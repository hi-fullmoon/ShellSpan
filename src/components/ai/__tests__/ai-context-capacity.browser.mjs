import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const entry = '/src/components/ai/__tests__/ai-context-capacity.browser.tsx';
const server = await createServer({ root, configFile: false, appType: 'custom', logLevel: 'error',
  plugins: [react(), tailwindcss()], resolve: { alias: { '@': `${root}src/` } },
  server: { host: '127.0.0.1', port: 0 } });
server.middlewares.use(async (request, response, next) => {
  if (request.url !== '/') return next();
  response.setHeader('Content-Type', 'text/html');
  response.end(await server.transformIndexHtml('/', '<!doctype html><html><body><div id="root"></div></body></html>'));
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]);
  for (const locale of ['zh-CN', 'en-US']) {
    for (const width of [1000, 320]) {
      await page.setViewportSize({ width, height: 700 });
      await page.evaluate(async ({ entry, locale }) => {
        const module = await import(entry);
        await module.show(locale, module.originalWindow);
      }, { entry, locale });
      const meter = page.locator('.ai-context-meter-trigger');
      await meter.click();
      const panel = page.locator('.ai-context-meter-panel');
      await panel.waitFor();
      assert.match(await panel.textContent(), /\/ 1M/u);
      await page.evaluate(async ({ entry, locale }) => (await import(entry)).show(locale, 128_000), { entry, locale });
      await page.waitForFunction(() => document.querySelector('.ai-context-meter-panel')?.textContent.includes('/ 128K'));
      assert.match(await panel.textContent(), /7%/u);
      const fits = await panel.evaluate(element => {
        const box = element.getBoundingClientRect();
        return box.left >= 0 && box.right <= innerWidth && element.scrollWidth <= element.clientWidth;
      });
      assert.equal(fits, true, `${locale} context panel fits at ${width}px`);
      await page.evaluate(() => document.getAnimations().forEach(animation => animation.finish()));
      await page.screenshot({ path: `/tmp/shellspan-context-capacity-${locale}-${width}.png` });
      await page.keyboard.press('Escape');
      await panel.waitFor({ state: 'detached' });
    }
  }
  assert.deepEqual(errors, []);
  console.log('Context capacity updates from 1M to 128K in both languages at wide and narrow widths.');
} finally {
  await browser?.close();
  await server.close();
}
