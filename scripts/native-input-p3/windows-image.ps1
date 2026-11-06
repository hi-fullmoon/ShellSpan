param(
  [Parameter(Mandatory=$true)][ValidateSet('Inspect','Stop','Crash')][string]$Action,
  [Parameter(Mandatory=$true)][int]$ApplicationPid,
  [Parameter(Mandatory=$true)][int]$RunnerPid,
  [Parameter(Mandatory=$true)][string]$Executable,
  [string]$ExpectedCreated,
  [string]$ExpectedHandleCreated,
  [string]$ExpectedSha256
)
$ErrorActionPreference='Stop'
if($Action-eq 'Crash' -and (-not $ExpectedCreated -or -not $ExpectedHandleCreated -or $ExpectedSha256-notmatch '^[a-f0-9]{64}$')){
  throw 'Crash requires the inspected creation times and PE digest'
}
# A pwsh caller can inherit a module path for a different engine. Bind this
# helper's own system modules before inspecting or hashing the owned image.
foreach($module in @('CimCmdlets','Microsoft.PowerShell.Utility','Microsoft.PowerShell.Security')){
  Import-Module (Join-Path $PSHOME ('Modules/'+$module+'/'+$module+'.psd1')) -ErrorAction Stop
}
$application=Get-CimInstance Win32_Process -Filter ('ProcessId='+$ApplicationPid)
if(-not $application -and $Action-eq 'Stop'){
  # An already exited process has nothing left to terminate. A live PID still
  # goes through the full parent/executable checks below, including PID reuse.
  @{applicationPid=$ApplicationPid;runnerPid=$RunnerPid;alreadyExited=$true}|ConvertTo-Json -Compress
  exit 0
}
if(-not $application -or $application.ParentProcessId-ne $RunnerPid -or
  -not [string]::Equals($application.ExecutablePath,[IO.Path]::GetFullPath($Executable),[StringComparison]::OrdinalIgnoreCase)){
  throw 'Owned native image process identity changed'
}
$runner=Get-CimInstance Win32_Process -Filter ('ProcessId='+$RunnerPid)
if(-not $runner -or $runner.Name-ne 'node.exe'){throw 'Owned native image runner is absent'}
$result=@{applicationPid=$ApplicationPid;runnerPid=$RunnerPid;executable=$application.ExecutablePath;
  created=$application.CreationDate.ToUniversalTime().ToString('o');sessionId=$application.SessionId;
  sha256=(Get-FileHash -LiteralPath $Executable -Algorithm SHA256).Hash.ToLowerInvariant()}
if($Action-eq 'Crash'){
  if($result.created-ne $ExpectedCreated -or $result.sha256-ne $ExpectedSha256){throw 'Owned crash image identity changed'}
  $target=[Diagnostics.Process]::GetProcessById($ApplicationPid)
  try{
    $null=$target.Handle
    $result.handleCreated=$target.StartTime.ToUniversalTime().ToString('o')
    if($result.handleCreated-ne $ExpectedHandleCreated -or
      -not [string]::Equals($target.MainModule.FileName,[IO.Path]::GetFullPath($Executable),[StringComparison]::OrdinalIgnoreCase)){
      throw 'Owned crash process handle identity changed'
    }
    # Kill this exact application without graceful shutdown or a tree-wide
    # taskkill. The runner survives to verify PE/source bytes after the crash.
    $target.Kill()
  }finally{$target.Dispose()}
  $result.crashRequested=$true
  $result.descendantsTerminatedByHelper=$false
}
if($Action-eq 'Inspect'){
  $inspected=[Diagnostics.Process]::GetProcessById($ApplicationPid)
  try{
    $null=$inspected.Handle
    if(-not [string]::Equals($inspected.MainModule.FileName,[IO.Path]::GetFullPath($Executable),[StringComparison]::OrdinalIgnoreCase)){
      throw 'Owned inspected process handle identity changed'
    }
    # CIM rounds creation timestamps to microseconds. Preserve the independent
    # handle timestamp exactly instead of comparing different precisions.
    $result.handleCreated=$inspected.StartTime.ToUniversalTime().ToString('o')
    $result.moduleBase=$inspected.MainModule.BaseAddress.ToInt64().ToString('x')
  }finally{$inspected.Dispose()}
  # A pwsh caller may carry its own module directory into this 5.1 process.
  # Inspect with this host's built-in security module, never an incompatible
  # auto-loaded module from a different PowerShell engine.
  $signature=Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $Executable
  $result.signatureStatus=[string]$signature.Status
  $result.signerThumbprint=if($signature.SignerCertificate){$signature.SignerCertificate.Thumbprint}else{$null}
}
if($Action-eq 'Stop'){
  # Terminate only this verified application and its own descendants. The Node
  # runner stays alive to verify sources, assets and PE bytes after real exit.
  $target=[Diagnostics.Process]::GetProcessById($ApplicationPid)
  try{
    $null=$target.Handle
    if([Math]::Abs($target.StartTime.ToFileTimeUtc()-$application.CreationDate.ToFileTimeUtc())-ge10-or
      -not [string]::Equals($target.MainModule.FileName,[IO.Path]::GetFullPath($Executable),[StringComparison]::OrdinalIgnoreCase)){
      throw 'Owned stop process handle identity changed'
    }
    # Keep the root handle pinned while the shared cleanup helper excludes
    # older PID aliases and pins every descendant before any termination.
    & (Join-Path (Split-Path -Parent $PSScriptRoot) 'fixtures/windows-desktop-process-cleanup.ps1') -RootPid $ApplicationPid -OwnerPid $RunnerPid -RootExecutable $Executable
    $result.treeKillUsed=$false
    $result.termination='verified-process-handles'
  }finally{$target.Dispose()}
}
$result | ConvertTo-Json -Depth 3 -Compress
