param([Parameter(Mandatory=$true)][string]$DataDirectory,[Parameter(Mandatory=$true)][string]$Workspace)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$data=[IO.Path]::GetFullPath($DataDirectory);$root=[IO.Path]::GetFullPath($Workspace)
if(-not $data.StartsWith($root+'\.native-input-p2\',[StringComparison]::OrdinalIgnoreCase)){throw 'Publisher verification requires owned isolated data'}
$name='PSReadLine.format.ps1xml';$expected='1ca887463598d38aa18236a97a4193b2228d1d8434fa73cc8c7932f42a0565cf'
$source=Join-Path $root ('src-tauri/resources/powershell/PSReadLine/2.4.5/'+$name)
if((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()-cne $expected){throw 'Approved upstream publisher file changed'}
$modules=@(Get-ChildItem -LiteralPath (Join-Path $data 'editors') -Directory)
if($modules.Count-ne 1){throw 'Actual bundled module identity is ambiguous'}
$file=Join-Path $modules[0].FullName ('PSReadLine/2.4.5/'+$name)
if((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()-cne $expected){throw 'Actual publisher file hash differs'}
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
$signature=Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $file
$publisher='CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US'
if($signature.Status-ne 'Valid'-or $signature.SignerCertificate.Subject-cne $publisher){throw 'Actual Microsoft signature is not valid'}
@{file=$file;sha256=$expected;signatureStatus='Valid';publisher=$publisher;signerThumbprint=$signature.SignerCertificate.Thumbprint;version='2.4.5';choice='RunOnceR'}|ConvertTo-Json -Compress
