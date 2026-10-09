//! Bounded diagnostic delivery only; a delivered failure is not tool admission.
use serde::{Deserialize, Serialize};
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct NativeRegistration {
    pub provider: String,
    pub register_code: u32,
    pub handle_nonzero: bool,
    pub unregister_code: Option<u32>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EtwException {
    #[serde(rename = "type")]
    pub exception_type: String,
    pub hresult: i32,
    pub native_error: Option<i32>,
    pub message: String,
    pub stack: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EtwObservation {
    pub version: u32,
    pub scope: String,
    pub assembly: String,
    #[serde(rename = "type")]
    pub type_name: String,
    pub assembly_version: String,
    pub mvid: String,
    pub stage: String,
    pub initializer_succeeded: bool,
    pub chain_complete: bool,
    pub exceptions: Vec<EtwException>,
    pub native_registrations: Vec<NativeRegistration>,
}
pub fn verify_delivery(raw: &str) -> Result<EtwObservation, String> {
    if raw.len() > 16384 {
        return Err("ETW diagnostic exceeds budget".into());
    }
    let report: EtwObservation = serde_json::from_str(raw).map_err(|e| e.to_string())?;
    if report.version != 1 || report.scope != "fixed-powershell-etw-initializer"
        || report.type_name != "System.Management.Automation.Tracing.PSEtwLog"
        || !report.assembly.eq_ignore_ascii_case(r"C:\Windows\Microsoft.Net\assembly\GAC_MSIL\System.Management.Automation\v4.0_3.0.0.0__31bf3856ad364e35\System.Management.Automation.dll")
        || report.assembly_version.chars().count() > 256 || report.exceptions.len() > 4
        || !matches!(report.stage.as_str(), "load" | "type" | "initializer" | "complete")
        || report.initializer_succeeded != (report.stage == "complete")
        || report.initializer_succeeded != report.exceptions.is_empty() || !report.chain_complete {
        return Err("ETW diagnostic identity or outcome invalid".into());
    }
    if report.stage != "load"
        && (report.assembly_version.is_empty()
            || !uuid::Uuid::parse_str(&report.mvid).is_ok_and(|id| !id.is_nil()))
    {
        return Err("loaded ETW assembly identity missing".into());
    }
    for exception in &report.exceptions {
        if exception.exception_type.is_empty()
            || exception.exception_type.chars().count() > 128
            || exception.message.chars().count() > 256
            || exception.stack.chars().count() > 512
            || (exception.exception_type == "System.ComponentModel.Win32Exception")
                != exception.native_error.is_some()
            || exception.native_error.is_some_and(|code| code <= 0)
        {
            return Err("ETW exception chain invalid".into());
        }
    }
    let providers = [
        "a0c1853b-5c40-4b15-8766-3cf1c58f985a",
        "3229ad87-338e-4e53-85b4-f77f5f2c2a07",
    ];
    if report.native_registrations.len() != providers.len() {
        return Err("fixed native ETW comparison incomplete".into());
    }
    for (entry, provider) in report.native_registrations.iter().zip(providers) {
        if entry.provider != provider
            || entry.handle_nonzero != (entry.register_code == 0)
            || (entry.handle_nonzero && entry.unregister_code != Some(0))
            || (!entry.handle_nonzero && entry.unregister_code.is_some())
        {
            return Err("native ETW identity or handle retirement invalid".into());
        }
    }
    Ok(report)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn observations() -> (serde_json::Value, serde_json::Value) {
        let source: serde_json::Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"),
            "/../../docs/design/evidence/windows-stage-a-2026-10-09-powershell-etw-source-control.json"))).unwrap();
        let lpac: serde_json::Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"),
            "/../../docs/design/evidence/windows-stage-a-2026-10-09-powershell-etw-lpac-controller.json"))).unwrap();
        (source, lpac)
    }
    #[test]
    fn actual_full_powershell_timeout_is_not_initializer_compatibility_success() {
        let report: serde_json::Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/design/evidence/windows-stage-a-2026-10-09-powershell-instrumentation-lpac-controller.json"))).unwrap();
        assert_eq!(report["error"], "candidate fixed entry timed out");
        assert!(report["tool_admission"].get("actual_exit").is_none());
        assert_eq!(report["tool_admission"]["stdout"], "");
        assert_eq!(report["production"], "unavailable");
        for field in [
            "capabilities_verified",
            "actual_lpac",
            "process_tree_stopped",
            "fixture_acls_revoked",
            "profile_removed",
        ] {
            assert_eq!(report[field], true, "{field}");
        }
    }
    #[test]
    fn actual_instrumentation_candidate_initializes_without_changing_assembly() {
        let evidence: serde_json::Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/design/evidence/windows-stage-a-2026-10-09-powershell-etw-instrumentation-lpac-controller.json"))).unwrap();
        let (source, _) = observations();
        let baseline = verify_delivery(source["stdout"].as_str().unwrap()).unwrap();
        let actual =
            verify_delivery(evidence["tool_admission"]["stdout"].as_str().unwrap()).unwrap();
        assert_eq!(actual.mvid, baseline.mvid);
        assert!(actual.initializer_succeeded);
        assert!(actual
            .native_registrations
            .iter()
            .all(|r| r.register_code == 0 && r.unregister_code == Some(0)));
        assert_eq!(
            evidence["requested_capabilities"],
            serde_json::json!(["registryRead", "lpacInstrumentation"])
        );
        for field in [
            "capabilities_verified",
            "actual_lpac",
            "process_tree_stopped",
            "fixture_acls_revoked",
            "profile_removed",
        ] {
            assert_eq!(evidence[field], true, "{field}");
        }
        assert_eq!(evidence["production"], "unavailable");
        assert_eq!(evidence["tool_admission"]["topology_verified"], true);
    }
    #[test]
    fn actual_initializer_comparison_preserves_access_denial_and_cleanup_scope() {
        let (source, lpac) = observations();
        assert_eq!(source["positive_control_passed"], true);
        let positive = verify_delivery(source["stdout"].as_str().unwrap()).unwrap();
        let negative = verify_delivery(lpac["tool_admission"]["stdout"].as_str().unwrap()).unwrap();
        assert!(positive.initializer_succeeded);
        assert!(!negative.initializer_succeeded);
        assert_eq!(positive.mvid, negative.mvid);
        assert_eq!(positive.assembly_version, negative.assembly_version);
        assert!(positive
            .native_registrations
            .iter()
            .all(|entry| entry.register_code == 0 && entry.unregister_code == Some(0)));
        assert!(negative
            .native_registrations
            .iter()
            .all(|entry| entry.register_code == 5 && !entry.handle_nonzero));
        assert_eq!(negative.exceptions.last().unwrap().native_error, Some(5));
        assert!(negative
            .exceptions
            .last()
            .unwrap()
            .stack
            .contains("EventProvider.EtwRegister"));
        for field in [
            "process_tree_stopped",
            "fixture_acls_revoked",
            "profile_removed",
        ] {
            assert_eq!(lpac[field], true, "{field}");
        }
        assert_eq!(lpac["tool_admission"]["etw_delivery_verified"], true);
        assert_eq!(lpac["tool_admission"]["initializer_succeeded"], false);
    }
    #[test]
    fn diagnostic_rejects_replacement_incomplete_chain_and_false_success() {
        let (_, lpac) = observations();
        let report: serde_json::Value =
            serde_json::from_str(lpac["tool_admission"]["stdout"].as_str().unwrap()).unwrap();
        for (field, value) in [
            ("version", serde_json::json!(2)),
            ("assembly", serde_json::json!("D:\\external.dll")),
            ("stage", serde_json::json!("complete")),
            ("exceptions", serde_json::json!([])),
            ("chain_complete", serde_json::json!(false)),
            ("initializer_succeeded", serde_json::json!(true)),
            ("mvid", serde_json::json!(uuid::Uuid::nil().to_string())),
            ("unexpected", serde_json::json!(true)),
        ] {
            let mut changed = report.clone();
            changed[field] = value;
            assert!(verify_delivery(&changed.to_string()).is_err(), "{field}");
        }
        let mut changed = report.clone();
        changed["exceptions"][2]["native_error"] = serde_json::json!(0);
        assert!(verify_delivery(&changed.to_string()).is_err());
        let mut changed = report;
        changed["exceptions"][0]["native_error"] = serde_json::json!(5);
        assert!(verify_delivery(&changed.to_string()).is_err());
        assert!(verify_delivery(&" ".repeat(16385)).is_err());
    }
    #[test]
    fn native_delivery_requires_both_fixed_providers_and_successful_retirement() {
        let (source, _) = observations();
        let report: serde_json::Value =
            serde_json::from_str(source["stdout"].as_str().unwrap()).unwrap();
        let mut changed = report.clone();
        changed["native_registrations"]
            .as_array_mut()
            .unwrap()
            .pop();
        assert!(verify_delivery(&changed.to_string()).is_err());
        for (field, value) in [
            (
                "provider",
                serde_json::json!("00000000-0000-0000-0000-000000000000"),
            ),
            ("handle_nonzero", serde_json::json!(false)),
            ("unregister_code", serde_json::json!(5)),
            ("register_code", serde_json::json!(5)),
        ] {
            let mut changed = report.clone();
            changed["native_registrations"][0][field] = value;
            assert!(verify_delivery(&changed.to_string()).is_err(), "{field}");
        }
        let mut changed = report;
        changed["native_registrations"][1] = changed["native_registrations"][0].clone();
        assert!(verify_delivery(&changed.to_string()).is_err());
    }
}
