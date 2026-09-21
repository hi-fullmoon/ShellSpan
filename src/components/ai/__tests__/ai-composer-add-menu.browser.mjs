import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// Run with the Vite development server.
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(process.env.SHELLSPAN_TEST_URL ?? 'http://localhost:1420');
  await page.evaluate(async () => {
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { AiComposerAddMenu } = await import('/src/components/ai/workspace/ai-composer-add-menu.tsx');
    await import('/src/components/ai/styles/context-menus.css');
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;bottom:20px;left:20px;width:calc(100% - 40px);z-index:100';
    document.body.append(host);
    ReactDOM.createRoot(host).render(React.createElement(AiComposerAddMenu, {
      disabled: false, agent: true, anchor: { current: host },
      onAddFile: () => { host.dataset.action = 'file'; },
      onAddFolder: () => { host.dataset.action = 'folder'; },
      onSkill: name => { host.dataset.action = name; },
    }));
  });
  for (const width of [1280, 640, 360]) {
    await page.setViewportSize({ width, height: 800 });
    const trigger = page.locator('.ai-composer-add');
    await trigger.waitFor();
    const plus = await trigger.locator('svg').evaluate(svg => {
      const bounds = svg.getBoundingClientRect();
      return { width: bounds.width, height: bounds.height,
        strokes: [...svg.querySelectorAll('path')].map(path => ({
          effect: getComputedStyle(path).vectorEffect,
          width: getComputedStyle(path).strokeWidth,
        })) };
    });
    assert.equal(plus.width, 16);
    assert.equal(plus.height, 16);
    assert.equal(plus.strokes.length, 2);
    for (const stroke of plus.strokes) {
      assert.equal(stroke.effect, 'non-scaling-stroke', 'Keep plus strokes solid when the icon shrinks');
      assert.equal(stroke.width, '1.5px');
    }
    await trigger.screenshot({ path: `/tmp/shellspan-composer-plus-${width}.png` });
    await page.locator('.ai-composer-add').click();
    const items = page.locator('.ai-composer-add-menu [data-slot="dropdown-menu-item"]');
    await items.first().waitFor();
    await page.locator('.ai-composer-add-menu').evaluate(async element => {
      await Promise.all(element.getAnimations().map(animation => animation.finished));
    });
    const geometry = await items.evaluateAll(elements => elements.map(element => {
      const row = element.getBoundingClientRect();
      const icon = element.querySelector('svg').getBoundingClientRect();
      return { width: icon.width, height: icon.height, rowHeight: row.height,
        centerOffset: Math.abs(icon.y + icon.height / 2 - row.y - row.height / 2) };
    }));
    assert.ok(geometry.length > 2, 'Includes file, folder and built-in skills');
    for (const icon of geometry) {
      assert.equal(icon.width, 14);
      assert.equal(icon.height, 14);
      assert.ok(icon.rowHeight >= 28, 'Keep the menu hit area');
      assert.ok(icon.centerOffset < 1, 'Keep icons vertically centered');
    }
    await page.keyboard.press('Escape');
    await page.locator('.ai-composer-add-menu').waitFor({ state: 'hidden' });
    console.log(`Verified ${geometry.length} menu icons at ${width}px`);
  }
} finally {
  await browser.close();
}
