$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Add-Type -Path (Join-Path $Root 'src-tauri/src/terminal_job_host.cs')
Add-Type -Path (Join-Path $PSScriptRoot 'fixtures/windows-native-job-client-probe.cs')
$Directory = Join-Path ([IO.Path]::GetTempPath()) ('shellspan-worker-failure-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $Directory
$Marker = Join-Path $Directory 'source-effect'
$Packet = @{ Worker = "param(`$packet,`$pipe) [IO.File]::WriteAllText('$Marker','unexpected-source')" }
$Observer = [ShellSpanUnexpectedClientProbe]::new()
$Worker = $null
try {
    $Failure = $null
    try {
        $Process = [Diagnostics.Process]::GetCurrentProcess()
        try { $Executable = $Process.MainModule.FileName } finally { $Process.Dispose() }
        $Worker = [ShellSpanProcessJob]::new($Executable, $Directory, [Management.Automation.PSSerializer]::Serialize($Packet))
    } catch { $Failure = $_.Exception.GetBaseException() }
    if ($null -eq $Failure -or $Failure.Message -ne 'Unexpected native worker pipe client' -or -not $Observer.Connected) {
        throw 'Real unexpected-client startup rejection was not exercised'
    }
    if ($Failure.Data['NativeWorkerCleanupConfirmed'] -ne $true -or (Test-Path -LiteralPath $Marker)) {
        throw 'Failed startup did not establish native cleanup and zero source effects'
    }
    $ChildId = [int]$Failure.Data['NativeWorkerProcessId']
    if (Get-Process -Id $ChildId -ErrorAction SilentlyContinue) { throw 'Owned worker remains after failed startup' }
    Write-Output ('Windows native worker startup rejection/cleanup: PASS (' + $PSVersionTable.PSVersion + ')')
} finally {
    if ($null -ne $Worker) { $Worker.Dispose() }
    $Observer.Dispose()
    Remove-Item -LiteralPath $Directory -Recurse -Force
}
