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
  cacheDir: `/tmp/shellspan-load-older-${process.pid}`,
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': `${root}src` } },
  server: { host: '127.0.0.1', port: 0, hmr: false },
});
server.middlewares.use('/__load-older', async (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(await server.transformIndexHtml('/__load-older',
    '<html><body><div id="root"></div><script type="module" src="/src/components/ai/__tests__/ai-turn-anchor.browser.tsx"></script></body></html>'));
});
await server.listen();
try {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      for (const width of [360, 900]) {
        const page = await browser.newPage({ viewport: { width, height: 700 }, reducedMotion: 'reduce' });
        await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__load-older`);
        await page.waitForFunction(() => Boolean(window.renderDocumentTurn));
        await page.evaluate(text => window.renderDocumentTurn(text, false, true), document);
        await page.locator('[data-slot="message-scroller"]:not(.invisible)').waitFor();
        await page.evaluate(() => globalThis.document.fonts.ready);
        const viewport = page.locator('[data-message-scroller-viewport]');
        const button = page.getByRole('button', { name: /^(Load earlier messages|加载更早消息)$/ });
        assert.equal(await viewport.locator('.ai-load-older').count(), 1,
          'Earlier messages must be loaded from inside the scrolling transcript');
        await viewport.focus();
        await page.keyboard.press('Home');
        await page.waitForFunction(() => globalThis.document.querySelector('[data-message-scroller-viewport]').scrollTop === 0);
        const atStart = await button.boundingBox();
        const viewportBounds = await viewport.boundingBox();
        const firstMessage = await page.locator('[data-slot="message-scroller-item"]').first().boundingBox();
        assert.ok(atStart.y >= viewportBounds.y && atStart.y + atStart.height <= firstMessage.y,
          'The history button must appear before the first loaded message');
        await button.focus();
        assert.ok(await button.evaluate(element => element === globalThis.document.activeElement),
          'The history button must remain keyboard accessible');
        await page.screenshot({ path: `/tmp/shellspan-load-older-${engine.name()}-${width}-top.png` });
        await viewport.hover();
        await page.mouse.wheel(0, 400);
        await page.waitForFunction(() => globalThis.document.querySelector('[data-message-scroller-viewport]').scrollTop > 200);
        const afterScroll = await button.boundingBox();
        assert.ok(afterScroll.y + afterScroll.height < viewportBounds.y,
          'Reading later messages must scroll the history button out of view');
        await page.screenshot({ path: `/tmp/shellspan-load-older-${engine.name()}-${width}-scrolled.png` });
        await viewport.focus();
        await page.keyboard.press('End');
        await page.waitForFunction(() => {
          const element = globalThis.document.querySelector('[data-message-scroller-viewport]');
          return Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop) < 2;
        });
        const atEnd = await button.boundingBox();
        assert.ok(atEnd.y + atEnd.height < viewportBounds.y, 'The button must not float above the latest messages');
        await page.evaluate(text => window.renderDocumentTurn(text, false, false), document);
        assert.equal(await button.count(), 0, 'A fully loaded history must not show the button');
        await page.evaluate(() => window.renderPagedHistory());
        await page.locator('[data-slot="message-scroller"]:not(.invisible)').waitFor();
        let loadedPages = 0;
        while (await button.count()) {
          await viewport.focus();
          await page.keyboard.press('Home');
          await page.waitForFunction(() => globalThis.document.querySelector('[data-message-scroller-viewport]').scrollTop < 1).catch(async error => {
            throw new Error(`${engine.name()} ${width}: ${await viewport.evaluate(element => JSON.stringify({ top: element.scrollTop, height: element.clientHeight, total: element.scrollHeight }))}`, { cause: error });
          });
          const beforeLoad = await page.locator('[data-slot="message-scroller-item"]').first().evaluate(element => ({
            id: element.dataset.messageId,
            top: element.getBoundingClientRect().top,
          }));
          if (loadedPages === 0) await button.click();
          else {
            await button.focus();
            await page.keyboard.press('Enter');
          }
          await page.waitForTimeout(500);
          const afterLoad = await page.locator('[data-slot="message-scroller-item"]').evaluateAll((elements, id) =>
            elements.find(element => element.dataset.messageId === id).getBoundingClientRect().top, beforeLoad.id);
          assert.ok(Math.abs(afterLoad - beforeLoad.top) < 2,
            `Loading history must preserve the reading position: ${JSON.stringify({ engine: engine.name(), width, beforeLoad, afterLoad })}`);
          loadedPages += 1;
          assert.ok(loadedPages < 20, 'Loading recorded history must reach the first page');
        }
        assert.ok(loadedPages > 1, 'Exercise repeated loading and removal of the history button');
        await page.screenshot({ path: `/tmp/shellspan-load-older-${engine.name()}-${width}-loaded.png` });
        await page.close();
      }
    } finally { await browser.close(); }
  }
  console.log('History position, repeated loading and keyboard activation passed in Chromium and WebKit at 360px and 900px');
} finally { await server.close(); }
