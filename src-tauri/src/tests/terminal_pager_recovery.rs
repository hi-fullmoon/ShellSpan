fn verify_native_pager_recovery(
    broker: &crate::terminal_broker::TerminalSessionBroker,
    commands: &crate::agent_runtime::TerminalExecuteRegistry,
    sessions: &crate::models::SessionManager,
    leases: &crate::agent_runtime::TerminalLeaseManager,
    transport: &str,
    shell: TerminalShellKind,
) {
    use crate::agent_runtime::{TerminalInteractiveInputKindNative, TerminalInteractiveRegistry};
    use crate::terminal_broker::{
        TerminalCommandState, TerminalLeaseOwner, TerminalWaitReason, TerminalWaitRequest,
    };

    let interactive = TerminalInteractiveRegistry::new(leases.clone(), broker.clone());
    let repository = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let source = format!(
        "GIT_PAGER='less -+F -+X' git -C {} log --oneline -5",
        shell_single_quote(repository.to_str().unwrap())
    );
    let operation = commands
        .start(
            sessions,
            transport,
            "typing-agent",
            "typing-task",
            "pager-command",
            &source,
            shell.enter(),
        )
        .unwrap();
    let screen = interactive
        .wait(
            transport,
            TerminalWaitRequest {
                after_screen_version: None,
                after_output_sequence: None,
                after_lifecycle_sequence: None,
                text: Some("(END)".into()),
                case_sensitive: true,
                idle: None,
                timeout: Duration::from_secs(5),
            },
        )
        .unwrap();
    assert_eq!(
        screen.reason,
        TerminalWaitReason::TextFound,
        "pager did not render its end marker: {:?}",
        screen.snapshot
    );
    // An active command observer keeps exclusive control. It must retire before
    // another tool can send input, even for the same Agent/task.
    assert_eq!(
        interactive
            .write(
                sessions,
                transport,
                "typing-agent",
                "typing-task",
                TerminalInteractiveInputKindNative::Text,
                Some("q"),
                None,
            )
            .unwrap_err(),
        "TERMINAL_INTERACTIVE_NOT_AT_SHELL_BOUNDARY"
    );
    let result = commands
        .wait(sessions, transport, &operation, Duration::from_millis(50))
        .unwrap();
    assert_eq!(result.state, TerminalCommandState::Uncertain);
    let terminal = broker.snapshot(Some(transport)).unwrap().session.unwrap();
    assert!(!terminal.prompt_ready, "less must still own the foreground");
    assert!(terminal.active_command_id.is_none());
    assert!(matches!(
        terminal.lease.unwrap().owner,
        TerminalLeaseOwner::User { .. }
    ));

    let receipt = interactive
        .write(
            sessions,
            transport,
            "typing-agent",
            "typing-task",
            TerminalInteractiveInputKindNative::Text,
            Some("q"),
            None,
        )
        .unwrap();
    assert_eq!(receipt.accepted_bytes, 1);
    wait_for_prompt(broker, transport);
    assert_eq!(
        interactive
            .release_at_prompt(transport, "another-agent", "typing-task")
            .unwrap_err(),
        "TERMINAL_INTERACTIVE_BUSY"
    );
    interactive
        .release_at_prompt(transport, "typing-agent", "typing-task")
        .unwrap();
    assert!(!interactive.has_operation(transport).unwrap());
    // Quitting the pager does not rewrite the earlier uncertain result.
    assert_eq!(
        operation.snapshot().unwrap().state,
        TerminalCommandState::Uncertain
    );
    let next = commands
        .start(
            sessions,
            transport,
            "typing-agent",
            "typing-task",
            "after-pager-command",
            "printf pager-recovery-complete",
            shell.enter(),
        )
        .unwrap();
    let result = commands
        .wait(sessions, transport, &next, Duration::from_secs(5))
        .unwrap();
    assert_eq!(result.state, TerminalCommandState::Completed);
    assert_eq!(result.exit_code, Some(0));
    assert!(result.combined_output.contains("pager-recovery-complete"));
    wait_for_prompt(broker, transport);
    interactive.release_turn("typing-agent").unwrap();
    leases.release_turn("typing-agent").unwrap();
}
