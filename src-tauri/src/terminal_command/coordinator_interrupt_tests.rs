use super::*;

// Broker/coordinator unit fixtures only; no native acceptance evidence.
fn claimed() -> NativeInputCoordinator {
    let broker = TerminalSessionBroker::enabled_for_test(512, 1048576, 1048576);
    let attachment = broker
        .attach_transport(
            "stop-unit",
            None,
            TerminalTransportKind::LocalPty,
            TerminalGeometry::new(80, 24),
        )
        .unwrap()
        .unwrap();
    let mut operation = TerminalCommandOperation::new(
        attachment.terminal_session_id.clone(),
        attachment.terminal_generation,
        "stop-operation".into(),
        "unit source".into(),
        None,
        1,
        1024,
        broker.counters.clone(),
    );
    operation.broker_state = Arc::downgrade(&broker.state);
    operation.lock().unwrap().native_protocol = true;
    let operation = Arc::new(operation);
    {
        let state = broker.lock().unwrap();
        let slot = state
            .sessions
            .get(&attachment.terminal_session_id)
            .cloned()
            .unwrap();
        drop(state);
        let mut record = slot.lock().unwrap();
        record.active_command = Some(operation.clone());
        record.lease = Some(TerminalLeaseSnapshot {
            lease_id: "unit-lease".into(),
            revision: 1,
            owner: TerminalLeaseOwner::Agent {
                owner_id: "unit-agent".into(),
                agent_session_id: "unit-agent".into(),
                task_id: "unit-task".into(),
                operation_id: "stop-operation".into(),
            },
        });
    }
    NativeInputCoordinator {
        broker,
        transport: "stop-unit".into(),
        accept_key: b"\x18a",
        operation,
        requests: HashMap::new(),
        receipts: HashMap::new(),
        deadline: None,
        interrupt_before_start_deadline: None,
        #[cfg(all(
            feature = "native-input-acceptance",
            debug_assertions,
            target_os = "macos",
            target_arch = "aarch64"
        ))]
        readonly_first_partial: None,
    }
}

fn submitted() -> NativeInputCoordinator {
    let coordinator = claimed();
    {
        let mut data = coordinator.operation.lock().unwrap();
        data.lifecycle.apply(CommandEvent::ConfirmInput).unwrap();
        data.lifecycle
            .apply(CommandEvent::AttemptSubmission)
            .unwrap();
    }
    coordinator
}

fn started(coordinator: &NativeInputCoordinator) {
    coordinator
        .operation
        .lock()
        .unwrap()
        .lifecycle
        .apply(CommandEvent::Started)
        .unwrap();
}

#[test]
fn accepted_stop_interrupts_once_more_only_after_started_without_settling() {
    for reason in [
        TerminalCommandRequestedSettlement::Cancelled,
        TerminalCommandRequestedSettlement::TakenOver,
    ] {
        let mut coordinator = submitted();
        let mut writes = 0;
        let deadline = Instant::now() + Duration::from_secs(2);
        assert!(coordinator
            .interrupt(reason, deadline, || {
                writes += 1;
                Ok(())
            })
            .unwrap());
        assert!(!coordinator
            .interrupt_after_started(|| panic!("not started"))
            .unwrap());
        assert!(!coordinator
            .interrupt(reason, deadline + Duration::from_secs(30), || panic!(
                "duplicate stop"
            ))
            .unwrap());
        assert_eq!(coordinator.interrupt_before_start_deadline, Some(deadline));
        started(&coordinator);
        assert!(coordinator
            .interrupt_after_started(|| {
                writes += 1;
                Ok(())
            })
            .unwrap());
        assert!(!coordinator
            .interrupt_after_started(|| panic!("second follow-up"))
            .unwrap());
        assert_eq!(writes, 2);
        let data = coordinator.operation.lock().unwrap();
        assert_eq!(data.lifecycle.phase(), CommandPhase::CancelRequested);
        assert_eq!(data.lifecycle.requested_settlement(), Some(reason));
        assert!(data.lifecycle.started() && !data.lifecycle.ended());
        assert!(!data.native_editor_ready_confirmed);
    }
}

#[test]
fn running_stop_does_not_repeat_interrupt() {
    let mut coordinator = submitted();
    started(&coordinator);
    assert!(coordinator
        .interrupt(
            TerminalCommandRequestedSettlement::Cancelled,
            Instant::now() + Duration::from_secs(2),
            || Ok(())
        )
        .unwrap());
    assert!(!coordinator
        .interrupt_after_started(|| panic!("already running at first stop"))
        .unwrap());
}

#[test]
fn cancel_after_unconfirmed_takeover_preserves_recovery_without_another_interrupt() {
    let mut coordinator = submitted();
    started(&coordinator);
    let deadline = Instant::now() + Duration::from_secs(2);
    assert!(coordinator
        .interrupt(
            TerminalCommandRequestedSettlement::TakenOver,
            deadline,
            || Ok(())
        )
        .unwrap());
    coordinator
        .broker
        .require_native_input_recovery("stop-unit", "stop-operation")
        .unwrap();
    assert!(coordinator
        .broker
        .release_agent_lease("stop-unit", "unit-agent", "unit-task", "stop-operation")
        .unwrap());
    let before = coordinator
        .broker
        .snapshot(Some("stop-unit"))
        .unwrap()
        .session
        .unwrap();

    assert!(!coordinator
        .interrupt(
            TerminalCommandRequestedSettlement::Cancelled,
            deadline,
            || { panic!("a duplicate stop must not send Ctrl+C after takeover") }
        )
        .unwrap());

    let after = coordinator
        .broker
        .snapshot(Some("stop-unit"))
        .unwrap()
        .session
        .unwrap();
    assert!(matches!(
        after.lease.unwrap().owner,
        TerminalLeaseOwner::User { .. }
    ));
    assert_eq!(after.next_input_sequence, before.next_input_sequence);
    assert!(after.input_observation.native_recovery_required);
    assert!(coordinator.operation.native_observation_pending().unwrap());
    let command = after.input_observation.active_command.unwrap();
    assert_eq!(command.operation_id, "stop-operation");
    assert_eq!(command.phase, CommandPhase::Uncertain);
    assert!(command.may_have_submitted && command.no_auto_replay);
}

#[test]
fn cancel_again_after_takeover_before_input_does_not_require_a_lease() {
    let mut coordinator = claimed();
    coordinator
        .cancel_draft_for(TerminalCommandRequestedSettlement::TakenOver, |_| {
            panic!("no draft was enqueued")
        })
        .unwrap();
    assert!(coordinator
        .broker
        .release_agent_lease("stop-unit", "unit-agent", "unit-task", "stop-operation")
        .unwrap());

    coordinator
        .cancel_draft_for(TerminalCommandRequestedSettlement::Cancelled, |_| {
            panic!("the cancelled operation must not clear the user's editor")
        })
        .unwrap();
    assert!(coordinator
        .operation
        .takeover_settled_before_submission()
        .unwrap());
}

#[test]
fn first_stop_still_requires_the_original_lease() {
    let mut coordinator = submitted();
    started(&coordinator);
    assert!(coordinator
        .broker
        .release_agent_lease("stop-unit", "unit-agent", "unit-task", "stop-operation")
        .unwrap());
    let error = coordinator
        .interrupt(
            TerminalCommandRequestedSettlement::Cancelled,
            Instant::now() + Duration::from_secs(2),
            || panic!("an old command must not interrupt under a user lease"),
        )
        .unwrap_err();
    assert_eq!(error, "TERMINAL_BROKER_STALE_LEASE");
    assert_eq!(
        coordinator.operation.snapshot().unwrap().phase,
        CommandPhase::Running
    );
}

#[test]
fn expired_ended_and_unknown_stops_never_send_late_interrupts() {
    for boundary in ["expired", "ended", "unknown"] {
        let mut coordinator = submitted();
        let deadline = if boundary == "expired" {
            Instant::now()
        } else {
            Instant::now() + Duration::from_secs(2)
        };
        coordinator
            .interrupt(
                TerminalCommandRequestedSettlement::Cancelled,
                deadline,
                || Ok(()),
            )
            .unwrap();
        started(&coordinator);
        if boundary != "expired" {
            coordinator
                .operation
                .lock()
                .unwrap()
                .lifecycle
                .apply(if boundary == "ended" {
                    CommandEvent::Settled
                } else {
                    CommandEvent::StopUnconfirmed
                })
                .unwrap();
        }
        let before = coordinator.operation.snapshot().unwrap();
        assert!(!coordinator
            .interrupt_after_started(|| panic!("late interrupt: {boundary}"))
            .unwrap());
        assert_eq!(
            coordinator.operation.snapshot().unwrap().phase,
            before.phase
        );
    }
}

#[test]
fn follow_up_revalidates_generation_operation_and_owner() {
    for changed in ["generation", "operation", "owner"] {
        let mut coordinator = submitted();
        coordinator
            .interrupt(
                TerminalCommandRequestedSettlement::Cancelled,
                Instant::now() + Duration::from_secs(2),
                || Ok(()),
            )
            .unwrap();
        started(&coordinator);
        {
            let state = coordinator.broker.lock().unwrap();
            let slot = state.sessions.values().next().cloned().unwrap();
            drop(state);
            let mut record = slot.lock().unwrap();
            match changed {
                "generation" => record.terminal_generation += 1,
                "operation" => record.active_command = None,
                _ => record.lease = Some(user_lease(3)),
            }
        }
        assert!(coordinator
            .interrupt_after_started(|| panic!("stale {changed}"))
            .is_err());
        assert!(!coordinator
            .interrupt_after_started(|| panic!("consumed stale stop"))
            .unwrap());
    }
}

#[test]
fn failed_follow_up_is_not_retried_or_treated_as_end() {
    let mut coordinator = submitted();
    coordinator
        .interrupt(
            TerminalCommandRequestedSettlement::Cancelled,
            Instant::now() + Duration::from_secs(2),
            || Ok(()),
        )
        .unwrap();
    started(&coordinator);
    assert_eq!(
        coordinator.interrupt_after_started(|| Err("partial write".into())),
        Err("partial write".into())
    );
    assert!(!coordinator
        .interrupt_after_started(|| panic!("partial write replay"))
        .unwrap());
    assert_eq!(
        coordinator.operation.snapshot().unwrap().phase,
        CommandPhase::CancelRequested
    );
}

#[test]
fn only_a_matching_started_receipt_enables_follow_up() {
    let mut coordinator = submitted();
    coordinator
        .requests
        .insert("prepare", "unit-prepare".into());
    coordinator
        .interrupt(
            TerminalCommandRequestedSettlement::Cancelled,
            Instant::now() + Duration::from_secs(2),
            || Ok(()),
        )
        .unwrap();
    let message = Envelope {
        protocol: nip::PROTOCOL.into(),
        identity: coordinator.identity().unwrap(),
        request_id: "unit-prepare".into(),
        payload: Payload::Started,
    };
    let mut stale = message.clone();
    stale.identity.source_revision += 1;
    assert!(coordinator.receive_envelope(stale).is_err());
    assert!(!coordinator
        .interrupt_after_started(|| panic!("foreign identity"))
        .unwrap());
    let mut stale = message.clone();
    stale.request_id = "foreign-prepare".into();
    assert!(coordinator.receive_envelope(stale).is_err());
    assert!(!coordinator
        .interrupt_after_started(|| panic!("foreign request"))
        .unwrap());
    coordinator.receive_envelope(message.clone()).unwrap();
    assert!(coordinator.interrupt_after_started(|| Ok(())).unwrap());
    coordinator.receive_envelope(message).unwrap();
    assert!(!coordinator
        .interrupt_after_started(|| panic!("duplicate Started"))
        .unwrap());
}

#[test]
fn control_closed_finalizes_capture_and_clears_native_observation_pending() {
    let coordinator = submitted();
    coordinator
        .operation
        .mark_retained_for_late_receipts()
        .unwrap();
    coordinator.control_closed().unwrap();
    assert!(coordinator.operation.native_capture_complete().unwrap());
    assert!(!coordinator.operation.native_observation_pending().unwrap());
    assert!(coordinator.operation.retained_and_settled().unwrap());
}
