import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, webkit } from 'playwright';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const server = await createServer({ root, configFile: false, appType: 'custom', logLevel: 'error',
  cacheDir: `/tmp/shellspan-alert-alignment-${process.pid}`,
  plugins: [react(), tailwindcss()], resolve: { alias: { '@': `${root}src` } },
  server: { host: '127.0.0.1', port: 0, hmr: false } });
server.middlewares.use('/alert-alignment', async (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(await server.transformIndexHtml('/alert-alignment', '<html><body><div id="root"></div><script type="module" src="/src/components/ui/__tests__/alert-alignment.browser-entry.tsx"></script></body></html>'));
});
await server.listen();
const engine = process.env.SHELLSPAN_TEST_ENGINE ?? 'chromium';
const browser = await (engine === 'webkit' ? webkit : chromium).launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/alert-alignment`);
  for (const theme of ['light', 'dark']) {
    for (const locale of ['zh-CN', 'en-US']) {
      await page.evaluate(async ({ locale, theme }) => {
        const entry = await import('/src/components/ui/__tests__/alert-alignment.browser-entry.tsx');
        await entry.show(locale, theme);
      }, { locale, theme });
      const alerts = page.locator('[data-cases="notices"] [data-slot="alert"], [data-slot="focus-start-notice"], [data-cases="variants"] [data-slot="alert"]');
      await alerts.first().waitFor();
      for (const width of [1280, 640, 320, 240]) {
        await page.setViewportSize({ width, height: 900 });
        const measurements = await alerts.evaluateAll(alerts => alerts.map(alert => {
          const icon = alert.querySelector(':scope > svg').getBoundingClientRect();
          const title = alert.querySelector('[data-slot="alert-title"]:not(.sr-only)');
          const description = alert.querySelector('[data-slot="alert-description"]');
          const text = title ?? description.querySelector(':scope > span') ?? description;
          const box = text.getBoundingClientRect();
          const style = getComputedStyle(text);
          return {
            delta: icon.y + icon.height / 2 - box.y - parseFloat(style.paddingTop) - parseFloat(style.lineHeight) / 2,
            gap: box.x - icon.right,
            overflow: alert.scrollWidth > alert.clientWidth,
          };
        }));
        assert.equal(measurements.length, 40, 'Cover every variant/size plus actual availability, focus and error notices');
        for (const [index, result] of measurements.entries()) {
          assert.ok(Math.abs(result.delta) < 0.1, `${engine}/${theme}/${locale}/${width}: sample ${index} first-line offset ${result.delta}`);
          assert.equal(result.gap, 4, `Sample ${index}: icon/text gap`);
          assert.equal(result.overflow, false, `Sample ${index}: horizontal overflow`);
        }
        const transcript = await page.locator('[data-cases="transcript"] .ai-transcript-notice, [data-cases="transcript"] .ai-turn-error').evaluateAll(notices => notices.map(notice => {
          const icon = notice.querySelector('svg').getBoundingClientRect();
          const text = notice.querySelector('.ai-disclosure-title, .ai-turn-error-copy');
          return { kind: notice.className, delta: icon.y + icon.height / 2 - text.getBoundingClientRect().y - parseFloat(getComputedStyle(text).lineHeight) / 2 };
        }));
        assert.ok(transcript.some(item => item.kind.includes('ai-transcript-notice')), 'Exercise a recorded approval notice');
        assert.ok(transcript.some(item => item.kind.includes('ai-turn-error')), 'Exercise a recorded error notice');
        for (const item of transcript) assert.ok(Math.abs(item.delta) < 0.1, `${item.kind}: first-line offset ${item.delta}`);
        await page.locator('[data-case="availability-true"] [role="status"][aria-label]').last().screenshot({
          path: `/tmp/shellspan-availability-${engine}-${theme}-${locale}-${width}.png`,
        });
      }
      const reconnect = page.locator('[data-case="availability-true"] [role="status"] button');
      await reconnect.focus();
      await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(() => document.body.dataset.noticeAction), 'reconnect');
      for (const variant of ['success', 'error']) {
        const id = await page.evaluate(async variant => {
          const entry = await import('/src/components/ui/__tests__/alert-alignment.browser-entry.tsx');
          return entry.showToast(variant);
        }, variant);
        const toast = page.getByTestId(id);
        await toast.waitFor();
        for (const width of [1280, 320]) {
          await page.setViewportSize({ width, height: 900 });
          const delta = await toast.evaluate(toast => {
            const icon = toast.querySelector('[data-icon]').getBoundingClientRect();
            const title = toast.querySelector('[data-title]');
            return icon.y + icon.height / 2 - title.getBoundingClientRect().y - parseFloat(getComputedStyle(title).lineHeight) / 2;
          });
          assert.ok(Math.abs(delta) <= 0.5, `Toast ${variant} first-line offset ${delta}`);
        }
        await toast.dblclick();
        await toast.waitFor({ state: 'detached' });
      }
    }
  }
  assert.deepEqual(errors, [], 'Notices must render without browser errors');
} finally {
  await browser.close();
  await server.close();
}
