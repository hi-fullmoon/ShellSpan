import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { TerminalControllerLayer } from '../terminal-controller-layer';
import { TerminalCarousel } from '../terminal-carousel';
import { TerminalTabBar } from '../terminal-tab-bar';
import { FocusLayout } from '@/components/focus/focus-layout';
import { terminalRegistry } from '../registry/terminal-registry';
import { useTerminalStore } from '@/stores/terminalStore';
import { useFocusStore } from '@/stores/focusStore';
import { useAppStore } from '@/stores/appStore';
import { initI18n } from '@/locales';
import {
  invokeCreateLocalSession, invokeCloseSession, invokeListAiRoutes, invokeGetTerminalBrokerSnapshot,
  invokeCreateAgentRuntimeSession, invokeStartAgentRuntime, invokeAgentRuntimeFollowup,
  invokeCancelAgentRuntime, invokeArchiveAgentRuntimeSession, invokeDeleteAgentRuntimeSession,
  listenToAgentTerminalLease, listenToAgentRuntimeSession,
} from '@/lib/ipc/tauri';
import '@/styles/base.css';

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function eventually(check: () => boolean, message: string, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    assert(Date.now() < deadline, message);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

// Keep production terminal rendering without mounting workspace persistence.
function NativeTerminals() {
  const sessions = useTerminalStore(state => state.sessions);
  const active = useTerminalStore(state => state.activeSessionId);
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col">
    <TerminalControllerLayer />
    <TerminalTabBar onTabActivate={id => useTerminalStore.getState().setActiveSession(id)} />
    <div className="relative min-h-0 flex-1"><TerminalCarousel sessions={sessions} activeSessionId={active}
      isActive isVisible onActivate={id => useTerminalStore.getState().setActiveSession(id)}
      onSettle={id => terminalRegistry.get(id)?.focus()} /></div>
  </div>;
}

// Real configured model, native IPC, cooperative shell integration and PTYs.
// No replaced transport, synthesized lease events or fabricated command output.
async function verify() {
  const reportPhase = async (progress: string) => {
    await fetch(`/__agent-stream-result/${new URL(location.href).searchParams.get('token')}`,
      { method: 'POST', body: JSON.stringify({ progress }) });
  };
  await reportPhase('Focus background: load configured model selection');
  await initI18n('en-US');
  const parameters = new URL(location.href).searchParams;
  const requestedRoute = parameters.get('route');
  const requestedModel = parameters.get('model');
  const selection = requestedRoute && requestedModel
    ? { routeId: requestedRoute, modelId: requestedModel } : (await invokeListAiRoutes()).defaultSelection;
  assert(selection, 'A configured default model is required');
  const root = createRoot(document.getElementById('root')!);
  const terminals: string[] = [];
  const disposers: (() => void)[] = [];
  const agentId = `agent-focus-background-${crypto.randomUUID()}`;
  let created = false;
  let violation: string | undefined;
  let failure: string | undefined;
  let monitoring = false;
  let acquired = 0;
  let released = 0;
  let completed = 0;
  const operations = new Set<string>();
  let output = '';
  try {
    await reportPhase('Focus background: connect real local PTYs and render Focus');
    useAppStore.getState().setActiveSection('terminal');
    flushSync(() => root.render(<FocusLayout><NativeTerminals /></FocusLayout>));
    for (let index = 0; index < 2; index++) {
      const session = await invokeCreateLocalSession(100, 25);
      terminals.push(session.sessionId);
      flushSync(() => useTerminalStore.getState().addSession(session));
    }
    await eventually(() => terminals.every(id => useTerminalStore.getState().sessions.some(
      session => session.sessionId === id && session.status === 'connected' && session.promptReady,
    )), 'Real terminal integrations did not become ready');
    const controller = terminalRegistry.get(terminals[0]);
    assert(controller, 'Missing background terminal controller');
    await controller.whenOutputReady();
    const broker = (await invokeGetTerminalBrokerSnapshot(terminals[0])).session;
    assert(broker?.integrationState === 'ready' && broker.promptReady, 'Background broker is not ready');
    disposers.push(controller.subscribeOutput(chunk => { output += chunk; }));
    flushSync(() => useFocusStore.getState().enter());
    flushSync(() => { assert(useFocusStore.getState().setTarget(terminals[1]), 'Cannot bind Focus terminal'); });
    await eventually(() => Boolean(document.querySelector('[data-slot="focus-agent"] [data-composer-editor]')),
      'Focus composer was not rendered');
    const editor = document.querySelector<HTMLElement>('[data-slot="focus-agent"] [data-composer-editor]')!;
    editor.focus();
    const checkView = () => {
      if (!monitoring) return;
      if (!useFocusStore.getState().enabled || useTerminalStore.getState().workspace !== 'focus'
        || useFocusStore.getState().targetSessionId !== terminals[1]
        || useTerminalStore.getState().activeSessionId !== terminals[1]
        || useAppStore.getState().activeSection !== 'terminal'
        || document.activeElement !== editor) violation ??= `Background changed Focus: enabled=${useFocusStore.getState().enabled}, workspace=${useTerminalStore.getState().workspace}, targetPreserved=${useFocusStore.getState().targetSessionId === terminals[1]}, selectionPreserved=${useTerminalStore.getState().activeSessionId === terminals[1]}, section=${useAppStore.getState().activeSection}, keyboardPreserved=${document.activeElement === editor}, acquired=${acquired}`;
    };
    disposers.push(useFocusStore.subscribe(checkView), useTerminalStore.subscribe(checkView), useAppStore.subscribe(checkView));
    document.addEventListener('focusin', checkView);
    disposers.push(() => document.removeEventListener('focusin', checkView));
    disposers.push(await listenToAgentTerminalLease(({ payload }) => {
      if (payload.agentSessionId !== agentId) return;
      if (payload.sessionId !== terminals[0]) failure = 'Lease targeted a different PTY';
      if (payload.state === 'acquired') { acquired++; operations.add(payload.operationId); }
      if (payload.state === 'released') released++;
      checkView();
    }));
    disposers.push(await listenToAgentRuntimeSession(({ payload }) => {
      if (payload.sessionId !== agentId) return;
      if (payload.type === 'request/failure') failure = `Model request failed: ${payload.data.failure.kind}`;
      if (payload.type === 'tool/approval' && payload.data.status === 'requested') failure = 'Unexpected approval request';
      if (payload.type === 'tool/result') {
        if (payload.data.status !== 'completed') failure = `Tool ${payload.data.name}: ${payload.data.status} ${payload.data.summary}`;
        else {
          const data = payload.data.data;
          if (!data || typeof data !== 'object' || !('channel' in data) || data.channel !== 'terminal'
            || !('exitCode' in data) || data.exitCode !== 0
            || !('terminalSessionId' in data) || data.terminalSessionId !== broker.terminalSessionId
            || !('terminalGeneration' in data) || data.terminalGeneration !== broker.terminalGeneration
            || !('operationId' in data) || typeof data.operationId !== 'string' || !operations.has(data.operationId)) {
            failure = `Completed tool ${payload.data.name} did not prove successful execution on the leased visible PTY; result keys: ${data && typeof data === 'object' ? Object.keys(data).join(',') : typeof data}; acquired leases: ${acquired}`;
          } else completed++;
        }
      }
      checkView();
    }));
    const markers = [crypto.randomUUID(), crypto.randomUUID()].map(id => `focus-background-${id}`);
    const commands = markers.map(marker => `printf '%s%s\\n' '${marker.slice(0, 20)}' '${marker.slice(20)}'`);
    const goal = `Execute exactly these two commands as two separate run_terminal_command tool calls, sequentially, on the bound visible terminal. Do not use background execution, Direct execution, additional tools, or change the commands. After both complete, reply done.\n${commands.join('\n')}`;
    await reportPhase('Focus background: create native Agent session');
    await invokeCreateAgentRuntimeSession({ sessionId: agentId, taskId: agentId, goal,
      executionSurface: 'boundTerminal', permissionMode: 'operator',
      target: { kind: 'local', targetId: `terminal-${terminals[0]}`, sessionId: terminals[0] },
      capabilityScope: { toolNames: ['run_terminal_command'], effects: ['none', 'readOnly', 'stateChange'], targetIds: [`terminal-${terminals[0]}`] },
    });
    created = true;
    await reportPhase('Focus background: start configured model with existing keychain credentials');
    await invokeStartAgentRuntime({ sessionId: agentId, selection });
    monitoring = true;
    checkView();
    assert(!violation, violation ?? 'Focus setup is invalid');
    const messageId = crypto.randomUUID();
    await reportPhase('Focus background: execute and observe two real visible commands');
    await invokeAgentRuntimeFollowup({ sessionId: agentId, messageId, clientSubmissionId: messageId, content: goal });
    await eventually(() => {
      checkView();
      assert(!violation, violation ?? 'View changed');
      assert(!failure, failure ?? 'Execution failed');
      return completed === 2 && acquired === 2 && released === 2 && markers.every(marker => output.includes(marker));
    }, 'Two real visible commands did not complete with PTY output', 180_000);
    await new Promise(resolve => setTimeout(resolve, 250));
    checkView();
    assert(!violation, violation ?? 'View changed after release');
  } finally {
    monitoring = false;
    await reportPhase('Focus background: clean up test-owned sessions and PTYs');
    for (const dispose of disposers.reverse()) dispose();
    try {
      if (created) {
        await invokeCancelAgentRuntime({ sessionId: agentId });
        await invokeArchiveAgentRuntimeSession({ sessionId: agentId });
        await invokeDeleteAgentRuntimeSession({ sessionId: agentId });
      }
    } finally {
      root.unmount();
      const closed = await Promise.allSettled(terminals.map(async id => {
        try { await invokeCloseSession(id); }
        finally { terminalRegistry.dispose(id); }
      }));
      for (const result of closed) if (result.status === 'rejected') throw result.reason;
    }
  }
}

void verify().then(() => ({ ok: true }), (error: unknown) => ({
  ok: false, error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error),
})).then(result => fetch(`/__agent-stream-result/${new URL(location.href).searchParams.get('token')}`,
  { method: 'POST', body: JSON.stringify(result) }));
