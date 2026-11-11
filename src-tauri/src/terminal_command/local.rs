//! Verified local Bash startup and its private, bounded duplex transport.
//! Call preparation from a blocking connection worker, never the UI thread.
use super::bash::bootstrap_source;
use super::{
    protocol as nip,
    registration::{file_sha, VerifiedNativeProfile},
};
use std::os::unix::{
    fs::PermissionsExt,
    net::{UnixListener, UnixStream},
};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

pub(crate) struct PreparedNativeBash {
    root: tempfile::TempDir,
    listener: UnixListener,
    bootstrap: PathBuf,
    pub profile: VerifiedNativeProfile,
    zle: bool,
    shell_override: Option<PathBuf>,
}
impl PreparedNativeBash {
    pub fn prepare(shell: &Path, resources: &Path) -> Result<Self, String> {
        if shell.to_str().is_some_and(|path| {
            crate::terminal_integration::TerminalShellKind::detect(path)
                == crate::terminal_integration::TerminalShellKind::Zsh
        }) {
            return Self::prepare_zle(shell, resources);
        }
        let shell_sha = file_sha(shell)?;
        let target = if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            "macos-arm64"
        } else if cfg!(all(
            target_os = "linux",
            target_arch = "aarch64",
            target_env = "gnu"
        )) {
            "linux-aarch64-glibc-2.36"
        } else {
            return Err("TERMINAL_NATIVE_PROFILE_UNSUPPORTED".into());
        };
        let artifact = super::artifacts::read_catalogue(resources, target)?
            .into_iter()
            .find(|artifact| artifact.shell_sha256 == shell_sha)
            .ok_or("TERMINAL_NATIVE_PROFILE_UNSUPPORTED")?;
        let root = tempfile::Builder::new()
            .prefix("ss-nip-")
            .tempdir()
            .map_err(|_| "TERMINAL_NATIVE_STARTUP_UNAVAILABLE")?;
        fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700))
            .map_err(|_| "TERMINAL_NATIVE_STARTUP_UNAVAILABLE")?;
        let module = root.path().join("adapter.so");
        fs::copy(resources.join(&artifact.module), &module)
            .map_err(|_| "TERMINAL_NATIVE_ARTIFACTS_UNAVAILABLE")?;
        fs::set_permissions(&module, fs::Permissions::from_mode(0o500))
            .map_err(|_| "TERMINAL_NATIVE_STARTUP_UNAVAILABLE")?;
        let profile = VerifiedNativeProfile::verify_local(
            &artifact.id,
            shell,
            &artifact.shell_sha256,
            &module,
            &artifact.module_sha256,
        )?;
        let socket = root.path().join("control");
        let listener =
            UnixListener::bind(&socket).map_err(|_| "TERMINAL_NATIVE_STARTUP_UNAVAILABLE")?;
        fs::set_permissions(&socket, fs::Permissions::from_mode(0o600))
            .map_err(|_| "TERMINAL_NATIVE_STARTUP_UNAVAILABLE")?;
        listener
            .set_nonblocking(true)
            .map_err(|_| "TERMINAL_NATIVE_STARTUP_UNAVAILABLE")?;
        let bootstrap = root.path().join("bashrc");
        fs::write(&bootstrap, bootstrap_source(&module, &socket)?)
            .map_err(|_| "TERMINAL_NATIVE_STARTUP_UNAVAILABLE")?;
        fs::set_permissions(&bootstrap, fs::Permissions::from_mode(0o600))
            .map_err(|_| "TERMINAL_NATIVE_STARTUP_UNAVAILABLE")?;
        Ok(Self {
            root,
            listener,
            bootstrap,
            profile,
            zle: false,
            shell_override: None,
        })
    }
    fn prepare_zle(shell: &Path, resources: &Path) -> Result<Self, String> {
        let target = if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            "macos-arm64"
        } else if cfg!(all(
            target_os = "linux",
            target_arch = "aarch64",
            target_env = "gnu"
        )) {
            "linux-aarch64-glibc-2.36"
        } else {
            return Err("TERMINAL_NATIVE_PROFILE_UNSUPPORTED".into());
        };
        let digest = file_sha(shell)?;
        let stock_macos_zsh = target == "macos-arm64"
            && digest == super::registration::mac_zle_pin("mainSha256")?;
        let artifact = super::editors::read_catalogue(resources, target)?
            .into_iter()
            .find(|artifact| {
                artifact.shell_sha256 == digest || stock_macos_zsh && artifact.shell.is_some()
            })
            .ok_or("TERMINAL_NATIVE_PROFILE_UNSUPPORTED")?;
        if artifact.shell.is_some()
            && file_sha(Path::new("/bin/zsh"))? != super::registration::mac_zle_pin("mainSha256")?
        {
            return Err("TERMINAL_NATIVE_PROFILE_UNSUPPORTED".into());
        }
        let root = tempfile::Builder::new()
            .prefix("ss-nip-zle-")
            .tempdir()
            .map_err(|_| "TERMINAL_NATIVE_STARTUP_UNAVAILABLE")?;
        fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700))
            .map_err(|_| "TERMINAL_NATIVE_STARTUP_UNAVAILABLE")?;
        let shell_override = if stock_macos_zsh {
            let source = artifact
                .shell
                .as_ref()
                .ok_or("TERMINAL_NATIVE_PROFILE_UNSUPPORTED")?;
            let executable = root.path().join("zsh");
            fs::copy(resources.join(source), &executable)
                .map_err(|_| "TERMINAL_NATIVE_ARTIFACTS_UNAVAILABLE")?;
            fs::set_permissions(&executable, fs::Permissions::from_mode(0o500))
                .map_err(|_| "TERMINAL_NATIVE_STARTUP_UNAVAILABLE")?;
            Some(executable)
        } else {
            None
        };
        let executable = shell_override.as_deref().unwrap_or(shell);
        let module = root.path().join("ss_nip.so");
        fs::copy(resources.join(&artifact.module), &module)
            .map_err(|_| "TERMINAL_NATIVE_ARTIFACTS_UNAVAILABLE")?;
        fs::set_permissions(&module, fs::Permissions::from_mode(0o500))
            .map_err(|_| "TERMINAL_NATIVE_STARTUP_UNAVAILABLE")?;
        let profile = super::editors::verify(&artifact, executable, &module)?;
        // Bind the public Core API to the exact reviewed binary. Production
        // admission remains an independent resource policy decision.
        let core_source = resources.join(
            artifact
                .core
                .as_ref()
                .ok_or("TERMINAL_NATIVE_SCOPED_CORE_UNAVAILABLE")?,
        );
        let core_sha = artifact
            .editor_sha256
            .as_ref()
            .ok_or("TERMINAL_NATIVE_SCOPED_CORE_UNAVAILABLE")?;
        if !cfg!(target_os = "macos")
            || fs::symlink_metadata(&core_source)
                .map_err(|_| "TERMINAL_NATIVE_SCOPED_CORE_UNAVAILABLE")?
                .file_type()
                .is_symlink()
            || file_sha(&core_source)? != *core_sha
        {
            return Err("TERMINAL_NATIVE_SCOPED_CORE_MISMATCH".into());
        }
        let core = root.path().join("scoped/zsh/zle.so");
        fs::create_dir_all(core.parent().unwrap())
            .map_err(|_| "TERMINAL_NATIVE_SCOPED_CORE_UNAVAILABLE")?;
        fs::copy(&core_source, &core).map_err(|_| "TERMINAL_NATIVE_SCOPED_CORE_UNAVAILABLE")?;
        fs::set_permissions(&core, fs::Permissions::from_mode(0o500))
            .map_err(|_| "TERMINAL_NATIVE_SCOPED_CORE_UNAVAILABLE")?;
        if file_sha(&core)? != *core_sha {
            return Err("TERMINAL_NATIVE_SCOPED_CORE_MISMATCH".into());
        }
        let profile = profile.bind_scoped_zle_core(&core)?;
        let socket = root.path().join("control");
        let listener =
            UnixListener::bind(&socket).map_err(|_| "TERMINAL_NATIVE_STARTUP_UNAVAILABLE")?;
        fs::set_permissions(&socket, fs::Permissions::from_mode(0o600))
            .map_err(|_| "TERMINAL_NATIVE_STARTUP_UNAVAILABLE")?;
        listener
            .set_nonblocking(true)
            .map_err(|_| "TERMINAL_NATIVE_STARTUP_UNAVAILABLE")?;
        let bootstrap = root.path().join("native-init");
        fs::write(
            &bootstrap,
            super::editors::zle_bootstrap(&module, &socket, executable, &artifact.profile)?,
        )
        .map_err(|_| "TERMINAL_NATIVE_STARTUP_UNAVAILABLE")?;
        Ok(Self {
            root,
            listener,
            bootstrap,
            profile,
            zle: true,
            shell_override,
        })
    }
    pub(crate) fn shell_override(&self) -> Option<&Path> {
        self.shell_override.as_deref()
    }
    pub fn configure(&self, command: &mut portable_pty::CommandBuilder) -> Result<(), String> {
        if self.zle {
            let quote = |value: &str| {
                shlex::try_quote(value)
                    .map(|v| v.into_owned())
                    .map_err(|_| "TERMINAL_NATIVE_PATH_INVALID")
            };
            let restore = match command.get_env("ZDOTDIR") {
                Some(value) => format!(
                    "ZDOTDIR={}\nexport ZDOTDIR",
                    quote(value.to_str().ok_or("TERMINAL_NATIVE_PATH_INVALID")?)?
                ),
                None => "unset ZDOTDIR".into(),
            };
            // Restore the original lookup directory in .zshenv; Zsh itself then
            // loads system/user profile, rc and login files in its normal order.
            // The one-use precmd hook runs only after that startup has finished.
            let core_path = self.root.path().join("scoped");
            let core_path = quote(core_path.to_str().ok_or("TERMINAL_NATIVE_PATH_INVALID")?)?;
            let core_loader=format!("() {{\n local -a old_path=(\"${{module_path[@]}}\")\n if builtin zmodload -e zsh/zle; then return 1; fi\n module_path=({core_path} \"${{old_path[@]}}\")\n builtin zmodload zsh/zle\n local core_result=$?\n module_path=(\"${{old_path[@]}}\")\n return $core_result\n}}");
            // Original user env is sourced once with its original ZDOTDIR.
            // Existing early Core/widgets are preserved: decline native and
            // continue normal profile/rc/login loading instead of returning.
            let original_env=format!("{restore}\n[[ -r ${{ZDOTDIR-$HOME}}/.zshenv ]] && source \"${{ZDOTDIR-$HOME}}/.zshenv\"\n");
            let initializer=format!("__shellspan_nip_initialize() {{\n precmd_functions=(\"${{(@)precmd_functions:#__shellspan_nip_initialize}}\")\n unfunction __shellspan_nip_initialize\n source {}\n}}\nprecmd_functions=(__shellspan_nip_initialize \"${{precmd_functions[@]}}\")\n",quote(self.bootstrap.to_str().ok_or("TERMINAL_NATIVE_PATH_INVALID")?)?);
            let wrapper=format!("{original_env}if {core_loader}; then\n{initializer}else\n builtin printf '%s\\n' TERMINAL_NATIVE_SCOPED_CORE_CONFLICT >&2\nfi\n");
            fs::write(self.root.path().join(".zshenv"), wrapper)
                .map_err(|_| "TERMINAL_NATIVE_STARTUP_UNAVAILABLE")?;
            command.env("ZDOTDIR", self.root.path());
            command.arg("-il");
            return Ok(());
        }
        command.args([
            "--shellspan-native-init",
            self.bootstrap
                .to_str()
                .ok_or("TERMINAL_NATIVE_PATH_INVALID")?,
            "-il",
        ]);
        Ok(())
    }
    pub fn start(
        self,
        probe: nip::ConnectionEnvelope,
        mut on_message: impl FnMut(nip::Message) -> Result<(), String> + Send + 'static,
        on_closed: impl FnOnce() + Send + 'static,
    ) -> NativeControlHandle {
        let socket = Arc::new(Mutex::new(None));
        let writer = socket.clone();
        let stopped = Arc::new(AtomicBool::new(false));
        let done = stopped.clone();
        #[cfg(all(
            feature = "native-input-acceptance",
            debug_assertions,
            target_os = "macos",
            target_arch = "aarch64"
        ))]
        let trace_control_id = probe.connection.control_id.clone();
        let thread = thread::spawn(move || {
            let _root = self.root;
            let result = (|| -> Result<(), String> {
                let deadline = Instant::now() + Duration::from_secs(5);
                let mut stream = loop {
                    if done.load(Ordering::Acquire) || Instant::now() >= deadline {
                        return Err("TERMINAL_NATIVE_CONNECT_TIMEOUT".into());
                    }
                    match self.listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(5))
                        }
                        Err(_) => return Err("TERMINAL_NATIVE_CONTROL_UNAVAILABLE".into()),
                    }
                };
                // BSD accepted sockets may inherit O_NONBLOCK from the listener.
                // Normalize the duplex stream so the existing timeouts apply.
                stream
                    .set_nonblocking(false)
                    .map_err(|_| "TERMINAL_NATIVE_CONTROL_UNAVAILABLE")?;
                stream
                    .set_read_timeout(Some(Duration::from_millis(50)))
                    .map_err(|_| "TERMINAL_NATIVE_CONTROL_UNAVAILABLE")?;
                stream
                    .set_write_timeout(Some(Duration::from_secs(1)))
                    .map_err(|_| "TERMINAL_NATIVE_CONTROL_UNAVAILABLE")?;
                let probe_bytes = probe
                    .encode()
                    .map_err(|_| "TERMINAL_NATIVE_PROTOCOL_INVALID")?;
                #[cfg(all(
                    feature = "native-input-acceptance",
                    debug_assertions,
                    target_os = "macos",
                    target_arch = "aarch64"
                ))]
                write_acceptance_startup_probe(&mut stream, &probe, &probe_bytes)?;
                #[cfg(not(all(
                    feature = "native-input-acceptance",
                    debug_assertions,
                    target_os = "macos",
                    target_arch = "aarch64"
                )))]
                let sent = stream.write_all(&probe_bytes);
                #[cfg(not(all(
                    feature = "native-input-acceptance",
                    debug_assertions,
                    target_os = "macos",
                    target_arch = "aarch64"
                )))]
                sent.map_err(|_| "TERMINAL_NATIVE_CONTROL_UNAVAILABLE")?;
                *writer
                    .lock()
                    .map_err(|_| "TERMINAL_NATIVE_CONTROL_UNAVAILABLE")? = Some(
                    stream
                        .try_clone()
                        .map_err(|_| "TERMINAL_NATIVE_CONTROL_UNAVAILABLE")?,
                );
                let mut decoder = nip::Decoder::default();
                let mut bytes = [0; 8192];
                while !done.load(Ordering::Acquire) {
                    match stream.read(&mut bytes) {
                        Ok(0) => {
                            #[cfg(all(
                                feature = "native-input-acceptance",
                                debug_assertions,
                                target_os = "macos",
                                target_arch = "aarch64"
                            ))]
                            super::acceptance_trace::record(
                                "control-eof",
                                serde_json::json!({"controlId":probe.connection.control_id}),
                            )?;
                            decoder
                                .finish()
                                .map_err(|_| "TERMINAL_NATIVE_PARTIAL_FRAME_EOF")?;
                            break;
                        }
                        Ok(count) => {
                            #[cfg(all(
                                feature = "native-input-acceptance",
                                debug_assertions,
                                target_os = "macos",
                                target_arch = "aarch64"
                            ))]
                            super::acceptance_trace::record(
                                "control-receive",
                                serde_json::json!({"controlId":probe.connection.control_id,"hex":hex::encode(&bytes[..count])}),
                            )?;
                            for message in decoder
                                .push(&bytes[..count])
                                .map_err(|_| "TERMINAL_NATIVE_PROTOCOL_INVALID")?
                            {
                                #[cfg(all(
                                    feature = "native-input-acceptance",
                                    debug_assertions,
                                    target_os = "macos",
                                    target_arch = "aarch64"
                                ))]
                                {
                                    for wrong in super::acceptance_trace::wrong_arm_bindings(
                                        &message,
                                        &probe.connection.control_id,
                                    )? {
                                        on_message(wrong)?;
                                    }
                                    super::acceptance_trace::hold_original_arm(
                                        &message,
                                        &probe.connection.control_id,
                                    )?;
                                }
                                #[cfg(all(
                                    feature = "native-input-acceptance",
                                    debug_assertions,
                                    target_os = "macos",
                                    target_arch = "aarch64"
                                ))]
                                if let Some(wrong) = super::acceptance_trace::mismatched_settlement(
                                    &message,
                                    &probe.connection.control_id,
                                )? {
                                    on_message(wrong)?;
                                }
                                #[cfg(all(
                                    feature = "native-input-acceptance",
                                    debug_assertions,
                                    target_os = "macos",
                                    target_arch = "aarch64"
                                ))]
                                super::acceptance_trace::hold_submission_receipt(
                                    &message,
                                    &probe.connection.control_id,
                                )?;
                                #[cfg(all(
                                    feature = "native-input-acceptance",
                                    debug_assertions,
                                    target_os = "macos",
                                    target_arch = "aarch64"
                                ))]
                                if super::acceptance_trace::eof_at_acceptance(&message) {
                                    decoder.finish().map_err(|_| {
                                        "TERMINAL_ACCEPTANCE_EOF_REQUIRES_FRAME_BOUNDARY"
                                    })?;
                                    stream.shutdown(std::net::Shutdown::Read).map_err(|_| {
                                        "TERMINAL_ACCEPTANCE_CONTROL_READ_SHUTDOWN_FAILED"
                                    })?;
                                    super::acceptance_trace::record(
                                        "control-read-half-shutdown",
                                        serde_json::json!({
                                            "controlId":probe.connection.control_id
                                        }),
                                    )?;
                                    // The next real read observes EOF. Do not route a
                                    // receipt from the faulted side of the connection.
                                    break;
                                }
                                on_message(message)?;
                            }
                        }
                        Err(error)
                            if matches!(
                                error.kind(),
                                std::io::ErrorKind::WouldBlock
                                    | std::io::ErrorKind::TimedOut
                                    | std::io::ErrorKind::Interrupted
                            ) => {}
                        Err(_) => return Err("TERMINAL_NATIVE_CONTROL_UNAVAILABLE".into()),
                    }
                }
                Ok(())
            })();
            #[cfg(all(
                feature = "native-input-acceptance",
                debug_assertions,
                target_os = "macos",
                target_arch = "aarch64"
            ))]
            let result = {
                let captured = super::acceptance_trace::record(
                    "control-closed",
                    serde_json::json!({"controlId":probe.connection.control_id,"error":result.as_ref().err()}),
                );
                result.and(captured)
            };
            if let Err(reason) = result {
                log::warn!(
                    "Native terminal control failed terminal_session_id={}: {reason}",
                    probe.connection.terminal_session_id
                );
            }
            done.store(true, Ordering::Release);
            if let Ok(mut guard) = writer.lock() {
                if let Some(socket) = guard.take() {
                    let _ = socket.shutdown(std::net::Shutdown::Both);
                }
            }
            on_closed();
        });
        NativeControlHandle {
            socket,
            stopped,
            thread: Some(thread),
            #[cfg(all(
                feature = "native-input-acceptance",
                debug_assertions,
                target_os = "macos",
                target_arch = "aarch64"
            ))]
            trace_control_id,
        }
    }
}

#[cfg(all(
    feature = "native-input-acceptance",
    debug_assertions,
    target_os = "macos",
    target_arch = "aarch64"
))]
fn write_acceptance_startup_probe(
    stream: &mut UnixStream,
    probe: &nip::ConnectionEnvelope,
    bytes: &[u8],
) -> Result<(), String> {
    use super::acceptance_trace::{enabled, record};

    let case = std::env::var("SHELLSPAN_ACCEPTANCE_WIRE_STARTUP").ok();
    let control_id = &probe.connection.control_id;
    let mut write = |part: &[u8]| -> Result<(), String> {
        record(
            "control-send-attempt",
            serde_json::json!({"controlId":control_id,"hex":hex::encode(part)}),
        )?;
        let sent = stream.write_all(part);
        record(
            "control-send-return",
            serde_json::json!({"controlId":control_id,"ok":sent.is_ok(),"partialUnknown":sent.is_err()}),
        )?;
        sent.map_err(|_| "TERMINAL_NATIVE_CONTROL_UNAVAILABLE".into())
    };
    let Some(case) = case else {
        return write(bytes);
    };
    if !enabled() || std::env::var("SHELLSPAN_ACCEPTANCE_SUBMISSION").as_deref() != Ok("1") {
        return Err("TERMINAL_ACCEPTANCE_DISABLED".into());
    }
    record(
        "wire-startup-selected",
        serde_json::json!({"case":case,"connection":probe.connection,"requestId":probe.request_id,"originalProbeHex":hex::encode(bytes)}),
    )?;
    match case.as_str() {
        "split-and-coalesced" => {
            let (first, second) = bytes.split_at(bytes.len() / 2);
            write(first)?;
            thread::sleep(Duration::from_millis(80));
            write(second)
        }
        "oversized" => {
            write(&vec![b' '; nip::MAX_MESSAGE_BYTES - 1])?;
            write(b" \n")
        }
        "invalid-json" => write(b"{\n"),
        "invalid-utf8" => write(&[0xff, b'\n']),
        "eof-partial-frame" => {
            write(&bytes[..bytes.len() / 2])?;
            stream
                .shutdown(std::net::Shutdown::Write)
                .map_err(|_| "TERMINAL_NATIVE_CONTROL_UNAVAILABLE")?;
            record(
                "wire-startup-write-eof",
                serde_json::json!({"controlId":control_id}),
            )
        }
        _ => Err("ACCEPTANCE_FIXED_WIRE_CASE_REQUIRED".into()),
    }
}

pub(crate) struct NativeControlHandle {
    #[cfg(all(
        feature = "native-input-acceptance",
        debug_assertions,
        target_os = "macos",
        target_arch = "aarch64"
    ))]
    trace_control_id: String,
    socket: Arc<Mutex<Option<UnixStream>>>,
    stopped: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}
impl NativeControlHandle {
    pub fn write(&self, bytes: &[u8]) -> Result<(), String> {
        if bytes.len() > nip::MAX_MESSAGE_BYTES || self.stopped.load(Ordering::Acquire) {
            return Err("TERMINAL_NATIVE_CONTROL_UNAVAILABLE".into());
        }
        let mut socket = self
            .socket
            .lock()
            .map_err(|_| "TERMINAL_NATIVE_CONTROL_UNAVAILABLE")?;
        let stream = socket
            .as_mut()
            .ok_or("TERMINAL_NATIVE_CONTROL_UNAVAILABLE")?;
        #[cfg(all(
            feature = "native-input-acceptance",
            debug_assertions,
            target_os = "macos",
            target_arch = "aarch64"
        ))]
        let altered = super::acceptance_trace::mismatched_prepare(bytes, &self.trace_control_id)?;
        #[cfg(all(
            feature = "native-input-acceptance",
            debug_assertions,
            target_os = "macos",
            target_arch = "aarch64"
        ))]
        let bytes = altered.as_deref().unwrap_or(bytes);
        #[cfg(all(
            feature = "native-input-acceptance",
            debug_assertions,
            target_os = "macos",
            target_arch = "aarch64"
        ))]
        super::acceptance_trace::record(
            "control-send-attempt",
            serde_json::json!({"controlId":self.trace_control_id,"hex":hex::encode(bytes)}),
        )?;
        let result = stream.write_all(bytes);
        #[cfg(all(
            feature = "native-input-acceptance",
            debug_assertions,
            target_os = "macos",
            target_arch = "aarch64"
        ))]
        super::acceptance_trace::record(
            "control-send-return",
            serde_json::json!({"controlId":self.trace_control_id,"ok":result.is_ok(),"partialUnknown":result.is_err()}),
        )?;
        result.map_err(|_| "TERMINAL_NATIVE_CONTROL_UNAVAILABLE".into())
    }
}
impl Drop for NativeControlHandle {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        if let Ok(guard) = self.socket.lock() {
            if let Some(socket) = guard.as_ref() {
                let _ = socket.shutdown(std::net::Shutdown::Both);
            }
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
