Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'InterruptedProfileGate.psm1') -Force

foreach ($sid in @('S-1-5-18', 'S-1-5-21-1-2-3-4\Other', '', 'S-1-5-21-1-2-3-4/Other','s-1-5-21-1-2-3-4','S-1-5-21-01-2-3-4','S-1-5-21-1-2-3-4294967296','S-1-5-21-1-2-3-0',"S-1-5-21-1-2-3-4`n")) {
    $rejected = $false
    try { $null = Get-FixedHivePresence -Sid $sid } catch { $rejected = $true }
    if (-not $rejected) { throw 'Hive query accepted a non-profile SID or path.' }
}
# An actual lookup of a nonexistent owned-form SID must return a boolean false.
$presence = Get-FixedHivePresence -Sid 'S-1-5-21-4294967295-4294967295-4294967295-4294967295'
if ($presence -isnot [bool] -or $presence) { throw 'Absent test hive was not confirmed absent.' }
$missingService = 'ShellSpanAdmissionA-' + [Guid]::NewGuid().ToString('N')
if (-not (Test-FixedServicesAbsent -Names @($missingService))) { throw 'Absent owned test service was not confirmed absent.' }
foreach ($names in @(@('Spooler'), @($missingService, $missingService), @('ShellSpanAdmissionA-../other'),@($missingService+"`n"))) {
    $rejected = $false
    try { $null = Test-FixedServicesAbsent -Names $names } catch { $rejected = $true }
    if (-not $rejected) { throw 'Service inventory accepted an unrelated name, duplicate or path.' }
}

function New-Receipt([bool]$retired) {
    [pscustomobject]@{ profile_removed=$retired; account_removed=$retired; filters_removed=$retired; cleanup_debt=@(); credential_reference=$null; credential_removed=$false }
}
function Assert-Eligibility($receipt, [hashtable]$actual, [bool]$expected, [string]$reason) {
    $gate = Get-FixedRecoveryEligibility -Receipt $receipt @actual
    if ($gate.eligible -ne $expected) { throw ('Recovery gate mismatch: ' + $reason) }
}
$absent = @{AccountPresent=$false;AccountDisabled=$false;HivePresent=$false;ProfileLoaded=$false;ProfileRecordCount=0;OriginalServicePresent=$false}
foreach ($ancestorValue in @([pscustomobject]@{states=@('retired','retired')}, 'unsupported', $false)) {
    $ancestorReceipt = New-Receipt $true
    $ancestorReceipt | Add-Member -NotePropertyName ancestor_metadata_intent -NotePropertyValue $ancestorValue
    Assert-Eligibility $ancestorReceipt $absent $false 'ancestor retirement needs exact OS handler'
    $ancestorGate = Get-FixedRecoveryEligibility -Receipt $ancestorReceipt @absent
    if ($ancestorGate.recorded_retirement) { throw 'Unsupported ancestor checkpoint claimed retirement.' }
}
Assert-Eligibility (New-Receipt $true) $absent $true 'retired receipt and quiet OS can be revalidated natively'
foreach ($field in @('AccountPresent','HivePresent','ProfileLoaded','OriginalServicePresent')) {
    $contradiction = $absent.Clone()
    $contradiction[$field] = $true
    Assert-Eligibility (New-Receipt $true) $contradiction $false ('stale retirement with actual ' + $field)
}
$profileExists = $absent.Clone(); $profileExists.ProfileRecordCount = 1
Assert-Eligibility (New-Receipt $true) $profileExists $false 'retired profile still has a current binding'
$pending = $absent.Clone(); $pending.AccountPresent=$true; $pending.AccountDisabled=$true; $pending.ProfileRecordCount=1
Assert-Eligibility (New-Receipt $false) $pending $true 'disabled pending account after hive unload'
foreach ($field in @('HivePresent','ProfileLoaded','OriginalServicePresent')) {
    $blocked = $pending.Clone(); $blocked[$field]=$true
    Assert-Eligibility (New-Receipt $false) $blocked $false ('pending account blocked by ' + $field)
}
$enabled = $pending.Clone(); $enabled.AccountDisabled=$false
Assert-Eligibility (New-Receipt $false) $enabled $false 'enabled account must not dispatch recovery'
Assert-Eligibility (New-Receipt $false) $absent $false 'missing account before recorded profile retirement'
$partial = New-Receipt $false; $partial.profile_removed=$true; $partial.account_removed=$true; $partial.cleanup_debt=@('filter retirement remains')
Assert-Eligibility $partial $absent $true 'partial account retirement can resume remaining native cleanup'
Assert-Eligibility $partial $pending $false 'retired account cannot reappear under the same name'
foreach ($value in @('true', 1, $null)) {
    $malformed = New-Receipt $false; $malformed.profile_removed=$value
    Assert-Eligibility $malformed $pending $false 'nonboolean receipt must fail closed'
}
$credential = New-Receipt $true; $credential.credential_reference='fixed-test-reference'
Assert-Eligibility $credential $absent $true 'unremoved credential goes through native cleanup again'
if ((Get-FixedRecoveryEligibility -Receipt $credential @absent).retirement_consistent_with_os) { throw 'Unremoved credential cannot claim consistent retirement.' }
$credential.credential_removed=$true
Assert-Eligibility $credential $absent $true 'removed credential still requires native revalidation'
$credential.credential_removed='true'
Assert-Eligibility $credential $absent $false 'credential removal must be boolean'
foreach ($value in @($false, 0, '', '   ', [pscustomobject]@{})) {
    $malformed = New-Receipt $true; $malformed.credential_reference=$value; $malformed.credential_removed=$true
    Assert-Eligibility $malformed $absent $false 'present malformed credential cannot bypass retired receipt validation'
    Assert-Eligibility $malformed $pending $false 'malformed credential cannot dispatch pending cleanup'
}
foreach ($pair in @(@('package_network_intent','package_filters_removed'),@('rpc_network_intent','rpc_filter_removed'),@('rpc_trace_intent','rpc_trace_removed'))) {
    $receipt = New-Receipt $true
    $receipt | Add-Member -NotePropertyName $pair[0] -NotePropertyValue ([pscustomobject]@{version=1})
    $receipt | Add-Member -NotePropertyName $pair[1] -NotePropertyValue $false
    if ((Get-FixedRecoveryEligibility -Receipt $receipt @absent).recorded_retirement) { throw 'Unretired additional resource falsely marked complete.' }
    Assert-Eligibility $receipt $absent $true 'remaining resource requires native recovery'
    $receipt.($pair[1])=$true
    if (-not (Get-FixedRecoveryEligibility -Receipt $receipt @absent).recorded_retirement) { throw 'Completed additional resource not recognized.' }
    $receipt.($pair[0])=$null
    Assert-Eligibility $receipt $absent $false 'completion without additional resource intent rejected'
    $receipt.($pair[1])='true'
    Assert-Eligibility $receipt $absent $false 'additional resource completion must be boolean'
}
$orphanStop=New-Receipt $true
$orphanStop | Add-Member -NotePropertyName rpc_trace_recovery_stopped -NotePropertyValue $true
Assert-Eligibility $orphanStop $absent $false 'trace recovery STOP requires intent, absence and recovery context'
'Interrupted profile gate regression checks passed.'
