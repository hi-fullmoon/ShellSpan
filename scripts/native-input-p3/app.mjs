import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,existsSync,openSync,closeSync} from 'node:fs';
import {resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {captureValidationSources} from '../native-input-p2/frozen-validation.mjs';
import {editorValidationEnvironment} from './editor-validation.mjs';
import {assertNativeGuiAllowed} from '../native-input-p2/gui-lock.mjs';
assertNativeGuiAllowed();
const root=resolve(import.meta.dirname,'../..');
const fixture=process.env.SHELLSPAN_P3_CASE??'jobs';assert(['jobs','contention','interactive','cancel','submit-fault'].includes(fixture));
const sshFixturePath=process.env.SHELLSPAN_P3_SSH_FIXTURE?resolve(process.env.SHELLSPAN_P3_SSH_FIXTURE):undefined;
const ssh=sshFixturePath?JSON.parse(readFileSync(sshFixturePath,'utf8')):undefined;
if(ssh){
 assert(fixture==='jobs'&&sshFixturePath.startsWith(resolve(root,'.artifacts/tests/native-input-p2/ssh')+'/'));
 assert(ssh.root===root&&ssh.host==='127.0.0.1'&&Number.isInteger(ssh.port)&&ssh.port>1024&&ssh.shell==='zsh'&&ssh.username==='nativeZle');
 assert(/^shellspan-nip-p2-[a-f0-9-]{36}$/.test(ssh.container));
 const label=execFileSync('docker',['inspect','--format','{{index .Config.Labels "shellspan.native-input-p2"}}',ssh.container],{encoding:'utf8'}).trim();
 assert.equal(ssh.container,`shellspan-nip-p2-${label}`);
}
assert(existsSync(resolve(root,'.artifacts/tests/native-input-p3/snapshot-index.json')),'Run application acceptance in a complete immutable P3 source copy');
assert(process.platform==='darwin'&&process.arch==='arm64','This entry owns the actual macOS ZLE application case');
const directory=resolve(root,'.artifacts/tests/native-input-p2/app-p3-zsh',randomUUID());
for(const name of ['home','data'])mkdirSync(resolve(directory,name),{recursive:true,mode:0o700});
const sources=captureValidationSources(root);writeFileSync(resolve(directory,'sources-before.json'),JSON.stringify(sources,null,2));
const originalHome=process.env.HOME;
const sourcePath=['.shellspan-dev','.shellspan'].map(name=>resolve(originalHome,name,'shellspan-main.db')).find(existsSync);
assert(sourcePath,'A configured actual route store is required');
const source=new DatabaseSync(sourcePath,{readOnly:true});
const row=source.prepare("SELECT value FROM preferences WHERE key='llm.routes.v1'").get();source.close();
assert(row&&typeof row.value==='string');const routes=JSON.parse(row.value);
for(const route of routes.routes){
  assert(['none','keychain'].includes(route.auth.kind));assert(Object.keys(route.auth).every(key=>['kind','reference'].includes(key)));
  const url=new URL(route.baseUrl);assert(!url.username&&!url.password&&!url.search&&!url.hash);
}
const requested=process.env.SHELLSPAN_P3_MODEL;
if(requested){const selected=routes.routes.find(route=>route.id===routes.defaultSelection.routeId);assert(selected.models[requested]);routes.defaultSelection={routeId:selected.id,modelId:requested,...(process.env.SHELLSPAN_P3_REASONING?{reasoningEffort:process.env.SHELLSPAN_P3_REASONING}:{})};}
writeFileSync(resolve(directory,'route-source.json'),JSON.stringify({path:sourcePath,valueSha256:createHash('sha256').update(row.value).digest('hex'),selection:routes.defaultSelection}));
writeFileSync(resolve(directory,'home/.zshrc'),"PROMPT='%F{cyan}P3 %n@%m %~%f %# '\nHISTFILE=$HOME/history\nHISTSIZE=1000\nSAVEHIST=1000\nsetopt interactivecomments\n");
let submittedProgramSha256;
if(fixture==='submit-fault'){
 const home=resolve(directory,'home'),program=resolve(home,'p3-stop-target');
 execFileSync('cc',['-std=c11','-pthread','scripts/native-input-p3/signal-target.c','-o',program],{cwd:root,stdio:'pipe'});
 submittedProgramSha256=createHash('sha256').update(readFileSync(program)).digest('hex');
 writeFileSync(resolve(home,'.zshrc'),readFileSync(resolve(home,'.zshrc'),'utf8')+"autoload -Uz add-zsh-hook\np3_stop_before_exec() {\n [[ ! -e $HOME/p3-stop-used ]] || return 0\n setopt localtraps\n trap '' INT\n builtin printf 1 > $HOME/p3-stop-used\n builtin print -rn -- \"$1\" > $HOME/p3-stop-source\n local gate_value\n IFS= read -r gate_value < $HOME/p3-stop-gate\n}\nadd-zsh-hook preexec p3_stop_before_exec\n");
 writeFileSync(resolve(directory,'submit-fault-program.json'),JSON.stringify({program,sha256:submittedProgramSha256,sourceSha256:createHash('sha256').update(readFileSync(resolve(root,'scripts/native-input-p3/signal-target.c'))).digest('hex'),gate:'public user preexec, local INT trap held until explicit FIFO release',productionShellOrUserConfigurationChanged:false},null,2));
}
const validation=await editorValidationEnvironment(root,resolve(root,'.artifacts/tests/native-input-p2/resources/native-input'),ssh?['macos-arm64','linux-aarch64-glibc-2.36']:['macos-arm64']);
const localArtifact=JSON.parse(readFileSync(resolve(root,'.artifacts/tests/native-input-p2/resources/native-input/editors-macos-arm64.json'),'utf8')).profiles[0];
assert(localArtifact.shell&&localArtifact.profile.shell==='zsh');
const localShell=resolve(root,'.artifacts/tests/native-input-p2/resources/native-input',localArtifact.shell);
assert.equal(createHash('sha256').update(readFileSync(localShell)).digest('hex'),localArtifact.shellSha256);
const environment={...process.env,...validation,SHELLSPAN_DATA_DIR:resolve(directory,'data'),SHELLSPAN_LOCAL_HOME:resolve(directory,'home'),SHELLSPAN_LOCAL_SHELL:localShell,SHELL:localShell,LC_ALL:'en_US.UTF-8',
  ...(ssh?{SHELLSPAN_P2_CREDENTIAL_REFERENCE:`native-p2-secret-${randomUUID()}`,SHELLSPAN_P2_SSH_USER:'nativeZle'}:{}),
  SHELLSPAN_ACCEPTANCE_EVIDENCE_DIR:directory,SHELLSPAN_DEV_SIGNING_KEYCHAIN:resolve(originalHome,'Library/Keychains/login.keychain-db')};
async function run(name,args,provision){const log=openSync(resolve(directory,`${name}.log`),'wx',0o600);const child=spawn(process.execPath,['scripts/verify-ai-session-stream.mjs',...args],{cwd:root,env:environment,stdio:[provision?'pipe':'ignore',log,log]});if(provision)child.stdin.end(JSON.stringify(provision));const outcome=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});closeSync(log);writeFileSync(resolve(directory,`${name}-process-exit.json`),JSON.stringify(outcome,null,2));return outcome.code??1;}
const initialization=['--data-initialize','--no-model','--data-scope','com.shellspan.validation.native-input-p3'];
let password=ssh?randomBytes(36).toString('base64url'):undefined;
try{
if(ssh)execFileSync('docker',['exec','-i',ssh.container,'chpasswd'],{input:`nativeZle:${password}\n`,stdio:['pipe','ignore','pipe']});
const initialized=await run('initialize',[...initialization,...(ssh?['--native-input-p2-credential','provision']:[])],ssh?{reference:environment.SHELLSPAN_P2_CREDENTIAL_REFERENCE,password}:undefined);password=undefined;assert.equal(initialized,0,'Actual isolated backend initialization failed');
const database=new DatabaseSync(resolve(directory,'data/shellspan-main.db'));
database.exec('BEGIN');const empty=database.prepare("SELECT value FROM preferences WHERE key='llm.routes.v1'").get();assert.equal(JSON.parse(empty.value).routes.length,0);
database.prepare("UPDATE preferences SET value=? WHERE key='llm.routes.v1'").run(JSON.stringify(routes));database.exec('COMMIT');database.close();
const selection=routes.defaultSelection;assert(selection?.routeId&&selection?.modelId);
const code=await run('application',[fixture==='contention'?'--terminal-contention':'--native-jobs',...(fixture==='interactive'?['--native-input-p2-interactive-fresh']:['cancel','submit-fault'].includes(fixture)?['--native-input-p3-cancel',...(fixture==='submit-fault'?['--native-input-p3-submit-fault']:[])]:[]),...(ssh?['--native-input-p2','--native-input-p2-ssh-fixture',sshFixturePath]:[]),'--native-input-p3','zsh','--data-scope','com.shellspan.validation.native-input-p3','--route',selection.routeId,'--model',selection.modelId,...(process.env.SHELLSPAN_P3_BACKPRESSURE==='1'?['--native-input-p3-backpressure']:[]),...(process.env.SHELLSPAN_P3_REVIEW==='1'?['--native-input-p3-review']:[])]);
if(submittedProgramSha256){
 assert.equal(createHash('sha256').update(readFileSync(resolve(directory,'home/p3-stop-target'))).digest('hex'),submittedProgramSha256);
 if(code===0){
  assert.equal(readFileSync(resolve(directory,'home/p3-stop-entries'),'utf8'),'X','Actual target replayed after the final frontend report');
  const target=JSON.parse(readFileSync(resolve(directory,'home/p3-stop-process.json'),'utf8'));
  for(const pid of[target.pid,-target.group]){assert(Number.isSafeInteger(pid)&&Math.abs(pid)>1);let gone=false;try{process.kill(pid,0);}catch(error){if(error.code==='ESRCH')gone=true;else throw error;}assert(gone,'Actual old process/group remained after application exit');}
  const ledger=new DatabaseSync(resolve(directory,'data/terminal-submissions/intentions.sqlite'),{readOnly:true});
  const counts=ledger.prepare('SELECT count(*) AS total,sum(settled) AS settled FROM submissions').get();ledger.close();
  writeFileSync(resolve(directory,'submission-fence-counts.json'),JSON.stringify(counts,null,2));assert.equal(counts.total,1);assert.equal(counts.settled,0);
 }
}
const after=captureValidationSources(root);writeFileSync(resolve(directory,'sources-after.json'),JSON.stringify(after,null,2));
assert.deepEqual(after,sources,'Immutable source copy changed during actual application acceptance');
writeFileSync(resolve(directory,'result.json'),JSON.stringify({exitCode:code,selection,sourceCount:Object.keys(sources).length},null,2));
console.log(JSON.stringify({directory,exitCode:code}));process.exitCode=code;
}finally{
 password=undefined;
 if(ssh){
  execFileSync('docker',['exec',ssh.container,'usermod','-L','nativeZle'],{stdio:'pipe'});
  let cleanup;
  try{cleanup=await run('credential-cleanup',[...initialization,'--native-input-p2-credential','cleanup'],{reference:environment.SHELLSPAN_P2_CREDENTIAL_REFERENCE});}
  finally{
   const label=execFileSync('docker',['inspect','--format','{{index .Config.Labels "shellspan.native-input-p2"}}',ssh.container],{encoding:'utf8'}).trim();assert.equal(ssh.container,`shellspan-nip-p2-${label}`);
   execFileSync('docker',['stop','--timeout','5',ssh.container],{stdio:'pipe'});
   assert.equal(execFileSync('docker',['inspect','--format','{{.State.Running}}',ssh.container],{encoding:'utf8'}).trim(),'false');
  }
  writeFileSync(resolve(directory,'ssh-cleanup.json'),JSON.stringify({container:ssh.container,accountLocked:true,credentialDeletedAndAbsent:cleanup===0,credentialReference:environment.SHELLSPAN_P2_CREDENTIAL_REFERENCE,stopped:true,retained:true},null,2));
  assert.equal(cleanup,0,'Actual owned SSH credential cleanup failed');
 }
}
