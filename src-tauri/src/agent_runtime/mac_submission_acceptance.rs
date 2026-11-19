//! Explicit no-model entrance to the installed tool pipeline. No native receipt
//! or approval is synthesized here; production policy and decisions still run.
use super::{ActiveDriverLease, AgentRuntime};
use crate::agent_runtime::{
    AgentActiveScope, AgentExecutionSurface, AgentInboxLane, AgentInboxMessage,
    AgentLifecyclePhase, AgentMessageSource, AgentSessionEventPayload, AgentSessionPermissionMode,
    AgentToolDecision, AgentToolDecisionInput, AgentToolResultStatus, ModelToolCall,
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
        if super::super::native::mac_sandbox_preview_active() {
            return Err("Fixed-command acceptance is unavailable in the manual preview".into());
        }
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
        let execution_surface = if std::env::var("SHELLSPAN_ACCEPTANCE_SUBMISSION_SCENARIO")
            .as_deref()
            == Ok("local-sandbox-direct")
        {
            AgentExecutionSurface::Direct
        } else {
            AgentExecutionSurface::BoundTerminal
        };
        let target_owned = if crate::terminal_command::acceptance_trace::ssh_recovery_enabled() {
            let (user, profile) =
                if std::env::var("SHELLSPAN_ACCEPTANCE_SSH_SHELL").as_deref() == Ok("bash") {
                    (
                        "native53",
                        "gnu-bash-5.3-readline-8.3.6-linux-aarch64-glibc-2.36-native",
                    )
                } else {
                    (
                        "nativeZle",
                        "zsh-5.9-zle-5.9-linux-aarch64-glibc-2.36-native",
                    )
                };
            let port = std::env::var("SHELLSPAN_ACCEPTANCE_SSH_PORT")
                .ok()
                .and_then(|value| value.parse::<u16>().ok())
                .filter(|port| *port > 1024);
            let raw_negative = matches!(
                std::env::var("SHELLSPAN_ACCEPTANCE_SUBMISSION_SCENARIO").as_deref(),
                Ok("raw-unapproved-shell" | "raw-resource-mismatch")
            );
            target.kind == "remote"
                && target.host.as_deref() == Some("127.0.0.1")
                && port.is_some()
                && target.port == port
                && target.username.as_deref() == Some(user)
                && self
                    .terminal_broker_snapshot(Some(&target.session_id))?
                    .session
                    .is_some_and(|session| {
                        session.open
                            && session.transport_kind
                                == crate::terminal_broker::TerminalTransportKind::SshPty
                            && if raw_negative {
                                session.input_mode
                                    == crate::terminal_command::protocol::InputMode::Raw
                                    && session.native_peer_profile.is_none()
                            } else {
                                session
                                    .native_peer_profile
                                    .as_ref()
                                    .and_then(|profile| profile.verified_profile_id.as_deref())
                                    == Some(profile)
                            }
                    })
        } else {
            target.kind == "local"
                && target.cwd.as_deref() == home.to_str()
                && target.local_root.as_deref() == home.to_str()
        };
        let permission_supported = snapshot.header.permission_mode
            == Some(AgentSessionPermissionMode::RequestApproval)
            || (execution_surface == AgentExecutionSurface::Direct
                && snapshot.header.permission_mode.is_some());
        if snapshot.ended
            || (!session_id.starts_with("phase3-submission-") && !delegated)
            || snapshot.header.model_selection.is_some()
            || snapshot.header.execution_surface != execution_surface
            || !permission_supported
            || !target_owned
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
        tool_argument: Option<&str>,
    ) -> Result<Value, String> {
        self.require_submission_acceptance_session(session_id, home)?;
        let id = uuid::Uuid::parse_str(call_id)
            .map_err(|_| "ACCEPTANCE_EXACT_CALL_UUID_REQUIRED".to_string())?;
        if id.to_string() != call_id {
            return Err("ACCEPTANCE_EXACT_CALL_UUID_REQUIRED".into());
        }
        let ssh = crate::terminal_command::acceptance_trace::ssh_recovery_enabled();
        let scenario =
            std::env::var("SHELLSPAN_ACCEPTANCE_SUBMISSION_SCENARIO").unwrap_or_default();
        let sandbox_direct = scenario == "local-sandbox-direct";
        if ssh
            && !match scenario.as_str() {
                "reconnect-tail" | "display-geometry" | "ordinary-input" | "raw-no-sftp" => false,
                "raw-unapproved-shell" | "raw-resource-mismatch" => source_kind == "effect",
                "running-stop"
                | "running-cancel"
                | "running-takeover"
                | "after-accept-stop"
                | "after-accept-cancel"
                | "after-accept-takeover" => source_kind == "running",
                "input-in-progress-stop"
                | "input-in-progress-cancel"
                | "input-in-progress-takeover" => source_kind == "paced-input",
                "runtime-multi-agent" | "close-running-terminal" | "delegation" => {
                    matches!(source_kind, "effect" | "running")
                }
                "positive-byte-boundary" => matches!(
                    source_kind,
                    "exact-byte-boundary" | "oversized-byte-boundary"
                ),
                "positive-source-boundaries" => matches!(
                    source_kind,
                    "complex-source" | "syntax-error" | "unsupported-input"
                ),
                "positive-parent-shell" => matches!(source_kind, "parent-shell" | "effect"),
                "positive-jobs" => matches!(source_kind, "job-launch" | "job-wait" | "job-stop"),
                "positive-job-completion" => matches!(source_kind, "job-launch" | "job-wait"),
                "positive-file-chain" => {
                    matches!(source_kind, "file-write" | "file-read" | "file-run")
                }
                _ => source_kind == "effect",
            }
        {
            return Err("ACCEPTANCE_SOURCE_KIND_REQUIRED".into());
        }
        let effect_file = if ssh {
            "phase3-ssh-effects"
        } else {
            "phase3-effects"
        };
        let effect = format!("printf '%s\\n' '{id}' >> \"$HOME/{effect_file}\"");
        let expected_arg = matches!(source_kind, "job-wait" | "job-stop" | "file-run");
        if tool_argument.is_some() != expected_arg {
            return Err("ACCEPTANCE_EXACT_TOOL_ARGUMENT_REQUIRED".into());
        }
        const FILE_NAME: &str = "phase3-scratch.sh";
        let file_chain = (ssh && scenario == "positive-file-chain")
            || (!ssh
                && matches!(
                    scenario.as_str(),
                    "local-file-chain" | "local-file-restart-prepare" | "local-file-restart-verify"
                ));
        let ownership_write =
            !ssh && scenario == "local-file-ownership" && source_kind == "file-write";
        let file_content = if ssh {
            "[[ $PWD == \"$HOME/phase3-parent\" && $PHASE3_PARENT == parent-env && $(phase3_parent_fn) == parent-function ]] || return 31\nprintf '%s\\n' FILE_ONCE >> \"$HOME/phase3-ssh-effects\"\n"
        } else {
            "[[ $PWD == \"$HOME\" && $PHASE3_PARENT == parent-env && $(phase3_parent_fn) == parent-function ]] || return 31\nprintf '%s\\n' FILE_ONCE >> \"$HOME/phase3-effects\"\n"
        };
        let source = match source_kind {
            "sandbox-reviewed-read" if sandbox_direct => "cat review-fixture/input.txt".into(),
            "sandbox-reviewed-list" if sandbox_direct => "ls review-fixture".into(),
            "sandbox-operator-write" if sandbox_direct => format!("printf entered > exit-{id}"),
            "sandbox-operator-outside-read" if sandbox_direct => "cat ../launcher.json".into(),
            "sandbox-gate" if sandbox_direct => format!("printf gate > gate-{id}"),
            "sandbox-init" if sandbox_direct => format!("printf init > init-{id}"),
            "sandbox-exit" if sandbox_direct => format!("printf entered > exit-{id}; printf nonzero >&2; exit 42"),
            "sandbox-exit-125" if sandbox_direct => format!("printf entered > exit-{id}; printf 'sandbox launcher: command diagnostic' >&2; exit 125"),
            "sandbox-before" if sandbox_direct => format!("printf before > before-{id}"),
            "sandbox-after" if sandbox_direct => format!("printf after >> after-{id}"),
            "sandbox-restart" if sandbox_direct => {
                format!("printf '%s\\n' \"$$\" >> pid-{id}; i=0; while [ ! -f release-{id} ] && [ \"$i\" -lt 250 ]; do i=$((i+1)); /bin/sleep .1; done")
            }
            "sandbox-cancel" | "sandbox-timeout" if sandbox_direct => {
                format!("printf '%s\\n' \"$$\" >> pid-{id}; exec /bin/sleep 30")
            }
            "effect" if ssh && scenario == "after-key-disconnect" => {
                format!("{effect}; exec /bin/sleep 30")
            }
            "effect" if ssh && matches!(scenario.as_str(), "after-key-control-eof" | "crash-after-key") => {
                format!("{effect}; /bin/sleep 15")
            }
            "effect" => format!("{effect}; printf '%s\\n' 'PHASE3_DONE_{id}'"),
            "running" => format!("{effect}; printf '%s\\n' 'PHASE3_RUNNING_{id}'; sleep 30"),
            "manual-running" if scenario == "human-phase3" => {
                format!("{effect}; printf '%s\\n' 'PHASE3_RUNNING_{id}'; sleep 180")
            }
            "syntax-error" => format!("{effect}\nif"),
            "unsupported-input" => format!("{effect}; \0"),
            "complex-source" if ssh && scenario == "positive-source-boundaries" => format!(
                "value=$(cat <<'SS_SOURCE'\n中文 e\u{301} 👩‍💻\t! \"quote\" 'single'\nSS_SOURCE\n)\n[[ $value == $'中文 e\u{301} 👩‍💻\\t! \"quote\" \\'single\\'' ]] && {{ {effect}; }}"
            ),
            "parent-shell" if ssh && scenario == "positive-parent-shell" => format!(
                "[[ $PWD == \"$HOME/phase3-parent\" && $PHASE3_PARENT == 'parent-env' && $(phase3_parent_fn) == 'parent-function' ]] && {{ {effect}; }}; (exit 7)"
            ),
            "exact-byte-boundary" | "oversized-byte-boundary"
                if matches!(scenario.as_str(), "byte-boundary" | "positive-byte-boundary") => {
                let bytes = if source_kind == "exact-byte-boundary" {
                    8192
                } else {
                    8193
                };
                let prefix = format!("{effect}; : '");
                format!("{prefix}{}'", "x".repeat(bytes - prefix.len() - 1))
            }
            "long-input" => format!("printf '%s' '{}' >/dev/null; {effect}", "x".repeat(4096)),
            "paced-input" => format!(": '{}'; {effect}", "x".repeat(256)),
            "transport-read" => format!("{effect}; read -r -t 30 phase3_transport"),
            "job-launch" if ssh && scenario == "positive-job-completion" => format!(
                "{effect}; printf '%s%s\\n' SSH_NATIVE_JOB_ LIVE; for attempt in {{1..120}}; do [[ -e $HOME/phase3-ssh-tail-release ]] && break; /bin/sleep .1; done; [[ -e $HOME/phase3-ssh-tail-release ]] || exit 99; printf '%s%s\\n' SSH_NATIVE_TAIL_ BEGIN; /bin/sleep .2; printf '%s%s\\n' SSH_NATIVE_TAIL_ END; exit 7"
            ),
            "job-launch" if (ssh && scenario == "positive-jobs") || (!ssh && matches!(scenario.as_str(), "local-jobs" | "experimental-profile")) => {
                let prefix = if ssh { "SSH_NATIVE_JOB_" } else { "NATIVE_JOB_" };
                format!("{effect}; printf '%s%s\\n' {prefix} LIVE; /bin/sleep 30")
            }
            "job-wait" | "job-stop" if (ssh && matches!(scenario.as_str(), "positive-jobs" | "positive-job-completion")) || (!ssh && scenario == "local-jobs") => {
                if !tool_argument.is_some_and(crate::terminal_command::protocol::valid_job_handle) {
                    return Err("ACCEPTANCE_NATIVE_JOB_HANDLE_REQUIRED".into());
                }
                String::new()
            }
            "file-write" | "file-read" if file_chain || ownership_write => String::new(),
            "file-run" if file_chain => {
                let path = tool_argument.ok_or("ACCEPTANCE_ACTUAL_READBACK_PATH_REQUIRED")?;
                let from_readback = self.sessions.all_events(session_id)?.iter().any(|event| {
                    matches!(&event.payload, AgentSessionEventPayload::ToolResult { name, status: AgentToolResultStatus::Completed, data: Some(data), .. }
                        if name == "read_file" && data["path"].as_str() == Some(path)
                            && data["content"].as_str() == Some(file_content))
                });
                if !from_readback || !path.starts_with('/') || !path.ends_with(&format!("/{FILE_NAME}")) {
                    return Err("ACCEPTANCE_ACTUAL_READBACK_PATH_REQUIRED".into());
                }
                format!(". {}", shlex::try_quote(path).map_err(|_| "ACCEPTANCE_ACTUAL_READBACK_PATH_REQUIRED")?)
            }
            _ => return Err("ACCEPTANCE_SOURCE_KIND_REQUIRED".into()),
        };
        let timeout_ms = match (source_kind, scenario.as_str()) {
            ("sandbox-reviewed-read" | "sandbox-reviewed-list", "local-sandbox-direct") => 5_000,
            ("sandbox-timeout", "local-sandbox-direct") => 1_500,
            (
                "effect",
                "timeout-unknown-accept"
                | "late-started-and-matched-settled"
                | "before-key-timeout"
                | "after-key-timeout",
            )
            | ("transport-read", "transport-disconnect") => 5000,
            ("manual-running", "human-phase3") => 210000,
            _ => 60000,
        };
        let (tool, arguments) = match source_kind {
            "job-wait" => (
                "wait_process",
                json!({"processHandle": tool_argument, "timeoutMs": 1000}),
            ),
            "job-stop" => (
                "kill_process",
                json!({"processHandle": tool_argument, "signal": "terminate", "timeoutMs": 10000}),
            ),
            "file-write" => (
                "write_file",
                json!({"path": FILE_NAME, "content": file_content,
                "fileScope": "scratch", "precondition": {"mustNotExist": true}}),
            ),
            "file-read" => (
                "read_file",
                json!({"path": FILE_NAME, "encoding": "utf8", "fileScope": "scratch"}),
            ),
            _ => (
                "run_terminal_command",
                json!({"command": source,
                "explanation": "Explicit isolated no-model submission acceptance", "background": source_kind == "job-launch", "timeoutMs": timeout_ms}),
            ),
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
                    name: tool.into(),
                    arguments,
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
            .await?
            .acknowledge()?;
        // A normal decision wakes the model driver afterwards. This explicit
        // no-model entrance stops after that exact same production decision.
        Ok(
            json!({"session":self.sessions.snapshot(&input.session_id)?,"modelAvailability":entry.model().err()}),
        )
    }
}
