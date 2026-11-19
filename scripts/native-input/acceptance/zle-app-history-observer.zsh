# Passive public ZLE observations in an owned acceptance HOME. No keyboard
# bytes, buffer writes, history mutation, native receipts or acceptance keys.
zmodload zsh/files
autoload -Uz add-zle-hook-widget
typeset -gi p3_app_history_index=0
p3_app_history_snapshot() {
  local p3_destination
  (( p3_app_history_index < 512 )) || return 1
  p3_destination="$HOME/history-observations/$p3_app_history_index"
  builtin mkdir -p -- "$p3_destination" || return 1
  builtin print -rn -- "$BUFFER" > "$p3_destination/editor-buffer"
  builtin print -rn -- "$CURSOR" > "$p3_destination/editor-cursor"
  p3_history_export "$p3_destination"
  (( p3_app_history_index++ ))
  # add-zle-hook-widget stops its chain on a nonzero widget result. Parent
  # command status is preserved by ZLE; the observer must let later hooks run.
  return 0
}
zle -N p3_app_history_snapshot
add-zle-hook-widget line-init p3_app_history_snapshot
add-zle-hook-widget line-pre-redraw p3_app_history_snapshot
