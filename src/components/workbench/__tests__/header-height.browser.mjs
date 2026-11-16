import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';

const screenshotDirectory = '.artifacts/tests/workbench';
await mkdir(screenshotDirectory, { recursive: true });

const tabs = [
  ['connections', 'Connections', '连接管理'],
  ['keychain', 'Credentials', '凭据管理'],
  ['knownHosts', 'Known Hosts', '已知主机'],
  ['monitor', 'Monitor', '监控'],
  ['logs', 'Log explorer', '日志中心'],
];

for (const browserType of [chromium, webkit]) {
  const browser = await browserType.launch();
  try {
    for (const locale of ['en-US', 'zh-CN']) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 720 } });
      await page.goto(process.env.SHELLSPAN_TEST_URL ?? 'http://localhost:1420');
      await page.evaluate(async (locale) => {
        const { default: React } = await import('/node_modules/.vite/deps/react.js');
        const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
        const { default: Workbench } = await import('/src/components/workbench/index.tsx');
        const { initI18n } = await import('/src/locales/index.ts');
        const { useAppStore } = await import('/src/stores/appStore.ts');
        useAppStore.setState({ locale });
        await initI18n(locale);
        document.getElementById('root').style.display = 'none';
        const root = document.createElement('div');
        root.id = 'header-review';
        root.style.cssText = 'position:fixed;inset:0';
        document.body.append(root);
        ReactDOM.createRoot(root).render(React.createElement(Workbench));
      }, locale);

      const sidebar = page.locator('#header-review nav');
      const panel = page.locator('#header-review [data-slot="workbench-page"]');
      const header = panel.locator('[data-slot="workbench-page-header"]');
      for (const [tab, english, chinese] of tabs) {
        const title = locale === 'en-US' ? english : chinese;
        await sidebar.getByRole('button', { name: title, exact: true }).click();
        await header.getByRole('heading', { name: title, exact: true }).waitFor();
        await page.evaluate(() => document.fonts.ready);

        for (const width of [1120, 767, 320, 196]) {
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
              controlsFit: controls.every((control) => Math.abs(center(control) - center(first)) < 1
                && control.height > 0 && control.top >= bounds.top + 1 && control.bottom <= bounds.bottom - 1),
              scrollEdgesFit: first.left >= bounds.left + 1 && last.right <= bounds.right - 1,
              scrollbar: getComputedStyle(actions).scrollbarWidth,
              overflow,
            };
          }, width);

          const context = `${browserType.name()} ${locale} ${tab} at ${width}px`;
          assert.ok(layout.controlsFit, `${context}: centered controls and no vertical clipping`);
          assert.ok(layout.scrollEdgesFit, `${context}: horizontal focus clearance`);
          assert.equal(layout.scrollbar, 'none', `${context}: scrollbar must not consume control height`);
          if (width >= 767) {
            assert.ok(layout.centered, `${context}: title and actions must share a row`);
            assert.equal(layout.overflow, false, `${context}: all actions must fit`);
          }
          if (width === 196 || (width === 320 && tab === 'logs')) {
            assert.ok(layout.stacked, `${context}: actions move together to the next row`);
          }
          if (width === 767 || width === 320) {
            await header.screenshot({ path: `${screenshotDirectory}/header-${tab}-${browserType.name()}-${locale}-${width}.png` });
          }
        }
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

console.log('All workbench headers passed alignment, row placement and scroll clearance in Chromium and WebKit for both locales.');
