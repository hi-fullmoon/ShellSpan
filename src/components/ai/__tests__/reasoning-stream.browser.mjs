import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, webkit } from 'playwright';

// Replay a real session; never embed private conversation content in fixtures.
const events = (await readFile(process.argv[2], 'utf8')).trim().split('\n').map(JSON.parse);
const root = path.resolve(import.meta.dirname, '../../../..');
const server = await createServer({
  root, configFile: false, appType: 'custom', logLevel: 'error',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.join(root, 'src') } },
  server: { host: '127.0.0.1', port: 0 },
});
server.middlewares.use('/stream-test', async (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(await server.transformIndexHtml('/stream-test', '<html><body><div id="root"></div><script type="module" src="/src/components/ai/__tests__/reasoning-stream.browser-entry.tsx"></script></body></html>'));
});
await server.listen();
try {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      for (const width of [420, 900]) {
        const page = await browser.newPage({ viewport: { width, height: 720 } });
        await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/stream-test`);
        const result = await page.evaluate(async events => {
          const { replay } = await import('/src/components/ai/__tests__/reasoning-stream.browser-entry.tsx');
          const requests = events.flatMap((event, index) => event.type === 'request/start'
            ? [{ index, id: event.data.requestId, length: events.reduce((sum, chunk) => sum + (chunk.type === 'assistant/chunk' && chunk.data.requestId === event.data.requestId ? chunk.data.reasoningDelta?.length ?? 0 : 0), 0) }] : []);
          const request = requests.sort((a, b) => b.length - a.length)[0];
          const start = request.index;
          const prefix = events.slice(0, start + 1);
          replay(prefix);
          await new Promise(resolve => setTimeout(resolve, 200));
          let backwards = 0;
          let clipping = 0;
          let frames = 0;
          let lastTop = 0;
          let lagging = 0;
          for (const event of events.slice(start + 1)) {
            prefix.push(event);
            if (event.type !== 'assistant/chunk' || !event.data.reasoningDelta || event.data.requestId !== request.id) continue;
            replay(prefix);
            await new Promise(requestAnimationFrame);
            const viewport = document.querySelector('[data-message-scroller-viewport]');
            const body = [...document.querySelectorAll('.ai-reasoning-body')].at(-1);
            if (!body) continue;
            const panel = body.parentElement;
            if (panel.getBoundingClientRect().height + 1 < body.getBoundingClientRect().height) clipping++;
            if (viewport.scrollTop < lastTop - 1) backwards++;
            if (viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop > 2) lagging++;
            lastTop = viewport.scrollTop;
            frames++;
          }
          return { frames, backwards, clipping, lagging };
        }, events);
        assert.ok(result.frames > 10);
        assert.equal(result.clipping, 0, 'Streaming reasoning must remain fully laid out');
        assert.equal(result.backwards, 0, 'Appending reasoning must not scroll backwards');
        assert.equal(result.lagging, 0, 'Follow mode must stay at the live edge');
        await page.screenshot({ path: `/tmp/shellspan-reasoning-stream-${engine.name()}-${width}.png` });
        await page.close();
      }
    } finally { await browser.close(); }
  }
} finally { await server.close(); }
