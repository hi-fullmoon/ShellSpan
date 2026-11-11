import {nativePowerShellJobSources} from './native-job-lifecycle-plan';
import {nativeJobHistorySource} from './native-job-ownership-plan';
import type {AgentSessionEvent} from '@/types/agent-session';

export function nativeJobStdinPlan(marker:string){
 const original=nativePowerShellJobSources(marker);
 return{sources:[...original,nativeJobHistorySource] as const,input:`B06_NATIVE_STDIN_${marker}\n`,expectedError:'TERMINAL_JOB_STDIN_UNSUPPORTED',tools:['run_terminal_command','run_terminal_command','write_process_input','wait_process','kill_process','run_terminal_command','run_terminal_command'] as const};
}
export function nativeJobStdinArguments(plan:ReturnType<typeof nativeJobStdinPlan>,step:number,handle?:string):Record<string,unknown>{
 if(!Number.isInteger(step)||step<0||step>6)throw Error('Exact native stdin step required');
 if(step===0||step===1||step===5||step===6)return{command:plan.sources[step===5?2:step===6?3:step],background:step===1};
 if(!handle||!/^job-[a-f0-9]{32}$/.test(handle))throw Error('Original actual native job handle required');
 if(step===2)return{processHandle:handle,input:plan.input,close:false};
 return step===3?{processHandle:handle,timeoutMs:1000}:{processHandle:handle,signal:'terminate',timeoutMs:10000};
}
export function matchesNativeJobStdinStep(plan:ReturnType<typeof nativeJobStdinPlan>,step:number,name:string,value:unknown,handle?:string):boolean{
 if(!value||typeof value!=='object'||Array.isArray(value)||name!==plan.tools[step])return false;
 const actual=value as Record<string,unknown>;let expected:Record<string,unknown>;try{expected=nativeJobStdinArguments(plan,step,handle);}catch{return false;}
 if(step===2&&Object.keys(actual).some(key=>!Object.prototype.hasOwnProperty.call(expected,key)))return false;
 const command='command'in expected;
 if(Object.keys(actual).some(key=>!Object.prototype.hasOwnProperty.call(expected,key)&&key!=='explanation'&&!(command&&['timeoutMs','lifecycleTrust'].includes(key))))return false;
 if(actual.explanation!==undefined&&typeof actual.explanation!=='string')return false;
 if(command){return actual.command===expected.command&&(expected.background===true?actual.background===true:actual.background===undefined||actual.background===false)&&(actual.lifecycleTrust===undefined||actual.lifecycleTrust==='cooperative')&&(actual.timeoutMs===undefined||typeof actual.timeoutMs==='number'&&Number.isSafeInteger(actual.timeoutMs)&&actual.timeoutMs>0);}
 return Object.entries(expected).every(([key,item])=>actual[key]===item);
}
export function nativeJobStdinGoal(plan:ReturnType<typeof nativeJobStdinPlan>):string{
 return `Perform exactly SEVEN serial calls on the bound native terminal, one per assistant response after its real result. No Direct, retries, extra calls or source/option repair. Call1 run_terminal_command SETUP. Call2 run_terminal_command background=true BACKGROUND. Call3 write_process_input with the original returned job handle, input=${JSON.stringify(plan.input)}, close=false. This is an intentional negative case: expect ${plan.expectedError}; do not switch surface, alter input, close the job or retry. Continue with call4 wait_process on the same handle timeoutMs=1000. Call5 kill_process on that handle signal=terminate timeoutMs=10000. Call6 run_terminal_command FINAL, whose exit7 is intentional. Call7 run_terminal_command HISTORY. Then stop. Preserve all raw source characters, actual Tab and embedded newlines, encode once, and do not add trailing CR/LF.\nSETUP:\n~~~sh\n${plan.sources[0]}\n~~~\nBACKGROUND:\n~~~sh\n${plan.sources[1]}\n~~~\nFINAL:\n~~~sh\n${plan.sources[2]}\n~~~\nHISTORY:\n~~~sh\n${plan.sources[3]}\n~~~`;
}

export function matchesNativeJobStdinReceipt(plan:ReturnType<typeof nativeJobStdinPlan>,value:unknown,handle:string):boolean{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;const args=value as Record<string,unknown>;
 return Object.keys(args).length===4&&Object.keys(args).every(key=>['processHandle','close','byteLength','contentPersisted'].includes(key))&&args.processHandle===handle&&args.close===false&&args.byteLength===new TextEncoder().encode(plan.input).length&&args.contentPersisted===false;
}

/** Read-only validation of the normal argument JSON stream; no input is repaired or persisted. */
export function createNativeJobStdinStreamTracker(){
 const streams=new Map<string,{turnId:string;stepId:string;index:number;name:string;arguments:string;bytes:number;requestId:string;providerCallId?:string}>();
 const key=(turnId:string,stepId:string,index:number)=>JSON.stringify([turnId,stepId,index]);
 return{
  observe(event:AgentSessionEvent){
   if(event.type!=='assistant/chunk'||!event.data.toolCallDelta)return;
   const delta=event.data.toolCallDelta;if(!event.turnId||!event.stepId||!Number.isSafeInteger(delta.index))throw Error('Actual stdin stream identity missing');
   const id=key(event.turnId,event.stepId,delta.index),value=streams.get(id)??{turnId:event.turnId,stepId:event.stepId,index:delta.index,name:'',arguments:'',bytes:0,requestId:event.data.requestId};
   if(value.requestId!==event.data.requestId)throw Error('Actual stdin stream request identity changed');
   if(delta.callId){if(value.providerCallId&&value.providerCallId!==delta.callId)throw Error('Actual stdin provider identity changed');value.providerCallId=delta.callId;}
   value.name+=delta.nameDelta??'';value.arguments+=delta.argumentsDelta??'';value.bytes+=new TextEncoder().encode(delta.argumentsDelta??'').length;
   if(value.bytes>65536)throw Error('Owned tool argument stream exceeded its observation bound');streams.set(id,value);
  },
  discard(turnId:string|undefined,stepId:string|undefined){for(const[id,value]of streams)if(value.turnId===turnId&&value.stepId===stepId)streams.delete(id);},
  verify(call:Extract<AgentSessionEvent,{type:'tool/call'}>,plan:ReturnType<typeof nativeJobStdinPlan>,handle:string){
   const values=[...streams.values()].filter(value=>value.turnId===call.turnId&&value.stepId===call.stepId);
   try{
    if(values.length!==1||values[0].name!=='write_process_input'||call.data.call.name!=='write_process_input')throw Error('Exactly one actual stdin proposal stream required');
    const value=values[0],provider=call.data.call.providerCallId;if(provider&&value.providerCallId&&provider!==value.providerCallId)throw Error('Actual stdin proposal/provider identity mismatch');
    let args:unknown;try{args=JSON.parse(value.arguments);}catch{throw Error('Actual stdin argument JSON was unavailable or invalid');}
    if(!matchesNativeJobStdinStep(plan,2,'write_process_input',args,handle))throw Error('Actual model stdin source/options differ from the unchanged fixture');
    return{turnId:call.turnId,stepId:call.stepId,callId:call.data.call.callId,requestId:value.requestId,toolIndex:value.index,providerCallId:value.providerCallId,expectedInputBytes:new TextEncoder().encode(plan.input).length,originalInputMatched:true,normalJsonParseOnly:true,inputPersisted:false};
   }finally{this.discard(call.turnId,call.stepId);}
  },
  clear(){streams.clear();},
 };
}
