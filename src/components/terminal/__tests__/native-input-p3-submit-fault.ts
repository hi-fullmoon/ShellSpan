import {Terminal} from '@xterm/xterm';
import {terminalRegistry} from '../registry/terminal-registry';
import {useTerminalStore} from '@/stores/terminalStore';
import {invokeCancelAgentRuntime,invokeCloseSession,invokeCreateLocalSession,invokeGetTerminalBrokerSnapshot,
 invokeGetTerminalSubmissionRecovery,invokeAgentTerminalLeaseReady,invokeWriteSession} from '@/lib/ipc/tauri';
import type {TerminalIntegrationStateEvent} from '@/types';
import type {AgentSessionEvent,AgentTerminalLeaseEvent} from '@/types/agent-session';

function assert(value:unknown,message:string):asserts value{if(!value)throw new Error(message);}
async function until(test:()=>boolean|Promise<boolean>,message:string,timeout=180000){const end=Date.now()+timeout;while(!await test()){assert(Date.now()<end,message);await new Promise(resolve=>setTimeout(resolve,25));}}
interface GateMetadata {gateSource?:string;process?:{pid:number;group:number;interruptBlocked:boolean;hangupBlocked:boolean;interruptIgnored:boolean};processAlive:boolean|null;groupGone:boolean|null;metadataIncomplete?:boolean;actualEntries:number|null}
export async function verifySubmittedFault(input:{id:string;source:string;terminalId:string;controller:NonNullable<ReturnType<typeof terminalRegistry.get>>;host:HTMLElement;token:string;events:AgentSessionEvent[];observations:TerminalIntegrationStateEvent[];leases:AgentTerminalLeaseEvent[];failure:()=>string|undefined;readRaw:()=>string;report:(value:unknown)=>Promise<Response>;oldClosed:()=>void}){
 const {id,source,terminalId,controller,host,token,events,observations,leases}=input;
 const original={selection:controller.terminal.getSelection,line:controller.terminal.buffer.normal.getLine,open:controller.terminal.open};
 const endpoint=`/__native-p3-submit-fault/${token}`;
 async function metadata(release=false):Promise<GateMetadata>{const response=await fetch(endpoint,{method:release?'POST':'GET'});assert(response.ok,'Owned preexec gate/process observation failed');const value:unknown=await response.json();assert(value&&typeof value==='object'&&'processAlive'in value&&'groupGone'in value,'Actual gate metadata is incomplete');return value as GateMetadata;}
 let fresh:string|undefined,disposeOutput:(()=>void)|undefined,newRaw='';
 let submitted:Awaited<ReturnType<typeof invokeGetTerminalBrokerSnapshot>>|undefined;
 let uncertain:Awaited<ReturnType<typeof invokeGetTerminalBrokerSnapshot>>|undefined;
 let lateStarted:Awaited<ReturnType<typeof invokeGetTerminalBrokerSnapshot>>|undefined;
 let beforeClose:GateMetadata|undefined,afterClose:GateMetadata|undefined;
 try{
  await until(async()=>{
   assert(!input.failure(),input.failure()??'The model failed before actual submission');
   const gate=await metadata();if(gate.gateSource!==source)return false;
   const snapshot=await invokeGetTerminalBrokerSnapshot(terminalId),active=snapshot.session?.inputObservation?.activeCommand;
   if(active?.agentSessionId!==id||!active.fullInputConfirmed||!active.submissionIntentDurable||!active.mayHaveSubmitted)return false;
   submitted=snapshot;return true;
  },'The real source never reached the held parent preexec with a durable submitted intent');
  const started=performance.now();let cancelled:unknown;
  try{cancelled=await invokeCancelAgentRuntime({sessionId:id});}
  catch(error){
   const message=String(error);
   assert(message==='TERMINAL_INPUT_RECOVERY_REQUIRED: native stop was not confirmed; no automatic replay',`Unexpected actual cancellation error: ${message}`);
   cancelled={error:message};
  }
  await until(async()=>{const snapshot=await invokeGetTerminalBrokerSnapshot(terminalId),observation=snapshot.session?.inputObservation;
   if(!observation?.nativeRecoveryRequired||!['uncertain','recoveryRequired'].includes(observation.activeCommand?.phase??''))return false;
   uncertain=snapshot;return true;
  },'Unconfirmed stop did not retain native recovery and uncertain state',15000);
  const elapsed=performance.now()-started;
  assert(uncertain?.session?.inputObservation?.activeCommand?.mayHaveSubmitted,'Unconfirmed stop was misreported as unsubmitted');
  assert(await controller.writeUserInput('P3_MUST_REMAIN_BLOCKED')===false,'The uncertain source fence admitted normal input');
  const beforeIpc=await invokeGetTerminalBrokerSnapshot(terminalId);let ipcRefusal:string|undefined;
  try{await invokeWriteSession(terminalId,'P3_BROKER_MUST_REFUSE');}catch(error){ipcRefusal=String(error);}
  const afterIpc=await invokeGetTerminalBrokerSnapshot(terminalId);
  assert(ipcRefusal&&beforeIpc.session?.open&&afterIpc.session?.open&&afterIpc.session.inputObservation?.nativeRecoveryRequired,'The actual backend did not reject the uncertain session write');
  assert(beforeIpc.session.nextInputSequence===afterIpc.session.nextInputSequence,'Rejected backend input changed the actual input sequence');
  await new Promise(resolve=>setTimeout(resolve,100));
  assert(!input.readRaw().includes('P3_BROKER_MUST_REFUSE')&&!input.readRaw().includes('P3_MUST_REMAIN_BLOCKED'),'A rejected user sentinel reached the actual PTY output');
  const recovery=await invokeGetTerminalSubmissionRecovery(id);assert(recovery.length===1&&recovery[0].noAutoReplay,'The actual unresolved durable call fence was lost');
  assert(recovery[0].identity.operationId===submitted?.session?.inputObservation?.activeCommand?.operationId,'Recovery changed the original submitted operation');
  await metadata(true);
  await until(async()=>{const value=await metadata();if(!value.process||value.metadataIncomplete||value.processAlive!==true)return false;beforeClose=value;return true;},'The real approved target did not start once after releasing its pre-existing user program gate',10000);
  assert(beforeClose?.process&&!beforeClose.process.interruptBlocked&&!beforeClose.process.hangupBlocked&&!beforeClose.process.interruptIgnored,'The user preexec local trap or signal mask leaked into the actual foreground process');
  assert(beforeClose.actualEntries===1,'The actual approved target entered more than once');
  await until(async()=>{
   const snapshot=await invokeGetTerminalBrokerSnapshot(terminalId),observation=snapshot.session?.inputObservation,active=observation?.activeCommand;
   if(active?.operationId!==recovery[0].identity.operationId||active.executionEvidence!=='startObserved')return false;
   assert(active.phase==='uncertain'&&active.mayHaveSubmitted&&active.submissionIntentDurable&&observation?.nativeRecoveryRequired,'A late real Started receipt removed the submitted-stop uncertainty');
   lateStarted=snapshot;return true;
  },'The actual late Started receipt did not remain observable in the fenced operation',10000);
  assert(controller.terminal.getSelection===Terminal.prototype.getSelection&&controller.terminal.getSelection===original.selection&&controller.terminal.buffer.normal.getLine===original.line&&controller.terminal.open===Terminal.prototype.open&&controller.terminal.open===original.open,'Running submission recovery changed a public renderer API');
  await invokeCloseSession(terminalId);terminalRegistry.dispose(terminalId);useTerminalStore.getState().removeSession(terminalId);input.oldClosed();
  await until(async()=>{const value=await metadata();afterClose=value;return value.processAlive===false&&value.groupGone===true;},'The actual old foreground process/group survived explicit terminal recovery',10000);
  const closed=await invokeGetTerminalBrokerSnapshot(terminalId);
  assert(closed.session?.open===false,'The old generation remained open after explicit terminal recovery');
  let staleRejected=false;try{staleRejected=!await invokeAgentTerminalLeaseReady({sessionId:terminalId,agentSessionId:id,operationId:recovery[0].identity.operationId,terminalConnected:true,outputListenerReady:true,hasPendingUserInput:false});}catch{staleRejected=true;}
  assert(staleRejected,'A stale ready claim was admitted for the old terminal identity');
  const session=await invokeCreateLocalSession(100,30);fresh=session.sessionId;useTerminalStore.getState().addSession(session);
  assert(fresh!==terminalId,'Explicit recovery reused the old terminal identity');
  await until(()=>!!terminalRegistry.get(session.sessionId),'Fresh recovery terminal controller missing',30000);
  const replacement=terminalRegistry.get(session.sessionId)!;replacement.attach(host);await replacement.whenOutputReady();
  const freshApis={selection:replacement.terminal.getSelection,line:replacement.terminal.buffer.normal.getLine,open:replacement.terminal.open};
  disposeOutput=replacement.subscribeOutput(value=>{newRaw+=value;});
  await until(async()=>!!(await invokeGetTerminalBrokerSnapshot(session.sessionId)).session?.promptReady,'Fresh recovery editor did not become ready',30000);
  assert(await replacement.writeUserInput("printf '%s%s\\n' P3_RECOVERY_ USER_OK\r"),'Explicit fresh terminal recovery did not restore user input');
  await until(()=>newRaw.includes('P3_RECOVERY_USER_OK'),'The actual fresh parent parser did not execute the user command',10000);
  assert((await invokeGetTerminalSubmissionRecovery(id)).length===1,'Fresh user recovery silently removed the old durable intent');
  assert((await metadata()).actualEntries===1,'The possibly submitted target executed again during explicit user recovery');
  assert(events.filter(value=>value.type==='tool/call').length===1,'The real model replayed the possibly submitted source');
  assert(replacement.terminal.getSelection===Terminal.prototype.getSelection&&replacement.terminal.getSelection===freshApis.selection&&replacement.terminal.buffer.normal.getLine===freshApis.line&&replacement.terminal.open===Terminal.prototype.open&&replacement.terminal.open===freshApis.open,'Fresh explicit recovery changed a public renderer API');
  await input.report({progress:'Actual App submitted-stop uncertainty, durable fence, process cleanup and explicit fresh-terminal recovery passed',evidence:{source,submitted,cancelled,elapsed,uncertain,lateStarted,closed,recovery,beforeIpc,afterIpc,ipcRefusal,beforeClose,afterClose,staleRejected,freshTerminal:await invokeGetTerminalBrokerSnapshot(session.sessionId),raw:input.readRaw(),newRaw,events,observations,leases,oldResultStillUnknown:true}});
  if(new URL(location.href).searchParams.get('nativeP3Review')==='true'){
   const reviewed=await fetch(`/__native-p3-review/${token}`);assert(reviewed.ok,'The actual native recovery window was not reviewed');
  }
 }catch(error){await input.report({progress:'Actual submitted-stop failure retained',evidence:{failed:true,error:String(error),source,submitted,uncertain,lateStarted,beforeClose,afterClose,events,observations,leases,newRaw}});throw error;}
 finally{disposeOutput?.();if(fresh){await invokeCloseSession(fresh);terminalRegistry.dispose(fresh);useTerminalStore.getState().removeSession(fresh);}}
}
