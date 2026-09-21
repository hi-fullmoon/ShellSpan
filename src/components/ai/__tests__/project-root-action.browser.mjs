import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const root = path.resolve(import.meta.dirname, '../../../..');
const server = await createServer({
  root, configFile: false, logLevel: 'error',
  resolve: { alias: { '@': path.join(root, 'src') } },
  plugins: [tailwindcss(), {
    name: 'project-root-action-check',
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith('/root-action')) return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<html><head><script type="module" src="/src/components/ai/__tests__/ai-folder-menu.browser-entry.tsx"></script></head><body><div id="root"></div></body></html>');
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
  for (const width of [400, 1000]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/root-action?needsRoot`);
    const editor = page.getByRole('textbox');
    await editor.fill('@/');
    const choose = page.getByRole('option', { name: 'Choose project directory' });
    await choose.waitFor();
    const bounds = await choose.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, 'Directory action fits the viewport');
    assert.equal(await page.getByText(/Start a new conversation/).count(), 0);
    await page.screenshot({ path: `/tmp/shellspan-project-root-action-${width}.png` });
    await choose.click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    const input = dialog.getByRole('textbox', { name: 'Project directory' });
    await input.fill(root);
    assert.equal(await dialog.getByRole('button', { name: 'Bind directory' }).isEnabled(), true);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await editor.textContent(), '@/', 'Cancel preserves the draft');
    await editor.fill('@project-root');
    await choose.waitFor();
    await editor.press('Enter');
    await dialog.waitFor();
  }
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await server.close();
}
