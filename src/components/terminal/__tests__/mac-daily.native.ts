import {getCurrentWindow} from '@tauri-apps/api/window';
import {terminalRegistry} from '../registry/terminal-registry';
import {useTerminalStore} from '@/stores/terminalStore';
import {useAppStore} from '@/stores/appStore';
import {initI18n} from '@/locales';
import {invokeCreateLocalSession,invokeCloseSession,invokeGetTerminalBrokerSnapshot,invokeListAiRoutes,invokeGetTerminalAcceptanceRawOutput,invokeCreateAgentRuntimeSession,invokePrepareTerminalAcceptanceRawCommand,listenToTerminalAcceptanceRawOutput,type TerminalAcceptanceRawFrameEvent} from '@/lib/ipc/tauri';
import {isMacFileChainProfile,quotePosixFileSource} from './native-file-chain-posix';
import {NativeDisplayTrace,nativeDisplayTraceState} from './native-display-trace';
import {nativeDisplayHistoryAnchor} from './native-display-history-plan';
import {macDailyExpectedRecords,macDailyEditingVisualCheckpoints,macDailyOutputPlan,macDailyPasteValues,macDailyTailEditPlan,macDailyUnicodeEditPlan} from './mac-daily-input-plan';
import {runMacDailyEditing} from './mac-daily-editing';
import {runMacDailyPump} from './mac-daily-pump';
import {runMacDailyToast} from './mac-daily-toast';
import {createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {Toaster} from '@/components/ui/sonner';
import {compactMacDailyRecords} from './mac-daily-evidence';
import '@/styles/base.css';

function assert(value:unknown,message:string):asserts value{if(!value)throw Error(message);}
async function until(test:()=>boolean|Promise<boolean>,message:string,milliseconds=20000){
 const end=Date.now()+milliseconds;
 while(!await test()){assert(Date.now()<end,message);await new Promise(done=>setTimeout(done,20));}
}
const hex=(value:string)=>Array.from(new TextEncoder().encode(value),b=>b.toString(16).padStart(2,'0')).join('');

async function verify(){
 const params=new URL(location.href).searchParams,token=params.get('token'),selection=params.get('macDaily');
 assert(token&&['bash','zsh','raw-bash','raw-zsh','editing-bash','editing-zsh','pump-bash','pump-zsh','toast-bash','toast-zsh'].includes(selection??''),'Exact owned Mac daily case required');
 const editingMode=selection!.startsWith('editing-'),pumpMode=selection!.startsWith('pump-'),toastMode=selection!.startsWith('toast-'),family=editingMode?selection!.slice(8):pumpMode?selection!.slice(5):toastMode?selection!.slice(6):selection!;
 const rawMode=family!.startsWith('raw-');
 const report=async(value:unknown)=>{const response=await fetch(`/__agent-stream-result/${token}`,{method:'POST',body:JSON.stringify(value)});assert(response.ok,'Actual daily evidence retention rejected: HTTP '+response.status);return response;};
 await initI18n('en-US');await getCurrentWindow().show();await getCurrentWindow().setFocus();
 useAppStore.setState({terminalCopyOnSelect:false});
 const routes=await invokeListAiRoutes();assert(!routes.routes.length&&!routes.defaultSelection,'No-model case must start with an empty route store');
 const storageKey='shellspan.phase2.isolated-webview',previousStorage=localStorage.getItem(storageKey);
 assert(previousStorage===null,'This case reused an earlier WebKit data store');localStorage.setItem(storageKey,token);
 assert(localStorage.getItem(storageKey)===token,'Actual owned WebKit storage write/read failed');
 const host=document.createElement('div');host.id='mac-daily-terminal';host.style.cssText='width:1100px;height:650px;margin-top:32px';document.getElementById('root')!.append(host);
 let raw='',visible='',trace:NativeDisplayTrace|undefined,problem:unknown;
 const records:Record<string,unknown>[]=[],input:{data:string;hex:string;at:number;kind:string}[]=[],stops:(()=>void)[]=[],visualFailures:unknown[]=[],publicInput:{data:string;hex:string;at:number}[]=[];
 if(toastMode){const element=document.createElement('div');document.body.append(element);const root=createRoot(element);root.render(createElement(Toaster));stops.push(()=>{root.unmount();element.remove();});}
 const wireEvents:TerminalAcceptanceRawFrameEvent[]=[];let wireBytes=0,wireCaptureError:unknown;
 stops.push(await listenToTerminalAcceptanceRawOutput(event=>{
  wireBytes+=event.payload.frame.bytes.length;
  if(wireBytes>16*1024*1024){wireCaptureError=Error('Observed original PTY frame capture exceeds fixed bound');return;}
  wireEvents.push(event.payload);
 }));
 const session=await invokeCreateLocalSession(100,30);
 useTerminalStore.getState().addSession(session);
 stops.push(terminalRegistry.subscribe(()=>{
  const c=terminalRegistry.get(session.sessionId);if(!c||trace)return;
  const t=c.terminal,b=t.buffer.active;
  trace=new NativeDisplayTrace({columns:t.cols,rows:t.rows,empty:b.baseY===0&&b.cursorX===0&&b.cursorY===0&&Array.from({length:b.length},(_,y)=>b.getLine(y)?.translateToString(true)??'').every(x=>x===''),unicodeVersion:t.unicode.activeVersion,nativeDisplayBinding:session.ptyInfo?.nativeDisplayBinding,
   options:{windowsPty:t.options.windowsPty,scrollback:t.options.scrollback,fontFamily:t.options.fontFamily,fontSize:t.options.fontSize,lineHeight:t.options.lineHeight,letterSpacing:t.options.letterSpacing,reflowCursorLine:t.options.reflowCursorLine}});
  const owned=trace;
  stops.push(c.subscribeOutput(chunk=>{assert(raw.length+chunk.length<900000,'Raw output exceeds bound');raw+=chunk;}));
  stops.push(c.subscribeDisplayOutput(({source,data})=>{const n=owned.output(data,source);visible+=data;queueMicrotask(()=>t.write('',()=>owned.parsed(n)));}));
  const resize=t.onResize(({cols,rows})=>owned.resize(cols,rows));stops.push(()=>resize.dispose());
 }));
 const c=terminalRegistry.create(session.sessionId,(id,event)=>useTerminalStore.getState().setStatus(id,event),(id,event)=>useTerminalStore.getState().setClosed(id,event),id=>useTerminalStore.getState().sessions.find(x=>x.sessionId===id)?.status??'connecting',()=>{},session.ptyInfo);
 const t=c.terminal,original={selection:t.getSelection,select:t.select,write:t.write,open:t.open,line:t.buffer.normal.getLine};
 const viewportEvents:Record<string,unknown>[]=[],viewportResizes:Record<string,unknown>[]=[];
 let viewportStage:string|undefined;
 const observeViewport=()=>({at:Date.now(),columns:t.cols,rows:t.rows,viewportY:t.buffer.normal.viewportY,baseY:t.buffer.normal.baseY,selection:t.getSelection(),position:t.getSelectionPosition()??null});
 const observeLayout=()=>{const rect=host.getBoundingClientRect(),screen=t.element?.querySelector('.xterm-screen')?.getBoundingClientRect(),style=t.element?getComputedStyle(t.element):undefined;return{devicePixelRatio,host:{width:rect.width,height:rect.height},screen:screen?{width:screen.width,height:screen.height}:null,font:style?{family:style.fontFamily,size:style.fontSize,lineHeight:style.lineHeight}:null};};
 const viewportScroll=t.onScroll(()=>{if(viewportStage){assert(viewportEvents.length<256,'Viewport observation bound exceeded');viewportEvents.push({kind:'scroll',stage:viewportStage,...observeViewport()});}});
 const viewportResize=t.onResize(()=>{if(viewportStage){assert(viewportEvents.length<256,'Viewport observation bound exceeded');viewportEvents.push({kind:'resize',stage:viewportStage,...observeViewport()});}});
 stops.push(()=>viewportScroll.dispose(),()=>viewportResize.dispose());
 const inputObserver=t.onData(data=>publicInput.push({data,hex:hex(data),at:Date.now()}));stops.push(()=>inputObserver.dispose());
 // onData also contains real parser replies and focus reports requested by
 // TUI programs. Preserve every event; only DOM input can interfere with this
 // programmatic case. Never classify an onData event as a physical key.
 const domInput:{type:string;trusted:boolean;at:number}[]=[];
 const observeDomInput=(event:Event)=>domInput.push({type:event.type,trusted:event.isTrusted,at:Date.now()});
 for(const type of ['keydown','beforeinput','paste','compositionstart']){host.addEventListener(type,observeDomInput,true);stops.push(()=>host.removeEventListener(type,observeDomInput,true));}
 const drain=async()=>{await new Promise<void>(done=>t.write('',done));await new Promise<void>(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done())));await new Promise<void>(done=>t.write('',done));};
 const snapshot=()=>invokeGetTerminalBrokerSnapshot(session.sessionId);
 // Read public cells only. Keep printed spaces and combining sequences intact;
 // empty padding cells are not source text. This never writes or reselects.
 const draftState=(source:string)=>{
  const b=t.buffer.normal,cursorRow=b.baseY+b.cursorY;let start=cursorRow;
  while(start>0&&b.getLine(start)?.isWrapped)start--;
  const cells=[];let text='',afterCursor='';
  for(let row=start;row<=cursorRow;row++)for(let column=0;column<t.cols;column++){
   const cell=b.getLine(row)?.getCell(column);assert(cell,'Draft public cell missing');
   const chars=cell.getChars();cells.push({row,column,chars,width:cell.getWidth()});
   if(row<cursorRow||column<b.cursorX)text+=chars;else afterCursor+=chars;
  }
  const expectedEcho=family==='zsh'?source.replace(/\u200d/g,'<200d>'):source;
  return{start,cursor:{row:cursorRow,column:b.cursorX},text,afterCursor,cells,expectedEcho,
   complete:text.endsWith(expectedEcho)&&/^ *$/.test(afterCursor),
   combiningAttached:cells.filter(cell=>cell.chars==='e\u0301').length===1};
 };
 const parkedState=()=>{
  const b=t.buffer.normal,position=t.getSelectionPosition();
  assert(position&&position.start.y>=0&&position.end.y<b.length&&position.start.x>=0&&position.start.x<t.cols&&position.end.x>=0&&position.end.x<=t.cols,'Parked selection has invalid public coordinates');
  return{position,viewportY:b.viewportY,baseY:b.baseY,anchorOffset:position.start.y-b.viewportY,selection:t.getSelection()};
 };
 const idle=async()=>{const state=(await snapshot()).session;return !!state&&state.promptReady&&!state.inputObservation?.commandInputPending&&!state.inputObservation?.nativeRecoveryRequired;};
 const send=async(data:string,kind='programmatic ordinary user input')=>{assert(!wireCaptureError,'Actual raw-frame observation failed');assert(domInput.length===0,'Unexpected DOM input interfered with automatic case');input.push({data,hex:hex(data),at:Date.now(),kind});assert(await c.writeUserInput(data),'Ordinary input rejected: '+kind);};
 const checkpoint=async(label:string,details:Record<string,unknown>={})=>{
  await drain();assert(trace,'Complete visible observer missing');
  assert(t.getSelection===original.selection&&t.select===original.select&&t.write===original.write&&t.open===original.open&&t.buffer.normal.getLine===original.line,'Public terminal API changed');
  const at=Date.now(),state=nativeDisplayTraceState(t),display={unicode:t.unicode.activeVersion,reflow:t.options.reflowCursorLine};
  await trace.checkpoint(label,state);
  const broker=await snapshot(),brokerCapturedAt=Date.now();
  records.push({label,at,state,broker,brokerCapturedAt,display,...details});
  // The server retains each complete checkpoint in an immutable progress file.
  // Do not resend every prior full buffer on each subsequent checkpoint.
  await report({progress:'Mac daily checkpoint: '+label,evidence:{kind:'mac-daily-progress',family,session,recordIndex:records.length-1,records:[records[records.length-1]],input,publicInput,domInput,viewportEvents,viewportResizes,modelCalls:0,humanReceipt:false}});
  if(['ready','tui-enter','tui-edit','tui-exit','draft-440x320','draft-360x580','draft-1100x650','parked-360','follow-new-output','pump-completion-ended','toast-visible',...macDailyEditingVisualCheckpoints].includes(label)){
   const response=await fetch(`/__native-mac-daily-checkpoint/${token}/${label}`,{method:'POST'});assert(response.ok,'Automation visual checkpoint was not observed');
   const observation=await response.json() as {visualPassed:boolean;notes:string};if(!observation.visualPassed)visualFailures.push({label,...observation});
  }
 };
 const commandFor=(value:string,index:number)=>macDailyOutputPlan(token,value,index);
 const finishOutput=async(value:string,index:number,offset:number,details:Record<string,unknown>={})=>{
  const {prefix}=commandFor(value,index),expected=prefix+hex(value)+':END\r\n';
  await until(()=>raw.slice(offset).includes(expected),'Exact independent output bytes missing for '+index);
  await until(idle,'Prompt not restored after '+index);await checkpoint('ordinary-'+index,{value,inputValueHex:hex(value),expectedOutput:expected,rawRange:{start:offset,end:raw.length},...details});
 };
 let initial:Awaited<ReturnType<typeof snapshot>>|undefined;
 try{
  c.attach(host);await c.whenOutputReady();c.focus();await drain();
  assert(trace?.initial.empty,'Visible observation began too late');
  if(rawMode){await until(()=>useTerminalStore.getState().sessions.find(x=>x.sessionId===session.sessionId)?.status==='connected','Raw transport unavailable');}
  else await until(idle,'Native prompt not ready');
  initial=await snapshot();
  if(rawMode)assert(initial.session?.inputMode==='raw'&&!initial.session.nativePeerProfile,'Unsupported actual system Shell did not downgrade');
  else assert(isMacFileChainProfile(initial.session?.nativePeerProfile,family),'Exact native profile missing');
  await checkpoint('ready',{initial,routes,webviewStorage:{key:storageKey,previous:previousStorage,value:localStorage.getItem(storageKey)},renderer:{domRows:host.querySelectorAll('.xterm-rows').length,canvas:host.querySelectorAll('canvas').length,unicode:t.unicode.activeVersion}});
  if(rawMode){
   const home=params.get('caseHome');assert(home&&home.startsWith('/'),'Exact raw acceptance HOME missing');
   let offset=raw.length;
   const ordinary=commandFor('RAW_中文_e\u0301_👩🏽‍💻',0);
   await send(ordinary.source+'\r');
   await until(()=>raw.slice(offset).includes(ordinary.prefix+hex('RAW_中文_e\u0301_👩🏽‍💻')+':END\r\n'),'Actual raw ordinary input output differs');
   await checkpoint('raw-ordinary');
   await send('/usr/bin/vi -u NONE -N "$HOME/phase2-raw-tui.txt"\r');
   await until(()=>t.buffer.active.type==='alternate','Raw system Shell could not start installed vi');await checkpoint('tui-enter');
   await send('iRAW_TUI_中文\x1b');
   await until(()=>Array.from({length:t.buffer.active.length},(_,y)=>t.buffer.active.getLine(y)?.translateToString(true)??'').some(line=>line.includes('RAW_TUI_中文')),'Actual raw vi interaction missing');await checkpoint('tui-edit');
   await send(':q!\r');await until(()=>t.buffer.active.type==='normal','Actual raw vi did not restore normal screen');
   offset=raw.length;const recovery=commandFor('RAW_TUI_RECOVERED',1);await send(recovery.source+'\r');
   await until(()=>raw.slice(offset).includes(recovery.prefix+hex('RAW_TUI_RECOVERED')+':END\r\n'),'Raw TUI did not restore ordinary input');await checkpoint('tui-exit');
   const beforeReadonly=await snapshot();await invokeGetTerminalAcceptanceRawOutput(session.sessionId);const afterReadonly=await snapshot();
   assert(beforeReadonly.session?.nextInputSequence===afterReadonly.session?.nextInputSequence&&afterReadonly.session?.inputMode==='raw'&&!afterReadonly.session.nativePeerProfile,'Readonly raw capture changed input or native capabilities');
   await checkpoint('raw-readonly',{beforeReadonly,afterReadonly});
   const id='raw-acceptance-'+crypto.randomUUID(),target={kind:'local' as const,targetId:'terminal-'+session.sessionId,sessionId:session.sessionId,cwd:home,localRoot:home};
   const created=await invokeCreateAgentRuntimeSession({sessionId:id,taskId:id,goal:'Verify unsupported raw terminal rejects preparation without executing source',target,permissionMode:'requestApproval',executionSurface:'boundTerminal',capabilityScope:{toolNames:['run_terminal_command'],effects:['stateChange'],targetIds:[target.targetId]}});
   assert(!created.header.modelSelection,'Raw preparation session unexpectedly selected a model');
   for(const background of [false,true]){
    const result=await invokePrepareTerminalAcceptanceRawCommand(id,background);
    records.push({label:'raw-preparation-'+background,result});
    assert(result.rejection?.startsWith('TERMINAL_VISIBLE_COMMAND_UNAVAILABLE')&&!result.unexpectedPreparationAbandoned,'Raw Agent source/job was not rejected at production cooperative preparation: '+result.rejection);
    assert(result.brokerBefore.session?.nextInputSequence===result.brokerAfter.session?.nextInputSequence,'Raw preparation wrote Agent source input');
    assert(result.brokerAfter.session?.inputMode==='raw'&&!result.brokerAfter.session.nativePeerProfile,'Raw preparation granted native capability');
    assert(result.recoveryBefore.length===0&&result.recoveryAfter.length===0&&!result.effectBefore&&!result.effectAfter,'Raw preparation persisted a submission or test effect');
    assert(result.headerBefore.executionSurface==='boundTerminal'&&result.sessionAfter.header.executionSurface==='boundTerminal','Raw preparation fell back to Direct');
   }
   await checkpoint('raw-production-refusal');
   await send('exit\r');await until(()=>useTerminalStore.getState().sessions.find(x=>x.sessionId===session.sessionId)?.status==='disconnected','Raw Shell transport did not end');await drain();await checkpoint('transport-end');
  }else if(toastMode){
   const home=params.get('caseHome');assert(home,'Toast acceptance requires its actual isolated HOME');
   await runMacDailyToast({token,terminal:t,host,send,checkpoint,finishOutput,drain,fit:()=>c.fit(),idle,snapshot,raw:()=>raw,publicInput,action:action=>trace!.action(action),draftState},home);
  }else if(pumpMode){
   await runMacDailyPump({token,terminal:t,host,send,checkpoint,finishOutput,drain,fit:()=>c.fit(),idle,snapshot,raw:()=>raw,publicInput,action:action=>trace!.action(action),draftState});
  }else if(editingMode){
   await runMacDailyEditing({token,terminal:t,host,send,checkpoint,finishOutput,drain,fit:()=>c.fit(),idle,snapshot,raw:()=>raw,publicInput,action:action=>trace!.action(action),draftState});
  }else{
  // Byte assertions use the separately printed hex of the edited value, never its echo.
  let offset=raw.length;
  const ascii=commandFor('EDIT_OK',0),position=ascii.source.indexOf('EDIT_OK');
  assert(position>=0,'ASCII plan invalid');
  await send(ascii.source.slice(0,position)+'EDIT_ZXK'+ascii.source.slice(position+7));
  const tail=ascii.source.length-position-7;
  await send('\x01');await send('\x05');await send('\x1b[D'.repeat(tail+3));await send('\x1b[3~');await send('\x1b[C');await send('\x7f');await send('O');await send('\x1b[C');await send('\x05\r');
  await finishOutput('EDIT_OK',0,offset);
  for(const [index,value]of macDailyPasteValues(token)){
   if(index===2||index===3){
    offset=raw.length;const plan=macDailyTailEditPlan(token,value,index),before=publicInput.length;
    assert(domInput.length===0,'Unexpected DOM input before NFC/NFD paste');t.paste(plan.source);await until(()=>publicInput.length>before,'NFC/NFD public paste produced no input');
    await send('\x1b[D'.repeat(plan.suffixCharacters),'move to original NFC/NFD ASCII tail');await send('\x7f');await send('OK');
    await checkpoint(index===2?'nfc-tail-edit':'nfd-tail-edit',{plan,originalPrefixHex:hex(value),submitted:false});
    assert(!raw.slice(offset).includes(plan.prefix+hex(plan.expectedValue)+':END\r\n'),'NFC/NFD input executed before Enter');
    await send('\x05\r');await finishOutput(plan.expectedValue,index,offset,{plan,originalPrefixHex:hex(value),asciiTailActuallyEdited:true});continue;
   }
   offset=raw.length;const plan=commandFor(value,index);
   assert(domInput.length===0,'Unexpected DOM input before paste');const before=publicInput.length;t.paste(plan.source);await until(()=>publicInput.length>before,'Public paste produced no actual input');await send('\r');await finishOutput(value,index,offset);
  }
  offset=raw.length;
  await send("printf '%s' CANCELLED > \"$HOME/phase2-cancel-effect\"");await send('\x03');await send('\r');
  const cancelPlan=commandFor('CANCEL_RECOVERED',6);await send(`if [ ! -e "$HOME/phase2-cancel-effect" ]; then ${cancelPlan.source}; else printf 'CANCEL_EFFECT_PRESENT\\n'; fi\r`);await finishOutput('CANCEL_RECOVERED',6,offset);
  // Real pathname completion and native history search use actual Tab/Ctrl-R.
  offset=raw.length;
  await send("printf %s COMPLETE > \"$HOME/p2_completion_unique\"; printf '%s%s\\n' COMPLETION_ READY\r");
  await until(()=>raw.slice(offset).includes('COMPLETION_READY'),'Actual completion fixture creation missing');await until(idle,'Completion fixture did not settle');offset=raw.length;
  await send('cat ./p2_compl');await send('\t','actual Tab completion');await send('\r');
  await until(()=>raw.slice(offset).includes('COMPLETE'),'Actual completed file was not read');await until(idle,'Tab completion did not restore prompt');await checkpoint('tab-completion');
  offset=raw.length;const history=commandFor('HISTORY_'+token.slice(0,8),7);await send(history.source+'\r');await finishOutput('HISTORY_'+token.slice(0,8),7,offset);
  offset=raw.length;await send('\x12','native reverse history search');await send('P2HEX_');await send('\r');
  await finishOutput('HISTORY_'+token.slice(0,8),7,offset);await checkpoint('history-search');
  // Cross the complete real Unicode field in both directions, then edit a wide character.
  offset=raw.length;const unicode=macDailyUnicodeEditPlan(token);
  await send(unicode.source);await until(()=>draftState(unicode.source).complete,'Initial Unicode draft did not finish drawing');await send('\x01');await send('\x1b[C'.repeat(unicode.prefixCharacters));
  await until(()=>t.buffer.normal.getLine(t.buffer.normal.baseY+t.buffer.normal.cursorY)?.getCell(t.buffer.normal.cursorX)?.getChars()==='中','Unicode cursor did not reach the first wide character');await drain();
  const cursorBefore={x:t.buffer.normal.cursorX,y:t.buffer.normal.cursorY,baseY:t.buffer.normal.baseY};await checkpoint('unicode-cursor-before',{plan:unicode,cursorBefore});
  await send('\x1b[C'.repeat(unicode.traversalKeys));await until(()=>draftState(unicode.source).text.includes(family==='zsh'?unicode.initialValue.replace(/\u200d/g,'<200d>'):unicode.initialValue),'Unicode cursor did not cross the complete combining/emoji field');
  const cursorBeyondField={x:t.buffer.normal.cursorX,y:t.buffer.normal.cursorY,baseY:t.buffer.normal.baseY};
  await send('\x1b[D'.repeat(unicode.traversalKeys));await until(()=>t.buffer.normal.cursorX===cursorBefore.x&&t.buffer.normal.cursorY===cursorBefore.y&&t.buffer.normal.baseY===cursorBefore.baseY,'Unicode cursor did not return to its original public position');await drain();
  const cursorReturned={x:t.buffer.normal.cursorX,y:t.buffer.normal.cursorY,baseY:t.buffer.normal.baseY};
  assert(JSON.stringify(cursorReturned)===JSON.stringify(cursorBefore),'Unicode cursor round trip drifted visually');await checkpoint('unicode-cursor-returned',{cursorBefore,cursorBeyondField,cursorReturned});
  await send('\x1b[3~');await send('文');await send('\x05\r');await finishOutput(unicode.expectedValue,8,offset,{plan:unicode,cursorBefore,cursorBeyondField,cursorReturned});
  // A real alternate-screen application, using only ordinary PTY keyboard input.
  await send('/usr/bin/vi -u NONE -N "$HOME/phase2-tui.txt"\r');await until(()=>t.buffer.active.type==='alternate','Installed vi did not enter alternate screen');await checkpoint('tui-enter');
  await send('iTUI_中文_e\u0301_👩🏽‍💻_NAV_X\x1b');await until(()=>Array.from({length:t.buffer.active.length},(_,y)=>t.buffer.active.getLine(y)?.translateToString(true)??'').some(line=>line.includes('TUI_中文_')),'Actual vi editing output missing');await checkpoint('tui-edit');
  await send('0');await until(()=>t.buffer.active.cursorX===0,'Actual vi navigation did not reach line start');
  const tuiStart={x:t.buffer.active.cursorX,y:t.buffer.active.cursorY};
  await send('$');await until(()=>t.buffer.active.getLine(t.buffer.active.cursorY)?.getCell(t.buffer.active.cursorX)?.getChars()==='X','Actual vi navigation did not reach the final sentinel');
  const tuiEnd={x:t.buffer.active.cursorX,y:t.buffer.active.cursorY};assert(tuiEnd.x>tuiStart.x,'Actual vi navigation did not move');
  await send('rK');await until(()=>t.buffer.active.getLine(t.buffer.active.cursorY)?.translateToString(true).includes('_NAV_K')===true,'Actual vi navigation/replacement failed');await checkpoint('tui-navigation',{tuiStart,tuiEnd});
  await send(':q!\r');await until(()=>t.buffer.active.type==='normal','Actual vi did not leave alternate screen');await until(idle,'TUI prompt missing');
  offset=raw.length;await send(commandFor('TUI_RECOVERED',9).source+'\r');await finishOutput('TUI_RECOVERED',9,offset);await checkpoint('tui-exit');
  // Dynamic sizes with an unsubmitted actual Unicode draft.
  offset=raw.length;const draft=commandFor('DRAFT_中文_e\u0301_👩🏽‍💻_'+ 'long'.repeat(40),10);
  await send(draft.source);
  for(const [width,height]of [[440,320],[360,580],[1100,320],[1100,650]]){
   await drain();host.style.width=width+'px';host.style.height=height+'px';c.fit();await drain();
   await until(async()=>{const g=(await snapshot()).session?.geometry;return g?.columns===t.cols&&g.rows===t.rows;},'Actual PTY geometry did not match display');
   await until(()=>draftState(draft.source).complete,'Actual resized draft is incomplete or cursor is not at its end');
   const displayed=Array.from({length:t.buffer.normal.length},(_,row)=>t.buffer.normal.getLine(row)?.translateToString(false)??'').join('');
   const draftCopies=displayed.split('DRAFT_').length-1,actualDraft=draftState(draft.source);
   await checkpoint('draft-'+width+'x'+height,{draft:draft.source,submitted:false,draftCopies,actualDraft});
   assert(draftCopies===1,'Actual resized draft has missing/duplicate visible prefix: '+draftCopies);
   assert(actualDraft.complete&&actualDraft.combiningAttached,'Actual draft content/cursor or NFD cell attachment is incorrect');
   assert(!raw.slice(offset).includes(draft.prefix+hex('DRAFT_中文_e\u0301_👩🏽‍💻_'+ 'long'.repeat(40))+':END\r\n'),'Resizing executed the unsubmitted draft');
  }
  await send('\r');await finishOutput('DRAFT_中文_e\u0301_👩🏽‍💻_'+ 'long'.repeat(40),10,offset);
  // Actual historical output, one initial public-coordinate selection, then no reselection.
  const anchorLine='P2ANCHOR_'+token.slice(0,8)+'_中文_e\u0301_👩🏽‍💻';
  await send(`printf '%s\\n' ${quotePosixFileSource(anchorLine)}; i=0; while [ "$i" -lt 80 ]; do printf 'P2H_%03d\\n' "$i"; i=$((i+1)); done\r`);await until(idle,'Historical output prompt missing');await drain();
  const anchor=nativeDisplayHistoryAnchor(t.buffer.normal,t.cols,[anchorLine]);assert(anchor&&anchor.row<t.buffer.normal.baseY,'Initial historical anchor missing');
  viewportStage='initial-selection';trace.action({kind:'select',column:anchor.column,row:anchor.row,length:anchor.length});t.select(anchor.column,anchor.row,anchor.length);
  trace.action({kind:'scrollToLine',row:anchor.row});t.scrollToLine(anchor.row);assert(t.getSelection()===anchorLine,'Initial Unicode selection differs');
  const originalParked=parkedState();await checkpoint('parked-initial',{anchor,originalParked});
  await send("printf '%s%s\\n' P2_NEW_ LOGICAL_OUTPUT\r");await until(idle,'New output did not settle');await drain();
  const afterOutput=parkedState();assert(afterOutput.viewportY<afterOutput.baseY&&afterOutput.selection===anchorLine&&afterOutput.anchorOffset===originalParked.anchorOffset,'New logical output changed parked viewport/selection anchor');await checkpoint('parked-new-output',{originalParked,afterOutput});
  for(const width of [440,360,1100]){
   await drain();viewportStage='fit-'+width;const beforeFit=observeViewport(),beforeLayout=observeLayout();host.style.width=width+'px';c.fit();const afterFit=observeViewport();await drain();const afterDrain=observeViewport(),afterLayout=observeLayout();viewportResizes.push({width,beforeFit,beforeLayout,afterFit,afterLayout,afterDrain});
   const afterResize=parkedState();assert(afterResize.selection===anchorLine&&afterResize.viewportY<afterResize.baseY&&afterResize.anchorOffset===originalParked.anchorOffset,'Horizontal reflow lost original selection/relative viewport anchor');await checkpoint('parked-'+width,{originalParked,afterResize});
  }
  viewportStage=undefined;
  trace.action({kind:'clearSelection'});t.clearSelection();trace.action({kind:'scrollToBottom'});t.scrollToBottom();
  await send("printf '%s%s\\n' P2_FOLLOW_ NEW_LOGICAL_OUTPUT\r");await until(idle,'Following output prompt missing');await drain();assert(t.buffer.normal.viewportY===t.buffer.normal.baseY,'Bottom did not follow actual new output');await checkpoint('follow-new-output');
  trace.action({kind:'searchNext',term:anchorLine});assert(c.searchAddon.findNext(anchorLine),'Production search addon could not find original historical output');await checkpoint('search-history');
  trace.action({kind:'clearSelection'});t.clearSelection();
  await send('exit\r');await until(()=>useTerminalStore.getState().sessions.find(x=>x.sessionId===session.sessionId)?.status==='disconnected','Shell transport did not end');await drain();await checkpoint('transport-end');
  }
 }catch(error){problem=error;await checkpoint('failure',{reason:String(error)}).catch(()=>{});}
 const expectedRecords=macDailyExpectedRecords[toastMode?'toast':pumpMode?'pump':editingMode?'editing':rawMode?'raw':'native'];
 if(!problem&&JSON.stringify(records.map(record=>record.label))!==JSON.stringify(expectedRecords))problem=Error('Actual named operations do not match the predeclared daily sequence');
 let wire:Record<string,unknown>|undefined;
 try{
  const before=await snapshot(),capture=await invokeGetTerminalAcceptanceRawOutput(session.sessionId),after=await snapshot();
  assert(capture.dataStoreIdentifier?.map(value=>value.toString(16).padStart(2,'0')).join('')===token.split('-').join(''),'Actual runtime WebKit identifier differs from this case');
  assert(before.session?.nextInputSequence===after.session?.nextInputSequence,'Raw observation changed input sequence');
  assert(capture.transportSessionId===session.sessionId,'Raw observation changed transport');
  assert(!wireCaptureError,'Actual raw-frame observation failed');
  await until(()=>wireEvents.length>=capture.capturedFrameCount,'Original raw frame events did not arrive through the declared EOF');
  const frames:Record<string,unknown>[]=[],data:number[]=[];let nextSequence=1,offset=0;
  for(const event of wireEvents){
   assert(event.transportSessionId===session.sessionId,'Observed raw frame came from another transport');const frame=event.frame;
   assert(frame.terminalSessionId===capture.terminalSessionId&&frame.terminalGeneration===capture.terminalGeneration&&frame.protocolVersion===1&&frame.type==='rawOutput','Raw frame identity mismatch');
   assert(frame.sequence===nextSequence++&&frame.byteOffset===offset&&frame.bytes.every(value=>Number.isInteger(value)&&value>=0&&value<=255),'Raw frame order, offset or bytes invalid');
   frames.push({sequence:frame.sequence,byteOffset:frame.byteOffset,length:frame.bytes.length});for(const byte of frame.bytes)data.push(byte);offset+=frame.bytes.length;
  }
  const bytes=Uint8Array.from(data),response=await fetch(`/__native-pty-wire/${token}`,{method:'POST',body:bytes});assert(response.ok,'Actual raw PTY retention failed');
  const {frames:rawFrames,capturedBytes,...metadata}=capture;void rawFrames;void capturedBytes;
  wire={...metadata,observedFrames:frames,file:await response.json(),readonlyBefore:before,readonlyAfter:after,decodedSessionEqual:new TextDecoder().decode(bytes)===raw,source:'actual Broker pre-UTF8 frame events observed from before session creation'};
  assert(bytes.length===capture.nextByteOffset&&wireEvents.length===capture.capturedFrameCount&&capture.capturedByteCount===capture.nextByteOffset&&capture.capturedFrameCount+1===capture.nextOutputSequence&&offset===capture.nextByteOffset&&nextSequence===capture.nextOutputSequence,'Actual original PTY stream is incomplete');
  assert(wire.decodedSessionEqual,'Original raw PTY does not correspond to actual decoded session output');
  if(!problem)assert(!capture.open,'Original PTY capture lacks transport EOF');
 }catch(error){problem??=error;}
 // These files contain the actual separate streams, without normalization or reconstructed local text.
 const uploads:Record<string,unknown>={};
 for(const [name,body]of [['output',raw],['visible-output',visible],['trace',JSON.stringify(trace?.snapshot(visible))]] as const){
  try{const response=await fetch(`/__native-display-${name}/${token}`,{method:'POST',body});assert(response.ok,'Evidence retention failed: '+name);uploads[name]=await response.json();}catch(error){problem??=error;}
 }
 stops.reverse().forEach(stop=>stop());terminalRegistry.dispose(session.sessionId);await invokeCloseSession(session.sessionId).catch(error=>{problem??=error;});
 if(visualFailures.length)problem??=Error('Required visual observations did not pass');
 if(!trace?.snapshot(visible).replayable)problem??=Error('Actual visible event order was not replayable');
 const uploadedTrace=uploads.trace as {file?:unknown;sha256?:unknown}|undefined;
 const traceFile=typeof uploadedTrace?.file==='string'&&typeof uploadedTrace.sha256==='string'?{file:uploadedTrace.file,sha256:uploadedTrace.sha256}:null;
 const compactRecords=compactMacDailyRecords(records,trace?.snapshot(visible).events.filter(event=>event.type==='checkpoint')??[],traceFile);
 await report({ok:!problem,error:problem?String(problem):undefined,evidence:{kind:'actual-macos-daily',family,selection,session,initial,expectedRecords,records:compactRecords,input,publicInput,domInput,viewportEvents,viewportResizes,visualFailures,wire,uploads,traceReplayable:trace?.snapshot(visible).replayable,modelCalls:0,agentSubmissions:0,humanReceipt:false,physicalInputClaim:false,scope:'Programmatic ordinary input and public paste through real production controller/App/Shell/PTY. Original Broker session capture bytes, decoded session stream and complete visible writes retained separately; bounded replay suffix completeness is recorded independently. Full public checkpoint states are retained verbatim in the uploaded trace and immutable individual progress files; final records reference their exact hashes. Public onData includes TUI parser replies and focus reports, not a physical-input claim. System keyboard, IME, mouse, clipboard and additional mode/lifecycle cases require independent evidence.'}});
}
void verify().catch(error=>fetch(`/__agent-stream-result/${new URL(location.href).searchParams.get('token')}`,{method:'POST',body:JSON.stringify({ok:false,error:String(error)})}));
