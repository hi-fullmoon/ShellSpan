import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(process.env.SHELLSPAN_TEST_URL ?? 'http://localhost:1420');
  await page.evaluate(async () => {
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { AiComposerAddMenu } = await import('/src/components/ai/workspace/ai-composer-add-menu.tsx');
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;bottom:20px;left:20px;width:calc(100% - 40px);z-index:100';
    document.body.append(host);
    ReactDOM.createRoot(host).render(React.createElement(AiComposerAddMenu, {
      disabled: false, agent: true, anchor: { current: host },
      onAddFile: () => {}, onAddFolder: () => {}, onSkill: () => {},
    }));
  });
  for (const width of [1280, 640, 360]) {
    await page.setViewportSize({ width, height: 800 });
    await page.locator('.ai-composer-add').click();
    const menu = page.locator('.ai-composer-add-menu');
    const item = menu.getByRole('menuitem').first();
    await item.hover();
    assert.equal(await menu.locator('[title]').count(), 0);
    assert.ok(await item.getAttribute('aria-description'));
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'hidden' });
    console.log(`No native menu tooltips at ${width}px`);
  }
} finally {
  await browser.close();
}
