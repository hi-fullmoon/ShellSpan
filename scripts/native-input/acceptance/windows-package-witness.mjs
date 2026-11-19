import assert from 'node:assert/strict';
import {lstat,realpath,readdir,readFile} from 'node:fs/promises';
import {resolve,join,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {windowsBootstrapWitness} from './windows-bootstrap-witness.mjs';

async function directory(path,optional=false){
 try{const stat=await lstat(path);assert(stat.isDirectory()&&!stat.isSymbolicLink(),'Owned witness directory must not be a link');assert.equal((await realpath(path)).toLowerCase(),path.toLowerCase(),'Owned witness directory traverses a link');return true;}
 catch(error){if(optional&&error.code==='ENOENT')return false;throw error;}
}
async function regular(path){
 const stat=await lstat(path);assert(stat.isFile()&&!stat.isSymbolicLink(),'Owned witness file must be regular');assert(stat.size<=1048576,'Owned witness file exceeds bound');return readFile(path);
}
export async function windowsPackageFileWitness(dataRoot,home,token,semanticBody=false){
 let witnessStage='owned-root-check';
 try{
  assert(isAbsolute(dataRoot)&&isAbsolute(home)&&/^[a-f0-9-]{36}$/.test(token),'Owned witness inputs required');
  const data=resolve(dataRoot),localHome=resolve(home);await directory(data);await directory(localHome);
  const temporary=join(data,'tmp'),recordDirectory=join(data,'agent-runtime/scratch/records'),files=[],records=[];
  witnessStage='scratch-directory-list';const entries=await directory(temporary,true)?await readdir(temporary,{withFileTypes:true}):[];
  for(const entry of entries.filter(e=>/^[a-f0-9]{16}$/.test(e.name))){
   assert(entry.isDirectory()&&!entry.isSymbolicLink(),'Scratch witness directory must not be a link');await directory(join(temporary,entry.name));
   witnessStage='scratch-script-read';const path=join(temporary,entry.name,`acceptance-${token}.ps1`);
   try{const bytes=await regular(path);files.push({path,byteLength:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),content:bytes.toString('utf8')});}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  witnessStage='scratch-record-list';const names=await directory(recordDirectory,true)?await readdir(recordDirectory):[];
  for(const name of names.filter(n=>/^[a-f0-9]{64}\.json$/.test(n))){witnessStage='scratch-record-read';records.push(JSON.parse((await regular(join(recordDirectory,name))).toString('utf8')));}
  witnessStage='scratch-effect-read';let effectEntries=[];try{effectEntries=(await regular(join(localHome,`scratch-effect-${token}.txt`))).toString('utf8').split(/\r?\n/).filter(Boolean);}catch(error){if(error.code!=='ENOENT')throw error;}
  let unexpectedBodyExists=false;
  if(semanticBody){witnessStage='semantic-body-stat';try{const info=await lstat(join(localHome,`semantic-body-${token}.txt`));assert(info.isFile()&&!info.isSymbolicLink(),'Semantic body witness must be regular');unexpectedBodyExists=true;}catch(error){if(error.code!=='ENOENT')throw error;}}
  witnessStage='bootstrap-witness';return {files,records,effectEntries,nativeBootstrap:windowsBootstrapWitness(data),...(semanticBody?{unexpectedBodyExists}:{})};
 }catch(error){Object.defineProperty(error,'witnessStage',{value:witnessStage,configurable:true});throw error;}
}
