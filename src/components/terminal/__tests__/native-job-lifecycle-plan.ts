export function nativePowerShellJobSources(marker: string): readonly [string, string, string] {
  if (!/^native-jobs-[a-f0-9-]{36}$/.test(marker)) throw Error('Owned native job marker required');
  return [
    `using namespace System.Text\nparam($P3Header=$([Console]::WriteLine('P3-PRE-'+'HEADER');'header-value'))\n$P3ParentScope='scope-${marker}'; [Console]::WriteLine('P3-BODY-'+'HEADER'); Set-Location -LiteralPath $env:SHELLSPAN_NATIVE_WORKSPACE; function global:shellspan_acceptance_alias_target { 'alias-ok' }; Set-Alias -Scope Global shellspan_acceptance_alias shellspan_acceptance_alias_target; function global:shellspan_acceptance_function { 'function-ok' }`,
    `Write-Output $P3ParentScope\nWrite-Output $env:SHELLSPAN_ACCEPTANCE\nWrite-Output (Get-Location).Path\nshellspan_acceptance_alias\nshellspan_acceptance_function\n@'\nreal\tTab 'single' "double"\nSHELLSPAN_END\n'@\nwhile (-not [IO.File]::Exists($env:SHELLSPAN_NATIVE_COMPLETION_GATE)) { Start-Sleep -Milliseconds 25 }`,
    'cmd.exe /d /c exit 7',
  ];
}

export function nativeJobLifecycleGoal(sources: readonly [string, string, string]): string {
  return `Execute exactly SEVEN calls using the bound visible terminal. Emit exactly ONE tool call per assistant response. Wait for that call's real tool/result before proposing the next call. This also applies individually to waits 3,4,5:never batch or parallelize the three waits. Do not use Direct, extra tools, retries or change source. The blocks below are RAW SHELL TEXT, not JSON string literals. Use the exact contents of each block as the command string; encode that string once in the tool arguments. Never include the fence or add backslashes to shell quotes. Preserve existing backslashes, actual tabs and adjacent single-quoted strings. Each command has NO trailing CR or LF. The single newline immediately before each closing fence is a markup separator, not part of the command; preserve every embedded newline and tab. Call 1 run_terminal_command with SETUP. Call 2 run_terminal_command background=true with BACKGROUND. Calls 3, 4 and 5 wait_process on the returned job-* handle timeoutMs=1000. Call 6 kill_process on that handle signal=terminate timeoutMs=10000. Call 7 run_terminal_command with FINAL. Then reply done. Job output is sharedTerminal.\n\nSETUP:\n~~~sh\n${sources[0]}\n~~~\n\nBACKGROUND:\n~~~sh\n${sources[1]}\n~~~\n\nFINAL:\n~~~sh\n${sources[2]}\n~~~`;
}

export function nativeJobStepMayFollow(step:number,completed:number,priorSteps:readonly string[],nextStep:string|undefined):boolean{
  return Number.isInteger(step)&&step>=0&&step<7&&completed===step&&!!nextStep&&!priorSteps.includes(nextStep);
}
