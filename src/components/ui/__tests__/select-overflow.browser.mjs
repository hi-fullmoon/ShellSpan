import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { webkit } from 'playwright';

// Run with: node src/components/ui/__tests__/select-overflow.browser.mjs
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const server = await createServer({
  root,
  configFile: false,
  appType: 'custom',
  logLevel: 'error',
  resolve: { alias: { '@': `${root}src` } },
  plugins: [tailwindcss(), {
    name: 'select-overflow',
    resolveId(id) {
      if (id === '/select-overflow-runtime.js') return id;
    },
    load(id) {
      if (id === '/select-overflow-runtime.js') return `
        export { default as React } from 'react';
        export { createRoot } from 'react-dom/client';
        export { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '/src/components/ui/select.tsx';
      `;
    },
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end(`<!doctype html><html><head><style>html,body,#root{height:100%;margin:0}</style></head><body><div id="root"></div></body></html>`);
      });
    },
  }],
  server: { host: '127.0.0.1', port: 0 },
});

const labels = [
  '175.178.66.45 · root@175.178.66.45 · /srv/apps/example',
  '10.0.0.1 · root@10.0.0.1 · /var/www/very-long-path/example',
];

let browser;
try {
  await server.listen();
  browser = await webkit.launch();
  const page = await browser.newPage();

  const closedTriggerMetrics = () => page.evaluate(() => {
    const trigger = document.querySelector('[data-slot="select-trigger"]');
    const value = trigger.querySelector('[data-slot="select-value"]');
    const icon = trigger.querySelector('svg');
    const triggerBox = trigger.getBoundingClientRect();
    const valueBox = value.getBoundingClientRect();
    const iconBox = icon.getBoundingClientRect();
    return {
      textOverflow: getComputedStyle(value).textOverflow,
      valueInsideTrigger: valueBox.right <= triggerBox.right - 1 && valueBox.left >= triggerBox.left,
      iconInsideTrigger: iconBox.right <= triggerBox.right && iconBox.left >= triggerBox.left,
      triggerWidth: triggerBox.width,
    };
  });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
  await page.evaluate(async (options) => {
    await import('/src/styles/base.css');
    const { React, createRoot, Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } = await import('/select-overflow-runtime.js');
    createRoot(document.getElementById('root')).render(
      React.createElement('div', { style: { width: `${options.containerWidth}px`, padding: '8px' } },
        React.createElement(Select, { defaultValue: 't1', items: options.labels.map((label, index) => ({ value: `t${index + 1}`, label })) },
          React.createElement(SelectTrigger, { id: 'select-overflow-check', size: 'sm' }, React.createElement(SelectValue, null)),
          React.createElement(SelectContent, null,
            React.createElement(SelectGroup, null,
              ...options.labels.map((label, index) => React.createElement(SelectItem, { key: label, value: `t${index + 1}` }, label)))),
        )),
    );
  }, { labels, containerWidth: 260 });
  await page.waitForSelector('[data-slot="select-trigger"]');

  const failures = [];
  let closedTriggerWidth = 0;
  const triggerMetrics = {};

  const closePopup = async () => {
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-slot="select-content"]', { state: 'hidden' });
  };
  const openPopup = async () => {
    await page.click('[data-slot="select-trigger"]');
    await page.waitForSelector('[data-slot="select-content"]');
    await page.waitForTimeout(250);
  };

  for (const viewport of [{ width: 1024, height: 700, name: 'wide' }, { width: 340, height: 700, name: 'narrow' }]) {
    await page.setViewportSize(viewport);
    closedTriggerWidth = (await page.evaluate(() => document.querySelector('[data-slot="select-trigger"]').getBoundingClientRect().width));

    triggerMetrics[viewport.name] = await closedTriggerMetrics();
    const closed = triggerMetrics[viewport.name];
    if (closed.textOverflow !== 'ellipsis' || !closed.valueInsideTrigger || !closed.iconInsideTrigger) {
      failures.push(`${viewport.name}: trigger value not ellipsized inside the trigger (${JSON.stringify(closed)})`);
    }

    await openPopup();
    const popup = await page.evaluate((anchorWidth) => {
      const content = document.querySelector('[data-slot="select-content"]');
      const contentBox = content.getBoundingClientRect();
      return {
        width: contentBox.width,
        left: contentBox.left,
        right: contentBox.right,
        insideViewport: contentBox.left >= -0.5 && contentBox.right <= window.innerWidth + 0.5,
        atLeastTriggerWidth: contentBox.width >= anchorWidth - 0.5,
        items: [...content.querySelectorAll('[data-slot="select-item"]')].map((item) => {
          const text = item.querySelector(':scope > div');
          const textBox = text.getBoundingClientRect();
          const style = getComputedStyle(text);
          return {
            clipped: textBox.right > contentBox.right - 2 || textBox.left < contentBox.left,
            ellipsis: style.textOverflow,
            minWidth: style.minWidth,
          };
        }),
      };
    }, closedTriggerWidth);
    await closePopup();

    if (!popup.insideViewport || !popup.atLeastTriggerWidth) {
      failures.push(`${viewport.name}: popup not sized between trigger and viewport (${JSON.stringify(popup)})`);
    }
    for (const [index, item] of popup.items.entries()) {
      if (item.clipped || item.minWidth !== '0px' || item.ellipsis !== 'ellipsis') {
        failures.push(`${viewport.name}: option ${index} not truncating inside the popup (${JSON.stringify(item)})`);
      }
    }
  }

  // Wide viewport with room to grow: the popup must widen past the narrow
  // trigger so the long target labels stay fully readable.
  await page.setViewportSize({ width: 1024, height: 700 });
  await openPopup();
  const grownWidth = await page.evaluate(() => document.querySelector('[data-slot="select-content"]').getBoundingClientRect().width);
  await closePopup();
  if (grownWidth <= closedTriggerWidth + 1) {
    failures.push(`wide: popup stayed at trigger width ${closedTriggerWidth.toFixed(0)}px instead of growing for long labels (${grownWidth.toFixed(0)}px)`);
  }

  if (failures.length > 0) {
    console.error(`select overflow render check failed:\n  - ${failures.join('\n  - ')}`);
    process.exitCode = 1;
  } else {
    console.log('select overflow render check passed: trigger values ellipsize with the chevron intact, '
      + 'popups grow between the anchor and viewport width, and long options truncate instead of clipping');
  }
} catch (error) {
  console.error(`select overflow render check failed: ${error?.message ?? error}`);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await server.close();
}
