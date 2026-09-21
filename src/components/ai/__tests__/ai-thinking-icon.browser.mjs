import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(process.env.SHELLSPAN_TEST_URL ?? 'http://localhost:1420');
  await page.evaluate(async () => {
    await import('/src/components/ai/styles/styles.css');
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { AiConversation } = await import('/src/components/ai/workspace/ai-conversation.tsx');
    const { initI18n } = await import('/src/locales/index.ts');
    await initI18n('zh-CN');
    const host = document.createElement('main');
    host.id = 'thinking-icon-check';
    host.className = 'ai-panel-shell';
    host.style.cssText = 'position:fixed;inset:0;display:flex;background:var(--background);z-index:100';
    document.body.append(host);
    ReactDOM.createRoot(host).render(React.createElement(AiConversation, {
      nodes: [], status: 'running', runningIndicator: 'ask', pending: true,
    }));
  });
  const indicator = page.locator('#thinking-icon-check [data-ai-thinking-indicator]');
  await indicator.waitFor();
  for (const width of [900, 360]) {
    await page.setViewportSize({ width, height: 600 });
    const result = await indicator.evaluate(el => {
      const icon = el.querySelector('svg').getBoundingClientRect();
      const label = el.querySelector('[data-slot="marker-content"]').getBoundingClientRect();
      return {
        width: icon.width, height: icon.height, gap: label.left - icon.right,
        centerOffset: icon.top + icon.height / 2 - (label.top + label.height / 2),
      };
    });
    assert.equal(result.width, 14);
    assert.equal(result.height, 14);
    assert.equal(result.gap, 4);
    assert.equal(result.centerOffset, 0);
    console.log(JSON.stringify({ viewportWidth: width, ...result }));
  }
} finally {
  await browser.close();
}
