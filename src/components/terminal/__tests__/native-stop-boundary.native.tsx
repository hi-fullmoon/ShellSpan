import {createRoot} from 'react-dom/client';
import {getCurrentWindow} from '@tauri-apps/api/window';
import {TerminalControllerLayer} from '../terminal-controller-layer';
import {terminalRegistry} from '../registry/terminal-registry';
import {agentTerminalLeaseState} from '../agent-terminal-lease-state';
import {useTerminalStore} from '@/stores/terminalStore';
import {initI18n} from '@/locales';
import {isCurrentNativeEditorProfile} from './native-editor-profile';
import {nativeFileCoreSetup,readNativeFileLoadedCore} from './native-file-chain-approval';
import {delegationOriginalCall} from './native-approval-delegation-plan';
import {matchesWindowsStopResult} from './native-windows-stop-plan';
import {stopBoundaryPlan,matchesStopBoundaryArgs,isPreAcceptBoundary,isConfirmedPreAcceptCancel} from './native-stop-boundary-plan';
import {invokeCreateLocalSession,invokeCloseSession,invokeGetTerminalBrokerSnapshot,invokeListAiRoutes,invokeCreateAgentRuntimeSession,invokeAgentRuntimeFollowup,invokeStartAgentRuntime,invokeCancelAgentRuntime,invokeArchiveAgentRuntimeSession,invokeGetAgentRuntimeSession,invokeGetPendingAgentRuntimeApprovalArguments,invokeApproveAgentRuntimeTool,invokeGetTerminalSubmissionRecovery,invokeWriteSession,listenToAgentRuntimeSession,listenToTerminalIntegrationState} from '@/lib/ipc/tauri';
import type {AgentSessionEvent} from '@/types/agent-session';
import type {TerminalIntegrationStateEvent} from '@/types';
import '@/styles/base.css';
function assert(value:unknown,message:string):asserts value{if(!value)throw Error(message);}
function object(value:unknown):Record<string,unknown>{assert(value&&typeof value==='object'&&!Array.isArray(value),'Structured capture observation required');return value as Record<string,unknown>;}
async function until(check:()=>boolean|Promise<boolean>,message:string,timeout=180000){const end=Date.now()+timeout;while(!await check()){assert(Date.now()<end,message);await new Promise(resolve=>setTimeout(resolve,20));}}
async function verify(){
 const params=new URL(location.href).searchParams,token=params.get('token');assert(token&&/^[a-f0-9-]{36}$/.test(token),'Owned capture token missing');
 const fixture=await (async()=>{const r=await fetch(`/__native-stop-boundary/${token}`);assert(r.ok,'Owned tail configuration unavailable');return object(await r.json());})();
 assert((fixture.stage==='durableIntent'||fixture.stage==='armed'||fixture.stage==='beforeAccept'||fixture.stage==='afterAccept')&&(fixture.action==='cancel'||fixture.action==='takeover'),'Explicit stop boundary missing');
 const plan=stopBoundaryPlan(token,fixture.stage,fixture.action),submittedBoundary=plan.stage==='beforeAccept'||plan.stage==='afterAccept',id='agent-stop-boundary-'+crypto.randomUUID(),events:AgentSessionEvent[]=[],observations:TerminalIntegrationStateEvent[]=[],queries:unknown[]=[],dispose:(()=>void)[]=[];
 let raw='',failure:string|undefined,created=false,terminalId:string|undefined,closed=false;
 const report=(evidence:unknown)=>fetch(`/__agent-stream-result/${token}`,{method:'POST',body:JSON.stringify({evidence,progress:'Actual native cancellation boundary acceptance'})});
 const witness=async()=>{const r=await fetch(`/__native-stop-boundary/${token}`);assert(r.ok,'Owned tail witness unavailable');return object(await r.json());};
 await initI18n('en-US');await getCurrentWindow().show();await getCurrentWindow().setFocus();const root=createRoot(document.getElementById('root')!);root.render(<TerminalControllerLayer/>);
 const host=document.createElement('div');host.style.cssText='position:fixed;inset:0';document.body.appendChild(host);
 try{
  assert(fixture.entries instanceof Array&&fixture.entries.length===0,'Stop source effect before approval');
  const session=await invokeCreateLocalSession(100,30);terminalId=session.sessionId;useTerminalStore.getState().addSession(session);
  await until(()=>!!terminalRegistry.get(session.sessionId),'Actual capture controller missing');const controller=terminalRegistry.get(session.sessionId)!;controller.attach(host);await controller.whenOutputReady();
  await until(async()=>!!(await invokeGetTerminalBrokerSnapshot(session.sessionId)).session?.promptReady,'Native capture prompt missing');
  const before=await invokeGetTerminalBrokerSnapshot(session.sessionId);assert(before.session?.inputMode==='native-inline'&&isCurrentNativeEditorProfile(before.session.nativePeerProfile,params.get('nativeP3')),'Capture provider differs');
  dispose.push(controller.subscribeOutput(v=>{assert(raw.length<524288,'Actual capture display exceeded bound');raw+=v;}));
  dispose.push(await listenToTerminalIntegrationState(({payload})=>{if(payload.sessionId===session.sessionId)observations.push(payload);}));
  assert(await controller.writeUserInput(nativeFileCoreSetup+'\r'),'Loaded module diagnostic refused');await until(()=>!!readNativeFileLoadedCore(raw),'Actual loaded Core missing');const loadedCore=readNativeFileLoadedCore(raw);assert(loadedCore,'Loaded Core missing');
  await until(async()=>!!(await invokeGetTerminalBrokerSnapshot(session.sessionId)).session?.promptReady,'Diagnostic prompt missing');
  dispose.push(await listenToAgentRuntimeSession(({payload})=>{
   if(payload.sessionId!==id)return;events.push(payload);
   if(payload.type==='agent/status'&&payload.data.status==='failed')failure??=payload.data.reason??'Capture model failed';
   if(payload.type==='tool/call')try{assert(events.filter(x=>x.type==='tool/call').length===1&&payload.data.call.name==='run_terminal_command','Capture source repeated or wrong tool');assert(matchesStopBoundaryArgs(delegationOriginalCall(events,payload).arguments,plan.command),'Original capture source changed');assert(payload.data.call.nativeName==='terminal_execute'&&matchesStopBoundaryArgs(payload.data.call.arguments,plan.command,true),'Prepared capture projection changed');}catch(error){failure??=String(error);}
   if(payload.type==='tool/approval'&&payload.data.status==='requested')void(async()=>{
    assert(!failure,failure??'Proposal mismatch');const {approvalId,callId,requestId}=payload.data,{turnId,stepId}=payload;assert(approvalId&&turnId&&stepId,'Capture approval identity missing');const decision={sessionId:id,approvalId,callId,requestId,turnId,stepId};
    const pending=await invokeGetPendingAgentRuntimeApprovalArguments(decision);assert(pending==null||matchesStopBoundaryArgs(pending,plan.command),'Pending capture source changed');
    const state=await invokeGetAgentRuntimeSession({sessionId:id});assert(state.header.permissionMode==='requestApproval'&&state.header.executionSurface==='boundTerminal'&&state.header.target?.sessionId===session.sessionId,'Capture permission/target changed');
    await report({kind:'actual-native-stop-boundary-approval',token,id,plan,before,loadedCore,fixture,events,observations,raw});
    await until(async()=>{assert(!failure,failure??'Capture approval failed');return(await witness()).armed===true;},'Actual Core verification missing',90000);await invokeApproveAgentRuntimeTool(decision);
   })().catch(error=>{failure??=String(error);});
  }));
  const selection=(await invokeListAiRoutes()).defaultSelection;assert(selection,'Configured model missing');
  await invokeCreateAgentRuntimeSession({sessionId:id,taskId:id,goal:plan.goal,executionSurface:'boundTerminal',permissionMode:'requestApproval',target:{kind:'local',targetId:'terminal-'+session.sessionId,sessionId:session.sessionId,cwd:before.session.currentDirectory},capabilityScope:{toolNames:['run_terminal_command'],effects:['stateChange','externalSideEffect'],targetIds:['terminal-'+session.sessionId]}});created=true;
  const message=crypto.randomUUID();await invokeAgentRuntimeFollowup({sessionId:id,messageId:message,clientSubmissionId:message,content:plan.goal});await invokeStartAgentRuntime({sessionId:id,selection});
  await until(async()=>{assert(!failure,failure??'Boundary proposal failed');assert(!events.some(x=>x.type==='tool/result'),'Tool settled before selected boundary');return(await witness()).held===true;},'Actual selected native boundary missing',90000);
  const admission=await invokeGetTerminalBrokerSnapshot(session.sessionId),command=admission.session?.inputObservation?.activeCommand;
  assert(command&&command.agentSessionId===id&&command.fullInputConfirmed&&command.submissionIntentDurable&&!command.draftCleared&&command.executionEvidence==='unknown'&&(submittedBoundary?command.mayHaveSubmitted:isPreAcceptBoundary(command,id)),'Selected native boundary identity/phase differs');
  const recovery=await invokeGetTerminalSubmissionRecovery(id);assert(recovery.length===1&&recovery[0].identity.commandId===command.commandId&&recovery[0].identity.operationId===command.operationId,'Durable boundary identity missing');
  assert((await witness()).entries instanceof Array&&JSON.stringify((await witness()).entries)==='[]','Source ran before stop');
  let actionResponse:unknown,actionError:string|undefined,actionCompleted=false;const actionInvokedAt=Date.now();
  let takeoverViewBefore:unknown,takeoverViewAfter:unknown;
  const actionPromise=(async()=>{try{if(plan.action==='cancel')actionResponse=await invokeCancelAgentRuntime({sessionId:id});else{const view=agentTerminalLeaseState.get(session.sessionId);assert(view&&view.agentSessionId===id&&view.operationId===command.operationId&&view.taskId===command.taskId&&view.terminalOwned,'Production takeover callback identity missing');takeoverViewBefore={agentSessionId:view.agentSessionId,taskId:view.taskId,operationId:view.operationId,terminalOwned:view.terminalOwned,inputBlocked:view.inputBlocked,takeoverRequested:view.takeoverRequested,takeoverFailed:view.takeoverFailed};view.requestTakeover();await until(()=>{const current=agentTerminalLeaseState.get(session.sessionId);assert(!current?.takeoverFailed,'Production takeover callback failed');return!current||!current.inputBlocked&&!current.takeoverRequested;},'Production takeover turn fence/input release missing',15000);const afterView=agentTerminalLeaseState.get(session.sessionId);takeoverViewAfter=afterView?{agentSessionId:afterView.agentSessionId,operationId:afterView.operationId,inputBlocked:afterView.inputBlocked,takeoverRequested:afterView.takeoverRequested,takeoverFailed:afterView.takeoverFailed}:null;actionResponse={productionCallbackCompleted:true};}}catch(error){actionError=String(error);}finally{actionCompleted=true;}})();
  await until(async()=>{const active=(await invokeGetTerminalBrokerSnapshot(session.sessionId)).session?.inputObservation?.activeCommand;assert(!active?.draftCleared,'Held native editor cannot already be cleared');assert(active?.phase!=='recoveryRequired'&&active?.phase!=='uncertain','Stop acknowledgement window expired before release');return active?.agentSessionId===id&&active.commandId===command.commandId&&active.phase==='cancelRequested';},'Actual stop request did not fence selected command',1500);
  const stopRequestObservedAt=Date.now();
  const blockedQueries:unknown[]=[];
  for(let n=0;n<3;n++){
   const snapshot=await invokeGetTerminalBrokerSnapshot(session.sessionId),active=snapshot.session?.inputObservation?.activeCommand,sequence=snapshot.session?.nextInputSequence;
   assert(active?.agentSessionId===id&&active.commandId===command.commandId&&!active.draftCleared&&active.executionEvidence!=='endObserved','Unconfirmed held stop invented cleanup');
   const frontendAccepted=await controller.writeUserInput('BOUNDARY_UNCONFIRMED_BLOCKED');let backendError:string|undefined;try{await invokeWriteSession(session.sessionId,'BOUNDARY_UNCONFIRMED_BACKEND_BLOCKED');}catch(error){backendError=String(error);}
   const after=await invokeGetTerminalBrokerSnapshot(session.sessionId),records=await invokeGetTerminalSubmissionRecovery(id);assert(!frontendAccepted&&backendError&&after.session?.nextInputSequence===sequence,'Unconfirmed stop returned editing');assert(records.length===0?!active.mayHaveSubmitted:JSON.stringify(records)===JSON.stringify(recovery),'Held stop changed durable identity or settled possible submission');blockedQueries.push({snapshot,records,frontendAccepted,backendError,sequence,afterSequence:after.session?.nextInputSequence});
  }
  await report({kind:'actual-native-stop-boundary-stopped',token,id,plan,before,loadedCore,admission,recovery,actionResponse,actionError,blockedQueries,events,observations,raw,stopAttempted:true,actionInvokedAt,stopRequestObservedAt,actionCompletedBeforeRelease:actionCompleted});
  const released=await fetch('/__native-stop-boundary/'+token+'/release',{method:'POST'});assert(released.ok,'Original native boundary not released');
  const nativeReleaseRequestedAt=Date.now();await actionPromise;
  if(plan.action==='takeover')assert(object(actionResponse).productionCallbackCompleted===true&&!actionError,'Production takeover did not complete selected operation handoff');
  await until(()=>events.some(x=>x.type==='tool/result'&&(submittedBoundary?matchesWindowsStopResult(x.data.status,x.data.data,plan.action):isConfirmedPreAcceptCancel(x.data.status,x.data.data,plan.action))),'Confirmed stop result missing',15000);
  const stoppedTool=events.find((x):x is Extract<AgentSessionEvent,{type:'tool/result'}>=>x.type==='tool/result');assert(stoppedTool,'Stopped result missing');const stoppedData=object(stoppedTool.data.data);
  if(submittedBoundary){const stable=object(stoppedData.commandObservation);assert(stable.agentSessionId===id&&stable.taskId===command.taskId&&stable.operationId===command.operationId&&stable.commandId===command.commandId&&stable.sourceRevision===command.sourceRevision&&stable.leaseGeneration===command.leaseGeneration&&stable.executionEvidence==='endObserved'&&stable.fullInputConfirmed===true&&stable.submissionIntentDurable===true&&stable.noAutoReplay===true&&stoppedData.execution==='unknown','Stable matching submitted end missing');}
  await until(async()=>{const s=(await invokeGetTerminalBrokerSnapshot(session.sessionId)).session;return!!s?.promptReady&&!s.inputObservation?.commandInputPending&&!s.inputObservation?.nativeRecoveryRequired;},'Confirmed clear did not restore user input',15000);
  const confirmedClearSnapshot=await invokeGetTerminalBrokerSnapshot(session.sessionId),recoveryAfterClear=await invokeGetTerminalSubmissionRecovery(id);assert(recoveryAfterClear.length===0,'Trusted clear left intent unresolved');
  assert(await controller.writeUserInput('\r'),'Post-clear Enter blocked');const offset=raw.length;assert(await controller.writeUserInput("[Console]::WriteLine('BOUNDARY_USER_'+'RESTORED')\r"),'Ordinary user command blocked');
  await until(()=>raw.slice(offset).includes('BOUNDARY_USER_RESTORED'),'Ordinary user source did not run',10000);
  const after=await invokeGetTerminalBrokerSnapshot(session.sessionId),state=await witness();assert(Array.isArray(state.entries)&&(submittedBoundary?state.entries.length<=1&&state.entries.every(x=>x==='START'):state.entries.length===0),'Stopped source reached DONE,replayed or ran after clear');if(!submittedBoundary)assert(!observations.some(x=>{const c=x.inputObservation?.activeCommand;return c?.agentSessionId===id&&(c.mayHaveSubmitted||c.executionEvidence!=='unknown');}),'Pre-accept stopped source was submitted');
  assert(events.filter(x=>x.type==='tool/call').length===1&&events.filter(x=>x.type==='tool/approval'&&x.data.status==='approved').length===1,'Boundary source/approval repeated');
  await invokeCloseSession(session.sessionId);closed=true;
  await report({kind:'actual-native-stop-boundary',token,id,plan,before,loadedCore,admission,recovery,actionResponse,actionError,blockedQueries,confirmedClearSnapshot,recoveryAfterClear,after,state,events,observations,raw,actionInvokedAt,stopRequestObservedAt,nativeReleaseRequestedAt,actionCompleted,takeoverViewBefore,takeoverViewAfter,normalCloseSucceeded:true,sourceEffects:submittedBoundary?(state.entries as unknown[]).length:0,sourceExecution:stoppedData.execution,submittedBoundary,matchingEnd:submittedBoundary,stoppedTool,actualClear:!submittedBoundary,lateEnterSafe:true,scope:submittedBoundary?'Actual protected accept boundary with real commit/context or real submissionAccepted output identity. Stop/takeover while held;input denied before matched trusted end and original settlement. Interrupted source execution remains unknown,START at most once,no DONE/replay,ordinary user command restored. External cut is not a trusted clear/end.':'Actual native durable/armed boundary paused before acknowledgement;real cancel/takeover API and unconfirmed input gate. Confirmed cancelled/not-started result,settled original durable identity,empty recovery,safe prompt/lease and later Enter are required;transient command projection may retire before event publication. No synthetic lifecycle,argument repair,source replay or physical-button claim.'});
 }catch(error){await report({kind:'actual-native-stop-boundary-failure',failed:true,error:String(error),id,plan,events,observations,queries,raw});throw error;}
 finally{dispose.forEach(fn=>fn());if(created){await invokeCancelAgentRuntime({sessionId:id}).catch(()=>{});await invokeArchiveAgentRuntimeSession({sessionId:id}).catch(()=>{});}if(terminalId){if(!closed)await invokeCloseSession(terminalId).catch(()=>{});terminalRegistry.dispose(terminalId);}root.unmount();host.remove();}
}
void verify().then(()=>({ok:true}),(error:unknown)=>({ok:false,error:error instanceof Error?error.message:String(error)})).then(value=>fetch(`/__agent-stream-result/${new URL(location.href).searchParams.get('token')}`,{method:'POST',body:JSON.stringify(value)}));
