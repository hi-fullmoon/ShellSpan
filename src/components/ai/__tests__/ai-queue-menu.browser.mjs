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
  cacheDir: join(screenshots, 'vite-cache'),
  resolve: { alias: { '@': `${root}src` } },
  esbuild: { jsx: 'automatic' },
  optimizeDeps: { entries: ['src/components/ai/__tests__/ai-queue-menu.browser.tsx'], include: ['react', 'react-dom/client'] },
  server: { host: '127.0.0.1', port: 0, hmr: false },
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
      const header = page.locator('.ai-queue-header');
      await header.waitFor();
      assert.equal(await page.getByRole('button', { name: chinese ? '调整排队顺序' : 'Reorder queued input' }).count(), 0, 'Reorder dropdown trigger must be removed in favor of drag-and-drop');
      const titleGeometry = await header.evaluate(element => {
        const icon = element.firstElementChild.getBoundingClientRect();
        const label = element.querySelector('.ai-queue-title').getBoundingClientRect();
        const chevron = element.lastElementChild.getBoundingClientRect();
        return {
          iconOffset: icon.top + icon.height / 2 - (label.top + label.height / 2),
          chevronOffset: chevron.top + chevron.height / 2 - (label.top + label.height / 2),
          gap: label.left - icon.right,
          height: element.getBoundingClientRect().height,
        };
      });
      assert.equal(titleGeometry.iconOffset, -1, 'Queue icon must compensate for its lower arrow to visually align with the title');
      assert.equal(titleGeometry.chevronOffset, 0, 'Collapse icon must remain centered with the title');
      assert.equal(titleGeometry.gap, 4, 'Queue title must retain the shared icon gap');
      assert.equal(titleGeometry.height, 32, 'Queue header must match the 32px height of task and subagent strips');
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
      assert.equal(await actions.count(), 2, 'Queue row actions should only show edit and remove');
      for (let index = 0; index < 2; index += 1) {
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
      const dragRow = async (fromIndex, toIndex) => {
        const rows = page.locator('.ai-queue-row');
        const fromBox = await rows.nth(fromIndex).boundingBox();
        const toBox = await rows.nth(toIndex).boundingBox();
        const startX = fromBox.x + 40;
        const startY = fromBox.y + fromBox.height / 2;
        const endY = toBox.y + toBox.height / 2;
        await page.mouse.move(startX, startY);
        await page.mouse.down();
        await page.mouse.move(startX, startY + (endY > startY ? 6 : -6), { steps: 3 });
        await page.mouse.move(startX, endY, { steps: 8 });
        await page.mouse.up();
      };
      await dragRow(0, 1);
      await page.waitForFunction(() => document.querySelector('.ai-queue-row-content > div:first-child').textContent === '年后');
      await dragRow(1, 0);
      await page.waitForFunction(() => document.querySelector('.ai-queue-row-content > div:first-child').textContent === 'hello');
      await page.waitForTimeout(80);
      const edit = page.getByRole('button', { name: chinese ? '编辑排队输入' : 'Edit queued input', exact: true }).first();
      await edit.click();
      const composer = page.getByTestId('ai-workspace-composer');
      await page.waitForFunction(() => document.querySelector('[data-testid="ai-workspace-composer"]')?.textContent === 'hello');
      assert.equal(await page.locator('.ai-queue-editor').count(), 0, 'Editing must reuse the regular composer instead of opening a separate edit card');
      assert.equal(await page.locator('.ai-queue-row').count(), 1, 'Editing must remove the recalled item from the queue');
      assert.equal(await page.locator('.ai-queue-row-content > div:first-child').first().textContent(), '年后');
      assert.equal(await composer.evaluate(element => element === document.activeElement || element.contains(document.activeElement)), true, 'Recalling into the composer must focus the editor');
      await page.mouse.move(0, 0);
      await page.screenshot({ path: join(screenshots, `${locale}-${width}-editing.png`) });
      await page.close();
    }
  }
  console.log(`Queue menu layout, labels, keyboard focus and reordering passed in both locales at 360px and 900px. Screenshots: ${screenshots}`);
} finally {
  await browser?.close();
  await server.close();
}
