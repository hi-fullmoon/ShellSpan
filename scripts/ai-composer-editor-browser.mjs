import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const origin = process.env.SHELLSPAN_COMPOSER_ORIGIN ?? 'http://127.0.0.1:1448';
const server = process.env.SHELLSPAN_COMPOSER_ORIGIN ? null : spawn(process.execPath,
  ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '1448', '--strictPort'], { stdio: 'ignore' });
let browser;
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(origin)).ok) { ready = true; break; } } catch { /* Vite is starting. */ }
    await delay(100);
  }
  assert.ok(ready, 'Preview server starts');
  browser = await chromium.launch({ headless: true });
  const screenshots = await mkdtemp(join(tmpdir(), 'shellspan-rich-composer-'));
  for (const [width, theme] of [[560, 'light'], [320, 'dark']]) {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/?aiStage6bVisual=1&locale=zh-CN&theme=${theme}`);
    const editor = page.locator('[data-composer-editor]');
    await editor.fill('/sys');
    await page.getByRole('option', { name: /system-status/ }).click();
    await page.waitForFunction(() => document.querySelector('[data-composer-command="system-status"]'));
    await editor.press('Backspace'); // trailing separator
    await editor.press('Backspace'); // the whole command
    assert.equal(await editor.textContent(), '');
    await editor.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
    assert.equal(await editor.textContent(), '/system-status');
    assert.equal(await editor.locator('[data-composer-command]').count(), 1);
    await editor.fill('检查网络');
    await editor.press('Shift+Enter');
    await page.keyboard.insertText('/net');
    await page.getByRole('option', { name: /network-diagnosis/ }).click();
    await page.keyboard.insertText('检查连接和 DNS');
    assert.equal(await editor.innerText(), '检查网络\n/network-diagnosis 检查连接和 DNS');
    assert.equal(await editor.locator('[data-composer-command]').count(), 1);
    assert.equal(await editor.evaluate(el => el.scrollWidth > el.clientWidth), false);
    await page.screenshot({ path: join(screenshots, `${width}-${theme}.png`) });
    await editor.fill('/var/log https://example.com/system-status /unknown ');
    assert.equal(await editor.locator('[data-composer-command]').count(), 0);
    assert.deepEqual(errors, []);
    await page.close();
  }
  for (const [width, height, theme] of [[400, 600, 'light'], [320, 480, 'dark'], [560, 800, 'light']]) {
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/?aiComposerVisual=1&locale=en-US&theme=${theme}`);
    const editor = page.locator('[data-composer-editor]');
    await editor.waitFor();
    const update = patch => page.evaluate(patch => window.composerTest.update(patch), patch);
    const undo = process.platform === 'darwin' ? 'Meta+z' : 'Control+z';
    await editor.fill('previous conversation draft');
    await page.getByRole('button', { name: 'New conversation', exact: true }).click();
    await editor.click();
    await editor.press(undo);
    assert.equal(await editor.textContent(), '', 'New conversation cannot undo into the old draft');
    await editor.fill('own draft');
    await editor.press(undo);
    assert.equal(await editor.textContent(), '', 'New conversation retains its own undo support');
    await update({ hero: false, status: 'running', draft: '' });
    await page.getByRole('button', { name: 'Stop this turn', exact: true }).waitFor();
    await editor.press('Enter');
    assert.equal(await page.locator('[data-stop-count]').getAttribute('data-stop-count'), '0');
    await page.getByRole('button', { name: 'Stop this turn', exact: true }).click();
    assert.equal(await page.locator('[data-stop-count]').getAttribute('data-stop-count'), '1');
    await update({ terminal: true, status: 'completed' });
    await page.waitForFunction(() => document.querySelector('[data-composer-editor]').contentEditable === 'true');
    await editor.fill('draft in a closed conversation');
    assert.ok(await page.getByRole('button', { name: 'Send', exact: true }).isDisabled());
    await update({ terminal: false, status: 'idle' });
    await page.waitForFunction(() => document.querySelector('[data-composer-editor]').contentEditable === 'true');
    await update({ phase: 'stopping', status: 'running', draft: 'next message' });
    await editor.fill('edited while stopping');
    assert.ok(await page.locator('.ai-composer-primary').last().isDisabled());
    await update({ phase: 'idle', status: 'idle' });
    await page.waitForFunction(() => document.activeElement === document.querySelector('[data-composer-editor]'));
    assert.equal(await editor.textContent(), 'edited while stopping');
    assert.ok(await page.getByRole('button', { name: 'Send', exact: true }).isEnabled());
    await update({ phase: undefined });
    for (const hero of [false, true]) {
      await update({ hero });
      for (const token of ['/', '@']) {
        const text = `${Array.from({ length: 20 }, (_, i) => `Draft line ${i}`).join('\n')}\n${token}`;
        await editor.fill(text);
        const menu = page.locator(token === '/' ? '[data-skill-completion]' : '[data-file-completion]');
        await menu.getByRole('option').first().waitFor();
        const popup = page.locator('.ai-completion-popup');
        await page.waitForFunction(() => {
          const rect = document.querySelector('.ai-completion-popup')?.getBoundingClientRect();
          return rect && rect.y >= 0 && rect.bottom <= window.innerHeight && rect.height > 50;
        });
        const box = await popup.boundingBox();
        const send = await page.locator('.ai-composer-primary').last().boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= width + 1, 'Popup stays inside panel width');
        assert.ok(send.y >= 0 && send.y + send.height <= height, 'Send button stays visible');
        assert.ok(await editor.evaluate(el => document.activeElement === el), 'Completion keeps editor focus');
        await page.screenshot({ path: join(screenshots, `${width}x${height}-${theme}-${hero ? 'hero' : 'active'}-${token === '/' ? 'skills' : 'files'}.png`) });
        // Scroll to the final option via keyboard, then insert without submitting.
        for (let i = 1; i < await menu.getByRole('option').count(); i++) await editor.press('ArrowDown');
        const selected = menu.locator('[aria-selected=true]');
        const optionBox = await selected.boundingBox();
        assert.ok(optionBox.y >= box.y && optionBox.y + optionBox.height <= box.y + box.height + 1, 'Active option scrolls into view');
        await editor.press('Tab');
        await popup.waitFor({ state: 'detached' });
        assert.ok((await editor.innerText()).startsWith('Draft line 0\n'), 'Completion preserves multiline draft');
      }
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(`Rich composer browser checks passed. Screenshots: ${screenshots}`);
} finally {
  await browser?.close();
  server?.kill('SIGTERM');
}
