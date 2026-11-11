import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';

// Scheduling only: this clock supplies no image, input or native receipt.
export function createMacEofEvidenceClock({workMs=600000,observationMs=1800000,onTimeout,onTransition=()=>{}}){
 assert(Number.isSafeInteger(workMs)&&workMs>0&&Number.isSafeInteger(observationMs)&&observationMs>0);
 assert.equal(typeof onTimeout,'function');
 let state='idle',remainingWorkMs=workMs,startedAt,label,timer;
 const snapshot=()=>({state,remainingWorkMs:state==='work'?Math.max(0,remainingWorkMs-(performance.now()-startedAt)):remainingWorkMs,workMs,observationMs,label});
 const record=()=>onTransition({...snapshot(),at:new Date().toISOString()});
 const expire=phase=>{
  if(state!==phase)return;
  if(phase==='work')remainingWorkMs=0;
  clearTimeout(timer);state='expired';record();onTimeout({phase,label,workMs,observationMs});
 };
 const resume=()=>{state='work';label=undefined;startedAt=performance.now();timer=setTimeout(()=>expire('work'),remainingWorkMs);record();};
 return{
  start(){assert.equal(state,'idle','Clock can start only once');resume();},
  beginObservation(nextLabel){
   assert.equal(state,'work','Only active work can enter an observation wait');
   assert(typeof nextLabel==='string'&&nextLabel.length>0,'Observation label required');
   remainingWorkMs=Math.max(0,remainingWorkMs-(performance.now()-startedAt));
   if(remainingWorkMs===0){expire('work');return false;}
   clearTimeout(timer);state='observation';label=nextLabel;startedAt=performance.now();
   timer=setTimeout(()=>expire('observation'),observationMs);record();return true;
  },
  endObservation(expectedLabel){
   if(state==='expired'||state==='stopped')return false;
   assert.equal(state,'observation','No active observation wait');assert.equal(expectedLabel,label,'Mismatched observation label');
   if(performance.now()-startedAt>=observationMs){expire('observation');return false;}
   clearTimeout(timer);resume();return true;
  },
  dispose(){clearTimeout(timer);if(state!=='expired'&&state!=='stopped'){if(state==='work')remainingWorkMs=Math.max(0,remainingWorkMs-(performance.now()-startedAt));state='stopped';record();}},
  snapshot,
 };
}
