import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(process.env.SHELLSPAN_TEST_URL ?? 'http://localhost:1420');
  await page.evaluate(async () => {
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { default: Workbench } = await import('/src/components/workbench/index.tsx');
    const { initI18n } = await import('/src/locales/index.ts');
    await initI18n('zh-CN');
    document.getElementById('root').style.display = 'none';
    const root = document.createElement('div');
    root.id = 'header-review';
    root.style.cssText = 'position:fixed;inset:0';
    document.body.append(root);
    ReactDOM.createRoot(root).render(React.createElement(Workbench));
  });
  await mkdir('.drawer-review', { recursive: true });
  for (const width of [1440, 800, 420]) {
    await page.setViewportSize({ width, height: 720 });
    const heights = [];
    for (const tab of ['connections', 'keychain', 'knownHosts', 'monitor', 'logs']) {
      await page.evaluate(async (tab) => {
        const { useAppStore } = await import('/src/stores/appStore.ts');
        useAppStore.getState().setActiveWorkbenchTab(tab);
      }, tab);
      const header = page.locator('#header-review [data-slot="workbench-page-header"]');
      await header.waitFor();
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      heights.push(await header.evaluate((element) => element.getBoundingClientRect().height));
      const actions = header.locator('[data-slot="workbench-page-header-actions"]');
      const search = actions.locator('input').first();
      if (await search.count()) await search.focus();
      const metrics = await actions.evaluate((element) => ({
        scrollbar: getComputedStyle(element).scrollbarWidth,
        height: element.clientHeight - parseFloat(getComputedStyle(element).paddingTop) - parseFloat(getComputedStyle(element).paddingBottom),
        controls: [...element.children].map((child) => child.getBoundingClientRect().height),
        clippedSearch: [...element.querySelectorAll('[data-slot="input-group"]')].some((group) => {
          const bounds = group.getBoundingClientRect();
          for (let parent = group.parentElement; parent; parent = parent.parentElement) {
            const style = getComputedStyle(parent);
            const clip = parent.getBoundingClientRect();
            if (style.overflowY !== 'visible' && (bounds.top - 1 < clip.top || bounds.bottom + 1 > clip.bottom)) return true;
            if (style.overflowX !== 'visible' && bounds.left - 1 < clip.left) return true;
          }
          return false;
        }),
      }));
      assert.equal(metrics.scrollbar, 'none', `${tab}: header actions must not show a scrollbar`);
      assert.equal(metrics.height, 32, `${tab}: scrollbar must not consume control height`);
      assert.ok(metrics.controls.every((height) => height <= metrics.height), `${tab}: controls must fit vertically`);
      assert.equal(metrics.clippedSearch, false, `${tab}: search focus ring must have top, bottom and left clearance at ${width}px`);
      await page.screenshot({ path: `.drawer-review/header-${tab}-${width}.png` });
      const scrollEdges = await actions.evaluate((element) => {
        element.scrollLeft = element.scrollWidth;
        const last = element.lastElementChild.getBoundingClientRect();
        const bounds = element.getBoundingClientRect();
        const rightClearance = getComputedStyle(element).overflowX === 'visible' || last.right + 1 <= bounds.right;
        element.scrollLeft = 0;
        const first = element.firstElementChild.getBoundingClientRect();
        const leftClearance = getComputedStyle(element).overflowX === 'visible' || first.left - 1 >= bounds.left;
        return { rightClearance, leftClearance };
      });
      assert.ok(scrollEdges.leftClearance && scrollEdges.rightClearance,
        `${tab}: controls must retain shadow clearance at both scroll ends at ${width}px`);
    }
    assert.equal(new Set(heights).size, 1, `Headers must match at ${width}px: ${heights}`);
  }
  console.log('All five workbench headers have equal heights at wide, medium and narrow widths.');
} finally {
  await browser.close();
}
