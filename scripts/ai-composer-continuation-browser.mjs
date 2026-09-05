import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const origin = 'http://127.0.0.1:1454';
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '1454', '--strictPort'], { stdio: 'ignore' });
let browser;
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(origin)).ok) { ready = true; break; } } catch { /* starting */ }
    await delay(100);
  }
  assert(ready, 'Vite starts');
  browser = await chromium.launch({ headless: true });
  const screenshots = await mkdtemp(join(tmpdir(), 'shellspan-continuation-'));
  for (const [width, theme] of [[560, 'light'], [320, 'dark']]) {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/?aiComposerVisual=1&locale=zh-CN&theme=${theme}`);
    const editor = page.locator('[data-composer-editor]');
    await editor.waitFor();
    const update = patch => page.evaluate(patch => window.composerTest.update(patch), patch);
    for (const status of ['cancelled', 'failed', 'completed']) {
      await update({ status, terminal: false, phase: 'idle' });
      await editor.fill('继续，保留刚才的结果');
      assert(await editor.isEditable(), `${status}: editable`);
      assert(await page.locator('.ai-composer-primary').last().isEnabled(), `${status}: can send`);
    }
    await update({ phase: 'stopping', status: 'running' });
    await editor.fill('停止期间修改的草稿');
    const primary = page.locator('.ai-composer-primary').last();
    assert(await primary.isDisabled(), 'send waits for cleanup');
    await editor.press('Enter');
    assert.equal(await editor.textContent(), '停止期间修改的草稿');
    await page.screenshot({ path: join(screenshots, `${width}-${theme}-stopping.png`) });
    await update({ phase: 'idle', status: 'idle' });
    await page.waitForFunction(() => document.activeElement === document.querySelector('[data-composer-editor]'));
    assert.equal(await editor.textContent(), '停止期间修改的草稿');
    assert(await primary.isEnabled());
    await page.screenshot({ path: join(screenshots, `${width}-${theme}-ready.png`) });
    await editor.press('Enter');
    await page.waitForFunction(() => document.querySelector('[data-composer-editor]').textContent === '');
    for (const phase of ['waitingApproval', 'waitingQuestion']) {
      await update({ phase, status: 'waiting' });
      await editor.fill('等待确认期间的草稿');
      assert(await editor.isEditable());
      assert(await primary.isDisabled());
    }
    const box = await editor.boundingBox();
    assert(box.x >= 0 && box.x + box.width <= width + 1, 'editor fits the panel');
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(`PASS: stop/continue, preserved drafts, focus, terminal and confirmation states at 560px light / 320px dark. Screenshots: ${screenshots}`);
} finally {
  await browser?.close();
  server.kill();
}
