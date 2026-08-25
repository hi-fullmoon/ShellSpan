param(
  [ValidateRange(1, 100)]
  [int]$Iterations = 3,

  [ValidateRange(1, [long]::MaxValue)]
  [long]$LargeBytes = 16777216,

  [ValidateRange(1, 100000)]
  [int]$SmallFileCount = 128,

  [ValidateRange(1, [long]::MaxValue)]
  [long]$SmallFileBytes = 4096,

  [switch]$DebugBuild
)

$ErrorActionPreference = 'Stop'

$workspace = Split-Path -Parent $PSScriptRoot
$composeFile = Join-Path $workspace 'tests\ssh-e2e\compose.yml'
$projectName = 'termbridge-sftp-benchmark'

try {
  docker compose --project-name $projectName --file $composeFile up --build --detach --wait
  $env:TERMBRIDGE_E2E_SSH_HOST = '127.0.0.1'
  $env:TERMBRIDGE_E2E_SSH_PORT = '22222'
  $env:TERMBRIDGE_E2E_SSH_USERNAME = 'termbridge'
  $env:TERMBRIDGE_E2E_SSH_PASSWORD = 'termbridge-e2e'
  $env:TERMBRIDGE_SFTP_BENCH_ITERATIONS = $Iterations.ToString()
  $env:TERMBRIDGE_SFTP_BENCH_LARGE_BYTES = $LargeBytes.ToString()
  $env:TERMBRIDGE_SFTP_BENCH_SMALL_FILE_COUNT = $SmallFileCount.ToString()
  $env:TERMBRIDGE_SFTP_BENCH_SMALL_FILE_BYTES = $SmallFileBytes.ToString()

  $cargoArguments = @('test')
  if (-not $DebugBuild) { $cargoArguments += '--release' }
  $cargoArguments += @(
    '--manifest-path', (Join-Path $workspace 'src-tauri\Cargo.toml'),
    'remote_fs::tests::isolated_sftp_transfer_benchmark',
    '--', '--ignored', '--exact', '--nocapture', '--test-threads=1'
  )
  & cargo $cargoArguments
  if ($LASTEXITCODE -ne 0) { throw "SFTP benchmark failed with exit code $LASTEXITCODE" }
} finally {
  docker compose --project-name $projectName --file $composeFile down --volumes --remove-orphans
}
