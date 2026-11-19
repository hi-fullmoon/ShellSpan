// A separately retained test-only revision of an immutable production snapshot.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,cpSync,readdirSync,existsSync} from 'node:fs';
import {resolve,relative} from 'node:path';
import {captureValidationSources} from './frozen-validation.mjs';

const owner=resolve(import.meta.dirname,'../../..');
const parent=resolve(process.argv[2]);
const zshHelper=process.argv[4]==='--zsh-helper';
assert(parent.startsWith(resolve(owner,'artifacts/tests/native-input/integration/acceptance-source')+'/'));
const parentMeta=JSON.parse(readFileSync(resolve(parent,'artifacts/tests/native-input/integration/source-snapshot.json'),'utf8'));
assert(parentMeta.ownerRoot===owner&&parentMeta.sharedDriftReviewed===true);
const freezeLog=resolve(parent,process.argv[3]);assert(freezeLog.startsWith(parent+'/'));
const baseline=readFileSync(freezeLog,'utf8').trim();assert(baseline.startsWith(resolve(parent,'artifacts/tests/native-input/integration/baseline')+'/'));
const directory=resolve(owner,'artifacts/tests/native-input/integration/acceptance-source',randomUUID());mkdirSync(directory,{recursive:true,mode:0o700});
const sourceRoot=resolve(directory,'ShellSpan');
const sha=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const head=readFileSync(resolve(baseline,'head.txt'),'utf8').trim();assert(/^[a-f0-9]{40}$/.test(head));
execFileSync('git',['clone','--quiet','--shared','--no-checkout',parent,sourceRoot],{stdio:'pipe'});
execFileSync('git',['-C',sourceRoot,'update-ref','refs/heads/codex/p2-test-revision',head]);
execFileSync('git',['-C',sourceRoot,'symbolic-ref','HEAD','refs/heads/codex/p2-test-revision']);
execFileSync('git',['-C',sourceRoot,'read-tree',head]);
execFileSync('tar',['-xzf',resolve(baseline,'HEAD.tar.gz'),'-C',sourceRoot]);
execFileSync('git',['-C',sourceRoot,'apply',resolve(baseline,'worktree.patch')]);
execFileSync('tar',['-xzf',resolve(baseline,'untracked.tgz'),'-C',sourceRoot]);
const parentSources=captureValidationSources(parent);
assert.deepEqual(captureValidationSources(sourceRoot),parentSources,'Parent source is not reconstructible from the recorded archive');
const changes=['scripts/verification/agent/verify-ai-session-stream.mjs','scripts/native-input/integration/app.mjs',
  'src/components/terminal/__tests__/native-input-p2-interactive-fresh.native.tsx',
  'src/components/terminal/__tests__/native-input-p2-interactive-fresh.native.html'];
if(zshHelper)changes.push('src-tauri/src/terminal_integration.rs');
for(const path of changes)cpSync(resolve(owner,path),resolve(sourceRoot,path));
const revised=captureValidationSources(sourceRoot);
const changed=[...new Set([...Object.keys(parentSources),...Object.keys(revised)])].filter(path=>parentSources[path]!==revised[path]);
assert(changed.every(path=>changes.includes(path)),'Unexpected source changed in the declared revision');
if(zshHelper){
  const diff=spawnSync('git',['diff','--no-index','--',resolve(parent,'src-tauri/src/terminal_integration.rs'),resolve(sourceRoot,'src-tauri/src/terminal_integration.rs')],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
  assert.equal(diff.status,1,'The declared Zsh helper revision has no inspectable source difference');
  writeFileSync(resolve(directory,'zsh-helper.diff'),diff.stdout,{mode:0o600});
}
const bundleResources=JSON.parse(readFileSync(resolve(parent,'src-tauri/tauri.conf.json'),'utf8')).bundle.resources;
const packagedResources=Object.keys(bundleResources).find(path=>bundleResources[path]==='native-input/generated/');
for(const path of['artifacts/tests/native-input/integration/resources/native-input','artifacts/tests/native-input/integration/producers','src-tauri/resources/native-input','src-tauri/resources/preview-licenses',...(packagedResources?[`src-tauri/${packagedResources}`]:[])]){
  if(!existsSync(resolve(parent,path)))continue;
  mkdirSync(resolve(sourceRoot,path,'..'),{recursive:true});cpSync(resolve(parent,path),resolve(sourceRoot,path),{recursive:true});
}
const metadata={createdAt:new Date().toISOString(),ownerRoot:owner,sourceRoot,parentSourceRoot:parent,
  scope:zshHelper?'Declared revision: private legacy Zsh stty helper plus four test/entry files; all other source is byte-identical to parent':'Test-only revision; all source outside the four declared test/entry files is byte-identical to the current production snapshot',
  head,baseline,archives:Object.fromEntries(['HEAD.tar.gz','worktree.patch','untracked.tgz'].map(name=>[name,sha(resolve(baseline,name))])),
  changes:changed.map(path=>({path,parentSha256:parentSources[path]??null,sha256:revised[path]})),
  sharedDrift:[],sharedDriftReviewed:true,modelConfiguration:'Current owning native preferences only; no old model configuration or credentials restored'};
writeFileSync(resolve(sourceRoot,'artifacts/tests/native-input/integration/source-snapshot.json'),JSON.stringify(metadata,null,2),{mode:0o600});
writeFileSync(resolve(directory,'snapshot.json'),JSON.stringify(metadata,null,2),{mode:0o600});
console.log(JSON.stringify({sourceRoot,directory,changed,productionSourceIdentical:!zshHelper}));
