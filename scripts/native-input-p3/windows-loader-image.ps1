param(
    [Parameter(Mandatory=$true)][uint32]$ConsoleProcessId,
    [Parameter(Mandatory=$true)][uint32]$OwnerProcessId,
    [Parameter(Mandatory=$true)][string]$ShellPath,
    [Parameter(Mandatory=$true)][string]$LibraryPath
)
$ErrorActionPreference='Stop'
$workspace=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$owned=[IO.Path]::GetFullPath((Join-Path $workspace 'artifacts/tests'))+'\'
$library=[IO.Path]::GetFullPath((Get-Item -LiteralPath $LibraryPath).FullName)
if(-not $library.StartsWith($owned,[StringComparison]::OrdinalIgnoreCase)){throw 'Loader candidate escaped owned artifacts'}
$console=Get-CimInstance Win32_Process -Filter ('ProcessId='+$ConsoleProcessId)
if($null-eq $console -or $console.ParentProcessId-ne $OwnerProcessId){throw 'ConsoleHost ownership mismatch'}
$shell=[IO.Path]::GetFullPath((Get-Item -LiteralPath $ShellPath).FullName)
if(-not [string]::Equals($console.ExecutablePath,$shell,[StringComparison]::OrdinalIgnoreCase)){throw 'ConsoleHost image mismatch'}
$modules=@([Diagnostics.Process]::GetProcessById($ConsoleProcessId).Modules | Where-Object {$_.ModuleName -ieq 'shellspan_native_input_editors.dll'})
if($modules.Count-gt 1){throw 'Ambiguous loader module'}
$modulePath=$null;$digest=$null
if($modules.Count-eq 1){
    $modulePath=[IO.Path]::GetFullPath($modules[0].FileName)
    if(-not [string]::Equals($modulePath,$library,[StringComparison]::OrdinalIgnoreCase)){throw 'Loaded a different native library'}
    $stream=[IO.File]::OpenRead($modulePath)
    $hasher=[Security.Cryptography.SHA256]::Create()
    try {$digest=[BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-','').ToLowerInvariant()}
    finally {$hasher.Dispose();$stream.Dispose()}
}
@{consoleProcessId=$ConsoleProcessId;ownerProcessId=$OwnerProcessId;shellPath=$shell;moduleCount=$modules.Count;modulePath=$modulePath;sha256=$digest;readOnly=$true}|ConvertTo-Json -Compress
