import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const server = await createServer({
  configFile: false, root, appType: 'custom', logLevel: 'error',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': `${root}src` } },
  server: { host: '127.0.0.1', port: 0 },
});
server.middlewares.use('/__model_menu', async (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(await server.transformIndexHtml('/__model_menu', '<html><body><div id="root"></div></body></html>'));
});
try {
  await server.listen();
  const browser = await chromium.launch({ ignoreDefaultArgs: ['--hide-scrollbars'] });
  try {
    for (const viewport of [{ width: 380, height: 360 }, { width: 1000, height: 900 }]) {
      const page = await browser.newPage({ viewport });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__model_menu`);
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
        // Exercise the real selector with the application's shipped model catalog.
        const providers = AI_PROVIDER_PRESETS.flatMap(preset =>
          Object.keys(catalog.presets[preset.preset]?.models ?? {}).map(model => ({
            ...preset, id: preset.preset, model,
          })),
        );
        useAiSettingsStore.setState({ providers, defaultProviderId: providers[0].id });
        ReactDOM.createRoot(document.getElementById('root')).render(React.createElement('main', {
          style: { position: 'fixed', bottom: 16, right: 16 },
        }, React.createElement(AiComposerModelSelector)));
      });
      const trigger = page.locator('.ai-model-trigger');
      await trigger.click();
      await page.locator('.ai-model-menu-cell').first().click();
      const menu = page.locator('.ai-model-menu');
      const scroller = menu.locator('[data-slot="ai-model-menu-scroll"]');
      const search = menu.getByRole('textbox');
      assert.equal(await search.evaluate(element => element === document.activeElement), true);
      assert.equal(await search.evaluate(element => getComputedStyle(element).fontSize), '13px');
      const searchStyle = await menu.locator('.ai-model-search-input').evaluate(element => {
        const style = getComputedStyle(element);
        return { shadow: style.boxShadow, border: style.borderWidth, radius: style.borderRadius };
      });
      assert.deepEqual(searchStyle, { shadow: 'none', border: '0px', radius: '0px' });
      await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running'));
      const popupBounds = await menu.boundingBox();
      const separatorBounds = await menu.locator('[data-slot="separator"]').boundingBox();
      assert.equal(separatorBounds.x - popupBounds.x, 8);
      assert.equal(popupBounds.x + popupBounds.width - separatorBounds.x - separatorBounds.width, 8);
      assert.ok(popupBounds.height <= 380 && popupBounds.y >= 0);
      await menu.screenshot({ path: `/tmp/shellspan-model-initial-${viewport.width}.png` });
      const dimensions = await scroller.evaluate(element => {
        const rect = element.getBoundingClientRect();
        return {
          x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, height: rect.height,
          clientHeight: element.clientHeight, scrollHeight: element.scrollHeight,
          overflow: getComputedStyle(element).overflowY,
          scrollbarWidth: getComputedStyle(element, '::-webkit-scrollbar').width,
          padding: getComputedStyle(element).padding,
          scrollbarSpace: element.offsetWidth - element.clientWidth,
        };
      });
      assert.ok(dimensions.height <= 381, JSON.stringify(dimensions));
      assert.ok(dimensions.x >= 0 && dimensions.right <= viewport.width + 1);
      assert.ok(dimensions.y >= 0 && dimensions.bottom <= viewport.height + 1);
      assert.ok(dimensions.scrollHeight > dimensions.clientHeight);
      assert.equal(dimensions.overflow, 'auto');
      assert.equal(dimensions.scrollbarWidth, '8px');
      assert.equal(dimensions.padding, '0px', 'The scrolling surface must extend to the popup edge');
      assert.equal(dimensions.scrollbarSpace, 8, 'The scrollbar must occupy the outermost 8px of the popup');
      assert.equal(await menu.locator('[data-slot="ai-model-menu-body"]').evaluate(element => getComputedStyle(element).padding), '3px');
      assert.equal((await scroller.boundingBox()).x + (await scroller.boundingBox()).width,
        (await menu.boundingBox()).x + (await menu.boundingBox()).width);
      const searchBounds = await search.boundingBox();
      await scroller.hover();
      await page.mouse.wheel(0, 300);
      await page.waitForFunction(() => document.querySelector('[data-slot="ai-model-menu-scroll"]').scrollTop > 0);
      assert.deepEqual(await search.boundingBox(), searchBounds, 'Search stays fixed while models scroll');
      await menu.screenshot({ path: `/tmp/shellspan-model-menu-${viewport.width}.png` });
      await search.fill('  MiNiMaX  ');
      const results = menu.getByRole('menuitemradio');
      assert.ok(await results.count() > 0);
      for (const label of await results.allTextContents()) assert.match(label, /minimax/i);
      await search.fill('MiniMax');
      assert.equal((await menu.boundingBox()).height, popupBounds.height, 'Filtered results must preserve the popup height');
      assert.equal((await search.boundingBox()).y, searchBounds.y, 'Filtering must not move the search input');
      await menu.screenshot({ path: `/tmp/shellspan-model-search-${viewport.width}.png` });
      await search.fill('no matching model');
      assert.equal(await results.count(), 0);
      await menu.getByRole('status').filter({ hasText: '未找到匹配的模型' }).waitFor();
      assert.equal((await menu.boundingBox()).height, popupBounds.height, 'Empty results must preserve the popup height');
      assert.equal((await search.boundingBox()).y, searchBounds.y, 'Empty results must not move the search input');
      await menu.screenshot({ path: `/tmp/shellspan-model-empty-${viewport.width}.png` });
      await search.press('Escape');
      assert.equal(await search.inputValue(), '');
      assert.ok(await results.count() > 10);
      await search.fill('qwen3');
      assert.equal(await menu.locator('[data-slot="ai-model-search"] button').count(), 0);
      await search.press('Escape');
      assert.equal(await search.inputValue(), '');
      assert.equal(await search.evaluate(element => element === document.activeElement), true);
      await search.press('ArrowDown');
      assert.equal(await results.first().evaluate(element => element === document.activeElement), true);
      await page.keyboard.press('ArrowUp');
      assert.equal(await search.evaluate(element => element === document.activeElement), true);
      await search.press('ArrowDown');
      await page.keyboard.press('Enter');
      await menu.waitFor({ state: 'hidden' });
      assert.equal(await trigger.evaluate(element => element === document.activeElement), true);
      await trigger.click();
      await page.locator('.ai-model-menu-cell').first().click();
      assert.equal(await search.inputValue(), '');
      await search.press('Escape');
      await page.locator('.ai-model-menu-cell').first().waitFor();
      await page.keyboard.press('Escape');
      await menu.waitFor({ state: 'hidden' });
      assert.deepEqual(errors, []);
      await page.close();
    }

    // A short model list keeps a content-sized popup; the pinned height must
    // follow the tallest content of the current open, not the fixed cap.
    const shortPage = await browser.newPage({ viewport: { width: 1000, height: 900 } });
    const shortErrors = [];
    shortPage.on('pageerror', error => shortErrors.push(error.message));
    await shortPage.goto(`http://127.0.0.1:${server.httpServer.address().port}/__model_menu`);
    await shortPage.evaluate(async () => {
      const { default: React } = await import('/@id/react');
      const { default: ReactDOM } = await import('/@id/react-dom/client');
      const { AiComposerModelSelector } = await import('/src/components/ai/workspace/ai-composer-model-selector.tsx');
      const { AI_PROVIDER_PRESETS, useAiSettingsStore } = await import('/src/stores/aiSettingsStore.ts');
      const { default: catalog } = await import('/protocol/llm/catalog.json');
      const { initI18n } = await import('/src/locales/index.ts');
      await import('/src/styles/base.css');
      await import('/src/components/ai/styles/styles.css');
      await initI18n('zh-CN');
      const preset = AI_PROVIDER_PRESETS[0];
      const providers = Object.keys(catalog.presets[preset.preset]?.models ?? {}).slice(0, 2)
        .map(model => ({ ...preset, id: preset.preset, model }));
      useAiSettingsStore.setState({ providers, defaultProviderId: providers[0].id });
      ReactDOM.createRoot(document.getElementById('root')).render(React.createElement('main', {
        style: { position: 'fixed', bottom: 16, right: 16 },
      }, React.createElement(AiComposerModelSelector)));
    });
    await shortPage.locator('.ai-model-trigger').click();
    await shortPage.locator('.ai-model-menu-cell').first().click();
    const shortMenu = shortPage.locator('.ai-model-menu');
    const shortBounds = await shortMenu.boundingBox();
    assert.ok(shortBounds.height < 380, 'A short model list should keep a content-sized popup');
    const bodyBottom = await shortMenu.locator('[data-slot="ai-model-menu-body"]')
      .evaluate(element => element.getBoundingClientRect().bottom);
    assert.ok(shortBounds.y + shortBounds.height - bodyBottom <= 1,
      'A short model list should not leave dead space below the last option');
    const shortSearch = shortMenu.getByRole('textbox');
    const shortSearchY = (await shortSearch.boundingBox()).y;
    await shortSearch.fill('no matching model');
    await shortMenu.getByRole('status').filter({ hasText: '未找到匹配的模型' }).waitFor();
    assert.equal((await shortMenu.boundingBox()).height, shortBounds.height,
      'Filtering a short list must keep the popup height stable');
    assert.equal((await shortSearch.boundingBox()).y, shortSearchY,
      'Filtering a short list must not move the search input');
    assert.deepEqual(shortErrors, []);
    await shortPage.close();
  } finally {
    await browser.close();
  }
} finally {
  await server.close();
}
