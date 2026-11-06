import {nativePowerShellJobSources} from './native-job-lifecycle-plan';
import {validNativeJobWaitOutputLimit} from './native-jobs-approval';

export function nativeJobCompletionPlan(marker:string,exitCode:0|7){
 if(exitCode!==0&&exitCode!==7)throw Error('Explicit native completion exit required');
 const [setup,original]=nativePowerShellJobSources(marker),early=`B06_EARLY_${marker}`,tail=`B06_TAIL_${marker}`,release=`B06_RELEASE_${marker}`,after=`B06_AFTER_${marker}`;
 const sources:readonly [string,string,string]=[setup,`${original}\n[Console]::Write('B06_TAIL_'); Start-Sleep -Milliseconds 100; [Console]::WriteLine('${marker}'); exit ${exitCode}`.replace("while (-not",`[Console]::WriteLine('${early}')\nwhile (-not`),`[Console]::WriteLine('${release}'); [IO.File]::WriteAllText($env:SHELLSPAN_NATIVE_COMPLETION_GATE,'released'); Start-Sleep -Milliseconds 500; [Console]::WriteLine('${after}')`];
 const goal=`Execute exactly FIVE calls on the bound visible terminal. Emit exactly ONE tool call per response and await its real tool/result before the next. No Direct, retries, kill_process, extra tools or changed source. The fenced blocks are RAW shell text, not JSON literals. Encode once in tool arguments, preserving embedded newlines, the actual Tab and quotes. No source has a trailing CR/LF. Call1 run_terminal_command SETUP;call2 run_terminal_command background=true BACKGROUND;call3 wait_process on its returned job-* handle timeoutMs=1000;call4 run_terminal_command RELEASE;call5 wait_process on that same handle timeoutMs=10000. Then reply done. Source exit7 is intentional and must not trigger a repair.\n\nSETUP:\n~~~sh\n${sources[0]}\n~~~\nBACKGROUND:\n~~~sh\n${sources[1]}\n~~~\nRELEASE:\n~~~sh\n${sources[2]}\n~~~`;
 return {sources,goal,exitCode,early,tail,release,after};
}

export function matchesNativeJobCompletionStep(step:number,value:unknown,sources:readonly [string,string,string],name:string,handle?:string):boolean{
 if(!value||typeof value!=='object'||Array.isArray(value)||name!==['run_terminal_command','run_terminal_command','wait_process','run_terminal_command','wait_process'][step])return false;
 const args=value as Record<string,unknown>;
 if(step===0||step===1||step===3)return args.command===sources[step===3?2:step]&&Object.keys(args).every(k=>['command','background','timeoutMs','explanation','lifecycleTrust'].includes(k))&&(step===1?args.background===true:args.background===undefined||args.background===false)&&(args.lifecycleTrust===undefined||args.lifecycleTrust==='cooperative')&&(args.timeoutMs===undefined||typeof args.timeoutMs==='number'&&Number.isInteger(args.timeoutMs)&&args.timeoutMs>0);
 return !!handle?.startsWith('job-')&&args.processHandle===handle&&args.timeoutMs===(step===2?1000:10000)&&validNativeJobWaitOutputLimit(args.maxOutputBytes)&&Object.keys(args).every(k=>['processHandle','timeoutMs','maxOutputBytes','explanation'].includes(k));
}
