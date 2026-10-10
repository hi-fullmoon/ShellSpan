Set-StrictMode -Version Latest

function Get-FixedHivePresence {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string] $Sid)
    $ErrorActionPreference = 'Stop'
    if ($Sid -cnotmatch '\AS-1-5-21-[0-9]+-[0-9]+-[0-9]+-[0-9]+\z') {
        throw 'Invalid fixed profile SID.'
    }
    foreach ($part in $Sid.Split('-')[4..7]) {
        [uint32]$parsedPart = 0
        if (-not [uint32]::TryParse($part,[ref]$parsedPart) -or $parsedPart.ToString() -cne $part) { throw 'Noncanonical fixed profile SID.' }
    }
    if ($Sid.Split('-')[7] -eq '0') { throw 'Fixed profile SID requires a nonzero account RID.' }
    # A denied query must throw; a provider's false result is not absence proof.
    $key = $null
    try {
        $key = [Microsoft.Win32.Registry]::Users.OpenSubKey($Sid, $false)
        return [bool]($null -ne $key)
    } finally {
        if ($null -ne $key) { $key.Dispose() }
    }
}

function Test-FixedServicesAbsent {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string[]] $Names)
    $ErrorActionPreference = 'Stop'
    if ($Names.Count -lt 1 -or $Names.Count -gt 8 -or @($Names | Select-Object -Unique).Count -ne $Names.Count) {
        throw 'Invalid fixed service inventory budget or duplicate names.'
    }
    foreach ($name in $Names) {
        if ($name -cnotmatch '\AShellSpanAdmissionA-[0-9a-f]{32}\z') { throw 'Invalid fixed service name.' }
    }
    if ($PSVersionTable.PSEdition -eq 'Desktop') { Add-Type -AssemblyName System.ServiceProcess }
    $services = [System.ServiceProcess.ServiceController]::GetServices()
    try {
        foreach ($service in $services) {
            if ($Names -contains $service.ServiceName) { return $false }
        }
        return $true
    } finally {
        foreach ($service in $services) { $service.Dispose() }
    }
}

function Get-FixedRecoveryEligibility {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $Receipt,
        [Parameter(Mandatory)][bool] $AccountPresent,
        [Parameter(Mandatory)][bool] $AccountDisabled,
        [Parameter(Mandatory)][bool] $HivePresent,
        [Parameter(Mandatory)][bool] $ProfileLoaded,
        [Parameter(Mandatory)][int] $ProfileRecordCount,
        [Parameter(Mandatory)][bool] $OriginalServicePresent
    )
    $recordedRetirement = $true
    $wellFormed = $true
    # Precise ancestor ACE recovery is not enabled yet. Do not interpret a
    # checkpoint supplied in this new contract as OS-confirmed retirement.
    $ancestorIntent = $Receipt.PSObject.Properties['ancestor_metadata_intent']
    if ($ancestorIntent -and $null -ne $ancestorIntent.Value) {
        $wellFormed = $false
        $recordedRetirement = $false
    }
    foreach ($name in @('profile_removed', 'account_removed', 'filters_removed')) {
        $property = $Receipt.PSObject.Properties[$name]
        if (-not $property -or $property.Value -isnot [bool] -or -not $property.Value) {
            $recordedRetirement = $false
        }
        if (-not $property -or $property.Value -isnot [bool]) { $wellFormed = $false }
    }
    $debt = $Receipt.PSObject.Properties['cleanup_debt']
    if (-not $debt -or $null -eq $debt.Value -or @($debt.Value).Count -ne 0) {
        $recordedRetirement = $false
    }
    if (-not $debt -or $debt.Value -isnot [System.Array]) { $wellFormed = $false }
    $credential = $Receipt.PSObject.Properties['credential_reference']
    if ($credential -and $null -ne $credential.Value) {
        $removed = $Receipt.PSObject.Properties['credential_removed']
        if ($credential.Value -isnot [string] -or -not $removed -or $removed.Value -isnot [bool]) { $wellFormed = $false }
        if ($credential.Value -is [string] -and [string]::IsNullOrWhiteSpace($credential.Value)) { $wellFormed = $false }
        if (-not $removed -or $removed.Value -isnot [bool] -or -not $removed.Value) {
            $recordedRetirement = $false
        }
    }
    foreach ($pair in @(@('package_network_intent','package_filters_removed'),@('rpc_network_intent','rpc_filter_removed'),@('rpc_trace_intent','rpc_trace_removed'))) {
        $intent = $Receipt.PSObject.Properties[$pair[0]]
        $removed = $Receipt.PSObject.Properties[$pair[1]]
        $hasIntent = $intent -and $null -ne $intent.Value
        if ($removed -and $removed.Value -isnot [bool]) { $wellFormed = $false }
        if ($hasIntent) {
            if ($intent.Value -isnot [System.Management.Automation.PSCustomObject] -or -not $removed -or $removed.Value -isnot [bool]) { $wellFormed = $false }
            if (-not $removed -or $removed.Value -isnot [bool] -or -not $removed.Value) { $recordedRetirement = $false }
        } elseif ($removed -and $removed.Value -is [bool] -and $removed.Value) {
            $wellFormed = $false
        }
    }
    $traceStop = $Receipt.PSObject.Properties['rpc_trace_recovery_stopped']
    if ($traceStop) {
        if ($traceStop.Value -isnot [bool]) { $wellFormed = $false }
        if ($traceStop.Value -is [bool] -and $traceStop.Value) {
            $traceIntent = $Receipt.PSObject.Properties['rpc_trace_intent']
            $traceRemoved = $Receipt.PSObject.Properties['rpc_trace_removed']
            $recovery = $Receipt.PSObject.Properties['recovery_executed']
            if (-not $traceIntent -or $null -eq $traceIntent.Value -or -not $traceRemoved -or $traceRemoved.Value -isnot [bool] -or -not $traceRemoved.Value -or -not $recovery -or $recovery.Value -isnot [bool] -or -not $recovery.Value) { $wellFormed = $false }
        }
    }
    $currentQuiet = -not $HivePresent -and -not $ProfileLoaded -and -not $OriginalServicePresent
    $retirementConsistent = $wellFormed -and $recordedRetirement -and $currentQuiet -and -not $AccountPresent -and $ProfileRecordCount -eq 0
    $accountConsistent = $false
    $profileConsistent = $false
    if ($wellFormed) {
        $accountConsistent = if ($AccountPresent) { $AccountDisabled -and -not $Receipt.account_removed } else { $Receipt.profile_removed -and $ProfileRecordCount -eq 0 }
        $profileConsistent = -not $Receipt.profile_removed -or $ProfileRecordCount -eq 0
    }
    $pendingEligible = $wellFormed -and -not $recordedRetirement -and $currentQuiet -and $accountConsistent -and $profileConsistent -and $ProfileRecordCount -ge 0 -and $ProfileRecordCount -le 1
    [pscustomobject]@{
        recorded_retirement = [bool]($wellFormed -and $recordedRetirement)
        retirement_consistent_with_os = [bool]$retirementConsistent
        eligible = [bool]($retirementConsistent -or $pendingEligible)
    }
}

Export-ModuleMember -Function Get-FixedRecoveryEligibility, Get-FixedHivePresence, Test-FixedServicesAbsent
