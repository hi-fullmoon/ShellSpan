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
    const { AiWorkspaceRoot } = await import('/src/components/ai/workspace/ai-workspace-root.tsx');
    const { initI18n } = await import('/src/locales/index.ts');
    await initI18n('zh-CN');
    const host = document.createElement('main');
    host.id = 'initial-session-check';
    host.className = 'ai-panel-shell @container/ai-workspace';
    host.style.cssText = 'position:fixed;inset:0;display:flex;background:var(--background);z-index:100';
    document.body.append(host);
    ReactDOM.createRoot(host).render(React.createElement(AiWorkspaceRoot, {
      scope: 'workbench', view: null, restoringSession: true,
    }));
  });
  const composer = page.locator('#initial-session-check [data-slot="ai-composer-seat"]');
  await composer.waitFor();
  for (const width of [900, 360]) {
    await page.setViewportSize({ width, height: 600 });
    const bounds = await composer.evaluate(el => {
      const rect = el.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, width: rect.width, phase: el.dataset.phase };
    });
    assert.equal(bounds.phase, 'active');
    assert.ok(bounds.top > 300, JSON.stringify(bounds));
    assert.ok(bounds.bottom <= 600, JSON.stringify(bounds));
    assert.ok(bounds.width <= width, JSON.stringify(bounds));
    assert.equal(await page.locator('#initial-session-check [aria-busy="true"]').count(), 1);
    console.log(JSON.stringify({ width, ...bounds }));
  }
} finally {
  await browser.close();
}
