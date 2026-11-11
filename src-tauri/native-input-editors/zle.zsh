# Sourced once after the existing shell's startup files. No eval of user source
# occurs in any widget: .accept-line returns that source to the parent parser.
if ! () {
  local name
  for name in ${(k)functions} ${(k)aliases} ${(k)galiases} ${(k)saliases} ${(k)widgets}; do [[ $name == __shellspan_nip_* ]] && return 1; done
  (( ${+parameters[__shellspan_nip_owned_functions]} || ${+parameters[__shellspan_nip_keymap]} || ${+parameters[__shellspan_nip_scope_previous]} || ${+parameters[__shellspan_nip_scope_applied]} || ${+parameters[SS_NIP_DISPLAY_LINES]} || ${+parameters[SS_NIP_KERNEL_ROWS]} || ${+parameters[SS_NIP_KERNEL_COLS]} )) && return 1
  return 0
}; then
  builtin ss_nip close
  return 1
fi
__shellspan_nip_scope_refresh() {
  local -i SS_NIP_DISPLAY_LINES SS_NIP_KERNEL_ROWS SS_NIP_KERNEL_COLS
  [[ ${parameters[ZLE_NATIVE_APPEND]-} == *special* ]] || return 1
  builtin ss_nip display-budget || return 1
  if (( ! ${+__shellspan_nip_scope_previous} )); then
    typeset -gi __shellspan_nip_scope_previous=$ZLE_NATIVE_APPEND
  fi
  typeset -gi __shellspan_nip_scope_applied=$(( SS_NIP_DISPLAY_LINES > 0 ))
  ZLE_NATIVE_APPEND=$__shellspan_nip_scope_applied
  [[ $ZLE_NATIVE_APPEND == $__shellspan_nip_scope_applied ]]
}
__shellspan_nip_scope_end() {
  if zle && (( ${+__shellspan_nip_scope_applied} )) && [[ $ZLE_NATIVE_APPEND == $__shellspan_nip_scope_applied ]]; then
    ZLE_NATIVE_APPEND=$__shellspan_nip_scope_previous
    zle -R
  fi
  unset __shellspan_nip_scope_previous __shellspan_nip_scope_applied
}
__shellspan_nip_binding_matches() {
  local -a __shellspan_words
  __shellspan_words=(${(z)"$(builtin bindkey -M "${3:-${KEYMAP:-main}}" "$1" 2>/dev/null)"})
  [[ ${#__shellspan_words} == 2 && ${__shellspan_words[2]} == "$2" ]]
}
# Ctrl-X a belongs to zsh's compinit (_expand_alias). Match the Broker's
# ZLE_ACCEPT_KEY and leave user bindings alone when either private key is taken.
if ! __shellspan_nip_binding_matches $'\x18\x1d' undefined-key || ! __shellspan_nip_binding_matches $'\x18\x1e' undefined-key; then
  unfunction __shellspan_nip_binding_matches
  builtin ss_nip close
  return 1
fi
__shellspan_nip_disable() {
  if zle -FL "$SS_NIP_FD" >/dev/null; then zle -F "$SS_NIP_FD"; fi
  builtin ss_nip close
  if zle; then
    if builtin ss_nip eof-owned "$BUFFER" "$CURSOR"; then BUFFER=; CURSOR=0; zle -R; fi
    builtin ss_nip eof-cleared "$BUFFER" "$CURSOR"
  fi
  __shellspan_nip_scope_end
  builtin printf '\e]1337;SetUserVar=ShellSpanNativeInput=MA==\a'
  # An accepted line which has not reached its parent remains guarded. Never
  # turn a failed handoff into permission for a later Enter to execute source.
  if builtin ss_nip pending-handoff; then return 0; fi
  local hook name
  for hook in preexec precmd; do
    name=__shellspan_nip_$hook
    if [[ ${functions[$name]-} == ${__shellspan_nip_owned_functions[$name]-} ]]; then add-zsh-hook -d "$hook" "$name"; fi
  done
  for hook in line-init line-finish; do
    name=__shellspan_nip_${hook//-/_}
    if [[ ${functions[$name]-} == ${__shellspan_nip_owned_functions[$name]-} ]]; then add-zle-hook-widget -d "$hook" "$name"; fi
  done
  if [[ ${functions[__shellspan_nip_accept]-} == ${__shellspan_nip_owned_functions[__shellspan_nip_accept]-} ]] &&
    __shellspan_nip_binding_matches $'\x18\x1d' __shellspan_nip_accept "$__shellspan_nip_keymap"; then builtin bindkey -M "$__shellspan_nip_keymap" $'\x18\x1d' undefined-key; fi
  if [[ ${functions[__shellspan_nip_dispatch]-} == ${__shellspan_nip_owned_functions[__shellspan_nip_dispatch]-} ]] &&
    __shellspan_nip_binding_matches $'\x18\x1e' __shellspan_nip_dispatch "$__shellspan_nip_keymap"; then builtin bindkey -M "$__shellspan_nip_keymap" $'\x18\x1e' undefined-key; fi
  for name in ${(k)__shellspan_nip_owned_functions}; do
    if [[ ${functions[$name]-} == ${__shellspan_nip_owned_functions[$name]} ]]; then
      [[ ${widgets[$name]-} == user:$name ]] && zle -D "$name"
      unfunction "$name"
    fi
  done
  unset __shellspan_nip_owned_functions __shellspan_nip_keymap
  return 0
}
__shellspan_nip_dispatch() {
  local -i __shellspan_nip_previous_rows=$BUFFERLINES
  while true; do
  if [[ -o allexport ]]; then
    __shellspan_nip_disable
    return 0
  fi
  if ! __shellspan_nip_binding_matches $'\x18\x1d' __shellspan_nip_accept || ! __shellspan_nip_binding_matches $'\x18\x1e' __shellspan_nip_dispatch; then
    __shellspan_nip_disable
    return 0
  fi
  if ! builtin ss_nip tick "$BUFFER" "$CURSOR"; then
    __shellspan_nip_disable
    return 0
  fi
  builtin ss_nip options "$options[interactivecomments]" "$options[monitor]"
  if (( SS_NIP_ACTION == 3 )); then
    local -a __shellspan_parse_options
    local __shellspan_option __shellspan_diagnostic
    for __shellspan_option in ${(k)options}; do
      case "$__shellspan_option" in
        rcs|globalrcs|interactive|login|privileged|exec|zle|monitor|restricted|shinstdin|singlecommand) continue ;;
      esac
      if [[ $options[$__shellspan_option] == on ]]; then
        __shellspan_parse_options+=(-o "$__shellspan_option")
      else
        __shellspan_parse_options+=(+o "$__shellspan_option")
      fi
    done
    if __shellspan_diagnostic=$("$__shellspan_nip_parser" -f "${__shellspan_parse_options[@]}" -n -c "$SS_NIP_TEXT" 2>&1) && [[ -z $__shellspan_diagnostic ]] &&
      builtin ss_nip validation-plan &&
      __shellspan_diagnostic=$("$__shellspan_nip_parser" -f "${__shellspan_parse_options[@]}" -n -c "$SS_NIP_VALIDATION_PLAN" 2>&1) && [[ -z $__shellspan_diagnostic ]]; then
      builtin ss_nip validate 1
    else
      builtin ss_nip validate 0 || return 1
      builtin ss_nip ready "$BUFFER" "$CURSOR" "$PWD"
    fi
  elif (( SS_NIP_ACTION )); then
    if (( SS_NIP_ACTION == 1 )); then
      if ! __shellspan_nip_scope_refresh; then __shellspan_nip_disable; return 1; fi
      builtin printf '\e]1337;SetUserVar=ShellSpanNativeInput=MQ==\a'
    fi
    BUFFER=$SS_NIP_TEXT
    CURSOR=${#BUFFER}
    # A final real editor repaint repairs native output interference before
    # acknowledging the actual full buffer. It draws BUFFER through ZLE only.
    local -i __shellspan_nip_full_repaint=0
    if (( SS_NIP_ACTION == 1 )) && builtin ss_nip complete-source "$BUFFER"; then builtin zle .redisplay; __shellspan_nip_full_repaint=1; fi
    zle -R
    # BUFFERLINES is the renderer's last completed frame, so read it after R,
    # not before rendering a newly assigned BUFFER or changing its capacity.
    if (( SS_NIP_ACTION == 1 && ! __shellspan_nip_full_repaint && BUFFERLINES > __shellspan_nip_previous_rows )); then
      builtin zle .redisplay
      zle -R
    fi
    __shellspan_nip_previous_rows=$BUFFERLINES
    builtin ss_nip ack "$BUFFER" "$CURSOR" || return 1
    if (( SS_NIP_ACTION == 2 )); then
      __shellspan_nip_scope_end
      builtin printf '\e]1337;SetUserVar=ShellSpanNativeInput=MA==\a'
    fi
  fi
  # Probe may arrive after line-init. Publish readiness only from this actual
  # ZLE callback and its current buffer, never from the probe's cached state.
  if (( SS_NIP_ACTION == 0 )) && builtin ss_nip idle; then
    builtin ss_nip ready "$BUFFER" "$CURSOR" "$PWD"
  fi
  if ! builtin ss_nip typing; then return 0; fi
  # The private FD wakes cancellation immediately. Timeout advances the native
  # monotonic animation on this same editor thread; no timer thread or signal
  # mask is installed in the user's Zsh process.
  builtin zselect -r "$SS_NIP_FD" -t 2
  done
}
__shellspan_nip_accept() {
  builtin ss_nip job || return
  if builtin ss_nip accept "$BUFFER" "$CURSOR"; then
    if [[ $SS_NIP_JOB_KIND == control ]]; then
      builtin ss_nip begin || return
      __shellspan_job_control "$SS_NIP_JOB_HANDLE" "$SS_NIP_JOB_ACTION"
      local __shellspan_result=$?
      builtin ss_nip settle "$__shellspan_result"
      builtin ss_nip ready "$BUFFER" "$CURSOR" "$PWD"
    else
      zle .accept-line
    fi
  fi
}
__shellspan_nip_line_finish() {
  # Re-read the actual private channel at the final public hook, after any user
  # line-finish hooks. An accepted line must not bypass a newly observed EOF.
  if builtin ss_nip pending-handoff && ! builtin ss_nip tick "$BUFFER" "$CURSOR"; then __shellspan_nip_disable; fi
  builtin ss_nip plan "$BUFFER"
  local __shellspan_result=$?
  if (( __shellspan_result == 1 )); then
    BUFFER=; CURSOR=0; zle send-break
    return 1
  fi
  if (( __shellspan_result == 0 )) && [[ $SS_NIP_PLAN != "$BUFFER" ]]; then
    # Public -I finishes the actual source display before the parent parser
    # receives the bound plan. No refresh follows this finish hook.
    zle -I
    BUFFER=$SS_NIP_PLAN
    CURSOR=${#BUFFER}
  fi
}
__shellspan_nip_preexec() {
  builtin printf '\e]1337;SetUserVar=ShellSpanNativeInput=MA==\a'
  builtin ss_nip job
  if [[ $SS_NIP_JOB_KIND == launch ]]; then
    __shellspan_job_arm_zsh "$SS_NIP_JOB_HANDLE" || return
  fi
  builtin ss_nip begin
}
__shellspan_nip_precmd() {
  local __shellspan_status=$?
  if zle; then return "$__shellspan_status"; fi
  __shellspan_native_status=$__shellspan_status
  if [[ -n ${__shellspan_job_armed_handle-} ]]; then
    __shellspan_job_confirm_zsh "$__shellspan_job_armed_handle"
    __shellspan_job_release_marker_zsh
  fi
  builtin ss_nip settle "$__shellspan_status"
  return "$__shellspan_status"
}
__shellspan_nip_line_init() {
  # The Core resets the special parameter on zleread exit/entry. Forget the
  # completed scope without restoring it into the next ordinary read.
  __shellspan_nip_scope_end
  if [[ -o allexport ]]; then
    __shellspan_nip_disable
    return 0
  fi
  if ! builtin ss_nip tick "$BUFFER" "$CURSOR"; then __shellspan_nip_disable; return 0; fi
  # Initial Probe may be consumed here before any FD-dispatch callback runs.
  # Publish the real options before editorReady on both startup paths.
  builtin ss_nip options "$options[interactivecomments]" "$options[monitor]"
  builtin ss_nip ready "$BUFFER" "$CURSOR" "$PWD"
}
zle -N __shellspan_nip_dispatch
zle -N __shellspan_nip_accept
zle -N __shellspan_nip_line_init
zle -N __shellspan_nip_line_finish
autoload -Uz add-zsh-hook add-zle-hook-widget
typeset -gA __shellspan_nip_owned_functions
() {
  local name
  for name in ${(k)functions}; do [[ $name == __shellspan_nip_* ]] && __shellspan_nip_owned_functions[$name]=$functions[$name]; done
  local -a map
  map=(${(z)"$(builtin bindkey -lL main)"})
  # -A names its existing target before the final alias (usually main).
  # Keep that target when the user later reconnects the main alias.
  if [[ ${map[2]} == -A ]]; then
    typeset -g __shellspan_nip_keymap=${map[-2]}
  else
    typeset -g __shellspan_nip_keymap=main
  fi
}
if ! { zmodload zsh/zselect && add-zsh-hook preexec __shellspan_nip_preexec &&
  add-zsh-hook precmd __shellspan_nip_precmd &&
  add-zle-hook-widget line-init __shellspan_nip_line_init &&
  add-zle-hook-widget line-finish __shellspan_nip_line_finish &&
  builtin bindkey $'\x18\x1d' __shellspan_nip_accept &&
  builtin bindkey $'\x18\x1e' __shellspan_nip_dispatch &&
  zle -F -w "$SS_NIP_FD" __shellspan_nip_dispatch; }; then
  __shellspan_nip_disable
  return 1
fi
builtin printf '\e]1337;SetUserVar=ShellSpanNativeInput=MA==\a'
