# Fixed one-shot SYSTEM journal diagnostic, with no caller-selected paths or commands.
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$prototype = Join-Path $workspace 'tests/windows-sandbox-account/target/debug/shellspan-account-sandbox-prototype.exe'
$evidence = Join-Path $workspace 'docs/design/evidence'
$prefix = 'windows-stage-a-2026-10-10-frontend-journal-system'
$invocation = Join-Path $evidence ($prefix + '-invocation.txt')
if (Test-Path -LiteralPath $invocation) { throw 'Existing invocation; do not repeat.' }
function Save-FixedEvidence([string]$suffix, $value) {
    $path = Join-Path $evidence ($prefix + '-' + $suffix + '.json')
    if (Test-Path -LiteralPath $path) { throw 'Existing evidence; do not overwrite.' }
    $value | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $path -Encoding utf8
}
try {
    $preparation = (& $prototype --prepare-owned-system-frontend-journal | Out-String) | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or -not $preparation.fixed_frontend_journal -or $preparation.fixed_workload -or $preparation.production -ne 'unavailable') { throw 'Unexpected journal preparation.' }
    Save-FixedEvidence 'preparation' $preparation
    $id = [Guid]::Parse($preparation.fixture_id)
    $service = (& $prototype --run-owned-system-admission $id.ToString() | Out-String) | ConvertFrom-Json
    Save-FixedEvidence 'service' $service
    if (-not $service.service_removed -or -not $service.observed_service_exit.process_exit_confirmed) { throw 'Owned service retirement unconfirmed; do not restart.' }
    $root = Join-Path 'C:/ProgramData' ('ShellSpan-account-profile-A-' + $id.ToString())
    $result = Get-Content -LiteralPath (Join-Path $root 'frontend-journal-result.json') -Raw | ConvertFrom-Json
    Save-FixedEvidence 'result' $result
    $anchor = Get-Content -LiteralPath (Join-Path $root 'ownership.json') -Raw | ConvertFrom-Json
    Save-FixedEvidence 'anchor' $anchor
    if (-not $result.actual_system -or -not $result.all_pages_bound -or -not $result.protected_anchor_readback -or -not $result.recovery_creation_blocked -or $result.accounts_created -or $result.filters_installed -or $result.input_namespace_created -or $service.observed_service_exit.win32_exit_code -ne 0) { throw 'Journal diagnostic did not pass.' }
    'SYSTEM full journal publication and same-service readback passed; protected records retained as evidence.' | Set-Content -LiteralPath $invocation -Encoding utf8
    exit 0
} catch {
    ($_ | Out-String) | Set-Content -LiteralPath $invocation -Encoding utf8
    exit 1
}
