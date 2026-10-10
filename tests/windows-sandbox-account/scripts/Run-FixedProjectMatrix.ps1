# Fixed diagnostic only. No command/path/identity parameters; production stays unavailable.
[CmdletBinding()]
param([ValidateSet('CredentialReset', 'NewAds', 'ConcurrentCancel', 'ReceiverDrain', 'ReceiverFinalControls', 'TcpListener', 'TcpListenerBounded', 'PrivateNetwork', 'DnsNetwork', 'DnsContexts', 'DnsSyncCache', 'DnsSidBlock', 'IdentityCredential', 'PowerShellBuild', 'PowerShellPersistedBuild', 'PowerShellDigestBuild', 'PowerShellSourceBuild', 'PowerShellPinnedSourceBuild', 'PowerShellSourceWriteDenied', 'GitInit', 'GitMetadataInit', 'GitMetadataPrefix', 'GitMetadataPartialFailure', 'GitMetadataCheckpointCrash', 'GitCeilingInit', 'GitRelativeInit', 'GitPrefix', 'NodeOwnedCwd', 'PowerShellOwnedCwd', 'NodeValidatedJournal', 'NodeProject', 'NodeMetadataProject', 'CrossSlotRegistry', 'CrossSlotRegistryAccess', 'NodePackageBlock', 'NodePackageBlockIndexed', 'DnsPackageBlockDefault', 'DnsPackageBlockMatrix', 'DnsPackageBlockInternet', 'NodeRpcBlock', 'DnsRpcBlockInternet', 'DnsSenderIdentity','DnsProtectedRpcTrace','DnsRpcProviderRegistration','RpcTraceServiceCrash','RpcTraceServiceCrashStopHybrid','DnsRpcInstrumentationInternet','DnsRpcInstrumentationDefault')][string]$Case = 'CredentialReset')
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'InterruptedProfileGate.psm1') -Force
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$prototype = Join-Path $workspace 'tests/windows-sandbox-account/target/debug/shellspan-account-sandbox-prototype.exe'
$evidence = Join-Path $workspace 'docs/design/evidence'
$prefix = switch ($Case) {
    'CredentialReset' { 'windows-stage-a-2026-10-09-credential-reset' }
    'NewAds' { 'windows-stage-a-2026-10-09-new-ads-system' }
    'ConcurrentCancel' { 'windows-stage-a-2026-10-09-concurrent-cancel-system' }
    'ReceiverDrain' { 'windows-stage-a-2026-10-09-receiver-drain-system' }
    'ReceiverFinalControls' { 'windows-stage-a-2026-10-09-receiver-final-controls-system' }
    'TcpListener' { 'windows-stage-a-2026-10-09-tcp-listener-system' }
    'TcpListenerBounded' { 'windows-stage-a-2026-10-09-tcp-listener-bounded-system' }
    'PrivateNetwork' { 'windows-stage-a-2026-10-09-private-network-system' }
    'DnsNetwork' { 'windows-stage-a-2026-10-09-dns-network-system' }
    'DnsContexts' { 'windows-stage-a-2026-10-09-dns-contexts-system' }
    'DnsSyncCache' { 'windows-stage-a-2026-10-09-dns-sync-cache-system' }
    'DnsSidBlock' { 'windows-stage-a-2026-10-09-dns-sid-block-system' }
    'PowerShellOwnedCwd' { 'windows-stage-a-2026-10-09-powershell7-owned-cwd-system' }
    'DnsRpcInstrumentationInternet' { 'windows-stage-a-2026-10-09-dns-rpc-instrumentation-internet-system' }
    'DnsRpcInstrumentationDefault' { 'windows-stage-a-2026-10-09-dns-rpc-instrumentation-default-system' }
    'RpcTraceServiceCrashStopHybrid' { 'windows-stage-a-2026-10-09-rpc-trace-service-crash-stop-hybrid-system' }
    'RpcTraceServiceCrash' { 'windows-stage-a-2026-10-09-rpc-trace-service-crash-system' }
    'DnsRpcProviderRegistration' { 'windows-stage-a-2026-10-09-dns-rpc-provider-registration-system' }
    'DnsProtectedRpcTrace' { 'windows-stage-a-2026-10-09-dns-protected-rpc-trace-system' }
    'DnsSenderIdentity' { 'windows-stage-a-2026-10-09-dns-sender-identity-system' }
    'DnsRpcBlockInternet' { 'windows-stage-a-2026-10-09-dns-rpc-block-internet-system' }
    'NodeRpcBlock' { 'windows-stage-a-2026-10-09-node-rpc-block-system' }
    'DnsPackageBlockInternet' { 'windows-stage-a-2026-10-09-dns-package-block-internet-system' }
    'DnsPackageBlockMatrix' { 'windows-stage-a-2026-10-09-dns-package-block-matrix-system' }
    'DnsPackageBlockDefault' { 'windows-stage-a-2026-10-09-dns-package-block-default-system' }
    'NodePackageBlockIndexed' { 'windows-stage-a-2026-10-09-node-package-block-indexed-system' }
    'NodePackageBlock' { 'windows-stage-a-2026-10-09-node-package-block-system' }
    'CrossSlotRegistryAccess' { 'windows-stage-a-2026-10-09-cross-slot-registry-access-system' }
    'CrossSlotRegistry' { 'windows-stage-a-2026-10-09-cross-slot-registry-system' }
    'NodeValidatedJournal' { 'windows-stage-a-2026-10-09-node-validated-journal-system' }
    'NodeProject' { 'windows-stage-a-2026-10-10-node-project-system' }
    'NodeMetadataProject' { 'windows-stage-a-2026-10-10-node-metadata-project-system' }
    'NodeOwnedCwd' { 'windows-stage-a-2026-10-09-node-cwd-assertion-system' }
    'GitPrefix' { 'windows-stage-a-2026-10-09-git-prefix-system' }
    'GitInit' { 'windows-stage-a-2026-10-09-git-init-system' }
    'GitMetadataInit' { 'windows-stage-a-2026-10-09-git-metadata-init-system' }
    'GitMetadataPrefix' { 'windows-stage-a-2026-10-09-git-metadata-prefix-system' }
    'GitMetadataPartialFailure' { 'windows-stage-a-2026-10-09-git-metadata-partial-failure-system' }
    'GitMetadataCheckpointCrash' { 'windows-stage-a-2026-10-09-git-metadata-checkpoint-crash-system' }
    'GitCeilingInit' { 'windows-stage-a-2026-10-09-git-ceiling-init-system' }
    'GitRelativeInit' { 'windows-stage-a-2026-10-09-git-relative-init-system' }
    'PowerShellSourceWriteDenied' { 'windows-stage-a-2026-10-09-powershell7-source-write-denied-system' }
    'PowerShellPinnedSourceBuild' { 'windows-stage-a-2026-10-09-powershell7-pinned-source-build-system' }
    'PowerShellSourceBuild' { 'windows-stage-a-2026-10-09-powershell7-source-file-build-system' }
    'PowerShellDigestBuild' { 'windows-stage-a-2026-10-09-powershell7-digest-build-system' }
    'PowerShellPersistedBuild' { 'windows-stage-a-2026-10-09-powershell7-persisted-build-system' }
    'PowerShellBuild' { 'windows-stage-a-2026-10-09-powershell7-build-system' }
    'IdentityCredential' { 'windows-stage-a-2026-10-09-identity-credential-system' }
}
if ($Case -eq 'DnsSenderIdentity') {
    $serviceBefore=Get-CimInstance Win32_Service -Filter "Name='Dnscache'"
    $processBefore=Get-CimInstance Win32_Process -Filter ("ProcessId="+$serviceBefore.ProcessId)
}
# This evidence run is single use; reject before preparing resources if repeated.
foreach ($name in @('preparation','service','profile','recovery-preparation','recovery-service','recovered-profile','os-audit')) {
    if (Test-Path -LiteralPath (Join-Path $evidence ($prefix + '-' + $name + '.json'))) { throw 'Fixed evidence already exists; do not overwrite or repeat this run.' }
}

function Save-Evidence($Name, $Value) {
    $Value | ConvertTo-Json -Depth 100 | Out-File -LiteralPath (Join-Path $evidence ($prefix + '-' + $Name + '.json')) -Encoding utf8
}
$preparation = if ($Case -eq 'NodeMetadataProject') {
    (& $prototype --prepare-owned-system-node-metadata-project | Out-String) | ConvertFrom-Json
} elseif ($Case -eq 'NodeProject') {
    (& $prototype --prepare-owned-system-node-project | Out-String) | ConvertFrom-Json
} elseif ($Case -eq 'DnsRpcInstrumentationDefault') {
    (& $prototype --prepare-owned-system-dns-rpc-instrumentation-default-diagnostic | Out-String) | ConvertFrom-Json
} elseif ($Case -eq 'DnsRpcInstrumentationInternet') {
    (& $prototype --prepare-owned-system-dns-rpc-instrumentation-internet-diagnostic | Out-String) | ConvertFrom-Json
} elseif ($Case -in @('RpcTraceServiceCrash','RpcTraceServiceCrashStopHybrid')) {
    (& $prototype --prepare-owned-system-lifecycle service-crash | Out-String) | ConvertFrom-Json
} elseif ($Case -eq 'ConcurrentCancel') {
    (& $prototype --prepare-owned-system-lifecycle concurrent-cancel | Out-String) | ConvertFrom-Json
} elseif ($Case -in @('DnsRpcBlockInternet','DnsSenderIdentity','DnsProtectedRpcTrace','DnsRpcProviderRegistration')) { (& $prototype --prepare-owned-system-dns-rpc-block-internet-diagnostic | Out-String) | ConvertFrom-Json } elseif ($Case -eq 'NodeRpcBlock') { (& $prototype --prepare-owned-system-node-rpc-block | Out-String) | ConvertFrom-Json } elseif ($Case -eq 'DnsPackageBlockInternet') { (& $prototype --prepare-owned-system-dns-package-block-internet-diagnostic | Out-String) | ConvertFrom-Json } elseif ($Case -in @('DnsPackageBlockDefault','DnsPackageBlockMatrix')) { (& $prototype --prepare-owned-system-dns-package-block | Out-String) | ConvertFrom-Json } elseif ($Case -in @('NodePackageBlock','NodePackageBlockIndexed')) { (& $prototype --prepare-owned-system-node-package-block | Out-String) | ConvertFrom-Json } elseif ($Case -in @('CrossSlotRegistry','CrossSlotRegistryAccess')) { (& $prototype --prepare-owned-system-cross-slot-registry-probe | Out-String) | ConvertFrom-Json } elseif ($Case -in @('NodeOwnedCwd','NodeValidatedJournal')) { (& $prototype --prepare-owned-system-node | Out-String) | ConvertFrom-Json } elseif ($Case -eq 'GitMetadataCheckpointCrash') { (& $prototype --prepare-owned-system-git-metadata-checkpoint-crash | Out-String) | ConvertFrom-Json } elseif ($Case -eq 'GitMetadataPartialFailure') { (& $prototype --prepare-owned-system-git-metadata-partial-failure | Out-String) | ConvertFrom-Json } elseif ($Case -eq 'GitMetadataPrefix') { (& $prototype --prepare-owned-system-git-metadata-prefix | Out-String) | ConvertFrom-Json } elseif ($Case -in @('GitMetadataInit','GitMetadataPrefix','GitMetadataPartialFailure','GitMetadataCheckpointCrash','NodeMetadataProject')) { (& $prototype --prepare-owned-system-git-metadata-init | Out-String) | ConvertFrom-Json } elseif ($Case -eq 'GitPrefix') { (& $prototype --prepare-owned-system-git-prefix-probe | Out-String) | ConvertFrom-Json } elseif ($Case -in @('GitInit','GitCeilingInit','GitRelativeInit')) { (& $prototype --prepare-owned-system-git-init | Out-String) | ConvertFrom-Json } elseif ($Case -in @('PowerShellBuild','PowerShellPersistedBuild','PowerShellDigestBuild','PowerShellSourceBuild','PowerShellPinnedSourceBuild','PowerShellSourceWriteDenied','PowerShellOwnedCwd')) { (& $prototype --prepare-owned-system-powershell7-build | Out-String) | ConvertFrom-Json } else { (& $prototype --prepare-owned-system-workload | Out-String) | ConvertFrom-Json }
$id = [Guid]::Parse($preparation.fixture_id)
if ($id -eq [Guid]::Empty -or -not $preparation.fixed_workload -or $preparation.production -ne 'unavailable') { throw 'Unexpected fixed preparation.' }
Save-Evidence 'preparation' $preparation
$service = (& $prototype --run-owned-system-admission $id.ToString() | Out-String) | ConvertFrom-Json
Save-Evidence 'service' $service
if ($service.fixture_id -ne $id.ToString() -or -not $service.service_removed) { throw 'Service retirement unconfirmed; keep owned receipt, do not retry live service.' }
$ownedRoot = Join-Path 'C:/ProgramData' ('ShellSpan-account-profile-A-' + $id.ToString())
$receiptPath = Join-Path $ownedRoot 'ownership.json'
$receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
Save-Evidence 'profile' $receipt
$recovery = (& $prototype --prepare-owned-system-profile-recovery $id.ToString() | Out-String) | ConvertFrom-Json
$recoveryId = [Guid]::Parse($recovery.fixture_id)
if ($recoveryId -eq [Guid]::Empty -or $recovery.recovery_target -ne $id.ToString() -or $recovery.fixed_workload) { throw 'Unexpected exact recovery preparation.' }
Save-Evidence 'recovery-preparation' $recovery
$recoveryService = (& $prototype --run-owned-system-admission $recoveryId.ToString() | Out-String) | ConvertFrom-Json
Save-Evidence 'recovery-service' $recoveryService
if (-not $recoveryService.service_removed) { throw 'Recovery service retirement unconfirmed.' }
$recovered = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
Save-Evidence 'recovered-profile' $recovered
if (-not $recovered.account_removed -or -not $recovered.profile_removed -or -not $recovered.filters_removed -or -not $recovered.credential_removed -or @($recovered.cleanup_debt).Count -ne 0) { throw 'Recovery incomplete; retain quarantine and exact receipt.' }
$ownedSid = $recovered.account_sid
if ($ownedSid -notmatch '^S-1-5-21-\d+-\d+-\d+-\d+$') { throw 'Invalid recovered SID.' }
$audit = [ordered]@{
    fixture_id = $id.ToString()
    account_absent = (@(Get-CimInstance Win32_UserAccount -Filter "SID='$ownedSid'").Count -eq 0)
    profile_absent = (@(Get-CimInstance Win32_UserProfile -Filter "SID='$ownedSid'").Count -eq 0)
    hive_absent = (-not (Get-FixedHivePresence -Sid $ownedSid))
    services_absent = (Test-FixedServicesAbsent -Names @(('ShellSpanAdmissionA-' + $id.ToString('N')),('ShellSpanAdmissionA-' + $recoveryId.ToString('N'))))
}
Save-Evidence 'os-audit' $audit
if (-not $audit.account_absent -or -not $audit.profile_absent -or -not $audit.hive_absent -or -not $audit.services_absent) { throw 'Current OS state contradicts retirement.' }
if ($Case -in @('GitMetadataInit','GitMetadataPrefix','GitMetadataPartialFailure','GitMetadataCheckpointCrash','NodeMetadataProject')) {
    $ancestorAudit = (& $prototype --inspect-owned-ancestor-retirement $id.ToString() | Out-String) | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $ancestorAudit.fixture_id -ne $id.ToString() -or -not $ancestorAudit.ancestor_package_aces_absent -or $ancestorAudit.exact_objects_verified -ne 2) { throw 'Exact ancestor ACE retirement unconfirmed.' }
    Save-Evidence 'ancestor-os-audit' $ancestorAudit
}

if ($Case -eq 'DnsSenderIdentity') {
    $serviceAfter=Get-CimInstance Win32_Service -Filter "Name='Dnscache'"
    $processAfter=Get-CimInstance Win32_Process -Filter ("ProcessId="+$serviceAfter.ProcessId)
    Save-Evidence 'dns-service-identity' ([ordered]@{
        fixture_id=$id.ToString()
        before=[ordered]@{service_name=$serviceBefore.Name; state=$serviceBefore.State; pid=$serviceBefore.ProcessId; creation_time=$processBefore.CreationDate.ToUniversalTime().ToString('o')}
        after=[ordered]@{service_name=$serviceAfter.Name; state=$serviceAfter.State; pid=$serviceAfter.ProcessId; creation_time=$processAfter.CreationDate.ToUniversalTime().ToString('o')}
    })
}
