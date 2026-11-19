import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream,lstatSync,fstatSync,openSync,readSync,closeSync,readdirSync,realpathSync,readlinkSync} from 'node:fs';
import {setImmediate as yieldIO} from 'node:timers/promises';
import {resolve,relative,isAbsolute} from 'node:path';

export const digest=value=>createHash('sha256').update(typeof value==='string'?value:canonical(value)).digest('hex');
export function canonical(value){
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
  assert(value!==undefined,'Undefined fingerprint input');return JSON.stringify(value);
}
export function inside(root,path){
  const child=relative(resolve(root),resolve(path));
  assert(child&&!child.startsWith('..')&&!isAbsolute(child),'Path must stay inside its owned root');return resolve(path);
}
function sameFile(before,after){
  for(const key of ['dev','ino','size','mtimeMs','ctimeMs'])assert.equal(after[key],before[key],`File changed while hashing (${key})`);
}
export async function hashFile(file,{signal}={}){
  signal?.throwIfAborted();
  const info=lstatSync(file);assert(info.isFile()&&!info.isSymbolicLink(),'Expected a regular input file');
  const hash=createHash('sha256'),fd=openSync(file,'r');let ownsDescriptor=true;
  try{
    sameFile(info,fstatSync(fd));
    if(info.size<=65536){
      const buffer=Buffer.alloc(info.size+1),bytesRead=readSync(fd,buffer,0,buffer.length,0);
      assert.equal(bytesRead,info.size,'File changed while hashing');hash.update(buffer.subarray(0,bytesRead));
      sameFile(info,fstatSync(fd));
    }else{
      const stream=createReadStream(file,{fd,autoClose:true,highWaterMark:1048576,signal});ownsDescriptor=false;
      try{
        for await(const bytes of stream){signal?.throwIfAborted();hash.update(bytes);}
      }catch(error){
        if(signal?.aborted&&error.code==='ABORT_ERR')signal.throwIfAborted();throw error;
      }
    }
    sameFile(info,lstatSync(file));signal?.throwIfAborted();
    return hash.digest('hex');
  }finally{if(ownsDescriptor)closeSync(fd);}
}

async function hashInputs(pending,{signal,concurrency=4}={}){
  assert(Number.isInteger(concurrency)&&concurrency>0&&concurrency<=8,'Inventory concurrency must be between one and eight');
  signal?.throwIfAborted();
  const controller=new AbortController(),files={};let next=0,failure;
  const cancel=()=>controller.abort(signal.reason);
  signal?.addEventListener('abort',cancel,{once:true});
  try{
    await Promise.all(Array.from({length:Math.min(concurrency,pending.length)},async()=>{
      try{
        while(next<pending.length){
          controller.signal.throwIfAborted();const {path,name}=pending[next++];
          files[name]=await hashFile(path,{signal:controller.signal});
          if(next%128===0)await yieldIO();
        }
      }catch(error){failure??=error;controller.abort(error);}
    }));
    if(failure)throw failure;signal?.throwIfAborted();return Object.fromEntries(Object.entries(files).sort());
  }finally{signal?.removeEventListener('abort',cancel);}
}

export async function inventory(root,paths,options={}){
  options.signal?.throwIfAborted();
  const base=realpathSync.native(root),pending=new Map(),directories=new Map();let visited=0;
  async function visit(path){
    options.signal?.throwIfAborted();
    const absolute=inside(base,resolve(base,path)),info=lstatSync(absolute);
    assert(!info.isSymbolicLink(),'Linked build inputs require an explicit independent inventory');
    assert.equal(realpathSync.native(absolute).toLowerCase(),absolute.toLowerCase(),'Input traverses a link');
    if(info.isDirectory()){
      const entries=readdirSync(absolute).sort();directories.set(absolute,entries);
      for(const entry of entries)await visit(resolve(absolute,entry));
    }else{
      assert(info.isFile(),'Unsupported build input');pending.set(absolute,{path:absolute,name:relative(base,absolute).replaceAll('\\','/')});
    }
    if(++visited%128===0)await yieldIO();
  }
  for(const path of paths)await visit(path);
  assert(pending.size,'Empty input inventory');
  const files=await hashInputs([...pending.values()],options);
  for(const [directory,entries]of directories){
    options.signal?.throwIfAborted();assert.equal(realpathSync.native(directory).toLowerCase(),directory.toLowerCase(),'Input directory changed');
    assert.deepEqual(readdirSync(directory).sort(),entries,'Input membership changed while hashing');
  }
  return files;
}

export const generatedDependencyOutputs={'.vite':'Vite cacheDir: development optimizer and Vitest results; forbidden as production package inputs'};
export function dependencyInputProjection(value){
  return {files:Object.fromEntries(Object.entries(value.files).filter(([path])=>!path.startsWith('.vite/'))),links:value.links};
}

// Installed JS dependency closure, including native tooling binaries. pnpm's
// links are recorded rather than recursively followed. The declared Vite
// output root is separate from installed package bytes, not an extension filter.
export async function dependencyInventory(directory,options={}){
  options.signal?.throwIfAborted();
  const root=realpathSync.native(directory),links={},pending=[],directories=new Map();let visited=0;
  async function visit(path,info){
    options.signal?.throwIfAborted();const name=relative(root,path).replaceAll('\\','/');
    if(name==='.vite'){
      assert(info.isDirectory()&&!info.isSymbolicLink(),'Test result output must be a real directory');return;
    }
    if(info.isSymbolicLink()){
      const target=realpathSync.native(path);inside(root,target);
      links[name]={link:readlinkSync(path),target:relative(root,target).replaceAll('\\','/')};
    }else if(info.isDirectory()){
      const entries=readdirSync(path,{withFileTypes:true});directories.set(path,entries.map(entry=>entry.name).sort());
      for(const entry of entries)await visit(resolve(path,entry.name),entry);
    }else{assert(info.isFile(),'Unsupported dependency input');pending.push({path,name});}
    if(++visited%128===0)await yieldIO();
  }
  const entries=readdirSync(root,{withFileTypes:true});directories.set(root,entries.map(entry=>entry.name).sort());
  for(const entry of entries)await visit(resolve(root,entry.name),entry);
  const files=await hashInputs(pending,options);
  for(const [path,value]of Object.entries(links)){
    assert.equal(readlinkSync(resolve(root,path)),value.link,'Dependency link changed while hashing');
    assert.equal(relative(root,realpathSync.native(resolve(root,path))).replaceAll('\\','/'),value.target,'Dependency target changed while hashing');
  }
  for(const [path,names]of directories){options.signal?.throwIfAborted();assert.deepEqual(readdirSync(path).sort(),names,'Dependency membership changed while hashing');}
  const value={files,links,generatedOutputs:generatedDependencyOutputs};
  return {...value,sha256:digest(value)};
}

// Enumerated source roots, not extension filters. Additions inside these roots
// invalidate their stage. Full source/index freeze remains a separate gate.
export const buildInputRoots={
  native:['src-tauri/native-input-editors/src','src-tauri/native-input-editors/Cargo.toml','src-tauri/native-input-editors/Cargo.lock',
    'src-tauri/native-input-editors/psreadline.cs','src-tauri/native-input-editors/psreadline.ps1','src-tauri/native-input-editors/zle.c','src-tauri/native-input-editors/zle.zsh',
    'src-tauri/vendor','src-tauri/src/terminal_command/protocol.rs','src-tauri/src/terminal_jobs.rs','src-tauri/src/terminal_jobs.ps1',
    'src-tauri/src/terminal_job_host.cs','src-tauri/src/terminal_console_signals.cs','scripts/native-input/acceptance/build-windows.mjs',
    'scripts/dependency-builds/psreadline','src-tauri/resources/powershell','src-tauri/resources/conpty'],
  frontend:['src','public','package.json','pnpm-lock.yaml','pnpm-workspace.yaml','patches','tsconfig.json','tsconfig.node.json'],
  package:['src-tauri/src','src-tauri/vendor','src-tauri/Cargo.toml','src-tauri/Cargo.lock','src-tauri/build.rs',
    'src-tauri/windows-app-manifest.xml','src-tauri/tauri.conf.json','src-tauri/capabilities','src-tauri/icons','src-tauri/resources',
    'scripts/native-input/prepare-resources.mjs','scripts/native-input/integration/rebuild-sources.mjs'],
};
export function stageToolchains(common,nativeCargoLockSha256){
  const frontend={node:common.node,lockSha256:common.lockSha256,installedDependencySha256:common.installedDependencySha256};
  const native={rustc:common.rustc,cargo:common.cargo,cargoLockSha256:nativeCargoLockSha256};
  return {native,frontend,package:{...common}};
}
export async function fingerprint(root,stage,{toolchain,target,configuration,extraPaths=[],signal}){
  return (await fingerprints(root,[{stage,toolchain,target,configuration,extraPaths}],{signal}))[stage];
}
export async function fingerprints(root,descriptors,{signal}={}){
  assert(descriptors.length,'Explicit build stages required');
  assert.equal(new Set(descriptors.map(item=>item.stage)).size,descriptors.length,'Duplicate build stage');
  const stages=descriptors.map(({stage,toolchain,target,configuration,extraPaths=[]})=>{
    assert(stage in buildInputRoots);assert(toolchain&&target&&configuration,'Explicit toolchain, target and build configuration required');
    const roots=[...buildInputRoots[stage],...extraPaths].map(path=>relative(resolve(root),inside(root,resolve(root,path))).replaceAll('\\','/'));
    return {stage,toolchain,target,configuration,extraPaths,roots};
  });
  // One complete checkpoint scan. Shared files are hashed once and assigned to
  // every declared stage that consumes them; no file-type or extension filter.
  const files=await inventory(root,[...new Set(stages.flatMap(item=>item.roots))],{signal});
  return Object.fromEntries(stages.map(({roots,...stage})=>{
    const selected=Object.fromEntries(Object.entries(files).filter(([path])=>roots.some(root=>path===root||path.startsWith(root+'/'))));
    const value={version:1,...stage,files:selected};return [stage.stage,{...value,sha256:digest(value)}];
  }));
}
export function reuseDecision(previous,current){
  if(!previous)return {reuse:false,reason:'missing-provenance'};
  for(const item of [previous,current]){
    const {sha256,...value}=item;assert.equal(digest(value),sha256,'Build input manifest tampered');
  }
  const paths=[...new Set([...Object.keys(previous.files),...Object.keys(current.files)])].sort();
  const changed=paths.filter(path=>previous.files[path]!==current.files[path]);
  const compatible=previous.stage===current.stage&&previous.target===current.target
    &&canonical(previous.toolchain)===canonical(current.toolchain)&&canonical(previous.configuration)===canonical(current.configuration);
  return {reuse:compatible&&changed.length===0,reason:!compatible?'build-contract-changed':changed.length?'input-drift':'identical-inputs',changed};
}
export async function verifyRetainedArtifacts(records){
  assert(records.length,'No retained build artifacts');
  for(const record of records){assert(/^[a-f0-9]{64}$/.test(record.sha256));assert.equal(await hashFile(record.path),record.sha256,`Retained artifact changed: ${record.role}`);}
}
