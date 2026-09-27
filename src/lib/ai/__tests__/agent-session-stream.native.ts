import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { AiWorkspaceErrorNotices } from '@/components/ai/workspace/ai-workspace-error-notices';
import { initI18n, t } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import {
  invokeArchiveAgentRuntimeSession,
  invokeCancelAgentRuntime,
  invokeCreateAgentRuntimeSession,
  invokeDeleteAgentRuntimeSession,
  invokeGetAgentRuntimeSession,
  invokeGetCommittedAgentRuntimeEvents,
  invokeRenameAgentRuntimeSession,
  isTauriRuntime,
  listenToAgentRuntimeSession,
} from '@/lib/ipc/tauri';
import { AgentSessionCommittedClient, type AgentSessionStreamTransport } from '../agent-session-client';
import { createAgentSessionViewProjector } from '../agent-session-adapter';
import '@/styles/base.css';
import '@/components/ai/styles/styles.css';

// Real Tauri subscriptions, durable events and storage errors. Gates delay actual
// IPC results; no model, transport response or committed event is fabricated.
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function eventually(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function verify(): Promise<void> {
  assert(isTauriRuntime(), 'This regression requires a real Tauri window');
  const sessionId = `stream-regression-${crypto.randomUUID()}`;
  const missingSession = `missing-${crypto.randomUUID()}`;
  const clients: AgentSessionCommittedClient[] = [];
  const pendingGates: ReturnType<typeof gate>[] = [];
  const unhandled: unknown[] = [];
  const captureUnhandled = (event: PromiseRejectionEvent) => { unhandled.push(event.reason); };
  window.addEventListener('unhandledrejection', captureUnhandled);
  const transport: AgentSessionStreamTransport = {
    snapshot: (id) => invokeGetAgentRuntimeSession({ sessionId: id }),
    committedEvents: invokeGetCommittedAgentRuntimeEvents,
    subscribe: (listener) => listenToAgentRuntimeSession((event) => listener(event.payload)),
  };
  const createClient = (source: AgentSessionStreamTransport) => {
    const client = new AgentSessionCommittedClient(sessionId, source);
    clients.push(client);
    return client;
  };
  const rename = async () => {
    const snapshot = await transport.snapshot(sessionId);
    return invokeRenameAgentRuntimeSession({ sessionId, title: `Stream regression ${snapshot.eventCount}`,
      expectedRevision: snapshot.eventCount, clientOperationId: crypto.randomUUID() });
  };
  await invokeCreateAgentRuntimeSession({ sessionId, taskId: crypto.randomUUID(),
    goal: 'Verify native committed stream lifecycle and recovery', executionSurface: 'direct' });
  const container = document.createElement('div');
  container.className = 'ai-panel-shell';
  container.dataset.aiScope = 'workbench';
  document.body.append(container);
  const root = createRoot(container);
  try {
    // Disconnect while the native subscribe call has completed but its promise
    // is still pending, then reconnect before the obsolete result is released.
    const subscriptionGate = gate();
    pendingGates.push(subscriptionGate);
    let subscriptions = 0;
    let releases = 0;
    let ready = false;
    const delayed = createClient({ ...transport, subscribe: async (listener) => {
      const first = ++subscriptions === 1;
      const unlisten = await transport.subscribe(listener);
      if (first) { ready = true; await subscriptionGate.promise; }
      return () => { releases++; unlisten(); };
    } });
    const oldConnect = delayed.connect().then(() => false, () => true);
    await eventually(() => ready, 'Native subscription did not register');
    delayed.disconnect();
    await delayed.connect();
    subscriptionGate.release();
    assert(await oldConnect, 'Disconnected subscription resolved successfully');
    assert(releases === 1, 'Obsolete native subscription was not released');
    const renamed = await rename();
    await eventually(() => delayed.state().lastCommittedSeq === renamed.eventCount - 1,
      'Old connection cleanup interrupted the new subscription');
    delayed.disconnect();
    assert(Number(releases) === 2, 'Current native subscription was not released');

    const snapshotGate = gate();
    pendingGates.push(snapshotGate);
    let snapshotReady = false;
    let reads = 0;
    const delayedSnapshot = createClient({ ...transport, snapshot: async (id) => {
      const first = ++reads === 1;
      const snapshot = await transport.snapshot(id);
      if (first) { snapshotReady = true; await snapshotGate.promise; }
      return snapshot;
    } });
    const oldSnapshot = delayedSnapshot.connect().then(() => false, () => true);
    await eventually(() => snapshotReady, 'Native snapshot did not arrive');
    delayedSnapshot.disconnect();
    await rename();
    const current = await delayedSnapshot.connect();
    snapshotGate.release();
    assert(await oldSnapshot, 'Disconnected snapshot resolved successfully');
    assert(delayedSnapshot.state().snapshot === current.snapshot, 'Late snapshot replaced the new connection');
    delayedSnapshot.disconnect();

    // A live gap repair may still be awaiting a page when navigation disconnects.
    const pageGate = gate();
    pendingGates.push(pageGate);
    const skippedPageEvent = gate();
    let skipPageEvent = false;
    let holdPage = false;
    let pageReady = false;
    const delayedPage = createClient({ ...transport,
      subscribe: (listener) => transport.subscribe((event) => {
        if (!skipPageEvent) listener(event);
        else if (event.sessionId === sessionId) skippedPageEvent.release();
      }),
      committedEvents: async (request) => {
        const page = await transport.committedEvents(request);
        if (holdPage) { holdPage = false; pageReady = true; await pageGate.promise; }
        return page;
      },
    });
    await delayedPage.connect();
    skipPageEvent = true;
    await rename();
    await skippedPageEvent.promise;
    skipPageEvent = false;
    holdPage = true;
    await rename();
    await eventually(() => pageReady, 'Live gap repair did not request its native page');
    const oldWork = delayedPage.settled();
    delayedPage.disconnect();
    const reconnected = await delayedPage.connect();
    pageGate.release();
    await oldWork;
    assert(delayedPage.state().events === reconnected.events, 'Obsolete live work mutated the reconnected window');
    delayedPage.disconnect();

    let deliverLive = true;
    let unavailable = false;
    let recoveryReads = 0;
    let skippedEvent = gate();
    const manualGate = gate();
    pendingGates.push(manualGate);
    let holdRecovery = false;
    let recoveryHeld = false;
    const recovering = createClient({
      ...transport,
      subscribe: (listener) => transport.subscribe((event) => {
        if (deliverLive) listener(event);
        else if (event.sessionId === sessionId) skippedEvent.release();
      }),
      committedEvents: async (request) => {
        recoveryReads++;
        const result = await transport.committedEvents(unavailable ? { ...request, sessionId: missingSession } : request);
        if (holdRecovery) { holdRecovery = false; recoveryHeld = true; await manualGate.promise; }
        return result;
      },
    });
    const project = createAgentSessionViewProjector();
    let visible = project(await recovering.connect());
    await initI18n('en-US');
    let uiRetry: Promise<void> | undefined;
    const renderError = () => flushSync(() => root.render(createElement(AiWorkspaceErrorNotices, {
      syncError: visible.syncError, syncRecovery: visible.syncRecovery,
      onRetrySync: () => {
        uiRetry = recovering.retrySync().then(() => undefined, () => undefined);
        return uiRetry;
      },
    })));
    recovering.onChange((state) => { visible = project(state); renderError(); });
    const beforeFailure = recovering.state().events;
    deliverLive = false;
    const missed = await rename();
    await skippedEvent.promise;
    unavailable = true;
    deliverLive = true;
    const latest = await rename();
    await eventually(() => Boolean(visible.syncError), 'Stream failure was not published to the session view');
    assert(recovering.state().events === beforeFailure, 'Failed full replay discarded published events');
    for (const locale of ['zh-CN', 'en-US'] as const) {
      useAppStore.setState({ locale });
      await initI18n(locale);
      renderError();
      assert(container.textContent?.includes(t('ai.error.streamSyncFailed')), 'Synchronization notice is not localized');
      assert(container.querySelectorAll('[data-ai-error-notice]').length === 1, 'Synchronization notice was duplicated');
    }
    const attempts = recoveryReads;
    await eventually(() => recoveryReads > attempts, 'No automatic recovery attempt occurred');
    assert(visible.syncError, 'Failed automatic recovery cleared the error');
    unavailable = false;
    // No additional event is sent: the timer must recover the final missed event.
    await eventually(() => !visible.syncError && visible.throughSeq === latest.eventCount - 1,
      'Automatic recovery did not catch up without another live event');
    assert((visible.throughSeq ?? -1) >= missed.eventCount, 'Gap was not filled');
    assert(!container.querySelector('[data-ai-error-notice]'), 'Recovered synchronization notice was not cleared');
    const durable = await transport.committedEvents({ sessionId, limit: 1024 });
    assert(JSON.stringify(recovering.state().events) === JSON.stringify(durable.events),
      'Recovered stream differs from the real durable journal');

    // Reproduce a second real sequence gap to exercise the manual recovery UI.
    deliverLive = false;
    skippedEvent = gate();
    await rename();
    await skippedEvent.promise;
    unavailable = true;
    deliverLive = true;
    const manualLatest = await rename();
    await eventually(() => Boolean(visible.syncError), 'Manual retry precondition did not produce an error');
    const lastSyncedAt = visible.syncRecovery?.lastSyncedAt;
    assert(lastSyncedAt !== undefined, 'Last successful synchronization time is unavailable');
    while ((visible.syncRecovery?.attempts ?? 0) < 3) {
      let failed = false;
      try { await recovering.retrySync(); } catch { failed = true; }
      assert(failed, 'Retry unexpectedly succeeded while journal reads were unavailable');
    }
    for (const locale of ['zh-CN', 'en-US'] as const) {
      useAppStore.setState({ locale });
      await initI18n(locale);
      renderError();
      assert(container.textContent?.includes(t('ai.error.streamSyncPersistent')), 'Persistent failures have no recovery guidance');
      assert(container.textContent?.includes(t('ai.error.streamSyncAttempts', { count: visible.syncRecovery!.attempts })),
        'Retry attempts were not displayed');
      assert(visible.syncRecovery?.lastSyncedAt === lastSyncedAt, 'A failed retry advanced the successful synchronization time');
      for (const width of [420, 900]) {
        container.style.width = `${width}px`;
        await new Promise(requestAnimationFrame);
        const button = container.querySelector('button')!;
        const alert = container.querySelector('[data-ai-error-notice]')!;
        assert(button.textContent?.includes(t('ai.error.streamSyncRetry')), 'Retry control is not readable');
        assert(button.getBoundingClientRect().right <= alert.getBoundingClientRect().right,
          'Retry control overflows the synchronization notice');
        assert(container.scrollWidth <= width + 1, 'Synchronization notice overflows its narrow container');
      }
    }
    unavailable = false;
    holdRecovery = true;
    const button = container.querySelector('button')!;
    button.click();
    assert(button.disabled && button.getAttribute('aria-busy') === 'true', 'Manual retry has no disabled busy feedback');
    assert(button.textContent?.includes(t('ai.error.streamSyncRetrying')), 'Retry progress label is missing');
    await eventually(() => recoveryHeld, 'Manual retry did not immediately reach native storage');
    const retryReads = recoveryReads;
    button.click();
    const concurrent = recovering.retrySync();
    assert(recoveryReads === retryReads, 'Concurrent retries started duplicate requests');
    manualGate.release();
    await Promise.all([uiRetry, concurrent]);
    assert(!visible.syncError && visible.throughSeq === manualLatest.eventCount - 1,
      'Manual retry did not recover the committed stream');
    assert(!container.querySelector('[data-ai-error-notice]'), 'Manual recovery left a stale error notice');
    recovering.disconnect();
    assert(unhandled.length === 0, 'Stream work caused an unhandled rejection');
  } finally {
    root.unmount();
    container.remove();
    for (const client of clients) client.disconnect();
    for (const pending of pendingGates) pending.release();
    window.removeEventListener('unhandledrejection', captureUnhandled);
    await invokeCancelAgentRuntime({ sessionId });
    await invokeArchiveAgentRuntimeSession({ sessionId });
    await invokeDeleteAgentRuntimeSession({ sessionId });
  }
}

const token = new URL(location.href).searchParams.get('token');
void verify().then(
  () => ({ ok: true }),
  (error: unknown) => ({ ok: false, error: error instanceof Error ? error.stack ?? error.message : String(error) }),
).then((result) => fetch(`/__agent-stream-result/${token}`, { method: 'POST', body: JSON.stringify(result) }));
