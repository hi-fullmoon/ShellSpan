use super::*;
use crate::agent_runtime::{
    AgentAuthorizeCallRequestNative, AgentPermissionModeNative, AgentRequestNative,
    AgentToolResultNative, AgentToolResultStatusNative, AgentToolTargetNative,
    NativeExecutionContext, NativeToolEngine, NATIVE_TOOL_CONTRACT_VERSION,
};
use crate::models::{ManagedSession, SessionCommandSender, SessionIdentity, SessionTerminalKind};
use crate::terminal_vim_bridge::{
    BridgeFailure, EditAction, EditorCommand, EditorError, EditorKind, EditorReply, EditorSnapshot,
    EditorTarget, InsertPosition, ACTIVATE,
};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

const OWNER: &str = "test-owner:test-turn";

struct EditorAgent {
    engine: NativeToolEngine,
    sessions: SessionManager,
    keyboard: crossbeam_channel::Receiver<SessionCommand>,
    context: NativeExecutionContext,
    database: crate::db::Database,
    credentials: crate::keychain::CredentialManager,
    known_hosts: std::path::PathBuf,
    _root: tempfile::TempDir,
}

impl EditorAgent {
    fn start(terminal: &RemoteFixtureTerminal, bridge: &RemoteVimBridge, workspace: &str) -> Self {
        let root = tempfile::tempdir().unwrap();
        let connection = crate::execution::fixture::isolated_ssh_connection();
        let id = terminal.transport_id.clone();
        let (sender, keyboard) = crossbeam_channel::unbounded();
        let sessions = SessionManager::default();
        sessions
            .insert_ssh(
                id.clone(),
                ManagedSession {
                    sender: SessionCommandSender::Event(sender),
                    waker: None,
                    output_state_sender: None,
                    status: StatusEvent {
                        session_id: id.clone(),
                        status: SessionStatus::Connected,
                        message: None,
                    },
                    output_ready: Arc::new(AtomicBool::new(true)),
                    output_paused: Arc::new(AtomicBool::new(false)),
                    terminal_kind: SessionTerminalKind::Remote,
                    identity: SessionIdentity {
                        title: id.clone(),
                        host: connection.host.clone(),
                        port: connection.port,
                        username: connection.username.clone(),
                    },
                },
                None,
            )
            .unwrap();
        sessions.register_vim_bridge(&id, bridge.client()).unwrap();
        let engine = NativeToolEngine::with_terminal_broker(terminal.broker.clone());
        engine.begin_terminal_turn(&id, "editor-agent").unwrap();
        Self {
            engine,
            sessions,
            keyboard,
            context: NativeExecutionContext {
                #[cfg(windows)]
                windows_sandbox_required: false,
                turn_id: "editor-turn".into(),
                step_id: "editor-step".into(),
                request: AgentRequestNative {
                    contract_version: NATIVE_TOOL_CONTRACT_VERSION,
                    request_id: "editor-request".into(),
                    user_session_id: "editor-agent".into(),
                    task_id: "editor-task".into(),
                    goal: "Edit and save the current file buffer".into(),
                    success_criteria: vec!["Preserve existing unsaved edits".into()],
                    permission_mode: AgentPermissionModeNative::RequestApproval,
                    targets: vec![AgentToolTargetNative::Remote {
                        target_id: "editor-host".into(),
                        session_id: id,
                        profile_id: None,
                        host: connection.host.clone(),
                        port: connection.port,
                        username: connection.username.clone(),
                        root_path: Some(workspace.into()),
                        local_root: None,
                    }],
                },
            },
            database: crate::db::Database::open(&root.path().join("db.sqlite")).unwrap(),
            credentials: crate::keychain::CredentialManager::new(),
            known_hosts: terminal
                ._known_hosts
                .as_ref()
                .unwrap()
                .path()
                .join("known_hosts"),
            _root: root,
        }
    }

    fn run(
        &self,
        terminal: &mut RemoteFixtureTerminal,
        bridge: &mut RemoteVimBridge,
        name: &str,
        arguments: Value,
    ) -> AgentToolResultNative {
        thread::scope(|scope| {
            let worker = scope.spawn(move || {
                let prepared = self
                    .engine
                    .prepare_authorization(
                        self.context.clone(),
                        AgentAuthorizeCallRequestNative {
                            request_id: self.context.request.request_id.clone(),
                            call_id: format!("editor-{}", Uuid::new_v4().simple()),
                            tool_name: name.into(),
                            arguments,
                            target: self.context.request.targets[0].clone(),
                            ttl_ms: None,
                        },
                        &self.sessions,
                        &self.database,
                        &self.credentials,
                        &self.known_hosts,
                    )
                    .unwrap();
                assert!(prepared.requires_native_confirmation);
                assert!(self
                    .engine
                    .issue_prepared_authorization(&prepared, false)
                    .is_err());
                let grant = self
                    .engine
                    .issue_prepared_authorization(&prepared, true)
                    .unwrap();
                let mut call = prepared.call;
                call.capability_id = grant.capability_id;
                self.engine
                    .execute_tool(
                        &self.context,
                        call,
                        &self.sessions,
                        &self.database,
                        &self.credentials,
                        &self.known_hosts,
                        &CancellationToken::new(),
                        None,
                    )
                    .unwrap()
            });
            until(terminal, bridge, |_, _| worker.is_finished());
            worker.join().unwrap()
        })
    }

    fn user_types(&self, terminal: &mut RemoteFixtureTerminal, input: &str) {
        self.engine
            .write_user_terminal_input(&self.sessions, &terminal.transport_id, input.into())
            .unwrap();
        match self.keyboard.recv_timeout(Duration::from_secs(1)).unwrap() {
            SessionCommand::Write(text) => ui_input(terminal, &text),
            _ => panic!("the user's keys should remain ordinary PTY input"),
        }
    }
}

fn ui_input(terminal: &mut RemoteFixtureTerminal, input: &str) {
    write_all_nonblocking(
        &terminal.session,
        &mut terminal.shell_channel,
        input.as_bytes(),
    )
    .expect("deliver interactive input to the real editor");
}

fn launch_editor(terminal: &mut RemoteFixtureTerminal, command: &str) {
    use crate::terminal_broker::{TerminalBrokerInputSource, TerminalInputKind};
    let broker = terminal.broker.clone();
    let id = terminal.transport_id.clone();
    for (input, kind) in [
        (command, TerminalInputKind::Text),
        ("\r", TerminalInputKind::Key),
    ] {
        broker
            .admit_terminal_input(
                &id,
                TerminalBrokerInputSource::User,
                kind,
                input.as_bytes(),
                || {
                    ui_input(terminal, input);
                    Ok(())
                },
            )
            .unwrap();
    }
}

fn pump_editor(terminal: &mut RemoteFixtureTerminal, bridge: &mut RemoteVimBridge) {
    if let Some(frame) = bridge.next_write() {
        let mut queue = VecDeque::from([SshWrite::Data {
            payload: SshPayload::Vim(frame),
            offset: 0,
        }]);
        let deadline = Instant::now() + Duration::from_secs(3);
        while !queue.is_empty() {
            match advance_ssh_write_queue(
                &mut queue,
                &mut terminal.shell_channel,
                None,
                None,
                Some(&mut bridge.channel),
            ) {
                Ok(_) => {}
                Err(error) if is_retryable_channel_error_kind(error.kind()) => {
                    assert!(
                        Instant::now() < deadline,
                        "editor packet did not reach its SSH channel"
                    );
                    thread::sleep(Duration::from_millis(5));
                }
                Err(error) => panic!("failed to send real SSH editor request: {error}"),
            }
        }
    }
    terminal.pump_once();
    if bridge.drain().expect("read the private SSH editor relay") {
        terminal
            .broker
            .set_vim_attached(&terminal.transport_id, bridge.attached())
            .unwrap();
    }
}

fn until(
    terminal: &mut RemoteFixtureTerminal,
    bridge: &mut RemoteVimBridge,
    mut check: impl FnMut(&RemoteFixtureTerminal, &RemoteVimBridge) -> bool,
) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !check(terminal, bridge) {
        pump_editor(terminal, bridge);
        assert!(
            Instant::now() < deadline,
            "editor condition not observed; screen tail {:?}",
            String::from_utf8_lossy(
                &terminal.display[terminal.display.len().saturating_sub(1100)..]
            )
        );
        thread::sleep(Duration::from_millis(10));
    }
}

fn exchange(
    terminal: &mut RemoteFixtureTerminal,
    bridge: &mut RemoteVimBridge,
    command: EditorCommand,
) -> Result<(String, EditorKind, EditorReply), BridgeFailure> {
    let pending = bridge.client().enqueue(command)?;
    let id = pending.id.clone();
    thread::scope(|scope| {
        let waiter = scope.spawn(move || pending.wait(&CancellationToken::new()));
        until(terminal, bridge, |_, _| waiter.is_finished());
        waiter
            .join()
            .unwrap()
            .map(|(kind, reply)| (id, kind, reply))
    })
}

fn inspect(
    terminal: &mut RemoteFixtureTerminal,
    bridge: &mut RemoteVimBridge,
    root: &str,
) -> EditorSnapshot {
    let (_, _, reply) = exchange(
        terminal,
        bridge,
        EditorCommand::Inspect {
            root: root.into(),
            owner: OWNER.into(),
        },
    )
    .unwrap();
    match reply {
        EditorReply::Observed { snapshot } => snapshot,
        reply => panic!("expected a live editor snapshot, received {reply:?}"),
    }
}

fn prepare(
    terminal: &mut RemoteFixtureTerminal,
    bridge: &mut RemoteVimBridge,
    root: &str,
    snapshot: EditorSnapshot,
    action: EditAction,
) -> String {
    let (id, _, reply) = exchange(
        terminal,
        bridge,
        EditorCommand::Prepare {
            root: root.into(),
            owner: OWNER.into(),
            target: EditorTarget {
                snapshot_id: snapshot.id,
                path: snapshot.path,
            },
            action,
        },
    )
    .unwrap();
    assert!(
        matches!(reply, EditorReply::Prepared),
        "unexpected editor prepare result {reply:?}"
    );
    id
}

fn commit(
    terminal: &mut RemoteFixtureTerminal,
    bridge: &mut RemoteVimBridge,
    prepared_id: String,
) -> EditorReply {
    exchange(terminal, bridge, EditorCommand::Commit { prepared_id })
        .unwrap()
        .2
}

fn disk(terminal: &RemoteFixtureTerminal, path: &str) -> String {
    terminal.session.set_blocking(true);
    let mut value = String::new();
    terminal
        .session
        .sftp()
        .unwrap()
        .open(Path::new(path))
        .unwrap()
        .read_to_string(&mut value)
        .unwrap();
    terminal.session.set_blocking(false);
    value
}

fn editor_command(
    terminal: &mut RemoteFixtureTerminal,
    bridge: &mut RemoteVimBridge,
    command: &str,
) {
    let marker = format!("editor-ready-{:08x}", Uuid::new_v4().as_fields().0);
    let mut parser = vt100::Parser::new(30, 100, 0);
    let mut consumed = 0;
    ui_input(terminal, &format!("{command}\r:echo '{marker}'\r"));
    until(terminal, bridge, |terminal, _| {
        parser.process(&terminal.display[consumed..]);
        consumed = terminal.display.len();
        parser
            .screen()
            .contents()
            .lines()
            .any(|line| line == marker)
    });
}

fn save_active(
    terminal: &mut RemoteFixtureTerminal,
    bridge: &mut RemoteVimBridge,
    root: &str,
) -> EditorReply {
    let observed = inspect(terminal, bridge, root);
    let prepared = prepare(terminal, bridge, root, observed, EditAction::Save);
    commit(terminal, bridge, prepared)
}

#[test]
#[ignore = "requires Linux with real Vim and Neovim under the isolated tests/ssh-e2e SSH service"]
fn isolated_ssh_vim_bridge_edits_and_verifies_both_editors() {
    for (editor, launch) in [
        ("vim", "vim -Nu NONE -i NONE -n"),
        ("nvim", "nvim --clean -i NONE -n"),
    ] {
        let broker = TerminalSessionBroker::phase4_enabled_for_test(4096);
        let (mut terminal, bridge) = RemoteFixtureTerminal::connect_with_vim_bridge(
            "shellspan",
            "editor-terminal",
            None,
            broker,
            true,
        );
        let mut bridge = bridge.unwrap();
        let root = format!("/tmp/shellspan-edit-test-{}", Uuid::new_v4().simple());
        let doc = format!("{root}/file.txt");
        terminal.execute_user_command(&format!(
            "mkdir -- {root} && printf 'disk-original\\n' > {doc}"
        ));
        assert!(matches!(
            exchange(
                &mut terminal,
                &mut bridge,
                EditorCommand::Inspect {
                    root: root.clone(),
                    owner: OWNER.into()
                }
            ),
            Err(BridgeFailure::NotAttached)
        ));
        launch_editor(&mut terminal, &format!("{launch} {doc}"));
        until(&mut terminal, &mut bridge, |terminal, _| {
            terminal
                .display
                .windows(8)
                .any(|bytes| bytes == b"file.txt")
                && terminal
                    .display
                    .windows(13)
                    .any(|bytes| bytes == b"disk-original")
        });
        ui_input(&mut terminal, &format!("{ACTIVATE}\r"));
        until(&mut terminal, &mut bridge, |_, bridge| bridge.attached());
        ui_input(&mut terminal, "GoUSER-DRAFT\x1b:echo 'draft-ready'\r");
        until(&mut terminal, &mut bridge, |terminal, _| {
            String::from_utf8_lossy(&terminal.display)
                .matches("draft-ready")
                .count()
                >= 2
        });
        let agent = EditorAgent::start(&terminal, &bridge, &root);
        let response = agent.run(
            &mut terminal,
            &mut bridge,
            crate::terminal_vim_bridge::INSPECT,
            json!({}),
        );
        assert_eq!(response.status, AgentToolResultStatusNative::Completed);
        let snapshot: EditorSnapshot =
            serde_json::from_value(response.data.unwrap()["snapshot"].clone()).unwrap();
        assert_eq!(snapshot.path, doc);
        assert!(snapshot.modified);
        assert_eq!(snapshot.line_count, 2);
        let text = "夜坐\n云生海角暮。\n:write\n";
        let response = agent.run(
            &mut terminal,
            &mut bridge,
            crate::terminal_vim_bridge::INSERT,
            json!({ "snapshotId": snapshot.id, "path": doc, "position": "start", "text": text }),
        );
        assert_eq!(
            response.status,
            AgentToolResultStatusNative::Completed,
            "{editor}: {response:?}"
        );
        let inserted: EditorSnapshot =
            serde_json::from_value(response.data.unwrap()["snapshot"].clone()).unwrap();
        assert_eq!(inserted.line_count, 5);
        assert_eq!(disk(&terminal, &doc), "disk-original\n");
        agent.user_types(&mut terminal, "u:echo 'undo-ready'\r");
        until(&mut terminal, &mut bridge, |terminal, _| {
            String::from_utf8_lossy(&terminal.display)
                .matches("undo-ready")
                .count()
                >= 2
        });
        let response = agent.run(
            &mut terminal,
            &mut bridge,
            crate::terminal_vim_bridge::INSPECT,
            json!({}),
        );
        assert_eq!(
            response.status,
            AgentToolResultStatusNative::Completed,
            "{editor}: {response:?}"
        );
        let undone: EditorSnapshot =
            serde_json::from_value(response.data.unwrap()["snapshot"].clone()).unwrap();
        assert!(undone.modified);
        assert_eq!(undone.line_count, 2);

        let response = agent.run(
            &mut terminal,
            &mut bridge,
            crate::terminal_vim_bridge::INSERT,
            json!({ "snapshotId": undone.id, "path": doc, "position": "start", "text": text }),
        );
        assert_eq!(
            response.status,
            AgentToolResultStatusNative::Completed,
            "{editor}: {response:?}"
        );
        let response = agent.run(
            &mut terminal,
            &mut bridge,
            crate::terminal_vim_bridge::SAVE,
            json!({ "snapshotId": response.data.unwrap()["snapshot"]["id"], "path": doc }),
        );
        assert_eq!(
            response.status,
            AgentToolResultStatusNative::Completed,
            "{editor}: {response:?}"
        );
        let data = response.data.unwrap();
        assert_eq!(data["outcome"], "saved");
        assert_eq!(data["snapshot"]["modified"], false);
        agent.engine.release_terminal_turn("editor-agent").unwrap();
        assert_eq!(
            disk(&terminal, &doc),
            format!("{text}disk-original\nUSER-DRAFT\n")
        );

        let saved = inspect(&mut terminal, &mut bridge, &root);
        let baseline_tick = saved.changed_tick;
        let prepared_id = prepare(
            &mut terminal,
            &mut bridge,
            &root,
            saved,
            EditAction::Insert {
                position: InsertPosition::End,
                text: "must not be sent".into(),
            },
        );
        let cancellation = CancellationToken::new();
        let pending = bridge
            .client()
            .enqueue(EditorCommand::Commit { prepared_id })
            .unwrap();
        cancellation.cancel();
        assert!(matches!(
            pending.wait(&cancellation),
            Err(BridgeFailure::Cancelled)
        ));
        pump_editor(&mut terminal, &mut bridge);
        let saved = inspect(&mut terminal, &mut bridge, &root);
        assert_eq!(saved.changed_tick, baseline_tick);

        let prepared = prepare(
            &mut terminal,
            &mut bridge,
            &root,
            saved,
            EditAction::Insert {
                position: InsertPosition::End,
                text: "late".into(),
            },
        );
        ui_input(&mut terminal, "GoUSER-TAKEOVER\x1b:echo 'takeover-ready'\r");
        until(&mut terminal, &mut bridge, |terminal, _| {
            String::from_utf8_lossy(&terminal.display)
                .matches("takeover-ready")
                .count()
                >= 2
        });
        assert!(matches!(
            commit(&mut terminal, &mut bridge, prepared),
            EditorReply::Rejected {
                code: EditorError::SnapshotChanged
            }
        ));

        ui_input(
            &mut terminal,
            ":autocmd BufWriteCmd <buffer> setlocal nomodified\r:echo 'hook-ready'\r",
        );
        until(&mut terminal, &mut bridge, |terminal, _| {
            String::from_utf8_lossy(&terminal.display)
                .matches("hook-ready")
                .count()
                >= 2
        });
        let modified = inspect(&mut terminal, &mut bridge, &root);
        let prepared = prepare(
            &mut terminal,
            &mut bridge,
            &root,
            modified,
            EditAction::Save,
        );
        assert!(matches!(
            commit(&mut terminal, &mut bridge, prepared),
            EditorReply::Uncertain {
                code: EditorError::SaveUnverified
            }
        ));
        assert_eq!(
            disk(&terminal, &doc),
            format!("{text}disk-original\nUSER-DRAFT\n")
        );

        let after_hook = inspect(&mut terminal, &mut bridge, &root);
        let prepared = prepare(
            &mut terminal,
            &mut bridge,
            &root,
            after_hook,
            EditAction::Save,
        );
        terminal.session.set_blocking(true);
        terminal
            .session
            .sftp()
            .unwrap()
            .create(Path::new(&doc))
            .unwrap()
            .write_all(b"external file edit\n")
            .unwrap();
        terminal.session.set_blocking(false);
        assert!(matches!(
            commit(&mut terminal, &mut bridge, prepared),
            EditorReply::Rejected {
                code: EditorError::DiskChanged
            }
        ));
        assert_eq!(disk(&terminal, &doc), "external file edit\n");

        ui_input(&mut terminal, ":qa!\r");
        until(&mut terminal, &mut bridge, |terminal, bridge| {
            !bridge.attached()
                && terminal
                    .broker
                    .snapshot(Some(&terminal.transport_id))
                    .unwrap()
                    .session
                    .unwrap()
                    .prompt_ready
        });
        terminal.execute_user_command(&format!("rm -- {doc} && rmdir -- {root}"));
        terminal.session.set_blocking(true);
        bridge.channel.send_eof().unwrap();
        bridge.channel.wait_eof().unwrap();
        bridge.channel.wait_close().unwrap();
        terminal.session.set_blocking(false);
    }
}

#[test]
#[ignore = "requires Linux with real Vim and Neovim under the isolated tests/ssh-e2e SSH service"]
fn isolated_ssh_vim_bridge_guards_disk_versions_and_resumes() {
    for (editor, launch) in [
        ("vim", "vim -Nu NONE -N -i NONE -n"),
        ("nvim", "nvim --clean -i NONE -n"),
    ] {
        let broker = TerminalSessionBroker::phase4_enabled_for_test(4096);
        let (mut terminal, bridge) = RemoteFixtureTerminal::connect_with_vim_bridge(
            "shellspan",
            "editor-guards",
            None,
            broker,
            true,
        );
        let mut bridge = bridge.unwrap();
        let parent = format!("/tmp/shellspan-editor-guards-{}", Uuid::new_v4().simple());
        let root = format!("{parent}/work");
        let alias = format!("{parent}/outside.txt");
        terminal.execute_user_command(&format!(
            "mkdir -p -- {root} && cd -- {root} && printf 'before\\n' > draft.txt && \
             printf 'before\\n' > tracked.txt && touch -t 202401010000.00 tracked.txt && \
             printf 'linked\\n' > linked.txt && \
             : > empty.txt && printf '\\n' > blank.txt && printf '\\r\\n' > crlf.txt"
        ));
        launch_editor(&mut terminal, &format!("{launch} draft.txt"));
        until(&mut terminal, &mut bridge, |terminal, _| {
            String::from_utf8_lossy(&terminal.display).contains("draft.txt")
        });
        editor_command(
            &mut terminal,
            &mut bridge,
            ":call setline(1, 'existing draft')",
        );
        editor_command(&mut terminal, &mut bridge, ACTIVATE);
        until(&mut terminal, &mut bridge, |_, bridge| bridge.attached());
        assert!(matches!(
            save_active(&mut terminal, &mut bridge, &root),
            EditorReply::Rejected {
                code: EditorError::DiskBaselineUnavailable
            }
        ));
        assert_eq!(disk(&terminal, &format!("{root}/draft.txt")), "before\n");

        editor_command(&mut terminal, &mut bridge, ":write");
        editor_command(
            &mut terminal,
            &mut bridge,
            ":call setline(1, 'after manual save')",
        );
        assert!(matches!(
            save_active(&mut terminal, &mut bridge, &root),
            EditorReply::Saved { .. }
        ));
        assert_eq!(
            disk(&terminal, &format!("{root}/draft.txt")),
            "after manual save\n"
        );

        editor_command(&mut terminal, &mut bridge, ":edit tracked.txt");
        editor_command(
            &mut terminal,
            &mut bridge,
            ":call setline(1, 'tracked draft')",
        );
        terminal.session.set_blocking(true);
        // The other writer changes the contents before the first Agent inspection
        // while retaining both the length and the exact original timestamp.
        run_ssh_setup_command(
            &terminal.session,
            &format!(
            "printf 'remote\\n' > {root}/tracked.txt && touch -t 202401010000.00 {root}/tracked.txt"
        ),
        )
        .unwrap();
        terminal.session.set_blocking(false);
        assert!(matches!(
            save_active(&mut terminal, &mut bridge, &root),
            EditorReply::Rejected {
                code: EditorError::DiskChanged
            }
        ));
        assert_eq!(disk(&terminal, &format!("{root}/tracked.txt")), "remote\n");

        editor_command(&mut terminal, &mut bridge, ":edit! linked.txt");
        editor_command(
            &mut terminal,
            &mut bridge,
            ":call setline(1, 'linked draft')",
        );
        let observed = inspect(&mut terminal, &mut bridge, &root);
        let prepared = prepare(
            &mut terminal,
            &mut bridge,
            &root,
            observed,
            EditAction::Save,
        );
        terminal.session.set_blocking(true);
        run_ssh_setup_command(
            &terminal.session,
            &format!("ln -- {root}/linked.txt {alias}"),
        )
        .unwrap();
        terminal.session.set_blocking(false);
        assert!(matches!(
            commit(&mut terminal, &mut bridge, prepared),
            EditorReply::Rejected {
                code: EditorError::MultipleHardLinks
            }
        ));
        assert_eq!(disk(&terminal, &format!("{root}/linked.txt")), "linked\n");
        assert_eq!(disk(&terminal, &alias), "linked\n");

        for (file, bytes) in [("empty.txt", ""), ("blank.txt", "\n"), ("crlf.txt", "\r\n")] {
            editor_command(&mut terminal, &mut bridge, &format!(":edit! {file}"));
            let result = save_active(&mut terminal, &mut bridge, &root);
            assert!(
                matches!(result, EditorReply::Saved { .. }),
                "{editor} {file}: {result:?}"
            );
            assert_eq!(disk(&terminal, &format!("{root}/{file}")), bytes);
        }

        if editor == "vim" {
            let observed = inspect(&mut terminal, &mut bridge, &root);
            let prepared = prepare(
                &mut terminal,
                &mut bridge,
                &root,
                observed,
                EditAction::Insert {
                    position: InsertPosition::Start,
                    text: "must not survive suspension".into(),
                },
            );
            ui_input(&mut terminal, "\x1a");
            until(&mut terminal, &mut bridge, |terminal, bridge| {
                !bridge.attached()
                    && terminal
                        .broker
                        .snapshot(Some(&terminal.transport_id))
                        .unwrap()
                        .session
                        .unwrap()
                        .prompt_ready
            });
            launch_editor(&mut terminal, "fg");
            until(&mut terminal, &mut bridge, |terminal, bridge| {
                bridge.attached()
                    && terminal
                        .broker
                        .snapshot(Some(&terminal.transport_id))
                        .unwrap()
                        .session
                        .unwrap()
                        .input_observation
                        .foreground_handoff_active
            });
            let agent = EditorAgent::start(&terminal, &bridge, &root);
            agent.user_types(&mut terminal, "\x1b");
            assert!(matches!(
                commit(&mut terminal, &mut bridge, prepared),
                EditorReply::Rejected {
                    code: EditorError::OperationExpired
                }
            ));
            assert_eq!(disk(&terminal, &format!("{root}/crlf.txt")), "\r\n");
            agent.engine.release_terminal_turn("editor-agent").unwrap();
        }

        // Unsaved changes in any buffer must reject close_vim_editor and preserve the editor.
        let dirty_observed = inspect(&mut terminal, &mut bridge, &root);
        let dirty_insert = prepare(
            &mut terminal,
            &mut bridge,
            &root,
            dirty_observed,
            EditAction::Insert {
                position: InsertPosition::End,
                text: "unsaved close guard".into(),
            },
        );
        let EditorReply::Inserted {
            snapshot: dirty_snapshot,
        } = commit(&mut terminal, &mut bridge, dirty_insert)
        else {
            panic!("{editor} expected dirty insertion before close guard");
        };
        let (_, _, rejected_close) = exchange(
            &mut terminal,
            &mut bridge,
            EditorCommand::Prepare {
                root: root.clone(),
                owner: OWNER.into(),
                target: EditorTarget {
                    snapshot_id: dirty_snapshot.id,
                    path: dirty_snapshot.path,
                },
                action: EditAction::Close,
            },
        )
        .unwrap();
        assert!(
            matches!(
                rejected_close,
                EditorReply::Rejected {
                    code: EditorError::UnsavedChanges
                }
            ),
            "{editor} close with unsaved buffer: {rejected_close:?}"
        );
        assert!(bridge.attached(), "{editor} must stay open when unsaved");

        // Reload cleanly, then close through the bridge and verify detach + prompt return.
        editor_command(&mut terminal, &mut bridge, ":edit!");
        let clean_observed = inspect(&mut terminal, &mut bridge, &root);
        let clean_close = prepare(
            &mut terminal,
            &mut bridge,
            &root,
            clean_observed,
            EditAction::Close,
        );
        let closed = commit(&mut terminal, &mut bridge, clean_close);
        assert!(
            matches!(closed, EditorReply::Closed { .. }),
            "{editor} clean close: {closed:?}"
        );
        until(&mut terminal, &mut bridge, |terminal, bridge| {
            !bridge.attached()
                && terminal
                    .broker
                    .snapshot(Some(&terminal.transport_id))
                    .unwrap()
                    .session
                    .unwrap()
                    .prompt_ready
        });
        terminal.execute_user_command(&format!(
            "cd /tmp && rm -- {root}/*.txt {alias} && rmdir -- {root} {parent}"
        ));
        terminal.session.set_blocking(true);
        bridge.channel.send_eof().unwrap();
        bridge.channel.wait_eof().unwrap();
        bridge.channel.wait_close().unwrap();
        terminal.session.set_blocking(false);
    }
}
