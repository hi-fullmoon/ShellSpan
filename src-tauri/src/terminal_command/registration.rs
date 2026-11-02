use super::protocol::{self as nip, EditorFamily, PeerProfile, ShellFamily};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::Read;
use std::path::Path;

/// Constructed by a trusted local loader from its pinned build manifest, never
/// from frontend JSON or from a peer's self-reported shell name/version.
#[derive(Debug, Clone)]
pub(crate) struct VerifiedNativeProfile {
    profile_id: String,
    shell_sha: String,
    module_sha: String,
    editor_profile: Option<PeerProfile>,
    scoped_editor_sha: Option<String>,
}
impl VerifiedNativeProfile {
    pub(crate) fn verify_remote(
        profile_id: &str,
        expected_shell_sha: &str,
        actual_shell_sha: &str,
        module: &Path,
        expected_module_sha: &str,
        actual_module_sha: &str,
    ) -> Result<Self, String> {
        if !profile_id.contains("linux-aarch64-glibc-2.36")
            || nip::native_profile_versions(profile_id).is_none()
        {
            return Err("TERMINAL_NATIVE_PROFILE_UNSUPPORTED".into());
        }
        if expected_shell_sha != actual_shell_sha
            || expected_module_sha != actual_module_sha
            || file_sha(module)? != expected_module_sha
        {
            return Err("TERMINAL_NATIVE_PROFILE_ARTIFACT_MISMATCH".into());
        }
        Ok(Self {
            profile_id: profile_id.into(),
            shell_sha: actual_shell_sha.into(),
            module_sha: actual_module_sha.into(),
            editor_profile: None,
            scoped_editor_sha: None,
        })
    }
    pub fn verify_local(
        profile_id: &str,
        shell: &Path,
        expected_shell_sha: &str,
        module: &Path,
        expected_module_sha: &str,
    ) -> Result<Self, String> {
        let local_target = if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
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
        let test_prototype = cfg!(all(test, target_os = "macos", target_arch = "aarch64"))
            && profile_id == nip::VERIFIED_PROFILE;
        if !test_prototype
            && (!profile_id.contains(local_target)
                || nip::native_profile_versions(profile_id).is_none())
        {
            return Err("TERMINAL_NATIVE_PROFILE_UNSUPPORTED".into());
        }
        let shell_sha = file_sha(shell)?;
        let module_sha = file_sha(module)?;
        if shell_sha != expected_shell_sha || module_sha != expected_module_sha {
            return Err("TERMINAL_NATIVE_PROFILE_ARTIFACT_MISMATCH".into());
        }
        Ok(Self {
            profile_id: profile_id.into(),
            shell_sha,
            module_sha,
            editor_profile: None,
            scoped_editor_sha: None,
        })
    }
    pub fn matches(&self, profile: &PeerProfile) -> bool {
        if let Some(expected) = &self.editor_profile {
            return expected == profile
                && !self.shell_sha.is_empty()
                && !self.module_sha.is_empty();
        }
        let versions = nip::native_profile_versions(&self.profile_id);
        #[cfg(test)]
        let versions = versions.or_else(|| {
            (self.profile_id == nip::VERIFIED_PROFILE).then_some(("5.3", "8.3.6", 0x0803))
        });
        let Some((bash, _readline, numeric)) = versions else {
            return false;
        };
        !self.shell_sha.is_empty()
            && !self.module_sha.is_empty()
            && profile.verified_profile_id.as_deref() == Some(self.profile_id.as_str())
            && profile.shell == ShellFamily::Bash
            && profile
                .shell_version
                .as_ref()
                .is_some_and(|value| value.starts_with(&format!("{bash}.")))
            && profile.editor == EditorFamily::Readline
            && profile.editor_numeric_version == numeric
            && profile
                .editor_version
                .as_ref()
                .is_some_and(|value| nip::native_editor_version_matches(numeric, value))
            && profile.adapter_version == "1"
    }
    pub fn capture_fence(&self) -> bool {
        self.editor_profile.is_some() || nip::native_profile_versions(&self.profile_id).is_some()
    }
    pub fn supports_jobs(&self) -> bool {
        self.editor_profile.is_none() && self.capture_fence()
    }
    pub(crate) fn verify_editor(
        profile: &PeerProfile,
        expected_shell_sha: &str,
        actual_shell_sha: &str,
        module: &Path,
        expected_module_sha: &str,
    ) -> Result<Self, String> {
        let id = profile
            .verified_profile_id
            .as_deref()
            .ok_or("TERMINAL_NATIVE_PROFILE_UNSUPPORTED")?;
        let supported = match (profile.shell, profile.editor) {
            (ShellFamily::Zsh, EditorFamily::Zle) => profile.shell_version.as_deref() == Some("5.9")
                && profile.editor_version.as_deref() == Some("5.9") && profile.editor_numeric_version == 509
                && ["zsh-5.9-zle-5.9-macos-arm64-native", "zsh-5.9-zle-5.9-linux-aarch64-glibc-2.36-native"].contains(&id),
            (ShellFamily::WindowsPowerShell, EditorFamily::PsReadLine) => profile.shell_version.as_deref() == Some("5.1.26100.9711")
                && profile.editor_version.as_deref() == Some("2.4.5") && profile.editor_numeric_version == 20405
                && id == "windows-powershell-5.1.26100.9711-psreadline-2.4.5-windows-x64-native",
            (ShellFamily::PowerShell7, EditorFamily::PsReadLine) => profile.shell_version.as_deref() == Some("7.6.9")
                && profile.editor_version.as_deref() == Some("2.4.5") && profile.editor_numeric_version == 20405
                && id == "powershell-7.6.9-psreadline-2.4.5-windows-x64-native",
            _ => false,
        };
        if !supported
            || profile.adapter_version != "1"
            || expected_shell_sha != actual_shell_sha
            || file_sha(module)? != expected_module_sha
        {
            return Err("TERMINAL_NATIVE_PROFILE_ARTIFACT_MISMATCH".into());
        }
        Ok(Self {
            profile_id: id.into(),
            shell_sha: actual_shell_sha.into(),
            module_sha: expected_module_sha.into(),
            editor_profile: Some(profile.clone()),
            scoped_editor_sha: None,
        })
    }
    /// Presentation metadata comes from the exact locally bound Core, never
    /// from the peer's claims, frontend state or an OSC display packet.
    pub(crate) fn bind_scoped_zle_core(mut self, core: &Path) -> Result<Self, String> {
        let expected = match self.profile_id.as_str() {
            "zsh-5.9-zle-5.9-macos-arm64-native" => {
                "cc7f4263d1650d51ca82aead721c11409938f4808f967d4bf3c6709036533b84"
            }
            "zsh-5.9-zle-5.9-linux-aarch64-glibc-2.36-native" => {
                "c9e451bd49ad6481872af4a0b069719abc5083e7c2a03c8973b2d5e718186404"
            }
            _ => return Err("TERMINAL_NATIVE_SCOPED_CORE_MISMATCH".into()),
        };
        if self.editor_profile.as_ref().is_none_or(|profile| {
            profile.shell != ShellFamily::Zsh || profile.editor != EditorFamily::Zle
        }) || std::fs::symlink_metadata(core)
            .map_err(|_| "TERMINAL_NATIVE_SCOPED_CORE_UNAVAILABLE")?
            .file_type()
            .is_symlink()
            || file_sha(core)? != expected
        {
            return Err("TERMINAL_NATIVE_SCOPED_CORE_MISMATCH".into());
        }
        self.scoped_editor_sha = Some(expected.into());
        Ok(self)
    }
    pub(crate) fn display_binding(&self) -> nip::DisplayBinding {
        let mut binding = nip::DisplayBinding::native();
        if self.scoped_editor_sha.is_some() {
            binding.unicode_version = Some(nip::DisplayUnicodeVersion::Unicode11);
            binding.owned_reflow_cursor_line = Some(true);
        }
        binding
    }
    pub fn shell(&self) -> crate::terminal_integration::TerminalShellKind {
        use crate::terminal_integration::TerminalShellKind as Kind;
        match self.editor_profile.as_ref().map(|p| p.shell) {
            Some(ShellFamily::Zsh) => Kind::Zsh,
            Some(ShellFamily::WindowsPowerShell) => Kind::WindowsPowerShell,
            Some(ShellFamily::PowerShell7) => Kind::PowerShell7,
            _ => Kind::Bash,
        }
    }
}
pub(crate) fn shell_family(
    shell: crate::terminal_integration::TerminalShellKind,
) -> Result<ShellFamily, String> {
    use crate::terminal_integration::TerminalShellKind as Kind;
    match shell {
        Kind::Bash => Ok(ShellFamily::Bash),
        Kind::Zsh => Ok(ShellFamily::Zsh),
        Kind::WindowsPowerShell => Ok(ShellFamily::WindowsPowerShell),
        Kind::PowerShell7 => Ok(ShellFamily::PowerShell7),
        Kind::Unsupported => Err("TERMINAL_NATIVE_PROFILE_UNSUPPORTED".into()),
    }
}
pub(crate) fn file_sha(path: &Path) -> Result<String, String> {
    let path =
        std::fs::canonicalize(path).map_err(|_| "TERMINAL_NATIVE_PROFILE_ARTIFACT_UNAVAILABLE")?;
    if !std::fs::metadata(&path)
        .map_err(|_| "TERMINAL_NATIVE_PROFILE_ARTIFACT_UNAVAILABLE")?
        .is_file()
    {
        return Err("TERMINAL_NATIVE_PROFILE_ARTIFACT_UNAVAILABLE".into());
    }
    let mut file = File::open(path).map_err(|_| "TERMINAL_NATIVE_PROFILE_ARTIFACT_UNAVAILABLE")?;
    let mut digest = Sha256::new();
    let mut bytes = [0; 65536];
    loop {
        let count = file
            .read(&mut bytes)
            .map_err(|_| "TERMINAL_NATIVE_PROFILE_ARTIFACT_UNAVAILABLE")?;
        if count == 0 {
            break;
        }
        digest.update(&bytes[..count]);
    }
    Ok(hex::encode(digest.finalize()))
}
