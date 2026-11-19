import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';

export function boundedWitnessFailure(kind,stage,error){
  const safe=value=>typeof value==='string'&&/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value)?value:'unknown';
  return {recordedAt:new Date().toISOString(),kind:safe(kind),stage:safe(error?.witnessStage??stage),code:safe(error?.code),observationAvailable:false};
}
export async function recordWitnessFailure(directory,kind,stage,error){
  assert(isAbsolute(directory),'Owned evidence directory required');
  const value=boundedWitnessFailure(kind,stage,error);
  await writeFile(join(directory,`native-witness-failure-${randomUUID()}.json`),JSON.stringify(value,null,2),{flag:'wx',mode:0o600});
  return value;
}
