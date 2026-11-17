import {describe,it,expect} from 'vitest';
import {mkdir,readFile,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {injectOccupiedScratch,scratchFaultOriginal} from '../native-input-p3/scratch-fault.mjs';

async function ownedCase(){
 const evidence=resolve(import.meta.dirname,'../../artifacts/tests/native-input-p2','fault-unit-'+randomUUID());
 for(const dir of ['home','data/tmp'])await mkdir(join(evidence,dir),{recursive:true});
 const token=randomUUID(),sessionId=randomUUID(),id='agent-file-fault-'+randomUUID();
 return {evidence,token,value:{id,target:{kind:'local',targetId:'terminal-'+sessionId,sessionId,cwd:join(evidence,'home')}}};
}
describe('owned scratch fault injection',()=>{
 it.skipIf(process.platform!=='darwin'||process.arch!=='arm64')('creates a real POSIX occupied directory without inventing an ownership record',async()=>{
  const c=await ownedCase(),result=await injectOccupiedScratch(c.evidence,c.token,c.value,true);
  expect(result.file).toBe(join(result.directory,`acceptance-${c.token}.sh`));
  expect(await readFile(result.file,'utf8')).toBe(`printf '%s\\n' 'SCRATCH_ORIGINAL_${c.token}'`);
  expect(await readdir(join(c.evidence,'data'))).toEqual(['tmp']);
  await expect(injectOccupiedScratch(c.evidence,c.token,c.value,true)).rejects.toThrow();
  expect(await readFile(result.file,'utf8')).toBe(result.content);
 });
 it('creates only the exact unowned directory and immutable original file,without an ownership record',async()=>{
  const c=await ownedCase(),result=await injectOccupiedScratch(c.evidence,c.token,c.value);
  const expected=createHash('sha256').update(JSON.stringify([c.value.id,c.value.target])).digest('hex');
  expect(result.key).toBe(expected);expect(result.directory).toBe(join(c.evidence,'data/tmp',expected.slice(0,16)));
  expect(await readFile(result.file,'utf8')).toBe(scratchFaultOriginal(c.token));
  expect(await readdir(join(c.evidence,'data'))).toEqual(['tmp']);
  await expect(injectOccupiedScratch(c.evidence,c.token,c.value)).rejects.toThrow();
  expect(await readFile(result.file,'utf8')).toBe(result.content);
 });
 it('rejects an outside evidence root and a changed working directory before allocating files',async()=>{
  const c=await ownedCase();
  await expect(injectOccupiedScratch(resolve(c.evidence,'../../outside'),c.token,c.value)).rejects.toThrow();
  await expect(injectOccupiedScratch(c.evidence,c.token,{...c.value,target:{...c.value.target,cwd:resolve(c.evidence,'..')}})).rejects.toThrow();
  expect(await readdir(join(c.evidence,'data/tmp'))).toEqual([]);
 });
 it('rejects alternate targets, extra fields and invalid identities',async()=>{
  const c=await ownedCase();
  for(const value of [{...c.value,extra:true},{...c.value,target:{...c.value.target,targetId:'other'}},{...c.value,id:'other-agent'}])await expect(injectOccupiedScratch(c.evidence,c.token,value)).rejects.toThrow();
  await expect(injectOccupiedScratch(c.evidence,'../bad',c.value)).rejects.toThrow();
  expect(await readdir(join(c.evidence,'data/tmp'))).toEqual([]);
 });
});
