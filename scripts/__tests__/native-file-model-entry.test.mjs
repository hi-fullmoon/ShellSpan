import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {expect,it} from 'vitest';
const root=path.resolve(import.meta.dirname,'../..'),run=promisify(execFile),cli=path.join(root,'scripts/verification/agent/verify-ai-session-stream.mjs'),evidence=path.join(root,'artifacts/tests/native-input/integration/file-selection-negative-only'),env={...process.env,SHELLSPAN_ALLOW_FOREGROUND_TESTS:'1',SHELLSPAN_ACCEPTANCE_EVIDENCE_DIR:evidence,SHELLSPAN_DATA_DIR:path.join(evidence,'data'),SHELLSPAN_LOCAL_HOME:path.join(evidence,'home')};
it.skipIf(process.platform!=='win32').each([
 ['native-input-p3-file-restart','prepare'],
 ['native-input-p3-file-restart','verify'],
 ['native-input-p3-file-fault','occupied-directory'],
 ['native-input-p3-file-fault','existing-file'],
].flatMap(([option,value])=>['no-model','mixed-case'].map(mode=>[option,value,mode])))('keeps original real-model/file-context gates with explicit selection: %s/%s/%s',async(option,value,mode)=>{
 const args=[cli,'--'+option,value,'--native-input-p3','powerShell7','--data-scope','com.shellspan.validation.native-input-p3','--route','existing-route','--model','second-model',...(mode==='no-model'?['--no-model']:['--native-jobs'])];
 const result=await run(process.execPath,args,{cwd:root,env,timeout:15000}).then(()=>null,error=>error);
 expect(result).not.toBeNull();expect(result.code).toBe(1);expect(result.stderr).toContain('--'+option+' requires');expect(result.stdout).not.toContain('Running DevCommand');
},20000);
it.skipIf(process.platform!=='win32').each(['prepare','verify'])('keeps no-model and owned-home gates for native restart path execution: %s',async phase=>{
 for(const mode of ['no-model','unowned-home']){
  const args=[cli,'--native-input-p3-file-restart',phase,'--native-input-p3-file-restart-execute','--native-input-p3','powerShell7','--data-scope','com.shellspan.validation.native-input-p3','--route','existing-route','--model','second-model',...(mode==='no-model'?['--no-model']:[])];
  const result=await run(process.execPath,args,{cwd:root,env:{...env,...mode==='unowned-home'?{SHELLSPAN_LOCAL_HOME:path.join(evidence,'other-home')}:{}},timeout:15000}).then(()=>null,error=>error);
  expect(result).not.toBeNull();expect(result.code).toBe(1);expect(result.stderr).toContain('--native-input-p3-file-restart-execute requires one owned real-model Windows');expect(result.stdout).not.toContain('Running DevCommand');
 }
},40000);
it.skipIf(process.platform!=='win32')('refuses native restart execution without an explicit restart phase',async()=>{
 const result=await run(process.execPath,[cli,'--native-input-p3-file-restart-execute'],{cwd:root,env,timeout:15000}).then(()=>null,error=>error);
 expect(result).not.toBeNull();expect(result.code).toBe(1);expect(result.stderr).toContain('--native-input-p3-file-restart-execute requires');expect(result.stdout).not.toContain('Running DevCommand');
},20000);

it.skipIf(process.platform!=='win32').each(['no-model','unowned-home'])('keeps declined-write approval refusal isolated before any App: %s',async mode=>{
 const args=[cli,'--native-input-p3-file-fault','declined-write','--native-input-p3','powerShell7','--data-scope','com.shellspan.validation.native-input-p3','--route','existing-route','--model','second-model',...(mode==='no-model'?['--no-model']:[])];
 const result=await run(process.execPath,args,{cwd:root,env:{...env,...mode==='unowned-home'?{SHELLSPAN_LOCAL_HOME:path.join(evidence,'other-home')}:{}},timeout:15000}).then(()=>null,error=>error);
 expect(result).not.toBeNull();expect(result.code).toBe(1);expect(result.stderr).toContain('declined-write requires an owned Windows real-model scratch target');expect(result.stdout).not.toContain('Running DevCommand');
},20000);

it.skipIf(process.platform!=='win32').each(['no-model','unowned-home','mixed-case'])('keeps foreign ownership refusal isolated before any App: %s',async mode=>{
 const args=[cli,'--native-input-p3-file-fault','foreign-owner','--native-input-p3','powerShell7','--data-scope','com.shellspan.validation.native-input-p3','--route','existing-route','--model','second-model',...(mode==='no-model'?['--no-model']:mode==='mixed-case'?['--native-jobs']:[])];
 const result=await run(process.execPath,args,{cwd:root,env:{...env,...mode==='unowned-home'?{SHELLSPAN_LOCAL_HOME:path.join(evidence,'other-home')}:{}},timeout:15000}).then(()=>null,error=>error);
 expect(result).not.toBeNull();expect(result.code).toBe(1);expect(result.stderr).toContain(mode==='mixed-case'?'--native-input-p3-file-fault requires':'foreign-owner requires an owned Windows real-model scratch target');expect(result.stdout).not.toContain('Running DevCommand');
},20000);

it.skipIf(process.platform!=='win32').each(['no-model','unowned-home','missing-job','wrong-job-host'])('keeps native file process references isolated before any App: %s',async mode=>{
 const args=[cli,'--native-input-p3-file-fault','background-reference','--native-input-p3','powerShell7','--data-scope','com.shellspan.validation.native-input-p3','--route','existing-route','--model','second-model',...(mode==='missing-job'?[]:['--native-jobs','--native-jobs-powershell',mode==='wrong-job-host'?'windowsPowerShell':'powerShell7']),...(mode==='no-model'?['--no-model']:[])];
 const result=await run(process.execPath,args,{cwd:root,env:{...env,...mode==='unowned-home'?{SHELLSPAN_LOCAL_HOME:path.join(evidence,'other-home')}:{}},timeout:15000}).then(()=>null,error=>error);
 expect(result).not.toBeNull();expect(result.code).toBe(1);expect(result.stderr).toContain('background-reference requires an owned Windows real-model native job target');expect(result.stdout).not.toContain('Running DevCommand');
},20000);

it.skipIf(process.platform!=='win32').each(['no-model','unowned-home','mixed-case'])('keeps independent Direct comparison isolated before any App: %s',async mode=>{
 const args=[cli,'--native-input-p3-file-fault','direct-comparison','--native-input-p3','powerShell7','--data-scope','com.shellspan.validation.native-input-p3','--route','existing-route','--model','second-model',...(mode==='no-model'?['--no-model']:mode==='mixed-case'?['--native-jobs']:[])];
 const result=await run(process.execPath,args,{cwd:root,env:{...env,...mode==='unowned-home'?{SHELLSPAN_LOCAL_HOME:path.join(evidence,'other-home')}:{}},timeout:15000}).then(()=>null,error=>error);
 expect(result).not.toBeNull();expect(result.code).toBe(1);expect(result.stderr).toContain(mode==='mixed-case'?'--native-input-p3-file-fault requires':'direct-comparison requires an owned Windows real-model independent Direct target');expect(result.stdout).not.toContain('Running DevCommand');
},20000);
