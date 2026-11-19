param([Parameter(Mandatory=$true)][string]$Workspace)
$ErrorActionPreference='Stop'
Set-Location $Workspace
$env:CARGO_TERM_COLOR='never'
$env:RUSTUP_TOOLCHAIN='1.95.0-x86_64-pc-windows-msvc'
$manifest=Get-Content -LiteralPath (Join-Path $Workspace 'sources.json') -Raw | ConvertFrom-Json
function Assert-Sources {
  foreach($property in $manifest.PSObject.Properties){
    $actual=(Get-FileHash -LiteralPath (Join-Path $Workspace $property.Name) -Algorithm SHA256).Hash.ToLowerInvariant()
    if($actual-cne $property.Value){throw ('Source drift: '+$property.Name)}
  }
}
Assert-Sources
$environment=@{at=(Get-Date).ToUniversalTime().ToString('o');session=[Diagnostics.Process]::GetCurrentProcess().SessionId;rust=(& rustc --version);cargo=(& cargo --version);node=(& node --version);pnpm=(& pnpm --version)}
$vswhere='C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
if(Test-Path -LiteralPath $vswhere){$environment.visualStudio=(& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -format json | ConvertFrom-Json)}
[IO.File]::WriteAllText((Join-Path $Workspace 'environment.json'),($environment|ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false))
$ErrorActionPreference='Continue'
& cargo.exe build --locked --manifest-path src-tauri/native-input-editors/Cargo.toml --lib --example windows_acceptance *> native-build.log
$code=$LASTEXITCODE
$ErrorActionPreference='Stop'
Assert-Sources
@{exitCode=$code;sourcesMatch=$true}|ConvertTo-Json|Set-Content -Encoding utf8 build-result.json
Get-Content -LiteralPath native-build.log -Tail 16
exit $code
