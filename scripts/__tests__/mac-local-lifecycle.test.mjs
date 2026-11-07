import {mkdirSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {expect,it} from 'vitest';
import {isMacLocalLifecycle} from '../native-input-p3/mac-local-lifecycle.mjs';

const directory=resolve(import.meta.dirname,'../../.artifacts/tests/native-input-p3/local-lifecycle-selection',randomUUID());
const paths={evidence:directory,data:resolve(directory,'data'),home:resolve(directory,'home')};
for(const path of [paths.data,paths.home])mkdirSync(path,{recursive:true,mode:0o700});
const localIt=process.platform==='darwin'&&process.arch==='arm64'?it:it.skip;
const bash={'native-input-p2-lifecycle':true,'native-input-p2':true,'no-model':true,'data-scope':'com.shellspan.validation.native-input-p2'};

it('rejects the late mode alone before any foreground or native operation',()=>{
 const root=resolve(import.meta.dirname,'../..');
 for(const foreground of ['0','1']) {
  const result=spawnSync(process.execPath,['scripts/verify-ai-session-stream.mjs','--native-input-p2-lifecycle-late'],
   {cwd:root,env:{...process.env,SHELLSPAN_ALLOW_FOREGROUND_TESTS:foreground},encoding:'utf8',timeout:5000});
  expect(result.error).toBeUndefined();expect(result.status).toBe(1);
  expect(result.stderr).toContain(foreground==='0'?'Native App acceptance is disabled by default':'Late local lifecycle requires the exact owned no-model Mac lifecycle mode');
 }
});

it('leaves unrelated and SSH lifecycle selection with the existing driver',()=>{
 expect(isMacLocalLifecycle({},paths)).toBe(false);
 expect(isMacLocalLifecycle({...bash,'native-input-p2-ssh-fixture':resolve(directory,'fixture.json')},paths)).toBe(false);
});
localIt('selects only exact no-model local Bash or Zsh families with owned paths',()=>{
 expect(isMacLocalLifecycle(bash,paths)).toBe(true);
 expect(isMacLocalLifecycle({...bash,'native-input-p2-lifecycle-late':true},paths)).toBe(true);
 expect(isMacLocalLifecycle({'native-input-p2-lifecycle':true,'native-input-p3':'zsh','no-model':true,'data-scope':'com.shellspan.validation.native-input-p3'},paths)).toBe(true);
});
localIt.each([
 {'no-model':false},
 {'data-scope':'com.shellspan.validation.native-input-p3'},
 {'native-input-p3':'zsh'},
 {route:'unexpected-route',model:'unexpected-model'},
 {'native-jobs':true},
])('rejects mixed or incorrectly scoped local lifecycle arguments: %j',extra=>{
 expect(()=>isMacLocalLifecycle({...bash,...extra},paths)).toThrow('no mixed operation');
});
localIt.each([
 {...paths,data:resolve(directory,'other-data')},
 {...paths,home:resolve(directory,'other-home')},
 {evidence:'relative',data:'relative/data',home:'relative/home'},
])('rejects non-owned local data or home pairs',invalid=>{
 expect(()=>isMacLocalLifecycle(bash,invalid)).toThrow('exact data/HOME');
});
