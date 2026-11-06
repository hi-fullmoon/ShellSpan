import {nativeJobCompletionPlan} from './native-job-completion-plan';
import {validNativeJobWaitOutputLimit} from './native-jobs-approval';
export function nativeJobRetiredPlan(marker:string,tool:'wait_process'|'kill_process'){
 if(tool!=='wait_process'&&tool!=='kill_process')throw Error('Explicit retired handle tool required');
 return {...nativeJobCompletionPlan(marker,tool==='wait_process'?0:7),retiredTool:tool};
}
interface RetiredTerminalIdentity {readonly terminalSessionId:string;readonly terminalGeneration:number;readonly transportSessionId:string;readonly open:boolean;}
export function isActualNativeJobReplacement(previous:RetiredTerminalIdentity,next:RetiredTerminalIdentity):boolean{
 return !!previous.terminalSessionId&&!!previous.transportSessionId&&!!next.transportSessionId&&!previous.open&&next.open&&Number.isSafeInteger(previous.terminalGeneration)&&Number.isSafeInteger(next.terminalGeneration)&&previous.terminalGeneration>0&&next.terminalSessionId===previous.terminalSessionId&&next.terminalGeneration===previous.terminalGeneration+1&&next.transportSessionId!==previous.transportSessionId;
}
export function isRetiredOwnerSubmissionRefusal(value:unknown):boolean{return (value instanceof Error?value.message:String(value)).replace(/^Error: /,'')==='ended Agent session does not accept new events';}
export function matchesRetiredHandleQuery(value:unknown,handle:string,tool:'wait_process'|'kill_process'):boolean{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;const args=value as Record<string,unknown>;
 return args.processHandle===handle&&args.timeoutMs===(tool==='wait_process'?1000:10000)&&(tool==='wait_process'?validNativeJobWaitOutputLimit(args.maxOutputBytes)&&!('signal'in args):args.signal==='terminate')&&Object.keys(args).every(key=>['processHandle','timeoutMs','signal','explanation',...(tool==='wait_process'?['maxOutputBytes']:[])].includes(key));
}
export function nativeRetiredCaptureError(status:number,detail:string):string{return `Actual replacement window capture refused (HTTP ${status}): ${detail.slice(0,4096)}`;}
