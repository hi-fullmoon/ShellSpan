import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const artifacts = path.join(root, 'artifacts/tests/native-job-marker');

describe.runIf(process.platform === 'win32')('native PowerShell marker discovery', () => {
  it.each([
    ['Windows PowerShell', path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')],
    ['PowerShell Core', 'pwsh.exe'],
  ])('%s avoids module execution while preserving command collision checks', (_host, executable) => {
    mkdirSync(artifacts, { recursive: true });
    const directory = mkdtempSync(path.join(artifacts, 'run-'));
    const handle = 'job-1234567890abcdef1234567890abcdef';
    const moduleRoot = path.join(directory, 'modules');
    const moduleDirectory = path.join(moduleRoot, 'MarkerProbe');
    mkdirSync(moduleDirectory, { recursive: true });
    writeFileSync(path.join(moduleDirectory, 'MarkerProbe.psd1'), `@{RootModule='MarkerProbe.psm1';ModuleVersion='1.0.0';FunctionsToExport=@('${handle}');CmdletsToExport=@();AliasesToExport=@()}`);
    writeFileSync(path.join(moduleDirectory, 'MarkerProbe.psm1'), `[IO.File]::WriteAllText($env:SHELLSPAN_MARKER_IMPORT,'imported'); function ${handle} {}; Export-ModuleMember -Function '${handle}'`);
    const script = path.join(directory, 'probe.ps1');
    writeFileSync(script, `
$ErrorActionPreference='Stop'
. $env:SHELLSPAN_MARKER_HELPERS
$h='${handle}'
function Assert-Probe($condition,$message){if(-not $condition){throw $message}}
function Install-Probe([string]$source="Write-Output 'isolated-marker-probe'"){
  $line=$h+" '"+$source.Replace("'","''")+"'"
  $tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseInput($line,[ref]$tokens,[ref]$errors)
  Install-ShellSpanNativeMarker $line $ast
}
$preference=Get-Variable PSModuleAutoLoadingPreference -ErrorAction Ignore
Assert-Probe (Install-Probe) 'Unloaded module metadata blocked marker installation'
Assert-Probe (-not [IO.File]::Exists($env:SHELLSPAN_MARKER_IMPORT)) 'Discovery executed an unloaded module'
Remove-ShellSpanNativeMarker
Assert-Probe ($null-eq (Get-Item -LiteralPath ('Function:\\'+$h) -ErrorAction Ignore)) 'Owned marker function leaked after cleanup'
$body={throw 'Existing function must never execute'}
Set-Item -LiteralPath ('Function:\\global:'+$h) -Value $body
Assert-Probe (-not (Install-Probe)) 'Existing function collision was ignored'
Assert-Probe ((Get-Item -LiteralPath ('Function:\\'+$h)).ScriptBlock -eq $body) 'Existing function was overwritten'
Remove-Item -LiteralPath ('Function:\\'+$h)
Set-Alias -Name $h -Value Write-Output -Scope Global
Assert-Probe (-not (Install-Probe)) 'Existing alias collision was ignored'
Assert-Probe ((Get-Alias -Name $h).Definition -eq 'Write-Output') 'Existing alias was overwritten'
Remove-Item -LiteralPath ('Alias:\\'+$h)
$env:PATH=$PSScriptRoot+[IO.Path]::PathSeparator+$env:PATH
$external=Join-Path $PSScriptRoot ($h+'.cmd');[IO.File]::WriteAllText($external,'@exit /b 0')
Assert-Probe (-not (Install-Probe)) 'Existing executable extension collision was ignored'
[IO.File]::Delete($external)
Set-Item -LiteralPath ('Function:\\global:'+$h+'Suffix') -Value {}
[IO.File]::WriteAllText((Join-Path $PSScriptRoot ($h+'Suffix.cmd')),'@exit /b 0')
Assert-Probe (Install-Probe) 'A different command sharing the prefix blocked the marker'
Remove-ShellSpanNativeMarker
Assert-Probe (Install-Probe) 'Marker could not be installed for replacement check'
Set-Item -LiteralPath ('Function:\\global:'+$h) -Value $body
Remove-ShellSpanNativeMarker
Assert-Probe ((Get-Item -LiteralPath ('Function:\\'+$h)).ScriptBlock -eq $body) 'Cleanup deleted a user replacement'
Remove-Item -LiteralPath ('Function:\\'+$h)
Assert-Probe (-not (Install-Probe 'if (')) 'Invalid source was accepted'
Assert-Probe (-not [IO.File]::Exists($env:SHELLSPAN_MARKER_IMPORT)) 'Later collision checks imported a module'
Assert-Probe (-not (Get-Module MarkerProbe)) 'Unloaded module became loaded'
$after=Get-Variable PSModuleAutoLoadingPreference -ErrorAction Ignore
Assert-Probe (($null-eq $preference -and $null-eq $after) -or ($null-ne $preference -and $null-ne $after -and $preference.Value-eq $after.Value)) 'User auto-loading preference changed'
$private=New-Module -ScriptBlock {param($helpers) . $helpers} -ArgumentList $env:SHELLSPAN_MARKER_HELPERS
& $private {
  param($handle)
  $line=$handle+" 'Write-Output 1'";$tokens=$null;$errors=$null
  $ast=[Management.Automation.Language.Parser]::ParseInput($line,[ref]$tokens,[ref]$errors)
  Assert-Probe (Install-ShellSpanNativeMarker $line $ast) 'Private module could not install its global marker'
  Remove-ShellSpanNativeMarker
  Assert-Probe ($null-eq (Get-Item -LiteralPath ('Function:\\'+$handle) -ErrorAction Ignore)) 'Private module leaked its global marker'
} $h
Assert-Probe (-not [IO.File]::Exists($env:SHELLSPAN_MARKER_IMPORT)) 'Private module lookup imported user module'
@{scenarios=8;moduleImported=$false;collisionsPreserved=$true}|ConvertTo-Json -Compress
`);
    try {
      const result = spawnSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script], {
        cwd: directory, windowsHide: true, encoding: 'utf8', timeout: 15_000,
        env: { ...process.env, PSModulePath: [moduleRoot, process.env.PSModulePath].filter(Boolean).join(path.delimiter),
          PSModuleAnalysisCachePath: path.join(directory, 'module.cache'),
          SHELLSPAN_MARKER_IMPORT: path.join(directory, 'module-imported.txt'),
          SHELLSPAN_MARKER_HELPERS: path.join(root, 'src-tauri/src/terminal_jobs.ps1') },
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ scenarios: 8, moduleImported: false, collisionsPreserved: true });
    } finally {
      const relative = path.relative(artifacts, directory);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe test cleanup path');
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
