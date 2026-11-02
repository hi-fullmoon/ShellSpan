//! Bash startup glue. Loading order and existing user configuration are retained.
use std::path::Path;
pub(crate) fn bootstrap_source(module: &Path, socket: &Path) -> Result<String, String> {
    let quote = |path: &Path| {
        shlex::try_quote(path.to_str().ok_or("TERMINAL_NATIVE_PATH_INVALID")?)
            .map(|value| value.into_owned())
            .map_err(|_| "TERMINAL_NATIVE_PATH_INVALID")
    };
    let job_helpers = crate::terminal_jobs::POSIX_HELPERS;
    // Called by the explicit GNU post-profile startup entry. Bash itself has
    // already loaded system/user configuration with the real HOME/login flags.
    Ok(format!(
        r#"__shellspan_control_path={control_path}
{job_helpers}
__shellspan_emit() {{
  case "$1" in
    B) builtin ss_native_input_v1_job "$2" "$3" "${{4:--}}" ;;
    F) builtin ss_native_input_v1_job "$2" finished "$3" ;;
  esac
}}
__shellspan_validate_native() {{
  local -a __shellspan_options=()
  local __shellspan_option __shellspan_diagnostic
  [[ -o posix ]] && __shellspan_options+=(--posix)
  for __shellspan_option in extglob extquote interactive_comments; do
    if shopt -q "$__shellspan_option"; then __shellspan_options+=(-O "$__shellspan_option"); else __shellspan_options+=(+O "$__shellspan_option"); fi
  done
  __shellspan_diagnostic=$("$BASH" --noprofile --norc "${{__shellspan_options[@]}}" -n -c "$1" 2>&1) && [[ -z $__shellspan_diagnostic ]]
}}
__shellspan_native_job_arm() {{
  local __shellspan_previous=$? __shellspan_handle=$1
  __shellspan_native_status=$__shellspan_previous
  __shellspan_job_validate "$1" "$2" || return
  builtin eval -- "$__shellspan_handle() {{ __shellspan_job_initialize_bash $__shellspan_handle; }}"
  __shellspan_job_armed_handle=$__shellspan_handle
}}
__shellspan_native_control_dispatch() {{
  local __shellspan_format __shellspan_handle __shellspan_action __shellspan_nonce __shellspan_extra __shellspan_result
  builtin ss_native_input_v1_control_access || return
  IFS=$'\t' builtin read -r __shellspan_format __shellspan_handle __shellspan_action __shellspan_nonce __shellspan_extra < "$__shellspan_control_path.control" || return
  [[ $__shellspan_format == NIP1-CONTROL && -z $__shellspan_extra ]] || return
  if builtin ss_native_input_v1_control_begin "$__shellspan_handle" "$__shellspan_action" "$__shellspan_nonce"; then
    __shellspan_job_control "$__shellspan_handle" "$__shellspan_action"
    __shellspan_result=$?
    builtin ss_native_input_v1_control_end "$__shellspan_result" "$PWD"
  fi
}}
__shellspan_native_prompt() {{
  local __shellspan_status=$1 __shellspan_handle=${{__shellspan_job_armed_handle-}} __shellspan_pid
  if [[ -n $__shellspan_handle ]]; then
    builtin jobs -p "%( $__shellspan_handle;" >| "${{__shellspan_control_path}}.job.$__shellspan_handle.identity" 2>/dev/null
    IFS= builtin read -r __shellspan_pid < "${{__shellspan_control_path}}.job.$__shellspan_handle.identity"
    if [[ -n $__shellspan_pid ]]; then __shellspan_job_register "$__shellspan_handle"
    elif [[ -f ${{__shellspan_control_path}}.job.$__shellspan_handle ]]; then
      __shellspan_job_register "$__shellspan_handle"
      __shellspan_job_completion "$__shellspan_handle"
      __shellspan_emit B "$__shellspan_handle" settled -
    else __shellspan_emit B "$__shellspan_handle" rejected -
    fi
    unset -f "$__shellspan_handle"
    __shellspan_job_armed_handle=
  fi
  builtin ss_native_input_v1_status "$__shellspan_status" "$PWD"
}}
__shellspan_prompt_declaration=$(declare -p PROMPT_COMMAND 2>/dev/null)
__shellspan_prompt_supported=0
case "$__shellspan_prompt_declaration" in
  ''|'declare -- '*|'declare -x '*|'declare -a '*|'declare -ax '*|'declare -xa '*) __shellspan_prompt_supported=1 ;;
esac
if (( __shellspan_prompt_supported )) && builtin enable -f {} ss_native_input_v1 ss_native_input_v1_display_abi ss_native_input_v1_status ss_native_input_v1_begin ss_native_input_v1_child_closed ss_native_input_v1_job ss_native_input_v1_control_access ss_native_input_v1_control_begin ss_native_input_v1_control_end ss_native_input_v1_dispatch_free; then
  if builtin ss_native_input_v1_display_abi && builtin bind -v >/dev/null && builtin ss_native_input_v1_dispatch_free && builtin bind -x '"\C-x\C-_":__shellspan_native_control_dispatch' && builtin ss_native_input_v1 {} "$(trap -p INT)" "$BASH_VERSION"; then
    if [[ $__shellspan_prompt_declaration == 'declare -a'* ]]; then
      if (( BASH_VERSINFO[0]>5 || (BASH_VERSINFO[0]==5 && BASH_VERSINFO[1]>=1) )); then
        PROMPT_COMMAND=('__shellspan_native_prompt "$?"' "${{PROMPT_COMMAND[@]}}")
      else
        PROMPT_COMMAND[0]='__shellspan_native_prompt "$?";'"${{PROMPT_COMMAND[0]-}}"
      fi
    else
      PROMPT_COMMAND='__shellspan_native_prompt "$?";'"${{PROMPT_COMMAND-}}"
    fi
  fi
fi
"#,
        quote(module)?,
        quote(socket)?,
        control_path = quote(socket)?
    ))
}
