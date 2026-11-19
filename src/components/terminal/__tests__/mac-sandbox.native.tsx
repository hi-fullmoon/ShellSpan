import { getCurrentWindow } from '@tauri-apps/api/window';
import { createRoot } from 'react-dom/client';
import { AiSettingsSection } from '@/components/ai/ai-settings-section';
import { AgentExecutionSurfaceSelector } from '@/components/ai/agent-execution-surface-selector';
import { AgentPermissionSelector } from '@/components/ai/agent-permission-selector';
import { AiApprovalPanel } from '@/components/ai/workspace/ai-approval-panel';
import { TooltipProvider } from '@/components/ui/tooltip';
import { agentSessionView } from '@/lib/ai/agent-session-adapter';
import {
  invokeCancelAgentRuntime, invokeCreateAgentRuntimeSession, invokeCreateLocalSession,
  invokeDecideTerminalAcceptanceCommand, invokeGetAgentRuntimeEvents, invokeGetAgentRuntimeSession,
  invokeInspectAgentRuntimeRecovery, invokeListAiRoutes, invokeLoadPreferences,
  invokeRunTerminalAcceptanceCommand, invokeSetAgentRuntimeExecutionSurface, type TerminalAcceptanceSourceKind,
} from '@/lib/ipc/tauri';
import { initI18n, t } from '@/locales';
import { useAiSettingsStore } from '@/stores/aiSettingsStore';
import { useAppStore } from '@/stores/appStore';
import { useTerminalStore } from '@/stores/terminalStore';
import type { AgentSessionEvent, AgentSessionPermissionMode } from '@/types/agent-session';
import '@/styles/base.css';
import '@/components/ai/styles/styles.css';

declare const __SANDBOX_ACCEPTANCE_ENDPOINT__: string;
type ToolResult = Extract<AgentSessionEvent, { type: 'tool/result' }>['data'];
type Case = { sessionId: string; callId: string; kind: TerminalAcceptanceSourceKind; result?: ToolResult };
type Phase = 'execute' | 'replay' | 'cut-before' | 'replay-before' | 'cut-after' | 'replay-after' | 'repeat';
type HostConfig = { home: string; phase: Phase; previous: Case[] };
type Witness = { content: string | null; running: boolean };
type Guard = { protected: boolean; phase: { phase: string } | null; beforeReady: boolean; afterReady: boolean };

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

async function host<T>(route: string, body?: unknown): Promise<T> {
  const response = await fetch(`${__SANDBOX_ACCEPTANCE_ENDPOINT__}/${route}`, body === undefined ? undefined : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert(response.ok, `${route}: ${response.status}`);
  return response.json();
}

async function until<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out: ${label}`);
}

const events = async (sessionId: string) => (await invokeGetAgentRuntimeEvents({ sessionId, limit: 500 })).events;
const results = (history: readonly AgentSessionEvent[], callId: string) => history.flatMap((event) =>
  event.type === 'tool/result' && event.data.callId === callId ? [event.data] : []);
const artifact = (name: string) => host<Witness>(`witness?name=${encodeURIComponent(name)}`);
const readGuard = () => host<Guard>('guard');
const dispatched = (history: readonly AgentSessionEvent[], record: Case) =>
  history.some((event) => event.type === 'tool/execution'
    && event.data.callId === record.callId && event.data.status === 'dispatched');

function approve(record: Case, history: readonly AgentSessionEvent[]) {
  const approval = history.find((event) => event.type === 'tool/approval'
    && event.data.callId === record.callId && event.data.status === 'requested');
  assert(approval?.type === 'tool/approval' && approval.turnId && approval.stepId && approval.data.approvalId,
    'A real pending approval is required');
  return invokeDecideTerminalAcceptanceCommand({
    sessionId: record.sessionId, turnId: approval.turnId, stepId: approval.stepId,
    requestId: approval.data.requestId, callId: record.callId, approvalId: approval.data.approvalId,
  }, true);
}

async function verifySandboxApproval(
  record: Case,
  snapshot: Awaited<ReturnType<typeof invokeGetAgentRuntimeSession>>,
  history: readonly AgentSessionEvent[],
) {
  const approval = agentSessionView({ snapshot, events: history, hasTerminalEvent: false }).pendingApproval;
  assert(approval?.commandSandbox === 'local', 'Committed native approval did not project its sandbox');
  const section = document.createElement('section');
  section.className = 'ai-panel-shell @container/ai-workspace';
  document.body.append(section);
  const root = createRoot(section);
  try {
    for (const [locale, width] of [['zh-CN', 360], ['en-US', 760]] as const) {
      section.style.width = `${width}px`;
      await initI18n(locale);
      useAppStore.setState({ locale });
      root.render(<AiApprovalPanel approval={approval} decision={null} error={null}
        onApprove={() => { void approve(record, history); }}
        onReject={() => { throw new Error('The test only observes the pending approval'); }} />);
      const note = await until(async () => {
        const current = section.querySelector<HTMLElement>('[role=note]');
        return current?.textContent?.includes(t('ai.workspace.approval.localSandboxImpact')) ? current : undefined;
      }, `Sandbox approval copy at ${width}px in ${locale}`);
      assert(!note.textContent?.includes(t('ai.workspace.approval.unsandboxedImpact')),
        'Sandboxed command received the unsandboxed warning');
      assert(note.scrollWidth <= note.clientWidth, 'The approval impact overflows horizontally');
    }
  } finally {
    root.unmount();
    section.remove();
    await initI18n('zh-CN');
    useAppStore.setState({ locale: 'zh-CN' });
  }
}

async function submitCase(home: string, terminalId: string, kind: TerminalAcceptanceSourceKind,
  permissionMode: AgentSessionPermissionMode) {
  document.getElementById('test')!.textContent = kind;
  const record: Case = { kind, sessionId: `phase3-submission-${crypto.randomUUID()}`, callId: crypto.randomUUID() };
  const target = { kind: 'local' as const, targetId: `terminal-${terminalId}`,
    sessionId: terminalId, cwd: home, localRoot: home };
  await invokeCreateAgentRuntimeSession({
    sessionId: record.sessionId, taskId: record.sessionId, target,
    goal: 'Exercise approval for an isolated Direct sandbox command',
    permissionMode, executionSurface: 'direct',
    capabilityScope: { toolNames: ['run_terminal_command'], effects: ['stateChange', 'readOnly', 'sensitiveRead', 'externalSideEffect'],
      targetIds: [target.targetId] },
  });
  const prepared = await invokeRunTerminalAcceptanceCommand(record.sessionId, record.callId, kind);
  return { record, prepared };
}

async function verifyOperatorPermissionCopy(terminalId: string, sandboxEnabled: boolean) {
  const section = document.createElement('section');
  section.className = 'ai-panel-shell @container/ai-workspace';
  document.body.append(section);
  const root = createRoot(section);
  try {
    for (const [locale, width] of [['zh-CN', 360], ['en-US', 760]] as const) {
      section.style.width = `${width}px`;
      await initI18n(locale);
      useAppStore.setState({ locale });
      root.render(<AgentPermissionSelector sessionId={terminalId} variant="composer"
        localDirectSandboxEnabled={sandboxEnabled} />);
      const trigger = await until(async () => section.querySelector('button') ?? undefined, 'Permission trigger');
      trigger.click();
      const fullAccess = await until(async () => [...document.querySelectorAll<HTMLElement>('.ai-permission-menu [role=menuitemradio]')]
        .find((option) => option.textContent?.startsWith(t('agent.permission.composer.fullAccess'))),
      'Full access option');
      assert(fullAccess.textContent?.includes(t(sandboxEnabled
        ? 'agent.permission.sandboxedFullAccessDescription' : 'agent.permission.composer.fullAccessDescription')),
      `Unexpected permission description for ${locale}`);
      const menu = fullAccess.closest<HTMLElement>('.ai-permission-menu');
      assert(menu && menu.scrollWidth <= menu.clientWidth, `Permission menu overflows in ${locale}`);
      fullAccess.click();
      const dialog = await until(async () => document.querySelector<HTMLElement>('[role=alertdialog]') ?? undefined,
        'Full access confirmation');
      const warning = dialog.querySelector<HTMLElement>('[data-slot=alert-dialog-description]');
      assert(warning?.textContent === t(sandboxEnabled
        ? 'agent.permission.sandboxedFullAccessWarning' : 'agent.permission.fullAccessWarning'),
      `Unexpected confirmation description for ${locale}`);
      assert(warning.scrollWidth <= warning.clientWidth, `Confirmation overflows in ${locale}`);
      const cancel = dialog.querySelector<HTMLElement>('[data-slot=alert-dialog-cancel]');
      assert(cancel, 'Full access confirmation must remain cancellable');
      cancel.click();
      await until(async () => !document.querySelector('[role=alertdialog]') ? true : undefined, 'Closed confirmation');
    }
  } finally {
    root.unmount();
    section.remove();
    await initI18n('zh-CN');
    useAppStore.setState({ locale: 'zh-CN' });
  }
}

async function verifyDirectOnly(home: string, terminalId: string) {
  const section = document.createElement('section');
  document.body.append(section);
  const root = createRoot(section);
  try {
    for (const [locale, width] of [['zh-CN', 360], ['en-US', 760]] as const) {
      section.style.width = `${width}px`;
      await initI18n(locale);
      useAppStore.setState({ locale });
      root.render(<TooltipProvider><AgentExecutionSurfaceSelector surface="direct"
        realTerminalState="ready" sandboxDirectOnly="local" /></TooltipProvider>);
      const trigger = await until(async () => section.querySelector('button') ?? undefined, 'Execution surface trigger');
      trigger.click();
      const visible = await until(async () => [...document.querySelectorAll<HTMLElement>('.ai-execution-surface-menu [role=menuitemradio]')]
        .find((option) => option.textContent?.startsWith(t('agent.executionSurface.v1.visibleCommand'))),
      'Visible command option');
      const menu = visible.closest<HTMLElement>('.ai-execution-surface-menu');
      assert(visible.getAttribute('aria-disabled') === 'true'
        && visible.getAttribute('aria-description') === t('ai.error.localSandboxDirectRequired')
        && menu && menu.scrollWidth <= menu.clientWidth, `Invalid sandbox restriction in ${locale}`);
      visible.click();
      assert(trigger.getAttribute('data-execution-surface') === 'direct', 'Visible command was selected');
      trigger.click();
      await until(async () => document.querySelector('.ai-execution-surface-menu') ? undefined : true, 'Closed execution menu');
    }
  } finally {
    root.unmount();
    section.remove();
    await initI18n('zh-CN');
    useAppStore.setState({ locale: 'zh-CN' });
  }

  const sessionId = `phase3-submission-${crypto.randomUUID()}`;
  const request = {
    sessionId, taskId: sessionId, goal: 'Validate the execution surface',
    target: { kind: 'local' as const, targetId: `terminal-${terminalId}`, sessionId: terminalId, cwd: home },
    permissionMode: 'requestApproval' as const,
  };
  const rejection = (operation: Promise<unknown>) => operation.then(() => '', String);
  assert((await rejection(invokeCreateAgentRuntimeSession({ ...request, executionSurface: 'boundTerminal' })))
    .includes('MAC_SANDBOX_PREVIEW_DIRECT_ONLY'), 'A visible sandbox session could be created');
  await invokeCreateAgentRuntimeSession({ ...request, executionSurface: 'direct' });
  assert((await rejection(invokeSetAgentRuntimeExecutionSurface({ sessionId, surface: 'boundTerminal' })))
    .includes('MAC_SANDBOX_PREVIEW_DIRECT_ONLY'), 'An existing sandbox session switched to visible execution');
  assert((await invokeGetAgentRuntimeSession({ sessionId })).header.executionSurface === 'direct',
    'The rejected change altered the saved execution surface');
}

async function verifyOperatorCommands(home: string, terminalId: string) {
  for (const kind of ['sandbox-operator-write', 'sandbox-operator-outside-read'] as const) {
    const { record, prepared } = await submitCase(home, terminalId, kind, 'operator');
    assert(prepared.settlement === 'Completed' && prepared.modelAvailability === 'MODEL_SELECTION_REQUIRED',
      `Expected ${kind} to settle without manual approval`);
    const history = await events(record.sessionId);
    const approvals = history.filter((event) => event.type === 'tool/approval' && event.data.callId === record.callId);
    assert(approvals.length === 1 && approvals[0].type === 'tool/approval'
      && approvals[0].data.status === 'approved' && approvals[0].data.reason === 'nativePolicyAutoApproved',
    `Unexpected approval path for ${kind}`);
    const settled = results(history, record.callId);
    assert(settled.length === 1 && dispatched(history, record), `Expected one dispatch and result for ${kind}`);
    const result = settled[0];
    const data = result.data as Record<string, unknown> | undefined;
    assert(data?.sandbox === 'nonoMacAcceptance' && data.started === true, JSON.stringify(result));
    if (kind === 'sandbox-operator-write') {
      assert(data.exitCode === 0 && (await artifact(`exit-${record.callId}`)).content === 'entered', JSON.stringify(result));
    } else {
      assert(data.exitCode === 1 && typeof data.stderr === 'string' && data.stderr.includes('Operation not permitted'),
        JSON.stringify(result));
    }
    await host('progress', { kind, result });
  }
}

async function prepareCase(home: string, terminalId: string, kind: TerminalAcceptanceSourceKind,
  permissionMode: 'requestApproval' | 'scopedAutopilot' = 'requestApproval') {
  const { record, prepared } = await submitCase(home, terminalId, kind, permissionMode);
  assert(prepared.settlement === 'Waiting' && prepared.modelAvailability === 'MODEL_SELECTION_REQUIRED',
    `Expected native approval for ${kind}`);
  const history = await events(record.sessionId);
  if (kind === 'sandbox-gate') await verifySandboxApproval(record, prepared.session, history);
  const decision = approve(record, history);
  void decision.catch(() => undefined);
  return { record, decision };
}

async function verifyReviewedCommands(home: string, terminalId: string) {
  for (const [kind, stdout] of [
    ['sandbox-reviewed-read', 'reviewed sandbox input\n'],
    ['sandbox-reviewed-list', 'input.txt\n'],
  ] as const) {
    const { record, prepared } = await submitCase(home, terminalId, kind, 'scopedAutopilot');
    assert(prepared.settlement !== 'Waiting' && prepared.modelAvailability === 'MODEL_SELECTION_REQUIRED',
      `Expected automatic approval for ${kind}`);
    const history = await events(record.sessionId);
    const approvals = history.filter((event) => event.type === 'tool/approval' && event.data.callId === record.callId);
    assert(approvals.length === 1 && approvals[0].type === 'tool/approval'
      && approvals[0].data.status === 'approved' && approvals[0].data.reason === 'nativePolicyAutoApproved',
    `Expected one automatic approval for ${kind}`);
    const settled = results(history, record.callId);
    assert(settled.length === 1 && dispatched(history, record), `Expected one dispatch and result for ${kind}`);
    const result = settled[0];
    const data = result.data as Record<string, unknown> | undefined;
    assert(result.status === 'completed' && data?.started === true && data.exitCode === 0
      && data.sandbox === 'nonoMacAcceptance' && data.approvalReview === 'boundedLocalRead' && data.stdout === stdout,
    JSON.stringify(result));
    await host('progress', { kind, result });
  }
}

async function exercise(home: string): Promise<Case[]> {
  await useAiSettingsStore.getState().hydrateFromDb();
  createRoot(document.getElementById('settings')!).render(<TooltipProvider><AiSettingsSection /></TooltipProvider>);
  const switchControl = await until(async () => [...document.querySelectorAll<HTMLElement>('[role=switch]')]
    .find((node) => node.getAttribute('aria-label') === t('settings.ai.agent.sandbox')), 'Agent sandbox switch');
  const enabled = async () => (await invokeLoadPreferences()).some(([key, value]) =>
    key === 'ai.agentSandboxEnabled' && value === 'true');
  assert(!await enabled(), 'New profile starts with sandbox disabled');
  const toggle = async (next: boolean) => {
    assert((switchControl.getAttribute('aria-checked') === 'true') !== next, 'Expected a change in sandbox switch');
    switchControl.click();
    await until(async () => await enabled() === next &&
      (switchControl.getAttribute('aria-checked') === 'true') === next ? true : undefined, 'Sandbox switch persisted');
  };
  const terminal = await invokeCreateLocalSession(80, 25, undefined, null);
  useTerminalStore.getState().addSession(terminal);
  useTerminalStore.getState().setStatus(terminal.sessionId, { sessionId: terminal.sessionId, status: 'connected' });
  await verifyOperatorPermissionCopy(terminal.sessionId, false);
  const disabledCall = await submitCase(home, terminal.sessionId, 'sandbox-operator-write', 'operator');
  const disabledHistory = await events(disabledCall.record.sessionId);
  const disabledResult = results(disabledHistory, disabledCall.record.callId)[0];
  assert(disabledResult?.status === 'rejected' && disabledResult.summary.includes('AGENT_SANDBOX_DISABLED')
    && !dispatched(disabledHistory, disabledCall.record)
    && (await artifact(`exit-${disabledCall.record.callId}`)).content === null, JSON.stringify(disabledResult));
  await host('progress', { kind: 'sandbox-operator-disabled', result: disabledResult });
  await toggle(true);
  await verifyDirectOnly(home, terminal.sessionId);
  await verifyOperatorPermissionCopy(terminal.sessionId, true);
  await verifyOperatorCommands(home, terminal.sessionId);
  await verifyReviewedCommands(home, terminal.sessionId);
  const records: Case[] = [];
  for (const kind of ['sandbox-gate', 'sandbox-init', 'sandbox-exit', 'sandbox-exit-125',
    'sandbox-cancel-before-launch', 'sandbox-descendant', 'sandbox-cancel', 'sandbox-timeout', 'sandbox-restart'] as const) {
    const { record, decision } = await prepareCase(home, terminal.sessionId, kind,
      kind === 'sandbox-exit' ? 'scopedAutopilot' : 'requestApproval');
    if (kind === 'sandbox-gate') {
      await until(async () => (await host<{ ready: boolean }>('ready')).ready ? true : undefined, 'Approved dispatch barrier');
      assert((await events(record.sessionId)).some((event) => event.type === 'tool/approval'
        && event.data.callId === record.callId && event.data.status === 'approved'), 'Approval was not committed');
      await toggle(false);
      await host('release', {});
    }
    if (kind === 'sandbox-cancel-before-launch') {
      await until(async () => (await host<{ ready: boolean }>('launch-ready')).ready ? true : undefined,
        'Launcher is running behind a closed gate');
      await invokeCancelAgentRuntime({ sessionId: record.sessionId });
    }
    if (kind === 'sandbox-cancel' || kind === 'sandbox-restart') {
      await until(async () => (await artifact(`pid-${record.callId}`)).running ? true : undefined, 'Actual command child');
      if (kind === 'sandbox-restart') {
        const history = await events(record.sessionId);
        assert(dispatched(history, record) && !results(history, record.callId).length, 'Expected a dispatched in-flight command');
        return [...records, record];
      }
      await invokeCancelAgentRuntime({ sessionId: record.sessionId });
    }
    await decision;
    const history = await events(record.sessionId);
    const settled = results(history, record.callId);
    assert(settled.length === 1, `Expected exactly one persisted result for ${kind}: ${JSON.stringify(settled)}`);
    const [result] = settled;
    const data = typeof result.data === 'object' && result.data !== null
      ? result.data as Record<string, unknown> : undefined;
    if (kind === 'sandbox-gate') {
      assert(!dispatched(history, record) && result.status === 'cancelled'
        && result.summary.includes('AGENT_SANDBOX_DISABLED'), JSON.stringify(result));
      assert(history.some((event) => event.type === 'tool/approval' && event.data.callId === record.callId
        && event.data.status === 'cancelled'), 'Approval cancellation was not persisted');
      assert((await artifact(`gate-${record.callId}`)).content === null, 'Gated command executed');
      await toggle(true);
    } else if (kind === 'sandbox-init') {
      assert(result.status === 'failed' && data?.started === false && data.exitCode === null
        && data.launcherExitCode === 125, JSON.stringify(result));
      assert((await artifact(`init-${record.callId}`)).content === null, 'Command ran after launcher failure');
    } else if (kind === 'sandbox-exit' || kind === 'sandbox-exit-125') {
      assert(data?.started === true && data.exitCode === (kind === 'sandbox-exit' ? 42 : 125)
        && data.launcherExitCode === undefined
        && (await artifact(`exit-${record.callId}`)).content === 'entered', JSON.stringify(result));
    } else if (kind === 'sandbox-cancel-before-launch') {
      const guard = await readGuard();
      assert(!dispatched(history, record) && result.status === 'cancelled' && data?.started === false
        && (await artifact(`cancelled-${record.callId}`)).content === null
        && !guard.protected && guard.phase === null, JSON.stringify({ result, guard }));
    } else if (kind === 'sandbox-descendant') {
      const child = await artifact(`pid-${record.callId}`);
      const guard = await readGuard();
      assert(result.status === 'completed' && data?.started === true && data.exitCode === 0
        && data.terminationConfirmed === true && child.content && !child.running
        && !guard.protected && guard.phase === null, JSON.stringify({ result, child, guard }));
    } else {
      const child = await artifact(`pid-${record.callId}`);
      assert(result.status === (kind === 'sandbox-cancel' ? 'cancelled' : 'timedOut')
        && data?.started === true && data.terminationConfirmed === true
        && child.content && !child.running, JSON.stringify({ result, child }));
    }
    records.push({ ...record, result });
    await host('progress', { kind, result });
  }
  throw new Error('Missing restart scenario');
}

async function exerciseCut(home: string, stage: 'before' | 'after') {
  const terminal = await invokeCreateLocalSession(80, 25, undefined, null);
  const { record } = await prepareCase(home, terminal.sessionId, `sandbox-${stage}`);
  await until(async () => {
    const state = await readGuard();
    return (stage === 'before' ? state.beforeReady : state.afterReady) ? true : undefined;
  }, `Crash checkpoint ${stage}`);
  const state = await readGuard();
  assert(state.protected && state.phase?.phase === (stage === 'before' ? 'prepared' : 'ended'),
    JSON.stringify(state));
  await host('restart', [record]);
}

async function verify() {
  const { home, phase, previous } = await host<HostConfig>('config');
  await initI18n('zh-CN');
  await getCurrentWindow().show();
  assert((await invokeListAiRoutes()).routes.length === 0, 'Unexpected model routes in acceptance profile');
  if (phase === 'execute') {
    await host('restart', await exercise(home));
    return;
  }
  if (phase === 'cut-before' || phase === 'cut-after') {
    await exerciseCut(home, phase === 'cut-before' ? 'before' : 'after');
    return;
  }
  let whileRunning: Guard | undefined;
  if (phase === 'replay') {
    const inFlight = previous.find((record) => record.kind === 'sandbox-restart');
    assert(inFlight && (await artifact(`pid-${inFlight.callId}`)).running, 'The original command must still be running after restart');
    whileRunning = await readGuard();
    assert(whileRunning.protected && whileRunning.phase?.phase === 'running', JSON.stringify(whileRunning));
    await host('finish-running', {});
  }
  await until(async () => {
    const state = await readGuard();
    return !state.protected && state.phase === null ? true : undefined;
  }, 'App released the managed directory after recovery');
  let interrupted: Awaited<ReturnType<typeof invokeInspectAgentRuntimeRecovery>> | undefined;
  for (const record of previous) {
    const history = await events(record.sessionId);
    const current = results(history, record.callId);
    if (record.kind === 'sandbox-restart') {
      const snapshot = await invokeGetAgentRuntimeSession({ sessionId: record.sessionId });
      const recovery = await invokeInspectAgentRuntimeRecovery({ sessionId: record.sessionId });
      assert(snapshot.uncertainNativeEffects && recovery.status === 'required' && recovery.callId === record.callId,
        JSON.stringify({ recovery, result: current }));
      interrupted = recovery;
      await until(async () => {
        const child = await artifact(`pid-${record.callId}`);
        return child.content?.trim().split('\n').length === 1 && !child.running ? true : undefined;
      }, 'Original child finished with one execution');
    } else if (record.kind === 'sandbox-before' || record.kind === 'sandbox-after') {
      const after = record.kind === 'sandbox-after';
      assert(dispatched(history, record) === after && !current.length, 'Unexpected dispatch or replay at crash cut');
      const witness = await artifact(`${after ? 'after' : 'before'}-${record.callId}`);
      assert(witness.content === (after ? 'after' : null), JSON.stringify(witness));
      const snapshot = await invokeGetAgentRuntimeSession({ sessionId: record.sessionId });
      assert(Boolean(snapshot.uncertainNativeEffects) === after, JSON.stringify(snapshot.recovery));
    } else {
      assert(current.length === 1 && JSON.stringify(current[0]) === JSON.stringify(record.result),
        `Replay changed the persisted result for ${record.kind}`);
      if (record.kind === 'sandbox-gate') {
        const approvals = history.flatMap((event) => event.type === 'tool/approval'
          && event.data.callId === record.callId ? [event.data.status] : []);
        assert(approvals.join(',') === 'requested,approved,cancelled', JSON.stringify(approvals));
      }
    }
  }
  assert(interrupted, 'Missing the interrupted call recovery');
  await host('done', { ok: true, replayed: previous.length, interrupted, whileRunning, guard: await readGuard() });
}

void verify().catch(async (error: unknown) => {
  document.getElementById('test')!.textContent = String(error);
  await host('done', { ok: false, error: String(error) });
});
