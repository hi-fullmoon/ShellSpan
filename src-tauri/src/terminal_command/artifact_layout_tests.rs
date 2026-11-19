use super::*;
use std::path::PathBuf;
use tauri::utils::resources::ResourcePaths;

#[test]
fn development_native_resources_match_the_package_input_and_keep_frozen_validation_isolated() {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
    let configured: HashMap<String, String> =
        serde_json::from_value(config["bundle"]["resources"].clone()).unwrap();
    let package_input = configured
        .iter()
        .find(|(_, target)| *target == &format!("{BUNDLE_RESOURCE_DIRECTORY}/"))
        .map(|(source, _)| manifest_dir.join(source))
        .expect("Native package resource mapping must exist");

    assert_eq!(
        development_resource_root(manifest_dir, false),
        package_input
    );
    assert_eq!(
        development_resource_root(manifest_dir, true),
        manifest_dir.join("../artifacts/tests/native-input/integration/resources/native-input")
    );
}

#[test]
fn native_package_frontend_directory_uses_the_actual_sdk_path_variant() {
    use tauri::utils::config::FrontendDist;
    let windows_absolute: FrontendDist = serde_json::from_str(r#""D:\\owned\\frontend""#).unwrap();
    assert!(matches!(windows_absolute, FrontendDist::Url(_)));
    let relative: FrontendDist = serde_json::from_str(r#""../artifacts/tests/frontend""#).unwrap();
    assert!(matches!(relative, FrontendDist::Directory(_)));
}

#[test]
fn native_resource_mapping_preserves_release_layout_without_stale_sources_or_build_logs() {
    let owner = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let evidence = owner.join("artifacts/tests/native-resource-layout");
    fs::create_dir_all(&evidence).unwrap();
    let directory = tempfile::tempdir_in(evidence).unwrap();
    let workspace = directory.path().join("workspace");
    let tauri = workspace.join("src-tauri");
    let generated = tauri.join("target/native-input/generated");
    fs::create_dir_all(tauri.join("resources/native-input/generated")).unwrap();
    fs::create_dir_all(&generated).unwrap();
    fs::write(tauri.join("resources/native-input/README.md"), b"notice").unwrap();
    fs::write(
        tauri.join("resources/native-input/generated/stale.bin"),
        b"stale",
    )
    .unwrap();
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
    let configured: HashMap<String, String> =
        serde_json::from_value(config["bundle"]["resources"].clone()).unwrap();
    assert_eq!(
        configured["target/native-input/generated/"],
        format!("{BUNDLE_RESOURCE_DIRECTORY}/")
    );
    let resources: HashMap<String, String> = configured
        .into_iter()
        .map(|(source, target)| (tauri.join(source).to_string_lossy().into_owned(), target))
        .collect();
    let empty = ResourcePaths::from_map(&resources, true)
        .iter()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(
        empty.len(),
        1,
        "An empty staging directory must need no fake manifest"
    );
    assert_eq!(empty[0].target(), Path::new("native-input/README.md"));
    assert!(!generated.join("resource-manifest.json").exists());

    fs::create_dir_all(generated.join("profile")).unwrap();
    fs::write(generated.join("resource-manifest.json"), b"manifest").unwrap();
    fs::write(generated.join("profile/module.dll"), b"verified-fixture").unwrap();
    fs::create_dir_all(generated.parent().unwrap().join("resource-build/previous")).unwrap();
    fs::write(
        generated
            .parent()
            .unwrap()
            .join("resource-build/prepare.log"),
        b"log",
    )
    .unwrap();
    let mapped = ResourcePaths::from_map(&resources, true)
        .iter()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(mapped.len(), 3);
    let bundle = directory.path().join("bundle");
    for resource in mapped {
        let target = bundle.join(resource.target());
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::copy(resource.path(), target).unwrap();
    }
    let loaded = bundle.join(BUNDLE_RESOURCE_DIRECTORY);
    assert_eq!(
        fs::read(loaded.join("profile/module.dll")).unwrap(),
        b"verified-fixture"
    );
    assert_eq!(
        fs::read(loaded.join("resource-manifest.json")).unwrap(),
        b"manifest"
    );
    assert!(!loaded.join("stale.bin").exists());
    assert!(!loaded.join("prepare.log").exists());
    assert!(!bundle.join("native-input/resource-build").exists());
}
