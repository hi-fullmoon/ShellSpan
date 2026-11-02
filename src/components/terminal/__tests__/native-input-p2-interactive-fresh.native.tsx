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
  const parameters=new URL(location.href).searchParams;const token=parameters.get('token');const nativeP3=parameters.get('nativeP3');
  assert(!nativeP3||nativeP3==='zsh','This existing POSIX interactive program requires the actual selected Zsh');
  const report=(value:unknown)=>fetch(`/__agent-stream-result/${token}`,{method:'POST',body:JSON.stringify(value)});
  const root=createRoot(document.getElementById('root')!);useAppStore.setState({activeSection:'terminal',restoreWorkspace:false});root.render(<TerminalControllerLayer/>);
  const host=document.createElement('div');host.style.cssText='width:1100px;height:650px';document.body.append(host);
  const id=`agent-native-interactive-${crypto.randomUUID()}`;let activeId=id,terminalId:string|undefined,ended=false,failure:string|undefined,raw='';
  const knownIds=new Set([id]);const createdIds:string[]=[];
  let credentialRefusalExpected=false;
  const calls:Extract<AgentSessionEvent,{type:'tool/call'}>[]=[];const results:Extract<AgentSessionEvent,{type:'tool/result'}>[]=[];
  const observations:TerminalIntegrationStateEvent[]=[];const leases:unknown[]=[];const disposers:(()=>void)[]=[];
  const command="printf '%s%s\\n' NATIVE_INTERACTIVE_ BASELINE";
  const allowedText=new Set(['interactive-value','y','SHOULD_NOT_WRITE']);
  async function read(event:Extract<AgentSessionEvent,{type:'tool/result'}>){
    let value:unknown=event.data.data;
    if(value&&typeof value==='object'&&'artifactRef'in value&&typeof value.artifactRef==='string'){
      const artifact=await invokeGetAgentRuntimeArtifact({sessionId:event.sessionId,artifactId:value.artifactRef,maxBytes:16*1024*1024});assert(!artifact.truncated,'Actual interactive result artifact was truncated');
      const bytes=Uint8Array.from(atob(artifact.bodyBase64),character=>character.charCodeAt(0));const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');assert(hash===artifact.metadata.sha256,'Actual interactive artifact integrity failed');value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    }
    return value;
  }
  try{
    const session=await invokeCreateLocalSession(100,30);terminalId=session.sessionId;useTerminalStore.getState().addSession(session);
    await until(()=>!!terminalRegistry.get(session.sessionId),'Actual native controller missing');const controller=terminalRegistry.get(session.sessionId)!;controller.attach(host);await controller.whenOutputReady();
    const initial=(await invokeGetTerminalBrokerSnapshot(session.sessionId)).session;assert(initial?.inputMode==='native-inline'&&initial.integrationState==='ready','New native initialization was not used');
    if(nativeP3)assert(initial.nativePeerProfile?.shell==='zsh'&&initial.nativePeerProfile.editor==='zle','Interactive acceptance selected a different native editor');
    const original={selection:controller.terminal.getSelection,line:controller.terminal.buffer.normal.getLine,open:controller.terminal.open};
    disposers.push(controller.subscribeOutput(chunk=>{raw+=chunk;}));
    disposers.push(await listenToTerminalIntegrationState(({payload})=>{if(payload.sessionId===session.sessionId)observations.push(payload);}));
    disposers.push(await listenToAgentTerminalLease(({payload})=>{if(payload.sessionId===session.sessionId)leases.push(payload);}));
    disposers.push(await listenToAgentRuntimeSession(({payload})=>{
      if(!knownIds.has(payload.sessionId))return;
      if(payload.type==='tool/call')calls.push(payload);if(payload.type==='tool/result'){
        results.push(payload);
        const call=calls.find(value=>value.sessionId===payload.sessionId&&value.turnId===payload.turnId&&value.stepId===payload.stepId&&value.data.call.callId===payload.data.callId)?.data.call;
        if(!call)failure='Actual tool result has no matching session/turn/step/call identity';
        const expectedRefusal=credentialRefusalExpected&&call?.name==='write_terminal_input';
        if(payload.data.status!=='completed'&&!expectedRefusal)failure=`${payload.data.name}: ${payload.data.summary}`;
      }if(payload.type==='turn/end'&&payload.sessionId===activeId)ended=true;
      if(payload.type==='request/failure'&&payload.sessionId===activeId)failure=`${payload.data.failure.kind}: ${redactTerminalSecrets(payload.data.failure.message)}`;
      if(payload.type==='tool/approval'&&payload.data.status==='requested'){
        const {approvalId,callId,requestId}=payload.data;const {turnId,stepId}=payload;assert(approvalId&&turnId&&stepId,'Actual interactive approval identity missing');const decision={sessionId:payload.sessionId,approvalId,callId,requestId,turnId,stepId};
        void(async()=>{const args=await invokeGetPendingAgentRuntimeApprovalArguments(decision)??calls.find(value=>value.sessionId===payload.sessionId&&value.turnId===turnId&&value.stepId===stepId&&value.data.call.callId===callId)?.data.call.arguments;assert(args&&typeof args==='object','Actual interactive arguments missing');
          if('command'in args)assert(args.command===command,'Approval escaped the exact native baseline command');
          else if('inputKind'in args)assert(args.inputKind==='text'&&'text'in args&&typeof args.text==='string'&&allowedText.has(args.text)||args.inputKind==='key'&&'key'in args&&args.key==='enter','Approval escaped controlled real interactive input');
          await invokeApproveAgentRuntimeTool(decision);
        })().catch(error=>{failure=error instanceof Error?error.message:String(error);});
      }
    }));
    const selection=(await invokeListAiRoutes()).defaultSelection;assert(selection,'Real configured model required');
    const goal=`Call run_terminal_command once with command=${JSON.stringify(command)} and reply done. No extra tools or retries.`;
    await invokeCreateAgentRuntimeSession({sessionId:id,taskId:id,goal,executionSurface:'boundTerminal',permissionMode:'requestApproval',target:{kind:'local',targetId:`terminal-${session.sessionId}`,sessionId:session.sessionId,cwd:initial.currentDirectory},capabilityScope:{toolNames:['run_terminal_command','read_terminal','write_terminal_input','wait_terminal'],effects:['none','readOnly','sensitiveRead','stateChange','externalSideEffect'],targetIds:[`terminal-${session.sessionId}`]}});createdIds.push(id);
    await invokeStartAgentRuntime({sessionId:id,selection});
    const send=async(content:string)=>{const message=crypto.randomUUID();await invokeAgentRuntimeFollowup({sessionId:activeId,messageId:message,clientSubmissionId:message,content});};
    await send(goal);await until(()=>{assert(!failure,failure??'Initial real native execution failed');return ended;},'Initial model turn did not end');
    assert(results.length===1&&results[0].data.status==='completed','Initial actual native tool failed');
    assert(observations.some(value=>value.inputObservation?.activeCommand?.fullInputConfirmed&&value.inputObservation.activeCommand.submissionIntentDurable),'Initial actual NIP complete proof/durable intent was not observed');
    await until(()=>!agentTerminalLeaseState.get(session.sessionId),'Initial turn did not release real input ownership');
    // Same actual native PTY, reusing the mature POSIX REPL/confirmation/alternate
    // buffer/credential-prompt programs from terminal_interactive.rs acceptance.
    const confirmationRead=nativeP3==='zsh'?'read -r -k 1 answer':'read -r -n 1 answer';
    const program=`printf '\\033[?1049h'; printf '%s%s\\n' NATIVE_TUI_ READY; IFS= read -r answer; printf 'INTERACTIVE_ECHO=%s\\n' "$answer"; printf '%s%s [y/N] ' NATIVE_ CONFIRM; IFS= ${confirmationRead}; printf '\\nCONFIRMED=%s\\n' "$answer"; printf '\\033[?1049l'; printf 'Pass%s: ' word; IFS= read -r -s answer; printf '\\nACTUAL_INPUT_LENGTH=%s\\n' "\${#answer}"; printf '%s%s' SECOND_SILENT_ READ; IFS= read -r -s second`;
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
    await send(`Make exactly these FOUR actual bound-terminal calls in order, preserving every JSON property name and value: ${JSON.stringify(steps)}. Each write_terminal_input call MUST use inputKind exactly once; its only other property is text OR key as shown. The property inputinputKind does not exist. Then reply done without further calls. Do not enter any secret or run a command.`);
    await until(()=>{assert(!failure,failure??'Actual interactive sequence failed');return ended;},'Actual interactive model tools did not finish');
    const interactive=results.slice(interactiveStart);assert(interactive.length===4,'The actual REPL/confirmation sequence omitted a tool');
    const values=await Promise.all(interactive.map(read));
    const receipts=values.filter((value):value is {receipt:{operationId:string}}=>!!value&&typeof value==='object'&&'receipt'in value&&!!value.receipt&&typeof value.receipt==='object'&&'operationId'in value.receipt&&typeof value.receipt.operationId==='string');
    assert(receipts.length===3&&new Set(receipts.map(value=>value.receipt.operationId)).size===1,'Real interactive inputs did not share the dedicated interactive lease');
    await until(()=>raw.includes('Password: '),'Actual credential prompt did not appear after alternate-buffer exit');
    // Keep the same real PTY/program. Use an explicit new task for the negative
    // credential probe, so no historical ephemeral input is a source for it.
    // The normal privacy gate remains enabled and no argument is reconstructed
    // or rewritten by this fixture; the real model must generate fresh input.
    const readStart=results.length;ended=false;
    await send('Call read_terminal exactly ONCE, then reply done. The controlled program now shows a credential-like prompt; report no prompt content, and do not enter text or call any other tool.');
    await until(()=>{assert(!failure,failure??'Actual credential screen read failed');return ended;},'Actual credential screen read did not finish');
    assert(results.length===readStart+1&&results[readStart].data.name==='read_terminal','The actual credential screen read was omitted');
    const screen=await read(results[readStart]);assert(screen&&typeof screen==='object'&&'credentialLikePrompt'in screen&&screen.credentialLikePrompt===true,'Actual credential-like screen was not classified');
    // Screen contents are transient by the existing privacy contract; only
    // sanitized metadata persists. Mature Rust acceptance checks the redacted
    // marker itself before that boundary. Never add a logging bypass here.
    assert('contentPersisted'in screen&&screen.contentPersisted===false&&!JSON.stringify(screen).includes('Password:'),'Actual credential-like screen leaked persisted prompt content');
    await invokeCancelAgentRuntime({sessionId:id});
    await until(()=>!agentTerminalLeaseState.get(session.sessionId),'The completed TUI task did not release ownership');
    activeId=`agent-native-credential-${crypto.randomUUID()}`;knownIds.add(activeId);ended=false;
    const credentialGoal='Issue only the explicitly supplied fresh non-secret sentinel call. Never copy historical input or a privacy receipt.';
    await invokeCreateAgentRuntimeSession({sessionId:activeId,taskId:activeId,goal:credentialGoal,executionSurface:'boundTerminal',permissionMode:'requestApproval',target:{kind:'local',targetId:`terminal-${session.sessionId}`,sessionId:session.sessionId,cwd:initial.currentDirectory},capabilityScope:{toolNames:['read_terminal','write_terminal_input'],effects:['none','readOnly','sensitiveRead','stateChange','externalSideEffect'],targetIds:[`terminal-${session.sessionId}`]}});createdIds.push(activeId);
    await invokeStartAgentRuntime({sessionId:activeId,selection});
    const refusalStart=results.length;const refusalCalls=calls.length;credentialRefusalExpected=true;ended=false;
    await send('Create exactly ONE fresh write_terminal_input call from this new instruction with arguments {"inputKind":"text","text":"SHOULD_NOT_WRITE"}, then stop. Only these two properties are allowed. This is a public non-secret sentinel in an owned test program; it is not historical input. The existing credential gate must refuse it. Do not copy a privacy receipt, retry, enter any password, or call any other tool.');
    await until(()=>results.length>refusalStart,'Actual credential-gate attempt did not return');
    await invokeCancelAgentRuntime({sessionId:activeId});
    assert(calls.length===refusalCalls+1&&calls[refusalCalls].data.call.name==='write_terminal_input','The model retried the refused credential input');
    assert(results[refusalStart].data.status!=='completed'&&/credential|凭据/i.test(results[refusalStart].data.summary),'Actual credential input was not refused');assert(!raw.includes('SHOULD_NOT_WRITE'),'Forbidden credential input reached the actual PTY');
    assert(raw.includes('INTERACTIVE_ECHO=interactive-value')&&raw.includes('CONFIRMED=y'),'Real REPL/confirmation input was not delivered');
    await invokeCancelAgentRuntime({sessionId:activeId});
    await until(()=>!agentTerminalLeaseState.get(session.sessionId),'Credential rejection did not release the dedicated interactive lease');
    const countOffset=raw.length;
    assert(await controller.writeUserInput('\r'),'Actual user could not finish the silent read');
    await until(()=>raw.slice(countOffset).includes('SECOND_SILENT_READ'),'Actual silent read did not return its input length');
    assert(raw.slice(countOffset).includes('ACTUAL_INPUT_LENGTH=0\r\n'),'Refused input reached the no-echo read despite absent visible echo');
    assert(await controller.writeUserInput('\u0003'),'Actual user could not interrupt the credential read');
    await until(async()=>!!(await invokeGetTerminalBrokerSnapshot(session.sessionId)).session?.promptReady,'Real native prompt did not recover after interactive stop');
    assert(controller.terminal.buffer.active.type==='normal'&&controller.terminal.options.reflowCursorLine===false,'Interactive stop left the native display/alternate buffer active');
    assert(controller.terminal.getSelection===original.selection&&controller.terminal.buffer.normal.getLine===original.line&&controller.terminal.open===original.open,'Interactive execution overrode public terminal APIs');
    await report({progress:'Actual native REPL/TUI and fresh-task credential gate passed on the same PTY',evidence:{kind:'actual-native-interactive-fresh-task-production',agentSessions:createdIds,initial,observations,leases,raw,calls,results:await Promise.all(results.map(read)),credentialInputBlocked:true,publicApisUnmodified:true}});
  }catch(error){await report({progress:'Actual native interactive failure retained before cleanup',evidence:{failed:true,reason:error instanceof Error?error.message:String(error),calls,results:await Promise.allSettled(results.map(read)),resultSummaries:results.map(event=>({sessionId:event.sessionId,turnId:event.turnId,stepId:event.stepId,callId:event.data.callId,status:event.data.status,summary:redactTerminalSecrets(event.data.summary)})),observations,leases,raw,broker:terminalId?await invokeGetTerminalBrokerSnapshot(terminalId):undefined}});throw error;}
  finally{disposers.forEach(dispose=>dispose());for(const sessionId of createdIds.reverse()){await invokeCancelAgentRuntime({sessionId});await invokeArchiveAgentRuntimeSession({sessionId});await invokeDeleteAgentRuntimeSession({sessionId});}root.unmount();if(terminalId){await invokeCloseSession(terminalId);terminalRegistry.dispose(terminalId);}host.remove();}
}
void verify().then(()=>({ok:true}),(error:unknown)=>({ok:false,error:error instanceof Error?`${error.message}\n${error.stack??''}`:String(error)})).then(value=>fetch(`/__agent-stream-result/${new URL(location.href).searchParams.get('token')}`,{method:'POST',body:JSON.stringify(value)}));
