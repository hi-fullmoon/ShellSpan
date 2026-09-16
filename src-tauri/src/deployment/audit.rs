//! Bounded, redacted audit export for one exact deployment run.
//!
//! The export is a read-only projection. It deliberately omits connection
//! endpoints, usernames, credential references, the workflow source directory,
//! raw process output, and arbitrary event payload fields.

use super::{
    DeploymentApprovalPlanSummary, DeploymentReleaseIdentity, DeploymentRunEventRecord,
    DeploymentRunRecord,
};
use crate::db::{current_timestamp_ms, Database};
use serde::Serialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::Path;

const AUDIT_SCHEMA_VERSION: u32 = 1;
const MAX_AUDIT_EVENTS: u32 = 500;
const MAX_AUDIT_BYTES: usize = 2 * 1024 * 1024;
const MAX_AUDIT_TEXT_CHARS: usize = 512;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentAuditExportResult {
    pub schema_version: u32,
    pub run_id: String,
    pub saved: bool,
    pub bytes: u64,
    pub document_sha256: String,
}

#[derive(Debug, Clone)]
pub(crate) struct DeploymentAuditDocument {
    pub run_id: String,
    pub bytes: Vec<u8>,
    pub document_sha256: String,
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn text_looks_sensitive(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    crate::runbook::contains_secret_literal(value)
        || [
            "password",
            "passphrase",
            "private key",
            "api key",
            "apikey",
            "authorization bearer",
            "credential value",
            "/users/",
            "/home/",
            "c:\\users\\",
        ]
        .iter()
        .any(|needle| lower.contains(needle))
}

fn safe_text(value: &str) -> String {
    if text_looks_sensitive(value) {
        return "[REDACTED]".into();
    }
    let normalized = value
        .chars()
        .map(|character| {
            if character.is_control() && !matches!(character, '\t' | '\n' | '\r') {
                '\u{fffd}'
            } else if matches!(character, '\n' | '\r' | '\t') {
                ' '
            } else {
                character
            }
        })
        .take(MAX_AUDIT_TEXT_CHARS)
        .collect::<String>();
    if normalized.is_empty() {
        "[EMPTY]".into()
    } else {
        normalized
    }
}

fn release(release: &Option<DeploymentReleaseIdentity>) -> Value {
    release.as_ref().map_or(Value::Null, |release| {
        json!({
            "releaseId": release.release_id,
            "artifactDigestSha256": release.artifact_digest_sha256,
        })
    })
}

fn approval(summary: &DeploymentApprovalPlanSummary, digest: &str) -> Value {
    json!({
        "schemaVersion": summary.schema_version,
        "planId": format!("plan-{digest}"),
        "planDigest": digest,
        "workflowId": summary.workflow_id,
        "workflowRevision": summary.workflow_revision,
        "operationKind": summary.operation_kind,
        "generatedAt": summary.generated_at,
        "expiresAt": summary.expires_at,
        "source": {
            "revision": summary.frozen.source_revision.revision,
            "dirty": summary.frozen.source_revision.dirty,
        },
        "target": {
            "profileId": summary.frozen.target.profile_id,
            "profileRevision": summary.frozen.target.profile_updated_at,
            "authenticationMethod": summary.frozen.target.auth_method,
            "usesJumpHost": summary.frozen.target.jump_host.is_some(),
        },
        "compose": {
            "project": summary.compose_project,
            "files": summary.compose_files,
            "services": summary.services,
        },
        "releases": {
            "current": release(&summary.frozen.current_release),
            "target": release(&Some(summary.frozen.target_release.clone())),
            "rollback": release(&summary.frozen.rollback_release),
        },
        "preflight": {
            "checkedAt": summary.frozen.preflight.checked_at,
            "checks": summary.frozen.preflight.checks.iter().map(|check| json!({
                "code": check.code,
                "outcome": check.outcome,
                "summary": safe_text(&check.summary),
            })).collect::<Vec<_>>(),
        },
        "actions": summary.actions,
        "redactions": [
            "artifactReference",
            "connectionEndpoint",
            "connectionUsername",
            "credentialReference",
            "jumpHostEndpoint",
            "remoteRoot",
            "sourceDirectory",
        ],
    })
}

fn copy_scalar(source: &Map<String, Value>, target: &mut Map<String, Value>, key: &str) {
    if let Some(value) = source.get(key) {
        match value {
            Value::String(text) => {
                target.insert(key.into(), Value::String(safe_text(text)));
            }
            Value::Bool(_) | Value::Number(_) | Value::Null => {
                target.insert(key.into(), value.clone());
            }
            _ => {}
        }
    }
}

/// Projects only stable, reviewed evidence fields. Unknown event payload keys
/// never enter the export, even when older database rows contain them.
fn evidence(payload: &Option<Value>) -> Option<Value> {
    let source = payload.as_ref()?.as_object()?;
    let mut projected = Map::new();
    for key in [
        "phase",
        "action",
        "outcome",
        "failureCategory",
        "remoteSequence",
        "reconciliationRequired",
        "sideEffectsStarted",
        "activeReleaseId",
        "rollbackReleaseId",
    ] {
        copy_scalar(source, &mut projected, key);
    }
    if let Some(result) = source.get("result").and_then(Value::as_object) {
        let mut safe_result = Map::new();
        for key in [
            "status",
            "outcome",
            "failureCategory",
            "reconciliationRequired",
        ] {
            copy_scalar(result, &mut safe_result, key);
        }
        if let Some(result_evidence) = result.get("evidence").and_then(Value::as_object) {
            let mut safe_evidence = Map::new();
            for key in [
                "remoteSequence",
                "runnerIdentityVerified",
                "requestIdentityVerified",
                "ledgerVerified",
                "currentReleaseId",
                "previousReleaseId",
                "targetReleaseVerified",
                "rollbackReleaseVerified",
                "composeServicesVerified",
                "healthVerified",
                "sideEffectsStarted",
                "approvalReusable",
            ] {
                copy_scalar(result_evidence, &mut safe_evidence, key);
            }
            if !safe_evidence.is_empty() {
                safe_result.insert("evidence".into(), Value::Object(safe_evidence));
            }
        }
        if !safe_result.is_empty() {
            projected.insert("result".into(), Value::Object(safe_result));
        }
    }
    (!projected.is_empty()).then_some(Value::Object(projected))
}

fn timeline(events: &[DeploymentRunEventRecord]) -> Vec<Value> {
    events
        .iter()
        .map(|event| {
            json!({
                "sequence": event.sequence,
                "kind": event.event_kind,
                "status": event.status,
                "summary": safe_text(&event.summary),
                "evidence": evidence(&event.payload),
                "recordedAt": event.recorded_at,
            })
        })
        .collect()
}

fn result_projection(run: &DeploymentRunRecord) -> Value {
    json!({
        "status": run.status,
        "reconciliationRequired": run.reconciliation_required,
        "lastEventSequence": run.last_event_sequence,
        "startedAt": run.started_at,
        "finishedAt": run.finished_at,
    })
}

fn build_value(
    run: &DeploymentRunRecord,
    events: &[DeploymentRunEventRecord],
    exported_at: i64,
) -> Value {
    json!({
        "schemaVersion": AUDIT_SCHEMA_VERSION,
        "exportedAt": exported_at,
        "run": {
            "id": run.id,
            "workflowId": run.workflow_id,
            "workflowRevision": run.workflow_revision,
            "sourceRunId": run.source_run_id,
            "operationKind": run.operation_kind,
            "triggerKind": run.trigger_kind,
            "createdAt": run.created_at,
            "updatedAt": run.updated_at,
        },
        "approvalSummary": approval(&run.approval_summary, &run.approval_digest),
        "timeline": timeline(events),
        "result": result_projection(run),
        "retention": {
            "automaticReleaseCleanup": false,
            "policy": "runtime-owned releases are retained; cleanup is not implemented in v1",
        },
    })
}

fn verify_exact_timeline(
    run: &DeploymentRunRecord,
    events: &[DeploymentRunEventRecord],
) -> Result<(), String> {
    if run.last_event_sequence > MAX_AUDIT_EVENTS {
        return Err(format!(
            "deployment audit event count exceeds the {MAX_AUDIT_EVENTS}-event export limit"
        ));
    }
    if events.len() != run.last_event_sequence as usize
        || events
            .iter()
            .enumerate()
            .any(|(index, event)| event.run_id != run.id || event.sequence != index as u32 + 1)
    {
        return Err("deployment audit timeline is incomplete or non-contiguous".into());
    }
    Ok(())
}

pub(crate) fn build_deployment_audit_document(
    database: &Database,
    run_id: &str,
) -> Result<DeploymentAuditDocument, String> {
    super::validate_identifier("deployment audit run id", run_id, 128)
        .map_err(|error| error.to_string())?;
    let run = database
        .get_deployment_run(run_id)?
        .ok_or_else(|| "DEPLOYMENT_RUN_NOT_FOUND".to_string())?;
    let events = database.list_deployment_run_events(run_id, 0, MAX_AUDIT_EVENTS)?;
    verify_exact_timeline(&run, &events)?;
    let unsigned = build_value(&run, &events, current_timestamp_ms());
    let unsigned_bytes = serde_json::to_vec(&unsigned)
        .map_err(|error| format!("failed to serialize deployment audit document: {error}"))?;
    let document_sha256 = sha256_hex(&unsigned_bytes);
    let mut signed = unsigned;
    signed
        .as_object_mut()
        .expect("deployment audit root is an object")
        .insert(
            "integrity".into(),
            json!({
                "algorithm": "sha256",
                "scope": "canonicalDocumentWithoutIntegrity",
                "documentSha256": document_sha256,
                "signature": null,
                "signatureStatus": "notConfigured",
            }),
        );
    let mut bytes = serde_json::to_vec_pretty(&signed)
        .map_err(|error| format!("failed to serialize deployment audit document: {error}"))?;
    bytes.push(b'\n');
    if bytes.len() > MAX_AUDIT_BYTES {
        return Err(format!(
            "deployment audit document exceeds the {MAX_AUDIT_BYTES}-byte export limit"
        ));
    }
    if crate::runbook::contains_secret_literal(&String::from_utf8_lossy(&bytes)) {
        return Err("deployment audit document failed secret scanning".into());
    }
    Ok(DeploymentAuditDocument {
        run_id: run.id,
        bytes,
        document_sha256,
    })
}

pub(crate) fn save_deployment_audit_document(
    document: &DeploymentAuditDocument,
    path: &Path,
) -> Result<(), String> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| "deployment audit destination has no parent directory".to_string())?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("failed to create deployment audit staging file: {error}"))?;
    temporary
        .write_all(&document.bytes)
        .map_err(|error| format!("failed to write deployment audit staging file: {error}"))?;
    temporary
        .as_file_mut()
        .sync_all()
        .map_err(|error| format!("failed to sync deployment audit staging file: {error}"))?;
    temporary
        .persist(path)
        .map_err(|error| format!("failed to publish deployment audit file: {}", error.error))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deployment::{
        ApprovedDeploymentAction, DeploymentEventKind, DeploymentFrozenPlanInputs,
        DeploymentFrozenSourceRevision, DeploymentOperationKind, DeploymentPreflightCheckSummary,
        DeploymentPreflightOutcome, DeploymentPreflightSummary, DeploymentRunStatus,
        DeploymentTargetIdentitySnapshot, DeploymentTriggerKind,
    };

    fn run() -> DeploymentRunRecord {
        DeploymentRunRecord {
            id: "run-audit".into(),
            workflow_id: "workflow-audit".into(),
            workflow_revision: 3,
            source_run_id: None,
            operation_kind: DeploymentOperationKind::Deploy,
            trigger_kind: DeploymentTriggerKind::Manual,
            status: DeploymentRunStatus::Failed,
            approval_summary: DeploymentApprovalPlanSummary {
                schema_version: 2,
                workflow_id: "workflow-audit".into(),
                workflow_revision: 3,
                operation_kind: DeploymentOperationKind::Deploy,
                artifact_reference: Some(format!(
                    "deployment-artifact-v1:{}:{}",
                    "a".repeat(64),
                    "b".repeat(64)
                )),
                frozen: DeploymentFrozenPlanInputs {
                    source_revision: DeploymentFrozenSourceRevision {
                        revision: "c".repeat(40),
                        dirty: false,
                    },
                    target: DeploymentTargetIdentitySnapshot {
                        profile_id: "profile-audit".into(),
                        profile_updated_at: 7,
                        host: "private.example.test".into(),
                        port: 22,
                        username: "secret-user".into(),
                        auth_method: "password".into(),
                        jump_host: None,
                    },
                    current_release: None,
                    target_release: DeploymentReleaseIdentity {
                        release_id: "release-audit".into(),
                        artifact_digest_sha256: "d".repeat(64),
                    },
                    rollback_release: None,
                    preflight: DeploymentPreflightSummary {
                        checked_at: 10,
                        checks: vec![DeploymentPreflightCheckSummary {
                            code: "docker".into(),
                            outcome: DeploymentPreflightOutcome::Passed,
                            summary: "password=must-not-escape".into(),
                        }],
                    },
                },
                remote_root: "/srv/private/app".into(),
                compose_project: "audit".into(),
                compose_files: vec!["compose.yaml".into()],
                services: vec!["web".into()],
                actions: vec![ApprovedDeploymentAction::StageRelease],
                generated_at: 1,
                expires_at: 61_001,
            },
            approval_digest: "e".repeat(64),
            reconciliation_required: false,
            last_event_sequence: 1,
            created_at: 1,
            updated_at: 2,
            started_at: Some(1),
            finished_at: Some(2),
        }
    }

    #[test]
    fn projection_redacts_identity_paths_secrets_and_unknown_payload_fields() {
        let run = run();
        let events = vec![DeploymentRunEventRecord {
            run_id: run.id.clone(),
            sequence: 1,
            event_kind: DeploymentEventKind::RunFailed,
            status: Some(DeploymentRunStatus::Failed),
            summary: "token=must-not-escape".into(),
            payload: Some(json!({
                "phase": "outcome",
                "failureCategory": "healthCheckFailed",
                "stdout": "password=must-not-escape",
                "localPath": "/Users/operator/private",
                "result": {
                    "outcome": "stateUnknown",
                    "evidence": { "ledgerVerified": false, "unknown": "secret" },
                },
            })),
            recorded_at: 2,
        }];
        verify_exact_timeline(&run, &events).unwrap();
        let serialized = serde_json::to_string(&build_value(&run, &events, 3)).unwrap();
        assert!(!serialized.contains("private.example.test"));
        assert!(!serialized.contains("secret-user"));
        assert!(!serialized.contains("/srv/private/app"));
        assert!(!serialized.contains("/Users/operator/private"));
        assert!(!serialized.contains("must-not-escape"));
        assert!(!serialized.contains("stdout"));
        assert!(!serialized.contains("unknown"));
        assert!(serialized.contains("[REDACTED]"));
        assert!(serialized.contains("ledgerVerified"));
    }

    #[test]
    fn exact_timeline_rejects_gaps_wrong_run_and_over_limit() {
        let mut run = run();
        let event = DeploymentRunEventRecord {
            run_id: run.id.clone(),
            sequence: 2,
            event_kind: DeploymentEventKind::RunFailed,
            status: Some(DeploymentRunStatus::Failed),
            summary: "failed".into(),
            payload: None,
            recorded_at: 2,
        };
        assert!(verify_exact_timeline(&run, &[event]).is_err());
        run.last_event_sequence = MAX_AUDIT_EVENTS + 1;
        assert!(verify_exact_timeline(&run, &[]).is_err());
    }

    #[test]
    fn save_is_atomic_and_private_staging_is_removed() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("run.audit.json");
        let document = DeploymentAuditDocument {
            run_id: "run-audit".into(),
            bytes: b"{\"schemaVersion\":1}\n".to_vec(),
            document_sha256: sha256_hex(b"test"),
        };
        save_deployment_audit_document(&document, &path).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), document.bytes);
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }
}
