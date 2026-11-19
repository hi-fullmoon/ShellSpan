import {describe,it,expect} from 'vitest';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {saveScratchRestart,readScratchRestart,scratchRestartWitness} from '../native-input/acceptance/scratch-restart.mjs';

// These are disk-boundary helper fixtures, never App/model acceptance evidence.
async function ownedCase(){
 const evidence=resolve(import.meta.dirname,'../../artifacts/tests/native-input/integration','restart-unit-'+randomUUID()),token=randomUUID(),sessionId=randomUUID(),id='agent-scratch-restart-'+randomUUID();
 const target={kind:'local',targetId:'terminal-'+sessionId,sessionId,cwd:join(evidence,'home')},key=createHash('sha256').update(JSON.stringify([id,target])).digest('hex'),fileName=`acceptance-${token}.ps1`,content=`Write-Output 'SCRATCH_RESTART_${token}'`,path=join(evidence,'data/tmp',key.slice(0,16),fileName),sha256=createHash('sha256').update(content).digest('hex');
 for(const dir of ['home','data/tmp/'+key.slice(0,16),'data/agent-runtime/scratch/records'])await mkdir(join(evidence,dir),{recursive:true});
 await writeFile(path,content);const recordPath=join(evidence,'data/agent-runtime/scratch/records',key+'.json'),record={version:1,key,sessionId:id,target,uses:{}};await writeFile(recordPath,JSON.stringify(record));
 return {evidence,value:{id,target,fileName,content,path,sha256},recordPath,record};
}
describe('scratch restart disk checkpoint guard',()=>{
 it('reopens only the same verified file and ownership record,without rewriting its checkpoint',async()=>{
  const c=await ownedCase();await saveScratchRestart(c.evidence,c.value);const before=await readFile(join(c.evidence,'native-scratch-restart.json'),'utf8');expect(await readScratchRestart(c.evidence)).toEqual(c.value);await expect(saveScratchRestart(c.evidence,c.value)).rejects.toThrow();expect(await readFile(join(c.evidence,'native-scratch-restart.json'),'utf8')).toBe(before);const witness=await scratchRestartWitness(c.evidence,c.value.fileName);expect(witness.files).toHaveLength(1);expect(witness.files[0].sha256).toBe(c.value.sha256);
 });
 it('rejects a different path or target instead of adopting adjacent files',async()=>{
  const c=await ownedCase();await expect(saveScratchRestart(c.evidence,{...c.value,path:resolve(c.evidence,'outside.ps1')})).rejects.toThrow();await expect(saveScratchRestart(c.evidence,{...c.value,target:{...c.value.target,sessionId:randomUUID()}})).rejects.toThrow();
 });
 it('detects changed file contents during read-only recovery',async()=>{
  const c=await ownedCase();await saveScratchRestart(c.evidence,c.value);await writeFile(c.value.path,'changed');await expect(readScratchRestart(c.evidence)).rejects.toThrow();
 });
 it('refuses to checkpoint an active execution reference as settled',async()=>{
  const c=await ownedCase();await writeFile(c.recordPath,JSON.stringify({...c.record,uses:{active:{state:'executing'}}}));await expect(saveScratchRestart(c.evidence,c.value)).rejects.toThrow();
 });
});
