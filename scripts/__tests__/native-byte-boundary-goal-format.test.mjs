import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {expect,it} from 'vitest';
const root=path.resolve(import.meta.dirname,'../..'),run=promisify(execFile),cli=path.join(root,'scripts/verify-ai-session-stream.mjs');
const owned=path.join(root,'artifacts/tests/native-input-p2/goal-format-negative-only/data');
it.each([
 ['missing boundary',['--native-input-p3-byte-boundary-goal-format','json'],'requires a byte-boundary case and exact raw/json/json-ascii format'],
 ['unknown format',['--native-input-p3-byte-boundary','8192','--native-input-p3-byte-boundary-goal-format','other'],'requires a byte-boundary case and exact raw/json/json-ascii format'],
 ['no-model execution',['--native-input-p3-byte-boundary','8192','--native-input-p3-byte-boundary-goal-format','json','--native-input-p3','powerShell7','--data-scope','com.shellspan.validation.native-input-p3','--no-model'],'requires one isolated real-model Windows byte-boundary case'],
 ['ASCII request without a boundary',['--native-input-p3-byte-boundary-goal-format','json-ascii'],'requires a byte-boundary case and exact raw/json/json-ascii format'],
 ['different editor',['--native-input-p3-byte-boundary','8192','--native-input-p3-byte-boundary-goal-format','json','--native-input-p3','zsh','--data-scope','com.shellspan.validation.native-input-p3'],'requires one isolated real-model Windows byte-boundary case'],
])('rejects %s before any native App/model launch',async(_name,args,message)=>{
 const result=await run(process.execPath,[cli,...args],{cwd:root,env:{...process.env,SHELLSPAN_ALLOW_FOREGROUND_TESTS:'1',SHELLSPAN_DATA_DIR:owned},timeout:15000}).then(()=>null,error=>error);
 expect(result).not.toBeNull();expect(result.code).toBe(1);expect(result.stderr).toContain(message);expect(result.stdout).not.toContain('Running DevCommand');
},20000);
it('keeps the foreground authorization gate for the JSON format',async()=>{
 const result=await run(process.execPath,[cli,'--native-input-p3-byte-boundary','8192','--native-input-p3-byte-boundary-goal-format','json'],{cwd:root,env:{...process.env,SHELLSPAN_ALLOW_FOREGROUND_TESTS:'0'},timeout:15000}).then(()=>null,error=>error);
 expect(result).not.toBeNull();expect(result.code).toBe(1);expect(result.stderr).toContain('Native App acceptance is disabled by default');expect(result.stdout).not.toContain('Running DevCommand');
},20000);
