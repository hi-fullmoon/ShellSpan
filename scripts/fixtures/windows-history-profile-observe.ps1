param(
 [Parameter(Mandatory=$true)][string]$OwnedProfile,
 [Parameter(Mandatory=$true)][string]$Module,
 [Parameter(Mandatory=$true)][ValidateSet('none','int','string')][string]$VariableKind,
 [Parameter(Mandatory=$true)][string]$Observation
)
$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$owned=[IO.Path]::GetFullPath((Join-Path $project 'artifacts/tests')).TrimEnd('\')+'\'
foreach($path in @($OwnedProfile,$Observation)){
 if(-not [IO.Path]::IsPathRooted($path)-or -not [IO.Path]::GetFullPath($path).StartsWith($owned,[StringComparison]::OrdinalIgnoreCase)){throw 'History profile observation requires owned test paths'}
}
$expectedModule=[IO.Path]::GetFullPath((Join-Path $project 'src-tauri/resources/powershell/PSReadLine/2.4.5/PSReadLine.psd1'))
if(-not [IO.Path]::GetFullPath($Module).Equals($expectedModule,[StringComparison]::OrdinalIgnoreCase)){throw 'History profile observation requires the bundled provider'}
$privateModules=[IO.Path]::GetFullPath((Join-Path $project 'src-tauri/resources/powershell'))
$systemModules=Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/Modules'
$env:PSModulePath=@($privateModules,(Join-Path $PSHOME 'Modules'),$systemModules)-join [IO.Path]::PathSeparator
if($VariableKind-ne 'none'){
 Remove-Variable -Name MaximumHistoryCount -Scope Global -ErrorAction SilentlyContinue
 if($VariableKind-eq 'int'){Set-Variable -Name MaximumHistoryCount -Scope Global -Value ([int]71)}else{Set-Variable -Name MaximumHistoryCount -Scope Global -Value ([string]'71')}
}
& $OwnedProfile
$provider=Get-Module PSReadLine
$assembly=[Microsoft.PowerShell.PSConsoleReadLineOptions].Assembly.Location
$assemblyStream=[IO.File]::OpenRead($assembly)
$algorithm=[Security.Cryptography.SHA256]::Create()
try{$assemblyHash=[BitConverter]::ToString($algorithm.ComputeHash($assemblyStream)).Replace('-','').ToLowerInvariant()}finally{$algorithm.Dispose();$assemblyStream.Dispose()}
$value=@{modulePath=$provider.Path;version=[string]$provider.Version;assembly=$assembly;assemblySha256=$assemblyHash;providerDefaultMaximum=[Microsoft.PowerShell.PSConsoleReadLineOptions]::DefaultMaximumHistoryCount}
$bytes=[Text.UTF8Encoding]::new($false).GetBytes(($value|ConvertTo-Json -Compress))
$stream=[IO.File]::Open($Observation,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
try{$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Dispose()}
