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
        let (name, arguments) = normalize_arguments(
            &visible,
            &target,
            Some(TerminalVisibleCommandRoute::LegacyFallback),
            false,
        )
        .unwrap();
        assert_eq!(name, "exec_command");
        assert_eq!(arguments["channel"], "pty");
        assert_eq!(arguments["background"], false);
        assert_eq!(arguments["elevated"], false);

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
    fn visible_command_routes_additively_to_terminal_execute_without_reinterpreting_pty() {
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
        .contains("legacy fallback is disabled"));
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
