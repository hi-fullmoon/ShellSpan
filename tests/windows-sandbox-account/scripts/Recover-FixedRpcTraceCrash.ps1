# One exact owned crash fixture. No UUID, path, command or identity arguments.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'InterruptedProfileGate.psm1') -Force
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$prototype = Join-Path $workspace 'tests/windows-sandbox-account/target/debug/shellspan-account-sandbox-prototype.exe'
$id = [Guid]'da9f4011-394d-4a24-8d8d-c63acecce63b'
$sid = 'S-1-5-21-4017028701-367916445-1230427694-1134'
$receiptPath = 'C:/ProgramData/ShellSpan-account-profile-A-da9f4011-394d-4a24-8d8d-c63acecce63b/ownership.json'
$prefix = Join-Path $workspace 'docs/design/evidence/windows-stage-a-2026-10-09-rpc-trace-crash-independent-recovery-'
foreach ($suffix in @('before','preparation','service','after','os-audit')) {
    if (Test-Path -LiteralPath ($prefix+$suffix+'.json')) { throw 'Fixed recovery evidence exists; do not repeat.' }
}
function Save-Evidence($Name,$Value) { $Value | ConvertTo-Json -Depth 100 | Out-File -LiteralPath ($prefix+$Name+'.json') -Encoding utf8 }
$before = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
if ($before.fixture_id -ne $id.ToString() -or $before.account_sid -ne $sid -or -not $before.controller_admission_report.service_crash_checkpoint) { throw 'Exact crash identity missing.' }
Save-Evidence 'before' $before
$preparation = (& $prototype --prepare-owned-system-profile-recovery $id.ToString() | Out-String) | ConvertFrom-Json
if ($preparation.recovery_target -ne $id.ToString()) { throw 'Exact recovery target changed.' }
Save-Evidence 'preparation' $preparation
$service = (& $prototype --run-owned-system-admission $preparation.fixture_id | Out-String) | ConvertFrom-Json
Save-Evidence 'service' $service
if (-not $service.service_removed) { throw 'Recovery service retirement unconfirmed.' }
$after = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
Save-Evidence 'after' $after
$accounts = @(Get-CimInstance Win32_UserAccount -Filter "SID='$sid'")
$profiles = @(Get-CimInstance Win32_UserProfile -Filter "SID='$sid'")
Save-Evidence 'os-audit' ([ordered]@{fixture_id=$id.ToString(); account_sid=$sid; accounts=@($accounts | Select-Object SID,Disabled); profiles=@($profiles | Select-Object SID,Loaded); hive_present=(Get-FixedHivePresence -Sid $sid)})
if (-not $after.rpc_trace_removed -or -not $after.rpc_trace_recovery_stopped) { throw 'Actual crashed RPC session STOP/absence not verified.' }
