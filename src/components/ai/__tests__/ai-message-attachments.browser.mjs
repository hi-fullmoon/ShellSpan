import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const documents = await Promise.all(['README.md', 'package.json', 'tsconfig.json', 'components.json'].map(async name => {
  const text = await readFile(name, 'utf8');
  return { id: name, name, text, size: Buffer.byteLength(text) };
}));
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(process.env.SHELLSPAN_TEST_URL ?? 'http://localhost:1420');
  await page.evaluate(async documents => {
    await import('/src/components/ai/styles/styles.css');
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { aiConversationNodeRenderers } = await import('/src/components/ai/workspace/ai-conversation-node-seat.tsx');
    const { encodeDocumentMessage } = await import('/src/lib/ai/document-message.ts');
    const { initI18n } = await import('/src/locales/index.ts');
    await initI18n('en-US');
    const host = document.createElement('main');
    host.id = 'attachment-check';
    host.className = 'ai-panel-shell';
    host.style.cssText = 'position:fixed;inset:0;padding:16px;background:var(--background);z-index:100';
    document.body.append(host);
    ReactDOM.createRoot(host).render(React.createElement(aiConversationNodeRenderers.userMessage, {
      node: { kind: 'userMessage', key: 'message', sourceKind: 'agent', sessionId: 'session',
        turnId: 'turn', stepId: null, firstSeq: 1, lastSeq: 1, timestamp: '2026-09-21T00:00:00Z',
        messageId: 'message', delivery: 'committed', content: encodeDocumentMessage('Review these files', documents) },
    }));
  }, documents);
  const rail = page.locator('#attachment-check [data-slot="attachment-group"]');
  await rail.waitFor();
  for (const width of [900, 360]) {
    await page.setViewportSize({ width, height: 600 });
    const result = await rail.evaluate(el => {
      const cards = [...el.querySelectorAll(':scope > [data-slot="attachment"]')].map(card => {
        const rect = card.getBoundingClientRect();
        return { top: rect.top, width: rect.width, height: rect.height };
      });
      return { cards, width: el.clientWidth, scrollWidth: el.scrollWidth, right: el.getBoundingClientRect().right };
    });
    assert.equal(result.cards.length, 4);
    assert.ok(result.cards.every(card => card.top === result.cards[0].top && card.width === 120 && card.height === 92));
    assert.ok(result.right <= width);
    if (width === 360) {
      assert.ok(result.scrollWidth > result.width);
      await rail.hover();
      await page.mouse.wheel(0, 160);
      await page.waitForFunction(() => document.querySelector('#attachment-check [data-slot="attachment-group"]').scrollLeft > 0);
    }
    console.log(JSON.stringify({ width, ...result }));
  }
  await page.locator('#attachment-check').getByRole('button', { name: 'Preview components.json' }).click();
  await page.getByRole('dialog').waitFor();
  assert.ok(await page.getByRole('dialog').innerText().then(text => text.includes('components.json')));
} finally {
  await browser.close();
}
