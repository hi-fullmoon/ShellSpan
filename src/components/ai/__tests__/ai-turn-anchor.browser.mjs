import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, webkit } from 'playwright';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const server = await createServer({
  root, configFile: false, appType: 'custom', logLevel: 'error',
  cacheDir: `/tmp/shellspan-turn-anchor-${process.pid}`,
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': `${root}src` } },
  server: { host: '127.0.0.1', port: 0, hmr: false },
});
server.middlewares.use('/__turn-anchor', async (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(await server.transformIndexHtml('/__turn-anchor',
    '<html><body><div id="root"></div><script type="module" src="/src/components/ai/__tests__/ai-turn-anchor.browser.tsx"></script></body></html>'));
});
await server.listen();
const address = server.httpServer.address();
try {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      for (const width of [360, 900]) {
      for (const motion of ['no-preference', 'reduce']) {
        const page = await browser.newPage({ viewport: { width, height: 700 }, reducedMotion: motion });
        await page.goto(`http://127.0.0.1:${address.port}/__turn-anchor`);
        await page.waitForFunction(() => Boolean(window.renderTurnPrefix));
        const nodes = await page.evaluate(() => window.turnNodes);
        const users = nodes.flatMap((node, index) => node.kind === 'userMessage' ? [index] : []);
        assert.ok(users.length > 1, 'The submitted prompt must follow recorded history');
        const last = users.at(-1);
        await page.evaluate(length => window.renderTurnPrefix(length), last);
        await page.locator('[data-slot="message-scroller"]:not(.invisible)').waitFor();
        await page.evaluate(() => document.fonts.ready);
        const samples = await page.evaluate(async length => {
          const viewport = document.querySelector('[data-message-scroller-viewport]');
          const positions = [viewport.scrollTop];
          window.renderTurnPrefix(length);
          const start = performance.now();
          while (performance.now() - start < 800) {
            await new Promise(requestAnimationFrame);
            positions.push(viewport.scrollTop);
          }
          return positions;
        }, last + 1);
        const positions = new Set(samples.map(Math.round));
        if (motion === 'reduce') assert.ok(positions.size <= 2, 'Reduced motion must position immediately');
        else assert.ok(positions.size > 3, `Expected intermediate scroll positions: ${JSON.stringify(samples)}`);
        const metrics = () => page.evaluate(() => {
          const viewport = document.querySelector('[data-message-scroller-viewport]');
          const anchor = document.querySelector('[data-scroll-anchor="true"]');
          const spacer = document.querySelector('[data-message-scroller-spacer]');
          return { offset: anchor.getBoundingClientRect().top - viewport.getBoundingClientRect().top,
            top: viewport.scrollTop, end: viewport.scrollHeight - viewport.clientHeight,
            spacer: spacer.hidden ? 0 : spacer.getBoundingClientRect().height };
        });
        await page.waitForFunction(() => {
          const anchor = document.querySelector('[data-scroll-anchor="true"]');
          const viewport = document.querySelector('[data-message-scroller-viewport]');
          return Math.abs(anchor.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 20) < 2;
        });
        const aligned = await metrics();
        assert.ok(aligned.spacer > 0, JSON.stringify(aligned));
        await page.screenshot({ path: `/tmp/shellspan-turn-anchor-${engine.name()}-${width}.png` });
        await page.setViewportSize({ width, height: 600 });
        await page.waitForTimeout(150);
        const grown = await metrics();
        assert.ok(grown.spacer < aligned.spacer, JSON.stringify({ aligned, grown }));
        const viewport = page.locator('[data-message-scroller-viewport]');
        await viewport.hover();
        await page.mouse.wheel(0, -250);
        await page.waitForTimeout(200);
        const reading = await metrics();
        await page.evaluate(length => window.renderTurnPrefix(length), nodes.length);
        await page.waitForTimeout(100);
        assert.ok(Math.abs((await metrics()).top - reading.top) < 2, 'Parent updates must preserve reading position');
        console.log(JSON.stringify({ engine: engine.name(), width, motion, intermediatePositions: positions.size, aligned, grown }));
        if (motion === 'no-preference') {
          await page.reload();
          await page.waitForFunction(() => Boolean(window.renderTurnPrefix));
          await page.evaluate(length => window.renderTurnPrefix(length), last);
          await page.locator('[data-slot="message-scroller"]:not(.invisible)').waitFor();
          await viewport.hover();
          await page.evaluate(length => window.renderTurnPrefix(length), last + 1);
          await page.waitForFunction(() => document.querySelector('[data-message-scroller-viewport]').style.scrollBehavior === 'smooth');
          await page.mouse.wheel(0, -200);
          await page.waitForTimeout(200);
          const interrupted = await metrics();
          await page.waitForTimeout(600);
          assert.ok(Math.abs((await metrics()).top - interrupted.top) < 2, 'Wheel input must stop the transition');
          assert.equal(await viewport.evaluate(element => element.style.scrollBehavior), '');
        }
        await page.close();
      }
      }
    } finally { await browser.close(); }
  }
} finally { await server.close(); }
