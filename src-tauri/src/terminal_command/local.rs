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
        let artifact = super::editors::read_catalogue(resources, target)?
            .into_iter()
            .find(|a| a.shell_sha256 == digest)
            .ok_or("TERMINAL_NATIVE_PROFILE_UNSUPPORTED")?;
        let root = tempfile::Builder::new()
            .prefix("ss-nip-zle-")
            .tempdir()
            .map_err(|_| "TERMINAL_NATIVE_STARTUP_UNAVAILABLE")?;
        fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700))
            .map_err(|_| "TERMINAL_NATIVE_STARTUP_UNAVAILABLE")?;
        let module = root.path().join("ss_nip.so");
        fs::copy(resources.join(&artifact.module), &module)
            .map_err(|_| "TERMINAL_NATIVE_ARTIFACTS_UNAVAILABLE")?;
        fs::set_permissions(&module, fs::Permissions::from_mode(0o500))
            .map_err(|_| "TERMINAL_NATIVE_STARTUP_UNAVAILABLE")?;
        let profile = super::editors::verify(&artifact, shell, &module)?;
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
            super::editors::zle_bootstrap(&module, &socket, shell, &artifact.profile)?,
        )
        .map_err(|_| "TERMINAL_NATIVE_STARTUP_UNAVAILABLE")?;
        Ok(Self {
            root,
            listener,
            bootstrap,
            profile,
            zle: true,
        })
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
        on_closed: impl FnOnce() -> () + Send + 'static,
    ) -> NativeControlHandle {
        let socket = Arc::new(Mutex::new(None));
        let writer = socket.clone();
        let stopped = Arc::new(AtomicBool::new(false));
        let done = stopped.clone();
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
                stream
                    .write_all(
                        &probe
                            .encode()
                            .map_err(|_| "TERMINAL_NATIVE_PROTOCOL_INVALID")?,
                    )
                    .map_err(|_| "TERMINAL_NATIVE_CONTROL_UNAVAILABLE")?;
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
                            decoder
                                .finish()
                                .map_err(|_| "TERMINAL_NATIVE_PARTIAL_FRAME_EOF")?;
                            break;
                        }
                        Ok(count) => {
                            for message in decoder
                                .push(&bytes[..count])
                                .map_err(|_| "TERMINAL_NATIVE_PROTOCOL_INVALID")?
                            {
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
        }
    }
}

pub(crate) struct NativeControlHandle {
    socket: Arc<Mutex<Option<UnixStream>>>,
    stopped: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}
impl NativeControlHandle {
    pub fn write(&self, bytes: &[u8]) -> Result<(), String> {
        if bytes.len() > nip::MAX_MESSAGE_BYTES || self.stopped.load(Ordering::Acquire) {
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
