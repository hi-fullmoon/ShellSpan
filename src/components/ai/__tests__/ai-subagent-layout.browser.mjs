import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';

// Replay actual durable session events; never start tools or model requests.
const path = process.argv[2];
const readEvents = async file => (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
const events = await readEvents(path);
const descriptors = events.filter(event => event.type === 'subagent/descriptor');
assert.ok(descriptors.length);
const children = await Promise.all(descriptors.map(async event => ({
  descriptor: event.data,
  events: await readEvents(join(dirname(path), `${event.data.childSessionId}.jsonl`)),
})));
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(process.env.SHELLSPAN_TEST_URL ?? 'http://localhost:1420');
  await page.evaluate(async ({ events, children }) => {
    await import('/src/components/ai/styles/styles.css');
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { AiSessionHeader } = await import('/src/components/ai/workspace/ai-session-header.tsx');
    const { AiSubagentCatalog } = await import('/src/components/ai/workspace/ai-subagent-catalog.tsx');
    const { AiToolRow } = await import('/src/components/ai/workspace/ai-tool-presentation.tsx');
    const { projectAgentChatNodes } = await import('/src/lib/ai/conversation-projection.ts');
    const { initI18n } = await import('/src/locales/index.ts');
    const { useAppStore } = await import('/src/stores/appStore.ts');
    useAppStore.setState({ locale: 'zh-CN' });
    await initI18n('zh-CN');
    const summary = (stream, status) => ({
      id: stream[0].sessionId, kind: 'agent', title: stream.find(e => e.type === 'session/created').data.goal,
      updatedAt: new Date(stream.at(-1).timeUnixMs).toISOString(), status, scopeKey: '', archived: false,
    });
    const root = summary(events, 'idle');
    const entries = children.map(({ descriptor, events: childEvents }) => {
      const settled = events.find(e => e.type === 'subagent/settled' && e.data.childSessionId === descriptor.childSessionId);
      const status = settled?.data.status ?? 'running';
      return { summary: summary(childEvents, status), role: descriptor.role, continuable: descriptor.continuable, depth: descriptor.depth, status };
    });
    const flatten = nodes => nodes.flatMap(node => node.kind === 'turnProcess' ? flatten(node.children) : [node]);
    const tools = flatten(projectAgentChatNodes(events)).filter(node => node.kind === 'tool' && node.title === 'Agent orchestration');
    if (!tools.length) throw new Error('Session must contain orchestration tools');
    const host = document.createElement('main');
    host.id = 'subagent-layout-check';
    host.className = 'ai-panel-shell';
    host.style.cssText = 'position:fixed;inset:0;background:var(--background);z-index:100';
    document.body.append(host);
    const current = { ...entries[0].summary, subagent: children[0].descriptor };
    const h = React.createElement;
    ReactDOM.createRoot(host).render(h(React.Fragment, null,
      h(AiSessionHeader, { title: root.title, context: 'Agent', status: root.status,
        lineage: h(AiSubagentCatalog, { root, current, entries, onOpen: () => {} }) }),
      ...tools.map(node => h(AiToolRow, { key: node.key, node })),
    ));
  }, { events, children });
  const host = page.locator('#subagent-layout-check');
  for (const width of [1000, 480, 360]) {
    await page.setViewportSize({ width, height: 800 });
    const trigger = host.locator('[data-slot="popover-trigger"]');
    await trigger.waitFor();
    const headerBox = await host.locator('header').boundingBox();
    const triggerBox = await trigger.boundingBox();
    assert.ok(Math.abs(headerBox.y + headerBox.height / 2 - triggerBox.y - triggerBox.height / 2) < 1);
    await trigger.click();
    const popup = page.locator('[data-slot="popover-content"]');
    await popup.waitFor();
    await popup.evaluate(async el => {
      await Promise.all(el.getAnimations().map(animation => animation.finished));
    });
    const row = popup.getByRole('listitem').first().getByRole('button');
    assert.equal(await row.evaluate(el => getComputedStyle(el).fontSize), '12px');
    const rootRow = popup.getByRole('button', { name: /^打开根会话/ });
    const rootTitle = await rootRow.locator('.truncate').boundingBox();
    const rootIcon = await rootRow.locator('svg').boundingBox();
    assert.equal(await rootRow.evaluate(el => getComputedStyle(el).columnGap), '4px');
    for (const item of await popup.getByRole('listitem').all()) {
      assert.equal(await item.getByRole('button').evaluate(el => getComputedStyle(el).columnGap), '4px');
      const title = await item.locator('.truncate.font-medium').boundingBox();
      const leadingIcon = await item.locator('svg').first().boundingBox();
      assert.ok(Math.abs(title.x - rootTitle.x) < 0.5, 'Root and child titles must share the same left edge');
      assert.ok(Math.abs(leadingIcon.x - rootIcon.x) < 0.5, 'Root and child icons must share the same left edge');
      for (const icon of await item.locator('svg').all()) {
        const box = await icon.boundingBox();
        assert.ok(Math.abs(box.y + box.height / 2 - title.y - title.height / 2) < 0.5,
          'Catalog icons must align with the first title line, not the full multiline row');
      }
    }
    const box = await popup.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= width);
    await page.keyboard.press('Escape');
    await popup.waitFor({ state: 'hidden' });
    const tool = host.locator('.ai-tool-row').first();
    await tool.hover();
    const title = await tool.locator('.ai-disclosure-title').boundingBox();
    const chevron = await tool.locator('.ai-disclosure-chevron').boundingBox();
    assert.ok(Math.abs(title.y + title.height / 2 - chevron.y - chevron.height / 2) < 0.5);
    assert.equal(await tool.locator('.ai-disclosure-chevron').evaluate(el => getComputedStyle(el).opacity), '1');
    assert.ok(!(await host.innerText()).includes('Agent orchestration'));
    assert.ok(!(await host.innerText()).includes('subagentTokenBudgetExceeded'));
    console.log(`Subagent layout, menu, localization and hover alignment passed at ${width}px`);
  }
} finally {
  await browser.close();
}
