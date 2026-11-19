# Owned acceptance-only user hook. The first precmd runs after native startup
# installed its preexec hook, so this gate follows the real native Started.
autoload -Uz add-zsh-hook
p3_handoff_gate() {
  [[ -f $HOME/handoff-gate-source && ! -e $HOME/handoff-gate-entered ]] || return 0
  [[ $1 == "$(<$HOME/handoff-gate-source)" ]] || return 0
  builtin print -rn -- "$1" > "$HOME/handoff-gate-actual-source"
  builtin print -rn -- "$$" > "$HOME/handoff-gate-parent-pid"
  builtin print -rn -- entered > "$HOME/handoff-gate-entered"
  local p3_gate_value
  IFS= read -r p3_gate_value < "$HOME/handoff-gate.fifo"
}
p3_install_handoff_gate() {
  add-zsh-hook -d precmd p3_install_handoff_gate
  add-zsh-hook preexec p3_handoff_gate
}
add-zsh-hook precmd p3_install_handoff_gate
