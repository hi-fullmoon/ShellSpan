# Single-use exact recovery of the terminated private-network diagnostic.
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'InterruptedProfileGate.psm1') -Force
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$prototype = Join-Path $workspace 'tests/windows-sandbox-account/target/debug/shellspan-account-sandbox-prototype.exe'
$prefix = Join-Path $workspace 'docs/design/evidence/windows-stage-a-2026-10-09-private-network-second-recovery'
$id = 'e6e6db33-844b-44b1-9bd9-6391d7c0b688'
$sid = 'S-1-5-21-4017028701-367916445-1230427694-1100'
foreach ($name in @('preparation','service','profile','os-audit')) {
    if (Test-Path -LiteralPath ($prefix + '-' + $name + '.json')) { throw 'Fixed recovery evidence exists; do not repeat.' }
}
if ((Get-FixedHivePresence -Sid $sid) -or @(Get-CimInstance Win32_UserProfile -Filter "SID='$sid'" | Where-Object Loaded).Count -ne 0) { throw 'Owned hive remains loaded; no service prepared.' }
$account = Get-LocalUser -Name 'SSPAe6e6db33844b'
if ($account.SID.Value -ne $sid -or $account.Enabled) { throw 'Exact account quarantine mismatch.' }
foreach ($serviceId in @($id, '2c867fcc-2168-4c15-93a0-5a76a9198e2b')) {
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
