use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::Arc;

use crate::redaction::redact_sensitive_text;
use serde::Serialize;

use super::{
    AgentArtifactMetadata, AgentArtifactStore, AgentCompactionStatus, AgentRecoveryStatus,
    AgentScopedPayload, AgentSessionEvent, AgentSessionEventPayload, AgentSessionStore,
    ModelSurfaceBudget,
};

const MAX_COMPACTION_FACTS: usize = 24;
const MAX_COMPACTION_RISKS: usize = 16;
const MAX_COMPACTION_REFERENCES: usize = 64;
const MAX_COMPACTION_SUMMARY_BYTES: usize = 32 * 1024;
const SUMMARY_TOKEN_RESERVE: u64 = 1_024;

pub(crate) trait AgentCompactionSummarizer: Send + Sync {
    fn summarize(
        &self,
        goal: &str,
        events: &[AgentSessionEvent],
        replaced_through_seq: u64,
        artifact: &AgentArtifactMetadata,
    ) -> Result<String, String>;
}

#[derive(Default)]
struct StructuredCompactionSummarizer;

impl AgentCompactionSummarizer for StructuredCompactionSummarizer {
    fn summarize(
        &self,
        goal: &str,
        events: &[AgentSessionEvent],
        replaced_through_seq: u64,
        artifact: &AgentArtifactMetadata,
    ) -> Result<String, String> {
        let facts = completed_facts(events, replaced_through_seq);
        let risks = pending_risks(events, replaced_through_seq);
        let references = evidence_references(events, replaced_through_seq);
        let mut summary = format!(
            "[ShellSpan structured compaction]\nGoal: {}\nCompleted facts:\n{}\nPending risks, approvals, and recovery:\n{}\nEvidence and artifact refs:\n- {} (sha256 {}, {} bytes)",
            bounded(redact_sensitive_text(goal), 4 * 1024),
            bullet_list(&facts, "No completed fact was recorded in this prefix."),
            bullet_list(&risks, "No unresolved approval or recovery boundary was recorded."),
            artifact.artifact_id,
            artifact.sha256,
            artifact.size_bytes,
        );
        for reference in references {
            summary.push_str("\n- ");
            summary.push_str(&reference);
        }
        if summary.len() > MAX_COMPACTION_SUMMARY_BYTES {
            summary = bounded(summary, MAX_COMPACTION_SUMMARY_BYTES);
        }
        if summary.trim().is_empty() {
            return Err("structured compaction summary was empty".into());
        }
        Ok(summary)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentCompactionOutcome {
    pub(crate) previous_generation: u64,
    pub(crate) surface_generation: u64,
    pub(crate) replaced_through_seq: u64,
    pub(crate) artifact: AgentArtifactMetadata,
}

#[derive(Clone)]
pub(crate) struct AgentCompactionManager {
    sessions: AgentSessionStore,
    artifacts: AgentArtifactStore,
    summarizer: Arc<dyn AgentCompactionSummarizer>,
}

impl AgentCompactionManager {
    pub(crate) fn new(sessions: AgentSessionStore, artifacts: AgentArtifactStore) -> Self {
        Self {
            sessions,
            artifacts,
            summarizer: Arc::new(StructuredCompactionSummarizer),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_summarizer(
        sessions: AgentSessionStore,
        artifacts: AgentArtifactStore,
        summarizer: Arc<dyn AgentCompactionSummarizer>,
    ) -> Self {
        Self {
            sessions,
            artifacts,
            summarizer,
        }
    }

    pub(crate) fn compact(
        &self,
        session_id: &str,
        turn_id: &str,
        step_id: &str,
        active_turn_id: Option<&str>,
        reason: &str,
        budget: &ModelSurfaceBudget,
        force: bool,
    ) -> Result<AgentCompactionOutcome, String> {
        let snapshot = self.sessions.snapshot(session_id)?;
        if !force && !budget.requires_compaction() {
            return Err("Model Surface is below the compaction threshold".into());
        }
        let events = self.sessions.all_events(session_id)?;
        let boundary = select_complete_turn_prefix(
            &events,
            snapshot.surface.replaced_through_seq,
            active_turn_id,
            budget,
            force,
        )?
        .ok_or_else(|| "no complete safe Turn prefix is available for compaction".to_string())?;
        let structured = structured_summary_value(
            &snapshot.header.goal,
            &events,
            boundary,
            snapshot.surface.generation,
        );
        let artifact = self.artifacts.store_json(
            session_id,
            "structured-compaction",
            "Model Surface compaction evidence",
            &structured,
        )?;
        let generation = snapshot.surface.generation.saturating_add(1);
        let reason = format!(
            "{reason}; artifactRef={}; previousGeneration={}",
            artifact.artifact_id, snapshot.surface.generation
        );
        let summary =
            match self
                .summarizer
                .summarize(&snapshot.header.goal, &events, boundary, &artifact)
            {
                Ok(summary) => summary,
                Err(error) => {
                    self.sessions.append_batch(
                        session_id,
                        vec![
                            AgentScopedPayload {
                                turn_id: Some(turn_id.to_string()),
                                step_id: Some(step_id.to_string()),
                                payload: AgentSessionEventPayload::CompactionStart {
                                    reason: format!(
                                        "{reason}; summarizationFailed={}",
                                        bounded(redact_sensitive_text(&error), 2 * 1024)
                                    ),
                                },
                            },
                            AgentScopedPayload {
                                turn_id: Some(turn_id.to_string()),
                                step_id: Some(step_id.to_string()),
                                payload: AgentSessionEventPayload::ContextArtifact {
                                    artifact_id: artifact.artifact_id.clone(),
                                    kind: artifact.kind.clone(),
                                    title: artifact.title.clone(),
                                    size_bytes: Some(artifact.size_bytes),
                                    media_type: Some(artifact.media_type.clone()),
                                    sha256: Some(artifact.sha256.clone()),
                                    sensitivity: Some(artifact.sensitivity),
                                },
                            },
                            AgentScopedPayload {
                                turn_id: Some(turn_id.to_string()),
                                step_id: Some(step_id.to_string()),
                                payload: AgentSessionEventPayload::CompactionEnd {
                                    surface_generation: generation,
                                    replaced_through_seq: boundary,
                                    status: AgentCompactionStatus::Failed,
                                },
                            },
                        ],
                    )?;
                    return Err(format!("compaction summarization failed: {error}"));
                }
            };
        self.sessions.append_batch(
            session_id,
            vec![
                AgentScopedPayload {
                    turn_id: Some(turn_id.to_string()),
                    step_id: Some(step_id.to_string()),
                    payload: AgentSessionEventPayload::CompactionStart { reason },
                },
                AgentScopedPayload {
                    turn_id: Some(turn_id.to_string()),
                    step_id: Some(step_id.to_string()),
                    payload: AgentSessionEventPayload::ContextArtifact {
                        artifact_id: artifact.artifact_id.clone(),
                        kind: artifact.kind.clone(),
                        title: artifact.title.clone(),
                        size_bytes: Some(artifact.size_bytes),
                        media_type: Some(artifact.media_type.clone()),
                        sha256: Some(artifact.sha256.clone()),
                        sensitivity: Some(artifact.sensitivity),
                    },
                },
                AgentScopedPayload {
                    turn_id: Some(turn_id.to_string()),
                    step_id: Some(step_id.to_string()),
                    payload: AgentSessionEventPayload::CompactionSummary {
                        summary,
                        replaced_through_seq: boundary,
                        surface_generation: generation,
                    },
                },
                AgentScopedPayload {
                    turn_id: Some(turn_id.to_string()),
                    step_id: Some(step_id.to_string()),
                    payload: AgentSessionEventPayload::CompactionEnd {
                        surface_generation: generation,
                        replaced_through_seq: boundary,
                        status: AgentCompactionStatus::Completed,
                    },
                },
            ],
        )?;
        let updated = self.sessions.snapshot(session_id)?.surface;
        if updated.generation != generation || updated.generation <= snapshot.surface.generation {
            return Err(
                "successful compaction did not strictly advance Model Surface generation".into(),
            );
        }
        Ok(AgentCompactionOutcome {
            previous_generation: snapshot.surface.generation,
            surface_generation: updated.generation,
            replaced_through_seq: boundary,
            artifact,
        })
    }
}

pub(crate) fn select_complete_turn_prefix(
    events: &[AgentSessionEvent],
    replaced_through_seq: Option<u64>,
    active_turn_id: Option<&str>,
    budget: &ModelSurfaceBudget,
    force: bool,
) -> Result<Option<u64>, String> {
    if has_compaction_in_flight(events) {
        return Err("compaction-in-flight is a recovery boundary".into());
    }
    let recovery_boundary = first_unresolved_recovery_seq(events);
    let mut starts = HashMap::<String, u64>::new();
    let mut candidates = Vec::new();
    for event in events
        .iter()
        .filter(|event| replaced_through_seq.is_none_or(|replaced| event.seq > replaced))
    {
        match &event.payload {
            AgentSessionEventPayload::TurnStart => {
                let turn_id = event
                    .turn_id
                    .as_ref()
                    .ok_or_else(|| "Turn start lost its identity".to_string())?;
                if starts.insert(turn_id.clone(), event.seq).is_some() {
                    return Err("Turn prefix contains a duplicate start".into());
                }
            }
            AgentSessionEventPayload::TurnEnd { .. } => {
                let turn_id = event
                    .turn_id
                    .as_ref()
                    .ok_or_else(|| "Turn end lost its identity".to_string())?;
                let Some(start) = starts.remove(turn_id) else {
                    continue;
                };
                if active_turn_id == Some(turn_id.as_str())
                    || recovery_boundary.is_some_and(|boundary| event.seq >= boundary)
                {
                    break;
                }
                let turn_events = events
                    .iter()
                    .filter(|candidate| (start..=event.seq).contains(&candidate.seq))
                    .collect::<Vec<_>>();
                if !turn_is_safe(&turn_events) {
                    break;
                }
                candidates.push(event.seq);
            }
            _ => {}
        }
    }
    if candidates.is_empty() {
        return Ok(None);
    }
    let mut last_candidate = None;
    for boundary in candidates {
        last_candidate = Some(boundary);
        let removed_tokens = surface_tokens_between(events, replaced_through_seq, boundary);
        let remaining = budget
            .estimated_input_tokens
            .saturating_sub(removed_tokens)
            .saturating_add(SUMMARY_TOKEN_RESERVE);
        if remaining <= budget.compaction_target_tokens || force {
            return Ok(Some(boundary));
        }
    }
    Ok(last_candidate)
}

fn turn_is_safe(events: &[&AgentSessionEvent]) -> bool {
    let mut calls = HashSet::new();
    let mut results = HashSet::new();
    let mut requested = HashSet::new();
    let mut terminal_approvals = HashSet::new();
    for event in events {
        match &event.payload {
            AgentSessionEventPayload::ToolCall { call } => {
                calls.insert(call.call_id.as_str());
            }
            AgentSessionEventPayload::ToolApproval {
                call_id, status, ..
            } => match status {
                super::AgentToolApprovalStatus::Requested => {
                    requested.insert(call_id.as_str());
                }
                super::AgentToolApprovalStatus::Approved
                | super::AgentToolApprovalStatus::Rejected
                | super::AgentToolApprovalStatus::Expired
                | super::AgentToolApprovalStatus::Cancelled => {
                    terminal_approvals.insert(call_id.as_str());
                }
            },
            AgentSessionEventPayload::ToolResult { call_id, .. } => {
                results.insert(call_id.as_str());
            }
            AgentSessionEventPayload::TaskState {
                recovery: Some(recovery),
                ..
            } if matches!(
                recovery.status,
                AgentRecoveryStatus::Required | AgentRecoveryStatus::Reconciling
            ) =>
            {
                return false
            }
            _ => {}
        }
    }
    calls.is_subset(&results) && requested.is_subset(&terminal_approvals)
}

fn has_compaction_in_flight(events: &[AgentSessionEvent]) -> bool {
    let starts = events
        .iter()
        .filter(|event| {
            matches!(
                event.payload,
                AgentSessionEventPayload::CompactionStart { .. }
            )
        })
        .count();
    let ends = events
        .iter()
        .filter(|event| {
            matches!(
                event.payload,
                AgentSessionEventPayload::CompactionEnd { .. }
            )
        })
        .count();
    starts > ends
}

fn first_unresolved_recovery_seq(events: &[AgentSessionEvent]) -> Option<u64> {
    let mut boundary = None;
    for event in events {
        let AgentSessionEventPayload::TaskState {
            recovery: Some(recovery),
            ..
        } = &event.payload
        else {
            continue;
        };
        match recovery.status {
            AgentRecoveryStatus::Required | AgentRecoveryStatus::Reconciling => {
                boundary.get_or_insert(event.seq);
            }
            AgentRecoveryStatus::None
            | AgentRecoveryStatus::Available
            | AgentRecoveryStatus::Completed => boundary = None,
        }
    }
    boundary
}

fn surface_tokens_between(
    events: &[AgentSessionEvent],
    replaced_through_seq: Option<u64>,
    boundary: u64,
) -> u64 {
    events
        .iter()
        .filter(|event| {
            replaced_through_seq.is_none_or(|replaced| event.seq > replaced)
                && event.seq <= boundary
        })
        .filter_map(|event| match &event.payload {
            AgentSessionEventPayload::UserMessage { message } => Some(message.content.len()),
            AgentSessionEventPayload::AssistantMessage {
                content,
                tool_calls,
                ..
            } => Some(
                content
                    .len()
                    .saturating_add(serde_json::to_vec(tool_calls).map_or(0, |value| value.len())),
            ),
            AgentSessionEventPayload::ToolResult { summary, .. } => Some(summary.len()),
            _ => None,
        })
        .map(|bytes| (bytes as u64).saturating_add(3) / 4)
        .sum()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StructuredSummary<'a> {
    format: &'static str,
    goal: String,
    previous_surface_generation: u64,
    replaced_through_seq: u64,
    completed_facts: Vec<String>,
    pending_risks_approvals_recovery: Vec<String>,
    evidence_refs: Vec<String>,
    source_event_count: usize,
    #[serde(skip)]
    _events: std::marker::PhantomData<&'a ()>,
}

fn structured_summary_value(
    goal: &str,
    events: &[AgentSessionEvent],
    boundary: u64,
    previous_generation: u64,
) -> serde_json::Value {
    serde_json::to_value(StructuredSummary {
        format: "shellspan.agent.surface-compaction.v2",
        goal: bounded(redact_sensitive_text(goal), 4 * 1024),
        previous_surface_generation: previous_generation,
        replaced_through_seq: boundary,
        completed_facts: completed_facts(events, boundary),
        pending_risks_approvals_recovery: pending_risks(events, boundary),
        evidence_refs: evidence_references(events, boundary),
        source_event_count: events.iter().filter(|event| event.seq <= boundary).count(),
        _events: std::marker::PhantomData,
    })
    .expect("structured compaction summary is serializable")
}

fn completed_facts(events: &[AgentSessionEvent], boundary: u64) -> Vec<String> {
    events
        .iter()
        .filter(|event| event.seq <= boundary)
        .filter_map(|event| match &event.payload {
            AgentSessionEventPayload::ToolResult {
                status: super::AgentToolResultStatus::Completed,
                name,
                summary,
                ..
            } => Some(format!("{name}: {}", redact_sensitive_text(summary))),
            AgentSessionEventPayload::TaskEvidence { kind, summary, .. } => {
                Some(format!("{kind}: {}", redact_sensitive_text(summary)))
            }
            _ => None,
        })
        .map(|value| bounded(value, 2 * 1024))
        .take(MAX_COMPACTION_FACTS)
        .collect()
}

fn pending_risks(events: &[AgentSessionEvent], boundary: u64) -> Vec<String> {
    events
        .iter()
        .filter(|event| event.seq <= boundary)
        .filter_map(|event| match &event.payload {
            AgentSessionEventPayload::ToolApproval {
                status: super::AgentToolApprovalStatus::Requested,
                call_id,
                risk,
                ..
            } => Some(format!("approval pending for {call_id} ({risk:?})")),
            AgentSessionEventPayload::TaskState {
                recovery: Some(recovery),
                ..
            } if recovery.status != AgentRecoveryStatus::None => Some(format!(
                "recovery {:?}: {}",
                recovery.status,
                recovery.summary.as_deref().unwrap_or("no summary")
            )),
            _ => None,
        })
        .map(|value| bounded(redact_sensitive_text(&value), 2 * 1024))
        .take(MAX_COMPACTION_RISKS)
        .collect()
}

fn evidence_references(events: &[AgentSessionEvent], boundary: u64) -> Vec<String> {
    let mut refs = BTreeSet::new();
    for event in events.iter().filter(|event| event.seq <= boundary) {
        match &event.payload {
            AgentSessionEventPayload::ToolResult { evidence_refs, .. } => {
                refs.extend(evidence_refs.iter().cloned());
            }
            AgentSessionEventPayload::ContextArtifact { artifact_id, .. } => {
                refs.insert(artifact_id.clone());
            }
            AgentSessionEventPayload::TaskEvidence { evidence_id, .. } => {
                refs.insert(evidence_id.clone());
            }
            _ => {}
        }
        if refs.len() >= MAX_COMPACTION_REFERENCES {
            break;
        }
    }
    refs.into_iter().collect()
}

fn bullet_list(values: &[String], empty: &str) -> String {
    if values.is_empty() {
        return format!("- {empty}");
    }
    values
        .iter()
        .map(|value| format!("- {value}"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn bounded(value: String, maximum: usize) -> String {
    if value.len() <= maximum {
        return value;
    }
    let mut end = maximum;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runtime::{
        AgentInboxMessage, AgentMessageSource, AgentSessionEvent, AgentToolApprovalStatus,
        AgentToolResultStatus, RecordedToolCall,
    };

    fn event(
        seq: u64,
        turn_id: Option<&str>,
        step_id: Option<&str>,
        payload: AgentSessionEventPayload,
    ) -> AgentSessionEvent {
        AgentSessionEvent::new(
            "session".into(),
            seq,
            1_000 + seq,
            turn_id.map(str::to_string),
            step_id.map(str::to_string),
            payload,
        )
    }

    fn budget() -> ModelSurfaceBudget {
        ModelSurfaceBudget {
            context_window: 16_384,
            output_reserve_tokens: 1_024,
            safety_reserve_tokens: 1_024,
            usable_input_tokens: 14_336,
            compaction_threshold_tokens: 12_185,
            compaction_target_tokens: 8_601,
            system_tokens: 100,
            tool_schema_tokens: 100,
            message_tokens: 13_000,
            estimated_input_tokens: 13_200,
            estimated_input_bytes: 52_800,
            maximum_input_bytes: 57_344,
        }
    }

    fn configured_session() -> (tempfile::TempDir, AgentSessionStore, AgentArtifactStore) {
        let root = tempfile::tempdir().unwrap();
        let sessions = AgentSessionStore::default();
        let artifacts = AgentArtifactStore::default();
        sessions.configure(root.path().to_path_buf()).unwrap();
        artifacts.configure(root.path()).unwrap();
        sessions
            .create(super::super::CreateAgentSessionRequest {
                session_id: "session".into(),
                task_id: "task".into(),
                goal: "Preserve audit history while compacting".into(),
                parent_session_id: None,
                target: None,
                permission_mode: None,
                success_criteria: Vec::new(),
                capability_scope: None,
                subagent: None,
            })
            .unwrap();
        for (turn_id, step_id, payload) in [
            (Some("turn-old"), None, AgentSessionEventPayload::TurnStart),
            (
                Some("turn-old"),
                Some("step-old"),
                AgentSessionEventPayload::StepStart,
            ),
            (
                Some("turn-old"),
                Some("step-old"),
                AgentSessionEventPayload::UserMessage {
                    message: AgentInboxMessage {
                        message_id: "message-old".into(),
                        content: "old context ".repeat(2_000),
                        source: AgentMessageSource::User,
                    },
                },
            ),
            (
                Some("turn-old"),
                Some("step-old"),
                AgentSessionEventPayload::StepEnd {
                    reason: "completed".into(),
                },
            ),
            (
                Some("turn-old"),
                None,
                AgentSessionEventPayload::TurnEnd {
                    reason: "completed".into(),
                },
            ),
        ] {
            sessions
                .append(
                    "session",
                    turn_id.map(str::to_string),
                    step_id.map(str::to_string),
                    payload,
                )
                .unwrap();
        }
        (root, sessions, artifacts)
    }

    #[test]
    fn selects_only_oldest_complete_safe_turn_prefix() {
        let events = vec![
            event(0, Some("turn-a"), None, AgentSessionEventPayload::TurnStart),
            event(
                1,
                Some("turn-a"),
                Some("step-a"),
                AgentSessionEventPayload::UserMessage {
                    message: AgentInboxMessage {
                        message_id: "message-a".into(),
                        content: "x".repeat(20_000),
                        source: AgentMessageSource::User,
                    },
                },
            ),
            event(
                2,
                Some("turn-a"),
                None,
                AgentSessionEventPayload::TurnEnd {
                    reason: "completed".into(),
                },
            ),
            event(3, Some("turn-b"), None, AgentSessionEventPayload::TurnStart),
        ];
        assert_eq!(
            select_complete_turn_prefix(&events, None, Some("turn-b"), &budget(), false).unwrap(),
            Some(2)
        );
    }

    #[test]
    fn pending_approval_and_unfinished_tool_group_block_prefix_selection() {
        let call = RecordedToolCall {
            call_id: "call".into(),
            provider_call_id: None,
            name: "apply_patch".into(),
            native_name: Some("apply_patch".into()),
            arguments: serde_json::json!({}),
            title: None,
            effect: None,
            target: None,
        };
        let events = vec![
            event(0, Some("turn"), None, AgentSessionEventPayload::TurnStart),
            event(
                1,
                Some("turn"),
                Some("step"),
                AgentSessionEventPayload::ToolCall { call },
            ),
            event(
                2,
                Some("turn"),
                Some("step"),
                AgentSessionEventPayload::ToolApproval {
                    request_id: "request".into(),
                    call_id: "call".into(),
                    approval_id: Some("approval".into()),
                    status: AgentToolApprovalStatus::Requested,
                    risk: None,
                    reason: None,
                    expires_at_unix_ms: Some(10_000),
                    prompt: None,
                },
            ),
            event(
                3,
                Some("turn"),
                None,
                AgentSessionEventPayload::TurnEnd {
                    reason: "waiting".into(),
                },
            ),
        ];
        assert_eq!(
            select_complete_turn_prefix(&events, None, None, &budget(), true).unwrap(),
            None
        );
        let _ = AgentToolResultStatus::Completed;
    }

    #[test]
    fn compaction_commits_artifact_summary_and_generation_atomically() {
        let (_root, sessions, artifacts) = configured_session();
        let manager = AgentCompactionManager::new(sessions.clone(), artifacts.clone());
        let outcome = manager
            .compact(
                "session",
                "turn-new",
                "step-new",
                None,
                "budgetThreshold",
                &budget(),
                true,
            )
            .unwrap();
        let snapshot = sessions.snapshot("session").unwrap();
        assert_eq!(snapshot.surface.generation, 1);
        assert_eq!(
            artifacts.verify("session", &outcome.artifact).unwrap(),
            super::super::AgentArtifactIntegrity::Verified
        );
        let events = sessions.all_events("session").unwrap();
        assert!(events
            .iter()
            .any(|event| matches!(event.payload, AgentSessionEventPayload::UserMessage { .. })));
        assert!(matches!(
            events.last().map(|event| &event.payload),
            Some(AgentSessionEventPayload::CompactionEnd {
                status: AgentCompactionStatus::Completed,
                ..
            })
        ));
    }

    struct FailingSummarizer;

    impl AgentCompactionSummarizer for FailingSummarizer {
        fn summarize(
            &self,
            _goal: &str,
            _events: &[AgentSessionEvent],
            _replaced_through_seq: u64,
            _artifact: &AgentArtifactMetadata,
        ) -> Result<String, String> {
            Err("synthetic summarizer failure".into())
        }
    }

    #[test]
    fn failed_compaction_is_durable_and_never_advances_the_surface() {
        let (_root, sessions, artifacts) = configured_session();
        let manager = AgentCompactionManager::with_summarizer(
            sessions.clone(),
            artifacts,
            Arc::new(FailingSummarizer),
        );
        assert!(manager
            .compact(
                "session",
                "turn-new",
                "step-new",
                None,
                "budgetThreshold",
                &budget(),
                true,
            )
            .is_err());
        assert_eq!(sessions.snapshot("session").unwrap().surface.generation, 0);
        assert!(matches!(
            sessions
                .all_events("session")
                .unwrap()
                .last()
                .map(|event| &event.payload),
            Some(AgentSessionEventPayload::CompactionEnd {
                status: AgentCompactionStatus::Failed,
                ..
            })
        ));
    }
}
