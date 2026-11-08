import type {EditingContext} from './mac-daily-editing';
import {macDailyPumpCompletionPlan} from './mac-daily-input-plan';

function assert(value:unknown,message:string):asserts value{if(!value)throw Error(message);}
async function until(test:()=>boolean|Promise<boolean>,message:string){const end=Date.now()+20000;while(!await test()){assert(Date.now()<end,message);await new Promise(done=>setTimeout(done,20));}}
const hex=(value:string)=>Array.from(new TextEncoder().encode(value),b=>b.toString(16).padStart(2,'0')).join('');

export async function runMacDailyPump(x:EditingContext){
 const {token,terminal:t,send,raw,checkpoint}=x,plan=macDailyPumpCompletionPlan(token),count=100;
 const marker=(index:number)=>'P2LIVE_'+token.slice(0,8)+'_'+String(index).padStart(3,'0')+'\r\n';
 const received=()=>Array.from({length:count},(_,i)=>marker(i)).filter(m=>raw().includes(m)).length;
 await send(`(i=0; while [ "$i" -lt ${count} ]; do /usr/bin/printf '%s%s_%03d\\n' P2LIVE_ '${token.slice(0,8)}' "$i"; i=$((i+1)); /bin/sleep 0.06; done) &\r`);
 await until(()=>received()>0,'Actual long-completion background producer did not start');await until(x.idle,'Producer did not restore the real prompt');
 await checkpoint('pump-completion-started',{producerRecords:received(),total:count,naturalProducer:true});
 const before=received(),offset=raw().length,inputOffset=x.publicInput.length;
 assert(before<count&&new TextEncoder().encode(plan.source).length===4790,'Exact active 4790-byte input scenario missing');
 t.paste(plan.source);await until(()=>x.publicInput.length>inputOffset,'Public long paste did not produce input');
 const pasteEvents=x.publicInput.slice(inputOffset);assert(pasteEvents.some(e=>e.data==='\x1b[200~'+plan.source+'\x1b[201~'),'Long paste did not preserve the exact bracketed command bytes');
 await checkpoint('pump-completion-pasted',{plan,sourceHex:hex(plan.source),pasteEvents,producerBefore:before,producerAfter:received(),submitted:false});
 await send('\r');await until(()=>raw().slice(offset).includes(plan.expectedOutput),'Actual completed long command did not print its independent frame');
 const response=await fetch(`/__native-mac-pump-result/${token}`);assert(response.ok,'Actual owned received-byte file could not be observed');
 const actual=await response.json() as {file:string;hex:string;bytes:number;sha256:string;observedAt:string};
 assert(actual.hex===hex(plan.value)&&actual.bytes===new TextEncoder().encode(plan.value).length,'Actual Shell received bytes differ from the original long input');
 await until(()=>received()>before,'Output did not continue naturally during the long command');await until(x.idle,'Long completion did not restore a prompt while producer was live');
 const after=received();assert(after<count,'Producer ended before complete long input/file/output/prompt evidence');
 await checkpoint('pump-completion-received',{actual,expectedValueHex:hex(plan.value),expectedOutput:plan.expectedOutput,sourceByteCount:4790,producerBefore:before,producerAfter:after,producerStillActive:true,rawRange:{start:offset,end:raw().length}});
 await until(()=>received()===count,'Actual producer did not drain all fixed records');await until(x.idle,'Producer completion prompt did not settle');await x.drain();
 let position=-1;for(let i=0;i<count;i++){const value=marker(i),next=raw().indexOf(value);assert(next>position&&raw().split(value).length===2,'Background records are missing, duplicated or reordered');position=next;}
 assert(raw().slice(offset).split(plan.expectedOutput).length===2,'Completed long command output was missing or duplicated');
 await checkpoint('pump-completion-ended',{actual,total:count,sourceByteCount:4790,producerRecords:received(),completeBytesVerified:true,sourceExecutedOnce:true});
 await send('exit\r');await until(async()=>!(await x.snapshot()).session?.open,'Long completion Shell transport did not end');await x.drain();await checkpoint('transport-end');
}
