param(
 [Parameter(Mandatory=$true)][string]$Plan,
 [Parameter(Mandatory=$true)][ValidateSet('SaveNothing','SaveAtExit','SaveIncrementally')][string]$Style
)
$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$allowed=[IO.Path]::GetFullPath((Join-Path $project '.artifacts/tests')).TrimEnd('\')+'\'
if(-not [IO.Path]::IsPathRooted($Plan)-or -not [IO.Path]::GetFullPath($Plan).StartsWith($allowed,[StringComparison]::OrdinalIgnoreCase)){throw 'History reuse plan escaped test evidence'}
$info=Get-Item -LiteralPath $Plan -Force
if($info.PSIsContainer-or ($info.Attributes-band [IO.FileAttributes]::ReparsePoint)-ne 0-or $info.Length-gt 65536){throw 'Invalid history reuse plan'}
$p=Get-Content -LiteralPath $Plan -Raw|ConvertFrom-Json
$root=[IO.Path]::GetFullPath([string]$p.evidence).TrimEnd('\')+'\'
$history=[IO.Path]::GetFullPath([string]$p.history)
if($p.version-ne 1-or $p.reuseId-notmatch '^[a-f0-9-]{36}$'-or -not $root.StartsWith($allowed,[StringComparison]::OrdinalIgnoreCase)-or -not $history.StartsWith((Join-Path $root 'data').TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'History reuse identity/path differs'}
foreach($path in @($Plan,$history)){
 $current=$path
 while($current.Length-ge $root.TrimEnd('\').Length){
  if([IO.File]::Exists($current)-or [IO.Directory]::Exists($current)){
   if(([IO.File]::GetAttributes($current)-band [IO.FileAttributes]::ReparsePoint)-ne 0){throw 'History reuse path cannot traverse a link'}
  }
  $parent=[IO.Path]::GetDirectoryName($current)
  if(-not $parent-or $parent-eq $current){break};$current=$parent
 }
}
function Digest([byte[]]$Bytes){$sha=[Security.Cryptography.SHA256]::Create();try{return [BitConverter]::ToString($sha.ComputeHash($Bytes)).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}}
function Write-Once([string]$Path,$Value){
 $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Value|ConvertTo-Json -Compress -Depth 5))
 $stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
 try{$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Dispose()}
}
$directory=[IO.Path]::GetDirectoryName($Plan)
$started=Join-Path $directory 'seed-started.json';$ready=Join-Path $directory 'seed-ready.json'
foreach($marker in @($started,$ready)){
 if([IO.File]::Exists($marker)){
  $metadata=Get-Item -LiteralPath $marker -Force
  if($metadata.PSIsContainer-or ($metadata.Attributes-band [IO.FileAttributes]::ReparsePoint)-ne 0-or $metadata.Length-gt 65536){throw 'Invalid history reuse marker'}
 }
}
$seed=[Text.UTF8Encoding]::new($false).GetBytes([string]$p.seedText)
if((Digest $seed)-cne $p.seedSha256){throw 'History seed digest differs'}
$applied=$false
if(-not [IO.File]::Exists($ready)){
 if([IO.File]::Exists($started)){throw 'History initialization incomplete; refusing reseed'}
 if([IO.File]::Exists($history)){throw 'History exists without the matching initialized marker'}
 Write-Once $started @{reuseId=$p.reuseId;host=$p.host;mode=$p.mode;maximumVariable=$p.maximumVariable;history=$history;seedSha256=$p.seedSha256;style=$Style}
 if($Style-cne 'SaveNothing'){
  $file=[IO.File]::Open($history,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
  try{$file.Write($seed,0,$seed.Length)}finally{$file.Dispose()}
  if((Digest ([IO.File]::ReadAllBytes($history)))-cne $p.seedSha256){throw 'History seed write verification failed'}
 }
 Write-Once $ready @{reuseId=$p.reuseId;host=$p.host;mode=$p.mode;maximumVariable=$p.maximumVariable;history=$history;seedSha256=$p.seedSha256;style=$Style}
 $applied=$true
}else{
 foreach($file in @($started,$ready)){
  $r=Get-Content -LiteralPath $file -Raw|ConvertFrom-Json
  foreach($key in @('reuseId','host','mode','maximumVariable','seedSha256')){if($r.$key-cne $p.$key){throw 'History reuse marker ownership differs'}}
  if($r.history-cne $history-or $r.style-cne $Style){throw 'History reuse marker options differ'}
 }
 if($Style-cne 'SaveNothing'-and -not [IO.File]::Exists($history)){throw 'Previously initialized history missing; refusing reseed'}
 if($Style-ceq 'SaveNothing'-and [IO.File]::Exists($history)){throw 'SaveNothing unexpectedly created history'}
}
$exists=[IO.File]::Exists($history);$hash=$null;$length=0
if($exists){$content=[IO.File]::ReadAllBytes($history);$hash=Digest $content;$length=$content.Length}
@{seedApplied=$applied;historyBeforeReader=@{exists=$exists;sha256=$hash;bytes=$length};reuseId=$p.reuseId}
