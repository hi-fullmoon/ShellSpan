import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

// Replay a real cancelled session: node src/components/ai/__tests__/ai-stopped-alignment.browser.mjs /path/to/session.jsonl
const events = (await readFile(process.argv[2], 'utf8')).trim().split('\n').map(JSON.parse);
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 2 });
  await page.goto(process.env.SHELLSPAN_TEST_URL ?? 'http://localhost:1420');
  await page.evaluate(async events => {
    await import('/src/components/ai/styles/styles.css');
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { AiConversationNodeList } = await import('/src/components/ai/workspace/ai-conversation-node-seat.tsx');
    const { projectAgentChatNodes } = await import('/src/lib/ai/conversation-projection.ts');
    const { initI18n } = await import('/src/locales/index.ts');
    await initI18n('zh-CN');
    const nodes = projectAgentChatNodes(events).flatMap(node => node.kind === 'turnProcess' ? node.children : [node])
      .filter(node => node.kind === 'error' && node.state === 'cancelled');
    if (!nodes.length) throw new Error('Session must contain a cancelled error node');
    const host = document.createElement('main');
    host.id = 'stopped-check';
    host.className = 'ai-panel-shell';
    host.style.cssText = 'position:fixed;inset:0;background:var(--background);padding:16px;z-index:100';
    document.body.append(host);
    ReactDOM.createRoot(host).render(React.createElement(AiConversationNodeList, { nodes: nodes.slice(0, 1) }));
  }, events);
  const notice = page.locator('#stopped-check [data-variant="cancelled"]');
  await notice.waitFor();
  await page.evaluate(() => document.fonts.ready);
  for (const width of [900, 320]) {
    await page.setViewportSize({ width, height: 160 });
    const geometry = await notice.evaluate(element => {
      const icon = element.querySelector('svg').getBoundingClientRect();
      const label = element.querySelector('.ai-disclosure-title').getBoundingClientRect();
      const slot = element.querySelector('.ai-disclosure-leading').getBoundingClientRect();
      const row = element.getBoundingClientRect();
      return { offset: icon.y + icon.height / 2 - label.y - label.height / 2, gap: label.x - slot.right, height: row.height };
    });
    await page.locator('#stopped-check').screenshot({ path: `/tmp/shellspan-stopped-${width}.png` });
    assert.equal(geometry.offset, 0, 'Stopped icon and label must be vertically centered');
    assert.equal(geometry.gap, 4, 'Keep the existing 4px spacing');
    assert.equal(geometry.height, 24, 'Keep the existing row height');
    console.log(`Stopped alignment passed at ${width}px`);
  }
} finally {
  await browser.close();
}
