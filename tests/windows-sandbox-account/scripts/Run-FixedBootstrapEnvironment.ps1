# Single-use owned bootstrap diagnostic. No path, command, identity or policy parameters.
param([ValidateSet('Initial','ExitDiagnostics','FixedReport','HeldReport')][string]$Case = 'Initial')
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'InterruptedProfileGate.psm1') -Force
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$prototype = Join-Path $workspace 'tests/windows-sandbox-account/target/debug/shellspan-account-sandbox-prototype.exe'
$prefix = Join-Path $workspace $(switch ($Case) { 'HeldReport' { 'docs/design/evidence/windows-stage-a-2026-10-09-bootstrap-held-report' } 'FixedReport' { 'docs/design/evidence/windows-stage-a-2026-10-09-bootstrap-fixed-report' } 'ExitDiagnostics' { 'docs/design/evidence/windows-stage-a-2026-10-09-bootstrap-terminal-exit' } default { 'docs/design/evidence/windows-stage-a-2026-10-09-bootstrap-explicit-environment' } })
foreach ($name in @('profile','recovered-profile','os-audit','error')) {
    if (Test-Path -LiteralPath ($prefix + '-' + $name + '.json')) { throw 'Evidence already exists; refuse repeated run.' }
}
function Save-Evidence($Name, $Value) {
    [IO.File]::WriteAllText(($prefix + '-' + $Name + '.json'), ($Value | ConvertTo-Json -Depth 100), (New-Object Text.UTF8Encoding($false)))
}
try {
    $ErrorActionPreference = 'Continue'
    $text = (& $prototype --diagnose-owned-account-lpac-admission 2> ($prefix + '-error.json') | Out-String)
    $nativeExit = $LASTEXITCODE
} finally {
    $ErrorActionPreference = 'Stop'
}
$receipt = $text | ConvertFrom-Json
$id = [Guid]::Parse($receipt.fixture_id)
if ($id -eq [Guid]::Empty -or $receipt.production -ne 'unavailable' -or $receipt.account_sid -notmatch '^S-1-5-21-\d+-\d+-\d+-\d+$') { throw 'Unexpected bootstrap receipt; retain diagnostic resources.' }
Save-Evidence 'profile' $receipt
if (-not $receipt.account_removed -or -not $receipt.profile_removed -or -not $receipt.filters_removed -or @($receipt.cleanup_debt).Count) {
    # Native exact recovery independently validates ownership and current resource identities.
    $recoveryText = (& $prototype --recover-owned-account-profile $id.ToString() | Out-String)
    if ($LASTEXITCODE -ne 0) { throw 'Exact bootstrap recovery refused; keep quarantine and receipt.' }
}
$recovered = Get-Content -LiteralPath (Join-Path 'C:/ProgramData' ('ShellSpan-account-profile-A-' + $id.ToString() + '/ownership.json')) -Raw | ConvertFrom-Json
Save-Evidence 'recovered-profile' $recovered
if ($recovered.fixture_id -ne $receipt.fixture_id -or $recovered.account_sid -ne $receipt.account_sid -or -not $recovered.account_removed -or -not $recovered.profile_removed -or -not $recovered.filters_removed -or @($recovered.cleanup_debt).Count) { throw 'Retirement unconfirmed.' }
$sid = $receipt.account_sid
$audit = [ordered]@{
    fixture_id = $id.ToString()
    native_exit = $nativeExit
    account_absent = (@(Get-CimInstance Win32_UserAccount -Filter "SID='$sid'").Count -eq 0)
    profile_absent = (@(Get-CimInstance Win32_UserProfile -Filter "SID='$sid'").Count -eq 0)
    hive_absent = (-not (Get-FixedHivePresence -Sid $sid))
    services_absent = (Test-FixedServicesAbsent -Names @(('ShellSpanAdmissionA-' + $id.ToString('N'))))
}
Save-Evidence 'os-audit' $audit
if (-not $audit.account_absent -or -not $audit.profile_absent -or -not $audit.hive_absent -or -not $audit.services_absent) { throw 'OS state contradicts retirement.' }
