# Recover only the existing empty-report bootstrap. Never prepare another account.
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'InterruptedProfileGate.psm1') -Force
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$prototype = Join-Path $workspace 'tests/windows-sandbox-account/target/debug/shellspan-account-sandbox-prototype.exe'
$id = '093354fe-26ac-48e5-9cd6-256b30ee7599'
$sid = 'S-1-5-21-4017028701-367916445-1230427694-1116'
$prefix = Join-Path $workspace 'docs/design/evidence/windows-stage-a-2026-10-09-empty-bootstrap-retirement'
foreach ($suffix in @('profile.json','os-audit.json','error.txt')) {
    if (Test-Path -LiteralPath ($prefix + '-' + $suffix)) { throw 'Evidence exists; refuse repeated run.' }
}
try {
    $ErrorActionPreference = 'Continue'
    & $prototype --recover-owned-account-profile $id 2> ($prefix + '-error.txt') | Out-Null
    $nativeExit = $LASTEXITCODE
} finally { $ErrorActionPreference = 'Stop' }
$receipt = Get-Content -LiteralPath ('C:/ProgramData/ShellSpan-account-profile-A-' + $id + '/ownership.json') -Raw | ConvertFrom-Json
[IO.File]::WriteAllText(($prefix + '-profile.json'), ($receipt | ConvertTo-Json -Depth 100), (New-Object Text.UTF8Encoding($false)))
if ($nativeExit -ne 0 -or $receipt.fixture_id -ne $id -or $receipt.account_sid -ne $sid -or -not $receipt.account_removed -or -not $receipt.profile_removed -or -not $receipt.filters_removed -or @($receipt.cleanup_debt).Count) { throw 'Exact empty-bootstrap retirement unconfirmed; retain quarantine.' }
$audit = [ordered]@{
    fixture_id = $id
    account_sid = $sid
    native_exit = $nativeExit
    account_absent = (@(Get-CimInstance Win32_UserAccount -Filter "SID='$sid'").Count -eq 0)
    profile_absent = (@(Get-CimInstance Win32_UserProfile -Filter "SID='$sid'").Count -eq 0)
    hive_absent = (-not (Get-FixedHivePresence -Sid $sid))
    services_absent = (Test-FixedServicesAbsent -Names @(('ShellSpanAdmissionA-' + $id.Replace('-',''))))
}
[IO.File]::WriteAllText(($prefix + '-os-audit.json'), ($audit | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
if (-not $audit.account_absent -or -not $audit.profile_absent -or -not $audit.hive_absent -or -not $audit.services_absent) { throw 'OS state contradicts retirement.' }
