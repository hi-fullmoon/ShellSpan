# Fixed complete SYSTEM materialization; no accounts, grants or tools.
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$prototype = Join-Path $workspace 'tests/windows-sandbox-account/target/debug/shellspan-account-sandbox-prototype.exe'
$evidence = Join-Path $workspace 'docs/design/evidence'
$prefix = 'windows-stage-a-2026-10-10-frontend-source-failure-system'
$invocation = Join-Path $evidence ($prefix + '-invocation.txt')
if (Test-Path -LiteralPath $invocation) { throw 'Existing invocation; do not repeat.' }
$reservation = [IO.File]::Open((Join-Path $evidence ($prefix + '-started.txt')), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try {
    $started = [Text.Encoding]::UTF8.GetBytes(('wrapper_pid={0}; started_utc={1:o}' -f $PID, [DateTime]::UtcNow))
    $reservation.Write($started, 0, $started.Length)
    $reservation.Flush($true)
} finally { $reservation.Dispose() }
function Save-FixedEvidence([string]$suffix, $value) {
    $path = Join-Path $evidence ($prefix + '-' + $suffix + '.json')
    if (Test-Path -LiteralPath $path) { throw 'Existing evidence; do not overwrite.' }
    $value | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $path -Encoding utf8
}
try {
    $targetDrive = [IO.DriveInfo]::new('C:/')
    if ($targetDrive.DriveFormat -ne 'NTFS' -or $targetDrive.AvailableFreeSpace -lt 2GB) { throw 'Fixed materialization requires NTFS and at least 2 GiB free; no service prepared.' }
    $preparation = (& $prototype --prepare-owned-system-frontend-source-workload-failure | Out-String) | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or -not $preparation.fixed_frontend_materialization -or (-not $preparation.frontend_materialization_source) -or (-not $preparation.frontend_source_workload_failure) -or $preparation.fixed_frontend_journal -or $preparation.fixed_workload -or $preparation.production -ne 'unavailable') { throw 'Unexpected materialization preparation.' }
    Save-FixedEvidence 'preparation' $preparation
    $id = [Guid]::Parse($preparation.fixture_id)
    if ($id -eq [Guid]::Empty) { throw 'Empty fixture identity.' }
    $service = (& $prototype --run-owned-system-admission $id.ToString() | Out-String) | ConvertFrom-Json
    $serviceExit = $LASTEXITCODE
    Save-FixedEvidence 'service' $service
    if ($serviceExit -ne 0 -or -not $service.service_removed -or -not $service.observed_service_exit.process_exit_confirmed) { throw 'Service retirement unconfirmed; retain debt and do not restart.' }
    $serviceRoot = Join-Path 'C:/ProgramData' ('ShellSpan-system-admission-A-' + $id.ToString())
    $diagnostic = Get-Content -LiteralPath (Join-Path $serviceRoot 'service-result.json') -Raw | ConvertFrom-Json
    Save-FixedEvidence 'diagnostic' $diagnostic
    if ($diagnostic.fixture_id -ne $id.ToString() -or $diagnostic.system_context_verified -ne $true -or $diagnostic.diagnostic_error -ne 'fixed source workload failure after complete checkpoints') { throw 'Expected fixed failure not observed; retain debt.' }
    if ($service.observed_service_exit.win32_exit_code -eq 0 -and $service.observed_service_exit.service_specific_exit_code -eq 0) { throw 'Fault service incorrectly reported success.' }
    $root = Join-Path 'C:/ProgramData' ('ShellSpan-account-profile-A-' + $id.ToString())
    $anchor = Get-Content -LiteralPath (Join-Path $root 'ownership.json') -Raw | ConvertFrom-Json
    Save-FixedEvidence 'anchor' $anchor
    if ($anchor.fixture_id -ne $id.ToString() -or $anchor.backend -ne 'fixed-frontend-source-materialization-v1' -or $anchor.namespace_root -ne 'frontend-source' -or $anchor.creation_stamp_version -ne 1 -or $anchor.journal_prepared -ne $true -or $anchor.phase -ne 'failed; execution forbidden' -or $anchor.permissions_granted -or $anchor.accounts_created -or $anchor.filters_installed -or -not (Test-Path -LiteralPath (Join-Path $root 'frontend-source'))) { throw 'Expected owned failed namespace differs.' }
    $pages = @(Get-ChildItem -LiteralPath $root -Filter 'frontend-bundle-page-*.json')
    $records = @($pages | ForEach-Object { (Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json).records })
    if ($pages.Count -ne $anchor.pages -or $records.Count -ne $anchor.objects -or @($records | Where-Object state -ne 'applied').Count -ne 0) { throw 'Complete applied checkpoints not confirmed.' }
    Save-FixedEvidence 'failed-audit' ([ordered]@{ fixture_id=$id.ToString(); objects_applied=$records.Count; pages=$pages.Count; namespace_exists=$true; service_removed=$true; process_exit_confirmed=$true; expected_failure=$true })
    & (Join-Path $PSScriptRoot 'Invoke-FixedFrontendSourceFailureRecovery.ps1')
    if ($LASTEXITCODE -ne 0) { throw 'Independent recovery failed; retain original debt.' }
    'Expected complete source failure followed by independent SYSTEM recovery; original failure retained.' | Set-Content -LiteralPath $invocation -Encoding utf8
    exit 0
} catch {
    ($_ | Out-String) | Set-Content -LiteralPath $invocation -Encoding utf8
    exit 1
}
