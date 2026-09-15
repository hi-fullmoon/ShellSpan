use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
#[cfg(any(windows, test))]
use std::time::Duration;
#[cfg(any(windows, test))]
use std::time::Instant;

use portable_pty::CommandBuilder;
use serde::Serialize;
use tempfile::TempDir;
use uuid::Uuid;

const MAX_CONTROL_FIELD_BYTES: usize = 16_384;
const MAX_CONTROL_BUFFER_BYTES: usize = MAX_CONTROL_FIELD_BYTES * 4;
#[cfg(any(windows, test))]
const WINDOWS_PIPE_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TerminalShellKind {
    Bash,
    Zsh,
    WindowsPowerShell,
    PowerShell7,
    Unsupported,
}

impl TerminalShellKind {
    pub(crate) fn detect(executable: &str) -> Self {
        let name = executable
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(executable)
            .to_ascii_lowercase();
        match name.as_str() {
            "bash" | "bash.exe" => Self::Bash,
            "zsh" | "zsh.exe" => Self::Zsh,
            "powershell" | "powershell.exe" => Self::WindowsPowerShell,
            "pwsh" | "pwsh.exe" => Self::PowerShell7,
            _ => Self::Unsupported,
        }
    }

    #[cfg_attr(not(any(windows, test)), allow(dead_code))]
    pub(crate) fn protocol_name(self) -> &'static str {
        match self {
            Self::Bash => "bash",
            Self::Zsh => "zsh",
            Self::WindowsPowerShell => "windowsPowerShell",
            Self::PowerShell7 => "powerShell7",
            Self::Unsupported => "unsupported",
        }
    }

    pub(crate) fn enter(self) -> &'static str {
        match self {
            Self::WindowsPowerShell | Self::PowerShell7 => "\r",
            Self::Bash | Self::Zsh | Self::Unsupported => "\n",
        }
    }

    pub(crate) fn supported(self) -> bool {
        self != Self::Unsupported
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TerminalIntegrationControlEvent {
    Ready { shell: TerminalShellKind },
    PromptStart { cwd: String },
    PromptEnd,
    CommandStart { command_line: String, cwd: String },
    CommandEnd { exit_code: i32, cwd: String },
    DirectoryChanged { cwd: String },
}

/// Incremental TSP/1 control decoder used by nonblocking SSH channels. It
/// consumes only the isolated control stream; PTY bytes never enter it.
#[derive(Debug, Default)]
pub(crate) struct TerminalIntegrationStreamDecoder {
    pending_bytes: Vec<u8>,
    pending_fields: Vec<String>,
}

impl TerminalIntegrationStreamDecoder {
    pub(crate) fn push(
        &mut self,
        bytes: &[u8],
    ) -> Result<Vec<TerminalIntegrationControlEvent>, String> {
        if self.pending_bytes.len().saturating_add(bytes.len()) > MAX_CONTROL_BUFFER_BYTES {
            return Err("TERMINAL_INTEGRATION_CONTROL_BUFFER_TOO_LARGE".into());
        }
        self.pending_bytes.extend_from_slice(bytes);
        let mut complete = 0;
        for index in 0..self.pending_bytes.len() {
            if self.pending_bytes[index] != 0 {
                if index.saturating_sub(complete) >= MAX_CONTROL_FIELD_BYTES {
                    return Err("TERMINAL_INTEGRATION_FIELD_TOO_LARGE".into());
                }
                continue;
            }
            let field = String::from_utf8(self.pending_bytes[complete..index].to_vec())
                .map_err(|_| "TERMINAL_INTEGRATION_NON_UTF8_FIELD".to_string())?;
            self.pending_fields.push(field);
            complete = index + 1;
        }
        if complete > 0 {
            self.pending_bytes.drain(..complete);
        }

        let mut events = Vec::new();
        loop {
            let Some(kind) = self.pending_fields.first().map(String::as_str) else {
                break;
            };
            let field_count = match kind {
                "R" | "P" | "X" => 2,
                "Q" | "T" => 1,
                "S" | "E" => 3,
                "D" => 2,
                _ => return Err("TERMINAL_INTEGRATION_UNKNOWN_EVENT".into()),
            };
            if self.pending_fields.len() < field_count {
                break;
            }
            let fields = self.pending_fields.drain(..field_count).collect::<Vec<_>>();
            let event = event_from_fields(&fields)?;
            if event.is_none() {
                continue;
            }
            events.push(event.expect("non-empty event checked above"));
        }
        Ok(events)
    }

    pub(crate) fn finish(&self) -> Result<(), String> {
        if self.pending_bytes.is_empty() && self.pending_fields.is_empty() {
            Ok(())
        } else {
            Err("TERMINAL_INTEGRATION_TRUNCATED_EVENT".into())
        }
    }
}

fn event_from_fields(fields: &[String]) -> Result<Option<TerminalIntegrationControlEvent>, String> {
    match fields[0].as_str() {
        "R" => Ok(Some(TerminalIntegrationControlEvent::Ready {
            shell: parse_shell(&fields[1])?,
        })),
        "P" => Ok(Some(TerminalIntegrationControlEvent::PromptStart {
            cwd: fields[1].clone(),
        })),
        "Q" => Ok(Some(TerminalIntegrationControlEvent::PromptEnd)),
        "S" => Ok(Some(TerminalIntegrationControlEvent::CommandStart {
            command_line: fields[1].clone(),
            cwd: fields[2].clone(),
        })),
        "E" => Ok(Some(TerminalIntegrationControlEvent::CommandEnd {
            exit_code: fields[1]
                .parse::<i32>()
                .map_err(|_| "TERMINAL_INTEGRATION_INVALID_EXIT_STATUS".to_string())?,
            cwd: fields[2].clone(),
        })),
        "D" => Ok(Some(TerminalIntegrationControlEvent::DirectoryChanged {
            cwd: fields[1].clone(),
        })),
        "X" => Err(format!("TERMINAL_INTEGRATION_DEGRADED: {}", fields[1])),
        "T" => Ok(None),
        _ => Err("TERMINAL_INTEGRATION_UNKNOWN_EVENT".into()),
    }
}

enum ControlEndpoint {
    #[cfg(unix)]
    Unix { fifo_path: PathBuf, reader: File },
    #[cfg(any(windows, test))]
    #[allow(dead_code)]
    Windows { pipe_path: String },
}

pub(crate) struct TerminalIntegrationControlHandle {
    stopped: Arc<AtomicBool>,
    #[cfg(unix)]
    wake_path: Option<PathBuf>,
    reader_thread: Option<thread::JoinHandle<()>>,
}

impl TerminalIntegrationControlHandle {
    pub(crate) fn stop(&mut self) {
        if self.stopped.swap(true, Ordering::AcqRel) {
            return;
        }
        #[cfg(unix)]
        if let Some(path) = self.wake_path.take() {
            use std::os::unix::fs::OpenOptionsExt;

            if let Ok(mut writer) = File::options()
                .write(true)
                .custom_flags(libc::O_NONBLOCK | libc::O_CLOEXEC)
                .open(path)
            {
                let _ = writer.write_all(b"T\0");
            }
        }
    }
}

impl Drop for TerminalIntegrationControlHandle {
    fn drop(&mut self) {
        self.stop();
        if let Some(reader_thread) = self.reader_thread.take() {
            let _ = reader_thread.join();
        }
    }
}

pub(crate) struct PreparedLocalShellIntegration {
    shell: TerminalShellKind,
    integration_id: String,
    bootstrap_root: TempDir,
    bootstrap_path: PathBuf,
    endpoint: ControlEndpoint,
}

impl PreparedLocalShellIntegration {
    pub(crate) fn prepare(shell: TerminalShellKind) -> Result<Self, String> {
        if !shell.supported() {
            return Err("TERMINAL_INTEGRATION_UNSUPPORTED_SHELL".into());
        }
        let bootstrap_root = tempfile::Builder::new()
            .prefix("shellspan-terminal-integration-")
            .tempdir()
            .map_err(|error| format!("failed to create shell integration root: {error}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            fs::set_permissions(bootstrap_root.path(), fs::Permissions::from_mode(0o700)).map_err(
                |error| format!("failed to protect shell integration root permissions: {error}"),
            )?;
        }
        let integration_id = format!("integration-{}", Uuid::new_v4());

        #[cfg(unix)]
        let (endpoint, bootstrap_path) = {
            use std::os::unix::ffi::OsStrExt;

            let fifo_path = bootstrap_root.path().join("control");
            let c_path = std::ffi::CString::new(fifo_path.as_os_str().as_bytes())
                .map_err(|_| "shell integration FIFO path contains NUL".to_string())?;
            if unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) } != 0 {
                return Err(format!(
                    "failed to create shell integration FIFO: {}",
                    io::Error::last_os_error()
                ));
            }
            // The private FIFO has a reader before shell startup, so hooks do
            // not block waiting for the broker. Hooks open a short-lived
            // writer per event; foreground commands inherit no control fd.
            let reader = File::options()
                .read(true)
                .write(true)
                .open(&fifo_path)
                .map_err(|error| format!("failed to open shell integration FIFO: {error}"))?;
            let bootstrap_path = write_posix_bootstrap(bootstrap_root.path(), shell, &fifo_path)?;
            (ControlEndpoint::Unix { fifo_path, reader }, bootstrap_path)
        };

        #[cfg(windows)]
        let (endpoint, bootstrap_path) = {
            let pipe_name = format!("shellspan-terminal-integration-{}", Uuid::new_v4());
            let pipe_path = format!(r"\\.\pipe\{pipe_name}");
            let bootstrap_path = bootstrap_root.path().join("shellspan-integration.ps1");
            fs::write(&bootstrap_path, powershell_bootstrap(&pipe_name, shell))
                .map_err(|error| format!("failed to write PowerShell integration: {error}"))?;
            (ControlEndpoint::Windows { pipe_path }, bootstrap_path)
        };

        Ok(Self {
            shell,
            integration_id,
            bootstrap_root,
            bootstrap_path,
            endpoint,
        })
    }

    pub(crate) fn shell(&self) -> TerminalShellKind {
        self.shell
    }

    pub(crate) fn integration_id(&self) -> &str {
        &self.integration_id
    }

    pub(crate) fn configure_command(&self, command: &mut CommandBuilder) -> Result<(), String> {
        match self.shell {
            TerminalShellKind::Bash => {
                command.args([
                    "--noprofile",
                    "--rcfile",
                    self.bootstrap_path
                        .to_str()
                        .ok_or_else(|| "bash integration path is not Unicode".to_string())?,
                    "-i",
                ]);
            }
            TerminalShellKind::Zsh => {
                command.env(
                    "ZDOTDIR",
                    self.bootstrap_root
                        .path()
                        .to_str()
                        .ok_or_else(|| "zsh integration path is not Unicode".to_string())?,
                );
                command.arg("-l");
            }
            TerminalShellKind::WindowsPowerShell | TerminalShellKind::PowerShell7 => {
                command.args([
                    "-NoExit",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    self.bootstrap_path
                        .to_str()
                        .ok_or_else(|| "PowerShell integration path is not Unicode".to_string())?,
                ]);
            }
            TerminalShellKind::Unsupported => {
                return Err("TERMINAL_INTEGRATION_UNSUPPORTED_SHELL".into())
            }
        }
        Ok(())
    }

    pub(crate) fn start_reader(
        self,
        mut on_event: impl FnMut(TerminalIntegrationControlEvent) -> Result<(), String> + Send + 'static,
        on_closed: impl FnOnce(Option<String>) + Send + 'static,
    ) -> TerminalIntegrationControlHandle {
        let stopped = Arc::new(AtomicBool::new(false));
        let reader_stopped = Arc::clone(&stopped);
        #[cfg(unix)]
        let wake_path = match &self.endpoint {
            ControlEndpoint::Unix { fifo_path, .. } => Some(fifo_path.clone()),
            #[cfg(test)]
            ControlEndpoint::Windows { .. } => None,
        };
        let reader_thread = thread::spawn(move || {
            // Retain the private bootstrap directory for the full shell
            // generation. It contains no nonce, output, or credential data.
            let _bootstrap_root = self.bootstrap_root;
            match self.endpoint {
                #[cfg(unix)]
                ControlEndpoint::Unix { mut reader, .. } => {
                    let result = read_control_events(&mut reader, &mut on_event);
                    let failed = result.is_err();
                    on_closed(if reader_stopped.load(Ordering::Acquire) {
                        None
                    } else {
                        result.err()
                    });
                    if failed {
                        drain_failed_control_channel(&mut reader, &reader_stopped);
                    }
                }
                #[cfg(any(windows, test))]
                ControlEndpoint::Windows { pipe_path } => match open_windows_pipe(&pipe_path) {
                    Ok(mut reader) => {
                        let result = read_control_events(&mut reader, &mut on_event);
                        let failed = result.is_err();
                        on_closed(if reader_stopped.load(Ordering::Acquire) {
                            None
                        } else {
                            result.err()
                        });
                        if failed {
                            drain_failed_control_channel(&mut reader, &reader_stopped);
                        }
                    }
                    Err(error) => on_closed(Some(error)),
                },
            }
        });
        TerminalIntegrationControlHandle {
            stopped,
            #[cfg(unix)]
            wake_path,
            reader_thread: Some(reader_thread),
        }
    }
}

fn drain_failed_control_channel(reader: &mut impl Read, stopped: &AtomicBool) {
    let mut buffer = [0_u8; 1024];
    loop {
        if stopped.load(Ordering::Acquire) {
            return;
        }
        match reader.read(&mut buffer) {
            Ok(0) => return,
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => return,
        }
    }
}

#[cfg(unix)]
fn write_posix_bootstrap(
    root: &Path,
    shell: TerminalShellKind,
    fifo_path: &Path,
) -> Result<PathBuf, String> {
    match shell {
        TerminalShellKind::Bash => {
            let path = root.join("shellspan-bashrc");
            fs::write(&path, bash_bootstrap(fifo_path, true))
                .map_err(|error| format!("failed to write bash integration: {error}"))?;
            Ok(path)
        }
        TerminalShellKind::Zsh => {
            let passthrough = [
                (".zshenv", "$HOME/.zshenv"),
                (".zprofile", "$HOME/.zprofile"),
                (".zlogin", "$HOME/.zlogin"),
            ];
            for (name, source) in passthrough {
                fs::write(
                    root.join(name),
                    format!("[[ -r {source} ]] && source {source}\n"),
                )
                .map_err(|error| format!("failed to write zsh startup passthrough: {error}"))?;
            }
            let path = root.join(".zshrc");
            fs::write(&path, zsh_bootstrap(fifo_path, true, false))
                .map_err(|error| format!("failed to write zsh integration: {error}"))?;
            Ok(path)
        }
        TerminalShellKind::WindowsPowerShell
        | TerminalShellKind::PowerShell7
        | TerminalShellKind::Unsupported => Err("TERMINAL_INTEGRATION_UNSUPPORTED_SHELL".into()),
    }
}

fn bash_bootstrap(fifo_path: &Path, source_login_profile: bool) -> String {
    let fifo_path = quote_posix(fifo_path.to_string_lossy().as_ref());
    let login_profile = if source_login_profile {
        r#"[[ -r /etc/profile ]] && source /etc/profile
if [[ -r "$HOME/.bash_profile" ]]; then
  source "$HOME/.bash_profile"
elif [[ -r "$HOME/.bash_login" ]]; then
  source "$HOME/.bash_login"
elif [[ -r "$HOME/.profile" ]]; then
  source "$HOME/.profile"
fi
"#
    } else {
        ""
    };
    format!(
        r#"{login_profile}__shellspan_control_path={fifo_path}
__shellspan_command_active=0
__shellspan_prompt_ready=0
__shellspan_pending_line=
__shellspan_previous_prompt_command=${{PROMPT_COMMAND-}}
__shellspan_emit() {{
  builtin printf '%s\0' "$@" >"$__shellspan_control_path"
}}
__shellspan_prompt_cycle() {{
  local __shellspan_status=$?
  if [[ $__shellspan_command_active -eq 0 && $__shellspan_prompt_ready -eq 1 ]]; then
    local __shellspan_late_line
    __shellspan_late_line=$__shellspan_pending_line
    __shellspan_pending_line=
    if [[ -z "$__shellspan_late_line" ]]; then
      __shellspan_late_line=$(HISTTIMEFORMAT= builtin history 1 2>/dev/null) || __shellspan_late_line=
      __shellspan_late_line=${{__shellspan_late_line#*[0-9]  }}
    fi
    __shellspan_prompt_ready=0
    __shellspan_command_active=1
    __shellspan_emit S "$__shellspan_late_line" "$PWD"
  fi
  if [[ -n "$__shellspan_previous_prompt_command" ]]; then
    builtin eval -- "$__shellspan_previous_prompt_command"
  fi
  if [[ $__shellspan_command_active -eq 1 ]]; then
    __shellspan_emit E "$__shellspan_status" "$PWD"
    __shellspan_command_active=0
  fi
  __shellspan_emit P "$PWD"
  __shellspan_emit Q
  __shellspan_prompt_ready=1
}}
__shellspan_capture_line() {{
  __shellspan_pending_line=$READLINE_LINE
}}
__shellspan_preexec() {{
  local __shellspan_debug_command=$BASH_COMMAND
  case "$__shellspan_debug_command" in
    __shellspan_prompt_cycle|__shellspan_capture_line|__shellspan_preexec) return ;;
  esac
  if [[ $__shellspan_prompt_ready -eq 1 && ${{BASH_SUBSHELL:-0}} -eq 0 ]]; then
    local __shellspan_line
    __shellspan_line=$__shellspan_pending_line
    __shellspan_pending_line=
    if [[ -z "$__shellspan_line" ]]; then
      __shellspan_line=$(HISTTIMEFORMAT= builtin history 1 2>/dev/null) || __shellspan_line=$__shellspan_debug_command
      __shellspan_line=${{__shellspan_line#*[0-9]  }}
    fi
    __shellspan_prompt_ready=0
    __shellspan_command_active=1
    __shellspan_emit S "$__shellspan_line" "$PWD"
  fi
}}
PROMPT_COMMAND=__shellspan_prompt_cycle
trap '__shellspan_preexec' DEBUG
if (( BASH_VERSINFO[0] >= 4 )); then
  if ! bind -x '"\C-x\C-g":__shellspan_capture_line' || ! bind '"\C-j":"\C-x\C-g\C-m"'; then
    __shellspan_emit X BashReadlineUnavailable
    return
  fi
fi
__shellspan_emit R bash
"#
    )
}

fn zsh_bootstrap(
    fifo_path: &Path,
    source_user_rc: bool,
    prompt_end_via_prompt_expansion: bool,
) -> String {
    let fifo_path = quote_posix(fifo_path.to_string_lossy().as_ref());
    let user_rc = if source_user_rc {
        r#"[[ -r "$HOME/.zshrc" ]] && source "$HOME/.zshrc"
"#
    } else {
        ""
    };
    let prompt_end_hook = if prompt_end_via_prompt_expansion {
        r#"__shellspan_prompt_end() {
  __shellspan_emit Q
}
setopt prompt_subst
PS1='$(__shellspan_prompt_end)'$PS1
"#
    } else {
        r#"__shellspan_line_init() {
  __shellspan_emit Q
}
autoload -Uz add-zle-hook-widget
add-zle-hook-widget line-init __shellspan_line_init
"#
    };
    format!(
        r#"{user_rc}typeset -gr __shellspan_control_path={fifo_path}
typeset -gi __shellspan_command_active=0
__shellspan_emit() {{
  builtin printf '%s\0' "$@" >"$__shellspan_control_path"
}}
__shellspan_precmd() {{
  local __shellspan_status=$?
  if (( __shellspan_command_active )); then
    __shellspan_emit E "$__shellspan_status" "$PWD"
    __shellspan_command_active=0
  fi
  __shellspan_emit P "$PWD"
}}
__shellspan_preexec() {{
  __shellspan_command_active=1
  __shellspan_emit S "$1" "$PWD"
}}
__shellspan_chpwd() {{
  __shellspan_emit D "$PWD"
}}
autoload -Uz add-zsh-hook
add-zsh-hook precmd __shellspan_precmd
add-zsh-hook preexec __shellspan_preexec
add-zsh-hook chpwd __shellspan_chpwd
{prompt_end_hook}
unset ZDOTDIR
__shellspan_emit R zsh
"#
    )
}

pub(crate) fn remote_posix_bootstrap(
    shell: TerminalShellKind,
    fifo_path: &str,
) -> Result<String, String> {
    let path = Path::new(fifo_path);
    match shell {
        TerminalShellKind::Bash => Ok(bash_bootstrap(path, true)),
        TerminalShellKind::Zsh => Ok(zsh_bootstrap(path, true, true)),
        _ => Err("TERMINAL_INTEGRATION_UNSUPPORTED_REMOTE_SHELL".into()),
    }
}

pub(crate) fn quote_remote_posix(value: &str) -> String {
    quote_posix(value)
}

fn quote_posix(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

#[cfg(any(windows, test))]
fn powershell_bootstrap(pipe_name: &str, shell: TerminalShellKind) -> String {
    let shell_name = shell.protocol_name();
    format!(
        r#"$__shellspanModule = New-Module -Name ShellSpanTerminalIntegration -ArgumentList '{pipe_name}','{shell_name}' -ScriptBlock {{
  param([string]$PipeName, [string]$ShellKind)
  $script:Pipe = [System.IO.Pipes.NamedPipeServerStream]::new($PipeName,[System.IO.Pipes.PipeDirection]::Out,1,[System.IO.Pipes.PipeTransmissionMode]::Byte,[System.IO.Pipes.PipeOptions]::None,0,4096)
  $script:Pipe.WaitForConnection()
  $script:Utf8 = [System.Text.UTF8Encoding]::new($false,$true)
  $script:CommandActive = $false
  function Send-ShellSpanControl {{
    param([string[]]$Fields)
    foreach ($Field in $Fields) {{
      $Bytes = $script:Utf8.GetBytes($Field)
      $script:Pipe.Write($Bytes,0,$Bytes.Length)
      $script:Pipe.WriteByte(0)
    }}
    $script:Pipe.Flush()
  }}
  $script:OriginalPrompt = (Get-Command prompt -CommandType Function).ScriptBlock
  function Invoke-ShellSpanPrompt {{
    param([bool]$PreviousSuccess)
    $ExitCode = if ($PreviousSuccess) {{ 0 }} else {{ if (($global:LASTEXITCODE -is [int]) -and ($global:LASTEXITCODE -ne 0)) {{ $global:LASTEXITCODE }} else {{ 1 }} }}
    if ($script:CommandActive) {{
      Send-ShellSpanControl @('E',[string]$ExitCode,(Get-Location).ProviderPath)
      $script:CommandActive = $false
    }}
    Send-ShellSpanControl @('P',(Get-Location).ProviderPath)
    $Rendered = & $script:OriginalPrompt
    Send-ShellSpanControl @('Q')
    return $Rendered
  }}
  function Start-ShellSpanCommand {{
    param([string]$Line)
    $script:CommandActive = $true
    Send-ShellSpanControl @('S',$Line,(Get-Location).ProviderPath)
    if ($null -ne $script:OriginalHistoryHandler) {{
      return [bool](& $script:OriginalHistoryHandler $Line)
    }}
    return $true
  }}
  Set-Item -Path Function:\global:prompt -Value {{
    $PreviousSuccess = $?
    & $__shellspanModule {{ param($Success) Invoke-ShellSpanPrompt $Success }} $PreviousSuccess
  }}
  if (Get-Module -ListAvailable -Name PSReadLine) {{
    Import-Module PSReadLine
    $script:OriginalHistoryHandler = (Get-PSReadLineOption).AddToHistoryHandler
    Set-PSReadLineOption -AddToHistoryHandler {{
      param($Line)
      & $__shellspanModule {{ param($CommandLine) Start-ShellSpanCommand $CommandLine }} $Line
    }}
  }} else {{
    Send-ShellSpanControl @('X','PSReadLineUnavailable')
    return
  }}
  Send-ShellSpanControl @('R',$ShellKind)
}}
"#
    )
}

#[cfg(any(windows, test))]
fn open_windows_pipe(pipe_path: &str) -> Result<File, String> {
    let deadline = Instant::now() + WINDOWS_PIPE_CONNECT_TIMEOUT;
    loop {
        match File::open(pipe_path) {
            Ok(file) => return Ok(file),
            Err(error) if Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(10));
                if error.kind() != io::ErrorKind::NotFound
                    && error.kind() != io::ErrorKind::WouldBlock
                {
                    // Named-pipe startup can transiently report access/busy
                    // errors before WaitForConnection begins accepting.
                    thread::yield_now();
                }
            }
            Err(error) => {
                return Err(format!(
                    "failed to connect PowerShell integration pipe: {error}"
                ))
            }
        }
    }
}

fn read_control_events(
    reader: &mut impl Read,
    on_event: &mut impl FnMut(TerminalIntegrationControlEvent) -> Result<(), String>,
) -> Result<(), String> {
    loop {
        let Some(kind) = read_field(reader)? else {
            return Ok(());
        };
        let event = match kind.as_str() {
            "R" => TerminalIntegrationControlEvent::Ready {
                shell: parse_shell(&required_field(reader, "ready shell")?)?,
            },
            "P" => TerminalIntegrationControlEvent::PromptStart {
                cwd: required_field(reader, "prompt cwd")?,
            },
            "Q" => TerminalIntegrationControlEvent::PromptEnd,
            "S" => TerminalIntegrationControlEvent::CommandStart {
                command_line: required_field(reader, "command line")?,
                cwd: required_field(reader, "command cwd")?,
            },
            "E" => {
                let exit_code = required_field(reader, "exit code")?
                    .parse::<i32>()
                    .map_err(|_| "TERMINAL_INTEGRATION_INVALID_EXIT_STATUS".to_string())?;
                TerminalIntegrationControlEvent::CommandEnd {
                    exit_code,
                    cwd: required_field(reader, "command end cwd")?,
                }
            }
            "D" => TerminalIntegrationControlEvent::DirectoryChanged {
                cwd: required_field(reader, "directory cwd")?,
            },
            "X" => {
                let reason = required_field(reader, "integration failure")?;
                return Err(format!("TERMINAL_INTEGRATION_DEGRADED: {reason}"));
            }
            "T" => return Ok(()),
            _ => return Err("TERMINAL_INTEGRATION_UNKNOWN_EVENT".into()),
        };
        on_event(event)?;
    }
}

fn required_field(reader: &mut impl Read, label: &str) -> Result<String, String> {
    read_field(reader)?
        .ok_or_else(|| format!("TERMINAL_INTEGRATION_TRUNCATED_EVENT: missing {label}"))
}

fn read_field(reader: &mut impl Read) -> Result<Option<String>, String> {
    let mut bytes = Vec::new();
    let mut byte = [0_u8; 1];
    loop {
        match reader.read(&mut byte) {
            Ok(0) if bytes.is_empty() => return Ok(None),
            Ok(0) => return Err("TERMINAL_INTEGRATION_TRUNCATED_FIELD".into()),
            Ok(_) if byte[0] == 0 => {
                return String::from_utf8(bytes)
                    .map(Some)
                    .map_err(|_| "TERMINAL_INTEGRATION_NON_UTF8_FIELD".into())
            }
            Ok(_) => {
                if bytes.len() >= MAX_CONTROL_FIELD_BYTES {
                    return Err("TERMINAL_INTEGRATION_FIELD_TOO_LARGE".into());
                }
                bytes.push(byte[0]);
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(format!("terminal integration control read failed: {error}")),
        }
    }
}

fn parse_shell(value: &str) -> Result<TerminalShellKind, String> {
    match value {
        "bash" => Ok(TerminalShellKind::Bash),
        "zsh" => Ok(TerminalShellKind::Zsh),
        "windowsPowerShell" => Ok(TerminalShellKind::WindowsPowerShell),
        "powerShell7" => Ok(TerminalShellKind::PowerShell7),
        _ => Err("TERMINAL_INTEGRATION_SHELL_IDENTITY_MISMATCH".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssh_control_decoder_accepts_split_frames_and_rejects_raw_forgery_bytes() {
        let mut decoder = TerminalIntegrationStreamDecoder::default();
        assert!(decoder.push(b"R\0ba").unwrap().is_empty());
        let events = decoder
            .push(b"sh\0P\0/home/tester\0Q\0S\0printf ok\0/home/tester\0")
            .unwrap();
        assert_eq!(
            events,
            vec![
                TerminalIntegrationControlEvent::Ready {
                    shell: TerminalShellKind::Bash,
                },
                TerminalIntegrationControlEvent::PromptStart {
                    cwd: "/home/tester".into(),
                },
                TerminalIntegrationControlEvent::PromptEnd,
                TerminalIntegrationControlEvent::CommandStart {
                    command_line: "printf ok".into(),
                    cwd: "/home/tester".into(),
                },
            ]
        );
        decoder.finish().unwrap();

        let mut forged_raw = TerminalIntegrationStreamDecoder::default();
        assert!(forged_raw
            .push(b"escape ]133; commandEnd exit=0")
            .unwrap()
            .is_empty());
        assert!(forged_raw.finish().is_err());
    }

    #[test]
    fn detects_supported_shells_without_guessing_unknown_names() {
        assert_eq!(
            TerminalShellKind::detect("/bin/bash"),
            TerminalShellKind::Bash
        );
        assert_eq!(
            TerminalShellKind::detect("/bin/zsh"),
            TerminalShellKind::Zsh
        );
        assert_eq!(
            TerminalShellKind::detect(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"),
            TerminalShellKind::WindowsPowerShell
        );
        assert_eq!(
            TerminalShellKind::detect("pwsh.exe"),
            TerminalShellKind::PowerShell7
        );
        assert_eq!(
            TerminalShellKind::detect("/bin/fish"),
            TerminalShellKind::Unsupported
        );
    }

    #[test]
    fn control_protocol_is_binary_framed_and_preserves_newlines_and_unicode() {
        let bytes = b"R\0zsh\0P\0/tmp/\xe7\xbb\x88\xe7\xab\xaf\0Q\0S\0printf one; printf two\0/tmp\0E\07\0/tmp\0";
        let mut events = Vec::new();
        read_control_events(&mut bytes.as_slice(), &mut |event| {
            events.push(event);
            Ok(())
        })
        .unwrap();
        assert_eq!(events.len(), 5);
        assert_eq!(
            events[3],
            TerminalIntegrationControlEvent::CommandStart {
                command_line: "printf one; printf two".into(),
                cwd: "/tmp".into(),
            }
        );
        assert_eq!(
            events[4],
            TerminalIntegrationControlEvent::CommandEnd {
                exit_code: 7,
                cwd: "/tmp".into(),
            }
        );
    }

    #[test]
    fn malformed_or_oversized_control_records_fail_closed() {
        assert!(read_control_events(&mut b"S\0unterminated".as_slice(), &mut |_| Ok(())).is_err());
        let oversized = vec![b'x'; MAX_CONTROL_FIELD_BYTES + 1];
        assert!(read_control_events(&mut oversized.as_slice(), &mut |_| Ok(())).is_err());
    }

    #[test]
    fn powershell_contract_has_no_nested_shell_or_terminal_markers() {
        for shell in [
            TerminalShellKind::WindowsPowerShell,
            TerminalShellKind::PowerShell7,
        ] {
            let script = powershell_bootstrap("pipe-id", shell);
            assert!(script.contains("$__shellspanModule = New-Module"));
            assert!(script.contains("NamedPipeServerStream"));
            assert!(script.contains("[System.IO.Pipes.PipeDirection]::Out"));
            assert!(script.contains("[System.IO.Pipes.PipeTransmissionMode]::Byte"));
            assert!(script.contains("[System.IO.Pipes.PipeOptions]::None"));
            assert!(
                script.find("WaitForConnection()").unwrap()
                    < script.find("Send-ShellSpanControl @('R'").unwrap()
            );
            assert!(script.contains("AddToHistoryHandler"));
            assert!(script.contains("Start-ShellSpanCommand $CommandLine"));
            assert!(script.contains("$PreviousSuccess = $?"));
            assert!(script.contains("$global:LASTEXITCODE"));
            assert!(script.contains("$global:LASTEXITCODE -ne 0"));
            assert!(script.contains("(Get-Location).ProviderPath"));
            assert!(!script.contains("PipeOptions]::Inheritable"));
            assert!(!script.contains("EncodedCommand"));
            assert!(!script.contains("BEGIN:"));
            assert!(!script.contains("[Agent]"));
            assert!(!script.contains("powershell.exe -"));
            assert!(!script.contains("pwsh.exe -"));
        }
    }

    #[cfg(unix)]
    #[test]
    fn posix_bootstraps_use_shell_hooks_and_a_non_inherited_fifo() {
        let bash = bash_bootstrap(Path::new("/private/control"), true);
        let zsh = zsh_bootstrap(Path::new("/private/control"), true, false);
        assert!(bash.contains("trap '__shellspan_preexec' DEBUG"));
        assert!(bash.contains("READLINE_LINE"));
        assert!(zsh.contains("add-zsh-hook preexec"));
        assert!(zsh.contains("add-zle-hook-widget line-init"));
        for script in [bash, zsh] {
            assert!(script.contains(">\"$__shellspan_control_path\""));
            assert!(!script.contains("control_fd"));
            assert!(!script.contains("BEGIN:"));
            assert!(!script.contains("[Agent]"));
            assert!(!script.contains("/bin/sh -c"));
        }
    }

    #[cfg(unix)]
    #[test]
    fn posix_resources_are_private_bounded_and_cleaned_before_reader_start() {
        use std::os::unix::fs::{FileTypeExt, PermissionsExt};

        for shell in [TerminalShellKind::Bash, TerminalShellKind::Zsh] {
            let integration = PreparedLocalShellIntegration::prepare(shell).unwrap();
            let root = integration.bootstrap_root.path().to_path_buf();
            let fifo = root.join("control");
            assert_eq!(
                fs::metadata(&root).unwrap().permissions().mode() & 0o777,
                0o700
            );
            let fifo_metadata = fs::metadata(&fifo).unwrap();
            assert!(fifo_metadata.file_type().is_fifo());
            assert_eq!(fifo_metadata.permissions().mode() & 0o777, 0o600);
            assert!(fs::read_dir(&root).unwrap().count() <= 5);

            drop(integration);
            assert!(!root.exists(), "startup rollback leaked {}", root.display());
        }
    }

    #[cfg(unix)]
    #[test]
    fn posix_reader_stop_and_failure_cleanup_are_bounded() {
        use std::sync::mpsc;

        let integration = PreparedLocalShellIntegration::prepare(TerminalShellKind::Bash).unwrap();
        let root = integration.bootstrap_root.path().to_path_buf();
        let mut handle = integration.start_reader(|_| Ok(()), |_| {});
        handle.stop();
        handle.stop();
        drop(handle);
        assert!(!root.exists(), "normal close leaked {}", root.display());

        let integration = PreparedLocalShellIntegration::prepare(TerminalShellKind::Zsh).unwrap();
        let root = integration.bootstrap_root.path().to_path_buf();
        let handle = integration.start_reader(|_| Ok(()), |_| {});
        drop(handle);
        assert!(!root.exists(), "disconnect leaked {}", root.display());

        let integration = PreparedLocalShellIntegration::prepare(TerminalShellKind::Bash).unwrap();
        let root = integration.bootstrap_root.path().to_path_buf();
        let fifo = root.join("control");
        let (closed_tx, closed_rx) = mpsc::channel();
        let handle = integration.start_reader(
            |_| Err("intentional control failure".into()),
            move |error| closed_tx.send(error).unwrap(),
        );
        let mut writer = File::options().write(true).open(&fifo).unwrap();
        writer.write_all(b"R\0bash\0").unwrap();
        writer.flush().unwrap();
        assert_eq!(
            closed_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
            Some("intentional control failure".into())
        );
        drop(writer);
        drop(handle);
        assert!(!root.exists(), "failed reader leaked {}", root.display());
    }

    #[cfg(unix)]
    #[test]
    fn posix_same_uid_reopen_is_documented_out_of_scope_tampering() {
        let integration = PreparedLocalShellIntegration::prepare(TerminalShellKind::Zsh).unwrap();
        let fifo = integration.bootstrap_root.path().join("control");

        let mut same_uid_writer = File::options().write(true).open(&fifo).unwrap();
        same_uid_writer.write_all(b"Q\0").unwrap();

        // This records the cooperative-shell boundary: mode 0700/0600
        // constrains other users but cannot distinguish the interactive shell
        // from deliberately tampering same-UID code once the path is found.
        // Visible terminal is not a sandbox; strong lifecycle work uses Direct.
        drop(same_uid_writer);
        drop(integration);
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn run_native_visible_command_acceptance(shell_path: &str, shell: TerminalShellKind) {
        use crate::terminal_broker::{
            TerminalGeometry, TerminalSessionBroker, TerminalTransportKind,
        };
        use portable_pty::{native_pty_system, PtySize};
        use std::io::Write;
        use std::sync::{Arc, Mutex};
        use std::time::Instant;

        let broker = TerminalSessionBroker::phase3_enabled_for_test(4_096);
        let transport_id = format!("native-{}", shell.protocol_name());
        broker
            .attach_transport(
                &transport_id,
                None,
                TerminalTransportKind::LocalPty,
                TerminalGeometry::new(180, 30),
            )
            .unwrap();
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 30,
                cols: 180,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut reader = pair.master.try_clone_reader().unwrap();
        let writer = Arc::new(Mutex::new(pair.master.take_writer().unwrap()));
        let integration = PreparedLocalShellIntegration::prepare(shell).unwrap();
        let integration_root = integration.bootstrap_root.path().to_path_buf();
        let integration_id = integration.integration_id().to_string();
        broker
            .register_integration_channel(&transport_id, &integration_id, shell)
            .unwrap();
        let home = tempfile::tempdir().unwrap();
        let mut command = CommandBuilder::new(shell_path);
        command.env("HOME", home.path());
        command.env("TERM", "xterm-256color");
        command.env("LANG", "C.UTF-8");
        command.env("LC_ALL", "C.UTF-8");
        integration.configure_command(&mut command).unwrap();
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);

        let control_broker = broker.clone();
        let control_transport = transport_id.clone();
        let control_integration = integration_id.clone();
        let closed_broker = broker.clone();
        let closed_transport = transport_id.clone();
        let closed_integration = integration_id.clone();
        let _integration_control = integration.start_reader(
            move |event| {
                control_broker.accept_integration_event(
                    &control_transport,
                    &control_integration,
                    event,
                )
            },
            move |error| {
                if error.is_some() {
                    let _ = closed_broker.integration_channel_closed(
                        &closed_transport,
                        &closed_integration,
                        "controlChannelFailed",
                    );
                }
            },
        );
        let display = Arc::new(Mutex::new(Vec::<u8>::new()));
        let display_reader = Arc::clone(&display);
        let output_broker = broker.clone();
        let output_transport = transport_id.clone();
        let output_thread = thread::spawn(move || {
            let mut buffer = [0_u8; 4096];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => {
                        display_reader
                            .lock()
                            .unwrap()
                            .extend_from_slice(&buffer[..count]);
                        output_broker
                            .observe_raw_output(&output_transport, &buffer[..count])
                            .unwrap();
                    }
                }
            }
        });

        wait_for_prompt(&broker, &transport_id);
        let ready = broker
            .snapshot(Some(&transport_id))
            .unwrap()
            .session
            .unwrap();
        assert_eq!(ready.integration_event_sequence, 3);
        assert_eq!(
            ready.integration_capabilities,
            [
                "promptLifecycle",
                "commandLifecycle",
                "exactCommandLine",
                "exitStatus",
                "currentDirectory",
            ]
        );
        let descendant_fds = execute_visible(
            &broker,
            &writer,
            &transport_id,
            shell,
            "/bin/sh -c 'for f in /dev/fd/*; do if [ -p \"$f\" ]; then printf \"S\\000forged\\000/tmp\\000\" >\"$f\" 2>/dev/null; exit 9; fi; done; exit 0'",
        );
        assert_eq!(
            descendant_fds.exit_code,
            Some(0),
            "foreground child inherited the integration FIFO"
        );
        let environment = execute_visible(&broker, &writer, &transport_id, shell, "/usr/bin/env");
        let integration_root_text = integration_root.to_string_lossy().into_owned();
        for secret in [
            integration_root_text.as_str(),
            "__shellspan_control_path",
            "shellspan-terminal-integration-",
            integration_id.as_str(),
        ] {
            assert!(
                !environment.combined_output.contains(secret),
                "integration control detail leaked through child environment: {secret}"
            );
        }
        let diagnostic =
            serde_json::to_string(&broker.snapshot(Some(&transport_id)).unwrap()).unwrap();
        assert!(!diagnostic.contains(&integration_root_text));
        execute_visible(&broker, &writer, &transport_id, shell, "PS1=''");
        let empty_prompt = execute_visible(
            &broker,
            &writer,
            &transport_id,
            shell,
            "printf empty-prompt-independent",
        );
        assert!(empty_prompt
            .combined_output
            .contains("empty-prompt-independent"));
        execute_visible(
            &broker,
            &writer,
            &transport_id,
            shell,
            "PS1=$'\\n\\033[35mcustom>\\033[0m '",
        );
        let prompt_independent = execute_visible(
            &broker,
            &writer,
            &transport_id,
            shell,
            "printf prompt-independent",
        );
        assert!(prompt_independent
            .combined_output
            .contains("prompt-independent"));
        let test_cwd = tempfile::tempdir().unwrap();
        let quoted_cwd = shell_single_quote(test_cwd.path().to_str().unwrap());
        let cd = execute_visible(
            &broker,
            &writer,
            &transport_id,
            shell,
            &format!("cd {quoted_cwd}"),
        );
        assert_eq!(cd.exit_code, Some(0));
        assert_eq!(cd.cwd.as_deref(), test_cwd.path().to_str());

        execute_visible(
            &broker,
            &writer,
            &transport_id,
            shell,
            "export SHELLSPAN_PHASE3_VALUE='终端值'",
        );
        let environment = execute_visible(
            &broker,
            &writer,
            &transport_id,
            shell,
            "printf '%s' \"$SHELLSPAN_PHASE3_VALUE\"",
        );
        assert!(environment.combined_output.contains("终端值"));

        execute_visible(
            &broker,
            &writer,
            &transport_id,
            shell,
            "alias ss_phase3_alias='printf alias-ok'",
        );
        let alias = execute_visible(&broker, &writer, &transport_id, shell, "ss_phase3_alias");
        assert!(alias.combined_output.contains("alias-ok"));
        execute_visible(
            &broker,
            &writer,
            &transport_id,
            shell,
            "ss_phase3_function(){ printf function-ok; }",
        );
        let function =
            execute_visible(&broker, &writer, &transport_id, shell, "ss_phase3_function");
        assert!(function.combined_output.contains("function-ok"));

        let option_command = match shell {
            TerminalShellKind::Bash => "set -o noclobber",
            TerminalShellKind::Zsh => "setopt noclobber",
            _ => unreachable!(),
        };
        execute_visible(&broker, &writer, &transport_id, shell, option_command);
        let option_check = match shell {
            TerminalShellKind::Bash => "[[ -o noclobber ]] && printf option-ok",
            TerminalShellKind::Zsh => "[[ -o noclobber ]] && printf option-ok",
            _ => unreachable!(),
        };
        let option = execute_visible(&broker, &writer, &transport_id, shell, option_check);
        assert!(option.combined_output.contains("option-ok"));

        let rich = execute_visible(
            &broker,
            &writer,
            &transport_id,
            shell,
            "printf '\\033[31m终端\\033[0m'; false",
        );
        assert_eq!(rich.command_line, "printf '\\033[31m终端\\033[0m'; false");
        assert_eq!(rich.exit_code, Some(1));
        assert!(rich.combined_output.contains("\u{1b}[31m终端\u{1b}[0m"));

        for (requested, expected) in [
            (
                crate::terminal_broker::TerminalCommandRequestedSettlement::Cancelled,
                crate::terminal_broker::TerminalCommandState::Cancelled,
            ),
            (
                crate::terminal_broker::TerminalCommandRequestedSettlement::TimedOut,
                crate::terminal_broker::TerminalCommandState::TimedOut,
            ),
            (
                crate::terminal_broker::TerminalCommandRequestedSettlement::TakenOver,
                crate::terminal_broker::TerminalCommandState::TakenOver,
            ),
        ] {
            let interrupted =
                execute_interrupted_visible(&broker, &writer, &transport_id, shell, requested);
            assert_eq!(interrupted.state, expected);
            assert!(interrupted.exit_code.is_some());
        }

        let before_large = display.lock().unwrap().len();
        let large = execute_visible(
            &broker,
            &writer,
            &transport_id,
            shell,
            "i=0; while (( i < 12000 )); do printf x; (( i++ )); done",
        );
        assert!(large.capture_truncated);
        assert_eq!(large.combined_output.len(), 4_096);
        wait_until(Duration::from_secs(2), || {
            display.lock().unwrap().len() >= before_large + 12_000
        });

        writer.lock().unwrap().write_all(b"exit\n").unwrap();
        writer.lock().unwrap().flush().unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while child.try_wait().unwrap().is_none() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        if child.try_wait().unwrap().is_none() {
            child.kill().unwrap();
        }
        drop(writer);
        drop(pair.master);
        output_thread.join().unwrap();
        let display_bytes = display.lock().unwrap();
        let display = String::from_utf8_lossy(&display_bytes);
        assert!(!display.contains(&integration_root_text));
        assert!(!display.contains(integration_id.as_str()));
    }

    #[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
    fn execute_visible(
        broker: &crate::terminal_broker::TerminalSessionBroker,
        writer: &std::sync::Arc<std::sync::Mutex<Box<dyn std::io::Write + Send>>>,
        transport_id: &str,
        shell: TerminalShellKind,
        command: &str,
    ) -> crate::terminal_broker::TerminalCommandSnapshot {
        use crate::terminal_broker::{TerminalBrokerInputSource, TerminalInputKind};
        let operation_id = format!("operation-{}", Uuid::new_v4().simple());
        broker
            .acquire_agent_lease(transport_id, "agent-session", "task-phase3", &operation_id)
            .unwrap();
        let operation = broker
            .begin_command(transport_id, &operation_id, command)
            .unwrap();
        let input = format!("{}{}", command, shell.enter());
        broker
            .admit_compatibility_input(
                transport_id,
                TerminalBrokerInputSource::Agent {
                    agent_session_id: "agent-session".into(),
                    task_id: "task-phase3".into(),
                    operation_id: operation_id.clone(),
                },
                TerminalInputKind::Text,
                input.as_bytes(),
                || {
                    let mut writer = writer.lock().unwrap();
                    writer
                        .write_all(input.as_bytes())
                        .map_err(|error| error.to_string())?;
                    writer.flush().map_err(|error| error.to_string())
                },
            )
            .unwrap();
        let mut snapshot = operation
            .wait_until_terminal(Duration::from_secs(8))
            .unwrap();
        assert!(
            snapshot.state.is_terminal(),
            "command did not settle: {snapshot:?}"
        );
        assert_eq!(
            snapshot.state,
            crate::terminal_broker::TerminalCommandState::Completed,
            "exact lifecycle failed for command {command:?}: {snapshot:?}"
        );
        thread::sleep(Duration::from_millis(40));
        broker
            .retire_command(transport_id, &snapshot.command_id)
            .unwrap();
        snapshot = operation.snapshot().unwrap();
        broker
            .release_agent_lease(transport_id, "agent-session", "task-phase3", &operation_id)
            .unwrap();
        wait_for_prompt(broker, transport_id);
        snapshot
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn execute_interrupted_visible(
        broker: &crate::terminal_broker::TerminalSessionBroker,
        writer: &std::sync::Arc<std::sync::Mutex<Box<dyn std::io::Write + Send>>>,
        transport_id: &str,
        shell: TerminalShellKind,
        requested: crate::terminal_broker::TerminalCommandRequestedSettlement,
    ) -> crate::terminal_broker::TerminalCommandSnapshot {
        use crate::terminal_broker::{TerminalBrokerInputSource, TerminalInputKind};
        use std::io::Write;

        let operation_id = format!("operation-{}", Uuid::new_v4().simple());
        broker
            .acquire_agent_lease(transport_id, "agent-session", "task-phase3", &operation_id)
            .unwrap();
        let command = "sleep 10";
        let operation = broker
            .begin_command(transport_id, &operation_id, command)
            .unwrap();
        let input = format!("{}{}", command, shell.enter());
        broker
            .admit_compatibility_input(
                transport_id,
                TerminalBrokerInputSource::Agent {
                    agent_session_id: "agent-session".into(),
                    task_id: "task-phase3".into(),
                    operation_id: operation_id.clone(),
                },
                TerminalInputKind::Text,
                input.as_bytes(),
                || {
                    let mut writer = writer.lock().unwrap();
                    writer
                        .write_all(input.as_bytes())
                        .map_err(|error| error.to_string())?;
                    writer.flush().map_err(|error| error.to_string())
                },
            )
            .unwrap();
        wait_until(Duration::from_secs(2), || {
            operation.snapshot().is_ok_and(|snapshot| {
                snapshot.state == crate::terminal_broker::TerminalCommandState::Running
            })
        });
        // preexec is emitted immediately before the shell launches the
        // foreground program. Let the PTY foreground process group settle so
        // this acceptance case measures interrupt behavior, not the tiny
        // preexec-to-exec scheduling window.
        thread::sleep(Duration::from_millis(100));
        assert!(operation.request_settlement(requested).unwrap());
        broker
            .admit_compatibility_input(
                transport_id,
                TerminalBrokerInputSource::System {
                    operation_id: operation_id.clone(),
                },
                TerminalInputKind::Interrupt,
                &[3],
                || {
                    let mut writer = writer.lock().unwrap();
                    writer.write_all(&[3]).map_err(|error| error.to_string())?;
                    writer.flush().map_err(|error| error.to_string())
                },
            )
            .unwrap();
        if requested == crate::terminal_broker::TerminalCommandRequestedSettlement::TakenOver {
            broker
                .release_agent_lease(transport_id, "agent-session", "task-phase3", &operation_id)
                .unwrap();
            assert!(broker
                .admit_compatibility_input(
                    transport_id,
                    TerminalBrokerInputSource::Agent {
                        agent_session_id: "agent-session".into(),
                        task_id: "task-phase3".into(),
                        operation_id: operation_id.clone(),
                    },
                    TerminalInputKind::Text,
                    b"rejected",
                    || panic!("post-takeover Agent input reached the terminal"),
                )
                .is_err());
        }
        let mut snapshot = operation
            .wait_until_terminal(Duration::from_secs(3))
            .unwrap();
        assert!(
            snapshot.state.is_terminal(),
            "{requested:?} interrupt did not settle: {snapshot:?}"
        );
        thread::sleep(Duration::from_millis(40));
        broker
            .retire_command(transport_id, &snapshot.command_id)
            .unwrap();
        snapshot = operation.snapshot().unwrap();
        if requested != crate::terminal_broker::TerminalCommandRequestedSettlement::TakenOver {
            broker
                .release_agent_lease(transport_id, "agent-session", "task-phase3", &operation_id)
                .unwrap();
        }
        wait_for_prompt(broker, transport_id);
        snapshot
    }

    #[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
    fn wait_for_prompt(broker: &crate::terminal_broker::TerminalSessionBroker, transport_id: &str) {
        use std::time::Instant;
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let snapshot = broker.snapshot(Some(transport_id)).unwrap();
            if snapshot.session.as_ref().is_some_and(|session| {
                session.integration_state == crate::terminal_broker::TerminalIntegrationState::Ready
                    && session.prompt_ready
            }) {
                return;
            }
            assert!(Instant::now() < deadline, "prompt not ready: {snapshot:?}");
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
    fn wait_until(timeout: Duration, predicate: impl Fn() -> bool) {
        use std::time::Instant;
        let deadline = Instant::now() + timeout;
        while !predicate() {
            assert!(Instant::now() < deadline, "condition did not become true");
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn shell_single_quote(value: &str) -> String {
        format!("'{}'", value.replace('\'', "'\"'\"'"))
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_native_bash_visible_commands_preserve_shell_state_and_raw_display() {
        run_native_visible_command_acceptance("/bin/bash", TerminalShellKind::Bash);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_native_zsh_visible_commands_preserve_shell_state_and_raw_display() {
        run_native_visible_command_acceptance("/bin/zsh", TerminalShellKind::Zsh);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_native_bash_visible_commands_preserve_shell_state_and_raw_display() {
        run_native_visible_command_acceptance("/bin/bash", TerminalShellKind::Bash);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_native_zsh_visible_commands_preserve_shell_state_and_raw_display() {
        run_native_visible_command_acceptance("/bin/zsh", TerminalShellKind::Zsh);
    }

    #[cfg(target_os = "windows")]
    fn run_windows_visible_command_acceptance(executable: &str, shell: TerminalShellKind) {
        use crate::terminal_broker::{
            TerminalGeometry, TerminalSessionBroker, TerminalTransportKind,
        };
        use portable_pty::{native_pty_system, PtySize};
        use std::io::Write;
        use std::sync::{Arc, Mutex};
        use std::time::Instant;

        let broker = TerminalSessionBroker::phase3_enabled_for_test(4_096);
        let transport_id = format!("native-{}", shell.protocol_name());
        broker
            .attach_transport(
                &transport_id,
                None,
                TerminalTransportKind::WindowsConPty,
                TerminalGeometry::new(180, 30),
            )
            .unwrap();
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 30,
                cols: 180,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut reader = pair.master.try_clone_reader().unwrap();
        let writer = Arc::new(Mutex::new(pair.master.take_writer().unwrap()));
        let integration = PreparedLocalShellIntegration::prepare(shell).unwrap();
        let integration_id = integration.integration_id().to_string();
        broker
            .register_integration_channel(&transport_id, &integration_id, shell)
            .unwrap();
        let mut command = CommandBuilder::new(executable);
        command.env("TERM", "xterm-256color");
        integration.configure_command(&mut command).unwrap();
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);

        let control_broker = broker.clone();
        let control_transport = transport_id.clone();
        let control_integration = integration_id.clone();
        let closed_broker = broker.clone();
        let closed_transport = transport_id.clone();
        let _integration_control = integration.start_reader(
            move |event| {
                control_broker.accept_integration_event(
                    &control_transport,
                    &control_integration,
                    event,
                )
            },
            move |error| {
                if error.is_some() {
                    let _ = closed_broker.integration_channel_closed(
                        &closed_transport,
                        &integration_id,
                        "controlChannelFailed",
                    );
                }
            },
        );
        let display = Arc::new(Mutex::new(Vec::<u8>::new()));
        let display_reader = Arc::clone(&display);
        let output_broker = broker.clone();
        let output_transport = transport_id.clone();
        let output_thread = thread::spawn(move || {
            let mut buffer = [0_u8; 4096];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => {
                        display_reader
                            .lock()
                            .unwrap()
                            .extend_from_slice(&buffer[..count]);
                        output_broker
                            .observe_raw_output(&output_transport, &buffer[..count])
                            .unwrap();
                    }
                }
            }
        });

        wait_for_prompt(&broker, &transport_id);
        let cwd = tempfile::tempdir().unwrap();
        let path = cwd.path().to_string_lossy().replace('\'', "''");
        let changed = execute_visible(
            &broker,
            &writer,
            &transport_id,
            shell,
            &format!("Set-Location -LiteralPath '{path}'"),
        );
        assert_eq!(changed.cwd.as_deref(), cwd.path().to_str());
        execute_visible(
            &broker,
            &writer,
            &transport_id,
            shell,
            "$env:SHELLSPAN_PHASE3_VALUE='终端值'",
        );
        let environment = execute_visible(
            &broker,
            &writer,
            &transport_id,
            shell,
            "[Console]::Write($env:SHELLSPAN_PHASE3_VALUE)",
        );
        assert!(environment.combined_output.contains("终端值"));
        execute_visible(
            &broker,
            &writer,
            &transport_id,
            shell,
            "Set-Alias -Name ss_phase3_alias -Value Write-Output",
        );
        let alias = execute_visible(
            &broker,
            &writer,
            &transport_id,
            shell,
            "ss_phase3_alias alias-ok",
        );
        assert!(alias.combined_output.contains("alias-ok"));
        execute_visible(
            &broker,
            &writer,
            &transport_id,
            shell,
            "function ss_phase3_function { [Console]::Write('function-ok') }",
        );
        let function =
            execute_visible(&broker, &writer, &transport_id, shell, "ss_phase3_function");
        assert!(function.combined_output.contains("function-ok"));
        execute_visible(
            &broker,
            &writer,
            &transport_id,
            shell,
            "$ErrorActionPreference='Continue'",
        );
        let rich = execute_visible(
            &broker,
            &writer,
            &transport_id,
            shell,
            "[Console]::Write(\"`e[31m终端`e[0m\")",
        );
        assert_eq!(rich.exit_code, Some(0));
        assert!(rich.combined_output.contains("终端"));
        let native_failure = execute_visible(
            &broker,
            &writer,
            &transport_id,
            shell,
            "cmd.exe /d /c exit 7",
        );
        assert_eq!(native_failure.exit_code, Some(7));
        let cmdlet_failure = execute_visible(
            &broker,
            &writer,
            &transport_id,
            shell,
            "$global:LASTEXITCODE=0; Write-Error expected",
        );
        assert_eq!(cmdlet_failure.exit_code, Some(1));
        let before_large = display.lock().unwrap().len();
        let large = execute_visible(
            &broker,
            &writer,
            &transport_id,
            shell,
            "1..12000 | ForEach-Object { [Console]::Write('x') }",
        );
        assert!(large.capture_truncated);
        wait_until(Duration::from_secs(3), || {
            display.lock().unwrap().len() >= before_large + 12_000
        });

        writer.lock().unwrap().write_all(b"exit\r").unwrap();
        writer.lock().unwrap().flush().unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while child.try_wait().unwrap().is_none() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        if child.try_wait().unwrap().is_none() {
            child.kill().unwrap();
        }
        drop(writer);
        drop(pair.master);
        output_thread.join().unwrap();
    }

    #[cfg(target_os = "windows")]
    #[test]
    #[ignore = "requires native Windows PowerShell 5.1 and ConPTY"]
    fn windows_powershell_5_1_visible_command_integration() {
        run_windows_visible_command_acceptance(
            "powershell.exe",
            TerminalShellKind::WindowsPowerShell,
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    #[ignore = "requires native PowerShell 7 and ConPTY"]
    fn windows_powershell_7_visible_command_integration() {
        run_windows_visible_command_acceptance("pwsh.exe", TerminalShellKind::PowerShell7);
    }
}
