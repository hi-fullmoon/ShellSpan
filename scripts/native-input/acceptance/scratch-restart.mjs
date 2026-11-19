import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile,lstat,realpath,readdir} from 'node:fs/promises';
import {resolve,relative,isAbsolute,sep} from 'node:path';
const evidenceRoot=resolve(import.meta.dirname,'../../../artifacts/tests/native-input/integration');
const uuid=/^[a-f0-9-]{36}$/;
const stateName='native-scratch-restart.json';
const pathIdentity=path=>process.platform==='win32'?resolve(path).toLowerCase():resolve(path);
async function owned(evidence){
 const child=relative(evidenceRoot,resolve(evidence));assert(isAbsolute(evidence)&&child&&child!=='..'&&!child.startsWith('..'+sep)&&!isAbsolute(child));
 for(const path of [evidence,resolve(evidence,'data'),resolve(evidence,'data/tmp'),resolve(evidence,'home')]){const stat=await lstat(path);assert(stat.isDirectory()&&!stat.isSymbolicLink());assert.equal(pathIdentity(await realpath(path)),pathIdentity(path));}
}
async function validate(evidence,value){
 await owned(evidence);assert(value&&typeof value==='object'&&!Array.isArray(value));
 assert.deepEqual(Object.keys(value).sort(),['content','fileName','id','path','sha256','target']);
 assert(value.id.startsWith('agent-scratch-restart-')&&uuid.test(value.id.slice('agent-scratch-restart-'.length)));
 const match=/^acceptance-([a-f0-9-]{36})\.(ps1|sh)$/.exec(value.fileName);assert(match);const posix=match[2]==='sh';assert(!posix||process.platform==='darwin'&&process.arch==='arm64');assert.equal(value.content,posix?`printf '%s\\n' 'SCRATCH_RESTART_${match[1]}'`:`Write-Output 'SCRATCH_RESTART_${match[1]}'`);
 const target=value.target;assert(target&&target.kind==='local'&&uuid.test(target.sessionId)&&target.targetId==='terminal-'+target.sessionId);
 assert.deepEqual(Object.keys(target).sort(),['cwd','kind','sessionId','targetId']);assert.equal(pathIdentity(target.cwd),pathIdentity(resolve(evidence,'home')));
 const ordered={kind:'local',targetId:target.targetId,sessionId:target.sessionId,cwd:target.cwd};
 const key=createHash('sha256').update(JSON.stringify([value.id,ordered])).digest('hex'),path=resolve(evidence,'data/tmp',key.slice(0,16),value.fileName);
 assert.equal(pathIdentity(value.path),pathIdentity(path));assert.equal(pathIdentity(await realpath(path)),pathIdentity(path));assert(!(await lstat(path)).isSymbolicLink());const bytes=await readFile(path);assert.equal(bytes.toString('utf8'),value.content);assert.equal(createHash('sha256').update(bytes).digest('hex'),value.sha256);
 const record=JSON.parse(await readFile(resolve(evidence,'data/agent-runtime/scratch/records',key+'.json'),'utf8'));assert([1,2].includes(record.version)&&record.key===key&&record.sessionId===value.id);assert.deepEqual(record.target,ordered);assert.equal(Object.keys(record.uses).length,0);
 return {key,record};
}
export async function saveScratchRestart(evidence,value){await validate(evidence,value);await writeFile(resolve(evidence,stateName),JSON.stringify(value,null,2),{flag:'wx',mode:0o600});return value;}
export async function readScratchRestart(evidence){await owned(evidence);const file=resolve(evidence,stateName);assert((await lstat(file)).isFile()&&!(await lstat(file)).isSymbolicLink());const value=JSON.parse(await readFile(file,'utf8'));await validate(evidence,value);return value;}
export async function scratchRestartWitness(evidence,fileName){
 await owned(evidence);assert(/^acceptance-[a-f0-9-]{36}\.(ps1|sh)$/.test(fileName));assert(!fileName.endsWith('.sh')||process.platform==='darwin'&&process.arch==='arm64');const files=[],records=[];
 for(const dir of await readdir(resolve(evidence,'data/tmp'),{withFileTypes:true}))if(dir.isDirectory()&&/^[a-f0-9]{16}$/.test(dir.name)){const path=resolve(evidence,'data/tmp',dir.name,fileName);try{const bytes=await readFile(path);files.push({path,content:bytes.toString('utf8'),sha256:createHash('sha256').update(bytes).digest('hex')});}catch(error){if(error.code!=='ENOENT')throw error;}}
 for(const name of await readdir(resolve(evidence,'data/agent-runtime/scratch/records')))if(/^[a-f0-9]{64}\.json$/.test(name))records.push(JSON.parse(await readFile(resolve(evidence,'data/agent-runtime/scratch/records',name),'utf8')));
 return {files,records};
}
