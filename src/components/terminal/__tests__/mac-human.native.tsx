import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {getCurrentWindow} from '@tauri-apps/api/window';
import {Button} from '@/components/ui/button';
import {Card,CardHeader,CardTitle,CardDescription,CardAction,CardContent} from '@/components/ui/card';
import {Alert,AlertTitle,AlertDescription} from '@/components/ui/alert';
import {Toaster} from '@/components/ui/sonner';
import {TerminalControllerLayer} from '../terminal-controller-layer';
import {TerminalPane} from '../terminal-pane';
import {terminalRegistry} from '../registry/terminal-registry';
import {useTerminalStore} from '@/stores/terminalStore';
import {useAppStore} from '@/stores/appStore';
import {initI18n,t,type LocaleKey} from '@/locales';
import {readClipboardText,writeClipboardText} from '@/lib/clipboard';
import {invokeCreateLocalSession,invokeCloseSession,invokeGetTerminalBrokerSnapshot,invokeListAiRoutes} from '@/lib/ipc/tauri';
import {isMacFileChainProfile} from './native-file-chain-posix';
import {macDisplayOutputCommand} from './native-display-manual-posix';
import {manualPointerRow,isManualSelection,type ManualPointerGesture} from './native-display-manual-plan';
import {macHumanPlan,macHumanScope} from './mac-human-plan';
import {macHumanCapture} from './mac-human-capture';
import '@/styles/base.css';
function assert(v:unknown,message:string):asserts v{if(!v)throw Error(message);}
async function until(fn:()=>boolean|Promise<boolean>,message:string){const end=Date.now()+20000;while(!await fn()){assert(Date.now()<end,message);await new Promise(done=>setTimeout(done,20));}}
const hex=(s:string)=>Array.from(new TextEncoder().encode(s),v=>v.toString(16).padStart(2,'0')).join('');
async function start(){
 await initI18n('zh-CN');await getCurrentWindow().show();await getCurrentWindow().setFocus();
 const parameters=new URL(location.href).searchParams,token=parameters.get('token'),selection=parameters.get('macDaily'),scope=macHumanScope(selection);assert(token&&selection,'Exact isolated human case required');
 const copySupplement=scope.caseScope==='copy-supplement',selectionSupplement=scope.caseScope==='selection-supplement',caseScope=scope.caseScope,lastStep=scope.steps[scope.steps.length-1],family=selection.endsWith('-zsh')?'zsh':'bash',plan=macHumanPlan(token),capture=await macHumanCapture(token),routes=await invokeListAiRoutes();assert(!routes.routes.length&&!routes.defaultSelection,'Human case cannot select a model');
 const session=await invokeCreateLocalSession(100,30);await capture.expect(session.sessionId,session.ptyInfo);useTerminalStore.getState().addSession(session);useTerminalStore.getState().setActiveSession(session.sessionId);useAppStore.setState({terminalCopyOnSelect:true,terminalTrimTrailingWhitespace:false});
 const root=createRoot(document.getElementById('root')!);let step=scope.steps[0]-1,started=false,busy=false,rawOffset=0,inputOffset=0,physicalOffset=0,gesture:ManualPointerGesture|undefined,pointerStart:{x:number;y:number;row:number;trusted:boolean}|undefined,copyKey=false;
 let clipboardOriginal:string|undefined,lastKnownClipboard:string|undefined,clipboardNeedsReset=false,releaseCopy:(()=>void)|undefined,operatorTimer:ReturnType<typeof setTimeout>|undefined,operatorStartedAt:number|undefined;
 const receipts:Record<string,unknown>[]=[],cursorObservations:Record<string,unknown>[]=[],clipboardReadIssues:Record<string,unknown>[]=[],clipboardPreparations:Record<string,unknown>[]=[];let refresh=()=>{};
 const clipboardCopyObservations:Record<string,unknown>[]=[],copyEvents:Record<string,unknown>[]=[];let clipboardObservationStopped=false,clipboardObservationCount=0;
 const keepClipboardObservation=(value:Record<string,unknown>)=>{assert(++clipboardObservationCount<=96,'Actual clipboard observation bound exceeded');clipboardCopyObservations.push(value);return value;};
 const observeCopyClipboard=async(phase:string,observedStep:number,expected:string)=>{
  if(clipboardObservationStopped)return;const readStartedAt=Date.now();let observation:Record<string,unknown>;
  try{const value=await readClipboardText();observation=keepClipboardObservation({phase,step:observedStep,readStartedAt,readEndedAt:Date.now(),readable:true,matchesExpected:value===expected});}
  catch(error){observation=keepClipboardObservation({phase,step:observedStep,readStartedAt,readEndedAt:Date.now(),readable:false,error:String(error)});}
  await capture.post({progress:'Actual copy clipboard observation',evidence:{kind:'mac-human-clipboard-observation',observation,humanReceipt:false}});
 };
 const readCopyClipboard=async(expected:string)=>{const readStartedAt=Date.now();try{const value=await readClipboardText();keepClipboardObservation({phase:'original-verification-read',step:step+1,readStartedAt,readEndedAt:Date.now(),readable:true,matchesExpected:value===expected});return value;}catch(error){keepClipboardObservation({phase:'original-verification-read',step:step+1,readStartedAt,readEndedAt:Date.now(),readable:false,error:String(error)});throw error;}};
 const snapshot=()=>invokeGetTerminalBrokerSnapshot(session.sessionId),controller=()=>{assert(capture.controller,'Actual production controller not mounted');return capture.controller;};
 const idle=async()=>{const s=(await snapshot()).session;return !!s?.promptReady&&!s.inputObservation?.commandInputPending&&!s.inputObservation?.nativeRecoveryRequired;};
 const scoped=(event:Event)=>event.target instanceof Element&&!!event.target.closest(`[data-terminal-pane-session="${session.sessionId}"] .xterm`);
 const eventListener=(event:Event)=>{if(!started||!scoped(event))return;const e=event as KeyboardEvent&CompositionEvent;capture.physical.push({at:Date.now(),step:step+1,type:event.type,trusted:event.isTrusted,key:e.key,metaKey:e.metaKey,ctrlKey:e.ctrlKey,data:event.type.startsWith('composition')?e.data:undefined});if(event.type==='keydown'&&e.isTrusted&&e.metaKey&&e.key.toLowerCase()==='c'){copyKey=true;if(step>=3&&step<9){const observedStep=step+1,expected=samples[step-3];for(const delay of [0,80,300])setTimeout(()=>{void observeCopyClipboard('after-trusted-copy-key-'+delay+'ms',observedStep,expected).catch(fail);},delay);}}};
 const observeCopyEvent=(event:ClipboardEvent)=>{if(!started||!scoped(event))return;try{assert(++clipboardObservationCount<=96,'Actual copy event observation bound exceeded');copyEvents.push({at:Date.now(),step:step+1,trusted:event.isTrusted,defaultPrevented:event.defaultPrevented,types:event.clipboardData?Array.from(event.clipboardData.types):[],scope:'Metadata only; no clipboard payload read or written'});}catch(error){void fail(error);}};
 const row=(y:number)=>{const t=controller().terminal,b=t.element?.querySelector('.xterm-screen')?.getBoundingClientRect();return b?manualPointerRow(y,b.top,b.height,t.rows):null;};
 const down=(e:PointerEvent)=>{if(started&&scoped(e)&&e.button===0){const r=row(e.clientY);if(r!==null)pointerStart={x:e.clientX,y:e.clientY,row:r,trusted:e.isTrusted};}};
 const up=(e:PointerEvent)=>{if(pointerStart&&scoped(e)){const r=row(e.clientY);if(r!==null)gesture={trusted:pointerStart.trusted&&e.isTrusted,startX:pointerStart.x,startY:pointerStart.y,endX:e.clientX,endY:e.clientY,startRow:pointerStart.row,endRow:r};}pointerStart=undefined;};
 for(const type of ['keydown','beforeinput','paste','compositionstart','compositionupdate','compositionend'])document.addEventListener(type,eventListener,true);document.addEventListener('pointerdown',down,true);document.addEventListener('pointerup',up,true);document.addEventListener('copy',observeCopyEvent,{capture:true,passive:true});
 let message=t('terminal.human.preparing'),ready=false;
 const samples=[plan.asciiSample,plan.asciiSample,plan.unicodeCopy,plan.soft,plan.hard,plan.nativeCopy];
 const availableClipboard=async(phase:string)=>{try{return await readClipboardText();}catch(error){clipboardReadIssues.push({at:Date.now(),step:step+1,phase,error:String(error)});return undefined;}};
 const clipboardBlocked=async()=>{clipboardNeedsReset=true;message=t('terminal.human.clipboardUnavailable');refresh();await capture.post({progress:'Clipboard preparation requires a trusted user action',evidence:{kind:'mac-human-clipboard-blocked',step:step+1,clipboardReadIssues,humanReceipt:false}});};
 const restoreClipboard=async()=>{
  if(clipboardOriginal===undefined||lastKnownClipboard===undefined)return{restored:false,reason:'No readable original text or no test write; current clipboard left untouched'};
  const current=await availableClipboard('restore');
  if(current===undefined||current!==lastKnownClipboard)return{restored:false,reason:'Clipboard changed outside this case or has no readable text; left untouched'};
  try{await writeClipboardText(clipboardOriginal);assert(await readClipboardText()===clipboardOriginal,'Original clipboard text restoration did not read back exactly');return{restored:true};}
  catch(error){return{restored:false,reason:'Owned clipboard restoration failed',error:String(error)};}
 };
 const prepareCopy=async()=>{
  const current=await availableClipboard('copy-precondition');
  if(current===undefined){await clipboardBlocked();return false;}
  if(lastKnownClipboard!==undefined&&current!==lastKnownClipboard)clipboardOriginal=current;
  const sentinel=plan.prefix+'CLIPBOARD_BEFORE_STEP_'+(step+1);
  await writeClipboardText(sentinel);assert(await readClipboardText()===sentinel,'Actual clipboard precondition could not be established');lastKnownClipboard=sentinel;clipboardNeedsReset=false;return true;
 };
 const fixture=async(source:string,marker:string)=>{releaseCopy?.();releaseCopy=undefined;const offset=capture.raw.length;assert(await controller().writeUserInput(source),'Actual fixture ordinary input rejected');await until(()=>capture.raw.slice(offset).includes(marker),'Actual sample output missing');await until(idle,'Actual sample prompt not ready');releaseCopy=controller().suppressUserInput();};
 const fail=async(error:unknown)=>{message=t('terminal.human.failed');ready=false;refresh();await capture.post({progress:'Human check failed; evidence retained',evidence:{kind:'mac-human-failure',error:String(error),receipts,physical:capture.physical,input:capture.input,clipboardCopyObservations,copyEvents}});};
 const stop=async()=>{
  if(operatorTimer)clearTimeout(operatorTimer);clipboardObservationStopped=true;ready=false;refresh();
  const clipboard=await restoreClipboard();
  await invokeCloseSession(session.sessionId);await until(async()=>!(await snapshot()).session?.open,'Deferred human PTY EOF missing');
  await capture.checkpoint('human-deferred',{broker:await snapshot(),receipts,clipboardReadIssues,clipboardPreparations});
  await capture.finish(session.sessionId,{family,caseScope,session,receipts,clipboard,clipboardReadIssues,clipboardPreparations,clipboardCopyObservations,copyEvents,humanReceipt:false,manualCasePassed:false},false,'HUMAN_OPERATOR_DEFERRED');
  terminalRegistry.dispose(session.sessionId);
 };
 const next=async(event:React.MouseEvent<HTMLButtonElement>)=>{
  if(!event.isTrusted||busy||!ready||clipboardNeedsReset)return;busy=true;refresh();
  try{
   if(!started){
    const clickedAt=Date.now(),current=await availableClipboard('start-preflight');
    if(current===undefined){await clipboardBlocked();return;}
    if(lastKnownClipboard===undefined||current!==lastKnownClipboard)clipboardOriginal=current;
    operatorStartedAt=clickedAt;
    await capture.post({progress:'Operator started human checks',started:true,evidence:{kind:'manual-native-display-start',trusted:event.isTrusted,operatorStartedAt}});
    operatorTimer=setTimeout(()=>{void stop();},Math.max(0,900000-(Date.now()-operatorStartedAt)));
    started=true;capture.releaseInitial();if(copySupplement||selectionSupplement){await fixture(macDisplayOutputCommand(plan.payload),'HUMAN_SAMPLES_READY\r\n');await prepareCopy();}controller().focus();rawOffset=capture.raw.length;inputOffset=capture.input.length;physicalOffset=capture.physical.length;message=t(clipboardNeedsReset?'terminal.human.clipboardUnavailable':'terminal.human.started');return;
   }
   const c=controller(),terminal=c.terminal;
   if(step<3){
    const expected=plan.inputs[step].expected,output=capture.raw.slice(rawOffset),data=capture.input.slice(inputOffset).map(v=>String(v.data)).join(''),physical=capture.physical.slice(physicalOffset);
    if(output.split(expected).length!==2){message=t('terminal.human.inputMismatch');return;}
    assert(physical.some(v=>v.type==='keydown'&&v.trusted&&v.key==='Enter'),'Trusted physical Enter missing');assert(physical.some(v=>v.type==='keydown'&&v.trusted&&v.metaKey&&String(v.key).toLowerCase()==='v')||physical.some(v=>v.type==='paste'&&v.trusted),'Actual system paste action missing');
    if(step===0)assert((data.includes('\x1b[D')||data.includes('\x1bOD'))&&data.includes('\x7f')&&data.includes('K'),'Physical ASCII edits missing');
    if(step===1){const composed=physical.filter(v=>v.type==='compositionend'&&v.trusted).map(v=>String(v.data??'')).join('');assert(composed.includes('中')&&composed.includes('文'),'Actual Chinese input-method composition was not observed');}
    if(step===2)assert(cursorObservations.some(v=>String(v.afterCursor).startsWith('NFD_'))&&data.includes('\x05')&&data.includes('\x7f'),'Physical cursor did not cross the NFD/emoji field and return with Control-E');
    await until(idle,'Human command did not return to its real native prompt');receipts.push({step:step+1,status:'passed',trustedOperatorConfirmation:event.isTrusted,expectedOutputHex:hex(expected),rawRange:{start:rawOffset,end:capture.raw.length},inputRange:{start:inputOffset,end:capture.input.length},physicalRange:{start:physicalOffset,end:capture.physical.length},cursorObservations:step===2?cursorObservations:undefined});
   }else{
    const expected=samples[step-3],direction=step===4?'reverse':'forward',actual=terminal.getSelection();
    if(!isManualSelection(expected,actual,gesture,direction)||!copyKey){message=t('terminal.human.copyMismatch');return;}
    let actualClipboard:string|null=null;for(let i=0;i<30;i++){const value=await readCopyClipboard(expected);if(value===expected){actualClipboard=value;break;}await new Promise(done=>setTimeout(done,100));}assert(actualClipboard!==null,'Actual system clipboard differs; unrelated clipboard contents were not recorded');lastKnownClipboard=actualClipboard;
    capture.observeSelection();receipts.push({step:step+1,status:'passed',trustedOperatorConfirmation:event.isTrusted,gesture,selection:actual,selectionHex:hex(actual),clipboard:actualClipboard,clipboardHex:hex(actualClipboard),copyKey,sourceTab:step===5||step===8,expectedTabSpaces:step===5||step===8?8:undefined,display:{unicode:terminal.unicode.activeVersion,reflow:terminal.options.reflowCursorLine}});
   }
   const imageRequired=selectionSupplement||(copySupplement?step===6:step>=3);
   if(imageRequired){message=t('terminal.human.waitScreenshot');refresh();}
   await capture.checkpoint('human-step-'+(step+1),{receipts:receipts.slice(),broker:await snapshot(),clipboardReadIssues,clipboardPreparations,clipboardCopyObservations,copyEvents},imageRequired);
   if(imageRequired)await observeCopyClipboard('after-original-image-barrier',step+1,samples[step-3]);
   step++;gesture=undefined;copyKey=false;message=t('terminal.human.verified');
   if(step===3)await fixture(macDisplayOutputCommand(plan.payload),'HUMAN_SAMPLES_READY\r\n');
   if(step===7)useAppStore.setState({terminalCopyOnSelect:false});
   if(step===8){await fixture("printf '\\033]1337;SetUserVar=ShellSpanNativeInput=MQ==\\007'; "+macDisplayOutputCommand(plan.nativeRaw),plan.nativeRaw+'\r\n');assert(terminal.options.reflowCursorLine===true,'Actual native display enter missing');}
   if(step>=3&&step<lastStep)await prepareCopy();
   if(step===lastStep){const operatorCompletedAt=Date.now();assert(operatorStartedAt&&operatorCompletedAt-operatorStartedAt<=900000,'Original human operation deadline expired');if(operatorTimer)clearTimeout(operatorTimer);await capture.post({progress:'Human operator actions complete; awaiting independent visual evidence',operatorCompleted:true,evidence:{kind:'mac-human-operator-complete',trusted:event.isTrusted,operatorStartedAt,operatorCompletedAt,receipts}});if(!selectionSupplement)await fixture("printf '\\033]1337;SetUserVar=ShellSpanNativeInput=MA==\\007'; printf '%s%s\\n' HUMAN_ MODE_EXIT\r",'HUMAN_MODE_EXIT\r\n');assert(terminal.options.reflowCursorLine===false,'Actual native display baseline did not return');message=t('terminal.human.waitScreenshot');refresh();await capture.checkpoint('human-final',{receipts,broker:await snapshot(),humanReceipt:true},true);clipboardObservationStopped=true;const clipboard=await restoreClipboard();await invokeCloseSession(session.sessionId);await until(async()=>!(await snapshot()).session?.open,'Human PTY EOF missing');await capture.checkpoint('human-transport-end',{broker:await snapshot()});await capture.finish(session.sessionId,{family,caseScope,requiredSteps:scope.steps,session,receipts,clipboard,operatorStartedAt,operatorCompletedAt,modelCalls:0,agentSubmissions:0,humanReceipt:true,manualCasePassed:!clipboard.error,clipboardReadIssues,clipboardPreparations,clipboardCopyObservations,copyEvents,sourceSamples:{unicodeRaw:plan.unicodeRaw,unicodeCopy:plan.unicodeCopy,nativeRaw:plan.nativeRaw,nativeCopy:plan.nativeCopy}},!clipboard.error,clipboard.error);terminalRegistry.dispose(session.sessionId);root.unmount();}
   rawOffset=capture.raw.length;inputOffset=capture.input.length;physicalOffset=capture.physical.length;
  }catch(error){await fail(error);}finally{busy=false;refresh();}
 };
 const copy=async(event:React.MouseEvent<HTMLButtonElement>)=>{if(!event.isTrusted||!started||step>=3)return;try{const source=plan.inputs[step].source;await writeClipboardText(source);assert(await readClipboardText()===source,'Actual prepared command clipboard mismatch');lastKnownClipboard=source;controller().focus();}catch(error){await fail(error);}};
 const prepareClipboard=async(event:React.MouseEvent<HTMLButtonElement>)=>{
  if(!event.isTrusted||busy||!ready||!clipboardNeedsReset)return;busy=true;refresh();
  try{
   const current=await availableClipboard('trusted-preparation-before');
   if(current===undefined)clipboardOriginal=undefined;
   else if(lastKnownClipboard===undefined||current!==lastKnownClipboard)clipboardOriginal=current;
   const text=plan.prefix+'CLIPBOARD_READY_STEP_'+(step+1);
   await writeClipboardText(text);assert(await readClipboardText()===text,'Trusted clipboard preparation did not read back exactly');
   lastKnownClipboard=text;clipboardNeedsReset=false;
   clipboardPreparations.push({at:Date.now(),step:step+1,trusted:event.isTrusted,previousTextReadable:current!==undefined,originalTextRestorable:clipboardOriginal!==undefined,knownTextHex:hex(text),stepPassed:false});
   if(started&&step>=3&&step<9)await prepareCopy();
   message=t('terminal.human.clipboardPrepared');
   await capture.post({progress:'Trusted clipboard preparation verified; no acceptance step credited',evidence:{kind:'mac-human-clipboard-prepared',clipboardReadIssues,clipboardPreparations,humanReceipt:false}});
  }catch(error){await fail(error);}finally{busy=false;refresh();}
 };
 function View(){const activeSession=useTerminalStore(s=>s.sessions.find(v=>v.sessionId===session.sessionId)??null);const[,render]=useState(0);refresh=()=>render(v=>v+1);const current=Math.min(step,lastStep-1),instruction=('terminal.human.step'+(current+1)) as LocaleKey;
  const title=selectionSupplement?'terminal.human.selectionTitle':copySupplement?'terminal.human.supplementTitle':'terminal.human.title',intro=selectionSupplement?'terminal.human.selectionIntro':copySupplement?'terminal.human.supplementIntro':'terminal.human.intro',currentLabel=selectionSupplement?'terminal.human.selectionCurrent':copySupplement?'terminal.human.supplementCurrent':'terminal.human.current';
  return <div className="flex h-screen min-h-0 flex-col gap-3 p-3"><TerminalControllerLayer/><Toaster/><Card size="sm" radius="compact" variant="outline" className="max-h-[40vh] min-h-0 shrink-0"><CardHeader className="shrink-0"><CardTitle>{t(title,{family})}</CardTitle><CardDescription>{t(intro)}</CardDescription><CardAction><Button id="human-start-next" disabled={!ready||busy||clipboardNeedsReset} onClick={e=>void next(e)}>{t(!started?'terminal.human.start':step===lastStep-1?(copySupplement?'terminal.human.supplementFinish':'terminal.human.finish'):'terminal.human.verify')}</Button></CardAction></CardHeader><CardContent className="min-h-0 overflow-auto"><div className="flex flex-col gap-3"><Alert variant="info"><AlertTitle>{t(currentLabel,{step:selectionSupplement?current-3:copySupplement?current-5:current+1})}</AlertTitle><AlertDescription>{t(instruction)}</AlertDescription></Alert><pre className="whitespace-pre-wrap break-all select-none">{step<3?plan.inputs[step].source:samples[current-3]}</pre><div className="flex items-center gap-3">{step<3&&<Button id="human-copy-command" size="sm" variant="outline" disabled={!started||busy||clipboardNeedsReset} onClick={e=>void copy(e)}>{t('terminal.human.copy')}</Button>}{clipboardNeedsReset&&<Button id="human-prepare-clipboard" size="sm" variant="outline" disabled={busy} onClick={e=>void prepareClipboard(e)}>{t('terminal.human.prepareClipboard')}</Button>}<Button size="sm" variant="outline" disabled={busy} onClick={e=>{if(e.isTrusted)void stop().catch(fail);}}>{t('terminal.human.defer')}</Button><p role="status">{message}</p></div></div></CardContent></Card><div className="min-h-0 flex-1"><TerminalPane activeSession={activeSession} isActive isVisible/></div></div>;}
 root.render(<View/>);await until(()=>!!capture.controller?.host,'Actual production pane did not attach');const c=controller();await c.whenOutputReady();await until(idle,'Actual manual native prompt not ready');const initial=await snapshot();assert(isMacFileChainProfile(initial.session?.nativePeerProfile,family),'Actual selected native profile missing');
 const renderObserver=c.terminal.onRender(()=>{if(!started||step!==2)return;const b=c.terminal.buffer.normal,at=b.baseY+b.cursorY;let afterCursor='';for(let y=at;y<b.length;y++){if(y>at&&!b.getLine(y)?.isWrapped)break;for(let x=y===at?b.cursorX:0;x<c.terminal.cols;x++)afterCursor+=b.getLine(y)?.getCell(x)?.getChars()??'';}if(cursorObservations.length<512)cursorObservations.push({at:Date.now(),x:b.cursorX,y:b.cursorY,baseY:b.baseY,afterCursor});});
 await capture.checkpoint('human-ready',{broker:initial,initial,routes,session,family},true);await capture.post({progress:'Manual window ready; waiting for user start',ready:true,evidence:{kind:'manual-native-display-ready',family,session,initial,operatorActions:0,humanReceipt:false}});ready=true;message=t('terminal.human.ready');refresh();
 void renderObserver;
}
const parameters = new URL(location.href).searchParams;
const selection = parameters.get('macDaily');
const run = async () => {
 if (selection !== 'human-viewport-zsh' && selection !== 'human-viewport-bash') return start();
 const token = parameters.get('token');
 assert(token, 'Exact owned viewport token required');
 const {startMacHumanViewport} = await import('./mac-human-viewport.native');
 return startMacHumanViewport(token, selection === 'human-viewport-zsh' ? 'zsh' : 'bash');
};
void run().catch(error=>{const token=parameters.get('token');void fetch('/__agent-stream-result/'+token,{method:'POST',body:JSON.stringify({ok:false,error:String(error),evidence:{kind:'mac-human-preparation-failure',humanReceipt:false}})});});
