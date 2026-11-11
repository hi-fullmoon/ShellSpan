import {invokeControlTerminalAcceptanceInputLease,invokeCreateAgentRuntimeSession,invokeGetTerminalSubmissionRecovery} from '@/lib/ipc/tauri';
import {useToastStore} from '@/stores/toastStore';
import {t} from '@/locales';
import type {EditingContext} from './mac-daily-editing';
import {macDailySingleOutputPlan} from './mac-daily-input-plan';

function assert(value:unknown,message:string):asserts value{if(!value)throw Error(message);}
async function until(test:()=>boolean|Promise<boolean>,message:string){const end=Date.now()+10000;while(!await test()){assert(Date.now()<end,message);await new Promise(done=>setTimeout(done,10));}}

export async function runMacDailyToast(x:EditingContext,home:string){
 const session=(await x.snapshot()).session;assert(session&&home.startsWith('/'),'Actual isolated native session required');
 const id='phase2-toast-'+crypto.randomUUID(),target={kind:'local' as const,targetId:'terminal-'+session.transportSessionId,sessionId:session.transportSessionId,cwd:home,localRoot:home};
 const created=await invokeCreateAgentRuntimeSession({sessionId:id,taskId:id,goal:'Observe actual production input rejection feedback without model or Agent source execution',target,permissionMode:'requestApproval',executionSurface:'boundTerminal',capabilityScope:{toolNames:['run_terminal_command'],effects:['stateChange'],targetIds:[target.targetId]}});
 assert(!created.header.modelSelection,'Acceptance session selected a model');
 const recoveryBefore=await invokeGetTerminalSubmissionRecovery(id);assert(recoveryBefore.length===0,'Unexpected existing durable submission');
 const acquired=await invokeControlTerminalAcceptanceInputLease(id,false);assert(!acquired.released&&acquired.brokerAfter.session?.lease?.owner.kind==='agent','Production lease acquisition not observed');
 await x.checkpoint('toast-lease-acquired',{acquired,agentSessionId:id,recoveryBefore});
 const offset=x.raw().length,before=acquired.brokerAfter.session?.nextInputSequence,attempt='TOAST_DIRECT_REJECT_'+x.token.slice(0,8);let rejection:unknown;
 try{await x.send(attempt,'actual production lease rejection');}catch(error){rejection=String(error);}
 assert(typeof rejection==='string'&&rejection.includes('TERMINAL_INPUT_BLOCKED_BY_AGENT'),'Actual production ordinary input was not refused by its lease');
 const message=t('terminal.notice.writeFailedMessage'),toastHistory:{at:number;toasts:ReturnType<typeof useToastStore.getState>['toasts']}[]=[];
 assert(useToastStore.getState().toasts.length===0,'Toast feedback was already present before the rejected input');
 const stop=useToastStore.subscribe(state=>toastHistory.push({at:Date.now(),toasts:state.toasts.map(item=>({...item}))}));
 let released=false;
 try{
  await x.paste('TOAST_PUBLIC_A_'+x.token.slice(0,8));await x.paste('TOAST_PUBLIC_B_'+x.token.slice(0,8));
  const rendered=()=>Array.from(document.querySelectorAll('[data-sonner-toast]')).filter(node=>node.textContent?.includes(message));
  await until(()=>useToastStore.getState().toasts.filter(item=>item.variant==='error'&&item.message===message).length===1&&rendered().length===1,'Real production Toast did not render once');
  const current=useToastStore.getState().toasts;assert(current.length===1&&current[0].duration===3000,'Production Toast count or duration was changed');
  const blocked=await x.snapshot();assert(blocked.session?.nextInputSequence===before,'Refused ordinary input advanced the real input sequence');
  assert(!x.raw().slice(offset).includes('TOAST_'),'Refused ordinary input reached actual PTY output');
  await x.checkpoint('toast-visible',{rejection,attempt,blocked,toastHistory:structuredClone(toastHistory),renderedText:rendered().map(node=>node.textContent),productionMessage:message,toastDuration:current[0].duration,toastId:current[0].id,agentSessionId:id});
  const logResponse=await fetch(`/__native-mac-toast-log/${x.token}`);assert(logResponse.ok,'Original frontend rejection log could not be retained');
  const log=await logResponse.json() as {file:string;sha256:string;text:string};
  const rejectionLines=log.text.split('\n').filter(line=>line.includes('Failed to write input to session '+session.transportSessionId)&&line.includes('TERMINAL_INPUT_BLOCKED_BY_AGENT'));
  assert(rejectionLines.length===2,'Both real public-input failures must complete in the original production frontend log');
  const lease=await invokeControlTerminalAcceptanceInputLease(id,true);released=true;assert(lease.released&&lease.brokerAfter.session?.lease?.owner.kind==='user','Production lease release not observed');
  assert(lease.brokerAfter.session.nextInputSequence===before,'Blocked input was queued for later execution');
  await until(()=>useToastStore.getState().toasts.length===0,'Production Toast did not close on its unchanged default duration');
  const ids=[...new Set(toastHistory.flatMap(entry=>entry.toasts.filter(item=>item.message===message).map(item=>item.id)))];assert(ids.length===1,'Repeated real rejection created a second Toast');
  const recoveryAfter=await invokeGetTerminalSubmissionRecovery(id);assert(recoveryAfter.length===0,'Feedback acceptance persisted an Agent command submission');
  await x.checkpoint('toast-lease-released',{lease,log:{file:log.file,sha256:log.sha256,rejectionLines},toastHistory,recoveryAfter,defaultAutoClosed:true});
  await x.send('\r');await until(x.idle,'Enter after actual lease release did not restore an empty native prompt');
  const start=x.raw().length,plan=macDailySingleOutputPlan(x.token,'TOAST_RECOVERED',14);await x.send(plan.source+'\r');await x.finishOutput('TOAST_RECOVERED',14,start,{blockedSourceAbsent:!x.raw().slice(offset).includes('TOAST_PUBLIC_'),agentSessionId:id});
  assert(!x.raw().slice(offset).includes('TOAST_PUBLIC_')&&!x.raw().slice(offset).includes(attempt),'Rejected draft was executed after real release');
  if(!x.deferTransportEnd){await x.send('exit\r');await until(async()=>!(await x.snapshot()).session?.open,'Toast acceptance transport did not reach actual EOF');await x.drain();await x.checkpoint('transport-end');}
 }finally{stop();if(!released)await invokeControlTerminalAcceptanceInputLease(id,true);}
}
