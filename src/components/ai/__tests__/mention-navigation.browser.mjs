import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const server = await createServer({
  configFile: false, root, appType: 'custom',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': `${root}src` } },
  server: { host: '127.0.0.1', port: 0 },
});
server.middlewares.use('/__mention-check', async (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(await server.transformIndexHtml('/__mention-check',
    '<html><body><div id="root"></div><script type="module" src="/src/components/ai/__tests__/mention-navigation-page.tsx"></script></body></html>'));
});
await server.listen();
let browser;
try {
  browser = await chromium.launch();
  for (const width of [420, 1100]) {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__mention-check`);
    const editor = page.getByRole('textbox');
    await editor.fill('@');
    const options = page.getByRole('option');
    await options.first().waitFor();
    const count = await options.count();
    assert.ok(count > 3);
    const selected = page.getByRole('option', { selected: true });
    const assertActive = async index => {
      const id = await options.nth(index).getAttribute('id');
      await page.waitForFunction(expected => document.querySelector('[role="option"][aria-selected="true"]')?.id === expected, id);
      assert.equal(await selected.count(), 1);
      assert.equal(await editor.getAttribute('aria-activedescendant'), id);
      assert.ok(await editor.evaluate(element => element === document.activeElement));
      assert.equal(await editor.textContent(), '@');
    };
    for (let index = 0; index < count; index++) {
      await options.nth(index).hover();
      await assertActive(index);
    }
    await page.keyboard.press('Control+n');
    await assertActive(0);
    await page.keyboard.press('Control+p');
    await assertActive(count - 1);
    const visible = await selected.boundingBox();
    const list = await page.getByRole('listbox').boundingBox();
    assert.ok(visible.y >= list.y && visible.y + visible.height <= list.y + list.height + 1);
    await page.keyboard.press('Control+p');
    await assertActive(count - 2);
    await page.keyboard.press('ArrowDown');
    await assertActive(count - 1);
    await options.nth(2).hover();
    await assertActive(2);
    await page.keyboard.press('Control+n');
    await assertActive(3);
    await page.keyboard.press('Control+p');
    await assertActive(2);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('[role="textbox"]')?.textContent === '/system-status ');
    assert.equal(await page.getByRole('listbox').count(), 0);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('Mention navigation passed at 420px and 1100px.');
} finally {
  await browser?.close();
  await server.close();
}
