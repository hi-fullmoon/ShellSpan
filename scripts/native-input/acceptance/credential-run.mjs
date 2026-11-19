// All cross-machine orchestration values are metadata. Key bytes stay in the
// native getter -> loopback -> pinned SSH stdin -> normal native save path.
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,openSync,closeSync} from 'node:fs';
import {resolve} from 'node:path';
import {assertNativeGuiAllowed} from '../integration/gui-lock.mjs';
assertNativeGuiAllowed();
const owner=resolve(import.meta.dirname,'../../..');
const [windowsFixture,macRoot]=process.argv.slice(2);
const fixture=JSON.parse(readFileSync(windowsFixture,'utf8'));
const remoteRoot=fixture.root.replaceAll('\\','/');assert(/^D:\/Developer\/ShellSpan-native-input-p3-app-[a-f0-9-]{36}$/.test(remoteRoot));
const runId=randomUUID(),directory=resolve(owner,'artifacts/tests/native-input-p3/credential-runs',runId);mkdirSync(directory,{recursive:true,mode:0o700});
const ssh=['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','HostKeyAlias=100.64.0.254','-o','ConnectTimeout=8'],peer='zhengbiwen@100.64.0.82';
const evidence=`${remoteRoot}/artifacts/tests/native-input-p2/credential-${runId}`;
function command(script,timeout=20000){return execFileSync('ssh',[...ssh,peer,`D:/Programs/PowerShell/7/pwsh.exe -NoLogo -NoProfile -NonInteractive -OutputFormat Text -EncodedCommand ${Buffer.from("$ProgressPreference='SilentlyContinue'; "+script,'utf16le').toString('base64')}`],{encoding:'utf8',timeout,maxBuffer:1024*1024});}
function readRemote(path){const result=command(`if(Test-Path -LiteralPath '${path}'){Get-Content -LiteralPath '${path}' -Raw}else{'null'}`);return JSON.parse(result.replace(/^\uFEFF/,'').trim());}
async function localPhase(action,input){const file=resolve(directory,`${action}-input.json`);writeFileSync(file,JSON.stringify(input),{flag:'wx',mode:0o600});const fd=openSync(resolve(directory,`${action}.log`),'wx',0o600);try{const child=spawn(process.execPath,[resolve(macRoot,'scripts/native-input/acceptance/credential-source.mjs'),action,file],{cwd:macRoot,env:{...process.env,CARGO_INCREMENTAL:'0',SHELLSPAN_P3_BUILD_CACHE:resolve(owner,'artifacts/tests/native-input-p3/acceptance-source/5993b372-11e5-4b26-b087-059112cea357/ShellSpan/artifacts/tests/native-input-p2/frozen-target')},stdio:['ignore',fd,fd]});const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});assert.equal(code,0,`Actual native ${action} failed; inspect metadata-only phase log`);}finally{closeSync(fd);}}
function startTask(configuration,name){
 const config=resolve(directory,`${name}-config.json`),remoteConfig=`${remoteRoot}/artifacts/tests/native-input-p3/${name}-${runId}.json`;
 writeFileSync(config,JSON.stringify(configuration,null,2));execFileSync('scp',[...ssh,config,`${peer}:${remoteConfig}`],{stdio:'pipe',timeout:20000});
 const fd=openSync(resolve(directory,`${name}-worker.log`),'wx',0o600);
 const child=spawn('ssh',[...ssh,peer,`powershell -NoLogo -NoProfile -NonInteractive -File ${remoteRoot}/scripts/fixtures/windows-desktop-session.ps1 -Workspace ${remoteRoot} -Worker ${remoteRoot}/scripts/native-input/acceptance/windows-credential-worker.ps1 -EvidenceDirectory ${configuration.evidenceDirectory} -Config ${remoteConfig}`],{stdio:['ignore',fd,fd]});
 const completed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>{closeSync(fd);resolve(code);});});return{child,completed,remoteConfig};
}
const config={runId,workspace:remoteRoot,evidenceDirectory:evidence,routeDatabase:'C:/Users/zhengbiwen/.shellspan/shellspan-main.db',opensslDirectory:'D:/Developer/ShellSpan-native-terminal-20261023/dependency-cache/openssl-3.6.3-msvc-x64',cargoTargetDirectory:'D:/Developer/ShellSpan-native-input-p3-app-aba582e7-d273-46d0-82f2-5840b462366e/artifacts/tests/native-input-p2/frozen-target'};
writeFileSync(resolve(directory,'run.json'),JSON.stringify({runId,remoteRoot,evidence,macRoot},null,2));
let started,workerResult;
try{
 await localPhase('prepare',{runId});
 const prepared=JSON.parse(readFileSync(resolve(directory,'prepare.log'),'utf8').trim().split(/\r?\n/).at(-1));assert(prepared.runId===runId);
 console.log(JSON.stringify({stage:'source-route-prepared',runId,sourceDirectory:prepared.sourceDirectory}));
 started=startTask(config,'acceptance');let ready;const deadline=Date.now()+15*60000;
 while(!ready){workerResult=readRemote(`${evidence}/worker-result.json`);assert(!workerResult,'Destination ended before its normal credential receiver became ready');ready=readRemote(`${evidence}/provision/credential-receiver-ready.json`);if(!ready){assert(Date.now()<deadline,'Destination readiness deadline exceeded');await new Promise(resolve=>setTimeout(resolve,1000));}}
 assert(ready.runId===runId&&ready.port===1432);console.log(JSON.stringify({stage:'destination-native-api-ready',runId}));
 await localPhase('export',{...prepared,destination:{host:'100.64.0.82',user:'zhengbiwen',port:1432,validationNonce:ready.validationNonce,remoteRoot}});
 console.log(JSON.stringify({stage:'normal-native-save-confirmed',runId}));
 const exit=await started.completed;workerResult=readRemote(`${evidence}/worker-result.json`);assert(workerResult?.credentialCleanupVerified,'Owned credential final cleanup is not verified');
 writeFileSync(resolve(directory,'worker-result.json'),JSON.stringify(workerResult,null,2));assert.equal(exit,0,'Actual Windows model acceptance failed');assert(workerResult.ok);
}finally{
 if(started){
  if(started.child.exitCode===null)await started.completed;
  // Parent SSH exit is not a writer-exit receipt. Ask the original worker to
  // cancel only its own CLI tree, then require actual process-exit proof before
  // recovering a credential whose normal save might otherwise still be active.
  command(`& '${remoteRoot}/scripts/native-input/acceptance/windows-credential-quiesce.ps1' -Config '${started.remoteConfig}'; if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}`,200000);
  workerResult=readRemote(`${evidence}/worker-result.json`);
  if(!workerResult?.credentialCleanupVerified){
   const recoveryConfig={...config,recoveryOnly:true,provisionDirectory:`${evidence}/provision`,evidenceDirectory:`${remoteRoot}/artifacts/tests/native-input-p2/credential-recovery-${runId}`};
   const recovery=startTask(recoveryConfig,'recovery');const exit=await recovery.completed;
   const recovered=readRemote(`${recoveryConfig.evidenceDirectory}/worker-result.json`);writeFileSync(resolve(directory,'recovery-result.json'),JSON.stringify(recovered,null,2));assert.equal(exit,0);assert(recovered?.credentialCleanupVerified,'Recovery did not verify owned credential cleanup');
  }
  writeFileSync(resolve(directory,'final.json'),JSON.stringify({runId,workerResult,directory},null,2));
 }
}
console.log(JSON.stringify({runId,directory,ok:true}));
