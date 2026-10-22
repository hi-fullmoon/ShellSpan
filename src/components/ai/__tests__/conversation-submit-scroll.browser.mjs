import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, webkit } from 'playwright';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const document = await readFile(new URL('../../../../AGENTS.md', import.meta.url), 'utf8');
const server = await createServer({
  root, configFile: false, appType: 'custom', logLevel: 'error',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': `${root}src` } },
  server: { host: '127.0.0.1', port: 0, hmr: false },
});
server.middlewares.use('/__submit-scroll', async (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(await server.transformIndexHtml('/__submit-scroll',
    '<html><body><div id="root"></div><script type="module" src="/src/components/ai/__tests__/ai-turn-anchor.browser.tsx"></script></body></html>'));
});
try {
  await server.listen();
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      for (const width of [360, 900]) {
        const page = await browser.newPage({ viewport: { width, height: 700 } });
        await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__submit-scroll`);
        await page.waitForFunction(() => Boolean(window.renderDocumentTurn));
        await page.evaluate(text => window.renderDocumentTurn(text, false), document);
        await page.locator('[data-slot="message-scroller"]:not(.invisible)').waitFor();
        await page.locator('button[aria-expanded="false"][aria-controls]').last().click();
        const viewport = page.locator('[data-message-scroller-viewport]');
        await page.waitForTimeout(200);
        await viewport.hover();
        await viewport.focus();
        await page.keyboard.press('Home');
        await page.waitForFunction(() => document.querySelector('[data-message-scroller-viewport]').scrollTop < 2);
        const positions = await page.evaluate(async text => {
          const viewport = document.querySelector('[data-message-scroller-viewport]');
          const positions = [viewport.scrollTop];
          window.renderDocumentTurn(text, true);
          const started = performance.now();
          while (performance.now() - started < 2500) {
            await new Promise(requestAnimationFrame);
            positions.push(viewport.scrollTop);
            if (Math.abs(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop) <= 1) break;
          }
          return positions;
        }, document);
        assert.ok(new Set(positions.map(Math.round)).size > 3, 'Submission must scroll through intermediate positions');
        await page.waitForFunction(() => {
          const viewport = document.querySelector('[data-message-scroller-viewport]');
          return Math.abs(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop) <= 1;
        });
        assert.equal(await page.locator('[data-message-scroller-spacer]').evaluate(element => element.hidden), false);
        assert.ok(await page.evaluate(() => {
          const viewport = document.querySelector('[data-message-scroller-viewport]');
          const anchor = document.querySelector('[data-scroll-anchor="true"]');
          return Math.abs(anchor.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 20) < 2;
        }), 'Submission must place the new question at the top');
        await page.waitForTimeout(500);
        assert.equal(await page.locator('[data-slot="message-scroller-button"]').getAttribute('data-active'), 'false',
          'The real conversation must hide the jump button after reaching the bottom');
        assert.equal(await page.locator('[data-slot="message-scroller-button"]').isVisible(), false,
          'The loading button must be absent after a submission scrolls from history to the bottom');
        await viewport.hover();
        await viewport.focus();
        await page.keyboard.press('Home');
        await page.locator('[data-slot="message-scroller-button"]').waitFor({ state: 'visible' });
        await page.locator('[data-slot="message-scroller-button"]').click();
        await page.locator('[data-slot="message-scroller-button"]').waitFor({ state: 'hidden' });
        await page.screenshot({ path: `/tmp/conversation-submit-${engine.name()}-${width}.png` });
        await page.close();
      }
    } finally { await browser.close(); }
  }
  console.log('Conversation submissions align the question at the top and retain bottom navigation in Chromium and WebKit at 360px and 900px');
} finally { await server.close(); }
