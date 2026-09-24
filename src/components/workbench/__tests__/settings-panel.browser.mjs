import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { webkit } from 'playwright';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const server = await createServer({
  root,
  configFile: false,
  appType: 'custom',
  logLevel: 'error',
  resolve: { alias: { '@': `${root}src` } },
  plugins: [tailwindcss(), {
    name: 'settings-panel-density',
    resolveId(id) {
      if (id === '/settings-runtime.js') return id;
    },
    load(id) {
      if (id === '/settings-runtime.js') return `
        export { default as React } from 'react';
        export { createRoot } from 'react-dom/client';
        export { SettingsPanel } from '/src/components/workbench/settings-panel.tsx';
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
  browser = await webkit.launch();
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
  await page.evaluate(async () => {
    await import('/src/styles/base.css');
    const { React, createRoot, SettingsPanel } = await import('/settings-runtime.js');
    createRoot(document.getElementById('root')).render(React.createElement(SettingsPanel));
  });
  const settingsDialog = page.locator('[data-slot="dialog-content"]');
  await settingsDialog.waitFor();
  await page.locator('[role="tabpanel"]').waitFor();

  const SECTION_TAB_ORDER = { general: 0, terminal: 2, shortcuts: 5 };
  const openSection = async (name) => {
    await page.evaluate((index) => {
      document.querySelectorAll('[role="tab"]')[index].click();
    }, SECTION_TAB_ORDER[name]);
    await page.waitForTimeout(50);
  };

  for (const viewport of [{ width: 1280, height: 800 }, { width: 640, height: 720 }]) {
    await page.setViewportSize(viewport);

    const general = await page.evaluate(() => {
      const dialog = document.querySelector('[data-slot="dialog-content"]');
      // The dialog's own title is also an h2; scope to the content section's heading.
      const sectionHeader = dialog.querySelector('section h2')?.parentElement?.parentElement;
      const rows = [...dialog.querySelectorAll('[data-slot="settings-group"] [data-slot="field"]')];
      return {
        dialogHeight: dialog.getBoundingClientRect().height,
        viewportHeight: window.innerHeight,
        sectionHeader: sectionHeader.getBoundingClientRect().height,
        rowHeights: rows.map((row) => row.getBoundingClientRect().height),
        rowDescriptionLeading: getComputedStyle(rows[0].querySelector('[data-slot="field-description"]')).lineHeight,
      };
    });

    // Below ~720px the content column drops under the 32rem container query,
    // so rows stack the control under the label instead of sitting side by side.
    const stacked = viewport.width <= 720;
    const rowMin = stacked ? 80 : 48;
    const rowMax = stacked ? 100 : 58;

    assert.ok(
      general.rowHeights.every((height) => height >= rowMin && height <= rowMax),
      `general rows outside ${rowMin}..${rowMax}px at ${viewport.width}: ${general.rowHeights.join(',')}`,
    );
    assert.ok(general.sectionHeader <= 56, `general section header ${general.sectionHeader}px exceeds 56px at ${viewport.width}`);
    assert.ok(general.dialogHeight <= general.viewportHeight, 'settings dialog exceeds viewport height');
    assert.match(general.rowDescriptionLeading, /^1[6-9]px$/, `description line height ${general.rowDescriptionLeading} is not compact`);

    await openSection('shortcuts');
    const shortcutRow = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-slot="settings-group"] [data-slot="field-group"] > div')]
        .filter((row) => row.querySelector('button'));
      return rows[0].getBoundingClientRect().height;
    });
    assert.ok(shortcutRow >= 42 && shortcutRow <= 46, `shortcut row ${shortcutRow}px outside 42..46px at ${viewport.width}`);

    await openSection('terminal');
    const overflow = await page.evaluate(() => {
      const viewportEl = document.querySelector('[role="tabpanel"]').closest('[data-slot="scroll-area"]');
      const groupTitleRow = document.querySelector('[data-slot="settings-group"] div.min-h-5');
      return {
        horizontal: viewportEl.scrollWidth - viewportEl.clientWidth,
        cardCount: document.querySelectorAll('[data-slot="settings-group"]').length,
        firstCardRadius: getComputedStyle(document.querySelector('[data-slot="settings-group"] [data-slot="card"]')).borderRadius,
        groupTitleRow: groupTitleRow.getBoundingClientRect().height,
      };
    });
    assert.ok(overflow.horizontal <= 0, `terminal section overflows horizontally by ${overflow.horizontal}px at ${viewport.width}`);
    assert.equal(overflow.cardCount, 4, 'terminal section should render 4 groups');
    assert.ok(overflow.firstCardRadius.length > 0, 'settings cards should carry a compact radius');
    assert.ok(overflow.groupTitleRow <= 22, `group title row ${overflow.groupTitleRow}px exceeds 22px at ${viewport.width}`);
  }

  console.log('settings panel: rows 56px, shortcut rows 44px, section header ≤56px, no overflow at 640/1280px');
} finally {
  await browser?.close();
  await server.close();
}
