# Check only at the primary prompt, after the foreground program and the
# line editor have relinquished the tty. stty -g is an opaque restore token.
__shellspan_saved_prompt_tty=
__shellspan_unconfirmed_raw=0
__shellspan_unconfirmed_epoch=0
__shellspan_recovery_epoch=0
__shellspan_tty_ticket=0

__shellspan_zsh_recovery_jobs() {
  local job process pid
  # jobstates belongs to the interactive shell. A subshell sees its own table.
  builtin zmodload -F zsh/parameter p:jobstates || return 1
  for job in "${jobstates[@]}"; do
    case "$job" in
      running:*|suspended:*)
        process=${job#*:*:}
        pid=${process%%=*}
        __shellspan_live_jobs+="$pid "
        [[ $job != suspended:* ]] || __shellspan_suspended_jobs+="$pid " ;;
    esac
  done
  return 0
}

__shellspan_begin_tty_recovery() {
  [[ -t 1 && -n ${TERM-} && $TERM != dumb ]] || return 0
  local __shellspan_live_jobs= __shellspan_suspended_jobs=
  local root=${__shellspan_control_path%/*}
  __shellspan_zsh_recovery_jobs || return 0
  (( ++__shellspan_recovery_epoch ))
  builtin printf '\030\033]6975;%s;%s;%s\007' "${root##*/}" "$__shellspan_recovery_epoch" " $__shellspan_live_jobs" || :
}

__shellspan_confirm_zsh_tty_recovery() {
  [[ -t 1 && -n ${TERM-} && $TERM != dumb ]] || return 3
  builtin zmodload zsh/zselect || return 3
  local __shellspan_prompt_root=${__shellspan_control_path%/*} __shellspan_response __shellspan_choice __shellspan_attempt
  (( __shellspan_tty_ticket = (__shellspan_tty_ticket % 2147483647) + 1 ))
  __shellspan_response="$__shellspan_control_path.tty-reply-$__shellspan_tty_ticket"
  # Ask whether a foreground application entered the alternate screen and has
  # exited. The independent reply file never consumes typed keys.
  builtin printf '\030\033]6974;%s;%s;%s;%s;%s;%s\007' "${__shellspan_prompt_root##*/}" "$__shellspan_tty_ticket" "$__shellspan_stopped" " $__shellspan_live_jobs" " $__shellspan_suspended_jobs" "$__shellspan_recovery_epoch" || return 3
  for ((__shellspan_attempt=0; __shellspan_attempt<100; __shellspan_attempt++)); do
    for __shellspan_choice in 1 0 2; do
      if [[ -f "$__shellspan_response-$__shellspan_choice" ]]; then
        command rm -f -- "$__shellspan_response-$__shellspan_choice" 2>/dev/null || :
        case "$__shellspan_choice" in 1) return 0 ;; 0) return 1 ;; 2) return 2 ;; esac
      fi
    done
    builtin zselect -t 2 2>/dev/null || :
  done
  return 3
}

__shellspan_recover_prompt_tty() {
  [[ ${__shellspan_stty_executable-} == /* && -t 0 ]] || return 0
  local __shellspan_tty_current __shellspan_tty_settings __shellspan_tty_speed __shellspan_tty_flag
  local __shellspan_tty_restore=${1:-0}
  local __shellspan_tty_result
  local __shellspan_tty_zero_min='(^|[[:space:];])min[[:space:]]*=[[:space:]]*0([[:space:];]|$)'
  # Keep stty in the shell's process group through command substitution.
  __shellspan_tty_current=$(exec "$__shellspan_stty_executable" -g 2>/dev/null </dev/tty) || return 0
  [[ -n $__shellspan_tty_current ]] || return 0
  if [[ $__shellspan_tty_current == "$__shellspan_saved_prompt_tty" ]]; then
    __shellspan_unconfirmed_raw=0
    return 0
  fi

  # Some Vim builds fall back from non-tty stdin to stderr after trying to
  # save modes, and on exit apply a zeroed termios to the PTY. Require the
  # compound signature so stty -onlcr, raw mode, or a speed change alone all
  # become part of the user's next saved mode instead of being reversed. Zsh
  # can already have restored ICANON and ECHO by the time this hook runs.
  __shellspan_tty_settings=$(exec "$__shellspan_stty_executable" -a 2>/dev/null </dev/tty) || return 0
  for __shellspan_tty_flag in -opost -isig; do
    case " $__shellspan_tty_settings " in
      *[[:space:]\;]"$__shellspan_tty_flag"[[:space:]\;]*) ;;
      *) __shellspan_saved_prompt_tty=$__shellspan_tty_current; __shellspan_unconfirmed_raw=0; return 0 ;;
    esac
  done
  # Drift between raw prompts can't establish a new baseline after a timeout.
  # A later foreground command can still establish ownership of its own modes.
  if (( __shellspan_unconfirmed_raw && __shellspan_unconfirmed_epoch == __shellspan_recovery_epoch )); then
    return 0
  fi
  if (( ! __shellspan_tty_restore )); then
    if ( [[ $__shellspan_tty_settings =~ $__shellspan_tty_zero_min ]] ); then
      __shellspan_tty_speed=$(exec "$__shellspan_stty_executable" speed 2>/dev/null </dev/tty) || return 0
      if [[ $__shellspan_tty_speed == 0 && -z ${__shellspan_live_jobs-} ]]; then
        __shellspan_tty_restore=1
      fi
    fi
    if (( ! __shellspan_tty_restore )) && [[ -n ${ZSH_VERSION-} && -n ${__shellspan_saved_prompt_tty-} ]]; then
      __shellspan_tty_result=0
      __shellspan_confirm_zsh_tty_recovery || __shellspan_tty_result=$?
      case "$__shellspan_tty_result" in
        0) __shellspan_tty_restore=1 ;;
        2) return 0 ;; # The foreground application has a live or suspended job.
        3)
          __shellspan_unconfirmed_raw=1
          __shellspan_unconfirmed_epoch=$__shellspan_recovery_epoch
          return 0 ;;
      esac
    fi
  fi
  if (( ! __shellspan_tty_restore )); then
    if (( __shellspan_unconfirmed_raw )); then
      __shellspan_unconfirmed_epoch=$__shellspan_recovery_epoch
      return 0
    fi
    __shellspan_saved_prompt_tty=$__shellspan_tty_current
  elif [[ -n ${__shellspan_saved_prompt_tty-} ]]; then
    if [[ -n ${ZSH_VERSION-} ]]; then
      # ZLE reapplies Zsh's cached settings. A foreground stty job also
      # refreshes that cache when Zsh collects the job at this prompt.
      "$__shellspan_stty_executable" "$__shellspan_saved_prompt_tty" </dev/tty >/dev/null 2>&1 || :
    else
      __shellspan_tty_current=$(exec "$__shellspan_stty_executable" "$__shellspan_saved_prompt_tty" 2>/dev/null </dev/tty) || :
    fi
  fi
  __shellspan_unconfirmed_raw=0
  return 0
}

__shellspan_recover_prompt_terminal() {
  local __shellspan_force_restore=0 __shellspan_stopped=0
  local __shellspan_signal
  if (( $1 > 128 && $1 <= 255 )) &&
    __shellspan_signal=$(builtin kill -l "$(( $1 - 128 ))" 2>/dev/null); then
    case "${__shellspan_signal#SIG}" in
      # A stopped program can resume through fg. Keep the prior tty snapshot.
      STOP|TSTP|TTIN|TTOU) __shellspan_stopped=1 ;;
      HUP|INT|QUIT|ILL|TRAP|ABRT|BUS|FPE|KILL|USR1|SEGV|USR2|PIPE|ALRM|TERM|XCPU|XFSZ|VTALRM|PROF|SYS) __shellspan_force_restore=1 ;;
    esac
  fi
  local __shellspan_live_jobs= __shellspan_suspended_jobs= __shellspan_prompt_root=${__shellspan_control_path%/*}
  if [[ -n ${ZSH_VERSION-} ]]; then
    __shellspan_zsh_recovery_jobs || return 0
  else
    __shellspan_live_jobs=$(builtin jobs -pr; builtin jobs -ps) || return 0
    __shellspan_live_jobs=${__shellspan_live_jobs//$'\n'/ }
  fi
  if (( ! __shellspan_stopped )); then
    if [[ -n ${ZSH_VERSION-} ]]; then
      # Zsh may cache a killed program's raw tty even after a masked exit.
      __shellspan_recover_prompt_tty
    elif [[ -z $__shellspan_live_jobs ]]; then
      __shellspan_recover_prompt_tty "$__shellspan_force_restore"
    fi
  fi
  [[ -t 1 && -n ${TERM-} && $TERM != dumb ]] || return 0
  # CAN ends any partial sequence left by a killed application. This private
  # boundary precedes the next visible prompt and carries no lifecycle authority.
  if [[ -n ${ZSH_VERSION-} ]]; then
    builtin printf '\030\033]6973;%s;%s;%s;%s\007' "${__shellspan_prompt_root##*/}" "$__shellspan_stopped" " $__shellspan_live_jobs" " $__shellspan_suspended_jobs" || :
  else
    builtin printf '\030\033]6973;%s;%s;%s\007' "${__shellspan_prompt_root##*/}" "$__shellspan_stopped" " $__shellspan_live_jobs" || :
  fi
}
