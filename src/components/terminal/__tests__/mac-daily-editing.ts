import type {Terminal} from '@xterm/xterm';
import type {invokeGetTerminalBrokerSnapshot} from '@/lib/ipc/tauri';
import type {NativeDisplayTraceAction} from './native-display-trace';
import {macDailyOutputPlan,macDailySingleOutputPlan,macDailyPasteValues,macDailyTailEditPlan,macDailyCompletionPlan} from './mac-daily-input-plan';
import {quotePosixFileSource} from './native-file-chain-posix';

export type EditingContext={
 token:string;terminal:Terminal;host:HTMLElement;
 /** Only the combined owned case performs the final normal exit itself. */
 deferTransportEnd?:true;
 send:(data:string,kind?:string)=>Promise<void>;
 paste:(data:string)=>Promise<void>;
 checkpoint:(label:string,details?:Record<string,unknown>)=>Promise<void>;
 finishOutput:(value:string,index:number,offset:number,details?:Record<string,unknown>)=>Promise<void>;
 drain:()=>Promise<void>;fit:()=>void;idle:()=>Promise<boolean>;
 snapshot:()=>ReturnType<typeof invokeGetTerminalBrokerSnapshot>;
 raw:()=>string;publicInput:readonly{data:string;hex:string;at:number}[];
 action:(action:NativeDisplayTraceAction)=>void;
 draftState:(source:string)=>{complete:boolean;text:string;afterCursor:string;cursor:{row:number;column:number}};
};
function assert(value:unknown,message:string):asserts value{if(!value)throw Error(message);}
async function until(test:()=>boolean|Promise<boolean>,message:string,milliseconds=20000){const end=Date.now()+milliseconds;while(!await test()){assert(Date.now()<end,message);await new Promise(done=>setTimeout(done,20));}}
const hex=(value:string)=>Array.from(new TextEncoder().encode(value),b=>b.toString(16).padStart(2,'0')).join('');
const sizes=[[440,320],[360,580],[1100,320],[1100,650]] as const;

/** Additional real-App operations for the existing fixed macOS Phase 2 matrix. */
export async function runMacDailyEditing(x:EditingContext){
 const {terminal:t,token,send,checkpoint,finishOutput,drain,raw}=x;
 const cursor=()=>{const b=t.buffer.active;return{x:b.cursorX,y:b.cursorY,baseY:b.baseY,cell:b.getLine(b.baseY+b.cursorY)?.getCell(b.cursorX)?.getChars()??null};};
 const fit=async(width:number,height:number)=>{await drain();x.host.style.width=width+'px';x.host.style.height=height+'px';x.fit();await drain();await until(async()=>{const g=(await x.snapshot()).session?.geometry;return g?.columns===t.cols&&g.rows===t.rows;},'Actual editing PTY geometry differs from public display');};
 const paste=async(source:string)=>{
  const before=x.publicInput.length,expected='\x1b[200~'+source.replace(/\n/g,'\r')+'\x1b[201~';
  await x.paste(source);await until(()=>x.publicInput.length>before,'Actual public paste did not emit input');
  const events=x.publicInput.slice(before);assert(events.some(e=>e.data===expected),'Actual xterm bracketed paste bytes differ, including its LF-to-CR input convention');
  return{source,sourceHex:hex(source),actualPaste:events};
 };
 // Move across actual embedded newlines before editing two separate lines.
 const original='FIRST_X\nSECOND\tSPACE  VALUE\nTHIRD_X',expected='FIRST_A\nSECOND\tSPACE  VALUE\nTHIRD_B',multi=macDailyOutputPlan(token,original,11),offset=raw().length;
 const pasted=await paste(multi.source);await checkpoint('multiline-before',{...pasted,submitted:false});
 assert(!raw().slice(offset).includes(multi.prefix+hex(original)+':END\r\n'),'Multiline paste executed before Enter');
 const first=multi.source.indexOf('FIRST_X')+6,last=multi.source.indexOf('THIRD_X')+6;assert(first>=6&&last>first,'Unique first/third multiline sentinel positions required');
 await send('\x1b[D'.repeat(multi.source.length),'move across the complete multiline draft to its start');await send('\x1b[C'.repeat(first),'move to first-line sentinel');
 await until(()=>cursor().cell==='X','Actual multiline cursor did not reach first-line X');await checkpoint('multiline-first-cursor',{cursor:cursor(),submitted:false});
 await send('\x1b[3~');await send('A');await checkpoint('multiline-first-edited',{cursor:cursor(),submitted:false});
 await send('\x1b[C'.repeat(last-first-1),'move across actual newlines to third-line sentinel');await until(()=>cursor().cell==='X','Actual multiline cursor did not reach third-line X');await checkpoint('multiline-last-cursor',{cursor:cursor(),submitted:false});
 await send('\x1b[3~');await send('B');await send('\x1b[C'.repeat(multi.source.length-last-1));
 await checkpoint('multiline-edited',{original,expected,originalHex:hex(original),expectedHex:hex(expected),cursor:cursor(),submitted:false});
 assert(!raw().slice(offset).includes(multi.prefix+hex(expected)+':END\r\n'),'Edited multiline input executed before Enter');
 await send('\r');await finishOutput(expected,11,offset,{original,pasted,firstLineEdited:true,thirdLineEdited:true,enterCount:1});
 // Real completion; its exact stdout is independent of the echoed command.
 const completion=macDailyCompletionPlan(token),filename=completion.filename,fileValue=completion.value;
 await send(completion.setup+'\r');await until(x.idle,'Completion file creation did not finish');
 const complete='cat ./'+filename;await send('cat ./p2_editing_compl');await send('\t','actual pathname Tab completion');await drain();
 const completions=[complete,complete+' '].filter(source=>x.draftState(source).complete);
 assert(completions.length===1,'Actual completed draft must be the exact filename with at most one completion delimiter');
 const completed=completions[0];assert(completed,'Actual completed source missing');await checkpoint('completion-expanded',{filename,completed,actualDraft:x.draftState(completed),inputPrefix:'cat ./p2_editing_compl',suffixSupplied:false,submitted:false});
 const completionOffset=raw().length;await send('\r');await until(()=>raw().slice(completionOffset).includes(fileValue+'\r\n'),'Exact separate completion stdout missing');await until(x.idle,'Completion prompt did not recover');
 assert(raw().slice(completionOffset).split(fileValue+'\r\n').length===2,'Completion stdout duplicated');await checkpoint('completion-output',{filename,fileValue,fileHex:hex(fileValue+'\n'),expectedOutput:fileValue+'\r\n',rawRange:{start:completionOffset,end:raw().length}});
 // One initial selection of actual output; no search or reselection on resize.
 const begin='P2OUT_'+token.slice(0,8)+'_BEGIN',end='P2OUT_'+token.slice(0,8)+'_END',ascii='ASCII_'+'x'.repeat(256),wide='WIDE_中文_e\u0301_👩🏽‍💻_'+ '宽字'.repeat(18),body=[begin,...Array.from({length:4},()=>[ascii,wide]).flat(),end].join('\n');
 const printedOffset=raw().length;
 await send(`printf '%s%s\\n' P2OUT_ ${quotePosixFileSource(token.slice(0,8)+'_BEGIN')}; i=0; while [ "$i" -lt 4 ]; do printf '%s\\n' ${quotePosixFileSource(ascii)} ${quotePosixFileSource(wide)}; i=$((i+1)); done; printf '%s%s\\n' P2OUT_ ${quotePosixFileSource(token.slice(0,8)+'_END')}\r`);
 await until(()=>raw().slice(printedOffset).includes(body.replace(/\n/g,'\r\n')+'\r\n'),'Actual long/wide printed block missing');await until(x.idle,'Printed block prompt missing');await drain();
 const b=t.buffer.normal,starts:number[]=[],ends:number[]=[];for(let y=0;y<b.length;y++){const text=b.getLine(y)?.translateToString(false)??'';if(text.startsWith(begin))starts.push(y);if(text.startsWith(end))ends.push(y);}
 assert(starts.length===1&&ends.length===1&&ends[0]>starts[0],'Actual independent printed block boundaries are ambiguous');
 const select={kind:'select' as const,column:0,row:starts[0],length:(ends[0]-starts[0])*t.cols+end.length};x.action(select);t.select(select.column,select.row,select.length);
 assert(t.getSelection()===body,'Initial public serialization of long/wide output differs');await checkpoint('printed-output',{body,bodyHex:hex(body),selection:t.getSelection(),initialSelection:select,rawRange:{start:printedOffset,end:raw().length}});
 for(const [width,height]of sizes){await fit(width,height);assert(t.getSelection()===body,'Resize lost or changed actual long/wide output');assert(t.getSelectionPosition(),'Resize lost original selection endpoints');await checkpoint('printed-'+width+'x'+height,{bodyHex:hex(body),selection:t.getSelection(),position:t.getSelectionPosition(),originalSelectionOnly:true});}
 x.action({kind:'clearSelection'});t.clearSelection();x.action({kind:'scrollToBottom'});t.scrollToBottom();
 const follow='P2FOLLOW_'+token.slice(0,8);await send(`printf '%s%s\\n' P2FOLLOW_ ${quotePosixFileSource(token.slice(0,8))}\r`);await until(()=>raw().includes(follow+'\r\n'),'New following output missing');await until(x.idle,'Following prompt missing');await checkpoint('follow-output');
 for(const [width,height]of sizes){await fit(width,height);const v=t.buffer.normal;assert(v.viewportY===v.baseY&&t.getSelection()===''&&v.cursorY>=0&&v.cursorY<t.rows,'Following viewport/cursor/selection baseline drifted on actual resize');await checkpoint('follow-'+width+'x'+height,{viewportY:v.viewportY,baseY:v.baseY,cursor:cursor(),selection:t.getSelection()});}
 // Producers run naturally in this Shell's own background jobs. No release gate.
 const marker=(kind:string,i:number)=>kind+'_'+token.slice(0,8)+'_'+String(i).padStart(3,'0');
 const count=(kind:string,total:number)=>Array.from({length:total},(_,i)=>marker(kind,i)+'\r\n').filter(value=>raw().includes(value)).length;
 const producer=(kind:string,total:number,delay:string,payload='')=>`(i=0; while [ "$i" -lt ${total} ]; do printf '%s%s_%03d%s\\n' ${quotePosixFileSource(kind+'_')} ${quotePosixFileSource(token.slice(0,8))} "$i" ${quotePosixFileSource(payload)}; i=$((i+1)); /bin/sleep ${delay}; done) &\r`;
 await send(producer('P2BG',200,'0.10'));await until(()=>count('P2BG',200)>0,'Real background producer did not emit');await until(x.idle,'Background command did not restore prompt');
 const bg=macDailyTailEditPlan(token,'BG_中文_e\u0301_👩🏽‍💻',12,true),bgOffset=raw().length;await send(bg.source);await checkpoint('background-draft',{source:bg.source,sourceHex:hex(bg.source),submitted:false,producerRecords:count('P2BG',200),cursor:cursor()});
 await send('\x1b[D'.repeat(bg.suffixCharacters));await send('\x7f');await send('OK');await send('\x05');
 for(const [width,height]of sizes){const before=count('P2BG',200);assert(before<200,'Background producer ended before required draft/resize interaction');await send('\x1b[D');await send('\x1b[C');await fit(width,height);await until(()=>count('P2BG',200)>before,'Background output did not naturally interleave with draft interaction');await checkpoint('background-'+width+'x'+height,{sourceHex:hex(bg.source),expectedValueHex:hex(bg.expectedValue),submitted:false,producerBefore:before,producerAfter:count('P2BG',200),cursor:cursor(),scope:'Actual interleaved stream; no contiguous draft assumption or display repair'});}
 await until(()=>count('P2BG',200)===200,'Actual background producer did not complete all unique records',30000);await checkpoint('background-ended',{producerRecords:200,cursor:cursor(),submitted:false});
 await send('\r');await finishOutput(bg.expectedValue,12,bgOffset,{producerRecords:200,naturalInterleave:true});
 // Long public paste while another actual producer drains, then cancel/Enter.
 const payload=':'+'p'.repeat(512),pumpMarkers=()=>Array.from({length:50},(_,i)=>marker('P2PUMP',i)+payload+'\r\n').filter(value=>raw().includes(value)).length;
 await send(producer('P2PUMP',50,'0.05',payload));await until(()=>pumpMarkers()>0,'Actual pump producer did not start');await until(x.idle,'Pump producer prompt missing');await checkpoint('pump-started',{producerRecords:pumpMarkers()});
 const [,long]=macDailyPasteValues(token)[4],longPlan=macDailyOutputPlan(token,long,5),pumpOffset=raw().length,beforePump=pumpMarkers();assert(new TextEncoder().encode(longPlan.source).length===4790&&beforePump<50,'Exact active long-input scenario missing');
 const longPaste=await paste(longPlan.source);await checkpoint('pump-pasted',{...longPaste,sourceByteCount:4790,producerBefore:beforePump,producerAfter:pumpMarkers(),submitted:false});
 await send('\x03');await send('\r');await until(x.idle,'Actual long-input cancel and next Enter did not restore a known empty prompt');await checkpoint('pump-cancelled',{producerRecords:pumpMarkers(),cancelThenNextEnter:true});await until(()=>pumpMarkers()===50,'Actual pump output did not drain to completion');
 assert(!raw().slice(pumpOffset).includes(longPlan.prefix),'Cancelled long command emitted an independent stdout prefix');
 assert(!raw().slice(pumpOffset).includes(longPlan.prefix+hex(long)+':END\r\n'),'Cancelled long command or a residual draft executed');
 const recovery=macDailySingleOutputPlan(token,'LONG_CANCEL_RECOVERED',13);await send(recovery.source+'\r');await finishOutput('LONG_CANCEL_RECOVERED',13,pumpOffset,{cancelledSourceByteCount:4790,producerRecords:50,cancelledOutputAbsent:true});
 if(!x.deferTransportEnd){await send('exit\r');await until(async()=>!(await x.snapshot()).session?.open,'Editing Shell transport did not end');await drain();await checkpoint('transport-end');}
}
