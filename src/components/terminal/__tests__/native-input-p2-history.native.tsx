import {createRoot} from 'react-dom/client';
import {nativeP2Password} from './native-input-p2-credential';
import {getCurrentWindow} from '@tauri-apps/api/window';
import {TerminalControllerLayer} from '../terminal-controller-layer';
import {terminalRegistry} from '../registry/terminal-registry';
import {useTerminalStore} from '@/stores/terminalStore';
import {useAppStore} from '@/stores/appStore';
import {initI18n} from '@/locales';
import {invokeCreateLocalSession,invokeCreateSession,invokeCheckHostKey,invokeTrustHost,invokeCloseSession,
  invokeGetTerminalBrokerSnapshot,invokeCreateAgentRuntimeSession,invokeStartAgentRuntime,invokeAgentRuntimeFollowup,
  invokeListAiRoutes,invokeApproveAgentRuntimeTool,invokeGetPendingAgentRuntimeApprovalArguments,
  invokeCancelAgentRuntime,invokeArchiveAgentRuntimeSession,invokeDeleteAgentRuntimeSession,invokeGetAgentRuntimeArtifact,
  listenToAgentRuntimeSession} from '@/lib/ipc/tauri';
import type {AgentSessionEvent} from '@/types/agent-session';
import '@/styles/base.css';

function assert(value:unknown,message:string):asserts value{if(!value)throw new Error(message);}
async function eventually(test:()=>boolean|Promise<boolean>,message:string){
  const deadline=Date.now()+180000;
  while(!await test()){assert(Date.now()<deadline,message);await new Promise(resolve=>setTimeout(resolve,25));}
}
async function verify(){
  const parameters=new URL(location.href).searchParams;
  const report=(value:unknown)=>fetch(`/__agent-stream-result/${parameters.get('token')}`,{method:'POST',body:JSON.stringify(value)});
  await initI18n('en-US');await getCurrentWindow().show();await getCurrentWindow().setFocus();
  const selection=(await invokeListAiRoutes()).defaultSelection;assert(selection,'Real model selection required');
  const root=createRoot(document.getElementById('root')!);
  useAppStore.setState({activeSection:'terminal',restoreWorkspace:false});
  root.render(<TerminalControllerLayer/>);
  const host=document.createElement('div');host.style.cssText='width:1100px;height:650px';document.body.append(host);
  const small=parameters.get('historySmall')==='true';
  const ssh=parameters.has('nativeP2SshPort');const port=Number(parameters.get('nativeP2SshPort'));
  const username=parameters.get('nativeP2SshUser')??'native53';
  let terminalId:string|undefined,created=false,ended=false,failure:string|undefined;
  const id=`agent-native-history-${crypto.randomUUID()}`;
  const results:Extract<AgentSessionEvent,{type:'tool/result'}>[]=[];
  const calls:Extract<AgentSessionEvent,{type:'tool/call'}>[]=[];
  let unlisten:(()=>void)|undefined;
  let beforeAudit:Promise<unknown>|undefined;
  let afterHistory='',afterHistoryRows='';
  const background='while :; do sleep 1; done';
  const before='builtin history -s KEEP_USER_A; builtin history -s KEEP_USER_B; builtin history -a; builtin history; (exit 7)';
  const after=`printf 'PARENT_STATUS=%s\\n' "$?"; printf 'HISTFILE_STATE:%s:%s\\n' "\${HISTFILE+x}" "\${HISTFILE-}"; printf 'HISTORY_CONFIG:%s:%s\\n' "\${HISTCONTROL-}" "\${HISTIGNORE-}"; builtin history; builtin history -a`;
  const allowed=new Set([background,before,after]);
  const cache=new Map<string,Promise<Record<string,unknown>>>();
  const read=(event:Extract<AgentSessionEvent,{type:'tool/result'}>)=>{
    let promise=cache.get(event.data.callId);
    if(!promise){promise=(async()=>{
      let value:unknown=event.data.data;
      if(value&&typeof value==='object'&&'artifactRef'in value&&typeof value.artifactRef==='string'){
        const artifact=await invokeGetAgentRuntimeArtifact({sessionId:id,artifactId:value.artifactRef,maxBytes:16*1024*1024});
        const bytes=Uint8Array.from(atob(artifact.bodyBase64),char=>char.charCodeAt(0));
        const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');
        assert(!artifact.truncated&&hash===artifact.metadata.sha256,'Actual history result artifact failed integrity');
        value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
      }
      assert(value&&typeof value==='object'&&!Array.isArray(value),'Structured actual tool result missing');
      return value as Record<string,unknown>;
    })();cache.set(event.data.callId,promise);}
    return promise;
  };
  try{
    if(ssh){const key=await invokeCheckHostKey('127.0.0.1',port);assert(key.status==='match'||key.status==='notFound','Fixture host identity changed');if(key.status==='notFound'){assert(key.fingerprint,'Host fingerprint missing');await invokeTrustHost('127.0.0.1',port,key.fingerprint);}}
    const session=ssh?await invokeCreateSession({name:'Native history isolated SSH',host:'127.0.0.1',port,username,authMethod:'password',password:await nativeP2Password(),terminalCols:100,terminalRows:30},'shellspan.native-input'):await invokeCreateLocalSession(100,30,undefined,'shellspan.native-input');
    terminalId=session.sessionId;useTerminalStore.getState().addSession(session);
    const controller=terminalRegistry.create(session.sessionId,(sid,event)=>useTerminalStore.getState().setStatus(sid,event),
      (sid,event)=>useTerminalStore.getState().setClosed(sid,event),sid=>useTerminalStore.getState().sessions.find(value=>value.sessionId===sid)?.status??'connecting',()=>{},session.ptyInfo);
    controller.attach(host);await controller.whenOutputReady();controller.focus();
    await eventually(async()=>(await invokeGetTerminalBrokerSnapshot(session.sessionId)).session?.integrationState==='ready','Actual shell integration did not become ready');
    const identity=(await invokeGetTerminalBrokerSnapshot(session.sessionId)).session;
    assert(identity?.integrationState==='ready','Actual shell integration unavailable');
    assert(identity.inputMode==='native-inline','Wrong actual initialization path');
    unlisten=await listenToAgentRuntimeSession(({payload})=>{
      if(payload.sessionId!==id)return;
      if(payload.type==='tool/call')calls.push(payload);
      if(payload.type==='request/failure')failure=`Model failure: ${payload.data.failure.kind}`;
      if(payload.type==='tool/result'){
        results.push(payload);if(payload.data.status!=='completed')failure=payload.data.summary;
        if(results.length===2)beforeAudit=fetch(`/__native-history-audit/${parameters.get('token')}`,{method:'POST'}).then(async response=>{assert(response.ok,`Actual history before-audit failed: ${await response.clone().text()}`);return response.json();});
      }
      if(payload.type==='turn/end')ended=true;
      if(payload.type==='tool/approval'&&payload.data.status==='requested'){
        const {approvalId,callId,requestId}=payload.data;const {turnId,stepId}=payload;
        assert(approvalId&&turnId&&stepId,'Actual approval binding incomplete');
        const decision={sessionId:id,approvalId,callId,requestId,turnId,stepId};
        void(async()=>{
          const args=await invokeGetPendingAgentRuntimeApprovalArguments(decision)??calls.find(value=>value.data.call.callId===callId)?.data.call.arguments;
          assert(args&&typeof args==='object','Actual approved arguments missing');
          if('command'in args)assert(typeof args.command==='string'&&allowed.has(args.command),'Approval escaped exact history commands');
          else{const launched=await read(results[0]);assert('processHandle'in args&&args.processHandle===launched.processHandle,'Control escaped the actual job handle');}
          await invokeApproveAgentRuntimeTool(decision);
        })().catch(error=>{failure=error instanceof Error?error.message:String(error);});
      }
    });
    const goal=`Use the bound visible terminal only, without retries or extra tools. Make exactly ${small?'FIVE':'SIX'} calls in order: 1 run_terminal_command background=true command=${JSON.stringify(background)}. 2 run_terminal_command command=${JSON.stringify(before)} (exit 7 is intentional; continue). 3 wait_process on the returned job-* handle timeoutMs=1000. 4 wait_process on the same handle timeoutMs=1000. 5 kill_process on that handle signal=terminate timeoutMs=10000.${small?'':` 6 run_terminal_command command=${JSON.stringify(after)}.`} Then reply done. Do not normalize source or reset shell status/history.`;
    await invokeCreateAgentRuntimeSession({sessionId:id,taskId:id,goal,executionSurface:'boundTerminal',permissionMode:'requestApproval',
      target:{kind:ssh?'remote':'local',targetId:`terminal-${session.sessionId}`,sessionId:session.sessionId,...(ssh?{host:'127.0.0.1',port,username}:{cwd:identity.currentDirectory})},
      capabilityScope:{toolNames:['run_terminal_command','wait_process','kill_process'],effects:['none','readOnly','stateChange','externalSideEffect'],targetIds:[`terminal-${session.sessionId}`]}});
    created=true;await invokeStartAgentRuntime({sessionId:id,selection});
    const submission=crypto.randomUUID();await invokeAgentRuntimeFollowup({sessionId:id,messageId:submission,clientSubmissionId:submission,content:goal});
    await eventually(()=>{assert(!failure,failure??'Actual history tools failed');return ended;},'Actual history model turn did not end');
    assert(results.length===(small?5:6),'History sequence omitted a real tool');
    const data=await Promise.all(results.map(read));
    assert(typeof data[1].combinedOutput==='string'&&/^\s*\d+\*?\s+KEEP_USER_A\r?$/m.test(data[1].combinedOutput)&&/^\s*\d+\*?\s+KEEP_USER_B\r?$/m.test(data[1].combinedOutput),'Original history entries were not observed before private controls');
    const beforeFile=await beforeAudit;assert(beforeFile,'Actual history before-audit missing');
    if(small){
      assert(data[1].exitCode===7,'The preceding real source did not exit 7');
      await eventually(async()=>!!(await invokeGetTerminalBrokerSnapshot(session.sessionId)).session?.promptReady,'Native editor did not return before EOF');
      await new Promise<void>(resolve=>controller.terminal.write('',resolve));
      const historyStart=controller.terminal.buffer.active.baseY+controller.terminal.buffer.active.cursorY;
      const stopHistory=controller.subscribeOutput(chunk=>{afterHistory+=chunk;});
      try{
        assert(await controller.writeUserInput('\u0018h'),'Actual user read-only history binding was blocked');
        await eventually(()=>{
          const buffer=controller.terminal.buffer.active;
          afterHistoryRows=Array.from({length:Math.max(0,buffer.length-historyStart)},(_,index)=>buffer.getLine(historyStart+index)?.translateToString(true)??'').join('\n');
          return afterHistory.includes('HISTORY_AFTER_CONTROL_BEGIN')&&afterHistory.includes('HISTORY_AFTER_CONTROL_END')
            &&/^\s*\d+\*?\s+KEEP_USER_A$/m.test(afterHistoryRows)&&/^\s*\d+\*?\s+KEEP_USER_B$/m.test(afterHistoryRows);
        },'Private controls evicted original entries from the actual post-control history display');
      }finally{stopHistory();}
      assert(await controller.writeUserInput('\u0004'),'Real empty-line Ctrl-D was blocked');
      await eventually(()=>useTerminalStore.getState().sessions.find(value=>value.sessionId===session.sessionId)?.status==='disconnected','Actual Ctrl-D did not close the shell');
      await report({progress:'Small HISTSIZE native controls completed; actual read-only user binding verified memory history before real Ctrl-D',evidence:{kind:'native-small-history-actual-application',small,ssh,identity,results:data,calls,beforeFile,afterHistory,afterHistoryRows}});
      return;
    }
    const output=data[5].combinedOutput;
    assert(data[1].exitCode===7&&typeof output==='string'&&output.includes('PARENT_STATUS=7'),'Private poll/stop changed the real nonzero parent status');
    assert(/^\s*\d+\*?\s+KEEP_USER_A\r?$/m.test(output)&&/^\s*\d+\*?\s+KEEP_USER_B\r?$/m.test(output),'Original individual user history entries changed');
    assert(!output.includes('__shellspan_native_history_cleanup')&&!output.includes('ss_native_input_control_end')&&!output.includes('__shellspan_job_control'),'Private management entered user history');
    await report({progress:'Actual continuous nonzero status/history sequence complete',evidence:{kind:'native-history-actual-model-and-application',ssh,identity,results:data,calls,output,beforeFile}});
  }catch(error){await report({progress:'History acceptance failed; retaining actual evidence',evidence:{failed:true,reason:error instanceof Error?error.message:String(error),ssh,calls,results:await Promise.allSettled(results.map(read)),afterHistory,afterHistoryRows,broker:terminalId?await invokeGetTerminalBrokerSnapshot(terminalId):undefined}});throw error;}
  finally{unlisten?.();if(created){await invokeCancelAgentRuntime({sessionId:id});await invokeArchiveAgentRuntimeSession({sessionId:id});await invokeDeleteAgentRuntimeSession({sessionId:id});}root.unmount();if(terminalId){await invokeCloseSession(terminalId);terminalRegistry.dispose(terminalId);}host.remove();}
}
void verify().then(()=>({ok:true}),(error:unknown)=>({ok:false,error:error instanceof Error?`${error.message}\n${error.stack??''}`:String(error)}))
  .then(value=>fetch(`/__agent-stream-result/${new URL(location.href).searchParams.get('token')}`,{method:'POST',body:JSON.stringify(value)}));
