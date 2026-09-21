import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const events = (await readFile(process.argv[2], 'utf8')).trim().split('\n').map(JSON.parse);
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(process.env.SHELLSPAN_TEST_URL ?? 'http://localhost:1420');
  await page.evaluate(async events => {
    await import('/src/components/ai/styles/styles.css');
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { AiConversation } = await import('/src/components/ai/workspace/ai-conversation.tsx');
    const { projectAgentChatNodes } = await import('/src/lib/ai/conversation-projection.ts');
    const nodes = projectAgentChatNodes(events);
    const host = document.createElement('main');
    host.id = 'subagent-transcript-check';
    host.className = 'ai-panel-shell ai-workspace-root';
    host.style.cssText = 'position:fixed;inset:0;display:flex;flex-direction:column;background:var(--background);z-index:100';
    document.body.append(host);
    ReactDOM.createRoot(host).render(React.createElement(AiConversation, {
      nodes, status: 'failed', throughSeq: events.at(-1).seq,
      initialAnchor: { atBottom: false, offset: 0, scrollTop: 0 },
    }));
  }, events);
  const host = page.locator('#subagent-transcript-check');
  const viewport = host.locator('[data-slot="message-scroller-viewport"]');
  await host.locator('.ai-turn-process-trigger').first().waitFor();
  for (const width of [1000, 480, 360]) {
    await page.setViewportSize({ width, height: 800 });
    await viewport.hover();
    await viewport.evaluate(el => { el.scrollTop = 0; });
    await page.waitForTimeout(150);
    const gap = await host.evaluate(el => {
      const content = el.querySelector('[data-slot="message-scroller-content"]');
      const first = [...el.querySelectorAll('.ai-transcript-flow-item')].find(row => row.getBoundingClientRect().height > 0);
      return first.getBoundingClientRect().top - content.getBoundingClientRect().top;
    });
    console.log(JSON.stringify({ width, gap }));
    assert.ok(gap <= 24, 'The first visible transcript row must follow the normal top padding without empty scroll items');
    await viewport.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await page.waitForTimeout(150);
    assert.ok(await viewport.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop < 2));
  }
} finally {
  await browser.close();
}
