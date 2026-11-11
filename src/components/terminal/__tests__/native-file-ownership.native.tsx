import {createRoot} from 'react-dom/client';
import {getCurrentWindow} from '@tauri-apps/api/window';
import {TerminalControllerLayer} from '../terminal-controller-layer';
import {terminalRegistry} from '../registry/terminal-registry';
import {useTerminalStore} from '@/stores/terminalStore';
import {initI18n} from '@/locales';
import {selectNativeBoundaryModel} from './native-byte-boundary-plan';
import {isCurrentNativeEditorProfile} from './native-editor-profile';
import {createNativeAcceptanceSurface} from './native-acceptance-surface';
import {delegationOriginalCall} from './native-approval-delegation-plan';
import {matchesNativeFileChainStep} from './native-file-chain-approval';
import {verifyNativeFileOwner} from './native-file-chain-edit';
import {matchesNativeForeignOwnerRead, nativeForeignOwnerReadArguments, verifyNativeForeignOwnerRefusal,nativeOwnerWriteApprovalArguments} from './native-file-ownership-plan';
import {invokeCreateLocalSession, invokeCloseSession, invokeGetTerminalBrokerSnapshot, invokeListAiRoutes, invokeCreateAgentRuntimeSession, invokeStartAgentRuntime, invokeAgentRuntimeFollowup, invokeCancelAgentRuntime, invokeArchiveAgentRuntimeSession, invokeGetPendingAgentRuntimeApprovalArguments, invokeApproveAgentRuntimeTool, listenToAgentRuntimeSession, listenToTerminalIntegrationState} from '@/lib/ipc/tauri';
import type {AgentSessionEvent} from '@/types/agent-session';
import type {TerminalIntegrationStateEvent} from '@/types';

function assert(value: unknown, message: string): asserts value { if (!value) throw Error(message); }
function object(value: unknown): Record<string, unknown> { assert(value && typeof value === 'object' && !Array.isArray(value), 'Structured ownership witness required');return value as Record<string, unknown>; }
async function until(test: () => boolean | Promise<boolean>, message: string) { const end = Date.now() + 180000;while (!await test()) { assert(Date.now() < end, message);await new Promise(resolve => setTimeout(resolve, 10)); } }

export async function verifyNativeForeignScratchOwner(parameters: URLSearchParams, token: string) {
  assert(/^[a-f0-9-]{36}$/.test(token) && ['windowsPowerShell', 'powerShell7'].includes(parameters.get('nativeP3') ?? ''), 'Owned Windows foreign-owner fixture required');
  await initI18n('en-US');await getCurrentWindow().show();await getCurrentWindow().setFocus();
  const element = document.getElementById('root')!, root = createRoot(element);root.render(<TerminalControllerLayer/>);
  const surface = await createNativeAcceptanceSurface(element), ownerId = 'agent-file-owner-' + crypto.randomUUID(), readerId = 'agent-file-reader-' + crypto.randomUUID();
  const events: AgentSessionEvent[] = [], observations: TerminalIntegrationStateEvent[] = [], dispose: (() => void)[] = [], created = new Set<string>(), decisions: Promise<void>[] = [], approvals = new Set<string>(),approvalRecords:unknown[]=[];
  const plan = {fileName: `acceptance-${token}.ps1`, content: `Write-Output 'SCRATCH_OWNER_${token}' # 所有权`, setup: ''};
  let terminalId: string | undefined, failure: string | undefined, path: string | undefined, raw = '', rawTruncated = false;
  const report = (value: unknown) => fetch(`/__agent-stream-result/${token}`, {method: 'POST', body: JSON.stringify(value)});
  const witness = async () => { const response = await fetch(`/__native-file-witness/${token}`);assert(response.ok, 'Owned file witness unavailable');return object(await response.json()); };
  try {
    const session = await invokeCreateLocalSession(100, 30);terminalId = session.sessionId;useTerminalStore.getState().addSession(session);
    await until(() => !!terminalRegistry.get(session.sessionId), 'Original terminal controller missing');const controller = terminalRegistry.get(session.sessionId)!;controller.attach(surface.host);await controller.whenOutputReady();
    await until(async () => !!(await invokeGetTerminalBrokerSnapshot(session.sessionId)).session?.promptReady, 'Original native prompt missing');
    const before = await invokeGetTerminalBrokerSnapshot(session.sessionId);assert(before.session?.currentDirectory && before.session.inputMode === 'native-inline' && isCurrentNativeEditorProfile(before.session.nativePeerProfile, parameters.get('nativeP3')), 'Original native profile/cwd missing');
    const cwd = before.session.currentDirectory, target = {kind: 'local' as const, targetId: 'terminal-' + session.sessionId, sessionId: session.sessionId, cwd};
    const selection = selectNativeBoundaryModel(await invokeListAiRoutes(), parameters.get('route'), parameters.get('model'));
    dispose.push(controller.subscribeOutput(value => { if (raw.length + value.length > 1048576) rawTruncated = true;else raw += value; }));
    dispose.push(await listenToTerminalIntegrationState(({payload}) => { if (payload.sessionId === session.sessionId) observations.push(payload); }));
    const prewrite: unknown[] = [];
    dispose.push(await listenToAgentRuntimeSession(({payload}) => {
      if (payload.sessionId !== ownerId && payload.sessionId !== readerId) return;events.push(payload);
      try {
        if (payload.type === 'request/failure') throw Error('Actual ownership model request failed');
        if (payload.type === 'tool/call') {
          assert(events.filter(event => event.sessionId === payload.sessionId && event.type === 'tool/call').length === 1, 'Extra ownership tool proposal');
          const original = delegationOriginalCall(events, payload), matches = payload.sessionId === ownerId
            ? (name: string, args: unknown) => matchesNativeFileChainStep(1, name, args, plan)
            : (name: string, args: unknown) => !!path && matchesNativeForeignOwnerRead(name, args, path);
          assert(matches(original.name, original.arguments) && matches(payload.data.call.name, payload.data.call.arguments), 'Original ownership proposal changed');
        }
      } catch (error) { failure ??= String(error); }
      if (payload.type === 'tool/approval' && payload.data.status === 'requested') {
        const pending = (async () => {
          const {approvalId, callId, requestId} = payload.data, {turnId, stepId} = payload;
          assert(payload.sessionId === ownerId && approvalId && turnId && stepId && !failure && !approvals.has(approvalId), 'Foreign read or invalid proposal requested approval');approvals.add(approvalId);
          const decision = {sessionId: ownerId, approvalId, callId, requestId, turnId, stepId},pendingArguments=await invokeGetPendingAgentRuntimeApprovalArguments(decision),resolved=nativeOwnerWriteApprovalArguments(events,decision,pendingArguments),args=resolved.argumentsValue;approvalRecords.push({decision,pendingArguments:args,argumentsSource:resolved.argumentsSource,actualPendingArgumentsRead:pendingArguments!==null&&pendingArguments!==undefined});
          assert(matchesNativeFileChainStep(1, 'write_file', args, plan), 'Pending owner write changed');const state = await witness();assert(Array.isArray(state.files) && state.files.length === 0, 'Script appeared before normal approval');prewrite.push(state);
          await invokeApproveAgentRuntimeTool(decision);
        })().catch(error => { failure ??= String(error); });decisions.push(pending);
      }
    }));
    async function run(id: string, goal: string, tool: 'write_file' | 'read_file') {
      await invokeCreateAgentRuntimeSession({sessionId: id, taskId: id, goal, executionSurface: 'boundTerminal', permissionMode: 'requestApproval', target, capabilityScope: {toolNames: [tool], effects: tool === 'write_file' ? ['stateChange'] : ['sensitiveRead'], targetIds: [target.targetId]}});created.add(id);
      const messageId = crypto.randomUUID();await invokeAgentRuntimeFollowup({sessionId: id, messageId, clientSubmissionId: messageId, content: goal});await invokeStartAgentRuntime({sessionId: id, selection});
      await until(() => { assert(!failure, failure ?? 'Ownership model failed');return events.some(event => event.sessionId === id && event.type === 'tool/result'); }, 'Actual ownership result missing');await Promise.all(decisions);assert(!failure, failure ?? 'Ownership approval failed');await invokeCancelAgentRuntime({sessionId: id});
      await until(() => { const boundaries = events.filter(event => event.sessionId === id && (event.type === 'turn/start' || event.type === 'turn/end' || event.type === 'session/ended'));return boundaries.length > 0 && boundaries[boundaries.length - 1].type !== 'turn/start'; }, 'Original ownership model turn did not end');
      const results = events.filter((event): event is Extract<AgentSessionEvent, {type: 'tool/result'}> => event.sessionId === id && event.type === 'tool/result');assert(results.length === 1, 'Ownership result count differs');return results[0];
    }
    const writeArgs = {fileScope: 'scratch', path: plan.fileName, content: plan.content, precondition: {mustNotExist: true}};
    const owner = await run(ownerId, `Call write_file exactly ONCE with exactly these arguments: ${JSON.stringify(writeArgs)}. Preserve every Unicode character. Wait for the result, then stop. Do not read, execute, retry, repair, change permissions or use other tools.`, 'write_file');
    const written = object(owner.data.data);assert(owner.data.status === 'completed' && written.fileScope === 'scratch' && written.temporary === true && typeof written.path === 'string' && typeof written.afterSha256 === 'string', 'Normal owner write did not return its managed path');path = written.path;
    const owned = await witness();assert(Array.isArray(owned.files) && owned.files.length === 1 && object(owned.files[0]).content === plan.content && object(owned.files[0]).sha256 === written.afterSha256, 'Original owner script/digest differs');await verifyNativeFileOwner(owned, ownerId, session.sessionId, cwd, path, 'settled');
    await run(readerId, `Call read_file exactly ONCE with exactly these arguments: ${JSON.stringify(nativeForeignOwnerReadArguments(path))}. This deliberate ownership refusal uses the ordinary workspace scope: do not add fileScope, change cwd or target, retry, repair, copy, execute, or use other tools. Wait for its actual refusal, then stop.`, 'read_file');
    const readerEvents = events.filter(event => event.sessionId === readerId), refusal = verifyNativeForeignOwnerRefusal(readerEvents, readerId, path, plan.content, target), after = await invokeGetTerminalBrokerSnapshot(session.sessionId), state = await witness();
    assert(prewrite.length === 1 && approvals.size === 1, 'Owner write approval count differs');assert(Array.isArray(state.files) && state.files.length === 1 && object(state.files[0]).content === plan.content && object(state.files[0]).sha256 === written.afterSha256, 'Foreign reader changed the owner script');await verifyNativeFileOwner(state, ownerId, session.sessionId, cwd, path, 'settled');
    assert(Array.isArray(state.effectEntries) && state.effectEntries.length === 0 && !rawTruncated, 'Unexpected execution effect or truncated PTY capture');assert(after.session?.currentDirectory === cwd && after.session.nextInputSequence === before.session.nextInputSequence && after.session.terminalSessionId === before.session.terminalSessionId && after.session.terminalGeneration === before.session.terminalGeneration && after.session.transportSessionId === before.session.transportSessionId, 'File ownership check changed the original native terminal');assert(!observations.some(value => [ownerId, readerId].includes(value.inputObservation?.activeCommand?.agentSessionId ?? '')), 'File-only ownership check injected native input');
    for (const id of [...created]) { await invokeArchiveAgentRuntimeSession({sessionId: id});created.delete(id); }
    assert(!failure && events.filter(event => event.type === 'tool/call').length === 2 && events.filter(event => event.type === 'tool/result').length === 2 && events.filter(event => event.type === 'tool/approval' && event.data.status === 'approved').length === 1, failure ?? 'Final ownership proposal/result/approval counts differ');
    assert(events.flatMap(event => event.type === 'assistant/message' ? event.data.content.filter(block => block.type === 'toolCall') : []).length === 2, 'Extra original ownership proposal appeared before archival');verifyNativeForeignOwnerRefusal(events.filter(event => event.sessionId === readerId), readerId, path, plan.content, target);
    await report({evidence: {kind: 'actual-native-file-foreign-owner', selection, token, ownerId, readerId, target, plan, path, before, after, owned, state, prewrite,approvalRecords, refusal, events, observations, raw, rawTruncated, scope: 'Actual approved owner write and independent real-model foreign workspace read denied before approval, with full ownership digest and unchanged original native target/cwd. No native path-execution, symbolic-link, prefix-collision, Direct or SFTP claim.'}, progress: 'Actual independent Agent scratch ownership refusal completed.'});
  } catch (error) {
    await report({evidence: {failed: true, kind: 'actual-native-file-foreign-owner-failure', token, ownerId, readerId, plan, path,approvalRecords, error: String(error), events, observations, raw, rawTruncated}, progress: 'Foreign ownership failure retained without replay or permission changes.'});throw error;
  } finally {
    dispose.forEach(fn => fn());for (const id of created) { await invokeCancelAgentRuntime({sessionId: id}).catch(() => {});await invokeArchiveAgentRuntimeSession({sessionId: id}).catch(() => {}); }if (terminalId) { await invokeCloseSession(terminalId);terminalRegistry.dispose(terminalId); }root.unmount();surface.host.remove();
  }
}
