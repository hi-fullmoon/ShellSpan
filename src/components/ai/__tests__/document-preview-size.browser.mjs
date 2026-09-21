import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const root = path.resolve(import.meta.dirname, '../../../..');
const server = await createServer({
  root, configFile: false, logLevel: 'error',
  resolve: { alias: { '@': path.join(root, 'src') } },
  plugins: [tailwindcss(), {
    name: 'document-preview-size-test',
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/preview-test') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<html><head><script type="module" src="/src/components/ai/__tests__/attachment-border.browser-entry.tsx"></script></head><body><div id="root"></div></body></html>');
      });
    },
  }],
  server: { host: '127.0.0.1', port: 0 },
});
try {
  await server.listen();
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage();
      for (const [width, height] of [[1440, 1000], [760, 700], [400, 600]]) {
        await page.setViewportSize({ width, height });
        await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/preview-test`);
        await page.getByRole('button', { name: /README.md/ }).click();
        const dialog = page.getByRole('dialog');
        await dialog.waitFor();
        await dialog.evaluate(async element => {
          await Promise.all(element.getAnimations().map(animation => animation.finished));
        });
        const bounds = await dialog.boundingBox();
        assert.ok(Math.abs(bounds.width - Math.min(960, width - 32)) < 1);
        assert.ok(Math.abs(bounds.height - height * 0.9) < 1);
        assert.ok(bounds.x >= 16 && bounds.y > 0);
        const viewport = dialog.locator('[data-slot="scroll-area-viewport"]');
        const header = dialog.locator('[data-slot="dialog-header"]');
        const headerBefore = await header.boundingBox();
        const scrolled = await viewport.evaluate(element => {
          element.scrollTop = element.scrollHeight;
          return element.scrollTop;
        });
        assert.ok(scrolled > 0, 'Long documents must scroll inside the preview');
        assert.deepEqual(await header.boundingBox(), headerBefore);
        await page.screenshot({ path: `/tmp/shellspan-document-preview-${engine.name()}-${width}.png` });
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'hidden' });
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  await server.close();
}
