# Recover only the fixture from this fixed experiment, never repeat its workload.
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'InterruptedProfileGate.psm1') -Force
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$evidence = Join-Path $workspace 'docs/design/evidence'
$prototype = Join-Path $workspace 'tests/windows-sandbox-account/target/debug/shellspan-account-sandbox-prototype.exe'
$prefix = 'windows-stage-a-2026-10-09-git-metadata-recovery-r2'
if (Test-Path -LiteralPath (Join-Path $evidence ($prefix + '-preparation.json'))) { throw 'Recovery attempt evidence exists.' }
try {
    $source = Get-Content -LiteralPath (Join-Path $evidence 'windows-stage-a-2026-10-09-git-metadata-init-system-preparation.json') -Raw | ConvertFrom-Json
    $id = [Guid]::Parse($source.fixture_id)
    if ($id -eq [Guid]::Empty -or $source.production -ne 'unavailable' -or $source.fixed_tool -ne 'git_metadata_init') { throw 'Fixed original preparation mismatch.' }
    $preparation = (& $prototype --prepare-owned-system-profile-recovery $id.ToString() | Out-String) | ConvertFrom-Json
    $preparation | ConvertTo-Json -Depth 40 | Set-Content -LiteralPath (Join-Path $evidence ($prefix + '-preparation.json')) -Encoding utf8
    if ($preparation.recovery_target -ne $id.ToString()) { throw 'Recovery target mismatch.' }
    $service = (& $prototype --run-owned-system-admission $preparation.fixture_id | Out-String) | ConvertFrom-Json
    $service | ConvertTo-Json -Depth 40 | Set-Content -LiteralPath (Join-Path $evidence ($prefix + '-service.json')) -Encoding utf8
    if (-not $service.service_removed) { throw 'Recovery service not confirmed retired.' }
    $receipt = Get-Content -LiteralPath (Join-Path 'C:/ProgramData' ('ShellSpan-account-profile-A-' + $id.ToString() + '/ownership.json')) -Raw | ConvertFrom-Json
    $receipt | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath (Join-Path $evidence ($prefix + '-profile.json')) -Encoding utf8
    $audit = (& $prototype --inspect-owned-ancestor-retirement $id.ToString() | Out-String) | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw 'Native exact ancestor retirement unconfirmed.' }
    $audit | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $evidence ($prefix + '-ancestor-os-audit.json')) -Encoding utf8
    $sid = $receipt.account_sid
    if ($sid -notmatch '^S-1-5-21-\d+-\d+-\d+-\d+$') { throw 'Invalid exact account SID.' }
    $os = [ordered]@{fixture_id=$id.ToString(); account_absent=(@(Get-CimInstance Win32_UserAccount -Filter "SID='$sid'").Count -eq 0); profile_absent=(@(Get-CimInstance Win32_UserProfile -Filter "SID='$sid'").Count -eq 0); hive_absent=(-not (Get-FixedHivePresence -Sid $sid)); services_absent=(Test-FixedServicesAbsent -Names @(('ShellSpanAdmissionA-'+$id.ToString('N')),('ShellSpanAdmissionA-'+([Guid]$preparation.fixture_id).ToString('N'))))}
    $os | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $evidence ($prefix + '-os-audit.json')) -Encoding utf8
    if (-not $os.account_absent -or -not $os.profile_absent -or -not $os.hive_absent -or -not $os.services_absent) { throw 'Exact OS retirement incomplete.' }
} catch {
    ($_ | Out-String) | Set-Content -LiteralPath (Join-Path $evidence ($prefix + '-error.txt')) -Encoding utf8
    exit 1
}
