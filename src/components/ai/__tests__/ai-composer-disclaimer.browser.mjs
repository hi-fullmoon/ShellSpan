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
    const { AiComposerSeat } = await import('/src/components/ai/workspace/ai-composer-seat.tsx');
    const { initI18n } = await import('/src/locales/index.ts');
    const { useAppStore } = await import('/src/stores/appStore.ts');
    useAppStore.setState({ locale: 'zh-CN' });
    await initI18n('zh-CN');
    const host = document.createElement('main');
    host.id = 'disclaimer-check';
    host.className = 'ai-panel-shell @container/ai-workspace';
    host.style.cssText = 'position:fixed;inset:0;display:flex;align-items:end;background:var(--background);z-index:100';
    document.body.append(host);
    ReactDOM.createRoot(host).render(React.createElement(AiComposerSeat, { phase: 'active', status: 'idle' }));
  });
  const notice = page.locator('#disclaimer-check [data-slot="ai-composer-disclaimer"]');
  await notice.waitFor();
  for (const width of [900, 360]) {
    await page.setViewportSize({ width, height: 600 });
    const result = await notice.evaluate(el => {
      const rect = el.getBoundingClientRect();
      const input = el.previousElementSibling.getBoundingClientRect();
      const style = getComputedStyle(el);
      return { text: el.textContent, fontSize: style.fontSize, opacity: style.opacity, align: style.textAlign,
        top: rect.top, bottom: rect.bottom, inputBottom: input.bottom,
        center: rect.x + rect.width / 2, inputCenter: input.x + input.width / 2 };
    });
    assert.equal(result.text, '内容由AI生成，请仔细甄别');
    assert.equal(result.fontSize, '11px');
    assert.equal(result.opacity, '0.7');
    assert.equal(result.align, 'center');
    assert.ok(result.top >= result.inputBottom);
    assert.ok(result.bottom <= 600);
    assert.ok(Math.abs(result.center - result.inputCenter) < 1);
    console.log(JSON.stringify({ width, ...result }));
  }
} finally {
  await browser.close();
}
