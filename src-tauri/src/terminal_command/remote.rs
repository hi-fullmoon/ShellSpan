//! Native SSH transport owned by the existing SSH worker. No per-grapheme
//! network requests, terminal bytes on the control plane, or new user shell.
use super::*;
use crate::terminal_command::{
    artifacts, protocol as nip,
    registration::{file_sha, VerifiedNativeProfile},
};
use sha2::{Digest, Sha256};

#[cfg(all(test, target_os = "macos"))]
#[path = "remote_tests.rs"]
mod tests;

pub(super) struct RemoteNativeBash {
    pub profile: VerifiedNativeProfile,
    pub control: Channel,
    pub active: bool,
    decoder: nip::Decoder,
    root: String,
    executable: String,
    zle: bool,
}
impl RemoteNativeBash {
    pub fn prepare(
        session: &Session,
        username: &str,
        resources: &Path,
    ) -> Result<Option<Self>, String> {
        let identity = detect_remote_login_shell_identity(session, username)?;
        if identity.shell == TerminalShellKind::Zsh {
            return Self::prepare_zle(session, resources, &identity).map(Some);
        }
        if identity.shell != TerminalShellKind::Bash {
            return Ok(None);
        }
        let sftp = session
            .sftp()
            .map_err(|_| "TERMINAL_NATIVE_SFTP_UNAVAILABLE")?;
        let shell_sha = remote_sha(&sftp, &identity.executable)?;
        let artifact = artifacts::read_catalogue(resources, "linux-aarch64-glibc-2.36")?
            .into_iter()
            .find(|artifact| artifact.shell_sha256 == shell_sha)
            .ok_or("TERMINAL_NATIVE_PROFILE_UNSUPPORTED")?;
        let module = resources.join(&artifact.module);
        let relay = resources.join(&artifact.relay);
        if file_sha(&module)? != artifact.module_sha256
            || file_sha(&relay)? != artifact.relay_sha256
        {
            return Err("TERMINAL_NATIVE_PROFILE_ARTIFACT_MISMATCH".into());
        }
        let root = format!("/tmp/.ss-nip-{}", Uuid::new_v4().simple());
        sftp.mkdir(Path::new(&root), 0o700)
            .map_err(|_| "TERMINAL_NATIVE_STARTUP_UNAVAILABLE")?;
        let result = (|| {
            let module_path = format!("{root}/adapter.so");
            let relay_path = format!("{root}/relay");
            upload(
                &sftp,
                &module_path,
                &std::fs::read(&module).map_err(|_| "TERMINAL_NATIVE_ARTIFACTS_UNAVAILABLE")?,
                0o500,
            )?;
            upload(
                &sftp,
                &relay_path,
                &std::fs::read(&relay).map_err(|_| "TERMINAL_NATIVE_ARTIFACTS_UNAVAILABLE")?,
                0o500,
            )?;
            if remote_sha(&sftp, &relay_path)? != artifact.relay_sha256 {
                return Err("TERMINAL_NATIVE_PROFILE_ARTIFACT_MISMATCH".into());
            }
            let profile = VerifiedNativeProfile::verify_remote(
                &artifact.id,
                &artifact.shell_sha256,
                &shell_sha,
                &module,
                &artifact.module_sha256,
                &remote_sha(&sftp, &module_path)?,
            )?;
            let socket = format!("{root}/control");
            let bootstrap = crate::terminal_command::bash::bootstrap_source(
                Path::new(&module_path),
                Path::new(&socket),
            )?;
            upload(
                &sftp,
                &format!("{root}/native-init"),
                bootstrap.as_bytes(),
                0o600,
            )?;
            if remote_sha(&sftp, &format!("{root}/native-init"))? != nip::sha(&bootstrap) {
                return Err("TERMINAL_NATIVE_PROFILE_ARTIFACT_MISMATCH".into());
            }
            let mut control = session
                .channel_session()
                .map_err(|_| "TERMINAL_NATIVE_CONTROL_UNAVAILABLE")?;
            control
                .exec(&format!(
                    "exec {} {}",
                    quote_remote_posix(&relay_path),
                    quote_remote_posix(&socket)
                ))
                .map_err(|_| "TERMINAL_NATIVE_CONTROL_UNAVAILABLE")?;
            Ok(Self {
                profile,
                control,
                active: true,
                decoder: nip::Decoder::default(),
                root: root.clone(),
                executable: identity.executable,
                zle: false,
            })
        })();
        if result.is_err() {
            cleanup(&sftp, &root);
        }
        result.map(Some)
    }
    pub fn start_shell(&self, channel: &mut Channel) -> Result<(), String> {
        if self.zle {
            return channel.exec(&format!("if [[ ${{parameters[ZDOTDIR]-}} == *export* ]]; then export __SHELLSPAN_NIP_ZDOTDIR_SET=1 __SHELLSPAN_NIP_ZDOTDIR_VALUE=\"$ZDOTDIR\"; else export __SHELLSPAN_NIP_ZDOTDIR_SET=0; unset __SHELLSPAN_NIP_ZDOTDIR_VALUE; fi; exec env ZDOTDIR={} {} -il",quote_remote_posix(&self.root),quote_remote_posix(&self.executable)))
                .map_err(|_|"TERMINAL_NATIVE_SHELL_START_FAILED".into());
        }
        channel
            .exec(&format!(
                "exec {} --shellspan-native-init {} -il",
                quote_remote_posix(&self.executable),
                quote_remote_posix(&format!("{}/native-init", self.root))
            ))
            .map_err(|_| "TERMINAL_NATIVE_SHELL_START_FAILED".into())
    }
    fn prepare_zle(
        session: &Session,
        resources: &Path,
        identity: &RemoteLoginShellIdentity,
    ) -> Result<Self, String> {
        use crate::terminal_command::editors;
        let sftp = session
            .sftp()
            .map_err(|_| "TERMINAL_NATIVE_SFTP_UNAVAILABLE")?;
        let shell_sha = remote_sha(&sftp, &identity.executable)?;
        let artifact = editors::read_catalogue(resources, "linux-aarch64-glibc-2.36")?
            .into_iter()
            .find(|p| p.shell_sha256 == shell_sha)
            .ok_or("TERMINAL_NATIVE_PROFILE_UNSUPPORTED")?;
        let module = resources.join(&artifact.module);
        let core = resources.join(
            artifact
                .core
                .as_ref()
                .ok_or("TERMINAL_NATIVE_SCOPED_CORE_UNAVAILABLE")?,
        );
        let core_sha = artifact
            .editor_sha256
            .as_ref()
            .ok_or("TERMINAL_NATIVE_SCOPED_CORE_UNAVAILABLE")?;
        if std::fs::symlink_metadata(&core)
            .map_err(|_| "TERMINAL_NATIVE_SCOPED_CORE_UNAVAILABLE")?
            .file_type()
            .is_symlink()
            || file_sha(&core)? != *core_sha
        {
            return Err("TERMINAL_NATIVE_SCOPED_CORE_MISMATCH".into());
        }
        let relay_name = artifact
            .relay
            .as_ref()
            .ok_or("TERMINAL_NATIVE_MANIFEST_INVALID")?;
        let relay_sha = artifact
            .relay_sha256
            .as_ref()
            .ok_or("TERMINAL_NATIVE_MANIFEST_INVALID")?;
        let id = artifact
            .profile
            .verified_profile_id
            .as_deref()
            .ok_or("TERMINAL_NATIVE_MANIFEST_INVALID")?;
        if relay_name != &format!("{id}/native-input-relay")
            || file_sha(&resources.join(relay_name))? != *relay_sha
        {
            return Err("TERMINAL_NATIVE_PROFILE_ARTIFACT_MISMATCH".into());
        }
        let profile = VerifiedNativeProfile::verify_editor(
            &artifact.profile,
            &artifact.shell_sha256,
            &shell_sha,
            &module,
            &artifact.module_sha256,
        )?
        .bind_scoped_zle_core(&core)?;
        let root = format!("/tmp/.ss-nip-{}", Uuid::new_v4().simple());
        sftp.mkdir(Path::new(&root), 0o700)
            .map_err(|_| "TERMINAL_NATIVE_STARTUP_UNAVAILABLE")?;
        let result = (|| {
            sftp.mkdir(Path::new(&format!("{root}/scoped")), 0o700)
                .map_err(|_| "TERMINAL_NATIVE_SCOPED_CORE_UNAVAILABLE")?;
            sftp.mkdir(Path::new(&format!("{root}/scoped/zsh")), 0o700)
                .map_err(|_| "TERMINAL_NATIVE_SCOPED_CORE_UNAVAILABLE")?;
            upload(
                &sftp,
                &format!("{root}/scoped/zsh/zle.so"),
                &std::fs::read(&core).map_err(|_| "TERMINAL_NATIVE_SCOPED_CORE_UNAVAILABLE")?,
                0o500,
            )?;
            if remote_sha(&sftp, &format!("{root}/scoped/zsh/zle.so"))? != *core_sha {
                return Err("TERMINAL_NATIVE_SCOPED_CORE_MISMATCH".into());
            }
            upload(
                &sftp,
                &format!("{root}/ss_nip.so"),
                &std::fs::read(&module).map_err(|_| "TERMINAL_NATIVE_ARTIFACTS_UNAVAILABLE")?,
                0o500,
            )?;
            upload(
                &sftp,
                &format!("{root}/relay"),
                &std::fs::read(resources.join(relay_name))
                    .map_err(|_| "TERMINAL_NATIVE_ARTIFACTS_UNAVAILABLE")?,
                0o500,
            )?;
            if remote_sha(&sftp, &format!("{root}/ss_nip.so"))? != artifact.module_sha256
                || remote_sha(&sftp, &format!("{root}/relay"))? != *relay_sha
            {
                return Err("TERMINAL_NATIVE_PROFILE_ARTIFACT_MISMATCH".into());
            }
            let startup = editors::zle_bootstrap(
                Path::new(&format!("{root}/ss_nip.so")),
                Path::new(&format!("{root}/control")),
                Path::new(&identity.executable),
                &artifact.profile,
            )?;
            upload(
                &sftp,
                &format!("{root}/native-init"),
                startup.as_bytes(),
                0o600,
            )?;
            let original_env="if [[ ${__SHELLSPAN_NIP_ZDOTDIR_SET-} == 1 ]]; then ZDOTDIR=$__SHELLSPAN_NIP_ZDOTDIR_VALUE; export ZDOTDIR; else unset ZDOTDIR; fi\nunset __SHELLSPAN_NIP_ZDOTDIR_SET __SHELLSPAN_NIP_ZDOTDIR_VALUE\n[[ -r ${ZDOTDIR-$HOME}/.zshenv ]] && source \"${ZDOTDIR-$HOME}/.zshenv\"\n";
            let core_loader=format!("() {{\n local -a old_path=(\"${{module_path[@]}}\")\n if builtin zmodload -e zsh/zle; then return 1; fi\n module_path=({} \"${{old_path[@]}}\")\n builtin zmodload zsh/zle\n local core_result=$?\n module_path=(\"${{old_path[@]}}\")\n return $core_result\n}}",quote_remote_posix(&format!("{root}/scoped")));
            let initializer=format!("__shellspan_nip_initialize() {{\n precmd_functions=(\"${{(@)precmd_functions:#__shellspan_nip_initialize}}\"); unfunction __shellspan_nip_initialize\n source {}\n}}\nprecmd_functions=(__shellspan_nip_initialize \"${{precmd_functions[@]}}\")\n",quote_remote_posix(&format!("{root}/native-init")));
            let wrapper=format!("{original_env}if {core_loader}; then\n{initializer}else\n builtin printf '%s\\n' TERMINAL_NATIVE_SCOPED_CORE_CONFLICT >&2\nfi\n");
            upload(&sftp, &format!("{root}/.zshenv"), wrapper.as_bytes(), 0o600)?;
            let mut control = session
                .channel_session()
                .map_err(|_| "TERMINAL_NATIVE_CONTROL_UNAVAILABLE")?;
            control
                .exec(&format!(
                    "exec {} {}",
                    quote_remote_posix(&format!("{root}/relay")),
                    quote_remote_posix(&format!("{root}/control"))
                ))
                .map_err(|_| "TERMINAL_NATIVE_CONTROL_UNAVAILABLE")?;
            Ok(Self {
                profile,
                control,
                active: true,
                decoder: nip::Decoder::default(),
                root: root.clone(),
                executable: identity.executable.clone(),
                zle: true,
            })
        })();
        if result.is_err() {
            cleanup(&sftp, &root);
        }
        result
    }
    pub fn send(&mut self, session: &Session, bytes: &[u8]) -> Result<(), String> {
        if !self.active || bytes.len() > nip::MAX_MESSAGE_BYTES {
            return Err("TERMINAL_NATIVE_CONTROL_UNAVAILABLE".into());
        }
        write_all_nonblocking(session, &mut self.control, bytes)
    }
    pub fn drain(&mut self, app: &AppHandle, transport: &str) -> Result<bool, String> {
        if !self.active {
            return Ok(false);
        }
        let mut bytes = [0; 8192];
        let mut progress = false;
        for _ in 0..32 {
            match self.control.read(&mut bytes) {
                Ok(0) if self.control.eof() => {
                    self.decoder
                        .finish()
                        .map_err(|_| "TERMINAL_NATIVE_PARTIAL_FRAME_EOF")?;
                    return Err("TERMINAL_NATIVE_CONTROL_CLOSED".into());
                }
                Ok(0) => break,
                Ok(count) => {
                    progress = true;
                    for message in self
                        .decoder
                        .push(&bytes[..count])
                        .map_err(|_| "TERMINAL_NATIVE_PROTOCOL_INVALID")?
                    {
                        app.try_state::<crate::agent_runtime::AgentRuntime>()
                            .ok_or("TERMINAL_NATIVE_RUNTIME_UNAVAILABLE")?
                            .accept_native_terminal_message(transport, message)?;
                        crate::commands::emit_terminal_integration_state(app, transport);
                    }
                }
                Err(error) if is_retryable_channel_error_kind(error.kind()) => break,
                Err(_) => return Err("TERMINAL_NATIVE_CONTROL_UNAVAILABLE".into()),
            }
        }
        Ok(progress)
    }
    pub fn fail(&mut self, app: &AppHandle, transport: &str) {
        self.active = false;
        let _ = self.control.send_eof();
        let _ = self.control.close();
        if let Some(runtime) = app.try_state::<crate::agent_runtime::AgentRuntime>() {
            let _ = runtime.native_terminal_control_closed(transport);
        }
        crate::commands::emit_terminal_integration_state(app, transport);
    }
    pub fn close(mut self, session: &Session) {
        self.active = false;
        let _ = self.control.send_eof();
        let _ = self.control.close();
        session.set_blocking(true);
        if let Ok(sftp) = session.sftp() {
            cleanup(&sftp, &self.root);
        }
    }
}
fn upload(sftp: &ssh2::Sftp, path: &str, bytes: &[u8], mode: u32) -> Result<(), String> {
    if bytes.len() > 32 * 1024 * 1024 {
        return Err("TERMINAL_NATIVE_ARTIFACT_LIMIT".into());
    }
    let mut file = sftp
        .create(Path::new(path))
        .map_err(|_| "TERMINAL_NATIVE_UPLOAD_FAILED")?;
    for chunk in bytes.chunks(65536) {
        if let Some(error) = crate::connection::terminal_deadline::failure_reason() {
            return Err(error);
        }
        file.write_all(chunk)
            .map_err(|_| "TERMINAL_NATIVE_UPLOAD_FAILED")?;
    }
    drop(file);
    sftp.setstat(
        Path::new(path),
        ssh2::FileStat {
            size: None,
            uid: None,
            gid: None,
            perm: Some(mode),
            atime: None,
            mtime: None,
        },
    )
    .map_err(|_| "TERMINAL_NATIVE_UPLOAD_FAILED".into())
}
fn remote_sha(sftp: &ssh2::Sftp, path: &str) -> Result<String, String> {
    let mut file = sftp
        .open(Path::new(path))
        .map_err(|_| "TERMINAL_NATIVE_ARTIFACTS_UNAVAILABLE")?;
    let before = file
        .stat()
        .map_err(|_| "TERMINAL_NATIVE_ARTIFACTS_UNAVAILABLE")?;
    if before.size.is_none_or(|size| size > 32 * 1024 * 1024) {
        return Err("TERMINAL_NATIVE_ARTIFACT_LIMIT".into());
    }
    let mut digest = Sha256::new();
    let mut total = 0_u64;
    let mut bytes = [0; 65536];
    loop {
        if let Some(error) = crate::connection::terminal_deadline::failure_reason() {
            return Err(error);
        }
        let count = file
            .read(&mut bytes)
            .map_err(|_| "TERMINAL_NATIVE_ARTIFACTS_UNAVAILABLE")?;
        if count == 0 {
            break;
        }
        total += count as u64;
        if total > 32 * 1024 * 1024 {
            return Err("TERMINAL_NATIVE_ARTIFACT_LIMIT".into());
        }
        digest.update(&bytes[..count]);
    }
    let after = file
        .stat()
        .map_err(|_| "TERMINAL_NATIVE_ARTIFACTS_UNAVAILABLE")?;
    if before.size != Some(total) || before.size != after.size || before.mtime != after.mtime {
        return Err("TERMINAL_NATIVE_ARTIFACT_CHANGED".into());
    }
    Ok(hex::encode(digest.finalize()))
}
fn cleanup(sftp: &ssh2::Sftp, root: &str) {
    let _ = sftp.unlink(Path::new(&format!("{root}/scoped/zsh/zle.so")));
    let _ = sftp.rmdir(Path::new(&format!("{root}/scoped/zsh")));
    let _ = sftp.rmdir(Path::new(&format!("{root}/scoped")));
    if let Ok(entries) = sftp.readdir(Path::new(root)) {
        for (path, _) in entries {
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("");
            let pending = name
                .strip_prefix("control.")
                .and_then(|name| name.strip_suffix(".pending"))
                .is_some_and(|nonce| {
                    nonce.len() == 32 && nonce.bytes().all(|byte| byte.is_ascii_hexdigit())
                });
            if path.parent() == Some(Path::new(root))
                && (matches!(
                    name,
                    "adapter.so"
                        | "ss_nip.so"
                        | ".zshenv"
                        | "relay"
                        | "native-init"
                        | "control"
                        | "control.control"
                ) || name.starts_with("control.job.job-")
                    || pending)
            {
                let _ = sftp.unlink(&path);
            }
        }
    }
    let _ = sftp.rmdir(Path::new(root));
}
