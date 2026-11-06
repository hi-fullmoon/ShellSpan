import {approvalDelegationPlan} from './native-approval-delegation-plan';

export function matchesDelegatedTakeoverLease(view:{agentSessionId:string;operationId:string;terminalOwned:boolean;takeoverRequested:boolean;takeoverFailed:boolean}|undefined,active:{agentSessionId:string;operationId:string;phase:string;fullInputConfirmed:boolean;submissionIntentDurable:boolean;executionEvidence:string}|undefined,childId:string):boolean{
 return !!view&&!!active&&view.agentSessionId===childId&&active.agentSessionId===childId&&view.operationId===active.operationId&&view.terminalOwned&&!view.takeoverRequested&&!view.takeoverFailed&&active.phase==='running'&&active.fullInputConfirmed&&active.submissionIntentDurable&&active.executionEvidence==='startObserved';
}

export function approvalDelegationClosePlan(token:string,targetId:string,otherTargetId:string,mode:'close'|'takeover'='close'){
 const base=approvalDelegationPlan(token,targetId);approvalDelegationPlan(token,otherTargetId);
 if(targetId===otherTargetId)throw Error('Independent other terminal required');
 const source=(who:'child'|'other')=>`[IO.File]::AppendAllText((Join-Path $env:SHELLSPAN_LOCAL_HOME 'delegation-${who}-${token}.txt'),'START'+[Environment]::NewLine); while ($true) { Start-Sleep -Milliseconds 50 }; [IO.File]::AppendAllText((Join-Path $env:SHELLSPAN_LOCAL_HOME 'delegation-${who}-${token}.txt'),'END'+[Environment]::NewLine)`;
 const child=source('child'),other=source('other');
 const commandGoal=(command:string)=>`Call run_terminal_command exactly ONCE with this exact JSON argument object: ${JSON.stringify({command,background:false,timeoutMs:30000,lifecycleTrust:'cooperative'})}. Preserve every declared parameter and decoded source character. This is an intentional owned running-${mode}/cancel test;cooperative is not a sandbox. No Direct,repair,retries or other tools. Then stop.`;
 const spawn={...base.spawn,goal:commandGoal(child)};
 return {child,other,spawn,parentGoal:`Call spawn_one_shot_agent exactly ONCE with this exact JSON argument object: ${JSON.stringify(spawn)}. Wait for its actual settlement,then stop. No other tools,native parent commands,retries or replacement children.`,otherGoal:commandGoal(other)};
}
