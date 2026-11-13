import { getCurrentWindow } from '@tauri-apps/api/window';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { terminalRegistry, type TerminalController } from '../registry/terminal-registry';
import { TerminalControllerLayer } from '../terminal-controller-layer';
import { agentTerminalLeaseState } from '../agent-terminal-lease-state';
import { terminalInputReadiness } from '../terminal-input-readiness';
import { useTerminalStore } from '@/stores/terminalStore';
import { useAppStore } from '@/stores/appStore';
import { initI18n } from '@/locales';
import { nativeP2Password } from './native-input-p2-credential';
import { readNativeAcceptanceResult } from './native-result-artifact';
import {
  invokeCheckHostKey, invokeTrustHost, invokeCloseSession, invokeCreateSession, invokeWriteSession,
  invokeAddProfile,
  invokeCreateAgentRuntimeSession, invokeRunTerminalAcceptanceCommand, invokeDecideTerminalAcceptanceCommand,
  invokeGetTerminalBrokerSnapshot, invokeGetTerminalSubmissionRecovery, invokeGetAgentRuntimeEvents,
  invokeInspectAgentRuntimeRecovery, invokeResumeAgentRuntimeRecovery, invokeListAiRoutes, invokeCancelAgentRuntime, invokeGetAgentRuntimeSession,
  invokeInterruptAgentRuntime,
  invokeSpawnAgentRuntimeSubagent, invokeCancelAgentRuntimeChild, invokeGetAgentTerminalOwner,
  listenToSshClosed, listenToSshData, type TerminalAcceptanceSourceKind,
} from '@/lib/ipc/tauri';
import type { SessionSummary, TerminalBrokerSessionSnapshot, TerminalSubmissionIntent } from '@/types';
import '@/styles/base.css';

type Identity = TerminalSubmissionIntent['identity'];
type Cut = { cut: string; pid: number; nonce: string; identity: Identity; trace: string };
type Trace = { event: string; sequence: number; details: {
  sessionId?: string; identity?: Identity; kind?: string; requestId?: string; hex?: string; incompleteHex?: string; reason?: string;
  path?: string; uploadedMode?: string; uploadSha256?: string; readbackSha256?: string; readbackLength?: number;
} };
type Effect = { text: string | null; sha256: string | null };

const parameters = new URL(location.href).searchParams;
const token = parameters.get('token');
const scenario = parameters.get('zleSshRecovery');
const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const bash = parameters.get('bashSsh') === 'true';
const username = bash ? 'native53' : 'nativeZle';
const profile = bash ? 'gnu-bash-5.3-readline-8.3.6-linux-aarch64-glibc-2.36-native' : 'zsh-5.9-zle-5.9-linux-aarch64-glibc-2.36-native';

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function waitFor<T>(read: () => T | Promise<T>, message: string, timeoutMs = 12000): Promise<NonNullable<T>> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const result = await read();
    if (result) return result;
    assert(performance.now() < deadline, message);
    await pause(20);
  }
}
async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  assert(response.ok, `${url} returned ${response.status}: ${await response.clone().text()}`);
  return response.json() as Promise<T>;
}
async function report(value: unknown) {
  const response = await fetch(`/__agent-stream-result/${token}`, { method: 'POST', body: JSON.stringify(value) });
  assert(response.ok, 'Actual SSH evidence could not be retained');
}
const witness = <T,>(route: string, method = 'GET') => json<T>(`/__zle-ssh-recovery/${token}/${route}`, { method });
const effect = () => witness<Effect>('effect');
const trace = () => witness<Trace[]>('trace');
const cutUrl = (settled = false) => `/__native-mac-submission-${settled ? 'settled-cut' : 'cut'}/${token}`;
const waitCut = (settled = false) => waitFor(async () => (await json<{ cut: Cut | null }>(cutUrl(settled))).cut, 'Actual submission cut missing');
const release = (cut: Cut, settled = false) => json<{ released: true }>(cutUrl(settled), {
  method: 'POST', body: JSON.stringify({ pid: cut.pid, nonce: cut.nonce }),
});
const snapshot = async (id: string) => (await invokeGetTerminalBrokerSnapshot(id)).session;
const sameIdentity = (left: Identity | undefined, right: Identity) => left !== undefined
  && (Object.keys(right) as (keyof Identity)[]).every(key => left[key] === right[key]);
const asHex = (value: string) => Array.from(new TextEncoder().encode(value), byte => byte.toString(16).padStart(2, '0')).join('');
const wire = (events: Trace[], session: SessionSummary) => events
  .filter(event => event.event === 'ssh-pty-read' && event.details.sessionId === session.sessionId).map(event => event.details.hex).join('');

async function verify() {
  const port = Number(parameters.get('nativeP2SshPort')), fingerprint = parameters.get('hostFingerprint');
  assert(token && scenario && port > 1024 && fingerprint, 'Exact owned SSH case required');
  const beforeKey = scenario.startsWith('before-key-') || scenario === 'crash-before-key';
  const explicitControl = /^before-key-(cancel|stop|takeover)$/.exec(scenario)?.[1];
  const controlledCut = /^(input-in-progress|input-complete|intent|armed|after-accept)-(stop|cancel|takeover)$/.exec(scenario);
  const disconnect = scenario.endsWith('-disconnect'), controlEof = scenario.endsWith('-control-eof');
  const crash = scenario === 'crash-before-key' || scenario === 'crash-after-key';
  const unapprovedShell = scenario === 'raw-unapproved-shell';
  const resourceMismatch = scenario === 'raw-resource-mismatch';
  const rawAdmission = scenario === 'raw-no-sftp' || unapprovedShell || resourceMismatch;
  await initI18n('en-US');
  await getCurrentWindow().show();
  const routes = await invokeListAiRoutes();
  assert(!routes.defaultSelection && routes.routes.length === 0, 'Isolated route store must be empty');
  const key = await invokeCheckHostKey('127.0.0.1', port);
  assert((key.status === 'notFound' || scenario === 'crash-restart' && key.status === 'match') && key.fingerprint === fingerprint,
    'Fixture host key or isolated known hosts differs');
  if (key.status === 'notFound') await invokeTrustHost('127.0.0.1', port, fingerprint);
  const password = await nativeP2Password();
  const host = document.getElementById('root')!;
  host.style.cssText = 'width:100vw;height:100vh';
  const layerHost = document.createElement('div');
  document.body.append(layerHost);
  const layer = createRoot(layerHost);
  useAppStore.setState({ activeSection: 'terminal', restoreWorkspace: false, terminalAutoReconnect: false });
  flushSync(() => layer.render(createElement(TerminalControllerLayer)));
  const records: Record<string, unknown> = { case: scenario, fingerprint };
  const sessions: SessionSummary[] = [], stops: (() => void)[] = [];
  const closed = new Set<string>();
  const decoded: Record<string, string> = {};
  const timeline: Record<string, unknown>[] = [];
  const pendingDisplay: { sessionId: string; source: string; data: string }[] = [];
  let controller: TerminalController | undefined;
  let originalFailure: unknown;

  async function open(previous?: SessionSummary, raw = false, independent = false) {
    const session = await invokeCreateSession({ name: bash ? 'Bash SSH lifecycle' : 'ZLE SSH recovery', host: '127.0.0.1', port,
      username, authMethod: 'password', password, terminalCols: 100, terminalRows: 30,
      replacesSessionId: previous?.sessionId }, raw && !rawAdmission ? null : 'shellspan.native-input');
    sessions.push(session);
    assert(session.ptyInfo?.transportKind === 'sshPty' && session.ptyInfo.inputMode === (raw ? 'raw' : 'native-inline')
      && session.terminalSessionId && session.terminalGeneration, 'Expected actual SSH PTY and negotiated mode');
    if (previous) assert(session.terminalSessionId === previous.terminalSessionId
      && session.terminalGeneration === previous.terminalGeneration! + 1, 'Reconnect did not advance the exact logical terminal generation');
    stops.push(await listenToSshData(session.sessionId, ({ payload }) => {
      decoded[session.sessionId] = (decoded[session.sessionId] ?? '') + payload;
      timeline.push({ stage: 'decoded', sessionId: session.sessionId, at: Date.now(), data: payload });
    }));
    stops.push(await listenToSshClosed(session.sessionId, ({ payload }) => {
      closed.add(session.sessionId);
      timeline.push({ stage: 'transport-closed', sessionId: session.sessionId, at: Date.now(), payload });
    }));
    if (independent) {
      useTerminalStore.getState().addSession(session);
    } else if (!previous) {
      useTerminalStore.getState().addSession(session);
      controller = terminalRegistry.create(session.sessionId, (id, event) => useTerminalStore.getState().setStatus(id, event),
        (id, event) => useTerminalStore.getState().setClosed(id, event),
        id => useTerminalStore.getState().sessions.find(item => item.sessionId === id)?.status ?? 'connecting', () => {}, session.ptyInfo);
      stops.push(controller.subscribeLifecycle(event => timeline.push({ stage: event.type, at: Date.now(), event })));
      stops.push(controller.subscribeDisplayOutput(output => pendingDisplay.push({ sessionId: controller!.sessionId, ...output })));
      stops.push(controller.subscribeDisplayOutputParsed(output => {
        const written = pendingDisplay.shift();
        timeline.push({ stage: 'parsed', sessionId: written?.sessionId, at: Date.now(),
          matchesWrite: written?.source === output.source && written.data === output.data, ...output });
      }));
      controller.attach(host);
    } else {
      terminalRegistry.rebindSession(previous.sessionId, session.sessionId, session.ptyInfo);
      useTerminalStore.getState().reconnectSession(previous.sessionId, session);
    }
    if (!independent) {
      assert(controller?.sessionId === session.sessionId, 'Actual production controller did not rebind');
      await controller.whenOutputReady();
    }
    const broker = await waitFor(async () => {
      const current = await snapshot(session.sessionId);
      const connected = useTerminalStore.getState().sessions.some(item => item.sessionId === session.sessionId && item.status === 'connected');
      return current?.open && connected && !terminalInputReadiness.isPreparing(session.sessionId)
        && (raw || current.promptReady && current.nativePeerProfile?.verifiedProfileId === profile) ? current : undefined;
    }, 'SSH successor or pinned native peer never became ready');
    timeline.push({ stage: 'ready', at: Date.now(), session, broker });
    if (!raw) {
      const loaded = await witness<{ profileId: string; files: { path: string; mode: string; length: number; sha256: string }[] }>('loaded-resources', 'POST');
      assert(loaded.profileId === profile, 'Loaded remote resource and Broker profile differ');
      const readbacks = (await trace()).filter(entry => entry.event === 'ssh-sftp-verified-readback'
        && loaded.files.some(file => file.path === entry.details.path));
      assert(readbacks.length === 3 && loaded.files.every(file => readbacks.some(({ details }) => details.path === file.path
        && details.uploadedMode === file.mode && details.readbackLength === file.length
        && details.readbackSha256 === file.sha256 && details.uploadSha256 === file.sha256)),
      'App SFTP upload/readback differs from actual loaded files');
      timeline.push({ stage: 'loaded-resources', at: Date.now(), sessionId: session.sessionId, loaded, readbacks });
    }
    return session;
  }

  async function verifyOrdinary(first: SessionSummary) {
    const terminal = controller!.terminal;
    const broker = await snapshot(first.sessionId);
    if (rawAdmission) assert(broker?.inputMode === 'raw' && broker.integrationState !== 'ready'
      && !broker.nativePeerProfile && !broker.inputObservation?.activeCommand, 'Raw admission case presented a native execution profile');
    await send("printf '%s%s\\n' SSH_EDIT_ GOODX\x7f\r");
    await waitFor(() => screen().includes('SSH_EDIT_GOOD'), 'Actual shell did not process ordinary editing');
    await send("printf '%s%s\\n' SSH_SIGNAL_ READY; /bin/sleep 30\r");
    await waitFor(() => screen().includes('SSH_SIGNAL_READY'), 'Actual foreground process did not start');
    await send('\x03');
    await send("printf 'SSH_SIGNAL_STATUS=%s\\n' \"$?\"\r");
    await waitFor(() => screen().includes('SSH_SIGNAL_STATUS=130'), 'Actual SIGINT did not stop the foreground process');
    await send("/usr/bin/top -d 1; printf '%s%s\\n' SSH_TUI_ EXITED\r");
    const active = () => Array.from({ length: terminal.buffer.active.length }, (_, index) => terminal.buffer.active.getLine(index)?.translateToString(true) ?? '').join('\n');
    const tui = await waitFor(() => /Tasks:\s+\d+/.test(active()) && active(), 'Actual Debian top did not render its interactive view');
    const bufferType = terminal.buffer.active.type;
    Object.assign(records, { broker, signalExitStatus: 130, tui, bufferType });
    await send('q');
    await waitFor(() => terminal.buffer.active.type === 'normal' && screen().includes('SSH_TUI_EXITED'), 'Actual TUI did not return to its parent Shell');
    if (scenario === 'ordinary-input') await waitFor(async () => (await snapshot(first.sessionId))?.promptReady, 'Actual native prompt did not recover after TUI');
    await marker('SSH_TUI_RETURNED');
    if (unapprovedShell || resourceMismatch) {
      const before = await snapshot(first.sessionId);
      const declined = await invocation(first, 'effect');
      const events = await declined.events();
      const refusal = events.find(event => event.type === 'tool/result' && event.data.callId === declined.callId);
      const after = await snapshot(first.sessionId);
      assert(!declined.approval && refusal?.type === 'tool/result' && refusal.data.status !== 'completed'
        && refusal.data.summary.startsWith('TERMINAL_VISIBLE_COMMAND_UNAVAILABLE:')
        && !events.some(event => event.type === 'tool/execution') && before?.nextInputSequence === after?.nextInputSequence
        && !after?.inputObservation?.activeCommand && (await effect()).text === null,
      'Raw SSH did not refuse the actual bound tool before input');
      await invokeCancelAgentRuntime({ sessionId: declined.id });
      await marker('SSH_RAW_AFTER_REFUSAL');
      const eventsOnWire = await trace();
      const expected = resourceMismatch ? 'TERMINAL_NATIVE_PROFILE_ARTIFACT_MISMATCH' : 'TERMINAL_NATIVE_PROFILE_UNSUPPORTED';
      assert(eventsOnWire.some(entry => entry.event === 'ssh-native-admission-refused'
        && entry.details.sessionId === first.sessionId && entry.details.reason === expected),
      'Actual profile refusal was not recorded for the owned connection');
      if (resourceMismatch) assert(!eventsOnWire.some(entry => entry.event === 'ssh-sftp-verified-readback'),
        'The mismatched resource reached a remote SFTP upload');
      Object.assign(records, { before, after, refusal, agentEvents: events });
    }
    const finalEffect = await effect();
    assert(finalEffect.text === null && !(await trace()).some(row => row.event === 'accept-key-write-returned'), 'Ordinary SSH input reached the Agent submit path');
    Object.assign(records, { broker, signalExitStatus: 130, tui, bufferType, finalEffect, finalScreen: screen() });
  }

  function screen() {
    const buffer = controller!.terminal.buffer.normal;
    return Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)?.translateToString(true) ?? '').join('\n');
  }
  async function drain() { await new Promise<void>(done => controller!.terminal.write('', done)); }
  async function send(source: string) {
    const accepted = await controller!.writeUserInput(source);
    timeline.push({ stage: 'user-input', at: Date.now(), sessionId: controller!.sessionId, accepted, source });
    assert(accepted, 'Actual registry user input blocked');
  }
  async function marker(name: string) {
    const split = name.lastIndexOf('_') + 1;
    await send(`printf '%s%s\\n' ${name.slice(0, split)} ${name.slice(split)}\r`);
    await waitFor(() => screen().includes(name), `Actual successor output ${name} missing`);
  }
  async function staleWrite(old: SessionSummary) {
    const refused = await invokeWriteSession(old.sessionId, "printf '%s%s\\n' SSH_STALE_ INPUT\r").then(() => false, () => true);
    timeline.push({ stage: 'old-input-refused', at: Date.now(), sessionId: old.sessionId, refused });
    assert(refused, 'Retired transport admitted old input');
  }
  function gate(value: TerminalBrokerSessionSnapshot | undefined) {
    return { id: value?.transportSessionId, generation: value?.terminalGeneration, open: value?.open,
      ready: value?.promptReady, mode: value?.inputMode, integration: value?.integrationState,
      recovery: value?.inputObservation?.nativeRecoveryRequired, active: value?.inputObservation?.activeCommand };
  }

  async function verifyTail(old: SessionSummary) {
    const partialOsc = '\u001b]1337;SetUserVar=ShellSpanNativeInput=MQ';
    await send("printf '%s%s\\n' SSH_OLD_ PREFIX; printf '\\033]1337;SetUserVar=ShellSpanNativeInput=MQ==\\007'; "
      + "printf '\\033]1337;SetUserVar=ShellSpanNativeInput=MQ'; "
      + "for attempt in {1..400}; do [[ -e $HOME/phase3-ssh-tail-release ]] && break; sleep .1; done; "
      + "[[ -e $HOME/phase3-ssh-tail-release ]] && { printf '==\\007'; printf '%s%s\\n' SSH_STALE_ TAIL; }; exit\r");
    await waitFor(() => decoded[old.sessionId]?.endsWith(partialOsc) && screen().includes('SSH_OLD_PREFIX'), 'Old SSH PTY half OSC missing');
    await drain();
    const oldParsed = timeline.filter(entry => entry.stage === 'parsed' && entry.source === 'session' && entry.sessionId === old.sessionId);
    assert(oldParsed.map(entry => entry.data).join('').endsWith(partialOsc), 'Old half OSC was not parsed in the old generation');
    const next = await open(old);
    await marker('SSH_NEW_NATIVE');
    await waitFor(async () => (await snapshot(next.sessionId))?.promptReady, 'Successor did not return to its prompt');
    await drain();
    const before = gate(await snapshot(next.sessionId)), text = screen();
    const display = controller!.terminal.options.reflowCursorLine;
    const boundary = await trace();
    await staleWrite(old);
    records.tailRelease = await witness('release-tail', 'POST');
    await waitFor(() => closed.has(old.sessionId) && decoded[old.sessionId]?.includes('SSH_STALE_TAIL'), 'Retired real SSH PTY did not deliver and close its tail');
    await drain();
    const events = await trace();
    const late = events.filter(event => event.sequence > (boundary[boundary.length - 1]?.sequence ?? 0));
    assert(wire(boundary, old).endsWith(asHex(partialOsc)) && wire(late, old).includes(asHex('==\u0007SSH_STALE_TAIL')),
      'Actual raw old SSH tail was not read after successor output');
    const parsedBoundary = timeline.findIndex(entry => entry.stage === 'parsed' && entry.source === 'local' && entry.data === '\u001b\\');
    const successorOutput = timeline.findIndex(entry => entry.stage === 'parsed' && entry.source === 'session'
      && entry.sessionId === next.sessionId && typeof entry.data === 'string' && entry.data.includes('SSH_NEW_NATIVE'));
    assert(parsedBoundary > timeline.indexOf(oldParsed[oldParsed.length - 1]) && successorOutput > parsedBoundary
      && timeline.filter(entry => entry.stage === 'parsed').every(entry => entry.matchesWrite)
      && controller!.terminal.options.reflowCursorLine === display
      && screen() === text && text.includes('SSH_OLD_PREFIX') && !text.includes('SSH_STALE_TAIL') && !text.includes('SSH_STALE_INPUT')
      && JSON.stringify(gate(await snapshot(next.sessionId))) === JSON.stringify(before), 'Old OSC or PTY tail changed successor display/input/recovery');
    records.retiredTail = { before, parsedBoundary, successorOutput, late, text };

    await send("printf '%s%s\\n' SSH_UTF8_ PREFIX; printf '\\342\\202'; exec /bin/sleep .3\r");
    await waitFor(() => closed.has(next.sessionId), 'SSH half UTF-8 producer did not close');
    await drain();
    const utf8 = await trace();
    const utf8Drain = utf8.find(event => event.event === 'ssh-decoder-drain' && event.details.sessionId === next.sessionId);
    const utf8Reads = utf8.filter(event => event.event === 'ssh-pty-read' && event.details.sessionId === next.sessionId);
    const utf8LastRead = utf8Reads[utf8Reads.length - 1];
    const prefix = decoded[next.sessionId] ?? '';
    const decodedReplacement = timeline.findIndex(entry => entry.stage === 'decoded' && entry.sessionId === next.sessionId
      && typeof entry.data === 'string' && entry.data.includes('\uFFFD'));
    const nextClose = timeline.findIndex(entry => entry.stage === 'transport-closed' && entry.sessionId === next.sessionId);
    assert(wire(utf8, next).endsWith('e282') && utf8Drain?.details.incompleteHex === 'e282'
      && utf8LastRead && utf8LastRead.sequence < utf8Drain.sequence
      && prefix.includes('SSH_UTF8_PREFIX') && prefix.endsWith('\uFFFD')
      && decodedReplacement >= 0 && decodedReplacement < nextClose,
    'SSH UTF-8 decoder did not flush the actual incomplete bytes before close');
    const raw = await open(next, true);
    await marker('SSH_NEW_RAW');
    assert(controller!.inputMode === 'raw' && controller!.terminal.options.reflowCursorLine === false, 'Raw rebind retained private display mode');
    const final = await open(raw);
    await marker('SSH_FINAL_NATIVE');
    await staleWrite(raw);
    assert(['SSH_OLD_PREFIX', 'SSH_NEW_NATIVE', 'SSH_UTF8_PREFIX', 'SSH_NEW_RAW', 'SSH_FINAL_NATIVE'].every(value => screen().includes(value))
      && !screen().includes('SSH_STALE_TAIL') && !(await snapshot(final.sessionId))?.inputObservation?.nativeRecoveryRequired,
    'Final native generation lost old history or inherited stale recovery');
    records.utf8Tail = { utf8Drain, utf8LastRead, decoded: prefix, finalScreen: screen() };
    assert((await effect()).text === null, 'Tail-only case wrote an Agent effect');
  }

  async function verifyDisplay(first: SessionSummary) {
    const term = controller!.terminal;
    const publicApis = { select: term.getSelection, open: term.open, line: term.buffer.normal.getLine };
    const soft = `SSH_SOFT_${'7'.padStart(140, '0')}_END`, hard = 'SSH_HARD_A\nSSH_HARD_B';
    async function resize(width: number, label: string) {
      host.style.width = `${width}px`;
      host.style.height = '520px';
      controller!.fit();
      const sessionId = controller!.sessionId, cols = term.cols, rows = term.rows;
      await waitFor(async () => {
        const geometry = (await snapshot(sessionId))?.geometry;
        return geometry?.columns === cols && geometry.rows === rows;
      }, `Actual SSH PTY dimensions did not follow ${label} layout`);
      await drain();
      timeline.push({ stage: 'render-resize', at: Date.now(), sessionId, cols, rows, label });
      return { cols, rows };
    }
    async function ordinarySelection(label: string) {
      await drain();
      term.selectAll();
      const copied = term.getSelection().replace(/\r\n/g, '\n');
      term.clearSelection();
      assert(copied.includes(soft) && copied.includes(hard), `Soft/hard line copy diverged in ${label}`);
      const found = controller!.searchAddon.findNext(soft);
      assert(found && term.getSelection() === soft, `Search did not select the exact logical soft line in ${label}`);
      term.clearSelection();
      return { label, softCopy: true, hardCopy: true, exactSearch: found };
    }
    const narrow = await resize(390, 'narrow');
    const background = "(for attempt in {1..400}; do [[ -e $HOME/phase3-ssh-tail-release ]] && break; sleep .1; done; [[ -e $HOME/phase3-ssh-tail-release ]] && printf '%s%s\\n' SSH_BACKGROUND_ END) &";
    await send("printf '%s%0140d%s\\n' SSH_SOFT_ 7 _END; printf '%s%s\\n' SSH_HARD_ A SSH_HARD_ B; for i in {1..65}; do printf 'SSH_HISTORY_%03d\\n' \"$i\"; done; " + background + '\r');
    await waitFor(() => screen().includes('SSH_HISTORY_065'), 'Real SSH display and history sample missing');
    const selection = [await ordinarySelection('narrow')];
    assert(term.buffer.normal.baseY > 0 && narrow.cols < 60, 'Narrow sample did not create a historical viewport');
    term.scrollToTop();
    const wide = await resize(1080, 'wide-parked');
    assert(wide.cols > narrow.cols && term.buffer.normal.viewportY < term.buffer.normal.baseY, 'Wide reflow lost the parked history viewport');
    selection.push(await ordinarySelection('wide'));
    term.scrollToBottom();
    await witness('release-tail', 'POST');
    await waitFor(() => screen().includes('SSH_BACKGROUND_END'), 'Real background PTY output missing');
    await drain();
    assert(term.buffer.normal.viewportY === term.buffer.normal.baseY, 'Actual background output lost bottom-following viewport');
    await invokeCloseSession(first.sessionId);
    await waitFor(() => closed.has(first.sessionId), 'Actual display PTY close missing');
    const successor = await open(first);
    await marker('SSH_DISPLAY_SUCCESSOR');
    selection.push(await ordinarySelection('rebound'));
    assert(term.getSelection === publicApis.select && term.open === publicApis.open && term.buffer.normal.getLine === publicApis.line
      && !(await snapshot(successor.sessionId))?.inputObservation?.activeCommand && (await effect()).text === null,
    'Display case changed the public API or created execution authority');
    Object.assign(records, { narrow, wide, soft, hard, selection, finalEffect: await effect(), finalScreen: screen(),
      focus: { documentHasFocus: document.hasFocus(), terminalHasFocus: term.element?.contains(document.activeElement) ?? false,
        programmaticInput: true, humanReceipt: false } });
  }

  async function createOwnedAgent(old: SessionSummary, tools = ['run_terminal_command'], profileId?: string) {
    const id = `phase3-submission-${crypto.randomUUID()}`;
    const target = { kind: 'remote' as const, targetId: `terminal-${old.sessionId}`, sessionId: old.sessionId,
      host: '127.0.0.1', port, username, ...(profileId ? { profileId } : {}) };
    const created = await invokeCreateAgentRuntimeSession({ sessionId: id, taskId: id, target, executionSurface: 'boundTerminal',
      permissionMode: 'requestApproval', goal: 'Execute the isolated SSH terminal acceptance request without a model',
      capabilityScope: { toolNames: tools, effects: ['stateChange', 'readOnly', 'externalSideEffect',
        ...(tools.includes('read_file') ? ['sensitiveRead' as const] : [])], targetIds: [target.targetId] } });
    assert(!created.header.modelSelection, 'Unexpected model selection');
    return id;
  }

  async function requestTool(id: string, kind: TerminalAcceptanceSourceKind, argument?: string) {
    const callId = crypto.randomUUID();
    const prepared = await invokeRunTerminalAcceptanceCommand(id, callId, kind, argument);
    assert(prepared.modelAvailability === 'MODEL_SELECTION_REQUIRED', 'Native tool request had an attached model');
    const events = () => invokeGetAgentRuntimeEvents({ sessionId: id, limit: 500 }).then(result => result.events);
    const approvals = (await events()).filter(event => event.type === 'tool/approval' && event.data.status === 'requested' && event.data.callId === callId);
    if (prepared.settlement !== 'Waiting') {
      assert(approvals.length === 0, 'A rejected request entered approval');
      return { id, callId, prepared, events, approval: null };
    }
    const event = approvals[0];
    assert(approvals.length === 1 && event.type === 'tool/approval' && event.turnId && event.stepId
      && event.data.approvalId && event.data.callId === callId, 'Exact production approval identity missing');
    const approval = { sessionId: id, turnId: event.turnId, stepId: event.stepId, requestId: event.data.requestId, callId, approvalId: event.data.approvalId };
    return { id, callId, prepared, events, approval };
  }

  async function invocation(old: SessionSummary, kind: TerminalAcceptanceSourceKind) {
    return requestTool(await createOwnedAgent(old), kind);
  }

  async function finishTool(request: Awaited<ReturnType<typeof requestTool>>, approve = true) {
    if (request.approval) await invokeDecideTerminalAcceptanceCommand(request.approval, approve);
    const events = await request.events();
    const result = events.find(event => event.type === 'tool/result' && event.data.callId === request.callId);
    assert(result?.type === 'tool/result', 'Actual tool result missing');
    const resolved = await readNativeAcceptanceResult(request.id, result.data.data);
    return { request: request.prepared, approval: request.approval, result, resolved, events };
  }

  async function verifyJobs(first: SessionSummary) {
    const id = await createOwnedAgent(first, ['run_terminal_command', 'wait_process', 'kill_process']);
    assert((await effect()).text === null, 'Fresh job fixture already has a remote effect');
    const launch = await requestTool(id, 'job-launch');
    assert(launch.approval && (await effect()).text === null, 'Background launch bypassed normal approval');
    const started = await finishTool(launch);
    Object.assign(records, { id, started });
    const data = started.resolved.data;
    assert(started.result.data.status === 'completed' && typeof data.processHandle === 'string'
      && /^job-[a-f0-9]{32}$/.test(data.processHandle) && data.outputScope === 'sharedTerminal'
      && data.terminalSessionId === first.terminalSessionId && data.terminalGeneration === first.terminalGeneration,
    'Background result was not the original native terminal job');
    const handle = data.processHandle;
    const binding = (value: unknown) => {
      assert(value && typeof value === 'object', 'Native job binding missing');
      const job = value as Record<string, unknown>;
      return ['processHandle', 'terminalSessionId', 'terminalGeneration', 'transportSessionId', 'ownerTargetId', 'agentSessionId', 'taskId', 'operationId']
        .map(key => { assert(key in job, `Native job binding lacks ${key}`); return job[key]; });
    };
    const original = binding(data.job);
    const watches = [];
    for (let i = 0; i < 3; i++) {
      const current = await finishTool(await requestTool(id, 'job-wait', handle));
      const item = current.resolved.data;
      watches.push(current);
      records.watches = watches;
      assert(current.result.data.status === 'completed' && item.outputScope === 'sharedTerminal' && item.stdout === '' && item.stderr === ''
        && JSON.stringify(binding(item.job)) === JSON.stringify(original), 'Actual wait changed the job identity or invented isolated output');
    }
    await waitFor(() => screen().includes('SSH_NATIVE_JOB_LIVE'), 'Actual background output did not reach the shared PTY');
    const stopped = await finishTool(await requestTool(id, 'job-stop', handle));
    records.stopped = stopped;
    const ending = stopped.resolved.data;
    const job = ending.job as { nativeActive?: boolean; controlLost?: boolean } | undefined;
    assert(stopped.result.data.status === 'completed' && ending.stopRequested === true
      && job?.nativeActive === false && job.controlLost === false && JSON.stringify(binding(job)) === JSON.stringify(original),
    'Actual stop did not confirm termination on the original job');
    await invokeCancelAgentRuntime({ sessionId: id });
    const finalEffect = await effect();
    const actual = await trace();
    const launchReceipts = actual.filter(event => event.event === 'ssh-receipt-read' && event.details.kind === 'submissionAccepted'
      && event.details.identity?.operationId === data.operationId);
    assert(launchReceipts.length === 1 && finalEffect.text === `${launch.callId}\n` && (await invokeGetTerminalSubmissionRecovery(id)).length === 0,
      'Native job launch was repeated or its durable intent was not resolved');
    Object.assign(records, { id, started, watches, stopped, finalEffect, launchReceipts });
  }

  async function verifyFileChain(first: SessionSummary) {
    const profileId = parameters.get('nativeP2Credential');
    assert(profileId && /^native-p2-secret-[a-f0-9-]{36}$/.test(profileId), 'Exact owned SSH profile credential missing');
    const now = Date.now();
    await invokeAddProfile({ id: profileId, name: 'Owned SSH scratch', host: '127.0.0.1', port, username, authMethod: 'password', createdAt: now, updatedAt: now });
    const id = await createOwnedAgent(first, ['write_file', 'read_file', 'run_terminal_command'], profileId);
    await send("mkdir -m 700 \"$HOME/phase3-parent\" && cd \"$HOME/phase3-parent\" && export PHASE3_PARENT=parent-env && phase3_parent_fn() { printf '%s' parent-function; }; printf '%s%s\\n' SSH_FILE_PARENT_ READY\r");
    await waitFor(async () => screen().includes('SSH_FILE_PARENT_READY') && (await snapshot(first.sessionId))?.promptReady, 'Actual parent Shell setup missing');
    const scratch = () => witness<{ path: string; mode: string; length: number; sha256: string } | null>('scratch');
    assert(!(await scratch()), 'Fresh fixture already has the isolated script');
    const declined = await requestTool(id, 'file-write');
    assert(declined.approval && !(await scratch()), 'Scratch path was written before approval');
    await invokeDecideTerminalAcceptanceCommand(declined.approval, false);
    const declinedEvents = await declined.events();
    Object.assign(records, { id, declined: declined.prepared, declinedEvents });
    assert(!declinedEvents.some(event => event.type === 'tool/execution' && event.data.callId === declined.callId)
      && !(await scratch()), 'Declined scratch write reached actual filesystem');
    const write = await requestTool(id, 'file-write');
    assert(write.approval && !(await scratch()), 'Second scratch request wrote before approval');
    const saved = await finishTool(write), disk = await scratch();
    Object.assign(records, { saved, disk });
    const read = await finishTool(await requestTool(id, 'file-read'));
    records.read = read;
    const savedData = saved.resolved.data, readData = read.resolved.data;
    assert(disk && saved.result.data.status === 'completed' && read.result.data.status === 'completed' && savedData.verified === true
      && savedData.afterSha256 === disk.sha256 && readData.path === disk.path && typeof readData.content === 'string',
    'Actual SFTP scratch write, readback and independent fixture path differ');
    const bytes = new TextEncoder().encode(readData.content);
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
    assert(digest === disk.sha256 && bytes.length === disk.length && !(await effect()).text, 'Real SFTP file differs or ran without approval');
    const execute = await requestTool(id, 'file-run', disk.path);
    assert(execute.approval && execute.prepared.source.includes(disk.path) && !(await effect()).text, 'Returned absolute path did not wait for native approval');
    const executed = await finishTool(execute), finalEffect = await effect();
    Object.assign(records, { executed, finalEffect });
    assert(executed.result.data.status === 'completed' && executed.resolved.data.channel === 'terminal'
      && executed.resolved.data.commandLine === execute.prepared.source && executed.resolved.data.exitCode === 0
      && finalEffect.text === 'FILE_ONCE\n' && (await invokeGetTerminalSubmissionRecovery(id)).length === 0,
    'SFTP readback path did not execute once in the original parent Shell');
    await invokeCancelAgentRuntime({ sessionId: id });
    const afterTermination = await scratch();
    Object.assign(records, { id, declined: declined.prepared, declinedEvents, saved, read, disk, digest, executed, finalEffect, afterTermination });
  }

  async function verifyPositive(first: SessionSummary) {
    const byteBoundary = scenario === 'positive-byte-boundary';
    const sourceBoundaries = scenario === 'positive-source-boundaries';
    const history = scenario?.startsWith('history-') ? scenario.slice('history-'.length) : undefined;
    const current = () => snapshot(first.sessionId);
    assert((await effect()).text === null, 'Positive case has an earlier remote effect');
    if (history) {
      await marker('SSH_HIST_A');
      if (history === 'custom') {
        await marker('SSH_HIST_DUP');
        await send("printf '%s%s\\n' SSH_HIST_ DUP\r");
        await waitFor(() => (decoded[first.sessionId]?.match(/SSH_HIST_DUP/g)?.length ?? 0) === 2, 'Both actual duplicate commands did not execute');
        await send(`${bash ? '' : ' '}SKIP_HISTORY_MARK\r`);
      }
      await marker('SSH_HIST_B');
      await waitFor(async () => (await current())?.promptReady, 'User history entries did not return to the original prompt');
    } else if (!byteBoundary && !sourceBoundaries) {
      await send("mkdir -m 700 \"$HOME/phase3-parent\" && cd \"$HOME/phase3-parent\" && export PHASE3_PARENT=parent-env && phase3_parent_fn() { printf '%s' parent-function; }; printf '%s%s\\n' SSH_PARENT_ READY\r");
      await waitFor(async () => screen().includes('SSH_PARENT_READY') && (await current())?.promptReady, 'Actual parent shell setup did not complete');
      const rejected = await invocation(first, 'effect');
      assert(rejected.approval && (await effect()).text === null, 'Approval rejection requires a real pending command with no effect');
      const before = await current();
      const decision = await invokeDecideTerminalAcceptanceCommand(rejected.approval, false);
      const events = await rejected.events(), recovery = await invokeGetTerminalSubmissionRecovery(rejected.id);
      assert(events.some(event => event.type === 'tool/approval' && event.data.status === 'rejected' && event.data.callId === rejected.callId)
        && !events.some(event => event.type === 'tool/execution') && recovery.length === 0
        && (await current())?.nextInputSequence === before?.nextInputSequence && (await effect()).text === null,
      'A rejected approval entered execution, mutated input, created intent or had an effect');
      records.rejected = { id: rejected.id, approval: rejected.approval, decision, events, recovery };
      await invokeCancelAgentRuntime({ sessionId: rejected.id });
    }
    const sourceKind = byteBoundary ? 'exact-byte-boundary' : sourceBoundaries ? 'complex-source' : history ? 'effect' : 'parent-shell';
    const accepted = await invocation(first, sourceKind);
    assert(accepted.approval && (await effect()).text === null, 'An approved case did not wait for approval');
    const bytes = new TextEncoder().encode(accepted.prepared.source);
    assert(!byteBoundary || bytes.length === 8192, 'Exact boundary source has the wrong byte length');
    if (sourceBoundaries) {
      assert(accepted.prepared.source.includes("<<'SS_SOURCE'\n中文 e\u0301 👩‍💻\t! \"quote\" 'single'\nSS_SOURCE\n"),
        'Complex source lost a required byte or quoting boundary');
    }
    const decision = await invokeDecideTerminalAcceptanceCommand(accepted.approval, true);
    const events = await accepted.events();
    const result = events.find(event => event.type === 'tool/result' && event.data.callId === accepted.callId);
    assert(result?.type === 'tool/result', 'Actual native execution result missing');
    const resolved = await readNativeAcceptanceResult(accepted.id, result.data.data);
    assert(resolved.data.channel === 'terminal' && resolved.data.execution === 'completed'
      && resolved.data.commandLine === accepted.prepared.source && resolved.data.exitCode === (sourceKind === 'parent-shell' ? 7 : 0),
    'Approved source did not complete through the original native terminal');
    const observed = await effect();
    assert(observed.text === `${accepted.callId}\n` && (await invokeGetTerminalSubmissionRecovery(accepted.id)).length === 0,
      'Actual effect was missing, repeated, or remained unsettled');
    await invokeCancelAgentRuntime({ sessionId: accepted.id });
    await waitFor(async () => (await current())?.promptReady && !agentTerminalLeaseState.get(first.sessionId), 'Actual native lease or prompt remained unavailable');
    if (byteBoundary) {
      const before = await current();
      const refused = await invocation(first, 'oversized-byte-boundary');
      const after = await refused.events();
      assert(new TextEncoder().encode(refused.prepared.source).length === 8193 && !refused.approval
        && after.some(event => event.type === 'tool/result' && event.data.callId === refused.callId
          && event.data.status === 'rejected' && event.data.summary.includes('8193 UTF-8 bytes'))
        && !after.some(event => event.type === 'tool/execution') && (await current())?.nextInputSequence === before?.nextInputSequence
        && (await invokeGetTerminalSubmissionRecovery(refused.id)).length === 0 && (await effect()).sha256 === observed.sha256,
      '8193-byte source was not rejected before approval and input with no additional effects');
      records.oversize = { id: refused.id, prepared: refused.prepared, after };
      await invokeCancelAgentRuntime({ sessionId: refused.id });
    } else if (sourceBoundaries) {
      const refusals = [];
      for (const kind of ['syntax-error', 'unsupported-input'] as const) {
        const before = await current();
        const refused = await invocation(first, kind);
        const result = await finishTool(refused);
        const dispatched = result.events.some(event => event.type === 'tool/execution' && event.data.callId === refused.callId);
        const after = await current(), recovery = await invokeGetTerminalSubmissionRecovery(refused.id);
        refusals.push({ kind, before, result, dispatched, after, recovery });
        records.refusals = refusals;
        assert(result.result.data.status !== 'completed' && recovery.length === 0
          && (dispatched ? result.resolved.data.execution === 'notStarted' : after?.nextInputSequence === before?.nextInputSequence)
          && (await effect()).sha256 === observed.sha256, 'Invalid source was submitted or ran its valid leading command');
        await invokeCancelAgentRuntime({ sessionId: refused.id });
        await waitFor(async () => (await current())?.promptReady && !agentTerminalLeaseState.get(first.sessionId), 'Refused source did not return ordinary input');
        await send('\r');
        await marker(kind === 'syntax-error' ? 'SSH_SYNTAX_EMPTY_ENTER_OK' : 'SSH_CONTROL_EMPTY_ENTER_OK');
        assert((await effect()).sha256 === observed.sha256, 'Ordinary Enter executed residual invalid source');
      }
    } else if (history) {
      await send('\x18h');
      const memory = await waitFor(() => decoded[first.sessionId]?.match(/(?:^|\n)SSH_HISTORY_BEGIN\r?\n([\s\S]*?)\r?\nSSH_HISTORY_END(?:\r?\n|$)/)?.[1],
        'Actual Bash binding or ZLE widget did not observe in-memory history');
      const home = `/home/${username}`;
      const expected = history === 'unset' ? 'SSH_HISTORY_FILE::' : history === 'empty' ? 'SSH_HISTORY_FILE:x:'
        : `SSH_HISTORY_FILE:x:${home}/${history === 'custom' ? 'custom-history' : bash ? '.bash_history' : 'history'}`;
      records.historyMemory = { variant: history, memory, expected, observer: bash ? 'Readline user binding' : 'ZLE user widget', acceptedSource: accepted.prepared.source };
      await send('exit\r');
      await waitFor(() => closed.has(first.sessionId), 'Actual login shell did not exit and flush history');
      const historyLines = memory.split(/\r?\n/);
      assert(historyLines.includes(expected) && memory.includes('SSH_HIST_ B')
        && historyLines.some(line => line.replace(/^\s*\d+\*?\s+/, '') === accepted.prepared.source)
        && !/(__shellspan|ss_native_input_begin)/.test(memory), 'Actual history did not retain the exact visible command and history settings');
      if (history === 'small') assert(!memory.includes('SSH_HIST_ A'), 'Small history retained an entry outside its configured bound');
      if (history === 'custom') assert(!memory.includes('SKIP_HISTORY_MARK') && memory.split('\n').filter(line => line.includes('SSH_HIST_ DUP')).length === 1,
        'Actual ignored/duplicate entries violated custom history policy');
    } else {
      await send("printf 'SSH_PARENT_STATUS=%s\\n' \"$?\"\r");
      await waitFor(() => screen().includes('SSH_PARENT_STATUS=7'), 'Private control changed the real parent Shell exit status');
    }
    const actual = await trace();
    const keys = actual.filter(entry => entry.event === 'accept-key-write-returned');
    const attempted = actual.filter(entry => entry.event === 'ssh-accept-key-write-attempt');
    const acceptedReceipts = actual.filter(entry => entry.event === 'ssh-receipt-read' && entry.details.kind === 'submissionAccepted');
    const settled = actual.filter(entry => entry.event === 'ssh-receipt-read' && entry.details.kind === 'settled');
    const intents = actual.filter(entry => entry.event === 'intent-record-returned');
    const identity = keys[0]?.details.identity;
    Object.assign(records, { id: accepted.id, identity, approval: accepted.approval, prepared: accepted.prepared,
      sourceBytes: bytes.length, decision, events, resolved, finalEffect: observed, finalScreen: screen(),
      positiveTrace: { keys, attempted, acceptedReceipts, settled, intents } });
    assert(identity && identity.agentSessionId === accepted.id && identity.terminalSessionId === first.terminalSessionId
      && identity.terminalGeneration === first.terminalGeneration && keys.length === 1 && attempted.length === 1
      && acceptedReceipts.length === 1 && settled.length === 1 && intents.length === 1
      && [acceptedReceipts[0], settled[0], intents[0]].every(event => sameIdentity(event.details.identity, identity))
      && intents[0].sequence < keys[0].sequence && keys[0].sequence < acceptedReceipts[0].sequence
      && acceptedReceipts[0].sequence < settled[0].sequence, 'Positive case did not have one real ordered intent/key/accept/settle chain');
  }

  async function verifySubmission(old: SessionSummary) {
    assert((await effect()).text === null, 'Unexpected earlier remote effect');
    const { id, callId, approval, prepared, events } = await invocation(old, 'effect');
    assert(approval, 'Actual approval was bypassed');
    Object.assign(records, { id, callId, approval, prepared });
    const approvalAt = performance.now();
    const decision = invokeDecideTerminalAcceptanceCommand(approval, true)
      .then(value => ({ value, at: performance.now() }), error => ({ error: String(error), at: performance.now() }));
    const cut = await waitCut();
    assert(cut.identity.agentSessionId === id && cut.identity.terminalSessionId === old.terminalSessionId
      && cut.identity.terminalGeneration === old.terminalGeneration, 'Cut belongs to another SSH operation/generation');
    const atCut = await snapshot(old.sessionId);
    const active = atCut?.inputObservation?.activeCommand;
    const pendingAtCut = await invokeGetTerminalSubmissionRecovery(id);
    Object.assign(records, { cut, atCut, pendingAtCut });
    assert(active?.fullInputConfirmed && active.submissionIntentDurable && active.mayHaveSubmitted === !beforeKey
      && active.commandId === cut.identity.commandId && active.operationId === cut.identity.operationId
      && pendingAtCut.length === 1 && sameIdentity(pendingAtCut[0].identity, cut.identity), 'Actual proof/FULL intent/key ordering differs at cut');
    const competingEnter = await controller!.writeUserInput('\r');
    records.competingEnter = competingEnter;
    assert(!competingEnter, 'Operation yielded terminal input while the cut was held');
    if (crash) {
      const observedEffect = beforeKey ? await effect()
        : await waitFor(async () => { const value = await effect(); return value.text === `${callId}\n` ? value : null; }, 'Actual effect missing before post-key App crash');
      assert(observedEffect.text === (beforeKey ? null : `${callId}\n`), 'Unexpected actual effect at App crash cut');
      Object.assign(records, { observedEffect, priorSession: old });
      await report({ progress: 'Actual signed App held at its crash cut', evidence: { records, sessions, timeline, decoded, trace: await trace() } });
      await witness('crash', 'POST');
      throw new Error('The owned App was not terminated at its crash cut');
    }
    if (disconnect) {
      const severed = await witness<{ at: number; socketIds: number[] }>('disconnect', 'POST');
      records.disconnect = severed;
      if (beforeKey) await waitFor(() => closed.has(old.sessionId), 'Actual transport did not close before release of the pre-key barrier');
      await release(cut);
      // A buffered acceptance can precede socket-loss notification. Allow one
      // production keepalive (30 s) and the SSH I/O deadline (15 s) to observe it.
      await waitFor(() => closed.has(old.sessionId), 'Actual SSH disconnect missing', beforeKey ? 12000 : 50000);
      records.disconnectObservedAfterMs = Date.now() - severed.at;
    } else if (controlEof) {
      if (!beforeKey) await waitFor(async () => (await effect()).text === `${callId}\n`, 'Actual post-key effect missing before relay EOF', 8000);
      records.controlEof = await witness('control-eof', 'POST');
      await release(cut);
      await waitFor(async () => {
        const current = await snapshot(old.sessionId);
        return current?.open && current.integrationState !== 'ready' && current.inputObservation?.nativeRecoveryRequired;
      }, 'Private relay loss did not fence the still-open SSH PTY');
      assert(!closed.has(old.sessionId), 'Private relay fault closed the whole SSH transport');
    } else if (beforeKey) {
      if (explicitControl) {
        const takeover = async () => {
          const lease = agentTerminalLeaseState.get(old.sessionId);
          assert(lease?.agentSessionId === id && lease.operationId === cut.identity.operationId,
            'The production SSH takeover view does not match the held operation');
          lease.requestTakeover();
          await waitFor(async () => !agentTerminalLeaseState.get(old.sessionId)
            && (await events()).some(event => event.type === 'turn/end' && event.turnId === approval.turnId),
          'The production takeover did not release the SSH lease and end its turn');
          return { origin: 'production-terminal-lease-view', leaseViewReleased: true, turnEndObserved: true };
        };
        const request = (explicitControl === 'takeover' ? takeover() : explicitControl === 'stop'
          ? invokeInterruptAgentRuntime({ sessionId: id }) : invokeCancelAgentRuntime({ sessionId: id }))
          .then(value => ({ value }), error => ({ error: String(error) }));
        const requestKind = explicitControl === 'takeover' ? 'takeover-owner-validated' : 'cancel-token';
        records.controlRequest = await waitFor(async () => {
          const state = await json<{ requests?: { requestKind: string; identity: Identity }[] }>(cutUrl());
          return state.requests?.find(request => request.requestKind === requestKind && sameIdentity(request.identity, cut.identity));
        }, 'The actual SSH control request did not enter before cut release');
        const clearance = (await trace()).find(entry => entry.event === 'ssh-receipt-read'
          && entry.details.kind === 'draftCleared' && sameIdentity(entry.details.identity, cut.identity));
        records.clearanceWhileHeld = clearance ?? null;
        if (!clearance) {
          const entered = await controller!.writeUserInput('\r');
          assert(!entered, 'The SSH control request returned editing before real clearance');
        }
        await release(cut);
        const controlled = await request;
        records.controlled = controlled;
        assert(!('error' in controlled), 'The actual SSH control request failed');
      } else {
        await pause(5250);
        await release(cut);
      }
    }
    const outcome = await decision;
    const after = await snapshot(old.sessionId), pending = await invokeGetTerminalSubmissionRecovery(id), observedEffect = await effect();
    const execution = await invokeInspectAgentRuntimeRecovery({ sessionId: id });
    Object.assign(records, { outcome, after, pending, observedEffect, execution });
    if (disconnect) assert(after?.closeReason === 'transportDisconnected', 'The Broker did not observe actual SSH transport loss');
    if (beforeKey) {
      assert(observedEffect.text === null, 'Pre-key fault caused a remote side effect');
      if (disconnect || controlEof) {
        assert(after?.open === controlEof && pending.length === 1 && sameIdentity(pending[0].identity, cut.identity)
          && pending[0].noAutoReplay, 'Pre-key transport loss discarded the original intent without actual draft clear');
      } else {
        const clear = (await trace()).filter(entry => entry.event === 'ssh-receipt-read' && entry.details.kind === 'draftCleared');
        records.draftClear = clear;
        assert((explicitControl || outcome.at - approvalAt >= 5000) && pending.length === 0 && after?.promptReady,
          'Pre-key timeout or cancellation did not clear the real draft and settle the zero-submit intent');
        assert(clear.length === 1 && sameIdentity(clear[0].details.identity, cut.identity), 'Actual matching DraftCleared was not observed');
        if (!explicitControl) await invokeCancelAgentRuntime({ sessionId: id });
        await waitFor(() => !agentTerminalLeaseState.get(old.sessionId), 'Cleared operation still owns the terminal');
        await send('\r');
        await marker('SSH_EMPTY_ENTER_OK');
      }
    } else {
      assert(pending.length === 1 && sameIdentity(pending[0].identity, cut.identity) && pending[0].noAutoReplay
        && execution.kind === 'executionInFlight' && execution.status === 'required' && execution.callId === callId,
      'Unknown submission lost the exact operation or durable recovery gate');
      const refusal = await invokeResumeAgentRuntimeRecovery({ sessionId: id }).then(() => null, error => String(error));
      records.resumeRefusal = refusal;
      assert(refusal?.includes('requires reconciliation or abort') && JSON.stringify(await invokeGetTerminalSubmissionRecovery(id)) === JSON.stringify(pending),
        'Unknown operation was eligible for replay');
      assert(observedEffect.text === null || observedEffect.text === `${callId}\n`, 'Remote effect occurred more than once');
      if (!disconnect && !controlEof) {
        assert(outcome.at - approvalAt >= 5000 && observedEffect.text === `${callId}\n`
          && after?.inputObservation?.commandInputPending && after.inputObservation.activeCommand?.phase === 'uncertain'
          && after.inputObservation.activeCommand.executionEvidence === 'unknown', 'Production deadline did not leave the exact operation uncertain');
        const refuseBackendEnter = async () => {
          const before = await snapshot(old.sessionId);
          const error = await invokeWriteSession(old.sessionId, '\r').then(() => null, reason => String(reason));
          const after = await snapshot(old.sessionId);
          assert(error && before?.nextInputSequence === after?.nextInputSequence,
            'Broker admitted Enter during unknown submission');
          return error;
        };
        const blockedEnter = await controller!.writeUserInput('\r');
        records.enterWhileUnknown = blockedEnter;
        assert(!blockedEnter, 'Unknown submission returned editing authority');
        records.backendEnterWhileUnknown = await refuseBackendEnter();
        await release(cut);
        const settlement = await waitCut(true);
        const late = (await snapshot(old.sessionId))?.inputObservation;
        const afterStarted = await invokeGetTerminalSubmissionRecovery(id);
        const lateEnter = await controller!.writeUserInput('\r');
        Object.assign(records, { settlement, late, afterStarted, lateEnter });
        assert(sameIdentity(settlement.identity, cut.identity) && late?.activeCommand?.commandId === cut.identity.commandId
          && late.activeCommand.phase === 'uncertain' && late.activeCommand.executionEvidence === 'startObserved'
          && late.commandInputPending && !lateEnter && JSON.stringify(afterStarted) === JSON.stringify(pending),
        'Late real Started changed the recovery gate or settled the original intent');
        records.backendEnterAfterStarted = await refuseBackendEnter();
        const actualReceipts = (await trace()).filter(entry => entry.event === 'ssh-receipt-read');
        const started = actualReceipts.find(entry => entry.details.kind === 'started');
        const settled = actualReceipts.find(entry => entry.details.kind === 'settled');
        assert(started && settled && started.sequence < settled.sequence && started.details.requestId === settled.details.requestId
          && sameIdentity(started.details.identity, cut.identity) && sameIdentity(settled.details.identity, cut.identity),
        'Real late SSH receipts do not match the original identity/request');
        await release(settlement, true);
        await waitFor(async () => (await invokeGetTerminalSubmissionRecovery(id)).length === 0, 'Matching real Settled did not settle the original intent');
        assert((await effect()).sha256 === observedEffect.sha256, 'Late receipts repeated the file effect');
      }
    }
    if (!closed.has(old.sessionId)) {
      await invokeCloseSession(old.sessionId);
      await waitFor(() => closed.has(old.sessionId), 'Original SSH PTY did not close');
    }
    const successor = await open(old);
    await staleWrite(old);
    await marker('SSH_RECOVERY_OK');
    const finalPending = await invokeGetTerminalSubmissionRecovery(id);
    const finalEffect = await effect(), actualTrace = await trace(), finalGate = gate(await snapshot(successor.sessionId));
    const finalRecovery = await invokeInspectAgentRuntimeRecovery({ sessionId: id });
    const agentEvents = await events();
    const keys = actualTrace.filter(entry => entry.event === 'accept-key-write-returned');
    const keyAttempts = actualTrace.filter(entry => entry.event === 'ssh-accept-key-write-attempt');
    const accepted = actualTrace.filter(entry => entry.event === 'ssh-receipt-read' && entry.details.kind === 'submissionAccepted');
    Object.assign(records, { finalPending, finalEffect, finalGate, finalRecovery, keys, keyAttempts, accepted, events: agentEvents });
    assert(keyAttempts.length === keys.length && keys.length === (beforeKey ? 0 : 1)
      && keyAttempts.every(entry => entry.details.sessionId === old.sessionId)
      && keys.every(entry => sameIdentity(entry.details.identity, cut.identity))
      && accepted.length <= keys.length && accepted.every(entry => sameIdentity(entry.details.identity, cut.identity)), 'Unexpected actual accept-key or peer receipt count');
    if (scenario === 'after-key-timeout') assert(accepted.length === 1, 'Held real peer acceptance is missing or duplicated');
    assert(!finalGate.recovery && !finalGate.active && JSON.stringify(finalPending) === JSON.stringify(disconnect || controlEof ? pending : [])
      && (beforeKey ? finalEffect.text === null : finalEffect.text === null || finalEffect.text === `${callId}\n`),
    'Reconnect changed the original intent, replayed a side effect or inherited the old input gate');
    assert(agentEvents.filter(event => event.type === 'tool/execution' && event.data.callId === callId).length === 1,
      'Original approved tool was dispatched more than once or execution was never dispatched');
    if (!beforeKey && (disconnect || controlEof)) assert(finalRecovery.kind === 'executionInFlight' && finalRecovery.status === 'required'
      && finalRecovery.callId === callId, 'Explicit terminal reconnect changed the original Agent recovery gate');
  }

  async function verifyRunningControl(first: SessionSummary, action: string, boundary?: string) {
    const afterAccept = boundary === 'after-accept';
    const partial = boundary === 'input-in-progress';
    const durable = !boundary || afterAccept || boundary === 'intent' || boundary === 'armed';
    const beforeKey = Boolean(boundary) && !afterAccept;
    const { id, callId, approval, events } = await invocation(first, partial ? 'paced-input' : beforeKey ? 'effect' : 'running');
    assert(approval && (await effect()).text === null, 'Actual SSH command must wait for approval');
    const decision = invokeDecideTerminalAcceptanceCommand(approval, true)
      .then(value => ({ value }), error => ({ error: String(error) }));
    const cut = boundary ? await waitCut() : undefined;
    const atCut = cut ? await snapshot(first.sessionId) : await waitFor(async () => {
      const current = await snapshot(first.sessionId);
      const active = current?.inputObservation?.activeCommand;
      return active?.agentSessionId === id && active.phase === 'running'
        && active.executionEvidence === 'startObserved' && (await effect()).text === `${callId}\n` ? current : undefined;
    }, 'Actual SSH command did not reach running with one file effect');
    const pending = await invokeGetTerminalSubmissionRecovery(id);
    const identity = cut?.identity ?? pending[0]?.identity;
    const active = atCut?.inputObservation?.activeCommand;
    assert(identity?.agentSessionId === id && identity.operationId === active?.operationId
      && identity.terminalGeneration === first.terminalGeneration && active.commandId === identity.commandId
      && pending.length === Number(durable) && (!durable || pending[0].noAutoReplay && sameIdentity(pending[0].identity, identity)),
    'Original SSH operation and intent differ at the selected boundary');
    if (cut) assert(cut.cut === boundary && active.fullInputConfirmed === !partial && active.submissionIntentDurable === durable
      && active.mayHaveSubmitted === afterAccept && active.phase === (partial ? 'typing' : afterAccept ? 'submissionAttempted' : 'inputConfirmed'),
    'SSH control did not observe the intended phase');
    Object.assign(records, { id, callId, approval, atCut, cut, pending });
    if (partial) {
      const progress = (await trace()).find(row => row.event === 'input-progress-observed'
        && sameIdentity(row.details.identity, identity));
      assert(progress, 'No real partial SSH input proof was captured');
      records.progress = progress;
    }
    const competingEnter = await controller!.writeUserInput('\r');
    assert(!competingEnter, 'The held SSH operation did not block a competing Enter');
    const control = async () => {
      if (action === 'takeover') {
        const lease = agentTerminalLeaseState.get(first.sessionId);
        assert(lease?.agentSessionId === id && lease.operationId === identity.operationId, 'Actual SSH lease view has a different owner');
        lease.requestTakeover();
        records.takeoverOrigin = 'production-terminal-lease-view';
      } else if (action === 'stop') {
        records.controlled = await invokeInterruptAgentRuntime({ sessionId: id });
      } else {
        records.controlled = await invokeCancelAgentRuntime({ sessionId: id });
      }
    };
    const request = control().then(() => ({ ok: true }), error => ({ ok: false, error: String(error) }));
    if (cut) {
      const requestKind = action === 'takeover' ? 'takeover-owner-validated' : 'cancel-token';
      records.controlRequest = await waitFor(async () => {
        const state = await json<{ requests?: { requestKind: string; identity: Identity }[] }>(cutUrl());
        return state.requests?.find(item => item.requestKind === requestKind && sameIdentity(item.identity, identity));
      }, 'The actual SSH control request did not reach its original cut');
      await release(cut);
    }
    const controlResult = await request;
    records.controlResult = controlResult;
    assert(controlResult.ok, 'Actual SSH control request failed');
    records.outcome = await decision;
    await waitFor(async () => {
      const current = await snapshot(first.sessionId);
      return current?.open && current.promptReady && !current.inputObservation?.commandInputPending
        && !current.inputObservation?.nativeRecoveryRequired && !agentTerminalLeaseState.get(first.sessionId);
    }, 'Real SSH settlement did not return the PTY to ordinary input');
    const actual = await trace();
    const matching = (kind: string) => actual.filter(row => row.event === 'ssh-receipt-read' && row.details.kind === kind
      && sameIdentity(row.details.identity, identity));
    const accepted = matching('submissionAccepted'), started = matching('started'), settled = matching('settled');
    const keys = actual.filter(row => row.event === 'accept-key-write-returned');
    const cleared = matching('draftCleared');
    if (beforeKey) assert(keys.length === 0 && accepted.length === 0 && settled.length === 0 && cleared.length === 1,
      'Actual SSH control did not clear the original pre-accept draft without execution');
    else assert(keys.length === 1 && sameIdentity(keys[0].details.identity, identity) && accepted.length === 1
      && settled.length === 1 && keys[0].sequence < accepted[0].sequence && accepted[0].sequence < settled[0].sequence
      && started.length <= 1 && (!started.length || accepted[0].sequence < started[0].sequence && started[0].sequence < settled[0].sequence),
    'Actual SSH control did not retain an ordered single acceptance and matching settlement');
    const recovery = await invokeGetTerminalSubmissionRecovery(id);
    const agentEvents = await events();
    assert(recovery.length === 0 && agentEvents.some(event => event.type === 'turn/end' && event.turnId === approval.turnId),
      'Matching SSH settlement did not finish the original Agent turn');
    await send('\r');
    await marker('SSH_RUNNING_CONTROL_ENTER_OK');
    const finalEffect = await effect();
    assert(beforeKey ? finalEffect.text === null : finalEffect.text === `${callId}\n` || afterAccept && finalEffect.text === null,
      'SSH control or later Enter repeated the original file effect');
    Object.assign(records, { competingEnter, keys, accepted, started, settled, cleared, identity, recovery, finalEffect, agentEvents });
  }

  async function verifyAgentIsolation(first: SessionSummary) {
    const second = await open(undefined, false, true);
    assert(first.terminalSessionId !== second.terminalSessionId, 'Independent SSH terminal reused the same logical identity');
    const delegated = scenario === 'delegation';
    const parent = delegated ? await invocation(first, 'effect') : undefined;
    const observer = await invocation(second, 'effect');
    assert(observer.approval && (!parent || parent.approval), 'The independent requests require real pending approvals');
    const observerBefore = await snapshot(second.sessionId), observerEvents = await observer.events();
    const child = parent ? await invokeSpawnAgentRuntimeSubagent({
      parentSessionId: parent.id, goal: 'Execute one approved fixture command without a model',
      role: 'operator', inheritanceMode: 'blank', targetIds: [`terminal-${first.sessionId}`],
      continuable: false, budget: { maxTurns: 1, timeoutMs: 90000 },
    }) : undefined;
    if (child) assert(child.header.parentSessionId === parent?.id && !child.header.subagent?.provider
      && !child.header.modelSelection && child.header.permissionMode === 'requestApproval'
      && child.header.target?.sessionId === first.sessionId, 'SSH child did not inherit the original target and approval policy');
    const owner = child ? await requestTool(child.header.sessionId, 'running') : await invocation(first, 'running');
    assert(owner.approval && (await effect()).text === null, 'Actual owner did not wait for approval');
    const decision = invokeDecideTerminalAcceptanceCommand(owner.approval, true)
      .then(value => ({ value }), error => ({ error: String(error) }));
    const running = await waitFor(async () => {
      const current = await snapshot(first.sessionId), active = current?.inputObservation?.activeCommand;
      return active?.agentSessionId === owner.id && active.phase === 'running' && active.executionEvidence === 'startObserved'
        && (await effect()).text === `${owner.callId}\n` ? current : undefined;
    }, 'Actual SSH owner did not reach running');
    const pending = await invokeGetTerminalSubmissionRecovery(owner.id), identity = pending[0]?.identity;
    assert(pending.length === 1 && pending[0].noAutoReplay && identity?.operationId === running.inputObservation?.activeCommand?.operationId
      && identity.agentSessionId === owner.id, 'Actual SSH owner did not retain one matching intent');
    const contender = parent ?? await invocation(first, 'effect');
    assert(contender.approval, 'The competing SSH request did not reach production approval');
    Object.assign(records, { id: owner.id, identity, running, pending, parent, child, owner: owner.prepared,
      observer: observer.prepared, observerBefore, observerEvents, contender: contender.prepared });
    if (parent) assert(await invokeGetAgentTerminalOwner(first.sessionId) === parent.id, 'Delegated SSH turn lost its parent owner');
    const contention = await invokeDecideTerminalAcceptanceCommand(contender.approval, true)
      .then(value => ({ value }), error => ({ error: String(error) }));
    const contenderEvents = await contender.events(), afterContention = await snapshot(first.sessionId);
    assert(afterContention?.inputObservation?.activeCommand?.operationId === identity.operationId
      && !contenderEvents.some(event => event.type === 'tool/result' && event.data.callId === contender.callId && event.data.status === 'completed')
      && (await effect()).text === `${owner.callId}\n`, 'Competing SSH request displaced or executed beside the original owner');
    Object.assign(records, { contention, contenderEvents, afterContention });
    const closing = scenario === 'close-running-terminal';
    if (parent && child) {
      const result = await invokeCancelAgentRuntimeChild({ parentSessionId: parent.id, childSessionId: child.header.sessionId });
      assert(result.ended && await invokeGetAgentTerminalOwner(first.sessionId) === parent.id,
        'Canceling the delegated SSH child did not restore the original parent');
      records.childCancellation = result;
    } else if (closing) {
      await invokeCloseSession(first.sessionId);
      await waitFor(() => closed.has(first.sessionId), 'Actual running SSH transport did not close');
    } else {
      records.ownerStop = await invokeInterruptAgentRuntime({ sessionId: owner.id });
    }
    records.outcome = await decision;
    const recovery = await invokeGetTerminalSubmissionRecovery(owner.id);
    const firstAfter = await snapshot(first.sessionId), observerAfter = await snapshot(second.sessionId);
    const observerEventsAfter = await observer.events(), finalEffect = await effect(), actual = await trace();
    const keys = actual.filter(row => row.event === 'accept-key-write-returned');
    const settled = actual.filter(row => row.event === 'ssh-receipt-read' && row.details.kind === 'settled'
      && sameIdentity(row.details.identity, identity));
    assert(keys.length === 1 && sameIdentity(keys[0].details.identity, identity) && finalEffect.text === `${owner.callId}\n`,
      'SSH ownership control lost or repeated the original actual effect');
    if (closing) assert(!firstAfter?.open && (recovery.length === 0 ? settled.length === 1
      : recovery.length === 1 && recovery[0].noAutoReplay && sameIdentity(recovery[0].identity, identity)),
    'Closing the running SSH transport lost the original settlement or uncertainty');
    else assert(firstAfter?.open && !firstAfter.inputObservation?.activeCommand && recovery.length === 0 && settled.length === 1,
      'Actual SSH stop or child cancellation did not settle its original operation');
    assert(observerBefore?.open && observerAfter?.open && observerAfter.nextInputSequence === observerBefore.nextInputSequence
      && observerAfter.terminalGeneration === observerBefore.terminalGeneration
      && JSON.stringify(observerEventsAfter) === JSON.stringify(observerEvents),
    'Unrelated SSH terminal or its pending approval changed');
    Object.assign(records, { firstAfter, observerAfter, observerEventsAfter, keys, settled, recovery, finalEffect });
    await invokeDecideTerminalAcceptanceCommand(observer.approval, false);
    for (const id of new Set([owner.id, contender.id, observer.id])) {
      if (!(closing && id === owner.id && recovery.length)) await invokeCancelAgentRuntime({ sessionId: id });
    }
  }

  async function verifyRestart(fresh: SessionSummary) {
    const prior = await witness<{ cut: Cut; original: { records: { id: string; callId: string; approval: Parameters<typeof invokeDecideTerminalAcceptanceCommand>[0]; priorSession: SessionSummary } }; effect: Effect }>('restart-prior');
    const { id, callId, approval, priorSession } = prior.original.records;
    assert(id === prior.cut.identity.agentSessionId && priorSession.sessionId !== fresh.sessionId, 'Original and restarted transports were not distinct');
    const original = await invokeGetAgentRuntimeSession({ sessionId: id });
    const pending = await invokeGetTerminalSubmissionRecovery(id);
    const recovery = await invokeInspectAgentRuntimeRecovery({ sessionId: id });
    assert(original.header.target?.sessionId === priorSession.sessionId && !(await snapshot(priorSession.sessionId))?.open
      && pending.length === 1 && pending[0].noAutoReplay && sameIdentity(pending[0].identity, prior.cut.identity)
      && recovery.kind === 'executionInFlight' && recovery.status === 'required' && recovery.callId === callId,
    'Restart lost the original target, durable intent or execution recovery gate');
    const before = await snapshot(fresh.sessionId);
    const refusal = async (operation: () => Promise<unknown>) => operation().then(() => null, error => String(error));
    const duplicate = await refusal(() => invokeRunTerminalAcceptanceCommand(id, callId, 'effect'));
    const repeatedApproval = await refusal(() => invokeDecideTerminalAcceptanceCommand(approval, true));
    const resume = await refusal(() => invokeResumeAgentRuntimeRecovery({ sessionId: id }));
    await staleWrite(priorSession);
    const afterAttempts = await snapshot(fresh.sessionId);
    Object.assign(records, { id, identity: prior.cut.identity, original, pending, recovery, duplicate, repeatedApproval, resume, before, afterAttempts });
    assert(duplicate && repeatedApproval && resume?.includes('requires reconciliation or abort')
      && afterAttempts?.nextInputSequence === before?.nextInputSequence,
    'Restart accepted a replay or changed the fresh SSH input sequence');
    await marker('SSH_RESTART_FRESH_INPUT');
    const finalEffect = await effect(), finalPending = await invokeGetTerminalSubmissionRecovery(id);
    assert(finalEffect.sha256 === prior.effect.sha256 && finalEffect.text === prior.effect.text
      && JSON.stringify(finalPending) === JSON.stringify(pending)
      && !(await trace()).some(entry => entry.event === 'accept-key-write-returned'), 'Restart changed the original effect or replayed its accept key');
    Object.assign(records, { finalPending, finalEffect, fresh });
  }

  try {
    const first = await open(undefined, rawAdmission);
    if (scenario === 'reconnect-tail') await verifyTail(first);
    else if (scenario === 'display-geometry') await verifyDisplay(first);
    else if (scenario === 'crash-restart') await verifyRestart(first);
    else if (scenario === 'ordinary-input' || rawAdmission) await verifyOrdinary(first);
    else if (scenario === 'positive-jobs') await verifyJobs(first);
    else if (scenario === 'positive-file-chain') await verifyFileChain(first);
    else if (scenario?.startsWith('positive-') || scenario?.startsWith('history-')) await verifyPositive(first);
    else if (scenario.startsWith('running-')) await verifyRunningControl(first, scenario.slice('running-'.length));
    else if (controlledCut) await verifyRunningControl(first, controlledCut[2], controlledCut[1]);
    else if (['runtime-multi-agent', 'close-running-terminal', 'delegation'].includes(scenario)) await verifyAgentIsolation(first);
    else await verifySubmission(first);
  } catch (error) {
    originalFailure = error;
    await report({ progress: 'ZLE SSH recovery failed before cleanup', evidence: { records, sessions, timeline, decoded, error: String(error) } });
    throw error;
  } finally {
    const cleanupErrors: string[] = [];
    for (const session of sessions) if (!closed.has(session.sessionId)) try {
      await invokeCloseSession(session.sessionId);
      await waitFor(() => closed.has(session.sessionId), 'Owned SSH close was not observed');
    } catch (error) { cleanupErrors.push(String(error)); }
    stops.forEach(stop => stop());
    if (controller) terminalRegistry.dispose(controller.sessionId);
    layer.unmount();
    layerHost.remove();
    if (cleanupErrors.length) {
      await report({ progress: 'ZLE SSH cleanup failed', evidence: { records, sessions, timeline, decoded, cleanupErrors, originalFailure: String(originalFailure) } });
      if (!originalFailure) throw new Error(cleanupErrors.join('\n'));
    }
  }
  await report({ ok: true, evidence: { kind: bash ? scenario === 'reconnect-tail' ? 'actual-bash-ssh-lifecycle' : 'actual-bash-ssh-recovery' : 'actual-zle-ssh-recovery', case: scenario, modelCalls: 0, records, sessions, timeline, decoded, trace: await trace() } });
}

void verify().catch((error: unknown) => report({ ok: false, error: error instanceof Error ? error.stack ?? error.message : String(error) }));
