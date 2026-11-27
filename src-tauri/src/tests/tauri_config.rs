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

#[test]
fn release_config_registers_shellspan_deep_link_scheme_across_platforms() {
    let config: Value = serde_json::from_str(include_str!("../../tauri.conf.json"))
        .expect("tauri.conf.json parses");
    assert_eq!(
        config["bundle"]["macOS"]["infoPlist"].as_str(),
        Some("Info.plist")
    );
    assert_eq!(
        config["bundle"]["windows"]["nsis"]["installerHooks"].as_str(),
        Some("windows/nsis-hooks.nsh")
    );
    assert_eq!(
        config["bundle"]["linux"]["deb"]["desktopTemplate"].as_str(),
        Some("linux/shellspan.desktop.hbs")
    );
    assert_eq!(
        config["bundle"]["linux"]["rpm"]["desktopTemplate"].as_str(),
        Some("linux/shellspan.desktop.hbs")
    );

    let info_plist = include_str!("../../Info.plist");
    assert!(info_plist.contains("<key>CFBundleURLSchemes</key>"));
    assert!(info_plist.contains("<string>shellspan</string>"));

    let nsis_hooks = include_str!("../../windows/nsis-hooks.nsh");
    assert!(nsis_hooks.contains("NSIS_HOOK_POSTINSTALL"));
    assert!(nsis_hooks.contains(r#"WriteRegStr HKCU "Software\Classes\shellspan""#));
    assert!(nsis_hooks.contains("NSIS_HOOK_POSTUNINSTALL"));
    assert!(nsis_hooks.contains(r#"DeleteRegKey HKCU "Software\Classes\shellspan""#));

    let desktop_template = include_str!("../../linux/shellspan.desktop.hbs");
    assert!(desktop_template.contains("Exec={{exec}} %u"));
    assert!(desktop_template.contains("MimeType=x-scheme-handler/shellspan;"));
}
