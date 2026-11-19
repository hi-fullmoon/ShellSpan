import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {expect,it} from 'vitest';
const root=path.resolve(import.meta.dirname,'../..'),run=promisify(execFile),cli=path.join(root,'scripts/verification/agent/verify-ai-session-stream.mjs'),evidence=path.join(root,'artifacts/tests/native-input-p2/job-selection-negative-only'),env={...process.env,SHELLSPAN_ALLOW_FOREGROUND_TESTS:'1',SHELLSPAN_LOCAL_SHELL:'D:/Programs/PowerShell/7/pwsh.exe',SHELLSPAN_ACCEPTANCE_EVIDENCE_DIR:evidence,SHELLSPAN_DATA_DIR:path.join(evidence,'data'),SHELLSPAN_LOCAL_HOME:path.join(evidence,'home')};
it.skipIf(process.platform!=='win32').each([
 ['native-input-p3-job-lifecycle',[]],
 ['native-input-p3-job-stdin',[]],
 ['native-input-p3-job-descendant',[]],
 ['native-input-p3-job-completion',['0']],
 ['native-input-p3-job-ownership',['wait']],
 ['native-input-p3-job-retired',['kill']],
].flatMap(([option,value])=>['unowned-home','no-model'].map(mode=>[option,value,mode])))('keeps original owned real-model job gates with explicit selection: %s/%j/%s',async(option,value,mode)=>{
 const args=[cli,'--'+option,...value,'--native-jobs','--native-jobs-powershell','powerShell7','--native-input-p3','powerShell7','--data-scope','com.shellspan.validation.native-input-p3','--route','existing-route','--model','second-model',...(mode==='no-model'?['--no-model']:[])];
 const result=await run(process.execPath,args,{cwd:root,env:{...env,...mode==='unowned-home'?{SHELLSPAN_LOCAL_HOME:path.join(evidence,'other-home')}:{}},timeout:15000}).then(()=>null,error=>error);
 expect(result).not.toBeNull();expect(result.code).toBe(1);expect(result.stderr).toContain('--'+option+' requires');expect(result.stdout).not.toContain('Running DevCommand');
},20000);
it.skipIf(process.platform!=='win32')('requires the original ownership case for exact cached-handle wording',async()=>{
 const result=await run(process.execPath,[cli,'--native-input-p3-job-ownership-exact-goal'],{cwd:root,env,timeout:15000}).then(()=>null,error=>error);
 expect(result).not.toBeNull();expect(result.code).toBe(1);expect(result.stderr).toContain('requires the original isolated ownership case');expect(result.stdout).not.toContain('Running DevCommand');
},20000);
it.skipIf(process.platform!=='win32').each(['no-model','unowned-home'])('keeps original ownership isolation with exact goal wording: %s',async mode=>{
 const args=[cli,'--native-input-p3-job-ownership','wait','--native-input-p3-job-ownership-exact-goal','--native-jobs','--native-jobs-powershell','powerShell7','--native-input-p3','powerShell7','--data-scope','com.shellspan.validation.native-input-p3','--route','existing-route','--model','second-model',...(mode==='no-model'?['--no-model']:[])];
 const result=await run(process.execPath,args,{cwd:root,env:{...env,...mode==='unowned-home'?{SHELLSPAN_LOCAL_HOME:path.join(evidence,'other-home')}:{}},timeout:15000}).then(()=>null,error=>error);
 expect(result).not.toBeNull();expect(result.code).toBe(1);expect(result.stderr).toContain('--native-input-p3-job-ownership requires');expect(result.stdout).not.toContain('Running DevCommand');
},20000);
