import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {expect,it} from 'vitest';
const root=path.resolve(import.meta.dirname,'../..'),run=promisify(execFile),cli=path.join(root,'scripts/verify-ai-session-stream.mjs'),evidence=path.join(root,'artifacts/tests/native-input-p2/history-selection-negative-only'),env={...process.env,SHELLSPAN_ALLOW_FOREGROUND_TESTS:'1',SHELLSPAN_ACCEPTANCE_EVIDENCE_DIR:evidence,SHELLSPAN_DATA_DIR:path.join(evidence,'data'),SHELLSPAN_LOCAL_HOME:path.join(evidence,'home')};
it.skipIf(process.platform!=='win32').each([
 ['native-input-p3-history-startup','unowned-home'],
 ['native-input-p3-history-lifecycle','unowned-home'],
 ['native-input-p3-history-startup','no-model'],
 ['native-input-p3-history-lifecycle','no-model'],
 ['native-input-p3-history-concurrent','unowned-home'],
 ['native-input-p3-history-concurrent','no-model'],
])('keeps the original owned real-model gate with explicit history selection: %s/%s',async(option,mode)=>{
 const args=[cli,'--'+option,'history-default','--native-jobs','--native-jobs-powershell','powerShell7','--native-input-p3','powerShell7','--data-scope','com.shellspan.validation.native-input-p3','--route','existing-route','--model','second-model',...(mode==='no-model'?['--no-model']:[])];
 const result=await run(process.execPath,args,{cwd:root,env:{...env,SHELLSPAN_LOCAL_SHELL:'D:/Programs/PowerShell/7/pwsh.exe',...mode==='unowned-home'?{SHELLSPAN_LOCAL_HOME:path.join(evidence,'other-home')}:{}},timeout:15000}).then(()=>null,error=>error);
 expect(result).not.toBeNull();expect(result.code).toBe(1);expect(result.stderr).toContain('requires one isolated real-model Windows history option case');expect(result.stdout).not.toContain('Running DevCommand');
},20000);
it.skipIf(process.platform!=='win32').each(['2','-1'])('refuses invalid history restart reader %s before starting an App',async reader=>{
 const result=await run(process.execPath,[cli,'--native-input-p3-history-reuse-reader='+reader],{cwd:root,env,timeout:15000}).then(()=>null,error=>error);
 expect(result).not.toBeNull();expect(result.code).toBe(1);expect(result.stderr).toContain('requires exact reader 0/1');expect(result.stdout).not.toContain('Running DevCommand');
},20000);
it.skipIf(process.platform!=='win32')('keeps no-model and unowned-home refusals for restart readers',async()=>{
 for(const mode of ['no-model','unowned-home']){
  const args=[cli,'--native-input-p3-history-lifecycle','history-default','--native-input-p3-history-reuse-reader','1','--native-jobs','--native-jobs-powershell','powerShell7','--native-input-p3','powerShell7','--data-scope','com.shellspan.validation.native-input-p3','--route','existing-route','--model','second-model',...(mode==='no-model'?['--no-model']:[])];
  const result=await run(process.execPath,args,{cwd:root,env:{...env,SHELLSPAN_LOCAL_SHELL:'D:/Programs/PowerShell/7/pwsh.exe',...mode==='unowned-home'?{SHELLSPAN_LOCAL_HOME:path.join(evidence,'other-home')}:{}},timeout:15000}).then(()=>null,error=>error);
  expect(result).not.toBeNull();expect(result.code).toBe(1);expect(result.stderr).toContain('requires one isolated real-model Windows history option case');expect(result.stdout).not.toContain('Running DevCommand');
 }
},40000);
it.skipIf(process.platform!=='win32')('rejects mixing concurrent readers with another history scenario before App startup',async()=>{
 const args=[cli,'--native-input-p3-history-concurrent','history-default','--native-input-p3-history-lifecycle','history-default'];
 const result=await run(process.execPath,args,{cwd:root,env,timeout:15000}).then(()=>null,error=>error);
 expect(result).not.toBeNull();expect(result.code).toBe(1);expect(result.stderr).toContain('Choose one isolated Windows history');expect(result.stdout).not.toContain('Running DevCommand');
},20000);
