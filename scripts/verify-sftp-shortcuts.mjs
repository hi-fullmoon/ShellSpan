import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(new URL('/src/components/sftp/__tests__/sftp-shortcuts.browser.html', process.env.SFTP_SHORTCUTS_URL ?? 'http://localhost:1420').href);
  await page.waitForFunction(() => document.body.dataset.sftpShortcutsReady === 'true')
    .catch((error) => { throw new Error(`${error.message}\n${JSON.stringify(errors)}`); });
  for (const width of [1280, 360]) {
    await page.setViewportSize({ width, height: 720 });
    await page.keyboard.press('Meta+Shift+O');
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    await page.getByRole('option').first().waitFor();
    assert.equal(await page.getByRole('option').count(), 20);
    const bounds = await dialog.boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width && bounds.y >= 0 && bounds.y + bounds.height <= 720, `Dialog exceeds ${width}px viewport`);
    const scroll = await dialog.locator('[data-slot="scroll-area-viewport"]').evaluate((node) => ({ height: node.clientHeight, content: node.scrollHeight }));
    assert.ok(scroll.content > scroll.height, 'Tab list must scroll inside the dialog');
    await page.screenshot({ path: `/tmp/shellspan-sftp-shortcuts-${width}.png`, animations: 'disabled' });
    await page.getByRole('searchbox').fill('no-match');
    assert.equal(await page.getByRole('option').count(), 0);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
  }
  assert.deepEqual(errors, [], 'Browser page errors');
  console.log('SFTP shortcut dialog verified at 1280px and 360px.');
} finally {
  await browser.close();
}
