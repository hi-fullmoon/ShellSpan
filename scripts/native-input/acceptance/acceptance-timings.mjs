import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {verifyRetainedArtifacts} from './acceptance-inputs.mjs';

const milliseconds=(start,end)=>{const value=Date.parse(end)-Date.parse(start);assert(Number.isFinite(value)&&value>=0,'Invalid stage timestamps');return value;};
export function legacyTiming(phases,total){
  const stages={};for(const phase of phases){assert.equal(phase.exitCode,0,'Failed legacy phase must be reported separately');stages[phase.name]=(stages[phase.name]??0)+milliseconds(phase.startedAt,phase.finishedAt);}
  const lastPreparation=phases.filter(item=>['prepare','prepare-validation'].includes(item.name)).at(-1),bundle=phases.find(item=>item.name==='bundle');
  // The old script did not time Vite separately. Preserve this as an
  // uninstrumented interval rather than asserting it all belongs to Vite.
  const frontendGapMs=lastPreparation&&bundle?milliseconds(lastPreparation.finishedAt,bundle.startedAt):null;
  return {totalMs:total,stages,frontendAndConfigurationGapMs:frontendGapMs,
    uninstrumentedMs:total-Object.values(stages).reduce((sum,value)=>sum+value,0),
    frontendGapQualification:'Includes frontend compilation and untimed configuration/resource work; not a direct Vite measurement'};
}
export function compareTimings(legacy,batch){
  return {legacy,batch:batch?{phases:batch.phases,ok:batch.ok,frontendOnly:batch.frontendOnly??false}:null,
    comparable:batch?.ok===true&&!batch.frontendOnly&&legacy.scope===batch.comparisonScope,
    speedupRatio:null,qualification:'No speedup ratio without matching executed cases, artifacts and phase scope. Cold isolated Cargo compilation is distinct from warm shared-target builds.'};
}
export async function retainedBaseline(directory){
  const read=async path=>JSON.parse(await readFile(path,'utf8'));
  const summary=await read(resolve(directory,'summary.json')),audit=await read(resolve(directory,'archive-result.json'));assert(audit.verified,'Only a completed retained batch can be a baseline');
  await verifyRetainedArtifacts([{path:resolve(directory,'evidence.zip'),role:'retained-baseline-archive',sha256:audit.sha256}]);
  const driver=await read(resolve(directory,'retained-driver/phases.json')).catch(()=>null);
  // Driver layout is intentionally discovered from the retained archive only;
  // never fall back to an active source case or its original running logs.
  assert(driver,'Expected retained-driver/phases.json; provide a completed retained batch');
  const cases=[];for(const item of summary.cases){
    const phase=driver.find(entry=>entry.label===item.label);assert(phase);
    cases.push({label:item.label,host:item.host,variant:item.variant,...legacyTiming(await read(resolve(directory,'retained-cases',item.label,'phases.json')),milliseconds(phase.start,phase.end))});
  }
  return {source:directory,archiveSha256:audit.sha256,scope:'four installed model-semantics/model-validation cases, both Windows hosts',cases,
    totalMs:cases.reduce((sum,item)=>sum+item.totalMs,0),packageBuilds:cases.length,installs:summary.packageInstalls,uninstalls:summary.packageUninstalls,
    actualToolCalls:summary.actualToolCalls,approvals:summary.approvals,llmHttpRequests:summary.modelHttpRequestCount};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const legacy=await retainedBaseline(resolve(process.argv[2]));
  const batch=process.argv[3]?JSON.parse(await readFile(resolve(process.argv[3]),'utf8')):undefined;
  console.log(JSON.stringify(compareTimings(legacy,batch),null,2));
}
