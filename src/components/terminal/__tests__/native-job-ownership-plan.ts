import {nativeJobCompletionPlan,matchesNativeJobCompletionStep} from './native-job-completion-plan';

export const nativeJobHistorySource="$h=@([Microsoft.PowerShell.PSConsoleReadLine]::GetHistoryItems() | ForEach-Object { $b=[Text.Encoding]::UTF8.GetBytes($_.CommandLine); $s=[Security.Cryptography.SHA256]::Create(); try { @{sha256=([BitConverter]::ToString($s.ComputeHash($b))).Replace('-','').ToLowerInvariant(); bytes=$b.Length} } finally { $s.Dispose() } }); [Console]::WriteLine('B06_HISTORY_'+(ConvertTo-Json -InputObject $h -Compress))";
export function nativeJobOwnershipStepMayFollow(step:number,completed:number,priorSteps:readonly string[],nextStep:string|undefined):boolean{return Number.isInteger(step)&&step>=0&&step<8&&completed===step&&!!nextStep&&!priorSteps.includes(nextStep);}
export const nativeJobForeignModelDeadlineMs=40000;
/** This check can only refuse; backend approval expiry remains authoritative. */
export function nativeJobOwnershipApprovalUsable(requestedAt:number,now:number):boolean{return Number.isFinite(requestedAt)&&Number.isFinite(now)&&now>=requestedAt&&now<requestedAt+55000;}
export function nativeJobOwnershipPlan(marker:string,foreignTool:'wait_process'|'kill_process'){
 if(foreignTool!=='wait_process'&&foreignTool!=='kill_process')throw Error('Explicit foreign job tool required');
 const completion=nativeJobCompletionPlan(marker,foreignTool==='wait_process'?0:7),sources:readonly [string,string,string,string]=[...completion.sources,nativeJobHistorySource];
 const goal=completion.goal.replace('exactly FIVE','exactly EIGHT').replace('kill_process, extra tools','extra tools').replace('Then reply done. Source exit7',`Call6 kill_process on that same already-exited handle signal=terminate timeoutMs=10000;call7 wait_process on the same already-exited handle timeoutMs=1000;call8 run_terminal_command HISTORY. These two completed-handle observations must not restart anything. Then reply done. Source exit7`)+`\nHISTORY:\n~~~sh\n${sources[3]}\n~~~`;
 return {...completion,sources,goal,foreignTool};
}
export function matchesNativeJobOwnershipStep(step:number,value:unknown,sources:readonly [string,string,string,string],name:string,handle?:string):boolean{
 if(step<5)return matchesNativeJobCompletionStep(step,value,[sources[0],sources[1],sources[2]],name,handle);
 if(!value||typeof value!=='object'||Array.isArray(value))return false;const args=value as Record<string,unknown>;
 if(step===7)return matchesNativeJobCompletionStep(3,value,[sources[0],sources[1],sources[3]],name);
 return (step===5||step===6)&&!!handle?.startsWith('job-')&&args.processHandle===handle&&name===(step===5?'kill_process':'wait_process')&&args.timeoutMs===(step===5?10000:1000)&&(step===5?args.signal==='terminate':!('signal'in args))&&Object.keys(args).every(k=>['processHandle','timeoutMs','signal','explanation'].includes(k));
}
export function foreignJobGoal(handle:string,tool:'wait_process'|'kill_process'){
 if(!/^job-[a-f0-9]{32}$/.test(handle)||!['wait_process','kill_process'].includes(tool))throw Error('Exact owned fixture handle/tool required');const args=tool==='wait_process'?{processHandle:handle,timeoutMs:1000}:{processHandle:handle,signal:'terminate',timeoutMs:10000};return {tool,args,goal:`Call ${tool} exactly ONCE with this exact JSON object: ${JSON.stringify(args)}. This is an intentional ownership refusal check using a different Agent task. If rejected, stop and reply done;do not repair,retry,use Direct,run source or call any other tool.`};
}
