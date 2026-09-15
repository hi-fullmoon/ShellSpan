param([Parameter(Mandatory = $true)][string]$gateNonce)

$global:GATE_NONCE = $gateNonce
$global:GATE_SEQ = 0
function global:prompt { 'GATE_PROMPT>' }
$global:GATE_OLD_PROMPT = $function:prompt
function global:prompt {
    $gateSuccess = $?
    $gateNative = $LASTEXITCODE
    $global:GATE_SEQ++
    [Console]::Write("$([char]27)]633;ShellSpan;v2;$global:GATE_NONCE;$global:GATE_SEQ;end;$gateSuccess;$gateNative$([char]7)")
    [Console]::Write('USER_HOOK')
    & $global:GATE_OLD_PROMPT
}
