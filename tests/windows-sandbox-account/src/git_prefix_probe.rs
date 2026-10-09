//! Read-only fixed owned-path metadata comparison, matching Git's Win32 stat open.
use crate::appcontainer_probe::Handle;
use serde::Serialize;
use std::path::{Component, Path, PathBuf, Prefix};
use std::ptr::{null, null_mut};
use windows_sys::Win32::{Foundation::*, Storage::FileSystem::*};

#[derive(serde::Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DirectoryObservation {
    pub path: PathBuf,
    #[serde(deserialize_with = "required_nullable")]
    pub attributes: Option<u32>,
    #[serde(deserialize_with = "required_nullable")]
    pub attributes_error: Option<u32>,
    #[serde(deserialize_with = "required_nullable")]
    pub open_error: Option<u32>,
    #[serde(deserialize_with = "required_nullable")]
    pub metadata_error: Option<u32>,
    #[serde(deserialize_with = "required_nullable")]
    pub identity: Option<(u32, u64)>,
}
fn required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    serde::Deserialize::deserialize(deserializer)
}
pub fn child_report() -> Result<serde_json::Value, String> {
    use windows_sys::Win32::{Security::*, System::Threading::*};
    let mut raw = null_mut();
    if unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 1, &mut raw) } != 0 {
        drop(Handle(raw));
        return Err("Git prefix probe rejects impersonation".into());
    }
    if unsafe { GetLastError() } != ERROR_NO_TOKEN {
        return Err("Git prefix thread context unknown".into());
    }
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) } == 0 {
        return Err("Git prefix primary unavailable".into());
    }
    let token = Handle(raw);
    let elevation = unsafe { crate::appcontainer_probe::query(token.0, TokenElevation) }?;
    if unsafe { (*elevation.as_ptr().cast::<TOKEN_ELEVATION>()).TokenIsElevated } != 0 {
        return Err("Git prefix probe rejects elevated primary".into());
    }
    let root = PathBuf::from(
        std::env::var("SSPA_FIXTURE")
            .map_err(|_| "Git prefix fixture environment missing or invalid")?,
    );
    Ok(serde_json::json!({"version":1,"root":root,"observations":observe(&root)?}))
}
pub fn verify_delivery(text: &str, root: &Path) -> Result<(), String> {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Delivery {
        version: u32,
        root: PathBuf,
        observations: Vec<DirectoryObservation>,
    }
    if text.len() > 16384 {
        return Err("Git prefix delivery exceeds budget".into());
    }
    let value: Delivery = serde_json::from_str(text).map_err(|e| e.to_string())?;
    let output = root.join("output");
    let mut paths: Vec<_> = output.ancestors().collect();
    paths.reverse();
    if value.version != 1
        || value.root != root
        || value.observations.len() != paths.len()
        || paths.len() > 32
    {
        return Err("Git prefix delivery binding differs".into());
    }
    for (entry, expected) in value.observations.iter().zip(paths) {
        if entry.path != expected
            || entry.attributes.is_some() == entry.attributes_error.is_some()
            || entry.open_error.is_some()
                && (entry.identity.is_some() || entry.metadata_error.is_some())
            || entry.open_error.is_none()
                && entry.identity.is_some() == entry.metadata_error.is_some()
            || [
                entry.attributes_error,
                entry.open_error,
                entry.metadata_error,
            ]
            .into_iter()
            .flatten()
            .any(|code| code == 0)
        {
            return Err("Git prefix delivery observation invalid".into());
        }
    }
    Ok(())
}
pub fn observe(root: &Path) -> Result<Vec<DirectoryObservation>, String> {
    let id = root
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.strip_prefix("ShellSpan-AC-"))
        .and_then(|name| uuid::Uuid::parse_str(name).ok());
    if !root.is_absolute()
        || id.is_none_or(|id| id.is_nil())
        || !matches!(root.components().next(), Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_)))
        || root
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
    {
        return Err("Git prefix probe requires fixed local owned UUID root".into());
    }
    let output = root.join("output");
    let mut paths: Vec<_> = output.ancestors().map(Path::to_path_buf).collect();
    if paths.len() > 32 {
        return Err("Git prefix probe exceeds directory budget".into());
    }
    paths.reverse();
    let mut result = Vec::new();
    for path in paths {
        let text = path.to_str().ok_or("invalid Git prefix")?;
        let wide: Vec<_> = text.encode_utf16().chain(Some(0)).collect();
        if wide.len() > 32768 {
            return Err("Git prefix length exceeds budget".into());
        }
        let attributes = unsafe { GetFileAttributesW(wide.as_ptr()) };
        let attributes_error =
            (attributes == INVALID_FILE_ATTRIBUTES).then(|| unsafe { GetLastError() });
        let raw = unsafe {
            CreateFileW(
                wide.as_ptr(),
                0,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS,
                null_mut(),
            )
        };
        let open_error = (raw == INVALID_HANDLE_VALUE).then(|| unsafe { GetLastError() });
        let mut observation = DirectoryObservation {
            path,
            attributes: (attributes != INVALID_FILE_ATTRIBUTES).then_some(attributes),
            attributes_error,
            open_error,
            metadata_error: None,
            identity: None,
        };
        if raw != INVALID_HANDLE_VALUE {
            let held = Handle(raw);
            let mut info = BY_HANDLE_FILE_INFORMATION::default();
            if unsafe { GetFileInformationByHandle(held.0, &mut info) } == 0 {
                observation.metadata_error = Some(unsafe { GetLastError() });
            } else {
                observation.identity = Some((
                    info.dwVolumeSerialNumber,
                    (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
                ));
            }
        }
        result.push(observation);
    }
    Ok(result)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn delivery_rejects_missing_duplicate_and_contradictory_observations() {
        let root = Path::new(r"C:\owned\ShellSpan-AC-11111111111141118111111111111111");
        let mut observations: Vec<_> = root
            .join("output")
            .ancestors()
            .map(|path| {
                serde_json::json!({"path":path,"attributes":16,"attributes_error":null,
                "open_error":null,"metadata_error":null,"identity":[1,2]})
            })
            .collect();
        observations.reverse();
        let delivery = serde_json::json!({"version":1,"root":root,"observations":observations});
        assert!(verify_delivery(&delivery.to_string(), root).is_ok());
        for field in [
            "path",
            "attributes",
            "attributes_error",
            "open_error",
            "metadata_error",
            "identity",
        ] {
            let mut changed = delivery.clone();
            changed["observations"][0]
                .as_object_mut()
                .unwrap()
                .remove(field);
            assert!(
                verify_delivery(&changed.to_string(), root).is_err(),
                "missing {field}"
            );
        }
        let mut missing = delivery.clone();
        missing["observations"].as_array_mut().unwrap().pop();
        assert!(verify_delivery(&missing.to_string(), root).is_err());
        let mut duplicate = delivery.clone();
        duplicate["observations"][1] = duplicate["observations"][0].clone();
        assert!(verify_delivery(&duplicate.to_string(), root).is_err());
        for (field, value) in [
            ("attributes_error", serde_json::json!(5)),
            ("open_error", serde_json::json!(5)),
            ("metadata_error", serde_json::json!(5)),
            ("identity", serde_json::Value::Null),
            ("attributes", serde_json::Value::Null),
        ] {
            let mut changed = delivery.clone();
            changed["observations"][0][field] = value;
            assert!(
                verify_delivery(&changed.to_string(), root).is_err(),
                "{field}"
            );
        }
        // Attribute lookup and handle opening are independent calls: one may fail
        // while the other succeeds. Preserve this valid diagnostic combination.
        let mut mixed = delivery;
        mixed["observations"][0]["attributes"] = serde_json::Value::Null;
        mixed["observations"][0]["attributes_error"] = serde_json::json!(5);
        assert!(verify_delivery(&mixed.to_string(), root).is_ok());
    }
    #[test]
    fn ordinary_owned_output_has_real_metadata_without_mutation() {
        let root =
            std::env::temp_dir().join(format!("ShellSpan-AC-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(root.join("output")).unwrap();
        let result = observe(&root).unwrap();
        let output = result.last().unwrap();
        assert_eq!(output.path, root.join("output"));
        assert!(output.open_error.is_none() && output.metadata_error.is_none());
        assert!(output.identity.is_some());
        let delivery = serde_json::json!({"version":1,"root":root,"observations":result});
        assert!(verify_delivery(&delivery.to_string(), &root).is_ok());
        let mut changed = delivery.clone();
        changed["observations"][0]["path"] = serde_json::json!(root);
        assert!(verify_delivery(&changed.to_string(), &root).is_err());
        let mut changed = delivery.clone();
        changed["observations"][0]["open_error"] = serde_json::json!(0);
        assert!(verify_delivery(&changed.to_string(), &root).is_err());
        let mut changed = delivery;
        changed["unknown"] = serde_json::json!(true);
        assert!(verify_delivery(&changed.to_string(), &root).is_err());
        assert_eq!(std::fs::read_dir(root.join("output")).unwrap().count(), 0);
        assert!(observe(Path::new("relative")).is_err());
        assert!(observe(Path::new(
            r"\\server\share\ShellSpan-AC-11111111111141118111111111111111"
        ))
        .is_err());
        trash::delete(root).unwrap();
    }
    #[test]
    fn actual_dedicated_programdata_ancestors_fail_while_owned_output_opens() {
        let receipt: serde_json::Value = serde_json::from_slice(include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../docs/design/evidence/windows-stage-a-2026-10-09-git-prefix-system-profile.json"
        )))
        .unwrap();
        let report = &receipt["controller_admission_report"];
        assert_eq!(receipt["controller_tool"], "git_prefix_probe");
        assert!(report["error"].is_null());
        assert_eq!(report["execution_topology_verified"], true);
        assert_eq!(report["process_tree_stopped"], true);
        assert_eq!(report["tool_admission"]["prefix_report_bound"], true);
        let text = report["tool_admission"]["stdout"].as_str().unwrap();
        let root = Path::new(
            receipt["controller_workload_fixture"]["path"]
                .as_str()
                .unwrap(),
        );
        verify_delivery(text, root).unwrap();
        let delivery: serde_json::Value = serde_json::from_str(text).unwrap();
        let observations = delivery["observations"].as_array().unwrap();
        assert_eq!(
            Path::new(observations[1]["path"].as_str().unwrap()),
            Path::new(r"C:\ProgramData")
        );
        assert_eq!(observations[1]["open_error"], 5);
        assert_eq!(observations[1]["attributes_error"], 5);
        let output = observations.last().unwrap();
        assert!(output["open_error"].is_null());
        assert!(output["identity"].is_array());
        let retired: serde_json::Value = serde_json::from_slice(include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../docs/design/evidence/windows-stage-a-2026-10-09-git-prefix-system-recovered-profile.json"
        ))).unwrap();
        assert_eq!(retired["fixture_id"], receipt["fixture_id"]);
        assert_eq!(retired["account_sid"], receipt["account_sid"]);
        for field in [
            "account_removed",
            "profile_removed",
            "filters_removed",
            "credential_removed",
        ] {
            assert_eq!(retired[field], true, "{field}");
        }
        assert!(retired["cleanup_debt"].as_array().unwrap().is_empty());
    }
    #[test]
    fn actual_lpac_denies_ancestors_but_opens_owned_output() {
        let report: serde_json::Value = serde_json::from_slice(include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../docs/design/evidence/windows-stage-a-2026-10-09-git-prefix-lpac.json"
        )))
        .unwrap();
        assert!(report["error"].is_null());
        assert_eq!(report["tool_admission"]["prefix_report_bound"], true);
        for field in [
            "process_tree_stopped",
            "profile_removed",
            "fixture_acls_revoked",
        ] {
            assert_eq!(report[field], true, "{field}");
        }
        let text = report["tool_admission"]["stdout"].as_str().unwrap();
        let root = Path::new(report["fixture"].as_str().unwrap());
        verify_delivery(text, root).unwrap();
        let delivery: serde_json::Value = serde_json::from_str(text).unwrap();
        let observations = delivery["observations"].as_array().unwrap();
        let users = observations
            .iter()
            .find(|entry| entry["path"] == r"C:\Users")
            .unwrap();
        assert_eq!(users["open_error"], 5);
        let output = observations.last().unwrap();
        assert!(output["open_error"].is_null() && output["metadata_error"].is_null());
        assert!(output["identity"].is_array());
    }
}
