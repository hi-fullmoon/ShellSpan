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
 invokeCreateAgentRuntimeSession,invokeRunTerminalAcceptanceCommand,invokeDecideTerminalAcceptanceCommand,invokeApproveAgentRuntimeTool,
 invokeSpawnAgentRuntimeSubagent,invokeCancelAgentRuntimeChild,invokeGetAgentTerminalOwner,
 invokeGetAgentRuntimeEvents,invokeGetAgentRuntimeSession,invokeInspectAgentRuntimeRecovery,invokeResumeAgentRuntimeRecovery,invokeCancelAgentRuntime,invokeInterruptAgentRuntime,invokeReconnectAgentTerminal,invokeGetTerminalSubmissionRecovery,invokeGetTerminalAcceptanceRawOutput,type TerminalAcceptanceSourceKind} from '@/lib/ipc/tauri';
import type {AgentSessionEvent} from '@/types/agent-session';
import {macLifecycleCapture} from './mac-lifecycle-capture';
import {macWireCapture} from './mac-wire-capture';
import {isMacFileChainProfile} from './native-file-chain-posix';
import '@/styles/base.css';

function assert(value:unknown,message:string):asserts value{if(!value)throw Error(message);}
async function until(check:()=>boolean|Promise<boolean>,message:string){const end=Date.now()+20000;while(!await check()){assert(Date.now()<end,message);await new Promise(done=>setTimeout(done,20));}}

async function verify(){
 const parameters=new URL(location.href).searchParams,token=parameters.get('token'),selection=parameters.get('macDaily'),home=parameters.get('caseHome');
 assert(token&&home?.startsWith('/')&&['submission-zsh','submission-bash'].includes(selection??''),'Exact owned no-model submission case required');
 const family=selection==='submission-zsh'?'zsh':'bash',records:Record<string,unknown>[]=[],agentIds:string[]=[],extraTerminals=new Set<string>();
 await initI18n('zh-CN');await getCurrentWindow().show();
 const routes=await invokeListAiRoutes();assert(routes.routes.length===0&&!routes.defaultSelection,'Submission acceptance requires an empty actual model route store');
 const observationResponse=await fetch('/__native-mac-submission-cut/'+token);assert(observationResponse.ok,'Actual scenario observation failed');
 const observationConfiguration=await observationResponse.json() as {scenario?:string|null;authority:string};assert(observationConfiguration.authority==='test-barrier-only','Scenario observation was presented as execution authority');
 const incompleteProof = observationConfiguration.scenario === 'incomplete-proof';
 const readonlyQuery = observationConfiguration.scenario === 'readonly-query-does-not-authorize';
 const inputInProgress = incompleteProof || readonlyQuery || observationConfiguration.scenario?.startsWith('input-in-progress-') === true;
 const nativeUnsupported = observationConfiguration.scenario === 'unsupported-input-native';
 const bindingNegative = ['source-mismatch', 'plan-mismatch'].includes(observationConfiguration.scenario ?? '') || nativeUnsupported;
 const transportLoss = observationConfiguration.scenario === 'transport-disconnect';
 const armIdentity = ['identity-mismatch','complete-identity-submatrix','generation-mismatch'].includes(observationConfiguration.scenario ?? '');
 const permissionMismatch = observationConfiguration.scenario === 'permission-mismatch';
 const manifestMismatch = observationConfiguration.scenario === 'resource-manifest-mismatch';
 const useParsedOutput = ['close-running-terminal', 'timeout-unknown-accept', 'control-eof', 'late-started-and-matched-settled', 'target-mismatch','delegation'].includes(observationConfiguration.scenario ?? '') || observationConfiguration.scenario?.startsWith('wire-') === true || observationConfiguration.scenario?.startsWith('after-accept-') === true || inputInProgress || bindingNegative || transportLoss || armIdentity || permissionMismatch;
 const wireFault = observationConfiguration.scenario?.startsWith('wire-') === true && observationConfiguration.scenario !== 'wire-split-and-coalesced';
 const capture=await macLifecycleCapture(token,{parsedOutputOrder:useParsedOutput||manifestMismatch,startupOutputMayPrecedeSubscription:wireFault||manifestMismatch}),session=await invokeCreateLocalSession(100,30);await capture.expect(session);
 useTerminalStore.getState().addSession(session);useTerminalStore.getState().setActiveSession(session.sessionId);useAppStore.getState().setActiveSection('terminal');
 const binding:{controller?:TerminalController}={};
 const stopBinding=terminalRegistry.subscribe(()=>{const current=terminalRegistry.get(session.sessionId);if(current&&!binding.controller){capture.bind(current);binding.controller=current;}});
 const root=createRoot(document.getElementById('root')!);
 function Pane(){const activeSession=useTerminalStore(state=>state.sessions.find(item=>item.sessionId===session.sessionId)??null);return createElement(AppShell,null,createElement('div',{className:'min-h-0 flex-1'},createElement(TerminalControllerLayer),createElement(TerminalPane,{activeSession,isActive:true,isVisible:true})));}
 root.render(createElement(Pane));await until(()=>!!binding.controller?.host,'Actual production terminal pane did not attach');const controller=binding.controller;assert(controller,'Actual production controller missing');await controller.whenOutputReady();
 const snapshot=()=>invokeGetTerminalBrokerSnapshot(session.sessionId);
 const idle=async()=>{const value=(await snapshot()).session;return !!value?.promptReady&&!value.inputObservation?.commandInputPending&&!value.inputObservation?.nativeRecoveryRequired;};
 const witness=async()=>{const response=await fetch('/__native-mac-submission-witness/'+token);assert(response.ok,'Actual submission effect could not be read');const value=await response.json() as {exists:boolean;text:string|null;sha256:string|null;readOnly:boolean};assert(value.readOnly,'Effect witness granted write authority');return value;};
 type Cut={version:number;pid:number;nonce:string;cut:'intent'|'input-in-progress'|'input-complete'|'armed'|'before-accept'|'after-accept'|'prepare'|'key'|'accept-receipt'|'settled-receipt'|'arm-identity';identity:{agentSessionId:string;taskId:string;operationId:string;commandId:string;sourceRevision:number}};
 type ControlAction='stop'|'cancel'|'takeover';
 type ControlScenario=`${Cut['cut']}-${ControlAction}`;
 type RunningScenario=`running-${ControlAction}`;
 type IsolationScenario='runtime-multi-agent'|'close-running-terminal'|'target-mismatch'|'delegation';
 type ControlRequest={requestKind:'cancel-token'|'takeover-owner-validated';nonce:string;pid:number;identity:Cut['identity']};
 type CancelWrite={requestId:string;sequence:number;returnSequence:number};
 const cutRoute=(settlement=false)=>'/__native-mac-submission-'+(settlement?'settled-cut':'cut')+'/'+token;
 const cutState=async(settlement=false)=>{const response=await fetch(cutRoute(settlement));assert(response.ok,'Actual cut observation failed');const value=await response.json() as {enabled:boolean;cut:Cut|null;scenario?:ControlScenario|RunningScenario|IsolationScenario|'approval-mismatch'|'expired-or-revoked'|'timeout-unknown-accept'|'control-eof'|'late-started-and-matched-settled'|'incomplete-proof'|'readonly-query-does-not-authorize'|'identity-mismatch'|'complete-identity-submatrix'|'generation-mismatch'|'permission-mismatch'|`app-crash-${'intent'|'prepare'|'proof'|'arm'|'key'|'restart'}`|null;requests?:ControlRequest[];cancelWritten?:CancelWrite|null;authority:string};assert(value.authority==='test-barrier-only','Cut control was presented as execution authority');return value;};
 const cutConfiguration=await cutState();
 const events=async(id:string)=>(await invokeGetAgentRuntimeEvents({sessionId:id,limit:500})).events;
 function pendingApproval(page:readonly AgentSessionEvent[],callId:string){
  const latest=new Map<string,Extract<AgentSessionEvent,{type:'tool/approval'}>>();
  for(const event of page)if(event.type==='tool/approval'&&event.data.approvalId)latest.set(event.data.approvalId,event);
  const approval=[...latest.values()].find(event=>event.data.callId===callId&&event.data.status==='requested');
  assert(approval?.data.approvalId&&approval.turnId&&approval.stepId,'Actual production approval identity missing');
  return {sessionId:approval.sessionId,turnId:approval.turnId,stepId:approval.stepId,requestId:approval.data.requestId,callId:approval.data.callId,approvalId:approval.data.approvalId};
 }
 async function run(kind:TerminalAcceptanceSourceKind,deferApproval=false,targetSession=session){
  const id='phase3-submission-'+crypto.randomUUID(),callId=crypto.randomUUID();agentIds.push(id);
  const target={kind:'local' as const,targetId:'terminal-'+targetSession.sessionId,sessionId:targetSession.sessionId,cwd:home!,localRoot:home!};
  const created=await invokeCreateAgentRuntimeSession({sessionId:id,taskId:id,goal:'Execute only the explicitly authorized isolated submission safety request without a model',target,permissionMode:'requestApproval',executionSurface:'boundTerminal',capabilityScope:{toolNames:['run_terminal_command'],effects:kind==='syntax-error'?['stateChange','readOnly','externalSideEffect']:['stateChange','readOnly'],targetIds:[target.targetId]}});
  assert(!created.header.modelSelection,'Actual acceptance session selected a model');
  const brokerBefore=await invokeGetTerminalBrokerSnapshot(targetSession.sessionId);
  const partial:Record<string,unknown>={id,callId,kind,created,brokerBefore};records.push(partial);
  const prepared=await invokeRunTerminalAcceptanceCommand(id,callId,kind);assert(prepared.modelAvailability==='MODEL_SELECTION_REQUIRED','A model was registered in the no-model entrance');
  const before=await events(id);Object.assign(partial,{prepared,before});let decision:unknown;
  if(prepared.settlement==='Waiting'&&!deferApproval){
   const approval=pendingApproval(before,callId);
   if((kind==='effect'||kind==='paced-input'&&inputInProgress)&&cutConfiguration.enabled){
    const decisionRequest=invokeDecideTerminalAcceptanceCommand(approval,true);void decisionRequest.catch(()=>{});
    let cut:Cut|undefined;
    await until(async()=>{const state=await cutState();if(state.cut){cut=state.cut;return true;}return false;},'Actual submission cut was not observed');
    assert(cut&&cut.identity.agentSessionId===id&&cut.identity.taskId===id,'Cut does not belong to this frozen invocation');const observedCut=cut;
    const cutBroker=await snapshot(),active=cutBroker.session?.inputObservation?.activeCommand;
    const inProgress=observedCut.cut==='input-in-progress';
    const durable=observedCut.cut!=='input-complete'&&!inProgress;
    assert(active?.submissionIntentDurable===durable&&active.fullInputConfirmed===!inProgress&&!active.mayHaveSubmitted&&active.phase===(inProgress?'typing':'inputConfirmed'),'Actual input and intent state did not match the cut before arm/accept');
    assert(active.commandId===observedCut.identity.commandId&&active.operationId===observedCut.identity.operationId,'Held broker state has a different command identity');
    let pauseObservation: {nonce:string;status:string;identity:Cut['identity'];observedEndBytes:number;sourceBytes:number}|undefined;
    if(inProgress){
     await until(async()=>{
      const response=await fetch('/__native-mac-submission-input-pause/'+token);
      assert(response.ok,'Actual Shell pause observation failed');
      const value=await response.json() as {observation:typeof pauseObservation;authority:string};
      assert(value.authority==='process-observation-only','Process observation was presented as execution authority');
      pauseObservation=value.observation;
      return !!pauseObservation;
     },'The actual input worker was not observed stopped');
     assert(pauseObservation?.nonce===observedCut.nonce&&pauseObservation.status==='stopped'
      &&pauseObservation.identity.commandId===active.commandId&&pauseObservation.observedEndBytes>0
      &&pauseObservation.observedEndBytes<pauseObservation.sourceBytes,'The stopped Shell did not match the original partial input');
    }
    const recoveryAtCut=await invokeGetTerminalSubmissionRecovery(id);assert(recoveryAtCut.length===(durable?1:0),'Actual recovery records did not match the expected intent state');
    assert(controller,'Actual controller missing at submission cut');const competingEnter=await controller.writeUserInput('\r');capture.recordInput('\r',competingEnter,'Competing Enter at actual '+observedCut.cut+' cut');assert(!competingEnter,'Competing user Enter crossed the command owner');
    if(cutConfiguration.scenario){
     const action=armIdentity?'arm-identity-cancel':incompleteProof||readonlyQuery?'input-in-progress-cancel':cutConfiguration.scenario;
     assert(action.startsWith(observedCut.cut+'-'),'Actual cut differs from requested control scenario');
     const takeover=action.endsWith('-takeover');
     const actualUiTakeover=async()=>{const lease=agentTerminalLeaseState.get(session.sessionId);assert(lease?.agentSessionId===id&&lease.operationId===observedCut.identity.operationId,'Production takeover view does not match the actual owner');lease.requestTakeover();await until(async()=>!agentTerminalLeaseState.get(session.sessionId)&&(await events(id)).some(event=>event.type==='turn/end'&&event.turnId===approval.turnId),'Production takeover flow did not release the real lease view and finish the original turn');return{origin:'production-terminal-lease-view',leaseViewReleased:true,turnEndObserved:true};};
     const pendingControl=takeover?actualUiTakeover():action.endsWith('-stop')?invokeInterruptAgentRuntime({sessionId:id}):invokeCancelAgentRuntime({sessionId:id});void pendingControl.catch(()=>{});
     let entered:ControlRequest|undefined;await until(async()=>{entered=(await cutState()).requests?.find(request=>request.identity.agentSessionId===id&&request.identity.commandId===observedCut.identity.commandId&&request.requestKind===(takeover?'takeover-owner-validated':'cancel-token'));return !!entered;},'Actual production control request did not enter before release');
     const afterRequest=await snapshot(),enterAfterRequest=await controller.writeUserInput('\r');capture.recordInput('\r',enterAfterRequest,'Enter after observed production control request, before clearance');assert(!enterAfterRequest,'Control request returned editing before actual clearance');
     const controlRecord:Record<string,unknown>={action,observedCut,cutBroker,recoveryAtCut,competingEnter,entered,afterRequest,enterAfterRequest,pauseObservation};Object.assign(partial,{controlRecord});
     if(armIdentity){
      let cancelWritten:CancelWrite|null|undefined;
      await until(async()=>{cancelWritten=(await cutState()).cancelWritten;return !!cancelWritten;},'Actual CancelDraft did not reach the private socket while the original arm was held');
      Object.assign(controlRecord,{cancelWritten});
     }
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
  const brokerAfter=await invokeGetTerminalBrokerSnapshot(targetSession.sessionId),record={id,callId,kind,created,brokerBefore,brokerAfter,prepared,before,decision,after,effects,recovery};Object.assign(partial,record);
  return record;
 }
 let problem:unknown,closed=false,secondWire:Awaited<ReturnType<typeof macWireCapture>>|undefined;
 try{
  const wireScenario = observationConfiguration.scenario;
  if(manifestMismatch){
   const before=await snapshot();
   assert(before.session?.open&&before.session.inputMode==='raw'&&!before.session.nativePeerProfile,
    'The actual terminal admitted the resource manifest mismatch');
   const refusal=await run('effect',true),after=await snapshot(),effect=await witness();
   assert(refusal.prepared.settlement!=='Waiting'
    &&!refusal.after.some(event=>event.type==='tool/execution')
    &&!refusal.effects.exists&&!effect.exists&&refusal.recovery.length===0
    &&before.session.nextInputSequence===after.session?.nextInputSequence,
   'Wrong resource manifest reached an actual approval, input or effect');
   await invokeCancelAgentRuntime({sessionId:refusal.id});
   await invokeCloseSession(session.sessionId);
   closed=true;
   const retained=await capture.finish();
   const response=await fetch('/__agent-stream-result/'+token,{method:'POST',body:JSON.stringify({
    ok:true,evidence:{kind:'actual-macos-resource-manifest-mismatch',scenario:wireScenario,session,before,after,refusal,effect,retained,routes,
     humanReceipt:false,phase3Complete:false},
   })});
   assert(response.ok,'Actual resource mismatch evidence was not retained');
   return;
  }
  if (wireScenario?.startsWith('wire-')) {
   const initial = await snapshot();
   const positive = wireScenario === 'wire-split-and-coalesced';
   let refusal;
   if (positive) {
    await until(idle, 'Split startup probe did not negotiate the actual terminal');
   } else {
    await until(async () => (await snapshot()).session?.integrationState === 'unavailable',
     'Malformed startup frame did not close the native control path');
    refusal = await run('effect', true);
    assert(refusal.prepared.settlement !== 'Waiting', 'An unavailable control path still offered native approval');
    assert(!refusal.after.some(event => event.type === 'tool/execution'), 'A malformed connection reached command execution');
    assert(refusal.recovery.length === 0 && !refusal.effects.exists, 'Malformed frame created an intent or effect');
   }
   const final = await snapshot();
   const effect = await witness();
   assert(final.session && final.session.terminalSessionId === session.terminalSessionId, 'Wire case lost its original terminal identity');
   assert(final.session?.nextInputSequence === initial.session?.nextInputSequence && !effect.exists, 'Wire case wrote command input');
   if (positive) assert(isMacFileChainProfile(final.session.nativePeerProfile, family), 'Verified peer did not negotiate');
   const journalAgentId = refusal?.id ?? 'phase3-submission-' + crypto.randomUUID();
   if (!refusal) {
    assert(home, 'The actual isolated home is required for the journal query');
    const target = {kind: 'local' as const, targetId: 'terminal-' + session.sessionId, sessionId: session.sessionId, cwd: home, localRoot: home};
    await invokeCreateAgentRuntimeSession({sessionId: journalAgentId, taskId: journalAgentId,
     goal: 'Inspect the original isolated terminal submission journal', target, permissionMode: 'requestApproval', executionSurface: 'boundTerminal'});
    agentIds.push(journalAgentId);
   }
   const recovery = await invokeGetTerminalSubmissionRecovery(journalAgentId);
   assert(recovery.length === 0, 'Framing created a submission intent');
   await invokeCancelAgentRuntime({sessionId: journalAgentId});
   await invokeCloseSession(session.sessionId);
   closed = true;
   const retained = await capture.finish();
   const response = await fetch('/__agent-stream-result/'+token, {method: 'POST', body: JSON.stringify({
    ok: true, evidence: {kind: 'actual-macos-wire-startup', scenario: wireScenario, family, session,
     initial, final, effect, refusal, journalAgentId, recovery, retained, routes, humanReceipt: false, phase3Complete: false},
   })});
   assert(response.ok, 'Actual wire case was not retained');
   return;
  }
  await until(idle,'Actual native prompt did not become ready');const initial=await snapshot();assert(isMacFileChainProfile(initial.session?.nativePeerProfile,family),'Exact native Shell binding missing');if(cutConfiguration.scenario!=='app-crash-restart')assert(!(await witness()).exists,'Owned effect file already exists');
  if(cutConfiguration.scenario==='app-crash-restart'){
   type Approval=ReturnType<typeof pendingApproval>;
   const observed=await fetch('/__native-mac-submission-resume/'+token);assert(observed.ok,'Original actual crash record not available');
   const prior=await observed.json() as {original:{approval:Approval;invocation:{agentSessionId:string;callId:string;sourceKind:'effect'|'running'};session:typeof session};identity:Cut['identity'];cut:Cut['cut'];afterCrashEffect:{exists:boolean;text:string|null;sha256:string|null};previousAppPid:number;authority:string};
   assert(prior.authority==='crash-observation-only'&&prior.original.invocation.agentSessionId===prior.identity.agentSessionId&&prior.original.session.sessionId!==session.sessionId,'Restart did not retain the real original identity');
   const originalSession=await invokeGetAgentRuntimeSession({sessionId:prior.original.invocation.agentSessionId}),originalTarget=await invokeGetTerminalBrokerSnapshot(prior.original.session.sessionId);
   assert(originalSession.header.target?.sessionId===prior.original.session.sessionId&&!originalTarget.session?.open,'Restart changed or reopened the original target');
   const before=await invokeGetTerminalSubmissionRecovery(prior.original.invocation.agentSessionId);
   const durable=!['prepare','input-complete'].includes(prior.cut);
   assert(before.length===(durable?1:0)&&(!durable||before[0].noAutoReplay&&before[0].identity.commandId===prior.identity.commandId),'Restart lost or invented the actual durable original identity');
   const attempts:Record<string,unknown>[]=[];
   const retry=async(label:string,call:()=>Promise<unknown>)=>{try{attempts.push({label,accepted:true,value:await call()});}catch(error){attempts.push({label,accepted:false,error:String(error)});}};
   await retry('same-invocation',()=>invokeRunTerminalAcceptanceCommand(prior.original.invocation.agentSessionId,prior.original.invocation.callId,prior.original.invocation.sourceKind));
   await retry('same-approval',()=>invokeDecideTerminalAcceptanceCommand(prior.original.approval,true));
   const recoveryCheckpoint=await invokeInspectAgentRuntimeRecovery({sessionId:prior.original.invocation.agentSessionId});
   assert(recoveryCheckpoint.kind==='executionInFlight'&&recoveryCheckpoint.status==='required'&&recoveryCheckpoint.callId===prior.original.invocation.callId,'Actual runtime did not retain its uncertain execution checkpoint');
   await retry('production-resume',()=>invokeResumeAgentRuntimeRecovery({sessionId:prior.original.invocation.agentSessionId}));
   const resumed=attempts.find(attempt=>attempt.label==='production-resume');
   assert(resumed?.accepted===false&&String(resumed.error).includes('this recovery boundary requires reconciliation or abort'),'The production resume path did not enforce recovery');
   const recoveryCheckpointAfter=await invokeInspectAgentRuntimeRecovery({sessionId:prior.original.invocation.agentSessionId});
   assert(JSON.stringify(recoveryCheckpointAfter)===JSON.stringify(recoveryCheckpoint),'Rejected production resume changed the original recovery facts');
   const after=await invokeGetTerminalSubmissionRecovery(prior.original.invocation.agentSessionId),effect=await witness(),fresh=await snapshot();
   assert(attempts.every(attempt=>attempt.accepted===false)&&JSON.stringify(before)===JSON.stringify(after)&&effect.exists===prior.afterCrashEffect.exists&&effect.text===prior.afterCrashEffect.text&&effect.sha256===prior.afterCrashEffect.sha256,'Restart replayed or altered the original uncertain operation');
   assert(fresh.session?.nextInputSequence===initial.session?.nextInputSequence,'Original replay attempt wrote to the fresh terminal');
   await capture.checkpoint('submission-crash-restart-ready',{session,prior,before,after,attempts,fresh});
   await invokeCloseSession(session.sessionId);closed=true;const retained=await capture.finish();
   const response=await fetch('/__agent-stream-result/'+token,{method:'POST',body:JSON.stringify({ok:true,evidence:{kind:'actual-macos-intent-crash-restart',scenario:cutConfiguration.scenario,session,prior,initial,fresh,originalSession,originalTarget,before,after,attempts,recoveryCheckpoint,recoveryCheckpointAfter,effect,retained,routes,humanReceipt:false,physicalInputClaim:false,phase3Complete:false}})});assert(response.ok,'Actual restart evidence was not retained');return;
  }
  await capture.checkpoint('submission-ready',{session,initial,routes});
  if(permissionMismatch){
   const invocation=await run('effect',true);
   assert(invocation.prepared.settlement==='Waiting','Actual permission case did not require approval');
   const approval=pendingApproval(invocation.before,invocation.callId);
   const outcome=await invokeDecideTerminalAcceptanceCommand(approval,true).then(
    value=>({value}),error=>({error:String(error)}));
   const after=await events(invocation.id),broker=await snapshot(),effect=await witness(),recovery=await invokeGetTerminalSubmissionRecovery(invocation.id);
   const evidence={invocation,approval,outcome,after,broker,effect,recovery};records.push(evidence);
   const failed=after.find(event=>event.type==='tool/result'&&event.data.callId===invocation.callId&&event.data.status==='failed');
   assert(failed||'error' in outcome,'Production did not refuse the changed permission');
   assert(!after.some(event=>event.type==='tool/result'&&event.data.callId===invocation.callId&&event.data.status==='completed')
    &&!effect.exists&&recovery.length===0&&initial.session?.nextInputSequence===broker.session?.nextInputSequence,
   'Changed permission reached an actual terminal write or intent');
   await invokeCancelAgentRuntime({sessionId:invocation.id});await invokeCloseSession(session.sessionId);closed=true;
   const retained=await capture.finish();
   const response=await fetch('/__agent-stream-result/'+token,{method:'POST',body:JSON.stringify({
    ok:true,evidence:{kind:'actual-macos-permission-mismatch',scenario:observationConfiguration.scenario,session,initial,
     observed:evidence,retained,routes,humanReceipt:false,phase3Complete:false},
   })});
   assert(response.ok,'Actual permission refusal was not retained');
   return;
  }
  if (transportLoss) {
   const invocation = await run('transport-read', true);
   assert(invocation.prepared.settlement === 'Waiting', 'Actual local transport case did not reach approval');
   const approval = pendingApproval(invocation.before, invocation.callId);
   const observation: Record<string, unknown> = { invocation, approval };
   records.push(observation);
   const decision = invokeDecideTerminalAcceptanceCommand(approval, true).then(
    value => ({ value }),
    error => ({ error: String(error) }),
   );
   let cut: Cut | undefined;
   await until(async () => {
    const observed = (await cutState()).cut;
    if (!observed) return false;
    cut = observed;
    return true;
   }, 'Actual accept receipt was not held before local transport loss');
   assert(cut?.cut === 'accept-receipt' && cut.identity.agentSessionId === invocation.id, 'Actual transport cut identity differs');
   const originalCut = cut;
   type TransportFault = {requested:{nonce:string;transportSessionId:string;originalIdentity:Cut['identity'];worker:{pid:number;parentPid:number}};
    signaled:{nonce:string;pid:number;signal:string;syscallAccepted:boolean}};
   let fault: TransportFault | undefined;
   await until(async () => {
    const response = await fetch('/__native-mac-submission-transport-loss/'+token);
    assert(response.ok, 'Actual transport fault observation failed');
    const value = await response.json() as {observation?:TransportFault;authority:string};
    assert(value.authority === 'process-observation-only', 'Process observation granted acceptance authority');
    fault = value.observation;
    return !!fault;
   }, 'Owned original Shell termination was not observed');
   assert(fault?.requested.nonce === originalCut.nonce && fault.requested.transportSessionId === session.sessionId
    && fault.requested.worker.parentPid === originalCut.pid && fault.signaled.pid === fault.requested.worker.pid
    && fault.signaled.nonce === originalCut.nonce && fault.signaled.signal === 'SIGKILL' && fault.signaled.syscallAccepted
    && JSON.stringify(fault.requested.originalIdentity) === JSON.stringify(originalCut.identity), 'Actual fault belongs to another process or command');
   Object.assign(observation, { originalCut, fault });
   const release = await fetch(cutRoute(), {method:'POST',body:JSON.stringify({nonce:originalCut.nonce,pid:originalCut.pid})});
   assert(release.ok, 'Actual accept observation could not release for transport cleanup');
   await until(async () => (await snapshot()).session?.open === false, 'Original PTY remained open after actual Shell termination');
   closed = true;
   const terminalClosed = await snapshot();
   const decisionOutcome = await decision;
   const pending = await invokeGetTerminalSubmissionRecovery(invocation.id);
   const runtimeRecovery = await invokeInspectAgentRuntimeRecovery({sessionId:invocation.id});
   const effect = await witness();
   assert(terminalClosed.session?.closeReason === 'remoteExit' && terminalClosed.session.terminalSessionId === session.terminalSessionId,
    'The observed closure was not the original local Shell loss');
   assert(pending.length === 1 && pending[0].identity.commandId === originalCut.identity.commandId && pending[0].noAutoReplay,
    'Local transport loss discarded or settled the original unknown intent');
   const attempts: {label:string;error?:string}[] = [];
   for (const [label,attempt] of [
    ['same-invocation',()=>invokeRunTerminalAcceptanceCommand(invocation.id,invocation.callId,'transport-read')],
    ['resume-recovery',()=>invokeResumeAgentRuntimeRecovery({sessionId:invocation.id})],
   ] as const) {
    try {
     await attempt();
     attempts.push({label});
    } catch (error) {
     attempts.push({label,error:String(error)});
    }
   }
   const enter = await controller.writeUserInput('\r');
   capture.recordInput('\r',enter,'Enter after actual local transport loss');
   const after = await invokeGetTerminalSubmissionRecovery(invocation.id), effectAfter = await witness();
   Object.assign(observation,{terminalClosed,decisionOutcome,pending,runtimeRecovery,effect,attempts,enter,after,effectAfter,events:await events(invocation.id)});
   assert(attempts.every(attempt=>attempt.error) && !enter && JSON.stringify(after) === JSON.stringify(pending)
    && effectAfter.sha256 === effect.sha256 && (effect.text === null || effect.text === invocation.callId+'\n'),
   'Actual transport loss allowed replay or returned editing');
   const retained = await capture.finish();
   const response = await fetch('/__agent-stream-result/'+token, {method:'POST',body:JSON.stringify({
    ok:true,evidence:{kind:'actual-macos-local-transport-loss',scenario:observationConfiguration.scenario,session,initial,
     observation,retained,routes,humanReceipt:false,phase3Complete:false},
   })});
   assert(response.ok, 'Actual local transport loss evidence was not retained');
   return;
  }
  if (bindingNegative) {
   const invocation = await run('effect', true);
   assert(invocation.prepared.settlement === 'Waiting', 'Immutable binding case did not reach actual approval');
   const approval = pendingApproval(invocation.before, invocation.callId);
   const observed: Record<string, unknown> = { invocation, approval };
   records.push(observed);
   const outcome = await invokeDecideTerminalAcceptanceCommand(approval, true).then(
    value => ({ value }),
    error => ({ error: String(error) }),
   );
   const after = await events(invocation.id);
   const result = after.find((event): event is Extract<AgentSessionEvent, {type:'tool/result'}> =>
    event.type === 'tool/result' && event.data.callId === invocation.callId);
   const broker = await snapshot(), recovery = await invokeGetTerminalSubmissionRecovery(invocation.id), effect = await witness();
   Object.assign(observed, { outcome, after, result, broker, recovery, effect });
   const details = result?.data.data;
   assert(after.some(event => event.type === 'tool/execution' && event.data.callId === invocation.callId),
    'The approval did not reach the actual production native execution path');
   assert(result && result.data.status !== 'completed' && details && typeof details === 'object'
    && !Array.isArray(details) && 'execution' in details && details.execution === 'notStarted',
   'Native binding rejection did not establish refusal before submission');
   assert(recovery.length === 0 && !effect.exists && !broker.session?.inputObservation?.activeCommand?.mayHaveSubmitted,
    'Native binding mismatch left a possible submission, durable intent, or effect');
   if(nativeUnsupported){
    const cancellation=await invokeCancelAgentRuntime({sessionId:invocation.id}).then(
     value=>({value}),error=>({error:String(error)}));
    const beforeEnter=await snapshot();
    Object.assign(observed,{cancellation,beforeEnter});
    const input=await controller.writeUserInput('\r').then(
     accepted=>({accepted,error:undefined}),error=>({accepted:false,error:String(error)}));
    assert(input.error===undefined||input.error.includes('TERMINAL_INPUT_RECOVERY_REQUIRED'),'Unexpected actual input failure: '+input.error);
    const afterEnter=await snapshot();
    capture.recordInput('\r',input.accepted,'Enter after native refusal and actual cancellation request');
    const afterEffect=await witness(),afterRecovery=await invokeGetTerminalSubmissionRecovery(invocation.id);
    Object.assign(observed,{enter:input.accepted,enterError:input.error,afterEnter,afterEffect,afterRecovery});
    assert(!input.accepted&&beforeEnter.session?.nextInputSequence===afterEnter.session?.nextInputSequence
     &&!afterEffect.exists&&afterRecovery.length===0,'Native refusal did not keep the original editor protected');
   }
   await invokeCloseSession(session.sessionId);
   closed = true;
   const retained = await capture.finish();
   const response = await fetch('/__agent-stream-result/'+token, { method: 'POST', body: JSON.stringify({
    ok: true, evidence: { kind: 'actual-macos-bound-command-refusal', scenario: observationConfiguration.scenario, session,
     initial, observed, retained, routes, humanReceipt: false, phase3Complete: false },
   }) });
   assert(response.ok, 'Actual immutable binding evidence was not retained');
   return;
  }
  if (cutConfiguration.scenario === 'timeout-unknown-accept' || cutConfiguration.scenario === 'control-eof'
   || cutConfiguration.scenario === 'late-started-and-matched-settled') {
   const eof = cutConfiguration.scenario === 'control-eof';
   const invocation = await run('effect', true);
   assert(invocation.prepared.settlement === 'Waiting', 'Actual fault command did not require approval');
   const approval = pendingApproval(invocation.before, invocation.callId);
   const observation: Record<string, unknown> = { invocation, approval };
   records.push(observation);
   const approvalStartedAt = performance.now();
   const decision = invokeDecideTerminalAcceptanceCommand(approval, true).then(
    value => ({ value, at: performance.now() }),
    error => ({ error: String(error), at: performance.now() }),
   );
   async function waitForReceipt(settlement: boolean) {
    let held: Cut | null = null;
    await until(async () => {
     held = (await cutState(settlement)).cut;
     return held !== null;
    }, 'The actual native receipt was not held');
    return held as Cut | null;
   }
   async function releaseReceipt(receipt: Cut, settlement: boolean) {
    const response = await fetch(cutRoute(settlement), { method: 'POST', body: JSON.stringify({ nonce: receipt.nonce, pid: receipt.pid }) });
    assert(response.ok, 'The owned actual receipt could not be released');
   }
   const cut = await waitForReceipt(false);
   assert(cut?.cut === 'accept-receipt' && cut.identity.agentSessionId === invocation.id, 'Held receipt belongs to another invocation');
   Object.assign(observation, { cut, approvalStartedAt, brokerAtCut: await snapshot() });
   if (eof) {
    await releaseReceipt(cut, false);
    await until(async () => (await snapshot()).session?.integrationState === 'unavailable', 'Actual control EOF was not observed on the original terminal');
   }
   const decisionOutcome = await decision;
   const unknown = await snapshot();
   const command = unknown.session?.inputObservation?.activeCommand;
   const pending = await invokeGetTerminalSubmissionRecovery(invocation.id);
   const actualEffect = await witness();
   const runtimeRecovery = await invokeInspectAgentRuntimeRecovery({ sessionId: invocation.id });
   let resumeRefusal: string | undefined;
   try {
    await invokeResumeAgentRuntimeRecovery({ sessionId: invocation.id });
   } catch (error) {
    resumeRefusal = String(error);
   }
   const recoveryAfterResume = await invokeInspectAgentRuntimeRecovery({ sessionId: invocation.id });
   Object.assign(observation, { decisionOutcome, unknown, pending, actualEffect, runtimeRecovery, resumeRefusal, recoveryAfterResume, afterTimeout: await events(invocation.id) });
   if (eof) {
    assert(decisionOutcome.at - approvalStartedAt < 10000 && unknown.session?.open
     && unknown.session.integrationState === 'unavailable' && unknown.session.inputObservation?.nativeRecoveryRequired,
    'The original PTY or its control-EOF recovery gate was not retained');
   } else {
    assert(decisionOutcome.at - approvalStartedAt >= 5000, 'The actual production deadline did not elapse');
   }
   assert(command?.phase === 'uncertain' && command.mayHaveSubmitted && command.noAutoReplay
    && command.executionEvidence === 'unknown' && command.commandId === cut.identity.commandId, 'The original operation did not retain unknown acceptance and capture');
   assert(pending.length === 1 && pending[0].identity.commandId === command.commandId && pending[0].noAutoReplay, 'The exact intent was unavailable during unknown acceptance');
   assert(runtimeRecovery.kind === 'executionInFlight' && runtimeRecovery.status === 'required'
    && runtimeRecovery.callId === invocation.callId && resumeRefusal?.includes('this recovery boundary requires reconciliation or abort')
    && JSON.stringify(recoveryAfterResume) === JSON.stringify(runtimeRecovery), 'Production recovery resumed or rewrote the unresolved operation');
   const enter = await controller.writeUserInput('\r');
   capture.recordInput('\r', enter, 'Enter while actual acceptance remains unknown');
   let repeatError: string | undefined;
   try {
    await invokeRunTerminalAcceptanceCommand(invocation.id, invocation.callId, 'effect');
   } catch (error) {
    repeatError = String(error);
   }
   const afterRepeat = await invokeGetTerminalSubmissionRecovery(invocation.id);
   Object.assign(observation, { enter, repeatError, afterRepeat, effectAfterRepeat: await witness() });
   assert(!enter && repeatError && JSON.stringify(afterRepeat) === JSON.stringify(pending), 'Unknown acceptance opened editing or permitted replay');
   assert((actualEffect.text === invocation.callId + '\n' || (eof && actualEffect.text === null))
    && (await witness()).sha256 === actualEffect.sha256, 'Repeated request changed the actual effect');
   if (eof) {
    await invokeCloseSession(session.sessionId);
    closed = true;
    const retained = await capture.finish();
    const response = await fetch('/__agent-stream-result/'+token, { method: 'POST', body: JSON.stringify({
     ok: true, evidence: { kind: 'actual-macos-control-eof', scenario: cutConfiguration.scenario, session,
      initial, observation, retained, routes, humanReceipt: false, phase3Complete: false },
    }) });
    assert(response.ok, 'Actual control EOF evidence was not retained');
    return;
   }
   await releaseReceipt(cut, false);
   const settlementCut = await waitForReceipt(true);
   assert(settlementCut?.cut === 'settled-receipt' && settlementCut.pid === cut.pid
    && JSON.stringify(settlementCut.identity) === JSON.stringify(cut.identity), 'The original settlement does not match the held acceptance identity');
   const lateStarted = await snapshot();
   const started = lateStarted.session?.inputObservation?.activeCommand;
   const pendingAfterStarted = await invokeGetTerminalSubmissionRecovery(invocation.id);
   const lateEnter = await controller.writeUserInput('\r');
   capture.recordInput('\r', lateEnter, 'Enter after late Started and before matching Settled');
   Object.assign(observation, { settlementCut, lateStarted, pendingAfterStarted, lateEnter });
   assert(started?.phase === 'uncertain' && started.commandId === command.commandId
    && started.executionEvidence === 'startObserved' && started.noAutoReplay && !lateEnter
    && JSON.stringify(pendingAfterStarted) === JSON.stringify(pending), 'Late Started changed recovery or editing before matching Settled');
   await releaseReceipt(settlementCut, true);
   await until(async () => (await invokeGetTerminalSubmissionRecovery(invocation.id)).length === 0, 'Matching native settlement did not close the original durable intent');
   const final = await snapshot();
   const settledEffect = await witness();
   assert(settledEffect.sha256 === actualEffect.sha256, 'Late native receipts caused another effect');
   Object.assign(observation, { final, settledEffect, settledRecovery: await invokeGetTerminalSubmissionRecovery(invocation.id) });
   await invokeCloseSession(session.sessionId);
   closed = true;
   const retained = await capture.finish();
   const response = await fetch('/__agent-stream-result/'+token, { method: 'POST', body: JSON.stringify({
    ok: true, evidence: { kind: 'actual-macos-unknown-accept-timeout', scenario: cutConfiguration.scenario, session,
     initial, observation, retained, routes, humanReceipt: false, phase3Complete: false },
   }) });
   assert(response.ok, 'Actual acceptance timeout evidence was not retained');
   return;
  }
  if(cutConfiguration.scenario?.startsWith('app-crash-')){
   const sourceKind=cutConfiguration.scenario==='app-crash-key'?'running':'effect';
   const prepared=await run(sourceKind,true);assert(prepared.prepared.settlement==='Waiting','Actual crash invocation did not request approval');
   const approval=pendingApproval(prepared.before,prepared.callId);
   const ready=await fetch('/__agent-stream-result/'+token,{method:'POST',body:JSON.stringify({progress:'Original App approval captured before the intentional isolated crash',evidence:{kind:'actual-macos-crash-approval-armed',approval,invocation:{agentSessionId:prepared.id,callId:prepared.callId,sourceKind},scenario:cutConfiguration.scenario,prepared,session,routes,humanReceipt:false}})});
   assert(ready.ok,'Original crash invocation was not retained');
   await invokeDecideTerminalAcceptanceCommand(approval,true);
   throw Error('The App returned from the real intent cut without the expected external SIGKILL');
  }
  if (cutConfiguration.scenario === 'expired-or-revoked') {
   async function checkRefusal(reason: 'expired' | 'revoked') {
    const invocation = await run('effect', true);
    assert(invocation.prepared.settlement === 'Waiting', 'The actual request did not reach approval');
    const approval = pendingApproval(invocation.before, invocation.callId);
    const requested = invocation.before.find(event =>
     event.type === 'tool/approval' && event.data.approvalId === approval.approvalId && event.data.status === 'requested');
    assert(requested?.type === 'tool/approval', 'Original approval event missing');
    const expires = requested.data.expiresAtUnixMs;
    assert(typeof expires === 'number' && Number.isSafeInteger(expires), 'Original approval deadline missing');
    let interruption: Awaited<ReturnType<typeof invokeInterruptAgentRuntime>> | undefined;
    if (reason === 'expired') {
     const remaining = expires - Date.now();
     assert(remaining > 0 && remaining <= 65_000, 'Unexpected production approval deadline');
     while (Date.now() <= expires) {
      await new Promise(done => setTimeout(done, Math.min(1000, expires - Date.now() + 30)));
     }
    } else {
     interruption = await invokeInterruptAgentRuntime({sessionId: invocation.id});
    }
    const attemptedAt = Date.now();
    let refusal: string | undefined;
    try {
     await invokeApproveAgentRuntimeTool(approval);
    } catch (error) {
     refusal = String(error);
    }
    const after = await events(invocation.id);
    const recovery = await invokeGetTerminalSubmissionRecovery(invocation.id);
    const broker = await snapshot();
    const effect = await witness();
    records.push({reason, invocation, approval, requested, attemptedAt, interruption, refusal, after, recovery, broker, effect});
    assert(refusal, 'Production accepted an expired or revoked approval');
    assert(after.some(event => event.type === 'tool/approval' && event.data.approvalId === approval.approvalId
     && event.data.status === (reason === 'expired' ? 'expired' : 'cancelled')), 'Production did not record the expected approval disposition');
    assert(!after.some(event => event.type === 'tool/execution') && recovery.length === 0 && !effect.exists,
     'Expired or revoked approval reached execution');
    assert(broker.session?.nextInputSequence === initial.session?.nextInputSequence, 'Refused approval wrote terminal input');
    await invokeCancelAgentRuntime({sessionId: invocation.id});
   }
   await checkRefusal('expired');
   await checkRefusal('revoked');
   await invokeCloseSession(session.sessionId);
   closed = true;
   const retained = await capture.finish();
   const response = await fetch('/__agent-stream-result/'+token, {method: 'POST', body: JSON.stringify({
    ok: true, evidence: {kind: 'actual-macos-expired-or-revoked', scenario: cutConfiguration.scenario, session,
     initial, records, retained, routes, humanReceipt: false, phase3Complete: false},
   })});
   assert(response.ok, 'Approval refusal evidence was not retained');
   return;
  }
  if(cutConfiguration.scenario==='approval-mismatch'){
   const first=await run('effect',true),other=await run('effect',true);
   assert(first.prepared.settlement==='Waiting'&&other.prepared.settlement==='Waiting','Two independent actual approvals must be pending');
   const firstApproval=pendingApproval(first.before,first.callId),otherApproval=pendingApproval(other.before,other.callId);
   assert(firstApproval.approvalId!==otherApproval.approvalId&&first.id!==other.id,'Actual approval and owner identities were not distinct');
   const refusals:Record<string,unknown>[]=[];
   const attempt=async(label:string,input:typeof firstApproval,expected:string)=>{
    let error:string|undefined;
    try{await invokeDecideTerminalAcceptanceCommand(input,true);}catch(failure){error=String(failure);}
    refusals.push({label,input,error,broker:await snapshot(),effect:await witness(),recovery:await invokeGetTerminalSubmissionRecovery(input.sessionId)});
    assert(error?.includes(expected),'Actual approval did not return the intended refusal: '+label);
   };
   await attempt('foreign-approval',{...firstApproval,approvalId:otherApproval.approvalId},'Approval identity or state is stale');
   assert(pendingApproval(await events(first.id),first.callId).approvalId===firstApproval.approvalId,'Wrong approval altered the original pending request');
   const realRejection=await invokeDecideTerminalAcceptanceCommand(firstApproval,false);
   await attempt('consumed-approval',firstApproval,'Approval is unknown, terminal, or was recovered as uncertain');
   const otherStillPending=pendingApproval(await events(other.id),other.callId);
   assert(otherStillPending.approvalId===otherApproval.approvalId,'Wrong decision changed the other live approval');
   const otherRejection=await invokeDecideTerminalAcceptanceCommand(otherApproval,false);
   const final=await snapshot(),effect=await witness(),firstEvents=await events(first.id),otherEvents=await events(other.id);
   assert(initial.session?.nextInputSequence===final.session?.nextInputSequence&&!effect.exists,'Invalid approval caused a terminal write or command effect');
   assert([...firstEvents,...otherEvents].every(event=>event.type!=='tool/execution'&&!(event.type==='tool/approval'&&event.data.status==='approved')),'Invalid approval started or approved an invocation');
   await invokeCancelAgentRuntime({sessionId:first.id});await invokeCancelAgentRuntime({sessionId:other.id});await invokeCloseSession(session.sessionId);closed=true;
   const retained=await capture.finish();
   const response=await fetch('/__agent-stream-result/'+token,{method:'POST',body:JSON.stringify({ok:true,evidence:{kind:'actual-macos-approval-mismatch',scenario:cutConfiguration.scenario,family,session,initial,final,effect,first,other,firstApproval,otherApproval,otherStillPending,firstEvents,otherEvents,realRejection,otherRejection,refusals,retained,routes,humanReceipt:false,physicalInputClaim:false,phase3Complete:false}})});assert(response.ok,'Actual approval-mismatch evidence was not retained');return;
  }
  if(cutConfiguration.scenario==='runtime-multi-agent'||cutConfiguration.scenario==='close-running-terminal'||cutConfiguration.scenario==='target-mismatch'||cutConfiguration.scenario==='delegation'){
   const scenario=cutConfiguration.scenario;
   const observerWire=await macWireCapture();secondWire=observerWire;
   const second=await invokeCreateLocalSession(100,30);
   assert(second.terminalSessionId&&second.terminalGeneration!==undefined,'Independent terminal identity missing');
   extraTerminals.add(second.sessionId);await observerWire.expect(second.sessionId,{terminalSessionId:second.terminalSessionId,terminalGeneration:second.terminalGeneration});useTerminalStore.getState().addSession(second);
   const secondSnapshot=()=>invokeGetTerminalBrokerSnapshot(second.sessionId);
   await until(async()=>{const state=(await secondSnapshot()).session;return !!state?.promptReady&&isMacFileChainProfile(state.nativePeerProfile,family);},'Actual second independent terminal did not reach its native prompt');
   const finishSecond=async()=>{
    await invokeCloseSession(second.sessionId);extraTerminals.delete(second.sessionId);
    await until(()=>observerWire.isFinalized(second.sessionId),'Actual second terminal worker did not finalize');
    const transport=observerWire.snapshot(second.sessionId,true),broker=await invokeGetTerminalAcceptanceRawOutput(second.sessionId);
    assert(transport.wireDecoded===transport.decoded&&broker.nextByteOffset===transport.byteCount
     &&broker.capturedFrameCount===transport.frameCount&&!broker.captureTruncated&&!broker.open,'Actual second transport and Broker boundaries differ');
    return {transport:observerWire.observations(second.sessionId),broker,wireBytes:transport.byteCount,wireFrames:transport.frameCount};
   };
   if(scenario==='delegation'){
    const parent=await run('effect',true),other=await run('effect',true,second);
    assert(parent.prepared.settlement==='Waiting'&&other.prepared.settlement==='Waiting','Actual parent and independent approval required');
    const parentApproval=pendingApproval(parent.before,parent.callId),otherApproval=pendingApproval(other.before,other.callId);
    const actualOtherBefore=await secondSnapshot(),otherEventsBefore=await events(other.id);
    assert(await invokeGetAgentTerminalOwner(session.sessionId)===parent.id,'Actual parent did not own the turn');
    const spawn={parentSessionId:parent.id,goal:'Run the explicit isolated child acceptance command without a model.',
     role:'operator' as const,inheritanceMode:'blank' as const,targetIds:['terminal-'+session.sessionId],continuable:false,
     budget:{maxTurns:1,timeoutMs:90000}};
    const child=await invokeSpawnAgentRuntimeSubagent(spawn),childId=child.header.sessionId,metadata=child.header.subagent;
    assert(metadata&&child.header.parentSessionId===parent.id&&metadata.parentTaskId===parent.created.header.taskId
     &&metadata.role==='operator'&&!metadata.provider&&!child.header.modelSelection
     &&child.header.target?.sessionId===session.sessionId&&child.header.permissionMode==='requestApproval',
    'Actual runtime delegation lost its parent, scope, permission, or no-model binding');
    const childCallId=crypto.randomUUID(),childPrepared=await invokeRunTerminalAcceptanceCommand(childId,childCallId,'running');
    assert(childPrepared.settlement==='Waiting'&&childPrepared.modelAvailability==='MODEL_SELECTION_REQUIRED','Actual child command did not require approval');
    const childBefore=await events(childId),childApproval=pendingApproval(childBefore,childCallId);
    const childDecision=invokeDecideTerminalAcceptanceCommand(childApproval,true).then(
     value=>({value}),error=>({error:String(error)}));
    await until(async()=>{
     const active=(await snapshot()).session?.inputObservation?.activeCommand;
     return active?.agentSessionId===childId&&active.taskId===child.header.taskId&&active.phase==='running'
      &&active.executionEvidence==='startObserved'&&(await witness()).text===childCallId+'\n';
    },'Actual delegated child did not acquire a running command');
    const childRunning=await snapshot(),turnOwner=await invokeGetAgentTerminalOwner(session.sessionId);
    const competing=await invokeDecideTerminalAcceptanceCommand(parentApproval,true).then(
     value=>({value}),error=>({error:String(error)}));
    const parentEvents=await events(parent.id),childAfterContention=await snapshot();
    assert(turnOwner===parent.id&&childAfterContention.session?.inputObservation?.activeCommand?.agentSessionId===childId,
     'Competing parent access displaced the actual delegated operation');
    assert(!parentEvents.some(event=>event.type==='tool/result'&&event.data.callId===parent.callId&&event.data.status==='completed')
     &&(await witness()).text===childCallId+'\n','Competing parent executed during the delegated command');
    const cancelledChild=await invokeCancelAgentRuntimeChild({parentSessionId:parent.id,childSessionId:childId});
    const childDecisionOutcome=await childDecision,childAfter=await events(childId);
    const afterChild=await snapshot(),ownerAfterChild=await invokeGetAgentTerminalOwner(session.sessionId);
    const actualOtherAfter=await secondSnapshot(),otherEventsAfter=await events(other.id),effect=await witness();
    const recovery=await invokeGetTerminalSubmissionRecovery(childId);
    const observed={scenario,session,second,parent,other,parentApproval,otherApproval,actualOtherBefore,actualOtherAfter,
     otherEventsBefore,otherEventsAfter,spawn,child,childCallId,childPrepared,childBefore,childApproval,childRunning,
     turnOwner,competing,parentEvents,childAfterContention,cancelledChild,childDecisionOutcome,childAfter,afterChild,ownerAfterChild,effect,recovery};
    records.push(observed);
    assert(cancelledChild.ended&&ownerAfterChild===parent.id&&!afterChild.session?.inputObservation?.activeCommand,
     'Real child cancellation did not restore the parent turn without the old child lease');
    assert(JSON.stringify(otherEventsBefore)===JSON.stringify(otherEventsAfter)
     &&actualOtherBefore.session?.nextInputSequence===actualOtherAfter.session?.nextInputSequence
     &&actualOtherBefore.session?.terminalGeneration===actualOtherAfter.session?.terminalGeneration
     &&pendingApproval(otherEventsAfter,other.callId).approvalId===otherApproval.approvalId,
    'Delegation changed the unrelated terminal, task, or approval');
    assert(effect.text===childCallId+'\n'&&recovery.length===0,'Delegated source repeated or lost its actual settlement');
    await invokeDecideTerminalAcceptanceCommand(otherApproval,false);
    await invokeCancelAgentRuntime({sessionId:parent.id});await invokeCancelAgentRuntime({sessionId:other.id});
    await invokeCloseSession(session.sessionId);closed=true;
    const otherOutput=await finishSecond(),retained=await capture.finish();
    terminalRegistry.dispose(second.sessionId);
    const response=await fetch('/__agent-stream-result/'+token,{method:'POST',body:JSON.stringify({
     ok:true,evidence:{kind:'actual-macos-delegation',...observed,otherOutput,retained,routes,humanReceipt:false,phase3Complete:false},
    })});
    assert(response.ok,'Actual delegated runtime evidence was not retained');
    return;
   }
   if(scenario==='target-mismatch'){
    const original=await run('effect',true),other=await run('effect',true,second);
    assert(original.prepared.settlement==='Waiting'&&other.prepared.settlement==='Waiting','Both actual target approvals must be pending');
    const originalApproval=pendingApproval(original.before,original.callId),otherApproval=pendingApproval(other.before,other.callId);
    const before=await snapshot(),otherBefore=await secondSnapshot();
    const reconnect={sessionId:original.id,previousSessionId:session.sessionId,terminalSessionId:second.sessionId};
    const wrongApproval={...originalApproval,sessionId:other.id};
    const attempts:{label:string;error?:string}[]=[];
    async function attempt(label:string, action:()=>Promise<unknown>){
     try{await action();attempts.push({label});}catch(error){attempts.push({label,error:String(error)});}
    }
    await attempt('rebind-active-approval',()=>invokeReconnectAgentTerminal(reconnect));
    await attempt('approve-on-other-bound-target',()=>invokeDecideTerminalAcceptanceCommand(wrongApproval,true));
    const actualOwner=await invokeGetAgentRuntimeSession({sessionId:original.id}),actualOther=await invokeGetAgentRuntimeSession({sessionId:other.id});
    const ownerEvents=await events(original.id),otherEvents=await events(other.id);
    const after=await snapshot(),otherAfter=await secondSnapshot(),effect=await witness();
    const recoveries=[await invokeGetTerminalSubmissionRecovery(original.id),await invokeGetTerminalSubmissionRecovery(other.id)];
    const observed={scenario,session,second,original,other,originalApproval,otherApproval,reconnect,wrongApproval,attempts,before,otherBefore,
     actualOwner,actualOther,ownerEvents,otherEvents,after,otherAfter,effect,recoveries};
    records.push(observed);
    assert(attempts.every(item=>item.error),'Production allowed the pending invocation to move or approve against another target');
    assert(actualOwner.header.target?.sessionId===session.sessionId&&actualOther.header.target?.sessionId===second.sessionId,
     'A real frozen target changed');
    assert(pendingApproval(ownerEvents,original.callId).approvalId===originalApproval.approvalId
     &&pendingApproval(otherEvents,other.callId).approvalId===otherApproval.approvalId,'A rejected target change consumed an approval');
    assert(![...ownerEvents,...otherEvents].some(event=>event.type==='tool/execution')
     &&before.session?.nextInputSequence===after.session?.nextInputSequence
     &&otherBefore.session?.nextInputSequence===otherAfter.session?.nextInputSequence
     &&!effect.exists&&recoveries.every(items=>items.length===0),'Wrong frozen target reached actual input, intent or execution');
    await invokeDecideTerminalAcceptanceCommand(originalApproval,false);
    await invokeDecideTerminalAcceptanceCommand(otherApproval,false);
    await invokeCancelAgentRuntime({sessionId:original.id});
    await invokeCancelAgentRuntime({sessionId:other.id});
    await invokeCloseSession(session.sessionId);closed=true;
    const otherOutput=await finishSecond(),retained=await capture.finish();
    terminalRegistry.dispose(second.sessionId);
    const response=await fetch('/__agent-stream-result/'+token,{method:'POST',body:JSON.stringify({
     ok:true,evidence:{kind:'actual-macos-target-mismatch',...observed,otherOutput,retained,routes,humanReceipt:false,phase3Complete:false},
    })});
    assert(response.ok,'Actual frozen target refusal was not retained');
    return;
   }
   const owner=await run('running',true),contender=await run('effect',true),observer=await run('effect',true,second);
   assert([owner,contender,observer].every(item=>item.prepared.settlement==='Waiting'),'Three actual runtime approvals must be pending before contention');
   const ownerApproval=pendingApproval(owner.before,owner.callId),contenderApproval=pendingApproval(contender.before,contender.callId),observerApproval=pendingApproval(observer.before,observer.callId);
   const originalDecision=invokeDecideTerminalAcceptanceCommand(ownerApproval,true);void originalDecision.catch(()=>{});
   await until(async()=>{const command=(await snapshot()).session?.inputObservation?.activeCommand;return command?.agentSessionId===owner.id&&command.phase==='running'&&command.executionEvidence==='startObserved'&&(await witness()).text===owner.callId+'\n';},'Actual owner never reached running before contention');
   const ownerBefore=await snapshot(),observerBefore=await secondSnapshot(),observerEventsBefore=await events(observer.id);
   const original=ownerBefore.session?.inputObservation?.activeCommand;assert(original?.agentSessionId===owner.id,'Actual running owner identity missing');
   let contenderDecision:Record<string,unknown>|undefined;
   void invokeDecideTerminalAcceptanceCommand(contenderApproval,true).then(value=>{contenderDecision={value};},error=>{contenderDecision={error:String(error)};});
   await until(()=>!!contenderDecision,'Competing actual approval did not return during the original run');
   const contenderEvents=await events(contender.id),ownerAfter=await snapshot(),observerAfterAttempt=await secondSnapshot();
   assert(ownerAfter.session?.inputObservation?.activeCommand?.commandId===original.commandId&&ownerAfter.session.inputObservation.activeCommand.phase==='running','Competing access displaced the running owner');
   assert(!contenderEvents.some(event=>event.type==='tool/result'&&event.data.callId===contender.callId&&event.data.status==='completed')&&(await witness()).text===owner.callId+'\n','Competing request executed or changed the original effect');
   let ownerControl:unknown;
   if(scenario==='close-running-terminal'){
    await invokeCloseSession(session.sessionId);closed=true;ownerControl={closeAcknowledged:true};
   }else ownerControl=await invokeInterruptAgentRuntime({sessionId:owner.id});
   const ownerDecision=await Promise.allSettled([originalDecision]),ownerFinal=await snapshot(),ownerRecovery=await invokeGetTerminalSubmissionRecovery(owner.id),observerFinal=await secondSnapshot(),observerEventsFinal=await events(observer.id),effect=await witness();
   assert(effect.text===owner.callId+'\n','Owner control or close changed the observed effect count');
   assert(observerBefore.session?.terminalGeneration===observerFinal.session?.terminalGeneration&&observerBefore.session?.nextInputSequence===observerFinal.session?.nextInputSequence&&JSON.stringify(observerEventsBefore)===JSON.stringify(observerEventsFinal),'Unrelated terminal or task changed during contention');
   assert(pendingApproval(observerEventsFinal,observer.callId).approvalId===observerApproval.approvalId,'Unrelated actual approval changed');
   if(scenario==='close-running-terminal')assert(!ownerFinal.session?.open,'Closed owner transport remained open');
   const isolated={scenario,session,second,owner,contender,observer,ownerApproval,contenderApproval,observerApproval,ownerBefore,ownerAfter,ownerControl,ownerDecision,ownerFinal,ownerRecovery,contenderDecision,contenderEvents,observerBefore,observerAfterAttempt,observerFinal,observerEventsBefore,observerEventsFinal,effect};records.push(isolated);
   await invokeDecideTerminalAcceptanceCommand(observerApproval,false);
   await invokeCancelAgentRuntime({sessionId:owner.id});await invokeCancelAgentRuntime({sessionId:contender.id});await invokeCancelAgentRuntime({sessionId:observer.id});
   if(!closed){await invokeCloseSession(session.sessionId);closed=true;}
   const otherOutput=await finishSecond();
   const retained=await capture.finish();terminalRegistry.dispose(second.sessionId);
   const response=await fetch('/__agent-stream-result/'+token,{method:'POST',body:JSON.stringify({ok:true,evidence:{kind:'actual-macos-runtime-isolation',family,...isolated,retained,otherOutput,routes,humanReceipt:false,physicalInputClaim:false,phase3Complete:false}})});assert(response.ok,'Actual runtime isolation evidence was not retained');return;
  }
  if(cutConfiguration.scenario?.startsWith('running-')||cutConfiguration.scenario?.startsWith('after-accept-')){
   const scenario=cutConfiguration.scenario,prepared=await run('running',true);
   const afterAccept = scenario.startsWith('after-accept-');
   assert(prepared.prepared.settlement==='Waiting','Actual running control case did not request approval');
   const approval=pendingApproval(prepared.before,prepared.callId);
   const decision=invokeDecideTerminalAcceptanceCommand(approval,true);void decision.catch(()=>{});
   let acceptedCut:Cut|undefined;
   if(afterAccept){
    await until(async()=>{const observed=(await cutState()).cut;if(!observed)return false;acceptedCut=observed;return true;},'Actual accepted receipt cut did not arrive');
    assert(acceptedCut?.cut==='after-accept'&&acceptedCut.identity.agentSessionId===prepared.id,'Accepted cut does not belong to this invocation');
   }
   let atCut:Awaited<ReturnType<typeof snapshot>>|undefined;
   await until(async()=>{
    const value=await snapshot(),active=value.session?.inputObservation?.activeCommand;
    if(active?.agentSessionId!==prepared.id||!active.mayHaveSubmitted||!active.submissionIntentDurable)return false;
    if(afterAccept){
     if(active.phase!=='submissionAttempted'||active.executionEvidence!=='unknown')return false;
    }else if(active.phase!=='running'||active.executionEvidence!=='startObserved'||(await witness()).text!==prepared.callId+'\n')return false;
    atCut=value;
    return true;
   },'The actual command did not reach its selected execution boundary');
   const active=atCut?.session?.inputObservation?.activeCommand;assert(active,'Actual running command identity missing');
   const recoveryAtCut=await invokeGetTerminalSubmissionRecovery(prepared.id);assert(recoveryAtCut.length===1&&recoveryAtCut[0].identity.commandId===active.commandId&&recoveryAtCut[0].noAutoReplay,'Actual running recovery identity missing');
   const competingEnter=await controller.writeUserInput('\r');capture.recordInput('\r',competingEnter,'Competing Enter while the actual command is running');assert(!competingEnter,'Running command returned editing before settlement');
   const actualUiTakeover=async()=>{const lease=agentTerminalLeaseState.get(session.sessionId);assert(lease?.agentSessionId===prepared.id&&lease.operationId===active.operationId,'Running takeover owner differs');lease.requestTakeover();await until(async()=>!agentTerminalLeaseState.get(session.sessionId)&&(await events(prepared.id)).some(event=>event.type==='turn/end'&&event.turnId===approval.turnId),'Running takeover did not release the original lease and turn');return{origin:'production-terminal-lease-view',leaseViewReleased:true,turnEndObserved:true};};
   const request=scenario.endsWith('-stop')?invokeInterruptAgentRuntime({sessionId:prepared.id}):scenario.endsWith('-cancel')?invokeCancelAgentRuntime({sessionId:prepared.id}):actualUiTakeover();
   void request.catch(()=>{});
   let acceptedControl:ControlRequest|undefined, competingBeforeRelease:boolean|undefined;
   if(acceptedCut){
    const cut=acceptedCut, expectedRequest=scenario.endsWith('-takeover')?'takeover-owner-validated':'cancel-token';
    await until(async()=>{acceptedControl=(await cutState()).requests?.find(value=>value.requestKind===expectedRequest&&value.identity.commandId===cut.identity.commandId);return !!acceptedControl;},'Actual control request did not reach the accepted cut');
    competingBeforeRelease=await controller.writeUserInput('\r');
    capture.recordInput('\r',competingBeforeRelease,'Competing Enter after control request before acceptance-cut release');
    assert(!competingBeforeRelease,'Editing returned before the accepted command could settle');
    const release=await fetch('/__native-mac-submission-cut/'+token,{method:'POST',body:JSON.stringify({nonce:cut.nonce,pid:cut.pid})});
    assert(release.ok,'The original accepted cut was not released');
   }
   const [decisionOutcome,controlOutcome]=await Promise.allSettled([decision,request]);
   const runningRecord={scenario,atCut,recoveryAtCut,competingEnter,decisionOutcome,controlOutcome,acceptedCut,acceptedControl,competingBeforeRelease};records.push(runningRecord);
   assert(controlOutcome.status==='fulfilled','Actual running control did not confirm settlement');
   await until(async()=>!agentTerminalLeaseState.get(session.sessionId)&&!terminalInputReadiness.isPreparing(session.sessionId)&&await idle(),'Actual running control did not return the terminal view');
   const settledEvents=await events(prepared.id),recoveryAfter=await invokeGetTerminalSubmissionRecovery(prepared.id);
   assert(recoveryAfter.length===0,'A settled running command retained an unresolved intention');
   const beforeEnter=await snapshot(),accepted=await controller.writeUserInput('\r');capture.recordInput('\r',accepted,'Enter after actual running control settled');assert(accepted,'Editing was not returned after running control settled');await until(idle,'Post-settlement Enter did not return to a prompt');
   const effect=await witness();
   assert((afterAccept&&!effect.exists)||effect.text===prepared.callId+'\n','Control or later Enter repeated the command effect');
   await invokeCancelAgentRuntime({sessionId:prepared.id});await invokeCloseSession(session.sessionId);closed=true;
   const retained=await capture.finish();
   const response=await fetch('/__agent-stream-result/'+token,{method:'POST',body:JSON.stringify({ok:true,evidence:{kind:'actual-macos-running-control',scenario,family,session,prepared,approval,runningRecord,settledEvents,recoveryAfter,beforeEnter,postEnterAccepted:accepted,effect,retained,routes,humanReceipt:false,physicalInputClaim:false,phase3Complete:false}})});assert(response.ok,'Actual running control evidence was not retained');return;
  }
  const effect=await run(inputInProgress?'paced-input':'effect');
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
  for(const terminal of extraTerminals)try{await invokeCloseSession(terminal);}catch(cleanup){records.push({terminal,closeError:String(cleanup)});}
  await capture.diagnose().catch(diagnostic=>records.push({diagnosticError:String(diagnostic)}));
  await fetch('/__agent-stream-result/'+token,{method:'POST',body:JSON.stringify({ok:false,error:String(problem),evidence:{kind:'actual-macos-submission-preflight-failure',family,session,records,humanReceipt:false,phase3Complete:false}})});
 }finally{capture.stop();secondWire?.stop();stopBinding();root.unmount();terminalRegistry.dispose(session.sessionId);for(const terminal of extraTerminals)terminalRegistry.dispose(terminal);}
}
void verify().catch(error=>{const token=new URL(location.href).searchParams.get('token');void fetch('/__agent-stream-result/'+token,{method:'POST',body:JSON.stringify({ok:false,error:String(error)})});});
