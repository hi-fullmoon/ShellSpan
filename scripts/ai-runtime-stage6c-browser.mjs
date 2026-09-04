import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
const output = await mkdtemp(join(tmpdir(), 'shellspan-images-e2e-'));
const ready = join(output, 'ready.json');
const rust = spawn('cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--lib', '--locked', 'image_browser_controller_http_bridge', '--', '--ignored', '--nocapture'], { detached: process.platform !== 'win32', stdio: 'inherit', env: { ...process.env, SHELLSPAN_IMAGES_BRIDGE_READY: ready } });
const completion = new Promise((resolve, reject) => { rust.once('error', reject); rust.once('exit', resolve); });
const origin = 'http://127.0.0.1:1448';
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '1448', '--strictPort'], { stdio: 'ignore' });
let browser, activePage, readState;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  let bridge;
  for (let i = 0; i < 1800; i++) {
    if (rust.exitCode !== null) throw new Error(`Rust exited ${rust.exitCode}`);
    try { bridge = JSON.parse(await readFile(ready, 'utf8')); if ((await fetch(origin)).ok) break; } catch { /* startup */ }
    await delay(100);
  }
  assert.ok(bridge);
  const rpc = async command => {
    const result = await (await fetch(bridge.url, { method: 'POST', body: JSON.stringify({ command, args: {} }) })).json();
    if (result.error) throw new Error(result.error); return result.value;
  };
  readState = rpc;
  browser = await chromium.launch({ headless: true });
  const report = [];
  for (const [index, width] of [320, 400, 560, 720].entries()) for (const theme of ['light', 'dark']) {
    const zh = theme === 'dark';
    const context = await browser.newContext({ viewport: { width, height: 800 }, reducedMotion: 'reduce' });
    const page = await context.newPage(); activePage = page;
    page.on('pageerror', e => console.error(e));
    const url = `${origin}/?${new URLSearchParams({ aiStage6cVisual: '', rpc: bridge.url, modelUrl: bridge.modelUrl, target: `image-${width}-${theme}`, theme, locale: zh ? 'zh-CN' : 'en-US' })}`;
    await page.goto(url); await page.locator('[data-stage6c-ready]').waitFor();
    if (index === 0) {
      // Real IndexedDB transactions: one winner for concurrent CAS, rollback leaves the
      // original complete batch, and a bound cold draft is discoverable from its Session.
      const result = await page.evaluate(async () => {
        const { writeImageDraft, readImageDraft } = await import('/src/lib/ai/image-drafts.ts');
        const value = { owner: 'transaction-test', revision: 1, text: 'whole batch', images: [{ name: 'x', mediaType: 'image/png', data: 'fixture' }], operation: { id: 'op', sessionId: 'bound', mode: 'start' } };
        const writes = await Promise.allSettled([writeImageDraft(value, 0), writeImageDraft({ ...value, text: 'loser' }, 0)]);
        return { fulfilled: writes.filter(w => w.status === 'fulfilled').length, value: await readImageDraft('agent:bound') };
      });
      assert.equal(result.fulfilled, 1); assert.equal(result.value.images.length, 1); assert.equal(result.value.operation.sessionId, 'bound');
    }
    const paste = async count => {
      await page.getByTestId('ai-workspace-composer').evaluate((editor, { image, count }) => {
        const clipboardData = new DataTransfer();
        const bytes = Uint8Array.from(atob(image.data), char => char.charCodeAt(0));
        for (let i = 0; i < count; i++) {
          clipboardData.items.add(new File([bytes], `screenshot-${i + 1}.png`, { type: image.mediaType }));
        }
        editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
      }, { image: bridge.image, count });
    };
    const add = async () => {
      if (index === 1) await page.evaluate(() => window.imageTestHoldPreparation());
      await paste(index === 0 ? 20 : 1);
      let loadingHeight;
      if (index === 1) {
        const pending = page.locator('.ai-image-thumbnail[aria-busy=true]');
        await pending.waitFor();
        await page.waitForFunction(() => document.querySelector('.ai-image-thumbnail[aria-busy=true] img')?.naturalWidth > 0);
        assert.equal(await pending.locator('img').evaluate(image => image.src.startsWith('blob:')), true, 'local image preview appears before native preparation');
        assert.equal(await pending.locator('[data-slot=spinner]').count(), 1);
        loadingHeight = (await page.locator('[data-composer-card]').boundingBox()).height;
        await page.screenshot({ path: join(output, `${width}-${theme}-loading.png`), animations: 'disabled' });
        await page.evaluate(() => window.imageTestReleasePreparation());
      }
      await page.locator('[data-testid=image-draft] img').first().waitFor();
      await page.getByText(zh ? '已保存草稿 · 尚未发送' : 'Saved draft · not sent').waitFor();
      if (index === 1) {
        assert.equal(await page.locator('.ai-image-thumbnail[aria-busy=true]').count(), 0);
        assert.equal(await page.locator('.ai-image-thumbnail [data-slot=spinner]').count(), 0);
        assert.equal((await page.locator('[data-composer-card]').boundingBox()).height, loadingHeight, 'finishing image preparation does not resize the composer');
      }
    };
    const skill = async () => {
      const editor = page.getByTestId('ai-workspace-composer');
      await editor.click(); await editor.evaluate(el => { el.setSelectionRange(el.value.length, el.value.length); el.dispatchEvent(new Event('select', { bubbles: true })); }); await editor.pressSequentially(' /sys');
      await page.getByRole('option', { name: /system-status/ }).click();
    };
    const before = await rpc('__state');
    if (index % 2 === 0) {
      await add(); assert.equal((await rpc('__state')).sessions.length, before.sessions.length, 'image selection must not create a rootless Session');
      if (index === 0) {
        assert.equal(await page.locator('.ai-image-thumbnail').count(), 20);
        await paste(1);
        await page.locator('[data-sonner-toast]').getByText(zh ? '最多添加 20 张图片' : 'You can add up to 20 images', { exact: true }).waitFor();
        assert.equal(await page.locator('.ai-image-thumbnail').count(), 20, 'overflow keeps all existing images');
        assert.equal(await page.locator('[data-testid=image-draft] [role=alert]').count(), 0, 'count overflow uses a toast');
        await page.screenshot({ path: join(output, `${width}-${theme}-limit-toast.png`), animations: 'disabled' });
        await page.getByTestId('ai-workspace-composer').fill('durable image draft ');
        await page.reload(); await page.locator('[data-testid=image-draft] img').first().waitFor();
        assert.equal(await page.getByTestId('ai-workspace-composer').inputValue(), 'durable image draft ');
        await page.evaluate(() => window.imageTestChangeProvider('qwen-turbo'));
        await page.getByTestId('ai-workspace-composer').press('Enter');
        await page.getByText(zh ? /当前模型不支持图片/ : /This model cannot receive images/).waitFor();
        assert.equal((await rpc('__state')).sessions.length, before.sessions.length);
        await page.evaluate(() => window.imageTestChangeProvider('qwen3-vl-plus'));
        await page.getByText(zh ? /当前模型不支持图片/ : /This model cannot receive images/).waitFor({ state: 'detached' });
      }
      await skill();
    } else { await skill(); await add(); }
    if (index === 1) {
      await page.locator('.ai-image-thumbnail').first().hover();
      await page.getByRole('button', { name: new RegExp(zh ? '删除图片' : 'Remove image') }).click();
      await page.locator('[data-testid=image-draft] img').first().waitFor({ state: 'detached' }); await add();
    }
    const thumbs = page.locator('.ai-image-thumbnail');
    const boxes = await thumbs.evaluateAll(elements => elements.map(el => { const box = el.getBoundingClientRect(); return { width: box.width, height: box.height, y: box.y }; }));
    assert.ok(boxes.every(box => box.width === 64 && box.height === 64 && box.y === boxes[0].y), '64px thumbnails stay on one row');
    const imageBox = await page.locator('.ai-image-rail').boundingBox();
    const editorBox = await page.getByTestId('ai-workspace-composer').boundingBox();
    assert.equal(await page.getByRole('button', { name: zh ? '添加图片' : 'Add images', exact: true }).count(), 0);
    assert.equal(await page.locator('input[type=file]').count(), 0);
    assert.ok(imageBox && editorBox && imageBox.y + imageBox.height <= editorBox.y, 'pasted image rail above editor');
    await page.getByRole('button', { name: new RegExp(zh ? '^预览图片' : '^Preview image') }).first().click();
    await page.getByRole('dialog').waitFor();
    assert.equal(await page.getByRole('dialog').locator('img').count(), 1);
    await page.getByRole('dialog').getByRole('button', { name: zh ? '关闭' : 'Close', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    if (index === 0) {
      const rail = page.locator('.ai-image-rail-viewport');
      await page.getByRole('button', { name: zh ? '后面的图片' : 'Next images', exact: true }).click();
      assert.ok(await rail.evaluate(el => el.scrollLeft > 0));
      await page.getByRole('button', { name: zh ? '前面的图片' : 'Previous images', exact: true }).click();
      assert.equal(await rail.evaluate(el => el.scrollLeft), 0);
      await thumbs.last().getByRole('button', { name: new RegExp(zh ? '^预览图片' : '^Preview image') }).focus();
      assert.ok(await rail.evaluate(el => el.scrollLeft > 0), 'keyboard focus reveals offscreen thumbnails');
      await page.getByTestId('ai-workspace-composer').focus();
      await rail.evaluate(el => { el.scrollLeft = 0; });
    }
    assert.ok(await page.locator('[data-message-scroller-viewport]').count() <= 1, 'empty hero must not add another scroller');
    await page.screenshot({ path: join(output, `${width}-${theme}-draft.png`), animations: 'disabled' });
    if (index === 2) await rpc('__fail_submit');
    await page.getByTestId('ai-workspace-composer').press('Enter');
    if (index === 2) {
      await page.getByText(zh ? /操作未确认，草稿已保留/ : /The operation is unconfirmed and your draft is kept/).waitFor();
      assert.equal((await rpc('__state')).requests.length, before.requests.length);
      await page.reload(); await page.locator('[data-testid=image-draft] img').first().waitFor();
      await page.getByRole('button', { name: zh ? '重试' : 'Retry', exact: true }).click();
    }
    await page.getByText('Image wire complete', { exact: true }).waitFor({ timeout: 20000 });
    await page.locator('[data-testid=image-draft] img').first().waitFor({ state: 'detached' });
    assert.equal(await page.getByTestId('ai-workspace-composer').inputValue(), '');
    const after = await rpc('__state'); const session = after.sessions.at(-1);
    assert.equal(session.snapshot.header.target.cwd, undefined);
    assert.equal(after.requests.length, before.requests.length + 1);
    const wire = after.requests.at(-1);
    assert.equal(wire.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(b => b.type === 'image_url').length, index === 0 ? 20 : 1, 'all admitted images reach the model request');
    assert.ok(JSON.stringify(wire).includes('# System status'));
    const image = wire.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).find(b => b.type === 'image_url');
    assert.ok(image?.image_url.url.startsWith('data:image/png;base64,'));
    assert.equal(session.events.filter(e => e.type === 'agent/inbox/spliced' && e.data.operation === 'enqueued' && e.data.messages.some(m => m.images?.length)).length, 1);
    assert.ok(!JSON.stringify(session.events).includes('data:image/png;base64,'));
    await rpc('__restart'); await page.reload();
    await page.locator('[data-slot=bubble] img').first().waitFor();
    if (index === 0) {
      await page.getByTestId('ai-workspace-composer').fill('Look at the same image again');
      await page.getByTestId('ai-workspace-composer').press('Enter');
      let resumed;
      for (let attempt = 0; attempt < 100; attempt++) {
        resumed = await rpc('__state');
        if (resumed.requests.length > after.requests.length) break;
        await delay(100);
      }
      assert.equal(resumed.requests.length, after.requests.length + 1, 'text follow-up reattaches the recovered vision session');
      assert.ok(JSON.stringify(resumed.requests.at(-1)).includes(image.image_url.url), 'recovered HTTP input contains identical pixels');
      await page.reload(); await page.locator('[data-slot=bubble] img').first().waitFor();
    }
    assert.equal(await page.locator('[data-message-scroller-viewport]').count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.screenshot({ path: join(output, `${width}-${theme}-recovered.png`), animations: 'disabled' });
    report.push({ width, theme, combo: index % 2 === 0 ? 'image-then-skill' : 'skill-then-image', wire: true, restart: true, compactThumbnails: true, preview: true });
    await context.close();
  }
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  await rpc('__stop'); assert.equal(await completion, 0);
  console.log(`PASS ${report.length} real browser → controller → Runtime → image HTTP/restart scenes; evidence: ${output}`);
} catch (error) {
  if (activePage && !activePage.isClosed()) {
    await activePage.screenshot({ path: join(output, 'failure.png') });
    await writeFile(join(output, 'failure.html'), await activePage.content());
    if (readState) await writeFile(join(output, 'failure-state.json'), JSON.stringify(await readState('__state')));
    console.error('Failure evidence:', output, 'UI:', await activePage.locator('body').innerText());
  }
  throw error;
} finally {
  await browser?.close(); vite.kill('SIGTERM');
  if (rust.exitCode === null) {
    if (process.platform !== 'win32') process.kill(-rust.pid, 'SIGTERM'); else rust.kill('SIGTERM');
    await completion;
  }
}
