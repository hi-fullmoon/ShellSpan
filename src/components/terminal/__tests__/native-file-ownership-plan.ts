import type {AgentSessionEvent} from '@/types/agent-session';
import {delegationOriginalCall} from './native-approval-delegation-plan';
import {matchesNativeFileChainStep,nativeFileChainPathIdentity} from './native-file-chain-approval';

interface OwnerApprovalIdentity {sessionId:string;turnId:string;stepId:string;callId:string;approvalId:string;requestId:string}
export function nativeOwnerWriteApprovalArguments(events:readonly AgentSessionEvent[],identity:OwnerApprovalIdentity,pending:unknown){
 const calls=events.filter((event):event is Extract<AgentSessionEvent,{type:'tool/call'}>=>event.type==='tool/call'&&event.sessionId===identity.sessionId&&event.turnId===identity.turnId&&event.stepId===identity.stepId&&event.data.call.callId===identity.callId);
 const approvals=events.filter(event=>event.type==='tool/approval'&&event.sessionId===identity.sessionId&&event.turnId===identity.turnId&&event.stepId===identity.stepId&&event.data.callId===identity.callId&&event.data.approvalId===identity.approvalId&&event.data.requestId===identity.requestId&&event.data.status==='requested');
 if(calls.length!==1||approvals.length!==1||calls[0].data.call.name!=='write_file')throw Error('Exact pending owner write identity required');
 const recorded=calls[0].data.call.arguments;
 if(!recorded||typeof recorded!=='object'||Array.isArray(recorded)||!('path'in recorded)||typeof recorded.path!=='string'||!('content'in recorded)||typeof recorded.content!=='string')throw Error('Complete non-ephemeral owner write arguments required');
 const plan={fileName:recorded.path,content:recorded.content,setup:''},args=pending??recorded;
 if(!matchesNativeFileChainStep(1,'write_file',recorded,plan)||!matchesNativeFileChainStep(1,'write_file',args,plan))throw Error('Owner approval arguments differ from the complete recorded call');
 return{argumentsValue:args,argumentsSource:pending===null||pending===undefined?'recorded-non-ephemeral-call' as const:'pending-arguments-api' as const};
}

export function nativeForeignOwnerReadArguments(path: string) {
  if (!nativeFileChainPathIdentity(path)) throw Error('Exact returned absolute Windows script path required');
  return {path, encoding: 'utf8', offset: 0, maxBytes: 8192} as const;
}

export function matchesNativeForeignOwnerRead(name: string, value: unknown, path: string): boolean {
  if (name !== 'read_file' || !value || typeof value !== 'object' || Array.isArray(value)) return false;
  const args = value as Record<string, unknown>, expected = nativeForeignOwnerReadArguments(path);
  return Object.keys(args).length === 4 && Object.entries(expected).every(([key, item]) => args[key] === item);
}

export function verifyNativeForeignOwnerRefusal(events: readonly AgentSessionEvent[], id: string, path: string, content: string, target: {sessionId: string; cwd: string}) {
  const calls = events.filter((event): event is Extract<AgentSessionEvent, {type: 'tool/call'}> => event.type === 'tool/call');
  const results = events.filter((event): event is Extract<AgentSessionEvent, {type: 'tool/result'}> => event.type === 'tool/result');
  const proposals = events.flatMap(event => event.type === 'assistant/message' ? event.data.content.flatMap(block => block.type === 'toolCall' ? [block.call] : []) : []);
  if (events.some(event => event.sessionId !== id || event.type === 'request/failure') || calls.length !== 1 || results.length !== 1 || proposals.length !== 1) throw Error('Exact independent reader model chain required');
  const call = calls[0], original = delegationOriginalCall(events, call), result = results[0];
  if (!matchesNativeForeignOwnerRead(original.name, original.arguments, path) || !matchesNativeForeignOwnerRead(call.data.call.name, call.data.call.arguments, path)) throw Error('Foreign read source or scope changed');
  if (call.data.call.target?.sessionId !== target.sessionId || call.data.call.target.cwd !== target.cwd) throw Error('Foreign read changed the frozen terminal target');
  if (events.some(event => event.type === 'tool/approval' && (event.data.status === 'requested' || event.data.status === 'approved'))) throw Error('Foreign read crossed the storage approval boundary');
  if (result.data.callId !== call.data.call.callId || result.turnId !== call.turnId || result.stepId !== call.stepId || result.data.status !== 'rejected' || !result.data.summary.includes('AGENT_SCRATCH_SCOPE_DENIED')) throw Error('Actual ownership refusal missing or mismatched');
  if (JSON.stringify(result.data).includes(content)) throw Error('Foreign script contents leaked in the refused result');
  return {callId: call.data.call.callId, originalPathPreserved: true, frozenTargetPreserved: true, approved: false, refusedBeforeFileRead: true, code: 'AGENT_SCRATCH_SCOPE_DENIED'} as const;
}
