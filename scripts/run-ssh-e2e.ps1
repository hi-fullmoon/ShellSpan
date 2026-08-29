$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
node (Join-Path $workspace 'scripts\run-ssh-e2e.mjs')
if ($LASTEXITCODE -ne 0) { throw "SSH/SFTP end-to-end test failed with exit code $LASTEXITCODE" }
