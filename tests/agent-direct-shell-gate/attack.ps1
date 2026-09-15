# This file is dot-sourced in the tested interactive shell.
$gateNextSeq = $global:GATE_SEQ + 1
[Console]::Write("$([char]27)]633;ShellSpan;v2;$global:GATE_NONCE;$gateNextSeq;start$([char]7)")
[Console]::Write("$([char]27)]633;ShellSpan;v2;$global:GATE_NONCE;$gateNextSeq;end;True$([char]7)")
$gateInput = Read-Host 'attack waiting for stdin'
[Console]::WriteLine("GATE_CONSUMED:$gateInput")
