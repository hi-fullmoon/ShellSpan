import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {cp,mkdir,readdir,readFile,writeFile,rm,chmod,stat,rename} from 'node:fs/promises';
import {captureValidationSources} from './integration/frozen-validation.mjs';
import {basename,resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {nativeInputBuildPath,nativeInputReleaseDirectory} from './integration/resource-paths.mjs';
import {copyNativeRebuildSources} from './integration/rebuild-sources.mjs';
import {bashProfileId,BASH_READLINE_VERSIONS,RELEASE_BASH_VERSION} from './integration/bash-profiles.mjs';

const root=resolve(import.meta.dirname,'../..');
const {values}=parseArgs({options:{'no-build':{type:'boolean'},'with-ssh':{type:'boolean'},'require-ssh':{type:'boolean'},acceptance:{type:'boolean'},target:{type:'string'},'validation-editor':{type:'string',multiple:true}}});
const target=values.target??(process.platform==='darwin'&&process.arch==='arm64'?'aarch64-apple-darwin':process.platform==='linux'&&process.arch==='arm64'?'aarch64-unknown-linux-gnu':process.platform==='win32'&&process.arch==='x64'?'x86_64-pc-windows-msvc':'unsupported');
const editorTargetsByBuildTarget=new Map([
  ['aarch64-apple-darwin','macos-arm64'],
  ['aarch64-unknown-linux-gnu','linux-aarch64-glibc-2.36'],
  ['x86_64-pc-windows-msvc','windows-x64'],
]);
const editorTarget=editorTargetsByBuildTarget.get(target);
const linuxEditorTarget=editorTargetsByBuildTarget.get('aarch64-unknown-linux-gnu');
const linuxX86BashTarget='linux-x86_64-glibc-2.28';
const hostBashTarget=target==='aarch64-apple-darwin'?'macos-arm64':target==='aarch64-unknown-linux-gnu'?linuxEditorTarget:undefined;
// Windows can carry the x86_64 Bash as a remote resource without selecting it locally.
const sshBashTargets=target==='aarch64-apple-darwin'||target==='aarch64-unknown-linux-gnu'
  ?[linuxEditorTarget,linuxX86BashTarget]:target==='x86_64-pc-windows-msvc'?[linuxX86BashTarget]:[];
const validationTargets=values['validation-editor']??[];const validationOnly=validationTargets.length>0;
const buildRoot=validationOnly||values.acceptance?'artifacts/tests':nativeInputBuildPath;
const sourceRoot=resolve(root,buildRoot,'native-input-p2/resources/native-input');
const logDirectory=validationOnly?resolve(root,buildRoot,'native-input-p3/resource-build'):resolve(root,nativeInputBuildPath,'resource-build');await mkdir(logDirectory,{recursive:true,mode:0o700});
assert(validationTargets.every(value=>[...editorTargetsByBuildTarget.values()].includes(value)));
const policy=JSON.parse(await readFile(resolve(root,'protocol/agent/runtime/native-editor-admission.json'),'utf8'));assert.equal(policy.version,1);assert(Array.isArray(policy.productionProfiles));
const productionProfilesFor=editor=>policy.productionProfiles.filter(id=>id.endsWith(`-${editor}-native`));
let frozenSources,sourceManifestSha256;
if(validationOnly){
  const stage=JSON.parse(await readFile(resolve(root,'artifacts/tests/native-input-p3/candidate-stage.json'),'utf8'));assert(stage.sealed&&stage.root===root,'Editor validation requires a sealed full source copy');
  const manifest=await readFile(resolve(stage.directory,'sources.json'));frozenSources=JSON.parse(manifest.toString('utf8'));assert.deepEqual(captureValidationSources(root),frozenSources);sourceManifestSha256=createHash('sha256').update(manifest).digest('hex');await writeFile(resolve(root,'artifacts/tests/native-input-p3/editor-validation-sources.json'),manifest);
}
const runId=randomUUID(),generated=resolve(logDirectory,`staging-${runId}`);
const destination=validationOnly?resolve(root,'artifacts/tests/native-input-p3/validation-resources',runId,'native-input'):nativeInputReleaseDirectory(root);
async function run(command,args,cwd=root){
  const log=await import('node:fs').then(fs=>fs.openSync(resolve(logDirectory,'prepare.log'),'a',0o600));
  const child=spawn(command,args,{cwd,env:{...process.env,SHELLSPAN_NATIVE_BUILD_ROOT:buildRoot,PYTHONDONTWRITEBYTECODE:'1'},stdio:['ignore',log,log]});
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  (await import('node:fs')).closeSync(log);
  assert.equal(code,0,`${command} failed; see ${logDirectory}`);
}
if(hostBashTarget&&!validationOnly&&!values['no-build'])await run('python3',['-B','scripts/native-input/integration/build.py']);
if(!values['no-build']&&editorTarget&&(validationOnly?validationTargets.includes(editorTarget):productionProfilesFor(editorTarget).length>0)){
  if(editorTarget===linuxEditorTarget)await run('sh',['scripts/native-input/acceptance/linux-build.sh']);
  else if(editorTarget==='windows-x64')await run(process.execPath,['scripts/native-input/acceptance/build-windows.mjs']);
  else await run(process.execPath,['scripts/native-input/acceptance/build.mjs','--build-scoped-core']);
}
if(!validationOnly&&values['with-ssh']&&!values['no-build']){
  const args=['run','--rm','-e','SHELLSPAN_NATIVE_BUILD_ROOT','-v',`${root}:/work`];
  if(process.getuid)args.push('--user',`${process.getuid()}:${process.getgid()}`,'-e','CARGO_HOME=/tmp/cargo');
  for(const sshTarget of sshBashTargets){
    const x86=sshTarget===linuxX86BashTarget;
    const platform=x86?'linux/amd64':'linux/arm64';
    const image=x86?'shellspan-native-input-p2:amd64':'shellspan-native-input-p2:local';
    const dockerfile=x86?'Dockerfile.amd64':'Dockerfile';
    await run('docker',['build','--platform',platform,'-t',image,'-f',`scripts/native-input/integration/${dockerfile}`,'scripts/native-input/integration']);
    await run('docker',[...args,'--platform',platform,image,'python3','-B','scripts/native-input/integration/build.py']);
    if(!x86&&productionProfilesFor(linuxEditorTarget).length>0){
      await run('docker',['build','--platform',platform,'-t','shellspan-native-input-p3:local','-f','scripts/native-input/acceptance/Dockerfile','scripts/native-input/acceptance']);
      await run('docker',[...args,'--platform',platform,'shellspan-native-input-p3:local','sh','scripts/native-input/acceptance/linux-build.sh']);
    }
  }
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
const editorNames=[];
const selectedEditors=validationOnly?validationTargets:[editorTarget,...(editorTarget==='macos-arm64'?[linuxEditorTarget]:[])].filter(Boolean);
for(const editor of selectedEditors){
  const approved=productionProfilesFor(editor);
  if(!validationOnly&&approved.length===0)continue;
  const name=`editors-${editor}.json`;
  const required=validationOnly||editor===editorTarget||values['require-ssh']||values['with-ssh'];
  const bytes=await readFile(resolve(sourceRoot,name)).catch(error=>{
    if(error.code==='ENOENT'&&!required)return undefined;
    if(error.code==='ENOENT')throw Error(`Required native editor catalogue missing: ${name}`);
    throw error;
  });
  if(!bytes)continue;
  if(!validationOnly){
    const catalogue=JSON.parse(bytes);
    const actual=catalogue.profiles.map(value=>value.profile.verifiedProfileId);
    assert.deepEqual(actual.sort(),approved.sort(),`Unexpected production profiles in ${name}`);
  }
  editorNames.push(name);
}
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
    if(profile.shell){assert.equal(name,'editors-macos-arm64.json');assert(profile.core&&profile.profile.shell==='zsh');assert.equal(profile.shell,`${id}/zsh`);}
    if(!validationOnly&&name==='editors-macos-arm64.json'){
      const pin=JSON.parse(await readFile(resolve(root,'scripts/dependency-builds/zsh/pin.json'),'utf8')).targets['macos-arm64'];
      assert.equal(profile.shell,`${id}/zsh`);
      assert.equal(profile.core,`${id}/zle.so`);
      assert.equal(profile.shellSha256,pin.privateMainSha256);
      assert.equal(profile.editorSha256,pin.privateCoreSha256);
    }
    if(!validationOnly&&name===`editors-${linuxEditorTarget}.json`){
      assert.equal(profile.core,`${id}/zle.so`);
      assert.equal(profile.relay,`${id}/native-input-relay`);
    }
    for(const[path,expected]of [[profile.module,profile.moduleSha256],...(profile.shell?[[profile.shell,profile.shellSha256]]:[]),...(profile.relay?[[profile.relay,profile.relaySha256]]:[]),...(profile.core?[[profile.core,profile.editorSha256],[profile.coreLicense,profile.coreLicenseSha256]]:[])]){
      assert(path.startsWith(`${id}/`)&&!path.includes('..'));assert.equal(sha(await readFile(resolve(sourceRoot,path))),expected);
      await mkdir(resolve(generated,id),{recursive:true});await cp(resolve(sourceRoot,path),resolve(generated,path));
    }
    editorAllowed.push(id);
    if(profile.core){
      const pin=JSON.parse(await readFile(resolve(root,'scripts/dependency-builds/zsh/pin.json'),'utf8'));
      const archive=resolve(root,buildRoot,`native-input-p3/dependencies/zsh-${pin.version}.tar.xz`);assert.equal(sha(await readFile(archive)),pin.archiveSha256);
      await mkdir(resolve(generated,'sources/dependencies'),{recursive:true});await cp(archive,resolve(generated,`sources/dependencies/zsh-${pin.version}.tar.xz`));
    }
  }
  await cp(resolve(sourceRoot,name),resolve(generated,name));targets.push(name);
}
const bashTargets=validationOnly?[]:[...new Set([hostBashTarget,...sshBashTargets].filter(Boolean))];
for(const catalogueTarget of bashTargets){
  const name=`catalogue-${catalogueTarget}.json`;
  const required=catalogueTarget===hostBashTarget||values['require-ssh']||values['with-ssh'];
  const bytes=await readFile(resolve(sourceRoot,name)).catch(error=>{
    if(error.code==='ENOENT'&&!required)return undefined;
    if(error.code==='ENOENT')throw Error(`Required native Bash catalogue missing: ${name}`);
    throw error;
  });
  if(!bytes)continue;
  const catalogue=JSON.parse(bytes);
  assert.equal(catalogue.version,1);
  assert.deepEqual(catalogue.profiles.map(profile=>profile.id),[bashProfileId(RELEASE_BASH_VERSION,catalogueTarget)],`Unexpected release Bash profiles in ${name}`);
  for(const [name,expected] of Object.entries(catalogue.sources))assert.equal(sha(await readFile(resolve(root,name))),expected,`Stale native source: ${name}`);
  if(catalogueTarget==='macos-arm64'){
    const pinPath='scripts/dependency-builds/bash-native/bash-5.3-patches.json';
    const pinBytes=await readFile(resolve(root,pinPath));
    assert.equal(catalogue.sources[pinPath],sha(pinBytes));
    const pins=JSON.parse(pinBytes);
    assert.equal(pins.length,20);
    assert.equal(catalogue.profiles[0].bashPatchLevel,pins.length);
    for(const [index,expected] of pins.entries()){
      const patch=`bash53-${String(index+1).padStart(3,'0')}`;
      assert.equal(sha(await readFile(resolve(sourceRoot,'sources',patch))),expected,`GNU Bash patch mismatch: ${patch}`);
    }
    const readline=JSON.parse(await readFile(resolve(root,'scripts/native-input/prototype/readline-sources.json'),'utf8'));
    assert.equal(readline.patches.length,6);
    assert.equal(sha(await readFile(resolve(sourceRoot,'sources/readline-8.3.tar.gz'))),readline.archive);
    for(const [index,expected] of readline.patches.entries()){
      const patch=`readline83-${String(index+1).padStart(3,'0')}`;
      assert.equal(sha(await readFile(resolve(sourceRoot,'sources',patch))),expected,`GNU Readline patch mismatch: ${patch}`);
    }
  }
  for(const profile of catalogue.profiles){
    assert.equal(profile.target,catalogueTarget);
    assert.equal(profile.bashVersion,RELEASE_BASH_VERSION);
    assert.equal(profile.readlineVersion,BASH_READLINE_VERSIONS[RELEASE_BASH_VERSION]);
    assert.equal(profile.captureFence,1);
    assert.equal(profile.module,`${profile.id}/adapter.so`);assert.equal(profile.relay,`${profile.id}/native-input-relay`);
    assert.equal(profile.readlineDisplayAbi,1,'Readline native display ABI missing');
    for(const [path,expected] of [[profile.module,profile.moduleSha256],[profile.relay,profile.relaySha256],[`${profile.id}/bash`,profile.shellSha256]]){
      const bytes=await readFile(resolve(sourceRoot,path));assert.equal(sha(bytes),expected,`Native artifact mismatch: ${path}`);
      await mkdir(resolve(generated,profile.id),{recursive:true});await cp(resolve(sourceRoot,path),resolve(generated,path));
    }
  }
  await cp(resolve(sourceRoot,name),resolve(generated,name));targets.push(name);
}
const includeBash=targets.some(name=>name.startsWith('catalogue-'));
if(includeBash){
  // Keep only this build's verified profiles, never stale ignored binaries.
  const allowed=new Set(['sources','README.txt',...targets,...editorAllowed]);
  for(const name of targets.filter(name=>name.startsWith('catalogue-')))for(const profile of JSON.parse(await readFile(resolve(generated,name),'utf8')).profiles)allowed.add(profile.id);
  for(const entry of await readdir(generated))if(!allowed.has(entry))await rm(resolve(generated,entry),{recursive:true});
  await cp(resolve(sourceRoot,'sources'),resolve(generated,'sources'),{recursive:true,filter:path=>{
    const name=basename(path);
    if(/^bash53-\d{3}$/.test(name))return targets.includes('catalogue-macos-arm64.json');
    return !/^bash-[\d.]+\.tar\.gz$/.test(name)||name===`bash-${RELEASE_BASH_VERSION}.tar.gz`;
  }});
  const tree=resolve(generated,'sources/ShellSpan');await mkdir(tree,{recursive:true});
  await copyNativeRebuildSources(root,tree);
  for(const name of ['scripts/dependency-builds/bash-native','scripts/native-input/prototype']){
    await cp(resolve(root,name),resolve(tree,name),{recursive:true,filter:path=>!path.split('/').some(part=>['target','__pycache__'].includes(part))});
  }
  for(const name of ['src-tauri/src/terminal_command/protocol.rs','scripts/native-input/integration/build.py','scripts/native-input/integration/Dockerfile','scripts/native-input/integration/Dockerfile.amd64']){
    await mkdir(resolve(tree,name,'..'),{recursive:true});await cp(resolve(root,name),resolve(tree,name));
  }
  for(const name of editorNames)for(const path of Object.keys(JSON.parse(await readFile(resolve(sourceRoot,name),'utf8')).sources)){
    assert((path.startsWith('src-tauri/')||path.startsWith('scripts/native-input/acceptance/')||path.startsWith('scripts/dependency-builds/zsh/'))&&!path.includes('..'));
    await mkdir(resolve(tree,path,'..'),{recursive:true});await cp(resolve(root,path),resolve(tree,path));
  }
  await run('cargo',['vendor','--locked','--versioned-dirs','--manifest-path','src-tauri/native-input-adapter/Cargo.toml','--sync','scripts/native-input/prototype/Cargo.toml','--sync','src-tauri/native-input-editors/Cargo.toml','vendor'],tree);
  await mkdir(resolve(tree,'.cargo'),{recursive:true});
  await writeFile(resolve(tree,'.cargo/config.toml'),'[source.crates-io]\nreplace-with = "vendored-sources"\n[source.vendored-sources]\ndirectory = "vendor"\n');
  await cp(resolve(sourceRoot,'README.txt'),resolve(generated,'README.txt'));
}else if(editorSupported){
  const allowed=new Set(['sources',...targets,...editorAllowed]);
  for(const entry of await readdir(generated))if(!allowed.has(entry))await rm(resolve(generated,entry),{recursive:true});
  const tree=resolve(generated,'sources/ShellSpan');await mkdir(tree,{recursive:true});
  await copyNativeRebuildSources(root,tree);
  for(const catalogue of editorNames)for(const path of Object.keys(JSON.parse(await readFile(resolve(sourceRoot,catalogue),'utf8')).sources)){
    assert((path.startsWith('src-tauri/')||path.startsWith('scripts/native-input/acceptance/')||path.startsWith('scripts/dependency-builds/zsh/'))&&!path.includes('..'));
    await mkdir(resolve(tree,path,'..'),{recursive:true});await cp(resolve(root,path),resolve(tree,path));
  }
  await run('cargo',['vendor','--locked','--versioned-dirs','--manifest-path','src-tauri/native-input-editors/Cargo.toml','--sync','src-tauri/native-input-adapter/Cargo.toml','vendor'],tree);
  await mkdir(resolve(tree,'.cargo'),{recursive:true});await writeFile(resolve(tree,'.cargo/config.toml'),'[source.crates-io]\nreplace-with = "vendored-sources"\n[source.vendored-sources]\ndirectory = "vendor"\n');
}else{for(const entry of await readdir(generated))await rm(resolve(generated,entry),{recursive:true});}
if(validationOnly){assert.deepEqual(captureValidationSources(root),frozenSources);await writeFile(resolve(generated,'editor-validation.json'),JSON.stringify({protocol:'shellspan.native-editor-validation',resourceRoot:destination,sourceManifestSha256,editorTargets:validationTargets},null,2));}
await writeFile(resolve(generated,'resource-manifest.json'),JSON.stringify({version:1,target,targets,sourceHashesVerified:includeBash||editorSupported,unsupportedHost:!includeBash&&!editorSupported,validationOnly,validationEditorTargets:validationTargets},null,2)+'\n');
await writableResourceTree(generated);
await mkdir(resolve(destination,'..'),{recursive:true});const backup=resolve(logDirectory,`previous-${runId}`);let previous=false;
try{await stat(destination);await rename(destination,backup);previous=true;}catch(error){if(error.code!=='ENOENT')throw error;}
try{await rename(generated,destination);}catch(error){if(previous)await rename(backup,destination);throw error;}
console.log(JSON.stringify({directory:destination,target,targets,validationOnly,previousRetained:previous?backup:undefined}));
