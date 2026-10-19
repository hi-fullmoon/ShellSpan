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
  invokeDeleteAgentRuntimeSession, invokeGetCommittedAgentRuntimeEvents } from '@/lib/ipc/tauri';
import { buildSessionCreateRequest, invokeCreateSession, invokeCheckHostKey, invokeTrustHost, invokeRemoveKnownHost } from '@/lib/ipc/tauri';
import { useProfileStore } from '@/stores/profileStore';
import type { ConnectionProfile } from '@/types';
import { useTerminalStore } from '@/stores/terminalStore';
import { useAppStore } from '@/stores/appStore';
import { initI18n } from '@/locales';
import { readTerminalCurrentDirectory } from '@/lib/terminal/terminal-current-directory';
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
function NativeAgent() {
  agent = useAiSessionController({ scope: 'terminal' });
  return <div data-agent-id={agent.view?.summary.id}>{agent.composer.draft}</div>;
}
function NativeWorkspace({ panel }: { panel: boolean }) {
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
    const projectRoot = sshFixture ? null : await readTerminalCurrentDirectory(live()!);
    assert(sshFixture || projectRoot, 'Missing actual local project directory');
    await invokeCreateAgentRuntimeSession({ sessionId: agentId, taskId: `task-${crypto.randomUUID()}`,
      goal: 'Verify terminal reconnect preserves this conversation', executionSurface: 'boundTerminal',
      permissionMode: 'operator', target: { kind: sshFixture ? 'remote' : 'local', targetId: `terminal-${original.sessionId}`, sessionId: original.sessionId,
        ...(sshFixture ? { host: profile.host, port: profile.port, username: profile.username, profileId: profile.id } : { cwd: projectRoot! }) } });
    created = true;
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
    const originalEvents = await invokeGetCommittedAgentRuntimeEvents({ sessionId: agentId, limit: 100 });
    for (let attempt = 0; attempt < 2; attempt++) {
      const previous = live()!.sessionId;
      if (attempt === 0) {
        const terminal = terminalRegistry.get(previous);
        assert(terminal, 'Missing production terminal for idle timeout');
        terminal.terminal.input('unset HISTFILE; TMOUT=1\r', true);
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
      await eventually(() => agent?.view?.snapshot.value.header.target?.sessionId === replacement,
        `Agent did not rebind to native replacement: ${agent?.composer.lastError?.message ?? 'no error'}`);
      assert(agent!.view!.summary.id === agentId, 'Reconnect replaced the Agent conversation ID');
      assert(agent!.composer.draft === 'Keep this draft through terminal reconnect', 'Reconnect lost the composer draft');
      assert(!agent!.readOnlySession, 'Reconnected Agent remained read-only');
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
    let rejected = false;
    try { await invokeReconnectAgentTerminal({ sessionId: agentId, previousSessionId: live()!.sessionId, terminalSessionId: unrelated.sessionId }); }
    catch { rejected = true; }
    assert(rejected, 'Backend accepted an unrelated native PTY as a reconnect');
    const events = await invokeGetCommittedAgentRuntimeEvents({ sessionId: agentId, limit: 100 });
    assert(events.events.filter(event => event.type === 'session/terminal_reconnected').length === 3, 'Native rebind events were not durably committed');
    assert(!events.events.some(event => event.type === 'turn/start' || event.type === 'request/start'), 'Reconnect started execution without human input');
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
