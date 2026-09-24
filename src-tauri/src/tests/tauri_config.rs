use serde_json::Value;

// The identifier decides where Tauri resolves app_log_dir(): release keeps the
// stable identity (updater artifacts, signing, log paths), while `tauri dev`
// merges the dev override so debug builds log to a separate directory instead
// of rotating out release logs under the shared KeepSome(10) pool.
#[test]
fn release_config_keeps_stable_identifier() {
    let config: Value = serde_json::from_str(include_str!("../../tauri.conf.json"))
        .expect("tauri.conf.json parses");
    assert_eq!(config["identifier"].as_str(), Some("com.shellspan"));
}

#[test]
fn dev_config_separates_log_identifier() {
    let config: Value = serde_json::from_str(include_str!("../../tauri.dev.conf.json"))
        .expect("tauri.dev.conf.json parses");
    assert_eq!(config["identifier"].as_str(), Some("com.shellspan-dev"));
}
