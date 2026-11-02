param([Parameter(Mandatory=$true)][string]$Config)
$ErrorActionPreference='Stop'
$settings=Get-Content -LiteralPath $Config -Raw|ConvertFrom-Json
$root=[IO.Path]::GetFullPath($settings.workspace)
$evidence=[IO.Path]::GetFullPath($settings.evidenceDirectory)
if(-not $evidence.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Evidence is outside the owned source copy'}
$runId=[guid]::Parse($settings.runId).ToString()
$result=@{runId=$runId;ok=$false;sessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId;pid=$PID;applications=@()}
$shells=@()
$node=(Get-Command node.exe).Source
$provision=if($settings.provisionDirectory){[IO.Path]::GetFullPath($settings.provisionDirectory)}else{Join-Path $evidence 'provision'}
if(-not $provision.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Credential ownership directory is outside the owned source copy'}
$cleanupExecutable=Join-Path $root 'scripts/credential-cleanup-target/debug/shellspan-p3-credential-cleanup.exe'
$cancellation=Join-Path $evidence 'cancel-owned-writers.json'
$self=[Diagnostics.Process]::GetCurrentProcess()
@{runId=$runId;pid=$PID;created=$self.StartTime.ToFileTimeUtc().ToString();executable=$self.MainModule.FileName}|ConvertTo-Json|Set-Content -Encoding utf8 (Join-Path $evidence 'worker-process.json')
function Invoke-Native([string[]]$Arguments,[string]$Name,[string]$Phase,[bool]$CleanupPhase=$false){
 if(-not $CleanupPhase-and (Test-Path $cancellation)){throw 'Owned writer cancellation requested before launch'}
 $env:SHELLSPAN_ACCEPTANCE_EVIDENCE_DIR=$Phase
 $process=Start-Process -FilePath $node -ArgumentList $Arguments -WorkingDirectory $root -WindowStyle Normal -PassThru -RedirectStandardOutput (Join-Path $Phase ($Name+'.log')) -RedirectStandardError (Join-Path $Phase ($Name+'.stderr.log'))
 @{pid=$process.Id;workerPid=$PID;created=$process.StartTime.ToFileTimeUtc().ToString();executable=$node;sessionId=$process.SessionId}|ConvertTo-Json|Set-Content -Encoding utf8 (Join-Path $Phase ($Name+'-process.json'))
 while(-not $process.WaitForExit(100)){
  if(-not $CleanupPhase-and (Test-Path $cancellation)){
   & powershell.exe -NoLogo -NoProfile -NonInteractive -File scripts/fixtures/windows-desktop-process-cleanup.ps1 -RootPid $process.Id -OwnerPid $PID -RootExecutable $node -Output (Join-Path $Phase ($Name+'-cancel-cleanup.json'))
   if($LASTEXITCODE-ne 0){throw 'Owned native writer cancellation did not verify process exit'}
   $process.WaitForExit();throw 'Owned native writer cancelled and its actual process tree exited'
  }
 }
 $process.Refresh()
 if($null-eq $process.ExitCode-or $process.ExitCode-ne 0){throw ('Actual native phase failed: '+$Name+' exit='+$process.ExitCode)}
}
try{
 Set-Location $root
 & powershell.exe -NoLogo -NoProfile -NonInteractive -File scripts/native-input-p3/windows-desktop-state.ps1 > (Join-Path $evidence 'desktop-before.json')
 if($LASTEXITCODE-ne 0-or $result.sessionId-eq 0){throw 'Actual interactive desktop unavailable'}
 $env:CARGO_TERM_COLOR='never';$env:CARGO_INCREMENTAL='0'
 $env:RUSTUP_TOOLCHAIN='1.95.0-x86_64-pc-windows-msvc'
 $env:OPENSSL_NO_VENDOR='1';$env:OPENSSL_STATIC='1';$env:OPENSSL_DIR=$settings.opensslDirectory
 foreach($entry in @(@('lib/libcrypto.lib','e2888b00e7f1b797b7a43c457d381537ba139940b177c4b142d56c4fd502af35'),@('lib/libssl.lib','27e62de9ee99139eff6b2c17493090dd243c301c44b42e3945b05b332ccde401'))){if((Get-FileHash (Join-Path $env:OPENSSL_DIR $entry[0]) -Algorithm SHA256).Hash.ToLowerInvariant()-cne $entry[1]){throw 'Verified dependency changed'}}
 $env:SHELLSPAN_ACCEPTANCE_RUN_ID=$runId;$env:SHELLSPAN_NATIVE_WORKSPACE=$root
 $env:SHELLSPAN_P3_BUILD_CACHE=[IO.Path]::GetFullPath($settings.cargoTargetDirectory)
 $configuredModules=@([Environment]::GetEnvironmentVariable('PSModulePath','User'),[Environment]::GetEnvironmentVariable('PSModulePath','Machine'))|Where-Object {$_}
 if($configuredModules.Count){$env:PSModulePath=$configuredModules-join ';'}else{Remove-Item Env:PSModulePath -ErrorAction SilentlyContinue}
 & $node scripts/native-input-p3/desktop-evidence.mjs before $evidence
 if($LASTEXITCODE-ne 0){throw 'Complete source freeze failed'}
 & $node scripts/fixtures/windows-desktop-data-audit.mjs (Join-Path $evidence 'user-data-before.json')
 if($LASTEXITCODE-ne 0){throw 'Original data audit failed'}
 # Build deletion support before any credential is received. Native progress on
 # stderr is not a PowerShell terminating error; its actual exit code is checked.
 $ErrorActionPreference='Continue'
 & cargo.exe build --locked --manifest-path scripts/native-input-p3/credential-cleanup/Cargo.toml --target-dir scripts/credential-cleanup-target *> (Join-Path $evidence 'credential-cleanup-build.log')
 $buildCode=$LASTEXITCODE;$ErrorActionPreference='Stop'
 if($buildCode-ne 0-or -not (Test-Path $cleanupExecutable)){throw 'Actual credential cleanup build failed'}
 if(-not $settings.recoveryOnly){
 $shells=@(@{kind='powerShell7';executable='D:\Programs\PowerShell\7\pwsh.exe'},@{kind='windowsPowerShell';executable=(Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe')})
 if($settings.shellKinds){foreach($kind in $settings.shellKinds){if($kind-notin @('powerShell7','windowsPowerShell')){throw 'Unknown actual shell kind'}};$shells=@($shells|Where-Object {$_.kind-in $settings.shellKinds});if(-not $shells.Count){throw 'At least one actual shell is required'}}
 foreach($shell in $shells){
  $phase=Join-Path $root ('.artifacts/tests/native-input-p2/'+$(if($shell.kind-eq 'windowsPowerShell'){'w51-'}else{'w7-'})+$runId);New-Item -ItemType Directory -Path $phase|Out-Null
  $shell.phase=$phase;$env:SHELLSPAN_LOCAL_SHELL=$shell.executable;$env:SHELLSPAN_DATA_DIR=Join-Path $phase 'data'
  & $shell.executable -NoLogo -NoProfile -NonInteractive -File scripts/fixtures/windows-shell-history-metadata.ps1 -Output (Join-Path $phase 'history-before.json')
  if($LASTEXITCODE-ne 0){throw 'Actual selected shell history discovery failed'}
  $shell.historyCaptured=$true
  Invoke-Native @('scripts/verify-ai-session-stream.mjs','--data-initialize','--no-model','--data-scope','com.shellspan.validation.native-input-p3') 'initialize' $phase
  $publisherArguments=@(if($shell.kind-eq 'windowsPowerShell'){'--native-input-p3-publisher-run-once'})
  if($settings.startupDiagnostics){$publisherArguments+=@('--native-input-p3-startup-diagnostic')}
  if(-not $settings.startupOnly){$publisherArguments+=@('--native-input-p3-require-jobs')}
  if($settings.startupDiagnostics){$env:SHELLSPAN_P3_STARTUP_DIAGNOSTIC='1'}else{Remove-Item Env:SHELLSPAN_P3_STARTUP_DIAGNOSTIC -ErrorAction SilentlyContinue}
  Invoke-Native (@('scripts/verify-ai-session-stream.mjs','--data-scope','com.shellspan.validation.native-input-p3','--no-model','--native-input-p3-startup',$shell.kind)+$publisherArguments) 'startup' $phase
 }
 if(-not $settings.startupOnly){
 New-Item -ItemType Directory -Path $provision|Out-Null
 $env:SHELLSPAN_DATA_DIR=Join-Path $provision 'data'
 Invoke-Native @('scripts/verify-ai-session-stream.mjs','--data-initialize','--no-model','--data-scope','com.shellspan.validation.native-input-p3') 'initialize' $provision
 & $node scripts/native-input-p3/credential-ownership.mjs baseline $provision $runId $settings.routeDatabase > (Join-Path $provision 'baseline.log')
 if($LASTEXITCODE-ne 0){throw 'Actual empty credential baseline failed'}
 $env:SHELLSPAN_P3_ROUTE_SOURCE=$settings.routeDatabase
 Invoke-Native @('scripts/verify-ai-session-stream.mjs','--data-initialize','--no-model','--data-scope','com.shellspan.validation.native-input-p3','--native-input-p3-credential','destination') 'receive' $provision
 & $node scripts/native-input-p3/credential-ownership.mjs recover $provision $runId $settings.routeDatabase > (Join-Path $provision 'ownership-check.log')
 if($LASTEXITCODE-ne 0){throw 'Actual saved credential ownership check failed'}
 $ownership=Get-Content (Join-Path $provision 'credential-recovery.json') -Raw|ConvertFrom-Json
 if($ownership.references.Count-ne 1-or -not $ownership.references[0].committed-or -not $ownership.references[0].normalApiReceipt){throw 'Normal API credential receipt and exclusive database differ'}
 foreach($shell in $shells){
  $phase=$shell.phase
  $env:SHELLSPAN_LOCAL_SHELL=$shell.executable
  try{
   $env:SHELLSPAN_DATA_DIR=Join-Path $phase 'data'
   & $node scripts/fixtures/windows-desktop-data.mjs (Join-Path $provision 'data/shellspan-main.db') $env:SHELLSPAN_DATA_DIR > (Join-Path $phase 'route-import.json')
   if($LASTEXITCODE-ne 0){throw 'Only owned route reference import failed'}
   $publisherArguments=@(if($shell.kind-eq 'windowsPowerShell'){'--native-input-p3-publisher-run-once'})
   Invoke-Native (@('scripts/verify-ai-session-stream.mjs','--data-scope','com.shellspan.validation.native-input-p3','--native-jobs','--native-input-p3',$shell.kind,'--native-jobs-powershell',$shell.kind)+$publisherArguments) 'application' $phase
   $result.applications+=@{kind=$shell.kind;ok=$true}
  }catch{$result.applications+=@{kind=$shell.kind;ok=$false;error=$_.Exception.Message}}
 }
 $result.ok=(@($result.applications|Where-Object {-not $_.ok}).Count-eq 0)
 if($result.ok){$result.exitCode=0}
 }else{$result.ok=$true;$result.exitCode=0;$result.startupOnly=$true}
 }else{$result.ok=$true;$result.exitCode=0}
}catch{$result.error=$_.Exception.Message}
finally{
 try{
  foreach($shell in @($shells|Where-Object {$_.historyCaptured})){
   $phase=$shell.phase
   & $shell.executable -NoLogo -NoProfile -NonInteractive -File scripts/fixtures/windows-shell-history-metadata.ps1 -Output (Join-Path $phase 'history-after.json')
   if($LASTEXITCODE-ne 0){throw 'Selected shell history final audit failed'}
   $before=Get-Content (Join-Path $phase 'history-before.json') -Raw|ConvertFrom-Json
   $after=Get-Content (Join-Path $phase 'history-after.json') -Raw|ConvertFrom-Json
   foreach($field in @('historyPath','engine','module','exists','sha256','bytes','lastWriteTimeUtc')){if($before.$field-ne $after.$field){throw ('Original shell history changed: '+$field)}}
  }
  if(@($shells|Where-Object {$_.historyCaptured}).Count-gt 0){$result.shellHistoryUnchanged=$true}
 }catch{$result.ok=$false;$result.historyAuditError=$_.Exception.Message}
 try{
  if(Test-Path (Join-Path $provision 'credential-baseline.json')){
   & $node scripts/native-input-p3/credential-ownership.mjs recover $provision $runId $settings.routeDatabase > (Join-Path $provision 'cleanup-recovery.log')
   if($LASTEXITCODE-ne 0){throw 'Actual credential recovery failed'}
   $recovery=Get-Content (Join-Path $provision 'credential-recovery.json') -Raw|ConvertFrom-Json
   foreach($owned in $recovery.references){
    & $cleanupExecutable delete $owned.file > (Join-Path $provision ('cleanup-'+$owned.reference+'.json'))
    if($LASTEXITCODE-ne 0){throw 'Owned OS credential deletion failed'}
    if($owned.committed){
     $phase=Join-Path $evidence 'verify-absence';New-Item -ItemType Directory -Path $phase|Out-Null
     $env:SHELLSPAN_DATA_DIR=Join-Path $phase 'data';$env:SHELLSPAN_P3_CREDENTIAL_OWNERSHIP=$owned.file
     Invoke-Native @('scripts/verify-ai-session-stream.mjs','--data-initialize','--no-model','--data-scope','com.shellspan.validation.native-input-p3') 'initialize' $phase $true
     & $node scripts/fixtures/windows-desktop-data.mjs (Join-Path $provision 'data/shellspan-main.db') $env:SHELLSPAN_DATA_DIR > (Join-Path $phase 'route-import.json')
     if($LASTEXITCODE-ne 0){throw 'Owned route reference import for absence check failed'}
     Invoke-Native @('scripts/verify-ai-session-stream.mjs','--data-initialize','--no-model','--data-scope','com.shellspan.validation.native-input-p3','--native-input-p3-credential','verify-absence') 'absence' $phase $true
    }
   }
   $result.credentialCleanupVerified=$true
  }else{$result.credentialCleanupVerified=$true;$result.credentialNeverRequested=$true}
 }catch{$result.ok=$false;$result.credentialCleanupError=$_.Exception.Message}
 try{
  & $node scripts/native-input-p3/desktop-evidence.mjs after $evidence
  if($LASTEXITCODE-ne 0){throw 'Complete source final verification failed'}
  & $node scripts/fixtures/windows-desktop-data-audit.mjs (Join-Path $evidence 'user-data-after.json')
  if($LASTEXITCODE-ne 0-or (Get-FileHash (Join-Path $evidence 'user-data-before.json')).Hash-ne (Get-FileHash (Join-Path $evidence 'user-data-after.json')).Hash){throw 'Original user data changed'}
  $result.originalUserDataUnchanged=$true
 }catch{$result.ok=$false;$result.auditError=$_.Exception.Message}
 $result.completedAt=(Get-Date).ToUniversalTime().ToString('o')
 $result|ConvertTo-Json -Depth 8|Set-Content -Encoding utf8 (Join-Path $evidence 'worker-result.pending.json')
 Move-Item (Join-Path $evidence 'worker-result.pending.json') (Join-Path $evidence 'worker-result.json')
}
if(-not $result.ok){exit 1}
