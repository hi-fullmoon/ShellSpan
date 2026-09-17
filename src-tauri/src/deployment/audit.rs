use super::canonicalization::canonical_sha256;
use super::repository::{DeploymentRunEventRecord, DeploymentRunRecord};
use super::security::{validate_bounded_safe_json, MAX_AUDIT_EVENTS, MAX_AUDIT_EXPORT_BYTES};
use crate::db::{current_timestamp_ms, Database};
use serde::Serialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::Path;

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

fn project_event_payload(payload: Option<&Value>) -> Option<Value> {
    let source = payload?.as_object()?;
    let mut projected = Map::new();
    for key in [
        "beforeEffects",
        "compensated",
        "evidenceComplete",
        "expiresAt",
        "failureCode",
        "finalizerFailures",
        "planDigest",
        "requiresReadOnlyReconciliation",
    ] {
        if let Some(value @ (Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_))) =
            source.get(key)
        {
            projected.insert(key.into(), value.clone());
        }
    }
    (!projected.is_empty()).then_some(Value::Object(projected))
}

fn event_projection(event: &DeploymentRunEventRecord) -> Value {
    json!({
        "sequence": event.sequence,
        "nodeId": event.node_id,
        "attempt": event.attempt,
        "kind": event.event_kind,
        "status": event.status,
        "summaryKey": event.summary_key,
        "payload": project_event_payload(event.payload.as_ref()),
        "recordedAt": event.recorded_at,
    })
}

fn run_projection(run: &DeploymentRunRecord) -> Value {
    json!({
        "id": run.id,
        "workflowId": run.workflow_id,
        "workflowRevision": run.workflow_revision,
        "operationKind": run.operation_kind,
        "triggerKind": run.trigger_kind,
        "status": run.status.as_str(),
        "definitionDigest": run.definition_digest,
        "planDigest": run.plan_digest,
        "createdAt": run.created_at,
        "updatedAt": run.updated_at,
        "startedAt": run.started_at,
        "finishedAt": run.finished_at,
    })
}

fn collect_events(
    database: &Database,
    run: &DeploymentRunRecord,
) -> Result<Vec<DeploymentRunEventRecord>, String> {
    let mut before = None;
    let mut descending = Vec::new();
    loop {
        let page = database.list_deployment_run_events(&run.id, before, 100)?;
        descending.extend(page.items);
        if descending.len() > MAX_AUDIT_EVENTS {
            return Err("DEPLOYMENT_WORKFLOW_AUDIT_EVENT_LIMIT_EXCEEDED".into());
        }
        match page.next_before_sequence {
            Some(next) => before = Some(next),
            None => break,
        }
    }
    descending.reverse();
    if descending
        .iter()
        .enumerate()
        .any(|(index, event)| event.run_id != run.id || event.sequence as usize != index + 1)
    {
        return Err("DEPLOYMENT_WORKFLOW_AUDIT_TIMELINE_INCOMPLETE".into());
    }
    Ok(descending)
}

pub(crate) fn build_deployment_audit_document(
    database: &Database,
    run_id: &str,
) -> Result<DeploymentAuditDocument, String> {
    super::node_registry::validate_identifier("runId", run_id)?;
    let run = database
        .get_deployment_run(run_id)?
        .ok_or_else(|| "DEPLOYMENT_WORKFLOW_RUN_NOT_FOUND".to_string())?;
    let events = collect_events(database, &run)?;
    let nodes = database.list_deployment_run_nodes(run_id)?;
    let receipts = database.list_deployment_effect_receipts(run_id)?;
    let outputs = database.list_deployment_run_outputs(run_id)?;
    let unsigned = json!({
        "schemaVersion": 3,
        "exportedAt": current_timestamp_ms(),
        "run": run_projection(&run),
        "approval": run.approval_summary.as_ref().map(|summary| json!({
            "digest": canonical_sha256(summary).ok(),
            "planDigest": run.plan_digest,
        })),
        "nodes": nodes.iter().map(|node| json!({
            "nodeId": node.node_id,
            "nodeType": node.node_type,
            "nodeTypeVersion": node.node_type_version,
            "status": node.status,
            "lastAttempt": node.last_attempt,
            "startedAt": node.started_at,
            "finishedAt": node.finished_at,
        })).collect::<Vec<_>>(),
        "outputs": outputs.iter().map(|output| json!({
            "nodeId": output.node_id,
            "name": output.output_name,
            "kind": output.output_kind.as_str(),
            "valueDigest": canonical_sha256(&output.value).ok(),
            "artifactReference": output.artifact_reference,
            "createdAt": output.created_at,
        })).collect::<Vec<_>>(),
        "receipts": receipts,
        "timeline": events.iter().map(event_projection).collect::<Vec<_>>(),
        "redactions": [
            "approvalDetails",
            "credentialValues",
            "localPaths",
            "rawNodeOutputs",
            "remoteEndpoints",
            "remoteText",
        ],
    });
    let unsigned_json = validate_bounded_safe_json(
        &unsigned,
        MAX_AUDIT_EXPORT_BYTES,
        "DEPLOYMENT_WORKFLOW_AUDIT_TOO_LARGE",
    )?;
    let document_sha256 = sha256_hex(unsigned_json.as_bytes());
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
        .map_err(|error| format!("failed to encode deployment audit: {error}"))?;
    bytes.push(b'\n');
    if bytes.len() > MAX_AUDIT_EXPORT_BYTES {
        return Err("DEPLOYMENT_WORKFLOW_AUDIT_TOO_LARGE".into());
    }
    if crate::runbook::contains_secret_literal(&String::from_utf8_lossy(&bytes)) {
        return Err("DEPLOYMENT_WORKFLOW_AUDIT_SECRET_SCAN_FAILED".into());
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
        .ok_or_else(|| "DEPLOYMENT_WORKFLOW_AUDIT_DESTINATION_INVALID".to_string())?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("failed to stage deployment audit: {error}"))?;
    temporary
        .write_all(&document.bytes)
        .and_then(|_| temporary.as_file_mut().sync_all())
        .map_err(|error| format!("failed to write deployment audit: {error}"))?;
    temporary
        .persist(path)
        .map_err(|error| format!("failed to publish deployment audit: {}", error.error))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_projection_drops_remote_text_and_unknown_fields() {
        let event = DeploymentRunEventRecord {
            run_id: "run-audit".into(),
            sequence: 1,
            node_id: Some("deploy".into()),
            attempt: Some(1),
            event_kind: "status_changed".into(),
            status: Some("failed".into()),
            summary_key: "deployment.run.failed".into(),
            payload: Some(json!({
                "failureCode": "DEPLOYMENT_WORKFLOW_NODE_FAILED",
                "stdout": "password=must-not-escape",
                "remoteMessage": "untrusted remote text",
            })),
            recorded_at: 1,
        };
        let encoded = serde_json::to_string(&event_projection(&event)).unwrap();
        assert!(encoded.contains("failureCode"));
        assert!(!encoded.contains("must-not-escape"));
        assert!(!encoded.contains("remoteMessage"));
        assert!(!encoded.contains("stdout"));
    }
}
