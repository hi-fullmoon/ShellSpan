param([Parameter(Mandatory=$true)][string]$Output)
$ErrorActionPreference='Stop'
Import-Module PSReadLine
$path=(Get-PSReadLineOption).HistorySavePath
$record=@{historyPath=$path;engine=$PSVersionTable.PSVersion.ToString();module=(Get-Module PSReadLine).Version.ToString();contentExported=$false;exists=(Test-Path -LiteralPath $path)}
if($record.exists){
    $before=Get-Item -LiteralPath $path
    $stream=[IO.File]::OpenRead($path);$algorithm=[Security.Cryptography.SHA256]::Create()
    try{$record.sha256=[BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-','').ToLowerInvariant()}
    finally{$algorithm.Dispose();$stream.Dispose()}
    $after=Get-Item -LiteralPath $path
    if($before.Length-ne $after.Length-or $before.LastWriteTimeUtc-ne $after.LastWriteTimeUtc){throw 'Original history changed during read-only audit'}
    $record.bytes=$after.Length;$record.lastWriteTimeUtc=$after.LastWriteTimeUtc.ToString('o')
}
[IO.File]::WriteAllText($Output,($record|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
