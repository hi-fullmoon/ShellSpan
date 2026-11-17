import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,readdirSync,statSync,writeFileSync} from 'node:fs';
import {resolve,relative} from 'node:path';
const root=resolve(import.meta.dirname,'../..');
const id=randomUUID();const directory=resolve(root,'artifacts/tests/native-input-p3/windows',id);
mkdirSync(directory,{recursive:true,mode:0o700});
const destination=`D:/Developer/ShellSpan-native-input-p3-${id}`;
const ssh=['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','HostKeyAlias=100.64.0.254','-o','ConnectTimeout=8'];
const peer='zhengbiwen@100.64.0.82';
const paths=[];
function visit(path){
  for(const entry of readdirSync(resolve(root,path),{withFileTypes:true})){
    if(['target','__pycache__'].includes(entry.name))continue;
    const child=`${path}/${entry.name}`;
    assert(!entry.isSymbolicLink());
    if(entry.isDirectory())visit(child);else{assert(entry.isFile());paths.push(child);}
  }
}
for(const path of ['src-tauri/native-input-editors','src-tauri/vendor/portable-pty','src-tauri/resources/powershell/PSReadLine/2.4.5','scripts/native-input-p3'])visit(path);
paths.push('src-tauri/src/terminal_command/protocol.rs','src-tauri/src/terminal_command/capture.rs','src-tauri/src/terminal_jobs.ps1','src-tauri/src/terminal_job_host.cs','src-tauri/src/terminal_console_signals.cs','scripts/fixtures/windows-shell-history-metadata.ps1','rust-toolchain.toml');
const sources=Object.fromEntries(paths.sort().map(path=>[path,createHash('sha256').update(readFileSync(resolve(root,path))).digest('hex')]));
writeFileSync(resolve(directory,'files.list'),paths.join('\n')+'\n');
writeFileSync(resolve(directory,'sources.json'),JSON.stringify(sources,null,2));
execFileSync('tar',['-czf',resolve(directory,'source.tar.gz'),'-T',resolve(directory,'files.list')],{cwd:root});
execFileSync('ssh',[...ssh,peer,`powershell -NoLogo -NoProfile -Command "if(Test-Path -LiteralPath '${destination}'){throw 'Owned destination already exists'}; New-Item -ItemType Directory -Path '${destination}' | Out-Null"`],{stdio:'inherit'});
execFileSync('scp',[...ssh,resolve(directory,'source.tar.gz'),resolve(directory,'sources.json'),`${peer}:${destination}/`],{stdio:'inherit'});
execFileSync('ssh',[...ssh,peer,`powershell -NoLogo -NoProfile -Command "Set-Location '${destination}'; tar -xzf source.tar.gz; if($LASTEXITCODE -ne 0){throw 'Source extraction failed'}"`],{stdio:'inherit'});
writeFileSync(resolve(directory,'fixture.json'),JSON.stringify({id,directory,destination,peer,ssh,sourceCount:paths.length,archiveSha256:createHash('sha256').update(readFileSync(resolve(directory,'source.tar.gz'))).digest('hex')},null,2));
console.log(resolve(directory,'fixture.json'));
