import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {lstatSync,readdirSync,readFileSync,realpathSync} from 'node:fs';
import {resolve,isAbsolute,join} from 'node:path';

export function windowsBootstrapWitness(dataRoot){
  let witnessStage='validate-data-root';
  try{
  assert(isAbsolute(dataRoot),'An absolute owned data root is required');
  const root=resolve(dataRoot);assert(lstatSync(root).isDirectory()&&!lstatSync(root).isSymbolicLink(),'Data root must be a real directory');
  assert.equal(realpathSync(root).toLowerCase(),root.toLowerCase(),'Data root must not traverse a link');
  const tmp=join(root,'tmp');let entries;
  try{witnessStage='temporary-root-stat';assert(lstatSync(tmp).isDirectory()&&!lstatSync(tmp).isSymbolicLink(),'Temporary root must be a real directory');witnessStage='temporary-root-list';entries=readdirSync(tmp,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return {bootstraps:[]};throw error;}
  const bootstraps=[];
  for(const entry of entries.filter(v=>/^shellspan-nip-[A-Za-z0-9_-]+$/.test(v.name))){
    const directory=join(tmp,entry.name);witnessStage='bootstrap-type-check';assert(!entry.isSymbolicLink()&&entry.isDirectory(),'Bootstrap must be a real directory');
    try{
      witnessStage='bootstrap-list';
      const files=readdirSync(directory).sort(),libraryPath=join(directory,'shellspan_native_input_editors.dll'),fileHashes={};let librarySha256=null;
      for(const name of files){
        const path=join(directory,name);
        try{witnessStage='resource-stat';const info=lstatSync(path);assert(info.isFile()&&!info.isSymbolicLink(),'Bootstrap resource must be a regular file');witnessStage='resource-hash';fileHashes[name]=createHash('sha256').update(readFileSync(path)).digest('hex');}
        catch(error){if(error.code!=='ENOENT')throw error;}
      }
      try{witnessStage='module-stat';const info=lstatSync(libraryPath);assert(info.isFile()&&!info.isSymbolicLink(),'Native module must be a regular file');witnessStage='module-hash';librarySha256=createHash('sha256').update(readFileSync(libraryPath)).digest('hex');}catch(error){if(error.code!=='ENOENT')throw error;}
      bootstraps.push({directory,libraryPath,librarySha256,files,fileHashes});assert(bootstraps.length<=32,'Unexpected native bootstrap count');
    }catch(error){if(error.code!=='ENOENT')throw error;}
  }
  return {bootstraps};
  }catch(error){Object.defineProperty(error,'witnessStage',{value:witnessStage,configurable:true});throw error;}
}
