//! The existing user's ConsoleHost/ConPTY, with an ACL-bound duplex NIP pipe.
//! Preparation and the bounded pipe worker run off the Tauri main thread.
use super::{
    editors, protocol as nip,
    registration::{file_sha, VerifiedNativeProfile},
};
use crate::terminal_integration::TerminalShellKind;
use std::{
    fs::{self, File},
    io::{Read, Write},
    os::windows::io::AsRawHandle,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use windows_sys::Win32::System::Pipes::{
    GetNamedPipeServerProcessId, PeekNamedPipe, SetNamedPipeHandleState, PIPE_NOWAIT,
    PIPE_READMODE_BYTE,
};
fn module_search_path(path: &Path) -> PathBuf {
    PathBuf::from(crate::path_utils::portable_local_path(path).replace('/', "\\"))
}

#[cfg(test)]
mod path_tests {
    use super::*;

    #[test]
    fn powershell_home_detection_receives_native_module_path_spelling() {
        assert_eq!(
            module_search_path(Path::new("D:/Programs/PowerShell/7/Modules")),
            PathBuf::from(r"D:\Programs\PowerShell\7\Modules")
        );
        assert_eq!(
            module_search_path(Path::new(r"\\?\D:\private\PSReadLine")),
            PathBuf::from(r"D:\private\PSReadLine")
        );
    }

    #[test]
    #[ignore = "requires sealed validation resources and an explicitly selected real Windows host"]
    fn resource_admission_uses_actual_windows_artifacts_before_host_creation() {
        assert_eq!(
            std::env::var("SHELLSPAN_ALLOW_FOREGROUND_TESTS").as_deref(),
            Ok("1")
        );
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let owned = source.join(".artifacts/tests").canonicalize().unwrap();
        let resources = editors::validation_resource_root().unwrap().unwrap();
        assert!(resources.starts_with(&owned));
        let evidence = PathBuf::from(std::env::var_os("SHELLSPAN_ADMISSION_EVIDENCE").unwrap());
        assert!(evidence.is_absolute());
        assert!(evidence.components().all(|part| !matches!(
            part,
            std::path::Component::ParentDir | std::path::Component::CurDir
        )));
        assert!(evidence
            .parent()
            .unwrap()
            .canonicalize()
            .unwrap()
            .starts_with(&owned));
        assert!(evidence.file_name().is_some());
        match fs::symlink_metadata(&evidence) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            _ => panic!("Admission evidence must be a fresh owned directory"),
        }
        fs::create_dir(&evidence).unwrap();
        let host = std::env::var("SHELLSPAN_ADMISSION_HOST").unwrap();
        let (shell, mut kind) = match host.as_str() {
            "powerShell7" => (
                PathBuf::from("D:/Programs/PowerShell/7/pwsh.exe"),
                TerminalShellKind::PowerShell7,
            ),
            "windowsPowerShell" => (
                PathBuf::from(std::env::var_os("SystemRoot").unwrap())
                    .join("System32/WindowsPowerShell/v1.0/powershell.exe"),
                TerminalShellKind::WindowsPowerShell,
            ),
            _ => panic!("Unknown actual admission host"),
        };
        let scenario = std::env::var("SHELLSPAN_ADMISSION_SCENARIO").unwrap();
        let expected_error = match scenario.as_str() {
            "baseline" => None,
            "unknown-source" => Some("TERMINAL_NATIVE_STALE_ARTIFACTS"),
            "unknown-adapter" | "unknown-profile" | "bad-digest" => {
                Some("TERMINAL_NATIVE_PROFILE_ARTIFACT_MISMATCH")
            }
            "wrong-platform" => Some("TERMINAL_NATIVE_MANIFEST_INVALID"),
            "wrong-kind" => {
                kind = if host == "powerShell7" {
                    TerminalShellKind::WindowsPowerShell
                } else {
                    TerminalShellKind::PowerShell7
                };
                Some("TERMINAL_NATIVE_PROFILE_ARTIFACT_MISMATCH")
            }
            _ => panic!("Unknown admission scenario"),
        };
        let data = evidence.join("data");
        let outcome = PreparedNativePowerShell::prepare(&shell, &resources, &data, kind);
        let (prepared, actual_error) = match outcome {
            Ok(value) => {
                drop(value);
                (true, None)
            }
            Err(error) => (false, Some(error)),
        };
        let remaining_startups = match fs::read_dir(data.join("tmp")) {
            Ok(entries) => entries
                .map(|entry| entry.unwrap())
                .filter(|entry| {
                    entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with("shellspan-nip-")
                })
                .count(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
            Err(_) => panic!("Owned startup directory could not be inspected"),
        };
        fs::write(evidence.join("result.json"),serde_json::to_vec_pretty(&serde_json::json!({
            "host":host,"scenario":scenario,"prepared":prepared,"expectedError":expected_error,"actualError":actual_error,
            "remainingStartupDirectories":remaining_startups,"sourceOperationsRequested":0,
            "scope":"Actual production PreparedNativePowerShell preparation and filesystem verification only;no host/PTY/App/model launch or native capability receipt."
        })).unwrap()).unwrap();
        assert_eq!(actual_error.as_deref(), expected_error);
        assert_eq!(prepared, expected_error.is_none());
        assert_eq!(remaining_startups, 0);
    }
}
pub(crate) struct PreparedNativePowerShell {
    root: tempfile::TempDir,
    bootstrap: PathBuf,
    pipe_path: String,
    modules: Option<PathBuf>,
    host_modules: PathBuf,
    pub profile: VerifiedNativeProfile,
    server_process_id: Option<u32>,
    conpty: PathBuf,
}
impl PreparedNativePowerShell {
    pub fn prepare(
        shell: &Path,
        resources: &Path,
        data: &Path,
        kind: TerminalShellKind,
    ) -> Result<Self, String> {
        if !cfg!(target_arch = "x86_64") {
            return Err("TERMINAL_NATIVE_PROFILE_UNSUPPORTED".into());
        }
        let digest = file_sha(shell)?;
        let artifact = editors::read_catalogue(resources, "windows-x64")?
            .into_iter()
            .find(|p| p.shell_sha256 == digest)
            .ok_or("TERMINAL_NATIVE_PROFILE_UNSUPPORTED")?;
        let editor_sha = artifact
            .editor_sha256
            .as_ref()
            .filter(|v| v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit()))
            .ok_or("TERMINAL_NATIVE_MANIFEST_INVALID")?;
        let expected_shell = match kind {
            TerminalShellKind::WindowsPowerShell => nip::ShellFamily::WindowsPowerShell,
            TerminalShellKind::PowerShell7 => nip::ShellFamily::PowerShell7,
            _ => return Err("TERMINAL_NATIVE_PROFILE_UNSUPPORTED".into()),
        };
        if artifact.profile.shell != expected_shell {
            return Err("TERMINAL_NATIVE_PROFILE_ARTIFACT_MISMATCH".into());
        }
        let modules = Some(
            crate::terminal_integration::prepare_bundled_powershell_module_for_host(
                data,
                kind == TerminalShellKind::WindowsPowerShell,
            )?,
        );
        let conpty = super::windows_conpty::prepare(data)?;
        let host_modules = module_search_path(
            &shell
                .parent()
                .ok_or("TERMINAL_NATIVE_PATH_INVALID")?
                .join("Modules"),
        );
        let temporary = data.join("tmp");
        fs::create_dir_all(&temporary).map_err(|_| "TERMINAL_NATIVE_STARTUP_UNAVAILABLE")?;
        let root = tempfile::Builder::new()
            .prefix("shellspan-nip-")
            .tempdir_in(&temporary)
            .map_err(|_| "TERMINAL_NATIVE_STARTUP_UNAVAILABLE")?;
        let library = root.path().join("shellspan_native_input_editors.dll");
        fs::copy(resources.join(&artifact.module), &library)
            .map_err(|_| "TERMINAL_NATIVE_ARTIFACTS_UNAVAILABLE")?;
        let profile = editors::verify(&artifact, shell, &library)?.bind_private_conpty(&conpty)?;
        let transport = root.path().join("transport.cs");
        fs::write(
            &transport,
            concat!(
                include_str!("../../native-input-editors/psreadline.cs"),
                "\n",
                include_str!("../terminal_display_origin_pipe.cs")
            ),
        )
        .map_err(|_| "TERMINAL_NATIVE_STARTUP_UNAVAILABLE")?;
        let provider = root.path().join("provider.ps1");
        fs::write(
            &provider,
            include_str!("../../native-input-editors/psreadline.ps1"),
        )
        .map_err(|_| "TERMINAL_NATIVE_STARTUP_UNAVAILABLE")?;
        let helpers = root.path().join("jobs.ps1");
        fs::write(&helpers, include_str!("../terminal_jobs.ps1"))
            .map_err(|_| "TERMINAL_NATIVE_STARTUP_UNAVAILABLE")?;
        let job_host = root.path().join("job-host.cs");
        fs::write(&job_host, include_str!("../terminal_job_host.cs"))
            .map_err(|_| "TERMINAL_NATIVE_STARTUP_UNAVAILABLE")?;
        let signals = root.path().join("signals.cs");
        fs::write(&signals, include_str!("../terminal_console_signals.cs"))
            .map_err(|_| "TERMINAL_NATIVE_STARTUP_UNAVAILABLE")?;
        let host_reference = root.path().join("host-reference.psm1");
        fs::write(
            &host_reference,
            include_bytes!("../../resources/powershell/PSReadLine/2.4.5/Upstream.PSReadLine.ps1"),
        )
        .map_err(|_| "TERMINAL_NATIVE_STARTUP_UNAVAILABLE")?;
        let name = format!("shellspan-nip-{}", uuid::Uuid::new_v4().simple());
        let quote = |s: &str| format!("'{}'", s.replace('\'', "''"));
        // Canonical Rust paths may carry the Win32 verbatim prefix. Expose the
        // existing local-path representation to PowerShell, whose URL/security
        // classifier does not treat that prefix as an ordinary local drive.
        // The files, hashes, ACLs and execution policy remain unchanged.
        let quote_path = |path: &Path| quote(&crate::path_utils::portable_local_path(path));
        let json = serde_json::to_string(&artifact.profile)
            .map_err(|_| "TERMINAL_NATIVE_MANIFEST_INVALID")?;
        let mut startup = "Import-Module PSReadLine -ErrorAction Stop\n".to_string();
        if let Some(isolated) = crate::path_utils::configured_data_directory() {
            let histories =
                crate::terminal_integration::prepare_isolated_powershell_history_directory(
                    isolated,
                )?;
            startup.push_str(&crate::terminal_integration::powershell_history_redirect(
                isolated,
                &histories.join(format!("{}.txt", kind.protocol_name())),
            ));
        }
        startup.push_str(&format!(". {} -Library {} -PipeName {} -ProfileJson {} -TransportSource ([IO.File]::ReadAllText({})) -ExpectedClientPid {} -ExpectedEditorHash {} -JobHelpersPath {} -JobHostPath {} -ConsoleSignalPath {} -HostReferencePath {}\n",
            quote_path(&provider),quote_path(&library),quote(&name),quote(&json),quote_path(&transport),std::process::id(),quote(editor_sha),quote_path(&helpers),quote_path(&job_host),quote_path(&signals),quote_path(&host_reference)));
        let bootstrap = root.path().join("startup.ps1");
        fs::write(&bootstrap, startup).map_err(|_| "TERMINAL_NATIVE_STARTUP_UNAVAILABLE")?;
        Ok(Self {
            root,
            bootstrap,
            pipe_path: format!(r"\\.\pipe\{name}"),
            modules,
            host_modules,
            profile,
            server_process_id: None,
            conpty,
        })
    }
    pub fn pty_system(&self) -> portable_pty::win::conpty::ConPtySystem {
        portable_pty::win::conpty::ConPtySystem::with_grapheme_host(self.conpty.clone())
    }
    pub fn bind_process(&mut self, pid: Option<u32>) {
        self.server_process_id = pid;
    }
    pub(crate) fn start_display_origin(
        &self,
        app: tauri::AppHandle,
        session_id: String,
        connection: &nip::ConnectionIdentity,
    ) -> Option<crate::terminal_display_origin::windows_pipe::DisplayOriginPipe> {
        if !self.profile.display_origin_channel() {
            return None;
        }
        let pid = self.server_process_id?;
        Some(crate::terminal_display_origin::windows_pipe::start(
            app,
            session_id,
            connection.terminal_session_id.clone(),
            connection.terminal_generation,
            format!("{}-display-origin", self.pipe_path),
            pid,
        ))
    }
    pub fn configure(&self, command: &mut portable_pty::CommandBuilder) -> Result<(), String> {
        if let Some(modules) = &self.modules {
            // PowerShell detects its default module path by string comparison
            // before loading profiles. Mixed separators trigger reordering.
            let mut paths = vec![module_search_path(modules), self.host_modules.clone()];
            if let Some(previous) = command.get_env("PSModulePath") {
                paths.extend(std::env::split_paths(previous));
            }
            if let Some(system) = std::env::var_os("SystemRoot") {
                paths.push(PathBuf::from(system).join("System32/WindowsPowerShell/v1.0/Modules"));
            }
            command.env(
                "PSModulePath",
                std::env::join_paths(paths).map_err(|_| "TERMINAL_NATIVE_PATH_INVALID")?,
            );
        }
        command.args(["-NoExit", "-File"]);
        command.arg(crate::path_utils::portable_local_path(&self.bootstrap));
        Ok(())
    }
    pub fn start(
        self,
        probe: nip::ConnectionEnvelope,
        mut on_message: impl FnMut(nip::Message) -> Result<(), String> + Send + 'static,
        on_closed: impl FnOnce() + Send + 'static,
    ) -> NativeControlHandle {
        let writer = Arc::new(Mutex::new(None));
        let socket = writer.clone();
        let stopped = Arc::new(AtomicBool::new(false));
        let done = stopped.clone();
        let bootstrap = Arc::new(NativeBootstrapLifetime {
            root: Some(self.root),
            host_exited: AtomicBool::new(false),
            host_pid: self.server_process_id,
        });
        let worker_bootstrap = Arc::clone(&bootstrap);
        let worker = thread::spawn(move || {
            let _bootstrap = worker_bootstrap;
            let _result = (|| -> Result<(), String> {
                let deadline = Instant::now() + Duration::from_secs(30);
                let mut file = loop {
                    if done.load(Ordering::Acquire) || Instant::now() >= deadline {
                        return Err("TERMINAL_NATIVE_CONNECT_TIMEOUT".into());
                    }
                    match fs::OpenOptions::new()
                        .read(true)
                        .write(true)
                        .open(&self.pipe_path)
                    {
                        Ok(file) => break file,
                        Err(_) => thread::sleep(Duration::from_millis(5)),
                    }
                };
                let mut server_process_id = 0;
                if unsafe {
                    GetNamedPipeServerProcessId(file.as_raw_handle(), &mut server_process_id)
                } == 0
                    || Some(server_process_id) != self.server_process_id
                {
                    return Err("TERMINAL_NATIVE_PRIVATE_PEER_MISMATCH".into());
                }
                let mode = PIPE_NOWAIT | PIPE_READMODE_BYTE;
                if unsafe {
                    SetNamedPipeHandleState(
                        file.as_raw_handle(),
                        &mode,
                        std::ptr::null(),
                        std::ptr::null(),
                    )
                } == 0
                {
                    return Err("TERMINAL_NATIVE_CONTROL_UNAVAILABLE".into());
                }
                file.write_all(
                    &probe
                        .encode()
                        .map_err(|_| "TERMINAL_NATIVE_PROTOCOL_INVALID")?,
                )
                .map_err(|_| "TERMINAL_NATIVE_CONTROL_UNAVAILABLE")?;
                *writer
                    .lock()
                    .map_err(|_| "TERMINAL_NATIVE_CONTROL_UNAVAILABLE")? = Some(
                    file.try_clone()
                        .map_err(|_| "TERMINAL_NATIVE_CONTROL_UNAVAILABLE")?,
                );
                let mut decoder = nip::Decoder::default();
                let mut bytes = [0; 8192];
                while !done.load(Ordering::Acquire) {
                    let mut available = 0;
                    if unsafe {
                        PeekNamedPipe(
                            file.as_raw_handle(),
                            std::ptr::null_mut(),
                            0,
                            std::ptr::null_mut(),
                            &mut available,
                            std::ptr::null_mut(),
                        )
                    } == 0
                    {
                        decoder
                            .finish()
                            .map_err(|_| "TERMINAL_NATIVE_PARTIAL_FRAME_EOF")?;
                        break;
                    }
                    if available == 0 {
                        thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    let limit = bytes.len().min(available as usize);
                    let count = file
                        .read(&mut bytes[..limit])
                        .map_err(|_| "TERMINAL_NATIVE_CONTROL_UNAVAILABLE")?;
                    if count == 0 {
                        return Err("TERMINAL_NATIVE_CONTROL_CLOSED".into());
                    }
                    for message in decoder
                        .push(&bytes[..count])
                        .map_err(|_| "TERMINAL_NATIVE_PROTOCOL_INVALID")?
                    {
                        on_message(message)?;
                    }
                }
                Ok(())
            })();
            done.store(true, Ordering::Release);
            if let Ok(mut file) = writer.lock() {
                file.take();
            }
            on_closed();
        });
        NativeControlHandle {
            socket,
            stopped,
            worker: Some(worker),
            bootstrap,
        }
    }
}
pub(crate) struct NativeControlHandle {
    socket: Arc<Mutex<Option<File>>>,
    stopped: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
    bootstrap: Arc<NativeBootstrapLifetime>,
}
impl NativeControlHandle {
    pub(crate) fn bootstrap_lifetime(&self) -> Arc<NativeBootstrapLifetime> {
        Arc::clone(&self.bootstrap)
    }
    pub fn write(&self, bytes: &[u8]) -> Result<(), String> {
        if self.stopped.load(Ordering::Acquire) || bytes.len() > nip::MAX_MESSAGE_BYTES {
            return Err("TERMINAL_NATIVE_CONTROL_UNAVAILABLE".into());
        }
        self.socket
            .lock()
            .map_err(|_| "TERMINAL_NATIVE_CONTROL_UNAVAILABLE")?
            .as_mut()
            .ok_or("TERMINAL_NATIVE_CONTROL_UNAVAILABLE")?
            .write_all(bytes)
            .map_err(|_| "TERMINAL_NATIVE_CONTROL_UNAVAILABLE".into())
    }
}

// A private-pipe EOF does not imply that the host unloaded its native DLL.
// Both the control handle and the real child waiter retain this directory.
pub(crate) struct NativeBootstrapLifetime {
    root: Option<tempfile::TempDir>,
    host_exited: AtomicBool,
    host_pid: Option<u32>,
}
impl NativeBootstrapLifetime {
    pub(crate) fn confirm_host_exit(&self) {
        self.host_exited.store(true, Ordering::Release);
    }
}
impl Drop for NativeBootstrapLifetime {
    fn drop(&mut self) {
        let Some(root) = self.root.take() else { return };
        if self.host_exited.load(Ordering::Acquire) {
            if let Err(error) = root.close() {
                log::warn!(
                    "Native PowerShell bootstrap cleanup failed host_pid={:?}: {error}",
                    self.host_pid
                );
            }
        } else {
            // Preserve the entire bootstrap if wait failed or was never observed.
            // An unknown host must not lose files merely because control closed.
            let _ = root.keep();
            log::warn!(
                "Native PowerShell bootstrap retained: host exit unconfirmed host_pid={:?}",
                self.host_pid
            );
        }
    }
}
impl Drop for NativeControlHandle {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

#[cfg(test)]
mod bootstrap_lifetime_tests {
    use super::*;
    use std::os::windows::fs::OpenOptionsExt;

    fn fixture() -> (
        tempfile::TempDir,
        Arc<NativeBootstrapLifetime>,
        PathBuf,
        File,
    ) {
        let parent = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../.artifacts/tests/native-input-p3/bootstrap-lifetime");
        fs::create_dir_all(&parent).unwrap();
        let outer = tempfile::tempdir_in(parent).unwrap();
        let root = tempfile::tempdir_in(outer.path()).unwrap();
        let path = root.path().to_path_buf();
        fs::write(path.join("bootstrap.ps1"), b"owned resource fixture").unwrap();
        let locked = path.join("locked-resource.bin");
        fs::write(&locked, b"real Windows file-sharing constraint").unwrap();
        let file = fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&locked)
            .unwrap();
        assert!(
            fs::remove_file(&locked).is_err(),
            "Windows must refuse deletion while the real handle denies delete sharing"
        );
        let lifetime = Arc::new(NativeBootstrapLifetime {
            root: Some(root),
            host_exited: AtomicBool::new(false),
            host_pid: None,
        });
        (outer, lifetime, path, file)
    }

    #[test]
    fn bootstrap_lifetime_requires_both_control_release_and_confirmed_host_exit() {
        // These are real Windows file locks, not editor/control receipts.
        for host_first in [false, true] {
            let (_outer, control, path, locked) = fixture();
            let host = Arc::clone(&control);
            if host_first {
                drop(locked);
                host.confirm_host_exit();
                drop(host);
                assert!(
                    path.join("bootstrap.ps1").exists(),
                    "Control still owns its files"
                );
                drop(control);
            } else {
                drop(control);
                assert!(
                    path.join("bootstrap.ps1").exists(),
                    "Control closure must not partially delete a live host's bootstrap"
                );
                drop(locked);
                host.confirm_host_exit();
                drop(host);
            }
            assert!(
                !path.exists(),
                "All bootstrap resources must disappear after the last owner and confirmed exit"
            );
        }
    }

    #[test]
    fn bootstrap_lifetime_preserves_the_entire_directory_when_host_exit_is_unconfirmed() {
        let (_outer, lifetime, path, locked) = fixture();
        drop(lifetime);
        assert_eq!(
            fs::read(path.join("bootstrap.ps1")).unwrap(),
            b"owned resource fixture"
        );
        assert!(path.join("locked-resource.bin").exists());
        drop(locked);
        // The fixture's outer TempDir owns cleanup; no real host was started.
    }
}
