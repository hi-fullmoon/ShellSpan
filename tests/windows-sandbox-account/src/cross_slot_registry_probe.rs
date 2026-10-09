//! Fixed owned interrupted-slot registry admission only; never reads key values.
use crate::appcontainer_probe::{query, sid_text, win, Handle};
use serde::{Deserialize, Serialize};
use std::ptr::null_mut;
use windows_sys::Win32::Foundation::{GetLastError, ERROR_NO_TOKEN};
use windows_sys::Win32::Security::*;
use windows_sys::Win32::System::Registry::*;
use windows_sys::Win32::System::Threading::*;

pub const OWNED_PEER_SIDS: [&str; 2] = [
    "S-1-5-21-4017028701-367916445-1230427694-1063",
    "S-1-5-21-4017028701-367916445-1230427694-1065",
];
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PeerRegistryObservation {
    pub target_sid: String,
    pub win32: u32,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CrossSlotRegistryReport {
    pub version: u32,
    pub source_sid: String,
    pub peers: Vec<PeerRegistryObservation>,
}
fn observe_access(system_control: bool, access: u32) -> Result<CrossSlotRegistryReport, String> {
    let mut raw = null_mut();
    if unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 1, &mut raw) } != 0 {
        let _held = Handle(raw);
        return Err("cross-slot probe requires the primary context".into());
    }
    if unsafe { GetLastError() } != ERROR_NO_TOKEN {
        return Err("cross-slot thread context unavailable".into());
    }
    win(
        unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE, &mut raw) },
        "inspect cross-slot primary identity",
    )?;
    let token = Handle(raw);
    let user = unsafe { query(token.0, TokenUser) }?;
    let user_sid = unsafe { (*user.as_ptr().cast::<TOKEN_USER>()).User.Sid };
    let source_sid = unsafe { sid_text(user_sid) }?;
    if system_control {
        if source_sid != "S-1-5-18" {
            return Err("cross-slot positive control requires SYSTEM".into());
        }
    } else {
        let app = unsafe { query(token.0, TokenIsAppContainer) }?;
        let integrity = unsafe { query(token.0, TokenIntegrityLevel) }?;
        let package = unsafe { query(token.0, TokenAppContainerSid) }?;
        let package_sid = unsafe {
            (*package.as_ptr().cast::<TOKEN_APPCONTAINER_INFORMATION>()).TokenAppContainer
        };
        let integrity_sid = unsafe {
            (*integrity.as_ptr().cast::<TOKEN_MANDATORY_LABEL>())
                .Label
                .Sid
        };
        if unsafe { *app.as_ptr().cast::<u32>() } != 1
            || unsafe { sid_text(integrity_sid) }? != "S-1-16-4096"
            || OWNED_PEER_SIDS.contains(&source_sid.as_str())
            || !unsafe { crate::appcontainer_probe::lpac_behavior(token.0, user_sid, package_sid) }?
        {
            return Err("cross-slot negative probe requires a different Low LPAC account".into());
        }
    }
    let peers = OWNED_PEER_SIDS
        .iter()
        .map(|target| {
            let key: Vec<u16> = target.encode_utf16().chain(Some(0)).collect();
            let mut raw = null_mut();
            let status = unsafe { RegOpenKeyExW(HKEY_USERS, key.as_ptr(), 0, access, &mut raw) };
            if status == 0 && raw.is_null() {
                return Err("cross-slot registry success lacks a handle".into());
            }
            if !raw.is_null() && unsafe { RegCloseKey(raw) } != 0 {
                return Err("cross-slot registry query handle close failed".into());
            }
            Ok(PeerRegistryObservation {
                target_sid: (*target).into(),
                win32: status,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(CrossSlotRegistryReport {
        version: 1,
        source_sid,
        peers,
    })
}
/// Caller must first validate these exact peer identities against protected ownership.
pub fn system_positive_control() -> Result<CrossSlotRegistryReport, String> {
    let report = observe_access(true, KEY_READ)?;
    verify(&report, "S-1-5-18", true)?;
    Ok(report)
}
pub fn child_report() -> Result<CrossSlotRegistryReport, String> {
    observe_access(false, KEY_READ)
}
fn canonical_account_sid(source: &str) -> bool {
    let Some(suffix) = source.strip_prefix("S-1-5-21-") else {
        return false;
    };
    let parts: Vec<_> = suffix.split('-').collect();
    parts.len() == 4
        && parts.iter().all(|part| {
            part.parse::<u32>()
                .is_ok_and(|value| value.to_string() == *part)
        })
        && parts[3] != "0"
}
pub fn verify(
    report: &CrossSlotRegistryReport,
    source: &str,
    positive: bool,
) -> Result<(), String> {
    if report.version != 1
        || report.source_sid != source
        || (positive && source != "S-1-5-18")
        || (!positive && (!canonical_account_sid(source) || OWNED_PEER_SIDS.contains(&source)))
        || report.peers.len() != OWNED_PEER_SIDS.len()
        || report
            .peers
            .iter()
            .zip(OWNED_PEER_SIDS)
            .any(|(actual, expected)| {
                actual.target_sid != expected || actual.win32 != if positive { 0 } else { 5 }
            })
    {
        return Err("cross-slot registry evidence identity, targets or result differs".into());
    }
    Ok(())
}
pub fn verify_delivery(json: &str, source: &str) -> Result<(), String> {
    if json.len() > 4096 {
        return Err("cross-slot registry report exceeds budget".into());
    }
    let report = serde_json::from_str(json).map_err(|_| "cross-slot registry report invalid")?;
    verify(&report, source, false)
}
/// Fixed access requests only: no registry mutation API is invoked.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RegistryAccessReport {
    pub read: CrossSlotRegistryReport,
    pub set_value: CrossSlotRegistryReport,
    pub create_sub_key: CrossSlotRegistryReport,
    pub delete: CrossSlotRegistryReport,
}
pub fn access_report(system_control: bool) -> Result<RegistryAccessReport, String> {
    let report = RegistryAccessReport {
        read: observe_access(system_control, KEY_READ)?,
        set_value: observe_access(system_control, KEY_SET_VALUE)?,
        create_sub_key: observe_access(system_control, KEY_CREATE_SUB_KEY)?,
        delete: observe_access(
            system_control,
            windows_sys::Win32::Storage::FileSystem::DELETE,
        )?,
    };
    if system_control {
        verify_access(&report, "S-1-5-18", true)?;
    }
    Ok(report)
}
pub fn verify_access(
    report: &RegistryAccessReport,
    source: &str,
    positive: bool,
) -> Result<(), String> {
    for observation in [
        &report.read,
        &report.set_value,
        &report.create_sub_key,
        &report.delete,
    ] {
        verify(observation, source, positive)?;
    }
    Ok(())
}
pub fn verify_access_delivery(json: &str, source: &str) -> Result<(), String> {
    if json.len() > 4096 {
        return Err("cross-slot access report exceeds budget".into());
    }
    let report = serde_json::from_str(json).map_err(|_| "cross-slot access report invalid")?;
    verify_access(&report, source, false)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cross_slot_evidence_requires_two_exact_peers_and_explicit_denial() {
        let source = "S-1-5-21-1-2-3-1001";
        let mut report = CrossSlotRegistryReport {
            version: 1,
            source_sid: source.into(),
            peers: OWNED_PEER_SIDS
                .iter()
                .map(|target| PeerRegistryObservation {
                    target_sid: (*target).into(),
                    win32: 5,
                })
                .collect(),
        };
        verify_delivery(&serde_json::to_string(&report).unwrap(), source).unwrap();
        for code in [0, 2, 87, 1702] {
            report.peers[0].win32 = code;
            assert!(verify(&report, source, false).is_err());
        }
        report.peers[0].win32 = 5;
        assert!(verify(&report, "S-1-5-18", false).is_err());
        report.peers[1].target_sid = report.peers[0].target_sid.clone();
        assert!(verify(&report, source, false).is_err());
        assert!(verify_delivery("{}", source).is_err());
        assert!(verify_delivery(&" ".repeat(4097), source).is_err());
    }
    #[test]
    fn actual_system_cross_slot_evidence_binds_controls_child_and_retirement() {
        let load = |suffix: &str| -> serde_json::Value {
            let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../docs/design/evidence")
                .join(format!(
                    "windows-stage-a-2026-10-09-cross-slot-registry-system-{suffix}.json"
                ));
            let text = std::fs::read_to_string(path).unwrap();
            serde_json::from_str(text.trim_start_matches('\u{feff}')).unwrap()
        };
        let profile = load("profile");
        let report = &profile["controller_admission_report"];
        let source = profile["account_sid"].as_str().unwrap();
        let positive: CrossSlotRegistryReport =
            serde_json::from_value(report["cross_slot_control"]["registry_positive"].clone())
                .unwrap();
        verify(&positive, "S-1-5-18", true).unwrap();
        for (index, sid) in OWNED_PEER_SIDS.iter().enumerate() {
            let peer = &report["cross_slot_control"]["ownership"][index];
            assert_eq!(peer["account_sid"], *sid);
            assert_eq!(peer["account_disabled"], true);
            assert_eq!(peer["profile_identity_verified"], true);
        }
        verify_delivery(report["tool_admission"]["stdout"].as_str().unwrap(), source).unwrap();
        assert_eq!(report["tool_admission"]["actual_exit"], 73);
        assert_eq!(report["tool_admission"]["cross_slot_report_bound"], true);
        for key in [
            "actual_lpac",
            "actual_low_integrity",
            "actual_user_verified",
            "actual_package_verified",
            "actual_capabilities_verified",
            "execution_topology_verified",
            "process_tree_stopped",
        ] {
            assert_eq!(report[key], true, "{key}");
        }
        let recovered = load("recovered-profile");
        assert_eq!(recovered["fixture_id"], profile["fixture_id"]);
        assert_eq!(recovered["account_sid"], source);
        for key in ["account_removed", "profile_removed", "filters_removed"] {
            assert_eq!(recovered[key], true, "{key}");
        }
        assert_eq!(recovered["cleanup_debt"], serde_json::json!([]));
        let audit = load("os-audit");
        assert_eq!(audit["fixture_id"], profile["fixture_id"]);
        for key in [
            "account_absent",
            "profile_absent",
            "hive_absent",
            "services_absent",
        ] {
            assert_eq!(audit[key], true, "{key}");
        }
    }
    #[test]
    fn actual_system_cross_slot_access_evidence_binds_controls_child_and_retirement() {
        let load = |suffix: &str| -> serde_json::Value {
            let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../docs/design/evidence")
                .join(format!(
                    "windows-stage-a-2026-10-09-cross-slot-registry-access-system-{suffix}.json"
                ));
            let text = std::fs::read_to_string(path).unwrap();
            serde_json::from_str(text.trim_start_matches('\u{feff}')).unwrap()
        };
        let profile = load("profile");
        let report = &profile["controller_admission_report"];
        let source = profile["account_sid"].as_str().unwrap();
        let positive: RegistryAccessReport = serde_json::from_value(
            report["cross_slot_control"]["registry_access_positive"].clone(),
        )
        .unwrap();
        verify_access(&positive, "S-1-5-18", true).unwrap();
        for (index, sid) in OWNED_PEER_SIDS.iter().enumerate() {
            let peer = &report["cross_slot_control"]["ownership"][index];
            assert_eq!(peer["account_sid"], *sid);
            assert_eq!(peer["account_disabled"], true);
            assert_eq!(peer["profile_identity_verified"], true);
        }
        verify_access_delivery(report["tool_admission"]["stdout"].as_str().unwrap(), source)
            .unwrap();
        assert_eq!(report["tool_admission"]["actual_exit"], 73);
        assert_eq!(report["tool_admission"]["cross_slot_report_bound"], true);
        for key in [
            "actual_lpac",
            "actual_low_integrity",
            "actual_user_verified",
            "actual_package_verified",
            "actual_capabilities_verified",
            "execution_topology_verified",
            "process_tree_stopped",
        ] {
            assert_eq!(report[key], true, "{key}");
        }
        let stdout = report["tool_admission"]["stdout"].as_str().unwrap();
        let delivered: serde_json::Value = serde_json::from_str(stdout).unwrap();
        for right in ["read", "set_value", "create_sub_key", "delete"] {
            for index in 0..2 {
                for code in [0, 2, 87, 1702] {
                    let mut changed = delivered.clone();
                    changed[right]["peers"][index]["win32"] = serde_json::json!(code);
                    assert!(verify_access_delivery(&changed.to_string(), source).is_err());
                }
            }
            let mut missing = delivered.clone();
            missing.as_object_mut().unwrap().remove(right);
            assert!(verify_access_delivery(&missing.to_string(), source).is_err());
            let mut wrong_source = delivered.clone();
            wrong_source[right]["source_sid"] = serde_json::json!("S-1-5-18");
            assert!(verify_access_delivery(&wrong_source.to_string(), source).is_err());
        }
        let mut extra = delivered.clone();
        extra["unexpected"] = serde_json::json!(true);
        assert!(verify_access_delivery(&extra.to_string(), source).is_err());
        let recovered = load("recovered-profile");
        assert_eq!(recovered["fixture_id"], profile["fixture_id"]);
        assert_eq!(recovered["account_sid"], source);
        for key in ["account_removed", "profile_removed", "filters_removed"] {
            assert_eq!(recovered[key], true, "{key}");
        }
        assert_eq!(recovered["cleanup_debt"], serde_json::json!([]));
        let audit = load("os-audit");
        assert_eq!(audit["fixture_id"], profile["fixture_id"]);
        for key in [
            "account_absent",
            "profile_absent",
            "hive_absent",
            "services_absent",
        ] {
            assert_eq!(audit[key], true, "{key}");
        }
    }
    #[test]
    fn registry_reports_reject_noncanonical_source_and_peer_substitution() {
        let mut report = CrossSlotRegistryReport {
            version: 1,
            source_sid: "S-1-5-21-1-2-3-1001".into(),
            peers: OWNED_PEER_SIDS
                .iter()
                .map(|sid| PeerRegistryObservation {
                    target_sid: (*sid).into(),
                    win32: 5,
                })
                .collect(),
        };
        for source in [
            "S-1-5-21-",
            "S-1-5-21-1-2-3",
            "S-1-5-21-1-2-3-4-5",
            "S-1-5-21-01-2-3-4",
            "S-1-5-21-1-2-3-0",
            "S-1-5-21-1-2-3-4294967296",
            "S-1-5-21-1-2-3-+4",
            "S-1-5-21-1-2-3-x",
        ] {
            report.source_sid = source.into();
            assert!(verify(&report, source, false).is_err(), "{source}");
        }
        report.source_sid = "S-1-5-21-1-2-3-1001".into();
        report.peers.swap(0, 1);
        assert!(verify(&report, &report.source_sid, false).is_err());
        report.peers.swap(0, 1);
        for field in ["version", "source_sid", "peers"] {
            let mut json = serde_json::to_value(&report).unwrap();
            json.as_object_mut().unwrap().remove(field);
            assert!(verify_delivery(&json.to_string(), &report.source_sid).is_err());
        }
        for field in ["target_sid", "win32"] {
            let mut json = serde_json::to_value(&report).unwrap();
            json["peers"][0].as_object_mut().unwrap().remove(field);
            assert!(verify_delivery(&json.to_string(), &report.source_sid).is_err());
        }
        let mut json = serde_json::to_value(&report).unwrap();
        json["peers"][0]["extra"] = serde_json::json!(true);
        assert!(verify_delivery(&json.to_string(), &report.source_sid).is_err());
    }
}
