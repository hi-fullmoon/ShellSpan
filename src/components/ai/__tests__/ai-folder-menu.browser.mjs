import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
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
    name: 'folder-menu-check',
    configureServer(vite) {
      vite.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url, 'http://localhost');
        if (url.pathname === '/project-entries') {
          const query = url.searchParams.get('q') ?? '';
          const parent = query.slice(0, query.lastIndexOf('/') + 1);
          const prefix = query.slice(parent.length);
          const entries = await readdir(path.join(root, parent), { withFileTypes: true });
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ status: 'ready', code: null, excluded: 0,
            scope: { root, rootIdentity: root, target: { kind: 'local', targetId: root, sessionId: root, label: path.basename(root), cwd: root } },
            entries: entries.filter(entry => entry.name.includes(prefix)).map(entry => ({ path: parent + entry.name, kind: entry.isDirectory() ? 'directory' : 'file' })),
          }));
          return;
        }
        if (url.pathname !== '/folder-test') return next();
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
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const url = `http://127.0.0.1:${server.httpServer.address().port}/folder-test`;
  for (const width of [400, 1000]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(url);
    await page.getByRole('button', { name: 'Add file or folder' }).click();
    const menu = page.getByRole('menu');
    await menu.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
    const menuText = await menu.innerText();
    const measureRows = elements => elements.map(element => {
      const bounds = element.getBoundingClientRect();
      const icon = element.querySelector('svg').getBoundingClientRect();
      const label = element.querySelector('span').getBoundingClientRect();
      const detail = element.querySelector(':scope > span:last-child').getBoundingClientRect();
      const style = getComputedStyle(element);
      return { height: bounds.height, iconWidth: icon.width, gap: label.left - icon.right, labelLeft: label.left, detailLeft: detail.left,
        fontSize: style.fontSize, fontWeight: style.fontWeight, lineHeight: style.lineHeight };
    });
    const menuRows = await menu.getByRole('menuitem').evaluateAll(measureRows);
    assert.equal(menuRows[0].labelLeft, menuRows[1].labelLeft, 'Add action labels align');
    assert.equal(menuRows[0].detailLeft, menuRows[1].detailLeft, 'Add action descriptions align');
    assert.equal(menuRows[0].gap, 4, 'Icon and label retain a 4px gap');
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'hidden' });
    await page.getByRole('textbox').fill('@');
    const mentions = page.getByRole('listbox');
    await mentions.waitFor();
    assert.equal((await mentions.innerText()).replace(/\s+/g, ' '), menuText.replace(/\s+/g, ' '), '@ and + show the same menu content');
    assert.deepEqual(await mentions.getByRole('option').evaluateAll(measureRows), menuRows, '@ and + have matching row geometry');
    await page.screenshot({ path: `/tmp/shellspan-unified-menu-${width}.png` });
    await page.getByRole('option', { name: 'Add folder', exact: true }).click();
    await page.getByRole('option', { name: 'src/' }).waitFor();
    assert.equal(await page.getByRole('group', { name: 'Skills', exact: true }).count(), 0);
    await page.getByRole('textbox').press('Escape');
    await page.getByRole('textbox').fill('');
    await page.getByRole('button', { name: 'Add file or folder' }).click();
    await page.getByRole('menuitem', { name: 'Add folder' }).click();
    await page.getByRole('option', { name: 'src/' }).waitFor();
    assert.equal(await page.getByRole('group', { name: 'Skills', exact: true }).count(), 0);
    assert.equal(await page.getByRole('menu').count(), 0);
    assert.equal(await page.getByRole('textbox').evaluate(element => element === document.activeElement), true);
    const directory = page.getByText(root, { exact: true });
    const target = page.getByText(path.basename(root), { exact: true });
    const directoryBounds = await directory.boundingBox();
    const targetBounds = await target.boundingBox();
    const listBounds = await mentions.boundingBox();
    assert.equal(targetBounds.y, directoryBounds.y, 'Terminal target and directory share one line');
    assert.equal(targetBounds.height, directoryBounds.height, 'Neither terminal target nor directory wraps');
    assert.ok(targetBounds.x + targetBounds.width < directoryBounds.x, 'Terminal target precedes directory horizontally');
    assert.equal(await directory.getAttribute('title'), root, 'Full directory is available on hover');
    assert.ok(directoryBounds.y + directoryBounds.height <= listBounds.y, 'Directory stays above the file list');
    assert.ok(directoryBounds.x >= 0 && directoryBounds.x + directoryBounds.width <= width, 'Directory fits the viewport');
    await mentions.evaluate(element => { element.scrollTop = element.scrollHeight; });
    assert.deepEqual(await directory.boundingBox(), directoryBounds, 'Directory stays fixed while files scroll');
    await mentions.evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: `/tmp/shellspan-folder-menu-${width}.png` });
    assert.equal(await page.getByRole('option', { name: 'package.json' }).count(), 0);
    await page.getByRole('option', { name: 'src/' }).click();
    assert.equal(await page.getByRole('textbox').textContent(), '@src/ ');
    await page.getByRole('textbox').fill('@src/');
    await page.getByRole('option', { name: 'src/components/' }).waitFor();
    const names = await page.getByRole('option').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')));
    assert.ok(names.every(name => name.startsWith('src/') && name.endsWith('/')), 'Nested folder browsing excludes files');
    await page.screenshot({ path: `/tmp/shellspan-direct-directory-${width}.png` });
    await page.goto(`${url}?needsRoot`);
    await page.getByRole('button', { name: 'Add file or folder' }).click();
    await page.getByRole('menuitem', { name: 'Add folder' }).click();
    await page.getByRole('dialog').waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'Project directory' }).isVisible(), true);
    const dialog = page.getByRole('dialog');
    const input = dialog.getByRole('textbox', { name: 'Project directory' });
    const bind = dialog.getByRole('button', { name: 'Bind directory' });
    assert.equal(await bind.isDisabled(), true);
    await input.fill(root);
    assert.equal(await bind.isEnabled(), true);
    const bounds = await dialog.boundingBox();
    const inputBounds = await input.boundingBox();
    const actionBounds = await bind.boundingBox();
    assert.ok(bounds.x >= 16 && bounds.x + bounds.width <= width - 16, 'Dialog retains viewport gutters');
    assert.equal(inputBounds.height, actionBounds.height, 'Input and action use standard control heights');
    assert.ok(actionBounds.y >= inputBounds.y + inputBounds.height, 'Action is outside the input in the footer');
    assert.equal(await dialog.locator('[data-slot="dialog-footer"]').getByRole('button').count(), 2);
    await page.screenshot({ path: `/tmp/shellspan-project-directory-${width}.png` });
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
  }
  assert.deepEqual(errors, [], 'Folder menu scenarios must not raise browser errors');
} finally {
  await browser?.close();
  await server.close();
}
