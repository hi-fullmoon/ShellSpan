import {nativeByteBoundaryJson} from './native-byte-boundary-plan';
import {matchesNativeFileChainStep, type NativeFileChainPlan} from './native-file-chain-approval';
import {verifyNativeFileOwnershipIdentity} from './native-file-chain-edit';
import {nativeJobHistorySource} from './native-job-ownership-plan';

export interface NativeFileReferencePlan extends NativeFileChainPlan {readonly token:string;readonly final:string;readonly history:string;readonly marker:string;}
export function nativeFileReferencePlan(token:string,cwd:string):NativeFileReferencePlan{
 if(!/^[a-f0-9-]{36}$/.test(token)||!cwd)throw Error('Owned file-reference identity/cwd required');
 const value='parent-'+token,quote=(text:string)=>"'"+text.split("'").join("''")+"'",marker='B08_REFERENCE_RUNNING_'+token;
 const setup=`$global:B08ReferenceParent=${quote(value)}; function global:B08ReferenceParentFn { 'B08_FN' }; Write-Output 'B08_REFERENCE_READY'`;
 const content=`if((Get-Location).ProviderPath -cne ${quote(cwd)}){throw 'worker cwd changed'}\n$p=[Diagnostics.Process]::GetCurrentProcess()\n$r=@{runId=${quote(token)};workerPid=$PID;workerCreated=$p.StartTime.ToUniversalTime().ToString('o');executable=$p.MainModule.FileName}\n$b=[Text.UTF8Encoding]::new($false).GetBytes(($r|ConvertTo-Json -Compress))\n$s=[IO.File]::Open((Join-Path $env:SHELLSPAN_LOCAL_HOME 'native-file-worker-${token}.json'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)\ntry{$s.Write($b,0,$b.Length)}finally{$s.Dispose()}\n[Console]::WriteLine(${quote(marker)})\nwhile($true){Start-Sleep -Milliseconds 25}`;
 const final=`if($global:B08ReferenceParent -cne ${quote(value)}){throw 'parent variable changed'}; if((B08ReferenceParentFn) -cne 'B08_FN'){throw 'parent function changed'}; if((Get-Location).ProviderPath -cne ${quote(cwd)}){throw 'parent cwd changed'}; Write-Output 'B08_REFERENCE_PARENT_OK'`;
 return{token,fileName:`acceptance-${token}.ps1`,content,setup,final,history:nativeJobHistorySource,marker};
}
export const nativeFileReferenceTools=['run_terminal_command','write_file','read_file','run_terminal_command','wait_process','kill_process','run_terminal_command','run_terminal_command'] as const;
export function matchesNativeFileReferenceStep(plan:NativeFileReferencePlan,index:number,name:string,value:unknown,handle?:string):boolean{
 if(name!==nativeFileReferenceTools[index]||!value||typeof value!=='object'||Array.isArray(value))return false;const args=value as Record<string,unknown>;
 if(index===1)return matchesNativeFileChainStep(1,name,args,plan);
 if(index===2)return matchesNativeFileChainStep(2,name,args,plan)&&args.path===plan.fileName&&args.offset===0&&args.maxBytes===8192;
 if(index===0||index===3||index===6||index===7){const source=index===0?plan.setup:index===3?plan.invoke:index===6?plan.final:plan.history;return typeof source==='string'&&args.command===source&&args.timeoutMs===(index===3?60000:5000)&&(index===3?args.background===true:args.background===undefined||args.background===false)&&(args.lifecycleTrust===undefined||args.lifecycleTrust==='cooperative')&&(args.explanation===undefined||typeof args.explanation==='string')&&Object.keys(args).every(key=>['command','background','timeoutMs','lifecycleTrust','explanation'].includes(key));}
 if(!handle||!/^job-[a-f0-9]{32}$/.test(handle)||args.processHandle!==handle)return false;
 return index===4?Object.keys(args).length===2&&args.timeoutMs===1000:index===5&&Object.keys(args).length===3&&args.signal==='terminate'&&args.timeoutMs===10000;
}
export function matchesNativeFileReferenceOriginal(plan:NativeFileReferencePlan,index:number,name:string,value:unknown,handle?:string):boolean{
 if(!matchesNativeFileReferenceStep(plan,index,name,value,handle))return false;return ![0,6,7].includes(index)||(value as Record<string,unknown>).background===false;
}
export function nativeFileReferenceInitialGoal(plan:NativeFileReferencePlan):string{
 return `Perform exactly FIVE serial calls, one at a time after the actual prior result. Use the original bound native terminal and normal approvals. No retries, extra tools, source repair, Direct or permission changes.\n1 run_terminal_command with command=${nativeByteBoundaryJson(plan.setup)},background=false,timeoutMs=5000.\n2 write_file with fileScope="scratch",path=${JSON.stringify(plan.fileName)},content=${nativeByteBoundaryJson(plan.content)},precondition={"mustNotExist":true}. Preserve every source byte and no trailing newline.\n3 read_file with fileScope="scratch",path=${JSON.stringify(plan.fileName)},encoding="utf8",offset=0,maxBytes=8192.\n4 run_terminal_command with background=true,timeoutMs=60000 and command consisting ONLY of &, one ASCII space, then the exact returned write_file absolute path in single quotes. Double any single quote in the path; preserve every backslash and prefix. Execute that path, not its script text.\n5 wait_process with exactly processHandle=the actual call4 returned job handle and timeoutMs=1000. Then stop this turn and wait for a follow-up. Do not stop, edit, delete or execute other source.`;
}
export function nativeFileReferenceContinuationGoal(plan:NativeFileReferencePlan,handle:string):string{
 if(!/^job-[a-f0-9]{32}$/.test(handle))throw Error('Original actual file worker handle required');return `Perform exactly THREE more serial calls, one per assistant response after the real result. No retries, other tools, Direct, source or option changes.\n1 kill_process with exactly ${JSON.stringify({processHandle:handle,signal:'terminate',timeoutMs:10000})}.\n2 run_terminal_command with command=${nativeByteBoundaryJson(plan.final)},background=false,timeoutMs=5000.\n3 run_terminal_command with command=${nativeByteBoundaryJson(plan.history)},background=false,timeoutMs=5000. Then stop.`;
}
export async function verifyNativeFileProcessReference(state:Record<string,unknown>,id:string,sessionId:string,cwd:string,path:string,handle:string){
 if(!/^job-[a-f0-9]{32}$/.test(handle))throw Error('Original file process handle required');const record=await verifyNativeFileOwnershipIdentity(state,id,sessionId,cwd,path),uses=Object.values(record.uses as Record<string,unknown>);
 // Usage's enum tag is camelCase; its unannotated task_id field remains snake_case.
 if(uses.length!==1)throw Error('Exact single process reference required');const use=uses[0] as Record<string,unknown>;if(!use||typeof use!=='object'||use.state!=='process'||use.handle!==handle||use.task_id!==id)throw Error('Original active file process reference missing');
 if(use.executionTarget!==undefined){const target=use.executionTarget as Record<string,unknown>;if(record.version!==2||target?.kind!=='local'||target.sessionId!==sessionId||target.targetId!=='terminal-'+sessionId||target.cwd!==cwd)throw Error('File process reference changed execution target');}
 return{key:record.key,handle,taskId:id,retained:true,state:'process' as const};
}
