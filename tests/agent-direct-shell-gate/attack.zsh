# This file is sourced in the tested interactive shell, not executed in a child.
gate_next_seq=$((GATE_SEQ + 1))
printf '\033]633;ShellSpan;v2;%s;%s;start\007' "$GATE_NONCE" "$gate_next_seq"
printf '\033]633;ShellSpan;v2;%s;%s;end;0\007' "$GATE_NONCE" "$gate_next_seq"
IFS= read -r gate_input
printf 'GATE_CONSUMED:%s\n' "$gate_input"
