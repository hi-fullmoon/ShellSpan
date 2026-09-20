import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const server = await createServer({
  configFile: false, root, appType: 'custom', logLevel: 'error',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': `${root}src` } },
  server: { host: '127.0.0.1', port: 0 },
});
server.middlewares.use('/__menu', async (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(await server.transformIndexHtml('/__menu', '<html><body><div id="root"></div><script type="module" src="/scripts/perf/document-upload-page.tsx"></script></body></html>'));
});
try {
  await server.listen();
  const browser = await chromium.launch();
  try {
    for (const width of [380, 1000]) {
      const page = await browser.newPage({ viewport: { width, height: 720 } });
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__menu`);
      await page.getByRole('button', { name: 'Switch mode' }).click();
      await page.getByRole('button', { name: 'Add file or folder' }).click();
      const menu = page.getByRole('menu');
      await menu.waitFor();
      await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running'));
      const bounds = await menu.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
      assert.equal(await menu.locator('input').count(), 0);
      assert.equal(await menu.evaluate(element => getComputedStyle(element).borderRadius), width <= 420 ? '14px' : '22px');
      const menuShadow = await menu.evaluate(element => getComputedStyle(element).boxShadow);
      assert.match(menuShadow, /0px 0px 0px 0\.5px/);
      assert.ok(await menu.evaluate(element => element.classList.contains('text-muted-foreground')));
      const groupColor = await menu.locator('[data-slot="dropdown-menu-label"]').first().evaluate(element => getComputedStyle(element).color);
      assert.match(groupColor, /\/ 0\.7\)/);
      await page.screenshot({ path: `/tmp/shellspan-muted-menu-${width}.png` });
      await page.keyboard.press('Escape');
      const editor = page.getByRole('textbox');
      await editor.fill('@');
      const list = page.getByRole('listbox');
      await list.waitFor();
      const popup = page.locator('.ai-completion-popup');
      assert.equal(await list.locator('[role="group"] > p').first().evaluate(element => getComputedStyle(element).color), groupColor);
      assert.equal(await popup.evaluate(element => getComputedStyle(element).borderRadius), width <= 420 ? '14px' : '22px');
      assert.equal(await popup.evaluate(element => getComputedStyle(element).borderTopWidth), '0px');
      const questionSurface = await popup.evaluate(element => {
        const reference = document.createElement('div');
        reference.className = 'ai-question-panel';
        element.append(reference);
        const expected = getComputedStyle(reference).boxShadow;
        const actual = getComputedStyle(element).boxShadow;
        reference.remove();
        return { expected, actual };
      });
      assert.notEqual(questionSurface.actual, 'none');
      assert.equal(questionSurface.actual, questionSurface.expected);
      assert.equal(menuShadow, questionSurface.expected);
      assert.equal(await page.getByRole('option').first().evaluate(element => getComputedStyle(element).borderRadius), '8px');
      assert.equal(await popup.getByText('Keep typing to search · ↑↓ to choose · Enter to insert · Esc to close').count(), 0);
      const popupBounds = await popup.boundingBox();
      const listBounds = await list.boundingBox();
      assert.ok(Math.abs(listBounds.y + listBounds.height - popupBounds.y - popupBounds.height) <= 2);
      await page.screenshot({ path: `/tmp/shellspan-mention-style-${width}.png` });
      await editor.fill('hello @network');
      await page.getByRole('option', { name: 'Diagnose DNS, ports, routing and connectivity' }).waitFor();
      assert.equal(await list.getByRole('group', { name: 'Add', exact: true }).count(), 0);
      assert.equal(await list.getByRole('group', { name: 'Chat history', exact: true }).count(), 0);
      assert.equal(await editor.evaluate(element => document.activeElement === element), true);
      await editor.press('Enter');
      assert.equal(await editor.textContent(), 'hello /network-diagnosis ');
      await page.locator('input[type=file][accept*=".pdf"]').setInputFiles(`${root}AGENTS.md`);
      await page.getByRole('button', { name: 'Preview AGENTS.md', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.waitFor();
      await dialog.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
      const scroll = dialog.locator('[data-slot="scroll-area"]');
      const viewport = dialog.locator('[data-slot="scroll-area-viewport"]');
      const bar = dialog.locator('[data-slot="scroll-area-scrollbar"]');
      await viewport.hover();
      await bar.waitFor({ state: 'visible' });
      const dialogBounds = await dialog.boundingBox();
      const scrollBounds = await scroll.boundingBox();
      const barBounds = await bar.boundingBox();
      assert.ok(Math.abs(dialogBounds.x + dialogBounds.width - scrollBounds.x - scrollBounds.width - 1) <= 1);
      assert.ok(Math.abs(scrollBounds.x + scrollBounds.width - barBounds.x - barBounds.width) <= 1);
      assert.ok(await viewport.evaluate(element => element.scrollHeight > element.clientHeight));
      assert.ok(await viewport.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
      const header = dialog.locator('[data-slot="dialog-header"]');
      const headerBounds = await header.boundingBox();
      await viewport.evaluate(element => { element.scrollTop = element.scrollHeight; });
      assert.ok(await viewport.evaluate(element => element.scrollTop > 0));
      assert.deepEqual(await header.boundingBox(), headerBounds);
      await page.screenshot({ path: `/tmp/shellspan-document-scroll-${width}.png` });
      await page.keyboard.press('Escape');
      console.log(`${width}px: muted menu, no search input, editor mention and keyboard selection passed`);
      await page.close();
    }
  } finally { await browser.close(); }
} finally { await server.close(); }
