import {expect,it} from 'vitest';
import type {TerminalCommandObservation} from '@/types';
import {verifyMotionInputOrder,recordMotionIntegration,recordMotionNativeResult,motionObservationsFromSamples} from './native-motion-evidence';
import type {NativeMotionSample} from './native-motion-evidence';
const source="using namespace System.Text\n[Console]::WriteLine('unchanged source')";
function row(phase:TerminalCommandObservation['phase'],change:Partial<TerminalCommandObservation>={}):TerminalCommandObservation{
 return{phase,displaySource:source,submissionIntentDurable:false,draftCleared:false,mayHaveSubmitted:false,fullInputConfirmed:false,leaseGeneration:1,sourceRevision:1,safeActions:['query','requestStop'],agentSessionId:'agent',taskId:'task',operationId:'operation',commandId:'command',legacyState:'submitted',legacyRevision:1,sourceMayBeEnqueued:true,executionEvidence:'unknown',noAutoReplay:true,...change};
}
function sequence(){return[row('preparing'),row('typing'),row('inputConfirmed',{fullInputConfirmed:true}),row('submissionAttempted',{fullInputConfirmed:true,submissionIntentDurable:true,mayHaveSubmitted:true}),row('running',{fullInputConfirmed:true,submissionIntentDurable:true,mayHaveSubmitted:true,executionEvidence:'startObserved'}),row('completed',{fullInputConfirmed:true,submissionIntentDurable:true,mayHaveSubmitted:true,executionEvidence:'endObserved'})];}
it('requires actual prepare/full/submit/end observations while reduced motion may omit intermediate typing frames',()=>{
 expect(verifyMotionInputOrder(sequence(),'command',source)).toMatchObject({preparationIndex:0,fullInputIndex:2,submissionIndex:3,ended:true,preSubmitInputObserved:true});
 expect(verifyMotionInputOrder(sequence().filter(value=>value.phase!=='typing'),'command',source).ended).toBe(true);
});
it('refuses submission or durable intent during preparation and typing',()=>{
 for(const phase of ['preparing','typing'] as const)for(const change of [{mayHaveSubmitted:true},{submissionIntentDurable:true},{executionEvidence:'startObserved' as const}]){
  const values=sequence();values[phase==='preparing'?0:1]=row(phase,change);expect(()=>verifyMotionInputOrder(values,'command',source)).toThrow('Preparation or typing submitted');
 }
});
it('refuses missing proof, reordered commit, altered source or incomplete settlement',()=>{
 for(const values of [[],sequence().filter(value=>value.phase!=='inputConfirmed'),sequence().slice(0,-1),sequence().map(value=>value.phase==='typing'?{...value,displaySource:source+'\n'}:value),[sequence()[3],...sequence().slice(0,3),sequence()[5]]])expect(()=>verifyMotionInputOrder(values,'command',source)).toThrow();
 const values=sequence();values[3]={...values[3],fullInputConfirmed:false};expect(()=>verifyMotionInputOrder(values,'command',source)).toThrow('Submission preceded');
});

const expected={agentSessionId:'agent',taskId:'task',terminalSessionId:'terminal',terminalGeneration:7,source,exitCode:0};
function result(){return{channel:'terminal',execution:'completed',exitCode:0,commandLine:source,terminalSessionId:'terminal',terminalGeneration:7,commandId:'command',operationId:'operation',commandObservation:row('completed',{fullInputConfirmed:true,submissionIntentDurable:true,mayHaveSubmitted:true,executionEvidence:'endObserved'})};}
function samplesFor(values:TerminalCommandObservation[]){const samples:NativeMotionSample[]=[],integrations=values.map(activeCommand=>({inputObservation:{activeCommand}}));for(const [index,value]of values.entries())recordMotionIntegration(samples,value,index);return{samples,integrations};}

it('uses the actual native tool-result end when the integration stream moves to the next command without an end snapshot',()=>{
 const values=samplesFor(sequence().slice(0,-1)),data=result();
 expect(()=>verifyMotionInputOrder(values.samples.map(sample=>sample.observation),'command',source)).toThrow('ordering incomplete');
 recordMotionNativeResult(values.samples,data,expected,20);
 const observations=motionObservationsFromSamples(values.samples,values.integrations,[{seq:20,data}]);
 expect(verifyMotionInputOrder(observations,'command',source)).toMatchObject({preparationIndex:0,fullInputIndex:2,submissionIndex:3,ended:true});
 expect(values.samples[values.samples.length-1]?.origin).toBe('native-result');expect(values.samples[values.samples.length-1]?.observation).toEqual(data.commandObservation);
});

it('does not substitute a successful exit code, untrusted output or unbound native result for a native end',()=>{
 for(const data of [{exitCode:0,stdout:'endObserved'}, {...result(),commandObservation:undefined}, {...result(),channel:'direct'}, {...result(),terminalGeneration:8}, {...result(),terminalSessionId:'other'}, {...result(),commandLine:'changed'}, {...result(),commandObservation:{...result().commandObservation,agentSessionId:'other'}}, {...result(),commandObservation:{...result().commandObservation,operationId:'other'}}, {...result(),commandObservation:{...result().commandObservation,executionEvidence:'unknown'}}, {...result(),commandObservation:{...result().commandObservation,submissionIntentDurable:false}}]){
  expect(()=>recordMotionNativeResult([],data,expected,20)).toThrow();
 }
});

it('retains the original source evidence and refuses changed or omitted source references',()=>{
 const values=samplesFor(sequence().slice(0,-1)),data=result();recordMotionNativeResult(values.samples,data,expected,20);
 const altered=structuredClone(values.samples);altered[0]={...altered[0],observation:{...altered[0].observation,displaySource:'changed'}};
 expect(()=>motionObservationsFromSamples(altered,values.integrations,[{seq:20,data}])).toThrow('changed');
 const wrongResult=structuredClone(values.samples);wrongResult[wrongResult.length-1]={...wrongResult[wrongResult.length-1],agentEventSeq:21};
 expect(()=>motionObservationsFromSamples(wrongResult,values.integrations,[{seq:20,data}])).toThrow('reference mismatch');
 expect(()=>motionObservationsFromSamples(values.samples.slice(0,-1),values.integrations,[{seq:20,data}])).toThrow('omitted');
 const noIntegration=values.samples.filter(sample=>sample.integrationIndex!==1).map((sample,receivedIndex)=>({...sample,receivedIndex}));
 expect(()=>motionObservationsFromSamples(noIntegration,values.integrations,[{seq:20,data}])).toThrow('omitted');
});

it('still refuses missing full-input proof and submission during preparation even with a genuine native end result',()=>{
 for(const rows of [sequence().slice(0,-1).filter(value=>value.phase!=='inputConfirmed'),[row('preparing',{mayHaveSubmitted:true}),...sequence().slice(1,-1)]]){
  const values=samplesFor(rows),data=result();recordMotionNativeResult(values.samples,data,expected,20);
  expect(()=>verifyMotionInputOrder(motionObservationsFromSamples(values.samples,values.integrations,[{seq:20,data}]),'command',source)).toThrow();
 }
});

it('copies observed payloads at reception and refuses duplicate native-result samples',()=>{
 const samples:NativeMotionSample[]=[],observed=row('typing');recordMotionIntegration(samples,observed,0);observed.displaySource='changed later';expect(samples[0].observation.displaySource).toBe(source);
 const data=result();recordMotionNativeResult(samples,data,expected,20);expect(()=>recordMotionNativeResult(samples,data,expected,21)).toThrow('Duplicate');
});
