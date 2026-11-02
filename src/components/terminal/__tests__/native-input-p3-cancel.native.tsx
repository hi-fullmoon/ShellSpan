import {createRoot} from 'react-dom/client';
import {getCurrentWindow} from '@tauri-apps/api/window';
import {Terminal} from '@xterm/xterm';
import {TerminalControllerLayer} from '../terminal-controller-layer';
import {terminalRegistry} from '../registry/terminal-registry';
import {agentTerminalLeaseState} from '../agent-terminal-lease-state';
import {verifySubmittedFault} from './native-input-p3-submit-fault';
import {useTerminalStore} from '@/stores/terminalStore';
import {initI18n} from '@/locales';
import {invokeCreateLocalSession,invokeCloseSession,invokeListAiRoutes,invokeGetTerminalBrokerSnapshot,
 invokeCreateAgentRuntimeSession,invokeStartAgentRuntime,invokeAgentRuntimeFollowup,invokeCancelAgentRuntime,
 invokeGetPendingAgentRuntimeApprovalArguments,invokeApproveAgentRuntimeTool,invokeArchiveAgentRuntimeSession,
 invokeDeleteAgentRuntimeSession,listenToAgentRuntimeSession,listenToTerminalIntegrationState,listenToAgentTerminalLease} from '@/lib/ipc/tauri';
import type {TerminalIntegrationStateEvent} from '@/types';
import type {AgentSessionEvent,AgentTerminalLeaseEvent} from '@/types/agent-session';
import '@/styles/base.css';

function assert(value:unknown,message:string):asserts value{if(!value)throw new Error(message);}
async function until(test:()=>boolean|Promise<boolean>,message:string,timeout=180000){const end=Date.now()+timeout;while(!await test()){assert(Date.now()<end,message);await new Promise(resolve=>setTimeout(resolve,5));}}
async function verify(){
 await initI18n('en-US');await getCurrentWindow().show();
 const parameters=new URL(location.href).searchParams,token=parameters.get('token');
 const report=(value:unknown)=>fetch(`/__agent-stream-result/${token}`,{method:'POST',body:JSON.stringify(value)});
 assert(parameters.get('nativeP3')==='zsh','This cancellation case requires the actual selected ZLE');
 const submitFault=parameters.get('nativeP3SubmitFault')==='true';
 const file=parameters.get('nativeP3CancelEffect');assert(file&&/^p3-cancel-[a-f0-9-]{36}$/.test(file),'Owned effect file missing');
 const nonce=crypto.randomUUID().replace(/-/g,''),prefix=`printf '%s' 'P3_CANCEL_${nonce.slice(0,12)}`;
 const source=submitFault?'"$HOME/p3-stop-target" "$HOME/p3-stop-process.json" "$HOME/p3-stop-entries"':`printf '%s' 'P3_CANCEL_${nonce}' > "$HOME/${file}"`;
 const id=`agent-p3-cancel-${crypto.randomUUID()}`;
 const root=createRoot(document.getElementById('root')!);root.render(<TerminalControllerLayer/>);
 const host=document.createElement('div');host.style.cssText='width:1100px;height:650px';document.body.append(host);
 const hostBounds=host.getBoundingClientRect();
 assert(hostBounds.top>=0&&hostBounds.bottom<=innerHeight&&hostBounds.height>0,'The actual native terminal host must be visible inside the viewport before any model request');
 const observations:TerminalIntegrationStateEvent[]=[],events:AgentSessionEvent[]=[],leases:AgentTerminalLeaseEvent[]=[];
 const disposers:(()=>void)[]=[];let terminalId:string|undefined,created=false,raw='',failure:string|undefined;
 let visibleTyping:unknown;
 let approvalArgumentEvidence:unknown;
 try{
  const session=await invokeCreateLocalSession(100,30);terminalId=session.sessionId;useTerminalStore.getState().addSession(session);
  await until(()=>!!terminalRegistry.get(session.sessionId),'Actual native registry controller missing');
  const controller=terminalRegistry.get(session.sessionId)!;controller.attach(host);await controller.whenOutputReady();
  await until(async()=>!!(await invokeGetTerminalBrokerSnapshot(session.sessionId)).session?.promptReady,'Actual native editor did not become ready',30000);
  const initial=(await invokeGetTerminalBrokerSnapshot(session.sessionId)).session;
  assert(initial?.nativePeerProfile?.shell==='zsh'&&initial.inputMode==='native-inline','Cancellation selected a different or unavailable editor');
  disposers.push(controller.subscribeOutput(value=>{raw+=value;}));
  disposers.push(await listenToTerminalIntegrationState(({payload})=>{if(payload.sessionId===session.sessionId)observations.push(payload);}));
  disposers.push(await listenToAgentTerminalLease(({payload})=>{if(payload.sessionId===session.sessionId)leases.push(payload);}));
  disposers.push(await listenToAgentRuntimeSession(({payload})=>{
   if(payload.sessionId!==id)return;events.push(payload);
   if(payload.type==='request/failure')failure=`${payload.data.failure.kind}:${payload.data.failure.code??'unknown'}`;
   if(payload.type==='tool/approval'&&payload.data.status==='requested'){
    const {approvalId,callId,requestId}=payload.data;const {turnId,stepId}=payload;
    if(!approvalId||!turnId||!stepId){failure='Actual approval identity missing';return;}
    const decision={sessionId:id,approvalId,callId,requestId,turnId,stepId};
    void(async()=>{const pending=await invokeGetPendingAgentRuntimeApprovalArguments(decision);
      const call=events.find((value):value is Extract<AgentSessionEvent,{type:'tool/call'}>=>value.type==='tool/call'&&value.sessionId===id&&value.turnId===turnId&&value.stepId===stepId&&value.data.call.callId===callId);
      const actual=pending??call?.data.call.arguments;
      const command=actual&&typeof actual==='object'&&'command'in actual?actual.command:undefined;
      approvalArgumentEvidence={fromPending:pending!==null&&pending!==undefined,keys:actual&&typeof actual==='object'?Object.keys(actual):[],commandType:typeof command,expectedLength:source.length,actualLength:typeof command==='string'?command.length:undefined,exact:command===source,suffixCodePoints:typeof command==='string'?Array.from(command.slice(-4),value=>value.codePointAt(0)):undefined};
      assert(command===source,'Model source escaped the pre-approved cancellation program');
      if(submitFault){
        // The production bound-terminal adapter omits background=false; the
        // TerminalExecuteArgumentsNative contract defaults an absent field to
        // false. Inspect those canonical arguments without changing them.
        assert(actual&&typeof actual==='object'&&(!('background'in actual)||actual.background===false)&&'timeoutMs'in actual&&actual.timeoutMs===60000,'Submitted-stop case requires the approved foreground mode and exact timeout');
      }
      await invokeApproveAgentRuntimeTool(decision);})().catch(error=>{failure=String(error);});
   }
  }));
  const selection=(await invokeListAiRoutes()).defaultSelection;assert(selection,'Actual configured model required');
  const goal=`Call run_terminal_command exactly ONCE ${submitFault?'with background=false and timeoutMs=60000 ':''}using the exact shell source below. The command has NO trailing CR or LF; the newline before the closing fence is markup only. Do not retry, change quoting, add tools or use Direct. Then reply done.\n~~~sh\n${source}\n~~~`;
  await invokeCreateAgentRuntimeSession({sessionId:id,taskId:id,goal,executionSurface:'boundTerminal',permissionMode:'requestApproval',target:{kind:'local',targetId:`terminal-${session.sessionId}`,sessionId:session.sessionId,cwd:initial.currentDirectory},capabilityScope:{toolNames:['run_terminal_command'],effects:['none','readOnly','stateChange','externalSideEffect'],targetIds:[`terminal-${session.sessionId}`]}});created=true;
  await invokeStartAgentRuntime({sessionId:id,selection});const message=crypto.randomUUID();await invokeAgentRuntimeFollowup({sessionId:id,messageId:message,clientSubmissionId:message,content:goal});
  if(submitFault){assert(token,'Owned result token missing');await verifySubmittedFault({id,source,terminalId:session.sessionId,controller,host,token,events,observations,leases,failure:()=>failure,readRaw:()=>raw,report,oldClosed:()=>{terminalId=undefined;}});return;}
  await until(()=>{
   assert(!failure,failure??'Actual cancellation source failed');
   const active=observations[observations.length-1]?.inputObservation?.activeCommand;
   if(active?.agentSessionId!==id||active.phase!=='typing'||active.fullInputConfirmed||!active.sourceMayBeEnqueued)return false;
   if(!controller.searchAddon.findNext(prefix))return false;
   const selected=controller.terminal.getSelection(),position=controller.terminal.getSelectionPosition();controller.terminal.clearSelection();
   if(selected!==prefix)return false;
   visibleTyping={operationId:active.operationId,fullInputConfirmed:false,position,actualVisiblePrefix:selected};return true;
  },'The actual public terminal never exposed a native typing prefix before full confirmation');
  await invokeCancelAgentRuntime({sessionId:id});
  await until(()=>observations.some(value=>{const command=value.inputObservation?.activeCommand;return command?.agentSessionId===id&&command.draftCleared&&!command.mayHaveSubmitted&&!command.submissionIntentDurable;}),'Actual owned prefix clear was not confirmed',15000);
  await until(()=>!agentTerminalLeaseState.get(session.sessionId),'Native cancellation did not release input ownership',15000);
  const status=await fetch(`/__native-p3-cancel-effect/${token}`);assert(status.ok,'Actual effect absence check failed');const effect:unknown=await status.json();assert(effect&&typeof effect==='object'&&'exists'in effect&&effect.exists===false,'The cancelled command executed a real effect');
  const before=raw.length;assert(await controller.writeUserInput("printf '%s%s\\n' P3_USER_ RESTORED\r"),'Actual user input remained blocked');
  await until(()=>raw.slice(before).includes('P3_USER_RESTORED'),'Ordinary user input did not recover after owned draft clearing',10000);
  assert(events.filter(value=>value.type==='tool/call').length===1,'The real model retried the cancelled operation');
  assert(controller.terminal.getSelection===Terminal.prototype.getSelection&&controller.terminal.open===Terminal.prototype.open,'Cancellation installed a renderer/source override');
  await report({progress:'Actual native visible-prefix cancellation, clear confirmation and ordinary user recovery passed',evidence:{initial,source,visibleTyping,effect,observations,leases,events,raw,noAutoReplay:true}});
 }catch(error){await report({progress:'Actual native cancellation failure retained',evidence:{failed:true,error:String(error),source,visibleTyping,approvalArgumentEvidence,observations,leases,events,raw,broker:terminalId?await invokeGetTerminalBrokerSnapshot(terminalId):undefined}});throw error;}
 finally{disposers.forEach(dispose=>dispose());if(created){await invokeCancelAgentRuntime({sessionId:id});if(!submitFault){await invokeArchiveAgentRuntimeSession({sessionId:id});await invokeDeleteAgentRuntimeSession({sessionId:id});}}root.unmount();if(terminalId){await invokeCloseSession(terminalId);terminalRegistry.dispose(terminalId);}host.remove();}
}
void verify().then(()=>({ok:true}),error=>({ok:false,error:error instanceof Error?error.message:String(error)})).then(value=>fetch(`/__agent-stream-result/${new URL(location.href).searchParams.get('token')}`,{method:'POST',body:JSON.stringify(value)}));
