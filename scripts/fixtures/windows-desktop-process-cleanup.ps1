param([Parameter(Mandatory=$true)][int]$RootPid,[Parameter(Mandatory=$true)][int]$OwnerPid,[Parameter(Mandatory=$true)][string]$RootExecutable,[string]$Output)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'windows-process-ownership.ps1')
$all=@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,ExecutablePath)
$result=@{kind='owned-native-cli-process-tree-cleanup';rootPid=$RootPid;ownerPid=$OwnerPid;ok=$false}
$pinned=[Collections.Generic.List[object]]::new()
try {
  $selection=Select-OwnedNativeProcessTree -Processes $all -RootPid $RootPid -OwnerPid $OwnerPid -RootExecutable $RootExecutable
  $result.rejectedEdges=@($selection.rejectedEdges)
  if($selection.alreadyExited){
    $result.alreadyExited=$true;$result.before=@();$result.remaining=@();$result.ok=$true
  }else{
    $known=@($selection.processes|ForEach-Object {@{pid=$_.ProcessId;parentPid=$_.ParentProcessId;created=([datetime]$_.CreationDate).ToFileTimeUtc().ToString();executable=$_.ExecutablePath}})
    $result.before=$known
    # Pin every identity before terminating any process. A handle remains bound
    # to its original process even if that numeric PID is subsequently reused.
    foreach($entry in $known){
      $process=$null
      try{$process=[Diagnostics.Process]::GetProcessById($entry.pid)}catch [ArgumentException]{continue}
      try{
        $null=$process.Handle
        if($process.HasExited){$process.Dispose();continue}
        $actual=@(Get-CimInstance Win32_Process -Filter ('ProcessId='+$entry.pid) -Property ProcessId,CreationDate,ExecutablePath)
        if($actual.Count-ne1-or$actual[0].CreationDate.ToFileTimeUtc().ToString()-ne$entry.created-or
          -not [string]::Equals($actual[0].ExecutablePath,$entry.executable,[StringComparison]::OrdinalIgnoreCase)-or
          [Math]::Abs($process.StartTime.ToFileTimeUtc()-[long]$entry.created)-ge10){throw 'Native CLI process identity changed while pinning; no process terminated'}
        $pinned.Add($process);$process=$null
      }finally{if($null-ne$process){$process.Dispose()}}
    }
    for($index=$pinned.Count-1;$index-ge0;$index--){if(-not$pinned[$index].HasExited){$pinned[$index].Kill()}}
    $result.termination='verified-process-handles';$result.treeKillUsed=$false
    $deadline=[Diagnostics.Stopwatch]::StartNew()
    do {
      $current=@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,ExecutablePath)
      $remaining=@(foreach($entry in $known){$match=@($current|Where-Object {$_.ProcessId-eq $entry.pid-and $_.CreationDate.ToFileTimeUtc().ToString()-eq $entry.created-and $_.ExecutablePath-eq $entry.executable});if($match.Count){$entry}})
      if($remaining.Count-eq 0){break}
      Start-Sleep -Milliseconds 100
    }while($deadline.ElapsedMilliseconds-lt 5000)
    $result.remaining=$remaining
    if($remaining.Count){throw ('Owned native CLI processes remain: '+(($remaining|ForEach-Object {$_.pid})-join ','))}
    $result.ok=$true
  }
}catch{$result.error=$_.Exception.Message}
finally{
  foreach($process in $pinned){$process.Dispose()}
  if($Output){$result|ConvertTo-Json -Depth 6|Set-Content -Encoding utf8 -LiteralPath $Output}
}
if(-not $result.ok){throw $result.error}
