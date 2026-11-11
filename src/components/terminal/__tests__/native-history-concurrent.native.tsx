import {createRoot} from 'react-dom/client';
import {getCurrentWindow} from '@tauri-apps/api/window';
import {TerminalControllerLayer} from '../terminal-controller-layer';
import {terminalRegistry} from '../registry/terminal-registry';
import {useTerminalStore} from '@/stores/terminalStore';
import {initI18n} from '@/locales';
import {selectNativeBoundaryModel} from './native-byte-boundary-plan';
import {isCurrentNativeEditorProfile} from './native-editor-profile';
import {createNativeAcceptanceSurface} from './native-acceptance-surface';
import {delegationOriginalCall} from './native-approval-delegation-plan';
import {nativeCaptureError} from './native-capture-error';
import {nativeHistoryModes,sameWindowsHistoryPath} from './native-history-plan';
import {matchesHistoryFingerprints,matchesHistoryLifecycleArguments,nativeHistoryLifecycleGoal} from './native-history-lifecycle-plan';
import {concurrentHistoryDisk,concurrentHistoryMemory,nativeHistoryConcurrentPlan,type ConcurrentHistoryStage} from './native-history-concurrent-plan';
import {invokeCreateLocalSession,invokeCloseSession,invokeGetTerminalBrokerSnapshot,invokeGetAgentTerminalOwner,invokeListAiRoutes,invokeCreateAgentRuntimeSession,invokeAgentRuntimeFollowup,invokeStartAgentRuntime,invokeApproveAgentRuntimeTool,invokeGetPendingAgentRuntimeApprovalArguments,invokeCancelAgentRuntime,invokeArchiveAgentRuntimeSession,invokeGetTerminalSubmissionRecovery,listenToAgentRuntimeSession,listenToTerminalIntegrationState,listenToSshClosed} from '@/lib/ipc/tauri';
import type {AgentSessionEvent} from '@/types/agent-session';
import type {ClosedEvent,TerminalIntegrationStateEvent} from '@/types';

function assert(value:unknown,message:string):asserts value{if(!value)throw Error(message);}
function object(value:unknown):Record<string,unknown>{assert(value&&typeof value==='object'&&!Array.isArray(value),'Structured concurrent history evidence required');return value as Record<string,unknown>;}
async function until(test:()=>boolean|Promise<boolean>,message:string,timeout=180000){const end=Date.now()+timeout;while(!await test()){assert(Date.now()<end,message);await new Promise(resolve=>setTimeout(resolve,5));}}
async function fingerprints(sources:readonly string[]){return Promise.all(sources.map(async source=>{const bytes=new TextEncoder().encode(source);return{sha256:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),value=>value.toString(16).padStart(2,'0')).join(''),bytes:bytes.length};}));}
type Broker=Awaited<ReturnType<typeof invokeGetTerminalBrokerSnapshot>>;
interface Reader {index:0|1;terminalId:string;before:Broker;raw:string;observations:TerminalIntegrationStateEvent[];events:AgentSessionEvent[];approved:string[];observer?:Record<string,unknown>;profile?:Record<string,unknown>;agentId?:string;data?:Record<string,unknown>;probe?:Record<string,unknown>;closed?:ClosedEvent;exitObservation?:Record<string,unknown>}

export async function verifyNativeHistoryConcurrent(){
 const params=new URL(location.href).searchParams,token=params.get('token'),mode=params.get('historyMode');assert(token&&nativeHistoryModes.some(value=>value===mode),'Exact owned concurrent history configuration required');
 const plan=nativeHistoryConcurrentPlan(token),readers:Reader[]=[],disposers:(()=>void)[]=[],agents=new Set<string>(),disk:Record<string,unknown>[]=[],report=(evidence:unknown,progress:string)=>fetch(`/__agent-stream-result/${token}`,{method:'POST',body:JSON.stringify({evidence,progress})});
 const get=async(name:string)=>{const response=await fetch(`/__native-history-${name}/${token}`);assert(response.ok,`Concurrent history ${name} unavailable`);return object(await response.json());};
 await initI18n('en-US');await getCurrentWindow().show();await getCurrentWindow().setFocus();const element=document.getElementById('root')!,root=createRoot(element);root.render(<TerminalControllerLayer/>);const {host,bounds}=await createNativeAcceptanceSurface(element);host.style.display='grid';host.style.gridTemplateRows='repeat(2,minmax(0,1fr))';
 let capture:unknown;
 try{
  for(const index of [0,1] as const){
   const panel=document.createElement('div');panel.style.cssText='min-height:0;min-width:0;height:100%;width:100%';host.append(panel);
   const session=await invokeCreateLocalSession(100,15);const reader:Reader={index,terminalId:session.sessionId,before:await invokeGetTerminalBrokerSnapshot(session.sessionId),raw:'',observations:[],events:[],approved:[]};readers.push(reader);useTerminalStore.getState().addSession(session);
   await until(()=>!!terminalRegistry.get(session.sessionId),'Concurrent history controller missing');const controller=terminalRegistry.get(session.sessionId)!;controller.attach(panel);await controller.whenOutputReady();
   disposers.push(controller.subscribeOutput(value=>{assert(reader.raw.length+value.length<=1048576,'Concurrent history PTY bound exceeded');reader.raw+=value;}));
   disposers.push(await listenToTerminalIntegrationState(({payload})=>{if(payload.sessionId===session.sessionId)reader.observations.push(payload);}));disposers.push(await listenToSshClosed(session.sessionId,({payload})=>{reader.closed=payload;}));
   await until(async()=>!!(await invokeGetTerminalBrokerSnapshot(session.sessionId)).session?.promptReady,'Concurrent history prompt missing');reader.before=await invokeGetTerminalBrokerSnapshot(session.sessionId);
   assert(reader.before.session?.inputMode==='native-inline'&&isCurrentNativeEditorProfile(reader.before.session.nativePeerProfile,params.get('nativeP3')),'Concurrent reader native profile unavailable');
   if(index===1)assert(reader.before.session.terminalSessionId!==readers[0].before.session?.terminalSessionId&&reader.terminalId!==readers[0].terminalId&&!readers[0].closed,'Two distinct simultaneously live readers required');
   await report({kind:'actual-native-history-concurrent-reader-ready',token,reader:String(index),mode,before:reader.before,firstObserver:readers[0].observer,plan},'Actual concurrent reader ready for independent held Shell/module and exit observation.');
   await until(async()=>{const value=await get('concurrent-observer-'+index);if(!value.ready)return false;reader.observer=value;return true;},'Concurrent reader OS inspection missing',60000);
   reader.profile=await get('concurrent-profile-'+index);assert(reader.profile.reader===String(index)&&reader.profile.readerPid===reader.observer?.shellPid&&reader.profile.readerCreated===reader.observer?.handleCreated&&reader.profile.seedApplied===(index===0),'Concurrent startup receipt differs from exact held reader');
   await until(async()=>{const value=await get('concurrent-exit-'+index);if(!value.ready)return false;const ready=object(value.ready);assert(ready.shellPid===reader.observer?.shellPid&&ready.created===reader.observer?.handleCreated&&ready.handleHeld===true,'Concurrent exit observer holds a different process');return true;},'Concurrent reader exit handle not held',60000);
  }
  const [first,second]=readers;assert(first.profile&&second.profile&&first.observer&&second.observer,'Both readers must be independently held before model calls');
  assert(first.observer.appPid===second.observer.appPid&&(first.observer.shellPid!==second.observer.shellPid||first.observer.handleCreated!==second.observer.handleCreated)&&Date.parse(String(second.observer.handleCreated))>Date.parse(String(first.observer.handleCreated)),'Concurrent OS identities are not distinct later readers of the same App');
  for(const key of ['mode','expectedMaximum','expectedStyle','expectedNativePath','reuseId'])assert(first.profile[key]===second.profile[key],'Concurrent startup options differ: '+key);
  for(const key of ['exists','bytes','sha256'])assert(object(first.profile.historyBeforeReader)[key]===object(second.profile.historyBeforeReader)[key],'Readers did not consume the same initial history bytes');
  assert(JSON.stringify(first.profile.expectedInitialSources)===JSON.stringify(second.profile.expectedInitialSources),'Concurrent initial source expectations differ');
  const maximum=first.profile.expectedMaximum,style=first.profile.expectedStyle,path=first.profile.expectedNativePath,seeds=first.profile.expectedInitialSources;assert(typeof maximum==='number'&&typeof style==='string'&&typeof path==='string'&&Array.isArray(seeds)&&seeds.every(value=>typeof value==='string'),'Actual concurrent options or initial sources incomplete');
  const actualOptions={maximum,style};
  const selection=selectNativeBoundaryModel(await invokeListAiRoutes(),params.get('route'),params.get('model'));
  async function promptReady(reader:Reader){await until(async()=>{const state=(await invokeGetTerminalBrokerSnapshot(reader.terminalId)).session;return !!state?.promptReady&&!state.inputObservation?.commandInputPending&&!state.inputObservation?.nativeRecoveryRequired&&await invokeGetAgentTerminalOwner(reader.terminalId)===null;},'Concurrent reader input ownership not released',15000);}
  for(const reader of readers){
   const source=plan.sources[reader.index],goal=nativeHistoryLifecycleGoal(source),id='agent-history-concurrent-'+crypto.randomUUID();reader.agentId=id;let failure:string|undefined;const reserved=new Set<string>();
   const unlisten=await listenToAgentRuntimeSession(({payload})=>{if(payload.sessionId!==id)return;if(payload.type!=='assistant/chunk')reader.events.push(payload);if(payload.type==='request/failure')failure??='Actual concurrent history model request failed';
    if(payload.type==='tool/call')try{assert(reader.events.filter(value=>value.type==='tool/call').length===1&&payload.data.call.name==='run_terminal_command'&&matchesHistoryLifecycleArguments(delegationOriginalCall(reader.events,payload).arguments,source)&&matchesHistoryLifecycleArguments(payload.data.call.arguments,source),'Concurrent original/prepared source changed or extra call proposed');}catch(error){failure??=String(error);}
    if(payload.type==='tool/approval'&&payload.data.status==='requested')void(async()=>{assert(!failure,failure??'Concurrent proposal invalid');const {approvalId,callId,requestId}=payload.data,{turnId,stepId}=payload;assert(approvalId&&turnId&&stepId&&!reserved.has(approvalId),'Duplicate concurrent approval');reserved.add(approvalId);const decision={sessionId:id,approvalId,callId,requestId,turnId,stepId},pending=await invokeGetPendingAgentRuntimeApprovalArguments(decision);assert(pending===null||pending===undefined||matchesHistoryLifecycleArguments(pending,source),'Concurrent pending approval source differs');await invokeApproveAgentRuntimeTool(decision);reader.approved.push(callId);})().catch(error=>{failure??=String(error);});
   });
   try{
    await invokeCreateAgentRuntimeSession({sessionId:id,taskId:id,goal,executionSurface:'boundTerminal',permissionMode:'requestApproval',target:{kind:'local',targetId:'terminal-'+reader.terminalId,sessionId:reader.terminalId,cwd:reader.before.session?.currentDirectory},capabilityScope:{toolNames:['run_terminal_command'],effects:['none','readOnly','stateChange','externalSideEffect'],targetIds:['terminal-'+reader.terminalId]}});agents.add(id);
    const messageId=crypto.randomUUID();await invokeAgentRuntimeFollowup({sessionId:id,messageId,clientSubmissionId:messageId,content:goal});await invokeStartAgentRuntime({sessionId:id,selection});
    await until(()=>{assert(!failure,failure??'Concurrent model failed');return reader.events.some(value=>value.type==='tool/result');},'Concurrent actual tool result missing');await invokeCancelAgentRuntime({sessionId:id});
    const results=reader.events.filter((value):value is Extract<AgentSessionEvent,{type:'tool/result'}>=>value.type==='tool/result');assert(results.length===1&&results[0].data.status==='completed'&&reader.approved.length===1,'Concurrent source did not complete once with normal approval');const data=object(results[0].data.data),proof=object(data.commandObservation);reader.data=data;
    assert(data.commandLine===source&&data.exitCode===0&&proof.displaySource===source&&proof.fullInputConfirmed===true&&proof.submissionIntentDurable===true&&proof.executionEvidence==='endObserved','Concurrent native full-input/settlement proof differs');assert(reader.observations.some(value=>value.inputObservation?.activeCommand?.commandId===proof.commandId&&value.inputObservation?.activeCommand?.executionEvidence==='startObserved'),'Concurrent source Started observation missing');
    assert(typeof data.combinedOutput==='string','Concurrent actual output unavailable');const match=data.combinedOutput.match(new RegExp(plan.markers[reader.index]+'(\\{[^\\r\\n]*\\})'));assert(match,'Concurrent public history JSON missing');const probe=object(JSON.parse(match[1]));reader.probe=probe;
    assert(probe.host==='ConsoleHost'&&typeof probe.path==='string'&&sameWindowsHistoryPath(probe.path,path)&&probe.maximum===maximum&&probe.style===style,'Concurrent command changed actual host/history options');assert(matchesHistoryFingerprints(probe.items,await fingerprints(concurrentHistoryMemory(seeds as string[],plan.sources,reader.index,style,maximum))),'Concurrent public history differs from exact provider import order');
    assert((await invokeGetTerminalSubmissionRecovery(id)).length===0,'Concurrent source intent unresolved');await invokeArchiveAgentRuntimeSession({sessionId:id});agents.delete(id);await promptReady(reader);
   }finally{unlisten();}
  }
  async function checkDisk(stage:ConcurrentHistoryStage){const value=await get('disk');assert(value.exists===(actualOptions.style!=='SaveNothing')&&matchesHistoryFingerprints(value.items,await fingerprints(concurrentHistoryDisk(seeds as string[],plan.sources,plan.exits,actualOptions.style,actualOptions.maximum,stage))),'Concurrent actual disk differs at '+stage);disk.push({stage,...value});}
  await checkDisk('probes');await getCurrentWindow().show();await getCurrentWindow().setFocus();const response=await fetch(`/__native-window-evidence/${token}`,{method:'POST'});if(!response.ok)throw Error(nativeCaptureError(response.status,await response.text()));capture=await response.json();
  for(const reader of readers){
   await promptReady(reader);const controller=terminalRegistry.get(reader.terminalId);assert(controller&&await controller.writeUserInput(plan.exits[reader.index]+'\r'),'Ordinary attributable concurrent exit blocked');
   await until(()=>!!reader.closed,'Concurrent Shell did not exit normally',15000);assert(reader.closed?.reasonKind==='remote_exit'&&reader.closed.reason==='local shell exited'&&!reader.closed.retryable,'Concurrent reader was force-closed');
   await until(async()=>{const value=await get('concurrent-exit-'+reader.index);if(!value.result)return false;const result=object(value.result);assert(result.shellPid===reader.observer?.shellPid&&result.created===reader.observer?.handleCreated&&result.ended===true&&result.exitCode===0,'Original concurrent Shell did not exit0');reader.exitObservation=result;return true;},'Held concurrent normal exit missing',15000);
   await checkDisk(reader.index===0?'firstExit':'bothExited');await invokeCloseSession(reader.terminalId);
  }
  await report({kind:'actual-native-history-concurrent',token,mode,selection,plan,readers,disk,capture,bounds,scope:'Two simultaneous actual ConsoleHost readers with once-only seed, exact model probes and actual save-policy/normal-exit evidence. Fresh accepted/cancel lifecycle and restart pairs remain separate.'},'Actual concurrent history readers completed without reseeding or source replay.');
 }catch(error){await report({kind:'actual-native-history-concurrent-failure',failed:true,token,mode,error:String(error),plan,readers,disk,capture,bounds},'Concurrent history failure retained; no source repair, reseed, capture waiver or replay.');throw error;}
 finally{disposers.forEach(dispose=>dispose());for(const id of agents){await invokeCancelAgentRuntime({sessionId:id}).catch(()=>{});await invokeArchiveAgentRuntimeSession({sessionId:id}).catch(()=>{});}for(const reader of readers){await invokeCloseSession(reader.terminalId).catch(()=>{});terminalRegistry.dispose(reader.terminalId);}root.unmount();host.remove();}
}
