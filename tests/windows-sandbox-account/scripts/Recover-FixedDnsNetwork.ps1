# Single-use exact recovery of the terminated dns-network diagnostic.
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'InterruptedProfileGate.psm1') -Force
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$prototype = Join-Path $workspace 'tests/windows-sandbox-account/target/debug/shellspan-account-sandbox-prototype.exe'
$prefix = Join-Path $workspace 'docs/design/evidence/windows-stage-a-2026-10-09-dns-network-second-recovery'
$id = '21594eee-b9c3-4b6d-b94b-e0ad1c23d7ae'
$sid = 'S-1-5-21-4017028701-367916445-1230427694-1101'
foreach ($name in @('preparation','service','profile','os-audit')) {
    if (Test-Path -LiteralPath ($prefix + '-' + $name + '.json')) { throw 'Fixed recovery evidence exists; do not repeat.' }
}
if ((Get-FixedHivePresence -Sid $sid) -or @(Get-CimInstance Win32_UserProfile -Filter "SID='$sid'" | Where-Object Loaded).Count -ne 0) { throw 'Owned hive remains loaded; no service prepared.' }
$account = Get-LocalUser -Name 'SSPA21594eeeb9c3'
if ($account.SID.Value -ne $sid -or $account.Enabled) { throw 'Exact account quarantine mismatch.' }
foreach ($serviceId in @($id, '4938089e-2cad-43ce-9503-68664d4b0b2f')) {
    if (-not (Test-FixedServicesAbsent -Names @('ShellSpanAdmissionA-' + $serviceId.Replace('-','')))) { throw 'Previous service still exists; do not restart.' }
}
function Save-Evidence($name, $value) {
    $value | ConvertTo-Json -Depth 100 | Out-File -LiteralPath ($prefix + '-' + $name + '.json') -Encoding utf8
}
$preparation = (& $prototype --prepare-owned-system-profile-recovery $id | Out-String) | ConvertFrom-Json
$recoveryId = [Guid]::Parse($preparation.fixture_id)
if ($recoveryId -eq [Guid]::Empty -or $preparation.recovery_target -ne $id -or $preparation.fixed_workload) { throw 'Unexpected recovery target.' }
Save-Evidence 'preparation' $preparation
$service = (& $prototype --run-owned-system-admission $recoveryId.ToString() | Out-String) | ConvertFrom-Json
Save-Evidence 'service' $service
if (-not $service.service_removed) { throw 'Recovery service exit unconfirmed.' }
$receipt = Get-Content -LiteralPath ('C:/ProgramData/ShellSpan-account-profile-A-' + $id + '/ownership.json') -Raw | ConvertFrom-Json
Save-Evidence 'profile' $receipt
if (-not $receipt.account_removed -or -not $receipt.profile_removed -or -not $receipt.filters_removed -or -not $receipt.credential_removed -or @($receipt.cleanup_debt).Count -ne 0) { throw 'Recovery incomplete; keep quarantine.' }
$audit = [ordered]@{
    fixture_id = $id
    account_absent = (@(Get-CimInstance Win32_UserAccount -Filter "SID='$sid'").Count -eq 0)
    profile_absent = (@(Get-CimInstance Win32_UserProfile -Filter "SID='$sid'").Count -eq 0)
    hive_absent = (-not (Get-FixedHivePresence -Sid $sid))
    services_absent = (Test-FixedServicesAbsent -Names @('ShellSpanAdmissionA-' + $recoveryId.ToString('N')))
}
Save-Evidence 'os-audit' $audit
if (-not $audit.account_absent -or -not $audit.profile_absent -or -not $audit.hive_absent -or -not $audit.services_absent) { throw 'OS state contradicts recovery.' }
