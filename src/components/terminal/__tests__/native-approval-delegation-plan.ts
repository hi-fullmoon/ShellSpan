import type {AgentSessionEvent,AgentSessionRecordedToolCall} from '@/types/agent-session';

export function approvalDelegationPlan(token:string,targetId:string){
 if(!/^[a-f0-9-]{36}$/.test(token)||!targetId.startsWith('terminal-'))throw Error('Owned delegation identity required');
 const child=`[IO.File]::AppendAllText((Join-Path $env:SHELLSPAN_LOCAL_HOME 'delegation-child-${token}.txt'),'START'+[Environment]::NewLine); Start-Sleep -Seconds 10; [IO.File]::AppendAllText((Join-Path $env:SHELLSPAN_LOCAL_HOME 'delegation-child-${token}.txt'),'END'+[Environment]::NewLine)`;
 const parent=`[IO.File]::AppendAllText((Join-Path $env:SHELLSPAN_LOCAL_HOME 'delegation-parent-${token}.txt'),'ONCE'+[Environment]::NewLine)`;
 const goal=`Call run_terminal_command exactly ONCE with this exact JSON argument object: ${JSON.stringify({command:child,background:false,timeoutMs:30000,lifecycleTrust:'cooperative'})}. Decode the command string once normally,preserve every character and every declared parameter. This is a known cooperative owned marker/sleep test,not process isolation or a sandbox. No other tools,Direct,repair or retries. Then reply done.`;
 const spawn={goal,role:'general',inheritanceMode:'blank',targetIds:[targetId],requiredTools:['run_terminal_command'],budget:{maxTurns:1,timeoutMs:180000}};
 return {child,parent,spawn};
}
export function matchesDelegationNativeArgs(value:unknown,source:string,child:boolean):boolean{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;const args=value as Record<string,unknown>;
 return Object.keys(args).every(key=>['command','background','timeoutMs','lifecycleTrust','explanation'].includes(key))&&args.command===source&&args.background===false&&args.timeoutMs===(child?30000:5000)&&args.lifecycleTrust==='cooperative';
}
export function matchesDelegationPreparedNativeArgs(value:unknown,source:string,child:boolean):boolean{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;const args=value as Record<string,unknown>;
 return Object.keys(args).length===3&&Object.keys(args).every(key=>['command','explanation','timeoutMs'].includes(key))&&args.command===source&&args.timeoutMs===(child?30000:5000)&&typeof args.explanation==='string'&&args.explanation.trim().length>0;
}
export function delegationOriginalCall(events:readonly AgentSessionEvent[],prepared:Extract<AgentSessionEvent,{type:'tool/call'}>):AgentSessionRecordedToolCall{
 if(!prepared.sessionId||!prepared.turnId||!prepared.stepId||!prepared.data.call.callId)throw Error('Incomplete original call identity');
 const calls=events.flatMap(event=>event.type==='assistant/message'&&event.sessionId===prepared.sessionId&&event.turnId===prepared.turnId&&event.stepId===prepared.stepId?event.data.content.flatMap(block=>block.type==='toolCall'&&block.call.callId===prepared.data.call.callId?[block.call]:[]):[]);
 if(calls.length!==1||calls[0].name!==prepared.data.call.name)throw Error('Missing,duplicate or mismatched original model proposal');return calls[0];
}
export function matchesDelegationSpawn(value:unknown,expected:ReturnType<typeof approvalDelegationPlan>['spawn']):boolean{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;const args=value as Record<string,unknown>;
 const budget=args.budget;
 return Object.keys(args).length===6&&args.goal===expected.goal&&args.role===expected.role&&args.inheritanceMode===expected.inheritanceMode&&Array.isArray(args.targetIds)&&args.targetIds.length===1&&args.targetIds[0]===expected.targetIds[0]&&Array.isArray(args.requiredTools)&&args.requiredTools.length===1&&args.requiredTools[0]==='run_terminal_command'&&!!budget&&typeof budget==='object'&&!Array.isArray(budget)&&Object.keys(budget).length===2&&'maxTurns'in budget&&budget.maxTurns===expected.budget.maxTurns&&'timeoutMs'in budget&&budget.timeoutMs===expected.budget.timeoutMs;
}
interface DelegationCallIdentity {readonly sessionId:string;readonly turnId?:string;readonly stepId?:string;readonly callId:string;readonly name:string;}
interface DelegationApprovalIdentity {readonly sessionId:string;readonly turnId?:string;readonly stepId?:string;readonly callId:string;readonly approvalId?:string;readonly reason?:string;}
export function countDelegationApprovals(calls:readonly DelegationCallIdentity[],approved:readonly DelegationApprovalIdentity[],requested:readonly DelegationApprovalIdentity[]):Readonly<{native:number;orchestration:number;total:number}>{
 const key=(value:DelegationApprovalIdentity|DelegationCallIdentity)=>{if(!value.sessionId||!value.turnId||!value.stepId||!value.callId)throw Error('Incomplete approval call identity');return JSON.stringify([value.sessionId,value.turnId,value.stepId,value.callId]);};
 const seen=new Set<string>();let native=0,orchestration=0;
 for(const approval of approved){const identity=key(approval),matching=calls.filter(call=>key(call)===identity);if(matching.length!==1||seen.has(identity))throw Error('Unmatched or duplicate approval');seen.add(identity);const call=matching[0];
  if(call.name==='run_terminal_command'){
   if(approval.reason!=='nativeApprovalCommitted'||!approval.approvalId||!requested.some(request=>key(request)===identity&&request.approvalId===approval.approvalId&&request.reason==='nativePolicyRequiresApproval'))throw Error('Native approval lacks matching committed request');native++;
  }else if(call.name==='spawn_one_shot_agent'){
   if(approval.reason!=='orchestrationCapabilityAuthorized'||approval.approvalId!==undefined||requested.some(request=>key(request)===identity))throw Error('Orchestration approval policy differs');orchestration++;
  }else throw Error('Unexpected approved tool');
 }
 return {native,orchestration,total:approved.length};
}
