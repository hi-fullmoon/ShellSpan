import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, webkit } from 'playwright';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const documentText = await readFile(new URL('../../../../AGENTS.md', import.meta.url), 'utf8');
const server = await createServer({ root, configFile: false, appType: 'custom', logLevel: 'error',
  cacheDir: `/tmp/shellspan-latest-button-${process.pid}`,
  plugins: [react(), tailwindcss()], resolve: { alias: { '@': `${root}src` } },
  server: { host: '127.0.0.1', port: 0, hmr: false } });
server.middlewares.use('/__latest', async (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(await server.transformIndexHtml('/__latest', '<html><body><div id="root"></div><script type="module" src="/src/components/ai/__tests__/ai-turn-anchor.browser.tsx"></script></body></html>'));
});
try {
  await server.listen();
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      for (const width of [360, 900]) {
        const page = await browser.newPage({ viewport: { width, height: 700 } });
        page.setDefaultTimeout(5000);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__latest`);
        await page.waitForFunction(() => Boolean(window.renderDocumentTurn));
        for (const generating of [true, false]) {
          if (generating) {
            await page.evaluate(text => window.renderDocumentTurn(text, false), documentText);
            await page.locator('[data-slot="message-scroller"]:not(.invisible)').waitFor();
            await page.locator('button[aria-expanded="false"][aria-controls]').last().click();
          } else {
            await page.evaluate(text => window.renderScrollingDocument(text, false), documentText);
            await page.locator('[data-slot="message-scroller"]:not(.invisible)').waitFor();
          }
          const viewport = page.locator('[data-message-scroller-viewport]');
          const jump = page.locator('[data-slot="message-scroller-button"]');
          await viewport.hover();
          await page.mouse.wheel(0, -30000);
          await page.waitForFunction(() => document.querySelector('[data-message-scroller-viewport]').scrollTop < 2);
          await jump.waitFor({ state: 'visible' });
          assert.equal(await jump.locator('.ai-scroll-loading').count(), generating ? 1 : 0);
          await page.mouse.wheel(0, 30000);
          await page.waitForFunction(() => {
            const viewport = document.querySelector('[data-message-scroller-viewport]');
            return Math.abs(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop) <= 1;
          });
          const geometry = await jump.evaluate(button => ({
            active: button.dataset.active, className: button.className, display: getComputedStyle(button).display,
            viewportDistance: (() => { const viewport = document.querySelector('[data-message-scroller-viewport]');
              return viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop; })(),
          }));
          assert.equal(await jump.isVisible(), false, `Bottom navigation must hide at the actual bottom: ${JSON.stringify(geometry)}`);
          await viewport.hover();
          await page.mouse.wheel(0, -30000);
          await page.waitForFunction(() => {
            const viewport = document.querySelector('[data-message-scroller-viewport]');
            return viewport.scrollTop < 2;
          });
          await jump.waitFor({ state: 'visible' });
          await jump.click();
          await jump.waitFor({ state: 'hidden' });
        }
        assert.deepEqual(errors, []);
        await page.screenshot({ path: `/tmp/shellspan-latest-button-${engine.name()}-${width}.png` });
        await page.close();
      }
    } finally { await browser.close(); }
  }
} finally { await server.close(); }
