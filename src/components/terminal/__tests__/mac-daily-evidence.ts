import type {NativeDisplayTrace} from './native-display-trace';

type Checkpoint=Extract<ReturnType<NativeDisplayTrace['snapshot']>['events'][number],{type:'checkpoint'}>;

/** Keep each exact state once in the retained trace, with verifiable references. */
export function compactMacDailyRecords(records:readonly Record<string,unknown>[],points:readonly Checkpoint[],traceFile:{file:string;sha256:string}|null){
 let next=0;
 const compact=records.map(record=>{
  if(typeof record.state!=='string')return record;
  const point=points[next];
  if(!point||point.label!==record.label||point.stateJson!==record.state)throw Error('Daily record differs from its original trace checkpoint');
  const{state,...details}=record;void state;
  return{...details,stateRef:{checkpoint:next++,stateSha256:point.stateSha256,stateCharacters:point.stateCharacters,trace:traceFile,retained:traceFile!==null}};
 });
 if(next!==points.length)throw Error('Daily records omit an original trace checkpoint');
 return compact;
}
