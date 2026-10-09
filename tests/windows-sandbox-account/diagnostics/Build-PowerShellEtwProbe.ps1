$ErrorActionPreference = 'Stop'
$taskIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$taskPrincipal = [Security.Principal.WindowsPrincipal]::new($taskIdentity)
if ($taskPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Compile this diagnostic with the ordinary desktop identity.'
}
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskOutputDirectory = Join-Path $taskRoot 'target\debug'
[IO.Directory]::CreateDirectory($taskOutputDirectory) | Out-Null
$taskCompiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$taskOutput = Join-Path $taskOutputDirectory 'powershell-etw-probe.exe'
$taskSource = Join-Path $PSScriptRoot 'PowerShellEtwProbe.cs'
& $taskCompiler /nologo /target:exe /platform:x64 "/out:$taskOutput" $taskSource
if ($LASTEXITCODE -ne 0) { throw 'Fixed ETW diagnostic compilation failed.' }
