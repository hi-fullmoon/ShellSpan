use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};

use super::{AgentSessionEvent, AgentSessionEventPayload as Payload, AgentToolResultStatus};

#[derive(Debug, Clone, Default)]
struct StepProgress {
    events: Vec<AgentSessionEvent>,
    changed: bool,
}

/// Five preceding signatures extend cycles of one through five tool steps.
#[derive(Debug, Clone, Default)]
struct Repetitions {
    history: VecDeque<String>,
    lengths: [usize; 5],
}

impl Repetitions {
    fn push(&mut self, signature: String) {
        for period in 1..=5 {
            self.lengths[period - 1] = if self.history.len() >= period
                && self.history[self.history.len() - period] == signature
            {
                self.lengths[period - 1].saturating_add(1)
            } else {
                period.min(self.history.len() + 1)
            };
        }
        self.history.push_back(signature);
        if self.history.len() > 5 {
            self.history.pop_front();
        }
    }

    fn count(&self) -> usize {
        self.lengths
            .iter()
            .enumerate()
            .filter(|(index, length)| **length >= 2 * (index + 1))
            .map(|(index, length)| *length / (index + 1))
            .max()
            .unwrap_or(usize::from(!self.history.is_empty()))
    }
}

#[cfg(test)]
mod tests {
    use super::Repetitions;

    #[test]
    fn requires_five_complete_cycles_for_every_supported_period() {
        for period in 1..=5 {
            let mut repetitions = Repetitions::default();
            for index in 0..5 * period {
                repetitions.push((index % period).to_string());
                assert_eq!(repetitions.count() >= 5, index + 1 == 5 * period);
            }
            repetitions.push("new observation".into());
            assert_eq!(repetitions.count(), 1);
            assert!(repetitions.history.len() <= 5);
        }
    }
}

type FileKey = (Option<String>, String);

#[derive(Debug, Clone, Default)]
pub(super) struct LoopProgress {
    turn_id: Option<String>,
    steps: HashMap<String, StepProgress>,
    evidence: HashSet<String>,
    repetitions: Repetitions,
    edits: HashMap<(String, String), (String, FileKey)>,
    failures: HashMap<FileKey, usize>,
    failure_counts: BTreeMap<usize, usize>,
    recovery_used: bool,
}

fn digest(value: &impl serde::Serialize) -> String {
    // Only serializable event fields are passed here.
    crate::llm::runtime::digest(&serde_json::to_vec(value).expect("event fields serialize"))
}

impl LoopProgress {
    pub(super) fn observe(&mut self, event: &AgentSessionEvent) {
        if matches!(event.payload, Payload::TurnStart) {
            *self = Self {
                turn_id: event.turn_id.clone(),
                ..Self::default()
            };
        }
        let Some(turn_id) = event.turn_id.as_deref() else {
            return;
        };
        if self.turn_id.is_none() {
            self.turn_id = Some(turn_id.into());
        }
        if self.turn_id.as_deref() != Some(turn_id) {
            return;
        }
        if let Payload::UserMessage { message } = &event.payload {
            if message.source.kind == super::AgentMessageSourceKind::User {
                self.recovery_used = false;
                self.repetitions = Repetitions::default();
            } else if message.source == super::AgentMessageSource::runtime("loop-recovery".into()) {
                self.recovery_used = true;
                self.repetitions = Repetitions::default();
            }
        }
        let Some(step_id) = event.step_id.as_deref() else {
            return;
        };

        self.observe_edit(event, step_id);
        let changed = match &event.payload {
            Payload::TaskEvidence { kind, summary, .. } => {
                self.evidence.insert(digest(&(kind, summary)))
            }
            Payload::UserMessage { message } => {
                message.source.kind == super::AgentMessageSourceKind::User
            }
            Payload::ToolApproval {
                status: super::AgentToolApprovalStatus::Approved,
                approval_id: Some(_),
                ..
            }
            | Payload::QuestionAnswered { .. } => true,
            _ => false,
        };
        if changed {
            self.steps.entry(step_id.into()).or_default().changed = true;
        }
        match &event.payload {
            Payload::ToolCall { .. } | Payload::ToolResult { .. } | Payload::TaskPlan { .. } => {
                self.steps
                    .entry(step_id.into())
                    .or_default()
                    .events
                    .push(event.clone());
            }
            Payload::StepEnd { reason } => {
                let step = self.steps.remove(step_id).unwrap_or_default();
                if step.changed || reason != "toolsCompleted" {
                    self.repetitions = Repetitions::default();
                }
                if reason == "toolsCompleted" {
                    let refs = step.events.iter().collect::<Vec<_>>();
                    if let Some(signature) = super::driver::tool_step_signature(&refs) {
                        self.repetitions.push(digest(&signature));
                    } else {
                        self.repetitions = Repetitions::default();
                    }
                }
            }
            _ => {}
        }
    }

    pub(super) fn counts(&self, turn_id: &str) -> (usize, usize) {
        if self.turn_id.as_deref() != Some(turn_id) {
            return (0, 0);
        }
        (
            self.failure_counts
                .last_key_value()
                .map_or(0, |(count, _)| *count),
            self.repetitions.count(),
        )
    }

    pub(super) fn recovery_used(&self, turn_id: &str) -> bool {
        self.turn_id.as_deref() == Some(turn_id) && self.recovery_used
    }

    fn set_failures(&mut self, key: FileKey, count: usize) {
        if let Some(previous) = self.failures.remove(&key) {
            if let Some(frequency) = self.failure_counts.get_mut(&previous) {
                *frequency -= 1;
                if *frequency == 0 {
                    self.failure_counts.remove(&previous);
                }
            }
        }
        if count > 0 {
            self.failures.insert(key, count);
            *self.failure_counts.entry(count).or_default() += 1;
        }
    }

    fn observe_edit(&mut self, event: &AgentSessionEvent, step_id: &str) {
        match &event.payload {
            Payload::UserMessage { message }
                if message.source.kind == super::AgentMessageSourceKind::User =>
            {
                self.edits.clear();
                self.failures.clear();
                self.failure_counts.clear();
            }
            Payload::ToolCall { call }
                if matches!(
                    call.name.as_str(),
                    "apply_patch" | "write_file" | "edit_file"
                ) =>
            {
                let path = if call.name == "apply_patch" {
                    call.arguments.pointer("/preconditions/0/path")
                } else {
                    call.arguments.get("path")
                };
                if let Some(path) = path.and_then(serde_json::Value::as_str) {
                    self.edits.insert(
                        (step_id.into(), call.call_id.clone()),
                        (
                            call.name.clone(),
                            (
                                call.target.as_ref().map(|target| target.target_id.clone()),
                                path.into(),
                            ),
                        ),
                    );
                }
            }
            Payload::ToolResult {
                call_id,
                status,
                summary,
                data,
                ..
            } => {
                let Some((name, key)) = self.edits.remove(&(step_id.into(), call_id.clone()))
                else {
                    return;
                };
                let preparation_error = *status == AgentToolResultStatus::Rejected
                    && [
                        "apply_patch ",
                        "write_file ",
                        "edit_file ",
                        "invalid apply_patch ",
                        "invalid write_file ",
                        "invalid edit_file ",
                    ]
                    .iter()
                    .any(|prefix| summary.starts_with(prefix));
                if *status == AgentToolResultStatus::Failed || preparation_error {
                    let count = self
                        .failures
                        .get(&key)
                        .copied()
                        .unwrap_or(0)
                        .saturating_add(1);
                    self.set_failures(key, count);
                } else if *status == AgentToolResultStatus::Completed {
                    let Some(data) = data else { return };
                    let digests = if matches!(name.as_str(), "apply_patch" | "edit_file") {
                        data.pointer("/files/0")
                    } else {
                        Some(data)
                    };
                    let before = digests.and_then(|value| value.get("beforeSha256"));
                    let after = digests.and_then(|value| value.get("afterSha256"));
                    if data.get("applied").or_else(|| data.get("written"))
                        == Some(&serde_json::Value::Bool(true))
                        && data.get("verified") == Some(&serde_json::Value::Bool(true))
                        && after.and_then(serde_json::Value::as_str).is_some()
                        && before != after
                    {
                        self.set_failures(key, 0);
                    }
                }
            }
            _ => {}
        }
    }
}
