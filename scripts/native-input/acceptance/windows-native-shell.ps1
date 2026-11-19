param(
  [Parameter(Mandatory=$true)][string]$AppRecord,
  [Parameter(Mandatory=$true)][string]$AppHelper,
  [Parameter(Mandatory=$true)][string]$OwnedRoot,
  [Parameter(Mandatory=$true)][string]$Shell,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedShellSha256,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedModuleSha256
)
$ErrorActionPreference='Stop'
foreach($module in @('CimCmdlets','Microsoft.PowerShell.Utility','Microsoft.PowerShell.Security','Microsoft.PowerShell.Management')){
  Import-Module (Join-Path $PSHOME ('Modules/'+$module+'/'+$module+'.psd1')) -ErrorAction Stop
}
if(-not [IO.Path]::IsPathRooted($OwnedRoot) -or -not [IO.Path]::IsPathRooted($Shell)){throw 'Absolute native Shell ownership paths required'}
$root=[IO.Path]::GetFullPath($OwnedRoot).TrimEnd('\')+'\'
$record=Get-Content -LiteralPath $AppRecord -Raw | ConvertFrom-Json
if(-not $record.executable.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)){throw 'App image is outside the owned acceptance directory'}
$actual=& powershell.exe -NoLogo -NoProfile -NonInteractive -File $AppHelper -Action Inspect -ApplicationPid $record.applicationPid -RunnerPid $record.runnerPid -Executable $record.executable | ConvertFrom-Json
if($LASTEXITCODE-ne 0){throw 'Native App identity inspection failed'}
foreach($key in @('created','handleCreated','sha256','moduleBase')){if($actual.$key-ne $record.$key){throw 'Native App identity changed'}}
$all=@(Get-CimInstance Win32_Process)
$descendants=[Collections.Generic.List[object]]::new();$frontier=@([int]$record.applicationPid)
while($frontier.Count){$children=@($all | Where-Object {$_.ParentProcessId-in $frontier});foreach($child in $children){$descendants.Add($child)};$frontier=@($children | ForEach-Object {$_.ProcessId})}
$expectedShell=[IO.Path]::GetFullPath($Shell)
$candidates=@($descendants | Where-Object {$_.ExecutablePath -and [string]::Equals($_.ExecutablePath,$expectedShell,[StringComparison]::OrdinalIgnoreCase)})
if($candidates.Count-ne 1){throw 'Expected exactly one bound native Shell descendant'}
$candidate=$candidates[0]
if((Get-FileHash -LiteralPath $candidate.ExecutablePath).Hash.ToLowerInvariant()-ne $ExpectedShellSha256){throw 'Bound native Shell image digest changed'}
$process=[Diagnostics.Process]::GetProcessById($candidate.ProcessId)
try{
  $null=$process.Handle
  if(-not [string]::Equals($process.MainModule.FileName,$expectedShell,[StringComparison]::OrdinalIgnoreCase)){throw 'Bound native Shell handle identity changed'}
  $libraries=@($process.Modules | Where-Object {$_.ModuleName-ieq 'shellspan_native_input_editors.dll'})
  if($libraries.Count-ne 1 -or -not $libraries[0].FileName.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)){throw 'Bound native module is outside the owned directory'}
  $library=$libraries[0]
  if((Get-FileHash -LiteralPath $library.FileName).Hash.ToLowerInvariant()-ne $ExpectedModuleSha256){throw 'Bound native module digest changed'}
  @{shellPid=$candidate.ProcessId;parentPid=$candidate.ParentProcessId;appPid=$record.applicationPid;created=$candidate.CreationDate.ToUniversalTime().ToString('o');handleCreated=$process.StartTime.ToUniversalTime().ToString('o');
    executable=$process.MainModule.FileName;sha256=$ExpectedShellSha256;module=$library.FileName;moduleBase=$library.BaseAddress.ToInt64().ToString('x');moduleSha256=$ExpectedModuleSha256} | ConvertTo-Json -Compress
}finally{$process.Dispose()}
