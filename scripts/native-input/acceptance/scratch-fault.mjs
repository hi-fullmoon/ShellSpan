import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,lstat,realpath,writeFile} from 'node:fs/promises';
import {resolve,relative,isAbsolute,sep} from 'node:path';

const evidenceRoot=resolve(import.meta.dirname,'../../../artifacts/tests/native-input-p2');
const uuid=/^[a-f0-9-]{36}$/;
export const scratchFaultOriginal=(token,posix=false)=>posix?`printf '%s\\n' 'SCRATCH_ORIGINAL_${token}'`:`Write-Output 'SCRATCH_ORIGINAL_${token}'`;
const pathIdentity=path=>process.platform==='win32'?resolve(path).toLowerCase():resolve(path);

// Fault injection is confined to a fresh directory in this checkout's owned
// acceptance data, before the first model tool is dispatched. No native frames
// or ownership records are manufactured.
export async function injectOccupiedScratch(evidence,token,value,posix=false){
  assert(!posix||process.platform==='darwin'&&process.arch==='arm64','POSIX scratch faults require macOS arm64');
  const child=relative(evidenceRoot,resolve(evidence));
  assert(isAbsolute(evidence)&&child&&child!=='..'&&!child.startsWith('..'+sep)&&!isAbsolute(child),'Owned scratch evidence required');
  assert(uuid.test(token)&&value&&typeof value==='object'&&!Array.isArray(value),'Invalid scratch fault identity');
  assert.deepEqual(Object.keys(value).sort(),['id','target']);
  assert(typeof value.id==='string'&&value.id.startsWith('agent-file-fault-')&&uuid.test(value.id.slice('agent-file-fault-'.length)));
  const target=value.target;
  assert(target&&typeof target==='object'&&!Array.isArray(target));
  assert.deepEqual(Object.keys(target).sort(),['cwd','kind','sessionId','targetId']);
  assert(target.kind==='local'&&uuid.test(target.sessionId)&&target.targetId==='terminal-'+target.sessionId);
  const home=resolve(evidence,'home'),data=resolve(evidence,'data'),tmp=resolve(data,'tmp');
  assert(typeof target.cwd==='string'&&pathIdentity(target.cwd)===pathIdentity(home));
  for(const path of [evidence,data,tmp,home]){
    const stat=await lstat(path);assert(stat.isDirectory()&&!stat.isSymbolicLink());
    assert.equal(pathIdentity(await realpath(path)),pathIdentity(path));
  }
  const ordered={kind:'local',targetId:target.targetId,sessionId:target.sessionId,cwd:target.cwd};
  const key=createHash('sha256').update(JSON.stringify([value.id,ordered])).digest('hex');
  const directory=resolve(tmp,key.slice(0,16));
  // Non-recursive creation rejects both an occupied directory and a link.
  await mkdir(directory,{mode:0o700});
  const file=resolve(directory,`acceptance-${token}.${posix?'sh':'ps1'}`),content=scratchFaultOriginal(token,posix);
  await writeFile(file,content,{flag:'wx',mode:0o600});
  return {key,directory,file,content,sha256:createHash('sha256').update(content).digest('hex')};
}
