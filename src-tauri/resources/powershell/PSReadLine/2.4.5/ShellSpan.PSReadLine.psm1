# Load the unmodified upstream module before user profiles configure it.
. "$PSScriptRoot\Upstream.PSReadLine.ps1"

# Windows PowerShell's previous PSReadLine 2.0 default had no predictions.
# Profiles run afterwards and retain control over explicit preferences.
if ($PSVersionTable.PSEdition -eq 'Desktop') {
    Set-PSReadLineOption -PredictionSource None
}
