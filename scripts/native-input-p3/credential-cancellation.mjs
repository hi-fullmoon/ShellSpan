// Real Session1 cancellation before any key is requested or delivered. This
// exercises the original receiver's process exit before recovery, not receipts.
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,openSync,closeSync} from 'node:fs';
import {resolve} from 'node:path';
const owner=resolve(import.meta.dirname,'../..'),fixture=JSON.parse(readFileSync(process.argv[2],'utf8'));
const root=fixture.root.replaceAll('\\','/'),runId=randomUUID();
const directory=resolve(owner,'.artifacts/tests/native-input-p3/credential-cancellation',runId);mkdirSync(directory,{recursive:true,mode:0o700});
const evidence=`${root}/.artifacts/tests/native-input-p2/credential-${runId}`,remoteConfig=`${root}/.artifacts/tests/native-input-p3/cancellation-${runId}.json`;
const configuration={runId,workspace:root,evidenceDirectory:evidence,shellKinds:['powerShell7'],routeDatabase:'C:/Users/zhengbiwen/.shellspan/shellspan-main.db',opensslDirectory:'D:/Developer/ShellSpan-native-terminal-20261023/dependency-cache/openssl-3.6.3-msvc-x64',cargoTargetDirectory:'D:/Developer/ShellSpan-native-input-p3-app-aba582e7-d273-46d0-82f2-5840b462366e/.artifacts/tests/native-input-p2/frozen-target'};
writeFileSync(resolve(directory,'configuration.json'),JSON.stringify(configuration,null,2));
execFileSync('scp',[...fixture.ssh,resolve(directory,'configuration.json'),`${fixture.peer}:${remoteConfig}`],{stdio:'pipe',timeout:20000});
function command(script,timeout=20000){return execFileSync('ssh',[...fixture.ssh,fixture.peer,'D:/Programs/PowerShell/7/pwsh.exe -NoLogo -NoProfile -NonInteractive -OutputFormat Text -EncodedCommand '+Buffer.from("$ProgressPreference='SilentlyContinue'; "+script,'utf16le').toString('base64')],{encoding:'utf8',timeout,maxBuffer:1024*1024});}
function read(path){return JSON.parse(command(`if(Test-Path '${path}'){Get-Content '${path}' -Raw}else{'null'}`).replace(/^\uFEFF/,''));}
const log=openSync(resolve(directory,'worker.log'),'wx',0o600);
const child=spawn('ssh',[...fixture.ssh,fixture.peer,`powershell -NoLogo -NoProfile -NonInteractive -File ${root}/scripts/fixtures/windows-desktop-session.ps1 -Workspace ${root} -Worker ${root}/scripts/native-input-p3/windows-credential-worker.ps1 -EvidenceDirectory ${evidence} -Config ${remoteConfig}`],{stdio:['ignore',log,log]});
const completed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>{closeSync(log);resolve(code);});});
let ready,proof;
try{
 const deadline=Date.now()+15*60000;
 while(!ready){const ended=read(`${evidence}/worker-result.json`);if(ended){writeFileSync(resolve(directory,'worker-result.json'),JSON.stringify(ended,null,2));assert.fail('Actual startup failed before the receiver; no credential was read');}ready=read(`${evidence}/provision/credential-receiver-ready.json`);if(!ready){assert(Date.now()<deadline);await new Promise(resolve=>setTimeout(resolve,1000));}}
 assert.equal(ready.runId,runId);console.log(JSON.stringify({stage:'actual-owned-receiver-ready',runId,noSecretRequested:true}));
}finally{
 const raw=command(`& '${root}/scripts/native-input-p3/windows-credential-quiesce.ps1' -Config '${remoteConfig}'; if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}`,200000);
 proof=JSON.parse(raw.trim());assert(proof.originalWriterExited&&proof.actualOwnedCliAndImagesExited);
 await completed;
 const worker=read(`${evidence}/worker-result.json`);const recovery=read(`${evidence}/provision/credential-recovery.json`);
 writeFileSync(resolve(directory,'result.json'),JSON.stringify({runId,directory,evidence,quiescence:proof,worker,recovery,noSecretRequested:true,harnessSha256:createHash('sha256').update(readFileSync(import.meta.filename)).digest('hex')},null,2));
 assert(worker?.credentialCleanupVerified&&worker.originalUserDataUnchanged);assert(!recovery||recovery.references.length===0);
}
assert(ready);console.log(JSON.stringify({directory,runId,ok:true,noSecretRequested:true,originalWritersExited:true}));
