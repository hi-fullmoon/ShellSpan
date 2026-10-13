import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Activity } from 'react';
import { AiConversation } from '@/components/ai/workspace/ai-conversation';
import { AiWorkspaceController } from '@/components/ai/workspace/ai-workspace-controller';
import { initI18n, t } from '@/locales';
import { useTerminalStore } from '@/stores/terminalStore';
import { createAgentSessionAdapter, createAgentSessionViewProjector } from '../agent-session-adapter';
import { CommittedEventBuffer } from '../committed-event-buffer';
import type { AiSessionView } from '../session-adapter';
import {
  invokeListAiRoutes, invokeListAiRouteModels, invokeCreateLocalSession, invokeCloseSession,
  invokeGetSessionStatus,
  invokeCreateAgentRuntimeSession, invokeStartAgentRuntime,
  invokeAgentRuntimeFollowup,
  invokeCancelAgentRuntime, invokeArchiveAgentRuntimeSession, invokeDeleteAgentRuntimeSession,
  invokeRenameAgentRuntimeSession, invokeGetAgentRuntimeSession,
  invokeGetCommittedAgentRuntimeEvents,
  listenToAgentRuntimeSession, isTauriRuntime,
} from '@/lib/ipc/tauri';
import '@/styles/base.css';
import '@/components/ai/styles/styles.css';

// Uses native journals, real PTYs and the configured model. Never copies journal
// contents or credentials into the report. Only test-owned sessions are removed.
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
let paintFallbacks = 0;
const frame = () => new Promise<void>(resolve => {
  const request = requestAnimationFrame(() => { clearTimeout(timeout); resolve(); });
  // WKWebView can suspend animation frames while the test window is obscured.
  // Keep correctness checks bounded, and disclose fallback use in the report.
  const timeout = setTimeout(() => { cancelAnimationFrame(request); paintFallbacks++; resolve(); }, 50);
});
async function painted() { await frame(); await frame(); }
async function eventually(check: () => boolean, message: string, timeout = 30_000) {
  const deadline = performance.now() + timeout;
  while (!check()) {
    assert(performance.now() < deadline, message);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
function stats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  return { count: sorted.length, medianMs: sorted[Math.floor(sorted.length / 2)] ?? 0,
    p95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * .95))] ?? 0,
    maxMs: sorted[sorted.length - 1] ?? 0 };
}

async function verify() {
  assert(isTauriRuntime(), 'Native Tauri window required');
  const cleanupIds = new URL(location.href).searchParams.getAll('cleanupSession');
  if (cleanupIds.length) {
    for (const sessionId of cleanupIds) {
      assert(sessionId.startsWith('panel-cache-') || sessionId.startsWith('panel-performance-'), 'Cleanup only accepts benchmark-owned session IDs');
      const snapshot = await invokeGetAgentRuntimeSession({ sessionId });
      assert(snapshot.header.goal === 'Verify bounded frontend retention without running a model'
        || snapshot.header.goal.startsWith('Performance verification '), 'Session does not belong to this benchmark');
      if (!snapshot.ended && !snapshot.archived) await invokeCancelAgentRuntime({ sessionId });
      if (!snapshot.archived) await invokeArchiveAgentRuntimeSession({ sessionId });
      await invokeDeleteAgentRuntimeSession({ sessionId });
    }
    return { cleanedTestSessions: cleanupIds.length };
  }
  await initI18n('en-US');
  const baseline = new URL(location.href).searchParams.get('baseline') === 'true';
  const noModel = new URL(location.href).searchParams.get('noModel') === 'true';
  const adapter = createAgentSessionAdapter();
  const container = document.createElement('div');
  container.className = 'ai-panel-shell flex flex-col min-h-0';
  container.dataset.aiScope = 'terminal';
  container.style.cssText = 'width:560px;height:720px;max-height:95vh';
  document.body.append(container);
  const root = createRoot(container);
  const displayedSession = () => container.querySelector<HTMLElement>('[data-slot="ai-workspace-root"]')?.dataset.sessionId;
  const ownedSessions: string[] = [];
  const cacheSessions: string[] = [];
  const deletedSessions = new Set<string>();
  const terminals: string[] = [];
  const chunks = new Map<string, number>();
  const failures = new Map<string, { kind: string; status?: number; code?: string }>();
  let phase = 'read stored sessions';
  const reportPhase = (next: string) => {
    phase = next;
    void fetch(`/__agent-stream-result/${new URL(location.href).searchParams.get('token')}`,
      { method: 'POST', body: JSON.stringify({ progress: next }) });
  };
  let failed = false;
  let primaryFailure: Error | undefined;
  let stopUpdates = false;
  let nativeUpdates: Promise<unknown>[] = [];
  const chunkTimes = new Map<string, { first: number; last: number }>();
  const frames: number[] = [];
  let measuring = false;
  let stopped = false;
  let lastFrame = performance.now();
  const sampleFrame = (now: number) => {
    if (measuring) frames.push(now - lastFrame);
    lastFrame = now;
    if (!stopped) requestAnimationFrame(sampleFrame);
  };
  requestAnimationFrame(sampleFrame);
  const unlisten = await listenToAgentRuntimeSession(({ payload: event }) => {
    if (!ownedSessions.includes(event.sessionId)) return;
    if (event.type === 'request/failure') {
      const { kind, status, code } = event.data.failure;
      failures.set(event.sessionId, { kind, status, code });
      return;
    }
    if (event.type !== (noModel ? 'session/renamed' : 'assistant/chunk')) return;
    if (event.type === 'assistant/chunk' && !event.data.textDelta) return;
    chunks.set(event.sessionId, (chunks.get(event.sessionId) ?? 0) + 1);
    const now = performance.now();
    chunkTimes.set(event.sessionId, { first: chunkTimes.get(event.sessionId)?.first ?? now, last: now });
  });
  try {
    const summaries = [];
    let cursor: string | undefined;
    do {
      const page = await adapter.list({ limit: 100, cursor });
      summaries.push(...page.sessions);
      cursor = page.nextCursor;
    } while (cursor);
    const candidates = summaries.filter(s => !s.archived && !s.parentSessionId).sort((a, b) => (b.revision ?? 0) - (a.revision ?? 0));
    const longViews: AiSessionView[] = [];
    for (const summary of candidates.slice(0, 8)) {
      const view = await adapter.open(summary.id);
      if (view.nodes.length >= 80 || JSON.stringify(view.nodes).length >= 100_000) longViews.push(view);
      if (longViews.length === 3) break;
    }
    assert(longViews.length === 3, 'Need three real stored conversations with at least 80 nodes or 100,000 serialized characters');
    const longSwitches: number[] = [];
    const firstRenders: number[] = [];
    reportPhase('render long conversations');
    const draw = (view: AiSessionView) => flushSync(() => root.render(
      <AiConversation key={view.summary.id} nodes={view.nodes} status={view.status} throughSeq={view.throughSeq} />,
    ));
    for (const width of [360, 900]) {
      container.style.width = `${width}px`;
      for (const view of longViews) {
        const start = performance.now();
        draw(view);
        await painted();
        firstRenders.push(performance.now() - start);
      }
      measuring = true;
      for (let index = 0; index < 20; index++) {
        const selected = longViews[index % longViews.length];
        const start = performance.now();
        const fresh = await adapter.open(selected.summary.id);
        assert(fresh.throughSeq === selected.throughSeq, 'Read-only journal unexpectedly changed');
        draw(fresh);
        await painted();
        longSwitches.push(performance.now() - start);
        assert(container.scrollWidth <= width + 1, 'Conversation overflows the panel');
      }
      measuring = false;
    }
    const longFrames = stats(frames.splice(0));
    reportPhase('replay recorded assistant streams through production projections');
    const sources = await Promise.all(longViews.slice(0, 3).map(async view => {
      const events = [];
      let afterSeq: number | undefined;
      for (;;) {
        const page = await invokeGetCommittedAgentRuntimeEvents({ sessionId: view.summary.id, afterSeq, limit: 1024 });
        events.push(...page.events);
        if (page.nextCursor === undefined) break;
        afterSeq = page.events[page.events.length - 1]?.seq;
      }
      return { view, events, cursor: 0, buffer: new CommittedEventBuffer(), project: createAgentSessionViewProjector(), terminal: false };
    }));
    assert(sources.length === 3, 'Recorded concurrent replay requires three distinct native journals');
    const replaySwitches: number[] = [];
    const chunksReplayed = sources.map(source => source.events.filter(event => event.type === 'assistant/chunk').length);
    assert(chunksReplayed.every(count => count > 0), 'Replay source has no real assistant chunks');
    measuring = true;
    let publication = 0;
    while (sources.some(source => source.cursor < source.events.length)) {
      for (const source of sources) {
        const end = Math.min(source.events.length, source.cursor + 32);
        while (source.cursor < end) {
          const event = source.events[source.cursor++];
          source.buffer.append(event);
          if (event.type === 'session/ended') source.terminal = true;
          if (event.type === 'session/resumed') source.terminal = false;
        }
      }
      const source = sources[publication++ % sources.length];
      const start = performance.now();
      const projected = source.project({ snapshot: source.view.snapshot.value,
        events: source.buffer.snapshot(), lastCommittedSeq: source.buffer.last?.seq, hasTerminalEvent: source.terminal });
      draw(projected);
      await painted();
      replaySwitches.push(performance.now() - start);
    }
    measuring = false;
    const replayFrames = stats(frames.splice(0));
    reportPhase('verify native cache retention and background catch-up');
    const cacheAdapter = createAgentSessionAdapter();
    try {
      for (let index = 0; index < 7; index++) {
        const sessionId = `panel-cache-${crypto.randomUUID()}`;
        await invokeCreateAgentRuntimeSession({ sessionId, taskId: sessionId,
          goal: 'Verify bounded frontend retention without running a model', executionSurface: 'direct' });
        cacheSessions.push(sessionId);
        await cacheAdapter.open(sessionId);
      }
      if (!baseline) {
        assert(cacheSessions.filter(id => cacheAdapter.peek?.(id)).length === 4, 'Inactive cache exceeds four sessions');
        assert(!cacheAdapter.peek?.(cacheSessions[0]), 'Oldest idle session was not evicted');
        const sessionId = cacheSessions[6];
        let publications = 0;
        const unsubscribe = cacheAdapter.subscribe(sessionId, () => { publications++; });
        await cacheAdapter.open(sessionId);
        unsubscribe();
        const before = publications;
        const snapshot = await invokeGetAgentRuntimeSession({ sessionId });
        const renamed = await invokeRenameAgentRuntimeSession({ sessionId, title: 'Native cache update',
          expectedRevision: snapshot.eventCount, clientOperationId: crypto.randomUUID() });
        await eventually(() => cacheAdapter.peek?.(sessionId)?.revision === renamed.eventCount,
          'Hidden native journal did not catch up');
        assert(publications === before, 'Hidden session published to the detached UI');
        await cacheAdapter.archive(sessionId);
        assert(cacheAdapter.peek?.(sessionId) === undefined, 'Archived session retained a writable cache entry');
        const archived = await cacheAdapter.open(sessionId);
        assert(archived.summary.archived && archived.snapshot.value.archived, 'Archived history reopened with stale metadata');
      }
    } finally { cacheAdapter.dispose(); }
    const routes = noModel ? undefined : await invokeListAiRoutes();
    const requestedRoute = new URL(location.href).searchParams.get('route');
    const requestedModel = new URL(location.href).searchParams.get('model');
    const selection = noModel ? undefined : requestedRoute && requestedModel
      ? { routeId: requestedRoute, modelId: requestedModel } : routes?.defaultSelection;
    assert(noModel || selection, 'No configured default model; live multi-Agent performance cannot be verified');
    if (selection) {
      assert(routes?.routes.some(route => route.id === selection.routeId), 'Requested route is not configured');
      const catalog = await invokeListAiRouteModels(selection.routeId);
      assert(catalog.models.some(model => model.modelId === selection.modelId), 'Requested model is not in the configured route catalog');
    }
    reportPhase('create native terminals and sessions');
    for (let index = 0; index < 3; index++) {
      const terminal = await invokeCreateLocalSession();
      terminals.push(terminal.sessionId);
      useTerminalStore.getState().addSession(terminal);
      useTerminalStore.getState().setStatus(terminal.sessionId, await invokeGetSessionStatus(terminal.sessionId));
      const id = `panel-performance-${crypto.randomUUID()}`;
      await invokeCreateAgentRuntimeSession({ sessionId: id, taskId: id,
        goal: `Performance verification ${index + 1}. Write a detailed 2000-word explanation of terminal and chat session caching. Use plain text. Do not call any tools or ask questions.`,
        target: { kind: 'local', targetId: `terminal-${terminal.sessionId}`, sessionId: terminal.sessionId },
        executionSurface: 'direct', permissionMode: 'requestApproval',
        capabilityScope: { toolNames: ['ask_user_question'], effects: ['none'], targetIds: [`terminal-${terminal.sessionId}`] },
      });
      ownedSessions.push(id);
    }
    let lists = 0;
    const observedAdapter = { ...adapter, list: async (...args: Parameters<typeof adapter.list>) => {
      lists++; return adapter.list(...args);
    } };
    const renderPanel = (visible: boolean) => flushSync(() => root.render(
      <Activity mode={visible ? 'visible' : 'hidden'}><AiWorkspaceController scope="terminal" adapter={observedAdapter} /></Activity>,
    ));
    renderPanel(true);
    reportPhase('restore native terminal conversations');
    // Establish each real terminal's initial history once before measuring revisits.
    for (let index = 0; index < terminals.length; index++) {
      useTerminalStore.setState({ activeSessionId: terminals[index] });
      await eventually(() => displayedSession() === ownedSessions[index],
        'Terminal did not restore its own native session');
      await painted();
    }
    const beforeRevisit = lists;
    reportPhase(noModel ? 'run concurrent native journal updates (no model output)' : 'run concurrent models');
    if (selection) {
      const startResults = await Promise.allSettled(ownedSessions.map(sessionId => invokeStartAgentRuntime({ sessionId, selection })));
      assert(startResults.every(result => result.status === 'fulfilled'), 'Configured model failed to start all three Agents');
      await Promise.all(ownedSessions.map((sessionId, index) => {
        const messageId = crypto.randomUUID();
        return invokeAgentRuntimeFollowup({ sessionId, messageId, clientSubmissionId: messageId,
          content: `Performance verification ${index + 1}: write a detailed 2000-word explanation of terminal and chat session caching. Use plain text; do not call tools or ask questions.` });
      }));
    } else {
      nativeUpdates = ownedSessions.map(async (sessionId, index) => {
        let update = 0;
        while (!stopUpdates) {
          const revision = (await invokeGetAgentRuntimeSession({ sessionId })).eventCount;
          try {
            await invokeRenameAgentRuntimeSession({ sessionId,
              title: `Performance verification ${index + 1}. Native update ${++update}`,
              expectedRevision: revision, clientOperationId: crypto.randomUUID() });
          } catch (error) {
            // The real panel may bind its project while the journal changes.
            // A revision conflict confirms this rename was rejected before append.
            if (!String(error).includes('Agent Runtime revision conflict:')) throw error;
          }
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      });
      void Promise.allSettled(nativeUpdates);
    }
    const inputsPerAgent = ownedSessions.map(() => 1);
    const outputDeadline = performance.now() + 120_000;
    for (;;) {
      const views = await Promise.all(ownedSessions.map(id => adapter.open(id)));
      const failure = views.find(view => view.status === 'failed' || view.status === 'cancelled');
      assert(!failure, 'Model execution failed before producing output');
      const ready = ownedSessions.every((id, index) => (chunks.get(id) ?? 0) >= 3 && (noModel
        || views[index].status === 'running' && performance.now() - (chunkTimes.get(id)?.last ?? 0) < 1_000));
      if (ready) break;
      assert(performance.now() < outputDeadline, noModel
        ? 'All three native journals must publish updates' : 'All three models must produce real assistant chunks');
      // A bounded real workload keeps faster Agents producing while slower
      // requests reach their first text. Every additional turn is disclosed.
      if (!noModel) await Promise.all(views.map(async (view, index) => {
        if (view.status !== 'idle' || !(chunks.get(view.summary.id) ?? 0) || inputsPerAgent[index] >= 3) return;
        const messageId = crypto.randomUUID();
        inputsPerAgent[index]++;
        await invokeAgentRuntimeFollowup({ sessionId: view.summary.id, messageId, clientSubmissionId: messageId,
          content: 'Continue the performance workload: write 200 numbered examples of terminal and chat caching behavior, with at least 20 words per example. Produce the full list as plain text; do not summarize, call tools, or ask questions.' });
      }));
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    const concurrentSwitches: number[] = [];
    const concurrentReady: number[] = [];
    let excludedPaintSamples = 0;
    const beforeMeasurement = ownedSessions.map(id => chunks.get(id) ?? 0);
    measuring = true;
    for (let index = 0; index < 45; index++) {
      const target = index % terminals.length;
      const start = performance.now();
      const fallbacksBeforeSwitch = paintFallbacks;
      useTerminalStore.setState({ activeSessionId: terminals[target] });
      await eventually(() => displayedSession() === ownedSessions[target],
        'Switch displayed another terminal conversation');
      concurrentReady.push(performance.now() - start);
      await painted();
      if (!noModel) assert(container.querySelector('[data-ai-node-kind="assistantMessage"]')?.textContent?.trim(),
        'Selected terminal has no rendered assistant text');
      if (paintFallbacks === fallbacksBeforeSwitch) concurrentSwitches.push(performance.now() - start);
      else excludedPaintSamples++;
    }
    measuring = false;
    const revisitLists = lists - beforeRevisit;
    const eventsDuringMeasurement = ownedSessions.map((id, index) => (chunks.get(id) ?? 0) - beforeMeasurement[index]);
    if (!noModel) assert(eventsDuringMeasurement.every(count => count > 0), 'Each model must output during the measured switches');
    if (!baseline) assert(revisitLists === 0, 'Warm terminal switches queried the session directory again');
    const ranges = ownedSessions.map(id => chunkTimes.get(id)!);
    assert(Math.max(...ranges.map(range => range.first)) < Math.min(...ranges.map(range => range.last)),
      'Model output intervals did not overlap; concurrent streaming was not verified');
    const liveViews = await Promise.all(ownedSessions.map(id => adapter.open(id)));
    if (!noModel) assert(liveViews.every(view => view.nodes.some(node => node.kind === 'assistantMessage'
      || node.kind === 'turnProcess' && node.children.some(child => child.kind === 'assistantMessage'))), 'Missing native assistant output');
    if (!baseline) {
      reportPhase('verify draft and explicit new-conversation restoration');
      useTerminalStore.setState({ activeSessionId: terminals[0] });
      await eventually(() => displayedSession() === ownedSessions[0],
        'Could not return to the first terminal');
      const newButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.getAttribute('aria-label') === t('ai.newConversation'));
      assert(newButton, 'Existing new-conversation action missing');
      newButton.click();
      await painted();
      renderPanel(false);
      for (const terminalId of terminals.slice(1)) {
        flushSync(() => useTerminalStore.setState({ activeSessionId: terminalId }));
        await painted();
      }
      renderPanel(true);
      await eventually(() => displayedSession() === ownedSessions[2], 'Hidden panel did not restore the final terminal');
      useTerminalStore.setState({ activeSessionId: terminals[0] });
      await eventually(() => container.querySelector<HTMLElement>('[data-slot="ai-workspace-root"]')?.dataset.phase === 'hero',
        'Hidden terminal switches replaced an explicit empty conversation with history');
      assert(displayedSession() === undefined, 'Empty conversation regained a session during hidden switches');
      const editor = container.querySelector<HTMLElement>('[contenteditable="true"]');
      assert(editor, 'Existing composer missing');
      editor.focus();
      document.execCommand('insertText', false, 'Native draft retained across terminal switches');
      await eventually(() => editor.textContent?.includes('Native draft retained') === true, 'Composer did not accept native editing');
      useTerminalStore.setState({ activeSessionId: terminals[1] });
      await eventually(() => displayedSession() === ownedSessions[1],
        'Draft prevented switching to the second terminal');
      useTerminalStore.setState({ activeSessionId: terminals[0] });
      await eventually(() => container.querySelector('[contenteditable="true"]')?.textContent?.includes('Native draft retained') === true,
        'Terminal switch lost the draft');
      assert(displayedSession() === undefined,
        'Explicit new conversation was replaced by automatic history');
      reportPhase('verify deletion of an inactive terminal conversation');
      stopUpdates = true;
      await Promise.all(nativeUpdates);
      useTerminalStore.setState({ activeSessionId: terminals[2] });
      await eventually(() => displayedSession() === ownedSessions[2], 'Could not open another terminal before deletion');
      const deletedId = ownedSessions[1];
      await invokeCancelAgentRuntime({ sessionId: deletedId });
      await invokeArchiveAgentRuntimeSession({ sessionId: deletedId });
      await invokeDeleteAgentRuntimeSession({ sessionId: deletedId });
      deletedSessions.add(deletedId);
      window.dispatchEvent(new CustomEvent('shellspan:ai-session-deleted', { detail: { sessionId: deletedId } }));
      useTerminalStore.setState({ activeSessionId: terminals[1] });
      await eventually(() => container.querySelector<HTMLElement>('[data-slot="ai-workspace-root"]')?.dataset.phase === 'hero',
        'Inactive terminal restored a deleted conversation');
      assert(!container.querySelector('[data-ai-error-notice]'), 'Deleted conversation left a stale restore error');
    }
    return { longConversations: longViews.map(view => ({ nodes: view.nodes.length, events: view.revision, serializedCharacters: JSON.stringify(view.nodes).length })),
      initialRenders: stats(firstRenders), longSwitches: stats(longSwitches), longFrames,
      concurrentReady: stats(concurrentReady), concurrentSwitches: concurrentSwitches.length ? stats(concurrentSwitches) : null,
      excludedPaintSamples,
      recordedStreamReplay: { distinctSessions: sources.length, chunksReplayed, eventsPerPublication: 32,
        switches: stats(replaySwitches), frames: replayFrames },
      concurrentFrames: stats(frames), revisitLists, concurrentEvents: ownedSessions.map(id => chunks.get(id)),
      modelOutputVerified: !noModel, selection, inputsPerAgent, eventsDuringMeasurement, overlappingEvents: true, paintFallbacks };
  } catch (error) {
    failed = true;
    const states = phase === 'run concurrent models'
      ? await Promise.allSettled(ownedSessions.map(id => adapter.open(id))) : [];
    const statuses = states.map(result => result.status === 'fulfilled'
      ? { status: result.value.status, chunks: chunks.get(result.value.summary.id) ?? 0,
        failure: failures.get(result.value.summary.id) } : { status: 'unavailable' });
    primaryFailure = new Error(`${phase}: ${error instanceof Error ? error.message : String(error)}${statuses.length ? `; ${JSON.stringify(statuses)}` : ''}`);
    throw primaryFailure;
  } finally {
    stopUpdates = true;
    const updates = await Promise.allSettled(nativeUpdates);
    stopped = true;
    root.unmount();
    adapter.dispose();
    unlisten();
    container.remove();
    const cleanupFailures: string[] = [];
    for (const sessionId of [...ownedSessions, ...cacheSessions].filter(id => !deletedSessions.has(id))) {
      let step = 'load';
      try {
        const snapshot = await invokeGetAgentRuntimeSession({ sessionId });
        step = 'cancel';
        if (!snapshot.ended && !snapshot.archived) await invokeCancelAgentRuntime({ sessionId });
        step = 'archive';
        if (!snapshot.archived) await invokeArchiveAgentRuntimeSession({ sessionId });
        step = 'delete';
        await invokeDeleteAgentRuntimeSession({ sessionId });
      } catch (error) { cleanupFailures.push(`${sessionId} ${step}: ${String(error)}`); }
    }
    const close = await Promise.allSettled(terminals.map(id => invokeCloseSession(id)));
    cleanupFailures.push(...close.flatMap(result => result.status === 'rejected' ? [String(result.reason)] : []));
    assert(!cleanupFailures.length, `${primaryFailure?.message ?? phase}; test-owned cleanup failed: ${cleanupFailures.join('; ')}`);
    if (!failed) assert(updates.every(result => result.status === 'fulfilled'), 'Native journal update failed');
  }
}
const token = new URL(location.href).searchParams.get('token');
void verify().then(metrics => ({ ok: true, metrics }),
  (error: unknown) => ({ ok: false, error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error) }),
).then(result => fetch(`/__agent-stream-result/${token}`, { method: 'POST', body: JSON.stringify(result) }));
