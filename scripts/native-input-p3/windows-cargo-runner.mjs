import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {copyFile,mkdtemp,readFile,rm} from 'node:fs/promises';
import {resolve,dirname,join,isAbsolute} from 'node:path';
import {createInterface} from 'node:readline';
import {verifyFrozenValidation,writeFrozenCheckpoint} from '../native-input-p2/frozen-validation.mjs';

assert.equal(process.platform,'win32');
const args=process.argv.slice(2);assert.equal(args[0],'run');
const manifest=process.env.SHELLSPAN_ACCEPTANCE_FROZEN_MANIFEST;
const evidence=process.env.SHELLSPAN_ACCEPTANCE_EVIDENCE_DIR;
const recordId=`${process.pid}-${randomUUID()}`;
assert(manifest&&evidence&&isAbsolute(evidence)&&resolve(evidence,'data')===resolve(process.env.SHELLSPAN_DATA_DIR));
const check=stage=>{const value=verifyFrozenValidation(manifest,stage);writeFrozenCheckpoint(join(evidence,`frozen-runner-${recordId}-${stage}.json`),value);return value;};
const hash=async path=>createHash('sha256').update(await readFile(path)).digest('hex');
const separator=args.indexOf('--');const buildArgs=args.slice(1,separator<0?undefined:separator);
const applicationArgs=separator<0?[]:args.slice(separator+1);
check('before-native-build');
const build=spawn(process.env.CARGO||'cargo',['build',...buildArgs,'--message-format=json-render-diagnostics'],{stdio:['ignore','pipe','inherit']});
const completed=new Promise((resolve,reject)=>{build.once('error',reject);build.once('exit',code=>resolve(code));});
let executable;
for await(const line of createInterface({input:build.stdout})){
  if(!line.trim())continue;
  const event=JSON.parse(line);
  if(event.reason==='compiler-message'&&event.message.rendered)process.stderr.write(event.message.rendered);
  if(event.reason==='compiler-artifact'&&event.executable&&event.target.kind.includes('bin')){
    assert.equal(resolve(event.target.src_path),resolve(import.meta.dirname,'../../src-tauri/src/main.rs'));
    assert(!executable||executable===event.executable,'Select one actual Windows application');executable=event.executable;
  }
}
assert.equal(await completed,0,'Actual Windows native compilation failed');assert(executable);
check('after-native-build');
const image=await mkdtemp(join(evidence,'native-image-'));
let application,exited;
try{
  const binary=join(image,'ShellSpan.exe');await copyFile(executable,binary);
  const binarySha256=await hash(binary);assert.equal(binarySha256,await hash(executable));
  const frozenInputs=check('before-native-launch');
  application=spawn(binary,applicationArgs,{stdio:'inherit'});
  exited=new Promise((resolve,reject)=>{application.once('error',reject);application.once('exit',code=>resolve(code));});
  const metadata=JSON.parse(execFileSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',resolve(import.meta.dirname,'windows-image.ps1'),
    '-Action','Inspect','-ApplicationPid',String(application.pid),'-RunnerPid',String(process.pid),'-Executable',binary],{encoding:'utf8'}));
  assert.equal(metadata.sha256,binarySha256);
  writeFrozenCheckpoint(join(evidence,`native-image-${recordId}.json`),{frozenManifest:manifest,binarySha256,frozenInputs,metadata,
    tauriConfigSha256:createHash('sha256').update(process.env.TAURI_CONFIG??'').digest('hex')});
  writeFrozenCheckpoint(join(evidence,`native-image-${recordId}-process.json`),{frozenManifest:manifest,runnerPid:process.pid,appPid:application.pid,executable:binary});
  const exitCode=await exited;
  let verified=false,failure;
  try{check('after-native-exit');assert.equal(await hash(binary),binarySha256,'Actual Windows PE image changed during execution');verified=true;}
  catch(error){failure=String(error);}
  writeFrozenCheckpoint(join(evidence,`native-image-${recordId}-end.json`),{frozenManifest:manifest,binarySha256,exitCode,verified,failure});
  assert(verified,failure);process.exitCode=exitCode??1;
}finally{
  if(application&&application.exitCode===null&&application.signalCode===null){
    execFileSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',resolve(import.meta.dirname,'windows-image.ps1'),
      '-Action','Stop','-ApplicationPid',String(application.pid),'-RunnerPid',String(process.pid),'-Executable',join(image,'ShellSpan.exe')],{stdio:'pipe',timeout:20000});await exited;
  }
  await rm(image,{recursive:true,force:true});
}
