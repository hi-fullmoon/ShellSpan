# Exact system-r3 process snapshot, without opening any transaction records.
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$output = Join-Path $workspace 'docs/design/evidence/windows-stage-a-2026-10-10-frontend-materialization-system-r3-process-12.json'
if (Test-Path -LiteralPath $output) { throw 'Existing process observation.' }
$id = '310c9957-d9ad-4a2e-9e11-1c878bc74a6f'
$items = @(Get-CimInstance Win32_Process -Filter "Name = 'shellspan-account-sandbox-prototype.exe' OR Name = 'fixed-admission.exe'" | Where-Object { $_.CommandLine -like ('*' + $id + '*') } | ForEach-Object {
    $observedProcess = Get-Process -Id $_.ProcessId -ErrorAction Stop
    $threads = @($observedProcess.Threads | ForEach-Object {
        $reason = $null
        if ($_.ThreadState -eq [Diagnostics.ThreadState]::Wait) { $reason = $_.WaitReason.ToString() }
        [ordered]@{ id = $_.Id; state = $_.ThreadState.ToString(); wait_reason = $reason }
    })
    [ordered]@{ pid = $_.ProcessId; creation = $_.CreationDate; command = $_.CommandLine; cpu_seconds = $observedProcess.CPU; working_set_bytes = $observedProcess.WorkingSet64; handles = $observedProcess.HandleCount; threads = $threads }
})
[ordered]@{ fixture_id = $id; observed_utc = [DateTime]::UtcNow.ToString('o'); records_opened = $false; processes = $items } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $output -Encoding utf8
