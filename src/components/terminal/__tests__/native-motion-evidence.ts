import type {TerminalCommandObservation} from '@/types';

export type NativeMotionObservation=Pick<TerminalCommandObservation,'agentSessionId'|'taskId'|'commandId'|'operationId'|'displaySource'|'noAutoReplay'|'phase'|'executionEvidence'|'fullInputConfirmed'|'mayHaveSubmitted'|'submissionIntentDurable'>;
export interface NativeMotionSample{
 readonly origin:'integration'|'native-result';
 readonly receivedIndex:number;
 readonly receivedAtUnixMs:number;
 readonly integrationIndex?:number;
 readonly agentEventSeq?:number;
 readonly observation:NativeMotionObservation;
}
interface NativeMotionExpected{readonly agentSessionId:string;readonly taskId:string;readonly terminalSessionId:string;readonly terminalGeneration:number;readonly source:string;readonly exitCode:number;}
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Structured native motion evidence required');return value as Record<string,unknown>;}
function assertNativeResult(value:unknown,expected:NativeMotionExpected):asserts value is {commandObservation:NativeMotionObservation}{
 const data=object(value),observation=object(data.commandObservation);
 if(data.channel!=='terminal'||data.execution!=='completed'||data.exitCode!==expected.exitCode||data.commandLine!==expected.source||data.terminalSessionId!==expected.terminalSessionId||data.terminalGeneration!==expected.terminalGeneration
  ||typeof data.commandId!=='string'||typeof data.operationId!=='string'||observation.commandId!==data.commandId||observation.operationId!==data.operationId||observation.agentSessionId!==expected.agentSessionId||observation.taskId!==expected.taskId
  ||observation.displaySource!==expected.source||observation.phase!=='completed'||observation.executionEvidence!=='endObserved'||observation.fullInputConfirmed!==true||observation.submissionIntentDurable!==true||observation.mayHaveSubmitted!==true||observation.noAutoReplay!==true)throw Error('Unbound or unconfirmed native result cannot prove motion completion');
}
export function recordMotionIntegration(samples:NativeMotionSample[],observation:TerminalCommandObservation|undefined,integrationIndex:number){
 if(!observation)return;
 if(!Number.isSafeInteger(integrationIndex)||integrationIndex<0)throw Error('Actual integration index required');
 samples.push({origin:'integration',receivedIndex:samples.length,receivedAtUnixMs:Date.now(),integrationIndex,observation:structuredClone(observation)});
}
export function recordMotionNativeResult(samples:NativeMotionSample[],value:unknown,expected:NativeMotionExpected,agentEventSeq:number){
 assertNativeResult(value,expected);
 if(!Number.isSafeInteger(agentEventSeq)||agentEventSeq<0||samples.some(sample=>sample.origin==='native-result'&&sample.observation.commandId===value.commandObservation.commandId))throw Error('Duplicate or unidentified native motion result');
 samples.push({origin:'native-result',receivedIndex:samples.length,receivedAtUnixMs:Date.now(),agentEventSeq,observation:structuredClone(value.commandObservation)});
}
function sameValue(a:unknown,b:unknown):boolean{
 if(Object.is(a,b))return true;
 if(Array.isArray(a)||Array.isArray(b))return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((value,index)=>sameValue(value,b[index]));
 if(!a||!b||typeof a!=='object'||typeof b!=='object')return false;
 const left=object(a),right=object(b),keys=Object.keys(left).sort();return keys.length===Object.keys(right).length&&keys.every(key=>Object.prototype.hasOwnProperty.call(right,key)&&sameValue(left[key],right[key]));
}
export function motionObservationsFromSamples(samples:readonly NativeMotionSample[],integrations:readonly unknown[],results:readonly {seq:number;data:unknown}[]):readonly NativeMotionObservation[]{
 if(!samples.length)throw Error('Actual motion samples missing');
 let integrationIndex=-1,resultSeq=-1;const seenIntegration=new Set<number>(),seenResults=new Set<number>();
 for(const [index,sample]of samples.entries()){
  if(sample.receivedIndex!==index||!Number.isSafeInteger(sample.receivedAtUnixMs))throw Error('Motion sample receive order missing');
  if(sample.origin==='integration'){
   const reference=sample.integrationIndex;
   if(reference===undefined||!Number.isSafeInteger(reference)||reference<=integrationIndex||reference>=integrations.length)throw Error('Motion integration reference mismatch');
   const original=object(object(integrations[reference]).inputObservation).activeCommand;
   if(!original||!sameValue(original,sample.observation))throw Error('Motion integration observation was changed');
   integrationIndex=reference;seenIntegration.add(reference);
  }else if(sample.origin==='native-result'){
   const seq=sample.agentEventSeq,matches=results.filter(result=>result.seq===seq);
   if(seq===undefined||!Number.isSafeInteger(seq)||seq<=resultSeq||seenResults.has(seq)||matches.length!==1)throw Error('Motion native-result reference mismatch');
   const data=object(matches[0].data),original=object(data.commandObservation);
   if(data.channel!=='terminal'||data.execution!=='completed'||original.phase!=='completed'||original.executionEvidence!=='endObserved'||original.fullInputConfirmed!==true||original.submissionIntentDurable!==true||original.noAutoReplay!==true||!sameValue(original,sample.observation))throw Error('Motion completion lacks its original native result');
   resultSeq=seq;seenResults.add(seq);
  }else throw Error('Unknown motion evidence origin');
 }
 const expectedIntegration=integrations.flatMap((value,index)=>{const input=object(value).inputObservation;return input&&object(input).activeCommand?[index]:[];});
 if(expectedIntegration.length!==seenIntegration.size||expectedIntegration.some(index=>!seenIntegration.has(index))||seenResults.size!==results.length)throw Error('Actual motion evidence omitted a source event');
 return samples.map(sample=>sample.observation);
}

export function verifyMotionInputOrder(observations:readonly NativeMotionObservation[],commandId:string,source:string){
 const rows=observations.filter(value=>value.commandId===commandId);
 const fail=(message:string):never=>{throw Error(message);};
 if(!rows.length)fail('Actual automatic input observations missing');
 let preparing=-1,full=-1,submitted=-1,ended=false;
 for(const [index,row]of rows.entries()){
  if(row.displaySource!==undefined&&row.displaySource!==source)fail('Automatic input observation changed the original source');
  if(row.noAutoReplay!==true)fail('Automatic input lost its no-replay fence');
  if(row.phase==='preparing'||row.phase==='typing'){
   if(preparing<0)preparing=index;
   if(row.mayHaveSubmitted||row.submissionIntentDurable||row.executionEvidence!=='unknown')fail('Preparation or typing submitted before complete input');
  }
  if(row.phase==='inputConfirmed'&&row.fullInputConfirmed&&!row.mayHaveSubmitted&&full<0)full=index;
  if(row.mayHaveSubmitted){
   if(!row.fullInputConfirmed||!row.submissionIntentDurable)fail('Submission preceded full input or durable intent');
   if(submitted<0)submitted=index;
  }
  if(row.executionEvidence==='endObserved')ended=true;
 }
 if(preparing<0||full<=preparing||submitted<=full||!ended)fail('Actual prepare/full-input/submission/end ordering incomplete');
 return{observations:rows.length,preparationIndex:preparing,fullInputIndex:full,submissionIndex:submitted,sourceUtf8Bytes:new TextEncoder().encode(source).length,ended:true,preSubmitInputObserved:true};
}
