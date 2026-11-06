param([Parameter(Mandatory=$true)][string]$Output,[int]$MaxEntries=2048)
$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$artifactRoot=[IO.Path]::GetFullPath((Join-Path $project '.artifacts/tests'))
$outputPath=[IO.Path]::GetFullPath($Output)
if(-not $outputPath.StartsWith($artifactRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){
  throw 'Foreground observation output must be owned test evidence'
}
if($MaxEntries-lt 1-or $MaxEntries-gt 2048){throw 'Invalid foreground observation bound'}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ShellSpanForegroundObservation {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
}
'@
$stream=[IO.File]::Open($outputPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
$writer=[IO.StreamWriter]::new($stream,[Text.UTF8Encoding]::new($false))
$previous='';$entries=0;$overflow=$false
$deadline=[DateTime]::UtcNow.AddMinutes(20)
try{
  while([DateTime]::UtcNow-lt $deadline-and -not [IO.File]::Exists($outputPath+'.stop')){
    $window=[ShellSpanForegroundObservation]::GetForegroundWindow()
    [uint32]$foregroundProcessId=0
    $null=[ShellSpanForegroundObservation]::GetWindowThreadProcessId($window,[ref]$foregroundProcessId)
    $identity=[string]$window.ToInt64()+':'+[string]$foregroundProcessId
    if($identity-cne $previous){
      if($entries-ge $MaxEntries){$overflow=$true;break}
      $name='unavailable'
      try{$name=[Diagnostics.Process]::GetProcessById([int]$foregroundProcessId).ProcessName}catch{}
      $writer.WriteLine((@{at=[DateTime]::UtcNow.ToString('o');window=$window.ToInt64();pid=$foregroundProcessId;processName=$name}|ConvertTo-Json -Compress))
      $writer.Flush();$entries++;$previous=$identity
    }
    Start-Sleep -Milliseconds 100
  }
}finally{
  $writer.Dispose();$stream.Dispose()
  @{at=[DateTime]::UtcNow.ToString('o');entries=$entries;overflow=$overflow;inputInjected=$false;focusActivated=$false;windowTitlesCaptured=$false}|ConvertTo-Json -Compress|Set-Content -LiteralPath ($outputPath+'.summary.json')
}
