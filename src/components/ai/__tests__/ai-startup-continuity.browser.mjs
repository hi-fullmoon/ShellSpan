import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, webkit } from 'playwright';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const server = await createServer({ root, configFile: false, appType: 'custom', logLevel: 'error',
  cacheDir: `/tmp/shellspan-startup-continuity-${process.pid}`,
  plugins: [react(), tailwindcss()], resolve: { alias: { '@': `${root}src` } },
  server: { host: '127.0.0.1', port: 0, hmr: false } });
server.middlewares.use('/__startup', async (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(await server.transformIndexHtml('/__startup', '<html><body></body></html>'));
});
try {
  await server.listen();
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      for (const width of [360, 900]) {
        const page = await browser.newPage({ viewport: { width, height: 720 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__startup`);
        await page.evaluate(async () => {
          const { mount } = await import('/src/components/ai/__tests__/ai-startup-continuity.browser.tsx');
          const host = document.createElement('main');
          host.className = 'ai-panel-shell @container/ai-workspace';
          host.style.cssText = 'position:fixed;inset:0;display:flex;flex-direction:column';
          document.body.append(host);
          window.startup = await mount(host);
          window.startup.session('pending');
        });
        await page.locator('[data-slot="message-scroller"]:not(.invisible)').waitFor();
        const adopted = await page.evaluate(() => {
          const scroller = document.querySelector('[data-slot="message-scroller"]');
          const viewport = document.querySelector('[data-message-scroller-viewport]');
          for (const stage of ['receipt', 'committed']) {
            window.startup.session(stage);
            if (document.querySelector('[data-slot="message-scroller"]') !== scroller
              || document.querySelector('[data-message-scroller-viewport]') !== viewport
              || scroller.classList.contains('invisible')) return false;
          }
          window.startup.session('navigation');
          return document.querySelector('[data-slot="message-scroller"]') !== scroller;
        });
        assert.equal(adopted, true, 'Session adoption preserves the visible scroller; navigation resets it');
        await page.evaluate(() => window.startup.prefix(window.startup.firstVisibleProcess));
        await page.locator('[data-ai-thinking-indicator]').waitFor({ state: 'visible' });
        assert.equal(await page.locator('.ai-turn-process').count(), 0);
        const pendingLabel = await page.locator('[data-ai-thinking-indicator] .shimmer').textContent();
        const pendingGeometry = await page.locator('[data-ai-thinking-indicator]').evaluate(element => {
          const row = element.getBoundingClientRect();
          const label = element.querySelector('[data-slot="marker-content"]').getBoundingClientRect();
          return { height: row.height, center: label.top + label.height / 2 - row.top };
        });
        await page.evaluate(() => window.startup.prefix(window.startup.firstVisibleProcess + 1));
        await page.locator('.ai-turn-process').waitFor({ state: 'visible' });
        assert.equal(await page.locator('[data-ai-thinking-indicator]').count(), 0);
        assert.equal(await page.locator('.ai-turn-process-trigger [data-slot="spinner"]').count(), 1);
        const processLabel = page.locator('.ai-turn-process-trigger .shimmer');
        assert.equal(await processLabel.textContent(), pendingLabel, 'Processing text must stay consistent after the first output');
        assert.notEqual(await processLabel.evaluate(element => getComputedStyle(element).animationName), 'none');
        assert.equal(await page.locator('[data-message-scroller-viewport]').evaluate(element =>
          element.scrollWidth <= element.clientWidth + 1), true, 'Startup output must fit the narrow viewport');
        await page.screenshot({ path: `/tmp/shellspan-startup-${engine.name()}-${width}.png` });
        await page.evaluate(() => window.startup.prefix(window.startup.completedProcess));
        const completed = page.locator('.ai-turn-process[data-status="completed"] .ai-turn-process-trigger').first();
        await completed.waitFor({ state: 'visible' });
        const completedGeometry = await completed.evaluate(element => {
          const row = element.getBoundingClientRect();
          const label = element.querySelector('.ai-disclosure-title').getBoundingClientRect();
          return { height: row.height, center: label.top + label.height / 2 - row.top };
        });
        assert.deepEqual(pendingGeometry, completedGeometry,
          'Processing and completed rows must retain the same height and label center');
        assert.equal(completedGeometry.height, 32);
        await page.evaluate(() => window.startup.delivery('pending'));
        const bubble = page.locator('.ai-message-bubble-user');
        await bubble.waitFor();
        const pendingBounds = await bubble.boundingBox();
        assert.equal(await page.locator('.ai-user-delivery').count(), 0,
          'Pending user messages must not show a sending label');
        await page.screenshot({ path: `/tmp/shellspan-user-pending-${engine.name()}-${width}.png` });
        await page.evaluate(() => window.startup.delivery('committed'));
        assert.deepEqual(await bubble.boundingBox(), pendingBounds,
          'Committing the user message must not resize or move its bubble');
        await page.evaluate(() => window.startup.delivery('failed'));
        assert.equal(await page.locator('.ai-user-delivery[data-state="failed"]').count(), 1,
          'Failed delivery must retain its visible feedback');
        assert.deepEqual(errors, []);
        await page.close();
      }
    } finally { await browser.close(); }
  }
} finally { await server.close(); }
