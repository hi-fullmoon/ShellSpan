# Fixed post-mutation checkpoint failure. No arbitrary command/path/PID input.
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$resultPath = Join-Path $workspace 'docs/design/evidence/windows-stage-a-2026-10-09-metadata-partial-failure-invocation.txt'
if (Test-Path -LiteralPath $resultPath) { throw 'Invocation evidence exists; do not repeat.' }
try {
    & (Join-Path $PSScriptRoot 'Run-FixedProjectMatrix.ps1') -Case GitMetadataPartialFailure
    'Fixed partial failure recovery matrix completed; inspect failure checkpoint separately.' | Set-Content -LiteralPath $resultPath -Encoding utf8
    exit 0
} catch {
    ($_ | Out-String) | Set-Content -LiteralPath $resultPath -Encoding utf8
    exit 1
}
