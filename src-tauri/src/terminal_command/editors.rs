//! Content-bound editor providers. A target/version string is never enough to
//! enable a provider; all producer inputs and the bound shell must match.
use super::{
    protocol as nip,
    registration::{file_sha, VerifiedNativeProfile},
};
use serde::Deserialize;
use std::{collections::HashMap, fs, path::Path};

pub(crate) const ZLE_ACCEPT_KEY: &[u8] = b"\x18\x1d";
pub(crate) const BASH_ACCEPT_KEY: &[u8] = b"\x18a";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct EditorArtifact {
    pub profile: nip::PeerProfile,
    pub shell_sha256: String,
    #[serde(default)]
    pub shell: Option<String>,
    pub module_sha256: String,
    pub module: String,
    #[serde(default)]
    pub editor_sha256: Option<String>,
    #[serde(default)]
    pub core: Option<String>,
    #[serde(default)]
    pub core_license: Option<String>,
    #[serde(default)]
    pub core_license_sha256: Option<String>,
    #[serde(default)]
    pub relay: Option<String>,
    #[serde(default)]
    pub relay_sha256: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Catalogue {
    version: u32,
    profiles: Vec<EditorArtifact>,
    sources: HashMap<String, String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AdmissionPolicy {
    version: u32,
    production_profiles: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ValidationAdmission {
    protocol: String,
    resource_root: String,
    source_manifest_sha256: String,
    editor_targets: Vec<String>,
}

fn validation_admitted(root: &Path, target: &str) -> bool {
    let check = (|| -> Option<bool> {
        let selected = std::env::var_os("SHELLSPAN_NATIVE_EDITOR_VALIDATION_ROOT")?;
        let actual = fs::canonicalize(root).ok()?;
        if fs::canonicalize(selected).ok()? != actual {
            return Some(false);
        }
        let source = fs::canonicalize(Path::new(env!("CARGO_MANIFEST_DIR")).parent()?).ok()?;
        if !actual.starts_with(&source) {
            return Some(false);
        }
        let snapshot: serde_json::Value = serde_json::from_slice(
            &fs::read(source.join(".artifacts/tests/native-input-p3/snapshot-index.json")).ok()?,
        )
        .ok()?;
        if fs::canonicalize(snapshot["root"].as_str()?).ok()? != source {
            return Some(false);
        }
        let index = fs::read(snapshot["index"].as_str()?).ok()?;
        use sha2::Digest;
        if hex::encode(sha2::Sha256::digest(index)) != snapshot["indexSha256"].as_str()? {
            return Some(false);
        }
        let manifest = fs::read(
            source.join(".artifacts/tests/native-input-p3/editor-validation-sources.json"),
        )
        .ok()?;
        let marker: ValidationAdmission =
            serde_json::from_slice(&fs::read(actual.join("editor-validation.json")).ok()?).ok()?;
        Some(
            marker.protocol == "shellspan.native-editor-validation"
                && fs::canonicalize(marker.resource_root).ok()? == actual
                && marker.source_manifest_sha256 == nip::sha(std::str::from_utf8(&manifest).ok()?)
                && marker.editor_targets.iter().any(|value| value == target),
        )
    })();
    check == Some(true)
}
pub(crate) fn validation_resource_root() -> Result<Option<std::path::PathBuf>, String> {
    let Some(selected) = std::env::var_os("SHELLSPAN_NATIVE_EDITOR_VALIDATION_ROOT") else {
        return Ok(None);
    };
    let root = std::path::PathBuf::from(selected);
    if !["macos-arm64", "linux-aarch64-glibc-2.36", "windows-x64"]
        .iter()
        .any(|target| validation_admitted(&root, target))
    {
        return Err("TERMINAL_NATIVE_VALIDATION_CONTEXT_INVALID".into());
    }
    fs::canonicalize(root)
        .map(Some)
        .map_err(|_| "TERMINAL_NATIVE_VALIDATION_CONTEXT_INVALID".into())
}
pub(crate) fn read_catalogue(root: &Path, target: &str) -> Result<Vec<EditorArtifact>, String> {
    let bytes = fs::read(root.join(format!("editors-{target}.json")))
        .map_err(|_| "TERMINAL_NATIVE_ARTIFACTS_UNAVAILABLE")?;
    if bytes.len() > 1_048_576 {
        return Err("TERMINAL_NATIVE_MANIFEST_LIMIT".into());
    }
    let catalogue: Catalogue =
        serde_json::from_slice(&bytes).map_err(|_| "TERMINAL_NATIVE_MANIFEST_INVALID")?;
    if catalogue.version != 1 || catalogue.profiles.len() > 8 {
        return Err("TERMINAL_NATIVE_MANIFEST_INVALID".into());
    }
    for (path, contents) in [
        (
            "src-tauri/native-input-editors/Cargo.toml",
            include_str!("../../native-input-editors/Cargo.toml"),
        ),
        (
            "src-tauri/native-input-editors/Cargo.lock",
            include_str!("../../native-input-editors/Cargo.lock"),
        ),
        (
            "src-tauri/native-input-editors/src/lib.rs",
            include_str!("../../native-input-editors/src/lib.rs"),
        ),
        (
            "src-tauri/native-input-editors/src/ffi.rs",
            include_str!("../../native-input-editors/src/ffi.rs"),
        ),
        (
            "src-tauri/native-input-editors/zle.c",
            include_str!("../../native-input-editors/zle.c"),
        ),
        (
            "src-tauri/native-input-editors/zle.zsh",
            include_str!("../../native-input-editors/zle.zsh"),
        ),
        (
            "src-tauri/native-input-editors/psreadline.cs",
            include_str!("../../native-input-editors/psreadline.cs"),
        ),
        (
            "src-tauri/native-input-editors/psreadline.ps1",
            include_str!("../../native-input-editors/psreadline.ps1"),
        ),
        (
            "src-tauri/src/terminal_command/protocol.rs",
            include_str!("protocol.rs"),
        ),
        (
            "src-tauri/src/terminal_jobs.rs",
            include_str!("../terminal_jobs.rs"),
        ),
        (
            "src-tauri/src/terminal_jobs.ps1",
            include_str!("../terminal_jobs.ps1"),
        ),
        (
            "src-tauri/src/terminal_job_host.cs",
            include_str!("../terminal_job_host.cs"),
        ),
        (
            "src-tauri/src/terminal_console_signals.cs",
            include_str!("../terminal_console_signals.cs"),
        ),
    ] {
        if catalogue.sources.get(path) != Some(&nip::sha(contents)) {
            return Err("TERMINAL_NATIVE_STALE_ARTIFACTS".into());
        }
    }
    if target == "windows-x64"
        && catalogue
            .sources
            .get("src-tauri/resources/powershell/PSReadLine/2.4.5/ShellSpan.Build.json")
            != Some(&nip::sha(include_str!(
                "../../resources/powershell/PSReadLine/2.4.5/ShellSpan.Build.json"
            )))
    {
        return Err("TERMINAL_NATIVE_STALE_ARTIFACTS".into());
    }
    if target == "windows-x64"
        && catalogue
            .sources
            .get("src-tauri/resources/conpty/1.25.260930003/pin.json")
            != Some(&nip::sha(include_str!(
                "../../resources/conpty/1.25.260930003/pin.json"
            )))
    {
        return Err("TERMINAL_NATIVE_STALE_ARTIFACTS".into());
    }
    if target == "macos-arm64" {
        for (path, contents) in [
            (
                "scripts/native-input-p3/build.mjs",
                include_str!("../../../scripts/native-input-p3/build.mjs"),
            ),
            (
                "scripts/native-input-p3/zsh-build-check.c",
                include_str!("../../../scripts/native-input-p3/zsh-build-check.c"),
            ),
        ] {
            if catalogue.sources.get(path) != Some(&nip::sha(contents)) {
                return Err("TERMINAL_NATIVE_STALE_ARTIFACTS".into());
            }
        }
    }
    if target == "linux-aarch64-glibc-2.36" {
        for (path, contents) in [
            (
                "src-tauri/native-input-adapter/Cargo.toml",
                include_str!("../../native-input-adapter/Cargo.toml"),
            ),
            (
                "src-tauri/native-input-adapter/Cargo.lock",
                include_str!("../../native-input-adapter/Cargo.lock"),
            ),
            (
                "src-tauri/native-input-adapter/src/bin/native-input-relay.rs",
                include_str!("../../native-input-adapter/src/bin/native-input-relay.rs"),
            ),
            (
                "scripts/native-input-p3/linux-build.sh",
                include_str!("../../../scripts/native-input-p3/linux-build.sh"),
            ),
            (
                "scripts/native-input-p3/publish-linux.py",
                include_str!("../../../scripts/native-input-p3/publish-linux.py"),
            ),
            (
                "scripts/native-input-p3/zsh-build-check.c",
                include_str!("../../../scripts/native-input-p3/zsh-build-check.c"),
            ),
        ] {
            if catalogue.sources.get(path) != Some(&nip::sha(contents)) {
                return Err("TERMINAL_NATIVE_STALE_ARTIFACTS".into());
            }
        }
    }
    for artifact in &catalogue.profiles {
        if target == "windows-x64"
            && artifact.editor_sha256.as_ref().is_none_or(|value| {
                value.len() != 64 || !value.bytes().all(|b| b.is_ascii_hexdigit())
            })
        {
            return Err("TERMINAL_NATIVE_MANIFEST_INVALID".into());
        }
        let id = artifact
            .profile
            .verified_profile_id
            .as_deref()
            .ok_or("TERMINAL_NATIVE_MANIFEST_INVALID")?;
        // All artifact names below derive from one portable profile component.
        // Reject traversal/absolute/separator forms before any artifact I/O.
        let mut components = Path::new(id).components();
        if !matches!(components.next(),Some(std::path::Component::Normal(value))if value==std::ffi::OsStr::new(id))
            || components.next().is_some()
            || id
                .as_bytes()
                .first()
                .is_none_or(|value| !value.is_ascii_alphanumeric())
            || !id
                .bytes()
                .all(|value| value.is_ascii_alphanumeric() || value == b'.' || value == b'-')
        {
            return Err("TERMINAL_NATIVE_MANIFEST_INVALID".into());
        }
        if let Some(core) = &artifact.core {
            if artifact.profile.shell != nip::ShellFamily::Zsh
                || artifact.profile.editor != nip::EditorFamily::Zle
                || core != &format!("{id}/zle.so")
                || artifact.editor_sha256.as_ref().is_none_or(|value| {
                    value.len() != 64 || !value.bytes().all(|b| b.is_ascii_hexdigit())
                })
                || artifact.core_license.as_deref() != Some(format!("{id}/LICENCE.zsh").as_str())
                || artifact.core_license_sha256.as_ref().is_none_or(|value| {
                    value.len() != 64 || !value.bytes().all(|b| b.is_ascii_hexdigit())
                })
            {
                return Err("TERMINAL_NATIVE_MANIFEST_INVALID".into());
            }
            for (path, contents) in [
                (
                    "scripts/dependency-builds/zsh/pin.json",
                    include_str!("../../../scripts/dependency-builds/zsh/pin.json"),
                ),
                (
                    "scripts/dependency-builds/zsh/native-display.patch",
                    include_str!("../../../scripts/dependency-builds/zsh/native-display.patch"),
                ),
                (
                    "scripts/native-input-p3/build-scoped-core.mjs",
                    include_str!("../../../scripts/native-input-p3/build-scoped-core.mjs"),
                ),
            ] {
                if catalogue.sources.get(path) != Some(&nip::sha(contents)) {
                    return Err("TERMINAL_NATIVE_STALE_ARTIFACTS".into());
                }
            }
            if target == "macos-arm64"
                && (artifact.shell.as_deref() != Some(format!("{id}/zsh").as_str())
                    || artifact.shell_sha256
                        != super::registration::mac_zle_pin("privateMainSha256")?
                    || catalogue
                        .sources
                        .get("scripts/dependency-builds/zsh/native-history.patch")
                        != Some(&nip::sha(include_str!(
                            "../../../scripts/dependency-builds/zsh/native-history.patch"
                        )))
                    || catalogue
                        .sources
                        .get("scripts/dependency-builds/zsh/native-macos-refresh.patch")
                        != Some(&nip::sha(include_str!(
                            "../../../scripts/dependency-builds/zsh/native-macos-refresh.patch"
                        ))))
            {
                return Err("TERMINAL_NATIVE_MANIFEST_INVALID".into());
            }
        } else if artifact.core_license.is_some() || artifact.core_license_sha256.is_some() {
            return Err("TERMINAL_NATIVE_MANIFEST_INVALID".into());
        }
        if let Some(shell) = &artifact.shell {
            if target != "macos-arm64"
                || artifact.core.is_none()
                || artifact.profile.shell != nip::ShellFamily::Zsh
                || shell != &format!("{id}/zsh")
            {
                return Err("TERMINAL_NATIVE_MANIFEST_INVALID".into());
            }
            let path = root.join(shell);
            if fs::symlink_metadata(&path)
                .map_err(|_| "TERMINAL_NATIVE_ARTIFACTS_UNAVAILABLE")?
                .file_type()
                .is_symlink()
                || file_sha(&path)? != artifact.shell_sha256
            {
                return Err("TERMINAL_NATIVE_PROFILE_ARTIFACT_MISMATCH".into());
            }
        }
        let extension = if target == "windows-x64" {
            "shellspan_native_input_editors.dll"
        } else {
            "ss_nip.so"
        };
        if !id.contains(target) || artifact.module != format!("{id}/{extension}") {
            return Err("TERMINAL_NATIVE_MANIFEST_INVALID".into());
        }
    }
    let policy: AdmissionPolicy = serde_json::from_str(include_str!(
        "../../../protocol/agent/runtime/native-editor-admission.json"
    ))
    .map_err(|_| "TERMINAL_NATIVE_ADMISSION_INVALID")?;
    if policy.version != 1 {
        return Err("TERMINAL_NATIVE_ADMISSION_INVALID".into());
    }
    if !catalogue.profiles.iter().all(|artifact| {
        artifact
            .profile
            .verified_profile_id
            .as_ref()
            .is_some_and(|id| policy.production_profiles.contains(id))
    }) && !validation_admitted(root, target)
    {
        return Err("TERMINAL_NATIVE_PROFILE_NOT_ACCEPTED".into());
    }
    Ok(catalogue.profiles)
}
pub(crate) fn verify(
    artifact: &EditorArtifact,
    shell: &Path,
    module: &Path,
) -> Result<VerifiedNativeProfile, String> {
    VerifiedNativeProfile::verify_editor(
        &artifact.profile,
        &artifact.shell_sha256,
        &file_sha(shell)?,
        module,
        &artifact.module_sha256,
    )
}
#[cfg(all(test, target_os = "macos", target_arch = "aarch64"))]
pub(crate) fn local_zle_shell(root: &Path) -> Result<std::path::PathBuf, String> {
    let artifact = read_catalogue(root, "macos-arm64")?
        .into_iter()
        .find(|artifact| artifact.profile.shell == nip::ShellFamily::Zsh)
        .ok_or("TERMINAL_NATIVE_PROFILE_UNSUPPORTED")?;
    artifact
        .shell
        .map(|path| root.join(path))
        .ok_or_else(|| "TERMINAL_NATIVE_PROFILE_UNSUPPORTED".into())
}
pub(crate) fn zle_bootstrap(
    module: &Path,
    socket: &Path,
    shell: &Path,
    profile: &nip::PeerProfile,
) -> Result<String, String> {
    let quote = |path: &Path| {
        shlex::try_quote(path.to_str().ok_or("TERMINAL_NATIVE_PATH_INVALID")?)
            .map(|v| v.into_owned())
            .map_err(|_| "TERMINAL_NATIVE_PATH_INVALID")
    };
    let json = serde_json::to_string(profile).map_err(|_| "TERMINAL_NATIVE_PROFILE_UNSUPPORTED")?;
    let quoted = shlex::try_quote(&json).map_err(|_| "TERMINAL_NATIVE_PROFILE_UNSUPPORTED")?;
    Ok(format!("[[ ! -o allexport ]] || return\ntypeset -ga __shellspan_nip_module_path=(\"${{module_path[@]}}\")\nmodule_path=({} \"${{module_path[@]}}\")\nzmodload ss_nip\nmodule_path=(\"${{__shellspan_nip_module_path[@]}}\")\nunset __shellspan_nip_module_path\ntypeset -gr __shellspan_nip_parser={}\ntypeset -g __shellspan_control_path={}\n{}\n__shellspan_emit() {{\n case \"$1\" in\n B) builtin ss_nip job-observation \"$2\" \"$3\" \"${{4:--}}\" ;;\n F) builtin ss_nip job-observation \"$2\" finished \"$3\" ;;\n esac\n}}\nif [[ $ZSH_VERSION == 5.9 && -o multibyte ]] && builtin ss_nip open {} {} 1; then\n{}\nfi\n",quote(module.parent().ok_or("TERMINAL_NATIVE_PATH_INVALID")?)?,quote(shell)?,quote(socket)?,crate::terminal_jobs::POSIX_HELPERS,quote(socket)?,quoted,include_str!("../../native-input-editors/zle.zsh")))
}
