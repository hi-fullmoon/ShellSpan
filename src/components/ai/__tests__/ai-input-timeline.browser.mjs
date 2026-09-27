import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, webkit } from 'playwright';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const server = await createServer({ root, configFile: false, appType: 'custom', logLevel: 'error',
  cacheDir: `/tmp/shellspan-input-timeline-${process.pid}`,
  plugins: [react(), tailwindcss()], resolve: { alias: { '@': `${root}src` } },
  server: { host: '127.0.0.1', port: 0, hmr: false } });
server.middlewares.use('/__timeline', async (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(await server.transformIndexHtml('/__timeline', '<html><body></body></html>'));
});
try {
  await server.listen();
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      for (const locale of ['zh-CN', 'en-US']) {
        for (const width of [360, 900]) {
          const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
          const errors = [];
          page.on('pageerror', error => errors.push(error.message));
          await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__timeline`);
          await page.evaluate(async locale => {
            const { mount } = await import('/src/components/ai/__tests__/ai-input-timeline.browser.tsx');
            const host = document.createElement('main');
            host.className = 'ai-panel-shell @container/ai-workspace';
            host.style.cssText = 'position:fixed;inset:0;display:flex;flex-direction:column';
            document.body.append(host);
            window.timeline = await mount(host, locale);
            window.timeline.waiting();
          }, locale);
          const waitLabel = locale === 'zh-CN' ? '等待下一步骤接收' : 'Waiting for next step';
          await page.getByText(waitLabel, { exact: true }).waitFor();
          await page.locator('[data-slot="message-scroller"]:not(.invisible)').waitFor();
          assert.equal(await page.locator('[data-ai-node-key="user:correction"]').count(), 0);
          const waitingFits = await page.locator('.ai-queue-row').evaluateAll(rows => rows.every(row => row.scrollWidth <= row.clientWidth + 1));
          assert.equal(waitingFits, true, `${locale} queue must fit ${width}px`);
          await page.locator('[data-message-scroller-viewport]').hover();
          await page.mouse.wheel(0, -10000);
          await page.waitForFunction(() => document.querySelector('[data-message-scroller-viewport]').scrollTop === 0);
          await page.screenshot({ path: `/tmp/shellspan-input-${engine.name()}-${locale}-${width}-waiting.png` });
          await page.getByRole('textbox').focus();
          const stable = await page.evaluate(() => {
            const first = document.querySelector('[data-ai-node-key="user:initial"]');
            const process = document.querySelector('[data-ai-node-key="turn-process:turn-1"]');
            const focused = document.activeElement;
            window.timeline.steering();
            return document.querySelector('[data-ai-node-key="user:initial"]') === first
              && document.querySelector('[data-ai-node-key="turn-process:turn-1"]') === process
              && document.activeElement === focused;
          });
          assert.equal(stable, true, 'Accepting a correction must preserve existing rows and editor focus');
          await page.getByText(locale === 'zh-CN' ? '本轮补充' : 'Added to this turn', { exact: true }).waitFor();
          assert.equal(await page.getByText(waitLabel, { exact: true }).count(), 0);
          await page.evaluate(() => window.timeline.completed());
          const keys = await page.locator('[data-ai-node-key]').evaluateAll(rows => rows.map(row => row.dataset.aiNodeKey));
          const expected = ['user:initial', 'turn-process:turn-1', 'user:correction',
            'turn-process:turn-1:after:correction', 'user:converted', 'turn-process:turn-1:after:converted', 'turn-tail:turn-1'];
          assert.deepEqual(keys, expected, 'Corrections must separate the work before and after their acceptance');
          assert.equal(await page.locator('[data-ai-node-key="user:queued"]').count(), 0);
          assert.equal(await page.locator('[data-ai-node-kind="turnTail"]').count(), 1);
          await page.locator('[data-message-scroller-viewport]').hover();
          await page.mouse.wheel(0, -10000);
          await page.waitForFunction(() => document.querySelector('[data-message-scroller-viewport]').scrollTop === 0);
          await page.screenshot({ path: `/tmp/shellspan-input-${engine.name()}-${locale}-${width}-completed.png` });
          await page.evaluate(() => window.timeline.nextTurn());
          const order = await page.locator('[data-ai-node-key]').evaluateAll(rows => rows.map(row => row.dataset.aiNodeKey));
          assert.ok(order.indexOf('user:queued') > order.indexOf('turn-tail:turn-1'));
          assert.equal(await page.locator('[data-slot="ai-queue-dock"]').count(), 0);
          assert.equal(await page.locator('[data-message-scroller-viewport]').evaluate(element => element.scrollWidth <= element.clientWidth + 1), true);
          assert.deepEqual(errors, []);
          await page.close();
        }
      }
    } finally { await browser.close(); }
  }
} finally { await server.close(); }
