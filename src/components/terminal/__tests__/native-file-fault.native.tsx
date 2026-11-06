import {createRoot} from 'react-dom/client';
import {getCurrentWindow} from '@tauri-apps/api/window';
import {TerminalControllerLayer} from '../terminal-controller-layer';
import {terminalRegistry} from '../registry/terminal-registry';
import {useTerminalStore} from '@/stores/terminalStore';
import {initI18n} from '@/locales';
import {isCurrentNativeEditorProfile} from './native-editor-profile';
import {matchesNativeFileChainStep} from './native-file-chain-approval';
import {invokeCreateLocalSession,invokeCloseSession,invokeGetTerminalBrokerSnapshot,invokeListAiRoutes,invokeCreateAgentRuntimeSession,invokeStartAgentRuntime,invokeAgentRuntimeFollowup,invokeCancelAgentRuntime,invokeArchiveAgentRuntimeSession,invokeGetPendingAgentRuntimeApprovalArguments,invokeApproveAgentRuntimeTool,listenToAgentRuntimeSession,listenToTerminalIntegrationState} from '@/lib/ipc/tauri';
import type {AgentSessionEvent} from '@/types/agent-session';
import type {TerminalIntegrationStateEvent} from '@/types';
import '@/styles/base.css';

function assert(value:unknown,message:string):asserts value{if(!value)throw Error(message);}
function object(value:unknown):Record<string,unknown>{assert(value&&typeof value==='object'&&!Array.isArray(value),'Expected structured witness');return value as Record<string,unknown>;}
async function until(test:()=>boolean|Promise<boolean>,message:string){const end=Date.now()+180000;while(!await test()){assert(Date.now()<end,message);await new Promise(resolve=>setTimeout(resolve,10));}}
async function verify(){
 const parameters=new URL(location.href).searchParams,token=parameters.get('token'),mode=parameters.get('fileFault');
 assert(token&&/^[a-f0-9-]{36}$/.test(token)&&(mode==='occupied-directory'||mode==='existing-file'),'Owned scratch fault parameters missing');
 await initI18n('en-US');await getCurrentWindow().show();await getCurrentWindow().setFocus();const root=createRoot(document.getElementById('root')!);root.render(<TerminalControllerLayer/>);const host=document.createElement('div');host.style.cssText='width:100vw;height:100vh';document.body.append(host);
 const id='agent-file-fault-'+crypto.randomUUID(),events:AgentSessionEvent[]=[],observations:TerminalIntegrationStateEvent[]=[],dispose:(()=>void)[]=[],reserved=new Set<string>(),prewrite:unknown[]=[];
 const original=`Write-Output 'SCRATCH_ORIGINAL_${token}'`,replacement=`Write-Output 'SCRATCH_REPLACEMENT_${token}'`,fileName=`acceptance-${token}.ps1`,expectedCalls=mode==='existing-file'?2:1;
 let terminalId:string|undefined,created=false,failure:string|undefined,raw='';let injection:unknown;
 const report=(value:unknown)=>fetch(`/__agent-stream-result/${token}`,{method:'POST',body:JSON.stringify(value)});
 const witness=async()=>{const response=await fetch(`/__native-file-witness/${token}`);assert(response.ok,'Scratch witness unavailable');return object(await response.json());};
 try{
  const session=await invokeCreateLocalSession(100,30);terminalId=session.sessionId;useTerminalStore.getState().addSession(session);await until(()=>!!terminalRegistry.get(session.sessionId),'Terminal controller missing');const controller=terminalRegistry.get(session.sessionId)!;controller.attach(host);await controller.whenOutputReady();
  await until(async()=>!!(await invokeGetTerminalBrokerSnapshot(session.sessionId)).session?.promptReady,'Native prompt not ready');const before=await invokeGetTerminalBrokerSnapshot(session.sessionId);assert(before.session?.inputMode==='native-inline'&&isCurrentNativeEditorProfile(before.session.nativePeerProfile,parameters.get('nativeP3')),'Actual native profile missing');const cwd=before.session.currentDirectory;assert(cwd,'Actual cwd missing');const target={kind:'local' as const,targetId:`terminal-${session.sessionId}`,sessionId:session.sessionId,cwd};
  dispose.push(controller.subscribeOutput(value=>{if(raw.length<262144)raw+=value;}));dispose.push(await listenToTerminalIntegrationState(({payload})=>{if(payload.sessionId===session.sessionId)observations.push(payload);}));
  const expectedContent=(index:number)=>mode==='existing-file'&&index===0?original:replacement;
  const matches=(index:number,name:string,args:unknown)=>index<expectedCalls&&matchesNativeFileChainStep(1,name,args,{fileName,content:expectedContent(index),setup:''});
  dispose.push(await listenToAgentRuntimeSession(({payload})=>{
   if(payload.sessionId!==id)return;events.push(payload);
   try{if(payload.type==='tool/call'){const index=events.filter(event=>event.type==='tool/call').length-1;assert(matches(index,payload.data.call.name,payload.data.call.arguments),'Unexpected file fault call');}}
   catch(error){failure=String(error);}
   if(payload.type==='tool/approval'&&payload.data.status==='requested')void(async()=>{
    const {approvalId,callId,requestId}=payload.data,{turnId,stepId}=payload;assert(approvalId&&turnId&&stepId&&!reserved.has(approvalId),'Duplicate/incomplete approval');reserved.add(approvalId);
    const calls=events.filter((event):event is Extract<AgentSessionEvent,{type:'tool/call'}>=>event.type==='tool/call'),index=calls.findIndex(event=>event.data.call.callId===callId&&event.turnId===turnId&&event.stepId===stepId);assert(mode==='existing-file'&&index===0,'Refused write unexpectedly requested approval');const decision={sessionId:id,approvalId,callId,requestId,turnId,stepId},args=await invokeGetPendingAgentRuntimeApprovalArguments(decision)??calls[index].data.call.arguments;
    assert(!failure&&matches(index,calls[index].data.call.name,args),'Approval differs from original-only write');const state=await witness();assert(Array.isArray(state.files)&&state.files.length===0,'Original file appeared before approval');prewrite.push(state);await invokeApproveAgentRuntimeTool(decision);
   })().catch(error=>{failure=String(error);});
  }));
  if(mode==='occupied-directory'){const response=await fetch(`/__native-file-fault/${token}`,{method:'POST',body:JSON.stringify({id,target})});assert(response.ok,'Owned directory fault injection failed');injection=await response.json();}
  const selection=(await invokeListAiRoutes()).defaultSelection;assert(selection,'Supplied model missing');
  const args=(content:string)=>JSON.stringify({fileScope:'scratch',path:fileName,content,precondition:{mustNotExist:true}});
  const goal=mode==='existing-file'?`Call write_file exactly TWICE in this order, once per call, no retries or other tools. First arguments: ${args(original)}. Wait for its successful result. Second arguments: ${args(replacement)}. The second call deliberately keeps mustNotExist=true and should be refused. Do not fix the precondition, overwrite, delete, read, or execute the script. Then stop.`:`Call write_file exactly ONCE with these exact arguments: ${args(replacement)}. This is a deliberate refusal check. Do not retry, repair, delete, read, or execute anything even if refused. Then stop.`;
  await invokeCreateAgentRuntimeSession({sessionId:id,taskId:id,goal,executionSurface:'boundTerminal',permissionMode:'requestApproval',target,capabilityScope:{toolNames:['write_file'],effects:['stateChange'],targetIds:[target.targetId]}});created=true;await invokeStartAgentRuntime({sessionId:id,selection});const message=crypto.randomUUID();await invokeAgentRuntimeFollowup({sessionId:id,messageId:message,clientSubmissionId:message,content:goal});
  const reason=mode==='occupied-directory'?'AGENT_SCRATCH_DIRECTORY_OCCUPIED':'write_file destination already exists';await until(()=>{assert(!failure,failure??'Fault approval failed');const settled=events.filter((event):event is Extract<AgentSessionEvent,{type:'tool/result'}>=>event.type==='tool/result');if(settled.length!==expectedCalls)return false;const last=settled[expectedCalls-1];assert(last.data.status==='rejected'||last.data.status==='failed','Write unexpectedly completed');return events.some(event=>event.type==='task/state'&&JSON.stringify(event.data).includes(reason))||JSON.stringify(last.data).includes(reason);},'Expected real file refusal missing');await invokeCancelAgentRuntime({sessionId:id});const calls=events.filter(event=>event.type==='tool/call'),results=events.filter((event):event is Extract<AgentSessionEvent,{type:'tool/result'}>=>event.type==='tool/result');assert(calls.length===expectedCalls,'Unexpected extra call');if(mode==='existing-file')assert(results[0].data.status==='completed','Initial approved write failed');const denied=results[expectedCalls-1];assert(denied.data.status==='rejected'||denied.data.status==='failed','Expected write was not refused');
  assert(events.some(event=>event.type==='task/state'&&JSON.stringify(event.data).includes(reason))||JSON.stringify(denied.data).includes(reason),'Actual refusal reason differs from the selected fault');const state=await witness(),after=await invokeGetTerminalBrokerSnapshot(session.sessionId);assert(Array.isArray(state.files)&&state.files.length===1&&object(state.files[0]).content===original,'Existing contents were replaced');assert(Array.isArray(state.effectEntries)&&state.effectEntries.length===0,'Unexpected script effect');assert(before.session.nextInputSequence===after.session?.nextInputSequence,'Agent wrote to the PTY');assert(after.session?.currentDirectory===cwd,'Parent cwd changed');assert(!observations.some(event=>event.inputObservation?.activeCommand?.agentSessionId===id),'Unexpected native input operation');assert(reserved.size===(mode==='existing-file'?1:0),'Unexpected approval count');
  await report({evidence:{kind:'actual-native-file-fault',mode,token,id,target,fileName,original,replacement,before,after,state,injection,prewrite,events,observations,raw},progress:'Actual managed-file refusal verified without overwrite or terminal input.'});
 }catch(error){await report({evidence:{failed:true,mode,id,error:String(error),events,observations,raw,injection,prewrite},progress:'File fault failure retained; no retry.'});throw error;}
 finally{dispose.forEach(fn=>fn());if(created){await invokeCancelAgentRuntime({sessionId:id}).catch(()=>{});await invokeArchiveAgentRuntimeSession({sessionId:id}).catch(()=>{});}if(terminalId){await invokeCloseSession(terminalId);terminalRegistry.dispose(terminalId);}root.unmount();host.remove();}
}
void verify().then(()=>({ok:true}),(error:unknown)=>({ok:false,error:error instanceof Error?error.message:String(error)})).then(value=>fetch(`/__agent-stream-result/${new URL(location.href).searchParams.get('token')}`,{method:'POST',body:JSON.stringify(value)}));
