//! Fixed offline build of actual ShellSpan source, not a complete app build.
use crate::fixed_tool::{ToolImageIdentity, ToolImageLease};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{io::Write, path::Path};

const SOURCE: &str = include_str!("../../../src/lib/terminal/terminal-output-buffer.ts");
const RUNNER: &str = include_str!("../fixtures/node-project-runner.cjs");
pub const SOURCE_SHA256: &str = "493170a9ad49179f03b79d2bf109122b2d55bd8ce76a0230b5a1d33e60fe8467";
pub const BUILD_SHA256: &str = "baea864351ffd989a944d0273f03e101e73dba663e937eb637de3972e0dce3b3";
const CHECKS: [&str; 4] = [
    "ansi_redraw",
    "redacted_recent_lines",
    "snapshot_cache",
    "session_rebind",
];

pub struct NodeProject {
    _root: crate::appcontainer_probe::Handle,
    _inputs: Vec<ToolImageLease>,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectResult {
    version: u32,
    node_version: String,
    source_sha256: String,
    build_sha256: String,
    source_write_rejected: bool,
    checks: Vec<String>,
}
fn hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
fn owned_root(root: &Path) -> Result<(uuid::Uuid, crate::appcontainer_probe::Handle), String> {
    let id = root
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.strip_prefix("ShellSpan-AC-"))
        .and_then(|name| uuid::Uuid::parse_str(name).ok());
    if !root.is_absolute() || id.is_none_or(|id| id.is_nil()) {
        return Err("Node project requires freshly owned UUID fixture".into());
    }
    let held = crate::appcontainer_probe::verify_retirement_object(root)?;
    Ok((id.ok_or("missing Node project UUID")?, held))
}
fn bounded_file(root: &Path, name: &str, budget: u64) -> Result<ToolImageLease, String> {
    let lease = ToolImageLease::open(&root.join(name))?;
    if lease.identity.bytes > budget {
        return Err("fixed Node project file exceeds budget".into());
    }
    // Freeze exact single-link files; do not adopt aliases as project evidence.
    let _held = crate::appcontainer_probe::verify_retirement_object(&root.join(name))?;
    Ok(lease)
}
impl NodeProject {
    pub fn prepare(root: &Path, user: &str, package: &str) -> Result<Self, String> {
        let (id, held) = owned_root(root)?;
        crate::credential_reference::OwnedCredentialReference::new(id, user)?;
        if package != crate::package_network_intent::expected_package_sid(id)? {
            return Err("fixed Node project requires exact owned package".into());
        }
        let source = SOURCE.replace("\r\n", "\n");
        if hash(source.as_bytes()) != SOURCE_SHA256 {
            return Err("ShellSpan source changed; recalibrate fixed project build".into());
        }
        let mut inputs = Vec::new();
        for (name, content) in [
            ("terminal-output-buffer.ts", source.as_str()),
            ("node-project-runner.cjs", RUNNER),
        ] {
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(root.join(name))
                .map_err(|e| e.to_string())?;
            file.write_all(content.as_bytes())
                .and_then(|()| file.sync_all())
                .map_err(|e| e.to_string())?;
            drop(file);
            crate::appcontainer_probe::set_owned_dacl(
                &root.join(name),
                &format!("D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;{user})(A;;FR;;;{package})"),
            )?;
            let lease = bounded_file(root, name, 65536)?;
            if lease.read_bytes()? != content.as_bytes() {
                return Err("frozen Node project input differs".into());
            }
            inputs.push(lease);
        }
        Ok(Self {
            _root: held,
            _inputs: inputs,
        })
    }
}
pub fn verify(root: &Path) -> Result<(ProjectResult, ToolImageIdentity), String> {
    let (_, _root) = owned_root(root)?;
    let source = bounded_file(root, "terminal-output-buffer.ts", 65536)?;
    if hash(&source.read_bytes()?) != SOURCE_SHA256 {
        return Err("Node project source digest differs".into());
    }
    let output = root.join("output");
    let _output = crate::appcontainer_probe::verify_retirement_object(&output)?;
    let built = bounded_file(&output, "terminal-output-buffer.mjs", 65536)?;
    if hash(&built.read_bytes()?) != BUILD_SHA256 {
        return Err("Node project compiled digest differs".into());
    }
    let result = bounded_file(&output, "node-project-result.json", 2048)?;
    let result: ProjectResult =
        serde_json::from_slice(&result.read_bytes()?).map_err(|e| e.to_string())?;
    validate_result(&result)?;
    Ok((result, built.identity.clone()))
}
fn validate_result(result: &ProjectResult) -> Result<(), String> {
    if result.version != 1
        || result.node_version != "v26.5.0"
        || result.source_sha256 != SOURCE_SHA256
        || result.build_sha256 != BUILD_SHA256
        || !result.source_write_rejected
        || result.checks != CHECKS
    {
        return Err("fixed Node project result differs".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn source_is_actual_project_revision_and_no_caller_inputs_are_accepted() {
        assert_eq!(hash(SOURCE.replace("\r\n", "\n").as_bytes()), SOURCE_SHA256);
        assert!(NodeProject::prepare(Path::new("relative"), "S-1-5-18", "S-1-15-2-1").is_err());
        assert!(verify(Path::new("relative")).is_err());
    }
    #[test]
    fn preparation_rejects_broad_package_before_any_input_publication() {
        let root =
            std::env::temp_dir().join(format!("ShellSpan-AC-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir(&root).unwrap();
        assert!(
            NodeProject::prepare(&root, "S-1-5-21-1-2-3-4", "S-1-15-2-1")
                .err()
                .unwrap()
                .contains("exact owned package")
        );
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
        trash::delete(root).unwrap();
    }
    #[test]
    fn actual_dedicated_project_result_and_first_failure_remain_distinct() {
        let read = |prefix: &str, suffix: &str| -> serde_json::Value {
            let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../docs/design/evidence/windows-stage-a-2026-10-10-{prefix}-system-{suffix}.json"));
            serde_json::from_str(
                std::fs::read_to_string(path)
                    .unwrap()
                    .trim_start_matches('\u{feff}'),
            )
            .unwrap()
        };
        let failed = read("node-project", "profile");
        let failure = &failed["controller_admission_report"];
        assert_eq!(failure["tool_admission"]["actual_exit"], 1);
        assert_eq!(failure["tool_admission"]["project_verified"], false);
        assert!(failure["tool_admission"]["stderr"]
            .as_str()
            .unwrap()
            .contains("lstat 'C:\\'"));
        let first = read("node-metadata-project", "profile");
        let report = &first["controller_admission_report"];
        assert!(report["error"].is_null());
        for field in [
            "execution_topology_verified",
            "actual_lpac",
            "actual_user_verified",
            "actual_package_verified",
            "actual_capabilities_verified",
            "process_tree_stopped",
        ] {
            assert_eq!(report[field], true, "{field}");
        }
        assert_eq!(report["tool_admission"]["actual_exit"], 73);
        assert_eq!(report["tool_admission"]["project_verified"], true);
        let good = report["tool_admission"]["project"].clone();
        validate_result(&serde_json::from_value(good.clone()).unwrap()).unwrap();
        for (field, value) in [
            ("source_write_rejected", serde_json::json!(false)),
            ("version", serde_json::json!(2)),
            ("node_version", serde_json::json!("unknown")),
            ("source_sha256", serde_json::json!(BUILD_SHA256)),
            ("build_sha256", serde_json::json!(SOURCE_SHA256)),
            (
                "checks",
                serde_json::json!([
                    "ansi_redraw",
                    "ansi_redraw",
                    "snapshot_cache",
                    "session_rebind"
                ]),
            ),
        ] {
            let mut bad = good.clone();
            bad[field] = value;
            assert!(
                validate_result(&serde_json::from_value(bad).unwrap()).is_err(),
                "{field}"
            );
        }
        assert!(!first["cleanup_debt"].as_array().unwrap().is_empty());
        let retired = read("node-metadata-project", "recovered-profile");
        assert_eq!(retired["fixture_id"], first["fixture_id"]);
        assert_eq!(retired["account_sid"], first["account_sid"]);
        assert!(retired["cleanup_debt"].as_array().unwrap().is_empty());
        for field in [
            "account_removed",
            "profile_removed",
            "filters_removed",
            "credential_removed",
        ] {
            assert_eq!(retired[field], true, "{field}");
        }
        let audit = read("node-metadata-project", "os-audit");
        assert_eq!(audit["fixture_id"], retired["fixture_id"]);
        for field in [
            "account_absent",
            "profile_absent",
            "hive_absent",
            "services_absent",
        ] {
            assert_eq!(audit[field], true, "{field}");
        }
        let ancestors = read("node-metadata-project", "ancestor-os-audit");
        assert_eq!(ancestors["fixture_id"], retired["fixture_id"]);
        assert_eq!(ancestors["ancestor_package_aces_absent"], true);
        assert_eq!(ancestors["identity_resources_retired"], true);
        assert_eq!(ancestors["exact_objects_verified"], 2);
    }
}
