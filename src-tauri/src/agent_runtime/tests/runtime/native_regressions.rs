//! Regression scenarios use the production native adapter, event store, SQLite,
//! real shell integration and a local PTY. No model response or tool is replaced.
use super::*;
use crate::agent_runtime::native_adapter::NativeToolServices;
use crate::agent_runtime::{
    AgentActiveScope, AgentExecutionSurface, AgentSessionPermissionMode, AgentSubagentRole,
    AgentToolApprovalStatus, AgentToolResultStatus, ModelToolCall, ToolPipelineSettlement,
};
use crate::models::{
    ManagedSession, SessionCommand, SessionCommandSender, SessionIdentity, SessionManager,
    SessionStatus, SessionTerminalKind, StatusEvent,
};
use crate::terminal_broker::{TerminalGeometry, TerminalSessionBroker, TerminalTransportKind};
use crate::terminal_integration::{
    PreparedLocalShellIntegration, TerminalIntegrationControlHandle, TerminalShellKind,
};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::sync::atomic::AtomicBool;
use std::thread;
use std::time::{Duration, Instant};

const TERMINAL: &str = "native-regression-terminal";

struct Scenario {
    root: tempfile::TempDir,
    runtime: AgentRuntime,
    transport: SessionManager,
    broker: TerminalSessionBroker,
    shell: TerminalShellKind,
    master: Box<dyn portable_pty::MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    control: Option<TerminalIntegrationControlHandle>,
    output: Option<thread::JoinHandle<()>>,
    input: Option<thread::JoinHandle<()>>,
}

impl Scenario {
    fn new(shell: TerminalShellKind) -> Self {
        let root = tempfile::tempdir().unwrap();
        let work = root.path().join("work");
        std::fs::create_dir(&work).unwrap();
        let state = root.path().join("state");
        let integration = PreparedLocalShellIntegration::prepare(shell, &state).unwrap();
        let broker = TerminalSessionBroker::phase5_enabled_for_test(65_536);
        broker
            .attach_transport(
                TERMINAL,
                None,
                TerminalTransportKind::LocalPty,
                TerminalGeometry::new(120, 30),
            )
            .unwrap();
        let integration_id = integration.integration_id().to_string();
        broker
            .register_integration_channel(TERMINAL, &integration_id, shell)
            .unwrap();
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 30,
                cols: 120,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer =
            crate::local_terminal_input::take_writer(pair.master.as_ref(), shell).unwrap();
        let executable = match shell {
            TerminalShellKind::Bash if std::path::Path::new("/opt/homebrew/bin/bash").exists() => {
                "/opt/homebrew/bin/bash"
            }
            TerminalShellKind::Bash => "/bin/bash",
            TerminalShellKind::Zsh => "/bin/zsh",
            _ => unreachable!(),
        };
        let mut command = CommandBuilder::new(executable);
        command.cwd(&work);
        command.env("HOME", root.path());
        command.env("HISTFILE", root.path().join("history"));
        command.env("TERM", "xterm-256color");
        command.env("LC_ALL", "C");
        integration.configure_command(&mut command).unwrap();
        let events = broker.clone();
        let control = integration.start_reader(
            move |event| events.accept_integration_event(TERMINAL, &integration_id, event),
            |_| {},
        );
        let child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let output_broker = broker.clone();
        let output = thread::spawn(move || {
            let mut bytes = [0; 4096];
            while let Ok(count) = reader.read(&mut bytes) {
                if count == 0
                    || output_broker
                        .observe_raw_output(TERMINAL, &bytes[..count])
                        .is_err()
                {
                    break;
                }
            }
        });
        let transport = SessionManager::default();
        let (sender, receiver) = crossbeam_channel::unbounded();
        transport
            .insert(
                TERMINAL.into(),
                ManagedSession {
                    sender: SessionCommandSender::Event(sender),
                    waker: None,
                    output_state_sender: None,
                    status: StatusEvent {
                        session_id: TERMINAL.into(),
                        status: SessionStatus::Connected,
                        message: None,
                    },
                    output_ready: Arc::new(AtomicBool::new(true)),
                    output_paused: Arc::new(AtomicBool::new(false)),
                    terminal_kind: SessionTerminalKind::Local,
                    identity: SessionIdentity {
                        title: executable.into(),
                        host: "local".into(),
                        port: 0,
                        username: String::new(),
                    },
                },
            )
            .unwrap();
        let input = thread::spawn(move || {
            while let Ok(command) = receiver.recv() {
                match command {
                    SessionCommand::Write(data) => {
                        if writer
                            .write_all(data.as_bytes())
                            .and_then(|()| writer.flush())
                            .is_err()
                        {
                            break;
                        }
                    }
                    SessionCommand::Close => break,
                    _ => panic!("unexpected PTY operation"),
                }
            }
        });
        let engine = Arc::new(NativeToolEngine::with_terminal_broker(broker.clone()));
        let acknowledger = Arc::downgrade(&engine);
        engine
            .set_terminal_lease_publisher(Arc::new(move |event| {
                if event.state == super::super::TerminalLeaseEventState::Acquired {
                    acknowledger
                        .upgrade()
                        .expect("live scenario engine")
                        .acknowledge_terminal_lease_ready(
                            &event.session_id,
                            &event.agent_session_id,
                            &event.operation_id,
                            true,
                            true,
                            false,
                            false,
                            false,
                            true,
                        )
                        .unwrap();
                }
            }))
            .unwrap();
        let native = Arc::new(
            NativeToolAdapter::from_services(
                NativeToolServices {
                    sessions: transport.clone(),
                    database: crate::db::Database::open(&state.join("profiles.db")).unwrap(),
                    credentials: crate::keychain::CredentialManager::new(),
                    known_hosts_path: state.join("known_hosts"),
                    data_root: state.clone(),
                },
                engine.clone(),
            )
            .unwrap(),
        );
        let mut builder = AgentRuntimeBuilder::new().native_tool_runtime(native);
        builder.native_engine = engine;
        let runtime = builder.build();
        runtime.configure(state).unwrap();
        runtime.set_event_publisher(Arc::new(|_| {})).unwrap();
        let scenario = Self {
            root,
            runtime,
            transport,
            broker,
            shell,
            master: pair.master,
            child,
            control: Some(control),
            output: Some(output),
            input: Some(input),
        };
        scenario.wait_prompt();
        scenario
    }

    fn wait_prompt(&self) {
        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            let snapshot = self.broker.snapshot(Some(TERMINAL)).unwrap();
            if snapshot.session.as_ref().is_some_and(|s| s.prompt_ready) {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "real {:?} prompt unavailable: {snapshot:?}",
                self.shell
            );
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn wait_foreground_job(&self) {
        let fd = self.master.as_raw_fd().expect("real Unix PTY descriptor");
        let shell = self.child.process_id().expect("real shell PID") as libc::pid_t;
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            // A builtin marker can precede the shell's setpgid/tcsetpgrp for
            // sleep. Wait for the real foreground job before sending Ctrl-C.
            // SAFETY: the master owns this live PTY descriptor throughout Self.
            let foreground = unsafe { libc::tcgetpgrp(fd) };
            if foreground > 0 && foreground != shell {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "shell did not hand the PTY to the foreground job"
            );
            thread::sleep(Duration::from_millis(5));
        }
    }

    fn root(
        &self,
        id: &str,
        surface: AgentExecutionSurface,
        mode: AgentSessionPermissionMode,
    ) -> Arc<super::super::AgentEntry> {
        self.runtime.create_session(serde_json::from_value(json!({
            "sessionId": id, "taskId": id, "goal": "Review the actual repository source in the temporary workspace",
            "permissionMode": mode, "executionSurface": surface,
            "target": { "kind": "local", "targetId": TERMINAL, "sessionId": TERMINAL, "cwd": self.root.path().join("work") },
        })).unwrap()).unwrap();
        // Attach the real HTTP adapter as an owner; these tests exercise native
        // calls directly and never manufacture a model response or contact a model.
        let provider: AiProviderConfig = serde_json::from_value(json!({
            "id": "native-regression", "kind": "ollama", "profile": "ollama",
            "baseUrl": "http://127.0.0.1:1", "model": "qwen3:8b", "requiresApiKey": false,
        }))
        .unwrap();
        let adapter = self.runtime.models.resolve(provider.clone(), None).unwrap();
        let handle = self
            .runtime
            .agents
            .attach(self.runtime.sessions.clone(), id.into(), provider, adapter)
            .unwrap();
        let entry = handle.entry();
        self.runtime
            .handles
            .lock()
            .unwrap()
            .insert(id.into(), handle);
        entry
    }

    fn start(&self, entry: &Arc<super::super::AgentEntry>, turn: &str, step: &str) {
        let session = self.runtime.sessions.snapshot(&entry.session_id).unwrap();
        if session.inbox.next_turn.is_empty() {
            self.runtime
                .sessions
                .enqueue(
                    &entry.session_id,
                    AgentInboxLane::NextTurn,
                    AgentInboxMessage {
                        message_id: format!("input-{turn}"),
                        client_submission_id: None,
                        content:
                            "Inspect the actual repository source and preserve concurrent changes"
                                .into(),
                        source: AgentMessageSource::user(),
                        images: Vec::new(),
                        terminal_context: None,
                    },
                )
                .unwrap();
        }
        self.runtime
            .sessions
            .begin_turn_step(&entry.session_id, turn.into(), step.into())
            .unwrap()
            .unwrap();
        entry
            .set_scope(Some(AgentActiveScope {
                turn_id: turn.into(),
                step_id: Some(step.into()),
            }))
            .unwrap();
        entry.set_phase(AgentLifecyclePhase::Running).unwrap();
    }

    fn approval(&self, session: &str) -> AgentToolDecisionInput {
        self.runtime
            .sessions
            .read_events(session, |events| {
                events.iter().rev().find_map(|event| {
                    if let super::super::AgentSessionEventPayload::ToolApproval {
                        request_id,
                        call_id,
                        approval_id: Some(approval_id),
                        status: AgentToolApprovalStatus::Requested,
                        ..
                    } = &event.payload
                    {
                        Some(AgentToolDecisionInput {
                            session_id: session.into(),
                            turn_id: event.turn_id.clone().unwrap(),
                            step_id: event.step_id.clone().unwrap(),
                            request_id: request_id.clone(),
                            call_id: call_id.clone(),
                            approval_id: approval_id.clone(),
                        })
                    } else {
                        None
                    }
                })
            })
            .unwrap()
            .unwrap()
    }

    fn child(&self, parent: &str) -> Arc<super::super::AgentEntry> {
        let child = self
            .runtime
            .subagents
            .create_child(
                parent,
                "Inspect the actual shell directory and report the result".into(),
                AgentSubagentRole::General,
                "blank",
                vec![TERMINAL.into()],
                serde_json::from_value(
                    json!({ "maxStepsPerTurn": 6, "maxTurns": 8, "timeoutMs": 60_000 }),
                )
                .unwrap(),
                true,
            )
            .unwrap();
        let snapshot = self.runtime.session(&child).unwrap();
        assert_eq!(
            snapshot.header.execution_surface,
            AgentExecutionSurface::BoundTerminal
        );
        assert_eq!(
            snapshot.header.permission_mode,
            Some(AgentSessionPermissionMode::RequestApproval)
        );
        self.runtime.agents.get(&child).unwrap().unwrap()
    }

    async fn directory_command(
        &self,
        entry: &Arc<super::super::AgentEntry>,
        turn: &str,
        step: &str,
        filename: &str,
    ) {
        let settlement = self.runtime.tools.process_model_calls(entry, turn, step, &format!("request-{step}"),
            vec![file_call("run_terminal_command", &format!("command-{step}"),
                json!({ "command": format!("pwd -P > {filename}"), "explanation": "Read the actual current directory through the bound shell" }))]).await.unwrap();
        assert_eq!(settlement, ToolPipelineSettlement::Waiting);
        assert!(
            !self.root.path().join("work").join(filename).exists(),
            "command ran before approval"
        );
        self.runtime
            .tools
            .decide(
                entry,
                self.approval(&entry.session_id),
                AgentToolDecision::Approve,
            )
            .await
            .unwrap();
        self.wait_prompt();
        let actual = std::fs::read_to_string(self.root.path().join("work").join(filename)).unwrap();
        assert_eq!(
            actual.trim(),
            self.root
                .path()
                .join("work")
                .canonicalize()
                .unwrap()
                .to_str()
                .unwrap()
        );
        assert!(self.runtime.sessions.all_events(&entry.session_id).unwrap().iter().any(|event|
            matches!(&event.payload, super::super::AgentSessionEventPayload::ToolResult {
                call_id, status: AgentToolResultStatus::Completed, ..
            } if call_id == &format!("command-{step}"))));
    }
}

impl Drop for Scenario {
    fn drop(&mut self) {
        let _ = self.transport.close(TERMINAL);
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.control.take();
        if let Some(input) = self.input.take() {
            let _ = input.join();
        }
        if let Some(output) = self.output.take() {
            let _ = output.join();
        }
    }
}

fn file_call(name: &str, call_id: &str, arguments: serde_json::Value) -> ModelToolCall {
    ModelToolCall {
        name: name.into(),
        call_id: call_id.into(),
        provider_call_id: None,
        arguments,
    }
}

#[tokio::test]
async fn real_file_change_during_approval_settles_failure_and_continues_the_queue() {
    let scenario = Scenario::new(TerminalShellKind::Bash);
    let runtime = &scenario.runtime;
    let entry = scenario.root(
        "approval",
        AgentExecutionSurface::Direct,
        AgentSessionPermissionMode::RequestApproval,
    );
    let before = include_str!("../../../../../src/lib/README.md");
    let changed = include_str!("../../../../../src/lib/ai/approval-decision.ts");
    let path = scenario.root.path().join("work/review.txt");
    std::fs::write(&path, before).unwrap();
    scenario.start(&entry, "approval-turn", "approval-step");
    let calls = vec![
        file_call(
            "write_file",
            "write",
            json!({ "path": "review.txt", "content": changed, "precondition": { "sha256": hex::encode(Sha256::digest(before.as_bytes())) } }),
        ),
        file_call(
            "read_file",
            "read",
            json!({ "path": "review.txt", "encoding": "utf8" }),
        ),
    ];
    assert_eq!(
        runtime
            .tools
            .process_model_calls(
                &entry,
                "approval-turn",
                "approval-step",
                "approval-request",
                calls
            )
            .await
            .unwrap(),
        ToolPipelineSettlement::Waiting
    );
    let original_approval = scenario.approval("approval");
    // A real concurrent editor update invalidates the approved digest.
    std::fs::write(&path, changed).unwrap();
    runtime
        .tools
        .decide(
            &entry,
            original_approval.clone(),
            AgentToolDecision::Approve,
        )
        .await
        .unwrap();
    let following = scenario.approval("approval");
    assert_eq!(following.call_id, "read");
    runtime
        .tools
        .decide(&entry, following, AgentToolDecision::Approve)
        .await
        .unwrap();
    assert!(runtime
        .tools
        .decide(&entry, original_approval, AgentToolDecision::Reject)
        .await
        .is_err());
    let events = runtime.sessions.all_events("approval").unwrap();
    assert_eq!(events.iter().filter(|e| matches!(&e.payload, super::super::AgentSessionEventPayload::ToolResult { call_id, status: AgentToolResultStatus::Cancelled, summary, .. } if call_id == "write" && summary.contains("digest precondition"))).count(), 1);
    assert!(!events.iter().any(|e| matches!(&e.payload, super::super::AgentSessionEventPayload::ToolExecution { call_id, .. } if call_id == "write")));
    assert!(events.iter().any(|e| matches!(&e.payload, super::super::AgentSessionEventPayload::ToolResult { call_id, status: AgentToolResultStatus::Completed, .. } if call_id == "read")));
    assert_eq!(std::fs::read_to_string(path).unwrap(), changed);
    let reopened = AgentSessionStore::default();
    reopened
        .configure(scenario.root.path().join("state"))
        .unwrap();
    assert_ne!(
        reopened.snapshot("approval").unwrap().recovery.kind,
        super::super::AgentRecoveryCheckpointKind::WaitingApproval
    );
}

#[tokio::test]
async fn real_approval_storage_obstruction_keeps_the_decision_retryable() {
    let scenario = Scenario::new(TerminalShellKind::Bash);
    let runtime = &scenario.runtime;
    let entry = scenario.root(
        "storage",
        AgentExecutionSurface::Direct,
        AgentSessionPermissionMode::RequestApproval,
    );
    scenario.start(&entry, "storage-turn", "storage-step");
    let path = scenario.root.path().join("work/new.txt");
    runtime.tools.process_model_calls(&entry, "storage-turn", "storage-step", "storage-request", vec![file_call("write_file", "write", json!({ "path": "new.txt", "content": include_str!("../../../../../src/lib/README.md"), "precondition": { "mustNotExist": true } }))]).await.unwrap();
    std::fs::write(&path, include_str!("../../../../../src/lib/README.md")).unwrap();
    let log = scenario
        .root
        .path()
        .join("state/agent-runtime/sessions-v5/storage.jsonl");
    let saved = log.with_extension("saved");
    std::fs::rename(&log, &saved).unwrap();
    std::fs::create_dir(&log).unwrap();
    let approval = scenario.approval("storage");
    assert!(runtime
        .tools
        .decide(&entry, approval.clone(), AgentToolDecision::Approve)
        .await
        .is_err());
    std::fs::rename(&log, log.with_extension("obstruction")).unwrap();
    std::fs::rename(saved, log).unwrap();
    runtime
        .tools
        .decide(&entry, approval, AgentToolDecision::Reject)
        .await
        .unwrap();
    assert_eq!(entry.phase().unwrap(), AgentLifecyclePhase::Running);
    assert_ne!(
        runtime.session("storage").unwrap().recovery.kind,
        super::super::AgentRecoveryCheckpointKind::WaitingApproval
    );
}

async fn delegated_terminal_roundtrip(shell: TerminalShellKind) {
    let scenario = Scenario::new(shell);
    let runtime = &scenario.runtime;
    let parent = scenario.root(
        "parent",
        AgentExecutionSurface::BoundTerminal,
        AgentSessionPermissionMode::RequestApproval,
    );
    scenario.start(&parent, "parent-turn", "parent-step");
    let child = scenario.child("parent");
    scenario.start(&child, "child-turn", "child-step");
    let grandchild = scenario.child(&child.session_id);
    scenario.start(&grandchild, "grandchild-turn", "grandchild-step");
    assert_eq!(
        runtime.terminal_turn_owner(TERMINAL).unwrap().as_deref(),
        Some("parent")
    );
    assert!(runtime
        .native_engine
        .begin_terminal_turn(TERMINAL, "unrelated-agent")
        .unwrap_err()
        .starts_with("TERMINAL_LEASE_BUSY"));
    assert!(runtime
        .write_user_terminal_input(&scenario.transport, TERMINAL, "pwd\n".into())
        .unwrap_err()
        .starts_with("TERMINAL_INPUT_BLOCKED_BY_AGENT"));
    scenario
        .directory_command(
            &grandchild,
            "grandchild-turn",
            "grandchild-step",
            "grandchild-cwd.txt",
        )
        .await;
    super::super::driver::close_open_scope(&runtime.sessions, &grandchild, "completed").unwrap();
    assert_eq!(
        runtime.terminal_turn_owner(TERMINAL).unwrap().as_deref(),
        Some("parent")
    );
    scenario
        .directory_command(&child, "child-turn", "child-step", "child-cwd.txt")
        .await;
    super::super::driver::close_open_scope(&runtime.sessions, &child, "completed").unwrap();
    // A continuable child receives a fresh, scoped delegation on its next turn.
    scenario.start(&child, "child-next-turn", "child-next-step");
    scenario
        .directory_command(
            &child,
            "child-next-turn",
            "child-next-step",
            "child-next-cwd.txt",
        )
        .await;
    super::super::driver::close_open_scope(&runtime.sessions, &child, "completed").unwrap();
    scenario
        .directory_command(&parent, "parent-turn", "parent-step", "parent-cwd.txt")
        .await;
    assert_eq!(
        runtime.terminal_turn_owner(TERMINAL).unwrap().as_deref(),
        Some("parent")
    );
    super::super::driver::close_open_scope(&runtime.sessions, &parent, "completed").unwrap();
    assert_eq!(runtime.terminal_turn_owner(TERMINAL).unwrap(), None);
    assert!(!runtime.native_engine.has_terminal_lease(TERMINAL).unwrap());
}

#[tokio::test]
async fn real_bash_delegation_preserves_approval_exclusion_and_parent_continuation() {
    delegated_terminal_roundtrip(TerminalShellKind::Bash).await;
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn real_zsh_delegation_preserves_approval_exclusion_and_parent_continuation() {
    delegated_terminal_roundtrip(TerminalShellKind::Zsh).await;
}

#[tokio::test]
async fn real_child_terminal_takeover_blocks_the_entire_delegation_until_turn_end() {
    let scenario = Scenario::new(TerminalShellKind::Bash);
    let runtime = &scenario.runtime;
    let parent = scenario.root(
        "takeover-parent",
        AgentExecutionSurface::BoundTerminal,
        AgentSessionPermissionMode::RequestApproval,
    );
    scenario.start(&parent, "parent-turn", "parent-step");
    let child = scenario.child(&parent.session_id);
    scenario.start(&child, "child-turn", "child-step");
    assert!(runtime
        .interrupt(&child.session_id)
        .await
        .unwrap_err()
        .contains("requires a root Session"));
    let (send, receive) = std::sync::mpsc::channel();
    let acknowledger = Arc::downgrade(&runtime.native_engine);
    runtime
        .native_engine
        .set_terminal_lease_publisher(Arc::new(move |event| {
            if event.state == super::super::TerminalLeaseEventState::Acquired {
                acknowledger
                    .upgrade()
                    .expect("live scenario engine")
                    .acknowledge_terminal_lease_ready(
                        &event.session_id,
                        &event.agent_session_id,
                        &event.operation_id,
                        true,
                        true,
                        false,
                        false,
                        false,
                        true,
                    )
                    .unwrap();
                send.send(event.clone()).unwrap();
            }
        }))
        .unwrap();
    runtime.tools.process_model_calls(&child, "child-turn", "child-step", "takeover-request", vec![
        file_call("run_terminal_command", "takeover", json!({
            "command": ": > running; sleep 30", "explanation": "Exercise actual foreground cancellation and user takeover",
        }))
    ]).await.unwrap();
    let tools = runtime.tools.clone();
    let approval = scenario.approval(&child.session_id);
    let deciding = child.clone();
    let decision = tokio::spawn(async move {
        tools
            .decide(&deciding, approval, AgentToolDecision::Approve)
            .await
    });
    let marker = scenario.root.path().join("work/running");
    let deadline = Instant::now() + Duration::from_secs(5);
    while !marker.exists() {
        assert!(
            Instant::now() < deadline,
            "the real child command never started"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    scenario.wait_foreground_job();
    let lease = receive.recv_timeout(Duration::from_secs(1)).unwrap();
    assert_eq!(lease.agent_session_id, child.session_id);
    assert!(runtime
        .native_engine
        .takeover_terminal(
            &scenario.transport,
            TERMINAL,
            &child.session_id,
            &lease.operation_id
        )
        .unwrap());
    tokio::time::timeout(Duration::from_secs(5), decision)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    scenario.wait_prompt();
    for id in [&parent.session_id, &child.session_id] {
        assert!(runtime
            .native_engine
            .begin_terminal_turn(TERMINAL, id)
            .unwrap_err()
            .starts_with("TERMINAL_LEASE_TAKEN_OVER"));
    }
    assert!(runtime
        .native_engine
        .begin_delegated_terminal_turn(TERMINAL, "late-child", &[parent.session_id.clone()])
        .unwrap_err()
        .starts_with("TERMINAL_LEASE_TAKEN_OVER"));
    runtime
        .write_user_terminal_input(
            &scenario.transport,
            TERMINAL,
            "pwd -P > user-cwd.txt\n".into(),
        )
        .unwrap();
    let user_file = scenario.root.path().join("work/user-cwd.txt");
    let deadline = Instant::now() + Duration::from_secs(5);
    while !user_file.exists() {
        assert!(
            Instant::now() < deadline,
            "takeover did not restore real user input"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    scenario.wait_prompt();
    assert_eq!(
        std::fs::read_to_string(user_file).unwrap().trim(),
        scenario
            .root
            .path()
            .join("work")
            .canonicalize()
            .unwrap()
            .to_str()
            .unwrap()
    );
    let stopped = runtime.interrupt(&child.session_id).await.unwrap();
    assert_eq!(stopped.header.session_id, parent.session_id);
    assert_eq!(stopped.status, super::super::AgentSessionStatus::Idle);
    assert!(!stopped.ended);
    assert!(runtime.session(&child.session_id).unwrap().ended);
    assert_eq!(runtime.terminal_turn_owner(TERMINAL).unwrap(), None);
    runtime
        .native_engine
        .begin_terminal_turn(TERMINAL, &parent.session_id)
        .unwrap();
    runtime
        .native_engine
        .release_terminal_turn(&parent.session_id)
        .unwrap();
}

#[tokio::test]
async fn real_parent_stop_joins_the_approved_child_command_and_releases_the_terminal() {
    let scenario = Scenario::new(TerminalShellKind::Bash);
    let runtime = &scenario.runtime;
    let parent = scenario.root(
        "stop-parent",
        AgentExecutionSurface::BoundTerminal,
        AgentSessionPermissionMode::RequestApproval,
    );
    scenario.start(&parent, "parent-turn", "parent-step");
    let child = scenario.child(&parent.session_id);
    scenario.start(&child, "child-turn", "child-step");
    runtime.tools.process_model_calls(&child, "child-turn", "child-step", "stop-request", vec![
        file_call("run_terminal_command", "stopped-command", json!({
            "command": ": > running && sleep 30", "explanation": "Check that root cancellation stops the real child command",
        }))
    ]).await.unwrap();
    let tools = runtime.tools.clone();
    let approval = scenario.approval(&child.session_id);
    let deciding = child.clone();
    let decision = tokio::spawn(async move {
        tools
            .decide(&deciding, approval, AgentToolDecision::Approve)
            .await
    });
    let marker = scenario.root.path().join("work/running");
    let deadline = Instant::now() + Duration::from_secs(5);
    while !marker.exists() {
        assert!(
            Instant::now() < deadline,
            "approved child never reached the real shell"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    scenario.wait_foreground_job();
    let stopped = tokio::time::timeout(
        Duration::from_secs(5),
        runtime.interrupt(&parent.session_id),
    )
    .await
    .unwrap()
    .unwrap();
    tokio::time::timeout(Duration::from_secs(5), decision)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(stopped.status, super::super::AgentSessionStatus::Idle);
    assert!(!stopped.ended);
    assert!(runtime.session(&child.session_id).unwrap().ended);
    assert_eq!(runtime.terminal_turn_owner(TERMINAL).unwrap(), None);
    assert!(!runtime.native_engine.has_terminal_lease(TERMINAL).unwrap());
    assert!(runtime
        .sessions
        .all_events(&child.session_id)
        .unwrap()
        .iter()
        .any(
            |event| matches!(&event.payload, super::super::AgentSessionEventPayload::ToolResult {
            call_id, status: AgentToolResultStatus::Cancelled, ..
        } if call_id == "stopped-command")
        ));
    scenario.wait_prompt();
    runtime
        .write_user_terminal_input(&scenario.transport, TERMINAL, "pwd\n".into())
        .unwrap();
}
