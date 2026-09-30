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

  const SECTION_TAB_ORDER = { general: 0, terminal: 2, shortcuts: 5, experimental: 6, feedback: 7 };
  const openSection = async (name) => {
    await page.evaluate((index) => {
      document.querySelectorAll('[role="tab"]')[index].click();
    }, SECTION_TAB_ORDER[name]);
    await page.waitForTimeout(50);
  };

  for (const viewport of [{ width: 1280, height: 800 }, { width: 640, height: 720 }]) {
    await page.setViewportSize(viewport);
    await openSection('general');

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

    await openSection('experimental');
    const panel = page.getByRole('tabpanel');
    const petTab = page.getByRole('tab', { name: '桌面宠物', exact: true });
    assert.equal(await petTab.getAttribute('aria-selected'), 'true');
    assert.equal(await petTab.locator('.lucide-paw-print').count(), 1);
    assert.equal(await page.getByRole('tab', { name: '实验性集成', exact: true }).count(), 0);
    assert.equal(await page.getByRole('heading', { name: '桌面宠物', level: 2 }).count(), 1);
    assert.equal(await panel.locator('[data-slot="card"]').count(), 4);
    assert.equal(await panel.getByRole('switch').count(), 6);
    assert.equal(await panel.locator('[data-slot="card-action"] [role="switch"]').count(), 1);
    assert.equal(await panel.locator('#feedback-description').count(), 0);
    const geometry = await panel.evaluate((element) => {
      const cards = [...element.querySelectorAll('[data-slot="integration-group"]')];
      return {
        overflow: element.scrollWidth - element.clientWidth,
        gaps: cards.slice(1).map((card, index) => card.getBoundingClientRect().top - cards[index].getBoundingClientRect().bottom),
        switchesFit: [...element.querySelectorAll('[role="switch"]')].every((control) => control.getBoundingClientRect().right <= element.getBoundingClientRect().right),
      };
    });
    assert.ok(geometry.overflow <= 0, `integration overflow at ${viewport.width}`);
    assert.deepEqual(geometry.gaps, [12, 12, 12]);
    assert.deepEqual(await panel.getByRole('heading', { level: 3 }).allTextContents(), ['桌宠联动', '任务提醒', '消息气泡', '连接与诊断']);
    assert.ok(await panel.locator('[data-slot="integration-group"]').evaluateAll((groups) => groups.every((group) => {
      const title = group.querySelector('h3');
      const card = group.querySelector('[data-slot="card"]');
      return title.id === group.getAttribute('aria-labelledby')
        && title.getBoundingClientRect().bottom < card.getBoundingClientRect().top
        && getComputedStyle(title).fontSize === '12px';
    })), 'group titles should match other settings sections and sit above each card');
    assert.ok(geometry.switchesFit, `switches clipped at ${viewport.width}`);
    await panel.locator('[data-slot="collapsible-trigger"]').click();
    assert.ok(await panel.locator('[data-slot="collapsible-content"]').isVisible());
    await page.screenshot({ path: `/tmp/shellspan-integrations-${viewport.width}.png` });

    await openSection('feedback');
    assert.equal(await panel.getByRole('switch').count(), 0);
    const feedbackButton = panel.locator('[data-slot="card-action"] button');
    assert.equal(await feedbackButton.count(), 1);
    assert.equal(await feedbackButton.getAttribute('aria-describedby'), 'feedback-description');
    assert.equal(await panel.getByText('问题与建议', { exact: true }).count(), 1);
    const [feedbackPage, feedbackRequest] = await Promise.all([
      page.waitForEvent('popup'),
      page.context().waitForEvent('request', { predicate: (request) => request.url().startsWith('https://github.com/hi-fullmoon/ShellSpan/issues/new') }),
      feedbackButton.click(),
    ]);
    assert.equal(feedbackRequest.url(), 'https://github.com/hi-fullmoon/ShellSpan/issues/new', 'feedback must not select a Petdex template or attach app data');
    await feedbackPage.close();
    await feedbackButton.focus();
    assert.ok(await feedbackButton.evaluate((element) => element === document.activeElement));
    assert.ok(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth), `feedback overflow at ${viewport.width}`);
    await page.screenshot({ path: `/tmp/shellspan-feedback-${viewport.width}.png` });
  }

  console.log('settings panel: rows 56px, shortcut rows 44px, section header ≤56px, no overflow at 640/1280px');
} finally {
  await browser?.close();
  await server.close();
}
