import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';

const screenshotDirectory = '.artifacts/tests/workbench';
await mkdir(screenshotDirectory, { recursive: true });

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
        useAppStore.setState({ locale, activeWorkbenchTab: 'connections' });
        await initI18n(locale);
        document.getElementById('root').style.display = 'none';
        const host = document.createElement('div');
        host.id = 'connection-header-review';
        host.style.cssText = 'position:fixed;inset:0';
        document.body.append(host);
        ReactDOM.createRoot(host).render(React.createElement(Workbench));
      }, locale);

      const panel = page.locator('#connection-header-review [data-slot="workbench-page"]');
      const header = panel.locator('[data-slot="workbench-page-header"]');
      const search = header.getByRole('textbox', {
        name: locale === 'en-US' ? 'Search connections' : '搜索连接',
      });
      await search.waitFor();
      await page.evaluate(() => document.fonts.ready);

      for (const width of [1000, 768, 767, 500, 360, 767]) {
        const layout = await panel.evaluate((panel, width) => {
          panel.style.width = `${width}px`;
          const title = panel.querySelector('[data-slot="workbench-page-header-copy"]').getBoundingClientRect();
          const actions = panel.querySelector('[data-slot="workbench-page-header-actions"]');
          const [search, add, menu] = [...actions.children].map((child) => child.getBoundingClientRect());
          return {
            stacked: search.top >= title.bottom,
            searchWidth: search.width,
            controlHeights: [search.height, add.height, menu.height],
            buttonsVisible: add.left >= search.right && menu.left >= add.right
              && menu.right <= panel.getBoundingClientRect().right,
          };
        }, width);
        const context = `${browserType.name()} ${locale} at ${width}px`;
        assert.equal(layout.stacked, width === 360, `${context}: row placement`);
        assert.deepEqual(layout.controlHeights, [32, 32, 32], `${context}: equal control heights`);
        assert.ok(layout.buttonsVisible, `${context}: both buttons fit`);
        if (width >= 767) {
          assert.equal(layout.searchWidth, 256, `${context}: full search width`);
        } else if (width === 500) {
          assert.ok(layout.searchWidth >= 128 && layout.searchWidth < 256, `${context}: search shrinks before wrapping`);
        } else {
          await header.screenshot({ path: `${screenshotDirectory}/connection-header-${browserType.name()}-${locale}-${width}.png` });
        }
      }

      await header.screenshot({ path: `${screenshotDirectory}/connection-header-${browserType.name()}-${locale}-767.png` });
      await search.focus();
      await search.press('Tab');
      assert.equal(await header.getByRole('button', {
        name: locale === 'en-US' ? 'New Connection' : '新建连接',
      }).evaluate((button) => button === document.activeElement), true);
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

console.log('Connection header wrapping, control sizes and tab order passed in Chromium and WebKit for both locales.');
