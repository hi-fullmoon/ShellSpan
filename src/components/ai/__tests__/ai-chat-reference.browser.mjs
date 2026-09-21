import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const root = path.resolve(import.meta.dirname, '../../../..');
const server = await createServer({
  root, configFile: false, logLevel: 'error',
  resolve: { alias: { '@': path.join(root, 'src') } },
  optimizeDeps: { include: ['react', 'react-dom/client'] },
  plugins: [tailwindcss(), {
    name: 'chat-reference-check',
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/reference-test') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<html><head><script type="module" src="/src/components/ai/__tests__/ai-chat-reference.browser-entry.tsx"></script></head><body><div id="root"></div></body></html>');
      });
    },
  }],
  server: { host: '127.0.0.1', port: 0 },
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/reference-test`);
  await page.getByRole('textbox').fill('请参考 @nginx');
  await page.getByRole('option', { name: 'Check nginx now.' }).click();
  const reference = page.getByRole('textbox').locator('[data-composer-chat-reference]');
  await reference.waitFor();
  await page.getByRole('textbox').press('End');
  await page.keyboard.insertText('继续分析');
  assert.equal(await page.locator('[data-unified-attachments]').count(), 0);
  for (const width of [400, 760]) {
    await page.setViewportSize({ width, height: 500 });
    const layout = await reference.evaluate(element => {
      const style = getComputedStyle(element);
      return { height: element.getBoundingClientRect().height, gap: parseFloat(getComputedStyle(element, '::before').marginRight),
        border: style.borderTopWidth, color: style.color, overflow: document.documentElement.scrollWidth > innerWidth };
    });
    assert.equal(layout.gap, 4);
    assert.equal(layout.border, '0px');
    assert.equal(layout.color, 'rgb(40, 91, 181)');
    assert.ok(layout.height <= 28);
    assert.equal(layout.overflow, false);
    await page.screenshot({ path: `/tmp/shellspan-chat-reference-${width}.png` });
  }
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await server.close();
}
