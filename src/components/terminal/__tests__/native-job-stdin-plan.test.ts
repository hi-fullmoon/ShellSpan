import {expect,it} from 'vitest';import {matchesNativeJobStdinStep,matchesNativeJobStdinReceipt,createNativeJobStdinStreamTracker,nativeJobStdinArguments,nativeJobStdinGoal,nativeJobStdinPlan} from './native-job-stdin-plan';import {nativePowerShellJobSources} from './native-job-lifecycle-plan';import {AGENT_SESSION_EVENT_VERSION} from '@/types/agent-session';import type {AgentSessionEvent} from '@/types/agent-session';
const marker='native-jobs-4c8d96aa-5a69-49f0-a768-52bb3a8b018b',handle='job-'+'a'.repeat(32),plan=nativeJobStdinPlan(marker);
it('keeps complete original setup/background/final sources and explicit unsupported stdin options',()=>{
 expect(plan.sources.slice(0,3)).toEqual(nativePowerShellJobSources(marker));expect(plan.sources[1]).toContain("real\tTab 'single' \"double\"");expect(plan.sources[3]).toContain('GetHistoryItems()');
 expect(nativeJobStdinArguments(plan,2,handle)).toEqual({processHandle:handle,input:plan.input,close:false});expect(plan.input.endsWith('\n')).toBe(true);
 expect(nativeJobStdinGoal(plan)).toContain(plan.expectedError);expect(nativeJobStdinGoal(plan)).toContain('close=false');expect(nativeJobStdinGoal(plan)).toContain(plan.sources[1]);
 for(let step=0;step<7;step++)expect(matchesNativeJobStdinStep(plan,step,plan.tools[step],nativeJobStdinArguments(plan,step,handle),handle)).toBe(true);
});
it('rejects altered stdin, foreign handles, direct handles or unsupported caller option repairs',()=>{
 const args=nativeJobStdinArguments(plan,2,handle);for(const changed of [{...args,close:true},{...args,input:plan.input.trimEnd()},{...args,processHandle:'proc-'+'a'.repeat(32)},{...args,processHandle:'job-'+'b'.repeat(32)}])expect(matchesNativeJobStdinStep(plan,2,'write_process_input',changed,handle)).toBe(false);
 expect(matchesNativeJobStdinStep(plan,2,'write_process_input',{...args,explanation:'not in the original stdin schema'},handle)).toBe(false);
 expect(matchesNativeJobStdinStep(plan,1,'run_terminal_command',{command:plan.sources[1],background:false},handle)).toBe(false);expect(()=>nativeJobStdinArguments(plan,2)).toThrow('Original actual');
});

function chunk(argumentsDelta:string,nameDelta:string|undefined='write_process_input',stepId='step'):AgentSessionEvent{return{version:AGENT_SESSION_EVENT_VERSION,sessionId:'agent',turnId:'turn',stepId,seq:1,timeUnixMs:1,type:'assistant/chunk',data:{requestId:'request',toolCallDelta:{index:0,callId:'provider',nameDelta,argumentsDelta}}};}
function privacyReceipt(){return{processHandle:handle,close:false,byteLength:new TextEncoder().encode(plan.input).length,contentPersisted:false};}
function call(stepId='step'):Extract<AgentSessionEvent,{type:'tool/call'}>{return{version:AGENT_SESSION_EVENT_VERSION,sessionId:'agent',turnId:'turn',stepId,seq:2,timeUnixMs:2,type:'tool/call',data:{call:{callId:'call',providerCallId:'provider',name:'write_process_input',arguments:{processHandle:handle,close:false,byteLength:new TextEncoder().encode(plan.input).length,contentPersisted:false}}}};}
it('compares the actual argument JSON stream once in memory and keeps the recorded privacy receipt separate',()=>{
 const tracker=createNativeJobStdinStreamTracker(),json=JSON.stringify(nativeJobStdinArguments(plan,2,handle));tracker.observe(chunk(json.slice(0,17)));tracker.observe(chunk(json.slice(17),''));
 const proof=tracker.verify(call(),plan,handle);expect(proof).toMatchObject({callId:'call',originalInputMatched:true,normalJsonParseOnly:true,inputPersisted:false,expectedInputBytes:new TextEncoder().encode(plan.input).length});expect(JSON.stringify(proof)).not.toContain(plan.input.trimEnd());
 expect(matchesNativeJobStdinReceipt(plan,call().data.call.arguments,handle)).toBe(true);expect(()=>tracker.verify(call(),plan,handle)).toThrow('Exactly one');
});
it('refuses changed input, omitted LF, close=true and foreign handles despite a matching-looking privacy receipt',()=>{
 for(const args of [{...nativeJobStdinArguments(plan,2,handle),input:plan.input.slice(0,-2)+'X\n'},{...nativeJobStdinArguments(plan,2,handle),input:plan.input.trimEnd()},{...nativeJobStdinArguments(plan,2,handle),close:true},{...nativeJobStdinArguments(plan,2,handle),processHandle:'job-'+'b'.repeat(32)}]){const tracker=createNativeJobStdinStreamTracker();tracker.observe(chunk(JSON.stringify(args)));expect(()=>tracker.verify(call(),plan,handle)).toThrow('differ');}
 for(const receipt of [{...privacyReceipt(),close:true},{...privacyReceipt(),byteLength:0},{...privacyReceipt(),contentPersisted:true},{...privacyReceipt(),input:plan.input}])expect(matchesNativeJobStdinReceipt(plan,receipt,handle)).toBe(false);
});
it('refuses cross-step/provider stream reuse and malformed JSON without disclosing captured input',()=>{
 const other=createNativeJobStdinStreamTracker();other.observe(chunk(JSON.stringify(nativeJobStdinArguments(plan,2,handle)),undefined,'other'));expect(()=>other.verify(call(),plan,handle)).toThrow('Exactly one');
 const provider=createNativeJobStdinStreamTracker();provider.observe(chunk(JSON.stringify(nativeJobStdinArguments(plan,2,handle))));const changed={...call(),data:{call:{...call().data.call,providerCallId:'foreign'}}};expect(()=>provider.verify(changed,plan,handle)).toThrow('provider');
 const invalid=createNativeJobStdinStreamTracker();invalid.observe(chunk('{"input":"COMPONENT_PRIVATE_INPUT'));expect(()=>invalid.verify(call(),plan,handle)).toThrow('unavailable or invalid');
});
