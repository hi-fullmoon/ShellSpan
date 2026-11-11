import {getCurrentWindow} from '@tauri-apps/api/window';
import {createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {terminalRegistry,type TerminalController} from '../registry/terminal-registry';
import {TerminalControllerLayer} from '../terminal-controller-layer';
import {TerminalPane} from '../terminal-pane';
import {agentTerminalLeaseState} from '../agent-terminal-lease-state';
import {terminalInputReadiness} from '../terminal-input-readiness';
import {AppShell} from '@/components/layout/app-shell';
import {useTerminalStore} from '@/stores/terminalStore';
import {useAppStore} from '@/stores/appStore';
import {initI18n} from '@/locales';
import {invokeCreateLocalSession,invokeCloseSession,invokeGetTerminalBrokerSnapshot,invokeListAiRoutes,
 invokeCreateAgentRuntimeSession,invokeRunTerminalAcceptanceCommand,invokeDecideTerminalAcceptanceCommand,
 invokeGetAgentRuntimeEvents,invokeCancelAgentRuntime,invokeInterruptAgentRuntime,invokeGetTerminalSubmissionRecovery,type TerminalAcceptanceSourceKind} from '@/lib/ipc/tauri';
import type {AgentSessionEvent} from '@/types/agent-session';
import {macLifecycleCapture} from './mac-lifecycle-capture';
import {isMacFileChainProfile} from './native-file-chain-posix';
import '@/styles/base.css';

function assert(value:unknown,message:string):asserts value{if(!value)throw Error(message);}
async function until(check:()=>boolean|Promise<boolean>,message:string){const end=Date.now()+20000;while(!await check()){assert(Date.now()<end,message);await new Promise(done=>setTimeout(done,20));}}

async function verify(){
 const parameters=new URL(location.href).searchParams,token=parameters.get('token'),selection=parameters.get('macDaily'),home=parameters.get('caseHome');
 assert(token&&home?.startsWith('/')&&['submission-zsh','submission-bash'].includes(selection??''),'Exact owned no-model submission case required');
 const family=selection==='submission-zsh'?'zsh':'bash',records:Record<string,unknown>[]=[],agentIds:string[]=[];
 await initI18n('zh-CN');await getCurrentWindow().show();await getCurrentWindow().setFocus();
 const routes=await invokeListAiRoutes();assert(routes.routes.length===0&&!routes.defaultSelection,'Submission acceptance requires an empty actual model route store');
 const capture=await macLifecycleCapture(token),session=await invokeCreateLocalSession(100,30);await capture.expect(session);
 useTerminalStore.getState().addSession(session);useTerminalStore.getState().setActiveSession(session.sessionId);useAppStore.getState().setActiveSection('terminal');
 const binding:{controller?:TerminalController}={};
 const stopBinding=terminalRegistry.subscribe(()=>{const current=terminalRegistry.get(session.sessionId);if(current&&!binding.controller){capture.bind(current);binding.controller=current;}});
 const root=createRoot(document.getElementById('root')!);
 function Pane(){const activeSession=useTerminalStore(state=>state.sessions.find(item=>item.sessionId===session.sessionId)??null);return createElement(AppShell,null,createElement('div',{className:'min-h-0 flex-1'},createElement(TerminalControllerLayer),createElement(TerminalPane,{activeSession,isActive:true,isVisible:true})));}
 root.render(createElement(Pane));await until(()=>!!binding.controller?.host,'Actual production terminal pane did not attach');const controller=binding.controller;assert(controller,'Actual production controller missing');await controller.whenOutputReady();
 const snapshot=()=>invokeGetTerminalBrokerSnapshot(session.sessionId);
 const idle=async()=>{const value=(await snapshot()).session;return !!value?.promptReady&&!value.inputObservation?.commandInputPending&&!value.inputObservation?.nativeRecoveryRequired;};
 const witness=async()=>{const response=await fetch('/__native-mac-submission-witness/'+token);assert(response.ok,'Actual submission effect could not be read');const value=await response.json() as {exists:boolean;text:string|null;sha256:string|null;readOnly:boolean};assert(value.readOnly,'Effect witness granted write authority');return value;};
 type Cut={version:number;pid:number;nonce:string;cut:'intent'|'input-complete'|'armed';identity:{agentSessionId:string;taskId:string;operationId:string;commandId:string;sourceRevision:number}};
 type ControlAction='stop'|'cancel'|'takeover';
 type ControlScenario=`${Cut['cut']}-${ControlAction}`;
 type ControlRequest={requestKind:'cancel-token'|'takeover-owner-validated';nonce:string;pid:number;identity:Cut['identity']};
 const cutState=async()=>{const response=await fetch('/__native-mac-submission-cut/'+token);assert(response.ok,'Actual cut observation failed');const value=await response.json() as {enabled:boolean;cut:Cut|null;scenario?:ControlScenario|null;requests?:ControlRequest[];authority:string};assert(value.authority==='test-barrier-only','Cut control was presented as execution authority');return value;};
 const cutConfiguration=await cutState();
 const events=async(id:string)=>(await invokeGetAgentRuntimeEvents({sessionId:id,limit:500})).events;
 function pendingApproval(page:readonly AgentSessionEvent[],callId:string){
  const latest=new Map<string,Extract<AgentSessionEvent,{type:'tool/approval'}>>();
  for(const event of page)if(event.type==='tool/approval'&&event.data.approvalId)latest.set(event.data.approvalId,event);
  const approval=[...latest.values()].find(event=>event.data.callId===callId&&event.data.status==='requested');
  assert(approval?.data.approvalId&&approval.turnId&&approval.stepId,'Actual production approval identity missing');
  return {sessionId:approval.sessionId,turnId:approval.turnId,stepId:approval.stepId,requestId:approval.data.requestId,callId:approval.data.callId,approvalId:approval.data.approvalId};
 }
 async function run(kind:TerminalAcceptanceSourceKind){
  const id='phase3-submission-'+crypto.randomUUID(),callId=crypto.randomUUID();agentIds.push(id);
  const target={kind:'local' as const,targetId:'terminal-'+session.sessionId,sessionId:session.sessionId,cwd:home!,localRoot:home!};
  const created=await invokeCreateAgentRuntimeSession({sessionId:id,taskId:id,goal:'Execute only the explicitly authorized isolated submission safety request without a model',target,permissionMode:'requestApproval',executionSurface:'boundTerminal',capabilityScope:{toolNames:['run_terminal_command'],effects:kind==='syntax-error'?['stateChange','readOnly','externalSideEffect']:['stateChange','readOnly'],targetIds:[target.targetId]}});
  assert(!created.header.modelSelection,'Actual acceptance session selected a model');
  const brokerBefore=await snapshot();
  const partial:Record<string,unknown>={id,callId,kind,created,brokerBefore};records.push(partial);
  const prepared=await invokeRunTerminalAcceptanceCommand(id,callId,kind);assert(prepared.modelAvailability==='MODEL_SELECTION_REQUIRED','A model was registered in the no-model entrance');
  const before=await events(id);Object.assign(partial,{prepared,before});let decision:unknown;
  if(prepared.settlement==='Waiting'){
   const approval=pendingApproval(before,callId);
   if(kind==='effect'&&cutConfiguration.enabled){
    const decisionRequest=invokeDecideTerminalAcceptanceCommand(approval,true);void decisionRequest.catch(()=>{});
    let cut:Cut|undefined;
    await until(async()=>{const state=await cutState();if(state.cut){cut=state.cut;return true;}return false;},'Actual submission cut was not observed');
    assert(cut&&cut.identity.agentSessionId===id&&cut.identity.taskId===id,'Cut does not belong to this frozen invocation');const observedCut=cut;
    const cutBroker=await snapshot(),active=cutBroker.session?.inputObservation?.activeCommand;
    const durable=observedCut.cut!=='input-complete';
    assert(active?.submissionIntentDurable===durable&&active.fullInputConfirmed&&!active.mayHaveSubmitted&&active.phase==='inputConfirmed','Actual input and intent state did not match the cut before arm/accept');
    assert(active.commandId===observedCut.identity.commandId&&active.operationId===observedCut.identity.operationId,'Held broker state has a different command identity');
    const recoveryAtCut=await invokeGetTerminalSubmissionRecovery(id);assert(recoveryAtCut.length===(durable?1:0),'Actual recovery records did not match the expected intent state');
    assert(controller,'Actual controller missing at submission cut');const competingEnter=await controller.writeUserInput('\r');capture.recordInput('\r',competingEnter,'Competing Enter at actual '+observedCut.cut+' cut');assert(!competingEnter,'Competing user Enter crossed the command owner');
    if(cutConfiguration.scenario){
     const action=cutConfiguration.scenario;
     assert(action.startsWith(observedCut.cut+'-'),'Actual cut differs from requested control scenario');
     const takeover=action.endsWith('-takeover');
     const actualUiTakeover=async()=>{const lease=agentTerminalLeaseState.get(session.sessionId);assert(lease?.agentSessionId===id&&lease.operationId===observedCut.identity.operationId,'Production takeover view does not match the actual owner');lease.requestTakeover();await until(async()=>!agentTerminalLeaseState.get(session.sessionId)&&(await events(id)).some(event=>event.type==='turn/end'&&event.turnId===approval.turnId),'Production takeover flow did not release the real lease view and finish the original turn');return{origin:'production-terminal-lease-view',leaseViewReleased:true,turnEndObserved:true};};
     const pendingControl=takeover?actualUiTakeover():action.endsWith('-stop')?invokeInterruptAgentRuntime({sessionId:id}):invokeCancelAgentRuntime({sessionId:id});void pendingControl.catch(()=>{});
     let entered:ControlRequest|undefined;await until(async()=>{entered=(await cutState()).requests?.find(request=>request.identity.agentSessionId===id&&request.identity.commandId===observedCut.identity.commandId&&request.requestKind===(takeover?'takeover-owner-validated':'cancel-token'));return !!entered;},'Actual production control request did not enter before release');
     const afterRequest=await snapshot(),enterAfterRequest=await controller.writeUserInput('\r');capture.recordInput('\r',enterAfterRequest,'Enter after observed production control request, before clearance');assert(!enterAfterRequest,'Control request returned editing before actual clearance');
     const controlRecord:Record<string,unknown>={action,observedCut,cutBroker,recoveryAtCut,competingEnter,entered,afterRequest,enterAfterRequest};Object.assign(partial,{controlRecord});
     const release=await fetch('/__native-mac-submission-cut/'+token,{method:'POST',body:JSON.stringify({nonce:observedCut.nonce,pid:observedCut.pid})});assert(release.ok,'Owned control cut could not be released');
     const [decisionOutcome,controlOutcome]=await Promise.allSettled([decisionRequest,pendingControl]);const observedDecision=decisionOutcome.status==='fulfilled'?decisionOutcome:{status:'rejected',reason:String(decisionOutcome.reason)},observedControl=controlOutcome.status==='fulfilled'?controlOutcome:{status:'rejected',reason:String(controlOutcome.reason)};Object.assign(controlRecord,{decisionOutcome:observedDecision,controlOutcome:observedControl});assert(controlOutcome.status==='fulfilled','Actual stop/cancel/takeover failed');decision=observedDecision;
    }else{
    const concurrent:{startedAt:number;finishedAt?:number;result?:unknown;error?:string}[]=[],cutRecord={observedCut,cutBroker,recoveryAtCut,competingEnter,concurrent,releaseStartedAt:0};Object.assign(partial,{cutRecord});
    const replay=async()=>{const attempt:typeof concurrent[number]={startedAt:performance.now()};concurrent.push(attempt);try{attempt.result=await invokeRunTerminalAcceptanceCommand(id,callId,kind);}catch(error){attempt.error=String(error);}finally{attempt.finishedAt=performance.now();}};
    const first=replay(),second=replay();await Promise.all([first,second]);cutRecord.releaseStartedAt=performance.now();
    assert(concurrent.every(attempt=>typeof attempt.finishedAt==='number'&&attempt.finishedAt<=cutRecord.releaseStartedAt)&&concurrent[0].startedAt<concurrent[1].finishedAt!&&concurrent[1].startedAt<concurrent[0].finishedAt!,'The actual duplicate RPCs did not overlap and finish while FULL was held');
    assert(!(await witness()).exists,'An actual effect occurred before the FULL barrier was released');
    const release=await fetch('/__native-mac-submission-cut/'+token,{method:'POST',body:JSON.stringify({nonce:observedCut.nonce,pid:observedCut.pid})});assert(release.ok,'Owned cut could not be released');
    const [approvedResult]=await Promise.all([decisionRequest,first,second]);decision=approvedResult;
    assert(concurrent.length===2&&concurrent.every(attempt=>attempt.startedAt<=cutRecord.releaseStartedAt),'Concurrent duplicates did not enter while the actual cut was held');
    }
   }else decision=await invokeDecideTerminalAcceptanceCommand(approval,true);
  }
  const after=await events(id),effects=await witness(),recovery=await invokeGetTerminalSubmissionRecovery(id);
  const brokerAfter=await snapshot(),record={id,callId,kind,created,brokerBefore,brokerAfter,prepared,before,decision,after,effects,recovery};Object.assign(partial,record);
  return record;
 }
 let problem:unknown,closed=false;
 try{
  await until(idle,'Actual native prompt did not become ready');const initial=await snapshot();assert(isMacFileChainProfile(initial.session?.nativePeerProfile,family),'Exact native Shell binding missing');assert(!(await witness()).exists,'Owned effect file already exists');
  await capture.checkpoint('submission-ready',{session,initial,routes});
  const effect=await run('effect');
  if(cutConfiguration.scenario){
   assert(!effect.after.some(event=>event.type==='tool/result'&&event.data.callId===effect.callId&&event.data.status==='completed'),'Preaccept control allowed a completed execution');assert(!effect.effects.exists,'Preaccept control executed the effect');
   await until(async()=>!agentTerminalLeaseState.get(session.sessionId)&&!terminalInputReadiness.isPreparing(session.sessionId)&&await idle(),'Actual control did not confirm clearance and release the terminal view');
   const beforeEnter=await snapshot(),accepted=await controller.writeUserInput('\r');capture.recordInput('\r',accepted,'Enter only after actual control clearance');assert(accepted,'Editing was not returned after confirmed clearance');await until(idle,'Post-control Enter did not return to a prompt');
   assert(!(await witness()).exists,'Post-control Enter executed a residual draft');records.push({postControlEnter:{accepted,beforeEnter,afterEnter:await snapshot(),effects:await witness()}});
   await invokeCancelAgentRuntime({sessionId:effect.id});await invokeCloseSession(session.sessionId);closed=true;const retained=await capture.finish();
   const response=await fetch('/__agent-stream-result/'+token,{method:'POST',body:JSON.stringify({ok:true,evidence:{kind:'actual-macos-submission-intent-control',scenario:cutConfiguration.scenario,family,session,records,retained,routes,humanReceipt:false,physicalInputClaim:false,phase3Complete:false}})});assert(response.ok,'Actual control evidence was not retained');return;
  }
  assert(effect.after.some(event=>event.type==='tool/result'&&event.data.callId===effect.callId&&event.data.status==='completed'),'Actual production tool did not report a successful execution');
  assert(effect.effects.text===effect.callId+'\n','Actual filesystem effect is not exactly one occurrence');assert(effect.recovery.length===0,'Settled execution retained an unresolved durable intent');
  await capture.checkpoint('submission-settled',{effect});
  const duplicateResults:unknown[]=[],duplicateRecord:Record<string,unknown>={duplicateResults};records.push(duplicateRecord);
  for(let index=0;index<2;index++){
   try{
    const repeated=await invokeRunTerminalAcceptanceCommand(effect.id,effect.callId,'effect');duplicateResults.push({repeated});
    if(repeated.settlement==='Waiting'){
     const approval=pendingApproval(await events(effect.id),effect.callId);
     duplicateResults.push({actualDecision:await invokeDecideTerminalAcceptanceCommand(approval,true)});
    }
   }catch(error){duplicateResults.push({error:String(error)});}
   assert((await witness()).text===effect.callId+'\n','Duplicate invocation added an actual effect');
  }
  Object.assign(duplicateRecord,{events:await events(effect.id),witness:await witness()});
  await invokeCancelAgentRuntime({sessionId:effect.id});await until(idle,'Completed acceptance owner did not release the native terminal after real cancellation');
  await capture.checkpoint('submission-duplicates',{duplicateResults,witness:await witness()});
  for(const kind of ['syntax-error','unsupported-input'] as const){
   const refused=await run(kind);assert(!refused.after.some(event=>event.type==='tool/result'&&event.data.callId===refused.callId&&event.data.status==='completed'),'Invalid input reported successful execution');
   const dispatched=refused.after.some(event=>event.type==='tool/execution'&&event.data.callId===refused.callId);
   if(dispatched){
    const result=refused.after.find((event):event is Extract<AgentSessionEvent,{type:'tool/result'}>=>event.type==='tool/result'&&event.data.callId===refused.callId);
    const data=result?.data.data;assert(data&&typeof data==='object'&&!Array.isArray(data)&&'execution' in data&&data.execution==='notStarted','Invalid source reached possible execution');
   }else assert(refused.brokerBefore.session?.nextInputSequence===refused.brokerAfter.session?.nextInputSequence,'Preparation refusal wrote source to the PTY');
   assert(refused.recovery.length===0,'Invalid source persisted a submission intention');
   assert(refused.effects.text===effect.callId+'\n','Invalid input executed its valid leading command');
   await invokeCancelAgentRuntime({sessionId:refused.id});await until(idle,'Refused command owner did not confirm native cleanup');
   const accepted=await controller.writeUserInput('\r');capture.recordInput('\r',accepted,'Enter after confirmed invalid-source cleanup');assert(accepted,'User Enter was not returned after confirmed cleanup');await until(idle,'User Enter did not return to an empty prompt');
   assert((await witness()).text===effect.callId+'\n','Enter executed residual invalid-source draft');
  }
  await capture.checkpoint('submission-rejected',{records,witness:await witness(),broker:await snapshot()});
  await invokeCloseSession(session.sessionId);closed=true;
  const retained=await capture.finish();
  const response=await fetch('/__agent-stream-result/'+token,{method:'POST',body:JSON.stringify({ok:true,evidence:{kind:'actual-macos-submission-preflight',family,session,records,retained,routes,humanReceipt:false,physicalInputClaim:false,phase3Complete:false,scope:'Actual no-model tool preparation, approval, native execution, duplicate effect fence and invalid-source Enter recovery. Ordered fault-cut proof and the complete fixed matrix remain separate obligations.'}})});assert(response.ok,'Actual submission evidence was not retained');
 }catch(error){
  problem=error;for(const id of agentIds)try{await invokeCancelAgentRuntime({sessionId:id});}catch(cleanup){records.push({agent:id,cleanupError:String(cleanup)});}
  if(!closed)try{await invokeCloseSession(session.sessionId);closed=true;}catch(cleanup){records.push({closeError:String(cleanup)});}
  await capture.diagnose().catch(diagnostic=>records.push({diagnosticError:String(diagnostic)}));
  await fetch('/__agent-stream-result/'+token,{method:'POST',body:JSON.stringify({ok:false,error:String(problem),evidence:{kind:'actual-macos-submission-preflight-failure',family,session,records,humanReceipt:false,phase3Complete:false}})});
 }finally{capture.stop();stopBinding();root.unmount();terminalRegistry.dispose(session.sessionId);}
}
void verify().catch(error=>{const token=new URL(location.href).searchParams.get('token');void fetch('/__agent-stream-result/'+token,{method:'POST',body:JSON.stringify({ok:false,error:String(error)})});});
