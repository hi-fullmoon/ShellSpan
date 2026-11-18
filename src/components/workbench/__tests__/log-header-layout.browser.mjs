import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium } from 'playwright';

// Supply an actual application log; no IPC or component substitutes are used.
const logPath = process.argv[2];
assert.ok(logPath, 'Usage: node log-header-layout.browser.mjs /absolute/path/to/frontend.log');
const content = await readFile(logPath, 'utf8');
assert.ok(content.trim(), 'The application log must contain entries');
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const server = await createServer({
  root, configFile: false, appType: 'custom', logLevel: 'error',
  cacheDir: `${root}artifacts/tests/log-filter-selection/vite-cache`,
  resolve: { alias: { '@': `${root}src` } },
  optimizeDeps: {
    entries: ['src/components/workbench/log-panel.tsx', 'src/locales/index.ts'],
    include: ['react-dom/client'],
  },
  plugins: [react(), tailwindcss(), {
    name: 'log-header-layout',
    resolveId(id) { if (id === '/layout-runtime.js') return id; },
    load(id) {
      if (id === '/layout-runtime.js') return `
        export { default as React } from 'react';
        export { createRoot } from 'react-dom/client';
        export { LogPanel } from '/src/components/workbench/log-panel.tsx';
        export { useAppStore } from '/src/stores/appStore.ts';
        export { initI18n } from '/src/locales/index.ts';
      `;
    },
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html><body><div id="root" style="height:900px"></div><script type="module" src="/layout-runtime.js"></script></body></html>');
      });
    },
  }],
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
  await page.evaluate(async () => {
    await import('/src/styles/base.css');
    const { React, createRoot, LogPanel, initI18n } = await import('/layout-runtime.js');
    await initI18n('zh-CN');
    createRoot(document.getElementById('root')).render(React.createElement(LogPanel));
  });
  const search = page.getByPlaceholder('搜索消息、组件或错误内容…');
  await search.waitFor();
  await page.evaluate(async (content) => {
    const { useLogStore } = await import('/src/stores/logStore.ts');
    useLogStore.setState({ content, loading: false, error: undefined });
  }, content);
  const dateGroup = page.getByRole('group', { name: '日期', exact: true });
  const levelGroup = page.getByRole('group', { name: '级别', exact: true });
  const allDates = dateGroup.getByRole('button', { name: '全部', exact: true });
  const allLevels = levelGroup.getByRole('button', { name: '全部', exact: true });
  const today = dateGroup.getByRole('button', { name: '今天', exact: true });
  const warn = levelGroup.getByRole('button', { name: 'WARN', exact: true });
  assert.equal(await today.getAttribute('aria-pressed'), 'true');
  assert.equal(await allLevels.getAttribute('aria-pressed'), 'true');

  await allDates.press('Space');
  await warn.press('Space');
  await warn.evaluate((button) => button.blur());
  await page.addStyleTag({ content: '[data-slot="toggle-group-item"] { transition: none !important; }' });
  const readColors = (button) => button.evaluate((element) => {
    const { backgroundColor, color } = getComputedStyle(element);
    const context = document.createElement('canvas').getContext('2d');
    context.fillStyle = backgroundColor;
    context.fillRect(0, 0, 1, 1);
    return { backgroundColor, color, alpha: context.getImageData(0, 0, 1, 1).data[3] };
  });
  const source = page.getByRole('button', { name: '前端日志', exact: true });
  const filterToolbar = page.locator('[data-slot="workbench-page-toolbar"]').filter({ has: page.getByRole('textbox') });
  const screenshots = `${root}artifacts/tests/log-filter-selection`;
  await mkdir(screenshots, { recursive: true });
  for (const [theme, width] of [['light', 1440], ['dark', 640]]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
    const foreground = await page.evaluate(() => getComputedStyle(document.body).color);
    assert.equal((await readColors(source)).alpha, 255, `Source selection stays solid in ${theme} theme`);
    for (const [selected, unselected] of [[allDates, today], [warn, allLevels]]) {
      assert.equal(await selected.getAttribute('aria-pressed'), 'true');
      assert.equal(await unselected.getAttribute('aria-pressed'), 'false');
      const selectedColors = await readColors(selected);
      assert.equal(selectedColors.color, foreground, `Selected filter text in ${theme} theme`);
      assert.ok(selectedColors.alpha > 0 && selectedColors.alpha < 128, `Selected filter fill in ${theme} theme`);
      assert.notEqual((await readColors(unselected)).backgroundColor, selectedColors.backgroundColor);
      await selected.hover();
      const hoverColors = await readColors(selected);
      assert.equal(hoverColors.color, foreground, `Hovered filter text in ${theme} theme`);
      assert.ok(hoverColors.alpha > selectedColors.alpha && hoverColors.alpha < 128, `Hovered filter fill in ${theme} theme`);
      await page.mouse.move(0, 0);
    }
    assert.equal(await warn.locator('span').evaluate((element) => getComputedStyle(element).opacity), '1');
    await filterToolbar.screenshot({ path: `${screenshots}/${theme}-${width}.png` });
  }
  await page.evaluate(() => { delete document.documentElement.dataset.theme; });
  await page.setViewportSize({ width: 1440, height: 900 });
  await allLevels.click();
  await page.locator('[data-index]').last().click();
  const aside = page.locator('aside');
  await aside.waitFor();
  const copy = aside.getByRole('button', { name: '复制', exact: true });
  await page.locator('#root').evaluate((element) => { element.style.height = '480px'; });
  for (const width of [1440, 640]) {
    await page.setViewportSize({ width, height: 900 });
    const metrics = await aside.evaluate((aside) => {
      const header = aside.firstElementChild;
      const tableHeader = aside.previousElementSibling.firstElementChild;
      const bounds = header.getBoundingClientRect();
      const tableBounds = tableHeader.getBoundingClientRect();
      const button = header.querySelector('button').getBoundingClientRect();
      const title = header.querySelector('span').getBoundingClientRect();
      const icon = header.querySelector('svg').getBoundingClientRect();
      return {
        height: bounds.height, tableHeight: tableBounds.height,
        top: bounds.top, tableTop: tableBounds.top,
        background: getComputedStyle(header).backgroundColor,
        tableBackground: getComputedStyle(tableHeader).backgroundColor,
        buttonFits: button.top >= bounds.top && button.bottom <= bounds.bottom,
        iconGap: title.left - icon.right,
        titleCenter: title.top + title.height / 2,
        iconCenter: icon.top + icon.height / 2,
        buttonCenter: button.top + button.height / 2,
        titleLineHeight: getComputedStyle(header.querySelector('span')).lineHeight,
        titleFontSize: getComputedStyle(header.querySelector('span')).fontSize,
      };
    });
    assert.equal(metrics.height, metrics.tableHeight, `Header heights at ${width}px`);
    assert.equal(metrics.top, metrics.tableTop, `Header alignment at ${width}px`);
    assert.equal(metrics.background, metrics.tableBackground);
    assert.equal(metrics.buttonFits, true);
    assert.equal(metrics.iconGap, 4);
    assert.equal(metrics.titleCenter, metrics.iconCenter, `Title/icon centers at ${width}px`);
    assert.equal(metrics.titleCenter, metrics.buttonCenter, `Title/close centers at ${width}px`);
    assert.equal(metrics.titleLineHeight, metrics.titleFontSize);
    const scrollbar = aside.locator('[data-slot="scroll-area-scrollbar"][data-orientation="vertical"]');
    await scrollbar.waitFor();
    const copyLayout = await copy.evaluate((button) => {
      const { borderRightWidth, columnGap } = getComputedStyle(button);
      return { height: button.getBoundingClientRect().height, borderRightWidth, columnGap };
    });
    assert.deepEqual(copyLayout, { height: 24, borderRightWidth: '0px', columnGap: '4px' }, `Copy layout at ${width}px`);
    const [copyBounds, scrollbarBounds] = await Promise.all([copy.boundingBox(), scrollbar.boundingBox()]);
    assert.ok(scrollbarBounds.x - (copyBounds.x + copyBounds.width) >= 4, `Copy clearance from scrollbar at ${width}px`);
    await aside.screenshot({ path: `${screenshots}/inspector-copy-${width}.png` });
    await page.screenshot({ path: `/tmp/shellspan-log-header-${width}.png` });
  }
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const rawLog = await aside.locator('pre').last().textContent();
  await copy.press('Enter');
  await aside.getByRole('button', { name: '已复制', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), rawLog);
  await page.screenshot({ path: '/tmp/shellspan-log-header-layout.png' });
  await aside.getByRole('button', { name: '关闭', exact: true }).click();
  assert.equal(await aside.count(), 0);
  await page.locator('#root').evaluate((element) => { element.style.height = '900px'; });

  const header = page.locator('[data-slot="workbench-page-header"]');
  for (const [locale, title, messageLabel, refreshLabel, moreLabel, diagnosticLabel] of [
    ['zh-CN', '日志中心', '消息', '刷新', '更多操作', '诊断包'],
    ['en-US', 'Log explorer', 'Message', 'Refresh', 'More actions', 'Diagnostic bundle'],
  ]) {
    await page.evaluate(async (locale) => {
      const { useAppStore, initI18n } = await import('/layout-runtime.js');
      await initI18n(locale);
      useAppStore.setState({ locale });
    }, locale);
    await header.getByRole('heading', { name: title, exact: true }).waitFor();
    for (const width of [1440, 1024, 752, 256]) {
      await page.setViewportSize({ width, height: 760 });
      const context = `${locale} at ${width}px`;
      const [toolbarBounds, searchBounds, resultBounds] = await Promise.all([
        filterToolbar.boundingBox(),
        filterToolbar.locator('[data-slot="input-group"]').boundingBox(),
        filterToolbar.getByText(/^\d+ (?:条结果|results)$/).boundingBox(),
      ]);
      assert.ok(toolbarBounds && searchBounds && resultBounds, `${context}: visible search and result count`);
      assert.equal(resultBounds.y + resultBounds.height / 2, searchBounds.y + searchBounds.height / 2,
        `${context}: result count aligns with the search field`);
      const rightInset = toolbarBounds.x + toolbarBounds.width - resultBounds.x - resultBounds.width;
      assert.equal(rightInset, searchBounds.x - toolbarBounds.x, `${context}: result count aligns with the right inset`);
      assert.ok(resultBounds.x >= searchBounds.x + searchBounds.width, `${context}: count and search do not overlap`);
      for (const name of [/^(日期|Date)$/, /^(级别|Level)$/]) {
        const bounds = await filterToolbar.getByRole('group', { name }).boundingBox();
        assert.ok(bounds, `${context}: visible ${name} filters`);
        if (width >= 1020) {
          assert.ok(bounds.x >= searchBounds.x + searchBounds.width && bounds.x + bounds.width <= resultBounds.x,
            `${context}: ${name} filters fit between search and count`);
        } else {
          assert.ok(bounds.y >= searchBounds.y + searchBounds.height,
            `${context}: ${name} filters are below search`);
        }
      }

      const row = page.locator('[data-index] > button').last();
      await row.waitFor();
      const layout = await row.evaluate((element) => {
        const [time, level, , message] = element.children;
        return {
          timeTop: time.getBoundingClientRect().top,
          levelTop: level.getBoundingClientRect().top,
          messageTop: message.getBoundingClientRect().top,
          messageWidth: message.getBoundingClientRect().width,
          rowWidth: element.getBoundingClientRect().width,
        };
      });
      if (width > 420) {
        assert.equal(layout.messageTop, layout.timeTop, context);
        continue;
      }
      assert.equal(layout.levelTop, layout.timeTop, context);
      assert.ok(layout.messageTop > layout.timeTop, `${context}: message below metadata`);
      assert.ok(layout.messageWidth >= layout.rowWidth - 24, `${context}: full-width message`);
      const messageHeading = page.getByText(messageLabel, { exact: true }).first();
      assert.ok((await messageHeading.boundingBox()).width >= layout.messageWidth, context);
      const actions = header.locator('[data-slot="workbench-page-header-actions"]');
      const geometry = await actions.evaluate((element) => {
        const controls = [...element.querySelectorAll('button')].map(button => button.getBoundingClientRect());
        const bounds = element.getBoundingClientRect();
        return {
          fits: controls.every(control => control.left >= bounds.left && control.right <= bounds.right
            && control.top >= bounds.top && control.bottom <= bounds.bottom),
          height: controls.map(control => control.height),
          scroll: element.scrollWidth - element.clientWidth,
        };
      });
      assert.deepEqual(geometry, { fits: true, height: [32, 32, 32, 32], scroll: 0 }, context);
      const more = actions.getByRole('button', { name: moreLabel, exact: true });
      await actions.getByRole('button', { name: refreshLabel, exact: true }).focus();
      await page.keyboard.press('Tab');
      assert.ok(await more.evaluate(button => button === document.activeElement), context);
      await page.keyboard.press('Enter');
      await page.getByRole('menuitem', { name: diagnosticLabel, exact: true }).waitFor();
      await page.keyboard.press('Escape');
      await page.getByRole('menu').waitFor({ state: 'hidden' });
      await page.screenshot({ path: `${screenshots}/compact-${locale}.png` });
    }
  }
  console.log('Log filters, inspector, and compact bilingual layouts verified.');
} finally {
  await browser?.close();
  await server.close();
}
