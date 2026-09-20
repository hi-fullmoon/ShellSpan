    use super::*;
    use crate::agent_runtime::{AgentExecutionSurface, ModelToolCall};

    fn local_target() -> AgentSessionTarget {
        AgentSessionTarget {
            kind: "local".into(),
            target_id: "target-local".into(),
            session_id: "terminal-local".into(),
            label: Some("Local".into()),
            profile_id: None,
            host: None,
            port: None,
            username: None,
            cwd: Some("/workspace".into()),
            root_path: None,
            local_root: None,
        }
    }

    fn remote_target() -> AgentSessionTarget {
        AgentSessionTarget {
            kind: "remote".into(),
            target_id: "target-remote".into(),
            session_id: "user-owned-remote-terminal".into(),
            label: Some("Remote".into()),
            profile_id: Some("profile-remote".into()),
            host: Some("fixture.example".into()),
            port: Some(22),
            username: Some("tester".into()),
            cwd: None,
            root_path: None,
            local_root: None,
        }
    }

    fn request(name: &str, arguments: Value) -> NativeToolRequest {
        NativeToolRequest {
            session_id: "session-native".into(),
            task_id: "task-native".into(),
            goal: "inspect safely".into(),
            success_criteria: vec!["evidence recorded".into()],
            turn_id: "turn-native".into(),
            step_id: "step-native".into(),
            request_id: "request-native".into(),
            model_call: ModelToolCall {
                call_id: "call-native".into(),
                provider_call_id: Some("provider-native".into()),
                name: name.into(),
                arguments,
            },
            target: local_target(),
            permission_mode: AgentSessionPermissionMode::RequestApproval,
            execution_surface: AgentExecutionSurface::Direct,
        }
    }

    #[test]
    fn terminal_alias_is_strict_and_cannot_supply_effect_or_execution_policy() {
        let target = target_native(&local_target()).unwrap();
        let (name, arguments) = normalize_arguments(
            &request(
                "run_terminal_command",
                json!({ "command": "pwd", "explanation": "inspect" }),
            ),
            &target,
            None,
            false,
        )
        .unwrap();
        assert_eq!(name, "exec_command");
        assert_eq!(arguments["channel"], "direct");
        assert_eq!(arguments["cwd"], "/workspace");
        assert_eq!(arguments["background"], false);
        assert_eq!(arguments["elevated"], false);

        let mut visible = request(
            "run_terminal_command",
            json!({ "command": "pwd", "explanation": "inspect visibly" }),
        );
        visible.execution_surface = AgentExecutionSurface::BoundTerminal;
        let error = normalize_arguments(
            &visible,
            &target,
            Some(TerminalVisibleCommandRoute::Unavailable),
            false,
        )
        .unwrap_err();
        assert_eq!(
            error,
            "TERMINAL_VISIBLE_COMMAND_UNAVAILABLE: cooperative terminal execution is not available"
        );

        assert!(normalize_arguments(
            &request(
                "run_terminal_command",
                json!({
                    "command": "pwd",
                    "explanation": "inspect",
                    "effect": "readOnly"
                }),
            ),
            &target,
            None,
            false,
        )
        .unwrap_err()
        .contains("schema rejected"));
    }

    #[test]
    fn terminal_alias_reports_actionable_utf8_byte_limit_errors() {
        let target = target_native(&local_target()).unwrap();
        let error = normalize_arguments(
            &request(
                "run_terminal_command",
                json!({
                    "command": "界".repeat(2_731),
                    "explanation": "write generated content"
                }),
            ),
            &target,
            None,
            false,
        )
        .unwrap_err();
        assert!(error.contains("8193 UTF-8 bytes exceeds the 8192-byte maximum"));
        assert!(error.contains("suggestedTool=write_file"));
        assert!(error.contains("use write_file"));
        assert!(error.contains("child Agents have the same limit"));

        let mut unrooted_request = request(
            "run_terminal_command",
            json!({
                "command": "x".repeat(8_193),
                "explanation": "write generated content"
            }),
        );
        unrooted_request.target = remote_target();
        let unrooted_target = target_native(&unrooted_request.target).unwrap();
        let error =
            normalize_arguments(&unrooted_request, &unrooted_target, None, false).unwrap_err();
        assert!(error.contains("suggestedAction=split_bounded_commands"));
        assert!(!error.contains("suggestedTool=write_file"));

        let mut profileless_rooted_request = request(
            "run_terminal_command",
            json!({
                "command": "x".repeat(8_193),
                "explanation": "write generated content"
            }),
        );
        let mut profileless_rooted = remote_target();
        profileless_rooted.profile_id = None;
        profileless_rooted.root_path = Some("/remote/workspace".into());
        profileless_rooted_request.target = profileless_rooted;
        let profileless_rooted_target = target_native(&profileless_rooted_request.target).unwrap();
        let error = normalize_arguments(
            &profileless_rooted_request,
            &profileless_rooted_target,
            None,
            false,
        )
        .unwrap_err();
        assert!(error.contains("suggestedAction=split_bounded_commands"));
        assert!(!error.contains("suggestedTool=write_file"));

        let error = normalize_arguments(
            &request(
                "run_terminal_command",
                json!({
                    "command": "pwd",
                    "explanation": "界".repeat(683)
                }),
            ),
            &target,
            None,
            false,
        )
        .unwrap_err();
        assert!(error.contains("2049 UTF-8 bytes exceeds the 2048-byte maximum"));

        let error = normalize_arguments(
            &request(
                "run_terminal_command",
                json!({
                    "command": "printf ok\u{001b}",
                    "explanation": "start and verify"
                }),
            ),
            &target,
            None,
            false,
        )
        .unwrap_err();
        assert!(error.contains("unsupported control character"));
        assert!(error.contains("doNotRetry=true"));
        assert!(error.contains("suggestedTool=write_file"));
        assert!(error.contains("do not use cat, echo, heredocs"));
        assert!(error.contains("use probe_http"));

        let mut unrooted_request = request(
            "run_terminal_command",
            json!({
                "command": "printf first\u{0000}",
                "explanation": "write generated content"
            }),
        );
        unrooted_request.target = remote_target();
        let unrooted_target = target_native(&unrooted_request.target).unwrap();
        let error =
            normalize_arguments(&unrooted_request, &unrooted_target, None, false).unwrap_err();
        assert!(error.contains("suggestedAction=split_bounded_commands"));
        assert!(!error.contains("suggestedTool=write_file"));
    }

    #[test]
    fn complete_scripts_always_use_direct_execution_and_preserve_arguments() {
        for command in [
            "pwd\nls",
            "cat <<'EOF'\nhello\nEOF",
            "printf\tvalue",
            "printf one\r\nprintf two",
        ] {
            for surface in [
                AgentExecutionSurface::Direct,
                AgentExecutionSurface::BoundTerminal,
            ] {
                for session_target in [local_target(), remote_target()] {
                    let mut call = request(
                        "run_terminal_command",
                        json!({"command": command, "explanation": "execute a complete script", "timeoutMs": 12000}),
                    );
                    call.execution_surface = surface;
                    call.target = session_target;
                    assert!(terminal_command_requires_direct_lifecycle(&call).unwrap());
                    let target = target_native(&call.target).unwrap();
                    // Normalization itself must preserve this invariant even if
                    // its caller has not precomputed the lifecycle requirement.
                    let (name, arguments) = normalize_arguments(
                        &call,
                        &target,
                        Some(TerminalVisibleCommandRoute::Unavailable),
                        false,
                    )
                    .unwrap();
                    assert_eq!(name, "exec_command");
                    assert_eq!(arguments["command"], command);
                    assert_eq!(arguments["timeoutMs"], 12000);
                    assert_eq!(arguments["channel"], "direct");
                    crate::agent_runtime::validate_tool_arguments_native(&name, &arguments)
                        .unwrap();
                }
            }
        }
    }

    #[test]
    fn background_commands_and_process_tools_use_native_process_handles() {
        let owner = target_native(&local_target()).unwrap();
        let mut background = request(
            "run_terminal_command",
            json!({
                "command": "node server.js",
                "explanation": "start the test server",
                "background": true,
                "timeoutMs": 120_000
            }),
        );
        background.execution_surface = AgentExecutionSurface::BoundTerminal;
        assert!(terminal_command_requires_direct_lifecycle(&background).unwrap());
        let (name, arguments) = normalize_arguments(&background, &owner, None, true).unwrap();
        assert_eq!(name, "exec_command");
        assert_eq!(arguments["background"], true);
        assert_eq!(arguments["timeoutMs"], 120_000);

        let handle = "proc-0123456789abcdef0123456789abcdef";
        for (name, arguments, native_name, native_arguments) in [
            (
                "write_process_input",
                json!({ "processHandle": handle, "input": "stop\n", "close": true }),
                "write_stdin",
                json!({ "input": "stop\n", "close": true }),
            ),
            (
                "wait_process",
                json!({ "processHandle": handle, "timeoutMs": 1_000 }),
                "wait_process",
                json!({ "timeoutMs": 1_000 }),
            ),
            (
                "kill_process",
                json!({ "processHandle": handle, "signal": "terminate" }),
                "kill_process",
                json!({ "signal": "terminate" }),
            ),
        ] {
            let model_request = request(name, arguments);
            let target = process_target_for_model_call(&model_request.model_call, &owner)
                .unwrap()
                .unwrap();
            assert!(matches!(
                &target,
                AgentToolTargetNative::Process {
                    owner_target_id,
                    process_handle,
                    ..
                } if owner_target_id == "target-local" && process_handle == handle
            ));
            let (normalized_name, normalized_arguments) =
                normalize_arguments(&model_request, &target, None, false).unwrap();
            assert_eq!(normalized_name, native_name);
            assert_eq!(normalized_arguments, native_arguments);
        }
    }

    #[test]
    fn remote_visible_normalization_is_additive_and_direct_policy_still_wins() {
        let target = target_native(&remote_target()).unwrap();
        let mut visible = request(
            "run_terminal_command",
            json!({ "command": "export PHASE4=kept", "explanation": "preserve remote state" }),
        );
        visible.target = remote_target();
        visible.execution_surface = AgentExecutionSurface::BoundTerminal;
        let (name, arguments) = normalize_arguments(
            &visible,
            &target,
            Some(TerminalVisibleCommandRoute::TerminalExecute),
            false,
        )
        .unwrap();
        assert_eq!(name, "terminal_execute");
        assert_eq!(arguments["command"], "export PHASE4=kept");
        assert!(arguments.get("channel").is_none());

        let (name, arguments) = normalize_arguments(
            &visible,
            &target,
            Some(TerminalVisibleCommandRoute::TerminalExecute),
            true,
        )
        .unwrap();
        assert_eq!(name, "exec_command");
        assert_eq!(arguments["channel"], "direct");
    }

    #[test]
    fn direct_native_tools_preserve_arguments_but_unknown_tools_fail_closed() {
        let target = target_native(&local_target()).unwrap();
        let arguments = json!({ "path": ".", "pageSize": 20 });
        assert_eq!(
            normalize_arguments(
                &request("list_directory", arguments.clone()),
                &target,
                None,
                false,
            )
            .unwrap(),
            ("list_directory".into(), arguments)
        );
        let mut visible_file = request("list_directory", json!({ "path": ".", "pageSize": 20 }));
        visible_file.execution_surface = AgentExecutionSurface::BoundTerminal;
        assert_eq!(
            normalize_arguments(&visible_file, &target, None, false).unwrap(),
            (
                "list_directory".into(),
                json!({ "path": ".", "pageSize": 20 })
            )
        );
        assert!(
            normalize_arguments(&request("browser_eval", json!({})), &target, None, false).is_err()
        );
        assert_eq!(
            stable_native_id("call", "same"),
            stable_native_id("call", "same")
        );
        assert_ne!(
            stable_native_id("call", "same"),
            stable_native_id("call", "other")
        );
    }

    #[test]
    fn omitted_history_input_is_rejected_before_native_dispatch() {
        let target = target_native(&local_target()).unwrap();
        for marker in [
            "[ephemeral terminal input omitted]",
            "[ephemeral terminal match text omitted]",
            "[ephemeral process input omitted]",
        ] {
            for (name, arguments) in [
                (
                    "write_terminal_input",
                    json!({ "inputKind": "text", "text": marker }),
                ),
                (
                    "write_terminal_input",
                    json!({ "inputKind": "paste", "text": format!("{marker}{marker}") }),
                ),
                (
                    "write_process_input",
                    json!({ "processHandle": "process-1", "input": marker }),
                ),
                (
                    "wait_terminal",
                    json!({ "text": marker, "timeoutMs": 1000 }),
                ),
                (
                    "run_terminal_command",
                    json!({ "command": format!("echo {marker}"), "explanation": "retry" }),
                ),
                ("exec_command", json!({ "command": marker })),
            ] {
                let mut call = request(name, arguments);
                call.execution_surface = AgentExecutionSurface::BoundTerminal;
                assert!(normalize_arguments(&call, &target, None, false)
                    .unwrap_err()
                    .starts_with("ephemeralInputUnavailable:"));
            }
        }
        let mut key = request(
            "write_terminal_input",
            json!({ "inputKind": "key", "key": "enter" }),
        );
        key.execution_surface = AgentExecutionSurface::BoundTerminal;
        assert!(normalize_arguments(&key, &target, None, false).is_ok());
    }

    #[test]
    fn interactive_terminal_tools_require_bound_surface_and_do_not_record_input_content() {
        let target = target_native(&local_target()).unwrap();
        let direct = request("read_terminal", json!({}));
        assert!(normalize_arguments(&direct, &target, None, false)
            .unwrap_err()
            .contains("bound-terminal"));

        let mut bound = request(
            "write_terminal_input",
            json!({ "inputKind": "text", "text": "ephemeral-value" }),
        );
        bound.execution_surface = AgentExecutionSurface::BoundTerminal;
        let (name, arguments) = normalize_arguments(&bound, &target, None, false).unwrap();
        assert_eq!(name, "write_terminal_input");
        assert_eq!(arguments["text"], "ephemeral-value");

        let recorded = recorded_native_arguments(&name, &arguments);
        assert_eq!(recorded["inputKind"], "text");
        assert_eq!(recorded["byteLength"], 15);
        assert_eq!(recorded["contentPersisted"], false);
        assert!(!recorded.to_string().contains("ephemeral-value"));
    }

    #[test]
    fn visible_command_routes_only_to_terminal_execute_when_available() {
        let target = target_native(&local_target()).unwrap();
        let mut visible = request(
            "run_terminal_command",
            json!({ "command": "cd /tmp", "explanation": "change current shell state" }),
        );
        visible.execution_surface = AgentExecutionSurface::BoundTerminal;

        let (name, arguments) = normalize_arguments(
            &visible,
            &target,
            Some(TerminalVisibleCommandRoute::TerminalExecute),
            false,
        )
        .unwrap();
        assert_eq!(name, "terminal_execute");
        assert_eq!(arguments["command"], "cd /tmp");
        assert!(arguments.get("channel").is_none());
        assert!(arguments.get("cwd").is_none());
        assert!(!arguments.to_string().contains("/bin/sh -c"));

        assert!(normalize_arguments(
            &visible,
            &target,
            Some(TerminalVisibleCommandRoute::Unavailable),
            false,
        )
        .unwrap_err()
        .contains("cooperative terminal execution is not available"));
    }

    #[test]
    fn visible_sensitive_and_explicit_untrusted_commands_are_forced_to_direct() {
        let target = target_native(&local_target()).unwrap();
        for arguments in [
            json!({
                "command": "cat ~/.ssh/id_ed25519",
                "explanation": "inspect a sensitive value"
            }),
            json!({
                "command": "./third-party-script",
                "explanation": "run an untrusted script",
                "lifecycleTrust": "directRequired"
            }),
        ] {
            let mut visible = request("run_terminal_command", arguments);
            visible.execution_surface = AgentExecutionSurface::BoundTerminal;
            assert!(terminal_command_requires_direct_lifecycle(&visible).unwrap());
            let (name, normalized) = normalize_arguments(&visible, &target, None, true).unwrap();
            assert_eq!(name, "exec_command");
            assert_eq!(normalized["channel"], "direct");
            assert!(normalized.get("lifecycleTrust").is_none());
        }

        let mut stateful = request(
            "run_terminal_command",
            json!({
                "command": "export DEMO=value",
                "explanation": "change the current interactive shell"
            }),
        );
        stateful.execution_surface = AgentExecutionSurface::BoundTerminal;
        assert!(!terminal_command_requires_direct_lifecycle(&stateful).unwrap());
        let (name, _) = normalize_arguments(
            &stateful,
            &target,
            Some(TerminalVisibleCommandRoute::TerminalExecute),
            false,
        )
        .unwrap();
        assert_eq!(name, "terminal_execute");
    }

    #[test]
    fn rooted_local_operator_commands_preserve_the_selected_terminal_surface() {
        let target = target_native(&local_target()).unwrap();
        let mut operator = request(
            "run_terminal_command",
            json!({
                "command": "printf updated > result.txt",
                "explanation": "write inside the frozen workspace"
            }),
        );
        operator.permission_mode = AgentSessionPermissionMode::Operator;
        operator.execution_surface = AgentExecutionSurface::BoundTerminal;

        let direct_required = terminal_command_requires_direct_lifecycle(&operator).unwrap();
        assert!(!direct_required);

        let (name, arguments) = normalize_arguments(
            &operator,
            &target,
            Some(TerminalVisibleCommandRoute::TerminalExecute),
            direct_required,
        )
        .unwrap();
        assert_eq!(name, "terminal_execute");
        assert_eq!(arguments["command"], "printf updated > result.txt");
    }
