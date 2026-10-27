import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, webkit } from 'playwright';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const server = await createServer({ root, configFile: false, appType: 'custom', logLevel: 'error',
  cacheDir: `/tmp/shellspan-footer-alignment-${process.pid}`,
  plugins: [react(), tailwindcss()], resolve: { alias: { '@': `${root}src` } },
  server: { host: '127.0.0.1', port: 0, hmr: false } });
server.middlewares.use('/__footer', async (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(await server.transformIndexHtml('/__footer', '<html><body></body></html>'));
});
try {
  await server.listen();
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      for (const locale of ['zh-CN', 'en-US']) {
        for (const width of [900, 360, 240]) {
          const page = await browser.newPage({ viewport: { width, height: 200 }, deviceScaleFactor: 2 });
          const errors = [];
          page.on('pageerror', error => errors.push(error.message));
          await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__footer`);
          await page.evaluate(async locale => {
            const { mount } = await import('/src/components/ai/__tests__/ai-turn-footer-alignment.browser.tsx');
            const host = document.createElement('main');
            host.className = 'ai-panel-shell min-w-0 p-4';
            document.body.append(host);
            await mount(host, locale);
            await document.fonts.ready;
          }, locale);
          const row = page.locator('.ai-turn-stats');
          await row.waitFor();
          await row.screenshot({ path: `/tmp/shellspan-footer-alignment-${engine.name()}-${locale}-${width}.png` });
          const geometry = await row.evaluate(element => {
            const time = element.querySelector('time');
            const rect = time.getBoundingClientRect();
            const labels = [...element.querySelectorAll('button[aria-haspopup="dialog"] > span')]
              .map(label => label.getBoundingClientRect());
            return { timestampHeight: rect.height, translate: getComputedStyle(time).translate,
              offsets: labels.filter(label => Math.abs(label.top - rect.top) < 10).map(label => rect.top - label.top),
              fits: element.scrollWidth <= element.clientWidth + 1 };
          });
          assert.equal(geometry.timestampHeight, 20);
          assert.equal(geometry.fits, true, `${locale} footer must fit at ${width}px`);
          if (width >= 360) assert.ok(geometry.offsets.length > 0, 'Timestamp must share the row with stat labels');
          for (const offset of geometry.offsets) {
            assert.ok(Math.abs(offset) < 0.1, `Timestamp must align with adjacent text: ${JSON.stringify(geometry)}`);
          }
          for (const trigger of await row.locator('button[aria-haspopup="dialog"]').all()) {
            await trigger.focus();
            await trigger.press('Enter');
            await page.locator('.ai-turn-stat-panel').waitFor();
            await page.keyboard.press('Escape');
            await page.locator('.ai-turn-stat-panel').waitFor({ state: 'hidden' });
          }
          assert.deepEqual(errors, []);
          await page.close();
        }
      }
    } finally { await browser.close(); }
  }
} finally { await server.close(); }
