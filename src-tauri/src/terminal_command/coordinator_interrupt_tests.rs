use super::*;

// Broker/coordinator unit fixtures only; no native acceptance evidence.
fn submitted() -> NativeInputCoordinator {
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
    {
        let mut data = operation.lock().unwrap();
        data.native_protocol = true;
        data.lifecycle.apply(CommandEvent::ConfirmInput).unwrap();
        data.lifecycle
            .apply(CommandEvent::AttemptSubmission)
            .unwrap();
    }
    let operation = Arc::new(operation);
    {
        let mut state = broker.lock().unwrap();
        let record = state
            .sessions
            .get_mut(&attachment.terminal_session_id)
            .unwrap();
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
        operation,
        requests: HashMap::new(),
        receipts: HashMap::new(),
        deadline: None,
        interrupt_before_start_deadline: None,
    }
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
            let mut state = coordinator.broker.lock().unwrap();
            let record = state.sessions.values_mut().next().unwrap();
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
