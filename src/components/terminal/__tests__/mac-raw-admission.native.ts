import {getCurrentWindow} from '@tauri-apps/api/window';
import {terminalRegistry} from '../registry/terminal-registry';
import {terminalInputReadiness} from '../terminal-input-readiness';
import {agentTerminalLeaseState} from '../agent-terminal-lease-state';
import {useTerminalStore} from '@/stores/terminalStore';
import {initI18n} from '@/locales';
import {quotePosixFileSource} from './native-file-chain-posix';
import {delegationOriginalCall} from './native-approval-delegation-plan';
import {invokeCreateLocalSession,invokeCloseSession,invokeGetTerminalBrokerSnapshot,invokeListAiRoutes,
 invokeCreateAgentRuntimeSession,invokeStartAgentRuntime,invokeAgentRuntimeFollowup,invokeApproveAgentRuntimeTool,
 invokeGetPendingAgentRuntimeApprovalArguments,invokeGetAgentRuntimeSession,invokeCancelAgentRuntime,
 invokeArchiveAgentRuntimeSession,invokeDeleteAgentRuntimeSession,listenToAgentRuntimeSession} from '@/lib/ipc/tauri';
import type {AgentSessionEvent,AgentSessionTarget} from '@/types/agent-session';
import '@/styles/base.css';
function assert(x:unknown,m:string):asserts x{if(!x)throw Error(m);}
function object(value:unknown):Record<string,unknown>{assert(value&&typeof value==='object'&&!Array.isArray(value),'Actual raw tool arguments must be an object');return value as Record<string,unknown>;}
async function until(test:()=>boolean|Promise<boolean>,message:string,timeout=10000){const end=Date.now()+timeout;while(!await test()){assert(Date.now()<end,message);await new Promise(done=>setTimeout(done,20));}}
async function verify(){
 const p=new URL(location.href).searchParams,token=p.get('token'),family=p.get('rawFamily');assert(token&&['bash','zsh'].includes(family??''),'Exact owned raw parameters missing');
 await initI18n('en-US');await getCurrentWindow().show();
 const witness=async()=>{const response=await fetch(`/__native-raw-admission/${token}/status`);assert(response.ok,'Owned raw witness unavailable');return await response.json() as {home:string;effectPath:string;effectPresent:boolean};};
 const initialWitness=await witness();assert(initialWitness.effectPath===initialWitness.home+'/raw-agent-effect'&&!initialWitness.effectPresent,'Raw effect path not fresh');
 const source="printf '%s%s\\n' RAW_AGENT_ EXECUTED > "+quotePosixFileSource(initialWitness.effectPath);
 const host=document.createElement('div');host.style.cssText='width:1100px;height:650px';document.body.append(host);
 const id='agent-raw-admission-'+crypto.randomUUID(),events:AgentSessionEvent[]=[],dispose:(()=>void)[]=[];
 let controller:ReturnType<typeof terminalRegistry.create>|undefined,terminalId:string|undefined,created=false,raw='',failure:string|undefined,ended=false;
 let evidence:Record<string,unknown>|undefined,problem:unknown;
 try {
  const session=await invokeCreateLocalSession(100,30);terminalId=session.sessionId;useTerminalStore.getState().addSession(session);
  assert(session.ptyInfo?.inputMode==='raw'&&!session.ptyInfo.nativeDisplayBinding,'Actual system Shell did not negotiate raw');
  controller=terminalRegistry.create(session.sessionId,(id,e)=>useTerminalStore.getState().setStatus(id,e),(id,e)=>useTerminalStore.getState().setClosed(id,e),id=>useTerminalStore.getState().sessions.find(s=>s.sessionId===id)?.status??'connecting',()=>{},session.ptyInfo);
  controller.attach(host);await controller.whenOutputReady();
  await until(()=>!terminalInputReadiness.isPreparing(session.sessionId)&&useTerminalStore.getState().sessions.find(s=>s.sessionId===session.sessionId)?.status==='connected','Actual raw input not ready');
  dispose.push(controller.subscribeOutput(chunk=>{assert(raw.length+chunk.length<131072,'Raw capture limit');raw+=chunk;}));
  assert(await controller.writeUserInput("printf '%s%s\\n' RAW_USER_ READY; printf '%s\\n' \"$PWD\"\r"),'Actual raw ordinary input unavailable');
  await until(()=>raw.includes('RAW_USER_READY')&&raw.includes(initialWitness.home),'Actual raw Shell cwd/output differs');
  const beforeSnapshot=await invokeGetTerminalBrokerSnapshot(session.sessionId),before=beforeSnapshot.session;
  const repeated=(await invokeGetTerminalBrokerSnapshot(session.sessionId)).session;
  assert(before&&repeated&&before.inputMode==='raw'&&!before.nativePeerProfile&&before.integrationState!=='ready','Raw state gained native authority');
  assert(beforeSnapshot.rollout.enabled&&beforeSnapshot.shellIntegrationRollout.enabled&&beforeSnapshot.terminalExecuteRollout.enabled,'Raw negative case requires enabled production execution gates');
  assert(repeated.inputMode==='raw'&&repeated.nextInputSequence===before.nextInputSequence,'Read-only snapshot changed raw admission/input');
  const target:AgentSessionTarget={kind:'local',targetId:'terminal-'+session.sessionId,sessionId:session.sessionId,cwd:initialWitness.home};
  dispose.push(await listenToAgentRuntimeSession(({payload})=>{
   if(payload.sessionId!==id)return;if(payload.type!=='assistant/chunk')events.push(payload);
   if(payload.type==='request/failure')failure='Actual model request failed: '+payload.data.failure.kind;
   if(payload.type==='turn/end')ended=true;
   if(payload.type==='tool/call')try{const original=delegationOriginalCall(events,payload),args=object(original.arguments);
    assert(payload.data.call.name==='run_terminal_command'&&original.name==='run_terminal_command'&&events.filter(e=>e.type==='tool/call').length===1,'Raw model used another tool or retried');
    assert(args.command===source&&(args.background===undefined||args.background===false)&&(args.lifecycleTrust===undefined||args.lifecycleTrust==='cooperative'),'Original raw model changed fixed source/surface');
   }catch(error){failure=String(error);}
   if(payload.type==='tool/approval'&&payload.data.status==='requested')void(async()=>{
    assert(!failure,failure??'Invalid original proposal');const {approvalId,callId,requestId}=payload.data,{turnId,stepId}=payload;assert(approvalId&&turnId&&stepId,'Raw approval identity incomplete');
    const decision={sessionId:id,approvalId,callId,requestId,turnId,stepId},pending=await invokeGetPendingAgentRuntimeApprovalArguments(decision);
    if(pending!==undefined&&pending!==null)assert(object(pending).command===source,'Raw approval source differs');await invokeApproveAgentRuntimeTool(decision);
   })().catch(error=>{failure=String(error);});
  }));
  const selection=(await invokeListAiRoutes()).defaultSelection;assert(selection,'Actual configured raw-negative model missing');
  const goal=`This is an owned negative admission test. Call run_terminal_command exactly ONCE with ${JSON.stringify({command:source,background:false,timeoutMs:5000})}. The bound terminal is raw and the runtime must refuse before input. Preserve the source and every declared value. Do not switch to Direct, use other tools, retry, repair, or execute any alternative. Then stop.`;
  const createdSnapshot=await invokeCreateAgentRuntimeSession({sessionId:id,taskId:id,goal,executionSurface:'boundTerminal',permissionMode:'requestApproval',target,capabilityScope:{toolNames:['run_terminal_command'],effects:['stateChange','externalSideEffect'],targetIds:[target.targetId]}});created=true;
  await invokeStartAgentRuntime({sessionId:id,selection});const message=crypto.randomUUID();await invokeAgentRuntimeFollowup({sessionId:id,messageId:message,clientSubmissionId:message,content:goal});
  await until(()=>{assert(!failure,failure??'Raw model failed');return ended;},'Actual raw negative model turn did not end',180000);
  const calls=events.filter(e=>e.type==='tool/call'),results=events.filter((e):e is Extract<AgentSessionEvent,{type:'tool/result'}>=>e.type==='tool/result');
  assert(calls.length===1&&results.length===1&&results[0].data.status!=='completed','Raw call was not refused exactly once');
  assert(results[0].data.summary.startsWith('TERMINAL_VISIBLE_COMMAND_UNAVAILABLE:'),'Refusal was not the actual raw cooperative preparation boundary');
  const refusal=object(results[0].data.data);assert(refusal.code==='TOOL_PREPARATION_REJECTED'&&refusal.phase==='preparation'&&refusal.execution==='notStarted'&&refusal.executed===false,'Raw preparation refusal lacks explicit not-started evidence');
  const after=(await invokeGetTerminalBrokerSnapshot(session.sessionId)).session;
  assert(after&&after.inputMode==='raw'&&after.nextInputSequence===before.nextInputSequence&&!after.inputObservation?.activeCommand&&!after.inputObservation?.nativeRecoveryRequired,'Raw rejection sent input or created uncertain native work');
  assert(!(await witness()).effectPresent,'Rejected raw source created its owned effect');
  const snapshot=await invokeGetAgentRuntimeSession({sessionId:id});assert(snapshot.header.executionSurface==='boundTerminal'&&JSON.stringify(snapshot.header.target)===JSON.stringify(target),'Raw execution silently changed its frozen target/surface');
  await invokeCancelAgentRuntime({sessionId:id});await until(()=>!agentTerminalLeaseState.get(session.sessionId),'Refused raw model retained input ownership');
  assert(await controller.writeUserInput("printf '%s%s\\n' RAW_USER_ RECOVERED\r"),'Ordinary raw input failed after model rejection');
  await until(()=>raw.includes('RAW_USER_RECOVERED'),'Raw user recovery output missing');
  assert(!(await witness()).effectPresent&&!raw.includes('RAW_AGENT_EXECUTED'),'Raw source ran despite rejection');
  evidence={kind:'actual-macos-unsupported-shell-raw-admission',family,selection,source,target,createdSnapshot,beforeSnapshot,before,repeated,after,snapshot,events,raw,effectPresent:false,ordinaryUserRecovered:true};
 }catch(error){problem=error;}
 finally {
  if(created){try{await invokeCancelAgentRuntime({sessionId:id});await invokeArchiveAgentRuntimeSession({sessionId:id});await invokeDeleteAgentRuntimeSession({sessionId:id});}catch(error){problem??=error;}}
  if(terminalId)try{await invokeCloseSession(terminalId);}catch(error){problem??=error;}
  if(controller)terminalRegistry.dispose(controller.sessionId);dispose.forEach(f=>f());host.remove();
 }
 await fetch(`/__agent-stream-result/${token}`,{method:'POST',body:JSON.stringify({progress:problem?'Actual raw admission failure retained':'Actual unsupported system Shell refused model source before input and preserved user input',evidence:{...evidence,family,source,terminalId,failed:!!problem,reason:problem?String(problem):undefined,events,raw}})});
 if(problem)throw problem;
}
void verify().then(()=>({ok:true}),(e:unknown)=>({ok:false,error:String(e)})).then(v=>fetch(`/__agent-stream-result/${new URL(location.href).searchParams.get('token')}`,{method:'POST',body:JSON.stringify(v)}));
