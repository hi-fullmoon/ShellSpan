import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, webkit } from 'playwright';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const server = await createServer({
  configFile: false, root, appType: 'custom', logLevel: 'error',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': `${root}src` } },
  server: { host: '127.0.0.1', port: 0, hmr: false },
});
server.middlewares.use('/__attachment-position', async (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(await server.transformIndexHtml('/__attachment-position', '<html><body><div id="root"></div><script type="module" src="/scripts/perf/document-upload-page.tsx"></script></body></html>'));
});

try {
  await server.listen();
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      for (const width of [380, 960]) {
        const page = await browser.newPage({ viewport: { width, height: 720 } });
        await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__attachment-position`);
        const name = 'terminal-protocol-rfc.md';
        await page.locator('input[type="file"]').setInputFiles(`${root}protocol/agent/runtime/${name}`);
        const preview = page.getByRole('button', { name: `Preview ${name}`, exact: true });
        await preview.hover();
        const tooltip = page.locator('[data-slot="tooltip-content"]');
        await tooltip.waitFor();
        await tooltip.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
        const card = page.locator(`[data-document-name="${name}"]`);
        const bounds = await card.boundingBox();
        const tip = await tooltip.boundingBox();
        assert.equal(await tooltip.textContent(), name);
        assert.equal(await tooltip.getAttribute('data-side'), 'top');
        assert.ok(Math.abs(tip.x - bounds.x) <= 1, 'Filename tooltip aligns with the card left edge');
        assert.ok(Math.abs(bounds.y - tip.y - tip.height - 4) <= 1, 'Filename tooltip sits directly above the card');
        const remove = page.getByRole('button', { name: `Remove ${name}`, exact: true });
        const button = await remove.boundingBox();
        assert.ok(Math.abs(button.y - bounds.y - 2) <= 1, 'Close button is 1px inside the top border');
        assert.ok(Math.abs(bounds.x + bounds.width - button.x - button.width - 2) <= 1, 'Close button is 1px inside the right border');
        await page.screenshot({ path: `/tmp/shellspan-attachment-position-${engine.name()}-${width}.png` });
        await preview.click();
        await page.getByRole('dialog').waitFor();
        await page.keyboard.press('Escape');
        await page.getByRole('dialog').waitFor({ state: 'hidden' });
        await remove.focus();
        assert.equal(await remove.evaluate(element => getComputedStyle(element).opacity), '1');
        await remove.press('Enter');
        assert.equal(await card.count(), 0);
        await page.close();
      }
    } finally { await browser.close(); }
  }
  console.log('Attachment positioning passed in Chromium and WebKit at 380px and 960px.');
} finally { await server.close(); }
