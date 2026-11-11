//! Explicit no-model entrance to the installed tool pipeline. No native receipt
//! or approval is synthesized here; production policy and decisions still run.
use super::{ActiveDriverLease, AgentRuntime};
use crate::agent_runtime::{
    AgentActiveScope, AgentExecutionSurface, AgentInboxLane, AgentInboxMessage,
    AgentLifecyclePhase, AgentMessageSource, AgentSessionPermissionMode, AgentToolDecision,
    AgentToolDecisionInput, ModelToolCall,
};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;

impl AgentRuntime {
    fn require_submission_acceptance_session(
        &self,
        session_id: &str,
        home: &Path,
    ) -> Result<(), String> {
        let snapshot = self.sessions.snapshot(session_id)?;
        let target = snapshot
            .header
            .target
            .as_ref()
            .ok_or("ACCEPTANCE_TARGET_REQUIRED")?;
        let delegated = std::env::var("SHELLSPAN_ACCEPTANCE_SUBMISSION_SCENARIO").as_deref()
            == Ok("delegation")
            && snapshot
                .header
                .subagent
                .as_ref()
                .is_some_and(|child| child.provider.is_none())
            && snapshot
                .header
                .parent_session_id
                .as_deref()
                .is_some_and(|id| id.starts_with("phase3-submission-"));
        if snapshot.ended
            || (!session_id.starts_with("phase3-submission-") && !delegated)
            || snapshot.header.model_selection.is_some()
            || snapshot.header.execution_surface != AgentExecutionSurface::BoundTerminal
            || snapshot.header.permission_mode != Some(AgentSessionPermissionMode::RequestApproval)
            || target.kind != "local"
            || target.cwd.as_deref() != home.to_str()
            || target.local_root.as_deref() != home.to_str()
        {
            return Err("ACCEPTANCE_ISOLATED_BOUND_TARGET_REQUIRED".into());
        }
        self.require_open_terminal_target(session_id)
    }

    pub(crate) async fn terminal_acceptance_run_command(
        &self,
        session_id: &str,
        home: &Path,
        call_id: &str,
        source_kind: &str,
    ) -> Result<Value, String> {
        self.require_submission_acceptance_session(session_id, home)?;
        let id = uuid::Uuid::parse_str(call_id)
            .map_err(|_| "ACCEPTANCE_EXACT_CALL_UUID_REQUIRED".to_string())?;
        if id.to_string() != call_id {
            return Err("ACCEPTANCE_EXACT_CALL_UUID_REQUIRED".into());
        }
        let effect = format!("printf '%s\\n' '{id}' >> \"$HOME/phase3-effects\"");
        let scenario =
            std::env::var("SHELLSPAN_ACCEPTANCE_SUBMISSION_SCENARIO").unwrap_or_default();
        let source = match source_kind {
            "effect" => format!("{effect}; printf '%s\\n' 'PHASE3_DONE_{id}'"),
            "running" => format!("{effect}; printf '%s\\n' 'PHASE3_RUNNING_{id}'; sleep 30"),
            "manual-running" if scenario == "human-phase3" => {
                format!("{effect}; printf '%s\\n' 'PHASE3_RUNNING_{id}'; sleep 180")
            }
            "syntax-error" => format!("{effect}\nif"),
            "unsupported-input" => format!("{effect}; \0"),
            "long-input" => format!("printf '%s' '{}' >/dev/null; {effect}", "x".repeat(4096)),
            "paced-input" => format!(": '{}'; {effect}", "x".repeat(256)),
            "transport-read" => format!("{effect}; read -r -t 30 phase3_transport"),
            _ => return Err("ACCEPTANCE_SOURCE_KIND_REQUIRED".into()),
        };
        let timeout_ms = match (source_kind, scenario.as_str()) {
            ("effect", "timeout-unknown-accept" | "late-started-and-matched-settled")
            | ("transport-read", "transport-disconnect") => 5000,
            ("manual-running", "human-phase3") => 210000,
            _ => 60000,
        };
        let entry = match self.agents.get(session_id)? {
            Some(entry) => entry,
            None => {
                let handle = self
                    .agents
                    .attach_without_model(self.sessions.clone(), session_id.into())?;
                let entry = handle.entry();
                let mut handles = self
                    .handles
                    .lock()
                    .map_err(|_| "Agent handle registry is unavailable".to_string())?;
                if handles.contains_key(session_id) {
                    self.agents.detach(session_id)?;
                    return Err("Agent Session already has an owning handle".into());
                }
                handles.insert(session_id.into(), handle);
                entry
            }
        };
        match entry.model() {
            Err(error) if error == "MODEL_SELECTION_REQUIRED" => {}
            Err(error) => return Err(error),
            Ok(_) => return Err("ACCEPTANCE_NO_MODEL_ENTRY_REQUIRED".into()),
        }
        if !entry.try_acquire_driver()? {
            return Err("ACCEPTANCE_TOOL_DRIVER_BUSY".into());
        }
        let _driver = ActiveDriverLease(Arc::clone(&entry));
        let (turn_id, step_id) = if let Some(scope) = entry.scope()? {
            // Re-deliver the original complete invocation identity. Starting
            // a continuation would authorize a different operation, not test
            // duplicate consumption of the original request.
            let step = scope.step_id.unwrap_or_else(|| format!("phase3-step-{id}"));
            (scope.turn_id, step)
        } else {
            let turn = format!("phase3-turn-{id}");
            let step = format!("phase3-step-{id}");
            self.sessions.enqueue(
                session_id,
                AgentInboxLane::NextTurn,
                AgentInboxMessage {
                    message_id: format!("phase3-explicit-input-{id}"),
                    client_submission_id: None,
                    content: format!("Execute the explicitly authorized isolated {source_kind} terminal acceptance request {id}; do not invoke a model."),
                    source: AgentMessageSource::user(),
                    images: Vec::new(),
                    terminal_context: None,
                },
            )?;
            self.sessions
                .begin_turn_step(session_id, turn.clone(), step.clone())?
                .ok_or("ACCEPTANCE_INPUT_NOT_CLAIMED")?;
            if matches!(scenario.as_str(), "delegation" | "human-phase3") {
                let snapshot = self.sessions.snapshot(session_id)?;
                let ancestors = super::terminal_turn_ancestors(&self.sessions, &snapshot)?;
                let target = snapshot
                    .header
                    .target
                    .as_ref()
                    .ok_or("ACCEPTANCE_TARGET_REQUIRED")?;
                self.native_engine.begin_delegated_terminal_turn(
                    &target.session_id,
                    session_id,
                    &ancestors,
                )?;
            }
            entry.set_scope(Some(AgentActiveScope {
                turn_id: turn.clone(),
                step_id: Some(step.clone()),
            }))?;
            entry.set_phase(AgentLifecyclePhase::Running)?;
            (turn, step)
        };
        let settlement = self
            .tools
            .process_model_calls(
                &entry,
                &turn_id,
                &step_id,
                &format!("phase3-request-{id}"),
                vec![ModelToolCall {
                    call_id: call_id.into(),
                    provider_call_id: None,
                    name: "run_terminal_command".into(),
                    arguments: json!({
                        "command": source,
                        "explanation": "Explicit isolated no-model submission acceptance",
                        "background": false,
                        "timeoutMs": timeout_ms
                    }),
                }],
            )
            .await?;
        Ok(json!({
            "invocationOrigin":"explicit isolated no-model tool request",
            "callId":call_id,"sourceKind":source_kind,"source":source,
            "settlement":format!("{settlement:?}"),
            "session":self.sessions.snapshot(session_id)?,
            "modelAvailability":entry.model().err()
        }))
    }

    pub(crate) async fn terminal_acceptance_decide_command(
        &self,
        home: &Path,
        input: AgentToolDecisionInput,
        approve: bool,
    ) -> Result<Value, String> {
        self.require_submission_acceptance_session(&input.session_id, home)?;
        let entry = self
            .agents
            .get(&input.session_id)?
            .ok_or("ACCEPTANCE_NO_MODEL_ENTRY_REQUIRED")?;
        match entry.model() {
            Err(error) if error == "MODEL_SELECTION_REQUIRED" => {}
            Err(error) => return Err(error),
            Ok(_) => return Err("ACCEPTANCE_NO_MODEL_ENTRY_REQUIRED".into()),
        }
        self.tools
            .decide(
                &entry,
                input.clone(),
                if approve {
                    AgentToolDecision::Approve
                } else {
                    AgentToolDecision::Reject
                },
            )
            .await?;
        // A normal decision wakes the model driver afterwards. This explicit
        // no-model entrance stops after that exact same production decision.
        Ok(
            json!({"session":self.sessions.snapshot(&input.session_id)?,"modelAvailability":entry.model().err()}),
        )
    }
}
