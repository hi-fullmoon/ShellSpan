import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

// Render the actual working tree patch through the production tool renderer.
const patch = execFileSync('git', ['diff', '--', 'src/components/ai/workspace/ai-tool-presentation.tsx'], { encoding: 'utf8' });
assert.ok(patch.length);
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto('http://localhost:1420');
  await page.evaluate(async (patch) => {
    await import('/src/components/ai/styles/styles.css');
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { AiToolExpandedContent } = await import('/src/components/ai/workspace/ai-tool-presentation.tsx');
    const { initI18n } = await import('/src/locales/index.ts');
    await initI18n('en-US');
    const host = document.createElement('main');
    host.className = 'ai-panel-shell';
    host.style.cssText = 'position:fixed;inset:0;overflow:auto;background:var(--background);padding:16px;z-index:100';
    document.body.append(host);
    ReactDOM.createRoot(host).render(React.createElement(AiToolExpandedContent, {
      node: { kind: 'tool', name: 'apply_patch', nativeName: 'apply_patch', input: { patch }, output: { diff: patch }, state: 'succeeded' },
      compact: false,
    }));
  }, patch);
  await page.locator('.ai-diff-code .hljs-keyword').first().waitFor();
  for (const width of [1100, 360]) {
    await page.setViewportSize({ width, height: 800 });
    const result = await page.locator('.ai-diff-body').evaluateAll((bodies) => bodies.map(body => ({
      whiteSpace: getComputedStyle(body).whiteSpace,
      right: body.getBoundingClientRect().right,
      scrolls: body.scrollWidth > body.clientWidth,
      lineNumber: body.querySelector('.ai-diff-line-number').textContent,
    })));
    assert.ok(result.every(body => body.whiteSpace === 'pre' && body.right <= width));
    assert.ok(result.some(body => body.scrolls));
    assert.ok(result.every(body => Number(body.lineNumber) > 0));
    await page.screenshot({ path: `/tmp/shellspan-diff-${width}.png` });
    console.log(JSON.stringify({ width, checked: result.length }));
  }
} finally {
  await browser.close();
}
