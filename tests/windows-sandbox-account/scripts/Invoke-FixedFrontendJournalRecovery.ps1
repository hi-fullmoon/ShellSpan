# Exact existing fixture, read-only independent SYSTEM recovery validation.
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$prototype = Join-Path $workspace 'tests/windows-sandbox-account/target/debug/shellspan-account-sandbox-prototype.exe'
$evidence = Join-Path $workspace 'docs/design/evidence'
$prefix = 'windows-stage-a-2026-10-10-frontend-journal-independent'
$target = 'f9b43a1d-ce0b-4d96-a2f0-2cd9394543d6'
$invocation = Join-Path $evidence ($prefix + '-invocation.txt')
if (Test-Path -LiteralPath $invocation) { throw 'Existing invocation; do not repeat.' }
function Save-FixedEvidence([string]$suffix, $value) {
    $path = Join-Path $evidence ($prefix + '-' + $suffix + '.json')
    if (Test-Path -LiteralPath $path) { throw 'Existing evidence; do not overwrite.' }
    $value | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $path -Encoding utf8
}
try {
    $preparation = (& $prototype --prepare-owned-system-frontend-journal-recovery $target | Out-String) | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $preparation.frontend_journal_recovery_target -ne $target -or $preparation.fixed_frontend_journal -or $preparation.fixed_workload) { throw 'Unexpected recovery preparation.' }
    Save-FixedEvidence 'preparation' $preparation
    $id = [Guid]::Parse($preparation.fixture_id)
    if ($id -eq [Guid]::Empty -or $id.ToString() -eq $target) { throw 'Recovery identity conflicts with original fixture.' }
    $service = (& $prototype --run-owned-system-admission $id.ToString() | Out-String) | ConvertFrom-Json
    Save-FixedEvidence 'service' $service
    if (-not $service.service_removed -or -not $service.observed_service_exit.process_exit_confirmed) { throw 'Independent service retirement unconfirmed.' }
    $root = Join-Path 'C:/ProgramData' ('ShellSpan-system-admission-A-' + $id.ToString())
    $diagnostic = Get-Content -LiteralPath (Join-Path $root 'service-result.json') -Raw | ConvertFrom-Json
    Save-FixedEvidence 'diagnostic' $diagnostic
    if ($diagnostic.diagnostic_error) { throw $diagnostic.diagnostic_error }
    $result = Get-Content -LiteralPath (Join-Path $root 'frontend-journal-recovery-result.json') -Raw | ConvertFrom-Json
    Save-FixedEvidence 'result' $result
    if ($result.fixture_id -ne $target -or $result.recovery_id -ne $id.ToString() -or -not $result.actual_system -or -not $result.independent_process -or -not $result.original_service_retired -or -not $result.all_pages_bound -or -not $result.recovery_creation_blocked -or $result.source_inventory_opened -or $result.records_mutated -or $service.observed_service_exit.win32_exit_code -ne 0) { throw 'Independent recovery did not pass.' }
    'Independent SYSTEM recovery read all pages; creation remains blocked and records remain unchanged.' | Set-Content -LiteralPath $invocation -Encoding utf8
    exit 0
} catch {
    ($_ | Out-String) | Set-Content -LiteralPath $invocation -Encoding utf8
    exit 1
}
