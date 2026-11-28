import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { chromium, webkit } from 'playwright';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
await mkdir(`${root}artifacts/tests/settings-redesign`, { recursive: true });
await mkdir(`${root}artifacts/tests/update-failure`, { recursive: true });
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
        export { useUpdateStore } from '/src/stores/updateStore.ts';
        export { updateFlowReducer } from '/src/lib/update.ts';
        export { t } from '/src/locales/index.ts';
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
  try {
    browser = await webkit.launch();
  } catch {
    browser = await chromium.launch({ channel: 'msedge' });
  }
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
      hasText: (button.textContent || '').trim().length > 0,
      height: button.getBoundingClientRect().height,
      iconSize: button.querySelector('svg')?.getBoundingClientRect().height,
      gap: getComputedStyle(button).columnGap,
    })));
    for (const action of actions) {
      assert.equal(action.height, 32, `${name}/${action.label}: action height`);
      if (action.hasText) {
        assert.equal(action.iconSize, undefined, `${name}/${action.label}: text action button should not render an icon`);
      } else if (action.iconSize !== undefined) {
        assert.equal(action.iconSize, 14, `${name}/${action.label}: icon size`);
      }
      assert.equal(action.gap, '4px', `${name}/${action.label}: icon and text gap`);
    }
    const selectHeights = await page.locator('[role="tabpanel"] [data-slot="select-trigger"]').evaluateAll(selects => selects.map(select => select.getBoundingClientRect().height));
    for (const height of selectHeights) assert.equal(height, 32, `${name}: Select must match action button height`);
    const headers = await page.locator('[role="tabpanel"] [data-slot="settings-group"] [data-slot="settings-group-header"]').evaluateAll(elements => elements.map(header => {
      const rect = header.getBoundingClientRect();
      const group = header.closest('[data-slot="settings-group"]');
      const fieldGroup = group.querySelector('[data-slot="field-group"]').getBoundingClientRect();
      const title = header.querySelector('h3').getBoundingClientRect();
      const button = header.querySelector('button')?.getBoundingClientRect();
      return { height: rect.height, gap: fieldGroup.top - rect.bottom,
        centerOffset: button ? Math.abs(title.top + title.height / 2 - button.top - button.height / 2) : 0 };
    }));
    for (const header of headers) {
      assert.equal(header.height, 32, `${name}: consistent group header height`);
      assert.ok(header.gap >= 4 && header.gap <= 12, `${name}: group header to list gap (${header.gap}px)`);
      assert.ok(header.centerOffset <= 1, `${name}: title and action must be vertically centered`);
    }
  };

  const checkFailedUpdate = async ({ checkLabel, retryLabel, screenshot }) => {
    const actions = page.locator('[data-slot="update-actions"]');
    const check = actions.getByRole('button', { name: checkLabel, exact: true });
    await check.scrollIntoViewIfNeeded();
    const before = await check.boundingBox();
    const message = await page.evaluate(async () => {
      const { t, updateFlowReducer, useUpdateStore } = await import('/settings-runtime.js');
      const message = t('update.failedFriendly');
      useUpdateStore.setState((state) => updateFlowReducer(state, {
        type: 'downloadFailed', payload: { message },
      }));
      return message;
    });

    const retry = actions.getByRole('button', { name: retryLabel, exact: true });
    const notice = page.getByRole('alert').filter({ hasText: message });
    await retry.waitFor();
    assert.equal(await actions.getByRole('button').count(), 1);
    const after = await retry.boundingBox();
    assert.equal(after.height, 32, 'retry retains the settings button height');
    assert.ok(Math.abs(after.x + after.width - before.x - before.width) <= 1, 'retry occupies the check button position');
    assert.equal(await notice.evaluate((alert) => getComputedStyle(alert).borderWidth), '0px', 'the failure notice has no border');
    assert.ok(await notice.evaluate((alert) => {
      const summary = alert.parentElement.querySelector('[data-slot="update-summary"]');
      const actions = alert.parentElement.querySelector('[data-slot="update-actions"]');
      const description = alert.querySelector('[data-slot="alert-description"]');
      const rect = alert.getBoundingClientRect();
      return rect.top > actions.getBoundingClientRect().bottom
        && Math.abs(rect.left - summary.getBoundingClientRect().left) <= 1
        && Math.abs(rect.right - actions.getBoundingClientRect().right) <= 1
        && description.scrollWidth <= description.clientWidth;
    }), 'the complete failure notice fits across the row below the retry button');
    await notice.locator('xpath=ancestor::*[@data-slot="settings-group"]').screenshot({ path: screenshot, animations: 'disabled' });
    await page.evaluate(async () => (await import('/settings-runtime.js')).useUpdateStore.getState().reset());
    await notice.waitFor({ state: 'hidden' });
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
    assert.ok(dividerInsets.every(({ left, right }) => Math.abs(left) <= 1 && Math.abs(right) <= 1), `setting dividers must span cleanly across rows: ${JSON.stringify(dividerInsets)}`);
    assert.ok(await page.locator('section [data-slot="scroll-area-viewport"]').evaluate(viewport => {
      const close = document.querySelector('[data-slot="dialog-close"]');
      return viewport.getBoundingClientRect().top >= close.getBoundingClientRect().bottom;
    }), 'scrolling settings must stay below the fixed close button');
    assert.equal(await page.locator('aside [role="tab"] svg').count(), 0, 'sidebar navigation items must not render icons');
    await page.screenshot({ path: `${root}artifacts/tests/settings-redesign/general-${viewport.width}.png`, animations: 'disabled' });
    for (const section of ['appearance', 'sftp', 'ai']) {
      await openSection(section);
      await page.screenshot({ path: `${root}artifacts/tests/settings-redesign/${section}-${viewport.width}.png`, animations: 'disabled' });
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
    const rowMin = stacked ? 95 : 56;
    const rowMax = stacked ? 140 : 88;

    assert.ok(
      general.rowHeights.every((height) => height >= rowMin && height <= rowMax),
      `general rows outside ${rowMin}..${rowMax}px at ${viewport.width}: ${general.rowHeights.join(',')}`,
    );
    assert.ok(general.sectionHeader >= 40 && general.sectionHeader <= 110, `section heading must fit its title and description at ${viewport.width}: ${general.sectionHeader}px`);
    assert.ok(general.dialogHeight <= general.viewportHeight, 'settings dialog exceeds viewport height');
    assert.match(general.rowDescriptionLeading, /^1[6-9]px$/, `description line height ${general.rowDescriptionLeading} is not compact`);
    await checkFailedUpdate({
      checkLabel: '检查更新', retryLabel: '重试',
      screenshot: `${root}artifacts/tests/update-failure/zh-CN-${viewport.width}.png`,
    });

    await openSection('shortcuts');
    const shortcutRow = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-slot="settings-group"] [data-slot="field-group"] > div')]
        .filter((row) => row.querySelector('button'));
      return rows[0].getBoundingClientRect().height;
    });
    assert.ok(shortcutRow >= 42 && shortcutRow <= 48, `shortcut row ${shortcutRow}px outside 42..48px at ${viewport.width}`);

    await openSection('terminal');
    const overflow = await page.evaluate(() => {
      const viewportEl = document.querySelector('[role="tabpanel"]').closest('[data-slot="scroll-area"]');
      const groupTitleRow = document.querySelector('[data-slot="settings-group-header"]');
      return {
        horizontal: viewportEl.scrollWidth - viewportEl.clientWidth,
        groupCount: document.querySelectorAll('[data-slot="settings-group"]').length,
        groupTitleRow: groupTitleRow.getBoundingClientRect().height,
      };
    });
    assert.ok(overflow.horizontal <= 0, `terminal section overflows horizontally by ${overflow.horizontal}px at ${viewport.width}`);
    assert.equal(overflow.groupCount, 4, 'terminal section should render 4 groups');
    assert.equal(overflow.groupTitleRow, 32, `group title row must be 32px at ${viewport.width}`);
    const titleInput = page.getByLabel('自定义模板', { exact: true });
    await titleInput.scrollIntoViewIfNeeded();
    assert.equal(await titleInput.evaluate((input) => getComputedStyle(input).backgroundColor), 'rgba(0, 0, 0, 0)',
      'The custom template input must show the card surface');
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
    await page.screenshot({ path: `${root}artifacts/tests/settings-redesign/title-settings-${viewport.width}.png`, animations: 'disabled' });

    await openSection('experimental');
    const panel = page.getByRole('tabpanel');
    const petTab = page.getByRole('tab', { name: '桌面宠物', exact: true });
    assert.equal(await petTab.getAttribute('aria-selected'), 'true');
    assert.equal(await petTab.locator('svg').count(), 0);
    assert.equal(await page.getByRole('tab', { name: '实验性集成', exact: true }).count(), 0);
    assert.equal(await page.getByRole('heading', { name: '桌面宠物', level: 2 }).count(), 1);
    assert.equal(await panel.locator('[data-slot="settings-group"], [data-slot="integration-group"], [data-slot="petdex-diagnostics"]').count(), 4);
    assert.equal(await panel.getByRole('switch').count(), 6);
    assert.ok(await panel.getByRole('switch').evaluateAll((controls) => controls.every((control) => {
      const labels = (control.getAttribute('aria-labelledby') ?? '').split(/\s+/).map(id => document.getElementById(id));
      return labels.some(label => label?.tagName === 'LABEL' && label.control && label.textContent.trim().length > 0);
    })), 'every pet switch must retain its clickable text label');
    assert.equal(await panel.locator('[data-slot="setting-control"] [role="switch"]').count(), 6);
    assert.equal(await panel.locator('#feedback-description').count(), 0);
    assert.equal(await panel.locator('[data-slot="petdex-preferences"]').getAttribute('data-inactive'), 'true');
    const taskGroup = panel.locator('[data-slot="integration-group"]').first();
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
      const firstRow = group.querySelector('[data-slot="field"]');
      return description.getBoundingClientRect().bottom < firstRow.getBoundingClientRect().top;
    }), 'task description must sit above the settings rows');
    await page.screenshot({ path: `${root}artifacts/tests/settings-redesign/experimental-${viewport.width}.png`, animations: 'disabled' });
    const geometry = await panel.evaluate((element) => {
      const sections = [...element.querySelectorAll('[data-slot="settings-group"], [data-slot="integration-group"], [data-slot="petdex-diagnostics"]')];
      return {
        overflow: element.scrollWidth - element.clientWidth,
        gaps: sections.slice(1).map((section, index) => Math.round(section.getBoundingClientRect().top - sections[index].getBoundingClientRect().bottom)),
        switchesFit: [...element.querySelectorAll('[role="switch"]')].every((control) => control.getBoundingClientRect().right <= element.getBoundingClientRect().right),
      };
    });
    assert.ok(geometry.overflow <= 0, `integration overflow at ${viewport.width}`);
    assert.deepEqual(geometry.gaps, [28, 28, 28]);
    assert.deepEqual(await panel.getByRole('heading', { level: 3 }).allTextContents(), ['桌宠联动', '任务提醒', '消息气泡']);
    assert.ok(await panel.locator('[data-slot="settings-group"], [data-slot="integration-group"]').evaluateAll((groups) => groups.every((group) => {
      const title = group.querySelector('h3');
      const firstRow = group.querySelector('[data-slot="field"]');
      return title.id === group.getAttribute('aria-labelledby')
        && title.getBoundingClientRect().bottom < firstRow.getBoundingClientRect().top
        && getComputedStyle(title).fontSize === '14px';
    })), 'group titles should match other settings sections and sit above each list');
    assert.ok(geometry.switchesFit, `switches clipped at ${viewport.width}`);
    assert.equal(await panel.locator('[data-slot="collapsible-trigger"]').count(), 1);
    assert.equal(await panel.locator('[data-slot="collapsible-content"]:visible').count(), 0);
    const diagnosticsTrigger = panel.locator('[data-slot="collapsible-trigger"]').first();
    await diagnosticsTrigger.scrollIntoViewIfNeeded();
    await diagnosticsTrigger.focus();
    await page.keyboard.press('Enter');
    assert.equal(await diagnosticsTrigger.getAttribute('aria-expanded'), 'true');
    assert.ok(await panel.locator('[data-slot="collapsible-content"]').first().isVisible());
    assert.ok(await diagnosticsTrigger.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return hit === element || element.contains(hit);
    }), 'unified diagnostics must remain reachable below the message settings');
    await page.keyboard.press('Space');
    assert.equal(await diagnosticsTrigger.getAttribute('aria-expanded'), 'false');
    await page.screenshot({ path: `${root}artifacts/tests/settings-redesign/integrations-${viewport.width}.png`, animations: 'disabled' });

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
    await page.screenshot({ path: `${root}artifacts/tests/settings-redesign/feedback-${viewport.width}.png`, animations: 'disabled' });

    // Exercise the real preference controls, including translated narrow layouts.
    await openSection('appearance');
    const themeToggleGroup = page.getByRole('group', { name: '主题', exact: true });
    await themeToggleGroup.getByRole('button', { name: '深色', exact: true }).click();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    assert.equal(await page.locator('aside [role="tab"][data-active]').evaluate((tab) => getComputedStyle(tab).borderTopColor), 'rgba(0, 0, 0, 0)', 'dark active sidebar tab must not show a border');
    await page.screenshot({ path: `${root}artifacts/tests/settings-redesign/appearance-dark-${viewport.width}.png`, animations: 'disabled' });
    await page.getByRole('combobox', { name: '语言', exact: true }).click();
    await page.screenshot({ path: `${root}artifacts/tests/settings-redesign/select-open-dark-${viewport.width}.png`, animations: 'disabled' });
    await page.getByRole('option', { name: 'English', exact: true }).click();
    await page.getByRole('heading', { name: 'Appearance', exact: true }).waitFor();
    assert.ok(await page.getByRole('tabpanel').evaluate(element => element.scrollWidth <= element.clientWidth), 'English settings must fit');
    await openSection('general');
    await checkFailedUpdate({
      checkLabel: 'Check for updates', retryLabel: 'Retry',
      screenshot: `${root}artifacts/tests/update-failure/en-US-${viewport.width}.png`,
    });
    await openSection('appearance');
    await page.getByRole('combobox', { name: 'Language', exact: true }).click();
    await page.getByRole('option', { name: '简体中文', exact: true }).click();
    await page.getByRole('heading', { name: '外观', exact: true }).waitFor();
    await page.getByRole('group', { name: '主题', exact: true }).getByRole('button', { name: '浅色', exact: true }).click();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    await page.getByRole('combobox', { name: '语言', exact: true }).click();
    await page.screenshot({ path: `${root}artifacts/tests/settings-redesign/select-open-light-${viewport.width}.png`, animations: 'disabled' });
    await page.keyboard.press('Escape');
    await openSection('terminal');
    await page.getByLabel('自定义模板', { exact: true }).scrollIntoViewIfNeeded();
    await page.getByRole('tab', { name: '通用', exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('heading', { name: '通用', exact: true }).waitFor();
    assert.equal(await page.locator('section [data-slot="scroll-area-viewport"]').evaluate(element => element.scrollTop), 0, 'category changes reset content scroll');
    await page.evaluate(async () => {
      const { useAppStore } = await import('/settings-runtime.js');
      useAppStore.getState().openSettings('terminal', 'terminal-title-template');
    });
    await page.getByRole('heading', { name: '终端', exact: true }).waitFor();
    await page.waitForFunction(async () => (await import('/settings-runtime.js')).useAppStore.getState().pendingSettingsTarget === null);
    const titleVisibility = await page.evaluate(() => {
      const viewportEl = document.querySelector('section [data-slot="scroll-area-viewport"]');
      const targetEl = document.querySelector('[data-settings-target="terminal-title-template"]');
      const viewportRect = viewportEl.getBoundingClientRect();
      const targetRect = targetEl.getBoundingClientRect();
      return {
        scrollTop: viewportEl.scrollTop,
        visibleTop: targetRect.top >= viewportRect.top - 1,
        visibleBottom: targetRect.bottom <= viewportRect.bottom + 1,
      };
    });
    assert.ok(titleVisibility.scrollTop > 0, `opening terminal title template target must scroll viewport at ${viewport.width}`);
    assert.ok(titleVisibility.visibleTop && titleVisibility.visibleBottom, `terminal title template target must be visible inside viewport at ${viewport.width}`);
  }

  console.log('settings panel: responsive settings rows, readable controls, keyboard actions and no overflow at 640/1280px');
} finally {
  await browser?.close();
  await server.close();
}
