function Select-OwnedNativeProcessTree {
  param([object[]]$Processes,[int]$RootPid,[int]$OwnerPid,[string]$RootExecutable)
  $root=@($Processes|Where-Object {$_.ProcessId-eq $RootPid})
  if($root.Count-eq 0){
    if(@($Processes|Where-Object {$_.ParentProcessId-eq $RootPid}).Count){throw 'Missing root has possible descendants; ownership is unproven'}
    return [pscustomobject]@{alreadyExited=$true;processes=@();rejectedEdges=@()}
  }
  $owner=@($Processes|Where-Object {$_.ProcessId-eq $OwnerPid})
  if($root.Count-ne 1-or$owner.Count-ne 1-or$RootPid-eq$OwnerPid-or
    $root[0].ParentProcessId-ne$OwnerPid-or
    -not [string]::Equals($root[0].ExecutablePath,$RootExecutable,[StringComparison]::OrdinalIgnoreCase)-or
    $null-eq$root[0].CreationDate-or$null-eq$owner[0].CreationDate-or
    [datetime]$root[0].CreationDate-lt[datetime]$owner[0].CreationDate){throw 'Native CLI root identity changed; no process selected'}
  $tree=[Collections.Generic.List[object]]::new();$tree.Add($root[0])
  $rejected=[Collections.Generic.List[object]]::new()
  $seen=[Collections.Generic.HashSet[int]]::new();$null=$seen.Add($RootPid)
  for($index=0;$index-lt$tree.Count;$index++){
    $parent=$tree[$index]
    foreach($child in @($Processes|Where-Object {$_.ParentProcessId-eq$parent.ProcessId})){
      if($seen.Contains([int]$child.ProcessId)){continue}
      if($null-eq$child.CreationDate-or[datetime]$child.CreationDate-lt[datetime]$parent.CreationDate){
        $rejected.Add([pscustomobject]@{pid=$child.ProcessId;parentPid=$parent.ProcessId;reason='child-created-before-current-parent-or-time-unavailable'})
        continue
      }
      $null=$seen.Add([int]$child.ProcessId);$tree.Add($child)
    }
  }
  return [pscustomobject]@{alreadyExited=$false;processes=$tree.ToArray();rejectedEdges=$rejected.ToArray()}
}
