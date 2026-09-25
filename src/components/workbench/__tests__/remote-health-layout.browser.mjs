import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const server = await createServer({
  root, configFile: false, appType: 'custom', logLevel: 'error',
  resolve: { alias: { '@': `${root}src` } },
  plugins: [tailwindcss(), {
    name: 'remote-health-layout',
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
        response.end('<!doctype html><html><body><div id="root"></div></body></html>');
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
    const { RemoteHealthSection } = await import('/src/components/workbench/remote-health-section.tsx');
    await initI18n('zh-CN');
    createRoot(document.getElementById('root')).render(React.createElement(RemoteHealthSection));
  });
  await page.locator('#remote-health-heading').waitFor();
  for (const width of [1200, 640, 390, 320]) {
    await page.locator('#root').evaluate((root, width) => { root.style.width = `${width}px`; }, width);
    const metrics = await page.locator('[data-slot="card-header"]').first().evaluate((header) => {
      const title = header.querySelector('[data-slot="card-title"]');
      const description = header.querySelector('[data-slot="card-description"]');
      return {
        gap: description.getBoundingClientRect().top - title.getBoundingClientRect().bottom,
        direction: getComputedStyle(header).flexDirection,
        overflow: header.scrollWidth > header.clientWidth,
      };
    });
    assert.equal(metrics.gap, 4, `Heading gap at ${width}px`);
    assert.equal(metrics.direction, width >= 640 ? 'row' : 'column');
    assert.equal(metrics.overflow, false, `Header overflow at ${width}px`);
  }
  await page.screenshot({ path: '/tmp/shellspan-remote-health-layout.png' });
  console.log('Remote health header: container layout and 4px heading spacing passed at four widths.');
} finally {
  await browser?.close();
  await server.close();
}
