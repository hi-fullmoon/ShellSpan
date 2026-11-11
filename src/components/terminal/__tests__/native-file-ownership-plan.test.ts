import {expect, it} from 'vitest';
import type {AgentSessionEvent, AgentSessionRecordedToolCall} from '@/types/agent-session';
import {matchesNativeForeignOwnerRead, nativeForeignOwnerReadArguments, verifyNativeForeignOwnerRefusal,nativeOwnerWriteApprovalArguments} from './native-file-ownership-plan';

const path = 'D:\\owned\\data\\tmp\\0123456789abcdef\\script.ps1', content = "Write-Output 'OWNER_ONLY'", id = 'reader-owned', target = {kind: 'local' as const, targetId: 'terminal-owned', sessionId: 'terminal-owned', cwd: 'D:/owned/home'};
function events(): AgentSessionEvent[] {
  const base = {version: 5 as const, sessionId: id, seq: 1, timeUnixMs: 1, turnId: 'turn-owned', stepId: 'step-owned'};
  const call: AgentSessionRecordedToolCall = {callId: 'call-owned', name: 'read_file', arguments: nativeForeignOwnerReadArguments(path), target};
  return [
    {...base, type: 'assistant/message', data: {messageId: 'message-owned', content: [{type: 'toolCall', call}], usage: {}, stopReason: 'toolCalls', interrupted: false}},
    {...base, seq: 2, type: 'tool/call', data: {call}},
    {...base, seq: 3, type: 'tool/result', data: {callId: call.callId, name: call.name, status: 'rejected', summary: "AGENT_SCRATCH_SCOPE_DENIED: use this session's fileScope=scratch target"}},
  ];
}
it('preserves the exact returned Windows path and bounded ordinary-workspace read', () => {
  expect(nativeForeignOwnerReadArguments(path)).toEqual({path, encoding: 'utf8', offset: 0, maxBytes: 8192});
  const extended = '\\\\?\\' + path;expect(nativeForeignOwnerReadArguments(extended).path).toBe(extended);
  expect(matchesNativeForeignOwnerRead('read_file', nativeForeignOwnerReadArguments(path), path)).toBe(true);
  for (const change of [{fileScope: 'scratch'}, {offset: 1}, {maxBytes: 16384}, {encoding: 'base64'}, {path: 'D:/other/script.ps1'}]) expect(matchesNativeForeignOwnerRead('read_file', {...nativeForeignOwnerReadArguments(path), ...change}, path)).toBe(false);
  expect(() => nativeForeignOwnerReadArguments('script.ps1')).toThrow('absolute Windows');
});
it('requires the original matched proposal and specific pre-approval ownership refusal', () => {
  expect(verifyNativeForeignOwnerRefusal(events(), id, path, content, target)).toMatchObject({approved: false, refusedBeforeFileRead: true, code: 'AGENT_SCRATCH_SCOPE_DENIED'});
});
it('rejects a different source, target, scope, proposal count, result identity or leaked contents', () => {
  const original = events(), callEvent = original[1] as Extract<AgentSessionEvent, {type: 'tool/call'}>, resultEvent = original[2] as Extract<AgentSessionEvent, {type: 'tool/result'}>;
  const invalid: AgentSessionEvent[][] = [
    original.slice(1), [...original, original[1]],
    [original[0], {...callEvent, data: {call: {...callEvent.data.call, arguments: {...nativeForeignOwnerReadArguments(path), fileScope: 'scratch'}}}}, original[2]],
    [original[0], {...callEvent, data: {call: {...callEvent.data.call, target: {...target, cwd: 'D:/foreign'}}}}, original[2]],
    [original[0], original[1], {...resultEvent, data: {...resultEvent.data, status: 'completed'}}],
    [original[0], original[1], {...resultEvent, data: {...resultEvent.data, callId: 'foreign'}}],
    [original[0], original[1], {...resultEvent, data: {...resultEvent.data, summary: 'file not found'}}],
    [original[0], original[1], {...resultEvent, stepId: 'foreign'}],
    [original[0], original[1], {...resultEvent, data: {...resultEvent.data, data: {content}}}],
  ];
  for (const value of invalid) expect(() => verifyNativeForeignOwnerRefusal(value, id, path, content, target)).toThrow();
});
it.each(['requested', 'approved'] as const)('rejects a foreign reader crossing the %s approval boundary', status => {
  const value = events();value.splice(2, 0, {version: 5, seq: 3, timeUnixMs: 1, sessionId: id, turnId: 'turn-owned', stepId: 'step-owned', type: 'tool/approval', data: {requestId: 'request-owned', callId: 'call-owned', approvalId: 'approval-owned', status}});
  expect(() => verifyNativeForeignOwnerRefusal(value, id, path, content, target)).toThrow('storage approval boundary');
});
it('resolves ordinary owner approval from the complete same-identity recorded call when the ephemeral API returns null',()=>{
 const original=events(),previous=original[1] as Extract<AgentSessionEvent,{type:'tool/call'}>,call:Extract<AgentSessionEvent,{type:'tool/call'}>={...previous,data:{call:{...previous.data.call,name:'write_file',arguments:{fileScope:'scratch',path:'owned.ps1',content,precondition:{mustNotExist:true}}}}},value:AgentSessionEvent[]=[original[0],call,...original.slice(2)];
 const identity={sessionId:id,turnId:'turn-owned',stepId:'step-owned',callId:'call-owned',approvalId:'approval-owner',requestId:'request-owner'};
 value.push({version:5,seq:4,timeUnixMs:4,sessionId:id,turnId:identity.turnId,stepId:identity.stepId,type:'tool/approval',data:{callId:identity.callId,approvalId:identity.approvalId,requestId:identity.requestId,status:'requested'}});
 expect(nativeOwnerWriteApprovalArguments(value,identity,null)).toEqual({argumentsValue:call.data.call.arguments,argumentsSource:'recorded-non-ephemeral-call'});
 expect(nativeOwnerWriteApprovalArguments(value,identity,call.data.call.arguments).argumentsSource).toBe('pending-arguments-api');
 for(const changed of [{...identity,sessionId:'foreign'},{...identity,stepId:'foreign'},{...identity,approvalId:'foreign'},{...identity,requestId:'foreign'}])expect(()=>nativeOwnerWriteApprovalArguments(value,changed,null)).toThrow('identity');
 expect(()=>nativeOwnerWriteApprovalArguments(value,identity,{...call.data.call.arguments as object,content:'changed'})).toThrow('differ');
 const redacted:AgentSessionEvent[]=value.map(event=>event===call?{...call,data:{call:{...call.data.call,arguments:{contentPersisted:false}}}}:event);expect(()=>nativeOwnerWriteApprovalArguments(redacted,identity,null)).toThrow('Complete');
});
