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
            await viewport.focus();
            await page.keyboard.press('Home');
            await page.waitForFunction(() => document.querySelector('[data-message-scroller-viewport]').scrollTop === 0);
            if (following) await page.locator('[data-slot="message-scroller-button"]').click();
            await page.waitForFunction(following => {
              const viewport = document.querySelector('[data-message-scroller-viewport]');
              return following ? viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 8 : viewport.scrollTop === 0;
            }, following);
            if (following) await page.locator('[data-slot="message-scroller"][data-following="true"]').waitFor();
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
              }, undefined, { timeout: 3000 }).catch(async error => {
                const state = await page.evaluate(() => {
                  const viewport = document.querySelector('[data-message-scroller-viewport]');
                  return { top: viewport.scrollTop, height: viewport.scrollHeight, client: viewport.clientHeight,
                    spacer: document.querySelector('[data-message-scroller-spacer]')?.getBoundingClientRect().height,
                    content: document.querySelector('[data-slot="message-scroller-content"]')?.getBoundingClientRect().height,
                    style: viewport.style.scrollBehavior,
                    following: document.querySelector('[data-following]')?.getAttribute('data-following'),
                    anchors: [...document.querySelectorAll('[data-scroll-anchor="true"]')].map(element => element.getAttribute('data-message-id')) };
                });
                throw new Error(`${scenario}: ${JSON.stringify(state)}`, { cause: error });
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
            await page.evaluate(() => window.timeline.nextTurn());
            assert.equal(await page.locator('[data-message-id="user:new-turn-step"]').getAttribute('data-scroll-anchor'), 'true',
              `${scenario}: a new question must create a top-aligned turn anchor`);
            await page.waitForFunction(() => {
              const viewport = document.querySelector('[data-message-scroller-viewport]');
              const anchor = document.querySelector('[data-message-id="user:new-turn-step"]');
              const content = anchor.parentElement;
              const inset = Number.parseFloat(getComputedStyle(content).paddingBlockStart) || 0;
              return Math.abs(anchor.getBoundingClientRect().top - viewport.getBoundingClientRect().top - inset) < 2;
            });
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
