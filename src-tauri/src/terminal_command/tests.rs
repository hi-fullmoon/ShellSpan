use super::{journal::SubmissionJournal, protocol::*, state::*};
use crate::terminal_broker::TerminalCommandRequestedSettlement;
use std::time::Duration;

#[test]
fn experimental_profile_is_outside_the_production_catalogue() {
    assert!(native_profile_versions(VERIFIED_PROFILE).is_none());
    assert_eq!(
        native_profile_versions("gnu-bash-5.3-readline-8.3.6-macos-arm64-native"),
        Some(("5.3", "8.3.6", 0x0803))
    );
    assert_eq!(
        native_profile_versions("gnu-bash-5.3-readline-8.3.6-linux-aarch64-glibc-2.36-native"),
        Some(("5.3", "8.3.6", 0x0803))
    );
}

#[test]
fn x86_64_ssh_only_admits_the_fixed_bash_readline_pair() {
    assert_eq!(
        native_profile_versions("gnu-bash-5.3-readline-8.3.6-linux-x86_64-glibc-2.28-native"),
        Some(("5.3", "8.3.6", 0x0803))
    );
    for profile in [
        "gnu-bash-4.1-readline-6.0-linux-x86_64-glibc-2.28-native",
        "gnu-bash-4.4-readline-7.0-linux-x86_64-glibc-2.28-native",
        "gnu-bash-5.3-readline-8.3.6-linux-x86_64-musl-native",
        "gnu-bash-5.3-readline-8.3.5-linux-x86_64-glibc-2.28-native",
        "gnu-bash-5.3-readline-8.3.6-linux-x86_64-glibc-2.36-native",
    ] {
        assert_eq!(native_profile_versions(profile), None, "{profile}");
    }
}

#[test]
fn windows_editor_binding_requires_the_updated_exact_host_and_artifacts() {
    use super::registration::VerifiedNativeProfile;
    use sha2::{Digest, Sha256};

    let directory = tempfile::tempdir().unwrap();
    let module = directory.path().join("provider.dll");
    std::fs::write(&module, b"binding unit fixture").unwrap();
    let module_sha = hex::encode(Sha256::digest(std::fs::read(&module).unwrap()));
    let shell_sha = "1".repeat(64);
    let mut profile = PeerProfile {
        shell: ShellFamily::PowerShell7,
        shell_version: Some("7.6.9".into()),
        editor: EditorFamily::PsReadLine,
        editor_version: Some("2.4.5".into()),
        editor_numeric_version: 20405,
        adapter_version: "1".into(),
        verified_profile_id: Some(super::registration::POWERSHELL7_NATIVE_PROFILE.into()),
    };
    let verify = |profile: &PeerProfile, actual_shell: &str| {
        VerifiedNativeProfile::verify_editor(
            profile,
            &shell_sha,
            actual_shell,
            &module,
            &module_sha,
        )
    };
    assert!(verify(&profile, &shell_sha).is_ok());
    let mut previous_provider = profile.clone();
    previous_provider.verified_profile_id = profile
        .verified_profile_id
        .as_ref()
        .map(|id| id.replace("shellspan6", "shellspan5"));
    assert!(verify(&previous_provider, &shell_sha).is_err());
    let mut stale_provider = profile.clone();
    stale_provider.verified_profile_id = profile
        .verified_profile_id
        .as_ref()
        .map(|id| id.replace("shellspan6", "shellspan1"));
    assert!(verify(&stale_provider, &shell_sha).is_err());
    #[cfg(windows)]
    {
        let verified = verify(&profile, &shell_sha).unwrap();
        assert!(!verified.display_origin_channel());
        assert_eq!(verified.display_binding().unicode_version, None);
        let runtime = super::windows_conpty::prepare(directory.path()).unwrap();
        let verified = verified.bind_private_conpty(&runtime).unwrap();
        assert!(verified.display_origin_channel());
        let binding = verified.display_binding();
        assert_eq!(
            binding.unicode_version,
            Some(DisplayUnicodeVersion::Graphemes15)
        );
        assert_eq!(binding.unicode_scope, Some(DisplayUnicodeScope::Session));
        assert_eq!(binding.owned_reflow_cursor_line, Some(false));
        std::fs::write(
            runtime.parent().unwrap().join("x64/OpenConsole.exe"),
            b"tampered",
        )
        .unwrap();
        assert!(verify(&profile, &shell_sha)
            .unwrap()
            .bind_private_conpty(&runtime)
            .is_err());
    }
    assert!(verify(&profile, &"2".repeat(64)).is_err());
    profile.shell_version = Some("7.6.8".into());
    assert!(verify(&profile, &shell_sha).is_err());
    profile.shell_version = Some("7.6.9".into());
    profile.verified_profile_id =
        Some("powershell-7.6.9-psreadline-2.4.5-windows-x64-native".into());
    assert!(verify(&profile, &shell_sha).is_err());
    let mut retired = profile.clone();
    retired.shell = ShellFamily::WindowsPowerShell;
    retired.shell_version = Some("5.1.26100.9818".into());
    retired.verified_profile_id = Some(
        "windows-powershell-5.1.26100.9818-psreadline-2.4.5-shellspan6-conpty1.25.260930003-graphemes-windows-x64-native".into(),
    );
    assert!(verify(&retired, &shell_sha).is_err());
    assert!(super::registration::shell_family(
        crate::terminal_integration::TerminalShellKind::WindowsPowerShell
    )
    .is_err());
    profile.verified_profile_id = Some(super::registration::POWERSHELL7_NATIVE_PROFILE.into());
    std::fs::write(&module, b"modified binding fixture").unwrap();
    assert!(verify(&profile, &shell_sha).is_err());
}

fn identity() -> Identity {
    Identity {
        terminal_session_id: "terminal:one".into(),
        terminal_generation: 1,
        lease_id: "lease_one".into(),
        lease_generation: 2,
        agent_session_id: "agent.one".into(),
        task_id: "task-one".into(),
        operation_id: "call:operation-1".into(),
        command_id: "command-one".into(),
        source_revision: 1,
    }
}
fn envelope(payload: Payload) -> Envelope {
    Envelope {
        protocol: PROTOCOL.into(),
        identity: identity(),
        request_id: "request:one".into(),
        payload,
    }
}

#[test]
fn journal_concurrent_connections_preserve_every_fence_and_settlement() {
    let directory = tempfile::tempdir().unwrap();
    let journal = SubmissionJournal::unconfigured();
    journal.configure(directory.path()).unwrap();
    let start = std::sync::Arc::new(std::sync::Barrier::new(8));
    let workers: Vec<_> = (0..8)
        .map(|worker| {
            let journal = journal.clone();
            let start = start.clone();
            std::thread::spawn(move || {
                start.wait();
                for index in 0..100 {
                    let mut id = identity();
                    id.agent_session_id = format!("concurrent-agent-{worker}");
                    id.operation_id = format!("concurrent-operation-{index}");
                    id.command_id = format!("concurrent-command-{worker}-{index}");
                    journal
                        .ensure_new_operation(&id.agent_session_id, &id.task_id, &id.operation_id)
                        .unwrap();
                    journal.record(&id).unwrap();
                    assert!(journal
                        .unresolved_for_agent(Some(&id.agent_session_id))
                        .unwrap()
                        .iter()
                        .any(|intent| intent.identity == id));
                    journal.settle(&id).unwrap();
                    assert_eq!(
                        journal.record(&id).unwrap_err(),
                        "TERMINAL_SUBMISSION_ALREADY_RECORDED"
                    );
                }
            })
        })
        .collect();
    for worker in workers {
        worker.join().unwrap();
    }
    assert!(journal.unresolved().unwrap().is_empty());
    drop(journal);
    let restarted = SubmissionJournal::unconfigured();
    restarted.configure(directory.path()).unwrap();
    assert!(restarted.unresolved().unwrap().is_empty());
    let connection = rusqlite::Connection::open(
        directory
            .path()
            .join("terminal-submissions/intentions.sqlite"),
    )
    .unwrap();
    let counts: (i64, i64) = connection
        .query_row("SELECT count(*),sum(settled) FROM submissions", [], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .unwrap();
    assert_eq!(counts, (800, 800));
}

#[test]
fn state_rejects_submission_before_full_confirmation_and_deduplicates_stops() {
    let mut state = CommandLifecycle::default();
    assert!(state.apply(CommandEvent::AttemptSubmission).is_err());
    state.apply(CommandEvent::Ready).unwrap();
    assert!(state.apply(CommandEvent::AttemptSubmission).is_err());
    state.apply(CommandEvent::BeginInput).unwrap();
    assert!(state.apply(CommandEvent::AttemptSubmission).is_err());
    state.apply(CommandEvent::ConfirmInput).unwrap();
    state.apply(CommandEvent::AttemptSubmission).unwrap();
    assert!(state.may_have_submitted());
    assert!(state.apply(CommandEvent::AttemptSubmission).is_err());
    state.apply(CommandEvent::Started).unwrap();
    state
        .apply(CommandEvent::RequestCancel(
            TerminalCommandRequestedSettlement::Cancelled,
        ))
        .unwrap();
    assert_eq!(
        state
            .apply(CommandEvent::RequestCancel(
                TerminalCommandRequestedSettlement::TakenOver
            ))
            .unwrap(),
        Transition::Idempotent
    );
    assert!(state.apply(CommandEvent::DraftCleared).is_err());
    state.apply(CommandEvent::Settled).unwrap();
    assert_eq!(state.phase(), CommandPhase::Cancelled);
    assert_eq!(
        state.apply(CommandEvent::Settled).unwrap(),
        Transition::Idempotent
    );
}

#[test]
fn codec_accepts_large_coalesced_frames_and_bounds_each_partial_frame() {
    // Pure wire tests, not native receipts. Each individual Prepare is legal;
    // the coalesced read and the cross-read tail exceed one frame's limit.
    let source = "界".repeat(2700);
    let plan = format!("{}{}", source, "x".repeat(20000));
    let digest = sha(&source);
    let request = envelope(Payload::PrepareInput {
        job: None,
        source,
        source_digest: digest.clone(),
        plan: plan.clone(),
        plan_digest: bound_plan_digest(&digest, &plan),
        budget_ms: 5000,
        reduced_motion: true,
    });
    let encoded = request.encode().unwrap();
    assert!(encoded.len() > 30000);
    let mut joined = Vec::new();
    for _ in 0..6 {
        joined.extend_from_slice(&encoded);
    }
    assert!(joined.len() > MAX_MESSAGE_BYTES);
    let mut decoder = Decoder::default();
    let messages = decoder.push(&joined).unwrap();
    assert_eq!(messages.len(), 6);
    for message in messages {
        let decoded = message
            .into_operation()
            .expect("Prepare must remain an operation frame");
        assert_eq!(
            serde_json::to_value(decoded).unwrap(),
            serde_json::to_value(&request).unwrap()
        );
    }
    decoder.finish().unwrap();
    let mut decoder = Decoder::default();
    assert!(decoder
        .push(&encoded[..encoded.len() - 3])
        .unwrap()
        .is_empty());
    let mut next = encoded[encoded.len() - 3..].to_vec();
    next.extend_from_slice(&joined);
    let messages = decoder.push(&next).unwrap();
    assert_eq!(messages.len(), 7);
    for message in messages {
        let decoded = message
            .into_operation()
            .expect("Split/coalesced Prepare changed frame kind");
        assert_eq!(
            serde_json::to_value(decoded).unwrap(),
            serde_json::to_value(&request).unwrap()
        );
    }
    decoder.finish().unwrap();
    let mut decoder = Decoder::default();
    assert!(decoder.push(&vec![b'x'; MAX_MESSAGE_BYTES + 1]).is_err());
    let mut decoder = Decoder::default();
    decoder.push(&encoded[..encoded.len() - 1]).unwrap();
    assert_eq!(decoder.finish(), Err(ErrorCode::RecoveryRequired));
}

#[test]
fn query_polling_never_consumes_commit_or_safe_stop_slots() {
    let mut guard = RequestGuard::new(identity());
    let source = "printf literal";
    let digest = sha(source);
    guard
        .accept(&envelope(Payload::PrepareInput {
            job: None,
            source: source.into(),
            source_digest: digest.clone(),
            plan: source.into(),
            plan_digest: bound_plan_digest(&digest, source),
            budget_ms: 5000,
            reduced_motion: true,
        }))
        .unwrap();
    for _ in 0..1000 {
        guard.accept(&envelope(Payload::Query)).unwrap();
    }
    let commit = envelope(Payload::Commit {
        source_digest: digest.clone(),
        plan_digest: bound_plan_digest(&digest, source),
    });
    guard.accept(&commit).unwrap();
    assert_eq!(guard.accept(&commit), Err(ErrorCode::DuplicateRequest));
    guard.accept(&envelope(Payload::CancelDraft)).unwrap();
    guard.accept(&envelope(Payload::Interrupt)).unwrap();
    for _ in 0..1000 {
        guard.accept(&envelope(Payload::Query)).unwrap();
    }
    assert_eq!(guard.accept(&commit), Err(ErrorCode::DuplicateRequest));
    assert_eq!(
        guard.accept(&envelope(Payload::Interrupt)),
        Err(ErrorCode::DuplicateRequest)
    );
}

#[test]
fn identity_contract_and_deadline_are_the_existing_broker_contract() {
    for id in ["a", "call:part.one_two-3", &"x".repeat(128)] {
        assert!(valid_identifier(id));
    }
    for id in [
        "",
        ":call",
        "call with space",
        &"x".repeat(129),
        "call\0suffix",
    ] {
        assert!(!valid_identifier(id));
    }
    let mut guard = RequestGuard::new(identity());
    let source = "true";
    let digest = sha(source);
    guard
        .accept(&envelope(Payload::PrepareInput {
            job: None,
            source: source.into(),
            source_digest: digest.clone(),
            plan: source.into(),
            plan_digest: bound_plan_digest(&digest, source),
            budget_ms: 1,
            reduced_motion: true,
        }))
        .unwrap();
    std::thread::sleep(Duration::from_millis(3));
    guard.accept(&envelope(Payload::Query)).unwrap();
    assert_eq!(
        guard.accept(&envelope(Payload::Commit {
            source_digest: digest.clone(),
            plan_digest: bound_plan_digest(&digest, source)
        })),
        Err(ErrorCode::Expired)
    );
    guard.accept(&envelope(Payload::CancelDraft)).unwrap();
}

#[test]
fn unconfirmed_stop_keeps_submission_unknown_until_a_private_result() {
    use CommandEvent as E;
    let cancel = E::RequestCancel(TerminalCommandRequestedSettlement::Cancelled);
    let mut submitted = CommandLifecycle::default();
    for event in [
        E::Ready,
        E::ConfirmInput,
        E::AttemptSubmission,
        cancel,
        E::StopUnconfirmed,
    ] {
        submitted.apply(event).unwrap();
    }
    assert_eq!(submitted.phase(), CommandPhase::Uncertain);
    assert!(submitted.may_have_submitted());
    assert!(!submitted.ended());
    assert!(!submitted.started());
    submitted.apply(E::Started).unwrap();
    assert_eq!(submitted.phase(), CommandPhase::Uncertain);
    assert!(submitted.started());
    assert!(!submitted.ended());
    assert_eq!(submitted.apply(E::Started).unwrap(), Transition::Idempotent);
    assert_eq!(
        submitted.requested_settlement(),
        Some(TerminalCommandRequestedSettlement::Cancelled)
    );
    submitted.apply(E::Settled).unwrap();
    assert_eq!(submitted.phase(), CommandPhase::Cancelled);
    assert!(submitted.ended());
    assert!(submitted.may_have_submitted());

    let mut draft = CommandLifecycle::default();
    for event in [E::Ready, E::BeginInput, cancel, E::StopUnconfirmed] {
        draft.apply(event).unwrap();
    }
    assert_eq!(draft.phase(), CommandPhase::RecoveryRequired);
    assert!(!draft.may_have_submitted());
    assert!(!draft.ended());
    assert!(!draft.draft_cleared());
}

#[test]
fn complete_state_event_matrix_preserves_submission_clear_and_idempotency_invariants() {
    use CommandEvent as E;
    let cancel = E::RequestCancel(TerminalCommandRequestedSettlement::Cancelled);
    let cases: Vec<(&str, Vec<E>)> = vec![
        ("awaiting", vec![]),
        ("preparing", vec![E::Ready]),
        ("typing", vec![E::Ready, E::BeginInput]),
        ("confirmed", vec![E::Ready, E::ConfirmInput]),
        (
            "attempted",
            vec![E::Ready, E::ConfirmInput, E::AttemptSubmission],
        ),
        (
            "running",
            vec![E::Ready, E::ConfirmInput, E::AttemptSubmission, E::Started],
        ),
        (
            "completed",
            vec![
                E::Ready,
                E::ConfirmInput,
                E::AttemptSubmission,
                E::Started,
                E::Settled,
            ],
        ),
        ("cancel-waiting", vec![cancel]),
        ("cancel-typing", vec![E::Ready, E::BeginInput, cancel]),
        (
            "cancel-local-withdrawal",
            vec![E::Ready, E::BeginInput, cancel, E::WithdrawBeforeSubmission],
        ),
        (
            "cancel-after-attempt",
            vec![E::Ready, E::ConfirmInput, E::AttemptSubmission, cancel],
        ),
        (
            "cancel-running",
            vec![
                E::Ready,
                E::ConfirmInput,
                E::AttemptSubmission,
                E::Started,
                cancel,
            ],
        ),
        (
            "cancelled-empty-proof",
            vec![E::Ready, E::BeginInput, cancel, E::DraftCleared],
        ),
        (
            "cancelled-no-owned-draft",
            vec![
                E::Ready,
                cancel,
                E::WithdrawBeforeSubmission,
                E::NoOwnedDraft,
            ],
        ),
        ("failed", vec![E::Ready, E::PreparationFailed]),
        ("parser-refused", vec![E::Ready, E::ParserRejected]),
        ("uncertain-before-attempt", vec![E::Ready, E::ControlLost]),
        (
            "uncertain-after-attempt",
            vec![
                E::Ready,
                E::ConfirmInput,
                E::AttemptSubmission,
                E::ControlLost,
            ],
        ),
        (
            "uncertain-after-start",
            vec![
                E::Ready,
                E::ConfirmInput,
                E::AttemptSubmission,
                E::Started,
                E::ControlLost,
            ],
        ),
        ("recovery", vec![E::Ready, E::BeginInput, E::InputLost]),
        (
            "refused-during-cancel",
            vec![
                E::Ready,
                E::ConfirmInput,
                E::AttemptSubmission,
                cancel,
                E::ParserRejected,
            ],
        ),
    ];
    let events = [
        E::Ready,
        E::BeginInput,
        E::ConfirmInput,
        E::AttemptSubmission,
        E::LegacyAttemptSubmission,
        E::Started,
        E::LegacyStarted,
        E::Settled,
        E::LegacySettled,
        cancel,
        E::RequestCancel(TerminalCommandRequestedSettlement::TimedOut),
        E::RequestCancel(TerminalCommandRequestedSettlement::TakenOver),
        E::StopUnconfirmed,
        E::WithdrawBeforeSubmission,
        E::NoOwnedDraft,
        E::LegacyInterruptEnqueued,
        E::LegacyEditReturned,
        E::DraftCleared,
        E::PreparationFailed,
        E::ParserRejected,
        E::SettledUncertain,
        E::CaptureIncomplete,
        E::InputLost,
        E::ControlLost,
        E::TransportClosed,
        E::ApplicationExit,
    ];
    let facts = |state: &CommandLifecycle| {
        (
            state.phase(),
            state.may_have_submitted(),
            state.started(),
            state.ended(),
            state.requested_settlement(),
            state.submission_revoked(),
            state.draft_cleared(),
            state.source_rejected(),
        )
    };
    let mut matrix = Vec::new();
    for (name, path) in cases {
        for event in events {
            let mut state = CommandLifecycle::default();
            for step in &path {
                state.apply(*step).unwrap();
            }
            let before = facts(&state);
            let result = state.apply(event);
            let after = facts(&state);
            if result.is_err() || result == Ok(Transition::Idempotent) {
                assert_eq!(
                    after, before,
                    "{name}: {event:?} changed facts while rejected/idempotent"
                );
            }
            assert!(
                !before.1 || after.1,
                "{name}: {event:?} erased possible submission"
            );
            if !before.6 && after.6 {
                assert_eq!(
                    event,
                    E::DraftCleared,
                    "{name}: local cancellation invented a native empty-buffer proof"
                );
            }
            if event == E::AttemptSubmission && result.is_ok() {
                assert_eq!(before.0, CommandPhase::InputConfirmed);
                assert!(!before.1);
            }
            if event == E::Started && result == Ok(Transition::Accepted) {
                assert!(before.1, "native start skipped the submission boundary");
            }
            if event == E::Settled && result == Ok(Transition::Accepted) {
                assert!(before.1, "native result settled an unsubmitted operation");
            }
            if before.4.is_some() {
                assert_eq!(
                    after.4, before.4,
                    "a late stop changed the first settlement reason"
                );
            }
            matrix.push(serde_json::json!({"stateCase":name,"before":before.0,"event":format!("{event:?}"),"decision":match result {Ok(Transition::Accepted)=>"accepted",Ok(Transition::Idempotent)=>"idempotent",Err(_)=>"rejected"},"after":after.0,"mayHaveSubmitted":after.1}));
        }
    }
    assert_eq!(matrix.len(), 546);
    if let Some(path) = std::env::var_os("SHELLSPAN_P1_MATRIX_PATH") {
        std::fs::write(path, serde_json::to_vec_pretty(&matrix).unwrap()).unwrap();
    }
}

#[cfg(unix)]
#[test]
#[ignore = "subprocess entry for actual SIGKILL crash-boundary verification"]
fn submission_crash_child() {
    let root =
        std::path::PathBuf::from(std::env::var_os("SHELLSPAN_P1_CRASH_ROOT").expect("crash root"));
    let cut = std::env::var("SHELLSPAN_P1_CRASH_CUT").unwrap();
    let journal = SubmissionJournal::unconfigured();
    journal.configure(&root).unwrap();
    if cut != "before-intent" {
        journal.record(&identity()).unwrap();
    }
    if matches!(cut.as_str(), "after-delivery" | "after-settlement") {
        let status = std::process::Command::new("/bin/sh")
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .args(["-c", "printf ONCE >> \"$1\"", "crash-probe"])
            .arg(root.join("effect"))
            .status()
            .unwrap();
        assert!(status.success());
    }
    if cut == "after-settlement" {
        journal.settle(&identity()).unwrap();
    }
    unsafe {
        libc::kill(libc::getpid(), libc::SIGKILL);
    }
    panic!("SIGKILL returned");
}

#[cfg(unix)]
#[test]
fn journal_sigkill_probe_preserves_intent_and_never_replays_its_separate_shell_effect() {
    use std::os::unix::process::ExitStatusExt;
    for cut in [
        "before-intent",
        "after-intent",
        "after-delivery",
        "after-settlement",
    ] {
        let root = tempfile::tempdir().unwrap();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "terminal_command::tests::submission_crash_child",
            ])
            .env("SHELLSPAN_P1_CRASH_ROOT", root.path())
            .env("SHELLSPAN_P1_CRASH_CUT", cut)
            .output()
            .unwrap();
        assert_eq!(
            output.status.signal(),
            Some(libc::SIGKILL),
            "{cut}: subprocess did not reach the crash boundary: {} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let journal = SubmissionJournal::unconfigured();
        journal.configure(root.path()).unwrap();
        let unresolved = journal.unresolved().unwrap();
        assert_eq!(
            unresolved.len(),
            usize::from(matches!(cut, "after-intent" | "after-delivery")),
            "{cut}"
        );
        let effect = std::fs::read(root.path().join("effect")).unwrap_or_default();
        assert_eq!(
            effect,
            if matches!(cut, "after-delivery" | "after-settlement") {
                b"ONCE".as_slice()
            } else {
                b"".as_slice()
            }
        );
        if cut != "before-intent" {
            assert!(journal
                .record(&identity())
                .unwrap_err()
                .contains("ALREADY_RECORDED"));
        }
        assert_eq!(
            std::fs::read(root.path().join("effect")).unwrap_or_default(),
            effect,
            "query/duplicate intent replayed execution"
        );
    }
}

#[test]
fn connection_readiness_validates_its_complete_operation_identity() {
    let connection = ConnectionIdentity {
        terminal_session_id: identity().terminal_session_id,
        terminal_generation: 1,
        control_id: "control:one".into(),
    };
    let mut message = ConnectionEnvelope {
        protocol: PROTOCOL.into(),
        request_id: "request:ready".into(),
        connection,
        payload: ConnectionPayload::EditorReady {
            editor_empty: true,
            owned_draft_absent: true,
            after_command: Some(identity()),
        },
    };
    message.validate().unwrap();
    if let ConnectionPayload::EditorReady {
        after_command: Some(identity),
        ..
    } = &mut message.payload
    {
        identity.lease_generation = 0;
    }
    assert_eq!(message.validate(), Err(ErrorCode::Identity));
    if let ConnectionPayload::EditorReady {
        after_command: Some(identity),
        ..
    } = &mut message.payload
    {
        identity.lease_generation = 2;
        identity.terminal_generation = 2;
    }
    assert_eq!(message.validate(), Err(ErrorCode::Identity));
}

#[test]
fn cold_recovery_does_not_replace_a_real_legacy_submission_with_an_empty_ledger() {
    let root = tempfile::tempdir().unwrap();
    let previous = SubmissionJournal::unconfigured();
    previous.configure(root.path()).unwrap();
    previous.record(&identity()).unwrap();
    drop(previous);
    let current = root.path().join("terminal-submissions");
    let legacy = root.path().join("terminal-submissions-obsolete");
    std::fs::rename(&current, &legacy).unwrap();
    let database = legacy.join("intentions.sqlite");
    let before = std::fs::read(&database).unwrap();
    let restarted = SubmissionJournal::unconfigured();
    restarted.configure(root.path()).unwrap();
    assert_eq!(
        restarted
            .ensure_new_operation(
                &identity().agent_session_id,
                &identity().task_id,
                &identity().operation_id,
            )
            .unwrap_err(),
        "TERMINAL_SUBMISSION_JOURNAL_MIGRATION_REQUIRED"
    );
    assert!(restarted
        .recovered_for_agent(&identity().agent_session_id)
        .is_err());
    assert!(
        !current.exists(),
        "recovery created a misleading empty ledger"
    );
    assert_eq!(std::fs::read(&database).unwrap(), before);
    let connection = rusqlite::Connection::open_with_flags(
        std::fs::canonicalize(&database).unwrap(),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .unwrap();
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM submissions WHERE settled=0",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
}

#[test]
fn cold_recovery_keeps_a_legacy_call_fence_when_a_current_ledger_also_exists() {
    let root = tempfile::tempdir().unwrap();
    let old_root = tempfile::tempdir().unwrap();
    let old = SubmissionJournal::unconfigured();
    old.configure(old_root.path()).unwrap();
    old.record(&identity()).unwrap();
    old.settle(&identity()).unwrap();
    let current = SubmissionJournal::unconfigured();
    current.configure(root.path()).unwrap();
    let mut another = identity();
    another.operation_id = "different-operation".into();
    current.record(&another).unwrap();
    drop(old);
    drop(current);
    std::fs::rename(
        old_root.path().join("terminal-submissions"),
        root.path().join("terminal-submissions-obsolete"),
    )
    .unwrap();
    let restarted = SubmissionJournal::unconfigured();
    restarted.configure(root.path()).unwrap();
    assert_eq!(
        restarted
            .ensure_new_operation(&another.agent_session_id, &another.task_id, "new-operation")
            .unwrap_err(),
        "TERMINAL_SUBMISSION_JOURNAL_MIGRATION_REQUIRED"
    );
}

#[test]
fn submission_storage_keeps_its_version_inside_the_database() {
    let root = tempfile::tempdir().unwrap();
    let journal = SubmissionJournal::unconfigured();
    journal.configure(root.path()).unwrap();
    journal.record(&identity()).unwrap();
    let database = root.path().join("terminal-submissions/intentions.sqlite");
    let connection = rusqlite::Connection::open(database).unwrap();
    assert_eq!(
        connection
            .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        2
    );
    let encoded: String = connection
        .query_row("SELECT record_json FROM submissions", [], |row| row.get(0))
        .unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&encoded).unwrap()["version"],
        1
    );
    connection.pragma_update(None, "user_version", 99).unwrap();
    let restarted = SubmissionJournal::unconfigured();
    restarted.configure(root.path()).unwrap();
    assert!(restarted.unresolved().is_err());
    assert_eq!(
        connection
            .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        99
    );
}

#[test]
fn startup_recovery_gate_does_not_treat_live_interactive_input_as_a_restart() {
    let root = tempfile::tempdir().unwrap();
    let first = SubmissionJournal::unconfigured();
    first.configure(root.path()).unwrap();
    assert!(
        !root.path().join("terminal-submissions").exists(),
        "configuration performed filesystem I/O before the background journal operation"
    );
    first.record(&identity()).unwrap();
    assert_eq!(first.unresolved().unwrap().len(), 1);
    assert!(first
        .recovered_for_agent(&identity().agent_session_id)
        .unwrap()
        .is_empty());
    first.configure(root.path()).unwrap();
    assert!(first
        .recovered_for_agent(&identity().agent_session_id)
        .unwrap()
        .is_empty());
    let restarted = SubmissionJournal::unconfigured();
    restarted.configure(root.path()).unwrap();
    assert_eq!(
        restarted
            .recovered_for_agent(&identity().agent_session_id)
            .unwrap()
            .len(),
        1
    );
    assert!(restarted
        .recovered_for_agent("other-agent")
        .unwrap()
        .is_empty());
    restarted.settle(&identity()).unwrap();
    assert!(restarted
        .recovered_for_agent(&identity().agent_session_id)
        .unwrap()
        .is_empty());
    assert!(restarted
        .ensure_new_operation(
            &identity().agent_session_id,
            &identity().task_id,
            &identity().operation_id
        )
        .is_err());
}

#[test]
fn cold_runtime_can_query_real_recovery_records_without_starting_an_agent() {
    let root = tempfile::tempdir().unwrap();
    let journal = SubmissionJournal::unconfigured();
    journal.configure(root.path()).unwrap();
    journal.record(&identity()).unwrap();
    let runtime = crate::agent_runtime::AgentRuntime::default();
    let records = runtime
        .terminal_submission_recovery(root.path(), &identity().agent_session_id)
        .unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].identity, identity());
    assert!(runtime
        .terminal_submission_recovery(root.path(), "other-agent")
        .unwrap()
        .is_empty());
    assert!(journal
        .ensure_new_operation(
            &identity().agent_session_id,
            &identity().task_id,
            &identity().operation_id
        )
        .is_err());
}
