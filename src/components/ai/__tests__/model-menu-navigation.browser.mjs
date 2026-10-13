import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, webkit } from 'playwright';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const server = await createServer({
  configFile: false, root, appType: 'custom', logLevel: 'error',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': `${root}src` } },
  server: { host: '127.0.0.1', port: 0 },
});
server.middlewares.use('/__model_navigation', async (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(await server.transformIndexHtml('/__model_navigation',
    '<html><body><button id="outside">Outside</button><div id="root"></div></body></html>'));
});

try {
  await server.listen();
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      for (const viewport of [{ width: 380, height: 360 }, { width: 1000, height: 900 }]) {
        const page = await browser.newPage({ viewport });
        page.setDefaultTimeout(5000);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__model_navigation`);
        await page.evaluate(async () => {
          const { default: React } = await import('/@id/react');
          const { default: ReactDOM } = await import('/@id/react-dom/client');
          const { AiComposerModelSelector } = await import('/src/components/ai/workspace/ai-composer-model-selector.tsx');
          const { AI_PROVIDER_PRESETS, useAiSettingsStore } = await import('/src/stores/aiSettingsStore.ts');
          const { default: catalog } = await import('/protocol/llm/catalog.json');
          const { initI18n } = await import('/src/locales/index.ts');
          await import('/src/styles/base.css');
          await import('/src/components/ai/styles/styles.css');
          await initI18n('zh-CN');
          const providers = AI_PROVIDER_PRESETS.flatMap(preset =>
            Object.keys(catalog.presets[preset.preset]?.models ?? {}).map(model => ({
              ...preset, id: preset.preset, model,
            })));
          const selection = providers[0];
          useAiSettingsStore.setState({ providers, defaultProviderId: selection.id });
          ReactDOM.createRoot(document.getElementById('root')).render(React.createElement('main', {
            style: { position: 'fixed', bottom: 16, right: 16 },
          }, React.createElement(AiComposerModelSelector, { selection })));
        });
        const trigger = page.locator('.ai-model-trigger');
        const menu = page.locator('.ai-model-menu');
        for (const [index, pane] of ['model'].entries()) {
          // Ordinary clicks and keyboard activation still navigate without closing.
          await trigger.click();
          await page.locator('.ai-model-menu-cell').nth(index).click();
          assert.equal(await menu.getAttribute('data-pane'), pane);
          await page.keyboard.press('Escape');
          await page.locator('.ai-model-menu-cell').nth(index).focus();
          await page.keyboard.press('Enter');
          assert.equal(await menu.getAttribute('data-pane'), pane);
          await page.keyboard.press('Escape');
          await page.keyboard.press('Escape');
          await menu.waitFor({ state: 'hidden' });

          // Real mouse events reproduce trigger press -> move -> release on a
          // root item's text, including the detached descendant event target.
          const bounds = await trigger.boundingBox();
          await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
          await page.mouse.down();
          await page.locator('.ai-model-menu-cell').nth(index).waitFor();
          await page.waitForTimeout(250); // Base UI enables drag-release activation after 200ms.
          const label = await page.locator('.ai-model-menu-cell').nth(index).locator('span').first().boundingBox();
          await page.mouse.move(label.x + label.width / 2, label.y + label.height / 2);
          await page.mouse.up();
          await page.waitForFunction(expected =>
            document.querySelector('.ai-model-menu')?.getAttribute('data-pane') === expected, pane);
          if (pane === 'model') {
            assert.equal(await menu.getByRole('textbox').evaluate(element => element === document.activeElement), true);
          }
          await menu.screenshot({ path: `/tmp/shellspan-menu-navigation-${engine.name()}-${viewport.width}-${pane}.png` });
          await menu.evaluate(element => {
            window.menuClosingFrames = [];
            const observer = new MutationObserver(() => {
              if (element.hasAttribute('data-closed')) {
                window.menuClosingFrames.push({
                  pane: element.getAttribute('data-pane'),
                  rootItems: element.querySelectorAll('.ai-model-menu-cell').length,
                  search: element.querySelector('input')?.value,
                  height: element.style.height,
                });
              }
              if (!element.isConnected) observer.disconnect();
            });
            observer.observe(document.body, { subtree: true, attributes: true, childList: true });
          });
          const closingHeight = await menu.evaluate(element => element.style.height);
          const outside = await page.locator('#outside').boundingBox();
          await page.mouse.click(outside.x + outside.width / 2, outside.y + outside.height / 2);
          await menu.waitFor({ state: 'hidden' });
          const closingFrames = await page.evaluate(() => window.menuClosingFrames);
          assert.ok(closingFrames.length > 0, 'Observe the actual closing animation');
          for (const frame of closingFrames) {
            assert.equal(frame.pane, pane, 'Closing must retain the second pane');
            assert.equal(frame.rootItems, 0, 'Root items must not flash during closing');
            assert.equal(frame.height, closingHeight, 'Closing must retain the model pane height');
          }
          await trigger.click();
          assert.equal(await menu.getAttribute('data-pane'), 'root');
          await page.locator('.ai-model-menu-cell').nth(index).click();
          assert.equal(await menu.getByRole('textbox').inputValue(), '');
          await page.keyboard.press('Escape');
          await page.keyboard.press('Escape');
          await menu.waitFor({ state: 'hidden' });
        }
        // Releasing the opening gesture outside must still cancel the menu.
        const bounds = await trigger.boundingBox();
        await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        await page.mouse.down();
        await menu.waitFor();
        await page.mouse.move(8, viewport.height / 2);
        await page.mouse.up();
        await menu.waitFor({ state: 'hidden' });
        assert.deepEqual(errors, []);
        await page.close();
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  await server.close();
}
