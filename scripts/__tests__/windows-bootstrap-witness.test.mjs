import fs from 'node:fs';import p from 'node:path';import {createHash} from 'node:crypto';import {expect,it} from 'vitest';
import {windowsBootstrapWitness} from '../native-input-p3/windows-bootstrap-witness.mjs';
import {boundedWitnessFailure,recordWitnessFailure} from '../native-input-p3/windows-witness-diagnostic.mjs';
import {spawn} from 'node:child_process';
const parent=p.resolve(import.meta.dirname,'../../.artifacts/tests/windows-bootstrap-witness');
function fixture(check){fs.mkdirSync(parent,{recursive:true});const root=fs.mkdtempSync(p.join(parent,'test-'));try{check(root);}finally{const relative=p.relative(parent,root);if(!relative||relative.startsWith('..')||p.isAbsolute(relative))throw Error('Unsafe fixture cleanup');fs.rmSync(root,{recursive:true,force:true});}}
it('reads only owned native directories and notices the actual last directory removal',()=>fixture(root=>{
 expect(windowsBootstrapWitness(root)).toEqual({bootstraps:[]});const native=p.join(root,'tmp/shellspan-nip-owned');fs.mkdirSync(native,{recursive:true});fs.mkdirSync(p.join(root,'tmp/other'));fs.writeFileSync(p.join(native,'shellspan_native_input_editors.dll'),'filesystem witness fixture,not native code');fs.writeFileSync(p.join(native,'startup.ps1'),'owned fixture');const witness=windowsBootstrapWitness(root);expect(witness.bootstraps).toHaveLength(1);expect(witness.bootstraps[0].librarySha256).toBe(createHash('sha256').update('filesystem witness fixture,not native code').digest('hex'));fs.unlinkSync(p.join(native,'shellspan_native_input_editors.dll'));expect(windowsBootstrapWitness(root).bootstraps[0].files).toEqual(['startup.ps1']);fs.unlinkSync(p.join(native,'startup.ps1'));fs.rmdirSync(native);expect(windowsBootstrapWitness(root)).toEqual({bootstraps:[]});
}));
it('refuses a native directory junction instead of following it',()=>fixture(root=>{
 const target=p.join(root,'target'),tmp=p.join(root,'tmp');fs.mkdirSync(target);fs.mkdirSync(tmp);fs.symlinkSync(target,p.join(tmp,'shellspan-nip-linked'),'junction');expect(()=>windowsBootstrapWitness(root)).toThrow('real directory');
}));
it('observes changes to retained non-DLL resources without logging their contents',()=>fixture(root=>{
 const native=p.join(root,'tmp/shellspan-nip-owned');fs.mkdirSync(native,{recursive:true});const startup=p.join(native,'startup.ps1');fs.writeFileSync(startup,'original fixture');const before=windowsBootstrapWitness(root).bootstraps[0];fs.writeFileSync(startup,'modified fixture');const after=windowsBootstrapWitness(root).bootstraps[0];expect(after.files).toEqual(before.files);expect(after.fileHashes['startup.ps1']).not.toBe(before.fileHashes['startup.ps1']);expect(JSON.stringify(after)).not.toContain('modified fixture');
}));
it('records only bounded diagnostic fields,never arbitrary error messages',()=>{
 const value=boundedWitnessFailure('running-stop','bootstrap-witness',{code:'EACCES',witnessStage:'resource-hash',message:'private pipe/token/file-content fixture'});expect(value).toMatchObject({kind:'running-stop',stage:'resource-hash',code:'EACCES',observationAvailable:false});expect(JSON.stringify(value)).not.toContain('private');expect(boundedWitnessFailure('bad/value','stage',{code:'unbounded secret value'}).code).toBe('unknown');
});
it.skipIf(process.platform!=='win32')('a real Windows sharing lock makes observation fail and writes immutable diagnostics',async()=>{
 fs.mkdirSync(parent,{recursive:true});const root=fs.mkdtempSync(p.join(parent,'lock-')),native=p.join(root,'tmp/shellspan-nip-owned');fs.mkdirSync(native,{recursive:true});const resource=p.join(native,'shellspan_native_input_editors.dll'),ready=p.join(root,'ready'),release=p.join(root,'release');fs.writeFileSync(resource,'file-sharing fixture,not native code');const quote=value=>"'"+value.replaceAll("'","''")+"'";
 const script=`$ErrorActionPreference='Stop';$f=[IO.File]::Open(${quote(resource)},[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None);try{[IO.File]::WriteAllText(${quote(ready)},'ready');$until=[DateTime]::UtcNow.AddSeconds(10);while(-not [IO.File]::Exists(${quote(release)})-and[DateTime]::UtcNow-lt$until){Start-Sleep -Milliseconds 10}}finally{$f.Dispose()}`;
 const child=spawn(p.join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:'ignore'}),done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)});
 try{
  const end=Date.now()+5000;while(!fs.existsSync(ready)){expect(Date.now(), 'Lock-holder did not become ready').toBeLessThan(end);await new Promise(resolve=>setTimeout(resolve,20));}
  let failure;try{windowsBootstrapWitness(root);}catch(error){failure=error;}expect(failure,'A real sharing lock must not look like an empty directory').toBeTruthy();expect(['resource-hash','module-hash']).toContain(failure.witnessStage);expect(['EACCES','EPERM','EBUSY']).toContain(failure.code);const first=await recordWitnessFailure(root,'unit-sharing-lock','bootstrap-witness',failure),second=await recordWitnessFailure(root,'unit-sharing-lock','bootstrap-witness',failure);expect(first.observationAvailable).toBe(false);expect(second.observationAvailable).toBe(false);expect(fs.readdirSync(root).filter(n=>n.startsWith('native-witness-failure-'))).toHaveLength(2);fs.writeFileSync(release,'release');expect(await done).toBe(0);expect(windowsBootstrapWitness(root).bootstraps).toHaveLength(1);
 }finally{
  if(child.exitCode===null&&child.signalCode===null){fs.writeFileSync(release,'release');await done;}const relative=p.relative(parent,root);if(!relative||relative.startsWith('..')||p.isAbsolute(relative))throw Error('Unsafe fixture cleanup');fs.rmSync(root,{recursive:true,force:true});
 }
});
