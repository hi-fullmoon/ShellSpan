import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {getCurrentWindow} from '@tauri-apps/api/window';
import {TerminalControllerLayer} from '../terminal-controller-layer';
import {TerminalPane} from '../terminal-pane';
import {terminalRegistry} from '../registry/terminal-registry';
import {useTerminalStore} from '@/stores/terminalStore';
import {useAppStore} from '@/stores/appStore';
import {initI18n} from '@/locales';
import {readClipboardText,writeClipboardText} from '@/lib/clipboard';
import {invokeCreateLocalSession,invokeCloseSession,invokeGetTerminalBrokerSnapshot,invokeListAiRoutes} from '@/lib/ipc/tauri';
import {isMacFileChainProfile} from './native-file-chain-posix';
import {manualPointerRow,isManualSelection,type ManualPointerGesture} from './native-display-manual-plan';
import {macHumanCapture} from './mac-human-capture';
import {macSystemSelectionPlan} from './mac-system-selection-plan';
import '@/styles/base.css';

function assert(value:unknown,message:string):asserts value{if(!value)throw Error(message);}
async function until(test:()=>boolean|Promise<boolean>,message:string){const end=Date.now()+20000;while(!await test()){assert(Date.now()<end,message);await new Promise(done=>setTimeout(done,20));}}
const hex=(text:string)=>Array.from(new TextEncoder().encode(text),byte=>byte.toString(16).padStart(2,'0')).join('');

async function start(){
 const params=new URL(location.href).searchParams,token=params.get('token'),mode=params.get('macDaily');
 assert(token&&(mode==='system-selection-zsh'||mode==='system-selection-bash'),'Exact automatic system-selection case required');
 const family=mode.endsWith('zsh')?'zsh':'bash',plan=macSystemSelectionPlan(token),capture=await macHumanCapture(token,'automatic');
 await initI18n('en-US');await getCurrentWindow().show();await getCurrentWindow().setFocus();
 const routes=await invokeListAiRoutes();assert(routes.routes.length===0&&!routes.defaultSelection,'System selection must use an empty model route store');
 const session=await invokeCreateLocalSession(100,30);assert(session.terminalSessionId&&session.terminalGeneration!==undefined,'Actual logical identity required');
 await capture.expect(session.sessionId,session.ptyInfo,{terminalSessionId:session.terminalSessionId,terminalGeneration:session.terminalGeneration});
 useTerminalStore.getState().addSession(session);useTerminalStore.getState().setActiveSession(session.sessionId);
 useAppStore.setState({terminalCopyOnSelect:false,terminalTrimTrailingWhitespace:false});
 const root=createRoot(document.getElementById('root')!),snapshot=()=>invokeGetTerminalBrokerSnapshot(session.sessionId);
 const controller=()=>{assert(capture.controller,'Actual production terminal not attached');return capture.controller;};
 const idle=async()=>{const broker=await snapshot();return !!broker.session?.promptReady&&!broker.session.inputObservation?.commandInputPending&&!broker.session.inputObservation?.nativeRecoveryRequired;};
 let status='Preparing actual system path',refresh=()=>{},releaseCopy:(()=>void)|undefined,problem:unknown;
 let clipboardOriginal:string|undefined,lastKnownClipboard:string|undefined;
 const receipts:Record<string,unknown>[]=[],preparations:Record<string,unknown>[]=[],clipboardIssues:Record<string,unknown>[]=[],unexpected:Record<string,unknown>[]=[],sources:Record<string,unknown>[]=[];
 let phase:ReturnType<typeof macSystemSelectionPlan>['phases'][number]|undefined,phaseIndex=-1;
 let pointerStart:{x:number;y:number;row:number;trusted:boolean}|undefined,gesture:ManualPointerGesture|undefined,copyKey:Record<string,unknown>|undefined;
 let resolveCopy:((value:Record<string,unknown>)=>void)|undefined,rejectCopy:((reason:unknown)=>void)|undefined,busy=false;
 const update=(value:string)=>{status=value;refresh();};
 const scoped=(event:Event)=>event.target instanceof Element&&!!event.target.closest(`[data-terminal-pane-session="${session.sessionId}"] .xterm`);
 const row=(clientY:number)=>{const t=controller().terminal,screen=t.element?.querySelector('.xterm-screen')?.getBoundingClientRect();return screen?manualPointerRow(clientY,screen.top,screen.height,t.rows):null;};
 const inspectSelection=()=>{const terminal=controller().terminal,b=terminal.buffer.normal;return{selection:terminal.getSelection(),position:terminal.getSelectionPosition()??null,columns:terminal.cols,rows:terminal.rows,baseY:b.baseY,viewportY:b.viewportY};};
 const pointerTypes=['pointerdown','pointerup','pointermove','pointercancel','mousedown','mousemove','mouseup'] as const;
 let pointerEventsObserved=0,pointerEventsOverflow=false;
 const observePointer=(event:Event)=>{
  if(!phase||!(event instanceof MouseEvent)||(!scoped(event)&&!(event.type==='mouseup'&&event.target===document)))return;
  pointerEventsObserved++;
  if(pointerEventsObserved>1000){if(!pointerEventsOverflow){pointerEventsOverflow=true;const error=Error('System pointer observation bound exceeded');problem??=error;rejectCopy?.(error);}return;}
  capture.physical.push({type:event.type,at:Date.now(),eventTimeStamp:event.timeStamp,phase:phase.id,trusted:event.isTrusted,
   button:event.button,buttons:event.buttons,detail:event.detail,clientX:event.clientX,clientY:event.clientY,
   metaKey:event.metaKey,ctrlKey:event.ctrlKey,shiftKey:event.shiftKey,altKey:event.altKey,
   targetKind:event.target===document?'document':event.target instanceof Element?event.target.tagName:'other',
   ...(event instanceof PointerEvent?{pointerId:event.pointerId,pointerType:event.pointerType,isPrimary:event.isPrimary}:{}),automationOnly:true});
 };
 const down=(event:PointerEvent)=>{
  if(!phase||!scoped(event)||event.button!==0)return;
  const y=row(event.clientY);if(y!==null)pointerStart={x:event.clientX,y:event.clientY,row:y,trusted:event.isTrusted};
 };
 const up=(event:PointerEvent)=>{
  if(!phase||!scoped(event))return;
  const y=row(event.clientY);if(pointerStart&&y!==null)gesture={trusted:pointerStart.trusted&&event.isTrusted,startX:pointerStart.x,startY:pointerStart.y,endX:event.clientX,endY:event.clientY,startRow:pointerStart.row,endRow:y};
  pointerStart=undefined;
  const current=phase;requestAnimationFrame(()=>{if(phase!==current)return;const selection=inspectSelection();update(`System automation: ${current.id}; selection matches=${selection.selection===current.expected}; waiting Cmd+C`);void capture.post({progress:'System pointer observation',evidence:{kind:'mac-system-pointer-observation',phase:current.id,selection,gesture,automationOnly:true,humanReceipt:false}}).catch(error=>{problem=error;rejectCopy?.(error);});});
 };
 const validateCopy=async()=>{
  assert(phase&&copyKey&&gesture,'Actual system pointer/copy sequence missing');const current=phase,t=controller().terminal,actual=inspectSelection(),before=await snapshot();
  assert(isManualSelection(current.expected,actual.selection,gesture,current.direction),'Actual OS mouse selection or direction differs');
  assert(actual.position&&actual.position.start.y>=0&&actual.position.end.y<t.buffer.normal.length&&actual.position.start.x>=0&&actual.position.end.x<=t.cols,'Actual selection endpoints invalid');
  assert(current.native?t.options.reflowCursorLine===true:t.options.reflowCursorLine===false,'Actual default/native display mode differs');
  const unicode=t.unicode.activeVersion;assert(unicode===(current.native?'11':'6'),'Actual display provider differs');
  let clipboard:string|undefined;
  await until(async()=>{try{const value=await readClipboardText();if(value===current.expected){clipboard=value;return true;}}catch(error){clipboardIssues.push({phase:current.id,error:String(error),at:Date.now()});}return false;},'Actual macOS clipboard does not equal the exact selected text');
  assert(clipboard===current.expected,'Exact clipboard text missing');lastKnownClipboard=clipboard;
  const after=await snapshot();assert(before.session?.nextInputSequence===after.session?.nextInputSequence,'System copy changed actual Shell input sequence');assert(unexpected.length===0,'Unexpected input interrupted system copy');
  capture.observeSelection();return{phase:current.id,step:phaseIndex+1,status:'passed',gesture,copyKey,selection:actual.selection,selectionHex:hex(actual.selection),position:actual.position,clipboard,clipboardHex:hex(clipboard),display:{unicode,reflow:t.options.reflowCursorLine},brokerBefore:before,brokerAfter:after,automationOnly:true,humanReceipt:false};
 };
 const key=(event:KeyboardEvent)=>{
  if(!scoped(event))return;
  const copy=event.metaKey&&event.key.toLowerCase()==='c',modifier=['Meta','Shift','Control','Alt'].includes(event.key);
  if((!copy&&!modifier)||(!phase&&!modifier)){event.preventDefault();event.stopImmediatePropagation();const error=Error('Unplanned key in automatic system selection');unexpected.push({type:event.type,trusted:event.isTrusted,keyKind:'unexpected',at:Date.now(),phase:phase?.id??'setup-or-close'});problem=error;rejectCopy?.(error);return;}
  if(!phase)return;
  capture.physical.push({type:'keydown',at:Date.now(),phase:phase.id,trusted:event.isTrusted,key:copy?'c':event.key,metaKey:event.metaKey,ctrlKey:event.ctrlKey,automationOnly:true});
  if(!copy||busy)return;if(!event.isTrusted){const error=Error('Copy did not arrive through the actual OS event path');problem=error;rejectCopy?.(error);return;}busy=true;
  copyKey={at:Date.now(),trusted:event.isTrusted,metaKey:event.metaKey,key:'c',automationOnly:true};
  void validateCopy().then(value=>resolveCopy?.(value),error=>{problem=error;rejectCopy?.(error);});
 };
 const rejectContent=(event:Event)=>{if(!scoped(event))return;event.preventDefault();event.stopImmediatePropagation();const error=Error('Unplanned text/composition/paste in system selection');unexpected.push({type:event.type,trusted:event.isTrusted,at:Date.now(),phase:phase?.id??'setup-or-close'});problem=error;rejectCopy?.(error);};
 for(const type of pointerTypes)document.addEventListener(type,observePointer,{capture:true,passive:true});
 document.addEventListener('pointerdown',down,true);document.addEventListener('pointerup',up,true);document.addEventListener('keydown',key,true);
 for(const type of ['beforeinput','paste','compositionstart'])document.addEventListener(type,rejectContent,true);
 const produce=async(source:string,marker:string)=>{
  assert(!problem&&unexpected.length===0,'Unplanned input forbids further fixture commands');
  releaseCopy?.();releaseCopy=undefined;capture.releaseInitial();const offset=capture.raw.length;
  sources.push({source,sourceHex:hex(source),at:Date.now(),kind:'programmatic fixture stdout only; not OS typing'});assert(await controller().writeUserInput(source),'Actual fixture source rejected');
  await until(()=>capture.raw.slice(offset).includes(marker),'Actual Shell stdout marker missing');await until(idle,'Actual fixture prompt did not settle');releaseCopy=controller().suppressUserInput();
 };
 const restoreClipboard=async()=>{
  if(clipboardOriginal===undefined||lastKnownClipboard===undefined)return{restored:false,reason:'Original text unavailable or no owned clipboard write; no original value recorded'};
  const current=await readClipboardText();if(current!==lastKnownClipboard)return{restored:false,reason:'Clipboard changed outside the owned last value; left untouched'};
  await writeClipboardText(clipboardOriginal);assert(await readClipboardText()===clipboardOriginal,'Original text clipboard restoration differs');return{restored:true};
 };
 function View(){const active=useTerminalStore(state=>state.sessions.find(value=>value.sessionId===session.sessionId)??null);const[,render]=useState(0);refresh=()=>render(value=>value+1);return <div style={{display:'flex',flexDirection:'column',width:1100,height:650,marginTop:32}}><TerminalControllerLayer/><p role="status" style={{flexShrink:0,userSelect:'none',margin:0}}>{status}</p><div style={{flex:1,minHeight:0}}><TerminalPane activeSession={active} isActive isVisible/></div></div>;}
 root.render(<View/>);
 try{
  await until(()=>!!capture.controller?.host,'Actual production pane did not mount');await controller().whenOutputReady();await until(idle,'Actual selected native prompt not ready');
  const initial=await snapshot();assert(isMacFileChainProfile(initial.session?.nativePeerProfile,family),'Exact native profile missing');
  update('System selection ready; automation only; no human timer');await capture.checkpoint(plan.readyLabel,{initial,broker:initial,session,routes,automationOnly:true,humanReceipt:false},true);
  try{clipboardOriginal=await readClipboardText();}catch(error){clipboardIssues.push({phase:'original-text',error:String(error),at:Date.now()});}
  await produce(plan.initialSource,plan.initialMarker);
  for(const[index,current]of plan.phases.entries()){
   assert(!problem,'Earlier system input failed');phase=undefined;
   if(current.native)await produce(plan.nativeSource,plan.nativeMarker);
   const sentinel=`SYSTEM_COPY_SENTINEL_${token}_${index}`;await writeClipboardText(sentinel);assert(await readClipboardText()===sentinel,'Actual clipboard sentinel did not read back');lastKnownClipboard=sentinel;preparations.push({phase:current.id,sentinelHex:hex(sentinel),at:Date.now(),acceptanceStepPassed:false});
   phaseIndex=index;gesture=undefined;copyKey=undefined;busy=false;
   const receipt=new Promise<Record<string,unknown>>((done,reject)=>{resolveCopy=done;rejectCopy=reject;});phase=current;controller().focus();update(`System automation: ${current.id}; waiting OS mouse and Cmd+C`);
   await capture.post({progress:'System selection awaiting OS action',evidence:{kind:'mac-system-selection-wait',phase:current.id,index,expectedHex:hex(current.expected),direction:current.direction,native:current.native,automationOnly:true,humanReceipt:false}});
   const actual=await receipt;receipts.push(actual);update(`Waiting original screenshot: ${current.id}`);
   await capture.checkpoint(current.label,{receipt:actual,broker:await snapshot(),automationOnly:true,humanReceipt:false},true);phase=undefined;assert(!problem&&unexpected.length===0,'Unplanned input interrupted system checkpoint');
  }
  await produce(plan.exitModeSource,plan.exitModeMarker);assert(controller().terminal.unicode.activeVersion==='6'&&controller().terminal.options.reflowCursorLine===false,'Actual native display baseline did not restore');
  update('System selections complete; no human receipt');await capture.checkpoint(plan.finalLabel,{receipts,broker:await snapshot(),automationOnly:true,humanReceipt:false},true);
 }catch(error){problem??=error;}
 phase=undefined;releaseCopy?.();releaseCopy=undefined;capture.releaseInitial();let clipboard:Record<string,unknown>;
 try{clipboard=await restoreClipboard();}catch(error){problem??=error;clipboard={restored:false,error:String(error)};}
 try{if(!problem){assert(await controller().writeUserInput('exit\r'),'Actual normal Shell exit rejected');await until(()=>capture.closedObserved,'Actual natural transport EOF missing');}await invokeCloseSession(session.sessionId);await until(()=>capture.wireFinalized,'Actual transport wire finalization missing');}
 catch(error){problem??=error;}
 try{await capture.checkpoint('system-selection-transport-end',{broker:await snapshot(),closedObserved:capture.closedObserved,wireFinalized:capture.wireFinalized,automationOnly:true,humanReceipt:false},false);}
 catch(error){problem??=error;}
 for(const type of pointerTypes)document.removeEventListener(type,observePointer,true);
 document.removeEventListener('pointerdown',down,true);document.removeEventListener('pointerup',up,true);document.removeEventListener('keydown',key,true);for(const type of ['beforeinput','paste','compositionstart'])document.removeEventListener(type,rejectContent,true);
 await capture.finish(session.sessionId,{family,selection:mode,session,requiredSystemPhases:plan.phases.map(value=>value.id),receipts,preparations,clipboard,clipboardIssues,unexpected,sources,pointerObservation:{observed:pointerEventsObserved,overflow:pointerEventsOverflow,limit:1000},sourceSamples:plan.sourceSamples,modelCalls:0,agentSubmissions:0,humanReceipt:false,physicalInputClaim:false,systemInputAutomation:true,scope:'Actual macOS OS pointer/Meta-C, production pane/copy path and native clipboard, tool driven. No real-user, hardware keyboard, IME or human completion receipt claimed.'},!problem,problem?String(problem):undefined);
 terminalRegistry.dispose(session.sessionId);root.unmount();
}
void start().catch(error=>fetch('/__agent-stream-result/'+new URL(location.href).searchParams.get('token'),{method:'POST',body:JSON.stringify({ok:false,error:String(error),evidence:{kind:'mac-system-selection-failure',humanReceipt:false,systemInputAutomation:true}})}));
