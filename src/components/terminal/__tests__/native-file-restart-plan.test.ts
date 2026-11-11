import {expect, it} from 'vitest';
import {nativePowerShellRestartInvocation, matchesNativePowerShellRestartSource, matchesNativePowerShellRestartRecovery} from './native-file-restart-plan';
import {matchesNativeFileChainStep} from './native-file-chain-approval';

it('executes the exact returned absolute path with PowerShell quoting and no path rewriting', () => {
  const path = "D:\\原始 cwd\\owner's files\\0123456789abcdef\\script.ps1";
  const invoke = nativePowerShellRestartInvocation(path);
  expect(invoke).toBe("& 'D:\\原始 cwd\\owner''s files\\0123456789abcdef\\script.ps1'");
  const plan = {fileName: 'script.ps1', content: 'Write-Output 1', setup: '', invoke};
  expect(matchesNativeFileChainStep(3, 'run_terminal_command', {command: invoke, background: false, timeoutMs: 5000}, plan)).toBe(true);
  for (const command of [plan.content, invoke.replace('原始 cwd', 'other'), '. ' + invoke.slice(2), invoke + '\n']) {
    expect(matchesNativeFileChainStep(3, 'run_terminal_command', {command, background: false, timeoutMs: 5000}, plan)).toBe(false);
  }
  const extended = '\\\\?\\D:\\原始 cwd\\script.ps1';
  expect(nativePowerShellRestartInvocation(extended)).toBe("& '" + extended + "'");
});
it.each(['relative.ps1', '../script.ps1', 'D:script.ps1', 'D:\\script.ps1\r\nWrite-Output 2', 'D:\\bad\0.ps1'])('refuses invalid returned script path %j', path => {
  expect(() => nativePowerShellRestartInvocation(path)).toThrow('Exact returned absolute Windows script path');
});

it('accepts a null NIP submission envelope only with complete original-source and settlement proof', () => {
  const source = nativePowerShellRestartInvocation("D:\\owner's files\\script.ps1");
  const proof = {displaySource: source, fullInputConfirmed: true, submissionIntentDurable: true,
    executionEvidence: 'endObserved', phase: 'completed', noAutoReplay: true};
  const data = {channel: 'terminal', execution: 'completed', exitCode: 0, commandLine: source,
    submittedCommandLine: null, commandObservation: proof};
  expect(matchesNativePowerShellRestartSource(data, source)).toBe(true);
  expect(matchesNativePowerShellRestartSource({...data, submittedCommandLine: source}, source)).toBe(true);
  for (const change of [{commandLine: source + '\n'}, {submittedCommandLine: 'different'},
    {submittedCommandLine: undefined}, {channel: 'direct'}, {exitCode: 7}, {commandObservation: null}]) {
    expect(matchesNativePowerShellRestartSource({...data, ...change}, source)).toBe(false);
  }
  for (const change of [{displaySource: 'different'}, {fullInputConfirmed: false},
    {submissionIntentDurable: false}, {executionEvidence: 'startObserved'}, {phase: 'running'}, {noAutoReplay: false}]) {
    expect(matchesNativePowerShellRestartSource({...data, commandObservation: {...proof, ...change}}, source)).toBe(false);
  }
});

it('requires the same reconnected native parent to become prompt-ready before the final snapshot', () => {
  const before = {open: true, promptReady: true, inputMode: 'native-inline', terminalSessionId: 'native',
    terminalGeneration: 1, transportSessionId: 'transport', currentDirectory: "D:/owner's/工作目录"};
  expect(matchesNativePowerShellRestartRecovery(before, {...before})).toBe(true);
  for (const change of [{promptReady: false}, {open: false}, {inputMode: 'legacy'},
    {terminalSessionId: 'foreign'}, {terminalGeneration: 2}, {transportSessionId: 'foreign'},
    {currentDirectory: 'D:/foreign'}]) {
    expect(matchesNativePowerShellRestartRecovery(before, {...before, ...change})).toBe(false);
  }
  expect(matchesNativePowerShellRestartRecovery(before, null)).toBe(false);
  expect(matchesNativePowerShellRestartRecovery({}, before)).toBe(false);
});
