//! Distribution metadata is read from the application's trusted resource root,
//! never from frontend input or a remote peer's version report.
use serde::Deserialize;
use std::{collections::HashMap, fs, path::Path};

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
            "scripts/native-input-p2/build.py",
            include_str!("../../../scripts/native-input-p2/build.py"),
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
            "scripts/dependency-builds/bash-native/readline-columns-8.3.6.patch",
            include_str!(
                "../../../scripts/dependency-builds/bash-native/readline-columns-8.3.6.patch"
            ),
        ),
        (
            "scripts/native-input-p0/build.py",
            include_str!("../../../scripts/native-input-p0/build.py"),
        ),
        (
            "scripts/native-input-p0/readline-sources.json",
            include_str!("../../../scripts/native-input-p0/readline-sources.json"),
        ),
    ];
    if required_sources
        .iter()
        .any(|(name, source)| catalogue.sources.get(*name) != Some(&super::protocol::sha(source)))
    {
        return Err("TERMINAL_NATIVE_STALE_ARTIFACTS".into());
    }
    for artifact in &catalogue.profiles {
        let Some((bash, readline, _)) = super::protocol::native_profile_versions(&artifact.id)
        else {
            return Err("TERMINAL_NATIVE_MANIFEST_INVALID".into());
        };
        if artifact.target != target
            || artifact.bash_version != bash
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
pub(crate) fn resource_root(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    if let Some(root) = super::editors::validation_resource_root()? {
        return Ok(root);
    }
    if cfg!(debug_assertions) {
        Ok(std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../.artifacts/tests/native-input-p2/resources/native-input"))
    } else {
        app.path()
            .resource_dir()
            .map(|root| root.join("native-input/generated"))
            .map_err(|_| "TERMINAL_NATIVE_ARTIFACTS_UNAVAILABLE".into())
    }
}
