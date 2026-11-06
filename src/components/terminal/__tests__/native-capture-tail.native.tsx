import {createRoot} from 'react-dom/client';
import {getCurrentWindow} from '@tauri-apps/api/window';
import {TerminalControllerLayer} from '../terminal-controller-layer';
import {terminalRegistry} from '../registry/terminal-registry';
import {useTerminalStore} from '@/stores/terminalStore';
import {initI18n} from '@/locales';
import {isCurrentNativeEditorProfile} from './native-editor-profile';
import {nativeFileCoreSetup,readNativeFileLoadedCore} from './native-file-chain-approval';
import {delegationOriginalCall} from './native-approval-delegation-plan';
import {matchesLateReceiptArgs} from './native-late-receipt-plan';
import {nativeCaptureTailPlan,readAcceptanceCommandCapture} from './native-capture-tail-plan';
import {invokeCreateLocalSession,invokeCloseSession,invokeGetTerminalBrokerSnapshot,invokeListAiRoutes,invokeCreateAgentRuntimeSession,invokeAgentRuntimeFollowup,invokeStartAgentRuntime,invokeCancelAgentRuntime,invokeArchiveAgentRuntimeSession,invokeGetAgentRuntimeSession,invokeGetPendingAgentRuntimeApprovalArguments,invokeApproveAgentRuntimeTool,invokeGetTerminalSubmissionRecovery,invokeWriteSession,listenToAgentRuntimeSession,listenToTerminalIntegrationState} from '@/lib/ipc/tauri';
import type {AgentSessionEvent} from '@/types/agent-session';
import type {TerminalIntegrationStateEvent} from '@/types';
import '@/styles/base.css';
function assert(value:unknown,message:string):asserts value{if(!value)throw Error(message);}
function object(value:unknown):Record<string,unknown>{assert(value&&typeof value==='object'&&!Array.isArray(value),'Structured capture observation required');return value as Record<string,unknown>;}
async function until(check:()=>boolean|Promise<boolean>,message:string,timeout=180000){const end=Date.now()+timeout;while(!await check()){assert(Date.now()<end,message);await new Promise(resolve=>setTimeout(resolve,20));}}
const captureOf=(value:unknown)=>readAcceptanceCommandCapture(object(object(value).session).acceptanceCommandCapture);
const text=(bytes:number[])=>new TextDecoder('utf-8',{fatal:true}).decode(new Uint8Array(bytes));
const quote=(value:string)=>`'${value.replace(/'/g,"''")}'`;
async function verify(){
 const params=new URL(location.href).searchParams,token=params.get('token');assert(token&&/^[a-f0-9-]{36}$/.test(token),'Owned capture token missing');
 const fixture=await (async()=>{const r=await fetch(`/__native-capture-tail/${token}`);assert(r.ok,'Owned tail configuration unavailable');return object(await r.json());})();
 assert(typeof fixture.eof==='boolean','Explicit capture mode missing');
 const plan=nativeCaptureTailPlan(fixture.eof),id='agent-capture-tail-'+crypto.randomUUID(),events:AgentSessionEvent[]=[],observations:TerminalIntegrationStateEvent[]=[],queries:unknown[]=[],dispose:(()=>void)[]=[];
 let raw='',failure:string|undefined,created=false,terminalId:string|undefined,closed=false;
 const report=(evidence:unknown)=>fetch(`/__agent-stream-result/${token}`,{method:'POST',body:JSON.stringify({evidence,progress:'Actual original-command capture-tail acceptance'})});
 const witness=async()=>{const r=await fetch(`/__native-capture-tail/${token}`);assert(r.ok,'Owned tail witness unavailable');return object(await r.json());};
 await initI18n('en-US');await getCurrentWindow().show();await getCurrentWindow().setFocus();const root=createRoot(document.getElementById('root')!);root.render(<TerminalControllerLayer/>);
 const host=document.createElement('div');host.style.cssText='position:fixed;inset:0';document.body.appendChild(host);
 try{
  assert(typeof fixture.library==='string'&&typeof fixture.gate==='string'&&typeof fixture.librarySha256==='string','Sealed native test program missing');
  const session=await invokeCreateLocalSession(100,30);terminalId=session.sessionId;useTerminalStore.getState().addSession(session);
  await until(()=>!!terminalRegistry.get(session.sessionId),'Actual capture controller missing');const controller=terminalRegistry.get(session.sessionId)!;controller.attach(host);await controller.whenOutputReady();
  await until(async()=>!!(await invokeGetTerminalBrokerSnapshot(session.sessionId)).session?.promptReady,'Native capture prompt missing');
  const before=await invokeGetTerminalBrokerSnapshot(session.sessionId);assert(before.session?.inputMode==='native-inline'&&isCurrentNativeEditorProfile(before.session.nativePeerProfile,params.get('nativeP3')),'Capture provider differs');
  dispose.push(controller.subscribeOutput(v=>{assert(raw.length<524288,'Actual capture display exceeded bound');raw+=v;}));
  dispose.push(await listenToTerminalIntegrationState(({payload})=>{if(payload.sessionId===session.sessionId)observations.push(payload);}));
  assert(await controller.writeUserInput(nativeFileCoreSetup+'\r'),'Loaded module diagnostic refused');await until(()=>!!readNativeFileLoadedCore(raw),'Actual loaded Core missing');const loadedCore=readNativeFileLoadedCore(raw);assert(loadedCore,'Loaded Core missing');
  await until(async()=>!!(await invokeGetTerminalBrokerSnapshot(session.sessionId)).session?.promptReady,'Diagnostic prompt missing');
  const declaration=`using System.Runtime.InteropServices; public static class ShellSpanAcceptanceTail { [DllImport(@"${fixture.library.replace(/"/g,'""')}",EntryPoint="Run",CallingConvention=CallingConvention.StdCall)] public static extern void Run(); }`;
  const setup=`$env:SHELLSPAN_CAPTURE_TAIL_TOKEN=${quote(token)}; $env:SHELLSPAN_CAPTURE_TAIL_GATE=${quote(fixture.gate)}; Add-Type -TypeDefinition ${quote(declaration)}; [Console]::WriteLine('C05_PROGRAM_'+'READY')`;
  assert(await controller.writeUserInput(setup+'\r'),'Owned native program setup refused');await until(()=>raw.includes('C05_PROGRAM_READY'),'Native program was not prepared');
  await until(async()=>!!(await invokeGetTerminalBrokerSnapshot(session.sessionId)).session?.promptReady,'Program setup prompt missing');
  dispose.push(await listenToAgentRuntimeSession(({payload})=>{
   if(payload.sessionId!==id)return;events.push(payload);
   if(payload.type==='agent/status'&&payload.data.status==='failed')failure??=payload.data.reason??'Capture model failed';
   if(payload.type==='tool/call')try{assert(events.filter(x=>x.type==='tool/call').length===1&&payload.data.call.name==='run_terminal_command','Capture source repeated or wrong tool');assert(matchesLateReceiptArgs(delegationOriginalCall(events,payload).arguments,plan.command),'Original capture source changed');assert(payload.data.call.nativeName==='terminal_execute'&&matchesLateReceiptArgs(payload.data.call.arguments,plan.command,true),'Prepared capture projection changed');}catch(error){failure??=String(error);}
   if(payload.type==='tool/approval'&&payload.data.status==='requested')void(async()=>{
    assert(!failure,failure??'Proposal mismatch');const {approvalId,callId,requestId}=payload.data,{turnId,stepId}=payload;assert(approvalId&&turnId&&stepId,'Capture approval identity missing');const decision={sessionId:id,approvalId,callId,requestId,turnId,stepId};
    const pending=await invokeGetPendingAgentRuntimeApprovalArguments(decision);assert(pending==null||matchesLateReceiptArgs(pending,plan.command),'Pending capture source changed');
    const state=await invokeGetAgentRuntimeSession({sessionId:id});assert(state.header.permissionMode==='requestApproval'&&state.header.executionSurface==='boundTerminal'&&state.header.target?.sessionId===session.sessionId,'Capture permission/target changed');
    await report({kind:'actual-native-capture-tail-approval',token,id,plan,before,loadedCore,fixture,events,observations,raw});
    await until(async()=>{assert(!failure,failure??'Capture approval failed');return(await witness()).armed===true;},'Actual Core verification missing',90000);await invokeApproveAgentRuntimeTool(decision);
   })().catch(error=>{failure??=String(error);});
  }));
  const selection=(await invokeListAiRoutes()).defaultSelection;assert(selection,'Configured model missing');
  await invokeCreateAgentRuntimeSession({sessionId:id,taskId:id,goal:plan.goal,executionSurface:'boundTerminal',permissionMode:'requestApproval',target:{kind:'local',targetId:'terminal-'+session.sessionId,sessionId:session.sessionId,cwd:before.session.currentDirectory},capabilityScope:{toolNames:['run_terminal_command'],effects:['stateChange','externalSideEffect'],targetIds:['terminal-'+session.sessionId]}});created=true;
  const message=crypto.randomUUID();await invokeAgentRuntimeFollowup({sessionId:id,messageId:message,clientSubmissionId:message,content:plan.goal});await invokeStartAgentRuntime({sessionId:id,selection});
  let tool:AgentSessionEvent|undefined;await until(()=>{assert(!failure,failure??'Capture model failed');tool=events.find(x=>x.type==='tool/result');return!!tool;},'Original capture tool result missing');assert(tool?.type==='tool/result','Tool result missing');
  const data=object(tool.data.data);assert(tool.data.status==='uncertain'&&data.execution==='unknown'&&data.exitCode===null&&data.noAutoReplay===true,'Blocked native program did not retain unknown result');
  const recovery=await invokeGetTerminalSubmissionRecovery(id);assert(recovery.length===1,'Original durable intent missing');
  const stable=await invokeGetTerminalBrokerSnapshot(session.sessionId),capture=captureOf(stable),active=stable.session?.inputObservation?.activeCommand;assert(active?.agentSessionId===id&&active.operationId===capture.operationId&&active.commandId===capture.commandId&&active.phase==='uncertain'&&active.executionEvidence==='startObserved','Original command coordinator changed');
  const begin=`C05_BEGIN_${token}`,tail=`C05_TAIL_${token}`;
  assert(capture.captureOpen&&capture.nativeFenceRegistered&&!capture.nativeFenceComplete&&!capture.truncated,'Original command fence closed before late output');assert(text(capture.bytes).includes(begin)&&!text(capture.bytes).includes(tail),'Original command capture boundaries differ');
  for(let n=0;n<3;n++){
   const snapshot=await invokeGetTerminalBrokerSnapshot(session.sessionId),current=captureOf(snapshot),sequence=snapshot.session?.nextInputSequence;
   const frontendAccepted=await controller.writeUserInput('C05_INPUT_MUST_BE_BLOCKED');let backendError:string|undefined;try{await invokeWriteSession(session.sessionId,'C05_BACKEND_MUST_BE_BLOCKED');}catch(error){backendError=String(error);}
   const after=await invokeGetTerminalBrokerSnapshot(session.sessionId);assert(!frontendAccepted&&backendError&&after.session?.nextInputSequence===sequence,'Unknown capture admitted input');assert(current.commandId===capture.commandId&&current.operationId===capture.operationId&&current.captureOpen&&!current.nativeFenceComplete,'Query lost original capture');assert(JSON.stringify(await invokeGetTerminalSubmissionRecovery(id))===JSON.stringify(recovery),'Query settled original intent');queries.push({snapshot,capture:current,frontendAccepted,backendError,sequence,afterSequence:after.session?.nextInputSequence});
  }
  await report({kind:'actual-native-capture-tail-unknown',token,id,plan,before,loadedCore,fixture,toolResult:tool,stable,capture,recovery,queries,events,observations,raw,originalToolUnknown:true});
  const released=await fetch(`/__native-capture-tail/${token}/release`,{method:'POST'});assert(released.ok,'Owned late tail was not released');
  if(plan.eof){
   await until(()=>raw.includes(tail),'Actual post-EOF program tail missing',15000);
   let afterTail=await invokeGetTerminalBrokerSnapshot(session.sessionId);
   await until(async()=>{afterTail=await invokeGetTerminalBrokerSnapshot(session.sessionId);return text(captureOf(afterTail).bytes).includes(tail);},'Original command lost post-EOF tail',5000);
   const finalCapture=captureOf(afterTail),finalText=text(finalCapture.bytes),recoveryAfterTail=await invokeGetTerminalSubmissionRecovery(id);
   assert(finalCapture.commandId===capture.commandId&&finalCapture.operationId===capture.operationId&&finalCapture.captureOpen&&!finalCapture.truncated,'EOF lost original capture');
   assert(finalText.split(begin).length===2&&finalText.split(tail).length===2&&finalCapture.bytes.length>capture.bytes.length,'EOF output lost or repeated');
   assert(afterTail.session?.integrationState==='unavailable'&&afterTail.session.integrationReason==='nativeControlClosed'&&!afterTail.session.integrationCapabilities.includes('nativeScriptInput')&&!afterTail.session.integrationCapabilities.includes('nativeJobControl'),'EOF did not revoke native capabilities');
   assert(afterTail.session.inputObservation?.activeCommand?.executionEvidence!=='endObserved'&&JSON.stringify(recoveryAfterTail)===JSON.stringify(recovery),'Ordinary tail/capture marker invented trusted settlement');
   const postTailQueries:unknown[]=[];
   for(let n=0;n<3;n++){
    const snapshot=await invokeGetTerminalBrokerSnapshot(session.sessionId),sequence=snapshot.session?.nextInputSequence;
    const frontendAccepted=await controller.writeUserInput('C05_EOF_TAIL_INPUT_BLOCKED');let backendError:string|undefined;try{await invokeWriteSession(session.sessionId,'C05_EOF_TAIL_BACKEND_BLOCKED');}catch(error){backendError=String(error);}
    const after=await invokeGetTerminalBrokerSnapshot(session.sessionId),records=await invokeGetTerminalSubmissionRecovery(id);assert(!frontendAccepted&&backendError&&after.session?.nextInputSequence===sequence&&JSON.stringify(records)===JSON.stringify(recovery),'EOF tail/query restored editing or settled intent');postTailQueries.push({snapshot,capture:captureOf(snapshot),frontendAccepted,backendError,sequence,afterSequence:after.session?.nextInputSequence,recovery:records});
   }
   assert(events.filter(x=>x.type==='tool/call').length===1&&events.filter(x=>x.type==='tool/approval'&&x.data.status==='approved').length===1,'EOF source/approval repeated');
   await invokeCloseSession(session.sessionId);closed=true;const recoveryAfterClose=await invokeGetTerminalSubmissionRecovery(id);assert(JSON.stringify(recoveryAfterClose)===JSON.stringify(recovery),'Closing EOF host settled unproven intent');
   await report({kind:'actual-native-capture-tail-eof',token,id,plan,before,loadedCore,fixture,toolResult:tool,stable,capture,recovery,queries,afterTail,finalCapture,recoveryAfterTail,postTailQueries,recoveryAfterClose,events,observations,raw,originalToolUnknown:true,lateTailCapturedOnce:true,normalCloseSucceeded:true,scope:'Actual source physically disposes only its private pipe,then enters bounded native program. Original command capture retains real tail after EOF/unknown;ordinary tail/OSC completeness never substitutes trusted Settled. Six input-refusal queries and normal close preserve original unsettled intent;no replay or synthetic receipt.'});return;
  }
  let settled:Awaited<ReturnType<typeof invokeGetTerminalBrokerSnapshot>>|undefined;
  await until(async()=>{settled=await invokeGetTerminalBrokerSnapshot(session.sessionId);return settled.session?.inputObservation?.activeCommand?.commandId===capture.commandId&&settled.session.inputObservation.activeCommand.executionEvidence==='endObserved'&&captureOf(settled).nativeFenceComplete;},'Original matching settlement/capture tail missing',15000);
  const finalCapture=captureOf(settled),finalText=text(finalCapture.bytes);assert(finalCapture.operationId===capture.operationId&&!finalCapture.truncated,'Late capture identity/truncation changed');assert(finalText.split(begin).length===2&&finalText.split(tail).length===2,'Original capture lost/repeated native output');assert(finalCapture.bytes.length>capture.bytes.length,'Original capture did not retain late bytes');
  const recoveryAfterSettled=await invokeGetTerminalSubmissionRecovery(id);assert(recoveryAfterSettled.length===0,'Matching late end did not settle intent');assert(events.filter(x=>x.type==='tool/call').length===1&&events.filter(x=>x.type==='tool/approval'&&x.data.status==='approved').length===1,'Capture command/approval repeated');assert(tool.data.status==='uncertain'&&data.execution==='unknown','Original result rewritten');
  await invokeCloseSession(session.sessionId);closed=true;
  await report({kind:'actual-native-capture-tail',token,id,plan,before,loadedCore,fixture,toolResult:tool,stable,capture,recovery,queries,settled,finalCapture,recoveryAfterSettled,events,observations,raw,originalToolUnknown:true,lateTailCapturedOnce:true,normalCloseSucceeded:true,scope:'Actual model-approved native program blocked in original ConsoleHost,real command/stop-confirmation timeout,three input-refusal queries,then independent gate releases real tail output. Opt-in debug read-only observation proves same original native command fence retained bytes through matching trusted late end. No fake receipt,GDB,argument repair,Direct,retry or protected old-operation replay.'});
 }catch(error){await report({kind:'actual-native-capture-tail-failure',failed:true,error:String(error),id,plan,events,observations,queries,raw});throw error;}
 finally{dispose.forEach(fn=>fn());if(created){await invokeCancelAgentRuntime({sessionId:id}).catch(()=>{});await invokeArchiveAgentRuntimeSession({sessionId:id}).catch(()=>{});}if(terminalId){if(!closed)await invokeCloseSession(terminalId).catch(()=>{});terminalRegistry.dispose(terminalId);}root.unmount();host.remove();}
}
void verify().then(()=>({ok:true}),(error:unknown)=>({ok:false,error:error instanceof Error?error.message:String(error)})).then(value=>fetch(`/__agent-stream-result/${new URL(location.href).searchParams.get('token')}`,{method:'POST',body:JSON.stringify(value)}));
