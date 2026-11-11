import {getCurrentWindow} from '@tauri-apps/api/window';
import type {SessionSummary} from '@/types';
import {invokeGetTerminalAcceptanceRawOutput,listenToTerminalAcceptanceRawOutput,type TerminalAcceptanceRawFrameEvent} from '@/lib/ipc/tauri';
import type {TerminalController,TerminalLifecycleEvent} from '../registry/terminal-registry';
import {NativeDisplayTrace,nativeDisplayTraceState} from './native-display-trace';
import {macWireCapture} from './mac-wire-capture';
import {macRenderObserver} from './mac-render-observer';

function assert(value:unknown,message:string):asserts value{if(!value)throw Error(message);}
/** Bounded actual observations, installed before any owned transport starts.
 * Retirement intentionally ends controller display, but not independent wire
 * observation. Neither a retired Broker prefix nor visible text is a full PTY. */
export async function macLifecycleCapture(token:string,{parsedOutputOrder=false,startupOutputMayPrecedeSubscription=false}={}){
 const wire=await macWireCapture(),sessions=new Map<string,SessionSummary>(),brokerFrames:TerminalAcceptanceRawFrameEvent[]=[],controllerOutput=new Map<string,string>(),retired=new Set<string>();
 const records:Record<string,unknown>[]=[],inputs:Record<string,unknown>[]=[],physical:Record<string,unknown>[]=[],lifecycle:TerminalLifecycleEvent[]=[],issues:string[]=[],stops:(()=>void)[]=[];
 let controller:TerminalController|undefined,trace:NativeDisplayTrace|undefined,renderer:ReturnType<typeof macRenderObserver>|undefined,visible='',brokerBytes=0,finished=false,physicalEventCount=0,inputProtected=false,parsedSequence=0,pendingDisplayClose=false;
 let original:{write:TerminalController['terminal']['write'];selection:TerminalController['terminal']['getSelection'];select:TerminalController['terminal']['select'];open:TerminalController['terminal']['open']}|undefined;
 const issue=(message:string)=>{if(!issues.includes(message))issues.push(message);};
 const requireCleanInput=()=>assert(physicalEventCount===0,'Unplanned trusted DOM input occurred during an automatic lifecycle case');
 stops.push(await listenToTerminalAcceptanceRawOutput(({payload})=>{
  brokerBytes+=payload.frame.bytes.length;if(brokerBytes>16*1024*1024){issue('Broker observation bound exceeded');return;}brokerFrames.push(payload);
 }));
 const assertPublic=()=>{assert(controller&&original,'Actual lifecycle observer is not bound');const t=controller.terminal;assert(t.write===original.write&&t.getSelection===original.selection&&t.select===original.select&&t.open===original.open,'Lifecycle public terminal methods were replaced');};
 const drain=async()=>{assertPublic();const t=controller!.terminal;await new Promise<void>(done=>t.write('',done));await new Promise<void>(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done())));await new Promise<void>(done=>t.write('',done));};
 const brokerMetadata=async(id:string)=>{try{return{available:true as const,value:await invokeGetTerminalAcceptanceRawOutput(id)};}catch(error){return{available:false as const,error:String(error),scope:'Query failure is retained; never used as zero rows, whole-wire proof, or native capability'};}};
 const persist=async(label:string)=>{
  assert(controller&&trace,'Actual lifecycle capture is missing');
  const transports=[];for(const [id,session]of sessions){transports.push({session,retired:retired.has(id),brokerMetadata:await brokerMetadata(id),brokerFrames:brokerFrames.filter(event=>event.transportSessionId===id),transport:wire.observations(id),controllerDecodedPrefix:controllerOutput.get(id)??'',controllerPrefixScope:'Only actual output delivered while this production listener was current. Retired late bytes remain in independent transport, not this visible prefix.'});}
  const body={kind:'mac-human-capture-snapshot',token,label,role:'automatic',at:Date.now(),sessionId:controller.sessionId,transports,visible,trace:trace.snapshot(visible),records,inputs,physical,physicalEventCount,inputProtected,lifecycle,issues,humanReceipt:false,authority:'Observation only; no input, acceptance, settlement or human authority'};
  const response=await fetch('/__native-mac-human-snapshot/'+token+'/'+label,{method:'POST',body:JSON.stringify(body)});assert(response.ok,'Actual lifecycle capture could not be retained: '+label);return await response.json() as {file:string;bytes:number;sha256:string};
 };
 return{
  records,inputs,lifecycle,drain,requireCleanInput,
  async expect(session:SessionSummary){
   assert(!sessions.has(session.sessionId),'Lifecycle transport binding repeated');assert(session.terminalSessionId&&session.terminalGeneration!==undefined,'Actual lifecycle logical identity missing');
   sessions.set(session.sessionId,session);await wire.expect(session.sessionId,{terminalSessionId:session.terminalSessionId,terminalGeneration:session.terminalGeneration});
  },
  bind(target:TerminalController){
   assert(!controller&&sessions.has(target.sessionId),'Actual lifecycle controller binding differs');controller=target;const t=target.terminal,b=t.buffer.normal;
   assert(!target.host,'Lifecycle display observation started after attach');original={write:t.write,select:t.select,selection:t.getSelection,open:t.open};renderer=macRenderObserver(target);
   trace=new NativeDisplayTrace({columns:t.cols,rows:t.rows,empty:b.baseY===0&&b.cursorX===0&&b.cursorY===0&&Array.from({length:b.length},(_,y)=>b.getLine(y)?.translateToString(true)??'').every(line=>line===''),unicodeVersion:t.unicode.activeVersion,nativeDisplayBinding:sessions.get(target.sessionId)?.ptyInfo?.nativeDisplayBinding,options:{windowsPty:t.options.windowsPty,scrollback:t.options.scrollback,fontFamily:t.options.fontFamily,fontSize:t.options.fontSize,lineHeight:t.options.lineHeight,letterSpacing:t.options.letterSpacing,reflowCursorLine:t.options.reflowCursorLine}},parsedOutputOrder);
   stops.push(target.subscribeOutput(chunk=>{const id=target.sessionId,previous=controllerOutput.get(id)??'';if(previous.length+chunk.length>900000){issue('Controller decoded observation bound exceeded');return;}controllerOutput.set(id,previous+chunk);}));
   stops.push(target.subscribeDisplayOutput(({source,data})=>{
    if(parsedOutputOrder&&pendingDisplayClose&&source==='local'&&data==='\u001b\\'){
     // The controller emits the local terminator only after its actual render
     // drain. The earlier transport Closed stays in the lifecycle evidence.
     pendingDisplayClose=false;trace!.action({kind:'transportClosed'});
    }
    const sequence=trace!.output(data,source);visible+=data;
    if(!parsedOutputOrder)queueMicrotask(()=>t.write('',()=>trace!.parsed(sequence)));
   }));
   if(parsedOutputOrder)stops.push(target.subscribeDisplayOutputParsed(output=>trace!.parsed(parsedSequence++,output)));
   stops.push(target.subscribeLifecycle(event=>{
    lifecycle.push(event);
    if(event.type==='closed'){
     if(parsedOutputOrder){if(pendingDisplayClose)issue('Repeated transport close before actual display drain');pendingDisplayClose=true;}
     else trace!.action({kind:'transportClosed'});
    }
    if(event.type==='rebound'){
     const successor=sessions.get(event.newSessionId);if(!successor){issue('Production rebound to an unobserved actual session');return;}
     retired.add(event.sessionId);trace!.action({kind:'rebindDisplay',ptyInfo:successor.ptyInfo});
    }
    if(event.type==='disposed'&&!finished)issue('Controller disposed before complete capture');
   }));
   const resize=t.onResize(({cols,rows})=>trace!.resize(cols,rows,parsedOutputOrder?nativeDisplayTraceState(t):undefined)),data=t.onData(value=>inputs.push({kind:'actual-terminal-onData',at:Date.now(),characters:value.length,utf8Bytes:new TextEncoder().encode(value).length,dataRetained:false,scope:'Unplanned UI payload metadata only; declared writeUserInput bytes retained separately'}));stops.push(()=>resize.dispose(),()=>data.dispose());
   const nonprinting=new Set(['Shift','Control','Alt','Meta','AltGraph','CapsLock','NumLock','ScrollLock','Fn','Escape','Tab','Enter','Backspace','Delete','Insert','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown','Process','Unidentified',...Array.from({length:24},(_,index)=>'F'+(index+1))]);
   const nonprintingCodes=new Set([...nonprinting,'ShiftLeft','ShiftRight','ControlLeft','ControlRight','AltLeft','AltRight','MetaLeft','MetaRight']);
   const observePhysical=(event:Event)=>{
    if(!event.isTrusted||!(event.target instanceof Node)||!target.container.contains(event.target))return;
    physicalEventCount++;issue('Unplanned trusted DOM input occurred during an automatic lifecycle case');
    if(!inputProtected){inputProtected=true;stops.push(target.suppressUserInput());}
    if(physical.length>=256){issue('Physical input observation bound exceeded');return;}
    const key=event instanceof KeyboardEvent?event:undefined,namedKey=key&&nonprinting.has(key.key)?key.key:undefined;
    physical.push({type:event.type,at:Date.now(),isTrusted:true,sessionId:target.sessionId,targetTag:event.target instanceof Element?event.target.tagName:null,documentFocused:document.hasFocus(),visibility:document.visibilityState,inputProtected:true,...(key?{keyCategory:namedKey?'nonprinting':'printable-or-unclassified',key:namedKey??'<not retained>',code:namedKey&&nonprintingCodes.has(key.code)?key.code:'<not retained>',shiftKey:key.shiftKey,ctrlKey:key.ctrlKey,altKey:key.altKey,metaKey:key.metaKey,repeat:key.repeat,location:key.location,isComposing:key.isComposing}:{}),scope:'Safe key identity/flags only. No printable key, clipboard, input or composition text retained; no human receipt.'});
   };
   for(const name of ['keydown','beforeinput','paste','compositionstart']){document.addEventListener(name,observePhysical,true);stops.push(()=>document.removeEventListener(name,observePhysical,true));}
  },
  recordInput(source:string,accepted:boolean,label:string){inputs.push({kind:'actual-writeUserInput-result',at:Date.now(),sessionId:controller?.sessionId,label,source,inputHex:Array.from(new TextEncoder().encode(source),byte=>byte.toString(16).padStart(2,'0')).join(''),accepted,humanReceipt:false,physicalInputClaim:false});},
  async checkpoint(label:string,details:Record<string,unknown>,image=false){
   await drain();assert(controller&&trace&&renderer,'Actual lifecycle display missing');
   const t=controller.terminal,state=nativeDisplayTraceState(t);await trace.checkpoint(label,state);
   const titlebar=document.querySelector<HTMLElement>('[data-tauri-drag-region]'),host=controller.host,screen=t.element?.querySelector<HTMLElement>('.xterm-screen');assert(titlebar&&host&&screen,'Actual lifecycle AppShell/terminal layout missing');
   const chrome=titlebar.getBoundingClientRect(),surface=host.getBoundingClientRect(),cells=screen.getBoundingClientRect();
   assert(chrome.height>0&&surface.top>=chrome.bottom&&surface.right<=innerWidth&&surface.bottom<=innerHeight&&cells.width>0&&cells.height>0&&cells.left>=surface.left&&cells.top>=surface.top&&cells.right<=surface.right&&cells.bottom<=surface.bottom,'Actual lifecycle cells are cropped or overlap the titlebar');
   const record={label,at:Date.now(),state,layout:{titlebar:chrome.toJSON(),host:surface.toJSON(),screen:cells.toJSON()},display:{unicode:t.unicode.activeVersion,reflow:t.options.reflowCursorLine},renderer:renderer.snapshot(),nativeInnerSize:await getCurrentWindow().innerSize(),...details};records.push(record);
   const retained=await persist(label);
   const progress=await fetch('/__agent-stream-result/'+token,{method:'POST',body:JSON.stringify({progress:'Actual lifecycle checkpoint: '+label,evidence:{kind:'mac-lifecycle-progress',label,retained,humanReceipt:false}})});assert(progress.ok,'Lifecycle progress retention rejected');
   if(image){
    const response=await fetch('/__native-mac-daily-checkpoint/'+token+'/'+label,{method:'POST'});assert(response.ok,'Lifecycle image observation failed');
    const value=await response.json() as {observed?:unknown;visualPassed?:unknown;notes?:unknown};assert(value.observed===true&&typeof value.visualPassed==='boolean'&&typeof value.notes==='string','Lifecycle image observation invalid');
    if(!value.visualPassed)issue('Required native image failed: '+label+' '+value.notes);
   }
   requireCleanInput();
   return retained;
  },
  diagnose:()=>persist('lifecycle-failure'),
  async diagnoseClosed(){
   assert(controller&&trace,'Actual lifecycle observer missing');const end=Date.now()+20000;
   while([...sessions.keys()].some(id=>!wire.isFinalized(id))&&Date.now()<end)await new Promise(done=>setTimeout(done,20));
   await drain();const terminal=controller.terminal,state=nativeDisplayTraceState(terminal);await trace.checkpoint('lifecycle-failure-closed',state);
   records.push({label:'lifecycle-failure-closed',at:Date.now(),state,display:{unicode:terminal.unicode.activeVersion,reflow:terminal.options.reflowCursorLine},renderer:renderer?.snapshot(),nativeInnerSize:await getCurrentWindow().innerSize()});
   const retained=await persist('lifecycle-failure-closed'),observations=[];
   for(const id of sessions.keys()){try{const actual=wire.snapshot(id,true);observations.push({sessionId:id,complete:actual.complete,frames:actual.frameCount,bytes:actual.byteCount,decoderEqual:actual.wireDecoded===actual.decoded});}catch(error){observations.push({sessionId:id,error:String(error),complete:false});}}
   return{retained,observations,scope:'Original failure retained after normal cleanup. Completeness is observed, not a native case pass.'};
  },
  async finish(){
   assert(controller&&trace,'Actual lifecycle observer missing');await drain();
   const end=Date.now()+20000;while([...sessions.keys()].some(id=>!wire.isFinalized(id))&&Date.now()<end)await new Promise(done=>setTimeout(done,20));
   await drain();
   if(pendingDisplayClose)issue('Actual display close drain terminator was not observed');
   // Preserve the complete original observations before judging equality.
   const terminal=controller.terminal,state=nativeDisplayTraceState(terminal);await trace.checkpoint('lifecycle-complete',state);
   records.push({label:'lifecycle-complete',at:Date.now(),state,display:{unicode:terminal.unicode.activeVersion,reflow:terminal.options.reflowCursorLine},renderer:renderer?.snapshot(),nativeInnerSize:await getCurrentWindow().innerSize()});
   const retained=await persist('lifecycle-complete'),transports=[];
   for(const [id,session]of sessions){
    const actual=wire.snapshot(id,true);
    if (startupOutputMayPrecedeSubscription) {
     assert(actual.wireDecoded.endsWith(actual.decoded), 'Subscribed startup display differs from the actual wire suffix');
    } else {
     assert(actual.wireDecoded===actual.decoded,'Independent full transport/standard decoder differ');
    }
    const prefix=controllerOutput.get(id)??'';assert(actual.decoded.startsWith(prefix),'Production controller output differs from its actual transport prefix');
    const frames=brokerFrames.filter(event=>event.transportSessionId===id),data:number[]=[];let next=1,offset=0;
    for(const event of frames){const frame=event.frame;assert(frame.protocolVersion===1&&frame.type==='rawOutput'&&frame.terminalSessionId===session.terminalSessionId&&frame.terminalGeneration===session.terminalGeneration&&frame.sequence===next++&&frame.byteOffset===offset,'Broker actual identity/sequence/offset differs');data.push(...frame.bytes);offset+=frame.bytes.length;}
    assert(data.length<=actual.bytes.length&&data.every((byte,index)=>byte===actual.bytes[index]),'Broker capture is not the exact actual pre-Broker wire prefix');
    const metadata=await brokerMetadata(id);
    if(!retired.has(id)){
     assert(metadata.available&&!metadata.value.open&&!metadata.value.captureTruncated,'Current actual Broker capture is not complete');
     assert(metadata.value.dataStoreIdentifier?.map(value=>value.toString(16).padStart(2,'0')).join('')===token.replace(/-/g,''),'Actual lifecycle WebKit store identity differs');
     assert(offset===actual.byteCount&&offset===metadata.value.nextByteOffset&&frames.length===metadata.value.capturedFrameCount,'Current full Broker/actual wire boundary differs');
     assert(prefix===actual.decoded,'Current production controller omitted final decoded bytes');
    }
    transports.push({sessionId:id,retired:retired.has(id),wireFrames:actual.frameCount,wireBytes:actual.byteCount,brokerPrefixFrames:frames.length,brokerPrefixBytes:offset,controllerPrefixCharacters:prefix.length,wireComplete:true,fullBrokerClaim:!retired.has(id),metadata,
     ...(startupOutputMayPrecedeSubscription ? {legacyDecodedStartCharacter:actual.wireDecoded.length-actual.decoded.length,legacyDisplayComplete:actual.wireDecoded===actual.decoded} : {})});
   }
   assertPublic();assert(trace.snapshot(visible).replayable,'Actual lifecycle display order is not replayable');assert(issues.length===0,issues.join('; '));finished=true;
   return{retained,transports,records:records.map(record=>({label:record.label,at:record.at,display:record.display,renderer:record.renderer,nativeInnerSize:record.nativeInnerSize})),inputs,lifecycle,visibleCharacters:visible.length,publicApisUnmodified:true,humanReceipt:false,physicalInputClaim:false,models:0};
  },
  stop(){finished=true;stops.reverse().forEach(stop=>stop());renderer?.stop();wire.stop();},
 };
}
