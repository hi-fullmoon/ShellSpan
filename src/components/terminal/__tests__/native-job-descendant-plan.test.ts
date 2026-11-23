import {afterAll,expect,it} from 'vitest';
import {nativeJobDescendantPlan,nativeJobDescendantInitialGoal,nativeJobDescendantContinuationGoal} from './native-job-descendant-plan';
import {nativeJobStdinPlan,matchesNativeJobStdinStep,nativeJobStdinArguments} from './native-job-stdin-plan';
import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
const marker='native-jobs-4c8d96aa-5a69-49f0-a768-52bb3a8b018b',handle='job-'+'a'.repeat(32);
it('keeps all original sources and management semantics while adding one separately owned descendant scene',()=>{
 const base=nativeJobStdinPlan(marker),plan=nativeJobDescendantPlan(marker);
 expect(plan.sources[0]).toBe(base.sources[0]);expect(plan.sources[1].endsWith(base.sources[1])).toBe(true);expect(plan.sources.slice(2)).toEqual(base.sources.slice(2));expect(plan.sources[1]).toContain("real\tTab 'single' \"double\"");
 expect(plan.sources[1]).toContain('UseShellExecute=$false');expect(plan.sources[1]).toContain('CreateNoWindow=$true');expect(plan.sources[1]).toContain('[IO.FileMode]::CreateNew');expect(new TextEncoder().encode(plan.sources[1]).length).toBeLessThanOrEqual(8192);
 expect(plan.sources[1]).not.toContain('-EncodedCommand');expect(plan.sources[1]).toContain('-Command "while (-not [IO.File]::Exists($env:SHELLSPAN_NATIVE_COMPLETION_GATE))');
 for(let step=0;step<7;step++)expect(matchesNativeJobStdinStep(plan,step,plan.tools[step],nativeJobStdinArguments(plan,step,handle),handle)).toBe(true);
 expect(matchesNativeJobStdinStep(plan,1,'run_terminal_command',{command:base.sources[1],background:true},handle)).toBe(false);
});
it('separates a two-call launch turn from management only after independent observation, preserving exact original handle and options',()=>{
 const plan=nativeJobDescendantPlan(marker),initial=nativeJobDescendantInitialGoal(plan),continuation=nativeJobDescendantContinuationGoal(plan,handle);
 expect(initial).toContain('exactly TWO');expect(initial).toContain('return HOLD');expect(initial).toContain(plan.sources[1]);expect(continuation).toContain('exactly FIVE');expect(continuation).toContain(handle);expect(continuation).toContain('timeoutMs=1000');expect(continuation).toContain('timeoutMs=10000');expect(continuation).toContain('close=false');expect(continuation).toContain(plan.sources[3]);expect(()=>nativeJobDescendantContinuationGoal(plan,'foreign-handle')).toThrow();
 expect(continuation).toContain('within this same runtime turn');expect(continuation).toContain('without waiting for another user message');expect(continuation).toContain('After the expected stdin rejection, continue directly to wait_process.');expect(continuation).toContain('Return final text only after HISTORY has returned.');
});
it.skipIf(process.platform!=='win32').each(['C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe','D:/Programs/PowerShell/7/pwsh.exe'])('parses the complete descendant source with the actual host without executing it: %s',async executable=>{
 const directory=path.resolve(import.meta.dirname,'../../../../artifacts/tests/native-job-descendant-parser',randomUUID());fs.mkdirSync(directory,{recursive:true});
 const source=path.join(directory,'source.ps1'),parser=path.join(directory,'parse.ps1'),home=path.join(directory,'home');fs.mkdirSync(home);
 fs.writeFileSync(source,nativeJobDescendantPlan(marker).sources[1]);
 fs.writeFileSync(parser,"param([string]$Source)\n$tokens=$null;$errors=$null;$null=[System.Management.Automation.Language.Parser]::ParseFile($Source,[ref]$tokens,[ref]$errors);if($errors.Count){[Console]::Error.WriteLine(($errors|ForEach-Object {$_.Message})-join [Environment]::NewLine);exit 1}\n");
 const result=await promisify(execFile)(executable,['-NoLogo','-NoProfile','-NonInteractive','-File',parser,'-Source',source],{timeout:15000,windowsHide:true,env:{...process.env,HOME:home,USERPROFILE:home,PSModuleAnalysisCachePath:path.join(directory,'module.cache')}});
 expect(result.stderr).toBe('');expect(fs.existsSync(path.join(home,nativeJobDescendantPlan(marker).witnessName))).toBe(false);
},20000);

afterAll(()=>{fs.rmSync(path.resolve(import.meta.dirname,'../../../../artifacts/tests/native-job-descendant-parser'),{recursive:true,force:true});});
