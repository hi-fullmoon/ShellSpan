param([switch]$RunOwnedFixture)
$ErrorActionPreference = 'Stop'

# Run the build with the desktop user's identity, never inside the elevated child.
$manifestPath = Join-Path $PSScriptRoot 'Cargo.toml'
& cargo build --locked --manifest-path $manifestPath
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$executablePath = Join-Path $PSScriptRoot 'target/debug/shellspan-account-sandbox-prototype.exe'
if (-not $RunOwnedFixture) {
    & $executablePath
    exit $LASTEXITCODE
}

# This explicit switch is the setup action. Windows presents UAC; cancellation
# must be reported as unavailable. Do not elevate the desktop or run cargo as admin.
try {
    $prototypeProcess = Start-Process -FilePath $executablePath -ArgumentList '--run-owned-fixture' -Verb RunAs -WindowStyle Hidden -PassThru
} catch {
    throw "Stage A unavailable: elevated fixture action was cancelled or failed. $($_.Exception.Message)"
}
if (-not $prototypeProcess.WaitForExit(30000)) {
    throw "Stage A unavailable: elevated fixture still running. Do not terminate or rerun blindly; inspect its protected ownership receipt and finish cleanup."
}
$prototypeProcess.Refresh()
if ($prototypeProcess.ExitCode -ne 0) {
    throw "Stage A NO-GO (exit $($prototypeProcess.ExitCode)). Inspect ProgramData/ShellSpan-stage-A-<UUID>/ownership.json as administrator."
}
