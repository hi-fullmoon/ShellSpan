import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
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
  resolve: { alias: { '@': `${root}src` } },
  plugins: [tailwindcss(), {
    name: 'log-header-layout',
    resolveId(id) { if (id === '/layout-runtime.js') return id; },
    load(id) {
      if (id === '/layout-runtime.js') return `
        export { default as React } from 'react';
        export { createRoot } from 'react-dom/client';
      `;
    },
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html><body><div id="root" style="height:900px"></div></body></html>');
      });
    },
  }],
  server: { host: '127.0.0.1', port: 0 },
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
  await page.evaluate(async () => {
    await import('/src/styles/base.css');
    const { React, createRoot } = await import('/layout-runtime.js');
    const { initI18n } = await import('/src/locales/index.ts');
    const { LogPanel } = await import('/src/components/workbench/log-panel.tsx');
    await initI18n('zh-CN');
    createRoot(document.getElementById('root')).render(React.createElement(LogPanel));
  });
  await page.getByPlaceholder('搜索消息、组件或错误内容…').waitFor();
  await page.evaluate(async (content) => {
    const { useLogStore } = await import('/src/stores/logStore.ts');
    useLogStore.setState({ content, loading: false, error: undefined });
  }, content);
  await page.getByRole('button', { name: '全部', exact: true }).first().click();
  await page.locator('[data-index]').last().click();
  const aside = page.locator('aside');
  await aside.waitFor();
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
    await page.screenshot({ path: `/tmp/shellspan-log-header-${width}.png` });
  }
  await page.screenshot({ path: '/tmp/shellspan-log-header-layout.png' });
  await aside.getByRole('button', { name: '关闭', exact: true }).click();
  assert.equal(await aside.count(), 0);
  console.log('Log header alignment, background, icon spacing and close action passed at wide and narrow sizes.');
} finally {
  await browser?.close();
  await server.close();
}
