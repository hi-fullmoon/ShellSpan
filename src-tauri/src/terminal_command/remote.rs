//! Native SSH transport owned by the existing SSH worker. No per-grapheme
//! network requests or terminal bytes on the control plane.
use super::*;
use crate::terminal_command::{
    artifacts, protocol as nip,
    registration::{file_sha, VerifiedNativeProfile},
};
use sha2::{Digest, Sha256};

const UNSUPPORTED_PROFILE: &str = "TERMINAL_NATIVE_PROFILE_UNSUPPORTED";

#[cfg(all(test, target_os = "macos"))]
#[path = "remote_tests.rs"]
mod tests;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RemoteBashTarget {
    Arm64,
    X86_64,
}

impl RemoteBashTarget {
    fn detect(session: &Session) -> Result<Self, String> {
        let tag = format!("shellspan-platform-{}", Uuid::new_v4().simple());
        let output = read_ssh_setup_command(
            session,
            &format!(
                r#"host=$(command uname -sm) || exit 1
libc=
case "$host" in
  'Linux x86_64') libc=$(LC_ALL=C command getconf GNU_LIBC_VERSION) || exit 1 ;;
esac
builtin printf '\n%s\t%s\t%s\n' '{}' "$host" "$libc""#,
                tag
            ),
        )
        .map_err(|_| UNSUPPORTED_PROFILE)?;
        Self::parse(&tag, &output)
    }

    fn parse(tag: &str, output: &[u8]) -> Result<Self, String> {
        let prefix = format!("{tag}\t");
        let mut records = output
            .split(|byte| *byte == b'\n')
            .filter_map(|line| line.strip_prefix(prefix.as_bytes()));
        let record = std::str::from_utf8(records.next().ok_or(UNSUPPORTED_PROFILE)?)
            .map_err(|_| UNSUPPORTED_PROFILE)?;
        if records.next().is_some() {
            return Err(UNSUPPORTED_PROFILE.into());
        }
        match record.split_once('\t') {
            Some(("Linux aarch64", "")) => Ok(Self::Arm64),
            Some(("Linux x86_64", libc)) => libc
                .strip_prefix("glibc 2.")
                .and_then(|value| value.parse::<u32>().ok())
                .filter(|minor| *minor >= 36)
                .map(|_| Self::X86_64)
                .ok_or_else(|| UNSUPPORTED_PROFILE.into()),
            _ => Err(UNSUPPORTED_PROFILE.into()),
        }
    }

    fn catalogue(self) -> &'static str {
        match self {
            Self::Arm64 => nip::LINUX_ARM64_BASH_TARGET,
            Self::X86_64 => nip::LINUX_X86_64_BASH_TARGET,
        }
    }
}

#[test]
fn ssh_bash_targets_require_linux_and_x86_64_requires_glibc_236_or_newer() {
    let parse = |value: &str| RemoteBashTarget::parse("tag", value.as_bytes());
    assert_eq!(
        parse("user greeting\ntag\tLinux aarch64\t\n"),
        Ok(RemoteBashTarget::Arm64)
    );
    for release in ["2.36", "2.38"] {
        assert_eq!(
            parse(&format!(
                "greeting\ntag\tLinux x86_64\tglibc {release}\nmore output\n"
            )),
            Ok(RemoteBashTarget::X86_64)
        );
    }
    for output in [
        "Linux x86_64\tglibc 2.36\n",
        "tag\tLinux x86_64\t\n",
        "tag\tLinux x86_64\tglibc 2.35\n",
        "tag\tLinux x86_64\tmusl 1.2.5\n",
        "tag\tLinux i686\tglibc 2.36\n",
        "tag\tDarwin x86_64\t\n",
        "tag\tLinux x86_64\tglibc 2.36\ntag\tLinux aarch64\t\n",
    ] {
        assert_eq!(parse(output), Err(UNSUPPORTED_PROFILE.into()), "{output:?}");
    }
}

enum RemoteShellStartup {
    Bash,
    PrivateBash,
    Zle,
}

pub(super) struct RemoteNativeBash {
    pub profile: VerifiedNativeProfile,
    pub control: Channel,
    pub active: bool,
    decoder: nip::Decoder,
    relay_boundary: Option<RelayBoundary>,
    root: String,
    executable: String,
    startup: RemoteShellStartup,
}

struct RelayBoundary {
    marker: Vec<u8>,
    prefix: Vec<u8>,
}

impl RelayBoundary {
    fn push(&mut self, bytes: &[u8]) -> Result<Option<&[u8]>, String> {
        const MAX_PREAMBLE_BYTES: usize = 8_192;
        self.prefix.extend_from_slice(bytes);
        if let Some(index) = self
            .prefix
            .windows(self.marker.len())
            .position(|part| part == self.marker)
        {
            if index <= MAX_PREAMBLE_BYTES {
                return Ok(Some(&self.prefix[index + self.marker.len()..]));
            }
        } else if self.prefix.len() < MAX_PREAMBLE_BYTES + self.marker.len() {
            return Ok(None);
        }
        Err("TERMINAL_NATIVE_RELAY_PREAMBLE_INVALID".into())
    }
}

fn start_native_relay(session: &Session, root: &str) -> Result<(Channel, RelayBoundary), String> {
    let tag = format!("shellspan-relay-{}", Uuid::new_v4().simple());
    let mut channel = session
        .channel_session()
        .map_err(|_| "TERMINAL_NATIVE_CONTROL_UNAVAILABLE")?;
    channel
        .handle_extended_data(ExtendedData::Ignore)
        .map_err(|_| "TERMINAL_NATIVE_CONTROL_UNAVAILABLE")?;
    channel
        .exec(&format!(
            "builtin printf '\\n%s\\n' '{tag}' && exec {} {}",
            quote_remote_posix(&format!("{root}/relay")),
            quote_remote_posix(&format!("{root}/control")),
        ))
        .map_err(|_| "TERMINAL_NATIVE_CONTROL_UNAVAILABLE")?;
    Ok((
        channel,
        RelayBoundary {
            marker: format!("\n{tag}\n").into_bytes(),
            prefix: Vec::new(),
        },
    ))
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
        let target = RemoteBashTarget::detect(session)?;
        let sftp = session
            .sftp()
            .map_err(|_| "TERMINAL_NATIVE_SFTP_UNAVAILABLE")?;
        let system_shell_sha = if target == RemoteBashTarget::Arm64 {
            Some(remote_sha(&sftp, &identity.executable)?)
        } else {
            None
        };
        let artifact = artifacts::read_catalogue(resources, target.catalogue())?
            .into_iter()
            // The x86_64 catalogue only admits the fixed 5.3/8.3.6 profile.
            .find(|artifact| {
                system_shell_sha
                    .as_ref()
                    .is_none_or(|sha| artifact.shell_sha256 == *sha)
            })
            .ok_or("TERMINAL_NATIVE_PROFILE_UNSUPPORTED")?;
        let module = resources.join(&artifact.module);
        let relay = resources.join(&artifact.relay);
        if file_sha(&module)? != artifact.module_sha256
            || file_sha(&relay)? != artifact.relay_sha256
        {
            return Err("TERMINAL_NATIVE_PROFILE_ARTIFACT_MISMATCH".into());
        }
        let private_shell = if target == RemoteBashTarget::X86_64 {
            let bytes = std::fs::read(resources.join(&artifact.id).join("bash"))
                .map_err(|_| "TERMINAL_NATIVE_ARTIFACTS_UNAVAILABLE")?;
            if hex::encode(Sha256::digest(&bytes)) != artifact.shell_sha256 {
                return Err("TERMINAL_NATIVE_PROFILE_ARTIFACT_MISMATCH".into());
            }
            Some(bytes)
        } else {
            None
        };
        let root = format!("/tmp/.ss-nip-{}", Uuid::new_v4().simple());
        sftp.mkdir(Path::new(&root), 0o700)
            .map_err(|_| "TERMINAL_NATIVE_STARTUP_UNAVAILABLE")?;
        let result = (|| {
            let module_path = format!("{root}/adapter.so");
            let relay_path = format!("{root}/relay");
            let (executable, shell_sha, startup) = if let Some(bytes) = private_shell {
                let path = format!("{root}/bash");
                upload(&sftp, &path, &bytes, 0o500)?;
                let sha = remote_sha(&sftp, &path)?;
                (path, sha, RemoteShellStartup::PrivateBash)
            } else {
                (
                    identity.executable,
                    system_shell_sha.ok_or("TERMINAL_NATIVE_PROFILE_UNSUPPORTED")?,
                    RemoteShellStartup::Bash,
                )
            };
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
            let relay_readback = remote_sha_and_length(&sftp, &relay_path)?;
            if relay_readback.0 != artifact.relay_sha256 {
                return Err("TERMINAL_NATIVE_PROFILE_ARTIFACT_MISMATCH".into());
            }
            let module_readback = remote_sha_and_length(&sftp, &module_path)?;
            let profile = VerifiedNativeProfile::verify_remote(
                &artifact.id,
                &artifact.shell_sha256,
                &shell_sha,
                &module,
                &artifact.module_sha256,
                &module_readback.0,
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
            let init_path = format!("{root}/native-init");
            let init_readback = remote_sha_and_length(&sftp, &init_path)?;
            let init_expected = nip::sha(&bootstrap);
            if init_readback.0 != init_expected {
                return Err("TERMINAL_NATIVE_PROFILE_ARTIFACT_MISMATCH".into());
            }
            #[cfg(all(
                feature = "native-input-acceptance",
                debug_assertions,
                target_os = "macos",
                target_arch = "aarch64"
            ))]
            if crate::terminal_command::acceptance_trace::ssh_recovery_enabled() {
                for (path, mode, expected, (sha256, length)) in [
                    (
                        &module_path,
                        0o500,
                        &artifact.module_sha256,
                        &module_readback,
                    ),
                    (&relay_path, 0o500, &artifact.relay_sha256, &relay_readback),
                    (&init_path, 0o600, &init_expected, &init_readback),
                ] {
                    crate::terminal_command::acceptance_trace::record(
                        "ssh-sftp-verified-readback",
                        serde_json::json!({"path": path, "uploadedMode": format!("{mode:o}"),
                            "uploadSha256": expected, "readbackSha256": sha256, "readbackLength": length}),
                    )?;
                }
            }
            if matches!(startup, RemoteShellStartup::PrivateBash) {
                // Check the actual dynamic loader, terminal library and adapter
                // before starting a login shell or attaching a generation.
                run_ssh_setup_command(
                    session,
                    &format!(
                        "exec {} --noprofile --norc -p -c 'builtin enable -f \"$1\" ss_native_input ss_native_input_display_abi && builtin ss_native_input_display_abi' shellspan-native-check {}",
                        quote_remote_posix(&executable),
                        quote_remote_posix(&module_path),
                    ),
                )
                .map_err(|_| "TERMINAL_NATIVE_STARTUP_UNAVAILABLE")?;
            }
            let (control, boundary) = start_native_relay(session, &root)?;
            Ok(Self {
                profile,
                control,
                active: true,
                decoder: nip::Decoder::default(),
                relay_boundary: Some(boundary),
                root: root.clone(),
                executable,
                startup,
            })
        })();
        if result.is_err() {
            cleanup(&sftp, &root);
        }
        result.map(Some)
    }
    pub fn uses_private_bash(&self) -> bool {
        matches!(self.startup, RemoteShellStartup::PrivateBash)
    }
    pub fn start_shell(&self, channel: &mut Channel) -> Result<(), String> {
        if matches!(self.startup, RemoteShellStartup::Zle) {
            return channel
                .exec(&format!(
                    "{}\nexec env ZDOTDIR={} {} -il",
                    include_str!("zle-ssh-initial-zdotdir.zsh"),
                    quote_remote_posix(&self.root),
                    quote_remote_posix(&self.executable)
                ))
                .map_err(|_| "TERMINAL_NATIVE_SHELL_START_FAILED".into());
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
            let core_path = format!("{root}/scoped/zsh/zle.so");
            let module_path = format!("{root}/ss_nip.so");
            let relay_path = format!("{root}/relay");
            upload(
                &sftp,
                &core_path,
                &std::fs::read(&core).map_err(|_| "TERMINAL_NATIVE_SCOPED_CORE_UNAVAILABLE")?,
                0o500,
            )?;
            let core_readback = remote_sha_and_length(&sftp, &core_path)?;
            if core_readback.0 != *core_sha {
                return Err("TERMINAL_NATIVE_SCOPED_CORE_MISMATCH".into());
            }
            upload(
                &sftp,
                &module_path,
                &std::fs::read(&module).map_err(|_| "TERMINAL_NATIVE_ARTIFACTS_UNAVAILABLE")?,
                0o500,
            )?;
            upload(
                &sftp,
                &relay_path,
                &std::fs::read(resources.join(relay_name))
                    .map_err(|_| "TERMINAL_NATIVE_ARTIFACTS_UNAVAILABLE")?,
                0o500,
            )?;
            let module_readback = remote_sha_and_length(&sftp, &module_path)?;
            let relay_readback = remote_sha_and_length(&sftp, &relay_path)?;
            if module_readback.0 != artifact.module_sha256 || relay_readback.0 != *relay_sha {
                return Err("TERMINAL_NATIVE_PROFILE_ARTIFACT_MISMATCH".into());
            }
            #[cfg(all(
                feature = "native-input-acceptance",
                debug_assertions,
                target_os = "macos",
                target_arch = "aarch64"
            ))]
            if crate::terminal_command::acceptance_trace::ssh_recovery_enabled() {
                for (path, expected, (sha256, length)) in [
                    (&core_path, core_sha, &core_readback),
                    (&module_path, &artifact.module_sha256, &module_readback),
                    (&relay_path, relay_sha, &relay_readback),
                ] {
                    crate::terminal_command::acceptance_trace::record(
                        "ssh-sftp-verified-readback",
                        serde_json::json!({"path": path, "uploadedMode": "500",
                            "uploadSha256": expected, "readbackSha256": sha256, "readbackLength": length}),
                    )?;
                }
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
            let (control, boundary) = start_native_relay(session, &root)?;
            Ok(Self {
                profile,
                control,
                active: true,
                decoder: nip::Decoder::default(),
                relay_boundary: Some(boundary),
                root: root.clone(),
                executable: identity.executable.clone(),
                startup: RemoteShellStartup::Zle,
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

    pub fn relay_started(&self) -> bool {
        self.relay_boundary.is_none()
    }

    fn decode_control_bytes(&mut self, bytes: &[u8]) -> Result<Vec<nip::Message>, String> {
        let bytes = if let Some(boundary) = &mut self.relay_boundary {
            let Some(bytes) = boundary.push(bytes)? else {
                return Ok(Vec::new());
            };
            bytes
        } else {
            bytes
        };
        let messages = self
            .decoder
            .push(bytes)
            .map_err(|_| "TERMINAL_NATIVE_PROTOCOL_INVALID")?;
        self.relay_boundary = None;
        Ok(messages)
    }

    pub fn read_control(&mut self) -> Result<Option<Vec<nip::Message>>, String> {
        let mut bytes = [0; 8192];
        match self.control.read(&mut bytes) {
            Ok(0) if self.control.eof() => {
                self.decoder
                    .finish()
                    .map_err(|_| "TERMINAL_NATIVE_PARTIAL_FRAME_EOF")?;
                Err("TERMINAL_NATIVE_CONTROL_CLOSED".into())
            }
            Ok(0) => Ok(None),
            Ok(count) => self.decode_control_bytes(&bytes[..count]).map(Some),
            Err(error) if is_retryable_channel_error_kind(error.kind()) => Ok(None),
            Err(_) => Err("TERMINAL_NATIVE_CONTROL_UNAVAILABLE".into()),
        }
    }

    pub fn accept_message(
        app: &AppHandle,
        transport: &str,
        message: nip::Message,
    ) -> Result<(), String> {
        #[cfg(all(
            feature = "native-input-acceptance",
            debug_assertions,
            target_os = "macos",
            target_arch = "aarch64"
        ))]
        crate::terminal_command::acceptance_trace::observe_ssh_receipt(&message, transport)?;
        app.try_state::<crate::agent_runtime::AgentRuntime>()
            .ok_or("TERMINAL_NATIVE_RUNTIME_UNAVAILABLE")?
            .accept_native_terminal_message(transport, message)?;
        crate::commands::emit_terminal_integration_state(app, transport);
        Ok(())
    }

    pub fn drain(&mut self, app: &AppHandle, transport: &str) -> Result<bool, String> {
        if !self.active {
            return Ok(false);
        }
        let mut progress = false;
        for _ in 0..32 {
            let Some(messages) = self.read_control()? else {
                break;
            };
            progress = true;
            for message in messages {
                Self::accept_message(app, transport, message)?;
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
    remote_sha_and_length(sftp, path).map(|(sha, _)| sha)
}

fn remote_sha_and_length(sftp: &ssh2::Sftp, path: &str) -> Result<(String, u64), String> {
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
    Ok((hex::encode(digest.finalize()), total))
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
                        | "bash"
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
