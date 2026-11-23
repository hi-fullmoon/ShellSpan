    use super::*;
    use crate::agent_runtime::{AgentExecutionSurface, ModelToolCall};

    #[test]
    fn long_goal_with_default_success_criteria_remains_a_valid_native_request() {
        let goal = "界".repeat(800);
        let mut native = AgentRequestNative {
            contract_version: NATIVE_TOOL_CONTRACT_VERSION,
            request_id: "long-goal-request".into(),
            user_session_id: "long-goal-session".into(),
            task_id: "long-goal-task".into(),
            goal: goal.clone(),
            success_criteria: vec![goal.clone()],
            targets: vec![AgentToolTargetNative::Local {
                target_id: "long-goal-target".into(),
                session_id: "long-goal-terminal".into(),
                cwd: None,
            }],
            permission_mode: AgentPermissionModeNative::RequestApproval,
        };
        assert!(crate::agent_runtime::validate_agent_request_native(&native).is_err());
        native.success_criteria = native_success_criteria(&goal, &[]);
        assert!(crate::agent_runtime::validate_agent_request_native(&native).is_ok());
        assert_eq!(native.goal, goal, "the frozen goal must not be truncated");
        assert_eq!(
            native.permission_mode,
            AgentPermissionModeNative::RequestApproval
        );
    }

    #[test]
    fn native_criteria_projection_preserves_explicit_criteria_and_short_defaults() {
        let criteria = vec!["Keep the requested exact result".into()];
        assert_eq!(
            native_success_criteria(&"g".repeat(8_192), &criteria),
            criteria
        );
        let boundary = "g".repeat(2_048);
        assert_eq!(native_success_criteria(&boundary, &[]), vec![boundary]);
    }

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
            remote_sandbox_required: None,
            local_sandbox_required: None,
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
            remote_sandbox_required: None,
            local_sandbox_required: None,
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
            scratch_target: local_target(),
            permission_mode: AgentSessionPermissionMode::RequestApproval,
            execution_surface: AgentExecutionSurface::Direct,
        }
    }

    #[test]
    fn configured_sudo_resolution_requires_the_exact_host_operation_and_current_revision() {
        use crate::models::{ProfileAuthMethod, ProfileRow};
        use crate::sudo_policy::{SaveProfileSudoPolicy, SudoOperation, SudoRunner};
        let temp = tempfile::tempdir().unwrap();
        let database = Database::open(&temp.path().join("db")).unwrap();
        let target = target_native(&remote_target()).unwrap();
        let profile = ProfileRow {
            id: "profile-remote".into(),
            name: "Remote".into(),
            host: "fixture.example".into(),
            port: 22,
            username: "tester".into(),
            auth_method: ProfileAuthMethod::Password,
            keychain_key_id: None,
            jump_host_config: None,
            organization_json: None,
            created_at: 1,
            updated_at: 1,
        };
        database.insert_profile(&profile).unwrap();
        let other = ProfileRow {
            id: "other".into(),
            ..profile.clone()
        };
        database.insert_profile(&other).unwrap();
        let input = json!({"sudoOperationId":"check-backup","explanation":"Verify backup"});
        assert!(normalize_sudo_operation(&database, &input, &target).is_err());
        let policy = database.profile_sudo_policy(&profile.id).unwrap();
        database
            .save_profile_sudo_policy(
                &profile.id,
                SaveProfileSudoPolicy {
                    profile_binding: policy.profile_binding,
                    revision: policy.revision,
                    runner: Some(SudoRunner {
                        port: 2223,
                        username: "shellspan-runner".into(),
                        host_key_sha256: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
                            .into(),
                    }),
                    operations: vec![SudoOperation {
                        id: "check-backup".into(),
                        label: "Check backups".into(),
                        command: "/usr/local/sbin/check-backup 'weekly primary'".into(),
                    }],
                },
            )
            .unwrap();
        let mut injection = input.clone();
        injection["command"] = json!("/usr/bin/id");
        assert!(normalize_sudo_operation(&database, &injection, &target).is_err());
        let mut unconfigured = remote_target();
        unconfigured.profile_id = Some(other.id);
        assert!(normalize_sudo_operation(
            &database,
            &input,
            &target_native(&unconfigured).unwrap()
        )
        .is_err());

        let resolved = normalize_sudo_operation(&database, &input, &target).unwrap();
        assert_eq!(
            resolved["command"],
            "/usr/local/sbin/check-backup 'weekly primary'"
        );
        let grant: crate::agent_runtime::ExecCommandArgumentsNative =
            serde_json::from_value(resolved).unwrap();
        crate::sudo_policy::verify_grant(&database, &target, &grant).unwrap();
        let mut forged = grant.clone();
        forged.command = "/usr/bin/id".into();
        assert!(crate::sudo_policy::verify_grant(&database, &target, &forged).is_err());

        let saved = database.profile_sudo_policy(&profile.id).unwrap();
        database
            .save_profile_sudo_policy(
                &profile.id,
                SaveProfileSudoPolicy {
                    profile_binding: saved.profile_binding,
                    revision: saved.revision,
                    runner: saved.runner,
                    operations: vec![],
                },
            )
            .unwrap();
        assert!(crate::sudo_policy::verify_grant(&database, &target, &grant).is_err());
        assert!(normalize_sudo_operation(&database, &input, &target).is_err());
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
    fn complete_scripts_preserve_the_selected_surface_and_original_arguments() {
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
                    let target = target_native(&call.target).unwrap();
                    if surface == AgentExecutionSurface::BoundTerminal {
                        assert!(!terminal_command_requires_direct_lifecycle(&call).unwrap());
                        let (name, arguments) = normalize_arguments(
                            &call,
                            &target,
                            Some(TerminalVisibleCommandRoute::TerminalExecute),
                            false,
                        )
                        .unwrap();
                        assert_eq!(name, "terminal_execute");
                        assert_eq!(arguments["command"], command);
                        assert_eq!(arguments["timeoutMs"], 12000);
                        crate::agent_runtime::validate_tool_arguments_native(&name, &arguments)
                            .unwrap();
                        continue;
                    }
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
        assert!(!terminal_command_requires_direct_lifecycle(&background).unwrap());
        let (name, arguments) = normalize_arguments(
            &background,
            &owner,
            Some(TerminalVisibleCommandRoute::TerminalExecute),
            false,
        )
        .unwrap();
        assert_eq!(name, "exec_command");
        assert_eq!(arguments["channel"], "direct");
        assert_eq!(arguments["background"], true);
        assert_eq!(arguments["cwd"], "/workspace");
        assert_eq!(arguments["timeoutMs"], 120_000);

        let remote_with_profile = target_native(&remote_target()).unwrap();
        background.target = remote_target();
        let (name, arguments) = normalize_arguments(
            &background,
            &remote_with_profile,
            Some(TerminalVisibleCommandRoute::TerminalExecute),
            false,
        )
        .unwrap();
        assert_eq!(name, "exec_command");
        assert_eq!(arguments["channel"], "direct");
        assert_eq!(arguments["background"], true);

        let mut profileless = remote_target();
        profileless.profile_id = None;
        let remote_without_profile = target_native(&profileless).unwrap();
        background.target = profileless;
        let (name, arguments) = normalize_arguments(
            &background,
            &remote_without_profile,
            Some(TerminalVisibleCommandRoute::TerminalExecute),
            false,
        )
        .unwrap();
        assert_eq!(name, "terminal_execute");
        assert_eq!(arguments["background"], true);

        background.target = local_target();
        background.execution_surface = AgentExecutionSurface::Direct;
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
    fn remote_visible_normalization_rejects_required_direct_without_fallback() {
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

        let error = normalize_arguments(
            &visible,
            &target,
            Some(TerminalVisibleCommandRoute::TerminalExecute),
            true,
        )
        .unwrap_err();
        assert!(error.contains("TERMINAL_DIRECT_REQUIRED"));
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
        let mut fresh = request(
            "write_terminal_input",
            json!({ "inputKind": "text", "text": "pwd\n" }),
        );
        fresh.execution_surface = AgentExecutionSurface::BoundTerminal;
        let (_, normalized) = normalize_arguments(&fresh, &target, None, false).unwrap();
        assert_eq!(normalized["text"], "pwd\n");
        for name in [
            "write_terminal_input",
            "wait_terminal",
            "write_process_input",
            "run_terminal_command",
            "exec_command",
        ] {
            let receipt = request(
                name,
                json!({"historicalInput": {"available": false, "replayable": false}}),
            );
            assert!(normalize_arguments(&receipt, &target, None, false)
                .unwrap_err()
                .starts_with("ephemeralInputUnavailable:"));
        }
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
    fn visible_sensitive_commands_keep_terminal_and_explicit_lifecycle_is_rejected() {
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
            let required = terminal_command_requires_direct_lifecycle(&visible).unwrap();
            if required {
                assert!(normalize_arguments(&visible, &target, None, false)
                    .unwrap_err()
                    .contains("TERMINAL_DIRECT_REQUIRED"));
            } else {
                let (name, _) = normalize_arguments(
                    &visible,
                    &target,
                    Some(TerminalVisibleCommandRoute::TerminalExecute),
                    false,
                )
                .unwrap();
                assert_eq!(name, "terminal_execute");
            }
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
    fn local_and_remote_visible_routes_never_fall_back_to_direct() {
        for session_target in [local_target(), remote_target()] {
            let mut raw = request(
                "exec_command",
                json!({"command": "pwd", "explanation": "raw direct call", "channel": "direct"}),
            );
            raw.execution_surface = AgentExecutionSurface::BoundTerminal;
            raw.target = session_target.clone();
            assert!(
                normalize_arguments(&raw, &target_native(&raw.target).unwrap(), None, false)
                    .unwrap_err()
                    .contains("TERMINAL_DIRECT_REQUIRED")
            );
            for command in [
                "pwd",
                "export DEMO=value",
                "alias ll='ls -l'",
                "curl https://example.test",
                "rm ./example",
                "cat ~/.ssh/id_ed25519",
            ] {
                let mut call = request(
                    "run_terminal_command",
                    json!({
                        "command": command, "explanation": "verify frozen routing", "timeoutMs": 1234
                    }),
                );
                call.target = session_target.clone();
                call.execution_surface = AgentExecutionSurface::BoundTerminal;
                let target = target_native(&call.target).unwrap();
                assert!(!terminal_command_requires_direct_lifecycle(&call).unwrap());
                let (name, args) = normalize_arguments(
                    &call,
                    &target,
                    Some(TerminalVisibleCommandRoute::TerminalExecute),
                    false,
                )
                .unwrap();
                assert_eq!(name, "terminal_execute");
                assert_eq!(args["timeoutMs"], 1234);
                assert!(normalize_arguments(&call, &target, None, false).is_err());
                call.execution_surface = AgentExecutionSurface::Direct;
                assert_eq!(
                    normalize_arguments(&call, &target, None, false).unwrap().0,
                    "exec_command"
                );
            }
            for command in ["sleep 1 &", "(sleep 1 &)"] {
                let mut call = request(
                    "run_terminal_command",
                    json!({"command": command, "explanation": "reject unmanaged jobs"}),
                );
                call.target = session_target.clone();
                call.execution_surface = AgentExecutionSurface::BoundTerminal;
                // Shell-specific syntax is checked against the bound shell at
                // the input endpoint, not with Bash grammar in this facade.
                assert!(!terminal_command_requires_direct_lifecycle(&call).unwrap());
                assert_eq!(
                    normalize_arguments(
                        &call,
                        &target_native(&call.target).unwrap(),
                        Some(TerminalVisibleCommandRoute::TerminalExecute),
                        false
                    )
                    .unwrap()
                    .0,
                    "terminal_execute"
                );
            }
        }
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

    #[test]
    fn process_results_validate_native_identity_before_projecting_the_frozen_host() {
        for prefix in ["job", "proc"] {
            let handle = format!("{prefix}-{}", "a".repeat(32));
            let host = target_native(&local_target()).unwrap();
            let call = request("wait_process", json!({"processHandle": handle}));
            let native = process_target_for_model_call(&call.model_call, &host)
                .unwrap()
                .unwrap();
            assert_eq!(
                project_native_result_target(&native, native.target_id(), host.target_id())
                    .unwrap(),
                host.target_id()
            );
            assert!(
                project_native_result_target(&native, "forged-target", host.target_id()).is_err()
            );
            assert!(
                project_native_result_target(&native, native.target_id(), "other-host").is_err()
            );
        }
        let host = target_native(&local_target()).unwrap();
        assert_eq!(
            project_native_result_target(&host, host.target_id(), host.target_id()).unwrap(),
            host.target_id()
        );
        assert!(project_native_result_target(&host, "forged-target", host.target_id()).is_err());
    }
