fn main() {
    // Tauri enumerates bundle inputs even for clean Cargo/dev builds. This only
    // creates the directory; native:prepare owns resources and their manifest.
    let manifest_dir = std::path::PathBuf::from(
        std::env::var_os("CARGO_MANIFEST_DIR").expect("missing Cargo manifest directory"),
    );
    let native_resources = manifest_dir.join("target/native-input/generated");
    std::fs::create_dir_all(&native_resources)
        .expect("failed to create native resource staging directory");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        let launcher_manifest = native_resources.join("sandbox/launcher-manifest.json");
        println!("cargo:rerun-if-changed={}", launcher_manifest.display());
        if let Ok(raw) = std::fs::read_to_string(&launcher_manifest) {
            if let Some(sha) = extract_launcher_sha256(&raw) {
                println!("cargo:rustc-env=SHELLSPAN_MAC_SANDBOX_LAUNCHER_RELEASE_SHA256={sha}");
            }
        }
    }
    let windows_msvc = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    if windows_msvc {
        // Link the manifest into every executable, including Cargo's test
        // harnesses, so Common Controls v6 is available before process startup.
        // Tauri's resource-only manifest does not reach all test executables.
        let manifest = std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap())
            .join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
        tauri_build::try_build(
            tauri_build::Attributes::new()
                .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest()),
        )
        .expect("failed to build Windows application resources");
    } else {
        tauri_build::build();
    }
}

fn extract_launcher_sha256(manifest: &str) -> Option<&str> {
    let key_index = manifest.find("\"sha256\"")?;
    let rest = &manifest[key_index + "\"sha256\"".len()..];
    let colon = rest.find(':')?;
    let after_colon = rest[colon + 1..].trim_start();
    let quoted = after_colon.strip_prefix('"')?;
    let end = quoted.find('"')?;
    let sha = &quoted[..end];
    if sha.len() == 64 && sha.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Some(sha)
    } else {
        None
    }
}
