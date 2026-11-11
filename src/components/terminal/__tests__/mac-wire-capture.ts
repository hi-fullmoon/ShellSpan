import {listenToSshData,listenToTerminalAcceptanceWireOutput,listenToTerminalAcceptanceWireFinalized,type TerminalAcceptanceWireEvent,type TerminalAcceptanceWireFinalized} from '@/lib/ipc/tauri';

interface WireStream {
  readonly frames:TerminalAcceptanceWireEvent[];
  decoded:string;
  finalized?:TerminalAcceptanceWireFinalized;
  expected?:{terminalSessionId:string;terminalGeneration:number};
}
function assert(value:unknown,message:string):asserts value{if(!value)throw Error(message);}
/** Actual process-local observations only. No input or native settlement API. */
export async function macWireCapture(){
 const streams=new Map<string,WireStream>(),stops:(()=>void)[]=[],expected=new Set<string>();let bytesObserved=0,problem:unknown;
 const stream=(id:string)=>{let value=streams.get(id);if(!value){value={frames:[],decoded:''};streams.set(id,value);}return value;};
 try{
  stops.push(await listenToTerminalAcceptanceWireOutput(({payload})=>{
   if(bytesObserved+payload.frame.bytes.length>16*1024*1024){problem??=Error('Actual transport wire capture exceeded its bound');return;}
   bytesObserved+=payload.frame.bytes.length;stream(payload.transportSessionId).frames.push(payload);
  }));
  stops.push(await listenToTerminalAcceptanceWireFinalized(({payload})=>{
   const value=stream(payload.transportSessionId);if(value.finalized)problem??=Error('Actual transport finalized more than once');value.finalized=payload;
  }));
 }catch(error){stops.reverse().forEach(stop=>stop());throw error;}
 return{
  async expect(id:string,identity?:{terminalSessionId:string;terminalGeneration:number}){
   assert(!expected.has(id),'Transport observation binding repeated');expected.add(id);stream(id).expected=identity;
   stops.push(await listenToSshData(id,({payload})=>{const value=stream(id);if(value.decoded.length+payload.length>900000){problem??=Error('Actual decoded transport exceeded its bound');return;}value.decoded+=payload;}));
  },
  isFinalized(id:string){const value=stream(id);return !!value.finalized&&value.frames.length>=value.finalized.frameCount;},
  observations(id:string){const value=stream(id);return{sessionId:id,frames:value.frames.slice(),decoded:value.decoded,finalized:value.finalized??null,expected:value.expected??null,problem:problem?String(problem):null,authority:'observation-only'};},
  snapshot(id:string,requireFinalized=false){
   assert(!problem,String(problem));assert(expected.has(id),'Unbound actual transport observation');const value=stream(id),data:number[]=[];let sequence=1,offset=0;
   for(const event of value.frames){
    const frame=event.frame;assert(event.transportSessionId===id&&frame.protocolVersion===1&&frame.type==='transportRead','Actual wire frame provenance mismatch');
    assert(Number.isSafeInteger(frame.sequence)&&frame.sequence===sequence++&&Number.isSafeInteger(frame.byteOffset)&&frame.byteOffset===offset,'Actual wire frame order/offset mismatch');
    assert(frame.bytes.every(byte=>Number.isInteger(byte)&&byte>=0&&byte<=255),'Actual wire byte is invalid');
    if(value.expected)assert(event.terminalSessionId===value.expected.terminalSessionId&&event.terminalGeneration===value.expected.terminalGeneration,'Actual wire logical identity mismatch');
    data.push(...frame.bytes);offset+=frame.bytes.length;
   }
   const finalized=value.finalized;
   if(requireFinalized)assert(finalized,'Actual worker finalization observation missing');
   if(finalized){
    assert(finalized.authority==='observation-only'&&!finalized.deliveryFailed,'Wire observation cannot grant authority or conceal a delivery failure');
    assert(finalized.frameCount===value.frames.length&&finalized.byteCount===offset&&finalized.nextSequence===sequence,'Actual worker wire boundary is incomplete');
    assert(finalized.worker.readerStopped&&finalized.worker.childWaiterFinished&&finalized.worker.inputStopped&&!finalized.worker.timedOut,'Actual worker did not complete normal output shutdown');
    if(value.expected)assert(finalized.terminalSessionId===value.expected.terminalSessionId&&finalized.terminalGeneration===value.expected.terminalGeneration,'Finalized wire identity changed');
   }
   const bytes=Uint8Array.from(data);
   return{sessionId:id,frames:value.frames.slice(),bytes,decoded:value.decoded,wireDecoded:new TextDecoder('utf-8').decode(bytes,{stream:!finalized}),finalized:finalized??null,complete:!!finalized,frameCount:value.frames.length,byteCount:offset};
  },
  stop(){stops.reverse().forEach(stop=>stop());},
 };
}
