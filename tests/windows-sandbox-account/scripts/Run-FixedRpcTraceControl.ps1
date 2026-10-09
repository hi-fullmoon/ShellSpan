# No arbitrary command, PID or trace provider. Ordinary self-PID control only.
[CmdletBinding()]
param([ValidateSet('Initial','NativeQuery','NativeQuerySchema','NativeQueryVerified','BoundIntent','BoundedBuffers')][string]$Case = 'Initial')
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$binary = Join-Path $workspace 'tests/windows-sandbox-account/target/debug/shellspan-rpc-trace-control.exe'
$fileName = switch ($Case) { 'BoundedBuffers' { 'windows-stage-a-2026-10-09-rpc-trace-bounded-buffers-control.json' }; 'BoundIntent' { 'windows-stage-a-2026-10-09-rpc-trace-bound-intent-control.json' }; 'NativeQuery' { 'windows-stage-a-2026-10-09-rpc-trace-native-query-control.json' }; 'NativeQuerySchema' { 'windows-stage-a-2026-10-09-rpc-trace-native-query-schema-control.json' }; 'NativeQueryVerified' { 'windows-stage-a-2026-10-09-rpc-trace-native-query-verified-control.json' }; default { 'windows-stage-a-2026-10-09-rpc-trace-self-control.json' } }
$evidencePath = Join-Path $workspace ('docs/design/evidence/' + $fileName)
$errorPath = $evidencePath + '.stderr.txt'
if ((Test-Path -LiteralPath $evidencePath) -or (Test-Path -LiteralPath $errorPath)) { throw 'Fixed control evidence already exists; do not repeat.' }
$ErrorActionPreference = 'Continue'
$output = & $binary 2> $errorPath
$nativeExitCode = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
if ($nativeExitCode -ne 0) { throw 'Fixed RPC trace control failed; retain original failure.' }
$report = ($output | Out-String) | ConvertFrom-Json
if ($report.production -ne 'unavailable' -or -not $report.rpc_trace.session_stopped -or -not $report.rpc_trace.consumer_closed) {
    throw 'RPC trace lifecycle unconfirmed.'
}
if ($Case -ne 'Initial' -and -not $report.rpc_trace.session_absent) { throw 'Native session absence unconfirmed.' }
$bytes = [Text.UTF8Encoding]::new($false).GetBytes(($report | ConvertTo-Json -Depth 20))
$stream = [IO.File]::Open($evidencePath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
try { $stream.Write($bytes,0,$bytes.Length) } finally { $stream.Dispose() }
