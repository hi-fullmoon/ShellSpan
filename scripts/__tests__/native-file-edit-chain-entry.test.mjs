import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {expect,it} from 'vitest';
const run=promisify(execFile),root=path.resolve(import.meta.dirname,'../..'),cli=path.join(root,'scripts/verify-ai-session-stream.mjs'),evidence=path.join(root,'.artifacts/tests/native-input-p2/file-edit-negative-only'),env={...process.env,SHELLSPAN_ALLOW_FOREGROUND_TESTS:'1',SHELLSPAN_ACCEPTANCE_EVIDENCE_DIR:evidence,SHELLSPAN_DATA_DIR:path.join(evidence,'data'),SHELLSPAN_LOCAL_HOME:path.join(evidence,'home')};
it.each([
 ['missing base mode',[]],
 ['missing Windows target',['--native-input-p3-file-chain']],
 ['non-Windows editor',['--native-input-p3-file-chain','--native-input-p3','zsh']],
 ['no-model execution',['--native-input-p3-file-chain','--native-input-p3','powerShell7','--data-scope','com.shellspan.validation.native-input-p3','--no-model']],
 ['mixed case',['--native-input-p3-file-chain','--native-input-p3','powerShell7','--data-scope','com.shellspan.validation.native-input-p3','--native-jobs']],
])('rejects %s before App/model launch',async(_name,args)=>{
 const result=await run(process.execPath,[cli,'--native-input-p3-file-chain-edit',...args],{cwd:root,env,timeout:15000}).then(()=>null,error=>error);expect(result).not.toBeNull();expect(result.code).toBe(1);expect(result.stderr).toContain('requires one owned real-model Windows six-call file chain');expect(result.stdout).not.toContain('Running DevCommand');
},20000);
