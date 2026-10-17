import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, webkit } from 'playwright';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const server = await createServer({ root, configFile: false, appType: 'custom',
  plugins: [react(), tailwindcss()], resolve: { alias: { '@': `${root}src/` } },
  server: { host: '127.0.0.1', port: 0 } });
server.middlewares.use('/focus-notice', async (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(await server.transformIndexHtml('/focus-notice', '<html><body><div id="root"></div><script type="module" src="/src/components/focus/__tests__/focus-notice.browser-entry.tsx"></script></body></html>'));
});
await server.listen();
const engine = process.env.SHELLSPAN_TEST_ENGINE ?? 'chromium';
const browser = await (engine === 'webkit' ? webkit : chromium).launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/focus-notice`);
  for (const theme of ['light', 'dark']) {
  for (const locale of ['zh-CN', 'en-US']) {
    await page.evaluate(async ({ locale, theme }) => {
      const entry = await import('/src/components/focus/__tests__/focus-notice.browser-entry.tsx');
      await entry.show(locale, theme);
    }, { locale, theme });
    const notice = page.locator('[data-slot="focus-start-notice"]');
    await notice.waitFor();
    for (const width of [1280, 400, 320, 240]) {
      await page.setViewportSize({ width, height: 640 });
      const geometry = await notice.evaluate(el => {
        const text = el.querySelector('[data-slot="alert-description"] > span');
        const icon = el.querySelector(':scope > svg').getBoundingClientRect();
        const button = el.querySelector('button').getBoundingClientRect();
        const box = el.getBoundingClientRect();
        const textBox = text.getBoundingClientRect();
        const style = getComputedStyle(text);
        const firstLine = textBox.top + parseFloat(style.paddingTop) + parseFloat(style.lineHeight) / 2;
        return { iconOffset: icon.top + icon.height / 2 - firstLine,
          actionIcons: el.querySelectorAll('button svg').length,
          gap: textBox.left - icon.right, buttonHeight: button.height,
          buttonOffset: button.top + button.height / 2 - firstLine,
          inline: button.left >= textBox.right, height: box.height,
          fits: el.scrollWidth <= el.clientWidth && button.right <= box.right && button.bottom <= box.bottom };
      });
      assert.equal(geometry.iconOffset, -1.5, `Icon must align to the first text line: ${locale}/${width}`);
      assert.equal(geometry.gap, 4, 'Icon and text retain the shared spacing');
      assert.equal(geometry.buttonHeight, 24, 'Action retains its compact size');
      assert.equal(geometry.actionIcons, 0, 'Notice actions stay text-only');
      assert.ok(geometry.fits, `Notice must fit: ${locale}/${width}`);
      if (geometry.inline) assert.equal(geometry.buttonOffset, 0, 'Inline action aligns to the first line');
      if (width === 1280) assert.equal(geometry.height, 38, 'Wide notice retains its original height');
      await notice.screenshot({ path: `/tmp/shellspan-focus-notice-${engine}-${theme}-${locale}-${width}.png` });
    }
    await page.evaluate(() => {
      document.body.dataset.connectRequested = 'false';
      document.addEventListener('shellspan:new-terminal-tab', () => { document.body.dataset.connectRequested = 'true'; }, { once: true });
    });
    await notice.getByRole('button').focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => document.body.dataset.connectRequested), 'true', 'Keyboard action still opens terminal creation');
  }
  }
  assert.deepEqual(errors, [], 'Notice must render without browser errors');
} finally {
  await browser.close();
  await server.close();
}
