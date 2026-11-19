import assert from 'node:assert/strict';import fs from 'node:fs';import {join} from 'node:path';
import {prepareWindowsHistoryReuseProfile} from './windows-history-reuse-profile.mjs';
import {readOwnedHistoryJson} from './windows-history-witness.mjs';
import {readWindowsHistoryReuseCase} from './windows-history-reuse-witness.mjs';

export function prepareWindowsHistoryConcurrentProfile(options){
  const plan={...prepareWindowsHistoryReuseProfile(options),concurrent:true};
  const seed=JSON.parse(fs.readFileSync(plan.reusePlan,'utf8')),nothing=plan.mode==='history-save-nothing';
  const beforeReader=nothing?{exists:false,bytes:0,sha256:null}:{exists:true,bytes:Buffer.byteLength(seed.seedText),sha256:seed.seedSha256};
  fs.writeFileSync(join(options.evidence,'native-history-plan.json'),JSON.stringify(plan,null,2),{flag:'wx'});
  for(const reader of ['0','1'])fs.writeFileSync(join(options.evidence,`native-history-reuse-reader-${reader}.json`),JSON.stringify({version:1,scene:'concurrent',reader,host:plan.host,mode:plan.mode,reuseId:plan.reuseId,initialSources:nothing?[]:plan.seedSources,beforeReader},null,2),{flag:'wx'});
  return plan;
}
export async function readWindowsHistoryConcurrentCase(evidence,options){
  assert(['0','1'].includes(options.reader),'Exact concurrent reader required');
  const plan=await readOwnedHistoryJson(evidence,'native-history-plan.json');
  assert(plan?.concurrent===true,'Owned concurrent history plan required');
  const expectation=await readOwnedHistoryJson(evidence,`native-history-reuse-reader-${options.reader}.json`);
  const other=await readOwnedHistoryJson(evidence,`native-history-reuse-reader-${options.reader==='0'?'1':'0'}.json`);
  assert(expectation?.scene==='concurrent'&&other?.scene==='concurrent','Both concurrent reader expectations required');
  assert.deepEqual(expectation.beforeReader,other.beforeReader,'Concurrent readers require the same initial file bytes');
  assert.deepEqual(expectation.initialSources,plan.mode==='history-save-nothing'?[]:plan.seedSources,'Concurrent initial sources differ from original seeds');
  return readWindowsHistoryReuseCase(evidence,options);
}
