import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

// Pass a real session JSONL file to replay its reasoning in the Vite app.
const events = (await readFile(process.argv[2], 'utf8')).trim().split('\n').map(JSON.parse);
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(process.env.SHELLSPAN_TEST_URL ?? 'http://localhost:1420');
  await page.evaluate(async (events) => {
    await import('/src/components/ai/styles/styles.css');
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { AiConversationNodeList, aiAskConversationNodeRenderers } = await import('/src/components/ai/workspace/ai-conversation-node-seat.tsx');
    const { projectAgentChatNodes } = await import('/src/lib/ai/conversation-projection.ts');
    const { initI18n } = await import('/src/locales/index.ts');
    await initI18n('en-US');
    const nodes = projectAgentChatNodes(events).flatMap(node => node.kind === 'turnProcess' ? node.children : [node]);
    const reasoning = nodes.filter(node => node.kind === 'reasoning');
    const node = reasoning.sort((a, b) => b.content.split('\n').length - a.content.split('\n').length)[0];
    if (!node) throw new Error('The supplied session has no reasoning');
    const host = document.createElement('main');
    host.id = 'reasoning-check';
    host.className = 'ai-panel-shell';
    host.style.cssText = 'position:fixed;inset:0;overflow:auto;background:var(--background);padding:16px;z-index:100';
    host.dataset.lines = String(node.content.split('\n').length);
    document.body.append(host);
    const h = React.createElement;
    ReactDOM.createRoot(host).render(h('div', null,
      h('section', { id: 'agent-reasoning' }, h(AiConversationNodeList, { nodes: [node] })),
      h('section', { id: 'ask-reasoning' }, h(AiConversationNodeList, { nodes: [node], renderers: aiAskConversationNodeRenderers })),
    ));
  }, events);
  for (const mode of ['agent', 'ask']) {
    const trigger = page.locator(`#${mode}-reasoning .ai-disclosure-row`);
    await trigger.focus();
    await page.keyboard.press('Enter');
    await page.locator(`#${mode}-reasoning .ai-reasoning-body p`).first().waitFor();
  }
  for (const width of [900, 360]) {
    await page.setViewportSize({ width, height: 900 });
    for (const mode of ['agent', 'ask']) {
      const geometry = await page.locator(`#${mode}-reasoning .ai-reasoning-body`).evaluate(body => {
        const paragraph = body.querySelector('p');
        const style = getComputedStyle(paragraph);
        return {
          whiteSpace: style.whiteSpace,
          fontSize: style.fontSize,
          color: style.color,
          expectedColor: getComputedStyle(body).color,
          lines: paragraph.getBoundingClientRect().height / parseFloat(style.lineHeight),
          overflow: body.scrollWidth > body.clientWidth,
        };
      });
      assert.equal(geometry.whiteSpace, 'normal');
      assert.equal(geometry.fontSize, '13px');
      assert.equal(geometry.color, geometry.expectedColor);
      assert.equal(geometry.overflow, false);
      const originalLines = Number(await page.locator('#reasoning-check').getAttribute('data-lines'));
      assert.ok(geometry.lines < originalLines / 2, 'Soft breaks must not render each word on its own line');
      console.log(JSON.stringify({ width, mode, ...geometry }));
    }
  }
} finally {
  await browser.close();
}
