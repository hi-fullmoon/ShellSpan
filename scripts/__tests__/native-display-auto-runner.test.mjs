import {it, expect} from 'vitest';
import fs from 'node:fs';
import p from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const root=p.resolve(import.meta.dirname,'../..');
const valid=['--native-input-p3-display-auto','--native-input-p3-startup','powerShell7','--no-model','--data-scope','com.shellspan.validation.native-input-p3'];
it.each([
 ['--native-input-p3-display-active-input'],
 [...valid, '--native-input-p3-display-active-input', '--native-input-p3-display-cursor-diagnostic'],
 [...valid, '--native-input-p3-display-active-input', '--native-input-p3-display-reflow-diagnostic'],
])('rejects active input outside its unchanged default display configuration: %j', (...args) => {
 const value=spawnSync(process.execPath,[p.join(root,'scripts/verify-ai-session-stream.mjs'),...args],{cwd:root,env:{...process.env,SHELLSPAN_ALLOW_FOREGROUND_TESTS:'1'},encoding:'utf8',timeout:10000});
 expect(value.status).toBe(1);expect(value.stderr).toContain('Active-input display requires the isolated unmodified display configuration');
},15000);
it.each([
 {args:['--native-input-p3-display-auto'],gate:'1',foreignHome:false},
 {args:valid.filter(x=>x!=='--no-model'),gate:'1',foreignHome:false},
 {args:[...valid,'--native-jobs'],gate:'1',foreignHome:false},
 {args:valid.map(x=>x==='powerShell7'?'zsh':x),gate:'1',foreignHome:false},
 {args:valid,gate:'0',foreignHome:false},
 {args:valid,gate:'1',foreignHome:true},
 {args:[...valid,'--native-input-p3-startup-user-edit'],gate:'1',foreignHome:false},
])('rejects unsafe automatic display modes before starting an App: %j',({args,gate,foreignHome})=>{
 const evidence=p.join(root,'artifacts/tests/native-display-auto-scope',randomUUID());
 const value=spawnSync(process.execPath,[p.join(root,'scripts/verify-ai-session-stream.mjs'),...args],{
  cwd:root,env:{...process.env,SHELLSPAN_ALLOW_FOREGROUND_TESTS:gate,SHELLSPAN_ACCEPTANCE_EVIDENCE_DIR:evidence,SHELLSPAN_DATA_DIR:p.join(evidence,'data'),SHELLSPAN_LOCAL_HOME:foreignHome?p.join(evidence,'foreign'):p.join(evidence,'home'),SHELLSPAN_LOCAL_SHELL:'D:/Programs/PowerShell/7/pwsh.exe'},encoding:'utf8',timeout:10000,
 });
 expect(value.status).toBe(1);expect(value.stderr).toContain(gate==='0'?'Native App acceptance is disabled by default':'--native-input-p3-display-auto requires an isolated scheduled Windows startup display case');expect(fs.existsSync(evidence)).toBe(false);
},15000);
it.each([
 ['--native-input-p3-display-cursor-diagnostic'],
 [...valid,'--native-input-p3-display-cursor-diagnostic','--native-input-p3-display-reflow-diagnostic'],
])('refuses cursor sampling outside a single default display diagnostic: %j',(...args)=>{
 const value=spawnSync(process.execPath,[p.join(root,'scripts/verify-ai-session-stream.mjs'),...args],{cwd:root,env:{...process.env,SHELLSPAN_ALLOW_FOREGROUND_TESTS:'1'},encoding:'utf8',timeout:10000});
 expect(value.status).toBe(1);expect(value.stderr).toContain('Cursor sampling requires the isolated default display case');
},15000);
it.each([
 ['--native-input-p3-display-reflow-diagnostic'],
 ['--native-input-p3-display-reflow-diagnostic','--native-input-p3-startup','powerShell7','--no-model','--data-scope','com.shellspan.validation.native-input-p3'],
])('rejects a reflow diagnostic outside its display-only fixture: %j',(...args)=>{
 const value=spawnSync(process.execPath,[p.join(root,'scripts/verify-ai-session-stream.mjs'),...args],{cwd:root,env:{...process.env,SHELLSPAN_ALLOW_FOREGROUND_TESTS:'1'},encoding:'utf8',timeout:10000});
 expect(value.status).toBe(1);expect(value.stderr).toContain('Display reflow diagnostic requires the isolated automatic display case');
},15000);
