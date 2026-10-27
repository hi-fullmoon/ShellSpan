import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium } from 'playwright';

// Replay durable parent/child events. Exercise the real UI and its submit
// callback without starting a model request, tool, or remote operation.
const parentPath = process.argv[2];
assert.ok(parentPath, 'Pass a real parent session JSONL path');
const readEvents = async path => (await readFile(path, 'utf8')).trim().split('\n').map(JSON.parse);
const parentEvents = await readEvents(parentPath);
const descriptor = parentEvents.find(event => event.type === 'subagent/descriptor' && event.data.continuable);
assert.ok(descriptor, 'A real continuable child is required');
const childEvents = await readEvents(join(dirname(parentPath), `${descriptor.data.childSessionId}.jsonl`));
assert.ok(childEvents.some(event => event.type === 'session/ended'), 'The child must have an ended checkpoint');
const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const server = await createServer({ root: repositoryRoot, configFile: false, appType: 'custom',
  plugins: [react(), tailwindcss()], resolve: { alias: { '@': `${repositoryRoot}src/` } },
  server: { host: '127.0.0.1', port: 0 } });
server.middlewares.use('/subagent-composer-check', async (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(await server.transformIndexHtml('/subagent-composer-check', '<html><body></body></html>'));
});
await server.listen();
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/subagent-composer-check`);
  await page.evaluate(async ({ parentEvents, childEvents }) => {
    await import('/src/styles/base.css');
    await import('/src/components/ai/styles/styles.css');
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { AiWorkspaceRoot } = await import('/src/components/ai/workspace/ai-workspace-root.tsx');
    const { agentSessionView } = await import('/src/lib/ai/agent-session-adapter.ts');
    const { projectAgentActivity } = await import('/src/lib/ai/agent-session-projection.ts');
    const { createAiComposerState } = await import('/src/lib/ai/composer-machine.ts');
    const { initI18n, t } = await import('/src/locales/index.ts');
    const { useAppStore } = await import('/src/stores/appStore.ts');
    const { useAiSettingsStore } = await import('/src/stores/aiSettingsStore.ts');
    const { sessionProviderConfig } = await import('/src/lib/ai/session-settings.ts');
    const replay = events => {
      const created = events.find(event => event.type === 'session/created');
      const activity = projectAgentActivity(events);
      return agentSessionView({ events, lastCommittedSeq: events.at(-1).seq,
        hasTerminalEvent: events.some(event => event.type === 'session/ended'),
        snapshot: {
          header: { ...created.data, sessionId: created.sessionId, createdAtUnixMs: created.timeUnixMs },
          status: activity.status, ended: events.some(event => event.type === 'session/ended'),
          archived: false, eventCount: events.length,
          surface: { generation: activity.context.surfaceGeneration, messages: [] },
          inbox: { nextTurn: [], nextStep: [] },
          task: { plan: activity.plan, evidence: events.filter(event => event.type === 'evidence/attached').map(event => event.data) },
          recovery: activity.recovery ?? { kind: 'idle', status: 'none', summary: '', lastCommittedSeq: events.at(-1).seq },
        },
      });
    };
    const runningEnd = childEvents.findLastIndex(event => event.type === 'agent/status' && event.data.status === 'running');
    const terminalIndex = childEvents.findIndex((event, index) => index > runningEnd
      && (event.type === 'session/ended' || event.type === 'agent/status' && event.data.status !== 'running'));
    const running = replay(childEvents.slice(0, terminalIndex));
    const ended = replay(childEvents);
    const parent = replay(parentEvents.slice(0, parentEvents.findIndex(event => event.type === 'subagent/descriptor') + 1));
    if (running.status !== 'running' || !running.snapshot.value.header.subagent?.continuable) throw new Error('Missing running child checkpoint');
    const host = document.createElement('main');
    host.id = 'subagent-composer-check';
    host.className = 'ai-panel-shell';
    host.style.cssText = 'position:fixed;inset:0;display:flex;flex-direction:column;background:var(--background);z-index:100';
    document.body.append(host);
    const root = ReactDOM.createRoot(host);
    let selected = running;
    let retainedParentNotice = false;
    let configurationError = null;
    let draft = '';
    const sent = [];
    const render = () => {
      const isChild = Boolean(selected.snapshot.value.header.subagent);
      root.render(React.createElement(AiWorkspaceRoot, {
        mode: 'agent', scope: 'terminal', view: selected, canStartAgent: true,
        terminalConnected: true, terminalConflict: !isChild || retainedParentNotice,
        agentUnavailableReason: configurationError ?? (isChild && !retainedParentNotice ? null : t('terminal.occupancy.submitBlocked')),
        composerState: createAiComposerState({ sessionId: selected.summary.id,
          runtimeStatus: selected.status, terminal: selected.snapshot.value.ended, draft }),
        onDraftChange: value => { draft = value; render(); },
        onSubmit: ({ content }) => { sent.push(content); },
      }));
    };
    globalThis.subagentComposerCheck = {
      async locale(locale) { useAppStore.setState({ locale }); await initI18n(locale); render(); },
      show(kind) { retainedParentNotice = false; configurationError = null; selected = ({ running, ended, parent })[kind]; render(); },
      retainParentNotice() { retainedParentNotice = true; render(); },
      missingModel() {
        // Resolve the real recorded selection against this browser's actual
        // settings. No provider response or transport error is fabricated.
        try { sessionProviderConfig(running.snapshot.value.header.subagent.provider, useAiSettingsStore.getState().providers); }
        catch (error) { configurationError = error.message; }
        if (!configurationError) throw new Error('Expected the recorded model to be absent from browser settings');
        render();
        return t('ai.error.invalidModelSelection');
      },
      sent,
      draft: running.snapshot.value.header.goal.split('\n')[0],
    };
    await globalThis.subagentComposerCheck.locale('zh-CN');
  }, { parentEvents, childEvents });
  const host = page.locator('#subagent-composer-check');
  const editor = host.getByTestId('ai-workspace-composer');
  for (const locale of ['zh-CN', 'en-US']) {
    await page.evaluate(locale => globalThis.subagentComposerCheck.locale(locale), locale);
    const label = locale === 'zh-CN' ? '补充指令' : 'Add instructions';
    for (const width of [1000, 480, 360]) {
      await page.setViewportSize({ width, height: 800 });
      await page.evaluate(() => globalThis.subagentComposerCheck.show('running'));
      const toggle = host.getByRole('button', { name: label, exact: true });
      await toggle.waitFor();
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      assert.equal(await editor.count(), 0, 'Child input is collapsed by default');
      assert.equal(await host.locator('[data-slot="ai-workspace-status-notices"]').innerText(), '',
        'Switching from the parent must not retain its terminal warning during an exit animation');
      if (locale === 'zh-CN' && width === 360) {
        await page.screenshot({ path: '/tmp/shellspan-subagent-composer-collapsed.png' });
      }
      assert.equal(await host.locator('[data-slot="ai-composer-disclaimer"]').count(), 0);
      assert.equal(await host.locator('[data-slot="ai-task-strip"]').count(), 1, 'Task plan stays visible');
      // Keep the recorded parent's terminal ownership while inspecting its
      // child. Neither passive reading nor child text delivery needs takeover.
      await page.evaluate(() => globalThis.subagentComposerCheck.retainParentNotice());
      assert.equal(await host.locator('[data-slot="ai-workspace-status-notices"]').innerText(), '');
      await toggle.focus();
      await page.keyboard.press('Enter');
      await editor.waitFor();
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
      assert.equal(await editor.getAttribute('aria-disabled'), null, 'Parent ownership must not block child instructions');
      assert.ok(await editor.evaluate(el => el === document.activeElement), 'Opening instructions focuses the editor');
      assert.equal(await host.getByRole('status', { name: locale === 'zh-CN' ? 'Agent 暂不可用' : 'Agent is unavailable' }).count(), 0);
      assert.equal(await toggle.evaluate(el => getComputedStyle(el).columnGap), '4px');
      const bounds = await editor.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width && bounds.y + bounds.height <= 800);
      const draft = await page.evaluate(() => globalThis.subagentComposerCheck.draft);
      await editor.fill(draft);
      await toggle.click();
      assert.equal(await editor.count(), 0);
      await toggle.click();
      assert.equal(await editor.textContent(), draft, 'Collapsing preserves the draft');
      await editor.press('Enter');
      assert.equal(await page.evaluate(() => globalThis.subagentComposerCheck.sent.at(-1)), draft);
      await page.screenshot({ path: `/tmp/shellspan-subagent-composer-${locale}-${width}.png` });
      await page.evaluate(() => globalThis.subagentComposerCheck.show('ended'));
      await toggle.waitFor({ state: 'detached' });
      assert.equal(await editor.count(), 0, 'Ended children stay read-only');
      if (locale === 'zh-CN' && width === 360) {
        await page.screenshot({ path: '/tmp/shellspan-subagent-composer-ended.png' });
      }
      await page.evaluate(() => globalThis.subagentComposerCheck.show('parent'));
      await editor.waitFor();
      assert.equal(await host.getByRole('button', { name: label, exact: true }).count(), 0);
      assert.ok(await host.locator('[data-slot="ai-workspace-status-notices"]').innerText(), 'Root terminal warning is preserved');
      await page.evaluate(() => globalThis.subagentComposerCheck.show('running'));
    }
    const failureMessage = await page.evaluate(() => globalThis.subagentComposerCheck.missingModel());
    const toggle = host.getByRole('button', { name: label, exact: true });
    assert.equal(await host.getByText(failureMessage, { exact: true }).count(), 0,
      'Configuration problems do not interrupt passive child observation');
    await toggle.click();
    const failure = host.getByText(failureMessage, { exact: true });
    await failure.waitFor();
    assert.equal(await failure.count(), 1, 'A real configuration blocker is explained once near the expanded input');
    const submitted = await page.evaluate(() => globalThis.subagentComposerCheck.sent.length);
    const draft = await editor.textContent();
    await editor.press('Enter');
    assert.equal(await page.evaluate(() => globalThis.subagentComposerCheck.sent.length), submitted);
    assert.equal(await editor.textContent(), draft, 'A blocked follow-up preserves the draft');
    await page.screenshot({ path: `/tmp/shellspan-subagent-composer-blocked-${locale}.png` });
    await toggle.click();
    await failure.waitFor({ state: 'detached' });
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await server.close();
}
