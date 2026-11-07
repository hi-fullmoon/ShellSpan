import {createRoot} from 'react-dom/client';
import {getCurrentWindow} from '@tauri-apps/api/window';
import {TerminalControllerLayer} from '../terminal-controller-layer';
import {terminalRegistry} from '../registry/terminal-registry';
import {agentTerminalLeaseState} from '../agent-terminal-lease-state';
import {useTerminalStore} from '@/stores/terminalStore';
import {initI18n} from '@/locales';
import {delegationOriginalCall} from './native-approval-delegation-plan';
import {zleHistoryArgumentJson} from './native-zle-history-plan';
import {invokeCreateLocalSession,invokeCloseSession,invokeGetTerminalBrokerSnapshot,invokeListAiRoutes,
 invokeCreateAgentRuntimeSession,invokeAgentRuntimeFollowup,invokeStartAgentRuntime,invokeApproveAgentRuntimeTool,
 invokeGetPendingAgentRuntimeApprovalArguments,invokeCancelAgentRuntime,invokeArchiveAgentRuntimeSession,
 invokeGetAgentRuntimeArtifact,listenToAgentRuntimeSession,listenToTerminalIntegrationState} from '@/lib/ipc/tauri';
import type {AgentSessionEvent} from '@/types/agent-session';
import type {TerminalIntegrationStateEvent} from '@/types';
import '@/styles/base.css';

function assert(value:unknown,message:string):asserts value{if(!value)throw Error(message);}
function object(value:unknown):Record<string,unknown>{assert(value&&typeof value==='object'&&!Array.isArray(value),'Structured actual evidence required');return value as Record<string,unknown>;}
async function until(test:()=>boolean|Promise<boolean>,message:string,timeout=180000){const end=Date.now()+timeout;while(!await test()){assert(Date.now()<end,message);await new Promise(resolve=>setTimeout(resolve,10));}}
async function verify(){
 const parameters=new URL(location.href).searchParams,token=parameters.get('token'),mode=parameters.get('zleHistoryMode');
 assert(token&&parameters.get('nativeP3')==='zsh'&&['default','small','custom','empty','unset','incremental','shared'].includes(mode??''),'Exact isolated ZLE history case required');
 await initI18n('en-US');await getCurrentWindow().show();
 const root=createRoot(document.getElementById('root')!);root.render(<TerminalControllerLayer/>);
 await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
 const host=document.createElement('div');host.style.cssText='width:100vw;height:100vh';document.getElementById('root')!.append(host);
 const observations:TerminalIntegrationStateEvent[]=[],events:AgentSessionEvent[]=[],cases:unknown[]=[],snapshots:Record<string,unknown>[]=[],dispose:(()=>void)[]=[],agents:string[]=[];
 let terminalId:string|undefined,raw='',failure:string|undefined;
 const report=(evidence:unknown,progress:string)=>fetch(`/__agent-stream-result/${token}`,{method:'POST',body:JSON.stringify({evidence,progress})});
 const readEndpoint=async(name:string)=>{const response=await fetch(`/__native-zle-history/${token}/${name}`);assert(response.ok,'Owned public history observation failed');return object(await response.json());};
 try{
  const plan=await readEndpoint('profile');assert(plan.mode===mode&&Array.isArray(plan.seedSources),'History profile differs');
  const session=await invokeCreateLocalSession(100,30);terminalId=session.sessionId;useTerminalStore.getState().addSession(session);
  await until(()=>!!terminalRegistry.get(session.sessionId),'Actual history controller missing');
  const controller=terminalRegistry.get(session.sessionId)!;controller.attach(host);await controller.whenOutputReady();
  const bounds=host.getBoundingClientRect();assert(bounds.top>=0&&bounds.bottom<=innerHeight&&bounds.width>0,'Actual history terminal outside viewport');
  await until(async()=>!!(await invokeGetTerminalBrokerSnapshot(session.sessionId)).session?.promptReady,'Actual history prompt missing',30000);
  const before=(await invokeGetTerminalBrokerSnapshot(session.sessionId)).session;
  assert(before?.nativePeerProfile?.shell==='zsh'&&before.inputMode==='native-inline','Wrong actual history editor');
  dispose.push(controller.subscribeOutput(value=>{assert(raw.length+value.length<1048576,'History capture limit');raw+=value;}));
  dispose.push(await listenToTerminalIntegrationState(({payload})=>{if(payload.sessionId===session.sessionId)observations.push(payload);}));
  const configured=(await invokeListAiRoutes()).defaultSelection;assert(configured,'Actual configured model required');const selection=configured;
  let expected=plan.persistent===true?[...plan.seedSources]:[];
  let lastObservation=-1;
  const snapshot=async()=>{
   assert(!agentTerminalLeaseState.get(session.sessionId),'History witness requires released ownership');
   await until(async()=>!!(await invokeGetTerminalBrokerSnapshot(session.sessionId)).session?.promptReady,'Prompt missing before passive history observation',10000);
   let actual:Record<string,unknown>|undefined;await until(async()=>{const value=await readEndpoint('current');if(value.ready&&typeof value.index==='number'&&value.index>lastObservation&&JSON.stringify(value.entries)===JSON.stringify(expected)&&object(value.editor).buffer===''){actual=value;return true;}return false;},'Fresh passive ZLE history does not match original accepted sources',10000);
   assert(actual&&typeof actual.index==='number','Passive public ZLE observation missing');lastObservation=actual.index;
   assert(object(actual.editor).buffer===''&&object(actual.editor).cursor==='0','Actual passive observer did not see an empty editor');
   if(snapshots.length)assert(JSON.stringify(actual.configuration)===JSON.stringify(snapshots[0].configuration),'Native operation changed history configuration');
   snapshots.push(actual);return actual;
  };
  await snapshot();
  const id='agent-zle-history-'+crypto.randomUUID();let started=false;
  async function call(name:string,args:Record<string,unknown>,cancel=false){
   const eventStart=events.length;
   const localEvents=()=>events.slice(eventStart).filter(event=>event.sessionId===id);
   const source=typeof args.command==='string'?args.command:undefined;
   const goal=`Call ${name} exactly ONCE. Copy this exact JSON object directly as the function argument payload: ${zleHistoryArgumentJson(args)}. Its Unicode escapes are already valid JSON: keep those escapes unchanged in the payload and let normal JSON parsing decode them. Do not manually render or re-encode the Unicode. Preserve every declared parameter. Nonzero command exit statuses are intentional. No other tools, retries, repair or Direct execution. Then reply done.`;
   const approved:string[]=[],reserved=new Set<string>();
   const stop=await listenToAgentRuntimeSession(({payload})=>{
    if(payload.sessionId!==id)return;
    // Collect before validating in this same ordered subscription. Independent
    // subscribers are not required to run in registration order.
    if(payload.type!=='assistant/chunk')events.push(payload);
    if(payload.type==='request/failure')failure??='Actual configured model request failed';
    if(payload.type==='tool/call')try{
     const original=delegationOriginalCall(localEvents(),payload),value=object(original.arguments),prepared=object(payload.data.call.arguments);
     const callCount=localEvents().filter(event=>event.type==='tool/call').length;
     assert(payload.data.call.name===name&&callCount===1,`Unexpected actual tool ${payload.data.call.name} or call count ${callCount}`);
     for(const [key,expectedValue]of Object.entries(args)){
      assert(value[key]===expectedValue,'Original model changed a fixed history argument');
      if(key==='background'&&expectedValue===false)assert(prepared[key]===undefined||prepared[key]===false,'Prepared command changed foreground mode');
      else assert(prepared[key]===expectedValue,'Prepared command changed a fixed argument');
     }
    }catch(error){failure??=String(error);}
    if(payload.type==='tool/approval'&&payload.data.status==='requested')void(async()=>{
     assert(!failure,failure??'Invalid proposal');const {approvalId,callId,requestId}=payload.data,{turnId,stepId}=payload;
     assert(approvalId&&turnId&&stepId&&!reserved.has(approvalId),'Incomplete or duplicate approval');reserved.add(approvalId);
     const decision={sessionId:id,approvalId,callId,requestId,turnId,stepId},pending=await invokeGetPendingAgentRuntimeApprovalArguments(decision);
     if(pending&&source)assert(object(pending).command===source,'Pending source differs');
     await invokeApproveAgentRuntimeTool(decision);approved.push(callId);
    })().catch(error=>{failure??=String(error);});
   });
   let data:Record<string,unknown>|undefined,visibleTyping:unknown;
   try{
    if(!started){
     await invokeCreateAgentRuntimeSession({sessionId:id,taskId:id,goal,executionSurface:'boundTerminal',permissionMode:'requestApproval',target:{kind:'local',targetId:'terminal-'+session.sessionId,sessionId:session.sessionId,cwd:before?.currentDirectory},capabilityScope:{toolNames:['run_terminal_command','wait_process','kill_process'],effects:['none','readOnly','stateChange','externalSideEffect'],targetIds:['terminal-'+session.sessionId]}});
     agents.push(id);await invokeStartAgentRuntime({sessionId:id,selection});started=true;
    }
    const message=crypto.randomUUID();await invokeAgentRuntimeFollowup({sessionId:id,messageId:message,clientSubmissionId:message,content:goal});
    if(cancel){
     const prefix="builtin printf '%s' 'APP_HISTORY_CANCEL_";
     await until(()=>{assert(!failure,failure??'Cancelled source failed');const active=observations[observations.length-1]?.inputObservation?.activeCommand;if(active?.agentSessionId!==id||active.phase!=='typing'||active.fullInputConfirmed||!active.sourceMayBeEnqueued)return false;if(!controller.searchAddon.findNext(prefix))return false;const selected=controller.terminal.getSelection();controller.terminal.clearSelection();if(selected!==prefix)return false;visibleTyping={operationId:active.operationId,actualVisiblePrefix:selected};return true;},'Visible native cancellation prefix missing');
     await invokeCancelAgentRuntime({sessionId:id});
     await until(()=>observations.some(value=>{const active=value.inputObservation?.activeCommand;return active?.agentSessionId===id&&active.draftCleared&&!active.mayHaveSubmitted&&!active.submissionIntentDurable;}),'Actual history draft clear missing',15000);
     assert((await readEndpoint('effect')).exists===false,'Cancelled history command executed');
    }else{
     await until(()=>{assert(!failure,failure??'History tool failed');return localEvents().some(event=>event.type==='turn/end');},'Actual model history turn did not end');
     const results=localEvents().filter((event):event is Extract<AgentSessionEvent,{type:'tool/result'}>=>event.type==='tool/result');
     assert(results.length===1&&results[0].data.status==='completed','Actual history tool did not complete once');
     let value:unknown=results[0].data.data;
     if(value&&typeof value==='object'&&'artifactRef'in value&&typeof value.artifactRef==='string'){
      const artifact=await invokeGetAgentRuntimeArtifact({sessionId:id,artifactId:value.artifactRef,maxBytes:1048576});assert(!artifact.truncated,'Actual result artifact truncated');
      const bytes=Uint8Array.from(atob(artifact.bodyBase64),char=>char.charCodeAt(0));const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');assert(digest===artifact.metadata.sha256,'Actual result integrity failed');value=JSON.parse(new TextDecoder().decode(bytes));
     }
     data=object(value);
     if(source){const command=object(data.commandObservation);assert(command.fullInputConfirmed===true&&command.submissionIntentDurable===true&&command.mayHaveSubmitted===true,'Actual native source acceptance missing');expected.push(source);if(mode==='small')expected=expected.slice(-3);}
    }
    await until(()=>!agentTerminalLeaseState.get(session.sessionId),'History ownership not released',15000);
    if(source)assert(approved.length===1,'Actual source approval did not bind once');await snapshot();
    cases.push({id,name,args,cancel,approved,data,visibleTyping});return data;
   }finally{stop();}
  }
  const parent="P3_HISTORY_PARENT='父Shell-é-👩🏽‍💻'; (exit 7)";
  const nonzero=await call('run_terminal_command',{command:parent,background:false,timeoutMs:10000});assert(nonzero?.exitCode===7,'Actual source status changed');
  const background='while :; do sleep 1; done';
  const launched=await call('run_terminal_command',{command:background,background:true,timeoutMs:10000});
  assert(typeof launched?.processHandle==='string'&&launched.processHandle.startsWith('job-'),'Actual background job handle missing');
  const preceding=await call('run_terminal_command',{command:'(exit 7)',background:false,timeoutMs:10000});assert(preceding?.exitCode===7,'Actual pre-control nonzero status missing');
  await call('wait_process',{processHandle:launched.processHandle,timeoutMs:1000});
  await call('wait_process',{processHandle:launched.processHandle,timeoutMs:1000});
  await call('kill_process',{processHandle:launched.processHandle,signal:'terminate',timeoutMs:10000});
  const source='builtin printf "APP_PARENT_STATUS=%s:%s\\n" "$?" "$P3_HISTORY_PARENT"; typeset APP_LITERAL="literal!!"; builtin printf "APP_UNICODE:%s\\n" "中文-é-👩🏽‍💻"';
  const recovered=await call('run_terminal_command',{command:source,background:false,timeoutMs:10000});assert(typeof recovered?.combinedOutput==='string'&&recovered.combinedOutput.includes('APP_PARENT_STATUS=7:父Shell-é-👩🏽‍💻'),'Private controls changed actual parent status/environment');
  const single=await call('run_terminal_command',{command:'false',background:false,timeoutMs:10000});assert(single?.exitCode===1,'Single-word source status changed');
  await call('run_terminal_command',{command:`builtin printf '%s' 'APP_HISTORY_CANCEL_${crypto.randomUUID()}' > "$HOME/history-cancel-effect"`,background:false,timeoutMs:10000},true);
  assert(await controller.writeUserInput('exit\r'),'Ordinary user exit blocked');
  await until(()=>useTerminalStore.getState().sessions.find(value=>value.sessionId===session.sessionId)?.status==='disconnected','Actual ordinary history exit did not close Shell',10000);
  const closed=useTerminalStore.getState().sessions.find(value=>value.sessionId===session.sessionId)?.closed;
  await report({kind:'actual-zle-app-model-history',mode,plan,before,selection,cases,snapshots,events,observations,raw,closed,normalUserExit:true,acceptedSources:expected,privateControlCount:3,cancelledSourceAbsent:true,scope:'Actual local ZLE App/model, public history widget and ordinary exit. Shared mode here is one process; multi-process sharing requires independent evidence.'},'Actual ZLE App/model history configuration completed.');
 }catch(error){await report({kind:'actual-zle-app-model-history-failure',failed:true,mode,error:String(error),cases,snapshots,events,observations,raw},'Actual ZLE history failure retained; no replay.');throw error;}
 finally{dispose.forEach(fn=>fn());for(const id of agents){await invokeCancelAgentRuntime({sessionId:id}).catch(()=>{});await invokeArchiveAgentRuntimeSession({sessionId:id}).catch(()=>{});}if(terminalId){await invokeCloseSession(terminalId);terminalRegistry.dispose(terminalId);}root.unmount();host.remove();}
}
void verify().then(()=>({ok:true}),(error:unknown)=>({ok:false,error:error instanceof Error?`${error.message}\n${error.stack??''}`:String(error)})).then(value=>fetch(`/__agent-stream-result/${new URL(location.href).searchParams.get('token')}`,{method:'POST',body:JSON.stringify(value)}));
