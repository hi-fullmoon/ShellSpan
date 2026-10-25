//! Cooperative native-shell jobs. Handles never encode a PID or a job slot.
use crate::terminal_integration::TerminalShellKind;
use serde::Serialize;

#[derive(Debug, Clone)]
pub(crate) struct PreparedShellJob {
    pub job: NativeShellJob,
    pub source: String,
    pub line: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeShellJob {
    pub process_handle: String,
    pub owner_target_id: String,
    pub agent_session_id: String,
    pub task_id: String,
    pub transport_session_id: String,
    pub terminal_session_id: String,
    pub terminal_generation: u64,
    pub shell: TerminalShellKind,
    #[serde(skip)]
    pub integration_id: Option<String>,
    #[serde(skip)]
    pub frozen_target: crate::agent_runtime::AgentToolTargetNative,
    pub operation_id: String,
    pub command_line: String,
    pub submitted_command_line: String,
    pub accepted_command_line: Option<String>,
    pub control_lost: bool,
    pub native_active: Option<bool>,
    pub state: String,
    pub exit_code: Option<i32>,
    pub observed_output_sequence: u64,
    pub observed_at_unix_ms: u64,
    pub observation_revision: u64,
    pub capture_start_sequence: u64,
    pub cleanup_reason: Option<String>,
    pub stop_requested: bool,
    pub launch_confirmed: bool,
}

pub(crate) fn submission(source: &str, handle: &str) -> Result<String, String> {
    crate::agent_runtime::validate_visible_command_input(source)?;
    validate_handle(handle)?;
    let quoted = shlex::try_quote(source).map_err(|_| "TERMINAL_JOB_INVALID_SOURCE")?;
    let trap = format!("__shellspan_job_status=$?; {{ builtin printf '%s\\n' \"$__shellspan_job_status\" >\"${{__shellspan_control_path}}.job.{handle}.pending\" && command /bin/mv -- \"${{__shellspan_control_path}}.job.{handle}.pending\" \"${{__shellspan_control_path}}.job.{handle}\"; }} 2>/dev/null");
    let trap = shlex::try_quote(&trap).map_err(|_| "TERMINAL_JOB_INVALID_TRAP")?;
    let line = format!("__shellspan_job_validate {handle} {quoted} && {{ ( : {handle}; trap {trap} EXIT; trap 'exit 143' TERM; __shellspan_job_restore; if __shellspan_job_return_status \"$__shellspan_native_status\"; then builtin eval -- \"$__shellspan_native_source\"; else builtin eval -- \"$__shellspan_native_source\"; fi ) & __shellspan_job_register {handle}; }}");
    if line.len() > 32_768 {
        return Err("TERMINAL_INPUT_UNSUPPORTED: job submission exceeds 32768 bytes".into());
    }
    Ok(line)
}

pub(crate) fn shell_submission(
    source: &str,
    handle: &str,
    shell: TerminalShellKind,
) -> Result<String, String> {
    if matches!(shell, TerminalShellKind::Bash | TerminalShellKind::Zsh) {
        return submission(source, handle);
    }
    crate::agent_runtime::validate_visible_command_input(source)?;
    validate_handle(handle)?;
    if !matches!(
        shell,
        TerminalShellKind::WindowsPowerShell | TerminalShellKind::PowerShell7
    ) {
        return Err("TERMINAL_BACKGROUND_UNSUPPORTED".into());
    }
    // PowerShell's native single-quoted literal: only apostrophes are doubled;
    // all LF/CR/Tab bytes and dollar/backtick characters remain literal.
    let literal = format!("'{}'", source.replace('\'', "''"));
    // Argument expressions run in the actual caller scope before entering the
    // integration module. StrictMode is scope state, not a copyable PSVariable.
    let probe = format!("$(& {{ $__shellspan_saved_errors_{id} = $Error.Clone(); try {{ $null = $__shellspan_strict_probe_{id}; $false }} catch {{ $Error.Clear(); $Error.AddRange($__shellspan_saved_errors_{id}); $true }} }})", id = &handle[4..]);
    let line=format!("& $__shellspanModule {{ param($h,$s,$strict,$functions,$language) & ${{function:Invoke-ShellSpanNativeJobStart}} $h $s $strict $functions $language }} '{handle}' {literal} {probe} @(& {{ $d=$ExecutionContext.SessionState.PSVariable.Get('global:PSDefaultParameterValues'); if ($null -eq $d -or -not ($d.Options -band [System.Management.Automation.ScopedItemOptions]::AllScope)) {{ $local:PSDefaultParameterValues=@{{}}; Microsoft.PowerShell.Management\\Get-ChildItem Function: }} }}) $ExecutionContext.SessionState.LanguageMode");
    if line.len() > 32768 {
        return Err("TERMINAL_INPUT_UNSUPPORTED: native job submission exceeds 32768 bytes".into());
    }
    Ok(line)
}

pub(crate) fn control_submission(
    handle: &str,
    shell: TerminalShellKind,
    stop: bool,
) -> Result<String, String> {
    validate_handle(handle)?;
    let action = if stop { "stop" } else { "poll" };
    Ok(
        if matches!(
            shell,
            TerminalShellKind::WindowsPowerShell | TerminalShellKind::PowerShell7
        ) {
            format!("& $__shellspanModule {{ param($h,$a) & ${{function:Invoke-ShellSpanNativeJobControl}} $h $a }} '{handle}' '{action}'")
        } else {
            format!("__shellspan_job_control {handle} {action}")
        },
    )
}

pub(crate) fn validate_handle(handle: &str) -> Result<(), String> {
    if handle.strip_prefix("job-").is_some_and(|suffix| {
        suffix.len() == 32 && suffix.bytes().all(|byte| byte.is_ascii_hexdigit())
    }) {
        Ok(())
    } else {
        Err("TERMINAL_JOB_INVALID_HANDLE".into())
    }
}

pub(crate) fn observation_time() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

// Bash uses machine-readable `jobs -p`; Zsh uses zsh/parameter's native
// jobstates/jobtexts dictionaries. No human jobs/ps table is parsed.
// The source executes in the shell's native asynchronous subshell, inheriting
// cwd, environment, aliases, functions and options. The parent alone controls
// its job table; a completed slot/PID is never used as a signal credential.
pub(crate) const POSIX_HELPERS: &str = r#"
__shellspan_job_validate() {
  local __shellspan_handle=$1
  __shellspan_job_aliases=0
  if [[ -n ${BASH_VERSION-} ]] && shopt -q expand_aliases; then __shellspan_job_aliases=1; fi
  if [[ ! -o monitor ]]; then
    __shellspan_emit B "$__shellspan_handle" rejected -
    return 2
  fi
  __shellspan_validate_native "$2"
}
__shellspan_job_restore() {
  # Bash disables alias expansion when it creates an asynchronous subshell.
  # The source is parsed by eval there, so restore its parent parsing option.
  if [[ -n ${BASH_VERSION-} ]]; then
    if [[ $__shellspan_job_aliases == 1 ]]; then shopt -s expand_aliases; else shopt -u expand_aliases; fi
  fi
}
__shellspan_job_return_status() { return "$1"; }
__shellspan_job_register() {
  __shellspan_emit B "$1" running -
}
__shellspan_job_completion() {
  local __shellspan_handle=$1 __shellspan_status
  local __shellspan_status_path="${__shellspan_control_path}.job.$__shellspan_handle"
  if [[ -f $__shellspan_status_path ]]; then
    IFS= builtin read -r __shellspan_status < "$__shellspan_status_path"
    __shellspan_emit F "$__shellspan_handle" "$__shellspan_status"
    command /bin/rm -- "$__shellspan_status_path"
  fi
}
__shellspan_job_observe_zsh() {
  local __shellspan_slot __shellspan_text __shellspan_native_state
  zmodload zsh/parameter || return 2
  for __shellspan_slot in "${(@k)jobstates}"; do
    __shellspan_text=${jobtexts[$__shellspan_slot]}
    if [[ $__shellspan_text == "( : $__shellspan_handle;"* ]]; then
      __shellspan_native_state=${jobstates[$__shellspan_slot]}
      case $__shellspan_native_state in
        running:*) __shellspan_active=1 ;;
        suspended:*) __shellspan_stopped=1 ;;
        done:*) ;;
        *) return 2 ;;
      esac
    fi
  done
}
__shellspan_job_control() {
  local __shellspan_handle=$1 __shellspan_action=$2 __shellspan_active= __shellspan_stopped= __shellspan_status __shellspan_pid= __shellspan_candidate
  # The literal opaque handle occurs in the native asynchronous command text.
  # Shell jobspec resolution is atomic inside kill; no PID/slot reuse window.
  local __shellspan_spec="%( : $__shellspan_handle;"
  local __shellspan_status_path="${__shellspan_control_path}.job.$__shellspan_handle"
  __shellspan_job_completion "$__shellspan_handle"
  if [[ -n ${ZSH_VERSION-} ]]; then
    __shellspan_job_observe_zsh || { __shellspan_emit B "$__shellspan_handle" uncertain -; return 2; }
  else
  # Query the parent's native table. Zsh discards that table in a command
  # substitution, so capture scalar builtin output in our private directory.
  builtin jobs -p "$__shellspan_spec" >| "$__shellspan_status_path.identity" 2>/dev/null
  IFS= builtin read -r __shellspan_pid < "$__shellspan_status_path.identity"
  # Filters apply to the whole table; Zsh ignores -r/-s with explicit jobspecs.
  builtin jobs -p -r >| "$__shellspan_status_path.running" 2>/dev/null
  builtin jobs -p -s >| "$__shellspan_status_path.stopped" 2>/dev/null
  while IFS= builtin read -r __shellspan_candidate; do
    if [[ -n $__shellspan_pid && $__shellspan_candidate == "$__shellspan_pid" ]]; then __shellspan_active=1; fi
  done < "$__shellspan_status_path.running"
  while IFS= builtin read -r __shellspan_candidate; do
    if [[ -n $__shellspan_pid && $__shellspan_candidate == "$__shellspan_pid" ]]; then __shellspan_stopped=1; fi
  done < "$__shellspan_status_path.stopped"
  command /bin/rm -- "$__shellspan_status_path.identity" "$__shellspan_status_path.running" "$__shellspan_status_path.stopped"
  fi
  if [[ -n $__shellspan_active || -n $__shellspan_stopped ]]; then
    if [[ $__shellspan_action == stop ]]; then
      builtin kill -s TERM "$__shellspan_spec" || { __shellspan_emit B "$__shellspan_handle" uncertain -; return 2; }
      # A stopped group must resume to handle its pending termination signal.
      builtin kill -s CONT "$__shellspan_spec" 2>/dev/null
      __shellspan_emit B "$__shellspan_handle" stopRequested -
    elif [[ -n $__shellspan_stopped ]]; then
      __shellspan_emit B "$__shellspan_handle" stopped -
    else
      __shellspan_emit B "$__shellspan_handle" running -
    fi
    return
  fi
  builtin wait "$__shellspan_spec" 2>/dev/null
  __shellspan_status=$?
  __shellspan_job_completion "$__shellspan_handle"
  # 127 can also mean the shell has already discarded a notified job. Without
  # its original EXIT event the broker must retain an unknown exit status.
  if [[ $__shellspan_status == 127 ]]; then
    __shellspan_emit B "$__shellspan_handle" settled -
  else
    __shellspan_emit B "$__shellspan_handle" settled "$__shellspan_status"
  fi
}
"#;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn powershell_job_contract_preserves_literals_and_uses_native_objects() {
        let source = "Write-Output 'quoted $value `backtick'\nWrite-Output \"CR\rTab\t\"";
        let handle = "job-0123456789abcdef0123456789abcdef";
        let line = shell_submission(source, handle, TerminalShellKind::PowerShell7).unwrap();
        assert!(line.contains("'quoted $value `backtick'".replace('\'', "''").as_str()));
        assert!(line.contains("\n") && line.contains("\r") && line.contains("\t"));
        assert!(line.contains("Invoke-ShellSpanNativeJobStart"));
        assert!(
            control_submission(handle, TerminalShellKind::WindowsPowerShell, true)
                .unwrap()
                .contains("Invoke-ShellSpanNativeJobControl")
        );
        let native = include_str!("terminal_jobs.ps1");
        for required in [
            "NativeJobRollout",
            "CreateRunspace",
            "[ShellSpanProcessJob]::new",
            "ActiveProcesses -eq 0",
            "InstanceId",
            "SourceStarted",
            "Out-Host",
            "[ShellSpanJobHost]::InstrumentSource",
        ] {
            assert!(
                native.contains(required),
                "missing native PowerShell job contract: {required}"
            );
        }
        assert!(!native.contains("Receive-Job"));
        assert!(!native.contains("Start-Job "));
        let host = include_str!("terminal_job_host.cs");
        for required in [
            "SourceSucceeded = $?",
            "TryStatementAst",
            "ReadLine()",
            "ReadKey(ReadKeyOptions",
            "PromptForCredential",
            "NotSupportedException",
            "ExitCode = code",
            "AssignProcessToJobObject",
            "TerminateJobObject",
            "GetNamedPipeClientProcessId",
            "start.RedirectStandardInput = true",
        ] {
            assert!(host.contains(required));
        }
    }
}
