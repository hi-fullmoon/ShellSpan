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
  console.log(`Rich composer browser checks passed. Screenshots: ${screenshots}`);
} finally {
  await browser?.close();
  server?.kill('SIGTERM');
}
