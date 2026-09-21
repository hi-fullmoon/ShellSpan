import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

// Replay a real cancelled session; do not manufacture runtime events.
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
    const node = projectAgentChatNodes(events).find(node => node.kind === 'turnProcess' && node.status === 'cancelled');
    if (!node) throw new Error('Session must contain a cancelled process');
    const host = document.createElement('main');
    host.id = 'process-alignment-check';
    host.className = 'ai-panel-shell';
    host.style.cssText = 'position:fixed;inset:0;background:var(--background);padding:16px;z-index:100';
    document.body.append(host);
    ReactDOM.createRoot(host).render(React.createElement(AiConversationNodeList, { nodes: [node] }));
  }, events);
  const trigger = page.locator('#process-alignment-check .ai-turn-process-trigger');
  await trigger.waitFor();
  await page.evaluate(() => document.fonts.ready);
  for (const width of [900, 320]) {
    await page.setViewportSize({ width, height: 400 });
    for (const expanded of [false, true]) {
      if (await trigger.getAttribute('aria-expanded') !== String(expanded)) await trigger.click();
      await page.waitForTimeout(300);
      const geometry = await trigger.evaluate(element => {
        const icon = element.querySelector('svg').getBoundingClientRect();
        const title = element.querySelector('.ai-disclosure-title').getBoundingClientRect();
        const summary = element.querySelector('.ai-disclosure-summary')?.getBoundingClientRect();
        const slot = element.querySelector('.ai-disclosure-leading').getBoundingClientRect();
        return {
          offset: icon.y + icon.height / 2 - title.y - title.height / 2,
          summaryOffset: summary ? summary.y + summary.height / 2 - title.y - title.height / 2 : 0,
          gap: title.x - slot.right,
          height: element.getBoundingClientRect().height,
        };
      });
      assert.equal(geometry.offset, -1, 'Arrow must follow the visible text center in both directions');
      assert.equal(geometry.summaryOffset, 0, 'Title and summary must remain aligned');
      assert.equal(geometry.gap, 4);
      assert.equal(geometry.height, 32);
      await trigger.screenshot({ path: `/tmp/shellspan-process-${width}-${expanded}.png` });
    }
    await trigger.focus();
    await page.keyboard.press('Enter');
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
    console.log(`Process alignment and keyboard toggle passed at ${width}px`);
  }
} finally {
  await browser.close();
}
