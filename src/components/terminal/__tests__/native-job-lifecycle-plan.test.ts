import {expect,it} from 'vitest';
import {nativeJobLifecycleGoal,nativePowerShellJobSources,nativeJobStepMayFollow} from './native-job-lifecycle-plan';

it('retains the existing P3 PowerShell seven-call sources and literal Tab',()=>{
 const marker='native-jobs-11111111-1111-4111-8111-111111111111',sources=nativePowerShellJobSources(marker);
 expect(sources[0]).toBe(`using namespace System.Text\nparam($P3Header=$([Console]::WriteLine('P3-PRE-'+'HEADER');'header-value'))\n$P3ParentScope='scope-${marker}'; [Console]::WriteLine('P3-BODY-'+'HEADER'); Set-Location -LiteralPath $env:SHELLSPAN_NATIVE_WORKSPACE; function global:shellspan_acceptance_alias_target { 'alias-ok' }; Set-Alias -Scope Global shellspan_acceptance_alias shellspan_acceptance_alias_target; function global:shellspan_acceptance_function { 'function-ok' }`);
 expect(sources[1]).toContain("@'\nreal\tTab 'single' \"double\"\nSHELLSPAN_END\n'@");
 expect(sources[1].endsWith('Start-Sleep -Milliseconds 25 }')).toBe(true);expect(sources[2]).toBe('cmd.exe /d /c exit 7');
 expect(sources.every(x=>!/[\r\n]$/.test(x))).toBe(true);expect(()=>nativePowerShellJobSources('foreign')).toThrow();
 const goal=nativeJobLifecycleGoal(sources);for(const source of sources)expect(goal).toContain(source);expect(goal).toContain('Calls 3, 4 and 5 wait_process');expect(goal).toContain('NO trailing CR or LF');
});
it('requires the prior result and a new model step instead of batching native waits',()=>{
 expect(nativeJobStepMayFollow(3,3,['step0','step1','step2'],'step3')).toBe(true);
 expect(nativeJobStepMayFollow(3,2,['step0','step1','step2'],'step3')).toBe(false);
 expect(nativeJobStepMayFollow(3,3,['step0','step1','step2'],'step2')).toBe(false);
 expect(nativeJobStepMayFollow(7,7,[],'extra')).toBe(false);
});
