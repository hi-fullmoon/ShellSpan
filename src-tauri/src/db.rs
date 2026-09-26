use rusqlite::{params, Connection, OptionalExtension, Transaction};
use std::path::Path;
use std::sync::{Arc, Mutex};

const CURRENT_SCHEMA_VERSION: i32 = 11;
const TERMINAL_WORKSPACE_VERSION: u64 = 1;
const MAX_TERMINAL_WORKSPACE_BYTES: usize = 1024 * 1024;
const MAX_TERMINAL_WORKSPACE_SESSIONS: usize = 100;

struct SchemaMigration {
    version: i32,
    name: &'static str,
    sql: &'static str,
}

fn validate_terminal_workspace(workspace_json: &str) -> Result<(), String> {
    if workspace_json.len() > MAX_TERMINAL_WORKSPACE_BYTES {
        return Err("terminal workspace exceeds the storage limit".to_string());
    }
    let workspace: serde_json::Value = serde_json::from_str(workspace_json)
        .map_err(|_| "terminal workspace must be valid JSON".to_string())?;
    let object = workspace
        .as_object()
        .ok_or_else(|| "terminal workspace must be an object".to_string())?;
    if object.get("version").and_then(serde_json::Value::as_u64) != Some(TERMINAL_WORKSPACE_VERSION)
    {
        return Err("terminal workspace version is unsupported".to_string());
    }
    let sessions = object
        .get("sessions")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "terminal workspace sessions must be an array".to_string())?;
    if sessions.len() > MAX_TERMINAL_WORKSPACE_SESSIONS {
        return Err("terminal workspace has too many sessions".to_string());
    }
    Ok(())
}

const SCHEMA_VERSION_TABLE: &str = "
CREATE TABLE schema_version (
    version INTEGER PRIMARY KEY,
    migration_name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
";

const SCHEMA_INITIAL: &str = "
CREATE TABLE profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 22,
    username TEXT NOT NULL,
    auth_method TEXT NOT NULL CHECK(auth_method IN ('password', 'key')),
    keychain_key_id TEXT,
    jump_host_config TEXT,
    organization_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE preferences (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE recent_profiles (
    profile_id TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    PRIMARY KEY (profile_id),
    FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
);

CREATE TABLE sftp_bookmarks (
    id TEXT PRIMARY KEY,
    host TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 22,
    username TEXT NOT NULL,
    path TEXT NOT NULL,
    side TEXT NOT NULL CHECK(side IN ('local', 'remote')),
    label TEXT,
    created_at INTEGER NOT NULL
);

CREATE TABLE terminal_workspace (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    sessions_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE sftp_workspace (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    workspace_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE key_credentials (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    key_type TEXT DEFAULT 'unknown',
    kind TEXT NOT NULL DEFAULT 'keyFile',
    public_key TEXT,
    certificate TEXT,
    service TEXT NOT NULL DEFAULT 'com.shellspan.key'
);
";

const SCHEMA_LEGACY_DEPLOYMENT: &str = "
CREATE TABLE deployment_workflows (
    id TEXT PRIMARY KEY
        CHECK(length(id) BETWEEN 1 AND 128 AND id = trim(id)),
    name TEXT NOT NULL
        CHECK(length(name) BETWEEN 1 AND 200 AND name = trim(name)),
    connection_profile_id TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
    definition_version INTEGER NOT NULL CHECK(definition_version = 1),
    definition_json TEXT NOT NULL
        CHECK(length(CAST(definition_json AS BLOB)) BETWEEN 2 AND 131072)
        CHECK(json_valid(definition_json) AND json_type(definition_json) = 'object'),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
    FOREIGN KEY (connection_profile_id) REFERENCES profiles(id) ON DELETE RESTRICT
);

CREATE TABLE deployment_runs (
    id TEXT PRIMARY KEY
        CHECK(length(id) BETWEEN 1 AND 128 AND id = trim(id)),
    workflow_id TEXT NOT NULL,
    workflow_revision INTEGER NOT NULL CHECK(workflow_revision >= 1),
    source_run_id TEXT,
    operation_kind TEXT NOT NULL
        CHECK(operation_kind IN ('deploy', 'resume', 'rollback')),
    trigger_kind TEXT NOT NULL
        CHECK(trigger_kind IN ('manual', 'agent', 'quick_action', 'recovery')),
    status TEXT NOT NULL
        CHECK(status IN (
            'planned', 'awaiting_approval', 'approved', 'reconciling',
            'in_progress', 'verifying', 'succeeded', 'cancel_requested',
            'canceled', 'failed', 'state_unknown'
        )),
    approval_summary_json TEXT NOT NULL
        CHECK(length(CAST(approval_summary_json AS BLOB)) BETWEEN 2 AND 65536)
        CHECK(json_valid(approval_summary_json) AND json_type(approval_summary_json) = 'object'),
    approval_digest TEXT NOT NULL
        CHECK(length(approval_digest) = 64)
        CHECK(approval_digest = lower(approval_digest))
        CHECK(approval_digest NOT GLOB '*[^0-9a-f]*'),
    reconciliation_required INTEGER NOT NULL DEFAULT 0
        CHECK(reconciliation_required IN (0, 1)),
    last_event_sequence INTEGER NOT NULL DEFAULT 0 CHECK(last_event_sequence >= 0),
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
    started_at INTEGER CHECK(started_at IS NULL OR started_at >= created_at),
    finished_at INTEGER CHECK(finished_at IS NULL OR finished_at >= created_at),
    CHECK(source_run_id IS NULL OR source_run_id <> id),
    CHECK(status <> 'state_unknown' OR reconciliation_required = 1),
    CHECK(
        (status IN ('succeeded', 'canceled', 'failed') AND finished_at IS NOT NULL)
        OR (status NOT IN ('succeeded', 'canceled', 'failed'))
    ),
    FOREIGN KEY (workflow_id) REFERENCES deployment_workflows(id) ON DELETE CASCADE,
    FOREIGN KEY (source_run_id) REFERENCES deployment_runs(id) ON DELETE SET NULL
);

CREATE TABLE deployment_run_events (
    run_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK(sequence >= 1),
    event_kind TEXT NOT NULL
        CHECK(event_kind IN (
            'run_created', 'approval_requested', 'approval_granted',
            'approval_rejected', 'reconciliation_started',
            'reconciliation_completed', 'status_changed',
            'cancellation_requested', 'resume_linked', 'rollback_linked',
            'run_succeeded', 'run_canceled', 'run_failed'
        )),
    status TEXT
        CHECK(status IS NULL OR status IN (
            'planned', 'awaiting_approval', 'approved', 'reconciling',
            'in_progress', 'verifying', 'succeeded', 'cancel_requested',
            'canceled', 'failed', 'state_unknown'
        )),
    summary TEXT NOT NULL
        CHECK(length(CAST(summary AS BLOB)) BETWEEN 1 AND 4096 AND summary = trim(summary)),
    payload_json TEXT
        CHECK(payload_json IS NULL OR (
            length(CAST(payload_json AS BLOB)) BETWEEN 2 AND 65536
            AND json_valid(payload_json)
            AND json_type(payload_json) = 'object'
        )),
    recorded_at INTEGER NOT NULL CHECK(recorded_at >= 0),
    PRIMARY KEY (run_id, sequence),
    FOREIGN KEY (run_id) REFERENCES deployment_runs(id) ON DELETE CASCADE
);

CREATE INDEX deployment_workflows_profile_idx
    ON deployment_workflows(connection_profile_id, updated_at DESC);
CREATE INDEX deployment_runs_workflow_idx
    ON deployment_runs(workflow_id, created_at DESC);
CREATE INDEX deployment_runs_status_idx
    ON deployment_runs(status, updated_at DESC);
CREATE INDEX deployment_runs_source_idx
    ON deployment_runs(source_run_id) WHERE source_run_id IS NOT NULL;
CREATE INDEX deployment_run_events_recorded_idx
    ON deployment_run_events(run_id, recorded_at);

CREATE TRIGGER deployment_run_events_sequence_guard
BEFORE INSERT ON deployment_run_events
FOR EACH ROW
WHEN NEW.sequence <> COALESCE(
    (SELECT MAX(sequence) + 1 FROM deployment_run_events WHERE run_id = NEW.run_id),
    1
)
BEGIN
    SELECT RAISE(ABORT, 'deployment event sequence must be contiguous');
END;

CREATE TRIGGER deployment_run_events_advance_sequence
AFTER INSERT ON deployment_run_events
FOR EACH ROW
BEGIN
    UPDATE deployment_runs
    SET last_event_sequence = NEW.sequence,
        updated_at = MAX(updated_at, NEW.recorded_at)
    WHERE id = NEW.run_id;
END;

CREATE TRIGGER deployment_run_events_immutable
BEFORE UPDATE ON deployment_run_events
BEGIN
    SELECT RAISE(ABORT, 'deployment events are immutable');
END;

CREATE TRIGGER deployment_run_events_no_direct_delete
BEFORE DELETE ON deployment_run_events
WHEN EXISTS (SELECT 1 FROM deployment_runs WHERE id = OLD.run_id)
BEGIN
    SELECT RAISE(ABORT, 'deployment events may only be deleted with their run');
END;

CREATE TRIGGER deployment_runs_no_direct_delete
BEFORE DELETE ON deployment_runs
WHEN EXISTS (SELECT 1 FROM deployment_workflows WHERE id = OLD.workflow_id)
BEGIN
    SELECT RAISE(ABORT, 'deployment runs may only be deleted with their workflow');
END;
";

const SCHEMA_LEGACY_PLAN_GUARDS: &str = "
CREATE INDEX deployment_runs_approval_digest_idx
    ON deployment_runs(approval_digest, created_at DESC);

CREATE TRIGGER deployment_runs_initial_status_guard
BEFORE INSERT ON deployment_runs
FOR EACH ROW
WHEN NEW.status <> 'planned'
BEGIN
    SELECT RAISE(ABORT, 'deployment runs must be created as planned');
END;

CREATE TRIGGER deployment_runs_status_transition_guard
BEFORE UPDATE OF status ON deployment_runs
FOR EACH ROW
WHEN OLD.status <> NEW.status AND NOT (
    (OLD.status = 'planned' AND NEW.status IN ('awaiting_approval', 'canceled'))
    OR (OLD.status = 'awaiting_approval' AND NEW.status IN ('approved', 'canceled', 'failed'))
    OR (OLD.status = 'approved' AND NEW.status IN (
        'awaiting_approval', 'reconciling', 'in_progress', 'cancel_requested', 'failed'
    ))
    OR (OLD.status = 'reconciling' AND NEW.status IN (
        'approved', 'in_progress', 'canceled', 'failed', 'state_unknown'
    ))
    OR (OLD.status = 'in_progress' AND NEW.status IN (
        'verifying', 'cancel_requested', 'failed', 'state_unknown'
    ))
    OR (OLD.status = 'verifying' AND NEW.status IN (
        'succeeded', 'cancel_requested', 'failed', 'state_unknown'
    ))
    OR (OLD.status = 'cancel_requested' AND NEW.status IN ('canceled', 'failed', 'state_unknown'))
    OR (OLD.status = 'state_unknown' AND NEW.status = 'reconciling')
)
BEGIN
    SELECT RAISE(ABORT, 'invalid deployment run status transition');
END;

CREATE TRIGGER deployment_runs_frozen_plan_immutable
BEFORE UPDATE OF workflow_id, workflow_revision, source_run_id, operation_kind,
                 trigger_kind, approval_summary_json, approval_digest
ON deployment_runs
WHEN EXISTS (SELECT 1 FROM deployment_workflows WHERE id = OLD.workflow_id)
BEGIN
    SELECT RAISE(ABORT, 'deployment run plan inputs are immutable');
END;
";

const SCHEMA_LEGACY_RUNTIME: &str = "
CREATE TABLE deployment_transfer_receipts (
    operation_id TEXT PRIMARY KEY
        CHECK(length(operation_id) BETWEEN 1 AND 128 AND operation_id = trim(operation_id)),
    run_id TEXT NOT NULL,
    plan_id TEXT NOT NULL
        CHECK(length(plan_id) = 69 AND plan_id LIKE 'plan-%'),
    plan_digest TEXT NOT NULL
        CHECK(length(plan_digest) = 64)
        CHECK(plan_digest = lower(plan_digest))
        CHECK(plan_digest NOT GLOB '*[^0-9a-f]*'),
    request_json TEXT NOT NULL
        CHECK(length(CAST(request_json AS BLOB)) BETWEEN 2 AND 65536)
        CHECK(json_valid(request_json) AND json_type(request_json) = 'object'),
    result_json TEXT NOT NULL
        CHECK(length(CAST(result_json AS BLOB)) BETWEEN 2 AND 65536)
        CHECK(json_valid(result_json) AND json_type(result_json) = 'object'),
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    FOREIGN KEY (run_id) REFERENCES deployment_runs(id) ON DELETE CASCADE
);

CREATE INDEX deployment_transfer_receipts_run_idx
    ON deployment_transfer_receipts(run_id, created_at DESC);

CREATE TRIGGER deployment_transfer_receipts_immutable
BEFORE UPDATE ON deployment_transfer_receipts
BEGIN
    SELECT RAISE(ABORT, 'deployment transfer receipts are immutable');
END;

CREATE TRIGGER deployment_transfer_receipts_no_direct_delete
BEFORE DELETE ON deployment_transfer_receipts
WHEN EXISTS (SELECT 1 FROM deployment_runs WHERE id = OLD.run_id)
BEGIN
    SELECT RAISE(ABORT, 'deployment transfer receipts may only be deleted with their run');
END;
";

const SCHEMA_LEGACY_RECONCILIATION: &str = "
DROP TRIGGER deployment_runs_status_transition_guard;

CREATE TRIGGER deployment_runs_status_transition_guard
BEFORE UPDATE OF status ON deployment_runs
FOR EACH ROW
WHEN OLD.status <> NEW.status AND NOT (
    (OLD.status = 'planned' AND NEW.status IN ('awaiting_approval', 'canceled'))
    OR (OLD.status = 'awaiting_approval' AND NEW.status IN ('approved', 'canceled', 'failed'))
    OR (OLD.status = 'approved' AND NEW.status IN (
        'awaiting_approval', 'reconciling', 'in_progress', 'cancel_requested', 'failed'
    ))
    OR (OLD.status = 'reconciling' AND NEW.status IN (
        'approved', 'in_progress', 'verifying', 'succeeded', 'cancel_requested',
        'canceled', 'failed', 'state_unknown'
    ))
    OR (OLD.status = 'in_progress' AND NEW.status IN (
        'reconciling', 'verifying', 'cancel_requested', 'failed', 'state_unknown'
    ))
    OR (OLD.status = 'verifying' AND NEW.status IN (
        'reconciling', 'succeeded', 'cancel_requested', 'failed', 'state_unknown'
    ))
    OR (OLD.status = 'cancel_requested' AND NEW.status IN (
        'reconciling', 'canceled', 'failed', 'state_unknown'
    ))
    OR (OLD.status = 'state_unknown' AND NEW.status = 'reconciling')
)
BEGIN
    SELECT RAISE(ABORT, 'invalid deployment run status transition');
END;
";

const SCHEMA_LEGACY_HISTORY_NOTIFICATIONS: &str = "
CREATE TABLE deployment_notification_receipts (
    run_id TEXT NOT NULL,
    event_sequence INTEGER NOT NULL CHECK(event_sequence >= 1),
    notification_kind TEXT NOT NULL
        CHECK(notification_kind IN (
            'succeeded', 'automatic_restore_completed', 'failed', 'user_action_required'
        )),
    run_status TEXT NOT NULL
        CHECK(run_status IN ('awaiting_approval', 'succeeded', 'canceled', 'failed', 'state_unknown')),
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    PRIMARY KEY (run_id, event_sequence, notification_kind),
    FOREIGN KEY (run_id) REFERENCES deployment_runs(id) ON DELETE CASCADE
);

CREATE INDEX deployment_notification_receipts_created_idx
    ON deployment_notification_receipts(created_at DESC);

CREATE TRIGGER deployment_notification_receipts_immutable
BEFORE UPDATE ON deployment_notification_receipts
BEGIN
    SELECT RAISE(ABORT, 'deployment notification receipts are immutable');
END;

CREATE TRIGGER deployment_notification_receipts_no_direct_delete
BEFORE DELETE ON deployment_notification_receipts
WHEN EXISTS (SELECT 1 FROM deployment_runs WHERE id = OLD.run_id)
BEGIN
    SELECT RAISE(ABORT, 'deployment notification receipts may only be deleted with their run');
END;

-- Existing durable outcomes predate Phase 7 notifications. Mark them delivered so an
-- upgrade never produces a burst of stale notifications; new transitions remain claimable.
INSERT INTO deployment_notification_receipts (
    run_id, event_sequence, notification_kind, run_status, created_at
)
SELECT id, last_event_sequence,
       CASE
           WHEN status = 'succeeded' THEN 'succeeded'
           WHEN status = 'failed' THEN 'failed'
           WHEN status = 'canceled' THEN 'automatic_restore_completed'
           ELSE 'user_action_required'
       END,
       status, updated_at
FROM deployment_runs
WHERE last_event_sequence >= 1
  AND (
      status IN ('awaiting_approval', 'succeeded', 'failed', 'state_unknown')
      OR (
          status = 'canceled'
          AND EXISTS (
              SELECT 1 FROM deployment_run_events e
              WHERE e.run_id = deployment_runs.id
                AND e.sequence = deployment_runs.last_event_sequence
                AND (
                    json_extract(e.payload_json, '$.rollbackReleaseId') IS NOT NULL
                    OR json_extract(e.payload_json, '$.result.evidence.rollbackReleaseVerified') = 1
                )
          )
      )
  );
";

const SCHEMA_DEPLOYMENT_WORKFLOW_FOUNDATION: &str = r#"
CREATE TABLE deployment_current_workflows (
    id TEXT PRIMARY KEY
        CHECK(length(id) BETWEEN 1 AND 128 AND id = trim(id)),
    name TEXT NOT NULL
        CHECK(length(CAST(name AS BLOB)) BETWEEN 1 AND 200 AND name = trim(name)),
    enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
    archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0, 1)),
    head_revision INTEGER NOT NULL CHECK(head_revision >= 1),
    head_layout_revision INTEGER NOT NULL DEFAULT 0 CHECK(head_layout_revision >= 0),
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
    CHECK(archived = 0 OR enabled = 0)
);

CREATE TABLE deployment_current_workflow_revisions (
    workflow_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision >= 1),
    schema_version INTEGER NOT NULL CHECK(schema_version = 3),
    definition_json TEXT NOT NULL
        CHECK(length(CAST(definition_json AS BLOB)) BETWEEN 2 AND 262144)
        CHECK(json_valid(definition_json) AND json_type(definition_json) = 'object'),
    definition_digest TEXT NOT NULL
        CHECK(length(definition_digest) = 71 AND definition_digest LIKE 'sha256:%')
        CHECK(substr(definition_digest, 8) = lower(substr(definition_digest, 8)))
        CHECK(substr(definition_digest, 8) NOT GLOB '*[^0-9a-f]*'),
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    PRIMARY KEY (workflow_id, revision),
    UNIQUE (workflow_id, definition_digest, revision),
    FOREIGN KEY (workflow_id) REFERENCES deployment_current_workflows(id) ON DELETE CASCADE
);

CREATE TABLE deployment_current_workflow_layouts (
    workflow_id TEXT NOT NULL,
    layout_revision INTEGER NOT NULL CHECK(layout_revision >= 1),
    schema_version INTEGER NOT NULL CHECK(schema_version = 1),
    layout_json TEXT NOT NULL
        CHECK(length(CAST(layout_json AS BLOB)) BETWEEN 2 AND 131072)
        CHECK(json_valid(layout_json) AND json_type(layout_json) = 'object'),
    layout_digest TEXT NOT NULL
        CHECK(length(layout_digest) = 71 AND layout_digest LIKE 'sha256:%')
        CHECK(substr(layout_digest, 8) = lower(substr(layout_digest, 8)))
        CHECK(substr(layout_digest, 8) NOT GLOB '*[^0-9a-f]*'),
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    PRIMARY KEY (workflow_id, layout_revision),
    FOREIGN KEY (workflow_id) REFERENCES deployment_current_workflows(id) ON DELETE CASCADE
);

CREATE TABLE deployment_current_runs (
    id TEXT PRIMARY KEY
        CHECK(length(id) BETWEEN 1 AND 128 AND id = trim(id)),
    workflow_id TEXT NOT NULL,
    workflow_revision INTEGER NOT NULL CHECK(workflow_revision >= 1),
    operation_kind TEXT NOT NULL CHECK(operation_kind IN ('deploy', 'rollback')),
    trigger_kind TEXT NOT NULL
        CHECK(trigger_kind IN ('manual', 'agent', 'quick_action', 'recovery')),
    status TEXT NOT NULL
        CHECK(status IN (
            'planned', 'awaiting_approval', 'approved', 'reconciling',
            'in_progress', 'verifying', 'succeeded', 'cancel_requested',
            'canceled', 'failed', 'state_unknown'
        )),
    definition_digest TEXT NOT NULL
        CHECK(length(definition_digest) = 71 AND definition_digest LIKE 'sha256:%'),
    plan_digest TEXT NOT NULL UNIQUE
        CHECK(length(plan_digest) = 71 AND plan_digest LIKE 'sha256:%'),
    plan_json TEXT NOT NULL
        CHECK(length(CAST(plan_json AS BLOB)) BETWEEN 2 AND 524288)
        CHECK(json_valid(plan_json) AND json_type(plan_json) = 'object'),
    approval_summary_json TEXT
        CHECK(approval_summary_json IS NULL OR (
            length(CAST(approval_summary_json AS BLOB)) BETWEEN 2 AND 65536
            AND json_valid(approval_summary_json)
            AND json_type(approval_summary_json) = 'object'
        )),
    last_event_sequence INTEGER NOT NULL DEFAULT 0 CHECK(last_event_sequence >= 0),
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
    started_at INTEGER CHECK(started_at IS NULL OR started_at >= created_at),
    finished_at INTEGER CHECK(finished_at IS NULL OR finished_at >= created_at),
    FOREIGN KEY (workflow_id, workflow_revision)
        REFERENCES deployment_current_workflow_revisions(workflow_id, revision) ON DELETE RESTRICT
);

CREATE TABLE deployment_current_run_nodes (
    run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    node_type TEXT NOT NULL,
    node_type_version INTEGER NOT NULL CHECK(node_type_version >= 1),
    status TEXT NOT NULL
        CHECK(status IN (
            'pending', 'ready', 'running', 'awaiting_approval', 'succeeded',
            'skipped', 'retry_waiting', 'cancel_requested', 'canceled', 'failed',
            'state_unknown', 'compensating', 'compensated'
        )),
    last_attempt INTEGER NOT NULL DEFAULT 0 CHECK(last_attempt >= 0),
    output_summary_json TEXT
        CHECK(output_summary_json IS NULL OR (
            length(CAST(output_summary_json AS BLOB)) BETWEEN 2 AND 65536
            AND json_valid(output_summary_json)
            AND json_type(output_summary_json) = 'object'
        )),
    started_at INTEGER,
    finished_at INTEGER,
    updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
    PRIMARY KEY (run_id, node_id),
    FOREIGN KEY (run_id) REFERENCES deployment_current_runs(id) ON DELETE CASCADE
);

CREATE TABLE deployment_current_node_attempts (
    run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    attempt INTEGER NOT NULL CHECK(attempt >= 1),
    schema_version INTEGER NOT NULL CHECK(schema_version = 1),
    node_type TEXT NOT NULL,
    node_type_version INTEGER NOT NULL CHECK(node_type_version >= 1),
    executor_version TEXT NOT NULL CHECK(length(executor_version) BETWEEN 1 AND 128),
    idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 256),
    status TEXT NOT NULL
        CHECK(status IN (
            'pending', 'running', 'succeeded', 'failed', 'canceled',
            'state_unknown', 'compensated'
        )),
    failure_category TEXT CHECK(failure_category IS NULL OR length(failure_category) <= 128),
    started_at INTEGER,
    finished_at INTEGER,
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
    PRIMARY KEY (run_id, node_id, attempt),
    UNIQUE (idempotency_key),
    FOREIGN KEY (run_id, node_id)
        REFERENCES deployment_current_run_nodes(run_id, node_id) ON DELETE CASCADE
);

CREATE TABLE deployment_current_artifacts (
    artifact_reference TEXT PRIMARY KEY
        CHECK(length(artifact_reference) = 91 AND artifact_reference LIKE 'deployment-artifact:sha256:%'),
    manifest_digest TEXT NOT NULL UNIQUE
        CHECK(length(manifest_digest) = 71 AND manifest_digest LIKE 'sha256:%'),
    content_digest TEXT NOT NULL
        CHECK(length(content_digest) = 71 AND content_digest LIKE 'sha256:%'),
    artifact_type TEXT NOT NULL CHECK(length(artifact_type) BETWEEN 1 AND 128),
    manifest_json TEXT NOT NULL
        CHECK(length(CAST(manifest_json AS BLOB)) BETWEEN 2 AND 262144)
        CHECK(json_valid(manifest_json) AND json_type(manifest_json) = 'object'),
    component_count INTEGER NOT NULL CHECK(component_count BETWEEN 1 AND 64),
    total_size INTEGER NOT NULL CHECK(total_size >= 0),
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    verified_at INTEGER NOT NULL CHECK(verified_at >= created_at)
);

CREATE TABLE deployment_current_run_outputs (
    run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    output_name TEXT NOT NULL CHECK(length(output_name) BETWEEN 1 AND 64),
    output_kind TEXT NOT NULL CHECK(output_kind IN ('scalar', 'artifact', 'receipt', 'evidence')),
    value_json TEXT NOT NULL
        CHECK(length(CAST(value_json AS BLOB)) BETWEEN 1 AND 65536)
        CHECK(json_valid(value_json)),
    value_digest TEXT NOT NULL
        CHECK(length(value_digest) = 71 AND value_digest LIKE 'sha256:%'),
    artifact_reference TEXT,
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    PRIMARY KEY (run_id, node_id, output_name),
    FOREIGN KEY (run_id, node_id)
        REFERENCES deployment_current_run_nodes(run_id, node_id) ON DELETE CASCADE,
    FOREIGN KEY (artifact_reference)
        REFERENCES deployment_current_artifacts(artifact_reference) ON DELETE RESTRICT,
    CHECK((output_kind = 'artifact') = (artifact_reference IS NOT NULL))
);

CREATE TABLE deployment_current_artifact_refs (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
    artifact_reference TEXT NOT NULL,
    workflow_id TEXT,
    run_id TEXT,
    node_id TEXT,
    ref_kind TEXT NOT NULL
        CHECK(ref_kind IN ('run', 'node', 'release_current', 'release_previous', 'audit')),
    owner_id TEXT NOT NULL CHECK(length(owner_id) BETWEEN 1 AND 256),
    lease_active INTEGER NOT NULL DEFAULT 0 CHECK(lease_active IN (0, 1)),
    retain_until INTEGER CHECK(retain_until IS NULL OR retain_until >= 0),
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
    UNIQUE (artifact_reference, ref_kind, owner_id),
    FOREIGN KEY (artifact_reference)
        REFERENCES deployment_current_artifacts(artifact_reference) ON DELETE RESTRICT,
    FOREIGN KEY (workflow_id) REFERENCES deployment_current_workflows(id) ON DELETE RESTRICT,
    FOREIGN KEY (run_id) REFERENCES deployment_current_runs(id) ON DELETE RESTRICT
);

CREATE TABLE deployment_current_effect_receipts (
    operation_id TEXT PRIMARY KEY CHECK(length(operation_id) BETWEEN 1 AND 128),
    schema_version INTEGER NOT NULL CHECK(schema_version = 1),
    receipt_type TEXT NOT NULL CHECK(length(receipt_type) BETWEEN 1 AND 128),
    run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    attempt INTEGER NOT NULL CHECK(attempt >= 1),
    target_id TEXT NOT NULL CHECK(length(target_id) BETWEEN 1 AND 64),
    plan_digest TEXT NOT NULL
        CHECK(length(plan_digest) = 71 AND plan_digest LIKE 'sha256:%'),
    payload_digest TEXT NOT NULL
        CHECK(length(payload_digest) = 71 AND payload_digest LIKE 'sha256:%'),
    receipt_json TEXT NOT NULL
        CHECK(length(CAST(receipt_json AS BLOB)) BETWEEN 2 AND 65536)
        CHECK(json_valid(receipt_json) AND json_type(receipt_json) = 'object'),
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    UNIQUE (run_id, node_id, attempt, receipt_type),
    FOREIGN KEY (run_id, node_id, attempt)
        REFERENCES deployment_current_node_attempts(run_id, node_id, attempt) ON DELETE RESTRICT
);

CREATE TABLE deployment_current_run_events (
    run_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK(sequence >= 1),
    node_id TEXT,
    attempt INTEGER CHECK(attempt IS NULL OR attempt >= 1),
    event_kind TEXT NOT NULL CHECK(length(event_kind) BETWEEN 1 AND 128),
    status TEXT CHECK(status IS NULL OR length(status) BETWEEN 1 AND 64),
    summary_key TEXT NOT NULL CHECK(length(summary_key) BETWEEN 1 AND 256),
    payload_json TEXT
        CHECK(payload_json IS NULL OR (
            length(CAST(payload_json AS BLOB)) BETWEEN 2 AND 65536
            AND json_valid(payload_json)
            AND json_type(payload_json) = 'object'
        )),
    recorded_at INTEGER NOT NULL CHECK(recorded_at >= 0),
    PRIMARY KEY (run_id, sequence),
    FOREIGN KEY (run_id) REFERENCES deployment_current_runs(id) ON DELETE CASCADE
);

CREATE INDEX deployment_current_workflows_page_idx
    ON deployment_current_workflows(archived, updated_at DESC, id DESC);
CREATE INDEX deployment_current_runs_workflow_idx
    ON deployment_current_runs(workflow_id, created_at DESC, id DESC);
CREATE INDEX deployment_current_runs_status_idx
    ON deployment_current_runs(status, updated_at DESC);
CREATE INDEX deployment_current_run_nodes_status_idx
    ON deployment_current_run_nodes(run_id, status, node_id);
CREATE INDEX deployment_current_attempts_page_idx
    ON deployment_current_node_attempts(run_id, node_id, attempt DESC);
CREATE INDEX deployment_current_artifact_refs_projection_idx
    ON deployment_current_artifact_refs(artifact_reference, lease_active, ref_kind, retain_until);
CREATE INDEX deployment_current_events_page_idx
    ON deployment_current_run_events(run_id, sequence DESC);

CREATE TRIGGER deployment_current_workflow_revisions_immutable
BEFORE UPDATE ON deployment_current_workflow_revisions
BEGIN
    SELECT RAISE(ABORT, 'deployment workflow revisions are immutable');
END;

CREATE TRIGGER deployment_current_workflow_layouts_immutable
BEFORE UPDATE ON deployment_current_workflow_layouts
BEGIN
    SELECT RAISE(ABORT, 'deployment workflow layouts are immutable');
END;

CREATE TRIGGER deployment_current_runs_identity_immutable
BEFORE UPDATE OF workflow_id, workflow_revision, operation_kind, trigger_kind,
                 definition_digest, plan_digest, plan_json
ON deployment_current_runs
BEGIN
    SELECT RAISE(ABORT, 'deployment run identity is immutable');
END;

CREATE TRIGGER deployment_current_run_nodes_identity_immutable
BEFORE UPDATE OF run_id, node_id, node_type, node_type_version
ON deployment_current_run_nodes
BEGIN
    SELECT RAISE(ABORT, 'deployment run node identity is immutable');
END;

CREATE TRIGGER deployment_current_attempts_identity_immutable
BEFORE UPDATE OF run_id, node_id, attempt, schema_version, node_type,
                 node_type_version, executor_version, idempotency_key, created_at
ON deployment_current_node_attempts
BEGIN
    SELECT RAISE(ABORT, 'deployment node attempt identity is immutable');
END;

CREATE TRIGGER deployment_current_outputs_immutable
BEFORE UPDATE ON deployment_current_run_outputs
BEGIN
    SELECT RAISE(ABORT, 'deployment run outputs are immutable');
END;

CREATE TRIGGER deployment_current_artifacts_identity_immutable
BEFORE UPDATE OF artifact_reference, manifest_digest, content_digest, artifact_type,
                 manifest_json, component_count, total_size, created_at
ON deployment_current_artifacts
BEGIN
    SELECT RAISE(ABORT, 'deployment artifact identity is immutable');
END;

CREATE TRIGGER deployment_current_artifact_refs_identity_immutable
BEFORE UPDATE OF id, artifact_reference, workflow_id, run_id, node_id,
                 ref_kind, owner_id, created_at
ON deployment_current_artifact_refs
BEGIN
    SELECT RAISE(ABORT, 'deployment artifact reference identity is immutable');
END;

CREATE TRIGGER deployment_current_receipts_immutable
BEFORE UPDATE ON deployment_current_effect_receipts
BEGIN
    SELECT RAISE(ABORT, 'deployment effect receipts are immutable');
END;

CREATE TRIGGER deployment_current_events_sequence_guard
BEFORE INSERT ON deployment_current_run_events
FOR EACH ROW
WHEN NEW.sequence <> COALESCE(
    (SELECT MAX(sequence) + 1 FROM deployment_current_run_events WHERE run_id = NEW.run_id),
    1
)
BEGIN
    SELECT RAISE(ABORT, 'deployment event sequence must be contiguous');
END;

CREATE TRIGGER deployment_current_events_advance_sequence
AFTER INSERT ON deployment_current_run_events
FOR EACH ROW
BEGIN
    UPDATE deployment_current_runs
    SET last_event_sequence = NEW.sequence,
        updated_at = MAX(updated_at, NEW.recorded_at)
    WHERE id = NEW.run_id;
END;

CREATE TRIGGER deployment_current_events_immutable
BEFORE UPDATE ON deployment_current_run_events
BEGIN
    SELECT RAISE(ABORT, 'deployment run events are immutable');
END;

CREATE TRIGGER deployment_current_events_no_direct_delete
BEFORE DELETE ON deployment_current_run_events
WHEN EXISTS (SELECT 1 FROM deployment_current_runs WHERE id = OLD.run_id)
BEGIN
    SELECT RAISE(ABORT, 'deployment events may only be deleted with their run');
END;

CREATE TRIGGER deployment_current_runs_no_direct_delete
BEFORE DELETE ON deployment_current_runs
WHEN EXISTS (SELECT 1 FROM deployment_current_workflows WHERE id = OLD.workflow_id)
BEGIN
    SELECT RAISE(ABORT, 'deployment runs may only be deleted with their workflow');
END;

CREATE TRIGGER deployment_current_workflows_protect_references
BEFORE DELETE ON deployment_current_workflows
WHEN EXISTS (SELECT 1 FROM deployment_current_runs WHERE workflow_id = OLD.id)
  OR EXISTS (SELECT 1 FROM deployment_current_artifact_refs WHERE workflow_id = OLD.id)
BEGIN
    SELECT RAISE(ABORT, 'deployment workflow has durable references and must be archived');
END;
"#;

const SCHEMA_DEPLOYMENT_WORKFLOW_INTEGRITY_GUARDS: &str = r#"
CREATE TRIGGER deployment_current_runs_digest_guard
BEFORE INSERT ON deployment_current_runs
WHEN substr(NEW.definition_digest, 8) <> lower(substr(NEW.definition_digest, 8))
  OR substr(NEW.definition_digest, 8) GLOB '*[^0-9a-f]*'
  OR substr(NEW.plan_digest, 8) <> lower(substr(NEW.plan_digest, 8))
  OR substr(NEW.plan_digest, 8) GLOB '*[^0-9a-f]*'
BEGIN
    SELECT RAISE(ABORT, 'deployment run digest is invalid');
END;

CREATE TRIGGER deployment_current_artifacts_digest_guard
BEFORE INSERT ON deployment_current_artifacts
WHEN NEW.artifact_reference <> ('deployment-artifact:' || NEW.manifest_digest)
  OR substr(NEW.manifest_digest, 8) <> lower(substr(NEW.manifest_digest, 8))
  OR substr(NEW.manifest_digest, 8) GLOB '*[^0-9a-f]*'
  OR substr(NEW.content_digest, 8) <> lower(substr(NEW.content_digest, 8))
  OR substr(NEW.content_digest, 8) GLOB '*[^0-9a-f]*'
BEGIN
    SELECT RAISE(ABORT, 'deployment artifact identity is invalid');
END;

CREATE TRIGGER deployment_current_outputs_digest_guard
BEFORE INSERT ON deployment_current_run_outputs
WHEN substr(NEW.value_digest, 8) <> lower(substr(NEW.value_digest, 8))
  OR substr(NEW.value_digest, 8) GLOB '*[^0-9a-f]*'
BEGIN
    SELECT RAISE(ABORT, 'deployment output digest is invalid');
END;

CREATE TRIGGER deployment_current_receipts_binding_guard
BEFORE INSERT ON deployment_current_effect_receipts
WHEN substr(NEW.plan_digest, 8) <> lower(substr(NEW.plan_digest, 8))
  OR substr(NEW.plan_digest, 8) GLOB '*[^0-9a-f]*'
  OR substr(NEW.payload_digest, 8) <> lower(substr(NEW.payload_digest, 8))
  OR substr(NEW.payload_digest, 8) GLOB '*[^0-9a-f]*'
  OR NEW.plan_digest <> (SELECT plan_digest FROM deployment_current_runs WHERE id = NEW.run_id)
BEGIN
    SELECT RAISE(ABORT, 'deployment receipt binding is invalid');
END;

CREATE TRIGGER deployment_current_attempts_sequence_guard
BEFORE INSERT ON deployment_current_node_attempts
WHEN NEW.attempt <> COALESCE(
    (SELECT MAX(attempt) + 1 FROM deployment_current_node_attempts
     WHERE run_id = NEW.run_id AND node_id = NEW.node_id),
    1
)
BEGIN
    SELECT RAISE(ABORT, 'deployment attempt sequence must be contiguous');
END;

CREATE TRIGGER deployment_current_workflow_revisions_no_direct_delete
BEFORE DELETE ON deployment_current_workflow_revisions
WHEN EXISTS (SELECT 1 FROM deployment_current_workflows WHERE id = OLD.workflow_id)
BEGIN
    SELECT RAISE(ABORT, 'deployment workflow revisions may only be deleted with their workflow');
END;

CREATE TRIGGER deployment_current_workflow_layouts_no_direct_delete
BEFORE DELETE ON deployment_current_workflow_layouts
WHEN EXISTS (SELECT 1 FROM deployment_current_workflows WHERE id = OLD.workflow_id)
BEGIN
    SELECT RAISE(ABORT, 'deployment workflow layouts may only be deleted with their workflow');
END;

CREATE TRIGGER deployment_current_run_nodes_no_direct_delete
BEFORE DELETE ON deployment_current_run_nodes
WHEN EXISTS (SELECT 1 FROM deployment_current_runs WHERE id = OLD.run_id)
BEGIN
    SELECT RAISE(ABORT, 'deployment run nodes may only be deleted with their run');
END;

CREATE TRIGGER deployment_current_attempts_no_direct_delete
BEFORE DELETE ON deployment_current_node_attempts
WHEN EXISTS (
    SELECT 1 FROM deployment_current_run_nodes
    WHERE run_id = OLD.run_id AND node_id = OLD.node_id
)
BEGIN
    SELECT RAISE(ABORT, 'deployment attempts may only be deleted with their run node');
END;

CREATE TRIGGER deployment_current_outputs_no_direct_delete
BEFORE DELETE ON deployment_current_run_outputs
WHEN EXISTS (
    SELECT 1 FROM deployment_current_run_nodes
    WHERE run_id = OLD.run_id AND node_id = OLD.node_id
)
BEGIN
    SELECT RAISE(ABORT, 'deployment outputs may only be deleted with their run node');
END;

CREATE TRIGGER deployment_current_receipts_no_direct_delete
BEFORE DELETE ON deployment_current_effect_receipts
WHEN EXISTS (SELECT 1 FROM deployment_current_runs WHERE id = OLD.run_id)
BEGIN
    SELECT RAISE(ABORT, 'deployment receipts may only be deleted with their run');
END;
"#;

const SCHEMA_DEPLOYMENT_WORKFLOW_PROFILE_GUARD: &str = r#"
CREATE TRIGGER deployment_current_profiles_protect_current_workflows
BEFORE DELETE ON profiles
WHEN EXISTS (
    SELECT 1
    FROM deployment_current_workflows w
    JOIN deployment_current_workflow_revisions r
      ON r.workflow_id = w.id AND r.revision = w.head_revision,
         json_each(r.definition_json, '$.targets') target
    WHERE json_extract(target.value, '$.connectionProfileId') = OLD.id
)
BEGIN
    SELECT RAISE(ABORT, 'profile is referenced by a deployment workflow');
END;
"#;

const SCHEMA_DEPLOYMENT_WORKFLOW_CANONICAL_NAMES: &str = r#"
ALTER TABLE deployment_workflows RENAME TO deployment_legacy_workflows;
ALTER TABLE deployment_runs RENAME TO deployment_legacy_runs;
ALTER TABLE deployment_run_events RENAME TO deployment_legacy_run_events;
ALTER TABLE deployment_transfer_receipts RENAME TO deployment_legacy_transfer_receipts;
ALTER TABLE deployment_notification_receipts RENAME TO deployment_legacy_notification_receipts;

ALTER TABLE deployment_current_workflows RENAME TO deployment_workflows;
ALTER TABLE deployment_current_workflow_revisions RENAME TO deployment_workflow_revisions;
ALTER TABLE deployment_current_workflow_layouts RENAME TO deployment_workflow_layouts;
ALTER TABLE deployment_current_runs RENAME TO deployment_runs;
ALTER TABLE deployment_current_run_nodes RENAME TO deployment_run_nodes;
ALTER TABLE deployment_current_node_attempts RENAME TO deployment_node_attempts;
ALTER TABLE deployment_current_run_outputs RENAME TO deployment_run_outputs;
ALTER TABLE deployment_current_artifacts RENAME TO deployment_artifacts;
ALTER TABLE deployment_current_artifact_refs RENAME TO deployment_artifact_refs;
ALTER TABLE deployment_current_effect_receipts RENAME TO deployment_effect_receipts;
ALTER TABLE deployment_current_run_events RENAME TO deployment_run_events;
"#;

const MIGRATIONS: &[SchemaMigration] = &[
    SchemaMigration {
        version: 1,
        name: "initial_schema",
        sql: SCHEMA_INITIAL,
    },
    SchemaMigration {
        version: 2,
        name: "deployment_foundation",
        sql: SCHEMA_LEGACY_DEPLOYMENT,
    },
    SchemaMigration {
        version: 3,
        name: "deployment_plan_guards",
        sql: SCHEMA_LEGACY_PLAN_GUARDS,
    },
    SchemaMigration {
        version: 4,
        name: "deployment_phase5_runtime",
        sql: SCHEMA_LEGACY_RUNTIME,
    },
    SchemaMigration {
        version: 5,
        name: "deployment_phase6_reconciliation",
        sql: SCHEMA_LEGACY_RECONCILIATION,
    },
    SchemaMigration {
        version: 6,
        name: "deployment_phase7_history_notifications",
        sql: SCHEMA_LEGACY_HISTORY_NOTIFICATIONS,
    },
    SchemaMigration {
        version: 7,
        name: "deployment_workflow_foundation",
        sql: SCHEMA_DEPLOYMENT_WORKFLOW_FOUNDATION,
    },
    SchemaMigration {
        version: 8,
        name: "deployment_workflow_integrity_guards",
        sql: SCHEMA_DEPLOYMENT_WORKFLOW_INTEGRITY_GUARDS,
    },
    SchemaMigration {
        version: 9,
        name: "deployment_workflow_profile_guard",
        sql: SCHEMA_DEPLOYMENT_WORKFLOW_PROFILE_GUARD,
    },
    SchemaMigration {
        version: 10,
        name: "deployment_workflow_canonical_names",
        sql: SCHEMA_DEPLOYMENT_WORKFLOW_CANONICAL_NAMES,
    },
    SchemaMigration {
        version: 11,
        name: "deployment_applications",
        sql: include_str!("deployment/application_schema.sql"),
    },
];

fn read_applied_schema_versions(conn: &Connection) -> Result<Vec<i32>, String> {
    let mut statement = conn
        .prepare("SELECT version FROM schema_version ORDER BY version ASC")
        .map_err(|e| format!("failed to read database schema migrations: {e}"))?;
    let versions = statement
        .query_map([], |row| row.get(0))
        .map_err(|e| format!("failed to query database schema migrations: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("failed to collect database schema migrations: {e}"))?;
    Ok(versions)
}

fn schema_version_has_migration_name(conn: &Connection) -> Result<bool, String> {
    let mut statement = conn
        .prepare("PRAGMA table_info(schema_version)")
        .map_err(|e| format!("failed to inspect schema migration ledger: {e}"))?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| format!("failed to query schema migration ledger: {e}"))?;
    for column in columns {
        if column.map_err(|e| format!("failed to read schema migration ledger: {e}"))?
            == "migration_name"
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn apply_schema_migration(
    conn: &mut Connection,
    migration: &SchemaMigration,
) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| {
        format!(
            "failed to start schema migration {} ({}): {e}",
            migration.version, migration.name
        )
    })?;
    if migration.version == 2 && !schema_version_has_migration_name(&tx)? {
        tx.execute_batch(
            "ALTER TABLE schema_version ADD COLUMN migration_name TEXT;\
             UPDATE schema_version SET migration_name = 'initial_schema' WHERE version = 1;",
        )
        .map_err(|e| format!("failed to upgrade schema migration ledger: {e}"))?;
    }
    tx.execute_batch(migration.sql).map_err(|e| {
        format!(
            "failed to apply schema migration {} ({}): {e}",
            migration.version, migration.name
        )
    })?;
    tx.execute(
        "INSERT INTO schema_version (version, migration_name) VALUES (?1, ?2)",
        params![migration.version, migration.name],
    )
    .map_err(|e| {
        format!(
            "failed to record schema migration {} ({}): {e}",
            migration.version, migration.name
        )
    })?;
    tx.commit().map_err(|e| {
        format!(
            "failed to commit schema migration {} ({}): {e}",
            migration.version, migration.name
        )
    })
}

fn validate_schema_migration_ledger(conn: &Connection) -> Result<(), String> {
    if !schema_version_has_migration_name(conn)? {
        return Err("invalid database schema migration ledger: migration names are missing".into());
    }
    let mut statement = conn
        .prepare("SELECT version, migration_name FROM schema_version ORDER BY version ASC")
        .map_err(|e| format!("failed to validate schema migration ledger: {e}"))?;
    let applied = statement
        .query_map([], |row| {
            Ok((row.get::<_, i32>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .map_err(|e| format!("failed to query schema migration ledger: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("failed to collect schema migration ledger: {e}"))?;
    for (migration, (version, name)) in MIGRATIONS.iter().zip(applied.iter()) {
        if *version != migration.version || name.as_deref() != Some(migration.name) {
            return Err(format!(
                "invalid database schema migration ledger at version {version}"
            ));
        }
    }
    if applied.len() != MIGRATIONS.len() {
        return Err(format!(
            "invalid database schema migration ledger: expected {} entries, found {}",
            MIGRATIONS.len(),
            applied.len()
        ));
    }
    Ok(())
}

#[derive(Clone)]
pub(crate) struct Database {
    conn: Arc<Mutex<Connection>>,
}

impl Database {
    /// Dedicated LLM document commit with compare-and-swap revision control.
    pub(crate) fn commit_llm_routes(
        &self,
        expected: Option<u64>,
        document: &str,
    ) -> Result<(), String> {
        let mut conn = self.conn.lock().map_err(|_| "database lock unavailable")?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let current: Option<String> = tx
            .query_row(
                "SELECT value FROM preferences WHERE key='llm.routes.v1'",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let revision = current
            .as_ref()
            .map(|raw| serde_json::from_str::<serde_json::Value>(raw).map_err(|e| e.to_string()))
            .transpose()?
            .and_then(|v| v["revision"].as_u64());
        if revision != expected {
            return Err("REVISION_CONFLICT".into());
        }
        tx.execute("INSERT INTO preferences (key,value) VALUES ('llm.routes.v1',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [document]).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }
    pub(crate) fn open(db_path: &Path) -> Result<Self, String> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("failed to create database directory: {e}"))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))
                    .map_err(|e| format!("failed to secure database directory: {e}"))?;
            }
        }
        let conn =
            Connection::open(db_path).map_err(|e| format!("failed to open database: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(db_path, std::fs::Permissions::from_mode(0o600))
                .map_err(|e| format!("failed to secure database file: {e}"))?;
        }
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
            .map_err(|e| format!("failed to set pragmas: {e}"))?;
        let db = Self {
            conn: Arc::new(Mutex::new(conn)),
        };
        db.initialize_or_validate_schema()?;
        Ok(db)
    }

    fn initialize_or_validate_schema(&self) -> Result<(), String> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;

        let has_schema_table: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_version')",
                [],
                |row| row.get(0),
            )
            .map_err(|e| format!("failed to inspect database schema: {e}"))?;
        if !has_schema_table {
            let user_table_count: i32 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
                    [],
                    |row| row.get(0),
                )
                .map_err(|e| format!("failed to inspect database tables: {e}"))?;
            if user_table_count != 0 {
                return Err("unsupported unversioned database schema".into());
            }
            conn.execute_batch(SCHEMA_VERSION_TABLE)
                .map_err(|e| format!("failed to initialize schema migration ledger: {e}"))?;
        }

        let applied_versions = read_applied_schema_versions(&conn)?;
        if let Some(version) = applied_versions
            .iter()
            .copied()
            .find(|version| *version > CURRENT_SCHEMA_VERSION)
        {
            return Err(format!(
                "unsupported database schema version {version}; latest supported version is {CURRENT_SCHEMA_VERSION}"
            ));
        }

        for (index, version) in applied_versions.iter().copied().enumerate() {
            let expected = i32::try_from(index + 1)
                .map_err(|_| "database schema migration history is too large".to_string())?;
            if version != expected {
                return Err(format!(
                    "invalid database schema migration history: expected version {expected}, found {version}"
                ));
            }
        }

        if has_schema_table && applied_versions.is_empty() {
            return Err("invalid database schema migration history: no applied versions".into());
        }

        let current = applied_versions.last().copied().unwrap_or(0);
        for migration in MIGRATIONS
            .iter()
            .filter(|migration| migration.version > current)
        {
            apply_schema_migration(&mut conn, migration)?;
        }
        validate_schema_migration_ledger(&conn)?;
        Ok(())
    }

    pub(crate) fn with_connection<T>(
        &self,
        operation: impl FnOnce(&Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        operation(&conn)
    }

    pub(crate) fn with_transaction<T>(
        &self,
        operation: impl FnOnce(&Transaction<'_>) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        let transaction = conn
            .transaction()
            .map_err(|e| format!("failed to start database transaction: {e}"))?;
        let result = operation(&transaction)?;
        transaction
            .commit()
            .map_err(|e| format!("failed to commit database transaction: {e}"))?;
        Ok(result)
    }

    // --- Profiles ---

    pub(crate) fn list_profiles(&self) -> Result<Vec<crate::models::ProfileRow>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        let mut stmt = conn
            .prepare(
                "SELECT id, name, host, port, username, auth_method, \
                 keychain_key_id, jump_host_config, organization_json, created_at, updated_at \
                 FROM profiles ORDER BY name",
            )
            .map_err(|e| format!("failed to prepare list_profiles: {e}"))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(crate::models::ProfileRow {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    host: row.get(2)?,
                    port: row.get(3)?,
                    username: row.get(4)?,
                    auth_method: {
                        let s: String = row.get(5)?;
                        match s.as_str() {
                            "password" => crate::models::ProfileAuthMethod::Password,
                            "key" => crate::models::ProfileAuthMethod::Key,
                            other => {
                                return Err(rusqlite::Error::FromSqlConversionFailure(
                                    5,
                                    rusqlite::types::Type::Text,
                                    Box::new(std::io::Error::new(
                                        std::io::ErrorKind::InvalidData,
                                        format!("unknown auth_method: {other}"),
                                    )),
                                ))
                            }
                        }
                    },
                    keychain_key_id: row.get(6)?,
                    jump_host_config: row.get(7)?,
                    organization_json: row.get(8)?,
                    created_at: row.get(9)?,
                    updated_at: row.get(10)?,
                })
            })
            .map_err(|e| format!("failed to query profiles: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("failed to collect profiles: {e}"))
    }

    pub(crate) fn get_profile(
        &self,
        id: &str,
    ) -> Result<Option<crate::models::ProfileRow>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        let row = conn
            .query_row(
                "SELECT id, name, host, port, username, auth_method, \
                 keychain_key_id, jump_host_config, organization_json, created_at, updated_at \
                 FROM profiles WHERE id = ?1",
                params![id],
                |row| {
                    Ok(crate::models::ProfileRow {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        host: row.get(2)?,
                        port: row.get(3)?,
                        username: row.get(4)?,
                        auth_method: {
                            let s: String = row.get(5)?;
                            match s.as_str() {
                                "password" => crate::models::ProfileAuthMethod::Password,
                                "key" => crate::models::ProfileAuthMethod::Key,
                                other => Err(rusqlite::Error::FromSqlConversionFailure(
                                    5,
                                    rusqlite::types::Type::Text,
                                    Box::new(std::io::Error::new(
                                        std::io::ErrorKind::InvalidData,
                                        format!("unknown auth_method: {other}"),
                                    )),
                                ))?,
                            }
                        },
                        keychain_key_id: row.get(6)?,
                        jump_host_config: row.get(7)?,
                        organization_json: row.get(8)?,
                        created_at: row.get(9)?,
                        updated_at: row.get(10)?,
                    })
                },
            )
            .optional()
            .map_err(|e| format!("failed to get profile: {e}"))?;
        Ok(row)
    }

    pub(crate) fn insert_profile(&self, profile: &crate::models::ProfileRow) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        conn.execute(
            "INSERT INTO profiles (id, name, host, port, username, auth_method, \
             keychain_key_id, jump_host_config, organization_json, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                profile.id,
                profile.name,
                profile.host,
                profile.port,
                profile.username,
                profile.auth_method.as_str(),
                profile.keychain_key_id,
                profile.jump_host_config,
                profile.organization_json,
                profile.created_at,
                profile.updated_at,
            ],
        )
        .map(|_| ())
        .map_err(|e| format!("failed to insert profile: {e}"))
    }

    pub(crate) fn update_profile(
        &self,
        id: &str,
        profile: &crate::models::ProfileRow,
    ) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        let rows = conn
            .execute(
                "UPDATE profiles SET name=?2, host=?3, port=?4, username=?5, auth_method=?6, \
                 keychain_key_id=?7, jump_host_config=?8, \
                 organization_json=?9, created_at=?10, updated_at=?11 WHERE id=?1",
                params![
                    id,
                    profile.name,
                    profile.host,
                    profile.port,
                    profile.username,
                    profile.auth_method.as_str(),
                    profile.keychain_key_id,
                    profile.jump_host_config,
                    profile.organization_json,
                    profile.created_at,
                    profile.updated_at,
                ],
            )
            .map_err(|e| format!("failed to update profile: {e}"))?;
        if rows == 0 {
            return Err(format!("profile {id} not found"));
        }
        Ok(())
    }

    pub(crate) fn delete_profile(&self, id: &str) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        conn.execute("DELETE FROM profiles WHERE id=?1", params![id])
            .map_err(|e| format!("failed to delete profile: {e}"))?;
        Ok(())
    }

    // --- Key credentials ---

    pub(crate) fn list_key_credentials(
        &self,
    ) -> Result<Vec<crate::models::KeyCredentialSummary>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        let mut stmt = conn
            .prepare(
                "SELECT id, label, COALESCE(key_type, 'unknown'), kind, service, public_key FROM key_credentials ORDER BY label",
            )
            .map_err(|e| format!("failed to prepare list_key_credentials: {e}"))?;
        let rows = stmt
            .query_map([], |row| {
                let kind: String = row.get(3)?;
                let public_key: Option<String> = row.get(5)?;
                let fingerprint = public_key
                    .as_deref()
                    .and_then(|key| ssh_key::PublicKey::from_openssh(key).ok())
                    .map(|key| key.fingerprint(ssh_key::HashAlg::Sha256).to_string());
                Ok(crate::models::KeyCredentialSummary {
                    id: row.get(0)?,
                    label: row.get(1)?,
                    key_type: row.get(2)?,
                    kind: match kind.as_str() {
                        "password" => crate::models::KeyCredentialKind::Password,
                        _ => crate::models::KeyCredentialKind::KeyFile,
                    },
                    service: row.get(4)?,
                    public_key,
                    fingerprint,
                })
            })
            .map_err(|e| format!("failed to query key_credentials: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("failed to collect key_credentials: {e}"))
    }

    pub(crate) fn upsert_key_credential(
        &self,
        id: &str,
        label: &str,
        key_type: &str,
        kind: &str,
        service: &str,
        public_key: Option<&str>,
        certificate: Option<&str>,
        updated_at: i64,
    ) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        conn.execute(
            "INSERT INTO key_credentials (id, label, key_type, kind, service, public_key, certificate, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) \
             ON CONFLICT(id) DO UPDATE SET label=excluded.label, key_type=excluded.key_type, kind=excluded.kind, service=excluded.service, public_key=excluded.public_key, certificate=excluded.certificate, updated_at=excluded.updated_at",
            params![id, label, key_type, kind, service, public_key, certificate, updated_at],
        )
        .map_err(|e| format!("failed to upsert key credential: {e}"))?;
        Ok(())
    }

    pub(crate) fn delete_key_credential(&self, id: &str) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        conn.execute("DELETE FROM key_credentials WHERE id=?1", params![id])
            .map_err(|e| format!("failed to delete key credential: {e}"))?;
        Ok(())
    }

    pub(crate) fn delete_key_credential_metadata(
        &self,
        id: &str,
        service: &str,
    ) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        conn.execute(
            "DELETE FROM key_credentials WHERE id=?1 AND service=?2",
            params![id, service],
        )
        .map_err(|e| format!("failed to delete key credential metadata: {e}"))?;
        Ok(())
    }

    pub(crate) fn key_credential_service(&self, id: &str) -> Result<Option<String>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        conn.query_row(
            "SELECT service FROM key_credentials WHERE id=?1",
            params![id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("failed to retrieve key credential service: {e}"))
    }

    pub(crate) fn list_profiles_referencing_key(
        &self,
        key_id: &str,
    ) -> Result<Vec<String>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        let mut stmt = conn
            .prepare("SELECT id, keychain_key_id, jump_host_config FROM profiles")
            .map_err(|e| format!("failed to prepare list_profiles_referencing_key: {e}"))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })
            .map_err(|e| format!("failed to query profiles referencing key: {e}"))?;
        let rows = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("failed to collect profiles referencing key: {e}"))?;
        Ok(rows
            .into_iter()
            .filter_map(|(id, main_key_id, jump_host_config)| {
                let jump_matches = jump_host_config
                    .as_deref()
                    .and_then(|json| serde_json::from_str::<serde_json::Value>(json).ok())
                    .and_then(|jump| {
                        jump.get("keychainKeyId")
                            .and_then(|value| value.as_str())
                            .map(str::to_owned)
                    })
                    .is_some_and(|jump_key_id| jump_key_id == key_id);
                (main_key_id.as_deref() == Some(key_id) || jump_matches).then_some(id)
            })
            .collect())
    }

    pub(crate) fn clear_keychain_key_id_references(&self, key_id: &str) -> Result<usize, String> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("failed to start key reference cleanup transaction: {e}"))?;
        let mut updated = tx
            .execute(
                "UPDATE profiles SET keychain_key_id = NULL, updated_at = ?2 WHERE keychain_key_id = ?1",
                params![key_id, current_timestamp_ms()],
            )
            .map_err(|e| format!("failed to clear keychain key references: {e}"))?;
        let mut stmt = tx
            .prepare("SELECT id, jump_host_config FROM profiles WHERE jump_host_config IS NOT NULL")
            .map_err(|e| format!("failed to prepare jump-host key cleanup: {e}"))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| format!("failed to query jump-host key references: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("failed to collect jump-host key references: {e}"))?;
        drop(stmt);
        for (profile_id, json) in rows {
            let Ok(mut jump) = serde_json::from_str::<serde_json::Value>(&json) else {
                continue;
            };
            if jump.get("keychainKeyId").and_then(|value| value.as_str()) != Some(key_id) {
                continue;
            }
            if let Some(object) = jump.as_object_mut() {
                object.remove("keychainKeyId");
            }
            tx.execute(
                "UPDATE profiles SET jump_host_config=?2, updated_at=?3 WHERE id=?1",
                params![profile_id, jump.to_string(), current_timestamp_ms()],
            )
            .map_err(|e| format!("failed to clear jump-host key reference: {e}"))?;
            updated += 1;
        }
        tx.commit()
            .map_err(|e| format!("failed to commit key reference cleanup: {e}"))?;
        Ok(updated)
    }

    // --- Preferences ---

    pub(crate) fn load_preferences(&self) -> Result<Vec<(String, String)>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        let mut stmt = conn
            .prepare("SELECT key, value FROM preferences")
            .map_err(|e| format!("failed to prepare load_preferences: {e}"))?;
        let rows = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|e| format!("failed to query preferences: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("failed to collect preferences: {e}"))
    }

    pub(crate) fn save_preferences(&self, entries: &[(String, String)]) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        for (key, value) in entries {
            conn.execute(
                "INSERT INTO preferences (key, value) VALUES (?1, ?2) \
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                params![key, value],
            )
            .map_err(|e| format!("failed to save preference {key}: {e}"))?;
        }
        Ok(())
    }

    pub(crate) fn delete_preferences(&self, keys: &[String]) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        for key in keys {
            conn.execute("DELETE FROM preferences WHERE key=?1", [key])
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    // --- Recent Profiles ---

    pub(crate) fn list_recent_profiles(&self) -> Result<Vec<String>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        let mut stmt = conn
            .prepare("SELECT profile_id FROM recent_profiles ORDER BY sort_order ASC")
            .map_err(|e| format!("failed to prepare list_recent_profiles: {e}"))?;
        let rows = stmt
            .query_map([], |row| row.get(0))
            .map_err(|e| format!("failed to query recent_profiles: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("failed to collect recent_profiles: {e}"))
    }

    pub(crate) fn touch_recent_profile(&self, profile_id: &str) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;

        // Shift all existing entries down to make room at position 0
        conn.execute("UPDATE recent_profiles SET sort_order = sort_order + 1", [])
            .map_err(|e| format!("failed to shift recent_profiles: {e}"))?;

        // Upsert at position 0
        conn.execute(
            "INSERT INTO recent_profiles (profile_id, sort_order) VALUES (?1, 0) \
             ON CONFLICT(profile_id) DO UPDATE SET sort_order=0",
            params![profile_id],
        )
        .map_err(|e| format!("failed to touch recent_profile: {e}"))?;

        // Prune to max 10
        conn.execute("DELETE FROM recent_profiles WHERE sort_order >= 10", [])
            .map_err(|e| format!("failed to prune recent_profiles: {e}"))?;

        Ok(())
    }

    pub(crate) fn remove_recent_profile(&self, profile_id: &str) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        conn.execute(
            "DELETE FROM recent_profiles WHERE profile_id=?1",
            params![profile_id],
        )
        .map_err(|e| format!("failed to remove recent_profile: {e}"))?;
        Ok(())
    }

    // --- SFTP Bookmarks ---

    pub(crate) fn list_sftp_bookmarks(
        &self,
        host: &str,
        port: u16,
        username: &str,
    ) -> Result<Vec<crate::models::SftpBookmarkRow>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        let mut stmt = conn
            .prepare(
                "SELECT id, host, port, username, path, side, label, created_at \
                 FROM sftp_bookmarks WHERE host=?1 AND port=?2 AND username=?3 \
                 ORDER BY created_at ASC",
            )
            .map_err(|e| format!("failed to prepare list_sftp_bookmarks: {e}"))?;
        let rows = stmt
            .query_map(params![host, port, username], |row| {
                Ok(crate::models::SftpBookmarkRow {
                    id: row.get(0)?,
                    host: row.get(1)?,
                    port: row.get(2)?,
                    username: row.get(3)?,
                    path: row.get(4)?,
                    side: row.get(5)?,
                    label: row.get(6)?,
                    created_at: row.get(7)?,
                })
            })
            .map_err(|e| format!("failed to query sftp_bookmarks: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("failed to collect sftp_bookmarks: {e}"))
    }

    pub(crate) fn insert_sftp_bookmark(
        &self,
        bookmark: &crate::models::SftpBookmarkRow,
    ) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        conn.execute(
            "INSERT INTO sftp_bookmarks (id, host, port, username, path, side, label, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                bookmark.id,
                bookmark.host,
                bookmark.port,
                bookmark.username,
                bookmark.path,
                bookmark.side,
                bookmark.label,
                bookmark.created_at,
            ],
        )
        .map(|_| ())
        .map_err(|e| format!("failed to insert sftp_bookmark: {e}"))
    }

    pub(crate) fn delete_sftp_bookmark(&self, id: &str) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        conn.execute("DELETE FROM sftp_bookmarks WHERE id=?1", params![id])
            .map_err(|e| format!("failed to delete sftp_bookmark: {e}"))?;
        Ok(())
    }

    // --- Terminal Workspace ---

    pub(crate) fn load_terminal_workspace(&self) -> Result<Option<String>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        conn.query_row(
            "SELECT sessions_json FROM terminal_workspace WHERE id=1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("failed to load terminal workspace: {e}"))
    }

    pub(crate) fn save_terminal_workspace(&self, sessions_json: &str) -> Result<(), String> {
        validate_terminal_workspace(sessions_json)?;
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        conn.execute(
            "INSERT INTO terminal_workspace (id, sessions_json, updated_at) \
             VALUES (1, ?1, ?2) \
             ON CONFLICT(id) DO UPDATE SET \
             sessions_json=excluded.sessions_json, updated_at=excluded.updated_at",
            params![sessions_json, current_timestamp_ms()],
        )
        .map(|_| ())
        .map_err(|e| format!("failed to save terminal workspace: {e}"))
    }

    pub(crate) fn clear_terminal_workspace(&self) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        conn.execute("DELETE FROM terminal_workspace WHERE id=1", [])
            .map(|_| ())
            .map_err(|e| format!("failed to clear terminal workspace: {e}"))
    }

    // --- SFTP Workspace ---

    pub(crate) fn load_sftp_workspace(&self) -> Result<Option<String>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        conn.query_row(
            "SELECT workspace_json FROM sftp_workspace WHERE id=1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("failed to load SFTP workspace: {e}"))
    }

    pub(crate) fn save_sftp_workspace(&self, workspace_json: &str) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        conn.execute(
            "INSERT INTO sftp_workspace (id, workspace_json, updated_at) \
             VALUES (1, ?1, ?2) \
             ON CONFLICT(id) DO UPDATE SET \
             workspace_json=excluded.workspace_json, updated_at=excluded.updated_at",
            params![workspace_json, current_timestamp_ms()],
        )
        .map(|_| ())
        .map_err(|e| format!("failed to save SFTP workspace: {e}"))
    }

    pub(crate) fn clear_sftp_workspace(&self) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("database lock poisoned: {e}"))?;
        conn.execute("DELETE FROM sftp_workspace WHERE id=1", [])
            .map(|_| ())
            .map_err(|e| format!("failed to clear SFTP workspace: {e}"))
    }
}

pub(crate) fn current_timestamp_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[cfg(test)]
pub(crate) mod tests {
    include!("tests/db.rs");
}
