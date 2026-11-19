import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {copyFileSync,mkdirSync,readFileSync,writeFileSync,chmodSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {parseArgs} from 'node:util';
import {windowsShortSnapshotLocation} from './windows-profiles.mjs';
import {captureValidationSources} from '../integration/frozen-validation.mjs';
import {createIndexReader} from './index-reader.mjs';
import {auditEditorResources} from './editor-resources.mjs';
import {selectSnapshotResources,verifySnapshotResourceCopy,copySnapshotResources} from './acceptance-snapshot-resources.mjs';
const owner=resolve(import.meta.dirname,'../../..');
const {values}=parseArgs({options:{'short-windows-paths':{type:'boolean'},'rebuild-windows-editors':{type:'boolean'},'windows-resources-from':{type:'string'},'controller-only':{type:'boolean'}}});
assert(!values['controller-only']||!values['rebuild-windows-editors']&&!values['windows-resources-from'],'Controller-only snapshots cannot rebuild or admit native resources');
assert(!(values['rebuild-windows-editors']&&values['windows-resources-from']),'Choose reconstruction or exact retained resource reuse');
assert(!values['windows-resources-from']||process.platform==='win32'&&process.arch==='x64','Retained Windows resources require actual Windows x64');
const reusedResources=values['windows-resources-from']?await selectSnapshotResources(owner,values['windows-resources-from']):undefined;
if(values['rebuild-windows-editors']){
  assert(process.platform==='win32'&&process.arch==='x64','Editor reconstruction requires actual Windows x64');
  assert.equal(process.env.SHELLSPAN_ALLOW_FOREGROUND_TESTS,'1','Windows editor reconstruction requires the explicit foreground test gate');
}
assert(!values['short-windows-paths']||process.platform==='win32'&&process.arch==='x64','Short Windows snapshots require actual Windows x64');
const id=randomUUID();
const location=values['short-windows-paths']?windowsShortSnapshotLocation(owner,id):undefined;
const directory=location?.directory??resolve(owner,'artifacts/tests/native-input/acceptance/acceptance-source',id);
// Reserve the compact namespace exclusively; a collision must never reuse or
// overwrite a retained acceptance source, even though UUID collisions are rare.
mkdirSync(dirname(directory),{recursive:true,mode:0o700});mkdirSync(directory,{mode:0o700});
const root=location?.root??resolve(directory,'ShellSpan');mkdirSync(root,{mode:0o700});
const sources=captureValidationSources(owner);
for(const path of Object.keys(sources)){
  assert(!path.startsWith('/')&&!path.split('/').includes('..'));
  mkdirSync(dirname(resolve(root,path)),{recursive:true});copyFileSync(resolve(owner,path),resolve(root,path));
}
const meta=resolve(root,'artifacts/tests/native-input/acceptance');mkdirSync(meta,{recursive:true});
const originalIndex=execFileSync('git',['rev-parse','--path-format=absolute','--git-path','index'],{cwd:owner,encoding:'utf8'}).trim();
const head=execFileSync('git',['rev-parse','HEAD'],{cwd:owner,encoding:'utf8'}).trim();
const {gitDirectory,index}=createIndexReader(meta,originalIndex,head);
chmodSync(index,0o400);
const indexSha256=createHash('sha256').update(readFileSync(index)).digest('hex');
writeFileSync(resolve(meta,'snapshot-index.json'),JSON.stringify({version:1,root,index,indexSha256,gitDirectory,purpose:'Read-only file discovery with a copied index; no refs, commit objects, branches or registered worktrees are created.'},null,2));
assert.deepEqual(captureValidationSources(owner),sources,'Owner changed while the acceptance copy was made');
assert.deepEqual(captureValidationSources(root),sources,'The complete acceptance copy differs from its source inventory');
writeFileSync(resolve(directory,'sources.json'),JSON.stringify(sources,null,2)+'\n');
writeFileSync(resolve(directory,'snapshot.json'),JSON.stringify({owner,root,directory,createdAt:new Date().toISOString(),head,sourceCount:Object.keys(sources).length,indexSha256},null,2)+'\n');
// Explicitly copied, hashed native resources are generated inputs rather than
// source. Their source manifests are checked again by the production loaders.
const resourceDestination=resolve(root,'artifacts/tests/native-input/integration/resources');
if(!values['controller-only']){
copySnapshotResources(reusedResources?.directory??resolve(owner,'artifacts/tests/native-input/integration/resources'),resourceDestination);
if(reusedResources){
  await verifySnapshotResourceCopy(reusedResources,resourceDestination);
  writeFileSync(resolve(meta,'resource-reuse.json'),JSON.stringify({sourceRoot:reusedResources.root,sourceManifestSha256:reusedResources.sourceManifestSha256,resourcesSha256:reusedResources.resourcesSha256,originalBytesCopied:true,recompiled:false},null,2));
}
if(values['rebuild-windows-editors']){
  const rebuildLog=resolve(meta,'windows-resource-rebuild.log');
  const output=execFileSync(process.execPath,[resolve(root,'scripts/native-input/acceptance/build-windows.mjs')],{cwd:root,env:{...process.env,SHELLSPAN_NATIVE_BUILD_ROOT:'artifacts/tests',RUSTUP_TOOLCHAIN:'1.95.0-x86_64-pc-windows-msvc',CARGO_TARGET_DIR:resolve(root,'src-tauri/native-input-editors/target'),CARGO_BUILD_JOBS:'4'},windowsHide:true,encoding:'utf8',maxBuffer:1024*1024});
  writeFileSync(rebuildLog,output);
  assert.deepEqual(captureValidationSources(root),sources,'Source changed during isolated Windows editor reconstruction');
  assert.deepEqual(captureValidationSources(owner),sources,'Owner changed during isolated Windows editor reconstruction');
}
}
const nativeResources=values['controller-only']?{contextKind:'controller-only',nativeResourcesValidated:false}:auditEditorResources(root,process.platform==='darwin'?'macos-arm64':'windows-x64');
writeFileSync(resolve(meta,'native-resource-audit.json'),JSON.stringify(nativeResources,null,2));
assert(values['controller-only']||nativeResources.selectedValid,`Native artifact inputs changed or are stale; retained failed snapshot: ${root}`);
const targetBindings={};
if(process.platform==='darwin'&&!values['controller-only']){
  const catalogue=JSON.parse(readFileSync(resolve(root,'artifacts/tests/native-input/integration/resources/native-input/editors-macos-arm64.json'),'utf8'));
  const coreRelative=catalogue.profiles[0].core;assert(coreRelative);
  const core=resolve(root,'artifacts/tests/native-input/integration/resources/native-input',coreRelative),sha=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
  const main=catalogue.profiles[0].shell?resolve(root,'artifacts/tests/native-input/integration/resources/native-input',catalogue.profiles[0].shell):'/bin/zsh';
  assert.equal(sha(core),catalogue.profiles[0].editorSha256);assert.equal(sha(main),catalogue.profiles[0].shellSha256);
  Object.assign(targetBindings,{core,coreSha256:sha(core),main,mainSha256:sha(main)});
}
writeFileSync(resolve(meta,'candidate-base-sources.json'),JSON.stringify(sources,null,2));
writeFileSync(resolve(meta,'candidate-stage.json'),JSON.stringify({root,directory,owner,head,sealed:true,contextKind:values['controller-only']?'controller-only':'artifact-source',overrides:[],explicitOverrides:[],sourceCount:Object.keys(sources).length,...targetBindings,windowsEditorsRebuilt:Boolean(values['rebuild-windows-editors']),nativeAcceptance:false,productionBindingChanged:false,completeOwnerSnapshot:true},null,2));
const dependencies=resolve(meta,'dependencies');mkdirSync(dependencies,{recursive:true});
const archive=resolve(owner,'artifacts/tests/native-input/acceptance/dependencies/zsh-5.9.tar.xz');if(existsSync(archive))copyFileSync(archive,resolve(dependencies,'zsh-5.9.tar.xz'));
console.log(root);
