import {expect,it} from 'vitest';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';

it.each([
 ['--native-input-p3-file-chain','--native-input-p3','zsh','--data-scope','com.shellspan.validation.native-input-p3'],
 ['--native-input-p3-file-chain','--native-input-p2','--data-scope','com.shellspan.validation.native-input-p2'],
 ['--native-input-p3-file-chain','--native-input-p3','zsh','--data-scope','com.shellspan.validation.native-input-p3','--no-model'],
])('refuses an unowned or mixed macOS file chain before App launch: %j',(...args)=>{
 const env={...process.env,SHELLSPAN_ALLOW_FOREGROUND_TESTS:'1'};
 for(const key of ['SHELLSPAN_ACCEPTANCE_EVIDENCE_DIR','SHELLSPAN_DATA_DIR','SHELLSPAN_LOCAL_HOME'])delete env[key];
 const result=spawnSync(process.execPath,[resolve(import.meta.dirname,'../verify-ai-session-stream.mjs'),...args],{env,encoding:'utf8',timeout:5000});
 expect(result.error).toBeUndefined();expect(result.status).toBe(1);expect(result.stderr).toContain('--native-input-p3-file-chain requires one isolated');
});
