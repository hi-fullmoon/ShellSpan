import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const root = path.resolve(import.meta.dirname, '../../../..');
const requests = [];
let delayedQuery;
let releaseResponse;
let responseStarted;
const server = await createServer({
  root, configFile: false, logLevel: 'error',
  resolve: { alias: { '@': path.join(root, 'src') } },
  optimizeDeps: { include: ['react', 'react-dom/client'] },
  plugins: [tailwindcss(), {
    name: 'project-directory-check',
    configureServer(vite) {
      vite.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url, 'http://localhost');
        if (url.pathname === '/directories') {
          const query = url.searchParams.get('q');
          requests.push(query);
          try {
            const parent = path.dirname(query.endsWith('/') ? `${query}.` : query);
            const prefix = query.endsWith('/') ? '' : path.basename(query);
            const entries = await readdir(parent, { withFileTypes: true });
            if (query === delayedQuery) {
              await new Promise(resolve => { releaseResponse = resolve; responseStarted?.(); });
            }
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify(entries.filter(entry => entry.isDirectory() && entry.name.startsWith(prefix))
              .sort((a, b) => a.name.localeCompare(b.name)).map(entry => `${path.join(parent, entry.name)}/`)));
          } catch { response.statusCode = 404; response.end(); }
          return;
        }
        if (url.pathname !== '/directory-test') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<html><head><script type="module" src="/src/components/ai/__tests__/project-directory.browser-entry.tsx"></script></head><body><div id="root"></div></body></html>');
      });
    },
  }], server: { host: '127.0.0.1', port: 0 },
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch();
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const [width, height] of [[400, 800], [1000, 800], [600, 420]]) {
    await page.setViewportSize({ width, height });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/directory-test`);
    await page.getByRole('button', { name: 'Add file or folder' }).click();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    const input = page.getByRole('combobox', { name: 'Project directory' });
    await input.waitFor();
    const initialBounds = await page.getByRole('dialog').boundingBox();
    requests.length = 0;
    await input.fill(`${root}/`);
    await input.fill(`${root}/s`);
    await input.fill(`${root}/src`);
    const option = page.getByRole('option', { name: `${root}/src/`, exact: true });
    await option.waitFor();
    assert.deepEqual(requests, [`${root}/src`], 'rapid typing performs one debounced directory read');
    await input.press('ArrowDown');
    await input.press('Enter');
    assert.equal(await input.inputValue(), `${root}/src/`, 'selection only completes the directory');
    await page.getByRole('option', { name: `${root}/src/components/`, exact: true }).waitFor();
    const bounds = await page.getByRole('dialog').boundingBox();
    assert.equal(bounds.height, initialBounds.height, 'suggestions do not change dialog height');
    const popupBounds = await page.locator('[data-slot="popover-content"]').filter({ has: page.getByRole('listbox') }).boundingBox();
    assert.ok(popupBounds.height <= 240 && popupBounds.y >= 0 && popupBounds.y + popupBounds.height <= height, 'floating list stays within its height cap and viewport');
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width && bounds.y >= 0 && bounds.y + bounds.height <= height);
    const geometry = await page.getByRole('option').first().evaluate(element => {
      const icon = element.querySelector('svg').getBoundingClientRect();
      const text = element.querySelector('span').getBoundingClientRect();
      return { gap: text.left - icon.right, overflow: element.scrollWidth > element.clientWidth };
    });
    assert.equal(geometry.gap, 4);
    assert.equal(geometry.overflow, false);
    await page.screenshot({ path: `/tmp/shellspan-project-directory-${width}.png` });
    await input.press('Escape');
    assert.equal(await page.getByRole('option').count(), 0);
    requests.length = 0;
    await input.dispatchEvent('compositionstart');
    await input.fill(`${root}/src/c`);
    await page.waitForTimeout(400);
    assert.equal(requests.length, 0, 'IME composition does not issue reads');
    await input.dispatchEvent('compositionend');
    await page.getByRole('option', { name: `${root}/src/components/`, exact: true }).waitFor();
    await input.press('Tab');
    assert.equal(await input.inputValue(), `${root}/src/components/`);
    delayedQuery = `${root}/src/h`;
    const started = new Promise(resolve => { responseStarted = resolve; });
    await input.fill(delayedQuery);
    await Promise.race([started, new Promise((_, reject) => setTimeout(() => reject(new Error('directory request did not start')), 10000))]);
    await input.fill(`${root}/src/loc`);
    const latest = page.getByRole('option', { name: `${root}/src/locales/`, exact: true });
    await latest.waitFor();
    releaseResponse(); delayedQuery = undefined;
    await page.waitForTimeout(100);
    assert.deepEqual(await page.getByRole('option').allTextContents(), [`${root}/src/locales/`], 'late directory response does not replace the latest suggestions');
    await latest.click();
    assert.equal(await input.inputValue(), `${root}/src/locales/`, 'mouse selection preserves input focus');
    assert.equal(await input.evaluate(element => document.activeElement === element), true);
    await input.fill(`${root}/package.json/`);
    await page.getByRole('status').filter({ hasText: 'Cannot list directories' }).waitFor();
    assert.equal((await page.getByRole('dialog').boundingBox()).height, initialBounds.height, 'failure feedback remains floating');
    requests.length = 0;
    await input.fill(`${root}/src/h`);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.waitForTimeout(400);
    assert.equal(requests.length, 0, 'closing cancels debounce');
  }
  assert.deepEqual(errors, []);
} finally { releaseResponse?.(); await browser?.close(); await server.close(); }
