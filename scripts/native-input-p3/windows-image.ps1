param(
  [Parameter(Mandatory=$true)][ValidateSet('Inspect','Stop')][string]$Action,
  [Parameter(Mandatory=$true)][int]$ApplicationPid,
  [Parameter(Mandatory=$true)][int]$RunnerPid,
  [Parameter(Mandatory=$true)][string]$Executable
)
$ErrorActionPreference='Stop'
$application=Get-CimInstance Win32_Process -Filter ('ProcessId='+$ApplicationPid)
if(-not $application -or $application.ParentProcessId-ne $RunnerPid -or
  -not [string]::Equals($application.ExecutablePath,[IO.Path]::GetFullPath($Executable),[StringComparison]::OrdinalIgnoreCase)){
  throw 'Owned native image process identity changed'
}
$runner=Get-CimInstance Win32_Process -Filter ('ProcessId='+$RunnerPid)
if(-not $runner -or $runner.Name-ne 'node.exe'){throw 'Owned native image runner is absent'}
$result=@{applicationPid=$ApplicationPid;runnerPid=$RunnerPid;executable=$application.ExecutablePath;
  created=$application.CreationDate.ToUniversalTime().ToString('o');sessionId=$application.SessionId;
  sha256=(Get-FileHash -LiteralPath $Executable -Algorithm SHA256).Hash.ToLowerInvariant()}
if($Action-eq 'Inspect'){
  # A pwsh caller may carry its own module directory into this 5.1 process.
  # Inspect with this host's built-in security module, never an incompatible
  # auto-loaded module from a different PowerShell engine.
  Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
  $signature=Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $Executable
  $result.signatureStatus=[string]$signature.Status
  $result.signerThumbprint=if($signature.SignerCertificate){$signature.SignerCertificate.Thumbprint}else{$null}
}
if($Action-eq 'Stop'){
  # Terminate only this verified application and its own descendants. The Node
  # runner stays alive to verify sources, assets and PE bytes after real exit.
  & taskkill.exe /PID $ApplicationPid /T /F 2>&1 | Out-Null
  if($LASTEXITCODE-ne 0){throw 'Owned native image cleanup failed'}
}
$result | ConvertTo-Json -Depth 3 -Compress
