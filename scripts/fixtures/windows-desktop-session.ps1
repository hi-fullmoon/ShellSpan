param(
    [Parameter(Mandatory=$true)][string]$Workspace,
    [Parameter(Mandatory=$true)][string]$Worker,
    [Parameter(Mandatory=$true)][string]$EvidenceDirectory,
    [Parameter(Mandatory=$true)][string]$Config
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($Workspace)
$workerPath = [IO.Path]::GetFullPath($Worker)
$evidence = [IO.Path]::GetFullPath($EvidenceDirectory)
if (-not $workerPath.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Worker must belong to the owned workspace' }
$configPath = [IO.Path]::GetFullPath($Config)
if (-not $configPath.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Config must belong to owned workspace' }
$settings = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$runId = [guid]::Parse($settings.runId).ToString()
if ([IO.Path]::GetFullPath($settings.evidenceDirectory) -ne $evidence) { throw 'Config evidence directory mismatch' }
if (Test-Path -LiteralPath $evidence) { throw 'Acceptance requires a new evidence directory; refusing stale results' }
New-Item -ItemType Directory -Path $evidence | Out-Null
$name = 'Codex-ShellSpan-Desktop-' + [guid]::NewGuid().ToString()
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$service = New-Object -ComObject Schedule.Service
$service.Connect()
$folder = $service.GetFolder('\')
$definition = $service.NewTask(0)
$definition.RegistrationInfo.Description = 'Owned ShellSpan native desktop acceptance'
$definition.Principal.UserId = $user
$definition.Principal.LogonType = 3
$definition.Principal.RunLevel = 0
$definition.Settings.DisallowStartIfOnBatteries = $false
$definition.Settings.StopIfGoingOnBatteries = $false
$definition.Settings.ExecutionTimeLimit = 'PT45M'
$action = $definition.Actions.Create(0)
$action.Path = (Get-Command pwsh.exe).Source
$action.Arguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File "' + $workerPath + '" -Config "' + $configPath + '"'
$action.WorkingDirectory = $root
$registered = $false
try {
    $task = $folder.RegisterTaskDefinition($name, $definition, 2, $user, $null, 3)
    $registered = $true
    $instance = $task.Run($null)
    @{ runId=$runId; taskName=$name; worker=$workerPath; startedAt=(Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $evidence 'task.json')
    $deadline = (Get-Date).AddMinutes(44)
    $startupDeadline = (Get-Date).AddSeconds(30)
    while (-not (Test-Path (Join-Path $evidence 'worker-result.json'))) {
        if ((Get-Date) -ge $deadline) { throw 'Owned desktop worker timed out' }
        if ($task.State -ne 4 -and $task.LastTaskResult -ne 267009 -and (Get-Date) -gt $startupDeadline) {
            throw ('Owned desktop task ended without a result: ' + $task.LastTaskResult)
        }
        Start-Sleep -Milliseconds 500
    }
    $workerResult = Get-Content (Join-Path $evidence 'worker-result.json') -Raw | ConvertFrom-Json
    if ($workerResult.runId -ne $runId) { throw 'Worker result belongs to another acceptance run' }
    $deadline = (Get-Date).AddSeconds(15)
    while ($task.State -eq 4 -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 100 }
    if ($task.State -eq 4 -or $task.LastTaskResult -ne 0) { throw ('Owned task did not exit successfully: ' + $task.LastTaskResult) }
    if (-not $workerResult.ok -or $workerResult.exitCode -ne 0 -or -not $workerResult.originalUserDataUnchanged -or $workerResult.sessionId -eq 0) {
        throw ('Native desktop worker failed: ' + ($workerResult | ConvertTo-Json -Compress))
    }
    $workerResult | ConvertTo-Json -Depth 5
} finally {
    if ($registered) {
        if ($task.State -eq 4) { $task.Stop(0) }
        $folder.DeleteTask($name, 0)
        @{ runId=$runId; taskName=$name; removed=$true; endedAt=(Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $evidence 'task-cleanup.json')
    }
}
