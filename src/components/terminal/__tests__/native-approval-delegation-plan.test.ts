import {describe,it,expect} from 'vitest';import {approvalDelegationPlan,matchesDelegationSpawn,matchesDelegationNativeArgs,matchesDelegationPreparedNativeArgs,delegationOriginalCall,countDelegationApprovals} from './native-approval-delegation-plan';
import type {AgentSessionEvent} from '@/types/agent-session';
const token='dfa69841-ea10-485b-bbda-a59cbb6a99c5';
describe('original model proposal and native projection',()=>{
 const identity={version:5 as const,sessionId:'child',turnId:'turn',stepId:'step',seq:1,timeUnixMs:1};
 const original={callId:'call-1',name:'run_terminal_command',arguments:{command:'source',background:false,timeoutMs:30000,lifecycleTrust:'cooperative',explanation:'owned test'}};
 const message:Extract<AgentSessionEvent,{type:'assistant/message'}>={...identity,type:'assistant/message',data:{messageId:'message',content:[{type:'toolCall',call:original}],usage:{},stopReason:'toolCalls',interrupted:false}};
 const prepared:Extract<AgentSessionEvent,{type:'tool/call'}>={...identity,seq:2,type:'tool/call',data:{call:{callId:'call-1',name:'run_terminal_command',nativeName:'terminal_execute',arguments:{command:'source',timeoutMs:30000,explanation:'owned test'}}}};
 it('checks exact original parameters separately from the adapter projection',()=>{const call=delegationOriginalCall([message],prepared);expect(call).toBe(original);expect(matchesDelegationNativeArgs(call.arguments,'source',true)).toBe(true);expect(matchesDelegationNativeArgs(prepared.data.call.arguments,'source',true)).toBe(false);expect(matchesDelegationPreparedNativeArgs(prepared.data.call.arguments,'source',true)).toBe(true);});
 it.each([{command:'changed'},{timeoutMs:5000},{background:true},{lifecycleTrust:'directRequired'},{explanation:''},{extra:'value'}])('rejects changed prepared input: %j',change=>{expect(matchesDelegationPreparedNativeArgs({...prepared.data.call.arguments as Record<string,unknown>,...change},'source',true)).toBe(false);});
 it('does not let a valid projection hide an invalid original lifecycle declaration',()=>{const changed={...message,data:{...message.data,content:[{type:'toolCall' as const,call:{...original,arguments:{...original.arguments,lifecycleTrust:'directRequired'}}}]}};expect(matchesDelegationNativeArgs(delegationOriginalCall([changed],prepared).arguments,'source',true)).toBe(false);});
 it.each([{sessionId:'parent'},{turnId:'other-turn'},{stepId:'other-step'}])('rejects a call-ID match from a different identity: %j',change=>{expect(()=>delegationOriginalCall([{...message,...change}],prepared)).toThrow('original model proposal');});
 it('rejects missing original evidence',()=>{expect(()=>delegationOriginalCall([],prepared)).toThrow('original model proposal');});
 it('rejects duplicate original evidence',()=>{expect(()=>delegationOriginalCall([message,message],prepared)).toThrow('duplicate');});
 it('rejects incomplete prepared identity',()=>{expect(()=>delegationOriginalCall([message],{...prepared,turnId:undefined})).toThrow('Incomplete');});
});
describe('approval-preserving delegation contract',()=>{
 it('uses distinct owned effects and a bounded child hold',()=>{const plan=approvalDelegationPlan(token,'terminal-owned');expect(plan.child).toContain('Start-Sleep -Seconds 10');expect(plan.child).toContain('delegation-child-'+token);expect(plan.parent).toContain('delegation-parent-'+token);expect(plan.spawn.requiredTools).toEqual(['run_terminal_command']);});
 it('rejects unowned identities',()=>{expect(()=>approvalDelegationPlan('../escape','terminal-owned')).toThrow();expect(()=>approvalDelegationPlan(token,'other')).toThrow();});
 it('accepts only the exact declared spawn',()=>{const plan=approvalDelegationPlan(token,'terminal-owned');expect(matchesDelegationSpawn(plan.spawn,plan.spawn)).toBe(true);});
 it('predeclares the one-shot child budget before model invocation',()=>{expect(approvalDelegationPlan(token,'terminal-owned').spawn.budget).toEqual({maxTurns:1,timeoutMs:180000});});
 it.each([undefined,null,[],{maxTurns:256,timeoutMs:86400000},{maxTurns:1},{maxTurns:1,timeoutMs:180000,maxToolCalls:1}])('rejects missing or altered budget without repairing the proposal: %j',budget=>{const plan=approvalDelegationPlan(token,'terminal-owned');expect(matchesDelegationSpawn({...plan.spawn,budget},plan.spawn)).toBe(false);});
 it.each([{role:'operator'},{inheritanceMode:'safePrefix'},{targetIds:['terminal-other']},{requiredTools:['write_file']},{goal:'changed'},{budget:{maxTurns:20}}])('rejects changed delegation scope: %j',change=>{const plan=approvalDelegationPlan(token,'terminal-owned');expect(matchesDelegationSpawn({...plan.spawn,...change},plan.spawn)).toBe(false);});
 it('declares cooperative before model invocation without weakening source or timeouts',()=>{const plan=approvalDelegationPlan(token,'terminal-owned');expect(plan.spawn.goal).toContain('"lifecycleTrust":"cooperative"');expect(matchesDelegationNativeArgs({command:plan.child,background:false,timeoutMs:30000,lifecycleTrust:'cooperative'},plan.child,true)).toBe(true);expect(matchesDelegationNativeArgs({command:plan.parent,background:false,timeoutMs:5000,lifecycleTrust:'cooperative'},plan.parent,false)).toBe(true);});
 it.each([{lifecycleTrust:'directRequired'},{lifecycleTrust:undefined},{background:true},{timeoutMs:5000},{command:'changed'},{shell:'direct'}])('rejects proposal deviation without stripping it: %j',change=>{const plan=approvalDelegationPlan(token,'terminal-owned');expect(matchesDelegationNativeArgs({command:plan.child,background:false,timeoutMs:30000,lifecycleTrust:'cooperative',...change},plan.child,true)).toBe(false);});
});
describe('delegation approval evidence classification',()=>{
 const spawn={sessionId:'parent',turnId:'p-turn',stepId:'p-step',callId:'call-1'},child={sessionId:'child',turnId:'c-turn',stepId:'c-step',callId:'call-1'},parent={sessionId:'parent',turnId:'p-turn',stepId:'p-next',callId:'call-2'};
 const calls=[{...spawn,name:'spawn_one_shot_agent'},{...child,name:'run_terminal_command'},{...parent,name:'run_terminal_command'}];
 const approved=[{...spawn,reason:'orchestrationCapabilityAuthorized'},{...child,reason:'nativeApprovalCommitted',approvalId:'child-approval'},{...parent,reason:'nativeApprovalCommitted',approvalId:'parent-approval'}];
 const requested=[{...child,reason:'nativePolicyRequiresApproval',approvalId:'child-approval'},{...parent,reason:'nativePolicyRequiresApproval',approvalId:'parent-approval'}];
 it('separates policy orchestration from two explicit native approvals with reused call IDs',()=>{expect(countDelegationApprovals(calls,approved,requested)).toEqual({native:2,orchestration:1,total:3});});
 it('rejects native approval without its actual request',()=>{expect(()=>countDelegationApprovals(calls,approved,requested.slice(1))).toThrow('matching committed request');});
 it('rejects duplicate approved events',()=>{expect(()=>countDelegationApprovals(calls,[...approved,approved[1]],requested)).toThrow('duplicate approval');});
 it('rejects a cross-session call-ID match',()=>{expect(()=>countDelegationApprovals(calls,[{...approved[1],sessionId:'other'}],requested)).toThrow('Unmatched');});
 it('rejects incomplete call identity',()=>{expect(()=>countDelegationApprovals(calls,[{...approved[0],turnId:undefined}],requested)).toThrow('Incomplete');});
 it('rejects a changed policy reason rather than silently ignoring the event',()=>{expect(()=>countDelegationApprovals(calls,[{...approved[0],reason:'other-policy'},...approved.slice(1)],requested)).toThrow('policy differs');});
});
