import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
const owner=resolve(import.meta.dirname,'../..'),id=randomUUID();
const directory=resolve(owner,'.artifacts/tests/native-input-p3/credential-stage',id);mkdirSync(directory,{recursive:true,mode:0o700});
const paths=['.gitignore','scripts/verify-ai-session-stream.mjs','scripts/native-input-p2/frozen-validation.mjs','scripts/native-input-p3/desktop-evidence.mjs','scripts/native-input-p3/windows-source-revision.mjs','scripts/native-input-p3/windows-cargo-runner.mjs','src-tauri/src/terminal_command/windows.rs','src-tauri/src/terminal_integration.rs','src-tauri/resources/powershell/PSReadLine/2.4.5/netstd/Microsoft.PowerShell.PSReadLine.Polyfiller.dll','src-tauri/resources/powershell/PSReadLine/2.4.5/net6plus/Microsoft.PowerShell.PSReadLine.Polyfiller.dll','src-tauri/native-input-editors/psreadline.ps1','src-tauri/native-input-editors/examples/windows_acceptance.rs',
 'scripts/native-input-p3/credential-channel.mjs','scripts/native-input-p3/credential-relay.mjs','scripts/native-input-p3/credential-ownership.mjs','scripts/native-input-p3/credential-cleanup/Cargo.toml','scripts/native-input-p3/credential-cleanup/Cargo.lock','scripts/native-input-p3/credential-cleanup/src/main.rs','scripts/native-input-p3/windows-credential-worker.ps1','scripts/native-input-p3/windows-credential-quiesce.ps1','src-tauri/native-input-editors/src/ffi.rs',
 'src/components/terminal/__tests__/native-input-p3-credential.ts','src/components/terminal/__tests__/native-data-initialize.native.ts','src/components/terminal/__tests__/native-jobs.native.tsx','src/components/terminal/__tests__/native-input-p3-startup.native.html','src/components/terminal/__tests__/native-input-p3-startup.native.ts'];
paths.push('src-tauri/src/terminal_command/journal.rs','src-tauri/src/agent_runtime/scratch.rs','src-tauri/src/agent_runtime/scratch_storage.rs','src-tauri/src/agent_runtime/tests/scratch.rs');
paths.push('scripts/native-input-p2/gui-lock.mjs','scripts/native-input-p3/focus-trace-channel.mjs','src/components/terminal/__tests__/native-focus-trace.ts');
const sources=()=>Object.fromEntries(paths.map(path=>[path,createHash('sha256').update(readFileSync(resolve(owner,path))).digest('hex')]));const before=sources();
writeFileSync(resolve(directory,'files.list'),paths.join('\0')+'\0');writeFileSync(resolve(directory,'sources.json'),JSON.stringify(before,null,2));
execFileSync('tar',['-czf',resolve(directory,'overrides.tar.gz'),'--null','-T',resolve(directory,'files.list')],{cwd:owner,env:{...process.env,COPYFILE_DISABLE:'1'}});assert.deepEqual(sources(),before);
const ssh=['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','HostKeyAlias=100.64.0.254','-o','ConnectTimeout=8'],peer='zhengbiwen@100.64.0.82';
const overrides=`D:/Developer/ShellSpan-native-input-p3-credential-overrides-${id}`;
execFileSync('ssh',[...ssh,peer,`powershell -NoLogo -NoProfile -Command "if(Test-Path '${overrides}'){throw 'Owned override path exists'}; New-Item -ItemType Directory '${overrides}'|Out-Null"`],{stdio:'inherit',timeout:20000});
execFileSync('scp',[...ssh,resolve(directory,'overrides.tar.gz'),`${peer}:${overrides}/overrides.tar.gz`],{stdio:'inherit',timeout:60000});
const base=process.argv[2]??'D:/Developer/ShellSpan-native-input-p3-app-222af3ab-56b6-4a85-99af-1e7c7d3b6f58';assert(/^D:\/Developer\/ShellSpan-native-input-p3-app-[a-f0-9-]{36}$/.test(base));
const output=execFileSync('ssh',[...ssh,peer,`powershell -NoLogo -NoProfile -Command "tar -xzf '${overrides}/overrides.tar.gz' -C '${overrides}'; if($LASTEXITCODE -ne 0){throw 'Override extraction failed'}; node '${overrides}/scripts/native-input-p3/windows-source-revision.mjs' '${base}' '${overrides}'; exit $LASTEXITCODE"`],{encoding:'utf8',timeout:120000,maxBuffer:1024*1024});
writeFileSync(resolve(directory,'revision.log'),output);const revision=JSON.parse(output.trim().split(/\r?\n/).at(-1));
writeFileSync(resolve(directory,'fixture.json'),JSON.stringify({...revision,directory,peer,ssh,overrides},null,2));console.log(JSON.stringify({...revision,directory}));
