// Actual installed package; default builds/captures the frozen native target.
import {parseArgs} from 'node:util';
import {spawnSync} from 'node:child_process';
import {readFileSync,readdirSync,mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {installedRuntimeManifest} from './native-input-p0/formal-runtime.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const{values:args}=parseArgs({options:{captures:{type:'string'},'copy-captures':{type:'string'},
  'compat-captures':{type:'string'},'geometry-captures':{type:'string'},'commit-capture':{type:'string'},
  'copy-only':{type:'boolean'},'inband-only':{type:'boolean'}}});
if(args['copy-only']&&args['inband-only'])throw new Error('Choose one scope');
const scope=args['copy-only']?'copy':args['inband-only']?'inband':'full';
const output=path.join(root,'.native-input-p0/formal-runs',new Date().toISOString().replaceAll(':','-'));
mkdirSync(output,{recursive:true});
const installed=await installedRuntimeManifest();
const owners=['scripts/native-input-p0/bridge.c','scripts/native-input-p0/inband-display.patch',
  'scripts/native-input-p0/src/lib.rs','scripts/native-input-p0/Cargo.lock',
  'src/lib/terminal/native-input-display.ts','scripts/dependency-builds/xterm/artifacts.json'];
const hashes=()=>Object.fromEntries(owners.map(name=>[name,createHash('sha256').update(readFileSync(path.join(root,name))).digest('hex')]));
const before=hashes(),results=[];writeFileSync(path.join(output,'sources-before.json'),JSON.stringify(before,null,2));
const original=path.join(output,'original-package');
function run(name,command,parameters,env={}){
  const result=spawnSync(command,parameters,{cwd:root,env:{...process.env,SHELLSPAN_P0_FORMAL_XTERM:'1',
    SHELLSPAN_P0_ORIGINAL_PACKAGE:original,SHELLSPAN_P0_ORIGINAL_XTERM:path.join(original,'lib/xterm.js'),...env},
    encoding:'utf8',maxBuffer:64*1024*1024});
  writeFileSync(path.join(output,`${name}.log`),`${result.stdout??''}${result.stderr??''}\nexit=${result.status}\n`);
  if(result.error)throw result.error;results.push({name,exit:result.status??1});return result.status===0;
}
// Only controls are source-built. Candidate runtimes always use the installed
// pnpm package, verified above; never apply an experimental patch to it again.
if(!run('original-package','pnpm',['patch','@xterm/xterm@6.0.0','--ignore-existing','--edit-dir',original]))throw new Error('Original package extraction failed');
if(!run('unpatched-control','node',['scripts/native-input-p0/build-xterm-lab.mjs','--baseline']))throw new Error('Unpatched control build failed');
if(!run('cursor-only-control','node',['scripts/native-input-p0/build-xterm-lab.mjs','--copy-fix','--baseline']))throw new Error('Cursor-only control build failed');
const needCopy=scope!=='inband',needInband=scope!=='copy';
let built;
function nativeTarget(){
  if(built)return built;
  if(process.platform!=='darwin'||process.arch!=='arm64')throw new Error('Frozen native target requires macOS arm64; not a skip');
  if(!run('native-build','python3',['scripts/native-input-p0/build.py','--upstream','--versions','5.3']))throw new Error('Native build failed');
  if(!run('native-display-build','python3',['scripts/native-input-p0/build-inband-lab.py']))throw new Error('Native display build failed');
  const build=JSON.parse(readFileSync(path.join(root,'.native-input-p0/build-darwin.json'),'utf8'))['5.3'];
  built={shell:build.shell,bridge:path.join(root,'.native-input-p0/inband-display-lab/bridge.so')};return built;
}
function capture(option,script,name,flags=[]){
  if(args[option])return path.resolve(root,args[option]);
  const target=nativeTarget(),directory=path.join(output,name);
  if(!run(name,'python3',[script,'--shell',target.shell,...(script.endsWith('terminal-compat.py')?[]:['--bridge',target.bridge]),
    '--output',directory,...flags]))throw new Error(`${name} failed`);
  return directory;
}
const inputs={scope};
if(needCopy){
  const copies=capture('copy-captures','scripts/native-input-p0/copy-compat.py','copy-captures');
  const compatibility=capture('compat-captures','scripts/native-input-p0/terminal-compat.py','compatibility-captures',['--native']);
  Object.assign(inputs,{copies,compatibility});
  run('copy','node',['scripts/native-input-p0/copy-compat.browser.mjs',copies,path.join(output,'copy')],{SHELLSPAN_P0_COPY_LEGACY_ROOT:compatibility});
  run('ordinary-stock','node',['scripts/native-input-p0/copy-compat.browser.mjs',copies,path.join(output,'ordinary-stock'),'--ordinary-stock-only'],{SHELLSPAN_P0_COPY_LEGACY_ROOT:compatibility});
}
if(needInband){
  const inband=capture('captures','scripts/native-input-p0/ownership-window.py','inband-captures',['--inband']);
  inputs.inband=inband;
  const manifest=JSON.parse(readFileSync(path.join(inband,'manifest.json'),'utf8'));
  if(manifest.nativeFailures.length)throw new Error('Supplied native corpus has failures');
  run('inband','node',['scripts/native-input-p0/terminal-compat.browser.mjs',inband],{
    SHELLSPAN_P0_OUTPUT_ROOT:path.join(output,'inband'),SHELLSPAN_P0_QUEUE_RESIZE:'0',SHELLSPAN_P0_FRAGMENT_BYTES:'0'});
  run('inband-queued','node',['scripts/native-input-p0/terminal-compat.browser.mjs',inband],{
    SHELLSPAN_P0_OUTPUT_ROOT:path.join(output,'inband-queued'),SHELLSPAN_P0_QUEUE_RESIZE:'1',SHELLSPAN_P0_FRAGMENT_BYTES:'1'});
  run('boundaries','node',['scripts/native-input-p0/inband-parser-boundaries.mjs',inband],{SHELLSPAN_P0_OUTPUT_ROOT:path.join(output,'boundaries')});
  run('display-controller','node',['src/lib/terminal/__tests__/native-input-display.browser.mjs'],{SHELLSPAN_P0_OUTPUT_ROOT:path.join(output,'display-controller')});
}
if(scope==='full'){
  const geometry=capture('geometry-captures','scripts/native-input-p0/acceptance.py','geometry-captures',['--display-profile','append']);
  inputs.geometry=geometry;
  run('geometry','node',['scripts/native-input-p0/browser.mjs'],{SHELLSPAN_P0_CAPTURE_ROOT:geometry,
    SHELLSPAN_P0_OUTPUT_ROOT:path.join(output,'geometry'),SHELLSPAN_P0_REFLOW_CURSOR:'1'});
  const commits=capture('commit-capture','scripts/native-input-p0/commit-resize.py','commit-captures');inputs.commits=commits;
  const candidates=existsSync(path.join(commits,'probe-result.json'))?[commits]:readdirSync(commits)
    .filter(name=>name.startsWith('commit-resize-')&&existsSync(path.join(commits,name,'probe-result.json'))).map(name=>path.join(commits,name));
  if(candidates.length!==1)throw new Error('Provide one complete commit/resize corpus');
  const resultPath=readFileSync(path.join(candidates[0],'probe-result.json'),'utf8');
  const commitResult=JSON.parse(resultPath);
  if(commitResult.completed!==64||commitResult.failures.length)throw new Error('Commit/resize corpus is incomplete or failing');
}
const after=hashes(),sourceStable=JSON.stringify(before)===JSON.stringify(after);
writeFileSync(path.join(output,'sources-after.json'),JSON.stringify(after,null,2));
writeFileSync(path.join(output,'result.json'),JSON.stringify({scope,installed,inputs,results,sourceStable,
  productionInputRouteEnabled:false,onlineDisplayBinding:'P1 pending'},null,2));
const failed=!sourceStable||results.some(result=>result.exit!==0);
console.log(`Formal xterm P0 (${scope}): ${failed?'FAIL':'PASS'}; ${output}`);process.exitCode=Number(failed);
