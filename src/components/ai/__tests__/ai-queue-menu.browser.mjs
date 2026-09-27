import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const screenshots = join(tmpdir(), 'shellspan-queue-menu');
await mkdir(screenshots, { recursive: true });
const server = await createServer({
  configFile: false, root, appType: 'custom', logLevel: 'error',
  resolve: { alias: { '@': `${root}src` } },
  esbuild: { jsx: 'automatic' },
  optimizeDeps: { include: ['react', 'react-dom/client'] },
  server: { host: '127.0.0.1', port: 0 },
  plugins: [tailwindcss(), {
    name: 'queue-menu-check',
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith('/?locale=')) return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html><body><main id="root" class="ai-panel-shell" style="padding-top:200px"></main><script type="module" src="/src/components/ai/__tests__/ai-queue-menu.browser.tsx"></script></body></html>');
      });
    },
  }],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch();
  for (const locale of ['zh-CN', 'en-US']) {
    for (const width of [360, 900]) {
      const page = await browser.newPage({ viewport: { width, height: 500 } });
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?locale=${locale}`);
      const chinese = locale === 'zh-CN';
      const triggers = page.getByRole('button', { name: chinese ? '调整排队顺序' : 'Reorder queued input' });
      await triggers.first().waitFor();
      const header = page.locator('.ai-queue-header');
      const headerBorder = await header.evaluate(element => {
        const style = getComputedStyle(element);
        const row = element.closest('.ai-queue-dock').querySelector('.ai-queue-row + .ai-queue-row');
        return { width: style.borderBottomWidth, style: style.borderBottomStyle, color: style.borderBottomColor, rowShadow: getComputedStyle(row).boxShadow };
      });
      assert.equal(headerBorder.width, '1px', 'Expanded header must separate the first queue item');
      assert.equal(headerBorder.style, 'solid');
      assert.ok(headerBorder.rowShadow.includes(headerBorder.color), 'Header and row separators must use the same color');
      await page.screenshot({ path: join(screenshots, `${locale}-${width}-header-border.png`) });
      await header.click();
      assert.equal(await header.getAttribute('aria-expanded'), 'false');
      assert.equal(await header.evaluate(element => getComputedStyle(element).borderBottomWidth), '0px', 'Collapsed header must not duplicate the outer bottom border');
      await header.hover();
      await header.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
      const collapsedGeometry = await header.evaluate(element => {
        const dock = element.closest('.ai-queue-dock');
        const headerRect = element.getBoundingClientRect();
        const dockRect = dock.getBoundingClientRect();
        return {
          topGap: headerRect.top - dockRect.top,
          bottomGap: dockRect.bottom - headerRect.bottom,
          background: getComputedStyle(element).backgroundColor,
          dockBackground: getComputedStyle(dock).backgroundColor,
        };
      });
      assert.equal(collapsedGeometry.topGap, 0, 'Collapsed hover must reach the top edge');
      assert.equal(collapsedGeometry.bottomGap, 0, 'Collapsed hover must reach the bottom edge');
      assert.notEqual(collapsedGeometry.background, collapsedGeometry.dockBackground);
      assert.notEqual(collapsedGeometry.background, 'rgba(0, 0, 0, 0)');
      await page.screenshot({ path: join(screenshots, `${locale}-${width}-collapsed-hover.png`) });
      await header.click();
      assert.equal(await header.getAttribute('aria-expanded'), 'true');
      await header.hover();
      await header.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
      const queueGeometry = await header.evaluate(element => {
        const dock = element.closest('.ai-queue-dock');
        const headerStyle = getComputedStyle(element);
        return {
          topGap: element.getBoundingClientRect().top - dock.getBoundingClientRect().top,
          headerRadius: headerStyle.borderRadius,
          hoverBackground: headerStyle.backgroundColor,
          dockBackground: getComputedStyle(dock).backgroundColor,
          dockRadius: getComputedStyle(dock).borderRadius,
          rowRadii: [...dock.querySelectorAll('.ai-queue-row')].map(row => getComputedStyle(row).borderRadius),
        };
      });
      assert.equal(queueGeometry.topGap, 0, 'Header hover background must reach the queue top edge');
      assert.equal(queueGeometry.headerRadius, '0px', 'Header corners must follow the outer queue clipping');
      assert.notEqual(queueGeometry.hoverBackground, queueGeometry.dockBackground);
      assert.notEqual(queueGeometry.hoverBackground, 'rgba(0, 0, 0, 0)');
      assert.notEqual(queueGeometry.dockRadius, '0px', 'Queue must retain its outer rounded corners');
      assert.ok(queueGeometry.rowRadii.every(radius => radius === '0px'), 'Row separators must have straight ends');
      await page.screenshot({ path: join(screenshots, `${locale}-${width}-header-hover.png`) });
      const actions = page.locator('.ai-queue-actions').first().getByRole('button');
      for (let index = 0; index < 3; index += 1) {
        const action = actions.nth(index);
        const before = await action.boundingBox();
        await action.hover();
        await page.waitForFunction(element => {
          const style = getComputedStyle(element);
          const surface = getComputedStyle(element.closest('.ai-queue-dock'));
          return style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== surface.backgroundColor;
        }, await action.elementHandle());
        await action.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
        assert.deepEqual(await action.boundingBox(), before, 'Hover must preserve icon button size and placement');
        await page.screenshot({ path: join(screenshots, `${locale}-${width}-hover-${index}.png`) });
        await page.mouse.move(0, 0);
      }
      await triggers.first().click();
      const menu = page.getByRole('menu');
      await menu.waitFor();
      await menu.evaluate(element => Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished)));
      await page.mouse.move(0, 0);
      await triggers.first().evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
      assert.notEqual(await triggers.first().evaluate(element => getComputedStyle(element).backgroundColor), 'rgba(0, 0, 0, 0)', 'Open menu must keep its trigger highlighted');
      assert.equal(await menu.getAttribute('data-side'), 'top');
      assert.equal(await menu.locator('[data-slot="dropdown-menu-label"]').textContent(), chinese ? '下一步骤' : 'Next step');
      const up = page.getByRole('menuitem', { name: chinese ? '上移' : 'Move up', exact: true });
      const down = page.getByRole('menuitem', { name: chinese ? '下移' : 'Move down', exact: true });
      assert.equal(await up.getAttribute('aria-disabled'), 'true');
      const geometry = await down.evaluate(element => {
        const icon = element.querySelector('svg').getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(element.lastChild);
        const text = range.getBoundingClientRect();
        return { gap: text.left - icon.right, lines: range.getClientRects().length, overflow: element.scrollWidth > element.clientWidth };
      });
      assert.equal(geometry.lines, 1);
      assert.equal(geometry.gap, 4);
      assert.equal(geometry.overflow, false);
      const box = await menu.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= width && box.width === 160);
      await page.screenshot({ path: join(screenshots, `${locale}-${width}.png`) });
      await page.keyboard.press('Escape');
      await page.waitForFunction(element => element === document.activeElement, await triggers.first().elementHandle());
      await page.keyboard.press('Enter');
      await down.waitFor();
      await down.focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('.ai-queue-row-content > span').textContent === '年后');
      await triggers.nth(1).click();
      assert.equal(await down.getAttribute('aria-disabled'), 'true');
      await up.click();
      await page.waitForFunction(() => document.querySelector('.ai-queue-row-content > span').textContent === 'hello');
      const edit = page.getByRole('button', { name: chinese ? '编辑排队输入' : 'Edit queued input', exact: true }).first();
      const rowBefore = await page.locator('.ai-queue-row').first().boundingBox();
      await edit.click();
      const editor = page.locator('.ai-queue-editor');
      const input = editor.getByRole('textbox');
      await input.waitFor();
      assert.equal(await input.evaluate(element => document.activeElement === element), true);
      const editGeometry = await editor.evaluate(element => {
        const inputRect = element.querySelector('input').getBoundingClientRect();
        const rowRect = element.closest('.ai-queue-row').getBoundingClientRect();
        return {
          topGap: inputRect.top - rowRect.top,
          bottomGap: rowRect.bottom - inputRect.bottom,
          height: inputRect.height,
          buttons: [...element.querySelectorAll('button')].map(button => {
            const rect = button.getBoundingClientRect();
            return { height: rect.height, top: rect.top - inputRect.top };
          }),
          overflow: element.scrollWidth > element.clientWidth,
        };
      });
      assert.ok(editGeometry.topGap >= 4 && editGeometry.bottomGap >= 4, 'Editor focus ring must have room above and below');
      assert.equal(editGeometry.overflow, false, 'Inline editor must fit a narrow queue');
      assert.ok(editGeometry.buttons.every(button => button.height === editGeometry.height && button.top === 0), 'Editor input and actions must align at equal heights');
      assert.deepEqual(await page.locator('.ai-queue-row').first().boundingBox(), rowBefore, 'Editing must preserve queue row geometry');
      await page.mouse.move(0, 0);
      await page.screenshot({ path: join(screenshots, `${locale}-${width}-editing.png`) });
      await input.press('Escape');
      assert.equal(await edit.evaluate(element => document.activeElement === element), true);
      await page.close();
    }
  }
  console.log(`Queue menu layout, labels, keyboard focus and reordering passed in both locales at 360px and 900px. Screenshots: ${screenshots}`);
} finally {
  await browser?.close();
  await server.close();
}
