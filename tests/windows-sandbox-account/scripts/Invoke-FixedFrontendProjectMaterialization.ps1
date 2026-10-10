# Fixed complete SYSTEM materialization; no accounts, grants or tools.
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$prototype = Join-Path $workspace 'tests/windows-sandbox-account/target/debug/shellspan-account-sandbox-prototype.exe'
$evidence = Join-Path $workspace 'docs/design/evidence'
$prefix = 'windows-stage-a-2026-10-10-frontend-project-materialization-system'
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
    $preparation = (& $prototype --prepare-owned-system-frontend-project-materialization | Out-String) | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or -not $preparation.fixed_frontend_materialization -or (-not $preparation.frontend_materialization_project) -or $preparation.frontend_materialization_source -or $preparation.frontend_source_workload_failure -or $preparation.frontend_project_workload_failure -or $preparation.fixed_frontend_journal -or $preparation.fixed_workload -or $preparation.production -ne 'unavailable') { throw 'Unexpected materialization preparation.' }
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
    if ($diagnostic.diagnostic_error) { throw $diagnostic.diagnostic_error }
    $root = Join-Path 'C:/ProgramData' ('ShellSpan-account-profile-A-' + $id.ToString())
    $result = Get-Content -LiteralPath (Join-Path $root 'frontend-materialization-result.json') -Raw | ConvertFrom-Json
    Save-FixedEvidence 'result' $result
    $anchor = Get-Content -LiteralPath (Join-Path $root 'ownership.json') -Raw | ConvertFrom-Json
    Save-FixedEvidence 'anchor' $anchor
    if ($result.fixture_id -ne $id.ToString() -or -not $result.actual_system -or $result.objects -le 0 -or $result.pages -ne [Math]::Ceiling($result.objects / 64) -or $result.namespace_root -ne 'frontend-project' -or $result.objects -ne $anchor.objects -or $result.pages -ne $anchor.pages -or $result.objects_created -ne $result.objects -or $result.objects_retired -ne $result.objects -or -not $result.retirement_confirmed -or $result.permissions_granted -or $result.accounts_created -or $result.filters_installed -or $result.tools_dispatched -or $service.observed_service_exit.win32_exit_code -ne 0 -or $service.observed_service_exit.service_specific_exit_code -ne 0) { throw 'Complete materialization did not pass.' }
    if ($anchor.backend -ne 'fixed-frontend-project-materialization-v1' -or $anchor.namespace_root -ne 'frontend-project' -or $anchor.fixture_id -ne $id.ToString() -or $anchor.journal_prepared -ne $true -or $anchor.creation_stamp_version -ne 1 -or $anchor.phase -ne 'retired; execution forbidden' -or $anchor.permissions_granted -or (Test-Path -LiteralPath (Join-Path $root 'frontend-project'))) { throw 'Namespace retirement not confirmed.' }
    'Complete SYSTEM materialization and retirement passed; protected metadata retained.' | Set-Content -LiteralPath $invocation -Encoding utf8
    exit 0
} catch {
    ($_ | Out-String) | Set-Content -LiteralPath $invocation -Encoding utf8
    exit 1
}
