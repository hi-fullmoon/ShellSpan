use super::{AgentExecutionSurface, AgentSandboxContract, AgentSandboxPolicy};

/// Native tools run in the application, outside a Shell's process sandbox.
/// Admission must name an implemented boundary at both prepare and dispatch.
pub(crate) fn require_native_tool_boundary(
    contract: Option<&AgentSandboxContract>,
    name: &str,
) -> Result<(), String> {
    let Some(contract) = contract else {
        return Ok(());
    };
    if contract.policy == AgentSandboxPolicy::Host {
        return Ok(());
    }
    if contract.target.kind == "remote" && contract.execution_surface == AgentExecutionSurface::Direct
        && matches!(name,"exec_command"|"write_stdin"|"wait_process"|"kill_process")
        && super::remote_seatbelt::authorize(contract).is_ok() {
        return Ok(());
    }
    if contract.target.kind == "local"
        && contract.execution_surface == AgentExecutionSurface::Direct
        && matches!(
            name,
            "exec_command" | "write_stdin" | "wait_process" | "kill_process" | "probe_http"
        )
    {
        // probe_http dispatch additionally checks a live, owned service relay.
        // Process controls additionally check the frozen process owner.
        return Ok(());
    }
    Err(
        "sandboxToolUnsupported: tool has no verified boundary for this execution host and policy"
            .into(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn structured_files_transfers_deployment_and_mcp_never_inherit_shell_isolation() {
        let project = tempfile::tempdir().unwrap();
        let target = serde_json::from_value(serde_json::json!({"kind":"local","targetId":"local","sessionId":"terminal","cwd":project.path()})).unwrap();
        let restricted = AgentSandboxContract::freeze(
            Some(AgentSandboxPolicy::Workspace),
            &target,
            AgentExecutionSurface::Direct,
            1,
        )
        .unwrap();
        let host = AgentSandboxContract::freeze(
            Some(AgentSandboxPolicy::Host),
            &target,
            AgentExecutionSurface::Direct,
            1,
        )
        .unwrap();
        for name in [
            "read_file",
            "list_directory",
            "search_text",
            "write_file",
            "edit_file",
            "apply_patch",
            "trash_file",
            "transfer_file",
            "inspect_host",
            "inspect_service",
            "query_logs",
            "diagnose_endpoint",
            "deploy",
            "terminal_execute",
            "read_terminal",
            "write_terminal_input",
            "mcp::server::tool",
        ] {
            assert!(
                require_native_tool_boundary(Some(&restricted), name).is_err(),
                "{name}"
            );
            require_native_tool_boundary(Some(&host), name).unwrap();
        }
        for name in [
            "exec_command",
            "write_stdin",
            "wait_process",
            "kill_process",
            "probe_http",
        ] {
            require_native_tool_boundary(Some(&restricted), name).unwrap();
        }
        let mut remote = restricted.clone();
        remote.target.kind = "remote".into();
        for name in [
            "exec_command",
            "probe_http",
            "transfer_file",
            "mcp::server::tool",
        ] {
            assert!(
                require_native_tool_boundary(Some(&remote), name).is_err(),
                "{name}"
            );
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn native_mcp_prepare_refuses_restricted_policy_before_config_or_process_access() {
        use crate::agent_runtime::{
            AgentPermissionModeNative, AgentRequestNative, NativeExecutionContext,
            NativeToolEngine, NATIVE_TOOL_CONTRACT_VERSION,
        };
        assert!(crate::agent_runtime::verify_native_sandbox_backend());
        let project = tempfile::tempdir().unwrap();
        let target: crate::agent_runtime::AgentSessionTarget = serde_json::from_value(serde_json::json!({"kind":"local","targetId":"local","sessionId":"unattached","cwd":project.path()})).unwrap();
        let contract = AgentSandboxContract::freeze(
            Some(AgentSandboxPolicy::Workspace),
            &target,
            AgentExecutionSurface::Direct,
            1,
        )
        .unwrap();
        let context = NativeExecutionContext {
            sandbox_contract: Some(contract),
            request: AgentRequestNative {
                contract_version: NATIVE_TOOL_CONTRACT_VERSION,
                request_id: "boundary-request".into(),
                user_session_id: "boundary-session".into(),
                task_id: "boundary-task".into(),
                goal: "Check native MCP boundary".into(),
                success_criteria: vec!["No MCP configuration read or process started".into()],
                targets: vec![crate::agent_runtime::AgentToolTargetNative::Local {
                    target_id: target.target_id,
                    session_id: target.session_id,
                    cwd: target.cwd,
                }],
                permission_mode: AgentPermissionModeNative::Operator,
            },
            turn_id: "turn".into(),
            step_id: "step".into(),
        };
        let database_root = tempfile::tempdir().unwrap();
        let database = crate::db::Database::open(&database_root.path().join("test.db")).unwrap();
        let engine = NativeToolEngine::default();
        let sessions = crate::models::SessionManager::default();
        let credentials = crate::keychain::CredentialManager::in_memory_for_tests();
        for name in [
            "read_file",
            "write_file",
            "apply_patch",
            "transfer_file",
            "inspect_host",
        ] {
            let native_target = context.request.targets[0].clone();
            let error = engine
                .prepare_authorization(
                    context.clone(),
                    crate::agent_runtime::AgentAuthorizeCallRequestNative {
                        request_id: context.request.request_id.clone(),
                        call_id: "boundary-call".into(),
                        tool_name: name.into(),
                        arguments: serde_json::json!({}),
                        target: native_target.clone(),
                        ttl_ms: None,
                    },
                    &sessions,
                    &database,
                    &credentials,
                    &database_root.path().join("known_hosts"),
                )
                .unwrap_err();
            assert!(
                error.starts_with("sandboxToolUnsupported:"),
                "prepare {name}: {error}"
            );
            // An unissued capability is actual rejected input, not an approved
            // transport substitute. Assert the tool boundary precedes it.
            let error = engine
                .execute_tool(
                    &context,
                    crate::agent_runtime::AgentToolCallNative {
                        request_id: context.request.request_id.clone(),
                        call_id: "boundary-call".into(),
                        tool_name: name.into(),
                        arguments: serde_json::json!({}),
                        target: native_target,
                        capability_id: "unissued".into(),
                    },
                    &sessions,
                    &database,
                    &credentials,
                    &database_root.path().join("known_hosts"),
                    &tokio_util::sync::CancellationToken::new(),
                )
                .unwrap_err();
            assert!(
                error.starts_with("sandboxToolUnsupported:"),
                "execute {name}: {error}"
            );
        }
        let error = NativeToolEngine::default()
            .prepare_mcp_authorization(
                context,
                "mcp-call".into(),
                "server",
                "tool",
                serde_json::json!({}),
                &crate::models::SessionManager::default(),
                &database,
            )
            .unwrap_err();
        assert!(error.starts_with("sandboxToolUnsupported:"), "{error}");
        assert_eq!(std::fs::read_dir(project.path()).unwrap().count(), 0);
    }
}
