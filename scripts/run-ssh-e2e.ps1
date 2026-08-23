$ErrorActionPreference = 'Stop'

$workspace = Split-Path -Parent $PSScriptRoot
$composeFile = Join-Path $workspace 'tests\ssh-e2e\compose.yml'
$projectName = 'termbridge-e2e'

try {
  docker compose --project-name $projectName --file $composeFile up --build --detach --wait
  $env:TERMBRIDGE_E2E_SSH_HOST = '127.0.0.1'
  $env:TERMBRIDGE_E2E_SSH_PORT = '22222'
  $env:TERMBRIDGE_E2E_SSH_USERNAME = 'termbridge'
  $env:TERMBRIDGE_E2E_SSH_PASSWORD = 'termbridge-e2e'
  cargo test --manifest-path (Join-Path $workspace 'src-tauri\Cargo.toml') isolated_ssh_sftp_end_to_end -- --ignored --nocapture
  if ($LASTEXITCODE -ne 0) { throw "SSH/SFTP end-to-end test failed with exit code $LASTEXITCODE" }
} finally {
  docker compose --project-name $projectName --file $composeFile down --volumes --remove-orphans
}
