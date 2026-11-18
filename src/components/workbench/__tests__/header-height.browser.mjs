import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';

const screenshotDirectory = 'artifacts/tests/workbench';
await mkdir(screenshotDirectory, { recursive: true });

const tabs = [
  ['connections', 'Connections', '连接管理'],
  ['keychain', 'Credentials', '凭据管理'],
  ['knownHosts', 'Known Hosts', '已知主机'],
  ['monitor', 'Monitor', '监控'],
  ['logs', 'Log explorer', '日志中心'],
];

async function checkLogActions(page, header, locale, width, context) {
  const [moreLabel, exportLabel, diagnosticLabel, refreshLabel] = locale === 'en-US'
    ? ['More actions', 'Export', 'Diagnostic bundle', 'Refresh']
    : ['更多操作', '导出', '诊断包', '刷新'];
  const trigger = header.getByRole('button', { name: moreLabel, exact: true });
  const refresh = header.getByRole('button', { name: refreshLabel, exact: true });
  const menu = page.getByRole('menu');
  assert.equal(await menu.count(), 0, `${context}: actions start collapsed`);
  for (const name of [exportLabel, diagnosticLabel]) {
    assert.equal(await header.getByRole('button', { name, exact: true }).count(), 0, `${context}: ${name} is in the menu`);
  }
  assert.equal((await trigger.boundingBox()).height, (await refresh.boundingBox()).height,
    `${context}: more actions and refresh have the same height`);
  const mutedColor = await header.locator('[data-slot="workbench-page-header-copy"] p')
    .evaluate((description) => getComputedStyle(description).color);

  if (width <= 320) await trigger.press('ArrowDown');
  else await trigger.click();
  const exportItem = menu.getByRole('menuitem', { name: exportLabel, exact: true });
  const diagnosticItem = menu.getByRole('menuitem', { name: diagnosticLabel, exact: true });
  await exportItem.waitFor();
  await diagnosticItem.waitFor();
  assert.ok(await exportItem.isDisabled(), `${context}: no log is available to export`);
  assert.ok(await diagnosticItem.isEnabled(), `${context}: diagnostic bundle is available without a log`);
  await diagnosticItem.focus();
  await menu.screenshot({
    animations: 'disabled',
    path: `${screenshotDirectory}/log-actions-${page.context().browser().browserType().name()}-${locale}-${width}.png`,
  });
  for (const action of [exportItem, diagnosticItem]) {
    const { centerOffset, ...iconStyle } = await action.evaluate((item) => {
      const icon = item.querySelector('svg');
      const iconRect = icon.getBoundingClientRect();
      const label = item.querySelector('[data-slot="menu-item-label"]').getBoundingClientRect();
      return {
        width: iconRect.width,
        height: iconRect.height,
        gap: label.left - iconRect.right,
        stroke: getComputedStyle(icon).stroke,
        centerOffset: iconRect.top + iconRect.height / 2 - (label.top + label.height / 2),
      };
    });
    assert.deepEqual(iconStyle, { width: 14, height: 14, gap: 4, stroke: mutedColor },
      `${context}: compact muted icons with 4px label spacing`);
    assert.ok(Math.abs(centerOffset) < 0.5,
      `${context}: menu icon and label vertical centers differ by ${centerOffset}px`);
  }

  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'hidden' });
  await trigger.and(page.locator(':focus')).waitFor();
}

for (const browserType of [chromium, webkit]) {
  const browser = await browserType.launch();
  try {
    for (const locale of ['en-US', 'zh-CN']) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 720 } });
      await page.goto(process.env.SHELLSPAN_TEST_URL ?? 'http://localhost:1420');
      await page.locator('[data-slot="workbench-page-header"] h1').waitFor();
      if (locale === 'en-US') {
        await page.getByRole('button', { name: '打开个人菜单', exact: true }).click();
        await page.getByRole('menuitem', { name: '外观', exact: true }).click();
        await page.getByRole('combobox', { name: '语言', exact: true }).click();
        await page.getByRole('option', { name: 'English', exact: true }).click();
        await page.getByRole('combobox', { name: 'Language', exact: true }).waitFor();
        await page.keyboard.press('Escape');
        await page.getByRole('dialog').waitFor({ state: 'hidden' });
      }

      const sidebar = page.locator('#root nav:not([aria-label])');
      const panel = page.locator('#root [data-slot="workbench-page"]');
      const header = panel.locator('[data-slot="workbench-page-header"]');
      for (const [tab, english, chinese] of tabs) {
        const title = locale === 'en-US' ? english : chinese;
        await sidebar.getByRole('button', { name: title, exact: true }).click();
        await header.getByRole('heading', { name: title, exact: true }).waitFor();
        await page.evaluate(() => document.fonts.ready);

        for (const width of [1120, 767, 320, 256, 196]) {
          const layout = await panel.evaluate((panel, width) => {
            panel.style.width = `${width}px`;
            const title = panel.querySelector('[data-slot="workbench-page-header-copy"]').getBoundingClientRect();
            const actions = panel.querySelector('[data-slot="workbench-page-header-actions"]');
            const bounds = actions.getBoundingClientRect();
            actions.scrollLeft = 0;
            const first = actions.firstElementChild.getBoundingClientRect();
            const center = (rect) => (rect.top + rect.bottom) / 2;
            const controls = [...actions.children].map((child) => child.getBoundingClientRect());
            const overflow = actions.scrollWidth > actions.clientWidth;
            actions.scrollLeft = actions.scrollWidth;
            const last = actions.lastElementChild.getBoundingClientRect();
            actions.scrollLeft = 0;
            return {
              stacked: first.top >= title.bottom,
              centered: Math.abs(center(first) - center(title)) < 1,
              sameRow: controls.every((control) => Math.abs(center(control) - center(first)) < 1),
              controlsFit: controls.every((control) => control.height > 0 && control.top >= bounds.top + 1 && control.bottom <= bounds.bottom - 1),
              scrollEdgesFit: first.left >= bounds.left + 1 && last.right <= bounds.right - 1,
              scrollbar: getComputedStyle(actions).scrollbarWidth,
              overflow,
            };
          }, width);

          const context = `${browserType.name()} ${locale} ${tab} at ${width}px`;
          assert.ok(layout.controlsFit, `${context}: no vertical clipping`);
          assert.ok(layout.scrollEdgesFit, `${context}: horizontal focus clearance`);
          assert.equal(layout.scrollbar, 'none', `${context}: scrollbar must not consume control height`);
          if (tab === 'logs' && width <= 320) {
            assert.equal(layout.overflow, false, `${context}: every action is visible at once`);
          } else {
            assert.ok(layout.sameRow, `${context}: controls share a row`);
          }
          if (width >= 767) {
            assert.ok(layout.centered, `${context}: title and actions must share a row`);
            assert.equal(layout.overflow, false, `${context}: all actions must fit`);
          }
          if (width === 196 || (width <= 320 && tab === 'logs')) {
            assert.ok(layout.stacked, `${context}: actions move together to the next row`);
          }
          if (width === 767 || width === 320 || (width === 256 && tab === 'logs')) {
            await header.screenshot({ path: `${screenshotDirectory}/header-${tab}-${browserType.name()}-${locale}-${width}.png` });
            if (tab === 'logs') await checkLogActions(page, header, locale, width, context);
          }
        }
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

console.log('Workbench header layout and log menu checks passed in Chromium and WebKit for both locales.');
