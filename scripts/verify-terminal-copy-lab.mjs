// Isolated dependency review only; never adopts cursor/copy rules in production.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,readdirSync,existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.join(root,'.native-input-p0/copy-runs',new Date().toISOString().replaceAll(':','-'));
mkdirSync(output,{recursive:true});
const sha=name=>createHash('sha256').update(readFileSync(path.resolve(root,name))).digest('hex');
const sources=['scripts/native-input-p0/xterm-copy-serialization.patch','scripts/native-input-p0/xterm-cursor-reflow.patch',
  'scripts/native-input-p0/build-xterm-lab.mjs','scripts/native-input-p0/copy-compat.py',
  'scripts/native-input-p0/copy-compat.browser.mjs','scripts/native-input-p0/copy-search-cases.json',
  'scripts/native-input-p0/terminal-compat.py','scripts/verify-terminal-copy-lab.mjs'];
const hashes=()=>Object.fromEntries(sources.map(name=>[name,sha(name)]));
const before=hashes();writeFileSync(path.join(output,'sources-before.json'),JSON.stringify(before,null,2));
const nativeGate='.native-input-p0/inband-runs/2026-10-31T07-47-56.795Z';
const gate=JSON.parse(readFileSync(path.join(root,nativeGate,'result.json'),'utf8'));
assert.equal(gate.native,0);assert.equal(gate.parsed,0);assert.equal(gate.queuedFragmented,0);assert(gate.sourceStable);
const nativeSources=JSON.parse(readFileSync(path.join(root,nativeGate,'sources-before.json'),'utf8'));
for(const name of ['scripts/native-input-p0/bridge.c','scripts/native-input-p0/inband-display.patch'])assert.equal(sha(name),nativeSources[name],`Native source changed; cannot reuse: ${name}`);
const bridge='.native-input-p0/inband-display-lab/bridge.so';
const nativeInputs=JSON.parse(readFileSync(path.join(root,nativeGate,'captures/manifest.json'),'utf8')).inputs;
assert.equal(sha(bridge),nativeInputs.bridge.sha256,'Frozen native module changed; cannot reuse lifecycle evidence');
const commitEvidence=[];
for(const directory of ['commit-resize-fixed-4.1','commit-resize-fixed-4.4','commit-resize-final-5.3']){
  const base=path.join(root,'.native-input-p0',directory);
  const name=readdirSync(base).find(name=>name.startsWith('commit-resize-'));
  const result=JSON.parse(readFileSync(path.join(base,name,'probe-result.json'),'utf8'));
  assert.equal(result.completed,64);assert.equal(result.failures.length,0);
  commitEvidence.push({directory,completed:result.completed,rawWrapLeaks:result.results.filter(item=>item.hiddenPlanLeak).length});
}
writeFileSync(path.join(output,'reused-native-evidence.json'),JSON.stringify({nativeGate,bridgeSha256:sha(bridge),commitEvidence},null,2));
function run(command,args,log,env={}){
  const result=spawnSync(command,args,{cwd:root,env:{...process.env,...env},encoding:'utf8',maxBuffer:32*1024*1024});
  writeFileSync(path.join(output,log),`${result.stdout??''}${result.stderr??''}\nexit=${result.status}\n`);
  if(result.error)throw result.error;return result.status??1;
}
for(const baseline of [true,false])if(run('node',['scripts/native-input-p0/build-xterm-lab.mjs','--copy-fix',...(baseline?['--baseline']:[])],baseline?'baseline-build.log':'candidate-build.log'))process.exit(1);
const shell=JSON.parse(readFileSync(path.join(root,'.native-input-p0/build-darwin.json'),'utf8'))['5.3'].shell;
const args=process.argv.slice(2),captureIndex=args.indexOf('--captures');
const captures=captureIndex>=0?path.resolve(root,args[captureIndex+1]):path.join(output,'captures');
const native=captureIndex>=0?0:run('python3',['scripts/native-input-p0/copy-compat.py','--output',captures,'--shell',shell,'--bridge',path.join(root,bridge)],'native-copy.log');
if(native)process.exit(native);
const copyInputs=JSON.parse(readFileSync(path.join(captures,'manifest.json'),'utf8'));
assert.equal(copyInputs.inputs.bridge,sha(bridge),'Copy capture uses a different native module');
for(const name of copyInputs.cases){
  const scenario=JSON.parse(readFileSync(path.join(captures,name,'scenario.json'),'utf8'));
  if(scenario.inbandDisplay){
    const result=JSON.parse(readFileSync(path.join(captures,name,'native-result.json'),'utf8'));
    assert.equal(result.result,'PASS');assert(result.nativeBufferBound);assert.equal(result.submissionCount,1);
    assert.equal(readFileSync(path.join(captures,name,'effect'),'utf8'),result.actualEffect);
  }
  if(scenario.name==='native-edit-tab'){
    const result=JSON.parse(readFileSync(path.join(captures,name,'native-result.json'),'utf8'));
    assert.equal(result.result,'PASS');assert(result.quotedInsertTabHistoryPreserved);
    assert.equal(readFileSync(path.join(captures,name,'home/user-tab-effect'),'utf8'),result.actualEffect);
  }
}
let legacy=path.join(root,'.native-input-p0/dependency-compat-pty-v4');
if(!existsSync(path.join(legacy,'manifest.json'))){
  legacy=path.join(output,'compatibility-captures');
  if(run('python3',['scripts/native-input-p0/terminal-compat.py','--output',legacy,'--native','--shell',shell],'compatibility-native.log'))process.exit(1);
}
const browser=run('node',['scripts/native-input-p0/copy-compat.browser.mjs',captures,path.join(output,'browser')],
  'browser.log',{SHELLSPAN_P0_COPY_LEGACY_ROOT:legacy});
const ordinaryStock=run('node',['scripts/native-input-p0/copy-compat.browser.mjs',captures,path.join(output,'ordinary-stock'),
  '--ordinary-stock-only'],'ordinary-stock.log',{SHELLSPAN_P0_COPY_LEGACY_ROOT:legacy});
const after=hashes(),sourceStable=JSON.stringify(before)===JSON.stringify(after);
writeFileSync(path.join(output,'sources-after.json'),JSON.stringify(after,null,2));
writeFileSync(path.join(output,'result.json'),JSON.stringify({native,browser,ordinaryStock,sourceStable,reusedNative:true,formalAdoption:false},null,2));
console.log(`P0 isolated copy laboratory: ${browser||ordinaryStock||!sourceStable?'FAIL':'PASS'} (no formal adoption); ${output}`);
process.exitCode=browser||ordinaryStock||Number(!sourceStable);
