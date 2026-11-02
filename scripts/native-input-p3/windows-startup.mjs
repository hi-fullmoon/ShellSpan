import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {assertNativeGuiAllowed} from '../native-input-p2/gui-lock.mjs';
assertNativeGuiAllowed();
const owner=resolve(import.meta.dirname,'../..'),fixture=JSON.parse(readFileSync(process.argv[2],'utf8'));
const family=process.argv[3];assert(['windowsPowerShell','powerShell7'].includes(family));
const root=fixture.root.replaceAll('\\','/'),runId=randomUUID();const directory=resolve(owner,'.artifacts/tests/native-input-p3/windows-startup',runId);mkdirSync(directory,{recursive:true});
const evidence=`${root}/.artifacts/tests/native-input-p2/startup-${runId}`,configFile=`${root}/.artifacts/tests/native-input-p3/startup-${runId}.json`;
const configuration={runId,workspace:root,evidenceDirectory:evidence,startupOnly:true,startupDiagnostics:true,shellKinds:[family],routeDatabase:'C:/Users/zhengbiwen/.shellspan/shellspan-main.db',opensslDirectory:'D:/Developer/ShellSpan-native-terminal-20261023/dependency-cache/openssl-3.6.3-msvc-x64',cargoTargetDirectory:'D:/Developer/ShellSpan-native-input-p3-app-aba582e7-d273-46d0-82f2-5840b462366e/.artifacts/tests/native-input-p2/frozen-target'};
writeFileSync(resolve(directory,'configuration.json'),JSON.stringify(configuration,null,2));execFileSync('scp',[...fixture.ssh,resolve(directory,'configuration.json'),`${fixture.peer}:${configFile}`],{stdio:'pipe',timeout:20000});
let code=0;
try{const output=execFileSync('ssh',[...fixture.ssh,fixture.peer,`powershell -NoLogo -NoProfile -NonInteractive -File ${root}/scripts/fixtures/windows-desktop-session.ps1 -Workspace ${root} -Worker ${root}/scripts/native-input-p3/windows-credential-worker.ps1 -EvidenceDirectory ${evidence} -Config ${configFile}`],{encoding:'utf8',timeout:12*60000,maxBuffer:1024*1024});writeFileSync(resolve(directory,'worker.log'),output);}catch(error){code=error.status??1;writeFileSync(resolve(directory,'worker.log'),String(error.stdout??'')+String(error.stderr??''));}
const phase=`${root}/.artifacts/tests/native-input-p2/${family==='windowsPowerShell'?'w51':'w7'}-${runId}`;
for(const[name,path]of[['worker-result.json',`${evidence}/worker-result.json`],['native-callbacks.json',`${phase}/data/native-callbacks.json`],['native-readline-failure.json',`${phase}/data/native-readline-failure.json`],['startup-evidence.json',`${phase}/native-webview-evidence.json`]]){
 try{execFileSync('scp',[...fixture.ssh,`${fixture.peer}:${path}`,resolve(directory,name)],{stdio:'pipe',timeout:20000});}catch{if(name==='worker-result.json')throw new Error('Actual startup worker result is unavailable');}
}
writeFileSync(resolve(directory,'result.json'),JSON.stringify({runId,directory,evidence,phase,family,exitCode:code,noModel:true,noCredentialRequested:true},null,2));console.log(JSON.stringify({directory,phase,exitCode:code}));process.exitCode=code;
