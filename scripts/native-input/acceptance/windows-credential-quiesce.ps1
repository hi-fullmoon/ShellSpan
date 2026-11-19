param([Parameter(Mandatory=$true)][string]$Config)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$settings=Get-Content -LiteralPath $Config -Raw|ConvertFrom-Json
$root=[IO.Path]::GetFullPath($settings.workspace);$evidence=[IO.Path]::GetFullPath($settings.evidenceDirectory)
if(-not $evidence.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Owned writer evidence path mismatch'}
$runId=[guid]::Parse($settings.runId).ToString()
$record=Get-Content -LiteralPath (Join-Path $evidence 'worker-process.json') -Raw|ConvertFrom-Json
if($record.runId-ne $runId){throw 'Owned writer identity mismatch'}
# A cooperative marker is observed both before every launch and while the
# owned CLI is running. The worker stops its actual CLI process tree, waits for
# exit, then performs cleanup; a lost SSH connection alone is never exit proof.
@{runId=$runId;reason='owning SSH orchestration ended';requestedAt=(Get-Date).ToUniversalTime().ToString('o')}|ConvertTo-Json|Set-Content -Encoding utf8 (Join-Path $evidence 'cancel-owned-writers.json')
$deadline=[Diagnostics.Stopwatch]::StartNew()
do{
 $current=Get-CimInstance Win32_Process -Filter ('ProcessId='+$record.pid)
 $same=$current-and $current.CreationDate.ToFileTimeUtc().ToString()-eq $record.created-and $current.ExecutablePath-eq $record.executable
 if(-not $same){break}
 if($deadline.ElapsedMilliseconds-ge 180000){throw 'Original owned writer has not exited; no recovery writer may start'}
 Start-Sleep -Milliseconds 100
}while($true)
$phases=@($evidence,(Join-Path $evidence 'provision'),(Join-Path $evidence 'verify-absence'),(Join-Path $root ('artifacts/tests/native-input/integration/w7-'+$runId)),(Join-Path $root ('artifacts/tests/native-input/integration/w51-'+$runId)))
foreach($phase in $phases){
 if(-not (Test-Path $phase)){continue}
 foreach($file in @(Get-ChildItem -LiteralPath $phase -Filter '*-process.json' -File)){
  $process=Get-Content -LiteralPath $file.FullName -Raw|ConvertFrom-Json
  $id=if($process.appPid){$process.appPid}else{$process.pid}
  if(-not $id){continue}
  $actual=Get-CimInstance Win32_Process -Filter ('ProcessId='+$id)
  if($actual){
   if($process.appPid-and $actual.ExecutablePath-eq $process.executable){throw 'Original owned native application is still running; recovery is forbidden'}
   if($process.created-and $actual.CreationDate.ToFileTimeUtc().ToString()-eq $process.created-and $actual.ExecutablePath-eq $process.executable){throw 'Original owned native CLI is still running; recovery is forbidden'}
  }
 }
}
$proof=@{runId=$runId;originalWriterExited=$true;actualOwnedCliAndImagesExited=$true;checkedAt=(Get-Date).ToUniversalTime().ToString('o')}
$proof|ConvertTo-Json|Set-Content -Encoding utf8 (Join-Path $evidence 'credential-writers-quiesced.json')
$proof|ConvertTo-Json -Compress
