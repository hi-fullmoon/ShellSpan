import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Terminal } from '@xterm/xterm';
import { TerminalControllerLayer } from '../terminal-controller-layer';
import { TerminalCarousel } from '../terminal-carousel';
import { FocusLayout } from '@/components/focus/focus-layout';
import { AppShell, MainContent } from '@/components/layout/app-shell';
import { AiPanel } from '@/components/ai/ai-panel';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useAiPanelStore } from '@/stores/aiPanelStore';
import { terminalRegistry } from '../registry/terminal-registry';
import { agentTerminalLeaseState } from '../agent-terminal-lease-state';
import { useTerminalStore } from '@/stores/terminalStore';
import { useAppStore } from '@/stores/appStore';
import { useFocusStore } from '@/stores/focusStore';
import { initI18n } from '@/locales';
import {
  invokeCreateLocalSession, invokeCloseSession, invokeListAiRoutes, invokeGetTerminalBrokerSnapshot,
  invokeCreateAgentRuntimeSession, invokeStartAgentRuntime, invokeAgentRuntimeFollowup,
  invokeCancelAgentRuntime, invokeArchiveAgentRuntimeSession, invokeDeleteAgentRuntimeSession,
  invokeApproveAgentRuntimeTool, invokeGetPendingAgentRuntimeApprovalArguments,
  invokeCreateSession, invokeCheckHostKey, invokeTrustHost, invokeRemoveKnownHost,
  invokeGetAgentRuntimeArtifact,
  invokeGetAgentRuntimeSession,
  invokeSetAgentRuntimeExecutionSurface,
  listenToAgentTerminalLease, listenToAgentRuntimeSession,
} from '@/lib/ipc/tauri';
import type { AgentSessionEvent } from '@/types/agent-session';
import '@/styles/base.css';

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function renderedBuffer(terminal: Terminal, through = terminal.buffer.active.length) {
  const buffer = terminal.buffer.active;
  const rows = Array.from({ length: through }, (_, index) => {
    const line = buffer.getLine(index);
    return { wrapped: line?.isWrapped ?? false,
      text: line?.translateToString(!buffer.getLine(index + 1)?.isWrapped) ?? '' };
  });
  return { rows, text: rows.map((line, index) => `${index && !line.wrapped ? '\n' : ''}${line.text}`).join('') };
}
function sourcePosition(terminal: Terminal, prefix: string, acrossRows = false) {
  for (let row = terminal.buffer.active.length - 1; row >= 0; row--) {
    const line = terminal.buffer.active.getLine(row);
    for (let column = 0; line && column < terminal.cols; column++) {
      if (line.getCell(column)?.getChars() !== prefix[0]) continue;
      if (acrossRows) {
        const matches = [...prefix].every((character, offset) => {
          const cell = column + offset;
          const actual=terminal.buffer.active.getLine(row + Math.floor(cell / terminal.cols))?.getCell(cell % terminal.cols)?.getChars();
          return actual !== undefined && (actual || ' ') === character;
        });
        if (matches) return { row, column };
      } else if (column + prefix.length <= terminal.cols && line.translateToString(false, column, column + prefix.length) === prefix) return { row, column };
    }
  }
  return undefined;
}
async function eventually(check: () => boolean | Promise<boolean>, message: string, timeout = 180_000) {
  const deadline = Date.now() + timeout;
  while (!await check()) {
    assert(Date.now() < deadline, message);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
function NativeTerminals() {
  const sessions = useTerminalStore(state => state.sessions);
  const active = useTerminalStore(state => state.activeSessionId);
  const section = useAppStore(state => state.activeSection);
  const focusEnabled = useFocusStore(state => state.enabled);
  const terminalOpen = useFocusStore(state => state.terminalOpen);
  const visible = section === 'terminal' && (!focusEnabled || terminalOpen);
  return <><TerminalControllerLayer />
    <div className="relative min-h-0 flex-1"><TerminalCarousel sessions={sessions} activeSessionId={active}
      isActive isVisible={visible} onActivate={id => useTerminalStore.getState().setActiveSession(id)}
      onSettle={id => { if (useAppStore.getState().activeSection === 'terminal') terminalRegistry.get(id)?.focus(); }} /></div></>;
}

// Real model + production IPC/facade/runtime/lease/broker/current Shell + xterm.
// Both draft surfaces use production controllers; no transport or tool event is replaced.
async function verify() {
  const parameters = new URL(location.href).searchParams;
  const report = async (progress: string) => fetch(`/__agent-stream-result/${parameters.get('token')}`,
    { method: 'POST', body: JSON.stringify({ progress }) });
  await initI18n('en-US');
  await getCurrentWindow().show();
  await getCurrentWindow().setFocus();
  if (parameters.get('narrow') === 'true') document.getElementById('root')!.style.width='600px';
  const selection = (await invokeListAiRoutes()).defaultSelection;
  assert(selection, 'A configured real default model is required');
  const root = createRoot(document.getElementById('root')!);
  const sshShell = parameters.get('sshShell');
  const nativeShell = parameters.get('nativeShell');
  const powershell = nativeShell === 'windowsPowerShell' || nativeShell === 'powerShell7';
  assert(!nativeShell || powershell, 'Unknown native PowerShell kind');
  const focusPolling = parameters.get('focusPolling') === 'true';
  assert(!sshShell || sshShell === 'bash' || sshShell === 'zsh', 'Unknown SSH fixture shell');
  const username = sshShell === 'zsh' ? 'shellspan-zsh' : 'shellspan';
  let trustedFixture = false;
  const terminals: string[] = [];
  const disposers: (() => void)[] = [];
  const agentId = `agent-native-jobs-${crypto.randomUUID()}`;
  const calls: Extract<AgentSessionEvent, { type: 'tool/call' }>[] = [];
  const results: Extract<AgentSessionEvent, { type: 'tool/result' }>[] = [];
  const executions: Extract<AgentSessionEvent, { type: 'tool/execution' }>[] = [];
  const operations = new Set<string>();
  const leaseEvents: unknown[] = [];
  const artifactEvidence = new Map<string, unknown>();
  const allowedCommands = new Set<string>();
  const approvalEvidence: { callId: string; status: string; seq: number; turnId?: string; stepId?: string }[] = [];
  let created = false;
  let failure: string | undefined;
  let monitoring = false;
  let output = '';
  let released = 0;
  let ended = false;
  let earlyOutput = false;
  let earlyViewEvidence: Record<string, unknown> | undefined;
  let earlyViewTiming: { capturedAtUnixMs: number; sourceEventSeq: number } | undefined;
  let earlyViewPromise: Promise<void> | undefined;
  let marker = '';
  let layoutEvidence: unknown;
  const geometryEvents: unknown[] = [];
  let rendererTransport: unknown;
  let uiFailure: unknown;
  let latestEvent: { type: string; seq?: number; operation?: string; state?: string } | undefined;
  let firstResult = false;
  let firstRelease = false;
  let armingUserView = false;
  let initialView: unknown;
  let workingView: unknown;
  let userViewStage = 'waiting-initial-command';
  let userDraftState: (() => unknown) | undefined;
  let draftInput: unknown;
  let userViewReady!: () => void;
  const userView = new Promise<void>(resolve => { userViewReady = resolve; });
  const readResult = async (event: Extract<AgentSessionEvent, { type: 'tool/result' }>): Promise<unknown> => {
    const value = event.data.data;
    if (!value || typeof value !== 'object' || !('artifactRef' in value) || typeof value.artifactRef !== 'string') return value;
    const artifact = await invokeGetAgentRuntimeArtifact({ sessionId: agentId, artifactId: value.artifactRef, maxBytes: 16 * 1024 * 1024 });
    assert(!artifact.truncated && artifact.metadata.kind === 'tool-result' && 'sha256' in value
      && artifact.metadata.sha256 === value.sha256, 'Tool result artifact was incomplete or changed identity');
    const bytes = Uint8Array.from(atob(artifact.bodyBase64), character => character.charCodeAt(0));
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
    assert(digest === artifact.metadata.sha256 && bytes.length === artifact.metadata.sizeBytes, 'Actual tool-result bytes did not match their metadata');
    artifactEvidence.set(artifact.metadata.artifactId, { sessionId: agentId, metadata: artifact.metadata, computedSha256: digest, bytes: bytes.length });
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  };
  try {
    for (const sessionId of parameters.getAll('cleanupSession')) {
      assert(/^agent-native-jobs-[0-9a-f-]{36}$/.test(sessionId), 'Cleanup is restricted to this acceptance session family');
      const previous = await invokeGetAgentRuntimeSession({ sessionId });
      if (!previous.ended) await invokeCancelAgentRuntime({ sessionId });
      await invokeArchiveAgentRuntimeSession({ sessionId });
      await invokeDeleteAgentRuntimeSession({ sessionId });
    }
    useAppStore.setState({ activeSection: 'terminal', restoreWorkspace: false });
    useAiPanelStore.getState().setOpen(true, 'workbench');
    useAiPanelStore.getState().setOpen(false, 'terminal');
    flushSync(() => root.render(<TooltipProvider><AppShell>
      <div className="relative flex min-h-0 min-w-0 flex-1">
        <FocusLayout><MainContent><NativeTerminals /></MainContent></FocusLayout><AiPanel />
      </div>
    </AppShell></TooltipProvider>));
    if (sshShell) {
      const host = await invokeCheckHostKey('127.0.0.1', 22222);
      assert(host.status === 'match' || host.status === 'notFound', 'Isolated SSH fixture host identity mismatch');
      if (host.status === 'notFound') {
        assert(host.fingerprint, 'Missing isolated fixture fingerprint');
        await invokeTrustHost('127.0.0.1', 22222, host.fingerprint);
        trustedFixture = true;
      }
    }
    for (let index = 0; index < 2; index++) {
      // Public disposable tests/ssh-e2e credentials; no saved user profile.
      const session = sshShell && index === 0 ? await invokeCreateSession({ name: 'Native jobs isolated SSH acceptance',
        host: '127.0.0.1', port: 22222, username, authMethod: 'password', password: 'shellspan-e2e', terminalCols: 100, terminalRows: 25,
      }) : await invokeCreateLocalSession(100, 25);
      terminals.push(session.sessionId);
      flushSync(() => useTerminalStore.getState().addSession(session));
    }
    await eventually(() => terminals.every(id => useTerminalStore.getState().sessions.some(
      session => session.sessionId === id && session.status === 'connected' && session.promptReady,
    )), 'Native shell integrations did not become ready', 30_000);
    const controller = terminalRegistry.get(terminals[0]);
    assert(controller, 'Missing production terminal controller');
    await controller.whenOutputReady();
    const ptyInfo = useTerminalStore.getState().sessions.find(session => session.sessionId === terminals[0])?.ptyInfo;
    rendererTransport = { ptyInfo, windowsPty: controller.terminal.options.windowsPty };
    if (powershell) {
      assert(ptyInfo?.transportKind === 'windowsConPty' && Number.isSafeInteger(ptyInfo.windowsBuildNumber), 'Missing actual backend ConPTY build metadata');
      assert(controller.terminal.options.windowsPty?.backend === 'conpty'
        && controller.terminal.options.windowsPty.buildNumber === ptyInfo.windowsBuildNumber, 'Renderer did not use the actual transport build');
    }
    geometryEvents.push({ kind: 'initial-observation', atUnixMs: Date.now(), columns: controller.terminal.cols, rows: controller.terminal.rows, outputCharacters: output.length });
    const resizeObserver = controller.terminal.onResize(({ cols, rows }) => {
      geometryEvents.push({ kind: 'actual-xterm-resize', atUnixMs: Date.now(), columns: cols, rows, outputCharacters: output.length });
    });
    disposers.push(() => resizeObserver.dispose());
    const identity = (await invokeGetTerminalBrokerSnapshot(terminals[0])).session;
    assert(identity?.integrationState === 'ready', 'Missing native integration');
    assert(!powershell || identity.integrationShell === nativeShell, 'Wrong actual PowerShell executable');
    disposers.push(controller.subscribeOutput(chunk => { output += chunk; }));
    if (focusPolling) {
      flushSync(() => useFocusStore.getState().enter());
      flushSync(() => { assert(useFocusStore.getState().setTarget(terminals[1]), 'Cannot bind production Focus target'); });
      await eventually(() => !!document.querySelector('[data-slot="focus-agent"] [data-composer-editor]'), 'Production Focus composer did not render');
    }
    const editorSelector = focusPolling ? '[data-slot="focus-agent"] [data-composer-editor]'
      : '[data-slot="ai-panel"][data-ai-scope="workbench"] [data-composer-editor]';
    let editor = focusPolling ? document.querySelector<HTMLElement>(editorSelector) : null;
    const enterDraft = async (target: HTMLElement) => {
      await eventually(() => target.isConnected && target.isContentEditable && target.getBoundingClientRect().width > 0,
        'Production composer is not visible and editable', 10000);
      target.focus();
      assert(document.activeElement === target, 'Production composer did not accept focus');
      const range = document.createRange();
      range.selectNodeContents(target);
      const selection = window.getSelection();
      assert(selection, 'Missing production draft selection');
      selection.removeAllRanges(); selection.addRange(range);
      if (powershell) {
        const response = await fetch(`/__native-composer-input/${parameters.get('token')}`, {
          method: 'POST', body: JSON.stringify({ text: 'preserve native polling draft' }),
        });
        const body = await response.text();
        assert(response.ok, `Actual user keyboard draft input failed: ${body}`);
        draftInput = JSON.parse(body);
      } else assert(document.execCommand('insertText', false, 'preserve native polling draft'), 'Cannot enter production draft');
      await eventually(() => target.innerText.trimEnd() === 'preserve native polling draft', 'Production draft input did not settle', 10000);
    };
    flushSync(() => useTerminalStore.getState().setActiveSession(focusPolling ? terminals[1] : terminals[0]));
    useAppStore.getState().setActiveSection('terminal');
    if (focusPolling) { assert(editor, 'Missing production Focus draft'); editor.focus(); }
    else controller.focus();
    if (focusPolling) {
      assert(editor, 'Missing production Focus draft'); await enterDraft(editor);
    }
    const draftText = () => editor?.innerText.trimEnd() ?? '';
    userDraftState = () => ({ connected: editor?.isConnected, editable: editor?.isContentEditable,
      focused: document.activeElement === editor, actual: draftText(), activeTag: document.activeElement?.tagName,
      section: useAppStore.getState().activeSection, width: editor?.getBoundingClientRect().width,
      height: editor?.getBoundingClientRect().height });
    const checkView = () => {
      if (monitoring && (document.activeElement !== editor || draftText() !== 'preserve native polling draft'
        || useAppStore.getState().activeSection !== (focusPolling ? 'terminal' : 'workbench')
        || focusPolling && (!useFocusStore.getState().enabled || useFocusStore.getState().targetSessionId !== terminals[1])
        || useTerminalStore.getState().activeSessionId !== terminals[1])) {
        const active = document.activeElement;
        const lease = agentTerminalLeaseState.get(terminals[0]);
        uiFailure ??= { activeTag: active?.tagName, activeLabel: active?.getAttribute('aria-label'),
          sourceTerminalFocused: active === controller.terminal.textarea,
          otherTerminalFocused: active === terminalRegistry.get(terminals[1])?.terminal.textarea,
          draftLength: draftText().length, draftMatches: draftText() === 'preserve native polling draft',
          section: useAppStore.getState().activeSection, expectedSection: focusPolling ? 'terminal' : 'workbench',
          activeSessionId: useTerminalStore.getState().activeSessionId, expectedSessionId: terminals[1],
          focusEnabled: useFocusStore.getState().enabled, focusTarget: useFocusStore.getState().targetSessionId,
          leaseOperation: lease?.operationId, leaseOwned: lease?.terminalOwned, latestEvent };
        failure ??= `Native job lease changed user view: ${JSON.stringify(uiFailure)}`;
      }
    };
    const armUserView = async () => {
      if (focusPolling || armingUserView || !firstResult || !firstRelease) return;
      armingUserView = true;
      userViewStage = 'activating-user-terminal';
      initialView = { latestEvent, section: useAppStore.getState().activeSection,
        activeSessionId: useTerminalStore.getState().activeSessionId,
        sourceFocused: document.activeElement === controller.terminal.textarea };
      // The initial explicit command may focus its terminal. Only after it
      // settles does the user choose another terminal/workspace and draft.
      flushSync(() => useTerminalStore.getState().setActiveSession(terminals[1]));
      const other = terminalRegistry.get(terminals[1]);
      assert(other?.terminal.textarea?.isConnected, 'The chosen user terminal was not attached');
      userViewStage = 'waiting-user-terminal-output';
      let outputReady = false;
      void other.whenOutputReady().then(() => { outputReady = true; }, error => { failure ??= String(error); });
      await eventually(() => outputReady, 'The chosen user terminal output did not become ready', 10000);
      userViewStage = 'opening-workbench';
      flushSync(() => useAppStore.getState().setActiveSection('workbench'));
      userViewStage = 'waiting-workbench-editor';
      await eventually(() => !!document.querySelector(editorSelector), 'Production Workbench composer did not render', 10000);
      editor = document.querySelector<HTMLElement>(editorSelector);
      assert(editor, 'Missing production Workbench draft');
      userViewStage = 'entering-workbench-draft';
      await enterDraft(editor);
      userViewStage = 'monitoring';
      monitoring = true;
      workingView = { after: latestEvent, section: useAppStore.getState().activeSection,
        activeSessionId: useTerminalStore.getState().activeSessionId, draftLength: draftText().length,
        editorFocused: document.activeElement === editor };
      checkView();
      assert(!failure, failure ?? 'User view could not be established');
      userViewReady();
      await report('Initial native command settled; user chose Workbench and another terminal. Monitoring subsequent launch/wait/stop leases.');
    };
    if (focusPolling) userViewReady();
    const captureEarlyView = async (event: Extract<AgentSessionEvent, { type: 'tool/result' }>) => {
      await new Promise<void>(resolve => controller.terminal.write('', resolve));
      const actual = renderedBuffer(controller.terminal);
      assert(actual.text.includes(marker), 'Actual target omitted background marker during native wait');
      for (const line of ['alias-ok', 'function-ok']) assert(actual.rows.some(row => row.text.trim() === line), `Actual background output line missing during wait: ${line}`);
      assert(actual.text.split('\n').some(line => /^real +Tab 'single' "double"$/.test(line.trim())), 'Actual here-string/Tab output missing during wait');
      const capturedAtUnixMs = Date.now();
      earlyViewTiming = { capturedAtUnixMs, sourceEventSeq: event.seq };
      const value = await readResult(event);
      assert(value && typeof value === 'object' && 'job' in value && value.job && typeof value.job === 'object'
        && 'nativeActive' in value.job && value.job.nativeActive === true, 'Native producer was not active at the captured wait');
      const gate = await fetch(`/__native-job-gate-proof/${parameters.get('token')}`, { method: 'POST' });
      assert(gate.ok, 'Independent completion gate was released during native wait');
      earlyViewEvidence = { beforeStopExecution: true, capturedAtUnixMs, sourceEvent: { seq: event.seq, timeUnixMs: event.timeUnixMs,
        turnId: event.turnId, stepId: event.stepId, callId: event.data.callId }, nativeActive: true, gate: await gate.json(),
        job: value.job, rendered: actual.text, displayRows: actual.rows };
    };
    disposers.push(useAppStore.subscribe(checkView), useTerminalStore.subscribe(checkView), useFocusStore.subscribe(checkView));
    document.addEventListener('focusin', checkView);
    disposers.push(() => document.removeEventListener('focusin', checkView));
    disposers.push(await listenToAgentTerminalLease(({ payload }) => {
      if (payload.agentSessionId !== agentId) return;
      leaseEvents.push(payload);
      latestEvent = { type: 'lease', operation: payload.operationId, state: payload.state };
      if (payload.state === 'acquired') operations.add(payload.operationId);
      if (payload.state === 'released') { released++; firstRelease = true; }
      void armUserView().catch(error => { failure ??= error instanceof Error ? error.message : String(error); });
      checkView();
    }));
    disposers.push(await listenToAgentRuntimeSession(({ payload }) => {
      if (payload.sessionId !== agentId) return;
      latestEvent = { type: payload.type, seq: payload.seq };
      if (payload.type === 'request/failure') failure ??= `Real model request failed: ${payload.data.failure.kind}`;
      if (payload.type === 'tool/approval') {
        approvalEvidence.push({ callId: payload.data.callId, status: payload.data.status, seq: payload.seq, turnId: payload.turnId, stepId: payload.stepId });
        if (payload.data.status === 'requested') {
          const { approvalId, callId, requestId } = payload.data;
          const { turnId, stepId } = payload;
          assert(approvalId && turnId && stepId, 'Incomplete real approval identity');
          const decision = { sessionId: agentId, approvalId, callId, requestId, turnId, stepId };
          void (async () => {
            // Only ephemeral payloads use the private argument endpoint;
            // ordinary terminal calls retain approved arguments in tool/call.
            const args = await invokeGetPendingAgentRuntimeApprovalArguments(decision)
              ?? calls.find(event => event.turnId === turnId && event.stepId === stepId && event.data.call.callId === callId)?.data.call.arguments;
            assert(args && typeof args === 'object', 'Approval arguments unavailable');
            const completed = await Promise.all(results.map(readResult));
            const handles = completed.flatMap(value => value && typeof value === 'object'
              && 'processHandle' in value && typeof value.processHandle === 'string' ? [value.processHandle] : []);
            assert(('command' in args && typeof args.command === 'string' && allowedCommands.has(args.command))
              || ('processHandle' in args && typeof args.processHandle === 'string' && handles.includes(args.processHandle)),
            `Approval escaped the exact test commands or native job: ${JSON.stringify({ callId, command: 'command' in args ? args.command : undefined, processHandle: 'processHandle' in args ? args.processHandle : undefined, handles })}`);
            if (!focusPolling && 'command' in args && typeof args.command === 'string' && args.command.includes('SHELLSPAN_END')) await userView;
            await invokeApproveAgentRuntimeTool(decision);
          })().catch(error => { failure ??= error instanceof Error ? error.message : String(error); });
        }
      }
      if (payload.type === 'tool/call') calls.push(payload);
      if (payload.type === 'tool/execution') executions.push(payload);
      if (payload.type === 'tool/result') {
        results.push(payload);
        if (results.length === 1 && payload.data.status === 'completed') firstResult = true;
        void armUserView().catch(error => { failure ??= error instanceof Error ? error.message : String(error); });
        if (payload.data.name === 'wait_process' && output.includes(marker)) earlyOutput = true;
        if (powershell && payload.data.name === 'wait_process' && !earlyViewPromise) {
          earlyViewPromise = captureEarlyView(payload).catch(error => { failure ??= error instanceof Error ? error.message : String(error); });
        }
        if (payload.data.status !== 'completed') failure ??= `Native model tool failed: ${payload.data.name} ${payload.data.status}: ${payload.data.summary}`;
      }
      if (payload.type === 'turn/end') ended = true;
      checkView();
    }));
    marker = powershell ? parameters.get('outputMarker') ?? '' : `native-jobs-${crypto.randomUUID()}`;
    assert(marker.startsWith('native-jobs-'), 'Missing independent output marker');
    const setup = powershell
      ? `Set-Location -LiteralPath $env:SHELLSPAN_NATIVE_WORKSPACE; function global:shellspan_acceptance_alias_target { 'alias-ok' }; Set-Alias -Scope Global shellspan_acceptance_alias shellspan_acceptance_alias_target; function global:shellspan_acceptance_function { 'function-ok' }`
      : `export SHELLSPAN_ACCEPTANCE='${marker.slice(0, 18)}''${marker.slice(18)}'; alias shellspan_acceptance_alias='printf %s%s alias -ok; echo'; shellspan_acceptance_function() { printf %s%s function -ok; echo; }`;
    const script = powershell
      ? `Write-Output $env:SHELLSPAN_ACCEPTANCE\nWrite-Output (Get-Location).Path\nshellspan_acceptance_alias\nshellspan_acceptance_function\n@'\nreal\tTab 'single' "double"\nSHELLSPAN_END\n'@\nwhile (-not [IO.File]::Exists($env:SHELLSPAN_NATIVE_COMPLETION_GATE)) { Start-Sleep -Milliseconds 25 }`
      : `printf '%s\\n' "$SHELLSPAN_ACCEPTANCE"\npwd\nshellspan_acceptance_alias\nshellspan_acceptance_function\ncat <<'SHELLSPAN_END'\nreal\tTab\nSHELLSPAN_END\nsleep 60`;
    const finalCommand = powershell ? 'cmd.exe /d /c exit 7' : '(exit 7)';
    for (const command of [setup, script, finalCommand]) allowedCommands.add(command);
    const goal = `Execute exactly this sequence using the bound visible terminal. Do not use Direct, extra tools, change source or retry. run_terminal_command accepts only command, explanation, background, timeoutMs and lifecycleTrust; nativeScriptInput/nativeJobControl are observed capabilities, never argument fields. 1. run_terminal_command command=${JSON.stringify(setup)}. 2. run_terminal_command background=true command=${JSON.stringify(script)}. 3. On the returned job-* handle call wait_process three separate times sequentially with timeoutMs=1000. 4. kill_process with signal=terminate timeoutMs=10000. 5. run_terminal_command command=${JSON.stringify(finalCommand)}. Then reply done. Job output is sharedTerminal, never isolated stdout.`;
    await invokeCreateAgentRuntimeSession({ sessionId: agentId, taskId: agentId, goal,
      executionSurface: 'boundTerminal', permissionMode: 'requestApproval',
      target: { kind: sshShell ? 'remote' : 'local', targetId: `terminal-${terminals[0]}`, sessionId: terminals[0],
        ...(sshShell ? { host: '127.0.0.1', port: 22222, username } : { cwd: identity.currentDirectory ?? undefined }) },
      capabilityScope: { toolNames: ['run_terminal_command', 'wait_process', 'kill_process', 'write_process_input'],
        effects: ['none', 'readOnly', 'stateChange', 'externalSideEffect'], targetIds: [`terminal-${terminals[0]}`] },
    });
    created = true;
    await invokeStartAgentRuntime({ sessionId: agentId, selection });
    monitoring = focusPolling;
    await report(`Native jobs: real model ${selection.routeId}/${selection.modelId}, shell=${identity.integrationShell}; executing complete script and repeated wait/kill leases`);
    const messageId = crypto.randomUUID();
    await invokeAgentRuntimeFollowup({ sessionId: agentId, messageId, clientSubmissionId: messageId, content: goal });
    await eventually(() => { assert(!failure, failure ?? 'Native acceptance failed'); return ended; }, 'Real model turn did not end');
    assert(results.length === 7 && calls.length === 7, `Expected seven actual tools, got ${calls.length}/${results.length}`);
    assert(focusPolling || workingView, 'Repeated management was not observed after the user view boundary');
    assert(calls.filter(event => event.data.call.name === 'wait_process').length === 3, 'Missing three real job observations');
    assert(calls.filter(event => event.data.call.name === 'run_terminal_command').every(event => event.data.call.nativeName === 'terminal_execute'), 'Visible execution bypassed terminal_execute');
    const data = await Promise.all(results.map(readResult));
    if (powershell) {
      assert(earlyViewPromise, 'No actual pre-stop view inspection was started');
      await earlyViewPromise;
      assert(!failure, failure ?? 'Actual pre-stop view inspection failed');
      const stop = results[5];
      const execution = executions.find(event => event.turnId === stop.turnId && event.stepId === stop.stepId && event.data.callId === stop.data.callId);
      assert(earlyViewTiming && execution && earlyViewTiming.sourceEventSeq < execution.seq
        && earlyViewTiming.capturedAtUnixMs < execution.timeUnixMs, 'Actual cells were not captured before native stop execution');
      earlyViewEvidence = { ...earlyViewEvidence, stopExecution: { seq: execution.seq, timeUnixMs: execution.timeUnixMs } };
    }
    const launched = data[1];
    assert(launched && typeof launched === 'object' && 'processHandle' in launched
      && typeof launched.processHandle === 'string' && launched.processHandle.startsWith('job-'), 'No native job handle');
    assert('job' in launched && launched.job && typeof launched.job === 'object', 'Missing actual launched job binding');
    const launchedJob = launched.job as Record<string, unknown>;
    const bindingKeys = ['processHandle', 'terminalSessionId', 'terminalGeneration', 'transportSessionId', 'ownerTargetId', 'agentSessionId', 'taskId', 'operationId'];
    for (const value of data.slice(2,6)) {
      assert(value && typeof value === 'object' && 'job' in value && value.job && typeof value.job === 'object', 'Missing actual observed job binding');
      const observed = value.job as Record<string, unknown>;
      for (const key of bindingKeys) assert(key in launchedJob && key in observed && launchedJob[key] === observed[key], `Native job binding changed: ${key}`);
    }
    if (powershell) {
      assert(earlyViewEvidence?.job && typeof earlyViewEvidence.job === 'object' && earlyViewTiming, 'Missing captured opaque job binding');
      const capturedJob = earlyViewEvidence.job as Record<string, unknown>;
      const capturedTime = earlyViewTiming.capturedAtUnixMs;
      for (const key of bindingKeys) assert(key in capturedJob && capturedJob[key] === launchedJob[key], `Captured view belongs to another native job: ${key}`);
      const following = data.slice(3,5).find(value => {
        if (!value || typeof value !== 'object' || !('job' in value) || !value.job || typeof value.job !== 'object') return false;
        const observed = value.job as Record<string, unknown>;
        return observed.nativeActive === true && typeof observed.observationRevision === 'number'
          && typeof capturedJob.observationRevision === 'number' && observed.observationRevision > capturedJob.observationRevision
          && typeof observed.observedAtUnixMs === 'number' && observed.observedAtUnixMs > capturedTime;
      });
      assert(following && typeof following === 'object' && 'job' in following, 'No newer real same-job active observation followed the actual cell capture');
      earlyViewEvidence = { ...earlyViewEvidence, followingActiveObservation: following.job };
    }
    for (const value of [data[0], launched, data[6]]) {
      assert(value && typeof value === 'object' && 'channel' in value && value.channel === 'terminal'
        && 'terminalSessionId' in value && value.terminalSessionId === identity.terminalSessionId
        && 'terminalGeneration' in value && value.terminalGeneration === identity.terminalGeneration
        && 'operationId' in value && typeof value.operationId === 'string' && operations.has(value.operationId),
      `Tool result does not belong to the actual leased PTY: ${JSON.stringify({ expected: { terminalSessionId: identity.terminalSessionId, generation: identity.terminalGeneration }, actual: value && typeof value === 'object' ? { keys: Object.keys(value), channel: 'channel' in value ? value.channel : undefined, terminalSessionId: 'terminalSessionId' in value ? value.terminalSessionId : undefined, generation: 'terminalGeneration' in value ? value.terminalGeneration : undefined, operationId: 'operationId' in value ? value.operationId : undefined } : typeof value, operations: [...operations] })}`);
    }
    for (const value of data.slice(2, 6)) {
      assert(value && typeof value === 'object' && 'outputScope' in value && value.outputScope === 'sharedTerminal'
        && 'stdout' in value && value.stdout === '' && 'stderr' in value && value.stderr === '', 'Job management fabricated isolated output');
    }
    const last = data[6];
    assert(last && typeof last === 'object' && 'exitCode' in last && last.exitCode === 7, 'Nonzero exit was not preserved');
    assert(output.includes(marker) && output.includes('alias-ok') && output.includes('function-ok'), 'Real shared PTY output/state inheritance missing');
    assert(earlyOutput, 'Background output did not arrive during wait before stop');
    assert(operations.size >= 7 && released === operations.size, 'Native lifecycle did not release all actual leases');
    assert(approvalEvidence.some(event => event.status === 'requested') && approvalEvidence.some(event => event.status === 'approved'), 'Real approval chain was not exercised');
    const stopped = data[5];
    if (powershell) for (const value of data.slice(2,5)) {
      assert(value && typeof value === 'object' && 'job' in value && value.job && typeof value.job === 'object'
        && 'nativeActive' in value.job && value.job.nativeActive === true, 'Completion-gated native worker did not stay active during early output/waits');
    }
    assert(stopped && typeof stopped === 'object' && 'stopRequested' in stopped && stopped.stopRequested === true
      && 'job' in stopped && stopped.job && typeof stopped.job === 'object' && 'nativeActive' in stopped.job
      && stopped.job.nativeActive === false && 'controlLost' in stopped.job && stopped.job.controlLost === false, 'Native job stop was not confirmed on its original binding');
    checkView();
    assert(!failure, failure ?? 'View changed');
    let directEvidence: Record<string, unknown> | undefined;
    if (parameters.get('directLifecycle') === 'true') {
      const settled = await invokeGetAgentRuntimeSession({ sessionId: agentId });
      assert(settled.status === 'idle' && !settled.ended, 'Explicit Direct switch requires the actual settled native conversation');
      await invokeSetAgentRuntimeExecutionSurface({ sessionId: agentId, surface: 'direct' });
      const directSource = powershell ? `$value=[Console]::ReadLine(); [Console]::WriteLine('received:'+$value)` : `read -r value; printf 'received:%s\\n' "$value"`;
      const directSleep = powershell ? 'Start-Sleep -Seconds 60' : 'sleep 60';
      allowedCommands.add(directSource); allowedCommands.add(directSleep);
      const offset = results.length;
      ended = false;
      const directGoal = `The user explicitly switched this session to Direct. Make exactly FIVE tool calls in this order: (1) run_terminal_command background=true command=${JSON.stringify(directSource)}; (2) write_process_input on its proc-* handle with input="direct-stdin\\n"; (3) wait_process timeoutMs=10000 on that first handle; (4) run_terminal_command background=true command=${JSON.stringify(directSleep)}; (5) kill_process signal=terminate timeoutMs=10000 on the second handle. kill_process already waits for termination and retires that handle. After call 5 immediately reply done. NEVER call wait_process after kill_process, never add a sixth call, and never retry a retired handle.`;
      const id = crypto.randomUUID();
      await invokeAgentRuntimeFollowup({ sessionId: agentId, messageId: id, clientSubmissionId: id, content: directGoal });
      await eventually(() => { assert(!failure, failure ?? 'Direct lifecycle failed'); return ended; }, 'Real Direct model turn did not end');
      const directResults = results.slice(offset);
      assert(directResults.length === 5, `Expected five Direct tools, got ${directResults.length}`);
      const processData = await readResult(directResults[0]);
      assert(processData && typeof processData === 'object' && 'processHandle' in processData
        && typeof processData.processHandle === 'string' && processData.processHandle.startsWith('proc-'), 'Direct did not preserve proc-* handles');
      const waited = await readResult(directResults[2]);
      assert(waited && typeof waited === 'object' && 'stdout' in waited && typeof waited.stdout === 'string'
        && waited.stdout.includes('received:direct-stdin') && 'exitCode' in waited && waited.exitCode === 0, 'Direct stdin/wait did not preserve structured real output');
      directEvidence = { surface: 'direct', processHandle: processData.processHandle,
        calls: calls.slice(7), results: directResults, structuredStdinOutput: waited.stdout, exitCode: waited.exitCode };
      await report('Explicit Direct verified: five real tools, proc-* handles, stdin, structured output/exit 0 and terminate preserved.');
    }
    checkView();
    assert(!failure, failure ?? 'View changed before explicit user review');
    for (const requested of approvalEvidence.filter(event => event.status === 'requested')) {
      const sameCall = (event: { callId: string; turnId?: string; stepId?: string }) => event.callId === requested.callId && event.turnId === requested.turnId && event.stepId === requested.stepId;
      const approved = approvalEvidence.find(event => sameCall(event) && event.status === 'approved');
      const dispatched = executions.find(event => sameCall({ callId: event.data.callId, turnId: event.turnId, stepId: event.stepId }));
      const result = results.find(event => sameCall({ callId: event.data.callId, turnId: event.turnId, stepId: event.stepId }));
      assert(approved && dispatched && result && requested.seq < approved.seq && approved.seq < dispatched.seq
        && dispatched.seq < result.seq, 'Requested approval did not precede the actual execution/result in its original turn and step');
    }
    const preservedDraft = draftText();
    const monitoredGeometry = { columns: controller.terminal.cols, rows: controller.terminal.rows };
    if (powershell) {
      // All model operations and strict view monitoring finish before the
      // explicit user review. Calibrate cells at this final visible geometry.
      monitoring = false;
      flushSync(() => {
        if (useFocusStore.getState().enabled) assert(useFocusStore.getState().setTarget(terminals[0]), 'Cannot explicitly review the actual Focus source');
        useAppStore.getState().setActiveSection('terminal');
        useTerminalStore.getState().setActiveSession(terminals[0]);
      });
      await controller.whenOutputReady(); controller.focus();
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      await eventually(async () => {
        const current = (await invokeGetTerminalBrokerSnapshot(terminals[0])).session;
        return current?.geometry.columns === controller.terminal.cols && current.geometry.rows === controller.terminal.rows;
      }, 'Actual source geometry did not settle for native review', 10000);
    }
    // Empty write is a parser-queue barrier, never a supplemental display byte.
    await new Promise<void>(resolve => controller.terminal.write('', resolve));
    const display = renderedBuffer(controller.terminal);
    const rendered = display.text;
    for (const text of [marker, 'alias-ok', 'function-ok', 'SHELLSPAN_END', powershell ? 'SHELLSPAN_NATIVE_COMPLETION_GATE' : 'sleep 60']) {
      assert(rendered.includes(text), `Target xterm omitted actual source/output text: ${text}`);
    }
    const job = 'job' in launched ? launched.job : undefined;
    assert(job && typeof job === 'object' && 'commandLine' in job && job.commandLine === script
      && 'submittedCommandLine' in job && typeof job.submittedCommandLine === 'string'
      && 'acceptedCommandLine' in job && job.acceptedCommandLine === job.submittedCommandLine
      && 'submittedCommandLine' in launched && launched.submittedCommandLine === job.submittedCommandLine,
    'Approved source and the complete native accepted line did not retain their exact production binding');
    // A job id can itself cross a native hard wrap after a long prompt. Locate
    // the final command start; the full id and every later cell are compared.
    const prefix = powershell ? job.acceptedCommandLine.slice(0,100) : '__shellspan_job_validate';
    const origin = sourcePosition(controller.terminal, prefix, powershell);
    assert(origin, 'Actual accepted source was not found in the target cell grid');
    const columns = controller.terminal.cols;
    const terminalRows = controller.terminal.rows;
    const proof = await fetch(`/__native-editor-layout/${parameters.get('token')}`, { method: 'POST', body: JSON.stringify({
      shell: identity.integrationShell, acceptedLine: job.acceptedCommandLine, columns, rows: terminalRows, prefixColumns: origin.column,
    }) });
    assert(proof.ok, `Native editor layout proof failed: ${await proof.clone().text()}`);
    const layout = await proof.json() as { rawBase64: string; trace: string; metadata: {
      kind: string; sourceSha256: string; nativeBufferSha256: string;
    } };
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(job.acceptedCommandLine as string));
    const expectedDigest = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    assert(layout.metadata.kind === 'native-editor-layout-only-no-source-execution'
      && layout.metadata.sourceSha256 === expectedDigest && layout.metadata.nativeBufferSha256 === expectedDigest,
    'Native layout editor did not consume the exact accepted bytes');
    assert(controller.terminal.cols === columns && controller.terminal.rows === terminalRows, 'Target geometry changed during native layout proof');
    // This separate native editor never accepts or executes source. Its real
    // ZLE/Readline drawing supplies row/cell boundaries, including hard wraps.
    const reference = new Terminal({ cols: columns, rows: terminalRows, scrollback: 20000 });
    const sourceCells: { row: number; column: number; expected: string; actual: string | undefined }[] = [];
    layoutEvidence = { trace: layout.trace, metadata: layout.metadata, origin, columns, rows: terminalRows, sourceCells };
    try {
      const bytes = Uint8Array.from(atob(layout.rawBase64), char => char.charCodeAt(0));
      await new Promise<void>(resolve => reference.write(bytes, resolve));
      const start = sourcePosition(reference, prefix, powershell);
      assert(start && start.column === origin.column, 'Native reference did not retain the actual prompt origin');
      const end = reference.buffer.active.baseY + reference.buffer.active.cursorY;
      for (let row = start.row; row <= end; row++) {
        const column = row === start.row ? start.column : 0;
        const expected = reference.buffer.active.getLine(row)!.translateToString(true, column);
        const actualRow = origin.row + row - start.row;
        const actual = controller.terminal.buffer.active.getLine(actualRow)?.translateToString(false, column, column + expected.length);
        sourceCells.push({ row: actualRow, column, expected, actual });
        assert(actual === expected, `Actual target source cells differ at row=${actualRow} column=${column}: ${JSON.stringify({ expected, actual })}`);
      }
    } finally { reference.dispose(); }
    await report(`Native jobs verified: seven real tools, ${operations.size} leases released, requestApproval, shell=${identity.integrationShell}, focusPolling=${focusPolling}, draft/focus preserved, native stop confirmed and exit 7 retained.`);
    const evidence = { runId:parameters.get('runId') ?? undefined, selection, permissionMode: 'requestApproval', focusPolling, initialView, workingView,
        leases: operations.size, released, leaseEvents, artifacts: [...artifactEvidence.values()], draftInput, draftPreserved: preservedDraft, draftSurface: focusPolling ? 'productionFocusComposer' : 'productionWorkbenchComposer',
        shell: identity.integrationShell, transport: identity.transportKind,
        terminalSessionId: identity.terminalSessionId, generation: identity.terminalGeneration,
        approvedSource: script, nativeLayout: { trace: layout.trace, metadata: layout.metadata, sourceCells }, rendered, displayRows: display.rows, rawOutput: output,
        geometry: { columns: controller.terminal.cols, rows: controller.terminal.rows }, earlyOutput, earlyViewEvidence, approvalEvidence, executions,
        calls: calls.slice(0,7).map(event => ({ seq: event.seq, turnId: event.turnId, stepId: event.stepId, call: event.data.call })),
        results: results.slice(0,7).map((event, index) => ({ seq: event.seq, turnId: event.turnId, stepId: event.stepId, status: event.data.status, data: data[index] })),
        direct: directEvidence, monitoredGeometry, geometryEvents, rendererTransport,
    };
    const finalEvidence: Record<string,unknown> = evidence;
    await fetch(`/__agent-stream-result/${parameters.get('token')}`, { method: 'POST', body: JSON.stringify({
      progress: 'Native target xterm retains the complete source and real early output; native cell evidence saved.', evidence,
    }) });
    if (powershell) {
      await getCurrentWindow().show();
      await getCurrentWindow().setFocus();
      controller.terminal.scrollToLine(origin.row);
      await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
      const windowProof=await fetch(`/__native-window-evidence/${parameters.get('token')}`,{method:'POST'});
      assert(windowProof.ok,`Owned native desktop capture failed: ${await windowProof.clone().text()}`);
      const windowEvidence:unknown=await windowProof.json();
      await fetch(`/__agent-stream-result/${parameters.get('token')}`,{method:'POST',body:JSON.stringify({
        progress:'Model and view contracts complete; explicit user review captured the actual source terminal window.',
        evidence:{...finalEvidence,windowEvidence,reviewView:{activeSessionId:useTerminalStore.getState().activeSessionId,explicitAfterAllModelOperations:true}},
      })});
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const fullResults = await Promise.allSettled(results.map(readResult));
    const controller = terminals[0] ? terminalRegistry.get(terminals[0]) : undefined;
    const display = controller ? renderedBuffer(controller.terminal) : undefined;
    await fetch(`/__agent-stream-result/${parameters.get('token')}`, { method: 'POST', body: JSON.stringify({
      progress: 'Native acceptance failed; preserving actual call/result and xterm diagnostics before cleanup.',
      evidence: { failed: true, reason, selection, focusPolling, sshShell, calls, executions, approvalEvidence,
        results: results.map((event, index) => ({ event, full: fullResults[index] })), rendered: display?.text,
        displayRows: display?.rows, rawOutput: output, nativeLayout: layoutEvidence, earlyViewEvidence, uiFailure, initialView, workingView, geometryEvents, rendererTransport,
        preparation: { stage: userViewStage, firstResult, firstRelease, armingUserView, draft: userDraftState?.(), draftInput },
        broker: terminals[0] ? await invokeGetTerminalBrokerSnapshot(terminals[0]) : undefined },
    }) });
    throw error;
  } finally {
    monitoring = false;
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
        try { await invokeCloseSession(id); } finally { terminalRegistry.dispose(id); }
      }));
      for (const result of closed) if (result.status === 'rejected') throw result.reason;
      if (trustedFixture) await invokeRemoveKnownHost('127.0.0.1', 22222);
    }
  }
}
void verify().then(() => ({ ok: true }), (error: unknown) => ({ ok: false,
  error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error),
})).then(result => fetch(`/__agent-stream-result/${new URL(location.href).searchParams.get('token')}`,
  { method: 'POST', body: JSON.stringify(result) }));
