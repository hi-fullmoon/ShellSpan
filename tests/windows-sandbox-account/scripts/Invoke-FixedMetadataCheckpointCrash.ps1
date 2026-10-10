# Exact one-shot controller self-termination checkpoint, never an arbitrary PID.
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$resultPath = Join-Path $workspace 'docs/design/evidence/windows-stage-a-2026-10-09-metadata-checkpoint-crash-invocation.txt'
if (Test-Path -LiteralPath $resultPath) { throw 'Invocation evidence exists; do not repeat.' }
try {
    & (Join-Path $PSScriptRoot 'Run-FixedProjectMatrix.ps1') -Case GitMetadataCheckpointCrash
    'Fixed controller checkpoint crash recovery completed; inspect native checkpoint separately.' | Set-Content -LiteralPath $resultPath -Encoding utf8
    exit 0
} catch {
    ($_ | Out-String) | Set-Content -LiteralPath $resultPath -Encoding utf8
    exit 1
}
