import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,copyFile,lstat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {canonical,digest,inventory,inside,hashFile,verifyRetainedArtifacts} from './acceptance-inputs.mjs';
import {assertProducerIdentitiesExited} from './process-identity.mjs';

export const statuses=['pending','pass','fail','blocked','not-applicable'];
const counters=['modelDrivenToolCalls','llmHttpRequests','approvals','commandExecutions','ordinaryTests'];
export function caseContract(value){
  for(const field of ['id','requirements','host','transport','artifact','stage','expected','inputs','evidence'])assert(value[field],`Missing case condition: ${field}`);
  assert(value.requirements.length&&value.evidence.length);return structuredClone(value);
}
export function evidenceMatches(planned,record){
  return record.status==='pass'&&record.sealed===true&&canonical(caseContract(planned))===canonical(caseContract(record.contract));
}
export function modelEvidenceMetrics(evidence,ordinaryTests){
  if(!evidence||!Array.isArray(evidence.events)||!Array.isArray(evidence.approved))return {modelDrivenToolCalls:null,llmHttpRequests:null,approvals:null,commandExecutions:null,ordinaryTests};
  const calls=evidence.events.filter(event=>event.type==='tool/call'),results=evidence.events.filter(event=>event.type==='tool/result');
  const terminalCalls=calls.filter(event=>event.data?.call?.name==='run_terminal_command');
  const completed=terminalCalls.map(call=>results.find(result=>result.data?.callId===call.data.call.callId));
  return {modelDrivenToolCalls:calls.length,llmHttpRequests:null,approvals:evidence.approved.length,
    commandExecutions:completed.every(event=>event?.data?.status==='completed'&&Number.isInteger(event.data?.data?.exitCode))?completed.length+ordinaryTests:null,ordinaryTests};
}
export async function referenceEvidence(planned,directory){
  const seal=await verifySeal(directory),record=JSON.parse(await readFile(resolve(directory,'result.json'),'utf8'));
  const reference={...record,sealed:true,reused:true,executed:false};assert(evidenceMatches(planned,reference),'Evidence conditions do not match');
  for(const file of planned.evidence)assert(file in seal.files,`Missing required evidence: ${file}`);
  assert(record.artifactProof?.retainedArtifacts?.length,'No independently retained artifact proof');
  await verifyRetainedArtifacts(record.artifactProof.retainedArtifacts);
  return {...reference,source:directory,sealSha256:seal.sha256};
}
export function summarize(planned,records){
  const ids=new Set(planned.map(item=>item.id));assert.equal(ids.size,planned.length,'Duplicate planned case');
  assert.equal(new Set(records.map(item=>item.id)).size,records.length,'Duplicate result');
  for(const record of records){assert(ids.has(record.id),'Unplanned result');assert(statuses.includes(record.status),'Unknown status');}
  const counts=Object.fromEntries(statuses.map(status=>[status,0])),metrics=Object.fromEntries(counters.map(key=>[key,0]));
  let executed=0,reused=0;
  for(const item of planned){
    const record=records.find(record=>record.id===item.id);counts[record?.status??'pending']++;
    if(!record)continue;
    if(record.status==='not-applicable')assert(record.reason,'Exclusion requires a reason');
    if(record.reused){assert(evidenceMatches(item,record),'Evidence conditions do not match');reused++;}
    if(record.executed){executed++;for(const key of counters){const value=record.metrics?.[key];if(value===null||value===undefined){metrics[key]=null;continue;}assert(Number.isSafeInteger(value)&&value>=0);if(metrics[key]!==null)metrics[key]+=value;}}
  }
  return {planned:planned.length,executed,reused,...counts,skipped:counts['not-applicable'],unexecuted:planned.length-executed-reused,metrics,
    // Requirement/platform coverage needs the complete checklist obligations.
    fullAcceptancePassed:false,parentRequirementsPassed:[]};
}

async function absent(path){try{await lstat(path);return false;}catch(error){if(error.code==='ENOENT')return true;throw error;}}
function requireExited(pids){for(const pid of pids){assert(Number.isInteger(pid)&&pid>1);try{process.kill(pid,0);}catch(error){if(error.code==='ESRCH')continue;throw error;}throw new Error(`Producer still running: ${pid}`);}}
export async function sealCase(directory,{status,producerPids,producerIdentities,files,terminationConfirmed}){
  assert(['pass','fail','blocked'].includes(status));assert(terminationConfirmed===true,'Termination must be confirmed before sealing');
  assert(await absent(resolve(directory,'active.json')),'Running case cannot be sealed or archived');
  if(producerIdentities===undefined)requireExited(producerPids);
  else await assertProducerIdentitiesExited(producerPids,producerIdentities);
  assert(files.length&&!files.includes('seal.json'),'Explicit closed evidence file list required');
  const hashes=await inventory(directory,files),value={version:producerIdentities===undefined?1:2,status,producerPids,...(producerIdentities===undefined?{}:{producerIdentities}),files:hashes};
  await writeFile(resolve(directory,'seal.json'),JSON.stringify({...value,sha256:digest(value)},null,2),{flag:'wx'});
  return {...value,sha256:digest(value)};
}
export async function verifySeal(directory){
  assert(await absent(resolve(directory,'active.json')),'Running case cannot be archived');
  const {sha256,...seal}=JSON.parse(await readFile(resolve(directory,'seal.json'),'utf8'));
  assert.equal(digest(seal),sha256,'Evidence seal changed');assert([1,2].includes(seal.version),'Unsupported evidence seal version');
  if(seal.version===1){assert.equal(seal.producerIdentities,undefined);requireExited(seal.producerPids);}
  else await assertProducerIdentitiesExited(seal.producerPids,seal.producerIdentities);
  assert.deepEqual(await inventory(directory,Object.keys(seal.files)),seal.files,'Sealed evidence changed');
  return {...seal,sha256};
}
// Same copy-exclusive + original/retained digest checks as 398 retention.
// Caller supplies a new owned destination; source evidence is never rewritten.
export async function retainSealedCase(directory,destination){
  const seal=await verifySeal(directory);await mkdir(destination,{recursive:false});
  for(const [path,sha256]of Object.entries(seal.files)){
    const target=inside(destination,resolve(destination,path));await mkdir(dirname(target),{recursive:true});
    await copyFile(inside(directory,resolve(directory,path)),target,constants.COPYFILE_EXCL);
    assert.equal(await hashFile(target),sha256,'Retained evidence differs');
  }
  assert.equal((await verifySeal(directory)).sha256,seal.sha256,'Source changed during retention');
  await writeFile(resolve(destination,'retention.json'),JSON.stringify({source:directory,sealSha256:seal.sha256,files:seal.files},null,2),{flag:'wx'});
  return {source:directory,destination,sealSha256:seal.sha256,files:Object.keys(seal.files).length};
}
