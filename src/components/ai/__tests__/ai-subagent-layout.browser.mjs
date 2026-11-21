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
    const { AiSubagentContext } = await import('/src/components/ai/workspace/ai-subagent-context.ts');
    const { AiSubagentStrip } = await import('/src/components/ai/workspace/ai-subagent-strip.tsx');
    const { AiToolRow } = await import('/src/components/ai/workspace/ai-tool-presentation.tsx');
    const { buildSubagentLineage, correlateSubagentToolSessions, isSubagentDelegationTool } = await import('/src/lib/ai/subagent-lineage.ts');
    const { projectAgentChatNodes } = await import('/src/lib/ai/conversation-projection.ts');
    const { projectAgentActivity } = await import('/src/lib/ai/agent-session-projection.ts');
    const { agentSessionView } = await import('/src/lib/ai/agent-session-adapter.ts');
    const { initI18n } = await import('/src/locales/index.ts');
    const { useAppStore } = await import('/src/stores/appStore.ts');
    useAppStore.setState({ locale: 'zh-CN' });
    await initI18n('zh-CN');
    const summary = (stream, status) => ({
      id: stream[0].sessionId, kind: 'agent', title: stream.find(e => e.type === 'session/created').data.goal,
      updatedAt: new Date(stream.at(-1).timeUnixMs).toISOString(), status, scopeKey: '', archived: false,
    });
    const root = summary(events, 'idle');
    const childSummaries = children.map(({ descriptor, events: childEvents }) => {
      const settled = events.find(e => e.type === 'subagent/settled' && e.data.childSessionId === descriptor.childSessionId);
      const status = settled?.data.status ?? 'running';
      return {
        ...summary(childEvents, status),
        parentSessionId: descriptor.parentSessionId,
        subagent: descriptor,
      };
    });
    const currentChildEvents = children[0].events;
    const currentCreated = currentChildEvents.find(e => e.type === 'session/created');
    const currentActivity = projectAgentActivity(currentChildEvents);
    const currentView = agentSessionView({
      events: currentChildEvents,
      lastCommittedSeq: currentChildEvents.at(-1).seq,
      hasTerminalEvent: currentChildEvents.some(e => e.type === 'session/ended'),
      snapshot: {
        header: { ...currentCreated.data, sessionId: currentCreated.sessionId, createdAtUnixMs: currentCreated.timeUnixMs },
        status: currentActivity.status,
        ended: currentChildEvents.some(e => e.type === 'session/ended'),
        archived: false,
        eventCount: currentChildEvents.length,
        surface: { generation: currentActivity.context.surfaceGeneration, messages: [] },
        inbox: { nextTurn: [], nextStep: [] },
        task: { plan: currentActivity.plan, evidence: [] },
        recovery: { kind: 'idle', status: 'none', summary: '', lastCommittedSeq: currentChildEvents.at(-1).seq },
      },
    });
    const nodes = projectAgentChatNodes(events);
    const activity = projectAgentActivity(events);
    const correlation = correlateSubagentToolSessions(nodes, activity.nodes, activity.agents, [root, ...childSummaries]);
    const lineage = buildSubagentLineage(currentView, [root, ...childSummaries], correlation.goalByChildId);
    const flatten = list => list.flatMap(node => node.kind === 'turnProcess' ? flatten(node.children) : [node]);
    const tools = flatten(nodes).filter(node => node.kind === 'tool' && isSubagentDelegationTool(node.name, node.nativeName));
    if (!tools.length) throw new Error('Session must contain subagent orchestration tools');
    const host = document.createElement('main');
    host.id = 'subagent-layout-check';
    host.className = 'ai-panel-shell';
    host.style.cssText = 'position:fixed;inset:0;display:flex;flex-direction:column;background:var(--background)';
    document.body.append(host);
    const current = lineage.current;
    const h = React.createElement;
    window.__openedSubagentSessions = [];
    function LayoutStrip() {
      const [open, setOpen] = React.useState(false);
      return h(AiSubagentStrip, {
        entries: lineage.entries,
        currentSessionId: root.id,
        open,
        onOpenChange: setOpen,
        onOpen: summary => window.__openedSubagentSessions.push(summary.id),
      });
    }
    ReactDOM.createRoot(host).render(h(AiSubagentContext.Provider, {
      value: {
        lineage,
        toolChildSessionIds: correlation.toolChildSessionIds,
        onOpenSession: summary => window.__openedSubagentSessions.push(summary.id),
      },
    },
      h(AiSessionHeader, {
        title: current.title,
        context: 'Agent',
        status: current.status,
        subagentNav: {
          roleLabel: '探索',
          subtitle: `${root.title} · 一次性 · 已完成`,
          subtitleTooltip: `${root.title} / ${current.title}`,
          backLabel: `返回主会话：${root.title}`,
          onBack: () => {},
          hideSessionChrome: true,
          switcher: h(AiSubagentCatalog, { root, current, entries: lineage.entries, onOpen: () => {} }),
        },
      }),
      h('div', { style: 'padding:12px;display:flex;flex-direction:column;gap:8px;' },
        ...tools.map(node => h(AiToolRow, { key: node.key, node })),
        h(LayoutStrip),
      ),
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
    assert.equal(await row.evaluate(el => getComputedStyle(el).borderRadius), '8px');
    assert.equal(await popup.evaluate(el => getComputedStyle(el).borderRadius), '10px');
    const popupTokenCheck = await popup.evaluate(el => {
      const style = getComputedStyle(el);
      const statusSvg = el.querySelector('.ai-subagent-status-icon svg[data-status]');
      const svgStatus = statusSvg?.getAttribute('data-status');
      const svgColor = statusSvg ? getComputedStyle(statusSvg).color : null;
      return {
        accentToken: style.getPropertyValue('--ai-accent').trim(),
        successToken: style.getPropertyValue('--ai-success').trim(),
        popupColor: style.color,
        svgStatus,
        svgColor,
      };
    });
    assert.ok(popupTokenCheck.accentToken && popupTokenCheck.successToken, 'Popover must define --ai-* tokens');
    if (popupTokenCheck.svgStatus && popupTokenCheck.svgStatus !== 'cancelled' && popupTokenCheck.svgStatus !== 'idle') {
      assert.notEqual(popupTokenCheck.svgColor, popupTokenCheck.popupColor, 'Popover status icon must use semantic token color');
    }
    const rootRow = popup.getByRole('button', { name: /^返回主会话/ });
    const rootTitle = await rootRow.locator('.truncate').boundingBox();
    const rootIconSlot = await rootRow.locator('.size-4').first().boundingBox();
    const rootIcon = await rootRow.locator('svg').boundingBox();
    assert.equal(await rootRow.evaluate(el => getComputedStyle(el).columnGap), '4px');
    for (const item of await popup.getByRole('listitem').all()) {
      const btn = item.getByRole('button');
      assert.equal(await btn.evaluate(el => getComputedStyle(el).columnGap), '4px');
      const title = await btn.locator('.truncate.font-medium').boundingBox();
      const leadingSlot = await btn.locator('.ai-subagent-status-icon').boundingBox();
      const leadingIcon = await btn.locator('svg').first().boundingBox();
      assert.ok(Math.abs(title.x - rootTitle.x) < 0.5, 'Root and child titles must share the same left edge');
      assert.ok(Math.abs(leadingSlot.x - rootIconSlot.x) < 0.5, 'Root and child icon slots must share the same left edge');
      assert.ok(
        Math.abs((leadingIcon.x + leadingIcon.width / 2) - (rootIcon.x + rootIcon.width / 2)) < 0.5,
        'Root and child icon centers must align horizontally',
      );
      for (const icon of await btn.locator('svg').all()) {
        const box = await icon.boundingBox();
        assert.ok(Math.abs(box.y + box.height / 2 - title.y - title.height / 2) < 0.5,
          'Catalog icons must align with the first title line, not the full multiline row');
      }
    }
    const box = await popup.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= width);
    await page.keyboard.press('Escape');
    await popup.waitFor({ state: 'hidden' });
    const card = host.locator('[data-slot="ai-subagent-card"]').first();
    await card.waitFor();
    assert.equal(await card.evaluate(el => getComputedStyle(el).borderTopWidth), '0px');
    const rowTrigger = card.locator('.ai-subagent-row-trigger');
    const rowBox = await rowTrigger.boundingBox();
    assert.ok(rowBox.height <= 28, `Compact subagent row height (${rowBox.height}) should match a single tool row`);
    const leadingBox = await rowTrigger.locator('.ai-disclosure-leading').boundingBox();
    const rowTitleBox = await rowTrigger.locator('.ai-disclosure-title').boundingBox();
    assert.ok(
      Math.abs((rowTitleBox.x - (leadingBox.x + leadingBox.width)) - 4) < 0.5,
      'Leading status icon and title must have a 4px gap',
    );
    await page.mouse.move(width - 1, 790);
    const leadingStatus = rowTrigger.locator('.ai-disclosure-leading > :not(.ai-disclosure-chevron)');
    const enterChevron = rowTrigger.locator('.ai-disclosure-leading > .ai-subagent-row-enter');
    assert.equal(await leadingStatus.evaluate(el => getComputedStyle(el).opacity), '1');
    assert.equal(await enterChevron.evaluate(el => getComputedStyle(el).opacity), '0');
    await rowTrigger.hover();
    assert.equal(await leadingStatus.evaluate(el => getComputedStyle(el).opacity), '0');
    assert.equal(await enterChevron.evaluate(el => getComputedStyle(el).opacity), '1');
    const openedBefore = await page.evaluate(() => window.__openedSubagentSessions.length);
    await rowTrigger.click();
    await page.mouse.move(width - 1, 790);
    const openedAfter = await page.evaluate(() => window.__openedSubagentSessions.length);
    assert.equal(openedAfter, openedBefore + 1, 'Clicking openable subagent row must navigate directly');
    assert.equal(await card.locator('.ai-subagent-card-body').count(), 0, 'Openable subagent row must not mount inline body');

    const stripTrigger = host.locator('.ai-subagent-strip-trigger');
    await stripTrigger.click();
    const stripRowIcon = host.locator('.ai-subagent-strip-list .ai-subagent-status-icon').first();
    await stripRowIcon.waitFor();
    const triggerIconBox = await stripTrigger.locator('svg').first().boundingBox();
    const stripRowIconBox = await stripRowIcon.boundingBox();
    assert.ok(
      Math.abs(triggerIconBox.x - stripRowIconBox.x) < 1,
      `Strip trigger icon (${triggerIconBox.x}) and expanded row icon (${stripRowIconBox.x}) must align vertically`,
    );
    await stripTrigger.click();

    assert.ok(!(await host.innerText()).includes('Agent orchestration'));
    assert.ok(!(await host.innerText()).includes('subagentTokenBudgetExceeded'));
  }
} finally {
  await browser.close();
}
