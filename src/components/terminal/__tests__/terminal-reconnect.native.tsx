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
  invokeResumeAgentRuntime, invokeAgentRuntimeFollowup, invokeMutateAgentRuntimeInbox,
  invokeDeleteAgentRuntimeSession, invokeGetCommittedAgentRuntimeEvents, invokeGetTerminalBrokerSnapshot } from '@/lib/ipc/tauri';
import { buildSessionCreateRequest, invokeCreateSession, invokeCheckHostKey, invokeTrustHost,
  invokeRemoveKnownHost, invokeAddProfile, invokeRemoveProfile, invokeStoreProfilePassword,
  invokeDeleteProfilePassword } from '@/lib/ipc/tauri';
import { useProfileStore } from '@/stores/profileStore';
import type { ConnectionProfile, ProfileRow } from '@/types';
import { useTerminalStore } from '@/stores/terminalStore';
import { useFocusStore } from '@/stores/focusStore';
import { FocusNoTarget } from '@/components/focus/focus-no-target';
import { AiWorkspaceRoot } from '@/components/ai/workspace/ai-workspace-root';
import { useAppStore } from '@/stores/appStore';
import { initI18n, t } from '@/locales';
import { readTerminalCurrentDirectory } from '@/lib/terminal/terminal-current-directory';
import { useCloseTerminal } from '@/hooks/useCloseTerminal';
import { useReconnectSession } from '@/hooks/useReconnectSession';
import { useToastStore } from '@/stores/toastStore';
import { canContinueOnReconnectedTerminal, canVerifyTerminalContinuation } from '@/lib/ai/reconnected-terminal';
import '@/styles/base.css';

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function eventually(check: () => boolean | Promise<boolean>, message: string | (() => string)) {
  const deadline = Date.now() + 30_000;
  while (!(await check())) {
    assert(Date.now() < deadline, typeof message === 'function' ? message() : message);
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
  return <section data-agent-panel className="flex h-full min-h-0 min-w-0 flex-col"><AiWorkspaceRoot scope="terminal" mode="agent" view={agent.view}
    composerState={agent.composer} canStartAgent={agent.canStartAgent} readOnlySession={agent.readOnlySession}
    draft={agent.composer.draft} onDraftChange={agent.setDraft}
    historicalTargetUnavailable={agent.historicalTargetUnavailable}
    agentUnavailableReason={agent.agentUnavailableReason}
    onContinueOnReconnectedTerminal={agent.continueOnReconnectedTerminal ?? undefined}
    terminalReconnectBusy={agent.terminalReconnectBusy}
    historicalContinuationAvailable={agent.historicalContinuationAvailable}
    executionSurfaceNotice={focusReconnect && !targetConnected ? <FocusNoTarget /> : undefined} /></section>;
}
function NativeWorkspace({ panel }: { panel: boolean }) {
  closeTerminal = useCloseTerminal();
  reconnectTerminal = useReconnectSession();
  const session = useTerminalStore(state => state.sessions.find(item => item.sessionId === state.activeSessionId) ?? null);
  return <TooltipProvider><TerminalControllerLayer /><div className="grid h-full min-h-0 grid-cols-2">
    <TerminalPane activeSession={session} />{panel && <NativeAgent />}</div><Toaster /></TooltipProvider>;
}

async function verify() {
  await initI18n('zh-CN');
  const root = createRoot(document.getElementById('root')!);
  const terminals = new Set<string>();
  const agentId = `reconnect-${crypto.randomUUID()}`;
  let created = false;
  let trustedFixtureHost = false;
  let savedProfile = false;
  const sshFixture = new URL(location.href).searchParams.get('sshFixture') === 'true';
  const profileRow: ProfileRow = { id: `reconnect-ssh-${crypto.randomUUID()}`, name: 'Isolated reconnect acceptance',
    host: '127.0.0.1', port: 22222, username: 'shellspan', authMethod: 'password', createdAt: Date.now(), updatedAt: Date.now() };
  const profile = { ...profileRow, password: 'shellspan-e2e' } satisfies ConnectionProfile;
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
      // Remote Agent reads use the saved profile and keychain reference.
      await invokeAddProfile(profileRow);
      savedProfile = true;
      await invokeStoreProfilePassword(profile.id, profile.password);
      useProfileStore.setState(state => ({ profiles: [...state.profiles, profile] }));
    }
    const original = sshFixture ? await invokeCreateSession(buildSessionCreateRequest(profile, 100, 25)) : await invokeCreateLocalSession(100, 25);
    terminals.add(original.sessionId);
    flushSync(() => useTerminalStore.getState().addSession(original, sshFixture ? profile.id : undefined));
    await eventually(() => live()?.status === 'connected', 'Original native PTY did not connect');
    await eventually(() => Boolean(live()?.promptReady), 'Original native shell did not reach its integrated prompt');
    if (new URL(location.href).searchParams.get('surfaceOnly') === 'true') {
      const originalController = terminalRegistry.get(original.sessionId);
      assert(originalController, 'Missing original production controller');
      const assertSurface = async () => {
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        const surfaces = document.querySelectorAll('[data-terminal-measure-session]');
        assert(surfaces.length === 1, `Reconnect left ${surfaces.length} terminal surfaces mounted`);
        const controller = terminalRegistry.get(live()!.sessionId);
        assert(controller === originalController, 'Reconnect replaced the retained controller');
        const host = document.querySelector(`[data-terminal-measure-session="${live()!.sessionId}"]`);
        assert(host && host.contains(controller.container), 'Replacement terminal is attached to a stale host');
        const bounds = () => ({
          pane: host.getBoundingClientRect(),
          viewport: document.getElementById('root')!.getBoundingClientRect(),
          screen: controller.terminal.element!.querySelector('.xterm-screen')!.getBoundingClientRect(),
        });
        await eventually(() => {
          const { pane, screen, viewport } = bounds();
          return screen.width > 0 && screen.height > 0 && screen.top >= pane.top && screen.bottom <= pane.bottom + 1
            && screen.top >= viewport.top && screen.bottom <= Math.min(viewport.bottom, innerHeight) + 1
            && screen.left >= pane.left && screen.right <= pane.right + 1;
        }, () => `Replacement terminal is outside its visible pane: ${JSON.stringify(bounds())}`);
      };
      const powershell = ['windowsPowerShell', 'powerShell7'].includes(
        (await invokeGetTerminalBrokerSnapshot(original.sessionId)).session?.integrationShell ?? '',
      );
      for (let attempt = 0; attempt < 3; attempt++) {
        const previous = live()!.sessionId;
        await invokeCloseSession(previous);
        await eventually(() => live()?.status === 'disconnected', 'Surface terminal did not disconnect');
        originalController.terminal.input('\r', true);
        await eventually(() => live()?.sessionId !== previous && live()?.status === 'connected'
          && Boolean(live()?.promptReady), 'Surface terminal did not reconnect to a ready prompt');
        terminals.add(live()!.sessionId);
        for (const width of ['720px', '1200px']) {
          document.getElementById('root')!.style.width = width;
          flushSync(() => root.render(<NativeWorkspace panel={false} />));
          await assertSurface();
        }
        const marker = `reconnect-visible-${crypto.randomUUID()}`;
        originalController.terminal.input(powershell ? `Write-Output '${marker}'\r` : `printf '%s\\n' '${marker}'\r`, true);
        await eventually(() => {
          const buffer = originalController.terminal.buffer.active;
          return Array.from({ length: buffer.length }, (_, row) => buffer.getLine(row)?.translateToString(true)).some(line => line === marker);
        }, 'Reconnected terminal did not render actual command output');
        await assertSurface();
      }
      return;
    }
    if (focusReconnect) assert(useFocusStore.getState().setTarget(original.sessionId), 'Cannot select the actual Focus target');
    const projectRoot = await readTerminalCurrentDirectory(live()!);
    assert(projectRoot, 'Missing actual terminal project directory');
    await invokeCreateAgentRuntimeSession({ sessionId: agentId, taskId: `task-${crypto.randomUUID()}`,
      goal: 'Verify terminal reconnect preserves this conversation', executionSurface: 'boundTerminal',
      permissionMode: 'operator', target: { kind: sshFixture ? 'remote' : 'local', targetId: `terminal-${original.sessionId}`, sessionId: original.sessionId,
        ...(sshFixture ? { host: profile.host, port: profile.port, username: profile.username,
          profileId: profile.id, rootPath: projectRoot } : { cwd: projectRoot }) } });
    created = true;
    if (focusReconnect) useFocusStore.getState().setConversation(agentId);
    flushSync(() => root.render(<NativeWorkspace panel />));
    await eventually(() => agent?.view?.summary.id === agentId, 'Native Agent did not restore its original conversation');
    const readProject = async () => {
      if (!sshFixture) {
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
      await eventually(() => Boolean(live()?.promptReady), 'Replacement shell did not reach its prompt');
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const replacementController = terminalRegistry.get(replacement);
      const replacementHost = document.querySelector(`[data-terminal-measure-session="${replacement}"]`);
      assert(replacementController && replacementHost?.isConnected
        && replacementHost.contains(replacementController.container)
        && replacementController.terminal.element?.isConnected,
      'Reconnected terminal lost its mounted xterm surface');
      const screen = replacementController.terminal.element.querySelector('.xterm-screen')?.getBoundingClientRect();
      assert(screen && screen.width > 0 && screen.height > 0, 'Reconnected xterm surface has no visible dimensions');
      assert(replacement !== previous, 'Reconnect did not create a real replacement PTY');
      if (focusReconnect) assert(useFocusStore.getState().targetSessionId === replacement,
        'Focus kept the removed transport ID after the terminal reconnected');
      assert(live()!.brokerReplacedSessionIds?.includes(previous), 'Real broker rollover lost verified ancestry');
      await eventually(() => agent?.view?.snapshot.value.header.target?.sessionId === replacement,
        () => `Agent did not rebind to native replacement: ${JSON.stringify({
          error: agent?.composer.lastError?.message, busy: agent?.terminalReconnectBusy,
          target: agent?.view?.snapshot.value.header.target?.sessionId, replacement,
          status: agent?.view?.status, recovery: agent?.view?.snapshot.value.recovery,
          autoEligible: canContinueOnReconnectedTerminal(agent?.view?.snapshot.value, live()),
          verifyEligible: canVerifyTerminalContinuation(agent?.view?.snapshot.value, live()),
        })}`);
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
    const selectedBeforeUnrelated = live()!.sessionId;
    if (!focusReconnect) {
      flushSync(() => {
        useTerminalStore.getState().addSession(unrelated);
        useTerminalStore.getState().setActiveSession(selectedBeforeUnrelated);
      });
    }
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
    await eventually(() => Boolean(useTerminalStore.getState().sessions.find(item => item.sessionId === unrelated.sessionId)?.promptReady),
      'Unrelated native PTY did not reach a trusted prompt');
    let rejected = '';
    try { await invokeReconnectAgentTerminal({ sessionId: agentId, previousSessionId: live()!.sessionId, terminalSessionId: unrelated.sessionId }); }
    catch (error) { rejected = String(error); }
    assert(rejected.includes(sshFixture ? 'TERMINAL_RECONNECT_UNVERIFIED' : 'TERMINAL_RECONNECT_SOURCE_ACTIVE'),
      `Backend did not enforce the original login and live-source gate: ${rejected}`);
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
    // Startup restoration runs only in an empty workspace. Close the extra
    // live tab before exercising that separate path.
    await invokeCloseSession(unrelated.sessionId);
    flushSync(() => useTerminalStore.getState().removeSession(unrelated.sessionId));

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
    assert(agent!.continueOnReconnectedTerminal, 'Restored transport did not offer explicit verification');
    assert(canVerifyTerminalContinuation(agent!.view!.snapshot.value, live()), 'Same-login restore was not eligible for verification');
    assert(!canContinueOnReconnectedTerminal(agent!.view!.snapshot.value, live()), 'Lost ancestry enabled automatic rebinding');
    assert(!agent!.composer.lastError, 'Restored transport attempted an invalid automatic rebind');
    const restoredEvents = await invokeGetCommittedAgentRuntimeEvents({ sessionId: agentId, limit: 100 });
    assert(restoredEvents.events.filter(event => event.type === 'session/terminal_reconnected').length === expectedReconnects,
      'Restoring workspace history rebound the old conversation');
    await eventually(() => Boolean(live()?.promptReady), 'Restored shell did not reach its integrated prompt');
    assert(!agent!.historicalContinuationAvailable, 'Restore could bypass verification by creating a linked Session');
    const panel = document.querySelector<HTMLElement>('[data-agent-panel]')!;
    const findAction = (label: string) => [...panel.querySelectorAll('button')]
      .find(item => item.innerText.trim() === label);
    for (const locale of ['zh-CN', 'en-US'] as const) {
      await initI18n(locale);
      flushSync(() => useAppStore.setState({ locale }));
      await new Promise(resolve => requestAnimationFrame(resolve));
      const button = findAction(t('ai.workspace.continueOnReconnectedTerminal'));
      assert(button, `Missing readable restore action in ${locale}`);
      button.focus();
      assert(document.activeElement === button, 'Restore action was not keyboard focusable');
      for (const width of [640, 340]) {
        panel.style.width = `${width}px`;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const notice = button.closest<HTMLElement>('[data-slot="alert"]')!;
        assert(notice.getAttribute('data-size') === 'sm', 'Restore replaced the shared compact Alert');
        assert(button.getBoundingClientRect().right <= notice.getBoundingClientRect().right + 1,
          `Restore action overflowed its notice in ${locale} at ${width}px`);
        assert(button.getBoundingClientRect().height === 24, 'Restore changed the shared compact Button height');
        assert(!panel.textContent?.includes(locale === 'zh-CN' ? '右上角新建会话' : 'Use New conversation'),
          'Restore still required a new conversation');
      }
      panel.style.removeProperty('width');
    }
    const current = live()!.sessionId;
    await invokeResumeAgentRuntime({ sessionId: agentId });
    const queuedId = `paused-${crypto.randomUUID()}`;
    const queued = await invokeAgentRuntimeFollowup({ sessionId: agentId, messageId: queuedId,
      clientSubmissionId: queuedId, content: 'Verify the connection only after this paused input is reviewed.', paused: true });
    assert(queued.inbox.nextTurn.some(item => item.messageId === queuedId), 'Paused input was not durably admitted');
    let queueError = '';
    try { await invokeReconnectAgentTerminal({ sessionId: agentId, previousSessionId: closing.sessionId, terminalSessionId: current }); }
    catch (error) { queueError = String(error); }
    assert(queueError.includes('settled root Session'), `Verification bypassed pending input: ${queueError}`);
    assert(JSON.stringify(await invokeGetAgentRuntimeSession({ sessionId: agentId })) === JSON.stringify(queued),
      'Rejected pending-input verification changed the journal');
    await invokeMutateAgentRuntimeInbox({ sessionId: agentId, expectedRevision: queued.eventCount,
      clientOperationId: `remove-${queuedId}`, mutation: { type: 'remove', itemId: queuedId } });
    const beforeVerification = await invokeGetAgentRuntimeSession({ sessionId: agentId });
    const controller = terminalRegistry.get(current)!;
    assert(await controller.writeUserInput(powershell ? 'Start-Sleep -Seconds 5' : 'sleep 5')
      && await controller.writeUserInput('\r'),
      'Could not start a real command to verify the current terminal busy gate');
    const promptReady = async () => (await invokeGetTerminalBrokerSnapshot(current)).session?.promptReady;
    await eventually(async () => await promptReady() === false, 'Real command did not make the shell busy');
    flushSync(() => agent!.continueOnReconnectedTerminal!());
    assert(agent!.terminalReconnectBusy, 'Restore did not expose its pending state');
    const checking = findAction(t('ai.workspace.reconnectChecking'));
    assert(checking?.disabled, 'Restore action remained enabled during verification');
    await eventually(() => !agent!.terminalReconnectBusy && Boolean(agent!.composer.lastError),
      'Busy execution did not produce an actionable verification error');
    assert(agent!.composer.lastError!.message === t('ai.workspace.reconnectUnsettled'), 'Busy execution did not report unsettled work');
    assert(agent!.readOnlySession && agent!.view!.snapshot.value.header.target?.sessionId === closing.sessionId,
      'Failed verification changed the original binding');
    assert(agent!.composer.draft === 'Keep this draft through terminal reconnect', 'Failed verification discarded the draft');
    assert(JSON.stringify(await invokeGetAgentRuntimeSession({ sessionId: agentId })) === JSON.stringify(beforeVerification),
      'Failed verification mutated the persisted conversation');
    await eventually(async () => await promptReady() === true, 'Real verification command did not finish');
    const verifyButton = findAction(t('ai.workspace.continueOnReconnectedTerminal'));
    assert(verifyButton, 'Failed verification did not retain a retry action');
    verifyButton.click();
    await eventually(() => agent?.view?.snapshot.value.header.target?.sessionId === current && !agent.terminalReconnectBusy,
      'Explicit verification did not restore the original conversation');
    assert(agent!.view!.summary.id === agentId && !agent!.readOnlySession, 'Verified restore replaced the conversation or left it read-only');
    assert(!agent!.composer.lastError, 'Successful retry retained the old verification error');
    assert(agent!.composer.draft === 'Keep this draft through terminal reconnect', 'Verified restore discarded the draft');
    const rebound = await invokeGetAgentRuntimeSession({ sessionId: agentId });
    assert(rebound.header.taskId === before.header.taskId && rebound.header.goal === before.header.goal, 'Explicit restore replaced the task');
    assert(rebound.header.permissionMode === 'requestApproval', 'Explicit restore retained prior authorization');
    const verifiedEvents = await invokeGetCommittedAgentRuntimeEvents({ sessionId: agentId, limit: 100 });
    assert(verifiedEvents.events.filter(event => event.type === 'session/terminal_reconnected').length === expectedReconnects + 1,
      'Explicit verification did not record exactly one durable rebind');
    assert(!verifiedEvents.events.some(event => event.type === 'turn/start' || event.type === 'request/start' || event.type === 'tool/execution'),
      'Verification replayed old work or started a model turn');
    await readProject();
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
    if (savedProfile) {
      await invokeDeleteProfilePassword(profile.id);
      await invokeRemoveProfile(profile.id);
      useProfileStore.setState(state => ({ profiles: state.profiles.filter(item => item.id !== profile.id) }));
    }
    if (trustedFixtureHost) await invokeRemoveKnownHost(profile.host, profile.port);
  }
}
const token = new URL(location.href).searchParams.get('token');
void verify().then(() => ({ ok: true }), (error: unknown) => ({ ok: false,
  error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error),
})).then(result => fetch(`/__agent-stream-result/${token}`, { method: 'POST', body: JSON.stringify(result) }));
