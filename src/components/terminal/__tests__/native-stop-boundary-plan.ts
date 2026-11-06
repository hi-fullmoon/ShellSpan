import type {TerminalCommandObservation} from '@/types';
export const stopBoundaryStages=['typing','fullInput','durableIntent','armed','beforeAccept','afterAccept','running'] as const;
export type StopBoundaryStage=typeof stopBoundaryStages[number];
export type StopBoundaryAction='cancel'|'takeover';
export type ControlledStopBoundaryStage='durableIntent'|'armed'|'beforeAccept'|'afterAccept';
export function stopBoundaryPlan(token:string,stage:ControlledStopBoundaryStage,action:StopBoundaryAction){
 if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(token)||!['durableIntent','armed','beforeAccept','afterAccept'].includes(stage)||!['cancel','takeover'].includes(action))throw Error('Explicit owned stop boundary required');
 const marker='stop-boundary-'+token+'.txt',file="(Join-Path $env:SHELLSPAN_LOCAL_HOME '"+marker+"')";
 const command=stage==='beforeAccept'||stage==='afterAccept'?"[IO.File]::AppendAllText("+file+",'START'+[Environment]::NewLine); while ($true) { Start-Sleep -Milliseconds 50 }; [IO.File]::AppendAllText("+file+",'DONE'+[Environment]::NewLine)":"[IO.File]::AppendAllText("+file+",'UNEXPECTED'+[Environment]::NewLine)",args={command,background:false,timeoutMs:30000,lifecycleTrust:'cooperative'};
 return {stage,action,marker,command,args,goal:`Call run_terminal_command exactly ONCE with this exact JSON object: ${JSON.stringify(args)}. This is an owned native cancellation-boundary acceptance case. Preserve every decoded source character. The independently observed ${stage} phase will receive ${action}. Do not repair,retry,replay,use Direct or other tools. Then stop.`};
}
export function matchesStopBoundaryArgs(value:unknown,command:string,prepared=false):boolean{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;const args=value as Record<string,unknown>,allowed=prepared?['command','timeoutMs','explanation']:['command','background','timeoutMs','lifecycleTrust','explanation'];
 return Object.keys(args).every(key=>allowed.includes(key))&&args.command===command&&args.timeoutMs===30000&&(args.explanation===undefined||typeof args.explanation==='string')&&(prepared||args.background===false&&args.lifecycleTrust==='cooperative');
}
export function isPreAcceptBoundary(command:TerminalCommandObservation|undefined,id:string):boolean{
 return !!command&&command.agentSessionId===id&&command.phase==='inputConfirmed'&&command.fullInputConfirmed&&command.submissionIntentDurable&&!command.mayHaveSubmitted&&!command.draftCleared&&command.executionEvidence==='unknown';
}
// Envelope only. Caller must independently verify the original durable identity,
// empty recovery, safe prompt/lease, late Enter and no source effect.
export function isConfirmedPreAcceptCancel(status:string,value:unknown,action:StopBoundaryAction='cancel'):boolean{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const data=value as Record<string,unknown>,details=data.errorDetails;
 if(!details||typeof details!=='object'||Array.isArray(details))return false;
 const error=details as Record<string,unknown>;
 const stopped=status==='cancelled'||action==='takeover'&&status==='failed'&&data.error==='TERMINAL_BROKER_LEASE_IDENTITY_MISMATCH'&&error.code==='TERMINAL_SUBMISSION_REJECTED';
 return stopped&&data.execution==='notStarted'&&data.noAutoReplay===true&&error.phase==='beforeSubmission'&&error.execution==='notStarted'&&error.terminalRecoveryRequired===false;
}
