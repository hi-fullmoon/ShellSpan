use std::fs::{self, File};
#[cfg(unix)]
use std::io::Write;
use std::io::{self, Read};
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
        while let Some(kind) = self.pending_fields.first().map(String::as_str) {
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
        let _already_stopped = self.stopped.swap(true, Ordering::AcqRel);
        #[cfg(unix)]
        if !_already_stopped {
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
    pub(crate) fn prepare(shell: TerminalShellKind, data_dir: &Path) -> Result<Self, String> {
        if !shell.supported() {
            return Err("TERMINAL_INTEGRATION_UNSUPPORTED_SHELL".into());
        }
        let temporary_root = data_dir.join("tmp");
        fs::create_dir_all(&temporary_root).map_err(|error| {
            format!("failed to create shell integration temporary root: {error}")
        })?;
        let bootstrap_root = tempfile::Builder::new()
            .prefix("shellspan-terminal-integration-")
            .tempdir_in(&temporary_root)
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
            fs::write(&path, bash_bootstrap(fifo_path, true, true))
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

fn bash_bootstrap(
    fifo_path: &Path,
    source_system_profile: bool,
    source_login_profile: bool,
) -> String {
    let fifo_path = quote_posix(fifo_path.to_string_lossy().as_ref());
    let system_profile = if source_system_profile {
        r#"[[ -r /etc/profile ]] && source /etc/profile
"#
    } else {
        ""
    };
    let login_profile = if source_login_profile {
        r#"if [[ -r "$HOME/.bash_profile" ]]; then
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
        r#"{system_profile}{login_profile}__shellspan_control_path={fifo_path}
__shellspan_integration_active=1
__shellspan_command_active=0
__shellspan_prompt_ready=0
__shellspan_pending_line=
__shellspan_previous_prompt_command=${{PROMPT_COMMAND-}}
__shellspan_emit() {{
  [[ $__shellspan_integration_active -eq 1 ]] || return 0
  builtin printf '%s\0' "$@" 2>/dev/null >"$__shellspan_control_path" || {{
    __shellspan_integration_active=0
    return 0
  }}
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
typeset -gi __shellspan_integration_active=1
typeset -gi __shellspan_command_active=0
__shellspan_emit() {{
  (( __shellspan_integration_active )) || return 0
  builtin printf '%s\0' "$@" 2>/dev/null >"$__shellspan_control_path" || {{
    __shellspan_integration_active=0
    return 0
  }}
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
    home_directory: &str,
) -> Result<String, String> {
    let path = Path::new(fifo_path);
    match shell {
        TerminalShellKind::Bash => Ok(format!(
            "HOME={}\nexport HOME\n{}",
            quote_posix(home_directory),
            bash_bootstrap(path, false, true)
        )),
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
  $script:InstallHistoryOnPrompt = $false
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
    if ($script:InstallHistoryOnPrompt) {{
      $script:InstallHistoryOnPrompt = $false
      Set-PSReadLineOption -AddToHistoryHandler {{
        param($Line)
        & $__shellspanModule {{ param($CommandLine) Start-ShellSpanCommand $CommandLine }} $Line
      }}
    }}
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
  function Invoke-ShellSpanFirstEnter {{
    param($Key, $Arg)
    $Line = $null
    $Cursor = 0
    [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$Line,[ref]$Cursor)
    if (-not [string]::IsNullOrWhiteSpace($Line)) {{
      $script:CommandActive = $true
      Send-ShellSpanControl @('S',$Line,(Get-Location).ProviderPath)
    }}
    Set-PSReadLineKeyHandler -Chord Enter -Function $script:OriginalEnterFunction
    $script:InstallHistoryOnPrompt = $true
    if ($script:OriginalEnterFunction -eq 'ValidateAndAcceptLine') {{
      [Microsoft.PowerShell.PSConsoleReadLine]::ValidateAndAcceptLine($Key,$Arg)
    }} else {{
      [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine($Key,$Arg)
    }}
  }}
  Set-Item -Path Function:\global:prompt -Value {{
    $PreviousSuccess = $?
    & $__shellspanModule {{ param($Success) Invoke-ShellSpanPrompt $Success }} $PreviousSuccess
  }}
  if (Get-Module -ListAvailable -Name PSReadLine) {{
    Import-Module PSReadLine
    $script:OriginalHistoryHandler = (Get-PSReadLineOption).AddToHistoryHandler
    if ($ShellKind -eq 'windowsPowerShell') {{
      # PSReadLine 2.0 replays saved history through AddToHistoryHandler on first ReadLine.
      # Capture that first Enter directly, then install the handler at the next prompt.
      $EnterHandler = Get-PSReadLineKeyHandler | Where-Object {{ $_.Key -eq 'Enter' }} | Select-Object -First 1
      if ($null -eq $EnterHandler -or $EnterHandler.Function -notin @('AcceptLine','ValidateAndAcceptLine')) {{
        Send-ShellSpanControl @('X','UnsupportedEnterHandler')
        return
      }}
      $script:OriginalEnterFunction = $EnterHandler.Function
      Set-PSReadLineKeyHandler -Chord Enter -ScriptBlock {{
        param($Key,$Arg)
        & $__shellspanModule {{ param($PressedKey,$Argument) Invoke-ShellSpanFirstEnter $PressedKey $Argument }} $Key $Arg
      }}
    }} else {{
      Set-PSReadLineOption -AddToHistoryHandler {{
        param($Line)
        & $__shellspanModule {{ param($CommandLine) Start-ShellSpanCommand $CommandLine }} $Line
      }}
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
    include!("tests/terminal_integration.rs");
}
