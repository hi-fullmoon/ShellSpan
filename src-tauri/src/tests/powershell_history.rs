use super::*;

#[test]
fn isolated_history_directory_refuses_file_or_link_replacement() {
    let artifacts =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../.artifacts/tests/powershell-history-policy");
    fs::create_dir_all(&artifacts).unwrap();
    let root = tempfile::tempdir_in(&artifacts).unwrap();
    let path = prepare_isolated_powershell_history_directory(root.path()).unwrap();
    assert_eq!(
        prepare_isolated_powershell_history_directory(root.path()).unwrap(),
        path
    );
    let other = tempfile::tempdir_in(&artifacts).unwrap();
    fs::write(other.path().join("shell-history"), "not a directory").unwrap();
    assert_eq!(
        prepare_isolated_powershell_history_directory(other.path()).unwrap_err(),
        "TERMINAL_HISTORY_ISOLATION_INVALID"
    );
}

#[cfg(windows)]
#[test]
fn actual_powershell_history_policy_preserves_owned_paths_and_rejects_escape_links() {
    use std::process::Command;
    let artifact_root =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../.artifacts/tests/powershell-history-policy");
    fs::create_dir_all(&artifact_root).unwrap();
    let modern = std::env::var_os("SHELLSPAN_TEST_PWSH")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("pwsh.exe"));
    for shell in [
        modern,
        PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join("System32/WindowsPowerShell/v1.0/powershell.exe"),
    ] {
        let fixture = tempfile::Builder::new()
            .prefix("owned user's history-")
            .tempdir_in(&artifact_root)
            .unwrap();
        let data = fixture.path().join("data");
        let outside = fixture.path().join("data-other");
        fs::create_dir_all(&data).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let history = prepare_isolated_powershell_history_directory(&data).unwrap();
        let fallback = history.join("default.txt");
        let custom = data.join("custom/命令 history.txt");
        let fresh = data.join("custom/fresh.txt");
        let external = outside.join("user.txt");
        let hard = data.join("custom/hard.txt");
        let junction = data.join("junction");
        fs::create_dir_all(custom.parent().unwrap()).unwrap();
        fs::write(&custom, "owned custom").unwrap();
        fs::write(&external, "outside sentinel").unwrap();
        fs::hard_link(&external, &hard).unwrap();
        let modules = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/powershell");
        let quote =
            |path: &Path| format!("'{}'", crate::portable_local_path(path).replace('\'', "''"));
        let setup=format!("[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)\nImport-Module PSReadLine -ErrorAction Stop\n$null=New-Item -ItemType Junction -Path {} -Target {} -ErrorAction Stop\n",quote(&junction),quote(&outside));
        let mut script = setup;
        let inputs = [
            ("custom", custom.clone(), true),
            ("new-owned", fresh, true),
            ("outside", external.clone(), false),
            ("prefix-escape", outside.join("more.txt"), false),
            ("directory", data.join("custom"), false),
            ("hardlink", hard, false),
            ("junction", junction.join("user.txt"), false),
        ];
        script.push_str("$records=@()\n");
        for (name, candidate, keep) in inputs {
            script.push_str(&format!("PSReadLine\\Set-PSReadLineOption -HistorySaveStyle SaveNothing -MaximumHistoryCount 7 -HistorySavePath {} -ErrorAction Stop\n",quote(&candidate)));
            script.push_str(&powershell_history_redirect(&data, &fallback));
            script.push_str(&format!("$o=PSReadLine\\Get-PSReadLineOption\n$records+=@{{name='{name}';path=[IO.Path]::GetFullPath($o.HistorySavePath);expected=[IO.Path]::GetFullPath({});maximum=$o.MaximumHistoryCount;style=[string]$o.HistorySaveStyle}}\n",quote(if keep{&candidate}else{&fallback})));
        }
        script.push_str(&format!("$null=New-Item -ItemType HardLink -Path {} -Target {} -ErrorAction Stop\n$blocked=$false\ntry {{\n",quote(&fallback),quote(&external)));
        script.push_str(&powershell_history_redirect(&data, &fallback));
        script.push_str("throw 'Unsafe fallback unexpectedly accepted'\n} catch { if ($_.Exception.Message -notlike '*TERMINAL_HISTORY_ISOLATION_INVALID*') { throw }; $blocked=$true }\nif(-not $blocked){throw 'Unsafe fallback was not refused'}\n[Console]::WriteLine((ConvertTo-Json -InputObject $records -Compress))\n");
        let file = fixture.path().join("policy.ps1");
        fs::write(&file, format!("\u{feff}{script}")).unwrap();
        let mut search = vec![PathBuf::from(
            crate::portable_local_path(&modules).replace('/', "\\"),
        )];
        if let Some(previous) = std::env::var_os("PSModulePath") {
            search.extend(std::env::split_paths(&previous));
        }
        let output = Command::new(&shell)
            .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-File"])
            .arg(&file)
            .env("HOME", fixture.path())
            .env("USERPROFILE", fixture.path())
            .env("PSModulePath", std::env::join_paths(search).unwrap())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "Host policy failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let records: serde_json::Value =
            serde_json::from_slice(&output.stdout).expect("Actual host policy JSON");
        assert_eq!(records.as_array().unwrap().len(), 7);
        for record in records.as_array().unwrap() {
            assert_eq!(record["path"], record["expected"], "{}", record["name"]);
            assert_eq!(record["maximum"], 7);
            assert_eq!(record["style"], "SaveNothing");
        }
        assert_eq!(fs::read_to_string(&external).unwrap(), "outside sentinel");
        assert_eq!(fs::read_to_string(&custom).unwrap(), "owned custom");
        assert_eq!(
            fs::read_to_string(&fallback).unwrap(),
            "outside sentinel",
            "Unsafe fallback was modified"
        );
        assert_eq!(
            prepare_isolated_powershell_history_directory(fixture.path()).unwrap(),
            fixture.path().join("shell-history")
        );
    }
}
