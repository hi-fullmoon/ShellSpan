import type { MouseEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { getCurrentWindow } from '@tauri-apps/api/window';
import TerminalWorkspace from '../index';
import { terminalRegistry } from '../registry/terminal-registry';
import { useTerminalTaskNavigation } from '../agent-terminal-task-navigation';
import { AppShell, MainContent } from '@/components/layout/app-shell';
import { AiPanel } from '@/components/ai/ai-panel';
import { Button } from '@/components/ui/button';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { useAiPanelStore } from '@/stores/aiPanelStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { useAppStore } from '@/stores/appStore';
import { initI18n, t } from '@/locales';
import {
 invokeCancelAgentRuntime, invokeCloseSession, invokeCreateAgentRuntimeSession, invokeCreateLocalSession,
 invokeDecideTerminalAcceptanceCommand, invokeGetAgentRuntimeEvents, invokeGetAgentRuntimeSession,
 invokeGetTerminalAcceptanceRawOutput, invokeGetTerminalBrokerSnapshot, invokeGetTerminalSubmissionRecovery,
 invokeInterruptAgentRuntime, invokeListAiRoutes, invokeRunTerminalAcceptanceCommand, type TerminalAcceptanceSourceKind,
} from '@/lib/ipc/tauri';
import { macWireCapture } from './mac-wire-capture';
import { isMacFileChainProfile } from './native-file-chain-posix';
import '@/styles/base.css';

const requireFact: (fact: unknown, message: string) => asserts fact = (fact, message) => {
 if (!fact) throw Error(message);
};
async function waitUntil(read: () => boolean | Promise<boolean>, message: string) {
 const deadline = Date.now() + 20000;
 while (!await read()) {
  requireFact(Date.now() < deadline, message);
  await new Promise(resolve => setTimeout(resolve, 20));
 }
}

async function verify() {
 const params = new URL(location.href).searchParams;
 const token = params.get('token'), home = params.get('caseHome'), selection = params.get('macDaily');
 requireFact(token && home?.startsWith('/') && (selection === 'submission-zsh' || selection === 'submission-bash'), 'Exact isolated manual inputs required');
 const family = selection === 'submission-zsh' ? 'zsh' : 'bash';
 const root = createRoot(document.getElementById('root')!);
 const window = getCurrentWindow(), wire = await macWireCapture();
 const terminals: string[] = [], agents: string[] = [], screenshots: Record<string, unknown> = {};
 const steps: Record<string, unknown>[] = [], actions: { kind: 'enter'|'tab'|'viewTask'; at: number; stage: number; sessionId?: string }[] = [];
 const navigation: { agentSessionId: string; terminalSessionId: string; at: number }[] = [];
 let operatorStartedAt: number | undefined, operatorCompletedAt: number | undefined, timer: ReturnType<typeof setTimeout> | undefined;
 let stage = 0, busy = true, deferred = false, failure: unknown;
 let ownerTerminal = '', otherTerminal = '', operatorFinished!: () => void;
 let decision: Promise<unknown> | undefined;
 let advance: (trusted: boolean) => Promise<void> = async () => {};
 const finished = new Promise<void>(resolve => { operatorFinished = resolve; });
 const report = async (body: unknown) => {
  const response = await fetch('/__agent-stream-result/' + token, { method: 'POST', body: JSON.stringify(body) });
  requireFact(response.ok, 'Actual manual evidence was not retained');
 };
 const effect = async () => {
  const response = await fetch('/__native-mac-submission-witness/' + token);
  requireFact(response.ok, 'Actual manual command effect was not readable');
  const result = await response.json() as { exists: boolean; text: string | null; sha256: string | null; readOnly: boolean };
  requireFact(result.readOnly, 'Effect observation granted write access');
  return result;
 };
 const capture = async (label: string) => {
  const response = await fetch('/__native-mac-daily-capture/' + token + '/' + label, { method: 'POST' });
  requireFact(response.ok, 'The original App window image was unavailable');
  const actual = await response.json() as { captured: boolean; authority: string; image: { file: string; sha256: string }; humanReceipt: boolean };
  requireFact(actual.captured && actual.authority === 'image-retention-only' && !actual.humanReceipt, 'Actual window capture identity differs');
  screenshots[label] = actual;
 };
 const visibleTask = () => document.querySelector<HTMLElement>('[data-slot="ai-panel"][data-ai-scope="terminal"] [data-slot="ai-workspace-root"]')?.dataset.sessionId;
 const snapshots = async () => [await invokeGetTerminalBrokerSnapshot(ownerTerminal), await invokeGetTerminalBrokerSnapshot(otherTerminal)];
 const events = async (id: string) => (await invokeGetAgentRuntimeEvents({ sessionId: id, limit: 500 })).events;
 function render() {
  const instructions = [t('terminal.phase3Manual.ready'), t('terminal.phase3Manual.contention'), t('terminal.phase3Manual.other'),
   t('terminal.phase3Manual.return')];
  root.render(<TooltipProvider><AppShell>
   <div className="shrink-0 border-b px-3 py-2">
    <div className="flex items-center gap-3">
     <div className="min-w-0 flex-1"><p className="font-medium">{t('terminal.phase3Manual.title')}</p><p>{instructions[stage] ?? t('terminal.phase3Manual.finishing')}</p></div>
     <Button disabled={busy || stage>3} onClick={(event: MouseEvent) => {
      if(!event.nativeEvent.isTrusted || busy || stage>3) return;
      void advance(event.nativeEvent.isTrusted).catch(error=>{failure=error;operatorFinished();});
     }}>{stage===0?t('terminal.navigationAcceptance.start'):stage===3?t('terminal.navigationAcceptance.finish'):t('terminal.navigationAcceptance.verify')}</Button>
     <Button variant="outline" disabled={busy} onClick={(event: MouseEvent)=>{
      if(event.nativeEvent.isTrusted&&!busy){deferred=true;operatorFinished();}
     }}>{t('terminal.navigationAcceptance.defer')}</Button>
    </div>
   </div>
   <div className="relative flex min-h-0 min-w-0 flex-1"><MainContent><TerminalWorkspace/></MainContent><AiPanel/></div>
  </AppShell><Toaster/></TooltipProvider>);
 }
 const renderNow=()=>flushSync(render);
 function key(event:KeyboardEvent){
  if(!operatorStartedAt||!event.isTrusted||event.key!=='Enter'||!(event.target instanceof Element))return;
  if(event.target.closest('[data-terminal-pane-session="'+ownerTerminal+'"] .xterm'))actions.push({kind:'enter',at:Date.now(),stage,sessionId:ownerTerminal});
 }
 function pointer(event:PointerEvent){
  if(!operatorStartedAt||!event.isTrusted||!(event.target instanceof Element))return;
  const tab=event.target.closest<HTMLElement>('[data-session-tab]')?.dataset.sessionTab;
  if(tab===ownerTerminal||tab===otherTerminal)actions.push({kind:'tab',at:Date.now(),stage,sessionId:tab});
  const task=event.target.closest<HTMLButtonElement>('[data-testid="agent-terminal-lease-bar"] button');
  if(task?.textContent?.trim()===t('terminal.occupancy.viewTask'))actions.push({kind:'viewTask',at:Date.now(),stage});
 }
 document.addEventListener('keydown',key,true);document.addEventListener('pointerdown',pointer,true);
 const unsubscribe=useTerminalTaskNavigation.subscribe(value=>{
  const request=value.request;
  if(operatorStartedAt&&request)navigation.push({agentSessionId:request.agentSessionId,terminalSessionId:request.terminalSessionId,at:Date.now()});
 });
 try {
  await initI18n('zh-CN');
  const routes=await invokeListAiRoutes();
  requireFact(routes.routes.length===0&&!routes.defaultSelection,'Manual test requires a genuinely empty model store');
  useAppStore.setState({locale:'zh-CN',activeSection:'terminal',restoreWorkspace:false});
  useAiPanelStore.getState().setOpen(true,'terminal');
  const a=await invokeCreateLocalSession(100,30),b=await invokeCreateLocalSession(100,30);
  ownerTerminal=a.sessionId;otherTerminal=b.sessionId;terminals.push(ownerTerminal,otherTerminal);
  for(const terminal of [a,b]){
   requireFact(terminal.terminalSessionId&&terminal.terminalGeneration!==undefined,'Actual native identity missing');
   await wire.expect(terminal.sessionId,{terminalSessionId:terminal.terminalSessionId,terminalGeneration:terminal.terminalGeneration});
  }
  useTerminalStore.getState().addSession({...a,title:t('terminal.navigationAcceptance.ownerTerminal')});
  useTerminalStore.getState().addSession({...b,title:t('terminal.navigationAcceptance.otherTerminal')});
  useTerminalStore.getState().setActiveSession(ownerTerminal);renderNow();
  await waitUntil(()=>!!terminalRegistry.get(ownerTerminal)&&!!terminalRegistry.get(otherTerminal),'Actual production controllers did not attach');
  await waitUntil(async()=>(await snapshots()).every(view=>view.session?.promptReady&&isMacFileChainProfile(view.session.nativePeerProfile,family)),'Actual native editors did not become ready');
  async function createTask(terminalId:string){
   requireFact(home,'Exact owned home missing');
   const id='phase3-submission-'+crypto.randomUUID(),callId=crypto.randomUUID(),targetId='terminal-'+terminalId;
   const created=await invokeCreateAgentRuntimeSession({sessionId:id,taskId:id,goal:'Explicit isolated manual acceptance task',
    target:{kind:'local',targetId,sessionId:terminalId,cwd:home,localRoot:home},permissionMode:'requestApproval',executionSurface:'boundTerminal',
    capabilityScope:{toolNames:['run_terminal_command'],effects:['stateChange','readOnly'],targetIds:[targetId]}});
   agents.push(id);
   return {id,callId,created};
  }
  async function prepareTask(task:Awaited<ReturnType<typeof createTask>>,kind:TerminalAcceptanceSourceKind,startedAt:number){
   const {id,callId}=task;
   const prepared=await invokeRunTerminalAcceptanceCommand(id,callId,kind);
   requireFact(prepared.settlement==='Waiting'&&prepared.modelAvailability==='MODEL_SELECTION_REQUIRED','Actual scoped manual approval missing');
   const requested=(await events(id)).find(event=>event.type==='tool/approval'&&event.data.status==='requested'&&event.data.callId===callId);
   requireFact(requested?.type==='tool/approval'&&requested.turnId&&requested.stepId&&requested.data.approvalId,'Actual manual approval identity missing');
   requireFact(requested.timeUnixMs>=startedAt&&typeof requested.data.expiresAtUnixMs==='number'
    &&requested.data.expiresAtUnixMs>Date.now(),'Manual approval did not originate after the trusted start');
   const approval={sessionId:id,callId,turnId:requested.turnId,stepId:requested.stepId,requestId:requested.data.requestId,approvalId:requested.data.approvalId};
   return {...task,prepared,approval,approvalRequestedAt:requested.timeUnixMs,approvalExpiresAt:requested.data.expiresAtUnixMs};
  }
  const owner=await createTask(ownerTerminal),other=await createTask(otherTerminal);
  let ownerInvocation: Awaited<ReturnType<typeof prepareTask>>|undefined;
  useTerminalStore.getState().setActiveSession(otherTerminal);
  useTerminalTaskNavigation.getState().setRequest({workspace:'terminal',agentSessionId:other.id,terminalSessionId:otherTerminal});
  await waitUntil(()=>visibleTask()===other.id,'Actual second task did not load');
  useTerminalStore.getState().setActiveSession(ownerTerminal);
  useTerminalTaskNavigation.getState().setRequest({workspace:'terminal',agentSessionId:owner.id,terminalSessionId:ownerTerminal});
  await waitUntil(()=>visibleTask()===owner.id,'Actual original task did not load');
  const otherEvents=await events(other.id);
  requireFact(!otherEvents.some(event=>event.type==='tool/approval'||event.type==='tool/execution'),
   'The independent task must begin idle without an outstanding command');
  const taskEvents=(records:typeof otherEvents)=>records.filter(event=>event.type!=='skill/catalog_observed');
  const baseline=await snapshots(),ownerHeader=(await invokeGetAgentRuntimeSession({sessionId:owner.id})).header,
   otherHeader=(await invokeGetAgentRuntimeSession({sessionId:other.id})).header;
  async function running(){
   const pair=await snapshots(),active=pair[0].session?.inputObservation?.activeCommand;
   requireFact(active?.agentSessionId===owner.id&&active.phase==='running'&&active.executionEvidence==='startObserved'
    &&active.fullInputConfirmed&&active.submissionIntentDurable,'Original actual command ownership changed');
   requireFact((await effect()).text===owner.callId+'\n','Actual command was repeated or changed');
   requireFact(JSON.stringify((await invokeGetAgentRuntimeSession({sessionId:owner.id})).header)===JSON.stringify(ownerHeader),'Original task header changed');
   requireFact(JSON.stringify((await invokeGetAgentRuntimeSession({sessionId:other.id})).header)===JSON.stringify(otherHeader),'Independent task header changed');
   const otherEventsObserved=await events(other.id);
   requireFact(JSON.stringify(taskEvents(otherEventsObserved))===JSON.stringify(taskEvents(otherEvents)),
    'An independent task event changed beyond read-only catalog observation');
   return {pair,active,otherEventsObserved};
  }
  advance=async(trusted)=>{
   requireFact(trusted,'Manual checkpoint requires a trusted operator action');
   busy=true;renderNow();
   if(stage===0){
    operatorStartedAt=Date.now();
    await report({started:true,progress:'Actual operator started the local Phase 3 check',evidence:{kind:'phase3-manual-start',operatorStartedAt,trusted,owner,other,humanReceipt:false}});
    timer=setTimeout(()=>{failure=Error('Actual operator did not complete the steps within the active window');operatorFinished();},150000);
    ownerInvocation=await prepareTask(owner,'manual-running',operatorStartedAt);
    let approvalError:string|undefined;
    decision=invokeDecideTerminalAcceptanceCommand(ownerInvocation.approval,true).catch(error=>{
     approvalError=String(error);
     return {error:approvalError};
    });
    await waitUntil(async()=>{
     requireFact(!approvalError,'Actual owner approval was refused: '+approvalError);
     const active=(await invokeGetTerminalBrokerSnapshot(ownerTerminal)).session?.inputObservation?.activeCommand;
     return active?.phase==='running'&&(await effect()).text===owner.callId+'\n';
    },'The actual no-model command did not start');
    steps.push({stage:'started',at:Date.now(),fact:await running()});
   }else{
    const fact=await running(),visible=visibleTask(),selected=useTerminalStore.getState().activeSessionId;
    if(stage===1)requireFact(actions.some(action=>action.kind==='enter'&&action.stage===1)&&selected===ownerTerminal&&visible===owner.id,'Actual trusted Enter on the owned terminal was not observed');
    if(stage===2)requireFact(actions.some(action=>action.kind==='tab'&&action.stage===2&&action.sessionId===otherTerminal)&&selected===otherTerminal&&visible===other.id,'Actual trusted switch to the other task was not observed');
    if(stage===3){
     const view=actions.find(action=>action.kind==='viewTask'&&action.stage===3);
     requireFact(actions.some(action=>action.kind==='tab'&&action.stage===3&&action.sessionId===ownerTerminal)
      &&selected===ownerTerminal&&visible===owner.id,'Actual trusted return to the owning task was not observed');
     if(view)requireFact(navigation.some(request=>request.agentSessionId===owner.id&&request.terminalSessionId===ownerTerminal
      &&request.at>=view.at),'Actual View task action did not open the original task');
     operatorCompletedAt=Date.now();if(timer)clearTimeout(timer);
    }
    steps.push({stage,at:Date.now(),trusted,fact,visible,selected,actions:[...actions],navigation:[...navigation]});
    await capture(stage===1?'phase3-manual-contention':stage===2?'phase3-manual-other':'phase3-manual-task-switch');
   }
   stage++;busy=false;renderNow();if(stage===4)operatorFinished();
  };
  await window.show();await window.setFocus();
  await capture('phase3-manual-ready');busy=false;renderNow();
  await report({ready:true,progress:'Actual signed App window is ready for the human',evidence:{kind:'phase3-manual-ready',family,owner,other,baseline,screenshots,humanReceipt:false}});
  await finished;
  if(timer)clearTimeout(timer);
  if(operatorStartedAt){
   await invokeInterruptAgentRuntime({sessionId:owner.id});
   await decision;
  }
  if(failure)throw failure;
  const ownerEvents=await events(owner.id),settledRecovery=await invokeGetTerminalSubmissionRecovery(owner.id);
  const finalEffect=await effect();
  if(!deferred)requireFact(operatorStartedAt&&operatorCompletedAt&&operatorCompletedAt-operatorStartedAt<=150000
   &&steps.length===4&&settledRecovery.length===0&&finalEffect.text===owner.callId+'\n','Manual operator or native settlement evidence is incomplete');
  for(const id of agents)await invokeCancelAgentRuntime({sessionId:id});
  for(const id of terminals)await invokeCloseSession(id);
  await waitUntil(()=>terminals.every(id=>wire.isFinalized(id)),'Actual manual PTYs did not finalize');
  const transport=[];
  for(const id of terminals){
   const actual=wire.snapshot(id,true),broker=await invokeGetTerminalAcceptanceRawOutput(id);
   requireFact(actual.wireDecoded===actual.decoded&&broker.nextByteOffset===actual.byteCount&&broker.capturedFrameCount===actual.frameCount&&!broker.open&&!broker.captureTruncated,'Actual manual PTY capture differs');
   transport.push({wire:wire.observations(id),broker});
  }
  await report({ok:true,evidence:{kind:'actual-macos-human-phase3',scenario:'human-phase3',family,
   owner:ownerInvocation??owner,other,session:a,otherSession:b,baseline,
   operatorStartedAt,operatorCompletedAt,steps,actions,navigation,screenshots,transport,ownerEvents,otherEvents,settledRecovery,finalEffect,routes,
   manualCaseObserved:!deferred,humanReceipt:!deferred,phase3Complete:false}});
 }catch(error){
  for(const id of agents)await invokeCancelAgentRuntime({sessionId:id}).catch(()=>{});
  for(const id of terminals)await invokeCloseSession(id).catch(()=>{});
  await report({ok:false,error:String(error),evidence:{kind:'actual-macos-human-phase3-failure',family,operatorStartedAt,operatorCompletedAt,
   steps,actions,navigation,screenshots,humanReceipt:false,phase3Complete:false}});
 }finally{
  if(timer)clearTimeout(timer);
  document.removeEventListener('keydown',key,true);document.removeEventListener('pointerdown',pointer,true);
  unsubscribe();wire.stop();root.unmount();
 }
}

void verify();
