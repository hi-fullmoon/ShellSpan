import React,{useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {getCurrentWindow} from '@tauri-apps/api/window';
import {TerminalControllerLayer} from '../terminal-controller-layer';
import {TerminalPane} from '../terminal-pane';
import {terminalRegistry} from '../registry/terminal-registry';
import {getTerminalScrollState} from '../terminal-scroll-state';
import {useTerminalStore} from '@/stores/terminalStore';
import {useAppStore} from '@/stores/appStore';
import {useToastStore} from '@/stores/toastStore';
import {readClipboardText} from '@/lib/clipboard';
import {initI18n,t} from '@/locales';
import {NativeDisplayManualInstructions} from './native-display-manual-instructions';
import {invokeCreateLocalSession,invokeCloseSession,invokeGetTerminalBrokerSnapshot} from '@/lib/ipc/tauri';
import {isCurrentNativeEditorProfile} from './native-editor-profile';
import {nativeDisplaySamples,isManualSelection,manualPointerRow,matchesKnownClipboard,type ManualPointerGesture} from './native-display-manual-plan';
import {nativeFileCoreSetup,readNativeFileLoadedCore} from './native-file-chain-approval';
import '@/styles/base.css';

declare const __PACKAGE_REPORT__:string;
declare const __PACKAGE_SHELL_KIND__:string;
declare const __PACKAGE_SHELL_VERSION__:string;
declare const __PACKAGE_NATIVE_SHA__:string|null;
function assert(value:unknown,message:string):asserts value{if(!value)throw Error(message);}
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(test:()=>boolean|Promise<boolean>,message:string){const deadline=Date.now()+20000;while(!await test()){assert(Date.now()<deadline,message);await wait(25);}}
const steps=[
 {key:'ascii',label:'Drag SELECT_ASCII left to right; automatic copy',direction:'forward'},
 {key:'ascii',label:'Drag SELECT_ASCII right to left; automatic copy',direction:'reverse'},
 {key:'unicode',label:'Select the entire SELECT_UNICODE line; automatic copy',direction:'forward'},
 {key:'soft',label:'Select SOFT_START through SOFT_END across soft wraps',direction:'forward'},
 {key:'hard',label:'Select HARD_FIRST through HARD_SECOND; press Ctrl+Shift+C',direction:'forward'},
] as const;
type Receipt=Readonly<Record<string,unknown>>;
const diagnostic:{raw:string;rawCharacters:number;before:Awaited<ReturnType<typeof invokeGetTerminalBrokerSnapshot>>|null;displayedLines:readonly string[];loadedCore:ReturnType<typeof readNativeFileLoadedCore>}={raw:'',rawCharacters:0,before:null,displayedLines:[],loadedCore:null};
function ManualDisplay({sessionId,finish}:{sessionId:string;finish:(receipts:Receipt[])=>Promise<void>}){
 const session=useTerminalStore(s=>s.sessions.find(v=>v.sessionId===sessionId)??null);
 const [ready,setReady]=useState(false),[started,setStarted]=useState(false),[step,setStep]=useState(0),[message,setMessage]=useState(t('terminal.acceptance.preparing')),[receipts,setReceipts]=useState<Receipt[]>([]),[narrow,setNarrow]=useState(false);
 const [gesture,setGesture]=useState<ManualPointerGesture>(),[copyKey,setCopyKey]=useState(false),[wheel,setWheel]=useState(false);
 const receiptsRef=useRef<Receipt[]>([]);
 const busyRef=useRef(false),[busy,setBusy]=useState(false);
 useEffect(()=>{
  let start:{x:number;y:number;row:number;trusted:boolean}|undefined;
  const terminalTarget=(event:Event)=>event.target instanceof Element&&!!event.target.closest(`[data-terminal-pane-session="${sessionId}"] .xterm`);
  const pointerRow=(y:number)=>{const terminal=terminalRegistry.get(sessionId)?.terminal,bounds=terminal?.element?.querySelector('.xterm-screen')?.getBoundingClientRect();return terminal&&bounds?manualPointerRow(y,bounds.top,bounds.height,terminal.rows):null;};
  const down=(e:PointerEvent)=>{if(terminalTarget(e)&&e.button===0){const row=pointerRow(e.clientY);start=row===null?undefined:{x:e.clientX,y:e.clientY,row,trusted:e.isTrusted};}};
  const up=(e:PointerEvent)=>{if(start&&terminalTarget(e)){const row=pointerRow(e.clientY);if(row!==null)setGesture({trusted:start.trusted&&e.isTrusted,startX:start.x,startY:start.y,endX:e.clientX,endY:e.clientY,startRow:start.row,endRow:row});}start=undefined;};
  const key=(e:KeyboardEvent)=>{if(terminalTarget(e)&&e.isTrusted&&e.ctrlKey&&e.shiftKey&&e.key.toLowerCase()==='c')setCopyKey(true);};
  const scroll=(e:WheelEvent)=>{if(terminalTarget(e)&&e.isTrusted&&e.deltaY<0)setWheel(true);};
  document.addEventListener('pointerdown',down,true);document.addEventListener('pointerup',up,true);document.addEventListener('keydown',key,true);document.addEventListener('wheel',scroll,true);
  return()=>{document.removeEventListener('pointerdown',down,true);document.removeEventListener('pointerup',up,true);document.removeEventListener('keydown',key,true);document.removeEventListener('wheel',scroll,true);};
 },[sessionId]);
 useEffect(()=>{let releaseInput:(()=>void)|undefined,unsubscribe:(()=>void)|undefined;let cancelled=false;
  void(async()=>{
   await until(()=>!!terminalRegistry.get(sessionId)?.host,'Actual TerminalPane did not attach');const controller=terminalRegistry.get(sessionId)!;await controller.whenOutputReady();
   await until(async()=>{const s=(await invokeGetTerminalBrokerSnapshot(sessionId)).session;return !!s?.promptReady&&isCurrentNativeEditorProfile(s.nativePeerProfile,__PACKAGE_SHELL_KIND__);},'Actual native provider unavailable');
   const before=await invokeGetTerminalBrokerSnapshot(sessionId);assert(before.session?.nativePeerProfile?.shellVersion===__PACKAGE_SHELL_VERSION__,'Wrong host version');
   diagnostic.before=before;unsubscribe=controller.subscribeOutput(value=>{diagnostic.rawCharacters+=value.length;if(diagnostic.raw.length<1048576)diagnostic.raw+=value.slice(0,1048576-diagnostic.raw.length);});
   const payload=Array.from({length:120},(_,i)=>`HISTORY_${String(i).padStart(3,'0')} stable anchor`).join('\n')+'\n'+[nativeDisplaySamples.ascii,nativeDisplaySamples.unicode,nativeDisplaySamples.soft,nativeDisplaySamples.hard,'MANUAL_DISPLAY_READY'].join('\n');
   const encoded=btoa(Array.from(new TextEncoder().encode(payload),b=>String.fromCharCode(b)).join(''));
   assert(await controller.writeUserInput(nativeFileCoreSetup+`; [Console]::WriteLine([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')))\r`),'Fixture output command was blocked');
   await until(()=>Array.from({length:controller.terminal.buffer.normal.length},(_,i)=>controller.terminal.buffer.normal.getLine(i)?.translateToString(true)).includes('MANUAL_DISPLAY_READY'),'Actual PTY output missing');
   releaseInput=controller.suppressUserInput();
   diagnostic.displayedLines=Array.from({length:controller.terminal.buffer.normal.length},(_,i)=>controller.terminal.buffer.normal.getLine(i)?.translateToString(true)??'');diagnostic.loadedCore=readNativeFileLoadedCore(diagnostic.raw);assert(diagnostic.loadedCore?.sha256===__PACKAGE_NATIVE_SHA__,'Actual display Shell did not load the selected DLL');
   await fetch(__PACKAGE_REPORT__,{method:'POST',body:JSON.stringify({ready:true,evidence:{kind:'manual-native-display-ready',before,clipboardRead:false,operatorActions:0,scope:'Actual ordinary-user PTY output;no Agent/source proof or completed manual cases.'}})});
   if(!cancelled){setReady(true);setMessage(t('terminal.acceptance.ready'));}
  })().catch(error=>{setMessage(t('terminal.acceptance.failure'));void fetch(__PACKAGE_REPORT__,{method:'POST',body:JSON.stringify({ok:false,error:String(error),evidence:{kind:'manual-display-preparation-failure',diagnostic}})});});
  return()=>{cancelled=true;releaseInput?.();unsubscribe?.();};
 },[sessionId]);
 const verify=async()=>{
  assert(started,'Operator has not started manual checks');
  const controller=terminalRegistry.get(sessionId);assert(controller,'Actual controller missing');
  if(step<steps.length){
   const current=steps[step],expected=nativeDisplaySamples[current.key],selection=controller.terminal.getSelection();
   if(!isManualSelection(expected,selection,gesture,current.direction)||(step===4&&!copyKey)){setMessage(t('terminal.acceptance.mismatch'));return;}
   await wait(350);const deadline=Date.now()+3000;let matched:ReturnType<typeof matchesKnownClipboard>=null;
   do{await wait(100);matched=matchesKnownClipboard(expected,await readClipboardText());}while(!matched&&Date.now()<deadline);
   const settings=useAppStore.getState();
   const receipt={step:step+1,sample:current.key,direction:current.direction,gesture,copyKey:step===4?copyKey:undefined,selectionExact:true,clipboardMatched:matched!==null,clipboardLineEnding:matched,copySettings:{copyOnSelect:settings.terminalCopyOnSelect,trimTrailingWhitespace:settings.terminalTrimTrailingWhitespace},copyFailureToastCount:useToastStore.getState().toasts.filter(toast=>toast.variant==='error'&&toast.message===t('terminal.feedback.copyFailed')).length};
   const next=[...receipts,receipt];receiptsRef.current=next;setReceipts(next);await fetch(__PACKAGE_REPORT__,{method:'POST',body:JSON.stringify({progress:true,evidence:{kind:'manual-native-display-progress',receipts:next}})});assert(matched,'Known selected text differed from the system clipboard');setStep(step+1);setGesture(undefined);setCopyKey(false);setMessage(t('terminal.acceptance.verified'));
   if(step+1===4)useAppStore.setState({terminalCopyOnSelect:false});
   if(step+1===steps.length)setWheel(false);
  }else{
   const buffer=controller.terminal.buffer.normal,selection=controller.terminal.getSelection(),before={viewportY:buffer.viewportY,baseY:buffer.baseY,columns:controller.terminal.cols,top:buffer.getLine(buffer.viewportY)?.translateToString(true),selection};
   if(!wheel||!getTerminalScrollState(controller.terminal).getSnapshot().history||selection!==nativeDisplaySamples.history||!before.top?.startsWith('HISTORY_')){setMessage(t('terminal.acceptance.historyMismatch'));return;}
   setNarrow(true);await until(()=>controller.terminal.cols<before.columns,'Narrow layout did not change the terminal geometry');
   await until(async()=>(await invokeGetTerminalBrokerSnapshot(sessionId)).session?.geometry.columns===controller.terminal.cols,'Backend PTY did not acknowledge the narrowed geometry');await wait(350);
   const after={viewportY:buffer.viewportY,baseY:buffer.baseY,columns:controller.terminal.cols,top:buffer.getLine(buffer.viewportY)?.translateToString(true),selection:controller.terminal.getSelection()};
   const receipt={step:6,kind:'operator-history-narrow-layout',trustedWheel:wheel,before,after,selectionPreserved:after.selection===before.selection,topAnchorPreserved:after.top===before.top};
   const next=[...receipts,receipt];receiptsRef.current=next;setReceipts(next);assert(receipt.selectionPreserved&&receipt.topAnchorPreserved,'Actual history anchor or selection changed during narrowing');await finish(next);
  }
 };
 const defer=()=>fetch(__PACKAGE_REPORT__,{method:'POST',body:JSON.stringify({ok:false,blocked:true,error:'MANUAL_OPERATOR_DEFERRED',evidence:{kind:'manual-native-display-deferred',receipts:receiptsRef.current,diagnostic}})});
 const verifyOnce=()=>{if(busyRef.current)return;busyRef.current=true;setBusy(true);void verify().catch(error=>{setReady(false);setMessage(t('terminal.acceptance.failure'));return fetch(__PACKAGE_REPORT__,{method:'POST',body:JSON.stringify({ok:false,error:String(error),evidence:{kind:'manual-native-display-failure',receipts:receiptsRef.current,diagnostic}})});}).finally(()=>{busyRef.current=false;setBusy(false);});};
 const startManual=(event:React.MouseEvent<HTMLButtonElement>)=>{if(!event.isTrusted||!ready||started||busyRef.current)return;busyRef.current=true;setBusy(true);void(async()=>{const response=await fetch(__PACKAGE_REPORT__,{method:'POST',body:JSON.stringify({started:true,evidence:{kind:'manual-native-display-start',trusted:event.isTrusted}})});assert(response.ok,'Operator start was not acknowledged');setGesture(undefined);setCopyKey(false);setWheel(false);setStarted(true);setMessage(t('terminal.acceptance.started'));})().catch(error=>{setReady(false);setMessage(t('terminal.acceptance.failure'));return fetch(__PACKAGE_REPORT__,{method:'POST',body:JSON.stringify({ok:false,error:String(error)})});}).finally(()=>{busyRef.current=false;setBusy(false);});};
 return <div className="flex h-screen min-h-0 flex-col gap-3 p-3"><TerminalControllerLayer/><NativeDisplayManualInstructions ready={ready} started={started} busy={busy} step={receipts.length} message={message} onStart={startManual} onVerify={verifyOnce} onDefer={()=>{void defer();}}/><div className="min-h-0 flex-1" style={{width:narrow?Math.min(640,Math.max(120,Math.floor((innerWidth-24)*0.7))):'100%'}}><TerminalPane activeSession={session} isActive isVisible/></div></div>;
}
async function start(){
 await initI18n('zh-CN');document.documentElement.lang='zh-CN';document.title=t('terminal.acceptance.title');await getCurrentWindow().show();await getCurrentWindow().setFocus();
 useAppStore.setState({terminalCopyOnSelect:true,terminalTrimTrailingWhitespace:false});
 const session=await invokeCreateLocalSession(100,30);useTerminalStore.getState().addSession(session);useTerminalStore.getState().setActiveSession(session.sessionId);const root=createRoot(document.getElementById('root')!);
 const finish=async(receipts:Receipt[])=>{const snapshot=await invokeGetTerminalBrokerSnapshot(session.sessionId);await fetch(__PACKAGE_REPORT__+'/capture',{method:'POST'});await invokeCloseSession(session.sessionId);terminalRegistry.dispose(session.sessionId);await fetch(__PACKAGE_REPORT__,{method:'POST',body:JSON.stringify({ok:true,evidence:{kind:'actual-manual-native-display',receipts,snapshot,diagnostic,scope:'Six operator selection/clipboard/history-narrowing subcases. No full D01-D06/native-source/model claim.'}})});root.unmount();};
 root.render(<ManualDisplay sessionId={session.sessionId} finish={finish}/>);
}
void start().catch(error=>fetch(__PACKAGE_REPORT__,{method:'POST',body:JSON.stringify({ok:false,error:String(error)})}));
