import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {copyFileSync,mkdirSync,readFileSync,writeFileSync,cpSync,chmodSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {captureValidationSources} from '../native-input-p2/frozen-validation.mjs';
import {createIndexReader} from './index-reader.mjs';
import {auditEditorResources} from './editor-resources.mjs';
const owner=resolve(import.meta.dirname,'../..');
const directory=resolve(owner,'.artifacts/tests/native-input-p3/acceptance-source',randomUUID());
const root=resolve(directory,'ShellSpan');mkdirSync(root,{recursive:true,mode:0o700});
const sources=captureValidationSources(owner);
for(const path of Object.keys(sources)){
  assert(!path.startsWith('/')&&!path.split('/').includes('..'));
  mkdirSync(dirname(resolve(root,path)),{recursive:true});copyFileSync(resolve(owner,path),resolve(root,path));
}
const meta=resolve(root,'.artifacts/tests/native-input-p3');mkdirSync(meta,{recursive:true});
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
cpSync(resolve(owner,'.artifacts/tests/native-input-p2/resources'),resolve(root,'.artifacts/tests/native-input-p2/resources'),{recursive:true});
const nativeResources=auditEditorResources(root,process.platform==='darwin'?'macos-arm64':'windows-x64');
writeFileSync(resolve(meta,'native-resource-audit.json'),JSON.stringify(nativeResources,null,2));
assert(nativeResources.selectedValid,`Native artifact inputs changed or are stale; retained failed snapshot: ${root}`);
const targetBindings={};
if(process.platform==='darwin'){
  const catalogue=JSON.parse(readFileSync(resolve(root,'.artifacts/tests/native-input-p2/resources/native-input/editors-macos-arm64.json'),'utf8'));
  const coreRelative=catalogue.profiles[0].core;assert(coreRelative);
  const core=resolve(root,'.artifacts/tests/native-input-p2/resources/native-input',coreRelative),sha=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
  assert.equal(sha(core),catalogue.profiles[0].editorSha256);Object.assign(targetBindings,{core,coreSha256:sha(core),mainSha256:sha('/bin/zsh')});
}
writeFileSync(resolve(meta,'candidate-base-sources.json'),JSON.stringify(sources,null,2));
writeFileSync(resolve(meta,'candidate-stage.json'),JSON.stringify({root,directory,owner,head,sealed:true,overrides:[],explicitOverrides:[],sourceCount:Object.keys(sources).length,...targetBindings,nativeAcceptance:false,productionBindingChanged:false,completeOwnerSnapshot:true},null,2));
const dependencies=resolve(meta,'dependencies');mkdirSync(dependencies,{recursive:true});
const archive=resolve(owner,'.artifacts/tests/native-input-p3/dependencies/zsh-5.9.tar.xz');if(existsSync(archive))copyFileSync(archive,resolve(dependencies,'zsh-5.9.tar.xz'));
console.log(root);
