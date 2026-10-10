# Fixed one-shot diagnostic wrapper; no arbitrary command, path or identity input.
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$resultPath = Join-Path $workspace 'docs/design/evidence/windows-stage-a-2026-10-09-git-metadata-invocation.txt'
if (Test-Path -LiteralPath $resultPath) { throw 'Invocation evidence exists; do not repeat.' }
try {
    & (Join-Path $PSScriptRoot 'Run-FixedProjectMatrix.ps1') -Case GitMetadataInit
    'Fixed Git metadata matrix completed; inspect native tool result separately.' | Set-Content -LiteralPath $resultPath -Encoding utf8
    exit 0
} catch {
    ($_ | Out-String) | Set-Content -LiteralPath $resultPath -Encoding utf8
    exit 1
}
