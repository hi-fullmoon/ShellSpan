use serde::{Deserialize, Serialize};

use super::{
    AgentFleetState, AgentPlanStep, AgentRecoveryState, AgentSessionEvent, AgentSessionEventPayload,
};

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentTaskPlanProjection {
    pub(crate) version: u64,
    pub(crate) steps: Vec<AgentPlanStep>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentTaskEvidenceProjection {
    pub(crate) evidence_id: String,
    pub(crate) kind: String,
    pub(crate) summary: String,
    pub(crate) recorded_at_seq: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentTaskProjection {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) goal: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) phase: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) progress: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) plan: Option<AgentTaskPlanProjection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) recovery: Option<AgentRecoveryState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) fleet: Option<AgentFleetState>,
    pub(crate) evidence: Vec<AgentTaskEvidenceProjection>,
}

pub(crate) fn derive_task(events: &[AgentSessionEvent]) -> AgentTaskProjection {
    let mut projection = AgentTaskProjection {
        task_id: None,
        goal: None,
        status: None,
        phase: None,
        progress: None,
        plan: None,
        recovery: None,
        fleet: None,
        evidence: Vec::new(),
    };
    for event in events {
        match &event.payload {
            AgentSessionEventPayload::SessionCreated { task_id, goal, .. } => {
                projection.task_id = Some(task_id.clone());
                projection.goal = Some(goal.clone());
            }
            AgentSessionEventPayload::TaskLinked { task_id, goal } => {
                projection.task_id = Some(task_id.clone());
                if goal.is_some() {
                    projection.goal.clone_from(goal);
                }
            }
            AgentSessionEventPayload::TaskPlan { version, steps } => {
                projection.plan = Some(AgentTaskPlanProjection {
                    version: *version,
                    steps: steps.clone(),
                });
            }
            AgentSessionEventPayload::TaskState {
                status,
                phase,
                progress,
                recovery,
                fleet,
            } => {
                projection.status = Some(status.clone());
                projection.phase.clone_from(phase);
                projection.progress = *progress;
                projection.recovery.clone_from(recovery);
                projection.fleet.clone_from(fleet);
            }
            AgentSessionEventPayload::TaskEvidence {
                evidence_id,
                kind,
                summary,
            } => projection.evidence.push(AgentTaskEvidenceProjection {
                evidence_id: evidence_id.clone(),
                kind: kind.clone(),
                summary: summary.clone(),
                recorded_at_seq: event.seq,
            }),
            _ => {}
        }
    }
    projection
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runtime::{AgentRecoveryStatus, AgentSessionEvent};

    fn event(seq: u64, payload: AgentSessionEventPayload) -> AgentSessionEvent {
        AgentSessionEvent::new("session".into(), seq, 1_000 + seq, None, None, payload)
    }

    #[test]
    fn task_projection_replays_latest_state_and_all_evidence() {
        let projection = derive_task(&[
            event(
                0,
                AgentSessionEventPayload::SessionCreated {
                    task_id: "task-1".into(),
                    goal: "inspect".into(),
                    parent_session_id: None,
                    target: None,
                    permission_mode: None,
                    success_criteria: Vec::new(),
                    capability_scope: None,
                    subagent: None,
                },
            ),
            event(
                1,
                AgentSessionEventPayload::TaskState {
                    status: "running".into(),
                    phase: Some("inspect".into()),
                    progress: Some(0.5),
                    recovery: Some(AgentRecoveryState {
                        status: AgentRecoveryStatus::None,
                        summary: None,
                    }),
                    fleet: None,
                },
            ),
            event(
                2,
                AgentSessionEventPayload::TaskEvidence {
                    evidence_id: "evidence-1".into(),
                    kind: "terminal-output".into(),
                    summary: "healthy".into(),
                },
            ),
        ]);
        assert_eq!(projection.task_id.as_deref(), Some("task-1"));
        assert_eq!(projection.status.as_deref(), Some("running"));
        assert_eq!(projection.evidence[0].recorded_at_seq, 2);
    }
}
