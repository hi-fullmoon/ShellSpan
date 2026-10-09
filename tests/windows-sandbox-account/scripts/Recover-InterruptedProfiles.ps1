# Fixed diagnostic recovery for three owned crash receipts. Run in an elevated
# PowerShell after a manually scheduled reboot; this script never restarts Windows.
[CmdletBinding()]
param([switch]$InspectOnly)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'InterruptedProfileGate.psm1') -Force
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this fixed diagnostic in an elevated PowerShell.'
}
$prototype = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../target/debug/shellspan-account-sandbox-prototype.exe'))
if (-not (Test-Path -LiteralPath $prototype -PathType Leaf)) {
    throw 'Build the independent Windows sandbox prototype first.'
}
$targets = @(
    @{ Id = 'ba16502e-566b-4193-93d6-b6b34414ae68'; Account = 'SSPAba16502e566b'; Sid = 'S-1-5-21-4017028701-367916445-1230427694-1063' },
    @{ Id = '4bb6655d-3b91-4088-b7f3-7db3e7005b0b'; Account = 'SSPA4bb6655d3b91'; Sid = 'S-1-5-21-4017028701-367916445-1230427694-1065' },
    @{ Id = 'da9f4011-394d-4a24-8d8d-c63acecce63b'; Account = 'SSPAda9f4011394d'; Sid = 'S-1-5-21-4017028701-367916445-1230427694-1134' }
)

function Read-FixedReceipt($target) {
    $receiptPath = Join-Path 'C:/ProgramData' ('ShellSpan-account-profile-A-' + $target.Id + '/ownership.json')
    $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
    if ($receipt.fixture_id -ne $target.Id -or $receipt.account -ne $target.Account -or $receipt.account_sid -ne $target.Sid) {
        throw 'Frozen receipt identity differs from the fixed owned target.'
    }
    return $receipt
}

function Get-FixedObservation($target) {
    $receipt = Read-FixedReceipt $target
    $matches = @(Get-LocalUser -ErrorAction Stop | Where-Object { $_.Name -eq $target.Account })
    if ($matches.Count -gt 1) { throw 'Fixed SAM lookup returned duplicate accounts.' }
    $account = if ($matches.Count -eq 1) { $matches[0] } else { $null }
    if ($account -and $account.SID.Value -ne $target.Sid) {
        throw 'Current SAM identity differs from the fixed owned target.'
    }
    $profiles = @(Get-CimInstance Win32_UserProfile -Filter ("SID='{0}'" -f $target.Sid))
    $hivePresent = Get-FixedHivePresence -Sid $target.Sid
    $loaded = @($profiles | Where-Object Loaded).Count -gt 0
    $originalService = 'ShellSpanAdmissionA-' + $target.Id.Replace('-', '')
    $serviceAbsent = Test-FixedServicesAbsent -Names @($originalService)
    $gate = Get-FixedRecoveryEligibility -Receipt $receipt -AccountPresent ([bool]$account) -AccountDisabled ([bool]($account -and -not $account.Enabled)) -HivePresent $hivePresent -ProfileLoaded $loaded -ProfileRecordCount $profiles.Count -OriginalServicePresent (-not $serviceAbsent)
    [pscustomobject]@{
        fixture_id = $target.Id
        account_absent = -not [bool]$account
        profile_absent = $profiles.Count -eq 0
        recorded_retirement = $gate.recorded_retirement
        retirement_consistent_with_os = $gate.retirement_consistent_with_os
        hive_absent = -not $hivePresent
        profile_not_loaded = -not $loaded
        original_service_absent = $serviceAbsent
        account_disabled = [bool]($account -and -not $account.Enabled)
        eligible_for_fixed_recovery = $gate.eligible
    }
}
$observations = foreach ($target in $targets) { Get-FixedObservation $target }
if ($InspectOnly) {
    $observations | ConvertTo-Json -Depth 3
    return
}
if (@($observations | Where-Object { -not $_.eligible_for_fixed_recovery }).Count -ne 0) {
    throw 'Owned hive/service/account gate still blocks recovery. No new service was prepared.'
}

foreach ($target in $targets) {
    # Even an apparently retired receipt goes through native recovery again.
    # Its flags alone cannot prove current process/filter/credential absence.
    # The native prototype independently revalidates protected ownership, actual
    # identities, stopped processes, frozen files and SID filters before mutation.
    $preparationText = (& $prototype --prepare-owned-system-profile-recovery $target.Id | Out-String)
    if ($LASTEXITCODE -ne 0) { throw 'Fixed recovery preparation failed; inspect the native diagnostic.' }
    $preparation = $preparationText | ConvertFrom-Json
    $preparedId = [Guid]::Parse($preparation.fixture_id)
    if ($preparedId -eq [Guid]::Empty -or $preparation.recovery_target -ne $target.Id -or $preparation.fixed_workload -or $preparation.production -ne 'unavailable') {
        throw 'Unexpected fixed recovery preparation contract.'
    }
    Write-Information ('Owned recovery preparation: ' + $preparedId) -InformationAction Continue
    $serviceText = (& $prototype --run-owned-system-admission $preparedId.ToString() | Out-String)
    if ($LASTEXITCODE -ne 0) {
        throw ('Fixed service dispatch failed. Keep its protected plan and inspect UUID ' + $preparedId + '; do not restart a live helper.')
    }
    $service = $serviceText | ConvertFrom-Json
    if ($service.fixture_id -ne $preparedId.ToString() -or -not $service.service_removed) {
        throw 'Fixed recovery service retirement is unconfirmed; retain its protected plan.'
    }
    $resultPath = Join-Path 'C:/ProgramData' ('ShellSpan-system-admission-A-' + $preparedId.ToString() + '/service-result.json')
    $result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
    $receipt = Read-FixedReceipt $target
    if ($result.diagnostic_error -or -not $receipt.profile_removed -or -not $receipt.account_removed -or -not $receipt.filters_removed -or @($receipt.cleanup_debt).Count -ne 0) {
        throw 'Owned recovery remains incomplete; retain the receipt and SID quarantine.'
    }
    if ($receipt.credential_reference -and -not $receipt.credential_removed) {
        throw 'Owned SYSTEM credential retirement is unconfirmed.'
    }
    $final = Get-FixedObservation $target
    if (-not $final.retirement_consistent_with_os) {
        throw 'Final current account/profile/hive state contradicts recorded retirement.'
    }
}
'All three fixed interrupted profile receipts are retired; production remains unavailable.'
