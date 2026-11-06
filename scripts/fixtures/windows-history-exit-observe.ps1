param([Parameter(Mandatory=$true)][string]$ShellRecord,[Parameter(Mandatory=$true)][string]$Output,[int]$TimeoutMs=600000)
$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$artifacts=[IO.Path]::GetFullPath((Join-Path $project '.artifacts/tests')).TrimEnd('\')+'\'
foreach($path in @($ShellRecord,$Output)){
  if(-not [IO.Path]::IsPathRooted($path)-or -not [IO.Path]::GetFullPath($path).StartsWith($artifacts,[StringComparison]::OrdinalIgnoreCase)){throw 'Exit observer paths must be owned test evidence'}
}
if($TimeoutMs-lt 1-or $TimeoutMs-gt 600000){throw 'Invalid exit observation deadline'}
$recordInfo=Get-Item -LiteralPath $ShellRecord -Force
if($recordInfo.PSIsContainer-or ($recordInfo.Attributes-band [IO.FileAttributes]::ReparsePoint)-ne 0-or $recordInfo.Length-gt 131072){throw 'Invalid Shell identity record'}
function Write-ExclusiveJson($Path,$Value){
  $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Value|ConvertTo-Json -Compress -Depth 5))
  $stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
  try{$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Dispose()}
}
$record=Get-Content -LiteralPath $ShellRecord -Raw|ConvertFrom-Json
if([int]$record.shellPid-le 1-or -not [IO.Path]::IsPathRooted([string]$record.executable)-or -not $record.created-or -not $record.sha256){throw 'Incomplete original Shell identity'}
$shellProcess=[Diagnostics.Process]::GetProcessById([int]$record.shellPid)
try{
  $null=$shellProcess.Handle
  $created=$shellProcess.StartTime.ToUniversalTime()
  if([math]::Abs(($created-([datetime]$record.created).ToUniversalTime()).TotalMilliseconds)-gt 1000-or -not $shellProcess.MainModule.FileName.Equals([string]$record.executable,[StringComparison]::OrdinalIgnoreCase)-or (Get-FileHash -LiteralPath $record.executable -Algorithm SHA256).Hash.ToLowerInvariant()-cne $record.sha256){throw 'Original Shell handle identity changed'}
  Write-ExclusiveJson ($Output+'.ready.json') @{shellPid=$record.shellPid;created=$created.ToString('o');executable=$record.executable;sha256=$record.sha256;handleHeld=$true;inputInjected=$false;terminationRequested=$false;at=[datetime]::UtcNow.ToString('o')}
  $ended=$shellProcess.WaitForExit($TimeoutMs)
  $observed=@{shellPid=$record.shellPid;created=$created.ToString('o');ended=$ended;exitCode=$null;handleHeld=$true;inputInjected=$false;terminationRequested=$false;at=[datetime]::UtcNow.ToString('o')}
  if($ended){$observed.exitCode=$shellProcess.ExitCode}
  Write-ExclusiveJson $Output $observed
  if(-not $ended){throw 'Original Shell did not exit before observer deadline'}
}finally{$shellProcess.Dispose()}
