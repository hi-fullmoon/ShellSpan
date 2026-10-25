param([Parameter(Mandatory=$true)][string]$Config)
$ErrorActionPreference = 'Stop'
$settings = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
$root = [IO.Path]::GetFullPath($settings.workspace)
$evidence = [IO.Path]::GetFullPath($settings.evidenceDirectory)
if (-not $evidence.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Evidence must belong to owned workspace' }
New-Item -ItemType Directory -Force -Path $evidence | Out-Null
$result = @{ runId=[guid]::Parse($settings.runId).ToString(); ok=$false; sessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId; pid=$PID }
$settings | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 (Join-Path $evidence 'run-config.json')
function Save-WorkerStage([string]$Stage) {
    @{stage=$Stage;at=(Get-Date).ToUniversalTime().ToString('o');pid=$PID;sessionId=$result.sessionId}|ConvertTo-Json|Set-Content -Encoding utf8 (Join-Path $evidence 'worker-stage.json')
}
function Invoke-OwnedNativeNode([string[]]$Arguments,[string]$LogName) {
    # Keep the validation CLI's console teardown separate from this worker,
    # so a failed App still reaches the audit/result finally block.
    $process=Start-Process -FilePath $node -ArgumentList $Arguments -WorkingDirectory $root -WindowStyle Normal -PassThru -RedirectStandardOutput (Join-Path $evidence ($LogName+'.log')) -RedirectStandardError (Join-Path $evidence ($LogName+'.stderr.log'))
    @{pid=$process.Id;sessionId=$process.SessionId;workerPid=$PID;separateConsole=$true}|ConvertTo-Json|Set-Content -Encoding utf8 (Join-Path $evidence ($LogName+'-process.json'))
    $process.WaitForExit()
    if($null-eq $process.ExitCode){throw 'Owned native CLI exit code unavailable'}
    return $process.ExitCode
}
try {
    if ($result.sessionId -eq 0) { throw 'Desktop acceptance must run in the logged-in interactive session' }
    Set-Location $root
    $env:CARGO_TERM_COLOR = 'never'
    $env:RUSTUP_TOOLCHAIN = '1.95.0-x86_64-pc-windows-msvc'
    $env:OPENSSL_NO_VENDOR = '1'
    $env:OPENSSL_STATIC = '1'
    $env:OPENSSL_DIR = Join-Path $root 'dependency-cache\openssl-3.6.3-msvc-x64'
    $env:SHELLSPAN_DATA_DIR = Join-Path $evidence 'data'
    $env:SHELLSPAN_ACCEPTANCE_EVIDENCE_DIR = $evidence
    $env:SHELLSPAN_LOCAL_SHELL = $settings.shellExecutable
    $env:SHELLSPAN_ACCEPTANCE_RUN_ID = $result.runId
    $env:SHELLSPAN_NATIVE_WORKSPACE = $root
    $rollout = if ($settings.nativeJobsOverride) { [string]$settings.nativeJobsOverride } else { '1' }
    if ($rollout -notin @('1','0','default')) { throw 'Invalid controlled native jobs rollout setting' }
    if ($rollout -eq 'default') { Remove-Item Env:SHELLSPAN_NATIVE_POWERSHELL_JOBS -ErrorAction SilentlyContinue }
    else { $env:SHELLSPAN_NATIVE_POWERSHELL_JOBS = $rollout }
    $result.nativeJobsOverride = $rollout
    $node = (Get-Command node.exe).Source
    Save-WorkerStage 'source-freeze'
    & $node scripts/fixtures/windows-desktop-evidence.mjs before $evidence
    if($LASTEXITCODE-ne 0){throw 'Desktop source freeze failed'}
    Save-WorkerStage 'selected-history-before'
    & $settings.shellExecutable -NoLogo -NoProfile -NonInteractive -File scripts/fixtures/windows-shell-history-metadata.ps1 -Output (Join-Path $evidence 'selected-shell-history-before.json')
    if($LASTEXITCODE-ne 0){throw 'Selected native shell history discovery failed'}
    $historyBefore=Get-Content (Join-Path $evidence 'selected-shell-history-before.json') -Raw|ConvertFrom-Json
    $env:SHELLSPAN_AUDIT_HISTORY_FILE=$historyBefore.historyPath
    Save-WorkerStage 'original-data-before'
    & $node scripts/fixtures/windows-desktop-data-audit.mjs (Join-Path $evidence 'user-data-before.json')
    if ($LASTEXITCODE -ne 0) { throw 'Original user data audit failed' }
    Save-WorkerStage 'native-data-initialize'
    $initializeExit=Invoke-OwnedNativeNode @('scripts/verify-ai-session-stream.mjs','--data-initialize','--no-model','--data-scope','com.shellspan.validation.windows-stage4') 'native-data-initialize'
    if($initializeExit-ne 0){throw ('Actual native data initialization failed: '+$initializeExit)}
    & $node scripts/fixtures/windows-desktop-evidence.mjs initialized $evidence
    if($LASTEXITCODE-ne 0){throw 'Initialized native executable evidence failed'}
    $ErrorActionPreference='Continue'
    & $node scripts/fixtures/windows-desktop-data.mjs $settings.routeDatabase $env:SHELLSPAN_DATA_DIR *> (Join-Path $evidence 'data-import.log')
    $importExit = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($importExit -ne 0) { throw ('Secret-free route import failed: ' + $importExit) }
    $arguments=@('scripts/verify-ai-session-stream.mjs','--data-scope','com.shellspan.validation.windows-stage4')
    if($settings.mode-eq 'contention'){$arguments+='--terminal-contention'}
    elseif($settings.mode-eq 'composer-input'){$arguments+=@('--terminal-contention','--no-model','--composer-input-diagnostic')}
    elseif($settings.mode-eq 'close'){$arguments+=@('--terminal-contention','--no-model')}
    elseif($settings.mode-eq 'reconnect'){$arguments+=@('--terminal-reconnect','--no-model')}
    else {
        $arguments+=@('--native-jobs','--native-jobs-powershell',$settings.shellKind)
        if ($settings.focus) { $arguments += '--native-jobs-focus' }
        if ($settings.direct) { $arguments += '--native-jobs-direct' }
        if ($settings.narrow) { $arguments += '--native-jobs-narrow' }
    }
    Save-WorkerStage 'native-model'
    $exitCode=Invoke-OwnedNativeNode $arguments 'native-model'
    $result.exitCode = $exitCode
    $result.ok = $exitCode -eq 0
} catch { $result.error = $_.Exception.Message }
finally {
    Save-WorkerStage 'final-audit'
    try { if ($node) {
        & $node scripts/fixtures/windows-desktop-evidence.mjs after $evidence
        if($LASTEXITCODE-ne 0){throw 'Desktop source or executable evidence failed'}
        & $settings.shellExecutable -NoLogo -NoProfile -NonInteractive -File scripts/fixtures/windows-shell-history-metadata.ps1 -Output (Join-Path $evidence 'selected-shell-history-after.json')
        if($LASTEXITCODE-ne 0){throw 'Selected native shell final history audit failed'}
        $historyAfter=Get-Content (Join-Path $evidence 'selected-shell-history-after.json') -Raw|ConvertFrom-Json
        if(-not $historyBefore-or $historyBefore.historyPath-ne $historyAfter.historyPath-or $historyBefore.exists-ne $historyAfter.exists-or $historyBefore.sha256-ne $historyAfter.sha256-or $historyBefore.bytes-ne $historyAfter.bytes-or $historyBefore.lastWriteTimeUtc-ne $historyAfter.lastWriteTimeUtc){throw 'Selected original shell history metadata changed'}
        & $node scripts/fixtures/windows-desktop-data-audit.mjs (Join-Path $evidence 'user-data-after.json')
        if ($LASTEXITCODE -ne 0) { $result.ok=$false; $result.auditError='Final original user data audit failed' }
        elseif ((Get-FileHash (Join-Path $evidence 'user-data-before.json')).Hash -ne (Get-FileHash (Join-Path $evidence 'user-data-after.json')).Hash) {
            $result.ok=$false; $result.auditError='Original user data changed; inspect hash-only audit'
        } else { $result.originalUserDataUnchanged=$true }
    } } catch { $result.ok=$false; $result.auditError='Original user data audit could not be completed' }
    $result.completedAt = (Get-Date).ToUniversalTime().ToString('o')
    $pending = Join-Path $evidence 'worker-result.pending.json'
    $result | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 $pending
    Move-Item -LiteralPath $pending -Destination (Join-Path $evidence 'worker-result.json')
}
if (-not $result.ok) { exit 1 }
