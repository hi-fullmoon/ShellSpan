import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

// Replay errors from a real session JSONL file supplied as the first argument.
const events = (await readFile(process.argv[2], 'utf8')).trim().split('\n').map(JSON.parse);
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(process.env.SHELLSPAN_TEST_URL ?? 'http://localhost:1420');
  await page.evaluate(async (events) => {
    await import('/src/components/ai/styles/styles.css');
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { AiConversationNodeList } = await import('/src/components/ai/workspace/ai-conversation-node-seat.tsx');
    const { initI18n } = await import('/src/locales/index.ts');
    const { projectAgentChatNodes } = await import('/src/lib/ai/conversation-projection.ts');
    await initI18n('zh-CN');
    const host = document.createElement('main');
    host.id = 'request-error-check';
    host.className = 'ai-panel-shell';
    host.style.cssText = 'position:fixed;inset:0;background:var(--background);padding:16px;overflow:auto;z-index:100';
    document.body.append(host);
    const nodes = projectAgentChatNodes(events).flatMap(node => node.kind === 'turnProcess' ? node.children : [node]);
    const errors = nodes.filter(node => node.kind === 'error');
    if (!errors.length) throw new Error('Session must contain a request error');
    ReactDOM.createRoot(host).render(React.createElement(AiConversationNodeList, { nodes: errors }));
  }, events);
  const notice = page.locator('#request-error-check .ai-turn-error').first();
  await notice.waitFor();
  await page.evaluate(() => document.fonts.ready);
  const details = notice.getByRole('button');
  for (const width of [1280, 640, 320]) {
    await page.setViewportSize({ width, height: 800 });
    assert.equal(await notice.locator('.ai-turn-error-title').evaluate(el => getComputedStyle(el).fontWeight), '400');
    const offset = await notice.evaluate(el => {
      const icon = el.querySelector('svg').getBoundingClientRect();
      const copy = el.querySelector('.ai-turn-error-copy');
      return copy.getBoundingClientRect().y + parseFloat(getComputedStyle(copy).lineHeight) / 2
        - icon.y - icon.height / 2;
    });
    assert.ok(Math.abs(offset - 1) < 0.1, 'Align icon with optically corrected first line, including wrapped text');
    await details.focus();
    await page.keyboard.press('Enter');
    assert.equal(await details.getAttribute('aria-expanded'), 'true');
    assert.equal(await notice.evaluate(el => el.scrollWidth > el.clientWidth), false);
    await page.keyboard.press('Enter');
    assert.equal(await details.getAttribute('aria-expanded'), 'false');
    if (width === 640) await page.locator('#request-error-check').screenshot({ path: '/tmp/shellspan-request-error-alignment.png' });
    console.log(`Request error rendering passed at ${width}px`);
  }
} finally {
  await browser.close();
}
