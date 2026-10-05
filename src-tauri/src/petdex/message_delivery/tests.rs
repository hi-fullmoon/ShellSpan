use super::*;
use crate::petdex::{
    types::{ActivityKind, ActivityOwner, WaitReason},
    ActivityGuard, ActivitySource,
};

#[tokio::test]
async fn message_test_obeys_gates_and_never_overwrites_three_waiting_slots() {
    let (_root, adapter) = adapter();
    adapter.set_message_preferences(MessagePreferences::default());
    assert_eq!(
        adapter.test_message().await.outcome,
        MessageTestOutcome::Disabled
    );
    adapter.set_message_preferences(MessagePreferences {
        petdex_messages_enabled: true,
        petdex_message_details_enabled: false,
    });
    let mut runs: Vec<_> = (0..3).map(|_| activity(&adapter)).collect();
    for run in &mut runs {
        run.transition(ActivityPhase::Waiting(WaitReason::Approval));
    }
    assert_eq!(
        adapter.test_message().await.outcome,
        MessageTestOutcome::Overridden
    );
    assert_eq!(adapter.message_diagnostic().used_slot_count, 0);
}

#[tokio::test]
async fn message_test_timeout_cancels_and_releases_slot_without_late_send() {
    let (_root, adapter) = adapter();
    let _run = activity(&adapter);
    let lock = adapter.inner.request_lock.lock().await;
    let result = adapter.test_message().await;
    assert_eq!(result.outcome, MessageTestOutcome::Failed);
    assert_eq!(result.diagnostic.used_slot_count, 0);
    assert!(adapter
        .inner
        .messages
        .lock()
        .unwrap()
        .preview_slot
        .is_none());
    drop(lock);
    assert_eq!(adapter.message_diagnostic().accepted_count, 0);
    assert!(adapter.next_message(Instant::now()).is_some());
}

#[test]
fn message_diagnostic_serialization_is_finite_and_monotonic() {
    let (_root, adapter) = adapter();
    let first = adapter.message_diagnostic();
    let second = adapter.message_diagnostic();
    assert!(second.revision > first.revision);
    let value = serde_json::to_value(second).unwrap();
    assert_eq!(value.as_object().unwrap().len(), 8);
    assert_eq!(value["status"], "ready");
    assert_eq!(value["usedSlotCount"], 0);
}

#[tokio::test]
async fn configuration_queue_and_cleanup_share_absolute_deadline() {
    let (_root, adapter) = adapter();
    adapter.inner.messages.lock().unwrap().usage[0].used = true;
    let _request = adapter.inner.request_lock.lock().await;
    let deadline = tokio::time::Instant::now() + Duration::from_millis(60);
    let command = adapter.inner.configuration_command_lock.lock().await;
    let queued = async {
        let _guard =
            tokio::time::timeout_at(deadline, adapter.inner.configuration_command_lock.lock())
                .await
                .unwrap();
        adapter.shutdown_messages_until(deadline).await
    };
    let release = async {
        tokio::time::sleep(Duration::from_millis(40)).await;
        drop(command);
    };
    let start = Instant::now();
    let (outcome, ()) = tokio::join!(queued, release);
    assert_eq!(outcome, CleanupOutcome::Unconfirmed);
    assert!(!adapter.inner.enabled.load(Ordering::Acquire));
    assert!(start.elapsed() < Duration::from_millis(150));
    assert_eq!(
        adapter.message_diagnostic().cleanup_outcome,
        CleanupOutcome::Unconfirmed
    );
}

fn adapter() -> (tempfile::TempDir, PetdexAdapter) {
    let root = tempfile::tempdir().unwrap();
    let adapter = PetdexAdapter::new(root.path().into());
    adapter.initialize_messages(root.path());
    let _ = adapter.prepare_coordinator().unwrap();
    adapter.set_message_preferences(MessagePreferences {
        petdex_messages_enabled: true,
        petdex_message_details_enabled: false,
    });
    (root, adapter)
}

fn activity(adapter: &PetdexAdapter) -> ActivityGuard {
    ActivityGuard::owned(
        Some(adapter.clone()),
        ActivitySource::Sftp,
        ActivityPhase::Running,
        ActivityOwner::Connection(std::sync::Arc::new(uuid::Uuid::new_v4())),
        ActivityKind::Upload,
    )
}

#[test]
fn latest_only_coalesces_deduplicates_and_prioritizes_wait_transitions() {
    let (_root, adapter) = adapter();
    let mut run = activity(&adapter);
    let now = Instant::now();
    let first = adapter.next_message(now).unwrap();
    assert_eq!(first.due, now + COALESCE);
    let repeated = adapter
        .next_message(now + Duration::from_millis(20))
        .unwrap();
    assert_eq!(first.due, repeated.due);
    run.transition(ActivityPhase::Waiting(WaitReason::Approval));
    let waiting = adapter.next_message(now).unwrap();
    assert_eq!(waiting.due, now);
    assert!(!adapter.pending_current(&first));
    run.transition(ActivityPhase::Running);
    let resumed = adapter.next_message(now).unwrap();
    assert_eq!(resumed.due, now);
    adapter
        .inner
        .messages
        .lock()
        .unwrap()
        .record(&resumed, RequestResult::Applied, true, now);
    run.transition(ActivityPhase::Running);
    assert!(
        adapter.next_message(now).is_none(),
        "same run and safe body must not refresh its position"
    );
}

#[test]
fn old_receipt_cannot_acknowledge_rebound_slot_or_replace_pending_version() {
    let (_root, adapter) = adapter();
    let mut old = activity(&adapter);
    let first = adapter.next_message(Instant::now()).unwrap();
    old.transition(ActivityPhase::Cancelled);
    let _new = activity(&adapter);
    let current = adapter.next_message(Instant::now()).unwrap();
    assert_ne!(
        first.snapshot.slots[0].binding_generation,
        current.snapshot.slots[0].binding_generation
    );
    adapter.inner.messages.lock().unwrap().record(
        &first,
        RequestResult::Applied,
        adapter.pending_current(&first),
        Instant::now(),
    );
    assert!(adapter.next_message(Instant::now()).is_some());
    assert_eq!(adapter.message_diagnostic().accepted_count, 0);
}

#[tokio::test]
async fn preferences_cancel_details_and_disabled_configuration_never_communicates() {
    let root = tempfile::tempdir().unwrap();
    let adapter = PetdexAdapter::new(root.path().into());
    let locked = adapter.inner.request_lock.lock().await;
    let result = adapter
        .configure_messages(
            MessagePreferences {
                petdex_messages_enabled: true,
                petdex_message_details_enabled: true,
            },
            "zh-CN",
        )
        .await;
    assert_eq!(result.cleanup_outcome, CleanupOutcome::NotNeeded);
    assert!(result.effective.petdex_messages_enabled);
    assert!(!adapter.inner.enabled.load(Ordering::Acquire));
    assert!(adapter.next_message(Instant::now()).is_none());
    assert_eq!(adapter.shutdown_messages().await, CleanupOutcome::NotNeeded);
    drop(locked);

    let (_root, adapter) = self::adapter();
    adapter.set_message_preferences(MessagePreferences {
        petdex_messages_enabled: true,
        petdex_message_details_enabled: true,
    });
    let run = activity(&adapter);
    run.details(|d| d.title("Fixed test title"));
    let before = adapter.next_message(Instant::now()).unwrap();
    adapter
        .configure_messages(
            MessagePreferences {
                petdex_messages_enabled: true,
                petdex_message_details_enabled: false,
            },
            "en-US",
        )
        .await;
    assert!(adapter
        .inner
        .messages
        .lock()
        .unwrap()
        .pending
        .iter()
        .all(Option::is_none));
    let after = adapter.next_message(Instant::now()).unwrap();
    assert!(!adapter.pending_current(&before));
    assert!(before.fingerprint.message != after.fingerprint.message);
    adapter
        .configure_messages(
            MessagePreferences {
                petdex_messages_enabled: true,
                petdex_message_details_enabled: false,
            },
            "zh-CN",
        )
        .await;
    assert!(!adapter.pending_current(&after));
    let translated = adapter.next_message(Instant::now()).unwrap();
    assert!(translated.fingerprint.message != after.fingerprint.message);
}

#[test]
fn reconnect_discards_results_and_health_generation_does_not_refresh_accepted_body() {
    let (_root, adapter) = adapter();
    let mut run = activity(&adapter);
    adapter.inner.write_policy.lock().unwrap().observe(101);
    let first = adapter.next_message(Instant::now()).unwrap();
    adapter.inner.messages.lock().unwrap().record(
        &first,
        RequestResult::Applied,
        true,
        Instant::now(),
    );
    adapter.inner.write_policy.lock().unwrap().observe(101);
    assert!(adapter.next_message(Instant::now()).is_none());
    adapter.inner.write_policy.lock().unwrap().observe(102);
    assert!(adapter.next_message(Instant::now()).is_some());
    adapter.inner.messages.lock().unwrap().offline = true;
    run.transition(ActivityPhase::Failed);
    assert!(
        adapter.next_message(Instant::now()).is_none(),
        "offline failure cannot replay into an unused slot"
    );
}

#[test]
fn unsupported_is_independent_and_retries_only_on_new_service_generation() {
    let (_root, adapter) = adapter();
    let _run = activity(&adapter);
    let now = Instant::now();
    adapter.next_message(now).unwrap();
    adapter
        .inner
        .messages
        .lock()
        .unwrap()
        .diagnostic
        .unsupported = true;
    assert!(adapter.next_message(now).is_none());
    let before = adapter.status();
    adapter.inner.write_policy.lock().unwrap().observe(100);
    assert!(adapter.next_message(now).is_some());
    assert_eq!(
        before,
        adapter.status(),
        "message status does not mutate action diagnostics"
    );
}

#[test]
fn successful_restart_probe_drops_old_results_but_new_online_results_remain() {
    let (_root, adapter) = adapter();
    adapter.inner.write_policy.lock().unwrap().observe(101);
    adapter.reconcile_message_connection(RequestResult::Applied);
    let mut old = activity(&adapter);
    old.transition(ActivityPhase::Succeeded);
    assert!(adapter.next_message(Instant::now()).is_some());
    adapter.inner.write_policy.lock().unwrap().observe(102);
    adapter.reconcile_message_connection(RequestResult::Applied);
    assert!(adapter.next_message(Instant::now()).is_none());
    adapter.reconcile_message_connection(RequestResult::Transport);
    let mut offline = activity(&adapter);
    offline.transition(ActivityPhase::Failed);
    adapter.reconcile_message_connection(RequestResult::Applied);
    assert!(adapter.next_message(Instant::now()).is_none());
    let mut online = activity(&adapter);
    online.transition(ActivityPhase::Succeeded);
    assert!(
        adapter.next_message(Instant::now()).is_some(),
        "successful recovery must not discard future results indefinitely"
    );
}

#[test]
fn partial_receipts_remain_independent_and_failure_precedes_ordinary_update() {
    let (_root, adapter) = adapter();
    let _ordinary = activity(&adapter);
    let mut failed = activity(&adapter);
    adapter.next_message(Instant::now()).unwrap();
    failed.transition(ActivityPhase::Failed);
    let failure = adapter.next_message(Instant::now()).unwrap();
    assert_eq!(failure.slot, 1);
    adapter.inner.messages.lock().unwrap().record(
        &failure,
        RequestResult::Applied,
        true,
        Instant::now(),
    );
    let ordinary = adapter.next_message(Instant::now()).unwrap();
    assert_eq!(ordinary.slot, 0);
    adapter.inner.messages.lock().unwrap().record(
        &ordinary,
        RequestResult::Transport,
        true,
        Instant::now(),
    );
    let messages = adapter.inner.messages.lock().unwrap();
    assert!(messages.accepted[1].is_some());
    assert!(messages.accepted[0].is_none());
    assert_eq!(messages.diagnostic.accepted_count, 1);
}

#[test]
fn cleanup_requires_every_used_slot_and_does_not_hide_partial_failure() {
    let mut partial = CleanupProgress {
        remaining: 3,
        failed: false,
    };
    partial.record(RequestResult::Applied);
    assert_eq!(partial.outcome(), CleanupOutcome::Unconfirmed);
    partial.record(RequestResult::Transport);
    partial.record(RequestResult::Applied);
    assert_eq!(partial.outcome(), CleanupOutcome::Unconfirmed);
    let mut all = CleanupProgress {
        remaining: 2,
        failed: false,
    };
    all.record(RequestResult::Applied);
    all.record(RequestResult::Applied);
    assert_eq!(all.outcome(), CleanupOutcome::Accepted);
}

#[tokio::test(start_paused = true)]
async fn all_slots_share_one_budget_including_configuration_and_request_queue() {
    let (_root, adapter) = adapter();
    adapter.inner.messages.lock().unwrap().usage = [Usage {
        used: true,
        possibly_busy: true,
    }; 3];
    let configuration = adapter.inner.configuration_lock.lock().await;
    let began = tokio::time::Instant::now();
    assert_eq!(
        adapter.shutdown_messages().await,
        CleanupOutcome::Unconfirmed
    );
    assert_eq!(began.elapsed(), super::super::STATE_ATTEMPT_TIMEOUT);
    assert_eq!(
        adapter.status().status,
        crate::petdex::PetdexConnectionStatus::Disabled
    );
    drop(configuration);
    assert_eq!(adapter.shutdown_messages().await, CleanupOutcome::NotNeeded);

    let (_root, adapter) = self::adapter();
    adapter.inner.messages.lock().unwrap().usage = [Usage {
        used: true,
        possibly_busy: true,
    }; 3];
    let request = adapter.inner.request_lock.lock().await;
    let began = tokio::time::Instant::now();
    let response = adapter
        .configure_messages(MessagePreferences::default(), "en-US")
        .await;
    assert_eq!(response.cleanup_outcome, CleanupOutcome::Unconfirmed);
    assert!(!response.effective.petdex_messages_enabled);
    assert_eq!(began.elapsed(), super::super::STATE_ATTEMPT_TIMEOUT);
    drop(request);
    assert!(adapter.next_message(Instant::now()).is_none());
}

#[tokio::test]
async fn cancelled_queued_send_and_expired_result_cannot_read_token_or_send() {
    let (_root, adapter) = adapter();
    let mut run = activity(&adapter);
    let pending = adapter.next_message(Instant::now()).unwrap();
    let request = adapter.inner.request_lock.lock().await;
    adapter.set_message_preferences(MessagePreferences::default());
    tokio::time::timeout(Duration::from_millis(100), adapter.deliver_message(pending))
        .await
        .unwrap();
    drop(request);
    assert_eq!(adapter.message_diagnostic().accepted_count, 0);
    adapter.set_message_preferences(MessagePreferences {
        petdex_messages_enabled: true,
        petdex_message_details_enabled: false,
    });
    run.transition(ActivityPhase::Succeeded);
    let pending = adapter.next_message(Instant::now()).unwrap();
    assert!(!adapter.message_snapshot_is_current(
        &pending.snapshot,
        pending.slot,
        adapter.service_generation(),
        Instant::now() + Duration::from_secs(2)
    ));
}

#[tokio::test(start_paused = true)]
async fn historical_busy_slots_never_trigger_recovery_when_messages_default_to_disabled() {
    let (_root, adapter) = adapter();
    adapter.set_message_preferences(MessagePreferences::default());
    adapter.inner.messages.lock().unwrap().usage = [Usage {
        used: true,
        possibly_busy: true,
    }; 3];
    let request = adapter.inner.request_lock.lock().await;
    let began = tokio::time::Instant::now();
    assert_eq!(adapter.shutdown_messages().await, CleanupOutcome::NotNeeded);
    assert_eq!(began.elapsed(), Duration::ZERO);
    drop(request);
    assert!(adapter
        .inner
        .messages
        .lock()
        .unwrap()
        .usage
        .iter()
        .all(|u| u.possibly_busy));
}

#[tokio::test]
async fn action_that_expires_behind_shared_lock_is_never_sent_late() {
    let (_root, adapter) = adapter();
    let request = adapter.inner.request_lock.lock().await;
    let command = crate::petdex::types::StateCommand {
        state: crate::petdex::types::PetdexState::Jumping,
        expires_at: Some(Instant::now() + Duration::from_millis(10)),
    };
    let other = adapter.clone();
    let cancellation = adapter.cancellation_token();
    let send = tokio::spawn(async move { other.apply_state(command, cancellation).await });
    tokio::time::sleep(Duration::from_millis(25)).await;
    drop(request);
    assert_eq!(send.await.unwrap(), RequestResult::Expired);
}

#[tokio::test]
async fn late_blocking_settlement_cannot_clear_new_busy_version() {
    let (_root, adapter) = adapter();
    let mut installation = adapter.inner.message_installation.lock().unwrap();
    installation
        .as_mut()
        .unwrap()
        .attempt_version(0, false, 1)
        .unwrap();
    let other = adapter.clone();
    let task = tokio::spawn(async move {
        other
            .installation_settled(0, None, 1, CancellationToken::new())
            .await
    });
    tokio::task::yield_now().await;
    installation
        .as_mut()
        .unwrap()
        .attempt_version(0, true, 2)
        .unwrap();
    drop(installation);
    assert!(matches!(task.await.unwrap(), Err(RequestFailure::Expired)));
    assert!(
        adapter
            .inner
            .message_installation
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .usage()[0]
            .possibly_busy
    );

    let cancellation = CancellationToken::new();
    cancellation.cancel();
    assert!(matches!(
        adapter.installation_settled(0, None, 2, cancellation).await,
        Err(RequestFailure::Disabled)
    ));
    assert!(
        adapter
            .inner
            .message_installation
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .usage()[0]
            .possibly_busy
    );
}

#[tokio::test(start_paused = true)]
async fn newer_configuration_cancels_older_cleanup_before_reopening() {
    let (_root, adapter) = adapter();
    adapter.inner.messages.lock().unwrap().usage[0] = Usage {
        used: true,
        possibly_busy: true,
    };
    let request = adapter.inner.request_lock.lock().await;
    let closing = adapter.configure_messages(MessagePreferences::default(), "en-US");
    tokio::pin!(closing);
    tokio::select! { biased; _ = &mut closing => panic!("cleanup waits for lock"), _ = tokio::task::yield_now() => {} }
    let opened = adapter
        .configure_messages(
            MessagePreferences {
                petdex_messages_enabled: true,
                petdex_message_details_enabled: false,
            },
            "en-US",
        )
        .await;
    assert!(opened.effective.petdex_messages_enabled);
    assert_eq!(closing.await.cleanup_outcome, CleanupOutcome::Unconfirmed);
    drop(request);
    assert!(
        adapter
            .inner
            .coordinator
            .lock()
            .unwrap()
            .arbiter
            .message_preferences
            .petdex_messages_enabled
    );
}

#[cfg(target_os = "macos")]
#[tokio::test]
#[ignore = "explicit installed Petdex production bubble/settlement acceptance; no service lifecycle changes"]
async fn installed_petdex_accepts_three_production_slots_and_bounded_close() {
    assert_eq!(
        std::env::var("SHELLSPAN_PETDEX_MESSAGE_E2E").as_deref(),
        Ok("1")
    );
    let home = std::path::PathBuf::from(std::env::var_os("HOME").unwrap());
    let adapter = PetdexAdapter::new(home);
    adapter
        .check_protocol_compatibility()
        .await
        .ok()
        .expect("anonymous native contract");
    let pid = adapter.inner.write_policy.lock().unwrap().pid_for_test();
    let process = std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "comm="])
        .output()
        .unwrap();
    assert!(process.status.success());
    assert_eq!(
        String::from_utf8(process.stdout).unwrap().trim(),
        "/Applications/Petdex.app/Contents/MacOS/petdex-desktop-native"
    );
    let directory = std::path::PathBuf::from("/tmp/shellspan-petdex-stage9-live");
    adapter.initialize_messages(&directory);
    let _ = adapter.prepare_coordinator().unwrap();
    adapter
        .configure_messages(
            MessagePreferences {
                petdex_messages_enabled: true,
                petdex_message_details_enabled: false,
            },
            "zh-CN",
        )
        .await;
    let guards: Vec<_> = (0..3).map(|_| activity(&adapter)).collect();
    for _ in 0..3 {
        let pending = adapter
            .next_message(Instant::now())
            .expect("current production message");
        tokio::time::sleep_until(tokio::time::Instant::from_std(pending.due)).await;
        adapter.deliver_message(pending).await;
    }
    let accepted = adapter.message_diagnostic().accepted_count;

    // Exercise the real wall clock and production configuration queue. No
    // replacement server or traffic flood is needed to consume the deadline.
    let configuration = adapter.inner.configuration_lock.lock().await;
    let began = Instant::now();
    let blocked = adapter
        .configure_messages(MessagePreferences::default(), "zh-CN")
        .await;
    let blocked_elapsed = began.elapsed();
    drop(configuration);

    adapter
        .configure_messages(
            MessagePreferences {
                petdex_messages_enabled: true,
                petdex_message_details_enabled: false,
            },
            "zh-CN",
        )
        .await;
    let configuration = adapter.inner.configuration_lock.lock().await;
    let closing = adapter.clone();
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let partial_close = tokio::spawn(async move {
        let began = Instant::now();
        let _ = started_tx.send(());
        let result = closing
            .configure_messages(MessagePreferences::default(), "zh-CN")
            .await;
        (result, began.elapsed())
    });
    started_rx.await.unwrap();
    // Leave less than the two 100ms write intervals needed for three slots.
    tokio::time::sleep(Duration::from_millis(1325)).await;
    drop(configuration);
    let (partial, partial_elapsed) = partial_close.await.unwrap();
    let settled_slots = adapter
        .inner
        .message_installation
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .usage()
        .iter()
        .filter(|usage| usage.used && !usage.possibly_busy)
        .count();
    let disabled_has_pending = adapter.next_message(Instant::now()).is_some();

    // Always repair this test installation's used slots before checking the
    // timing assertions; a busy desktop must not leave test bubbles busy.
    adapter
        .configure_messages(
            MessagePreferences {
                petdex_messages_enabled: true,
                petdex_message_details_enabled: false,
            },
            "zh-CN",
        )
        .await;
    let response = adapter
        .configure_messages(MessagePreferences::default(), "zh-CN")
        .await;
    let usage = adapter
        .inner
        .message_installation
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .usage();
    adapter.shutdown_messages().await;
    drop(guards);
    let request = adapter.inner.request_lock.lock().await;
    let disabled_health =
        tokio::time::timeout(Duration::from_millis(100), adapter.check_health()).await;
    drop(request);
    let disabled_without_request_lock = matches!(
        disabled_health,
        Ok(crate::petdex::types::PetdexHealth::Disabled)
    );
    serde_json::to_writer_pretty(
        std::fs::File::create("/tmp/petdex-stage11-live-budget.json").unwrap(),
        &serde_json::json!({
            "blockedCloseElapsedMs": blocked_elapsed.as_millis(),
            "partialCloseElapsedMs": partial_elapsed.as_millis(),
            "settledSlotsBeforeDeadline": settled_slots,
            "blockedOutcome": blocked.cleanup_outcome,
            "partialOutcome": partial.cleanup_outcome,
            "finalCleanupOutcome": response.cleanup_outcome,
            "disabledWithoutRequestLock": disabled_without_request_lock,
            "disabledHasPendingMessage": disabled_has_pending,
            "finalSlotsSettled": usage.iter().all(|u| u.used && !u.possibly_busy),
        }),
    )
    .unwrap();
    assert_eq!(blocked.cleanup_outcome, CleanupOutcome::Unconfirmed);
    assert!(!blocked.effective.petdex_messages_enabled);
    assert!(blocked_elapsed >= Duration::from_millis(1500));
    assert!(blocked_elapsed < Duration::from_millis(1750));
    assert_eq!(partial.cleanup_outcome, CleanupOutcome::Unconfirmed);
    assert!(!partial.effective.petdex_messages_enabled);
    assert!(partial_elapsed >= Duration::from_millis(1500));
    assert!(partial_elapsed < Duration::from_millis(1750));
    assert!((1..3).contains(&settled_slots));
    assert!(!disabled_has_pending);
    assert!(disabled_without_request_lock);
    assert_eq!(
        accepted, 3,
        "production HTTP receipts, not display confirmation"
    );
    assert_eq!(response.cleanup_outcome, CleanupOutcome::Accepted);
    assert!(usage.iter().all(|u| u.used && !u.possibly_busy));
    assert!(!response.effective.petdex_messages_enabled);
    assert_eq!(
        adapter.check_health().await,
        crate::petdex::types::PetdexHealth::Disabled
    );
}
