import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const content = await readFile(new URL('../../../../README.md', import.meta.url), 'utf8');
const server = await createServer({
  configFile: false, root, appType: 'custom',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': `${root}src/` } },
  server: { host: '127.0.0.1', port: 0 },
});
server.middlewares.use('/__sending', async (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(await server.transformIndexHtml('/__sending',
    '<html><body><div id="root"></div><script type="module" src="/src/components/ai/__tests__/message-sending.browser.tsx"></script></body></html>'));
});
await server.listen();
let browser;
try {
  browser = await chromium.launch();
  const address = server.httpServer.address();
  assert.ok(address && typeof address !== 'string');
  for (const width of [360, 900]) {
    const page = await browser.newPage({ viewport: { width, height: 720 } });
    await page.goto(`http://127.0.0.1:${address.port}/__sending`);
    await page.waitForFunction(() => Boolean(window.renderSendingMessage));
    await page.evaluate(content => window.renderSendingMessage(content, 'pending'), content.split('\n').slice(0, 8).join('\n'));
    const spinner = page.getByRole('status', { name: '正在发送' });
    await spinner.waitFor();
    const bubble = page.locator('.ai-message-bubble-content');
    const pendingBox = await bubble.boundingBox();
    const spinnerBox = await spinner.boundingBox();
    assert.ok(pendingBox && spinnerBox);
    assert.equal(spinnerBox.width, 12);
    assert.equal(spinnerBox.height, 12);
    assert.ok(spinnerBox.x >= 0);
    assert.equal(Math.round(pendingBox.x - spinnerBox.x - spinnerBox.width), 4);
    assert.equal(await spinner.evaluate(el => getComputedStyle(el).opacity), '0.6');
    await page.screenshot({ path: `/tmp/shellspan-message-sending-${width}.png` });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await spinner.evaluate(el => getComputedStyle(el).animationName), 'none');
    await page.evaluate(content => window.renderSendingMessage(content, 'committed'), content.split('\n').slice(0, 8).join('\n'));
    assert.equal(await spinner.count(), 0);
    assert.deepEqual(await bubble.boundingBox(), pendingBox, 'Sending state must not move or resize the message');
    await page.close();
  }
} finally {
  await browser?.close();
  await server.close();
}
