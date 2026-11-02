import {createRoot} from 'react-dom/client';
import {getCurrentWindow} from '@tauri-apps/api/window';
import {TerminalControllerLayer} from '../terminal-controller-layer';
import {terminalRegistry} from '../registry/terminal-registry';
import {useTerminalStore} from '@/stores/terminalStore';
import {useAppStore} from '@/stores/appStore';
import {initI18n} from '@/locales';
import {nativeP2Password} from './native-input-p2-credential';
import {invokeCreateSession,invokeCloseSession,invokeWriteSession,invokeGetTerminalBrokerSnapshot,
  invokeCheckHostKey,invokeTrustHost,invokeCreateAgentRuntimeSession,invokeStartAgentRuntime,
  invokeAgentRuntimeFollowup,invokeListAiRoutes,invokeGetPendingAgentRuntimeApprovalArguments,
  invokeApproveAgentRuntimeTool,invokeCancelAgentRuntime,invokeArchiveAgentRuntimeSession,
  invokeDeleteAgentRuntimeSession,listenToAgentRuntimeSession} from '@/lib/ipc/tauri';
import type {AgentSessionEvent} from '@/types/agent-session';
import '@/styles/base.css';

function assert(value:unknown,message:string):asserts value{if(!value)throw new Error(message);}
async function until(test:()=>boolean|Promise<boolean>,message:string){const deadline=Date.now()+180000;while(!await test()){assert(Date.now()<deadline,message);await new Promise(resolve=>setTimeout(resolve,20));}}
async function verify(){
  await initI18n('en-US');await getCurrentWindow().show();
  const parameters=new URL(location.href).searchParams;const token=parameters.get('token');
  const nonce=parameters.get('nativeP2FaultNonce');assert(nonce&&/^[a-f0-9-]{36}$/.test(nonce),'Owned effect nonce required');
  const port=Number(parameters.get('nativeP2SshPort'));const username=parameters.get('nativeP2SshUser');assert(port>1024&&username,'Owned SSH target required');
  const password=await nativeP2Password();
  const key=await invokeCheckHostKey('127.0.0.1',port);assert(key.status==='match'||key.status==='notFound','Owned host changed');if(key.status==='notFound'){assert(key.fingerprint,'Missing host fingerprint');await invokeTrustHost('127.0.0.1',port,key.fingerprint);}
  const root=createRoot(document.getElementById('root')!);useAppStore.setState({activeSection:'terminal',restoreWorkspace:false});root.render(<TerminalControllerLayer/>);
  const host=document.createElement('div');host.style.cssText='width:1100px;height:650px';document.body.append(host);
  const sessions:string[]=[];const id=`agent-native-ssh-fault-${crypto.randomUUID()}`;
  let created=false;let unlisten:(()=>void)|undefined;let failure:string|undefined;let approvals=0;
  const calls:Extract<AgentSessionEvent,{type:'tool/call'}>[]=[];
  const source=`printf 'ONCE\\n' >> "$HOME/native-p2-once-${nonce}"; exec /bin/sleep 30`;
  const report=(value:unknown)=>fetch(`/__agent-stream-result/${token}`,{method:'POST',body:JSON.stringify(value)});
  try{
    const old=await invokeCreateSession({name:'Owned SSH control EOF',host:'127.0.0.1',port,username,authMethod:'password',password,terminalCols:100,terminalRows:30});sessions.push(old.sessionId);useTerminalStore.getState().addSession(old);
    await until(()=>!!terminalRegistry.get(old.sessionId),'Actual registry controller missing');
    const controller=terminalRegistry.get(old.sessionId)!;controller.attach(host);await controller.whenOutputReady();
    const initial=(await invokeGetTerminalBrokerSnapshot(old.sessionId)).session;assert(initial?.inputMode==='native-inline'&&initial.integrationState==='ready','Actual SSH native startup unavailable');
    unlisten=await listenToAgentRuntimeSession(({payload})=>{
      if(payload.sessionId!==id)return;if(payload.type==='tool/call'){calls.push(payload);if(calls.length>1)failure='Model attempted another call after a may-submitted operation';}
      if(payload.type==='tool/approval'&&payload.data.status==='requested'){
        const {approvalId,callId,requestId}=payload.data;const {turnId,stepId}=payload;
        assert(approvalId&&turnId&&stepId,'Actual approval identity missing');
        const decision={sessionId:id,approvalId,callId,requestId,turnId,stepId};
        void(async()=>{
          assert(++approvals===1,'Refusing to approve replay of the actual SSH effect');
          const args=await invokeGetPendingAgentRuntimeApprovalArguments(decision)??calls.find(value=>value.data.call.callId===callId)?.data.call.arguments;
          assert(args&&typeof args==='object'&&'command'in args&&args.command===source,'Model changed the exact owned fault command');
          await invokeApproveAgentRuntimeTool(decision);
        })().catch(error=>{failure=error instanceof Error?error.message:String(error);});
      }
    });
    const selection=(await invokeListAiRoutes()).defaultSelection;assert(selection,'Actual configured model required');
    const goal=`Call run_terminal_command exactly once with command=${JSON.stringify(source)} timeoutMs=10000. This deliberately execs a real foreground program so its private Bash control socket closes. Do not use extra tools, retry, or normalize source. Stop after that one call.`;
    await invokeCreateAgentRuntimeSession({sessionId:id,taskId:id,goal,executionSurface:'boundTerminal',permissionMode:'requestApproval',target:{kind:'remote',targetId:`terminal-${old.sessionId}`,sessionId:old.sessionId,host:'127.0.0.1',port,username},capabilityScope:{toolNames:['run_terminal_command'],effects:['stateChange','externalSideEffect','readOnly','none'],targetIds:[`terminal-${old.sessionId}`]}});created=true;
    await invokeStartAgentRuntime({sessionId:id,selection});const submission=crypto.randomUUID();await invokeAgentRuntimeFollowup({sessionId:id,messageId:submission,clientSubmissionId:submission,content:goal});
    let failedSnapshot:Awaited<ReturnType<typeof invokeGetTerminalBrokerSnapshot>>|undefined;
    await until(async()=>{
      assert(!failure,failure??'Actual SSH fault failed');const snapshot=await invokeGetTerminalBrokerSnapshot(old.sessionId);const command=snapshot.session?.inputObservation?.activeCommand;
      if(snapshot.session?.integrationState!=='ready'&&command?.mayHaveSubmitted){failedSnapshot=snapshot;return true;}return false;
    },'Actual exec/private SSH control EOF was not observed');
    assert(failedSnapshot?.session?.inputObservation?.nativeRecoveryRequired&&failedSnapshot.session.inputObservation.activeCommand?.submissionIntentDurable&&failedSnapshot.session.inputObservation.activeCommand.noAutoReplay,'Private EOF did not preserve the durable recovery gate');
    const rejected=await invokeWriteSession(old.sessionId,"printf SHOULD_NOT_WRITE\r").then(()=>false,()=>true);assert(rejected,'Ordinary source bypassed the old uncertain generation recovery gate');
    await invokeCancelAgentRuntime({sessionId:id});
    await invokeCloseSession(old.sessionId);
    const next=await invokeCreateSession({name:'Owned SSH after explicit reconnect',host:'127.0.0.1',port,username,authMethod:'password',password,terminalCols:40,terminalRows:30,replacesSessionId:old.sessionId});sessions.push(next.sessionId);useTerminalStore.getState().addSession(next);
    assert(next.terminalSessionId===old.terminalSessionId&&next.terminalGeneration!==old.terminalGeneration&&next.ptyInfo?.inputMode==='native-inline','Reconnect did not create a new trusted native generation');
    terminalRegistry.rebindSession(old.sessionId,next.sessionId,next.ptyInfo);await controller.whenOutputReady();
    let raw='';const dispose=controller.subscribeOutput(chunk=>{raw+=chunk;});
    try{
      await until(()=>!!useTerminalStore.getState().sessions.find(value=>value.sessionId===next.sessionId)?.promptReady,'New SSH generation did not become ready');
      await invokeWriteSession(next.sessionId,"printf '%s%s\\n' SSH_RECOVERY_ OK\r");
      await until(()=>raw.includes('SSH_RECOVERY_OK\r\n'),'New ordinary SSH terminal was not usable');
      const staleRejected=await invokeWriteSession(old.sessionId,"printf STALE_SHOULD_NOT_WRITE\r").then(()=>false,()=>true);assert(staleRejected,'Retired SSH transport still accepted source');
      assert(calls.length===1&&approvals===1,'Fault handling replayed the source');
      await report({progress:'Actual SSH worker control EOF and explicit recovery passed',evidence:{kind:'actual-ssh-worker-private-eof',nonce,old,initial,failedSnapshot,rejected,staleRejected,next,raw,calls,approvals}});
    }finally{dispose();}
  }finally{unlisten?.();if(created){await invokeCancelAgentRuntime({sessionId:id});await invokeArchiveAgentRuntimeSession({sessionId:id});await invokeDeleteAgentRuntimeSession({sessionId:id});}root.unmount();for(const session of sessions){await invokeCloseSession(session).catch(()=>{});terminalRegistry.dispose(session);}host.remove();}
}
void verify().then(()=>({ok:true}),(error:unknown)=>({ok:false,error:error instanceof Error?`${error.message}\n${error.stack??''}`:String(error)})).then(value=>fetch(`/__agent-stream-result/${new URL(location.href).searchParams.get('token')}`,{method:'POST',body:JSON.stringify(value)}));
