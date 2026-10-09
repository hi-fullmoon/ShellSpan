# Exact existing failed bootstrap only. No new account or service is prepared.
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$prototype = Join-Path $workspace 'tests/windows-sandbox-account/target/debug/shellspan-account-sandbox-prototype.exe'
$file = Join-Path $workspace 'docs/design/evidence/windows-stage-a-2026-10-09-bootstrap-independent-recovery-observation.json'
if (Test-Path -LiteralPath $file) { throw 'Evidence exists; refuse repeated inspection.' }
$id = '093354fe-26ac-48e5-9cd6-256b30ee7599'
try {
    $ErrorActionPreference = 'Continue'
    & $prototype --recover-owned-account-profile $id 2> ($file + '.error.txt') | Out-Null
    $nativeExit = $LASTEXITCODE
} finally { $ErrorActionPreference = 'Stop' }
$receipt = Get-Content -LiteralPath ('C:/ProgramData/ShellSpan-account-profile-A-' + $id + '/ownership.json') -Raw | ConvertFrom-Json
if ($receipt.fixture_id -ne $id -or $receipt.account_sid -ne 'S-1-5-21-4017028701-367916445-1230427694-1116') { throw 'Fixed recovery receipt identity differs.' }
$result = [ordered]@{ native_exit = $nativeExit; receipt = $receipt }
[IO.File]::WriteAllText($file, ($result | ConvertTo-Json -Depth 100), (New-Object Text.UTF8Encoding($false)))
