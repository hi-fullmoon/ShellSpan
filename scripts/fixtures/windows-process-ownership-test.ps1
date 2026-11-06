param([Parameter(Mandatory=$true)][string]$InputFile,[Parameter(Mandatory=$true)][string]$Helper)
$ErrorActionPreference='Stop'
. $Helper
$fixture=Get-Content -LiteralPath $InputFile -Raw|ConvertFrom-Json
foreach($process in $fixture.processes){if($null-ne$process.CreationDate){$process.CreationDate=[datetime]::Parse($process.CreationDate)}}
try{
  $selection=Select-OwnedNativeProcessTree -Processes @($fixture.processes) -RootPid $fixture.rootPid -OwnerPid $fixture.ownerPid -RootExecutable $fixture.rootExecutable
  @{ok=$true;alreadyExited=$selection.alreadyExited;selected=@($selection.processes|ForEach-Object ProcessId);rejected=@($selection.rejectedEdges)}|ConvertTo-Json -Depth 5 -Compress
}catch{@{ok=$false;error=$_.Exception.Message}|ConvertTo-Json -Compress}
