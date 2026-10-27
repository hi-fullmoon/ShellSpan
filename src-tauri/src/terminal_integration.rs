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

const MAX_CONTROL_FIELD_BYTES: usize = 32_768;
const MAX_CONTROL_BUFFER_BYTES: usize = MAX_CONTROL_FIELD_BYTES * 4;

#[cfg(any(windows, test))]
const BUNDLED_PSREADLINE_FILES: &[(&str, &[u8])] = &[
    ("PSReadLine.psd1", include_bytes!("../resources/powershell/PSReadLine/2.4.5/PSReadLine.psd1")),
    ("ShellSpan.PSReadLine.psm1", include_bytes!("../resources/powershell/PSReadLine/2.4.5/ShellSpan.PSReadLine.psm1")),
    ("PSReadLine.psm1", include_bytes!("../resources/powershell/PSReadLine/2.4.5/PSReadLine.psm1")),
    ("Upstream.PSReadLine.ps1", include_bytes!("../resources/powershell/PSReadLine/2.4.5/Upstream.PSReadLine.ps1")),
    ("PSReadLine.format.ps1xml", include_bytes!("../resources/powershell/PSReadLine/2.4.5/PSReadLine.format.ps1xml")),
    ("Microsoft.PowerShell.PSReadLine.dll", include_bytes!("../resources/powershell/PSReadLine/2.4.5/Microsoft.PowerShell.PSReadLine.dll")),
    ("Microsoft.PowerShell.Pager.dll", include_bytes!("../resources/powershell/PSReadLine/2.4.5/Microsoft.PowerShell.Pager.dll")),
    ("netstd/Microsoft.PowerShell.PSReadLine.Polyfiller.dll", include_bytes!("../resources/powershell/PSReadLine/2.4.5/netstd/Microsoft.PowerShell.PSReadLine.Polyfiller.dll")),
    ("net6plus/Microsoft.PowerShell.PSReadLine.Polyfiller.dll", include_bytes!("../resources/powershell/PSReadLine/2.4.5/net6plus/Microsoft.PowerShell.PSReadLine.Polyfiller.dll")),
    ("License.txt", include_bytes!("../resources/powershell/PSReadLine/2.4.5/License.txt")),
    ("Upstream.PSReadLine.psd1", include_bytes!("../resources/powershell/PSReadLine/2.4.5/Upstream.PSReadLine.psd1")),
];

#[cfg(any(windows, test))]
fn prepare_bundled_powershell_module(data_dir: &Path) -> Result<PathBuf, String> {
    use sha2::{Digest, Sha256};
    let mut digest = Sha256::new();
    for (name, bytes) in BUNDLED_PSREADLINE_FILES {
        digest.update(name.as_bytes());
        digest.update([0]);
        digest.update(bytes);
    }
    let identity = hex::encode(digest.finalize());
    let parent = data_dir.join("native-editor-modules");
    fs::create_dir_all(&parent)
        .map_err(|error| format!("failed to prepare native editor cache: {error}"))?;
    let root = parent.join(&identity[..32]);
    if !root.exists() {
        let staging = tempfile::Builder::new()
            .prefix(".psreadline-")
            .tempdir_in(&parent)
            .map_err(|error| format!("failed to stage native editor: {error}"))?;
        let version = staging.path().join("PSReadLine/2.4.5");
        for (name, bytes) in BUNDLED_PSREADLINE_FILES {
            let path = version.join(name);
            fs::create_dir_all(path.parent().ok_or("invalid bundled editor path")?)
                .map_err(|error| format!("failed to prepare native editor directory: {error}"))?;
            fs::write(path, bytes)
                .map_err(|error| format!("failed to stage native editor file: {error}"))?;
        }
        if let Err(error) = fs::rename(staging.path(), &root) {
            if !root.exists() {
                return Err(format!("failed to install native editor: {error}"));
            }
        }
    }
    for (name, bytes) in BUNDLED_PSREADLINE_FILES {
        let actual = fs::read(root.join("PSReadLine/2.4.5").join(name))
            .map_err(|error| format!("failed to verify native editor: {error}"))?;
        if actual.as_slice() != *bytes {
            return Err("bundled native editor integrity mismatch".into());
        }
    }
    Ok(root)
}

pub(crate) fn bash_native_submission(source: &str) -> Result<String, String> {
    if source.len() > 8192 {
        return Err(
            "TERMINAL_INPUT_UNSUPPORTED: source exceeds 8192 UTF-8 bytes; no input was sent".into(),
        );
    }
    let quoted = shlex::try_quote(source).map_err(|_| "TERMINAL_INPUT_UNSUPPORTED")?;
    // A real status-only command before eval preserves Bash's foreground
    // interrupt settlement. The approved script still runs at parent top level.
    Ok(format!("(exit \"$?\"); builtin eval -- {quoted}"))
}

pub(crate) fn bash_native_eval_source(line: &str) -> Option<String> {
    let quoted = if let Some(quoted) = line.strip_prefix("(exit \"$?\"); builtin eval -- ") {
        quoted
    } else {
        let (handle, quoted) = line.strip_prefix("( ")?.split_once(";\nbuiltin eval -- ")?;
        crate::terminal_jobs::validate_handle(handle).ok()?;
        quoted.strip_suffix("\n) &")?
    };
    let words = shlex::split(quoted)?;
    (words.len() == 1).then(|| words[0].clone())
}
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
    NativeCleared {
        sequence: u64,
        buffer: String,
    },
    NativeCheckpoint {
        buffer: String,
    },
    NativePrivateControl {
        enabled: bool,
    },
    NativePrivateReady,
    NativePrivateCheckpoint {
        descriptor: String,
        buffer: String,
    },
    NativeCheckpointMode {
        enabled: bool,
    },
    Job {
        handle: String,
        state: String,
        exit_code: Option<i32>,
    },
    Ready {
        shell: TerminalShellKind,
    },
    NativeInput {
        enabled: bool,
    },
    NativeJobs {
        enabled: bool,
    },
    NativeComments {
        enabled: bool,
    },
    InputRejected {
        command_line: String,
        reason: String,
    },
    InterruptUncertain,
    PromptStart {
        cwd: String,
    },
    PromptEnd,
    CommandStart {
        command_line: String,
        cwd: String,
    },
    CommandEnd {
        exit_code: i32,
        cwd: String,
    },
    DirectoryChanged {
        cwd: String,
    },
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
                "R" | "P" | "X" | "I" | "C" | "K" | "A" | "H" | "V" => 2,
                "L" => 3,
                "Q" | "T" | "U" | "W" => 1,
                "S" | "E" | "J" | "F" | "M" => 3,
                "B" => 4,
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
        "L" => {
            let sequence = fields[1]
                .parse::<u64>()
                .map_err(|_| "TERMINAL_NATIVE_CLEAR_INVALID_SEQUENCE")?;
            if sequence == 0
                || sequence > 9_007_199_254_740_991
                || fields[1] != sequence.to_string()
            {
                return Err("TERMINAL_NATIVE_CLEAR_INVALID_SEQUENCE".into());
            }
            Ok(Some(TerminalIntegrationControlEvent::NativeCleared {
                sequence,
                buffer: fields[2].clone(),
            }))
        }
        "H" => Ok(Some(
            TerminalIntegrationControlEvent::NativeCheckpointMode {
                enabled: match fields[1].as_str() {
                    "1" => true,
                    "0" => false,
                    _ => return Err("TERMINAL_NATIVE_CHECKPOINT_INVALID_MODE".into()),
                },
            },
        )),
        "A" => Ok(Some(TerminalIntegrationControlEvent::NativeCheckpoint {
            buffer: fields[1].clone(),
        })),
        "V" => Ok(Some(
            TerminalIntegrationControlEvent::NativePrivateControl {
                enabled: match fields[1].as_str() {
                    "1" => true,
                    "0" => false,
                    _ => return Err("TERMINAL_PRIVATE_CONTROL_INVALID_MODE".into()),
                },
            },
        )),
        "M" => Ok(Some(
            TerminalIntegrationControlEvent::NativePrivateCheckpoint {
                descriptor: fields[1].clone(),
                buffer: fields[2].clone(),
            },
        )),
        "K" => Ok(Some(TerminalIntegrationControlEvent::NativeJobs {
            enabled: match fields[1].as_str() {
                "1" => true,
                "0" => false,
                _ => return Err("TERMINAL_JOB_INVALID_CAPABILITY".into()),
            },
        })),
        "B" | "F" => {
            crate::terminal_jobs::validate_handle(&fields[1])?;
            let completion = fields[0] == "F";
            let state = if completion {
                "finished"
            } else {
                fields[2].as_str()
            };
            if !matches!(
                state,
                "finished"
                    | "running"
                    | "stopped"
                    | "stopRequested"
                    | "settled"
                    | "queued"
                    | "terminated"
                    | "uncertain"
                    | "rejected"
            ) {
                return Err("TERMINAL_JOB_INVALID_STATE".into());
            }
            if !completion && (state == "finished" || (state != "settled" && fields[3] != "-")) {
                return Err("TERMINAL_JOB_INVALID_EXIT".into());
            }
            let exit_code = if completion {
                Some(
                    fields[2]
                        .parse::<i32>()
                        .map_err(|_| "TERMINAL_JOB_INVALID_EXIT")?,
                )
            } else if fields[3] != "-" {
                Some(
                    fields[3]
                        .parse::<i32>()
                        .map_err(|_| "TERMINAL_JOB_INVALID_EXIT")?,
                )
            } else {
                None
            };
            Ok(Some(TerminalIntegrationControlEvent::Job {
                handle: fields[1].clone(),
                state: state.into(),
                exit_code,
            }))
        }
        "R" => Ok(Some(TerminalIntegrationControlEvent::Ready {
            shell: parse_shell(&fields[1])?,
        })),
        "P" => Ok(Some(TerminalIntegrationControlEvent::PromptStart {
            cwd: fields[1].clone(),
        })),
        "Q" => Ok(Some(TerminalIntegrationControlEvent::PromptEnd)),
        "W" => Ok(Some(TerminalIntegrationControlEvent::NativePrivateReady)),
        "U" => Ok(Some(TerminalIntegrationControlEvent::InterruptUncertain)),
        "I" => Ok(Some(TerminalIntegrationControlEvent::NativeInput {
            enabled: match fields[1].as_str() {
                "1" => true,
                "0" => false,
                _ => return Err("TERMINAL_INTEGRATION_INVALID_INPUT_MODE".into()),
            },
        })),
        "C" => Ok(Some(TerminalIntegrationControlEvent::NativeComments {
            enabled: match fields[1].as_str() {
                "1" => true,
                "0" => false,
                _ => return Err("TERMINAL_INTEGRATION_INVALID_INPUT_MODE".into()),
            },
        })),
        "S" => Ok(Some(TerminalIntegrationControlEvent::CommandStart {
            command_line: fields[1].clone(),
            cwd: fields[2].clone(),
        })),
        "J" => Ok(Some(TerminalIntegrationControlEvent::InputRejected {
            command_line: fields[1].clone(),
            reason: fields[2].clone(),
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
    #[cfg(windows)]
    bundled_powershell_modules: Option<PathBuf>,
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

        #[cfg(windows)]
        let bundled_powershell_modules = if shell == TerminalShellKind::WindowsPowerShell {
            Some(prepare_bundled_powershell_module(data_dir)?)
        } else {
            None
        };

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
            let mut script = powershell_bootstrap(&pipe_name, shell);
            if let Some(directory) = crate::path_utils::configured_data_directory() {
                let history = directory.join("shell-history");
                fs::create_dir_all(&history).map_err(|error| {
                    format!("failed to prepare isolated shell history: {error}")
                })?;
                script = format!(
                    "{}\n{script}",
                    powershell_history_redirect(
                        &history.join(format!("{}.txt", shell.protocol_name()))
                    )
                );
            }
            fs::write(&bootstrap_path, script)
                .map_err(|error| format!("failed to write PowerShell integration: {error}"))?;
            (ControlEndpoint::Windows { pipe_path }, bootstrap_path)
        };

        Ok(Self {
            shell,
            integration_id,
            bootstrap_root,
            bootstrap_path,
            endpoint,
            #[cfg(windows)]
            bundled_powershell_modules,
        })
    }

    pub(crate) fn shell(&self) -> TerminalShellKind {
        self.shell
    }

    pub(crate) fn integration_id(&self) -> &str {
        &self.integration_id
    }

    pub(crate) fn configure_command(&self, command: &mut CommandBuilder) -> Result<(), String> {
        #[cfg(windows)]
        if let Some(modules) = &self.bundled_powershell_modules {
            let mut paths = vec![modules.clone()];
            if let Some(previous) = command.get_env("PSModulePath") {
                paths.extend(std::env::split_paths(previous));
            }
            if let Some(system_root) = std::env::var_os("SystemRoot") {
                let system_modules =
                    PathBuf::from(system_root).join("System32/WindowsPowerShell/v1.0/Modules");
                if !paths.contains(&system_modules) {
                    paths.push(system_modules);
                }
            }
            let module_path = std::env::join_paths(paths)
                .map_err(|error| format!("failed to bind native editor module path: {error}"))?;
            command.env("PSModulePath", module_path);
        }
        #[cfg(unix)]
        if self.shell == TerminalShellKind::Zsh {
            let executable = command
                .get_argv()
                .first()
                .map(PathBuf::from)
                .filter(|path| path.is_absolute())
                .and_then(|path| fs::canonicalize(path).ok());
            fs::write(
                &self.bootstrap_path,
                zsh_bootstrap(
                    &self.bootstrap_root.path().join("control"),
                    true,
                    false,
                    executable.as_deref().and_then(Path::to_str),
                ),
            )
            .map_err(|error| format!("failed to bind native zsh parser: {error}"))?;
        }
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
            fs::write(&path, zsh_bootstrap(fifo_path, true, false, None))
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
    let job_helpers = crate::terminal_jobs::POSIX_HELPERS;
    format!(
        r#"readonly __shellspan_parser_executable=$BASH
readonly __shellspan_stty_executable=$(builtin type -P stty)
{system_profile}{login_profile}__shellspan_control_path={fifo_path}
__shellspan_integration_active=1
__shellspan_command_active=0
__shellspan_prompt_ready=0
__shellspan_pending_line=
__shellspan_native_source=
__shellspan_native_status=0
__shellspan_clear_sequence=0
__shellspan_previous_prompt_command=${{PROMPT_COMMAND-}}
__shellspan_prompt_tty_state=()
__shellspan_prompt_echo_control=0
__shellspan_receiver_tty=
__shellspan_native_quarantined=0
__shellspan_debug_prompt_echo_control=0
__shellspan_prompt_interrupt_label='^C'
__shellspan_previous_exit_trap=$(trap -p EXIT)
__shellspan_previous_int_trap=$(trap -p INT)
__shellspan_exit_trap=
__shellspan_int_trap=
__shellspan_stty() {{
  local __shellspan_stty_output __shellspan_stty_status=0
  # In Bash 3, launching a short foreground job races the parent's setpgid
  # with the child's redundant call on macOS. Command substitution keeps this
  # private helper in the shell's group; exec avoids another Bash child job.
  # User commands, prompt hooks and their monitor setting remain untouched.
  __shellspan_stty_output=$(exec "$__shellspan_stty_executable" "$@" </dev/tty) || __shellspan_stty_status=$?
  builtin printf '%s' "$__shellspan_stty_output"
  return "$__shellspan_stty_status"
}}
__shellspan_restore_prompt_tty() {{
  if [[ ${{#__shellspan_prompt_tty_state[@]}} -ne 0 ]]; then
    if __shellspan_stty "${{__shellspan_prompt_tty_state[@]}}" 2>/dev/null; then
      __shellspan_prompt_tty_state=()
    fi
  fi
}}
__shellspan_restore_receiver_tty() {{
  if [[ -n $__shellspan_receiver_tty ]]; then
    __shellspan_stty "$__shellspan_receiver_tty" 2>/dev/null
    __shellspan_receiver_tty=
  fi
}}
__shellspan_return_status() {{
  return "$1"
}}
__shellspan_run_previous_trap() {{
  local __shellspan_trap=$1 __shellspan_trap_status=$2
  shift 2
  [[ -n "$__shellspan_trap" ]] || return "$__shellspan_trap_status"
  local -a __shellspan_trap_args
  # Let Bash decode its own shell-quoted `trap -p` output.
  builtin eval "__shellspan_trap_args=(${{__shellspan_trap#trap -- }})"
  # Establish $? with a builtin function, without creating a foreground job
  # while Bash is handling a signal or exiting.
  if __shellspan_return_status "$__shellspan_trap_status"; then
    builtin eval -- "${{__shellspan_trap_args[0]}}"
  else
    builtin eval -- "${{__shellspan_trap_args[0]}}"
  fi
}}
__shellspan_on_exit() {{
  local __shellspan_exit_status=$?
  __shellspan_prompt_ready=0
  __shellspan_restore_receiver_tty
  __shellspan_restore_prompt_tty
  __shellspan_run_previous_trap "$__shellspan_previous_exit_trap" "$__shellspan_exit_status" "$@"
  return "$__shellspan_exit_status"
}}
__shellspan_on_interrupt() {{
  local __shellspan_int_status=$?
  __shellspan_restore_receiver_tty
  if [[ $__shellspan_command_active -eq 1 && -n "$__shellspan_previous_int_trap" ]]; then
    __shellspan_emit U
  fi
  # Bash 4+ normally echoes SIGINT through ECHOCTL at the input prompt.
  # Restore that feedback only while our prompt guard suppresses kernel echo.
  if (( BASH_VERSINFO[0] >= 4 )) && [[ $__shellspan_debug_prompt_echo_control -eq 1 ]]; then
    # Readline has already returned the cursor to column zero. Keep the
    # cancelled input intact and put its cancellation marker on the next line.
    builtin printf '\r\n%s' "$__shellspan_prompt_interrupt_label"
  fi
  __shellspan_run_previous_trap "$__shellspan_previous_int_trap" "$__shellspan_int_status" "$@"
  return "$__shellspan_int_status"
}}
__shellspan_guard_prompt_tty() {{
  # Canonical input needs CR-to-NL translation when Readline is disabled.
  if [[ ! -o emacs && ! -o vi ]]; then
    __shellspan_restore_prompt_tty
    return
  fi
  if [[ ${{#__shellspan_prompt_tty_state[@]}} -eq 0 ]]; then
    local __shellspan_tty_settings __shellspan_flag __shellspan_pattern __shellspan_readline_settings
    __shellspan_tty_settings=$(__shellspan_stty -a 2>/dev/null) || return
    for __shellspan_flag in icrnl echoctl; do
      __shellspan_pattern="(^|[[:space:];])${{__shellspan_flag}}([[:space:];]|$)"
      if [[ $__shellspan_tty_settings =~ $__shellspan_pattern ]]; then
        __shellspan_prompt_tty_state+=("$__shellspan_flag")
      else
        __shellspan_prompt_tty_state+=("-$__shellspan_flag")
      fi
    done
    __shellspan_pattern='(^|[[:space:];])echo([[:space:];]|$)'
    __shellspan_prompt_echo_control=0
    if [[ ${{__shellspan_prompt_tty_state[1]}} == echoctl && $__shellspan_tty_settings =~ $__shellspan_pattern ]]; then
      __shellspan_readline_settings=$(bind -v 2>/dev/null)
      __shellspan_pattern='(^|[[:space:]])set[[:space:]]+echo-control-characters[[:space:]]+on([[:space:]]|$)'
      if [[ $__shellspan_readline_settings =~ $__shellspan_pattern ]]; then
        __shellspan_prompt_echo_control=1
      fi
    fi
    __shellspan_pattern='(^|[[:space:];])intr[[:space:]]*=[[:space:]]*([^[:space:];]+)'
    if [[ $__shellspan_tty_settings =~ $__shellspan_pattern ]]; then
      __shellspan_prompt_interrupt_label=${{BASH_REMATCH[2]}}
    fi
  fi
  __shellspan_stty -icrnl -echoctl 2>/dev/null || __shellspan_restore_prompt_tty
  # User commands may replace or remove traps. Reconcile at every prompt,
  # preserving the newest handler rather than only the startup profile's trap.
  local __shellspan_current_trap
  __shellspan_current_trap=$(trap -p EXIT)
  if [[ $__shellspan_current_trap != "$__shellspan_exit_trap" || -z "$__shellspan_exit_trap" ]]; then
    __shellspan_previous_exit_trap=$__shellspan_current_trap
    trap '__shellspan_on_exit "$@"' EXIT
    __shellspan_exit_trap=$(trap -p EXIT)
  fi
  __shellspan_current_trap=$(trap -p INT)
  if [[ $__shellspan_current_trap != "$__shellspan_int_trap" || -z "$__shellspan_int_trap" ]]; then
    __shellspan_previous_int_trap=$__shellspan_current_trap
    # Bash 3.2 can resume Readline's current input after a trapped SIGINT.
    # With no user handler, retain its default cancellation rather than adding
    # a no-op trap. Only Bash 4+ needs our prompt interrupt feedback wrapper.
    if (( BASH_VERSINFO[0] < 4 )) && [[ -z "$__shellspan_current_trap" ]]; then
      __shellspan_int_trap=
      return
    fi
    if [[ -n "$__shellspan_current_trap" ]]; then
      local -a __shellspan_int_args
      builtin eval "__shellspan_int_args=(${{__shellspan_current_trap#trap -- }})"
      # An ignored SIGINT must stay ignored by commands and their children.
      if [[ -z "${{__shellspan_int_args[0]}}" ]]; then
        __shellspan_int_trap=$__shellspan_current_trap
        return
      fi
    fi
    trap '__shellspan_on_interrupt "$@"' INT
    __shellspan_int_trap=$(trap -p INT)
  fi
}}
__shellspan_emit() {{
  [[ ${{BASH_SUBSHELL:-0}} -eq 0 ]] || return 0
  [[ $__shellspan_integration_active -eq 1 ]] || return 0
  builtin printf '%s\0' "$@" 2>/dev/null >"$__shellspan_control_path" || {{
    __shellspan_integration_active=0
    return 0
  }}
  # Display-only boundary, ordered with PTY text. Lifecycle stays on the FIFO.
  case "$1" in
    P) builtin printf '\033]133;A\007' ;;
    S) builtin printf '\033]133;C\007' ;;
  esac
}}
__shellspan_prompt_cycle() {{
  local __shellspan_status=$?
  __shellspan_restore_receiver_tty
  __shellspan_private_descriptor=
  if [[ -n ${{__shellspan_job_armed_handle-}} ]]; then
    local __shellspan_identity="${{__shellspan_control_path}}.job.${{__shellspan_job_armed_handle}}.identity" __shellspan_pid
    builtin jobs -p "%( $__shellspan_job_armed_handle;" >| "$__shellspan_identity" 2>/dev/null
    IFS= builtin read -r __shellspan_pid < "$__shellspan_identity"
    if [[ -n $__shellspan_pid ]]; then
      __shellspan_job_register "$__shellspan_job_armed_handle"
    elif [[ -f ${{__shellspan_control_path}}.job.${{__shellspan_job_armed_handle}} ]]; then
      __shellspan_job_register "$__shellspan_job_armed_handle"
      __shellspan_job_completion "$__shellspan_job_armed_handle"
      __shellspan_emit B "$__shellspan_job_armed_handle" settled -
    else
      __shellspan_emit B "$__shellspan_job_armed_handle" rejected -
    fi
    unset -f "$__shellspan_job_armed_handle"
    __shellspan_job_armed_handle=
  fi
  __shellspan_native_status=$__shellspan_status
  __shellspan_native_source=
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
  __shellspan_guard_prompt_tty
  if [[ $__shellspan_command_active -eq 1 && -n "$__shellspan_previous_int_trap" ]]; then
    __shellspan_emit U
  fi
  if [[ $__shellspan_command_active -eq 1 ]]; then
    __shellspan_emit E "$__shellspan_status" "$PWD"
    __shellspan_command_active=0
  fi
  __shellspan_emit P "$PWD"
  # Bash 4.x executes bind-x's command string in place. Rebinding the active
  # receiver from its syntax-rejection callback frees that executing string.
  # Keep its existing bindings until the next real PROMPT_COMMAND cycle.
  if [[ ${{1-}} != native-reject ]]; then
    __shellspan_native_input=0
    if (( ! __shellspan_native_quarantined && (BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 1)) )) && [[ -o emacs || -o vi ]] && [[ -z "$__shellspan_previous_int_trap" && $__shellspan_parser_executable == /* && $__shellspan_stty_executable == /* ]]; then
      # Older Readline leaves the tty's VDISCARD active on macOS: it consumes
      # Ctrl-O before bind-x sees it. Ctrl-R reaches the private receiver.
      if bind '"\C-x\C-v":quoted-insert' && bind '"\C-xn":"\C-x\C-v\C-j"' && bind '"\C-xt":"\C-x\C-v\C-i"' && bind '"\C-xr":"\C-x\C-v\C-m"' && bind -x '"\C-x\C-a":__shellspan_native_checkpoint' && bind -x '"\C-x\C-d":__shellspan_discard_native' && bind -x '"\C-x\C-g":__shellspan_capture_line' && bind '"\C-x\C-e":accept-line' && bind -x '"\C-x\C-r":__shellspan_private_receive' && bind -x '"\C-x\C-k":__shellspan_private_commit'; then
        __shellspan_native_input=1
      fi
    fi
  fi
  __shellspan_emit I "$__shellspan_native_input"
  __shellspan_emit H "$__shellspan_native_input"
  if [[ $__shellspan_native_input == 1 && ${{1-}} != native-reject ]]; then
    bind -x '"\C-x\C-b":__shellspan_native_receive'
  fi
  __shellspan_emit V "$__shellspan_native_input"
  if [[ $__shellspan_native_input == 1 && -o monitor ]]; then __shellspan_emit K 1; else __shellspan_emit K 0; fi
  __shellspan_emit Q
  __shellspan_prompt_ready=1
}}
__shellspan_capture_line() {{
  __shellspan_pending_line=$READLINE_LINE
}}
__shellspan_accept_native() {{
  local __shellspan_source=$READLINE_LINE __shellspan_marker= __shellspan_prefix __shellspan_original=${{1-}}
  if [[ $READLINE_LINE == '( job-'* ]]; then
    __shellspan_marker=${{READLINE_LINE:2:36}}
    __shellspan_prefix="( $__shellspan_marker;"$'\nbuiltin eval -- '
    if [[ ${{#__shellspan_marker}} != 36 || ${{__shellspan_marker#job-}} == *[!0-9a-f]* || $READLINE_LINE != "$__shellspan_prefix"*$'\n) &' || -z $__shellspan_original || -n $(type -t -- "$__shellspan_marker") ]] || ! __shellspan_validate_native "$__shellspan_original" quiet; then
      __shellspan_emit J "$READLINE_LINE" TERMINAL_INPUT_UNSUPPORTED
      READLINE_LINE=; READLINE_POINT=0; __shellspan_prompt_ready=0; return
    fi
  fi
  if ! __shellspan_validate_native "$__shellspan_source"; then
    READLINE_LINE=; READLINE_POINT=0; __shellspan_prompt_ready=0; return
  fi
  if [[ -n $__shellspan_marker ]]; then
    if [[ -o errexit && $__shellspan_native_status != 0 ]]; then
      __shellspan_emit J "$READLINE_LINE" TERMINAL_BACKGROUND_UNSUPPORTED
      READLINE_LINE=; READLINE_POINT=0; __shellspan_prompt_ready=0; return
    fi
    __shellspan_job_aliases=0
    if shopt -q expand_aliases; then __shellspan_job_aliases=1; fi
    builtin eval -- "$__shellspan_marker() {{ __shellspan_job_initialize_bash $__shellspan_marker; }}"
    __shellspan_job_armed_handle=$__shellspan_marker
  fi
  __shellspan_pending_line=$READLINE_LINE
}}
__shellspan_private_receive() {{
  __shellspan_private_descriptor=
  [[ -z "$READLINE_LINE" ]] || {{ __shellspan_emit M '' "$READLINE_LINE"; return; }}
  __shellspan_emit W
  local __shellspan_data
  if __shellspan_read_private 65 2 __shellspan_data && [[ ${{#__shellspan_data}} == 65 && ${{__shellspan_data:0:1}} == [ps] && ${{__shellspan_data:1}} != *[!0-9a-f]* ]]; then
    __shellspan_private_descriptor=$__shellspan_data
  fi
  __shellspan_emit M "$__shellspan_private_descriptor" "$READLINE_LINE"
}}
__shellspan_private_commit() {{
  local __shellspan_descriptor=$__shellspan_private_descriptor __shellspan_status __shellspan_action=poll
  __shellspan_private_descriptor=
  [[ -z "$READLINE_LINE" && ${{#__shellspan_descriptor}} == 65 ]] || return
  local __shellspan_handle="job-${{__shellspan_descriptor:1:32}}"
  [[ ${{__shellspan_descriptor:0:1}} == s ]] && __shellspan_action=stop
  __shellspan_emit S "__shellspan_job_control $__shellspan_handle $__shellspan_action" "$PWD"
  if __shellspan_job_control "$__shellspan_handle" "$__shellspan_action"; then __shellspan_status=0; else __shellspan_status=$?; fi
  __shellspan_emit E "$__shellspan_status" "$PWD"
  __shellspan_emit P "$PWD"
  __shellspan_emit I 1
  __shellspan_emit H 1
  __shellspan_emit V 1
  if [[ -o monitor ]]; then __shellspan_emit K 1; else __shellspan_emit K 0; fi
  __shellspan_emit Q
}}
__shellspan_native_checkpoint() {{
  __shellspan_emit A "$READLINE_LINE"
}}
__shellspan_native_receive() {{
  local __shellspan_completed_descriptor=
  __shellspan_receiver_tty=$(__shellspan_stty -g 2>/dev/null) || return
  __shellspan_stty -echo 2>/dev/null || {{ __shellspan_restore_receiver_tty; return; }}
  __shellspan_native_receive_frame
  local __shellspan_receive_status=$?
  __shellspan_restore_receiver_tty
  # The acknowledgement also fences terminal-mode restoration. A following
  # discard key must reach Readline rather than the receiver's cooked tty.
  if [[ -n $__shellspan_completed_descriptor ]]; then
    __shellspan_native_frame_checkpoint "$__shellspan_completed_descriptor"
  fi
  return "$__shellspan_receive_status"
}}
__shellspan_quarantine_native() {{
  # A timed-out frame may still be arriving over SSH. Never hand its tail to
  # Readline. Keep consuming silently until transport closure;
  # the broker requires a fresh terminal generation before further input.
  __shellspan_native_quarantined=1
  # Ctrl-C cannot establish that all bytes in flight have arrived. Keep this
  # failed frame isolated even across interrupts; recovery requires reconnect.
  trap '' INT
  local __shellspan_discard
  while IFS= builtin read -r -s -n 1 __shellspan_discard </dev/tty; do :; done
  return 130
}}
__shellspan_native_receive_frame() {{
  local __shellspan_async_redraw=0
  [[ -n $(builtin jobs -p -r) ]] && __shellspan_async_redraw=1
  __shellspan_emit A "$READLINE_LINE"
  [[ -z "$READLINE_LINE" ]] || return
  local __shellspan_descriptor __shellspan_encoded __shellspan_decoded __shellspan_count __shellspan_source_count __shellspan_original=
  local __shellspan_rows __shellspan_columns __shellspan_without_newlines __shellspan_line_count __shellspan_row
  local __shellspan_deadline=$((SECONDS + 2)) __shellspan_remaining
  if ! __shellspan_read_private 65 2 __shellspan_descriptor; then
    __shellspan_emit M '' "$READLINE_LINE"; __shellspan_quarantine_native; return
  fi
  if [[ ${{#__shellspan_descriptor}} != 65 || ${{__shellspan_descriptor:0:1}} != b || ${{__shellspan_descriptor:1}} == *[!0-9a-f]* ]]; then
    __shellspan_emit M '' "$READLINE_LINE"; __shellspan_quarantine_native; return
  fi
  __shellspan_count=$((16#${{__shellspan_descriptor:1:5}}))
  __shellspan_source_count=$((16#${{__shellspan_descriptor:6:4}}))
  __shellspan_rows=$((16#${{__shellspan_descriptor:10:4}}))
  __shellspan_columns=$((16#${{__shellspan_descriptor:14:4}}))
  __shellspan_remaining=$((__shellspan_deadline - SECONDS))
  if (( __shellspan_count < 4 || __shellspan_count > 131072 || __shellspan_count % 4 || __shellspan_source_count > 32768 || __shellspan_source_count >= __shellspan_count || __shellspan_source_count % 4 || __shellspan_remaining <= 0 || __shellspan_rows < 1 || __shellspan_rows > 1000 || __shellspan_columns < 1 || __shellspan_columns > 1000 )) || ! __shellspan_read_private "$__shellspan_count" "$__shellspan_remaining" __shellspan_encoded; then
    __shellspan_emit M "$__shellspan_descriptor" "$READLINE_LINE"; __shellspan_quarantine_native; return
  fi
  builtin printf -v __shellspan_decoded '%b' "${{__shellspan_encoded:__shellspan_source_count}}"
  if (( __shellspan_source_count )); then
    builtin printf -v __shellspan_original '%b' "${{__shellspan_encoded:0:__shellspan_source_count}}"
    if ! __shellspan_validate_native "$__shellspan_original" quiet; then
      __shellspan_emit J "$__shellspan_original" TERMINAL_INPUT_UNSUPPORTED
      __shellspan_prompt_ready=0
      __shellspan_prompt_cycle native-reject
      return
    fi
  fi
  READLINE_LINE=$__shellspan_decoded
  __shellspan_readline_end "$(( (__shellspan_count - __shellspan_source_count) / 4 ))"
  __shellspan_accept_native "$__shellspan_original"
  if [[ -z "$READLINE_LINE" ]]; then __shellspan_prompt_cycle native-reject; return; fi
  if [[ -z "$__shellspan_previous_int_trap" && -n "$__shellspan_int_trap" ]]; then
    trap - INT
    __shellspan_int_trap=
  fi
  __shellspan_without_newlines=${{READLINE_LINE//$'\n'/}}
  __shellspan_line_count=$(( ${{#READLINE_LINE}} - ${{#__shellspan_without_newlines}} + 1 ))
  if (( (__shellspan_count - __shellspan_source_count) / 4 > __shellspan_rows * __shellspan_columns || __shellspan_line_count >= __shellspan_rows )); then
    # Readline clears the viewport for oversized buffers. Scroll the existing
    # native screen into terminal history first, without replaying its content.
    builtin printf '\033[%d;1H' "$__shellspan_rows"
    for ((__shellspan_row=0; __shellspan_row<__shellspan_rows; __shellspan_row++)); do builtin printf '\n'; done
    builtin printf '\033[H'
  elif [[ $__shellspan_async_redraw == 1 ]]; then
    builtin printf '\r\n'
  fi
  __shellspan_completed_descriptor=$__shellspan_descriptor
  return 124
}}
__shellspan_native_frame_checkpoint() {{
  __shellspan_emit M "$1" "$READLINE_LINE"
}}
__shellspan_readline_end() {{
  # bind-x offsets are bytes before Bash 5.0, characters starting with 5.0.
  # The receiver supplies the validated displayed-line byte length, excluding
  # the original-source field. Do not assign LC_ALL: it may be read-only.
  if (( BASH_VERSINFO[0] < 5 )); then
    READLINE_POINT=$1
  else
    READLINE_POINT=${{#READLINE_LINE}}
  fi
}}
__shellspan_read_private() {{
  local __shellspan_read_status=0 __shellspan_read_record
  local __shellspan_read_deadline=$((SECONDS + $2))
  # A synchronous command-substitution child stays in the foreground group,
  # but has no children of its own. Parent job exits cannot interrupt its
  # read builtin's legacy tcsetattr(TCSADRAIN). Keep fixed-byte boundaries;
  # do not retry/replay input or leave a helper reading the tty after timeout.
  __shellspan_read_record=$(
    __shellspan_read_value=
    __shellspan_read_remaining=$((__shellspan_read_deadline - SECONDS))
    (( __shellspan_read_remaining > 0 )) || builtin exit 142
    builtin exec {{__shellspan_read_fd}}</dev/tty || builtin exit
    IFS= builtin read -r -s -u "$__shellspan_read_fd" -N "$1" -t "$__shellspan_read_remaining" __shellspan_read_value
    __shellspan_read_status=$?
    builtin exec {{__shellspan_read_fd}}<&-
    builtin printf '%s' "$__shellspan_read_value"
    builtin exit "$__shellspan_read_status"
  ) || __shellspan_read_status=$?
  (( __shellspan_read_status == 0 )) || return "$__shellspan_read_status"
  [[ ${{#__shellspan_read_record}} == "$1" ]] || return 2
  builtin printf -v "$3" '%s' "$__shellspan_read_record"
}}
__shellspan_discard_native() {{
  __shellspan_private_descriptor=
  if [[ -n ${{__shellspan_job_armed_handle-}} ]]; then
    unset -f "$__shellspan_job_armed_handle"
    __shellspan_job_armed_handle=
  fi
  READLINE_LINE=
  READLINE_POINT=0
  __shellspan_pending_line=
  __shellspan_clear_sequence=$((__shellspan_clear_sequence + 1))
  __shellspan_emit L "$__shellspan_clear_sequence" "$READLINE_LINE"
}}
__shellspan_validate_native() {{
  local __shellspan_source=$1
  local -a __shellspan_parse_options=()
  local __shellspan_option __shellspan_parse_diagnostic
  [[ -o posix ]] && __shellspan_parse_options+=(--posix)
  for __shellspan_option in extglob extquote interactive_comments; do
    if shopt -q "$__shellspan_option"; then
      __shellspan_parse_options+=(-O "$__shellspan_option")
    else
      __shellspan_parse_options+=(+O "$__shellspan_option")
    fi
  done
  # Bash -n returns success for an unterminated heredoc, but emits a warning.
  # Any native parser diagnostic therefore refuses the entire buffer.
  if __shellspan_parse_diagnostic=$("$__shellspan_parser_executable" --noprofile --norc "${{__shellspan_parse_options[@]}}" -n -c "$__shellspan_source" 2>&1) && [[ -z "$__shellspan_parse_diagnostic" ]]; then
    __shellspan_native_source=$__shellspan_source
    return 0
  else
    [[ -z "$__shellspan_parse_diagnostic" ]] || builtin printf '%s\n' "$__shellspan_parse_diagnostic"
    [[ ${{2-}} == quiet ]] || __shellspan_emit J "$__shellspan_source" TERMINAL_INPUT_UNSUPPORTED
    __shellspan_native_source=
    return 2
  fi
}}
__shellspan_preexec() {{
  local __shellspan_debug_command=$BASH_COMMAND
  # Bash also runs DEBUG before a signal trap, with BASH_COMMAND still naming
  # the interrupted command. Remember the guard before preexec restores it.
  __shellspan_debug_prompt_echo_control=0
  if [[ ${{#__shellspan_prompt_tty_state[@]}} -ne 0 ]]; then
    __shellspan_debug_prompt_echo_control=$__shellspan_prompt_echo_control
  fi
  case "$__shellspan_debug_command" in
    __shellspan_prompt_cycle|__shellspan_restore_receiver_tty|__shellspan_capture_line|__shellspan_accept_native|__shellspan_native_receive|__shellspan_native_receive_frame|__shellspan_quarantine_native|__shellspan_read_private\ *|__shellspan_native_frame_checkpoint\ *|__shellspan_private_receive|__shellspan_private_commit|__shellspan_native_checkpoint|__shellspan_discard_native|__shellspan_preexec|__shellspan_on_exit|__shellspan_on_exit\ *|__shellspan_on_interrupt|__shellspan_on_interrupt\ *) return ;;
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
    __shellspan_restore_prompt_tty
    # Our prompt-only INT feedback handler must not make Bash resume the
    # remaining lines of an accepted native buffer after a foreground SIGINT.
    # Native input is advertised only with the user's default INT disposition.
    if [[ -z "$__shellspan_previous_int_trap" && -n "$__shellspan_int_trap" ]]; then
      trap - INT
      __shellspan_int_trap=
    elif [[ -n "$__shellspan_previous_int_trap" ]]; then
      __shellspan_emit U
    fi
    __shellspan_emit S "$__shellspan_line" "$PWD"
  fi
}}
{job_helpers}
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
    parser_executable: Option<&str>,
) -> String {
    let fifo_path = quote_posix(fifo_path.to_string_lossy().as_ref());
    let parser_executable = quote_posix(parser_executable.unwrap_or(""));
    let user_rc = if source_user_rc {
        r#"[[ -r "$HOME/.zshrc" ]] && source "$HOME/.zshrc"
"#
    } else {
        ""
    };
    let prompt_end_hook = if prompt_end_via_prompt_expansion {
        r#"__shellspan_prompt_end() {
  local __shellspan_prompt_end_active=1
  __shellspan_emit Q
}
setopt prompt_subst
PS1='${__shellspan_prompt_end_pending:+$(__shellspan_prompt_end)}${__shellspan_prompt_end_pending::=}'$PS1
"#
    } else {
        r#"__shellspan_line_init() {
  __shellspan_emit Q
}
autoload -Uz add-zle-hook-widget
add-zle-hook-widget line-init __shellspan_line_init
"#
    };
    let job_helpers = crate::terminal_jobs::POSIX_HELPERS;
    format!(
        r#"typeset -gr __shellspan_parser_executable={parser_executable}
typeset -gr __shellspan_stty_executable=$(builtin whence -p stty)
{user_rc}typeset -gr __shellspan_control_path={fifo_path}
typeset -gi __shellspan_integration_active=1
typeset -gi __shellspan_command_active=0
typeset -gi __shellspan_native_pending=0
typeset -gi __shellspan_native_quarantined=0
typeset -gi __shellspan_clear_sequence=0
typeset -g __shellspan_native_line=
__shellspan_emit() {{
  if (( ZSH_SUBSHELL )); then
    [[ $1 == Q && ${{__shellspan_prompt_end_active:-0}} == 1 ]] || return 0
  fi
  (( __shellspan_integration_active )) || return 0
  {{ builtin printf '%s\0' "$@" >"$__shellspan_control_path"; }} 2>/dev/null || {{
    __shellspan_integration_active=0
    return 0
  }}
  case "$1" in
    P) builtin printf '\033]133;A\007' ;;
    S) builtin printf '\033]133;C\007' ;;
  esac
}}
__shellspan_precmd() {{
  local __shellspan_status=$?
  __shellspan_private_descriptor=
  __shellspan_native_redraw_before_accept=0
  if [[ -n ${{__shellspan_blocked_marker-}} && ${{functions[$__shellspan_blocked_marker]-}} == "${{__shellspan_blocked_marker_definition-}}" ]]; then
    unfunction "$__shellspan_blocked_marker"
  fi
  __shellspan_blocked_marker=
  __shellspan_blocked_marker_definition=
  if [[ -n ${{__shellspan_job_armed_handle-}} ]]; then
    __shellspan_job_confirm_zsh "$__shellspan_job_armed_handle"
    __shellspan_job_release_marker_zsh
  fi
  __shellspan_native_status=$__shellspan_status
  __shellspan_prompt_end_pending=1
  if (( __shellspan_native_pending && ! __shellspan_command_active )); then
    __shellspan_emit S "$__shellspan_native_line" "$PWD"
    __shellspan_native_pending=0
    __shellspan_native_line=
    __shellspan_command_active=1
  fi
  if (( __shellspan_command_active )); then
    __shellspan_emit E "$__shellspan_status" "$PWD"
    __shellspan_command_active=0
  fi
  __shellspan_emit P "$PWD"
  __shellspan_native_pending=0
  __shellspan_publish_native_capabilities
}}
__shellspan_publish_native_capabilities() {{
  if [[ -o interactivecomments ]]; then __shellspan_emit C 1; else __shellspan_emit C 0; fi
  if [[ $__shellspan_native_quarantined == 0 && -o zle && -n $__shellspan_parser_executable && $__shellspan_stty_executable == /* ]] && zmodload zsh/datetime && zmodload -F zsh/system b:sysread && bindkey '^X^V' quoted-insert && bindkey -s '^Xn' '^X^V^J' && bindkey -s '^Xt' '^X^V^I' && bindkey -s '^Xr' '^X^V^M' && bindkey '^X^A' __shellspan_native_checkpoint && bindkey '^X^D' __shellspan_discard_native && bindkey '^X^E' __shellspan_accept_native; then
    __shellspan_emit I 1
    __shellspan_emit H 1
    if zmodload zsh/datetime && bindkey '^X^O' __shellspan_private_receive && bindkey '^X^K' __shellspan_private_commit && bindkey '^X^B' __shellspan_native_receive; then
      __shellspan_emit V 1
    else
      __shellspan_emit V 0
    fi
    if [[ -o monitor ]] && zmodload zsh/parameter; then __shellspan_emit K 1; else __shellspan_emit K 0; fi
  else
    __shellspan_emit I 0
    __shellspan_emit H 0
    __shellspan_emit V 0
    __shellspan_emit K 0
  fi
}}
__shellspan_preexec() {{
  local REPLY
  __shellspan_command_active=1
  # Only the native accept widget arms a one-use child marker. A normal Enter
  # on a cancelled, previously typed group gets an inert marker instead.
  if (( ! __shellspan_native_pending )) && __shellspan_job_marker_zsh "$1"; then
    local __shellspan_marker=$REPLY
    if (( ! ${{+functions[$__shellspan_marker]}} && ! ${{+aliases[$__shellspan_marker]}} )); then
      functions[$__shellspan_marker]='if (( ZSH_SUBSHELL )); then exit 2; else return 2; fi'
      __shellspan_blocked_marker=$__shellspan_marker
      __shellspan_blocked_marker_definition=${{functions[$__shellspan_marker]}}
    fi
  fi
  if (( __shellspan_native_pending )); then
    __shellspan_emit S "$__shellspan_native_line" "$PWD"
    __shellspan_native_pending=0
    __shellspan_native_line=
  else
    __shellspan_emit S "$1" "$PWD"
  fi
}}
__shellspan_accept_native() {{
  local REPLY
  local -a __shellspan_parse_options
  local __shellspan_option __shellspan_parse_diagnostic
  for __shellspan_option in ${{(k)options}}; do
    case "$__shellspan_option" in
      rcs|globalrcs|interactive|login|privileged|exec|zle|monitor|restricted|shinstdin|singlecommand) continue ;;
    esac
    if [[ $options[$__shellspan_option] == on ]]; then
      __shellspan_parse_options+=(-o "$__shellspan_option")
    else
      __shellspan_parse_options+=(+o "$__shellspan_option")
    fi
  done
  if ! {{ __shellspan_parse_diagnostic=$("$__shellspan_parser_executable" -f "${{__shellspan_parse_options[@]}}" -n -c "$BUFFER" 2>&1) && [[ -z "$__shellspan_parse_diagnostic" ]]; }}; then
    [[ -z "$__shellspan_parse_diagnostic" ]] || builtin printf '%s\n' "$__shellspan_parse_diagnostic"
    __shellspan_emit J "$BUFFER" TERMINAL_INPUT_UNSUPPORTED
    BUFFER=
    zle send-break
    return
  fi
  if __shellspan_job_marker_zsh "$BUFFER"; then
    local __shellspan_marker=$REPLY
    local __shellspan_prefix="( $__shellspan_marker;"$'\n'
    local __shellspan_suffix=$'\n) &'
    local __shellspan_original=${{BUFFER#"$__shellspan_prefix"}}
    __shellspan_original=${{__shellspan_original%"$__shellspan_suffix"}}
    # Removing the fixed, broker-built envelope is framing, not source parsing.
    # The original source must also be valid on its own: an unmatched closing
    # group could otherwise balance our envelope and escape the native child.
    if [[ "$BUFFER" != "$__shellspan_prefix"*"$__shellspan_suffix" ]] || ! {{ __shellspan_parse_diagnostic=$("$__shellspan_parser_executable" -f "${{__shellspan_parse_options[@]}}" -n -c "$__shellspan_original" 2>&1) && [[ -z "$__shellspan_parse_diagnostic" ]]; }}; then
      [[ -z "$__shellspan_parse_diagnostic" ]] || builtin printf '%s\n' "$__shellspan_parse_diagnostic"
      __shellspan_emit J "$BUFFER" TERMINAL_INPUT_UNSUPPORTED
      BUFFER=
      zle send-break
      return
    fi
    if ! __shellspan_job_context_zsh; then
      __shellspan_emit J "$BUFFER" TERMINAL_BACKGROUND_UNSUPPORTED
      BUFFER=
      zle send-break
      return
    fi
    if ! __shellspan_job_arm_zsh "$__shellspan_marker"; then
      __shellspan_emit J "$BUFFER" TERMINAL_INPUT_UNSUPPORTED
      zle send-break
      return
    fi
  fi
  __shellspan_native_line=$BUFFER
  __shellspan_native_pending=1
  local __shellspan_redraw=${{__shellspan_native_redraw_before_accept:-0}}
  __shellspan_native_redraw_before_accept=0
  # The receiver has already displayed the source. Only protect output from
  # other controlled jobs that were live during this edit; invalidating every
  # accepted buffer would leave a second complete source copy in scrollback.
  if (( __shellspan_redraw )); then zle -I; fi
  zle accept-line
}}
__shellspan_native_checkpoint() {{
  __shellspan_emit A "$BUFFER"
}}
zle -N __shellspan_native_checkpoint
__shellspan_native_frame_checkpoint() {{
  __shellspan_emit M "$1" "$BUFFER"
}}
__shellspan_native_receive() {{
  local __shellspan_receiver_tty __shellspan_receiver_fd __shellspan_completed_descriptor=
  __shellspan_receiver_tty=$("$__shellspan_stty_executable" -g </dev/tty 2>/dev/null) || return
  "$__shellspan_stty_executable" -echo </dev/tty 2>/dev/null || return
  {{
    builtin exec {{__shellspan_receiver_fd}}</dev/tty || return
    __shellspan_native_receive_frame
  }} always {{
    if [[ -n ${{__shellspan_receiver_fd-}} ]]; then builtin exec {{__shellspan_receiver_fd}}<&-; fi
    "$__shellspan_stty_executable" "$__shellspan_receiver_tty" </dev/tty 2>/dev/null
  }}
  # External stty temporarily leaves ZLE's input mode. Publish readiness only
  # after it returns, so the next discard key cannot be consumed as tty EOF.
  if [[ -n $__shellspan_completed_descriptor ]]; then
    __shellspan_native_frame_checkpoint "$__shellspan_completed_descriptor"
  fi
}}
__shellspan_read_native() {{
  local __shellspan_read_data= __shellspan_read_chunk
  local -i __shellspan_read_total=0 __shellspan_read_count=0
  local -F 6 __shellspan_read_remaining
  while (( __shellspan_read_total < $1 )); do
    __shellspan_read_remaining=$(( $2 - EPOCHREALTIME ))
    (( __shellspan_read_remaining > 0 )) || return 142
    # Transport bytes must bypass ZLE's get-key/typeahead/last-key machinery.
    # sysread is bounded per chunk; the original absolute frame deadline is
    # checked both before and after each read, without replaying any input.
    builtin sysread -i "$__shellspan_receiver_fd" -s "$(( $1 - __shellspan_read_total ))" -t "$__shellspan_read_remaining" -c __shellspan_read_count __shellspan_read_chunk 2>/dev/null || return $?
    (( EPOCHREALTIME < $2 && __shellspan_read_count > 0 )) || return 142
    [[ $__shellspan_read_chunk != *$'\x03'* ]] || return 130
    __shellspan_read_data+=$__shellspan_read_chunk
    (( __shellspan_read_total += __shellspan_read_count ))
  done
  builtin printf -v "$3" '%s' "$__shellspan_read_data"
}}
__shellspan_quarantine_native() {{
  __shellspan_native_quarantined=1
  trap '' INT
  local __shellspan_discard
  while read -r -s -k 1 __shellspan_discard; do :; done
  return 130
}}
__shellspan_native_receive_frame() {{
  __shellspan_native_redraw_before_accept=0
  local __shellspan_slot
  if zmodload zsh/parameter; then
    for __shellspan_slot in "${{(@k)jobstates}}"; do
      if [[ ${{jobtexts[$__shellspan_slot]}} == "( job-"* ]]; then
        case ${{jobstates[$__shellspan_slot]}} in
          running:*|suspended:*) __shellspan_native_redraw_before_accept=1; break ;;
        esac
      fi
    done
  fi
  __shellspan_emit A "$BUFFER"
  [[ -z "$BUFFER" ]] || return
  local __shellspan_descriptor __shellspan_encoded __shellspan_decoded __shellspan_count
  local -F 6 __shellspan_deadline=$(( EPOCHREALTIME + 2.0 )) __shellspan_remaining
  if ! __shellspan_read_native 65 "$__shellspan_deadline" __shellspan_descriptor; then
    __shellspan_native_frame_checkpoint ''
    __shellspan_quarantine_native
    return
  fi
  if [[ ${{#__shellspan_descriptor}} != 65 || ${{__shellspan_descriptor[1]}} != e || ${{__shellspan_descriptor[2,-1]}} == *[!0-9a-f]* ]]; then
    __shellspan_native_frame_checkpoint ''
    __shellspan_quarantine_native
    return
  fi
  __shellspan_count=$((16#${{__shellspan_descriptor[2,5]}}))
  __shellspan_remaining=$(( __shellspan_deadline - EPOCHREALTIME ))
  if (( __shellspan_count < 4 || __shellspan_count > 36864 || __shellspan_count % 4 || __shellspan_remaining <= 0 )) || ! __shellspan_read_native "$__shellspan_count" "$__shellspan_deadline" __shellspan_encoded; then
    __shellspan_native_frame_checkpoint "$__shellspan_descriptor"
    __shellspan_quarantine_native
    return
  fi
  builtin printf -v __shellspan_decoded '%b' "$__shellspan_encoded"
  # Native invalidation preserves asynchronous output before the one native
  # buffer replacement. No source is accepted or evaluated by this widget.
  zle -I
  BUFFER=$__shellspan_decoded
  CURSOR=${{#BUFFER}}
  __shellspan_completed_descriptor=$__shellspan_descriptor
}}
zle -N __shellspan_native_receive
__shellspan_private_receive() {{
  __shellspan_private_descriptor=
  [[ -z "$BUFFER" ]] || {{ __shellspan_emit M '' "$BUFFER"; return; }}
  __shellspan_emit A "$BUFFER"
  local __shellspan_byte __shellspan_data= __shellspan_index
  local -F 6 __shellspan_deadline=$(( EPOCHREALTIME + 2.0 )) __shellspan_remaining
  for __shellspan_index in {{1..65}}; do
    __shellspan_remaining=$(( __shellspan_deadline - EPOCHREALTIME ))
    if (( __shellspan_remaining <= 0 )) || ! read -r -s -k 1 -t "$__shellspan_remaining" __shellspan_byte || [[ $__shellspan_byte == $'\x03' ]]; then
      __shellspan_emit M '' "$BUFFER"
      return
    fi
    __shellspan_data+=$__shellspan_byte
  done
  if [[ -z "$BUFFER" && ${{__shellspan_data[1]}} == [ps] && ${{__shellspan_data[2,-1]}} != *[!0-9a-f]* ]]; then
    __shellspan_private_descriptor=$__shellspan_data
  fi
  __shellspan_emit M "$__shellspan_private_descriptor" "$BUFFER"
}}
zle -N __shellspan_private_receive
__shellspan_private_commit() {{
  local __shellspan_descriptor=$__shellspan_private_descriptor
  # Consume before any action: no later Enter/widget can repeat this request.
  __shellspan_private_descriptor=
  [[ -z "$BUFFER" && ${{#__shellspan_descriptor}} == 65 ]] || return
  local __shellspan_handle="job-${{__shellspan_descriptor[2,33]}}"
  local __shellspan_action=poll __shellspan_status
  [[ ${{__shellspan_descriptor[1]}} == s ]] && __shellspan_action=stop
  __shellspan_emit S "__shellspan_job_control $__shellspan_handle $__shellspan_action" "$PWD"
  __shellspan_command_active=1
  if __shellspan_job_control "$__shellspan_handle" "$__shellspan_action"; then
    __shellspan_status=0
  else
    __shellspan_status=$?
  fi
  __shellspan_emit E "$__shellspan_status" "$PWD"
  __shellspan_command_active=0
  __shellspan_emit P "$PWD"
  __shellspan_publish_native_capabilities
  __shellspan_emit Q
}}
zle -N __shellspan_private_commit
__shellspan_private_line_finish() {{ __shellspan_private_descriptor=; }}
autoload -Uz add-zle-hook-widget
add-zle-hook-widget line-finish __shellspan_private_line_finish
__shellspan_discard_native() {{
  __shellspan_private_descriptor=
  __shellspan_native_redraw_before_accept=0
  __shellspan_job_release_marker_zsh
  BUFFER=
  CURSOR=0
  __shellspan_native_line=
  __shellspan_native_pending=0
  (( __shellspan_clear_sequence += 1 ))
  __shellspan_emit L "$__shellspan_clear_sequence" "$BUFFER"
  zle reset-prompt
}}
zle -N __shellspan_discard_native
__shellspan_validate_native() {{
  local -a __shellspan_parse_options
  local __shellspan_option __shellspan_parse_diagnostic
  for __shellspan_option in ${{(k)options}}; do
    case "$__shellspan_option" in
      rcs|globalrcs|interactive|login|privileged|exec|zle|monitor|restricted|shinstdin|singlecommand) continue ;;
    esac
    if [[ $options[$__shellspan_option] == on ]]; then
      __shellspan_parse_options+=(-o "$__shellspan_option")
    else
      __shellspan_parse_options+=(+o "$__shellspan_option")
    fi
  done
  if __shellspan_parse_diagnostic=$("$__shellspan_parser_executable" -f "${{__shellspan_parse_options[@]}}" -n -c "$1" 2>&1) && [[ -z "$__shellspan_parse_diagnostic" ]]; then
    typeset -g __shellspan_native_source=$1
    return 0
  fi
  [[ -z "$__shellspan_parse_diagnostic" ]] || builtin printf '%s\n' "$__shellspan_parse_diagnostic"
  __shellspan_emit J "$1" TERMINAL_INPUT_UNSUPPORTED
  return 2
}}
{job_helpers}
zle -N __shellspan_accept_native
__shellspan_chpwd() {{
  __shellspan_emit D "$PWD"
}}
autoload -Uz add-zsh-hook
add-zsh-hook precmd __shellspan_precmd
add-zsh-hook preexec __shellspan_preexec
add-zsh-hook chpwd __shellspan_chpwd
{prompt_end_hook}
# System zshrc may derive HISTFILE from our temporary ZDOTDIR. Keep history
# in the user's home when that default would outlive the control directory.
# Preserve all explicitly configured history paths outside the bootstrap root.
if [[ ${{HISTFILE-}} == "${{__shellspan_control_path:h}}/.zsh_history" ]]; then
  HISTFILE="$HOME/.zsh_history"
fi
unset ZDOTDIR
__shellspan_emit R zsh
"#
    )
}

pub(crate) fn remote_posix_bootstrap(
    shell: TerminalShellKind,
    fifo_path: &str,
    home_directory: &str,
    shell_executable: &str,
) -> Result<String, String> {
    let path = Path::new(fifo_path);
    match shell {
        TerminalShellKind::Bash => Ok(format!(
            "HOME={}\nexport HOME\n{}",
            quote_posix(home_directory),
            bash_bootstrap(path, false, true)
        )),
        TerminalShellKind::Zsh => Ok(zsh_bootstrap(path, true, true, Some(shell_executable))),
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
fn powershell_history_redirect(path: &Path) -> String {
    let literal = crate::portable_local_path(path).replace('\'', "''");
    format!("Import-Module PSReadLine -ErrorAction Stop\nSet-PSReadLineOption -HistorySavePath '{literal}' -ErrorAction Stop")
}

#[cfg(any(windows, test))]
fn powershell_bootstrap(pipe_name: &str, shell: TerminalShellKind) -> String {
    let shell_name = shell.protocol_name();
    let job_helpers = include_str!("terminal_jobs.ps1");
    let job_host = include_str!("terminal_job_host.cs");
    let console_signals = include_str!("terminal_console_signals.cs");
    let native_job_rollout = if cfg!(windows)
        && match std::env::var("SHELLSPAN_NATIVE_POWERSHELL_JOBS") {
            Ok(value) => value == "1",
            Err(std::env::VarError::NotPresent) => true,
            Err(_) => false,
        } {
        "$true"
    } else {
        "$false"
    };
    format!(
        r#"$__shellspanModule = New-Module -Name ShellSpanTerminalIntegration -ArgumentList '{pipe_name}','{shell_name}' -ScriptBlock {{
  param([string]$PipeName, [string]$ShellKind)
  $script:Pipe = [System.IO.Pipes.NamedPipeServerStream]::new($PipeName,[System.IO.Pipes.PipeDirection]::Out,1,[System.IO.Pipes.PipeTransmissionMode]::Byte,[System.IO.Pipes.PipeOptions]::None,0,4096)
  $script:Pipe.WaitForConnection()
  $script:Utf8 = [System.Text.UTF8Encoding]::new($false,$true)
  $script:ConsoleSignalSource = @'
{console_signals}
'@
  $script:ConsoleSignalReady = $false
  try {{
    if ($null -eq ('ShellSpanConsoleSignals' -as [type])) {{ Microsoft.PowerShell.Utility\Add-Type -TypeDefinition $script:ConsoleSignalSource -ErrorAction Stop }}
    [ShellSpanConsoleSignals]::SetIgnore($false)
    $script:ConsoleSignalReady = $true
  }} catch {{ }}
  $script:CommandActive = $false
  $script:InstallHistoryOnPrompt = $false
  Set-Variable -Scope Script -Name NativeJobRollout -Option ReadOnly -Value {native_job_rollout}
  function Send-ShellSpanControl {{
    param([string[]]$Fields)
    foreach ($Field in $Fields) {{
      $Bytes = $script:Utf8.GetBytes($Field)
      $script:Pipe.Write($Bytes,0,$Bytes.Length)
      $script:Pipe.WriteByte(0)
    }}
    $script:Pipe.Flush()
    if ($Fields[0] -ceq 'S') {{ [Console]::Write("$([char]27)]133;C$([char]7)") }}
    if ($Fields[0] -ceq 'P') {{ [Console]::Write("$([char]27)]133;A$([char]7)") }}
  }}
  $script:OriginalPrompt = (Get-Command prompt -CommandType Function).ScriptBlock
  $script:NativePromptRedraw = $false
  $script:NativeEditorTransaction = $false
  function Sync-ShellSpanNativeEditor {{
    if (-not $script:NativeEditorTransaction -or $script:NativeShellJobs.Count -eq 0) {{ return }}
    $Before=$null; $BeforeCursor=0
    [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$Before,[ref]$BeforeCursor)
    # Reanchor the actual PSReadLine editor after asynchronous console writes.
    # Public InvokePrompt redraws its own BUFFER, never tool-result output.
    if ([Console]::CursorLeft -gt 0) {{ [Console]::WriteLine() }}
    $PreviousRedraw=$script:NativePromptRedraw
    $script:NativePromptRedraw = $true
    try {{ [Microsoft.PowerShell.PSConsoleReadLine]::InvokePrompt($null,[int][Console]::CursorTop) }}
    finally {{ $script:NativePromptRedraw = $PreviousRedraw }}
    $After=$null; $AfterCursor=0
    [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$After,[ref]$AfterCursor)
    if ($Before -cne $After -or $BeforeCursor -ne $AfterCursor) {{ throw 'TERMINAL_INPUT_RECOVERY_REQUIRED: native redraw changed the editor' }}
  }}
  function Invoke-ShellSpanPrompt {{
    param([bool]$PreviousSuccess)
    if ($script:NativePromptRedraw) {{ return & $script:OriginalPrompt }}
    # PSReadLine's public ClearScreen/InvokePrompt redraws the existing editor;
    # it does not finish a command or enter a new host prompt. Identify that
    # public call by method identity, without inspecting private editor state.
    $EditorType='Microsoft.PowerShell.PSConsoleReadLine' -as [type]
    if ($script:ConsoleSignalReady -and $null -ne $EditorType -and $ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage') {{
      foreach ($Frame in [Diagnostics.StackTrace]::new().GetFrames()) {{
        $Method=$Frame.GetMethod()
        if ($null -ne $Method -and $Method.IsPublic -and $Method.IsStatic -and $Method.DeclaringType -eq $EditorType -and $Method.Name -ceq 'InvokePrompt') {{
          return & $script:OriginalPrompt
        }}
      }}
    }}
    $script:NativeEditorTransaction = $false
    $script:PrivateDescriptor=$null
    Remove-ShellSpanNativeMarker
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
    $NativeReady = $script:ConsoleSignalReady -and (Install-ShellSpanNativeInput)
    Send-ShellSpanControl @('I',$(if ($NativeReady) {{ '1' }} else {{ '0' }}))
    Send-ShellSpanControl @('H',$(if ($NativeReady) {{ '1' }} else {{ '0' }}))
    Send-ShellSpanControl @('V',$(if ($NativeReady) {{ '1' }} else {{ '0' }}))
    Send-ShellSpanControl @('K',$(if ($NativeReady -and (Test-ShellSpanNativeJobs)) {{ '1' }} else {{ '0' }}))
    Send-ShellSpanControl @('Q')
    return $Rendered
  }}
  function Add-ShellSpanNativeEditorData {{
    param([int]$Position,[string]$Payload)
    $PreviousRedraw=$script:NativePromptRedraw
    $script:NativePromptRedraw=$true
    try {{ [Microsoft.PowerShell.PSConsoleReadLine]::Replace($Position,0,$Payload) }}
    finally {{ $script:NativePromptRedraw=$PreviousRedraw }}
  }}
  function Start-ShellSpanCommand {{
    param([string]$Line)
    if (-not $script:CommandActive) {{
      $script:CommandActive = $true
      Send-ShellSpanControl @('S',$Line,(Get-Location).ProviderPath)
    }}
    if ($null -ne $script:OriginalHistoryHandler) {{
      return $script:OriginalHistoryHandler.Invoke($Line)
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
    $PreviousRedraw=$script:NativePromptRedraw
    $script:NativePromptRedraw=$true
    try {{
      if ($script:OriginalEnterFunction -eq 'ValidateAndAcceptLine') {{
        [Microsoft.PowerShell.PSConsoleReadLine]::ValidateAndAcceptLine($Key,$Arg)
      }} else {{
        [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine($Key,$Arg)
      }}
    }} finally {{ $script:NativePromptRedraw=$PreviousRedraw }}
  }}
  function Invoke-ShellSpanNativeSubmit {{
    param($Key, $Arg)
    Sync-ShellSpanNativeEditor
    $Line = $null
    $Cursor = 0
    [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$Line,[ref]$Cursor)
    $Tokens = $null
    $ParseErrors = $null
    $Ast = [System.Management.Automation.Language.Parser]::ParseInput($Line,[ref]$Tokens,[ref]$ParseErrors)
    $Background = $Ast.Find({{ param($Node) $Node -is [System.Management.Automation.Language.PipelineAst] -and $Node.PSObject.Properties['Background'] -and $Node.Background }},$true)
    if ($ParseErrors.Count -gt 0 -or $null -ne $Background -or -not (Install-ShellSpanNativeMarker $Line $Ast)) {{
      $Reason = if ($null -ne $Background) {{ 'TERMINAL_BACKGROUND_UNSUPPORTED' }} else {{ 'TERMINAL_INPUT_UNSUPPORTED' }}
      $PreviousRedraw=$script:NativePromptRedraw
      $script:NativePromptRedraw=$true
      try {{ [Microsoft.PowerShell.PSConsoleReadLine]::CancelLine($Key,$Arg) }}
      finally {{ $script:NativePromptRedraw=$PreviousRedraw }}
      Send-ShellSpanControl @('J',$Line,$Reason)
      return
    }}
    $script:CommandActive = $true
    Send-ShellSpanControl @('S',$Line,(Get-Location).ProviderPath)
    $PreviousRedraw=$script:NativePromptRedraw
    $script:NativePromptRedraw=$true
    try {{ [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine($Key,$Arg) }}
    finally {{ $script:NativePromptRedraw=$PreviousRedraw }}
  }}
  function Install-ShellSpanNativeInput {{
    try {{
      $EditorOptions=PSReadLine\Get-PSReadLineOption
      if ($EditorOptions.GetType().Assembly -ne [Microsoft.PowerShell.PSConsoleReadLine].Assembly) {{ return $false }}
      if ($script:ShellKind -eq 'windowsPowerShell' -and (Microsoft.PowerShell.Core\Get-Module -Name PSReadLine).Version -lt [version]'2.4.5') {{ return $false }}
      if ($null -eq [ShellSpanConsoleSignals].GetMethod('ReadEditorData')) {{ throw 'Native editor data receiver unavailable' }}
      $null = Set-PSReadLineKeyHandler -ErrorAction Stop -Chord 'Ctrl+x,n' -ScriptBlock {{ [Microsoft.PowerShell.PSConsoleReadLine]::Insert("`n") }}
      $null = Set-PSReadLineKeyHandler -ErrorAction Stop -Chord 'Ctrl+x,t' -ScriptBlock {{ [Microsoft.PowerShell.PSConsoleReadLine]::Insert("`t") }}
      $null = Set-PSReadLineKeyHandler -ErrorAction Stop -Chord 'Ctrl+x,r' -ScriptBlock {{ [Microsoft.PowerShell.PSConsoleReadLine]::Insert("`r") }}
      $null = Set-PSReadLineKeyHandler -ErrorAction Stop -Chord 'Ctrl+x,Ctrl+a' -ScriptBlock {{
        $Line=$null; $Cursor=0
        [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$Line,[ref]$Cursor)
        if ([string]::IsNullOrEmpty($Line)) {{
          & $__shellspanModule {{ $script:NativeEditorTransaction = $true }}
        }}
        [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$Line,[ref]$Cursor)
        & $__shellspanModule {{ param($Buffer) Send-ShellSpanControl @('A',$Buffer) }} $Line
      }}
      $null = Set-PSReadLineKeyHandler -ErrorAction Stop -Chord 'Ctrl+x,Ctrl+b' -ScriptBlock {{
        if (-not (& $__shellspanModule {{ $script:NativeEditorTransaction }})) {{ throw 'Native editor transaction unavailable' }}
        $Line=$null; $Cursor=0
        [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$Line,[ref]$Cursor)
        $PreviousControlCAsInput=[Console]::TreatControlCAsInput
        [Console]::TreatControlCAsInput=$true
        try {{
          & $__shellspanModule {{ param($Buffer) Send-ShellSpanControl @('A',$Buffer) }} $Line
          $Data=[ShellSpanConsoleSignals]::ReadEditorData()
        }}
        catch {{
          & $__shellspanModule {{
            $PreviousRedraw=$script:NativePromptRedraw
            $script:NativePromptRedraw=$true
            try {{ [Microsoft.PowerShell.PSConsoleReadLine]::CancelLine() }}
            finally {{ $script:NativePromptRedraw=$PreviousRedraw }}
          }}
          [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$Line,[ref]$Cursor)
          & $__shellspanModule {{ param($Buffer) Send-ShellSpanControl @('A',$Buffer) }} $Line
          return
        }}
        finally {{ [Console]::TreatControlCAsInput=$PreviousControlCAsInput }}
        & $__shellspanModule {{ Sync-ShellSpanNativeEditor }}
        # Insert(string) in PSReadLine 2.4 normalizes CRLF. Replace is the
        # public native insertion API that preserves the approved bytes.
        & $__shellspanModule {{ param($Position,[string]$Payload) Add-ShellSpanNativeEditorData $Position $Payload }} $Cursor $Data
        [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$Line,[ref]$Cursor)
        & $__shellspanModule {{ param($Buffer) Send-ShellSpanControl @('A',$Buffer) }} $Line
      }}
      # A late data fence is inert even if its receiver has already aborted.
      # No encoded batch ever carries an Enter or an accept-line chord.
      $null = Set-PSReadLineKeyHandler -ErrorAction Stop -Chord 'Ctrl+x,Ctrl+f' -ScriptBlock {{ }}
      $null = Set-PSReadLineKeyHandler -ErrorAction Stop -Chord 'Ctrl+x,Ctrl+r' -ScriptBlock {{ & $__shellspanModule {{ Receive-ShellSpanPrivateControl }} }}
      $null = Set-PSReadLineKeyHandler -ErrorAction Stop -Chord 'Ctrl+x,Ctrl+k' -ScriptBlock {{ & $__shellspanModule {{ Complete-ShellSpanPrivateControl }} }}
      $null = Set-PSReadLineKeyHandler -ErrorAction Stop -Chord 'Ctrl+x,Ctrl+e' -ScriptBlock {{
        param($Key,$Arg)
        & $__shellspanModule {{ param($PressedKey,$Argument) Invoke-ShellSpanNativeSubmit $PressedKey $Argument }} $Key $Arg
      }}
      return $true
    }} catch {{
      return $false
    }}
  }}
  $script:NativeJobHostSource = @'
{job_host}
'@
{job_helpers}
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
            "L" => event_from_fields(&[
                kind.clone(),
                required_field(reader, "native clear sequence")?,
                required_field(reader, "native cleared buffer")?,
            ])?
            .ok_or("TERMINAL_NATIVE_CLEAR_INVALID_SEQUENCE")?,
            "H" => event_from_fields(&[
                kind.clone(),
                required_field(reader, "native checkpoint mode")?,
            ])?
            .ok_or("TERMINAL_NATIVE_CHECKPOINT_INVALID_MODE")?,
            "A" => TerminalIntegrationControlEvent::NativeCheckpoint {
                buffer: required_field(reader, "native checkpoint buffer")?,
            },
            "V" => event_from_fields(&[
                kind.clone(),
                required_field(reader, "private control mode")?,
            ])?
            .ok_or("TERMINAL_PRIVATE_CONTROL_EMPTY_EVENT")?,
            "W" => TerminalIntegrationControlEvent::NativePrivateReady,
            "M" => TerminalIntegrationControlEvent::NativePrivateCheckpoint {
                descriptor: required_field(reader, "private descriptor")?,
                buffer: required_field(reader, "private descriptor buffer")?,
            },
            "K" => event_from_fields(&[kind.clone(), required_field(reader, "native job mode")?])?
                .ok_or("TERMINAL_JOB_EMPTY_EVENT")?,
            "B" | "F" => {
                let mut fields = vec![
                    kind.clone(),
                    required_field(reader, "job handle")?,
                    required_field(reader, "job state/status")?,
                ];
                if kind == "B" {
                    fields.push(required_field(reader, "job reserved")?);
                }
                event_from_fields(&fields)?.ok_or("TERMINAL_JOB_EMPTY_EVENT")?
            }
            "R" => TerminalIntegrationControlEvent::Ready {
                shell: parse_shell(&required_field(reader, "ready shell")?)?,
            },
            "P" => TerminalIntegrationControlEvent::PromptStart {
                cwd: required_field(reader, "prompt cwd")?,
            },
            "Q" => TerminalIntegrationControlEvent::PromptEnd,
            "U" => TerminalIntegrationControlEvent::InterruptUncertain,
            "I" => TerminalIntegrationControlEvent::NativeInput {
                enabled: match required_field(reader, "native input mode")?.as_str() {
                    "1" => true,
                    "0" => false,
                    _ => return Err("TERMINAL_INTEGRATION_INVALID_INPUT_MODE".into()),
                },
            },
            "C" => TerminalIntegrationControlEvent::NativeComments {
                enabled: match required_field(reader, "native comment mode")?.as_str() {
                    "1" => true,
                    "0" => false,
                    _ => return Err("TERMINAL_INTEGRATION_INVALID_INPUT_MODE".into()),
                },
            },
            "S" => TerminalIntegrationControlEvent::CommandStart {
                command_line: required_field(reader, "command line")?,
                cwd: required_field(reader, "command cwd")?,
            },
            "J" => TerminalIntegrationControlEvent::InputRejected {
                command_line: required_field(reader, "rejected command")?,
                reason: required_field(reader, "rejection reason")?,
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

    #[cfg(unix)]
    mod command_presentation {
        include!("tests/terminal_command_presentation.rs");
    }

    #[cfg(unix)]
    mod late_native_frame {
        include!("tests/terminal_late_native_frame.rs");
    }

    #[cfg(target_os = "macos")]
    mod zsh_receive_pressure {
        include!("tests/terminal_zsh_receive_pressure.rs");
    }
}
