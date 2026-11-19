$ErrorActionPreference='Stop'
function New-OwnedFalseStatus {
  [CmdletBinding()]param()
  $PSCmdlet.WriteError([Management.Automation.ErrorRecord]::new([Exception]::new(),'OwnedStatus',[Management.Automation.ErrorCategory]::NotSpecified,$null))
}
function Invoke-OwnedReader {
  [CmdletBinding()]param()
  $Previous=$?
  $Result='owned-line'
  if(-not $Previous){
    $local:ErrorActionPreference='Ignore'
    $PSCmdlet.WriteError([Management.Automation.ErrorRecord]::new([Exception]::new(),'OwnedReadLineStatus',[Management.Automation.ErrorCategory]::NotSpecified,$null))
  }
  return $Result
}
$before=$Error.Count
New-OwnedFalseStatus -ErrorAction Ignore
$line=Invoke-OwnedReader
$success=$?
@{engine=$PSVersionTable.PSVersion.ToString();line=$line;success=$success;errorsAdded=$Error.Count-$before;preference=$ErrorActionPreference;nativeAcceptance=$false}|ConvertTo-Json -Compress
if($success -or $line-cne 'owned-line' -or $Error.Count-ne $before -or $ErrorActionPreference-cne 'Stop'){exit 1}
