import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { TerminalControllerLayer } from '../terminal-controller-layer';
import { TerminalPane } from '../terminal-pane';
import { terminalRegistry } from '../registry/terminal-registry';
import { useAiSessionController, type AiSessionController } from '@/components/ai/workspace/use-ai-session-controller';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { invokeCreateLocalSession, invokeCloseSession, invokeCreateAgentRuntimeSession,
  invokeGetAgentRuntimeSession, invokeReconnectAgentTerminal, invokeArchiveAgentRuntimeSession,
  invokeDeleteAgentRuntimeSession, invokeGetCommittedAgentRuntimeEvents, invokeGetTerminalBrokerSnapshot } from '@/lib/ipc/tauri';
import { buildSessionCreateRequest, invokeCreateSession, invokeCheckHostKey, invokeTrustHost, invokeRemoveKnownHost } from '@/lib/ipc/tauri';
import { useProfileStore } from '@/stores/profileStore';
import type { ConnectionProfile } from '@/types';
import { useTerminalStore } from '@/stores/terminalStore';
import { useFocusStore } from '@/stores/focusStore';
import { FocusNoTarget } from '@/components/focus/focus-no-target';
import { AiWorkspaceRoot } from '@/components/ai/workspace/ai-workspace-root';
import { useAppStore } from '@/stores/appStore';
import { initI18n } from '@/locales';
import { readTerminalCurrentDirectory } from '@/lib/terminal/terminal-current-directory';
import { useCloseTerminal } from '@/hooks/useCloseTerminal';
import { useReconnectSession } from '@/hooks/useReconnectSession';
import { useToastStore } from '@/stores/toastStore';
import '@/styles/base.css';

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function eventually(check: () => boolean, message: string) {
  const deadline = Date.now() + 30_000;
  while (!check()) {
    assert(Date.now() < deadline, message);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
let agent: AiSessionController | undefined;
let closeTerminal: ReturnType<typeof useCloseTerminal> | undefined;
let reconnectTerminal: ReturnType<typeof useReconnectSession> | undefined;
const focusReconnect = new URL(location.href).searchParams.get('focusReconnect') === 'true';
function NativeAgent() {
  agent = useAiSessionController({ scope: 'terminal', focusMode: focusReconnect });
  const focusTarget = useFocusStore(state => state.targetSessionId);
  const targetConnected = useTerminalStore(state => state.sessions.some(
    session => session.sessionId === focusTarget && session.status === 'connected',
  ));
  if (focusReconnect) return <AiWorkspaceRoot scope="terminal" mode="agent" view={agent.view}
    composerState={agent.composer} canStartAgent={agent.canStartAgent} readOnlySession={agent.readOnlySession}
    agentUnavailableReason={agent.agentUnavailableReason}
    onContinueOnReconnectedTerminal={agent.continueOnReconnectedTerminal ?? undefined}
    historicalContinuationAvailable={agent.historicalContinuationAvailable}
    executionSurfaceNotice={!targetConnected ? <FocusNoTarget /> : undefined} />;
  return <div data-agent-id={agent.view?.summary.id}>{agent.composer.draft}</div>;
}
function NativeWorkspace({ panel }: { panel: boolean }) {
  closeTerminal = useCloseTerminal();
  reconnectTerminal = useReconnectSession();
  const session = useTerminalStore(state => state.sessions.find(item => item.sessionId === state.activeSessionId) ?? null);
  return <TooltipProvider><TerminalControllerLayer /><TerminalPane activeSession={session} />
    {panel && <NativeAgent />}<Toaster /></TooltipProvider>;
}

async function verify() {
  await initI18n('zh-CN');
  const root = createRoot(document.getElementById('root')!);
  const terminals = new Set<string>();
  const agentId = `reconnect-${crypto.randomUUID()}`;
  let created = false;
  let trustedFixtureHost = false;
  const sshFixture = new URL(location.href).searchParams.get('sshFixture') === 'true';
  // Public credentials for tests/ssh-e2e only; never saved to user configuration.
  const profile: ConnectionProfile = { id: `reconnect-ssh-${crypto.randomUUID()}`, name: 'Isolated reconnect acceptance',
    host: '127.0.0.1', port: 22222, username: 'shellspan', authMethod: 'password', password: 'shellspan-e2e', createdAt: Date.now(), updatedAt: Date.now() };
  const live = () => useTerminalStore.getState().sessions.find(item => item.sessionId === useTerminalStore.getState().activeSessionId);
  try {
    useAppStore.getState().setActiveSection('terminal');
    if (focusReconnect) useFocusStore.getState().enter();
    flushSync(() => root.render(<NativeWorkspace panel={false} />));
    if (sshFixture) {
      const host = await invokeCheckHostKey(profile.host, profile.port);
      assert(host.status === 'match' || host.status === 'notFound', 'SSH fixture host identity could not be verified');
      if (host.status === 'notFound') {
        assert(host.fingerprint, 'Missing SSH fixture fingerprint');
        await invokeTrustHost(profile.host, profile.port, host.fingerprint);
        trustedFixtureHost = true;
      }
      useProfileStore.setState(state => ({ profiles: [...state.profiles, profile] }));
    }
    const original = sshFixture ? await invokeCreateSession(buildSessionCreateRequest(profile, 100, 25)) : await invokeCreateLocalSession(100, 25);
    terminals.add(original.sessionId);
    flushSync(() => useTerminalStore.getState().addSession(original, sshFixture ? profile.id : undefined));
    await eventually(() => live()?.status === 'connected', 'Original native PTY did not connect');
    await eventually(() => Boolean(live()?.promptReady), 'Original native shell did not reach its integrated prompt');
    if (focusReconnect) assert(useFocusStore.getState().setTarget(original.sessionId), 'Cannot select the actual Focus target');
    const projectRoot = sshFixture ? null : await readTerminalCurrentDirectory(live()!);
    assert(sshFixture || projectRoot, 'Missing actual local project directory');
    await invokeCreateAgentRuntimeSession({ sessionId: agentId, taskId: `task-${crypto.randomUUID()}`,
      goal: 'Verify terminal reconnect preserves this conversation', executionSurface: 'boundTerminal',
      permissionMode: 'operator', target: { kind: sshFixture ? 'remote' : 'local', targetId: `terminal-${original.sessionId}`, sessionId: original.sessionId,
        ...(sshFixture ? { host: profile.host, port: profile.port, username: profile.username, profileId: profile.id } : { cwd: projectRoot! }) } });
    created = true;
    if (focusReconnect) useFocusStore.getState().setConversation(agentId);
    flushSync(() => root.render(<NativeWorkspace panel />));
    await eventually(() => agent?.view?.summary.id === agentId, 'Native Agent did not restore its original conversation');
    const readProject = async () => {
      if (projectRoot) {
        const files = await agent!.listFileReferences('', new AbortController().signal);
        assert(files.status === 'ready' || files.status === 'truncated', `Native file references failed: ${files.code ?? files.status}`);
        assert(files.scope?.target.sessionId === live()?.sessionId, 'File reference scope retained the old transport');
      }
      const skills = await agent!.listSkills();
      assert(skills.status === 'fresh', `Native Skills refresh failed: ${skills.status}`);
    };
    await readProject();
    flushSync(() => agent!.setDraft('Keep this draft through terminal reconnect'));
    const before = await invokeGetAgentRuntimeSession({ sessionId: agentId });
    const shell=(await invokeGetTerminalBrokerSnapshot(live()!.sessionId)).session?.integrationShell;
    const powershell=shell==='windowsPowerShell'||shell==='powerShell7';
    const originalEvents = await invokeGetCommittedAgentRuntimeEvents({ sessionId: agentId, limit: 100 });
    for (let attempt = 0; attempt < 2; attempt++) {
      const previous = live()!.sessionId;
      if (attempt === 0) {
        const terminal = terminalRegistry.get(previous);
        assert(terminal, 'Missing production terminal for idle timeout');
        terminal.terminal.input(powershell?'exit\r':'unset HISTFILE; TMOUT=1\r', true);
      } else {
        await invokeCloseSession(previous);
      }
      await eventually(() => live()?.status === 'disconnected', 'Native close did not reach the terminal store');
      const disconnected = await invokeGetAgentRuntimeSession({ sessionId: agentId });
      const terminal = terminalRegistry.get(previous);
      assert(terminal, 'Missing disconnected production terminal');
      terminal.terminal.input('\r', true);
      await eventually(() => live()?.sessionId !== previous && live()?.status === 'connected', 'Enter did not reconnect the real native PTY');
      const replacement = live()!.sessionId;
      terminals.add(replacement);
      assert(replacement !== previous, 'Reconnect did not create a real replacement PTY');
      if (focusReconnect) assert(useFocusStore.getState().targetSessionId === replacement,
        'Focus kept the removed transport ID after the terminal reconnected');
      assert(live()!.brokerReplacedSessionIds?.includes(previous), 'Real broker rollover lost verified ancestry');
      await eventually(() => agent?.view?.snapshot.value.header.target?.sessionId === replacement,
        `Agent did not rebind to native replacement: ${agent?.composer.lastError?.message ?? 'no error'}`);
      assert(agent!.view!.summary.id === agentId, 'Reconnect replaced the Agent conversation ID');
      assert(agent!.composer.draft === 'Keep this draft through terminal reconnect', 'Reconnect lost the composer draft');
      assert(!agent!.readOnlySession, 'Reconnected Agent remained read-only');
      if (focusReconnect) assert(!document.querySelector('[data-slot="focus-start-notice"]'),
        'Focus still reported its reconnected target as closed');
      const persisted = await invokeGetAgentRuntimeSession({ sessionId: agentId });
      assert(persisted.header.taskId === before.header.taskId && persisted.header.goal === before.header.goal, 'Reconnect replaced task context');
      assert(persisted.header.permissionMode === 'requestApproval', 'Reconnect retained old execution authorization');
      const committed = await invokeGetCommittedAgentRuntimeEvents({ sessionId: agentId, limit: 100 });
      assert(committed.events.filter(event => event.type === 'session/terminal_reconnected').length === attempt + 1,
        `Unexpected reconnect events: before=${disconnected.eventCount}, after=${persisted.eventCount}, types=${committed.events.map(event => event.type).join(',')}`);
      assert(!committed.events.some(event => event.type === 'turn/start' || event.type === 'request/start'), 'Reconnect started execution without human input');
      assert(JSON.stringify(committed.events.slice(0, originalEvents.events.length)) === JSON.stringify(originalEvents.events), 'Reconnect changed existing conversation events');
      await readProject();
    }
    flushSync(() => root.render(<NativeWorkspace panel={false} />));
    agent = undefined;
    const previous = live()!.sessionId;
    await invokeCloseSession(previous);
    await eventually(() => live()?.status === 'disconnected', 'Panel-hidden terminal did not disconnect');
    const terminal = terminalRegistry.get(previous);
    assert(terminal, 'Missing panel-hidden production terminal');
    terminal.terminal.input('\r', true);
    await eventually(() => live()?.sessionId !== previous && live()?.status === 'connected', 'Enter did not reconnect while the Agent panel was closed');
    terminals.add(live()!.sessionId);
    flushSync(() => root.render(<NativeWorkspace panel />));
    await eventually(() => agent?.view?.summary.id === agentId
      && agent.view.snapshot.value.header.target?.sessionId === live()?.sessionId, 'Closed panel did not restore and rebind its predecessor conversation');
    const unrelated = await invokeCreateLocalSession(80, 24);
    terminals.add(unrelated.sessionId);
    let expectedReconnects = 3;
    if (focusReconnect) {
      flushSync(() => useTerminalStore.getState().addSession(unrelated));
      await eventually(() => live()?.status === 'connected', 'Unrelated viewing terminal did not connect');
      for (const hidden of [false, true]) {
        const previous = useFocusStore.getState().targetSessionId!;
        assert(previous !== unrelated.sessionId, 'Viewing a different tab changed the Focus target');
        if (hidden) flushSync(() => useFocusStore.getState().leave());
        flushSync(() => useTerminalStore.getState().setActiveSession(unrelated.sessionId));
        await invokeCloseSession(previous);
        await eventually(() => useTerminalStore.getState().sessions.find(item => item.sessionId === previous)?.status === 'disconnected',
          'Focus target did not disconnect while a different terminal was selected');
        assert(reconnectTerminal, 'Missing production reconnect action');
        await reconnectTerminal(previous);
        await eventually(() => {
          const id = useFocusStore.getState().targetSessionId;
          return id !== previous && useTerminalStore.getState().sessions.some(item => item.sessionId === id && item.status === 'connected');
        }, 'Focus did not follow its replacement while another terminal was selected');
        const replacement = useFocusStore.getState().targetSessionId!;
        terminals.add(replacement);
        assert(useTerminalStore.getState().activeSessionId === unrelated.sessionId, 'Focus reconnect stole the viewed terminal');
        assert(useFocusStore.getState().enabled === !hidden, 'Reconnect changed whether Focus was enabled');
        await eventually(() => agent?.view?.snapshot.value.header.target?.sessionId === replacement,
          'Focus Agent did not bind to its replacement while hidden or viewing another tab');
        assert(agent!.view!.summary.id === agentId && agent!.composer.draft === 'Keep this draft through terminal reconnect',
          'Focus reconnect replaced the conversation or lost its draft');
        if (hidden) flushSync(() => useFocusStore.getState().enter());
        assert(useFocusStore.getState().targetSessionId === replacement, 'Returning to Focus lost its reconnected target');
        expectedReconnects++;
      }
      flushSync(() => useTerminalStore.getState().setActiveSession(useFocusStore.getState().targetSessionId));
      await readProject();
    }
    let rejected = false;
    try { await invokeReconnectAgentTerminal({ sessionId: agentId, previousSessionId: live()!.sessionId, terminalSessionId: unrelated.sessionId }); }
    catch { rejected = true; }
    assert(rejected, 'Backend accepted an unrelated native PTY as a reconnect');
    const events = await invokeGetCommittedAgentRuntimeEvents({ sessionId: agentId, limit: 100 });
    assert(events.events.filter(event => event.type === 'session/terminal_reconnected').length === expectedReconnects, 'Native rebind events were not durably committed');
    assert(!events.events.some(event => event.type === 'turn/start' || event.type === 'request/start'), 'Reconnect started execution without human input');
    const closing = live()!;
    await eventually(() => Boolean(live()?.promptReady), 'Reconnected shell did not reach its prompt');
    const closingController = terminalRegistry.get(closing.sessionId);
    assert(closingController && closeTerminal, 'Missing production close path');
    assert(await closingController.writeUserInput(powershell?'exit\r':'unset HISTFILE; TMOUT=1\r'), 'Final native disconnect input was rejected');
    await eventually(() => live()?.status === 'disconnected', 'Reconnected shell did not disconnect after idle timeout');
    const toastsBeforeClose = useToastStore.getState().toasts.length;
    await closeTerminal(closing.sessionId);
    assert(!useTerminalStore.getState().sessions.some(item => item.sessionId === closing.sessionId), 'Closing the disconnected terminal retained its tab');
    if (focusReconnect) assert(useFocusStore.getState().targetSessionId === closing.sessionId,
      'Closing the Focus target implicitly adopted another terminal');
    assert(useToastStore.getState().toasts.length === toastsBeforeClose, 'Closing a disconnected terminal reported a false error');
    assert((await invokeGetAgentRuntimeSession({ sessionId: agentId })).ended, 'Closing must settle the associated Agent');
    await invokeCloseSession(closing.sessionId);
    if (focusReconnect) {
      // Startup restoration runs only in an empty workspace. The extra live
      // tab used above must be closed before exercising that separate path.
      await invokeCloseSession(unrelated.sessionId);
      flushSync(() => useTerminalStore.getState().removeSession(unrelated.sessionId));
    }

    // Restore exactly the persisted workspace fields: broker identities do not
    // survive a process restart. Exercise the production Enter reconnect path.
    flushSync(() => useTerminalStore.getState().addRestoredSessions([{
      sessionId: closing.sessionId, title: closing.title, host: closing.host,
      port: closing.port, username: closing.username, profileId: closing.profileId,
    }]));
    await eventually(() => Boolean(terminalRegistry.get(closing.sessionId)), 'Restored terminal was not mounted');
    terminalRegistry.get(closing.sessionId)!.terminal.input('\r', true);
    await eventually(() => live()?.sessionId !== closing.sessionId && live()?.status === 'connected',
      'Restored terminal did not establish a fresh connection');
    terminals.add(live()!.sessionId);
    await eventually(() => agent?.view?.summary.id === agentId && agent.readOnlySession,
      'Restored terminal did not retain the earlier conversation as read-only history');
    assert(live()!.brokerReplacedSessionIds?.length === 0, 'Restored transport was treated as a verified replacement');
    assert(!agent!.continueOnReconnectedTerminal, 'Restored transport offered an impossible rebind');
    assert(!agent!.composer.lastError, 'Restored transport attempted an invalid automatic rebind');
    const restoredEvents = await invokeGetCommittedAgentRuntimeEvents({ sessionId: agentId, limit: 100 });
    assert(restoredEvents.events.filter(event => event.type === 'session/terminal_reconnected').length === expectedReconnects,
      'Restoring workspace history rebound the old conversation');
  } finally {
    root.unmount();
    if (created) {
      await invokeArchiveAgentRuntimeSession({ sessionId: agentId });
      await invokeDeleteAgentRuntimeSession({ sessionId: agentId });
    }
    for (const id of terminals) {
      await invokeCloseSession(id).catch(() => undefined);
      terminalRegistry.dispose(id);
      useTerminalStore.getState().removeSession(id);
    }
    if (sshFixture) useProfileStore.setState(state => ({ profiles: state.profiles.filter(item => item.id !== profile.id) }));
    if (trustedFixtureHost) await invokeRemoveKnownHost(profile.host, profile.port);
  }
}
const token = new URL(location.href).searchParams.get('token');
void verify().then(() => ({ ok: true }), (error: unknown) => ({ ok: false,
  error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error),
})).then(result => fetch(`/__agent-stream-result/${token}`, { method: 'POST', body: JSON.stringify(result) }));
