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
        export { useAppStore } from '/src/stores/appStore.ts';
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

  const SECTION_TAB_ORDER = { general: 0, appearance: 1, terminal: 2, sftp: 3, ai: 4, shortcuts: 5, experimental: 6, feedback: 7 };
  const openSection = async (name) => {
    await page.evaluate((index) => {
      document.querySelectorAll('[role="tab"]')[index].click();
    }, SECTION_TAB_ORDER[name]);
    await page.waitForFunction((index) => {
      const tab = document.querySelectorAll('[role="tab"]')[index];
      const panels = document.querySelectorAll('[role="tabpanel"]');
      return panels.length === 1 && panels[0].id === tab.getAttribute('aria-controls') && !panels[0].hasAttribute('inert');
    }, SECTION_TAB_ORDER[name]);
    await page.waitForFunction(() => [...document.querySelectorAll('[role="tabpanel"] [data-slot="button"]')].every(button => button.getBoundingClientRect().height > 0));
    const actions = await page.locator('[role="tabpanel"] [data-slot="button"]').evaluateAll(buttons => buttons.map(button => ({
      label: button.textContent || button.getAttribute('aria-label'),
      height: button.getBoundingClientRect().height,
      iconSize: button.querySelector('svg')?.getBoundingClientRect().height,
      gap: getComputedStyle(button).columnGap,
    })));
    for (const action of actions) {
      assert.equal(action.height, 32, `${name}/${action.label}: action height`);
      if (action.iconSize !== undefined) assert.equal(action.iconSize, 14, `${name}/${action.label}: icon size`);
      assert.equal(action.gap, '4px', `${name}/${action.label}: icon and text gap`);
    }
    const selectHeights = await page.locator('[role="tabpanel"] [data-slot="select-trigger"]').evaluateAll(selects => selects.map(select => select.getBoundingClientRect().height));
    for (const height of selectHeights) assert.equal(height, 32, `${name}: Select must match action button height`);
    const headers = await page.locator('[role="tabpanel"] [data-slot="settings-group"] [data-slot="settings-group-header"]').evaluateAll(elements => elements.map(header => {
      const rect = header.getBoundingClientRect();
      const card = header.nextElementSibling.getBoundingClientRect();
      const title = header.querySelector('h3').getBoundingClientRect();
      const button = header.querySelector('button')?.getBoundingClientRect();
      return { height: rect.height, gap: card.top - rect.bottom,
        centerOffset: button ? Math.abs(title.top + title.height / 2 - button.top - button.height / 2) : 0 };
    }));
    for (const header of headers) {
      assert.equal(header.height, 32, `${name}: consistent group header height`);
      assert.equal(header.gap, 8, `${name}: group header to card gap`);
      assert.ok(header.centerOffset <= 1, `${name}: title and action must be vertically centered`);
    }
  };

  for (const viewport of [{ width: 1280, height: 800 }, { width: 640, height: 720 }]) {
    await page.setViewportSize(viewport);
    await openSection('general');
    await page.getByRole('heading', { name: '通用', exact: true }).click();
    const dividerInsets = await page.locator('[data-slot="settings-group"] [data-slot="separator"]').evaluateAll(dividers => dividers.map(divider => {
      const line = divider.getBoundingClientRect();
      const group = divider.parentElement.getBoundingClientRect();
      return { left: line.left - group.left, right: group.right - line.right };
    }));
    assert.ok(dividerInsets.every(({ left, right }) => left >= 15 && Math.abs(left - right) <= 1), `setting dividers must have equal insets: ${JSON.stringify(dividerInsets)}`);
    assert.ok(await page.locator('section [data-slot="scroll-area-viewport"]').evaluate(viewport => {
      const close = document.querySelector('[data-slot="dialog-close"]');
      return viewport.getBoundingClientRect().top >= close.getBoundingClientRect().bottom;
    }), 'scrolling settings must stay below the fixed close button');
    await page.screenshot({ path: `/tmp/shellspan-settings-buttons-${viewport.width}.png`, animations: 'disabled' });
    for (const section of ['appearance', 'sftp', 'ai']) {
      await openSection(section);
      await page.screenshot({ path: `/tmp/shellspan-settings-${section}-${viewport.width}.png` });
    }
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
    const rowMin = stacked ? 90 : 56;
    const rowMax = stacked ? 125 : 76;

    assert.ok(
      general.rowHeights.every((height) => height >= rowMin && height <= rowMax),
      `general rows outside ${rowMin}..${rowMax}px at ${viewport.width}: ${general.rowHeights.join(',')}`,
    );
    assert.ok(general.sectionHeader >= 50 && general.sectionHeader <= 110, `section heading must fit its title and description at ${viewport.width}: ${general.sectionHeader}px`);
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
      const groupTitleRow = document.querySelector('[data-slot="settings-group-header"]');
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
    assert.equal(overflow.groupTitleRow, 32, `group title row must be 32px at ${viewport.width}`);
    const titleInput = page.getByLabel('自定义模板', { exact: true });
    await titleInput.scrollIntoViewIfNeeded();
    await page.getByLabel('页签标题模板', { exact: true }).click();
    await page.getByRole('option', { name: '连接名称', exact: true }).click();
    assert.ok(await page.getByText('全局默认', { exact: true }).isVisible(), 'scope must display a readable label');
    assert.ok(await page.getByLabel('页签标题模板', { exact: true }).getByText('连接名称', { exact: true }).isVisible(), 'preset must display a readable label');
    await page.getByLabel('页签标题模板', { exact: true }).click();
    await page.getByRole('option', { name: '名称与会话序号', exact: true }).click();
    assert.equal(await titleInput.inputValue(), '${name} #${index}');
    assert.ok(await page.getByLabel('页签标题模板', { exact: true }).getByText('名称与会话序号', { exact: true }).isVisible());
    await page.getByLabel('页签标题模板', { exact: true }).click();
    await page.getByRole('option', { name: '自定义模板', exact: true }).click();
    assert.ok(await page.getByLabel('页签标题模板', { exact: true }).getByText('自定义模板', { exact: true }).isVisible());
    await titleInput.fill('${user}@${host} #${index}');
    assert.equal(await page.getByRole('button', { name: '保存', exact: true }).count(), 0);
    assert.equal(await page.evaluate(async () => (await import('/settings-runtime.js')).useAppStore.getState().terminalTabTitleTemplate), '${user}@${host} #${index}');
    await titleInput.fill('${unknown}');
    assert.equal(await titleInput.getAttribute('aria-invalid'), 'true');
    assert.equal(await page.evaluate(async () => (await import('/settings-runtime.js')).useAppStore.getState().terminalTabTitleTemplate), '${user}@${host} #${index}');
    await titleInput.fill('${name}');
    assert.equal(await page.evaluate(async () => (await import('/settings-runtime.js')).useAppStore.getState().terminalTabTitleTemplate), '${name}');
    assert.ok(await page.getByLabel('页签标题模板', { exact: true }).getByText('自定义模板', { exact: true }).isVisible());
    const titleLayout = await page.locator('[data-terminal-title-settings]').evaluate((element) => {
      const input = element.querySelector('[data-slot="input"]');
      const selects = [...element.querySelectorAll('[data-title-selects] [data-slot="select-trigger"]')];
      const rect = element.getBoundingClientRect();
      const inputRect = input.getBoundingClientRect();
      return { width: rect.width, inputWidth: inputRect.width, height: rect.height,
        selectTops: selects.map((select) => select.getBoundingClientRect().top),
        fits: element.scrollWidth <= element.clientWidth };
    });
    assert.ok(titleLayout.inputWidth > titleLayout.width - 40, 'template editor must use the full row width');
    assert.ok(titleLayout.fits, 'title settings must not overflow');
    if (viewport.width === 1280) {
      assert.equal(titleLayout.selectTops[0], titleLayout.selectTops[1], 'wide title controls must share one row');
      assert.ok(titleLayout.height < 300, 'wide title editor should remain compact');
    } else {
      assert.ok(titleLayout.selectTops[1] > titleLayout.selectTops[0], 'narrow title controls must stack');
    }
    assert.ok(await titleInput.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= window.innerWidth;
    }), 'template input must fit the narrow dialog');
    await page.screenshot({ path: `/tmp/shellspan-title-settings-${viewport.width}.png` });

    await openSection('experimental');
    const panel = page.getByRole('tabpanel');
    const petTab = page.getByRole('tab', { name: '桌面宠物', exact: true });
    assert.equal(await petTab.getAttribute('aria-selected'), 'true');
    assert.equal(await petTab.locator('.lucide-paw-print').count(), 1);
    assert.equal(await page.getByRole('tab', { name: '实验性集成', exact: true }).count(), 0);
    assert.equal(await page.getByRole('heading', { name: '桌面宠物', level: 2 }).count(), 1);
    assert.equal(await panel.locator('[data-slot="card"]').count(), 4);
    assert.equal(await panel.getByRole('switch').count(), 6);
    assert.ok(await panel.getByRole('switch').evaluateAll((controls) => controls.every((control) => {
      const labels = (control.getAttribute('aria-labelledby') ?? '').split(/\s+/).map(id => document.getElementById(id));
      return labels.some(label => label?.tagName === 'LABEL' && label.control && label.textContent.trim().length > 0);
    })), 'every pet switch must retain its clickable text label');
    assert.equal(await panel.locator('[data-slot="setting-control"] [role="switch"]').count(), 6);
    assert.equal(await panel.locator('#feedback-description').count(), 0);
    const taskGroup = panel.locator('[data-slot="integration-group"]').nth(1);
    assert.equal(await taskGroup.locator('[data-slot="separator"]').count(), 2);
    const taskRows = await taskGroup.locator('[data-slot="field"]').evaluateAll(rows => rows.map(row => {
      const label = row.querySelector('label').getBoundingClientRect();
      const control = row.querySelector('[role="switch"]').getBoundingClientRect();
      return { height: row.getBoundingClientRect().height, centerOffset: Math.abs(label.y + label.height / 2 - control.y - control.height / 2) };
    }));
    assert.deepEqual(taskRows.map(row => row.height), [40, 40, 40]);
    assert.ok(taskRows.every(row => row.centerOffset <= 1), 'compact task labels and switches must stay on the same row');
    assert.ok(await taskGroup.evaluate(group => {
      const description = group.querySelector('#petdex-categories-description');
      const card = group.querySelector('[data-slot="card"]');
      return !card.contains(description) && description.getBoundingClientRect().bottom < card.getBoundingClientRect().top;
    }), 'task description must be a subtitle above the settings card');
    await page.screenshot({ path: `/tmp/shellspan-pet-subtitle-${viewport.width}.png` });
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
        && getComputedStyle(title).fontSize === '14px';
    })), 'group titles should match other settings sections and sit above each card');
    assert.ok(geometry.switchesFit, `switches clipped at ${viewport.width}`);
    assert.equal(await panel.locator('[data-slot="collapsible-content"]:visible').count(), 0);
    await panel.locator('[data-slot="collapsible-trigger"]').first().click();
    assert.ok(await panel.locator('[data-slot="collapsible-content"]').first().isVisible());
    const connectionDetails = panel.locator('[data-slot="collapsible-trigger"]').last();
    await connectionDetails.scrollIntoViewIfNeeded();
    await connectionDetails.focus();
    await page.keyboard.press('Enter');
    assert.equal(await connectionDetails.getAttribute('aria-expanded'), 'true');
    assert.ok(await connectionDetails.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return hit === element || element.contains(hit);
    }), 'connection diagnostics must remain reachable below the message settings');
    await page.keyboard.press('Space');
    assert.equal(await connectionDetails.getAttribute('aria-expanded'), 'false');
    await page.screenshot({ path: `/tmp/shellspan-integrations-${viewport.width}.png` });

    await openSection('feedback');
    assert.equal(await panel.getByRole('switch').count(), 0);
    const feedbackButton = panel.locator('[data-slot="setting-control"] button');
    assert.equal(await feedbackButton.count(), 1);
    assert.equal(await feedbackButton.getAttribute('aria-describedby'), 'feedback-description');
    assert.equal(await panel.getByText('问题与建议', { exact: true }).count(), 1);
    assert.equal(await panel.getByText('建议提供的信息', { exact: true }).count(), 1);
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

    // Exercise the real preference controls, including translated narrow layouts.
    await openSection('appearance');
    await page.getByRole('combobox', { name: '主题', exact: true }).click();
    await page.getByRole('option', { name: '深色', exact: true }).click();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    await page.getByRole('option', { name: '深色', exact: true }).waitFor({ state: 'hidden' });
    await page.screenshot({ path: `/tmp/shellspan-settings-dark-${viewport.width}.png`, animations: 'disabled' });
    await page.getByRole('combobox', { name: '语言', exact: true }).click();
    await page.getByRole('option', { name: 'English', exact: true }).click();
    await page.getByRole('heading', { name: 'Appearance', exact: true }).waitFor();
    assert.ok(await page.getByRole('tabpanel').evaluate(element => element.scrollWidth <= element.clientWidth), 'English settings must fit');
    await page.screenshot({ path: `/tmp/shellspan-settings-english-${viewport.width}.png` });
    await page.getByRole('combobox', { name: 'Language', exact: true }).click();
    await page.getByRole('option', { name: '简体中文', exact: true }).click();
    await page.getByRole('heading', { name: '外观', exact: true }).waitFor();
    await page.getByRole('combobox', { name: '主题', exact: true }).click();
    await page.getByRole('option', { name: '浅色', exact: true }).click();
    await openSection('terminal');
    await page.getByLabel('自定义模板', { exact: true }).scrollIntoViewIfNeeded();
    await page.getByRole('tab', { name: '通用', exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('heading', { name: '通用', exact: true }).waitFor();
    assert.equal(await page.locator('section [data-slot="scroll-area-viewport"]').evaluate(element => element.scrollTop), 0, 'category changes reset content scroll');
  }

  console.log('settings panel: responsive settings rows, readable controls, keyboard actions and no overflow at 640/1280px');
} finally {
  await browser?.close();
  await server.close();
}
