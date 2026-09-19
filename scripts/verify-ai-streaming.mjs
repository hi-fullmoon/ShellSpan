import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, webkit } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const server = await createServer({
  configFile: false,
  root,
  appType: 'custom',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('../src/', import.meta.url)) } },
  server: { host: '127.0.0.1', port: 0 },
});
server.middlewares.use('/__ai-streaming-check', async (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(await server.transformIndexHtml('/__ai-streaming-check',
    '<html><body><div id="root"></div><script type="module" src="/scripts/perf/ai-streaming-page.tsx"></script></body></html>'));
});
await server.listen();
const address = server.httpServer.address();
if (!address || typeof address === 'string') throw new Error('Vite did not expose a loopback port');
const url = `http://127.0.0.1:${address.port}/__ai-streaming-check`;
const history = await readFile(new URL('../README.md', import.meta.url), 'utf8');
const answer = await readFile(new URL('../AGENTS.md', import.meta.url), 'utf8');
const image = { name: '32x32.png', mediaType: 'image/png',
  data: (await readFile(new URL('../src-tauri/icons/32x32.png', import.meta.url))).toString('base64') };

try {
  for (const browserType of [chromium, webkit]) {
    const browser = await browserType.launch({ ignoreDefaultArgs: ['--hide-scrollbars'] });
    try {
      for (const width of [420, 900]) {
        const page = await browser.newPage({ viewport: { width, height: 720 }, reducedMotion: 'no-preference' });
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(url);
        await page.waitForFunction(() => Boolean(window.streamingCheck));
        await page.evaluate((text) => window.streamingCheck.reset(text), history);
        const viewport = page.locator('[data-message-scroller-viewport]');
        const settle = () => page.evaluate(() => new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        }));
        const metrics = () => viewport.evaluate((element) => ({
          top: element.scrollTop,
          gap: element.scrollHeight - element.clientHeight - element.scrollTop,
          width: element.clientWidth,
          contentWidth: element.scrollWidth,
        }));
        const append = async (text) => {
          await page.evaluate((content) => window.streamingCheck.append(content), text);
          await settle();
        };
        await settle();
        // Grow the actual Markdown through native ResizeObserver deliveries.
        for (let index = 0; index < answer.length; index += 160) await append(answer.slice(index, index + 160));
        assert.ok((await metrics()).gap <= 8, `${browserType.name()} ${width}: turn did not enter live follow`);

        for (const releaseBetweenDrags of [false, true]) {
          const track = await viewport.boundingBox();
          assert.ok(track);
          const x = track.x + track.width - 3;
          await page.mouse.move(x, track.y + track.height - 12);
          await page.mouse.down();
          await page.mouse.move(x, track.y + track.height / 2, { steps: 8 });
          await settle();
          assert.ok((await metrics()).gap > 100, 'native scrollbar drag did not leave the bottom');
          if (releaseBetweenDrags) {
            await page.mouse.up();
            const thumb = await viewport.evaluate((element) => {
              const rect = element.getBoundingClientRect();
              const height = Math.max(32, element.clientHeight * element.clientHeight / element.scrollHeight);
              return rect.top + (element.clientHeight - height) * element.scrollTop
                / (element.scrollHeight - element.clientHeight) + height / 2;
            });
            await page.mouse.move(x, thumb);
            await page.mouse.down();
          }
          await page.mouse.move(x, track.y + track.height - 1, { steps: 8 });
          await settle();
          await page.mouse.up();
          assert.ok((await metrics()).gap <= 8, 'native scrollbar drag did not reach the bottom');
          await append('\n\n' + answer.slice(0, 500));
          assert.ok((await metrics()).gap <= 8, 'native scrollbar returned to bottom without resuming follow');
        }

        for (const key of ['End', 'ArrowDown', 'PageDown', 'Space']) {
          await viewport.focus();
          await page.keyboard.press(key);
          await append('\n\n' + answer.slice(0, 400));
          assert.ok((await metrics()).gap <= 8, `${key}: lost live follow`);
        }

        await viewport.hover();
        await page.mouse.wheel(0, -500);
        await page.waitForFunction(() => {
          const viewport = document.querySelector('[data-message-scroller-viewport]');
          return viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop > 100;
        });
        await settle();
        const reading = await metrics();
        await append('\n\n' + answer.slice(0, 600));
        assert.ok(Math.abs((await metrics()).top - reading.top) < 3, 'stream pulled the reader away from history');

        const savedAnchor = await page.evaluate(() => window.streamingCheck.anchor());
        await page.evaluate(() => window.streamingCheck.reopen());
        await settle();
        const restoredOffset = await page.evaluate((key) => {
          const row = document.querySelector(`[data-ai-node-key="${key}"]`).closest('[data-slot="message-scroller-item"]');
          return row.getBoundingClientRect().top - document.querySelector('[data-message-scroller-viewport]').getBoundingClientRect().top;
        }, savedAnchor.nodeKey);
        // Offscreen content-visibility estimates may change absolute scrollTop;
        // the saved message's position within the viewport must remain stable.
        assert.ok(Math.abs(restoredOffset - savedAnchor.offset) < 3, 'reopen lost the visible reading anchor');

        await page.locator('[data-slot="message-scroller-button"]').click();
        await page.waitForFunction(() => {
          const viewport = document.querySelector('[data-message-scroller-viewport]');
          return viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 8;
        });
        await append('\n\n' + answer.slice(0, 600));
        assert.ok((await metrics()).gap <= 8, 'jump-to-latest did not resume follow');
        await page.setViewportSize({ width: width === 420 ? 600 : 500, height: 620 });
        await settle();
        const resized = await metrics();
        assert.ok(resized.gap <= 8, 'viewport resize lost live follow');
        assert.ok(resized.contentWidth <= resized.width + 1, 'transcript overflowed horizontally');
        // A normal click followed by a later height correction is not a drag.
        await viewport.click({ position: { x: 80, y: 40 } });
        await page.waitForTimeout(250);
        await page.evaluate((content) => window.streamingCheck.replaceAnswer(content), answer);
        await settle();
        await append('\n\n' + answer);
        assert.ok((await metrics()).gap <= 8, 'a released click detached follow after content shrank');
        for (const scenario of ['multiple-tools', 'retry-success']) {
          const count = await page.evaluate((name) => window.streamingCheck.processEventCount(name), scenario);
          let originalPanel;
          for (let length = 1; length <= count; length += 1) {
            await page.evaluate(({ scenario, length }) => window.streamingCheck.replayProcess(scenario, length), { scenario, length });
            await settle();
            const panel = page.locator('.ai-turn-process');
            if (!await panel.count()) continue;
            if (!originalPanel) originalPanel = await panel.elementHandle();
            assert.ok(await panel.evaluate((element, original) => element === original, originalPanel),
              `${scenario}: request update remounted the process panel`);
            assert.ok((await metrics()).gap <= 8, `${scenario} event ${length}: lost live follow`);
          }
          const toggle = page.locator('.ai-turn-process-trigger');
          await toggle.click();
          await page.waitForTimeout(400); // The production panel transition lasts 300ms.
          await append('\n\n' + answer.slice(0, 600));
          assert.ok((await metrics()).gap <= 8, `${scenario}: collapse then output lost follow`);
          await toggle.click();
          await page.waitForTimeout(400);
          assert.ok((await metrics()).gap <= 8, `${scenario}: expansion lost follow`);
        }
        assert.deepEqual(errors, []);
        await page.screenshot({ path: `/tmp/shellspan-ai-streaming-${browserType.name()}-${width}.png` });
        for (const { queue, withImage } of [
          { queue: false, withImage: false }, { queue: true, withImage: false },
          { queue: false, withImage: true }, { queue: true, withImage: true },
        ]) {
          await page.evaluate(({ queue, image }) => window.streamingCheck.submissionCase(queue, image),
            { queue, image: withImage ? image : undefined });
          if (withImage) await page.waitForFunction(() => window.submissionCheck.imageReady);
          await settle();
          const editor = page.locator('[contenteditable="true"][role="textbox"]');
          await editor.click();
          await page.keyboard.insertText(queue ? 'README.md' : answer);
          // Scroll away *after* focusing/typing, so editor focus cannot hide the bug.
          await viewport.hover();
          await page.mouse.wheel(0, -600);
          await page.waitForFunction(() => {
            const element = document.querySelector('[data-message-scroller-viewport]');
            return element.scrollHeight - element.clientHeight - element.scrollTop > 100;
          });
          await page.keyboard.press('Enter');
          await page.waitForFunction(() => window.submissionCheck.pending === 1);
          if (withImage) {
            await page.waitForFunction(() => !window.submissionCheck.imageBusy);
            assert.equal(await page.evaluate(() => window.submissionCheck.imageError), null);
          }
          await settle();
          assert.ok((await metrics()).gap <= 8, `Enter (${queue ? 'queue' : 'send'}) did not return from history to bottom`);
          assert.equal(await page.locator('[data-scroll-anchor="true"]').count(), 0,
            'top anchoring can override send-to-bottom');
          await viewport.hover();
          await page.mouse.wheel(0, -400);
          await page.waitForFunction(() => {
            const element = document.querySelector('[data-message-scroller-viewport]');
            return element.scrollHeight - element.clientHeight - element.scrollTop > 100;
          });
          await settle();
          const reading = await metrics();
          await page.evaluate(() => window.submissionCheck.acknowledge());
          await settle();
          assert.ok(Math.abs((await metrics()).top - reading.top) < 3,
            'acknowledgement overrode reading position after a send');
        }
        assert.deepEqual(errors, []);
        process.stdout.write(`${browserType.name()} ${width}px: native scrollbar, text/image submission, stream, history, restore and animated process updates passed\n`);
        await page.close();
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  await server.close();
}
