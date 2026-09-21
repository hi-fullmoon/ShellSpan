import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, webkit } from 'playwright';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const documents = await Promise.all([
  'README.md', 'AGENTS.md', 'CONTRIBUTING.md', 'docs/releasing.md',
  'protocol/agent/runtime/turn-and-task-plan.md',
].map(async name => ({ name, text: await readFile(join(root, name), 'utf8') })));
const server = await createServer({
  configFile: false, root, appType: 'custom',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': `${root}src/` } },
  server: { host: '127.0.0.1', port: 0 },
});
server.middlewares.use('/__scroll-stability', async (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(await server.transformIndexHtml('/__scroll-stability',
    '<html><body><div id="root"></div><script type="module" src="/src/components/ai/__tests__/message-scroll-stability.browser.tsx"></script></body></html>'));
});
await server.listen();
const address = server.httpServer.address();
assert.ok(address && typeof address !== 'string');

try {
  for (const browserType of [chromium, webkit]) {
    const browser = await browserType.launch({ ignoreDefaultArgs: ['--hide-scrollbars'] });
    try {
      for (const width of [420, 900]) {
        const page = await browser.newPage({ viewport: { width, height: 720 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${address.port}/__scroll-stability`);
        await page.waitForFunction(() => Boolean(window.renderScrollDocuments));
        await page.evaluate(documents => window.renderScrollDocuments(documents), documents);
        await page.locator('[data-slot="message-scroller"]:not(.invisible)').waitFor();
        await page.evaluate(() => document.fonts.ready);
        const viewport = page.locator('[data-message-scroller-viewport]');
        const metrics = () => viewport.evaluate(element => ({
          top: element.scrollTop, height: element.scrollHeight, client: element.clientHeight,
        }));
        const initial = await metrics();
        assert.ok(initial.height > initial.client * 3, 'Documents must span several viewports');
        await viewport.hover();
        let previous = initial;
        for (let step = 0; step < 12; step += 1) {
          await page.mouse.wheel(0, 480);
          await page.waitForTimeout(100);
          const current = await metrics();
          assert.equal(current.height, initial.height,
            `${browserType.name()} ${width}: scrolling changed the transcript height at step ${step}`);
          assert.ok(current.top >= previous.top - 1, 'Downward scrolling moved backwards');
          previous = current;
        }
        // Drag the native scrollbar through unvisited rows, then reverse it.
        const track = await viewport.boundingBox();
        assert.ok(track);
        const thumb = await viewport.evaluate(element => {
          const rect = element.getBoundingClientRect();
          const height = Math.max(32, element.clientHeight ** 2 / element.scrollHeight);
          return rect.top + (element.clientHeight - height) * element.scrollTop
            / (element.scrollHeight - element.clientHeight) + height / 2;
        });
        const x = track.x + track.width - 3;
        await page.mouse.move(x, thumb);
        await page.mouse.down();
        let pointerY = thumb;
        for (const target of [track.y + track.height - 1, track.y + 20]) {
          const before = await metrics();
          let last = before;
          const direction = Math.sign(target - pointerY);
          for (let step = 1; step <= 15; step += 1) {
            await page.mouse.move(x, pointerY + (target - pointerY) * step / 15);
            await page.waitForTimeout(20);
            const current = await metrics();
            assert.equal(current.height, initial.height, 'Dragging changed the transcript height');
            assert.ok((current.top - last.top) * direction >= -1, 'Scrollbar reversed during a one-way drag');
            last = current;
          }
          pointerY = target;
          const after = await metrics();
          assert.ok(Math.abs(after.top - before.top) > 100, 'Native scrollbar did not move');
        }
        await page.mouse.up();
        const stopped = await metrics();
        await page.waitForTimeout(250);
        assert.ok(Math.abs((await metrics()).top - stopped.top) < 1, 'Released scrollbar jumped');
        await page.screenshot({ path: `/tmp/shellspan-scroll-stability-${browserType.name()}-${width}.png` });
        // Resizing invalidates cached offscreen heights; subsequent scrolling
        // must not keep changing the range as those rows become visible.
        await page.setViewportSize({ width: width === 420 ? 900 : 420, height: 720 });
        await page.waitForTimeout(150);
        const resized = await metrics();
        await viewport.hover();
        for (let step = 0; step < 8; step += 1) {
          await page.mouse.wheel(0, 600);
          await page.waitForTimeout(100);
          assert.equal((await metrics()).height, resized.height, 'Scroll range changed after resizing');
        }
        assert.deepEqual(errors, []);
        console.log(`${browserType.name()} ${width}px: wheel and native scrollbar keep a stable transcript height`);
        await page.close();
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  await server.close();
}
