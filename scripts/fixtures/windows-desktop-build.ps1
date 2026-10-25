param([Parameter(Mandatory=$true)][string]$Workspace)
$ErrorActionPreference = 'Stop'
Set-Location $Workspace
$env:RUSTUP_TOOLCHAIN = '1.95.0-x86_64-pc-windows-msvc'
$env:OPENSSL_NO_VENDOR = '1'
$env:OPENSSL_STATIC = '1'
$env:OPENSSL_DIR = Join-Path $PWD 'dependency-cache\openssl-3.6.3-msvc-x64'
$env:CARGO_TERM_COLOR = 'never'
$ErrorActionPreference = 'Continue'
& cargo.exe build --locked --manifest-path src-tauri/Cargo.toml --example native_editor_layout --example native_powershell_output_baseline *> desktop-layout-build-msvc.log
$result = $LASTEXITCODE
Get-Content desktop-layout-build-msvc.log -Tail 12
exit $result
