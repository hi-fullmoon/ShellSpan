//! Distribution metadata is read from the application's trusted resource root,
//! never from frontend input or a remote peer's version report.
use serde::Deserialize;
use std::{collections::HashMap, fs, path::Path};

pub(crate) const BUNDLE_RESOURCE_DIRECTORY: &str = "native-input/generated";
const MACOS_BASH_TARGET: &str = "macos-arm64";
const SHELLSPAN_BASH_PROFILE: &str = "gnu-bash-5.3-readline-8.3.6-macos-arm64-native";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Catalogue {
    version: u32,
    profiles: Vec<NativeArtifact>,
    sources: HashMap<String, String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeArtifact {
    pub id: String,
    pub target: String,
    pub bash_version: String,
    pub bash_patch_level: Option<u32>,
    pub readline_version: String,
    pub shell_sha256: String,
    pub module_sha256: String,
    pub module: String,
    pub build_shell: String,
    pub capture_fence: u32,
    pub readline_display_abi: u32,
    pub relay: String,
    pub relay_sha256: String,
}
pub(crate) fn read_catalogue(root: &Path, target: &str) -> Result<Vec<NativeArtifact>, String> {
    let bytes = fs::read(root.join(format!("catalogue-{target}.json")))
        .map_err(|_| "TERMINAL_NATIVE_ARTIFACTS_UNAVAILABLE")?;
    if bytes.len() > 1_048_576 {
        return Err("TERMINAL_NATIVE_MANIFEST_LIMIT".into());
    }
    let catalogue: Catalogue =
        serde_json::from_slice(&bytes).map_err(|_| "TERMINAL_NATIVE_MANIFEST_INVALID")?;
    if catalogue.version != 1 || catalogue.profiles.len() > 32 || catalogue.sources.is_empty() {
        return Err("TERMINAL_NATIVE_MANIFEST_INVALID".into());
    }
    let required_sources = [
        (
            "src-tauri/native-input-adapter/Cargo.toml",
            include_str!("../../native-input-adapter/Cargo.toml"),
        ),
        (
            "src-tauri/native-input-adapter/Cargo.lock",
            include_str!("../../native-input-adapter/Cargo.lock"),
        ),
        (
            "src-tauri/native-input-adapter/bridge.c",
            include_str!("../../native-input-adapter/bridge.c"),
        ),
        (
            "src-tauri/native-input-adapter/src/lib.rs",
            include_str!("../../native-input-adapter/src/lib.rs"),
        ),
        (
            "src-tauri/native-input-adapter/src/native_protocol.rs",
            include_str!("../../native-input-adapter/src/native_protocol.rs"),
        ),
        (
            "src-tauri/native-input-adapter/src/bin/native-input-relay.rs",
            include_str!("../../native-input-adapter/src/bin/native-input-relay.rs"),
        ),
        (
            "src-tauri/src/terminal_command/protocol.rs",
            include_str!("protocol.rs"),
        ),
        (
            "scripts/native-input/integration/build.py",
            include_str!("../../../scripts/native-input/integration/build.py"),
        ),
        (
            "scripts/native-input/integration/Dockerfile",
            include_str!("../../../scripts/native-input/integration/Dockerfile"),
        ),
        (
            "scripts/dependency-builds/bash-native/build.py",
            include_str!("../../../scripts/dependency-builds/bash-native/build.py"),
        ),
        (
            "scripts/dependency-builds/bash-native/startup-init-4.1.patch",
            include_str!("../../../scripts/dependency-builds/bash-native/startup-init-4.1.patch"),
        ),
        (
            "scripts/dependency-builds/bash-native/startup-init-4.4.patch",
            include_str!("../../../scripts/dependency-builds/bash-native/startup-init-4.4.patch"),
        ),
        (
            "scripts/dependency-builds/bash-native/startup-init-5.3.patch",
            include_str!("../../../scripts/dependency-builds/bash-native/startup-init-5.3.patch"),
        ),
        (
            "scripts/dependency-builds/bash-native/readline-columns-6.0.patch",
            include_str!(
                "../../../scripts/dependency-builds/bash-native/readline-columns-6.0.patch"
            ),
        ),
        (
            "scripts/dependency-builds/bash-native/readline-columns-7.0.patch",
            include_str!(
                "../../../scripts/dependency-builds/bash-native/readline-columns-7.0.patch"
            ),
        ),
        (
            "scripts/dependency-builds/bash-native/readline-paste-6.0.patch",
            include_str!("../../../scripts/dependency-builds/bash-native/readline-paste-6.0.patch"),
        ),
        (
            "scripts/dependency-builds/bash-native/darwin-headers-4.1.patch",
            include_str!("../../../scripts/dependency-builds/bash-native/darwin-headers-4.1.patch"),
        ),
        (
            "scripts/dependency-builds/bash-native/bash-bind-x-return-4.1.patch",
            include_str!(
                "../../../scripts/dependency-builds/bash-native/bash-bind-x-return-4.1.patch"
            ),
        ),
        (
            "scripts/dependency-builds/bash-native/readline-combining-wrap.patch",
            include_str!(
                "../../../scripts/dependency-builds/bash-native/readline-combining-wrap.patch"
            ),
        ),
        (
            "scripts/dependency-builds/bash-native/readline-resize-6.0.patch",
            include_str!(
                "../../../scripts/dependency-builds/bash-native/readline-resize-6.0.patch"
            ),
        ),
        (
            "scripts/dependency-builds/bash-native/readline-resize-7.0.patch",
            include_str!(
                "../../../scripts/dependency-builds/bash-native/readline-resize-7.0.patch"
            ),
        ),
        (
            "scripts/dependency-builds/bash-native/readline-columns-8.3.6.patch",
            include_str!(
                "../../../scripts/dependency-builds/bash-native/readline-columns-8.3.6.patch"
            ),
        ),
        (
            "scripts/native-input/prototype/build.py",
            include_str!("../../../scripts/native-input/prototype/build.py"),
        ),
        (
            "scripts/native-input/prototype/readline-sources.json",
            include_str!("../../../scripts/native-input/prototype/readline-sources.json"),
        ),
    ];
    if required_sources
        .iter()
        .any(|(name, source)| catalogue.sources.get(*name) != Some(&super::protocol::sha(source)))
    {
        return Err("TERMINAL_NATIVE_STALE_ARTIFACTS".into());
    }
    if target == super::protocol::LINUX_X86_64_BASH_TARGET {
        let recipe = "scripts/native-input/integration/Dockerfile.amd64";
        let contents = include_str!("../../../scripts/native-input/integration/Dockerfile.amd64");
        if catalogue.sources.get(recipe) != Some(&super::protocol::sha(contents)) {
            return Err("TERMINAL_NATIVE_STALE_ARTIFACTS".into());
        }
    }
    if target == MACOS_BASH_TARGET
        && catalogue
            .profiles
            .iter()
            .any(|artifact| artifact.id == SHELLSPAN_BASH_PROFILE)
    {
        let pin = "scripts/dependency-builds/bash-native/bash-5.3-patches.json";
        let contents =
            include_str!("../../../scripts/dependency-builds/bash-native/bash-5.3-patches.json");
        if catalogue.sources.get(pin) != Some(&super::protocol::sha(contents)) {
            return Err("TERMINAL_NATIVE_STALE_ARTIFACTS".into());
        }
    }
    for artifact in &catalogue.profiles {
        let Some((bash, readline, _)) = super::protocol::native_profile_versions(&artifact.id)
        else {
            return Err("TERMINAL_NATIVE_MANIFEST_INVALID".into());
        };
        if artifact.target != target
            || artifact.id != format!("gnu-bash-{bash}-readline-{readline}-{target}-native")
            || artifact.bash_version != bash
            || (artifact.id == SHELLSPAN_BASH_PROFILE && artifact.bash_patch_level != Some(20))
            || artifact.readline_version != readline
            || artifact.capture_fence != 1
            || artifact.readline_display_abi != 1
            || artifact.module != format!("{}/adapter.so", artifact.id)
            || artifact.relay != format!("{}/native-input-relay", artifact.id)
            || artifact.build_shell.is_empty()
            || [
                &artifact.shell_sha256,
                &artifact.module_sha256,
                &artifact.relay_sha256,
            ]
            .iter()
            .any(|value| value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        {
            return Err("TERMINAL_NATIVE_MANIFEST_INVALID".into());
        }
    }
    Ok(catalogue.profiles)
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
pub(crate) fn shellspan_bash(root: &Path) -> Result<std::path::PathBuf, String> {
    use std::os::unix::fs::PermissionsExt;

    let artifact = read_catalogue(root, MACOS_BASH_TARGET)?
        .into_iter()
        .find(|artifact| artifact.id == SHELLSPAN_BASH_PROFILE)
        .ok_or("TERMINAL_NATIVE_PROFILE_UNSUPPORTED")?;
    let shell = root.join(SHELLSPAN_BASH_PROFILE).join("bash");
    let metadata =
        fs::metadata(&shell).map_err(|_| "TERMINAL_NATIVE_PROFILE_ARTIFACT_UNAVAILABLE")?;
    if !metadata.is_file() || metadata.permissions().mode() & 0o111 == 0 {
        return Err("TERMINAL_NATIVE_PROFILE_ARTIFACT_UNAVAILABLE".into());
    }
    if super::registration::file_sha(&shell)? != artifact.shell_sha256 {
        return Err("TERMINAL_NATIVE_PROFILE_MISMATCH".into());
    }
    Ok(shell)
}

fn development_resource_root(manifest_dir: &Path, frozen_validation: bool) -> std::path::PathBuf {
    if frozen_validation {
        manifest_dir.join("../artifacts/tests/native-input-p2/resources/native-input")
    } else {
        manifest_dir.join("target/native-input/generated")
    }
}

pub(crate) fn resource_root(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    if let Some(root) = super::editors::validation_resource_root()? {
        return Ok(root);
    }
    if cfg!(debug_assertions) {
        // Frozen acceptance snapshots own a separate producer tree. Ordinary
        // development uses the same verified staging directory as packaging.
        Ok(development_resource_root(
            Path::new(env!("CARGO_MANIFEST_DIR")),
            std::env::var_os("SHELLSPAN_ACCEPTANCE_FROZEN_MANIFEST").is_some(),
        ))
    } else {
        app.path()
            .resource_dir()
            .map(|root| root.join(BUNDLE_RESOURCE_DIRECTORY))
            .map_err(|_| "TERMINAL_NATIVE_ARTIFACTS_UNAVAILABLE".into())
    }
}

#[cfg(test)]
#[path = "artifact_layout_tests.rs"]
mod layout_tests;
