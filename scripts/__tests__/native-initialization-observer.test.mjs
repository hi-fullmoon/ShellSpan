import fs from 'node:fs';import p from 'node:path';import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readInitializationObserver} from '../native-input-p3/initialization-observer.mjs';
function fixture(){
 const token=randomUUID(),root=p.resolve(import.meta.dirname,'../../artifacts/tests/initialization-observer',token);fs.mkdirSync(root,{recursive:true});
 const manifest=p.join(root,'frozen-manifest-'+token+'.json'),name='native-image-101-'+token,exe=p.join(root,'native-image-component/ShellSpan.exe');
 const put=(name,value)=>fs.writeFileSync(p.join(root,name),JSON.stringify(value));
 const app={pid:202,runnerPid:101,path:exe,handleCreated:'2026-11-08T01:02:03.1234567Z',handleHeld:true,ended:false,sha256:'a'.repeat(64)};
 const observation=()=>({applications:[{...app}],failures:[],readOnly:true,inputInjected:false,terminationRequested:false});
 put(name+'-process.json',{appPid:202,runnerPid:101,executable:exe,frozenManifest:manifest});put(name+'.json',{frozenManifest:manifest,binarySha256:'a'.repeat(64)});
 return{root,token,manifest,name,put,observation};
}
it('keeps initialization pending until both independent observers hold the same actual App',async()=>{
 const f=fixture();expect(await readInitializationObserver(f.root,f.token,f.manifest)).toEqual({ready:false});
 f.put('os-identity-initialize.json',f.observation());expect(await readInitializationObserver(f.root,f.token,f.manifest)).toEqual({ready:false});
 f.put('os-modules-initialize.json',f.observation());expect(await readInitializationObserver(f.root,f.token,f.manifest)).toMatchObject({ready:true,token:f.token,appPid:202,observerKinds:['identity','modules'],readOnly:true,inputInjected:false,terminationRequested:false});
});
it('refuses mismatched held identity, image bytes, owner, ended process, or observer failure',async()=>{
 for(const change of ['creation','digest','owner','ended','failure']){
  const f=fixture(),fast=f.observation();f.put('os-identity-initialize.json',f.observation());
  if(change==='creation')fast.applications[0].handleCreated='2026-11-08T01:02:04.1234567Z';
  if(change==='digest')fast.applications[0].sha256='b'.repeat(64);
  if(change==='owner')fast.applications[0].runnerPid=303;
  if(change==='ended')fast.applications[0].ended=true;
  if(change==='failure')fast.failures=['actual observer failed'];
  f.put('os-modules-initialize.json',fast);await expect(readInitializationObserver(f.root,f.token,f.manifest)).rejects.toThrow();
 }
});
it('does not use a prior App manifest or partially published observation',async()=>{
 const f=fixture();f.put('os-identity-initialize.json',f.observation());f.put('os-modules-initialize.json',f.observation());
 expect(await readInitializationObserver(f.root,f.token,p.join(f.root,'foreign-manifest.json'))).toEqual({ready:false});
 fs.writeFileSync(p.join(f.root,'os-identity-initialize.json'),'{"applications":');
 expect(await readInitializationObserver(f.root,f.token,f.manifest)).toEqual({ready:false});
});
it('rejects standalone observed initialization before any App can start',async()=>{
 const cli=p.resolve(import.meta.dirname,'../verify-ai-session-stream.mjs');
 const result=await promisify(execFile)(process.execPath,[cli,'--native-input-p3-observed-initialize'],{timeout:15000,windowsHide:true,env:{...process.env,SHELLSPAN_ALLOW_FOREGROUND_TESTS:'1'}}).then(()=>null,error=>error);
 expect(result).not.toBeNull();expect(result.code).toBe(1);expect(result.stderr).toContain('Observed initialization requires one isolated Windows no-model initializer');expect(result.stdout).not.toContain('Running DevCommand');
});
