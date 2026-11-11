import type {TerminalController,TerminalLifecycleEvent} from '../registry/terminal-registry';
import {terminalRegistry} from '../registry/terminal-registry';
import {invokeGetTerminalAcceptanceRawOutput,listenToTerminalAcceptanceRawOutput,type TerminalAcceptanceRawFrameEvent} from '@/lib/ipc/tauri';
import {NativeDisplayTrace,nativeDisplayTraceState} from './native-display-trace';
import type {SessionPtyInfo} from '@/types';
import {macWireCapture} from './mac-wire-capture';
import {macRenderObserver} from './mac-render-observer';
export async function macHumanCapture(token:string,role:'human'|'automatic'='human',options:{parsedOutputOrder?:boolean}={}){
 const transport=await macWireCapture();let diagnosed=false;
 const frames:TerminalAcceptanceRawFrameEvent[]=[],physical:Record<string,unknown>[]=[],input:Record<string,unknown>[]=[],records:Record<string,unknown>[]=[],lifecycle:TerminalLifecycleEvent[]=[],stops:(()=>void)[]=[];
 const visualFailures:{label:string;notes:string}[]=[];
 let raw='',visible='',controller:TerminalController|undefined,trace:NativeDisplayTrace|undefined,renderer:ReturnType<typeof macRenderObserver>|undefined,expectedId:string|undefined,binding:SessionPtyInfo['nativeDisplayBinding'],releaseInitial:(()=>void)|undefined,original:{write:TerminalController['terminal']['write'];select:TerminalController['terminal']['select'];selection:TerminalController['terminal']['getSelection']}|undefined;
 const post=async(value:unknown)=>{const r=await fetch('/__agent-stream-result/'+token,{method:'POST',body:JSON.stringify(value)});if(!r.ok)throw Error('Human evidence retention rejected');};
 const diagnose=async(sessionId:string)=>{
  if(diagnosed)return;diagnosed=true;
  let metadata:unknown;try{metadata=await invokeGetTerminalAcceptanceRawOutput(sessionId);}catch(error){metadata={error:String(error)};}
  const body={kind:'mac-human-capture-snapshot',token,label:'eof-diagnostic',role,at:Date.now(),sessionId,metadata,frames:frames.slice(),transport:transport.observations(sessionId),raw,visible,trace:trace?.snapshot(visible),records,physical,input,authority:'observation-only; validation remains separate'};
  const response=await fetch('/__native-mac-human-snapshot/'+token+'/eof-diagnostic',{method:'POST',body:JSON.stringify(body)});
  if(!response.ok)throw Error('Actual EOF diagnostic could not be retained');
 };
 const persistCheckpoint=async(label:string)=>{
  if(!expectedId||!trace)throw Error('Actual human snapshot binding missing');
  const metadata=await invokeGetTerminalAcceptanceRawOutput(expectedId),observedFrames=frames.slice(),data:number[]=[];
  if(metadata.dataStoreIdentifier?.map(v=>v.toString(16).padStart(2,'0')).join('')!==token.replace(/-/g,''))throw Error('Human snapshot WebView identity mismatch');
  let sequence=1,offset=0;
  for(const event of observedFrames){const frame=event.frame;if(event.transportSessionId!==expectedId||frame.sequence!==sequence++||frame.byteOffset!==offset)throw Error('Human snapshot raw frame identity/order mismatch');data.push(...frame.bytes);offset+=frame.bytes.length;}
  if(metadata.captureTruncated||offset!==metadata.nextByteOffset||observedFrames.length!==metadata.capturedFrameCount)throw Error('Human snapshot did not reach the actual metadata boundary');
  const bytes=Uint8Array.from(data),decoded=new TextDecoder('utf-8').decode(bytes,{stream:metadata.open}),wire=transport.snapshot(expectedId);
  if(decoded!==raw)throw Error('Human snapshot raw/decoded streams differ');
  if(wire.wireDecoded!==raw||wire.decoded!==raw)throw Error('Independent transport/controller decoding differs at checkpoint');
  const snapshot={kind:'mac-human-capture-snapshot',token,label,role,at:Date.now(),sessionId:expectedId,metadata,frames:observedFrames,raw,visible,trace:trace.snapshot(visible),records,physical,input,transport:{...wire,bytes:Array.from(wire.bytes)},eofVerified:wire.complete&&!metadata.open};
  const response=await fetch('/__native-mac-human-snapshot/'+token+'/'+label,{method:'POST',body:JSON.stringify(snapshot)});
  if(!response.ok)throw Error('Actual human checkpoint bytes were not retained');
 };
 stops.push(await listenToTerminalAcceptanceRawOutput(event=>frames.push(event.payload)));
 stops.push(terminalRegistry.subscribe(()=>{if(controller||!expectedId)return;controller=terminalRegistry.get(expectedId);if(!controller)return;const c=controller,t=c.terminal,b=t.buffer.normal;releaseInitial=c.suppressUserInput();
 renderer=macRenderObserver(c);stops.push(()=>renderer?.stop());
 original={write:t.write,select:t.select,selection:t.getSelection};trace=new NativeDisplayTrace({columns:t.cols,rows:t.rows,empty:b.baseY===0&&b.cursorX===0&&b.cursorY===0&&Array.from({length:b.length},(_,y)=>b.getLine(y)?.translateToString(true)??'').every(line=>line===''),unicodeVersion:t.unicode.activeVersion,nativeDisplayBinding:binding,options:{windowsPty:t.options.windowsPty,scrollback:t.options.scrollback,fontFamily:t.options.fontFamily,fontSize:t.options.fontSize,lineHeight:t.options.lineHeight,letterSpacing:t.options.letterSpacing,reflowCursorLine:t.options.reflowCursorLine}},options.parsedOutputOrder===true);
 stops.push(c.subscribeOutput(chunk=>{if(raw.length+chunk.length>900000)throw Error('Human raw output bound');raw+=chunk;}));
 stops.push(c.subscribeLifecycle(event=>{lifecycle.push(event);if(event.type==='closed')trace!.action({kind:'transportClosed'});}));
 stops.push(c.subscribeDisplayOutput(({source,data})=>{const sequence=trace!.output(data,source);visible+=data;if(!options.parsedOutputOrder)queueMicrotask(()=>t.write('',()=>trace!.parsed(sequence)));}));
 if(options.parsedOutputOrder){let sequence=0;stops.push(c.subscribeDisplayOutputParsed(output=>trace!.parsed(sequence++,output)));}
 const data=t.onData(data=>input.push({at:Date.now(),data})),resize=t.onResize(({cols,rows})=>trace!.resize(cols,rows,options.parsedOutputOrder?nativeDisplayTraceState(t):undefined));stops.push(()=>data.dispose(),()=>resize.dispose());
 }));
 return{post,diagnose,physical,input,records,lifecycle,async expect(id:string,pty:SessionPtyInfo|undefined,identity?:{terminalSessionId:string;terminalGeneration:number}){expectedId=id;binding=pty?.nativeDisplayBinding;await transport.expect(id,identity);},releaseInitial(){releaseInitial?.();releaseInitial=undefined;},get raw(){return raw;},get controller(){return controller;},get closedObserved(){return lifecycle.some(event=>event.type==='closed'&&event.sessionId===expectedId);},get wireFinalized(){return !!expectedId&&transport.isFinalized(expectedId);},
  observeSelection(){if(!controller||!trace)throw Error('Human selection observer missing');const t=controller.terminal,p=t.getSelectionPosition();if(!p)throw Error('Actual human selection missing');trace.action({kind:'select',column:p.start.x,row:p.start.y,length:(p.end.y-p.start.y)*t.cols+p.end.x-p.start.x});trace.action({kind:'scrollToLine',row:t.buffer.normal.viewportY});},
  observeUnicodeVersion(register?:'graphemes'){if(!controller||!trace)throw Error('Actual public provider observer missing');trace.action({kind:'unicodeVersion',version:controller.terminal.unicode.activeVersion,...(register?{register}: {})});},
  async checkpoint(label:string,details:Record<string,unknown>,image=false){
   if(!controller||!trace)throw Error('Actual human controller missing');const t=controller.terminal;
   if(t.write!==original?.write||t.select!==original.select||t.getSelection!==original.selection)throw Error('Public human terminal methods were replaced');
   await new Promise<void>(done=>t.write('',done));await new Promise<void>(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done())));await new Promise<void>(done=>t.write('',done));
   const state=nativeDisplayTraceState(t);await trace.checkpoint(label,state);const record={label,at:Date.now(),state,renderer:renderer?.snapshot(),display:{unicode:t.unicode.activeVersion,reflow:t.options.reflowCursorLine},...details};records.push(record);
   if(image||label==='human-deferred')await persistCheckpoint(label);
   await post({progress:(role==='human'?'Human':'Automatic')+' checkpoint: '+label,evidence:{kind:role==='human'?'mac-human-progress':'mac-auto-progress',records:[record],physical,input}});
   if(image){
    const r=await fetch('/__native-mac-daily-checkpoint/'+token+'/'+label,{method:'POST'});
    if(role==='human'){if(!r.ok||!(await r.json()).visualPassed)throw Error('Required native image was not observed');}
    else{
     if(!r.ok)throw Error('Required native image observation could not be retained');
     const verdict=await r.json() as {observed?:unknown;visualPassed?:unknown;notes?:unknown};
     if(verdict.observed!==true||typeof verdict.visualPassed!=='boolean'||typeof verdict.notes!=='string')throw Error('Required native image observation is invalid');
     if(!verdict.visualPassed){
      visualFailures.push({label,notes:verdict.notes});
      // Continue independent byte/state collection, retaining the required
      // image failure. finish() must still report a failed overall case.
      await post({progress:'Automatic required native image failed: '+label,evidence:{kind:'mac-auto-image-failure',visualFailures:visualFailures.slice(),humanReceipt:false}});
     }
    }
   }
  },
  async finish(sessionId:string,details:Record<string,unknown>,ok=true,error?:string){
   if(!trace)throw Error('Actual capture trace missing');
   const end=Date.now()+20000;while(!transport.isFinalized(sessionId)&&Date.now()<end)await new Promise(done=>setTimeout(done,20));
   await diagnose(sessionId);
   const capture=await invokeGetTerminalAcceptanceRawOutput(sessionId),wireState=transport.snapshot(sessionId,true),data:number[]=[];
   if(capture.dataStoreIdentifier?.map(v=>v.toString(16).padStart(2,'0')).join('')!==token.replace(/-/g,''))throw Error('Capture WebView identity mismatch');
   let next=1,offset=0;
   for(const event of frames){const frame=event.frame;if(event.transportSessionId!==sessionId||frame.protocolVersion!==1||frame.type!=='rawOutput'||frame.terminalSessionId!==capture.terminalSessionId||frame.terminalGeneration!==capture.terminalGeneration||frame.sequence!==next++||frame.byteOffset!==offset)throw Error('Broker raw frame identity/order mismatch');data.push(...frame.bytes);offset+=frame.bytes.length;}
   if(capture.open||offset!==capture.nextByteOffset||frames.length!==capture.capturedFrameCount)throw Error('Broker original stream lacks complete closure');
   const acceptedBytes=Uint8Array.from(data),uploads:Record<string,unknown>={};
   // Retain all actual streams before comparing them. A failed equality must
   // preserve its evidence, not turn into a successful or missing capture.
   for(const [name,body]of [['output',raw],['visible-output',visible],['trace',JSON.stringify(trace.snapshot(visible))]] as const){
    const response=await fetch('/__native-display-'+name+'/'+token,{method:'POST',body});if(!response.ok)throw Error('Actual display capture retention failed');uploads[name]=await response.json();
   }
   const wire=await fetch('/__native-pty-wire/'+token,{method:'POST',body:wireState.bytes});if(!wire.ok)throw Error('Actual transport wire retention failed');uploads.wire=await wire.json();
   if(acceptedBytes.length!==wireState.bytes.length||acceptedBytes.some((byte,index)=>byte!==wireState.bytes[index]))throw Error('Broker capture differs from actual pre-Broker transport bytes');
   if(new TextDecoder().decode(acceptedBytes)!==raw||wireState.wireDecoded!==raw||wireState.decoded!==raw)throw Error('Actual transport, Broker, legacy and controller decoded streams differ');
   if(wireState.finalized?.terminalSessionId!==capture.terminalSessionId||wireState.finalized.terminalGeneration!==capture.terminalGeneration)throw Error('Transport/Broker closure identity differs');
   if(!trace.snapshot(visible).replayable)throw Error('Actual visible event order not replayable');
   stops.reverse().forEach(stop=>stop());transport.stop();
   const overallOk=ok&&visualFailures.length===0,overallError=error??(visualFailures.length?'Required native images failed: '+visualFailures.map(item=>item.label).join(', '):undefined);
   await post({ok:overallOk,error:overallError,evidence:{kind:role==='human'?'actual-macos-human':'actual-macos-automatic',role,sessionId,renderer:renderer?.snapshot(),records,physical,input,lifecycle,wire:{metadata:capture,observedFrames:frames.length,decodedSessionEqual:true,transport:wireState.finalized,transportFrames:wireState.frames.map(event=>({sequence:event.frame.sequence,byteOffset:event.frame.byteOffset,length:event.frame.bytes.length}))},uploads,...details,...(role==='automatic'?{dataAssertionsPassed:ok,requiredNativeImagesPassed:visualFailures.length===0,visualFailures:visualFailures.slice(),overallCasePassed:overallOk}: {})}});
  },
 };
}
