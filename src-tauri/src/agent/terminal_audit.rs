//! Durable append-only writer for Agent terminal safety events.
//!
//! The schema is fixed and intentionally cannot store raw PTY output, raw user
//! input, full transcripts, credentials, provider content, or arbitrary JSON.

use super::terminal_coordinator::{TerminalAuditEventV1, TerminalAuditWriterV1};
use crate::db::{current_timestamp_ms, Database};
use rusqlite::{params, OptionalExtension};
use sha2::{Digest, Sha256};

pub(crate) struct DatabaseTerminalAuditWriterV1<'a> {
    database: &'a Database,
}

impl<'a> DatabaseTerminalAuditWriterV1<'a> {
    pub(crate) fn new(database: &'a Database) -> Self {
        Self { database }
    }
}

impl TerminalAuditWriterV1 for DatabaseTerminalAuditWriterV1<'_> {
    fn append(&self, event: &TerminalAuditEventV1) -> Result<(), String> {
        validate_event_v1(event)?;
        let state = enum_name_v1(&event.state)?;
        let sequence = i64::try_from(event.sequence)
            .map_err(|_| "Agent terminal audit sequence exceeds SQLite range".to_string())?;
        let occurred_at = i64::try_from(event.occurred_at_ms)
            .map_err(|_| "Agent terminal audit timestamp exceeds SQLite range".to_string())?;
        let lease_epoch = i64::try_from(event.lease_epoch)
            .map_err(|_| "Agent terminal audit lease epoch exceeds SQLite range".to_string())?;
        let lease_revision = i64::try_from(event.lease_revision)
            .map_err(|_| "Agent terminal audit lease revision exceeds SQLite range".to_string())?;
        self.database.with_connection(|connection| {
            let inserted = connection
                .execute(
                    "INSERT OR IGNORE INTO agent_terminal_audit_events (
                        event_id, run_id, action_id, sequence, occurred_at,
                        target_digest, session_id, state, action_digest,
                        risk_digest, approval_digest, lease_epoch, lease_revision,
                        driver, program, scenario, event_digest, redacted_preview,
                        created_at
                     ) VALUES (
                        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                        ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19
                     )",
                    params![
                        event.event_id,
                        event.run_id,
                        event.action_id,
                        sequence,
                        occurred_at,
                        event.target_digest,
                        event.session_id,
                        state,
                        event.action_digest,
                        event.risk_digest,
                        event.approval_digest,
                        lease_epoch,
                        lease_revision,
                        event.driver,
                        event.program,
                        event.scenario,
                        event.event_digest,
                        event.redacted_preview,
                        current_timestamp_ms(),
                    ],
                )
                .map_err(|error| format!("failed to append Agent terminal audit: {error}"))?;
            if inserted == 1 {
                return Ok(());
            }
            let existing: Option<String> = connection
                .query_row(
                    "SELECT event_digest FROM agent_terminal_audit_events WHERE event_id=?1",
                    params![event.event_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| format!("failed to read Agent terminal audit replay: {error}"))?;
            if existing.as_deref() == Some(event.event_digest.as_str()) {
                Ok(())
            } else {
                Err(
                    "Agent terminal audit event id or sequence collided with different content"
                        .to_string(),
                )
            }
        })
    }
}

fn validate_event_v1(event: &TerminalAuditEventV1) -> Result<(), String> {
    for (label, value, max_len) in [
        ("event", event.event_id.as_str(), 240usize),
        ("run", event.run_id.as_str(), 160usize),
        ("action", event.action_id.as_str(), 160usize),
        ("session", event.session_id.as_str(), 160usize),
    ] {
        if value.is_empty()
            || value.len() > max_len
            || !value.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | ':')
            })
        {
            return Err(format!("Agent terminal audit {label} identity is invalid"));
        }
    }
    for digest in [
        Some(event.target_digest.as_str()),
        Some(event.action_digest.as_str()),
        event.risk_digest.as_deref(),
        event.approval_digest.as_deref(),
        Some(event.event_digest.as_str()),
    ]
    .into_iter()
    .flatten()
    {
        if digest.len() > 200
            || digest.chars().any(char::is_control)
            || !digest.starts_with("sha256-v1:")
        {
            return Err("Agent terminal audit digest is invalid".to_string());
        }
    }
    if event.redacted_preview.is_empty()
        || event.redacted_preview.len() > 240
        || event.redacted_preview.chars().any(char::is_control)
    {
        return Err("Agent terminal audit preview is invalid".to_string());
    }
    for value in [
        event.driver.as_deref(),
        event.program.as_deref(),
        event.scenario.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        if value.is_empty() || value.len() > 100 || value.chars().any(char::is_control) {
            return Err("Agent terminal audit driver binding is invalid".to_string());
        }
    }
    Ok(())
}

fn enum_name_v1(value: &impl serde::Serialize) -> Result<String, String> {
    serde_json::to_value(value)
        .map_err(|_| "failed to serialize Agent terminal audit enum".to_string())?
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "Agent terminal audit enum was not a string".to_string())
}

/// Converts every persisted in-flight effect into `unknownEffect` on startup.
/// It does not recreate coordinator records, approvals, lease ownership, or an
/// executable request, and therefore can never replay terminal input.
pub(crate) fn recover_interrupted_agent_terminal_audits(
    database: &Database,
) -> Result<usize, String> {
    database.with_transaction(|transaction| {
        let candidates = {
            let mut statement = transaction
                .prepare(
                    "SELECT e.run_id, e.action_id, e.target_digest, e.session_id,
                            e.action_digest, e.risk_digest, e.approval_digest,
                            e.lease_epoch, e.lease_revision, e.driver, e.program,
                            e.scenario
                     FROM agent_terminal_audit_events e
                     JOIN (
                        SELECT run_id, action_id, MAX(sequence) AS max_sequence
                        FROM agent_terminal_audit_events
                        GROUP BY run_id, action_id
                     ) latest
                       ON latest.run_id=e.run_id
                      AND latest.action_id=e.action_id
                      AND latest.max_sequence=e.sequence
                     WHERE e.state IN ('writing', 'awaitingObservation')",
                )
                .map_err(|error| {
                    format!("failed to prepare Agent terminal recovery query: {error}")
                })?;
            let rows = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, Option<String>>(6)?,
                        row.get::<_, i64>(7)?,
                        row.get::<_, i64>(8)?,
                        row.get::<_, Option<String>>(9)?,
                        row.get::<_, Option<String>>(10)?,
                        row.get::<_, Option<String>>(11)?,
                    ))
                })
                .map_err(|error| format!("failed to query Agent terminal recovery: {error}"))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("failed to collect Agent terminal recovery: {error}"))?
        };
        let mut recovered = 0usize;
        for (
            run_id,
            action_id,
            target_digest,
            session_id,
            action_digest,
            risk_digest,
            approval_digest,
            lease_epoch,
            lease_revision,
            driver,
            program,
            scenario,
        ) in candidates
        {
            let next_sequence: i64 = transaction
                .query_row(
                    "SELECT COALESCE(MAX(sequence), 0) + 1
                     FROM agent_terminal_audit_events WHERE run_id=?1",
                    params![run_id],
                    |row| row.get(0),
                )
                .map_err(|error| format!("failed to allocate recovery sequence: {error}"))?;
            let occurred_at = current_timestamp_ms();
            let event_digest = recovery_digest_v1(
                &run_id,
                &action_id,
                next_sequence,
                occurred_at,
                &action_digest,
            );
            transaction
                .execute(
                    "INSERT INTO agent_terminal_audit_events (
                        event_id, run_id, action_id, sequence, occurred_at,
                        target_digest, session_id, state, action_digest,
                        risk_digest, approval_digest, lease_epoch, lease_revision,
                        driver, program, scenario, event_digest, redacted_preview,
                        created_at
                     ) VALUES (
                        ?1, ?2, ?3, ?4, ?5, ?6, ?7, 'unknownEffect', ?8,
                        ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18
                     )",
                    params![
                        format!("agent-terminal-recovery-{run_id}-{next_sequence}"),
                        run_id,
                        action_id,
                        next_sequence,
                        occurred_at,
                        target_digest,
                        session_id,
                        action_digest,
                        risk_digest,
                        approval_digest,
                        lease_epoch,
                        lease_revision,
                        driver,
                        program,
                        scenario,
                        event_digest,
                        "application ended before terminal effect was independently resolved",
                        occurred_at,
                    ],
                )
                .map_err(|error| format!("failed to persist terminal recovery: {error}"))?;
            recovered += 1;
        }
        Ok(recovered)
    })
}

fn recovery_digest_v1(
    run_id: &str,
    action_id: &str,
    sequence: i64,
    occurred_at: i64,
    action_digest: &str,
) -> String {
    let mut hasher = Sha256::new();
    for value in [
        "agent-terminal-recovery-v1",
        run_id,
        action_id,
        &sequence.to_string(),
        &occurred_at.to_string(),
        action_digest,
    ] {
        hasher.update((value.len() as u64).to_be_bytes());
        hasher.update(value.as_bytes());
    }
    let digest = hasher.finalize();
    let digest_hex = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("sha256-v1:{digest_hex}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::terminal_coordinator::TerminalInteractionStateV1;
    use tempfile::tempdir;

    #[test]
    fn durable_writer_is_idempotent_and_has_no_raw_data_columns() {
        let directory = tempdir().unwrap();
        let database = Database::open(&directory.path().join("audit.db")).unwrap();
        let writer = DatabaseTerminalAuditWriterV1::new(&database);
        let event = TerminalAuditEventV1 {
            event_id: "agent-terminal-run-1-1".to_string(),
            run_id: "run-1".to_string(),
            action_id: "action-1".to_string(),
            sequence: 1,
            occurred_at_ms: 1,
            target_digest: "sha256-v1:target".to_string(),
            session_id: "agent-session-1".to_string(),
            state: TerminalInteractionStateV1::Writing,
            action_digest: "sha256-v1:action".to_string(),
            risk_digest: Some("sha256-v1:risk".to_string()),
            approval_digest: Some("sha256-v1:approval".to_string()),
            lease_epoch: 1,
            lease_revision: 2,
            driver: Some("fixture.shellPrompt".to_string()),
            program: Some("termbridge-interactive-fixture".to_string()),
            scenario: Some("confirm".to_string()),
            event_digest: "sha256-v1:event".to_string(),
            redacted_preview: "approved semantic input".to_string(),
        };
        writer.append(&event).unwrap();
        writer.append(&event).unwrap();
        database
            .with_connection(|connection| {
                let count: i64 = connection
                    .query_row(
                        "SELECT COUNT(*) FROM agent_terminal_audit_events",
                        [],
                        |row| row.get(0),
                    )
                    .map_err(|error| error.to_string())?;
                assert_eq!(count, 1);
                let columns = connection
                    .prepare("PRAGMA table_info(agent_terminal_audit_events)")
                    .and_then(|mut statement| {
                        statement
                            .query_map([], |row| row.get::<_, String>(1))?
                            .collect::<Result<Vec<_>, _>>()
                    })
                    .map_err(|error| error.to_string())?;
                for forbidden in [
                    "raw_input",
                    "raw_output",
                    "transcript",
                    "credential",
                    "challenge",
                    "token",
                ] {
                    assert!(!columns.iter().any(|column| column.contains(forbidden)));
                }
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn startup_recovery_marks_inflight_unknown_without_replayable_payload() {
        let directory = tempdir().unwrap();
        let database = Database::open(&directory.path().join("recovery.db")).unwrap();
        let writer = DatabaseTerminalAuditWriterV1::new(&database);
        writer
            .append(&TerminalAuditEventV1 {
                event_id: "agent-terminal-run-1-1".to_string(),
                run_id: "run-1".to_string(),
                action_id: "action-1".to_string(),
                sequence: 1,
                occurred_at_ms: 1,
                target_digest: "sha256-v1:target".to_string(),
                session_id: "agent-session-1".to_string(),
                state: TerminalInteractionStateV1::Writing,
                action_digest: "sha256-v1:action".to_string(),
                risk_digest: None,
                approval_digest: None,
                lease_epoch: 1,
                lease_revision: 1,
                driver: None,
                program: None,
                scenario: None,
                event_digest: "sha256-v1:event".to_string(),
                redacted_preview: "prewrite".to_string(),
            })
            .unwrap();
        assert_eq!(
            recover_interrupted_agent_terminal_audits(&database).unwrap(),
            1
        );
        assert_eq!(
            recover_interrupted_agent_terminal_audits(&database).unwrap(),
            0
        );
    }
}
