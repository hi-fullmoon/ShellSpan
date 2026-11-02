// Reconstruct a recorded validation source tree in an ignored artifact folder.
// User files/configuration are read-only. This creates no commit or tag.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,cpSync,readdirSync} from 'node:fs';
import {resolve,relative} from 'node:path';
import {captureValidationSources} from './frozen-validation.mjs';

const owner=resolve(import.meta.dirname,'../..');
const baseline=resolve(process.argv[2]);const currentMode=process.argv[3]==='--current';const reference=currentMode?undefined:resolve(process.argv[3]);
assert(baseline.startsWith(resolve(owner,'.native-input-p2/baseline')+'/'));
assert(currentMode||reference.startsWith(resolve(owner,'.native-input-p2/app-')));
const sha=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const head=readFileSync(resolve(baseline,'head.txt'),'utf8').trim();assert(/^[a-f0-9]{40}$/.test(head));
const before=captureValidationSources(owner);
const directory=resolve(owner,'.native-input-p2/acceptance-source',randomUUID());mkdirSync(directory,{recursive:true,mode:0o700});
const sourceRoot=resolve(directory,'ShellSpan');
execFileSync('git',['clone','--quiet','--shared','--no-checkout',owner,sourceRoot],{stdio:'pipe'});
execFileSync('git',['-C',sourceRoot,'update-ref','refs/heads/codex/p2-validation-source',head]);
execFileSync('git',['-C',sourceRoot,'symbolic-ref','HEAD','refs/heads/codex/p2-validation-source']);
execFileSync('git',['-C',sourceRoot,'read-tree',head]);
execFileSync('tar',['-xzf',resolve(baseline,'HEAD.tar.gz'),'-C',sourceRoot]);
execFileSync('git',['-C',sourceRoot,'apply',resolve(baseline,'worktree.patch')]);
execFileSync('tar',['-xzf',resolve(baseline,'untracked.tgz'),'-C',sourceRoot]);
const baselineSources=JSON.parse(readFileSync(resolve(baseline,'sources.json'),'utf8'));
assert.deepEqual(captureValidationSources(sourceRoot),baselineSources,'The reconstructed archive does not match its recorded source hashes');
const shared=new Set(['package.json','pnpm-lock.yaml','src-tauri/Cargo.toml','src-tauri/Cargo.lock','src-tauri/src/lib.rs','src-tauri/src/commands.rs','src-tauri/src/models.rs','src/lib/ipc/tauri.ts','src/types/index.ts']);
const inputs=currentMode?{sources:baselineSources}:JSON.parse(readFileSync(resolve(reference,'acceptance-inputs.json'),'utf8'));
const core={};
for(const [path,digest] of Object.entries(inputs.sources)){
  if(shared.has(path)||path.startsWith('node_modules/')||path.startsWith('scripts/')||path.includes('/__tests__/'))continue;
  assert.equal(sha(resolve(owner,path)),digest,`Current P2 core changed; review before using a baseline: ${path}`);
  assert.equal(sha(resolve(sourceRoot,path)),digest,`Baseline does not contain the current P2 core: ${path}`);
  core[path]=digest;
}
const overlays=['scripts/native-input-p2','scripts/verify-ai-session-stream.mjs','scripts/dev-cargo-runner.mjs','scripts/verify-terminal-input-p2.mjs',
  'src/components/terminal/__tests__/native-jobs.native.tsx','src/components/terminal/__tests__/terminal-contention.native.tsx','src/components/terminal/__tests__/terminal-delegation.native.tsx',
  ...readdirSync(resolve(owner,'src/components/terminal/__tests__')).filter(name=>name.startsWith('native-input-p2-')).map(name=>`src/components/terminal/__tests__/${name}`)];
for(const path of overlays)cpSync(resolve(owner,path),resolve(sourceRoot,path),{recursive:true,force:true,filter:path=>!path.split('/').includes('__pycache__')});
const drift=[];
for(const path of shared){
  const old=sha(resolve(sourceRoot,path)),current=sha(resolve(owner,path));if(old===current)continue;
  const diff=spawnSync('git',['diff','--no-index','--',resolve(sourceRoot,path),resolve(owner,path)],{encoding:'utf8',maxBuffer:8*1024*1024});
  assert(diff.status===1,'Could not inspect the shared source difference');
  const diffPath=resolve(directory,path.replaceAll('/','_')+'.diff');writeFileSync(diffPath,diff.stdout,{mode:0o600});
  drift.push({path,baselineSha256:old,currentSha256:current,diff:relative(owner,diffPath),diffSha256:sha(diffPath)});
}
assert.deepEqual(captureValidationSources(owner),before,'Owner source changed while the validation snapshot was being copied');
for(const path of['.native-input-p2/resources/native-input-v1','.native-input-p2/producers','src-tauri/resources/native-input-v1']){
  mkdirSync(resolve(sourceRoot,path,'..'),{recursive:true});cpSync(resolve(owner,path),resolve(sourceRoot,path),{recursive:true});
}
const fixture='87e1754d-ca4c-4689-95ea-27faea5c8f27';
mkdirSync(resolve(sourceRoot,'.native-input-p2/ssh',fixture),{recursive:true});
cpSync(resolve(owner,'.native-input-p2/ssh',fixture,'fixture.json'),resolve(sourceRoot,'.native-input-p2/ssh',fixture,'fixture.json'));
const metadata={createdAt:new Date().toISOString(),ownerRoot:owner,sourceRoot,baseline:relative(owner,baseline),head,
  archives:Object.fromEntries(['HEAD.tar.gz','worktree.patch','untracked.tgz'].map(name=>[name,sha(resolve(baseline,name))])),
  scope:'Isolated P2 source acceptance; does not certify the evolving whole workspace',core,overlays,sharedDrift:drift,
  sharedDriftReviewed:drift.length===0,modelConfiguration:'Read current owning native preferences at each case; never restore an old route or credential'};
writeFileSync(resolve(sourceRoot,'.native-input-p2/source-snapshot.json'),JSON.stringify(metadata,null,2),{mode:0o600});
writeFileSync(resolve(directory,'snapshot.json'),JSON.stringify(metadata,null,2),{mode:0o600});
console.log(JSON.stringify({directory,sourceRoot,sharedDrift:drift,reviewRequired:true}));
