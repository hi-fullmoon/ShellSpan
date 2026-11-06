import { getCurrentWindow } from '@tauri-apps/api/window';
import { initI18n } from '@/locales';
import { useTerminalStore } from '@/stores/terminalStore';
import { useAppStore } from '@/stores/appStore';
import { terminalRegistry } from '../registry/terminal-registry';
import { createAgentTerminalLeaseCoordinator } from '../terminal-controller-layer';
import { matchesNativeJobsApproval } from './native-jobs-approval';
import {
  invokeCreateLocalSession, invokeCloseSession, invokeGetTerminalBrokerSnapshot,
  invokeCreateAgentRuntimeSession, invokeStartAgentRuntime, invokeAgentRuntimeFollowup,
  invokeListAiRoutes, invokeGetPendingAgentRuntimeApprovalArguments, invokeApproveAgentRuntimeTool,
  invokeGetTerminalSubmissionRecovery, invokeCancelAgentRuntime, invokeArchiveAgentRuntimeSession,
  listenToAgentRuntimeSession, listenToAgentTerminalLease,
} from '@/lib/ipc/tauri';
import type { AgentSessionEvent, AgentTerminalLeaseEvent } from '@/types/agent-session';
import '@/styles/base.css';

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function until(test: () => Promise<boolean>, message: string) {
  const deadline = Date.now() + 120_000;
  while (!await test()) { assert(Date.now() < deadline, message); await new Promise(done => setTimeout(done, 20)); }
}

async function verify() {
  const parameters = new URL(location.href).searchParams;
  const token = parameters.get('token'), family = parameters.get('recoveryNativeFamily');
  assert(token && /^[a-f0-9-]{36}$/.test(token) && (family === 'bash' || family === 'zsh'), 'Exact owned macOS crash case required');
  const report = (value: unknown) => fetch(`/__agent-stream-result/${token}`, { method: 'POST', body: JSON.stringify(value) });
  await initI18n('en-US'); await getCurrentWindow().show();
  useAppStore.setState({ activeSection: 'terminal', restoreWorkspace: false });
  const host = document.getElementById('root')!; host.style.cssText = 'width:100vw;height:100vh';
  const session = await invokeCreateLocalSession(100, 30); useTerminalStore.getState().addSession(session);
  const controller = terminalRegistry.create(session.sessionId,
    (id, event) => useTerminalStore.getState().setStatus(id, event),
    (id, event) => useTerminalStore.getState().setClosed(id, event),
    id => useTerminalStore.getState().sessions.find(value => value.sessionId === id)?.status ?? 'connecting', () => {}, session.ptyInfo);
  const id = `agent-macos-crash-${token}`, events: AgentSessionEvent[] = [], leases: AgentTerminalLeaseEvent[] = [];
  const coordinator = createAgentTerminalLeaseCoordinator();
  const source = `builtin printf '%s\\n' "$$" > "$HOME/native-pid-${token}"; builtin printf 'ONCE\\n' >> "$HOME/native-crash-${token}"; while [[ ! -e "$HOME/native-release-${token}" ]]; do sleep 0.05; done; builtin printf 'AFTER\\n' >> "$HOME/native-after-${token}"`;
  const allowed = new Map([[source, false]]);
  let raw = '', failure: string | undefined, created = false, approvalReserved = false;
  let approvalArgumentSource: 'pending-ephemeral' | 'original-model-call' | undefined;
  let unlisten: (() => void) | undefined;
  let unlistenLease: (() => void) | undefined;
  const stopOutput = controller.subscribeOutput(value => { assert(raw.length + value.length <= 262144, 'Crash output bound'); raw += value; });
  try {
    controller.attach(host); await controller.whenOutputReady();
    await until(async () => !!(await invokeGetTerminalBrokerSnapshot(session.sessionId)).session?.promptReady, 'Actual native prompt missing');
    const before = await invokeGetTerminalBrokerSnapshot(session.sessionId), peer = before.session?.nativePeerProfile;
    assert(before.session?.inputMode === 'native-inline' && peer?.shell === family && peer.verifiedProfileId, 'Verified actual native family required');
    unlistenLease = await listenToAgentTerminalLease(({ payload }) => {
      if (payload.sessionId !== session.sessionId) return; leases.push(payload);
      void coordinator.handle(payload).catch(error => { failure = String(error); });
    });
    unlisten = await listenToAgentRuntimeSession(({ payload }) => {
      coordinator.handleSession(payload);
      if (payload.sessionId !== id) return; events.push(payload);
      if (payload.type === 'request/failure') failure = `Actual provider failure: ${payload.data.failure.kind}`;
      if (payload.type === 'tool/call') {
        const call = payload.data.call;
        if (events.filter(event => event.type === 'tool/call').length !== 1 || call.name !== 'run_terminal_command'
          || !matchesNativeJobsApproval(call.arguments, allowed, [])
          || !call.arguments || typeof call.arguments !== 'object' || !('timeoutMs' in call.arguments) || call.arguments.timeoutMs !== 30_000) failure = 'Original model proposal differs from the frozen single crash source; no repair authorized';
      }
      if (payload.type === 'tool/approval' && payload.data.status === 'requested') void (async () => {
        assert(!failure && !approvalReserved, failure ?? 'Duplicate approval');
        const { approvalId, callId, requestId } = payload.data, { turnId, stepId } = payload;
        assert(approvalId && turnId && stepId, 'Incomplete real approval identity');
        const call = events.find((event): event is Extract<AgentSessionEvent, { type: 'tool/call' }> => event.type === 'tool/call' && event.turnId === turnId && event.stepId === stepId && event.data.call.callId === callId);
        assert(call && matchesNativeJobsApproval(call.data.call.arguments, allowed, []), 'Original matching model call missing');
        const decision = { sessionId: id, approvalId, callId, requestId, turnId, stepId };
        const pending = await invokeGetPendingAgentRuntimeApprovalArguments(decision);
        // The normal API returns null for non-ephemeral arguments. In that
        // case review the original matching model event, without rewriting it.
        const args = pending ?? call.data.call.arguments;
        approvalArgumentSource = pending == null ? 'original-model-call' : 'pending-ephemeral';
        assert(args && typeof args === 'object' && matchesNativeJobsApproval(args, allowed, []) && 'timeoutMs' in args && args.timeoutMs === 30_000, 'Approval changed the frozen source or timeout');
        approvalReserved = true; await invokeApproveAgentRuntimeTool(decision);
      })().catch(error => { failure = String(error); });
    });
    const selection = (await invokeListAiRoutes()).defaultSelection; assert(selection, 'Actual configured model required');
    const goal = `Call run_terminal_command exactly ONCE with background=false and timeoutMs=30000, using the exact source below with no trailing newline. Do not retry, change source, or use other tools. This is an owned crash acceptance case.\n~~~${family}\n${source}\n~~~`;
    await invokeCreateAgentRuntimeSession({ sessionId: id, taskId: id, goal, executionSurface: 'boundTerminal', permissionMode: 'requestApproval',
      target: { kind: 'local', targetId: `terminal-${session.sessionId}`, sessionId: session.sessionId, cwd: before.session.currentDirectory },
      capabilityScope: { toolNames: ['run_terminal_command'], effects: ['none', 'readOnly', 'stateChange', 'externalSideEffect'], targetIds: [`terminal-${session.sessionId}`] } });
    created = true; await invokeStartAgentRuntime({ sessionId: id, selection });
    const message = crypto.randomUUID(); await invokeAgentRuntimeFollowup({ sessionId: id, messageId: message, clientSubmissionId: message, content: goal });
    await until(async () => {
      assert(!failure, failure ?? 'Actual crash approval failed');
      assert(!events.some(event => event.type === 'tool/result'), 'Original call settled before the crash cut');
      const active = (await invokeGetTerminalBrokerSnapshot(session.sessionId)).session?.inputObservation?.activeCommand;
      return active?.agentSessionId === id && active.phase === 'running' && active.fullInputConfirmed && active.submissionIntentDurable && active.mayHaveSubmitted && active.executionEvidence === 'startObserved';
    }, 'Real native operation did not reach the durable running crash cut');
    const submitted = await invokeGetTerminalBrokerSnapshot(session.sessionId), recovery = await invokeGetTerminalSubmissionRecovery(id);
    assert(approvalReserved && events.filter(event => event.type === 'tool/call').length === 1 && !events.some(event => event.type === 'tool/result'), 'Single pending call required at the crash cut');
    assert(recovery.length === 1 && recovery[0].noAutoReplay && recovery[0].identity.operationId === submitted.session?.inputObservation?.activeCommand?.operationId, 'Durable original operation identity missing');
    await report({ progress: 'Actual macOS native running crash cut reached; awaiting verified external App termination', evidence: {
      kind: 'actual-macos-native-running-crash-cut', family, token, id, source, before, submitted, recovery, events, leases, raw,
      approvalReserved, approvalArgumentSource, complete: false, scope: 'Real model, exact original source, approval, full proof, durable intent and Started. External owner must verify the ONCE effect and exact App identity before SIGKILL; no cancel/close IPC before the cut.' } });
    await new Promise<never>(() => {});
  } catch (error) {
    await report({ progress: 'Actual macOS crash case failed; original evidence retained', evidence: { failed: true, error: String(error), family, token, id, source, events, leases, raw } });
    throw error;
  } finally {
    unlisten?.(); unlistenLease?.(); coordinator.dispose(); stopOutput();
    if (created) { await invokeCancelAgentRuntime({ sessionId: id }); await invokeArchiveAgentRuntimeSession({ sessionId: id }); }
    terminalRegistry.dispose(session.sessionId); await invokeCloseSession(session.sessionId);
  }
}
void verify().then(() => ({ ok: true }), error => ({ ok: false, error: String(error) }))
  .then(value => fetch(`/__agent-stream-result/${new URL(location.href).searchParams.get('token')}`, { method: 'POST', body: JSON.stringify(value) }));
