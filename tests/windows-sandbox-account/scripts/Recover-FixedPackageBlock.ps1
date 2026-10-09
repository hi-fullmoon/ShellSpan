# Fixed owned slot only; no path, identity or command parameters.
[CmdletBinding()]
param([ValidateSet('Diagnostic','Retirement')][string]$Case='Diagnostic')
$ErrorActionPreference='Stop'
$workspace=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$exe=Join-Path $workspace 'tests/windows-sandbox-account/target/debug/shellspan-account-sandbox-prototype.exe'
$target='99d3e9a2-d62a-42a5-b27c-1b16599bcb65'
$prefix=Join-Path $workspace ('docs/design/evidence/windows-stage-a-2026-10-09-package-block-recovery-'+$Case.ToLowerInvariant())
foreach($suffix in @('preparation','service','profile')) { if(Test-Path -LiteralPath ($prefix+'-'+$suffix+'.json')) {throw 'Fixed recovery evidence already exists.'} }
$preparation=(& $exe --prepare-owned-system-profile-recovery $target | Out-String) | ConvertFrom-Json
if($preparation.recovery_target -ne $target -or $preparation.fixed_workload){throw 'Recovery binding differs.'}
$preparation | ConvertTo-Json -Depth 100 | Out-File ($prefix+'-preparation.json') -Encoding utf8
$service=(& $exe --run-owned-system-admission $preparation.fixture_id | Out-String) | ConvertFrom-Json
$service | ConvertTo-Json -Depth 100 | Out-File ($prefix+'-service.json') -Encoding utf8
if(-not $service.service_removed){throw 'Recovery service still live; do not repeat.'}
$profile=Get-Content ('C:/ProgramData/ShellSpan-account-profile-A-'+$target+'/ownership.json') -Raw | ConvertFrom-Json
$profile | ConvertTo-Json -Depth 100 | Out-File ($prefix+'-profile.json') -Encoding utf8
if($Case -eq 'Retirement' -and (-not $profile.account_removed -or -not $profile.filters_removed -or -not $profile.package_filters_removed -or @($profile.cleanup_debt).Count -ne 0)){throw 'Retirement not confirmed; retain protected receipt.'}