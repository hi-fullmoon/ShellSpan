import {createRoot} from 'react-dom/client';
import {getCurrentWindow} from '@tauri-apps/api/window';
import {TerminalControllerLayer} from '../terminal-controller-layer';
import {terminalRegistry} from '../registry/terminal-registry';
import {agentTerminalLeaseState} from '../agent-terminal-lease-state';
import {useTerminalStore} from '@/stores/terminalStore';
import {useAppStore} from '@/stores/appStore';
import {initI18n} from '@/locales';
import {redactTerminalSecrets} from '@/lib/terminal/terminal-output-buffer';
import {invokeCreateLocalSession,invokeCloseSession,invokeGetTerminalBrokerSnapshot,
  invokeCreateAgentRuntimeSession,invokeStartAgentRuntime,invokeAgentRuntimeFollowup,invokeListAiRoutes,
  invokeGetPendingAgentRuntimeApprovalArguments,invokeApproveAgentRuntimeTool,invokeCancelAgentRuntime,
  invokeArchiveAgentRuntimeSession,invokeDeleteAgentRuntimeSession,invokeGetAgentRuntimeArtifact,
  listenToAgentRuntimeSession,listenToTerminalIntegrationState,listenToAgentTerminalLease} from '@/lib/ipc/tauri';
import type {AgentSessionEvent} from '@/types/agent-session';
import type {TerminalIntegrationStateEvent} from '@/types';
import '@/styles/base.css';

function assert(value:unknown,message:string):asserts value{if(!value)throw new Error(message);}
async function until(test:()=>boolean|Promise<boolean>,message:string){const deadline=Date.now()+180000;while(!await test()){assert(Date.now()<deadline,message);await new Promise(resolve=>setTimeout(resolve,20));}}
async function verify(){
  await initI18n('en-US');await getCurrentWindow().show();
  const token=new URL(location.href).searchParams.get('token');const report=(value:unknown)=>fetch(`/__agent-stream-result/${token}`,{method:'POST',body:JSON.stringify(value)});
  const root=createRoot(document.getElementById('root')!);useAppStore.setState({activeSection:'terminal',restoreWorkspace:false});root.render(<TerminalControllerLayer/>);
  const host=document.createElement('div');host.style.cssText='width:1100px;height:650px';document.body.append(host);
  const id=`agent-native-interactive-${crypto.randomUUID()}`;let terminalId:string|undefined,created=false,ended=false,failure:string|undefined,raw='';
  let credentialRefusalExpected=false;
  const calls:Extract<AgentSessionEvent,{type:'tool/call'}>[]=[];const results:Extract<AgentSessionEvent,{type:'tool/result'}>[]=[];
  const observations:TerminalIntegrationStateEvent[]=[];const leases:unknown[]=[];const disposers:(()=>void)[]=[];
  const command="printf '%s%s\\n' NATIVE_INTERACTIVE_ BASELINE";
  const allowedText=new Set(['interactive-value','y','SHOULD_NOT_WRITE']);
  async function read(event:Extract<AgentSessionEvent,{type:'tool/result'}>){
    let value:unknown=event.data.data;
    if(value&&typeof value==='object'&&'artifactRef'in value&&typeof value.artifactRef==='string'){
      const artifact=await invokeGetAgentRuntimeArtifact({sessionId:id,artifactId:value.artifactRef,maxBytes:16*1024*1024});assert(!artifact.truncated,'Actual interactive result artifact was truncated');
      const bytes=Uint8Array.from(atob(artifact.bodyBase64),character=>character.charCodeAt(0));const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');assert(hash===artifact.metadata.sha256,'Actual interactive artifact integrity failed');value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    }
    return value;
  }
  try{
    const session=await invokeCreateLocalSession(100,30);terminalId=session.sessionId;useTerminalStore.getState().addSession(session);
    await until(()=>!!terminalRegistry.get(session.sessionId),'Actual native controller missing');const controller=terminalRegistry.get(session.sessionId)!;controller.attach(host);await controller.whenOutputReady();
    const initial=(await invokeGetTerminalBrokerSnapshot(session.sessionId)).session;assert(initial?.inputMode==='native-inline'&&initial.integrationState==='ready','New native initialization was not used');
    const original={selection:controller.terminal.getSelection,line:controller.terminal.buffer.normal.getLine,open:controller.terminal.open};
    disposers.push(controller.subscribeOutput(chunk=>{raw+=chunk;}));
    disposers.push(await listenToTerminalIntegrationState(({payload})=>{if(payload.sessionId===session.sessionId)observations.push(payload);}));
    disposers.push(await listenToAgentTerminalLease(({payload})=>{if(payload.sessionId===session.sessionId)leases.push(payload);}));
    disposers.push(await listenToAgentRuntimeSession(({payload})=>{
      if(payload.sessionId!==id)return;
      if(payload.type==='tool/call')calls.push(payload);if(payload.type==='tool/result'){
        results.push(payload);
        const call=calls.find(value=>value.data.call.callId===payload.data.callId)?.data.call;
        const expectedRefusal=credentialRefusalExpected&&call?.name==='write_terminal_input';
        if(payload.data.status!=='completed'&&!expectedRefusal)failure=`${payload.data.name}: ${payload.data.summary}`;
      }if(payload.type==='turn/end')ended=true;
      if(payload.type==='request/failure')failure=`${payload.data.failure.kind}: ${redactTerminalSecrets(payload.data.failure.message)}`;
      if(payload.type==='tool/approval'&&payload.data.status==='requested'){
        const {approvalId,callId,requestId}=payload.data;const {turnId,stepId}=payload;assert(approvalId&&turnId&&stepId,'Actual interactive approval identity missing');const decision={sessionId:id,approvalId,callId,requestId,turnId,stepId};
        void(async()=>{const args=await invokeGetPendingAgentRuntimeApprovalArguments(decision)??calls.find(value=>value.data.call.callId===callId)?.data.call.arguments;assert(args&&typeof args==='object','Actual interactive arguments missing');
          if('command'in args)assert(args.command===command,'Approval escaped the exact native baseline command');
          else if('inputKind'in args)assert(args.inputKind==='text'&&'text'in args&&typeof args.text==='string'&&allowedText.has(args.text)||args.inputKind==='key'&&'key'in args&&args.key==='enter','Approval escaped controlled real interactive input');
          await invokeApproveAgentRuntimeTool(decision);
        })().catch(error=>{failure=error instanceof Error?error.message:String(error);});
      }
    }));
    const selection=(await invokeListAiRoutes()).defaultSelection;assert(selection,'Real configured model required');
    const goal=`Call run_terminal_command once with command=${JSON.stringify(command)} and reply done. No extra tools or retries.`;
    await invokeCreateAgentRuntimeSession({sessionId:id,taskId:id,goal,executionSurface:'boundTerminal',permissionMode:'requestApproval',target:{kind:'local',targetId:`terminal-${session.sessionId}`,sessionId:session.sessionId,cwd:initial.currentDirectory},capabilityScope:{toolNames:['run_terminal_command','read_terminal','write_terminal_input','wait_terminal'],effects:['none','readOnly','sensitiveRead','stateChange','externalSideEffect'],targetIds:[`terminal-${session.sessionId}`]}});created=true;
    await invokeStartAgentRuntime({sessionId:id,selection});
    const send=async(content:string)=>{const message=crypto.randomUUID();await invokeAgentRuntimeFollowup({sessionId:id,messageId:message,clientSubmissionId:message,content});};
    await send(goal);await until(()=>{assert(!failure,failure??'Initial real native execution failed');return ended;},'Initial model turn did not end');
    assert(results.length===1&&results[0].data.status==='completed','Initial actual native tool failed');
    assert(observations.some(value=>value.inputObservation?.activeCommand?.fullInputConfirmed&&value.inputObservation.activeCommand.submissionIntentDurable),'Initial actual NIP complete proof/durable intent was not observed');
    await until(()=>!agentTerminalLeaseState.get(session.sessionId),'Initial turn did not release real input ownership');
    // Same actual native PTY, reusing the mature POSIX REPL/confirmation/alternate
    // buffer/credential-prompt programs from terminal_interactive.rs acceptance.
    const program="printf '\\033[?1049h'; printf '%s%s\\n' NATIVE_TUI_ READY; IFS= read -r answer; printf 'INTERACTIVE_ECHO=%s\\n' \"$answer\"; printf '%s%s [y/N] ' NATIVE_ CONFIRM; IFS= read -r -n 1 answer; printf '\\nCONFIRMED=%s\\n' \"$answer\"; printf '\\033[?1049l'; printf 'Pass%s: ' word; IFS= read -r -s answer; printf '\\nACTUAL_INPUT_LENGTH=%s\\n' \"${#answer}\"; printf '%s%s' SECOND_SILENT_ READ; IFS= read -r -s second";
    assert(await controller.writeUserInput(`${program}\r`),'Actual user could not start the controlled foreground program');
    await until(()=>controller.terminal.buffer.active.type==='alternate'&&raw.includes('NATIVE_TUI_READY\r\n'),'Actual alternate-screen program did not start');
    assert(controller.terminal.options.reflowCursorLine===false,'Owned display remained enabled inside real interactive TUI');
    const firstRead=results.length;ended=false;
    await send('Call read_terminal with {} exactly once, then reply done without any other tool.');
    await until(()=>{assert(!failure,failure??'Actual TUI screen read failed');return ended;},'Actual alternate-buffer read did not finish');
    assert(results.length===firstRead+1&&results[firstRead].data.name==='read_terminal','Actual alternate-buffer screen read missing');
    const alternate=await read(results[firstRead]);assert(alternate&&typeof alternate==='object'&&'snapshot'in alternate&&alternate.snapshot&&typeof alternate.snapshot==='object'&&'activeBuffer'in alternate.snapshot&&alternate.snapshot.activeBuffer==='alternate','Actual read_terminal did not observe the real alternate buffer');
    const interactiveStart=results.length;ended=false;
    const steps=[{name:'write_terminal_input',arguments:{inputKind:'text',text:'interactive-value'}},{name:'write_terminal_input',arguments:{inputKind:'key',key:'enter'}},{name:'wait_terminal',arguments:{text:'INTERACTIVE_ECHO=interactive-value',timeoutMs:10000}},{name:'write_terminal_input',arguments:{inputKind:'text',text:'y'}}];
    await send(`Make exactly these FOUR actual bound-terminal calls in order, preserving every JSON property name and value: ${JSON.stringify(steps)}. Each write_terminal_input call MUST include the required inputKind property. Then reply done without further calls. Do not enter any secret or run a command.`);
    await until(()=>{assert(!failure,failure??'Actual interactive sequence failed');return ended;},'Actual interactive model tools did not finish');
    const interactive=results.slice(interactiveStart);assert(interactive.length===4,'The actual REPL/confirmation sequence omitted a tool');
    const values=await Promise.all(interactive.map(read));
    const receipts=values.filter((value):value is {receipt:{operationId:string}}=>!!value&&typeof value==='object'&&'receipt'in value&&!!value.receipt&&typeof value.receipt==='object'&&'operationId'in value.receipt&&typeof value.receipt.operationId==='string');
    assert(receipts.length===3&&new Set(receipts.map(value=>value.receipt.operationId)).size===1,'Real interactive inputs did not share the dedicated interactive lease');
    await until(()=>raw.includes('Password: '),'Actual credential prompt did not appear after alternate-buffer exit');
    const readStart=results.length;ended=false;
    await send('Call read_terminal exactly ONCE, then reply done. The controlled program now shows a credential-like prompt; report no prompt content, and do not enter text or call any other tool.');
    await until(()=>{assert(!failure,failure??'Actual credential screen read failed');return ended;},'Actual credential screen read did not finish');
    assert(results.length===readStart+1&&results[readStart].data.name==='read_terminal','The actual credential screen read was omitted');
    const screen=await read(results[readStart]);assert(screen&&typeof screen==='object'&&'credentialLikePrompt'in screen&&screen.credentialLikePrompt===true,'Actual credential-like screen was not classified');
    // Screen contents are transient by the existing privacy contract; only
    // sanitized metadata persists. Mature Rust acceptance checks the redacted
    // marker itself before that boundary. Never add a logging bypass here.
    assert('contentPersisted'in screen&&screen.contentPersisted===false&&!JSON.stringify(screen).includes('Password:'),'Actual credential-like screen leaked persisted prompt content');
    const refusalStart=results.length;const refusalCalls=calls.length;credentialRefusalExpected=true;ended=false;
    await send('Attempt write_terminal_input exactly ONCE with {inputKind:"text",text:"SHOULD_NOT_WRITE"}, then stop. This is a public non-secret sentinel in an owned test program. The existing credential gate must refuse it. Do not retry, enter any password, or call any other tool.');
    await until(()=>results.length>refusalStart,'Actual credential-gate attempt did not return');
    await invokeCancelAgentRuntime({sessionId:id});
    assert(calls.length===refusalCalls+1&&calls[refusalCalls].data.call.name==='write_terminal_input','The model retried the refused credential input');
    assert(results[refusalStart].data.status!=='completed'&&/credential|凭据/i.test(results[refusalStart].data.summary),'Actual credential input was not refused');assert(!raw.includes('SHOULD_NOT_WRITE'),'Forbidden credential input reached the actual PTY');
    assert(raw.includes('INTERACTIVE_ECHO=interactive-value')&&raw.includes('CONFIRMED=y'),'Real REPL/confirmation input was not delivered');
    await invokeCancelAgentRuntime({sessionId:id});
    await until(()=>!agentTerminalLeaseState.get(session.sessionId),'Credential rejection did not release the dedicated interactive lease');
    const countOffset=raw.length;
    assert(await controller.writeUserInput('\r'),'Actual user could not finish the silent read');
    await until(()=>raw.slice(countOffset).includes('SECOND_SILENT_READ'),'Actual silent read did not return its input length');
    assert(raw.slice(countOffset).includes('ACTUAL_INPUT_LENGTH=0\r\n'),'Refused input reached the no-echo read despite absent visible echo');
    assert(await controller.writeUserInput('\u0003'),'Actual user could not interrupt the credential read');
    await until(async()=>!!(await invokeGetTerminalBrokerSnapshot(session.sessionId)).session?.promptReady,'Real native prompt did not recover after interactive stop');
    assert(controller.terminal.buffer.active.type==='normal'&&controller.terminal.options.reflowCursorLine===false,'Interactive stop left the native display/alternate buffer active');
    assert(controller.terminal.getSelection===original.selection&&controller.terminal.buffer.normal.getLine===original.line&&controller.terminal.open===original.open,'Interactive execution overrode public terminal APIs');
    await report({progress:'Actual native REPL/TUI/credential redaction and dedicated input lease passed',evidence:{kind:'actual-native-interactive-production',initial,observations,leases,raw,calls,results:await Promise.all(results.map(read)),credentialInputBlocked:true,publicApisUnmodified:true}});
  }catch(error){await report({progress:'Actual native interactive failure retained before cleanup',evidence:{failed:true,reason:error instanceof Error?error.message:String(error),calls,results:await Promise.allSettled(results.map(read)),observations,leases,raw,broker:terminalId?await invokeGetTerminalBrokerSnapshot(terminalId):undefined}});throw error;}
  finally{disposers.forEach(dispose=>dispose());if(created){await invokeCancelAgentRuntime({sessionId:id});await invokeArchiveAgentRuntimeSession({sessionId:id});await invokeDeleteAgentRuntimeSession({sessionId:id});}root.unmount();if(terminalId){await invokeCloseSession(terminalId);terminalRegistry.dispose(terminalId);}host.remove();}
}
void verify().then(()=>({ok:true}),(error:unknown)=>({ok:false,error:error instanceof Error?`${error.message}\n${error.stack??''}`:String(error)})).then(value=>fetch(`/__agent-stream-result/${new URL(location.href).searchParams.get('token')}`,{method:'POST',body:JSON.stringify(value)}));
