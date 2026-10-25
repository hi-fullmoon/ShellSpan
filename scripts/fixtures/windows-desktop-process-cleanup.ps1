param([Parameter(Mandatory=$true)][int]$RootPid,[Parameter(Mandatory=$true)][int]$OwnerPid,[Parameter(Mandatory=$true)][string]$RootExecutable,[string]$Output)
$ErrorActionPreference='Stop'
$all=@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,ExecutablePath)
$root=@($all|Where-Object {$_.ProcessId-eq $RootPid})
$result=@{kind='owned-native-cli-process-tree-cleanup';rootPid=$RootPid;ownerPid=$OwnerPid;ok=$false}
try {
  if($root.Count-eq 0){
    if(@($all|Where-Object {$_.ParentProcessId-eq $RootPid}).Count){throw 'Missing root still has descendants; ownership cannot be re-established'}
    $result.alreadyExited=$true;$result.before=@();$result.remaining=@();$result.ok=$true
  }else{
    if($root.Count-ne 1-or $root[0].ParentProcessId-ne $OwnerPid-or -not [string]::Equals($root[0].ExecutablePath,$RootExecutable,[StringComparison]::OrdinalIgnoreCase)){throw 'Native CLI root identity changed; no process terminated'}
    $tree=[Collections.Generic.List[object]]::new();$tree.Add($root[0]);$frontier=@($RootPid)
    while($frontier.Count){
      $children=@($all|Where-Object {$_.ParentProcessId-in $frontier})
      foreach($child in $children){$tree.Add($child)}
      $frontier=@($children|ForEach-Object {$_.ProcessId})
    }
    $known=@($tree|ForEach-Object {@{pid=$_.ProcessId;parentPid=$_.ParentProcessId;created=$_.CreationDate.ToFileTimeUtc().ToString();executable=$_.ExecutablePath}})
    $result.before=$known
    $ErrorActionPreference='Continue'
    & taskkill.exe /PID $RootPid /T /F 2>&1|Out-Null
    $result.taskkillExitCode=$LASTEXITCODE
    $ErrorActionPreference='Stop'
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
  if($Output){$result|ConvertTo-Json -Depth 6|Set-Content -Encoding utf8 -LiteralPath $Output}
}
if(-not $result.ok){throw $result.error}
