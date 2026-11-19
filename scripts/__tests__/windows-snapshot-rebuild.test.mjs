import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {expect,it} from 'vitest';

it.runIf(process.platform==='win32'&&process.arch==='x64')('refuses editor reconstruction before snapshot work without the explicit test gate',()=>{
 const result=spawnSync(process.execPath,[path.resolve(import.meta.dirname,'../native-input/acceptance/snapshot.mjs'),'--short-windows-paths','--rebuild-windows-editors'],{encoding:'utf8',windowsHide:true,env:{...process.env,SHELLSPAN_ALLOW_FOREGROUND_TESTS:'0'}});
 expect(result.status).not.toBe(0);
 expect(result.stderr).toContain('Windows editor reconstruction requires the explicit foreground test gate');
 expect(result.stdout).toBe('');
});
