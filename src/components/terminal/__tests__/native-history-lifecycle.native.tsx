import {selectNativeBoundaryModel} from './native-byte-boundary-plan';
import {createRoot} from 'react-dom/client';
import {getCurrentWindow} from '@tauri-apps/api/window';
import {TerminalControllerLayer} from '../terminal-controller-layer';
import {terminalRegistry} from '../registry/terminal-registry';
import {useTerminalStore} from '@/stores/terminalStore';
import {initI18n} from '@/locales';
import {delegationOriginalCall} from './native-approval-delegation-plan';
import {isCurrentNativeEditorProfile} from './native-editor-profile';
import {nativeHistoryModes, sameWindowsHistoryPath} from './native-history-plan';
import {expectedMemoryHistory, expectedPersistedHistory, matchesHistoryFingerprints, matchesHistoryLifecycleArguments, nativeHistoryLifecycleGoal, nativeHistoryLifecyclePlan} from './native-history-lifecycle-plan';
import {isWindowsDraftCancelStage} from './native-windows-draft-plan';
import {isConfirmedPreAcceptCancel} from './native-stop-boundary-plan';
import {invokeCreateLocalSession, invokeCloseSession, invokeGetTerminalBrokerSnapshot, invokeListAiRoutes, invokeCreateAgentRuntimeSession, invokeAgentRuntimeFollowup, invokeStartAgentRuntime, invokeApproveAgentRuntimeTool, invokeGetPendingAgentRuntimeApprovalArguments, invokeCancelAgentRuntime, invokeArchiveAgentRuntimeSession, invokeGetTerminalSubmissionRecovery, invokeGetAgentTerminalOwner, listenToAgentRuntimeSession, listenToTerminalIntegrationState, listenToSshClosed} from '@/lib/ipc/tauri';
import type {AgentSessionEvent} from '@/types/agent-session';
import type {ClosedEvent, TerminalIntegrationStateEvent} from '@/types';

function assert(value: unknown, message: string): asserts value { if (!value) throw Error(message); }
function object(value: unknown): Record<string, unknown> { assert(value && typeof value === 'object' && !Array.isArray(value), 'Structured history evidence required'); return value as Record<string, unknown>; }
async function until(test: () => boolean | Promise<boolean>, message: string, timeout = 180000) {
  const end = Date.now() + timeout;
  while (!await test()) { assert(Date.now() < end, message); await new Promise(resolve => setTimeout(resolve, 5)); }
}
async function fingerprints(sources: readonly string[]) {
  return Promise.all(sources.map(async source => {
    const bytes = new TextEncoder().encode(source);
    return {sha256: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), x => x.toString(16).padStart(2, '0')).join(''), bytes: bytes.length};
  }));
}

export async function verifyNativeHistoryLifecycle() {
  const params = new URL(location.href).searchParams, token = params.get('token'), mode = params.get('historyMode'), reuseReader = params.get('historyReuseReader');
  assert(token && nativeHistoryModes.some(value => value === mode), 'Owned exact history lifecycle case required');
  assert(reuseReader === null || ['0', '1'].includes(reuseReader), 'Exact isolated history reuse reader required');
  const plan = nativeHistoryLifecyclePlan(token), events: AgentSessionEvent[] = [], observations: TerminalIntegrationStateEvent[] = [], records: Record<string, unknown>[] = [], created = new Set<string>(), dispose: (() => void)[] = [];
  let terminalId: string | undefined, profile: Record<string, unknown> | undefined, observer: Record<string, unknown> | undefined, initial: Record<string, unknown> | undefined, final: Record<string, unknown> | undefined, beforeExitDisk: Record<string, unknown> | undefined, afterExitDisk: Record<string, unknown> | undefined, exitObservation: Record<string, unknown> | undefined, shellClosed: ClosedEvent | undefined, window: unknown, captureFailure: string | undefined, raw = '', normalExitVerified = false;
  const report = (value: unknown) => fetch(`/__agent-stream-result/${token}`, {method: 'POST', body: JSON.stringify(value)});
  const get = async (name: string) => { const response = await fetch(`/__native-history-${name}/${token}`); assert(response.ok, `Owned history ${name} observation unavailable`); return object(await response.json()); };
  const effect = async () => { const response = await fetch(`/__native-windows-draft/${token}`); assert(response.ok, 'Owned cancellation effect witness unavailable'); return object(await response.json()); };
  await initI18n('en-US');await getCurrentWindow().show();await getCurrentWindow().setFocus();
  assert(!matchMedia('(prefers-reduced-motion: reduce)').matches, 'Visible typing cancellation requires the current non-reduced-motion acceptance condition');
  const root = createRoot(document.getElementById('root')!);root.render(<TerminalControllerLayer/>);
  const host = document.createElement('div');host.style.cssText = 'width:100vw;height:100vh';
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));document.getElementById('root')!.append(host);
  try {
    const session = await invokeCreateLocalSession(100, 30);terminalId = session.sessionId;useTerminalStore.getState().addSession(session);
    await until(() => !!terminalRegistry.get(session.sessionId), 'History lifecycle controller missing');
    const controller = terminalRegistry.get(session.sessionId)!;controller.attach(host);await controller.whenOutputReady();
    await until(async () => !!(await invokeGetTerminalBrokerSnapshot(session.sessionId)).session?.promptReady, 'History lifecycle native prompt missing');
    const before = await invokeGetTerminalBrokerSnapshot(session.sessionId);
    assert(before.session?.inputMode === 'native-inline' && isCurrentNativeEditorProfile(before.session.nativePeerProfile, params.get('nativeP3')), 'History lifecycle native profile unavailable');
    dispose.push(controller.subscribeOutput(value => { assert(raw.length + value.length <= 1048576, 'History lifecycle capture bound exceeded');raw += value; }));
    dispose.push(await listenToTerminalIntegrationState(({payload}) => { if (payload.sessionId === session.sessionId) observations.push(payload); }));
    dispose.push(await listenToSshClosed(session.sessionId, ({payload}) => { shellClosed = payload; }));
    if (reuseReader === null) profile = await get('profile');
    await report({evidence: {kind: 'actual-native-history-lifecycle-ready', token, mode, before, profile, plan}, progress: 'Actual history lifecycle App ready for original OS Shell/module and held-handle exit observation.'});
    await until(async () => { const response = await fetch(`/__native-job-observer/${token}`);assert(response.ok, 'History lifecycle OS observer unavailable');const value = object(await response.json());if (value.ready) { observer = value;return true; }return false; }, 'History lifecycle OS Shell inspection missing', 60000);
    if (reuseReader !== null) profile = await get('profile');
    assert(profile?.mode === mode, 'History lifecycle profile mode differs');
    assert(typeof profile.expectedMaximum === 'number' && typeof profile.expectedStyle === 'string' && typeof profile.expectedNativePath === 'string' && Array.isArray(profile.seedSources) && profile.seedSources.every(x => typeof x === 'string'), 'Actual public startup options incomplete');
    assert(profile.pathSettingRejected === (mode === 'history-empty' || mode === 'history-null'), 'Empty/null history option rejection differs from actual profile');
    if (reuseReader !== null) assert(profile.reader === reuseReader && profile.readerPid === observer?.shellPid && profile.readerCreated === observer?.handleCreated && profile.seedApplied === (reuseReader === '0') && Array.isArray(profile.expectedInitialSources) && profile.expectedInitialSources.every(x => typeof x === 'string'), 'Reused history startup did not match the held original reader');
    const maximum = profile.expectedMaximum, style = profile.expectedStyle, historyPath = profile.expectedNativePath, seeds = reuseReader !== null ? profile.expectedInitialSources as string[] : profile.seedsOnDisk === true ? profile.seedSources as string[] : [];
    await until(async () => { const value = await get('exit');if (!value.ready) return false;const ready = object(value.ready);assert(ready.shellPid === observer?.shellPid && ready.created === observer?.handleCreated && ready.handleHeld === true, 'Held original Shell handle identity differs');return true; }, 'Original Shell exit observer not ready', 60000);
    assert((await effect()).exists === false, 'Cancellation namespace already has effects');
    const selection = selectNativeBoundaryModel(await invokeListAiRoutes(), params.get('route'), params.get('model'));
    const approvedSources: string[] = [];
    async function promptReady() {
      await until(async () => { const current = (await invokeGetTerminalBrokerSnapshot(session.sessionId)).session;return !!current?.promptReady && !current.inputObservation?.commandInputPending && !current.inputObservation?.nativeRecoveryRequired && await invokeGetAgentTerminalOwner(session.sessionId) === null; }, 'History lifecycle did not release input ownership', 15000);
    }
    async function run(source: string, stage: string, cancel = false): Promise<Record<string, unknown>> {
      const id = `agent-history-${stage}-${crypto.randomUUID()}`, goal = nativeHistoryLifecycleGoal(source), local: AgentSessionEvent[] = [], approved: string[] = [], reserved = new Set<string>();let failure: string | undefined, admission: unknown, stopped: unknown;
      const unlisten = await listenToAgentRuntimeSession(({payload}) => {
        if (payload.sessionId !== id) return;
        if (payload.type !== 'assistant/chunk') { local.push(payload);events.push(payload); }
        if (payload.type === 'request/failure') failure ??= 'Actual history lifecycle model request failed';
        if (payload.type === 'tool/call') try {
          assert(local.filter(x => x.type === 'tool/call').length === 1 && payload.data.call.name === 'run_terminal_command' && matchesHistoryLifecycleArguments(delegationOriginalCall(local, payload).arguments, source) && matchesHistoryLifecycleArguments(payload.data.call.arguments, source), 'Original history lifecycle command changed or extra tool proposed');
        } catch (error) { failure ??= String(error); }
        if (payload.type === 'tool/approval' && payload.data.status === 'requested') void (async () => {
          assert(!failure, failure ?? 'Invalid history lifecycle proposal');const {approvalId, callId, requestId} = payload.data, {turnId, stepId} = payload;
          assert(approvalId && turnId && stepId && !reserved.has(approvalId), 'Duplicate history lifecycle approval');reserved.add(approvalId);
          const decision = {sessionId: id, approvalId, callId, requestId, turnId, stepId}, pending = await invokeGetPendingAgentRuntimeApprovalArguments(decision);
          assert(pending === null || pending === undefined || matchesHistoryLifecycleArguments(pending, source), 'Pending history lifecycle command changed');
          await invokeApproveAgentRuntimeTool(decision);approved.push(callId);
        })().catch(error => { failure ??= String(error); });
      });
      try {
        await invokeCreateAgentRuntimeSession({sessionId: id, taskId: id, goal, executionSurface: 'boundTerminal', permissionMode: 'requestApproval', target: {kind: 'local', targetId: 'terminal-' + session.sessionId, sessionId: session.sessionId, cwd: before.session?.currentDirectory}, capabilityScope: {toolNames: ['run_terminal_command'], effects: ['none', 'readOnly', 'stateChange', 'externalSideEffect'], targetIds: ['terminal-' + session.sessionId]}});created.add(id);
        const messageId = crypto.randomUUID();await invokeAgentRuntimeFollowup({sessionId: id, messageId, clientSubmissionId: messageId, content: goal});await invokeStartAgentRuntime({sessionId: id, selection});
        if (cancel) {
          await until(() => {
            assert(!failure, failure ?? 'History cancellation proposal failed');assert(!local.some(x => x.type === 'tool/result'), 'Draft settled before requested pre-accept cancellation');
            const latest = observations[observations.length - 1], command = latest?.inputObservation?.activeCommand;
            if (!isWindowsDraftCancelStage(command, id, 'typing') || !controller.searchAddon.findNext(plan.draft.prefix)) return false;
            const selected = controller.terminal.getSelection();controller.terminal.clearSelection();if (selected !== plan.draft.prefix) return false;
            admission = {observation: latest, actualPrefix: selected};return true;
          }, 'Actual visible history draft was not observed before submission');
          const command = object(object(admission).observation).inputObservation as TerminalIntegrationStateEvent['inputObservation'];
          assert(command?.activeCommand && isWindowsDraftCancelStage(command.activeCommand, id, 'typing'), 'History draft admission identity missing');const identity = command.activeCommand;
          stopped = await invokeCancelAgentRuntime({sessionId: id});
          await until(() => observations.some(x => { const current = x.inputObservation?.activeCommand;return current?.agentSessionId === id && current.operationId === identity.operationId && current.commandId === identity.commandId && current.draftCleared && !current.mayHaveSubmitted && !current.submissionIntentDurable; }), 'Matching actual history draft-clear confirmation missing', 15000);
        }
        await until(() => { assert(!failure, failure ?? 'History lifecycle model failed');return local.some(x => x.type === 'tool/result'); }, 'History lifecycle tool result missing');
        await invokeCancelAgentRuntime({sessionId: id});
        const results = local.filter((x): x is Extract<AgentSessionEvent, {type: 'tool/result'}> => x.type === 'tool/result');
        assert(results.length === 1 && approved.length === 1, 'History lifecycle tool/approval count differs');
        const data = object(results[0].data.data);
        if (cancel) assert(isConfirmedPreAcceptCancel(results[0].data.status, data, 'cancel'), 'History draft was not confirmed cancelled before acceptance');
        else {
          const stable = object(data.commandObservation);
          assert(results[0].data.status === 'completed' && data.commandLine === source && data.exitCode === 0 && stable.fullInputConfirmed === true && stable.submissionIntentDurable === true && stable.executionEvidence === 'endObserved', 'History source did not complete actual native acceptance once');
          assert(observations.some(x => { const command = x.inputObservation?.activeCommand;return !!command && command.commandId === stable.commandId && command.executionEvidence === 'startObserved'; }), 'Actual history source Started observation missing');approvedSources.push(source);
        }
        const recovery = await invokeGetTerminalSubmissionRecovery(id);assert(recovery.length === 0, 'History lifecycle intent unsettled');
        const record = {id, stage, source, events: local, approved, data, admission, stopped, recovery};records.push(record);
        await invokeArchiveAgentRuntimeSession({sessionId: id});created.delete(id);await promptReady();return data;
      } finally { unlisten(); }
    }
    async function parseProbe(data: Record<string, unknown>, marker: string) {
      assert(typeof data.combinedOutput === 'string', 'Actual public history output missing');const match = data.combinedOutput.match(new RegExp(marker + '(\\{[^\\r\\n]*\\})'));assert(match, 'Actual public history JSON marker missing');
      const value = object(JSON.parse(match[1]));assert(typeof value.path === 'string' && sameWindowsHistoryPath(value.path, historyPath) && value.maximum === maximum && value.style === style, 'Actual App changed caller history path/maximum/style');
      assert(matchesHistoryFingerprints(value.items, await fingerprints(expectedMemoryHistory(seeds, approvedSources, maximum))), 'Actual public history differs from exact accepted source sequence');return value;
    }
    initial = await parseProbe(await run(plan.initialProbe, 'initial'), plan.initialMarker);
    for (const [index, item] of plan.accepted.entries()) { const data = await run(item.source, 'accepted-' + (index + 1));assert(typeof data.combinedOutput === 'string' && data.combinedOutput.includes(item.marker), 'Actual accepted history command output missing'); }
    await run(plan.draft.source, 'cancel', true);assert((await effect()).exists === false, 'Cancelled history draft executed an effect');
    final = await parseProbe(await run(plan.finalProbe, 'final'), plan.finalMarker);
    beforeExitDisk = await get('disk');assert(beforeExitDisk.exists === (style !== 'SaveNothing') && matchesHistoryFingerprints(beforeExitDisk.items, await fingerprints(expectedPersistedHistory(seeds, approvedSources, style, false))), 'Native disk history before exit differs from actual save policy');
    await getCurrentWindow().show();await getCurrentWindow().setFocus();
    const capture = await fetch(`/__native-window-evidence/${token}`, {method: 'POST'});
    if (capture.ok) window = await capture.json();else captureFailure = 'History lifecycle capture refused HTTP ' + capture.status + ': ' + (await capture.text()).slice(0, 4096);
    await promptReady();assert(await controller.writeUserInput('exit\r'), 'Ordinary real PTY exit was blocked after Agent release');
    await until(() => !!shellClosed, 'Actual Shell did not end after ordinary exit', 15000);assert(shellClosed?.reasonKind === 'remote_exit' && shellClosed.reason === 'local shell exited' && !shellClosed.retryable, 'Shell end came from forced close or error');
    await until(async () => { const value = await get('exit');if (!value.result) return false;exitObservation = object(value.result);assert(exitObservation.shellPid === observer?.shellPid && exitObservation.created === observer?.handleCreated && exitObservation.exitCode === 0 && exitObservation.ended === true, 'Original held Shell did not exit normally with zero status');return true; }, 'Original held Shell exit status missing', 15000);
    normalExitVerified = true;afterExitDisk = await get('disk');assert(afterExitDisk.exists === (style !== 'SaveNothing') && matchesHistoryFingerprints(afterExitDisk.items, await fingerprints(expectedPersistedHistory(seeds, approvedSources, style, true))), 'Native normal-exit disk history lost,duplicated or added sources');assert((await effect()).exists === false, 'Cancelled history effect appeared after normal exit');
    await invokeCloseSession(session.sessionId);
    if (captureFailure) throw Error(captureFailure);
    await report({evidence: {kind: 'actual-native-history-lifecycle', selection, token, mode, reuseReader, profile, observer, initial, final, records, events, observations, approvedSources, beforeExitDisk, afterExitDisk, exitObservation, shellClosed, normalExitVerified, window, raw, scope: 'One complete Windows history configuration and reader only;remaining required configurations, restart pairing, concurrent readers and platforms stay separate.'}, progress: 'Actual native App history accepted/cancelled/normal-exit persistence case completed.'});
  } catch (error) {
    await report({evidence: {kind: 'actual-native-history-lifecycle-failure', failed: true, token, mode, error: String(error), profile, observer, initial, final, records, events, observations, beforeExitDisk, afterExitDisk, exitObservation, shellClosed, normalExitVerified, captureFailure, raw}, progress: 'Actual App history lifecycle failure retained;no replay,source repair or capture waiver.'});throw error;
  } finally {
    dispose.forEach(fn => fn());for (const id of created) { await invokeCancelAgentRuntime({sessionId: id}).catch(() => {});await invokeArchiveAgentRuntimeSession({sessionId: id}).catch(() => {}); }
    if (terminalId) { await invokeCloseSession(terminalId).catch(() => {});terminalRegistry.dispose(terminalId); }root.unmount();host.remove();
  }
}
