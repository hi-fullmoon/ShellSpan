import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, webkit } from 'playwright';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const server = await createServer({ root, configFile: false, appType: 'custom', logLevel: 'error',
  cacheDir: `/tmp/shellspan-steering-scroll-${process.pid}`,
  plugins: [react(), tailwindcss()], resolve: { alias: { '@': `${root}src` } },
  server: { host: '127.0.0.1', port: 0, hmr: false } });
server.middlewares.use('/__steering-scroll', async (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(await server.transformIndexHtml('/__steering-scroll', '<html><body></body></html>'));
});
try {
  await server.listen();
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      for (const width of [360, 900]) {
        for (const motion of ['no-preference', 'reduce']) {
          for (const following of [false, true]) {
            const scenario = `${engine.name()} ${width}px ${motion} ${following ? 'following' : 'reading'}`;
            const page = await browser.newPage({ viewport: { width, height: 400 }, reducedMotion: motion });
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__steering-scroll`);
            await page.evaluate(async () => {
              const { mount } = await import('/src/components/ai/__tests__/ai-input-timeline.browser.tsx');
              const host = document.createElement('main');
              host.className = 'ai-panel-shell @container/ai-workspace';
              host.style.cssText = 'position:fixed;inset:0;display:flex;flex-direction:column';
              document.body.append(host);
              window.timeline = await mount(host, 'zh-CN');
              window.timeline.waiting();
              await document.fonts.ready;
            });
            await page.locator('[data-slot="message-scroller"]:not(.invisible)').waitFor();
            const viewport = page.locator('[data-message-scroller-viewport]');
            assert.equal(await viewport.evaluate(element => element.scrollHeight > element.clientHeight), true,
              `${scenario}: the recorded transcript must overflow the short viewport`);
            await viewport.hover();
            await page.mouse.wheel(0, following ? 10000 : -10000);
            await page.waitForFunction(following => {
              const viewport = document.querySelector('[data-message-scroller-viewport]');
              return following ? viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 8 : viewport.scrollTop === 0;
            }, following);
            const firstTop = await page.locator('[data-ai-node-key="user:initial"]').evaluate(element => element.getBoundingClientRect().top);
            // Capture every frame, not just the final position: a transient
            // top-alignment followed by compensation also interrupts reading.
            const samples = await page.evaluate(async () => {
              const viewport = document.querySelector('[data-message-scroller-viewport]');
              const samples = [];
              window.timeline.steering();
              const start = performance.now();
              while (performance.now() - start < 400) {
                await new Promise(requestAnimationFrame);
                samples.push(viewport.scrollTop);
              }
              return samples;
            });
            assert.equal(await page.locator('[data-message-id="user:correction"]').getAttribute('data-scroll-anchor'), 'false',
              `${scenario}: steering must not create a turn anchor`);
            if (following) {
              await page.waitForFunction(() => {
                const viewport = document.querySelector('[data-message-scroller-viewport]');
                return Math.abs(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop) <= 8;
              });
            } else {
              assert.ok(samples.every(top => Math.abs(top) <= 1), `${scenario}: reading moved: ${JSON.stringify(samples)}`);
              const after = await page.locator('[data-ai-node-key="user:initial"]').evaluate(element => element.getBoundingClientRect().top);
              assert.ok(Math.abs(after - firstTop) <= 1, `${scenario}: the visible message moved`);
            }
            await page.evaluate(() => window.timeline.completed());
            await page.waitForFunction(following => {
              const viewport = document.querySelector('[data-message-scroller-viewport]');
              return following ? Math.abs(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop) <= 8 : viewport.scrollTop === 0;
            }, following);
            const submissionSamples = await page.evaluate(async () => {
              const viewport = document.querySelector('[data-message-scroller-viewport]');
              const samples = [];
              window.timeline.nextTurn();
              const start = performance.now();
              while (performance.now() - start < 400) {
                await new Promise(requestAnimationFrame);
                samples.push(viewport.scrollTop);
              }
              return samples;
            });
            assert.equal(await page.locator('[data-message-id="user:queued"]').getAttribute('data-scroll-anchor'), 'false',
              `${scenario}: a new question must not create a top-aligned turn anchor`);
            if (following) {
              await page.waitForFunction(() => {
                const viewport = document.querySelector('[data-message-scroller-viewport]');
                return Math.abs(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop) <= 8;
              });
            } else {
              assert.ok(submissionSamples.every(top => Math.abs(top) <= 1),
                `${scenario}: submitting a question moved the reading position: ${JSON.stringify(submissionSamples)}`);
            }
            if (motion === 'reduce') await page.screenshot({
              path: `/tmp/shellspan-steering-scroll-${engine.name()}-${width}-${following ? 'following' : 'reading'}.png`,
            });
            assert.deepEqual(errors, [], scenario);
            await page.close();
          }
        }
      }
    } finally { await browser.close(); }
  }
} finally { await server.close(); }
