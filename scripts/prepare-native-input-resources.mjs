import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {cp,mkdir,readdir,readFile,writeFile,rm,chmod,stat,rename} from 'node:fs/promises';
import {captureValidationSources} from './native-input-p2/frozen-validation.mjs';
import {resolve} from 'node:path';
import {parseArgs} from 'node:util';

const root=resolve(import.meta.dirname,'..');
const {values}=parseArgs({options:{'no-build':{type:'boolean'},'with-ssh':{type:'boolean'},'require-ssh':{type:'boolean'},target:{type:'string'},'validation-editor':{type:'string',multiple:true}}});
const target=values.target??(process.platform==='darwin'&&process.arch==='arm64'?'aarch64-apple-darwin':process.platform==='linux'&&process.arch==='arm64'?'aarch64-unknown-linux-gnu':process.platform==='win32'&&process.arch==='x64'?'x86_64-pc-windows-msvc':'unsupported');
const sourceRoot=resolve(root,'.native-input-p2/resources/native-input-v1');
const logDirectory=resolve(root,'.native-input-p2/resource-build');await mkdir(logDirectory,{recursive:true,mode:0o700});
const validationTargets=values['validation-editor']??[];const validationOnly=validationTargets.length>0;
assert(validationTargets.every(value=>['macos-arm64','linux-aarch64-glibc-2.36','windows-x64'].includes(value)));
const policy=JSON.parse(await readFile(resolve(root,'protocol/agent/runtime/native-editor-admission.json'),'utf8'));assert.equal(policy.version,1);assert(Array.isArray(policy.productionProfiles));
let frozenSources,sourceManifestSha256;
if(validationOnly){
  const stage=JSON.parse(await readFile(resolve(root,'.native-input-p3/candidate-stage.json'),'utf8'));assert(stage.sealed&&stage.root===root,'Editor validation requires a sealed full source copy');
  const manifest=await readFile(resolve(stage.directory,'sources.json'));frozenSources=JSON.parse(manifest.toString('utf8'));assert.deepEqual(captureValidationSources(root),frozenSources);sourceManifestSha256=createHash('sha256').update(manifest).digest('hex');await writeFile(resolve(root,'.native-input-p3/editor-validation-sources.json'),manifest);
}
const runId=randomUUID(),generated=resolve(logDirectory,`staging-${runId}`);
const destination=validationOnly?resolve(root,'.native-input-p3/validation-resources',runId,'native-input-v1'):resolve(root,'src-tauri/resources/native-input-v1/generated');
async function run(command,args,cwd=root){
  const log=await import('node:fs').then(fs=>fs.openSync(resolve(logDirectory,'prepare.log'),'a',0o600));
  const child=spawn(command,args,{cwd,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},stdio:['ignore',log,log]});
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  (await import('node:fs')).closeSync(log);
  assert.equal(code,0,`${command} failed; see ${logDirectory}`);
}
const supported=['aarch64-apple-darwin','aarch64-unknown-linux-gnu'].includes(target);
const includeBash=supported&&!validationOnly;
if(includeBash&&!values['no-build'])await run('python3',['-B','scripts/native-input-p2/build.py']);
const editorHost=supported||target==='x86_64-pc-windows-msvc';
if(editorHost&&!values['no-build']&&(validationOnly||policy.productionProfiles.length>0))await run(process.execPath,[target==='x86_64-pc-windows-msvc'?'scripts/native-input-p3/build-windows.mjs':'scripts/native-input-p3/build.mjs']);
if(values['with-ssh']){
  assert(process.arch==='arm64','The accepted Linux dependency build requires an arm64 Docker host');
  await run('docker',['build','-t','shellspan-native-input-p2:local','-f','scripts/native-input-p2/Dockerfile','scripts/native-input-p2']);
  const args=['run','--rm','-v',`${root}:/work`];
  if(process.getuid)args.push('--user',`${process.getuid()}:${process.getgid()}`,'-e','CARGO_HOME=/tmp/cargo');
  await run('docker',[...args,'shellspan-native-input-p2:local','python3','-B','scripts/native-input-p2/build.py']);
}
await mkdir(generated,{recursive:true});
async function writableResourceTree(directory){
  for(const entry of await readdir(directory,{withFileTypes:true})){
    const path=resolve(directory,entry.name);
    assert(!entry.isSymbolicLink(),'Native resources must not contain symbolic links');
    if(entry.isDirectory()){await chmod(path,0o755);await writableResourceTree(path);}
    else{const mode=(await stat(path)).mode;await chmod(path,mode&0o111?0o755:0o644);}
  }
}
// tauri-build recopies these files on every configuration/build change. The
// installed private runtime copy remains 0500; package build inputs must remain
// writable so a second build can replace them, including cargo-vendor files.
await writableResourceTree(generated);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const targets=[];
const availableEditors=editorHost&&(validationOnly||policy.productionProfiles.length>0)?(await readdir(sourceRoot)).filter(name=>/^editors-(macos-arm64|linux-aarch64-glibc-2\.36|windows-x64)\.json$/.test(name)):[];
const editorNames=[];
for(const name of availableEditors){
  if(validationOnly){if(validationTargets.some(value=>name===`editors-${value}.json`))editorNames.push(name);}
  else if(policy.productionProfiles.length){const catalogue=JSON.parse(await readFile(resolve(sourceRoot,name),'utf8'));if(catalogue.profiles.every(value=>policy.productionProfiles.includes(value.profile.verifiedProfileId)))editorNames.push(name);}
}
if(validationOnly)assert(validationTargets.every(value=>editorNames.includes(`editors-${value}.json`)),'An explicitly requested validation target is missing');
const editorSupported=editorNames.length>0;
const editorAllowed=[];
for(const name of editorNames){
  const catalogue=JSON.parse(await readFile(resolve(sourceRoot,name),'utf8'));
  assert.equal(catalogue.version,1);assert(catalogue.profiles.length>0&&catalogue.profiles.length<=8);
  for(const[path,expected]of Object.entries(catalogue.sources))assert.equal(sha(await readFile(resolve(root,path))),expected,`Stale editor source: ${path}`);
  for(const profile of catalogue.profiles){
    const id=profile.profile.verifiedProfileId;assert(/^[a-zA-Z0-9][a-zA-Z0-9.-]+$/.test(id));
    assert.equal(profile.module,`${id}/${name==='editors-windows-x64.json'?'shellspan_native_input_editors.dll':'ss_nip.so'}`);
    if(profile.core){assert.equal(profile.core,`${id}/zle.so`);assert.equal(profile.coreLicense,`${id}/LICENCE.zsh`);}
    for(const[path,expected]of [[profile.module,profile.moduleSha256],...(profile.relay?[[profile.relay,profile.relaySha256]]:[]),...(profile.core?[[profile.core,profile.editorSha256],[profile.coreLicense,profile.coreLicenseSha256]]:[])]){
      assert(path.startsWith(`${id}/`)&&!path.includes('..'));assert.equal(sha(await readFile(resolve(sourceRoot,path))),expected);
      await mkdir(resolve(generated,id),{recursive:true});await cp(resolve(sourceRoot,path),resolve(generated,path));
    }
    editorAllowed.push(id);
    if(profile.core){
      const pin=JSON.parse(await readFile(resolve(root,'scripts/dependency-builds/zsh/pin.json'),'utf8'));
      const archive=resolve(root,`.native-input-p3/dependencies/zsh-${pin.version}.tar.xz`);assert.equal(sha(await readFile(archive)),pin.archiveSha256);
      await mkdir(resolve(generated,'sources/dependencies'),{recursive:true});await cp(archive,resolve(generated,`sources/dependencies/zsh-${pin.version}.tar.xz`));
    }
  }
  await cp(resolve(sourceRoot,name),resolve(generated,name));targets.push(name);
}
if(editorSupported&&!validationOnly)assert(editorNames.includes(`editors-${target==='x86_64-pc-windows-msvc'?'windows-x64':target==='aarch64-apple-darwin'?'macos-arm64':'linux-aarch64-glibc-2.36'}.json`),'Host editor provider missing');
if(includeBash){
  const names=(await readdir(sourceRoot)).filter(name=>/^catalogue-(macos-arm64|linux-aarch64-glibc-2\.36)\.json$/.test(name));
  for(const name of names){
    const catalogue=JSON.parse(await readFile(resolve(sourceRoot,name),'utf8'));
    assert(catalogue.version===1&&Array.isArray(catalogue.profiles)&&catalogue.profiles.length===3);
    for(const [name,expected] of Object.entries(catalogue.sources))assert.equal(sha(await readFile(resolve(root,name))),expected,`Stale native source: ${name}`);
    for(const profile of catalogue.profiles){
      assert(/^gnu-bash-(4\.1-readline-6\.0|4\.4-readline-7\.0|5\.3-readline-8\.3\.6)-(macos-arm64|linux-aarch64-glibc-2\.36)-nip1-init1-capture1$/.test(profile.id));
      assert.equal(profile.module,`${profile.id}/adapter.so`);assert.equal(profile.relay,`${profile.id}/native-input-relay`);
      assert.equal(profile.readlineDisplayAbi,1,'Readline native display ABI missing');
      for(const [path,expected] of [[profile.module,profile.moduleSha256],[profile.relay,profile.relaySha256],[`${profile.id}/bash`,profile.shellSha256]]){
        const bytes=await readFile(resolve(sourceRoot,path));assert.equal(sha(bytes),expected,`Native artifact mismatch: ${path}`);
        await mkdir(resolve(generated,profile.id),{recursive:true});await cp(resolve(sourceRoot,path),resolve(generated,path));
      }
    }
    await cp(resolve(sourceRoot,name),resolve(generated,name));targets.push(name);
  }
  assert(targets.includes(`catalogue-${target==='aarch64-apple-darwin'?'macos-arm64':'linux-aarch64-glibc-2.36'}.json`),'Host native target missing');
  if(values['require-ssh']||values['with-ssh'])assert(targets.includes('catalogue-linux-aarch64-glibc-2.36.json'),'Linux SSH resources missing');
  // Keep only this build's verified profiles, never stale ignored binaries.
  const allowed=new Set(['sources','README.txt',...targets,...editorAllowed]);
  for(const name of targets.filter(name=>name.startsWith('catalogue-')))for(const profile of JSON.parse(await readFile(resolve(generated,name),'utf8')).profiles)allowed.add(profile.id);
  for(const entry of await readdir(generated))if(!allowed.has(entry))await rm(resolve(generated,entry),{recursive:true});
  await cp(resolve(sourceRoot,'sources'),resolve(generated,'sources'),{recursive:true});
  const tree=resolve(generated,'sources/ShellSpan');await mkdir(tree,{recursive:true});
  for(const name of ['src-tauri/native-input-adapter','src-tauri/native-input-editors','src-tauri/vendor/portable-pty','scripts/dependency-builds/bash-native','scripts/native-input-p0']){
    await cp(resolve(root,name),resolve(tree,name),{recursive:true,filter:path=>!path.split('/').some(part=>['target','__pycache__'].includes(part))});
  }
  for(const name of ['src-tauri/src/terminal_command/protocol.rs','scripts/native-input-p2/build.py']){
    await mkdir(resolve(tree,name,'..'),{recursive:true});await cp(resolve(root,name),resolve(tree,name));
  }
  for(const name of editorNames)for(const path of Object.keys(JSON.parse(await readFile(resolve(sourceRoot,name),'utf8')).sources)){
    assert((path.startsWith('src-tauri/')||path.startsWith('scripts/native-input-p3/')||path.startsWith('scripts/dependency-builds/zsh/'))&&!path.includes('..'));
    await mkdir(resolve(tree,path,'..'),{recursive:true});await cp(resolve(root,path),resolve(tree,path));
  }
  await run('cargo',['vendor','--locked','--versioned-dirs','--manifest-path','src-tauri/native-input-adapter/Cargo.toml','--sync','scripts/native-input-p0/Cargo.toml','--sync','src-tauri/native-input-editors/Cargo.toml','vendor'],tree);
  await mkdir(resolve(tree,'.cargo'),{recursive:true});
  await writeFile(resolve(tree,'.cargo/config.toml'),'[source.crates-io]\nreplace-with = "vendored-sources"\n[source.vendored-sources]\ndirectory = "vendor"\n');
  await cp(resolve(sourceRoot,'README.txt'),resolve(generated,'README.txt'));
}else if(editorSupported){
  const allowed=new Set(['sources',...targets,...editorAllowed]);
  for(const entry of await readdir(generated))if(!allowed.has(entry))await rm(resolve(generated,entry),{recursive:true});
  const tree=resolve(generated,'sources/ShellSpan');await mkdir(tree,{recursive:true});
  for(const name of ['src-tauri/native-input-editors','src-tauri/native-input-adapter','src-tauri/vendor/portable-pty'])await cp(resolve(root,name),resolve(tree,name),{recursive:true,filter:path=>!path.split(/[\\/]/).includes('target')});
  for(const catalogue of editorNames)for(const path of Object.keys(JSON.parse(await readFile(resolve(sourceRoot,catalogue),'utf8')).sources)){
    assert((path.startsWith('src-tauri/')||path.startsWith('scripts/native-input-p3/')||path.startsWith('scripts/dependency-builds/zsh/'))&&!path.includes('..'));
    await mkdir(resolve(tree,path,'..'),{recursive:true});await cp(resolve(root,path),resolve(tree,path));
  }
  await run('cargo',['vendor','--locked','--versioned-dirs','--manifest-path','src-tauri/native-input-editors/Cargo.toml','--sync','src-tauri/native-input-adapter/Cargo.toml','vendor'],tree);
  await mkdir(resolve(tree,'.cargo'),{recursive:true});await writeFile(resolve(tree,'.cargo/config.toml'),'[source.crates-io]\nreplace-with = "vendored-sources"\n[source.vendored-sources]\ndirectory = "vendor"\n');
}else{for(const entry of await readdir(generated))await rm(resolve(generated,entry),{recursive:true});}
if(validationOnly){assert.deepEqual(captureValidationSources(root),frozenSources);await writeFile(resolve(generated,'editor-validation.json'),JSON.stringify({protocol:'shellspan.native-editor-validation/1',resourceRoot:destination,sourceManifestSha256,editorTargets:validationTargets},null,2));}
await writeFile(resolve(generated,'resource-manifest.json'),JSON.stringify({version:1,target,targets,sourceHashesVerified:includeBash||editorSupported,unsupportedHost:!includeBash&&!editorSupported,validationOnly,validationEditorTargets:validationTargets},null,2)+'\n');
await writableResourceTree(generated);
await mkdir(resolve(destination,'..'),{recursive:true});const backup=resolve(logDirectory,`previous-${runId}`);let previous=false;
try{await stat(destination);await rename(destination,backup);previous=true;}catch(error){if(error.code!=='ENOENT')throw error;}
try{await rename(generated,destination);}catch(error){if(previous)await rename(backup,destination);throw error;}
console.log(JSON.stringify({directory:destination,target,targets,validationOnly,previousRetained:previous?backup:undefined}));
