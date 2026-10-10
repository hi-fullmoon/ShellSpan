# Recover only the fixture recorded by the fixed complete materialization run.
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$prototype = Join-Path $workspace 'tests/windows-sandbox-account/target/debug/shellspan-account-sandbox-prototype.exe'
$evidence = Join-Path $workspace 'docs/design/evidence'
$prefix = 'windows-stage-a-2026-10-10-frontend-source-materialization-independent'
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
    $original = Get-Content -LiteralPath (Join-Path $evidence 'windows-stage-a-2026-10-10-frontend-source-materialization-system-preparation.json') -Raw | ConvertFrom-Json
    if (-not $original.fixed_frontend_materialization -or (-not $original.frontend_materialization_source) -or $original.production -ne 'unavailable') { throw 'Original scope differs.' }
    $targetId = [Guid]::Parse($original.fixture_id)
    if ($targetId -eq [Guid]::Empty) { throw 'Empty original fixture.' }
    $target = $targetId.ToString()
    # The native preparation revalidates protected original records and SCM.
    $preparation = (& $prototype --prepare-owned-system-frontend-source-materialization-recovery $target | Out-String) | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $preparation.frontend_materialization_recovery_target -ne $target -or (-not $preparation.frontend_materialization_source) -or $preparation.fixed_frontend_materialization -or $preparation.fixed_frontend_journal -or $preparation.fixed_workload) { throw 'Unexpected recovery preparation.' }
    Save-FixedEvidence 'preparation' $preparation
    $id = [Guid]::Parse($preparation.fixture_id)
    if ($id -eq [Guid]::Empty -or $id -eq $targetId) { throw 'Recovery identity conflicts.' }
    $service = (& $prototype --run-owned-system-admission $id.ToString() | Out-String) | ConvertFrom-Json
    $serviceExit = $LASTEXITCODE
    Save-FixedEvidence 'service' $service
    if ($serviceExit -ne 0 -or -not $service.service_removed -or -not $service.observed_service_exit.process_exit_confirmed) { throw 'Recovery service retirement unconfirmed; do not restart.' }
    $root = Join-Path 'C:/ProgramData' ('ShellSpan-system-admission-A-' + $id.ToString())
    $diagnostic = Get-Content -LiteralPath (Join-Path $root 'service-result.json') -Raw | ConvertFrom-Json
    Save-FixedEvidence 'diagnostic' $diagnostic
    if ($diagnostic.diagnostic_error) { throw $diagnostic.diagnostic_error }
    $result = Get-Content -LiteralPath (Join-Path $root 'frontend-materialization-recovery-result.json') -Raw | ConvertFrom-Json
    Save-FixedEvidence 'result' $result
    if ($result.fixture_id -ne $target -or $result.recovery_id -ne $id.ToString() -or -not $result.actual_system -or -not $result.independent_process -or -not $result.original_service_retired -or $result.source_inventory_opened -or $result.objects_created -ne 0 -or $result.objects -le 0 -or $result.pages -ne [Math]::Ceiling($result.objects / 64) -or $result.namespace_root -ne 'frontend-source' -or -not $result.retirement_confirmed -or $result.permissions_granted -or $result.accounts_created -or $result.filters_installed -or $result.tools_dispatched -or $service.observed_service_exit.win32_exit_code -ne 0 -or $service.observed_service_exit.service_specific_exit_code -ne 0) { throw 'Independent recovery common gates did not pass.' }
    if ($result.initialization_only -eq $true) {
        if ($result.namespace_absence_confirmed -ne $true -or $result.page_records_mutated -ne $false -or $result.objects_retired -ne 0) { throw 'Initialization recovery scope differs.' }
        'Independent SYSTEM unprepared namespace absence confirmed; zero objects retired and original page records retained.' | Set-Content -LiteralPath $invocation -Encoding utf8
    } else {
        if ($result.objects_retired -ne $result.objects) { throw 'Independent complete retirement count differs.' }
        'Independent SYSTEM complete retirement confirmed; no source inventory opened or tools dispatched.' | Set-Content -LiteralPath $invocation -Encoding utf8
    }
    exit 0
} catch {
    ($_ | Out-String) | Set-Content -LiteralPath $invocation -Encoding utf8
    exit 1
}
