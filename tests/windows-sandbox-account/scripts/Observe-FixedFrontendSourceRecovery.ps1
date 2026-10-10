# Read-only terminal audit for exact source transaction; no service actions.
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$output = Join-Path $workspace 'docs/design/evidence/windows-stage-a-2026-10-10-frontend-source-materialization-independent-final-audit.json'
if (Test-Path -LiteralPath $output) { throw 'Observation already recorded.' }
$id = 'a982be11-d802-424e-ba39-dcdfd72a265a'
$recoveryId = '4bea6a19-a71b-4f43-8736-b3a90e921503'
$serviceReceipt = Get-Content -LiteralPath (Join-Path $workspace 'docs/design/evidence/windows-stage-a-2026-10-10-frontend-source-materialization-independent-service.json') -Raw | ConvertFrom-Json
if ($serviceReceipt.fixture_id -ne $recoveryId -or -not $serviceReceipt.service_removed -or -not $serviceReceipt.observed_service_exit.process_exit_confirmed -or $serviceReceipt.observed_service_exit.win32_exit_code -ne 0 -or $serviceReceipt.observed_service_exit.service_specific_exit_code -ne 0) { throw 'Exact successful terminal service receipt required.' }
$admissionRoot = Join-Path 'C:/ProgramData' ('ShellSpan-system-admission-A-' + $id)
$profileRoot = Join-Path 'C:/ProgramData' ('ShellSpan-account-profile-A-' + $id)
$snapshot = [ordered]@{ fixture_id = $id; observed_utc = [DateTime]::UtcNow.ToString('o'); read_only = $true }
$snapshot.processes = @(Get-CimInstance Win32_Process -Filter "Name = 'shellspan-account-sandbox-prototype.exe' OR Name = 'fixed-admission.exe'" | Where-Object { $_.CommandLine -like ('*' + $id + '*') -or $_.CommandLine -like ('*' + $recoveryId + '*') } | ForEach-Object {
    $nativeProcess = Get-Process -Id $_.ProcessId -ErrorAction Stop
    [ordered]@{ pid = $_.ProcessId; creation = $_.CreationDate; command = $_.CommandLine; cpu_seconds = $nativeProcess.CPU; working_set_bytes = $nativeProcess.WorkingSet64; handles = $nativeProcess.HandleCount }
})
if ($snapshot.processes.Count -ne 0) { throw 'Exact transaction process still exists; do not open records.' }
$snapshot.admission_files = @(Get-ChildItem -LiteralPath $admissionRoot -File | Select-Object Name,Length,LastWriteTimeUtc)
$snapshot.profile_exists = Test-Path -LiteralPath $profileRoot
if ($snapshot.profile_exists) {
    $snapshot.profile_files = @(Get-ChildItem -LiteralPath $profileRoot -File | Select-Object Name,Length,LastWriteTimeUtc)
    $snapshot.checkpoint_pages = @(Get-ChildItem -LiteralPath $profileRoot -Filter 'frontend-bundle-page-*.json').Count
    $states = @{}
    foreach ($page in (Get-ChildItem -LiteralPath $profileRoot -Filter 'frontend-bundle-page-*.json')) {
        $pageStream = [IO.File]::Open($page.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
        $pageReader = [IO.StreamReader]::new($pageStream)
        try { $recordPage = $pageReader.ReadToEnd() | ConvertFrom-Json }
        finally { $pageReader.Dispose() }
        foreach ($record in $recordPage.records) {
            $state = [string]$record.state
            if (-not $states.ContainsKey($state)) { $states[$state] = 0 }
            $states[$state]++
        }
    }
    $snapshot.diagnostic_page_states = $states
    $snapshot.states_are_nontransactional_observation = $true
    $snapshot.namespace_exists = Test-Path -LiteralPath (Join-Path $profileRoot 'frontend-source')
    $snapshot.anchor = Get-Content -LiteralPath (Join-Path $profileRoot 'ownership.json') -Raw | ConvertFrom-Json
}
$snapshot | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $output -Encoding utf8
