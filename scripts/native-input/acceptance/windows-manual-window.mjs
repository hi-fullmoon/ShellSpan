import assert from 'node:assert/strict';
export const manualWindowMilliseconds=600000;
/** Operator scheduling only; this never changes native execution deadlines. */
export function manualWindowTransition(phase,value){
 if(value.started===true){
  assert(phase==='ready'&&value.evidence?.kind==='manual-native-display-start'&&value.evidence?.trusted===true,'Manual start must follow readiness exactly once and require a trusted operator action');
  return {phase:'started',startOperatorTimer:true};
 }
 if(value.ready===true){
  assert(phase==='waiting'&&value.evidence?.kind==='manual-native-display-ready','Unexpected manual readiness');
  return {phase:'ready',startOperatorTimer:false};
 }
 if(typeof value.ok==='boolean')return {phase:'terminal',startOperatorTimer:false};
 return {phase,startOperatorTimer:false};
}
