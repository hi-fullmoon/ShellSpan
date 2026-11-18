import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createCanvas, loadImage } from 'canvas';
import { chromium, webkit } from 'playwright';

const screenshotDirectory = 'artifacts/tests/workbench';
await mkdir(screenshotDirectory, { recursive: true });

for (const browserType of [chromium, webkit]) {
  const browser = await browserType.launch();
  try {
    for (const locale of ['en-US', 'zh-CN']) {
      const page = await browser.newPage({ colorScheme: 'light', viewport: { width: 1440, height: 720 } });
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
      const moreActions = header.getByRole('button', {
        name: locale === 'en-US' ? 'More actions' : '更多操作',
      });
      const readBackground = (locator) => locator.evaluate(async (element) => {
        await new Promise(requestAnimationFrame);
        await Promise.all(element.getAnimations().map((animation) => animation.finished));
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        context.fillStyle = getComputedStyle(element).backgroundColor;
        context.fillRect(0, 0, 1, 1);
        return [...context.getImageData(0, 0, 1, 1).data];
      });
      const pageBackground = await readBackground(page.locator('body'));
      const secondary = await readBackground(moreActions);
      await moreActions.hover();
      const hover = await readBackground(moreActions);
      for (const [label, [red, green, blue, alpha]] of Object.entries({ pageBackground, secondary, hover })) {
        assert.deepEqual([green, blue, alpha], [red, red, 255], `${label} uses an opaque neutral gray in light mode`);
      }
      assert.ok(secondary[0] < hover[0] && hover[0] < pageBackground[0], 'Secondary, hover and page backgrounds remain distinct');
      await page.mouse.move(0, 0);
      await search.fill('SSH');
      const countSelectionGrayPixels = async () => {
        const image = await loadImage(await search.screenshot());
        const context = createCanvas(image.width, image.height).getContext('2d');
        context.drawImage(image, 0, 0);
        const { data } = context.getImageData(0, 0, image.width, image.height);
        let count = 0;
        for (let pixel = 0; pixel < data.length; pixel += 4) {
          const red = data[pixel];
          if (red === data[pixel + 1] && red === data[pixel + 2] && red >= 170 && red <= 220) count++;
        }
        return count;
      };
      const beforeSelection = await countSelectionGrayPixels();
      await search.selectText();
      assert.ok(await countSelectionGrayPixels() > beforeSelection + 50, 'Selected search text paints a distinct neutral gray background');
      await search.clear();
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

console.log('Connection header layout, tab order and light colors passed in Chromium and WebKit for both locales.');
