import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {expect,it} from 'vitest';
const root=path.resolve(import.meta.dirname,'../..'),run=promisify(execFile),cli=path.join(root,'scripts/verify-ai-session-stream.mjs'),evidence=path.join(root,'artifacts/tests/native-input-p2/semantic-negative-only');
const env={...process.env,SHELLSPAN_ALLOW_FOREGROUND_TESTS:'1',SHELLSPAN_ACCEPTANCE_EVIDENCE_DIR:evidence,SHELLSPAN_DATA_DIR:path.join(evidence,'data'),SHELLSPAN_LOCAL_HOME:path.join(evidence,'home')};
it.each([
 ['--native-input-p3-semantics-goal-format','exact'],
 ['--native-input-p3-semantics','headers','--native-input-p3-semantics-goal-format','unknown'],
])('rejects a missing semantic case or unknown request format before native activity: %j',async(...args)=>{
 const result=await run(process.execPath,[cli,...args],{cwd:root,env,timeout:15000}).then(()=>null,error=>error);
 expect(result).not.toBeNull();expect(result.code).toBe(1);expect(result.stderr).toContain('requires a semantic case and exact format');expect(result.stdout).not.toContain('Running DevCommand');
},20000);
it.each([
 ['unknown variant',['--native-input-p3-semantics','other']],
 ['missing target',['--native-input-p3-semantics','headers']],
 ['no-model execution',['--native-input-p3-semantics','headers','--native-input-p3','powerShell7','--data-scope','com.shellspan.validation.native-input-p3','--no-model']],
 ['different editor',['--native-input-p3-semantics','validation','--native-input-p3','zsh','--data-scope','com.shellspan.validation.native-input-p3']],
 ['mixed file-chain mode',['--native-input-p3-semantics','headers','--native-input-p3','powerShell7','--data-scope','com.shellspan.validation.native-input-p3','--native-input-p3-file-chain']],
])('rejects %s before native App/model activity',async(_name,args)=>{
 const result=await run(process.execPath,[cli,...args],{cwd:root,env,timeout:15000}).then(()=>null,error=>error);
 expect(result).not.toBeNull();expect(result.code).toBe(1);expect(result.stderr).toContain('requires one owned real-model Windows headers/validation case');expect(result.stdout).not.toContain('Running DevCommand');
},20000);
it('requires the original foreground gate even for an owned semantic fixture',async()=>{
 const result=await run(process.execPath,[cli,'--native-input-p3-semantics','headers'],{cwd:root,env:{...env,SHELLSPAN_ALLOW_FOREGROUND_TESTS:'0'},timeout:15000}).then(()=>null,error=>error);
 expect(result).not.toBeNull();expect(result.code).toBe(1);expect(result.stderr).toContain('Native App acceptance is disabled by default');expect(result.stdout).not.toContain('Running DevCommand');
},20000);

it('rejects reduced-motion mode without its original real-model semantic fixture',async()=>{
 const result=await run(process.execPath,[cli,'--native-input-p3-reduced-motion'],{cwd:root,env,timeout:15000}).then(()=>null,error=>error);
 expect(result).not.toBeNull();expect(result.code).toBe(1);expect(result.stderr).toContain('requires an isolated semantic case');expect(result.stdout).not.toContain('Running DevCommand');
});
