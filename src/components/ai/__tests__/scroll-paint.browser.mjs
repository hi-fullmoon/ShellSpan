import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from 'canvas';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, webkit } from 'playwright';

// An optional local capture stays outside the repository and is replayed read-only.
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const capturePath = process.argv[2];
const events = capturePath
  ? (await readFile(capturePath, 'utf8')).trim().split('\n').map(JSON.parse)
  : JSON.parse(await readFile(new URL('../../../../src/test/fixtures/agent-skills-runtime.json', import.meta.url), 'utf8'));
const messages = events.flatMap((event, index) => event.type === 'assistant/message' ? [index] : []);
assert.ok(messages.length > 0, 'A recorded assistant response is required');
const checkpoints = [...new Set([messages[Math.floor(messages.length / 3)],
  messages[Math.floor(messages.length * 2 / 3)], events.length - 1])];
const server = await createServer({ root, configFile: false, appType: 'custom', logLevel: 'error',
  cacheDir: `/tmp/shellspan-scroll-paint-${process.pid}`,
  plugins: [react(), tailwindcss()], resolve: { alias: { '@': `${root}src` } },
  server: { host: '127.0.0.1', port: 0, hmr: false } });
server.middlewares.use('/__scroll-paint', async (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(await server.transformIndexHtml('/__scroll-paint',
    '<html><body><div id="root"></div><script type="module" src="/src/components/ai/__tests__/runtime-scroll-replay.browser.tsx"></script></body></html>'));
});

async function assertPainted(page, description) {
  const boxes = await page.evaluate(() => {
    const viewport = document.querySelector('[data-message-scroller-viewport]').getBoundingClientRect();
    const boxes = [];
    for (const message of document.querySelectorAll('[data-ai-node-kind="assistantMessage"]')) {
      const walker = document.createTreeWalker(message, NodeFilter.SHOW_TEXT);
      let text;
      while ((text = walker.nextNode())) {
        if (!text.textContent.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(text);
        for (const box of range.getClientRects()) {
          // Ignore partial lines and the intentional bottom fade.
          if (box.width < 24 || box.top < viewport.top + 8 || box.bottom > viewport.bottom - 64
            || box.left < viewport.left || box.right > viewport.right) continue;
          boxes.push({ x: Math.floor(box.x), y: Math.floor(box.y),
            width: Math.ceil(box.width), height: Math.ceil(box.height) });
        }
      }
    }
    return boxes;
  });
  if (!boxes.length) return 0;
  const screenshot = await page.screenshot();
  const image = await loadImage(screenshot);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  for (const box of boxes) {
    const pixels = context.getImageData(box.x, box.y, box.width, box.height).data;
    let ink = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (Math.max(pixels[index], pixels[index + 1], pixels[index + 2]) < 150) ink += 1;
    }
    if (ink <= 3) await page.screenshot({ path: '/tmp/shellspan-scroll-paint-failure.png' });
    assert.ok(ink > 3, `${description}: visible text must have painted glyphs at ${JSON.stringify(box)}`);
  }
  return boxes.length;
}

try {
  await server.listen();
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      for (const width of [420, 900]) {
        const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: 'light' });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__scroll-paint`);
        await page.waitForFunction(() => Boolean(window.initializeRuntimeReplay));
        await page.evaluate(events => window.initializeRuntimeReplay(events), events);
        let painted = 0;
        for (const checkpoint of checkpoints) {
          await page.evaluate(length => window.replayUntil(length), checkpoint + 1);
          const viewport = page.locator('[data-message-scroller-viewport]');
          await page.locator('[data-slot="message-scroller"]:not(.invisible)').waitFor();
          assert.equal(await viewport.evaluate(element =>
            /(?:paint|content|strict)/.test(getComputedStyle(element).contain)), false,
          'The scroll viewport must expose new tiles without an additional paint-containment clip');
          await page.evaluate(() => document.fonts.ready);
          await viewport.focus();
          await page.keyboard.press('Home');
          await viewport.hover();
          for (let step = 0; step < 8; step += 1) {
            await page.mouse.wheel(0, 520);
            await page.waitForTimeout(80);
            painted += await assertPainted(page, `${engine.name()} ${width}px checkpoint ${checkpoint} scroll ${step}`);
          }
          await viewport.press('End');
          await page.waitForTimeout(250);
          painted += await assertPainted(page, `${engine.name()} ${width}px end`);
        }
        assert.ok(painted > 0, 'The recorded conversation must expose painted assistant text');
        assert.deepEqual(errors, []);
        await page.close();
      }
    } finally { await browser.close(); }
  }
} finally { await server.close(); }
