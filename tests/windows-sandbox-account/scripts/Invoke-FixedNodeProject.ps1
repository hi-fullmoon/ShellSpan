# Fixed one-shot diagnostic wrapper; no command, path or identity parameters.
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$resultPath = Join-Path $workspace 'docs/design/evidence/windows-stage-a-2026-10-10-node-project-invocation.txt'
if (Test-Path -LiteralPath $resultPath) { throw 'Invocation evidence exists; do not repeat.' }
try {
    & (Join-Path $PSScriptRoot 'Run-FixedProjectMatrix.ps1') -Case NodeProject
    'Fixed Node project resources retired; inspect native project result separately.' | Set-Content -LiteralPath $resultPath -Encoding utf8
    exit 0
} catch {
    ($_ | Out-String) | Set-Content -LiteralPath $resultPath -Encoding utf8
    exit 1
}
