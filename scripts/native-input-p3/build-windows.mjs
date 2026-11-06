import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,copyFileSync,openSync,closeSync} from 'node:fs';
import {resolve,join,dirname,win32} from 'node:path';
import {parseArgs} from 'node:util';
import {selectWindowsProfiles} from './windows-profiles.mjs';
const {values}=parseArgs({options:{shell:{type:'string',multiple:true},'list-shells':{type:'boolean'}}});
const selected=selectWindowsProfiles(values.shell);
if(values['list-shells']){console.log(JSON.stringify({execution:false,fullMatrix:values.shell===undefined,profiles:selected}));process.exit(0);}
assert(process.platform==='win32'&&process.arch==='x64','Windows providers must be rebuilt on actual Windows x64');
const root=resolve(import.meta.dirname,'../..');
execFileSync(process.execPath,[resolve(root,'scripts/rebuild-psreadline.mjs'),'--verify-only'],{cwd:root,stdio:'pipe',windowsHide:true});
const resources=resolve(root,'.artifacts/tests/native-input-p2/resources/native-input');mkdirSync(resources,{recursive:true});
const directory=resolve(root,'.artifacts/tests/native-input-p3');mkdirSync(directory,{recursive:true});
const sha=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const conpty=resolve(root,'src-tauri/resources/conpty/1.25.260930003');
for(const [path,expected]of Object.entries(JSON.parse(readFileSync(resolve(conpty,'pin.json'),'utf8')).files))
  assert.equal(sha(resolve(conpty,path)),expected,'Private ConPTY differs from its reviewed pin');
const sourcePaths=['Cargo.toml','Cargo.lock','src/lib.rs','src/ffi.rs','zle.c','zle.zsh','psreadline.cs','psreadline.ps1'].map(path=>`src-tauri/native-input-editors/${path}`);
sourcePaths.push('src-tauri/src/terminal_command/protocol.rs','src-tauri/src/terminal_jobs.rs','src-tauri/src/terminal_jobs.ps1','src-tauri/src/terminal_job_host.cs','src-tauri/src/terminal_console_signals.cs');
sourcePaths.push('src-tauri/resources/powershell/PSReadLine/2.4.5/ShellSpan.Build.json');
sourcePaths.push('src-tauri/resources/conpty/1.25.260930003/pin.json');
const sources=Object.fromEntries(sourcePaths.map(path=>[path,sha(resolve(root,path))]));
const log=openSync(resolve(directory,'windows-producer-build.log'),'a');
try{execFileSync('cargo',['build','--locked','--release','--lib','--manifest-path','src-tauri/native-input-editors/Cargo.toml'],{cwd:root,env:{...process.env,RUSTUP_TOOLCHAIN:'1.95.0-x86_64-pc-windows-msvc'},stdio:['ignore',log,log]});}finally{closeSync(log);}
for(const[path,expected]of Object.entries(sources))assert.equal(sha(resolve(root,path)),expected,'Producer source drifted during build');
const library=resolve(root,'src-tauri/native-input-editors/target/release/shellspan_native_input_editors.dll');
const powershell=join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
const pwsh=execFileSync(powershell,['-NoLogo','-NoProfile','-Command','(Get-Command pwsh.exe -ErrorAction Stop).Source'],{encoding:'utf8',windowsHide:true}).trim();
const expectedEditor=sha(resolve(root,'src-tauri/resources/powershell/PSReadLine/2.4.5/Microsoft.PowerShell.PSReadLine.dll'));
const profiles=[];
for(const{shell,expectedVersion}of selected){
  const executable=shell==='windowsPowerShell'?powershell:pwsh;
  const environment={...process.env};
  environment.PSModulePath=[win32.normalize(resolve(root,'src-tauri/resources/powershell')),win32.normalize(join(dirname(executable),'Modules')),environment.PSModulePath??''].filter(Boolean).join(';');
  const actual=JSON.parse(execFileSync(executable,['-NoLogo','-NoProfile','-Command',"Import-Module PSReadLine -ErrorAction Stop; $m=Get-Module PSReadLine; $a=[Microsoft.PowerShell.PSConsoleReadLine].Assembly; @{engine=$PSVersionTable.PSVersion.ToString();editor=$m.Version.ToString();assembly=$a.Location}|ConvertTo-Json -Compress"],{env:environment,encoding:'utf8',windowsHide:true}).trim());
  assert.equal(actual.engine,expectedVersion);assert.equal(actual.editor,'2.4.5');assert.equal(sha(actual.assembly),expectedEditor,'Loaded provider differs from the reviewed shellspan1 assembly');
  const id=`${shell==='windowsPowerShell'?'windows-powershell':'powershell'}-${expectedVersion}-psreadline-2.4.5-shellspan1-conpty1.25.260930003-graphemes-windows-x64-native`;
  const profile={shell,shellVersion:actual.engine,editor:'psReadLine',editorVersion:actual.editor,editorNumericVersion:20405,adapterVersion:'1',verifiedProfileId:id};
  mkdirSync(resolve(resources,id),{recursive:true});copyFileSync(library,resolve(resources,id,'shellspan_native_input_editors.dll'));
  profiles.push({profile,shellSha256:sha(executable),moduleSha256:sha(library),module:`${id}/shellspan_native_input_editors.dll`,editorSha256:expectedEditor});
}
writeFileSync(resolve(resources,'editors-windows-x64.json'),JSON.stringify({version:1,profiles,sources},null,2)+'\n');
console.log(JSON.stringify({target:'windows-x64',fullMatrix:values.shell===undefined,profiles:profiles.map(p=>p.profile.verifiedProfileId)}));
