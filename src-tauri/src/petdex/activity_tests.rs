use super::types::{WaitReason, FAILURE_TTL, SUCCESS_TTL};
use super::*;

fn assert_staggered_short_prompts_are_delivered(phase: ActivityPhase, state: PetdexState) {
    let start = Instant::now();
    let ttl = state.ttl().expect("short prompt duration");
    let stagger = Duration::from_millis(500);
    let mut arbiter = PetdexArbiter::default();
    arbiter.set_categories(PetdexCategories {
        ai: true,
        ..Default::default()
    });
    for (source, run_id) in [(ActivitySource::Sftp, 1), (ActivitySource::Ai, 2)] {
        arbiter.apply(
            ActivityEvent::new(source, run_id, 0, ActivityPhase::Running, start),
            start,
        );
    }
    arbiter.apply(
        ActivityEvent::new(ActivitySource::Sftp, 1, 1, phase, start),
        start,
    );
    let mut delivery = DeliveryPolicy::default();
    let first = arbiter.target(start);
    assert_eq!(first.state, state);
    delivery.record(first.command(), RequestResult::Applied, start);

    let second_at = start + stagger;
    arbiter.apply(
        ActivityEvent::new(ActivitySource::Ai, 2, 1, phase, second_at),
        second_at,
    );
    // The first prompt still wins. A shrinking remaining duration must not
    // be mistaken for a new command on each coordinator wake.
    assert_eq!(arbiter.target(second_at).expires_at, first.expires_at);
    assert_eq!(
        delivery.attempt_deadline(arbiter.target(second_at), second_at),
        Some(start + INITIAL_RECOVERY_PROBE_INTERVAL)
    );

    let first_expired = start + ttl;
    let remaining = arbiter.target(first_expired);
    assert_eq!(remaining.state, state);
    assert_eq!(remaining.expires_at, Some(second_at + ttl));
    assert_eq!(
        remaining.command().remaining_duration(first_expired).ok(),
        Some(Some(stagger))
    );
    assert_eq!(
        delivery.attempt_deadline(remaining, first_expired),
        Some(first_expired),
        "the remaining source must be sent when the first short prompt expires"
    );
    delivery.record(remaining.command(), RequestResult::Applied, first_expired);
    assert_eq!(
        delivery.attempt_deadline(remaining, first_expired + MIN_SEND_INTERVAL),
        Some(first_expired + INITIAL_RECOVERY_PROBE_INTERVAL),
        "the replacement prompt must not be repeatedly sent"
    );
    let finished_at = second_at + ttl;
    let idle = arbiter.target(finished_at);
    assert_eq!(idle.state, PetdexState::Idle);
    assert_eq!(
        delivery.attempt_deadline(idle, finished_at),
        Some(finished_at)
    );
}

#[test]
fn staggered_source_failures_deliver_the_remaining_failure() {
    assert_staggered_short_prompts_are_delivered(ActivityPhase::Failed, PetdexState::Failed);
}

#[test]
fn staggered_source_successes_deliver_the_remaining_success() {
    assert_staggered_short_prompts_are_delivered(ActivityPhase::Succeeded, PetdexState::Jumping);
}

#[test]
fn expiry_changes_preserve_send_throttling_and_unchanged_command_backoff() {
    let start = Instant::now();
    let first = ArbitrationTarget {
        state: PetdexState::Failed,
        expires_at: Some(start + FAILURE_TTL),
    };
    let next = ArbitrationTarget {
        expires_at: Some(start + FAILURE_TTL + Duration::from_secs(1)),
        ..first
    };
    let mut delivery = DeliveryPolicy::default();
    delivery.record(first.command(), RequestResult::Transport, start);
    let shortly_after = start + Duration::from_millis(10);
    assert_eq!(
        delivery.attempt_deadline(first, shortly_after),
        Some(start + INITIAL_FAILURE_BACKOFF)
    );
    assert_eq!(
        delivery.attempt_deadline(next, shortly_after),
        Some(start + MIN_SEND_INTERVAL)
    );
    let failed_at = start + MIN_SEND_INTERVAL;
    delivery.record(next.command(), RequestResult::Transport, failed_at);
    assert_eq!(
        delivery.attempt_deadline(next, failed_at),
        Some(failed_at + failure_backoff(2))
    );
}

#[test]
fn transport_commands_keep_absolute_expiry_across_checks_and_retries() {
    let start = Instant::now();
    let target = ArbitrationTarget {
        state: PetdexState::Waving,
        expires_at: Some(start + SUCCESS_TTL),
    };
    let command = target.command();
    assert_eq!(
        command
            .remaining_duration(start + Duration::from_millis(900))
            .unwrap_or_else(|_| panic!("live duration")),
        Some(Duration::from_millis(300))
    );
    for now in [
        start + SUCCESS_TTL,
        start + SUCCESS_TTL + Duration::from_secs(1),
    ] {
        assert!(matches!(
            command.remaining_duration(now),
            Err(types::RequestFailure::Expired)
        ));
    }
    let mut delivery = DeliveryPolicy::default();
    delivery.record(command, RequestResult::Applied, start);
    delivery.record(command, RequestResult::Expired, start + SUCCESS_TTL);
    let renewed = ArbitrationTarget {
        state: PetdexState::Waving,
        expires_at: Some(start + SUCCESS_TTL * 2),
    };
    assert_eq!(
        delivery.attempt_deadline(renewed, start + SUCCESS_TTL),
        Some(start + SUCCESS_TTL + MIN_SEND_INTERVAL)
    );
    assert_eq!(delivery.consecutive_failures, 0);
}

#[tokio::test]
async fn an_expired_command_stops_before_credentials_or_network() {
    let root = tempfile::TempDir::new().expect("isolated empty home");
    let adapter = PetdexAdapter::new(root.path().to_path_buf());
    adapter.set_enabled_for_io_test(true);
    let result = adapter
        .apply_state(
            StateCommand {
                state: PetdexState::Waving,
                expires_at: Some(Instant::now()),
            },
            adapter.cancellation_token(),
        )
        .await;
    assert_eq!(result, RequestResult::Expired);
}

#[tokio::test(start_paused = true)]
async fn the_entire_attempt_including_lock_wait_has_one_budget() {
    assert!(STATE_ATTEMPT_TIMEOUT < TEST_CONNECTION_TIMEOUT);
    let root = tempfile::TempDir::new().expect("isolated empty home");
    let adapter = PetdexAdapter::new(root.path().to_path_buf());
    adapter.set_enabled_for_io_test(true);
    let _lock = adapter.inner.request_lock.lock().await;
    let start = tokio::time::Instant::now();
    assert_eq!(
        adapter
            .apply_state(
                StateCommand::full_ttl(PetdexState::Running),
                adapter.cancellation_token()
            )
            .await,
        RequestResult::Transport
    );
    assert_eq!(tokio::time::Instant::now() - start, STATE_ATTEMPT_TIMEOUT);
}

#[test]
fn expiry_does_not_claim_success_or_replace_the_connection_diagnosis() {
    let adapter = PetdexAdapter::new(PathBuf::from("/nonexistent-petdex-home"));
    let (_receiver, cancellation) = adapter.prepare_coordinator().expect("enabled");
    let mut control = adapter.inner.coordinator.lock().expect("coordinator");
    control.refresh_diagnostic(&cancellation, Some(RequestResult::Applied), false);
    let before = control.diagnostic;
    control.refresh_diagnostic(&cancellation, Some(RequestResult::Expired), false);
    assert_eq!(control.diagnostic, before);
}

#[test]
fn abandoned_manual_preview_restores_business_target_and_prior_diagnosis() {
    let adapter = PetdexAdapter::new(PathBuf::from("/nonexistent-petdex-home"));
    let _activity = ActivityGuard::new(
        Some(adapter.clone()),
        ActivitySource::Sftp,
        ActivityPhase::Running,
    );
    let (_receiver, cancellation) = adapter.prepare_coordinator().expect("enabled");
    let started = Instant::now();
    let mut control = adapter.inner.coordinator.lock().expect("coordinator");
    control.refresh_diagnostic(&cancellation, Some(RequestResult::Transport), false);
    let previous = control.diagnostic;
    control.arbiter.start_preview(started);
    control.refresh_diagnostic(&cancellation, None, true);
    assert_eq!(control.diagnostic.target_action, Some(PetdexState::Waving));
    assert!(control.abandon_test_preview(started, &cancellation, previous));
    assert_eq!(control.diagnostic.status, previous.status);
    assert_eq!(control.diagnostic.last_success_at, previous.last_success_at);
    assert_eq!(
        control
            .arbiter
            .target(started + Duration::from_millis(500))
            .state,
        PetdexState::Running
    );
    let later = started + Duration::from_millis(600);
    control.arbiter.start_preview(later);
    cancellation.cancel();
    assert!(!control.abandon_test_preview(started, &cancellation, previous));
    assert_eq!(control.arbiter.target(later).state, PetdexState::Waving);
}

#[test]
fn removing_only_the_owned_preview_preserves_business_prompts_and_new_previews() {
    let start = Instant::now();
    let mut arbiter = PetdexArbiter::default();
    arbiter.apply(
        ActivityEvent::new(ActivitySource::Sftp, 1, 0, ActivityPhase::Running, start),
        start,
    );
    arbiter.apply(
        ActivityEvent::new(ActivitySource::Sftp, 1, 1, ActivityPhase::Succeeded, start),
        start,
    );
    arbiter.start_preview(start);
    arbiter.cancel_preview(start);
    assert_eq!(arbiter.target(start).state, PetdexState::Jumping);
    let later = start + Duration::from_millis(100);
    arbiter.start_preview(later);
    arbiter.cancel_preview(start);
    assert_eq!(arbiter.target(later).state, PetdexState::Waving);
    arbiter.apply(
        ActivityEvent::new(ActivitySource::Sftp, 2, 0, ActivityPhase::Running, later),
        later,
    );
    arbiter.apply(
        ActivityEvent::new(ActivitySource::Sftp, 2, 1, ActivityPhase::Failed, later),
        later,
    );
    arbiter.cancel_preview(later);
    assert_eq!(arbiter.target(later).state, PetdexState::Failed);
}

#[test]
fn disabled_tracking_and_enable_snapshot_follow_worker_lifetime() {
    let adapter = PetdexAdapter::new(PathBuf::from("/nonexistent-petdex-home"));
    let mut transfer = ActivityGuard::new(
        Some(adapter.clone()),
        ActivitySource::Sftp,
        ActivityPhase::Running,
    );
    let mut ssh = ActivityGuard::new(
        Some(adapter.clone()),
        ActivitySource::Ssh,
        ActivityPhase::Connecting,
    );
    assert_eq!(adapter.status().status, PetdexConnectionStatus::Disabled);
    let (_receiver, first_generation) = adapter.prepare_coordinator().unwrap();
    assert_eq!(adapter.status().target_action, Some(PetdexState::Running));
    adapter.stop_coordinator();
    transfer.transition(ActivityPhase::Succeeded);
    let (_receiver, second_generation) = adapter.prepare_coordinator().unwrap();
    assert!(first_generation.is_cancelled());
    assert_eq!(adapter.status().target_action, Some(PetdexState::Waiting));
    assert!(adapter
        .test_command(Instant::now(), &first_generation)
        .is_none());
    ssh.transition(ActivityPhase::Connected);
    adapter.stop_coordinator();
    let (_receiver, third_generation) = adapter.prepare_coordinator().unwrap();
    assert!(second_generation.is_cancelled());
    assert_eq!(adapter.status().target_action, Some(PetdexState::Idle));
    ssh.transition(ActivityPhase::Failed);
    let (target, _) = adapter
        .arbitration_snapshot(Instant::now(), &third_generation)
        .unwrap();
    assert_eq!(target.state, PetdexState::Failed);
    adapter.stop_coordinator();
}

#[test]
fn worker_unwind_and_concurrent_cleanup_cannot_remove_another_run() {
    let adapter = PetdexAdapter::new(PathBuf::from("/nonexistent-petdex-home"));
    let mut survivor = ActivityGuard::new(
        Some(adapter.clone()),
        ActivitySource::Sftp,
        ActivityPhase::Running,
    );
    std::thread::scope(|scope| {
        let mut workers = Vec::new();
        for _ in 0..32 {
            let adapter = adapter.clone();
            workers.push(scope.spawn(move || {
                let _guard =
                    ActivityGuard::new(Some(adapter), ActivitySource::Sftp, ActivityPhase::Running);
                panic!("exercise worker unwind cleanup");
            }));
        }
        for worker in workers {
            assert!(worker.join().is_err());
        }
    });
    let (_receiver, cancellation) = adapter.prepare_coordinator().unwrap();
    assert_eq!(adapter.status().target_action, Some(PetdexState::Running));
    survivor.transition(ActivityPhase::Cancelled);
    assert_eq!(
        adapter
            .arbitration_snapshot(Instant::now(), &cancellation)
            .unwrap()
            .0
            .state,
        PetdexState::Idle
    );
    adapter.stop_coordinator();
}

#[test]
fn independent_preview_respects_failure_and_waiting_without_erasing_business_results() {
    let start = Instant::now();
    let mut arbiter = PetdexArbiter::default();
    arbiter.apply(
        ActivityEvent::new(ActivitySource::Sftp, 1, 0, ActivityPhase::Running, start),
        start,
    );
    arbiter.apply(
        ActivityEvent::new(
            ActivitySource::Sftp,
            2,
            0,
            ActivityPhase::Waiting(WaitReason::Approval),
            start,
        ),
        start,
    );
    arbiter.apply(
        ActivityEvent::new(ActivitySource::Sftp, 1, 1, ActivityPhase::Succeeded, start),
        start,
    );
    arbiter.start_preview(start);
    assert!(arbiter.preview_overridden(start));
    assert_eq!(arbiter.target(start).state, PetdexState::Waiting);
    arbiter.apply(
        ActivityEvent::new(ActivitySource::Sftp, 3, 0, ActivityPhase::Running, start),
        start,
    );
    arbiter.apply(
        ActivityEvent::new(ActivitySource::Sftp, 3, 1, ActivityPhase::Failed, start),
        start,
    );
    assert_eq!(arbiter.target(start).state, PetdexState::Failed);
    assert_eq!(
        arbiter.target(start + FAILURE_TTL).state,
        PetdexState::Waiting
    );
    arbiter.apply(
        ActivityEvent::new(
            ActivitySource::Sftp,
            2,
            2,
            ActivityPhase::Running,
            start + FAILURE_TTL,
        ),
        start + FAILURE_TTL,
    );
    assert_eq!(
        arbiter.target(start + FAILURE_TTL).state,
        PetdexState::Running
    );
    // An old waiting update cannot overwrite the resumed phase.
    arbiter.apply(
        ActivityEvent::new(
            ActivitySource::Sftp,
            2,
            1,
            ActivityPhase::Waiting(WaitReason::Answer),
            start,
        ),
        start + FAILURE_TTL,
    );
    assert_eq!(
        arbiter.target(start + FAILURE_TTL).state,
        PetdexState::Running
    );
    arbiter.start_preview(start + FAILURE_TTL);
    assert_eq!(
        arbiter.target(start + FAILURE_TTL).state,
        PetdexState::Waving
    );
    assert_eq!(
        arbiter.target(start + FAILURE_TTL + SUCCESS_TTL).state,
        PetdexState::Running
    );
}

#[test]
fn preview_reply_reports_transport_failure_override_and_cancelled_generation() {
    let adapter = PetdexAdapter::new(PathBuf::from("/nonexistent-petdex-home"));
    let (_receiver, cancellation) = adapter.prepare_coordinator().unwrap();
    assert_eq!(
        adapter
            .test_result(RequestResult::Disabled, false, None)
            .preview,
        PreviewOutcome::Disabled
    );
    let mut activity = ActivityGuard::new(
        Some(adapter.clone()),
        ActivitySource::Sftp,
        ActivityPhase::Running,
    );
    assert_eq!(
        adapter
            .test_command(Instant::now(), &cancellation)
            .unwrap()
            .state,
        PetdexState::Waving
    );
    assert_eq!(
        adapter
            .test_result(RequestResult::Applied, false, Some(&cancellation))
            .preview,
        PreviewOutcome::Requested
    );
    activity.transition(ActivityPhase::Waiting(WaitReason::Answer));
    assert_eq!(
        adapter
            .test_result(RequestResult::Applied, false, Some(&cancellation))
            .preview,
        PreviewOutcome::Overridden
    );
    assert_eq!(
        adapter
            .test_command(Instant::now(), &cancellation)
            .unwrap()
            .state,
        PetdexState::Waiting
    );
    assert_eq!(
        adapter
            .test_result(RequestResult::Transport, true, Some(&cancellation))
            .preview,
        PreviewOutcome::Failed
    );
    activity.transition(ActivityPhase::Cancelled);
    assert_eq!(
        adapter
            .test_result(RequestResult::Applied, true, Some(&cancellation))
            .preview,
        PreviewOutcome::Overridden
    );
    adapter.stop_coordinator();
    let (_receiver, _new_generation) = adapter.prepare_coordinator().unwrap();
    assert_eq!(
        adapter
            .test_result(RequestResult::Applied, false, Some(&cancellation))
            .preview,
        PreviewOutcome::Disabled
    );
    adapter.stop_coordinator();
}

#[test]
fn recovery_after_failure_uses_current_activity_not_expired_terminal() {
    let start = Instant::now();
    let mut arbiter = PetdexArbiter::default();
    let mut delivery = DeliveryPolicy::default();
    arbiter.apply(
        ActivityEvent::new(ActivitySource::Sftp, 1, 0, ActivityPhase::Running, start),
        start,
    );
    arbiter.apply(
        ActivityEvent::new(ActivitySource::Sftp, 2, 0, ActivityPhase::Running, start),
        start,
    );
    arbiter.apply(
        ActivityEvent::new(ActivitySource::Sftp, 2, 1, ActivityPhase::Failed, start),
        start,
    );
    delivery.record(
        arbiter.target(start).command(),
        RequestResult::Transport,
        start,
    );
    let shortly_after = start + INITIAL_FAILURE_BACKOFF;
    assert_eq!(
        arbiter
            .target(shortly_after)
            .command()
            .remaining_duration(shortly_after)
            .unwrap_or_else(|_| panic!("live command")),
        Some(FAILURE_TTL - INITIAL_FAILURE_BACKOFF)
    );
    let recovered_at = start + FAILURE_TTL;
    let target = arbiter.target(recovered_at);
    assert_eq!(target.state, PetdexState::Running);
    assert_eq!(
        delivery.attempt_deadline(target, recovered_at),
        Some(recovered_at)
    );
}
