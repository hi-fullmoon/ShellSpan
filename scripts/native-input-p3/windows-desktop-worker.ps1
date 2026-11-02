param([Parameter(Mandatory=$true)][string]$Config)
$ErrorActionPreference='Stop'
$settings=Get-Content -LiteralPath $Config -Raw|ConvertFrom-Json
$root=[IO.Path]::GetFullPath($settings.workspace)
$evidence=[IO.Path]::GetFullPath($settings.evidenceDirectory)
if(-not $evidence.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Evidence is outside the owned source copy'}
$result=@{runId=[guid]::Parse($settings.runId).ToString();ok=$false;sessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId;pid=$PID}
$node=(Get-Command node.exe).Source
function Invoke-Native([string[]]$Arguments,[string]$Name){
  $process=Start-Process -FilePath $node -ArgumentList $Arguments -WorkingDirectory $root -WindowStyle Normal -PassThru -RedirectStandardOutput (Join-Path $evidence ($Name+'.log')) -RedirectStandardError (Join-Path $evidence ($Name+'.stderr.log'))
  @{pid=$process.Id;workerPid=$PID;sessionId=$process.SessionId}|ConvertTo-Json|Set-Content -Encoding utf8 (Join-Path $evidence ($Name+'-process.json'))
  $process.WaitForExit()
  if($null-eq $process.ExitCode-or $process.ExitCode-ne 0){throw ('Actual native phase failed: '+$Name+' exit='+$process.ExitCode)}
}
try{
  Set-Location $root
  & powershell.exe -NoLogo -NoProfile -NonInteractive -File scripts/native-input-p3/windows-desktop-state.ps1 > (Join-Path $evidence 'desktop-before.json')
  if($LASTEXITCODE-ne 0){throw 'Actual interactive input desktop unavailable'}
  $env:CARGO_TERM_COLOR='never'
  $env:RUSTUP_TOOLCHAIN='1.95.0-x86_64-pc-windows-msvc'
  $env:OPENSSL_NO_VENDOR='1';$env:OPENSSL_STATIC='1';$env:OPENSSL_DIR=$settings.opensslDirectory
  foreach($entry in @(@('lib/libcrypto.lib','e2888b00e7f1b797b7a43c457d381537ba139940b177c4b142d56c4fd502af35'),@('lib/libssl.lib','27e62de9ee99139eff6b2c17493090dd243c301c44b42e3945b05b332ccde401'))){
    if((Get-FileHash (Join-Path $env:OPENSSL_DIR $entry[0]) -Algorithm SHA256).Hash.ToLowerInvariant()-cne $entry[1]){throw 'Verified third-party dependency cache changed'}
  }
  $env:SHELLSPAN_DATA_DIR=Join-Path $evidence 'data'
  $env:SHELLSPAN_ACCEPTANCE_EVIDENCE_DIR=$evidence
  $env:SHELLSPAN_LOCAL_SHELL=$settings.shellExecutable
  $env:SHELLSPAN_ACCEPTANCE_RUN_ID=$result.runId
  $env:SHELLSPAN_NATIVE_WORKSPACE=$root
  # Remove only this fixture worker's pwsh-created process augmentation. Child
  # hosts then construct their normal engine-specific paths from OS settings.
  $configuredModules=@([Environment]::GetEnvironmentVariable('PSModulePath','User'),[Environment]::GetEnvironmentVariable('PSModulePath','Machine'))|Where-Object {$_}
  if($configuredModules.Count){$env:PSModulePath=$configuredModules-join ';'}else{Remove-Item Env:PSModulePath -ErrorAction SilentlyContinue}
  if($settings.cargoTargetDirectory){$env:SHELLSPAN_P3_BUILD_CACHE=[IO.Path]::GetFullPath($settings.cargoTargetDirectory)}
  & $node scripts/native-input-p3/desktop-evidence.mjs before $evidence
  if($LASTEXITCODE-ne 0){throw 'Complete source freeze failed'}
  & $settings.shellExecutable -NoLogo -NoProfile -NonInteractive -File scripts/fixtures/windows-shell-history-metadata.ps1 -Output (Join-Path $evidence 'selected-shell-history-before.json')
  if($LASTEXITCODE-ne 0){throw 'Actual selected-shell history discovery failed'}
  $historyBefore=Get-Content (Join-Path $evidence 'selected-shell-history-before.json') -Raw|ConvertFrom-Json
  $env:SHELLSPAN_AUDIT_HISTORY_FILE=$historyBefore.historyPath
  & $node scripts/fixtures/windows-desktop-data-audit.mjs (Join-Path $evidence 'user-data-before.json')
  if($LASTEXITCODE-ne 0){throw 'Read-only original data audit failed'}
  Invoke-Native @('scripts/verify-ai-session-stream.mjs','--data-initialize','--no-model','--data-scope','com.shellspan.validation.native-input-p3') 'initialize'
  & $node scripts/fixtures/windows-desktop-data.mjs $settings.routeDatabase $env:SHELLSPAN_DATA_DIR > (Join-Path $evidence 'route-import.json')
  if($LASTEXITCODE-ne 0){throw 'Current route reference import failed'}
  $arguments=@('scripts/verify-ai-session-stream.mjs','--data-scope','com.shellspan.validation.native-input-p3','--native-jobs','--native-input-p3',$settings.shellKind,'--native-jobs-powershell',$settings.shellKind)
  if($settings.focus){$arguments+='--native-jobs-focus'}
  if($settings.narrow){$arguments+='--native-jobs-narrow'}
  Invoke-Native $arguments 'application'
  $result.exitCode=0;$result.ok=$true
}catch{$result.error=$_.Exception.Message}
finally{
  try{
    & $node scripts/native-input-p3/desktop-evidence.mjs after $evidence
    if($LASTEXITCODE-ne 0){throw 'Complete source end verification failed'}
    & $settings.shellExecutable -NoLogo -NoProfile -NonInteractive -File scripts/fixtures/windows-shell-history-metadata.ps1 -Output (Join-Path $evidence 'selected-shell-history-after.json')
    if($LASTEXITCODE-ne 0){throw 'Selected shell history final audit failed'}
    $historyAfter=Get-Content (Join-Path $evidence 'selected-shell-history-after.json') -Raw|ConvertFrom-Json
    if(-not $historyBefore-or $historyBefore.historyPath-ne $historyAfter.historyPath-or $historyBefore.exists-ne $historyAfter.exists-or $historyBefore.sha256-ne $historyAfter.sha256-or $historyBefore.bytes-ne $historyAfter.bytes-or $historyBefore.lastWriteTimeUtc-ne $historyAfter.lastWriteTimeUtc){throw 'Original selected shell history changed'}
    & $node scripts/fixtures/windows-desktop-data-audit.mjs (Join-Path $evidence 'user-data-after.json')
    if($LASTEXITCODE-ne 0){throw 'Original data final audit failed'}
    if((Get-FileHash (Join-Path $evidence 'user-data-before.json')).Hash-ne (Get-FileHash (Join-Path $evidence 'user-data-after.json')).Hash){throw 'Original user data changed'}
    $result.originalUserDataUnchanged=$true
  }catch{$result.ok=$false;$result.auditError=$_.Exception.Message}
  $result.completedAt=(Get-Date).ToUniversalTime().ToString('o')
  $result|ConvertTo-Json -Depth 5|Set-Content -Encoding utf8 (Join-Path $evidence 'worker-result.pending.json')
  Move-Item (Join-Path $evidence 'worker-result.pending.json') (Join-Path $evidence 'worker-result.json')
}
if(-not $result.ok){exit 1}
