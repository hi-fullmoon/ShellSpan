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
    name: 'directory-highlight-check',
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/directory-test') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<html><head><script type="module" src="/src/components/ai/__tests__/ai-directory-highlight.browser-entry.tsx"></script></head><body><div id="root"></div></body></html>');
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
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/directory-test`);
  const editor = page.getByRole('textbox');
  await editor.locator('[data-composer-directory]').waitFor();
  for (const width of [400, 980]) {
    await page.setViewportSize({ width, height: 500 });
    const styles = await editor.evaluate(element => {
      const directory = getComputedStyle(element.querySelector('[data-composer-directory]'));
      const skill = getComputedStyle(element.querySelector('[data-composer-command]'));
      return { directory: [directory.color, directory.backgroundColor], skill: [skill.color, skill.backgroundColor],
        overflow: document.documentElement.scrollWidth > innerWidth };
    });
    assert.notDeepEqual(styles.directory, styles.skill);
    assert.equal(styles.directory[0], 'rgb(40, 91, 181)');
    assert.equal(styles.overflow, false);
    await page.screenshot({ path: `/tmp/shellspan-directory-highlight-${width}.png` });
  }
  await editor.click();
  await editor.press('ControlOrMeta+a');
  await editor.press('ArrowRight');
  await page.keyboard.insertText('cache/');
  assert.equal(await editor.textContent(), '/system-status @zhengbiwen/.nvm/ cache/');
  await editor.press('Backspace');
  assert.equal(await editor.textContent(), '/system-status @zhengbiwen/.nvm/ cache');
  assert.equal(await editor.locator('[data-composer-directory]').textContent(), '@zhengbiwen/.nvm/');
  await editor.click();
  await editor.press('ControlOrMeta+a');
  await editor.press('ArrowRight');
  await page.keyboard.insertText(' 继续检查');
  assert.equal(await editor.locator('[data-composer-directory]').textContent(), '@zhengbiwen/.nvm/');
  await page.screenshot({ path: '/tmp/shellspan-directory-highlight-typing.png' });
  // Backspace at the directory boundary removes the entire reference.
  await editor.locator('[data-composer-directory]').evaluate(element => {
    const text = element.firstChild;
    const selection = window.getSelection();
    selection.setBaseAndExtent(text, text.textContent.length, text, text.textContent.length);
  });
  await editor.press('Backspace');
  assert.equal(await editor.locator('[data-composer-directory]').count(), 0);
  assert.equal(await editor.textContent(), '/system-status  cache 继续检查');
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await server.close();
}
