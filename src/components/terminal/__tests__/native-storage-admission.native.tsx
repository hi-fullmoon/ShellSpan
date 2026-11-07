import {createRoot} from 'react-dom/client';
import {getCurrentWindow} from '@tauri-apps/api/window';
import {TerminalControllerLayer} from '../terminal-controller-layer';
import {terminalRegistry} from '../registry/terminal-registry';
import {useTerminalStore} from '@/stores/terminalStore';
import {initI18n} from '@/locales';
import {isCurrentNativeEditorProfile} from './native-editor-profile';
import {matchesNativeJobsApproval} from './native-jobs-approval';
import {recordedNativeUncertainty} from './native-key-crash-observation';
import {invokeCreateLocalSession,invokeCloseSession,invokeGetTerminalBrokerSnapshot,invokeListAiRoutes,
  invokeCreateAgentRuntimeSession,invokeStartAgentRuntime,invokeAgentRuntimeFollowup,invokeCancelAgentRuntime,
  invokeArchiveAgentRuntimeSession,invokeGetPendingAgentRuntimeApprovalArguments,invokeApproveAgentRuntimeTool,
  listenToAgentRuntimeSession,listenToTerminalIntegrationState,invokeGetTerminalSubmissionRecovery,invokeWriteSession} from '@/lib/ipc/tauri';
import type {AgentSessionEvent} from '@/types/agent-session';
import type {TerminalIntegrationStateEvent} from '@/types';
import '@/styles/base.css';

function assert(value:unknown,message:string):asserts value{if(!value)throw new Error(message);}
async function until(test:()=>boolean|Promise<boolean>,message:string){const end=Date.now()+120000;while(!await test()){assert(Date.now()<end,message);await new Promise(resolve=>setTimeout(resolve,10));}}
async function verify(){
  const parameters=new URL(location.href).searchParams,token=parameters.get('token'),mode=parameters.get('storageAdmission');
  const posix=parameters.get('nativeP3')==='zsh'||parameters.get('nativeP2')==='true';
  const refusals:Record<string,string>={missing:'TERMINAL_SUBMISSION_JOURNAL_UNAVAILABLE',
    'read-only':'TERMINAL_SUBMISSION_JOURNAL_UNAVAILABLE','unknown-format':'TERMINAL_SUBMISSION_JOURNAL_INVALID',
    'invalid-marker':'TERMINAL_SUBMISSION_JOURNAL_INVALID','foreign-namespace':'TERMINAL_SUBMISSION_JOURNAL_MIGRATION_REQUIRED',
    'missing-directory':'TERMINAL_SUBMISSION_JOURNAL_UNAVAILABLE','directory-junction':'TERMINAL_SUBMISSION_JOURNAL_INVALID',
    'corrupt-database':'TERMINAL_SUBMISSION_JOURNAL_UNAVAILABLE: sqlite=26','read-denied':'TERMINAL_SUBMISSION_JOURNAL_UNAVAILABLE: sqlite=14'};
  const crash=mode==='crash-after-start',keyCrash=mode==='crash-key',earlyCrash=['crash-prepare','crash-proof','crash-intent','crash-arm'].includes(mode??''),timeoutMs=crash?30000:5000;
  assert(token&&/^[0-9a-f-]{36}$/.test(token)&&mode&&(mode==='healthy'||crash||earlyCrash||keyCrash||Object.prototype.hasOwnProperty.call(refusals,mode)),'Owned storage case parameters missing');
  await initI18n('en-US');await getCurrentWindow().show();await getCurrentWindow().setFocus();
  const root=createRoot(document.getElementById('root')!);root.render(<TerminalControllerLayer/>);
  const host=document.createElement('div');host.style.cssText='width:100vw;height:100vh';document.body.append(host);
  const markStarted=posix?`builtin printf 'ONCE\\n' >> "$HOME/storage-${token}.txt"`:`[IO.File]::AppendAllText((Join-Path $env:SHELLSPAN_LOCAL_HOME 'storage-${token}.txt'),'ONCE'+[Environment]::NewLine)`;
  const source=crash?`${markStarted}; $end=[DateTime]::UtcNow.AddSeconds(30); while(-not (Test-Path (Join-Path $env:SHELLSPAN_LOCAL_HOME 'crash-release-${token}.txt')) -and [DateTime]::UtcNow -lt $end){Start-Sleep -Milliseconds 50}; if(Test-Path (Join-Path $env:SHELLSPAN_LOCAL_HOME 'crash-release-${token}.txt')){[IO.File]::AppendAllText((Join-Path $env:SHELLSPAN_LOCAL_HOME 'crash-after-${token}.txt'),'AFTER')}`:markStarted;
  const id=`agent-storage-${crypto.randomUUID()}`,events:AgentSessionEvent[]=[],observations:TerminalIntegrationStateEvent[]=[],dispose:(()=>void)[]=[];
  let terminalId:string|undefined,created=false,approvalReserved=false,failure:string|undefined,raw='';
  const report=(value:unknown)=>fetch(`/__agent-stream-result/${token}`,{method:'POST',body:JSON.stringify(value)});
  try{
    const session=await invokeCreateLocalSession(100,30);terminalId=session.sessionId;useTerminalStore.getState().addSession(session);
    await until(()=>!!terminalRegistry.get(session.sessionId),'Actual terminal controller missing');
    const controller=terminalRegistry.get(session.sessionId)!;controller.attach(host);await controller.whenOutputReady();
    await until(async()=>!!(await invokeGetTerminalBrokerSnapshot(session.sessionId)).session?.promptReady,'Native prompt not ready');
    const before=await invokeGetTerminalBrokerSnapshot(session.sessionId);
    const peer=before.session?.nativePeerProfile;
    const gnu=parameters.get('nativeP2')==='true'&&peer?.shell==='bash'&&peer.editor==='readline'&&peer.adapterVersion==='1'
      &&['gnu-bash-4.1-readline-6.0-macos-arm64-native','gnu-bash-4.4-readline-7.0-macos-arm64-native','gnu-bash-5.3-readline-8.3.6-macos-arm64-native'].includes(peer.verifiedProfileId??'');
    assert(before.session?.inputMode==='native-inline'&&(gnu||isCurrentNativeEditorProfile(peer,parameters.get('nativeP3'))),'Actual native editor unavailable');
    dispose.push(controller.subscribeOutput(value=>{if(raw.length<262144)raw+=value;}));
    dispose.push(await listenToTerminalIntegrationState(({payload})=>{if(payload.sessionId===session.sessionId)observations.push(payload);}));
    dispose.push(await listenToAgentRuntimeSession(({payload})=>{
      if(payload.sessionId!==id)return;events.push(payload);
      if(payload.type==='tool/approval'&&payload.data.status==='requested')void(async()=>{
        const {approvalId,callId,requestId}=payload.data,{turnId,stepId}=payload;assert(approvalId&&turnId&&stepId&&!approvalReserved,'Duplicate or incomplete approval');
        const call=events.find((e):e is Extract<AgentSessionEvent,{type:'tool/call'}>=>e.type==='tool/call'&&e.turnId===turnId&&e.stepId===stepId&&e.data.call.callId===callId);
        assert(call?.data.call.name==='run_terminal_command','Unexpected tool name');
        approvalReserved=true;
        const decision={sessionId:id,approvalId,callId,requestId,turnId,stepId};
        const pending=await invokeGetPendingAgentRuntimeApprovalArguments(decision);
        const args=pending??call.data.call.arguments;
        assert(matchesNativeJobsApproval(args,new Map([[source,false]]),[]),'Unapproved storage source or arguments');
        assert(args&&typeof args==='object'&&'timeoutMs'in args&&args.timeoutMs===timeoutMs,'Exact storage timeout missing');
        if(earlyCrash||keyCrash){
          await report({evidence:{kind:'actual-native-crash-approval',mode,token,id,source,before,events,observations,raw,approvalReserved},progress:'Actual model approval is pending; awaiting the externally verified breakpoint.'});
          await until(async()=>{const response=await fetch(`/__native-crash-arm/${token}`);assert(response.ok,'Owned debugger gate unavailable');const value:unknown=await response.json();return !!value&&typeof value==='object'&&'armed'in value&&value.armed===true;},'Exact external breakpoint was not armed');
        }
        await invokeApproveAgentRuntimeTool(decision);
      })().catch(error=>{failure=String(error);});
    }));
    const selection=(await invokeListAiRoutes()).defaultSelection;assert(selection,'Supplied model is missing');
    const goal=`Call run_terminal_command exactly ONCE with background=false and timeoutMs=${timeoutMs} using the source below, with no trailing newline. Do not retry or use other tools even if refused. Then stop.
~~~${posix?'sh':'powershell'}
${source}
~~~`;
    await invokeCreateAgentRuntimeSession({sessionId:id,taskId:id,goal,executionSurface:'boundTerminal',permissionMode:'requestApproval',target:{kind:'local',targetId:`terminal-${session.sessionId}`,sessionId:session.sessionId,cwd:before.session.currentDirectory},capabilityScope:{toolNames:['run_terminal_command'],effects:['none','readOnly','stateChange','externalSideEffect'],targetIds:[`terminal-${session.sessionId}`]}});created=true;
    await invokeStartAgentRuntime({sessionId:id,selection});const message=crypto.randomUUID();await invokeAgentRuntimeFollowup({sessionId:id,messageId:message,clientSubmissionId:message,content:goal});
    if(earlyCrash)await until(()=>{
      assert(!failure,failure??'Approval failed');
      assert(!events.some(event=>event.type==='tool/result'),'Tool settled before the selected breakpoint');
      return false;
    },'External debugger did not terminate the App at the selected breakpoint');
    if(keyCrash){
      await until(()=>{assert(!failure,failure??'Approval failed');return events.some(event=>event.type==='tool/result');},'Actual Shell crash did not settle the tool as uncertain');
      const results=events.filter((event):event is Extract<AgentSessionEvent,{type:'tool/result'}>=>event.type==='tool/result');
      assert(results.length===1&&results[0].data.status==='uncertain'&&events.filter(event=>event.type==='tool/call').length===1,'Shell crash was not one uncertain actual tool call');
      await until(()=>!!recordedNativeUncertainty(observations,id),'Actual uncertain observation was not delivered');
      const recordedUncertain=recordedNativeUncertainty(observations,id);
      const after=await invokeGetTerminalBrokerSnapshot(session.sessionId),recovery=await invokeGetTerminalSubmissionRecovery(id);
      const active=recordedUncertain;
      assert(active?.agentSessionId===id&&active.fullInputConfirmed&&active.submissionIntentDurable&&active.mayHaveSubmitted&&active.executionEvidence==='unknown','Crash changed real submission facts or claimed Started');
      assert(after.session?.inputObservation?.nativeRecoveryRequired||after.session?.open===false,'The crashed generation did not block further input');
      assert(recovery.length===1&&recovery[0].noAutoReplay&&recovery[0].identity.operationId===active.operationId,'Durable crash identity was lost');
      const userBlocked=await controller.writeUserInput('KEY_RECOVERY_MUST_BLOCK')===false;assert(userBlocked,'Frontend admitted input on the crashed generation');
      const beforeIpc=await invokeGetTerminalBrokerSnapshot(session.sessionId);let ipcError:string|undefined;
      try{await invokeWriteSession(session.sessionId,'KEY_BROKER_MUST_BLOCK');}catch(error){ipcError=String(error);}
      const afterIpc=await invokeGetTerminalBrokerSnapshot(session.sessionId);
      assert(ipcError&&beforeIpc.session?.nextInputSequence===afterIpc.session?.nextInputSequence,'The crashed generation admitted backend input');
      const response=await fetch(`/__native-storage-effect/${token}`);assert(response.ok,'Owned crash effect unavailable');const effect:unknown=await response.json();
      assert(effect&&typeof effect==='object'&&'entries'in effect&&Array.isArray(effect.entries)&&effect.entries.length===0,'The source passed the pre-Started crash cut');
      await report({evidence:{kind:'actual-native-key-crash',mode,id,source,before,after,recordedUncertain,recovery,effect,events,observations,raw,userBlocked,beforeIpc,afterIpc,ipcError,
        scope:'Real native key/accept followed by Shell death at Editor.started entry; original command result remains uncertain. No synthetic receipt or source replay.'},progress:'Actual pre-Started Shell crash retained the durable identity and blocked further input.'});
      return;
    }
    if(crash){
      await until(async()=>{assert(!failure,failure??'Approval failed');const active=(await invokeGetTerminalBrokerSnapshot(session.sessionId)).session?.inputObservation?.activeCommand;
        return active?.agentSessionId===id&&active.phase==='running'&&active.fullInputConfirmed&&active.submissionIntentDurable&&active.mayHaveSubmitted&&active.executionEvidence==='startObserved';},'Actual source did not reach the predetermined running crash cut');
      const submitted=await invokeGetTerminalBrokerSnapshot(session.sessionId),recovery=await invokeGetTerminalSubmissionRecovery(id);
      const effectResponse=await fetch(`/__native-storage-effect/${token}`);assert(effectResponse.ok,'Owned crash start effect unavailable');const effect:unknown=await effectResponse.json();
      assert(effect&&typeof effect==='object'&&'entries'in effect&&Array.isArray(effect.entries)&&effect.entries.length===1&&effect.entries[0]==='ONCE','Actual crash source did not start exactly once');
      assert(events.filter(e=>e.type==='tool/call').length===1&&approvalReserved&&!events.some(e=>e.type==='tool/result'),'Crash cut already settled or approval count changed');
      assert(recovery.length===1&&recovery[0].noAutoReplay&&recovery[0].identity.operationId===submitted.session?.inputObservation?.activeCommand?.operationId,'Crash intent identity missing');
      await report({evidence:{kind:'actual-native-crash-ready',mode,id,source,before,submitted,recovery,effect,events,observations,raw,approvalReserved,
        cut:'running-after-real-started-before-settlement',scope:'Real native execution, durable intent and pending result. External owner must verify and kill the exact App; no cancel/close IPC before the cut.'},progress:'Actual running crash cut reached; awaiting external verified App termination.'});
      await new Promise<never>(()=>{});
    }
    await until(()=>{assert(!failure,failure??'Approval failed');return events.some(e=>e.type==='tool/result');},'Actual tool did not return');
    await invokeCancelAgentRuntime({sessionId:id});
    const calls=events.filter(e=>e.type==='tool/call'),results=events.filter((e):e is Extract<AgentSessionEvent,{type:'tool/result'}>=>e.type==='tool/result');assert(calls.length===1&&results.length===1&&approvalReserved,'The model did not make exactly one approved call');
    const after=await invokeGetTerminalBrokerSnapshot(session.sessionId);const effectResponse=await fetch(`/__native-storage-effect/${token}`);assert(effectResponse.ok,'Owned effect check failed');const effect:unknown=await effectResponse.json();
    assert(effect&&typeof effect==='object'&&'entries'in effect&&Array.isArray(effect.entries),'Effect evidence invalid');
    if(mode==='healthy'){assert(results[0].data.status==='completed'&&effect.entries.length===1&&effect.entries[0]==='ONCE','Healthy native control did not execute once');}
    else{const expected=refusals[mode];assert(results[0].data.status==='failed'&&(results[0].data.summary===expected||results[0].data.summary.startsWith(expected+':')),'Refusal did not match the predetermined storage fault');
      assert(effect.entries.length===0&&before.session.nextInputSequence===after.session?.nextInputSequence,'The refused source affected the PTY or filesystem');
      assert(!observations.some(o=>o.inputObservation?.activeCommand?.agentSessionId===id),'The storage refusal created a native input operation');}
    await report({evidence:{kind:'actual-native-storage-admission',mode,source,before,after,effect,events,observations,raw,approvalReserved,
      scope:'One actual model/approval/native-bound call with the predetermined storage fault; not all crash cuts or platforms'},progress:'Actual storage admission case completed.'});
  }catch(error){await report({evidence:{failed:true,mode,error:String(error),source,events,observations,raw},progress:'Storage admission failure retained; no retry.'});throw error;}
  finally{dispose.forEach(fn=>fn());if(created){await invokeCancelAgentRuntime({sessionId:id}).catch(()=>{});await invokeArchiveAgentRuntimeSession({sessionId:id}).catch(()=>{});}if(terminalId){await invokeCloseSession(terminalId);terminalRegistry.dispose(terminalId);}root.unmount();host.remove();}
}
void verify().then(()=>({ok:true}),(error:unknown)=>({ok:false,error:error instanceof Error?error.message:String(error)}))
  .then(value=>fetch(`/__agent-stream-result/${new URL(location.href).searchParams.get('token')}`,{method:'POST',body:JSON.stringify(value)}));
