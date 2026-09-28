//! Policy inspection utilities.  Durable Agent state is owned by SessionStore.
use crate::agent_runtime::{
    AgentEffectKindNative, AgentNetworkDestinationNative, AgentObservedEffectNative,
    AgentPermissionModeNative, AgentToolCallNative, ApplyPatchArgumentsNative,
    EditFileArgumentsNative, ListDirectoryArgumentsNative, ProbeHttpArgumentsNative,
    ReadFileArgumentsNative, SearchTextArgumentsNative, TransferDirectionNative,
    TransferFileArgumentsNative, TrashFileArgumentsNative, WriteFileArgumentsNative,
};
use serde_json::Value;

/// Full access skips per-call approval, but does not bypass native deny rules.
/// Conservative fallback; native automatic review may authorize a scoped read
/// through a constrained driver, never an arbitrary shell or stdin execution.
pub(crate) fn requires_call_confirmation_native(
    mode: AgentPermissionModeNative,
    tool: &str,
    effect: AgentEffectKindNative,
    sensitive_paths: usize,
) -> bool {
    if mode == AgentPermissionModeNative::Operator {
        return false;
    }
    if matches!(tool, "kill_process" | "wait_process") {
        // The execution kernel still validates ownership. Stopping or observing
        // an already authorized process must not be blocked by another approval.
        return false;
    }
    if mode == AgentPermissionModeNative::RequestApproval
        || matches!(
            tool,
            "exec_command"
                | "terminal_execute"
                | "write_terminal_input"
                | "write_stdin"
                | "call_mcp_tool"
        )
        || sensitive_paths > 0
    {
        return true;
    }
    match mode {
        AgentPermissionModeNative::RequestApproval => true,
        AgentPermissionModeNative::ScopedAutopilot => effect != AgentEffectKindNative::ReadOnly,
        AgentPermissionModeNative::Operator => false,
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CallPolicyScopeNative {
    pub(crate) paths: Vec<String>,
    pub(crate) network_destinations: Vec<AgentNetworkDestinationNative>,
    pub(crate) sensitive_path_count: usize,
    pub(crate) critical_path_count: usize,
    pub(crate) unknown_write: bool,
}
pub(crate) fn current_unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub(crate) fn inspect_call_policy_scope_native(
    call: &AgentToolCallNative,
) -> Result<CallPolicyScopeNative, String> {
    let paths = match call.tool_name.as_str() {
        "trash_file" => vec![
            serde_json::from_value::<TrashFileArgumentsNative>(call.arguments.clone())
                .map_err(|_| "trash_file policy arguments were invalid".to_string())?
                .path,
        ],
        "read_file" => vec![
            serde_json::from_value::<ReadFileArgumentsNative>(call.arguments.clone())
                .map_err(|_| "read_file policy arguments were invalid".to_string())?
                .path,
        ],
        "list_directory" => vec![
            serde_json::from_value::<ListDirectoryArgumentsNative>(call.arguments.clone())
                .map_err(|_| "list_directory policy arguments were invalid".to_string())?
                .path,
        ],
        "search_text" => vec![
            serde_json::from_value::<SearchTextArgumentsNative>(call.arguments.clone())
                .map_err(|_| "search_text policy arguments were invalid".to_string())?
                .path,
        ],
        "write_file" => vec![
            serde_json::from_value::<WriteFileArgumentsNative>(call.arguments.clone())
                .map_err(|_| "write_file policy arguments were invalid".to_string())?
                .path,
        ],
        "edit_file" => vec![
            serde_json::from_value::<EditFileArgumentsNative>(call.arguments.clone())
                .map_err(|_| "edit_file policy arguments were invalid".to_string())?
                .path,
        ],
        "apply_patch" => {
            serde_json::from_value::<ApplyPatchArgumentsNative>(call.arguments.clone())
                .map_err(|_| "apply_patch policy arguments were invalid".to_string())?
                .preconditions
                .into_iter()
                .map(|p| p.path)
                .collect()
        }
        "transfer_file" => {
            let a = serde_json::from_value::<TransferFileArgumentsNative>(call.arguments.clone())
                .map_err(|_| "transfer_file policy arguments were invalid".to_string())?;
            let crate::agent_runtime::AgentToolTargetNative::Remote {
                root_path,
                local_root,
                ..
            } = &call.target
            else {
                return Err("transfer_file requires remote and local roots".into());
            };
            match a.direction {
                TransferDirectionNative::Upload => vec![
                    qualify_local_path(local_root.as_deref(), &a.source_path),
                    qualify_remote_path(root_path.as_deref(), &a.destination_path),
                ],
                TransferDirectionNative::Download => vec![
                    qualify_remote_path(root_path.as_deref(), &a.source_path),
                    qualify_local_path(local_root.as_deref(), &a.destination_path),
                ],
            }
        }
        _ => Vec::new(),
    };
    let paths: Vec<String> = paths
        .into_iter()
        .map(|path| {
            if call.tool_name == "transfer_file" {
                path
            } else {
                match &call.target {
                    crate::agent_runtime::AgentToolTargetNative::Local {
                        cwd: Some(root), ..
                    } if !std::path::Path::new(&path).is_absolute() => std::path::Path::new(root)
                        .join(path)
                        .to_string_lossy()
                        .into_owned(),
                    crate::agent_runtime::AgentToolTargetNative::Remote {
                        root_path: Some(root),
                        ..
                    } if !path.starts_with('/') => format!("{}/{path}", root.trim_end_matches('/')),
                    _ => path,
                }
            }
        })
        .collect();
    let network_destinations = match call.tool_name.as_str() {
        "diagnose_endpoint" => {
            let arguments: crate::agent_runtime::DiagnoseEndpointArguments =
                serde_json::from_value(call.arguments.clone())
                    .map_err(|_| "invalid diagnostic destination".to_string())?;
            vec![AgentNetworkDestinationNative {
                protocol: match arguments.protocol {
                    crate::agent_runtime::EndpointProtocol::Tcp => "tcp",
                    crate::agent_runtime::EndpointProtocol::Tls => "tls",
                    crate::agent_runtime::EndpointProtocol::Http => "http",
                    crate::agent_runtime::EndpointProtocol::Https => "https",
                }
                .into(),
                host: arguments.host,
                port: arguments.port,
            }]
        }
        "probe_http" => {
            let arguments =
                serde_json::from_value::<ProbeHttpArgumentsNative>(call.arguments.clone())
                    .map_err(|_| "probe_http policy arguments were invalid".to_string())?;
            vec![AgentNetworkDestinationNative {
                protocol: "http".into(),
                host: "127.0.0.1".into(),
                port: arguments.port,
            }]
        }
        _ => Vec::new(),
    };
    let sensitive_path_count = paths.iter().filter(|p| path_is_sensitive_native(p)).count();
    let critical_path_count = paths.iter().filter(|p| path_is_critical_native(p)).count();
    Ok(CallPolicyScopeNative {
        paths,
        network_destinations,
        sensitive_path_count,
        critical_path_count,
        unknown_write: matches!(
            call.tool_name.as_str(),
            "exec_command" | "terminal_execute" | "write_terminal_input"
        ),
    })
}

fn qualify_local_path(root: Option<&str>, path: &str) -> String {
    if let Some(root) = root {
        std::path::Path::new(root)
            .join(path)
            .to_string_lossy()
            .into_owned()
    } else {
        path.into()
    }
}

fn qualify_remote_path(root: Option<&str>, path: &str) -> String {
    if path.starts_with('/') || root.is_none() {
        path.into()
    } else {
        format!(
            "{}/{}",
            root.unwrap_or_default().trim_end_matches('/'),
            path
        )
    }
}
pub(crate) fn path_is_sensitive_native(path: &str) -> bool {
    let p = path.replace('\\', "/").to_ascii_lowercase();
    p.contains(".env")
        || p.contains(".ssh")
        || p.contains(".aws")
        || p.contains(".gnupg")
        || p.contains(".kube")
        || p.contains(".azure")
        || p.contains("credential")
        || p.contains("/keychains/")
        || p.split('/').any(|part| {
            matches!(
                part,
                ".zshrc"
                    | ".bashrc"
                    | ".bash_profile"
                    | ".profile"
                    | ".npmrc"
                    | ".netrc"
                    | ".pypirc"
                    | ".bash_history"
                    | ".zsh_history"
                    | ".shellspan"
            )
        })
        || p.contains("secret")
        || p.ends_with(".pem")
        || p.ends_with(".key")
        || p.ends_with(".pfx")
        || p.ends_with(".p12")
        || p == "/etc/shadow"
}
fn path_is_critical_native(path: &str) -> bool {
    protected_delete_path_native(path)
}
pub(crate) fn enforce_native_call_policy_native(
    call: &AgentToolCallNative,
    effect: &AgentObservedEffectNative,
    scope: &CallPolicyScopeNative,
) -> Result<(), String> {
    if matches!(call.tool_name.as_str(), "exec_command" | "terminal_execute") {
        if let Some(command) = call.arguments.get("command").and_then(Value::as_str) {
            let cwd = match (&call.target, call.tool_name.as_str()) {
                (
                    crate::agent_runtime::AgentToolTargetNative::Local { cwd, .. },
                    "exec_command",
                ) => cwd.as_deref(),
                // A visible shell or remote SSH command does not inherit the
                // structured-file root as its working directory.
                _ => None,
            };
            super::shell_guard::reject_destructive(command, cwd)?;
        }
    }
    if call.tool_name == "terminal_execute"
        && matches!(
            effect.kind,
            AgentEffectKindNative::SensitiveRead
                | AgentEffectKindNative::Destructive
                | AgentEffectKindNative::ExternalSideEffect
        )
    {
        return Err(
            "native policy requires Direct execution for security-sensitive command lifecycle evidence"
                .into(),
        );
    }
    let critical_write = if call.tool_name == "transfer_file" {
        // Both upload and download write their destination, even when overwrite
        // is false. A protected read source is not itself a protected mutation.
        scope
            .paths
            .get(1)
            .is_some_and(|path| path_is_critical_native(path))
    } else {
        scope.critical_path_count > 0
            && matches!(
                effect.kind,
                AgentEffectKindNative::StateChange | AgentEffectKindNative::Destructive
            )
    };
    if critical_write {
        return Err("AGENT_CRITICAL_OPERATION_DENIED: native policy rejects state changes on critical paths".into());
    }
    Ok(())
}

#[cfg(test)]
fn reject_literal_destructive_command(script: &str) -> Result<(), String> {
    super::shell_guard::reject_destructive(script, None)
}

pub(crate) fn protected_delete_path_native(path: &str) -> bool {
    let path = path.replace('\\', "/");
    let path = path.trim_end_matches('/');
    path.is_empty()
        || matches!(path, "/var" | "/private/var")
        || [
            "/etc",
            "/bin",
            "/sbin",
            "/usr",
            "/System",
            "/Library",
            "/dev",
            "/proc",
            "/sys",
            "/boot",
            "/private/etc",
            "/var/lib",
            "/var/db",
            "/private/var/db",
        ]
        .iter()
        .any(|root| path == *root || path.starts_with(&format!("{root}/")))
        || path.eq_ignore_ascii_case("C:")
        || path.eq_ignore_ascii_case("C:/Windows")
        || path.to_ascii_lowercase().starts_with("c:/windows/")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runtime::AgentToolTargetNative;
    use serde_json::json;

    #[test]
    fn transfers_protect_the_write_destination_without_blocking_read_sources() {
        let root = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(root.path()).unwrap();
        let mut call = terminal_call();
        call.tool_name = "transfer_file".into();
        call.target = AgentToolTargetNative::Remote {
            target_id: "remote".into(),
            session_id: "terminal".into(),
            profile_id: Some("profile".into()),
            host: "localhost".into(),
            port: 22,
            username: "operator".into(),
            root_path: Some("/etc".into()),
            local_root: Some(root.to_string_lossy().into()),
        };
        let registry = super::super::ToolRegistryNative::from_builtin_manifest().unwrap();
        for overwrite in [false, true] {
            call.arguments = json!({"direction":"download", "sourcePath":"hosts", "destinationPath":"hosts.backup", "overwrite":overwrite});
            let scope = inspect_call_policy_scope_native(&call).unwrap();
            let effect = super::super::assess_effect_native(
                &registry.executable("transfer_file").unwrap().descriptor,
                &call,
            )
            .unwrap();
            assert_eq!(
                scope.paths,
                vec![
                    "/etc/hosts".to_string(),
                    root.join("hosts.backup").to_string_lossy().into_owned()
                ]
            );
            assert!(enforce_native_call_policy_native(&call, &effect, &scope).is_ok());
            call.arguments = json!({"direction":"upload", "sourcePath":"hosts.backup", "destinationPath":"hosts", "overwrite":overwrite});
            let scope = inspect_call_policy_scope_native(&call).unwrap();
            let effect = super::super::assess_effect_native(
                &registry.executable("transfer_file").unwrap().descriptor,
                &call,
            )
            .unwrap();
            assert_eq!(
                scope.paths,
                vec![
                    root.join("hosts.backup").to_string_lossy().into_owned(),
                    "/etc/hosts".to_string()
                ]
            );
            assert!(enforce_native_call_policy_native(&call, &effect, &scope).is_err());
            let system_destination = if cfg!(windows) {
                "C:/Windows/System32/config/SYSTEM"
            } else {
                "/etc/hosts"
            };
            call.arguments = json!({"direction":"download", "sourcePath":"hosts", "destinationPath":system_destination, "overwrite":overwrite});
            let scope = inspect_call_policy_scope_native(&call).unwrap();
            let effect = super::super::assess_effect_native(
                &registry.executable("transfer_file").unwrap().descriptor,
                &call,
            )
            .unwrap();
            assert!(enforce_native_call_policy_native(&call, &effect, &scope).is_err());
        }
    }

    #[test]
    fn full_access_skips_approval_and_other_modes_gate_unisolated_execution() {
        for mode in [
            AgentPermissionModeNative::RequestApproval,
            AgentPermissionModeNative::ScopedAutopilot,
            AgentPermissionModeNative::Operator,
        ] {
            for tool in [
                "exec_command",
                "terminal_execute",
                "write_terminal_input",
                "write_stdin",
                "call_mcp_tool",
            ] {
                for effect in [
                    AgentEffectKindNative::ReadOnly,
                    AgentEffectKindNative::StateChange,
                    AgentEffectKindNative::Destructive,
                    AgentEffectKindNative::ExternalSideEffect,
                ] {
                    assert_eq!(
                        requires_call_confirmation_native(mode, tool, effect, 0),
                        mode != AgentPermissionModeNative::Operator,
                        "{mode:?} {tool} {effect:?}"
                    );
                }
            }
            for tool in ["wait_process", "kill_process"] {
                assert!(!requires_call_confirmation_native(
                    mode,
                    tool,
                    AgentEffectKindNative::StateChange,
                    0
                ));
            }
        }
    }

    #[test]
    fn full_access_skips_sensitive_file_approval_but_other_modes_do_not() {
        for (tool, effect) in [
            ("read_file", AgentEffectKindNative::SensitiveRead),
            ("write_file", AgentEffectKindNative::StateChange),
            ("trash_file", AgentEffectKindNative::Destructive),
        ] {
            assert!(!requires_call_confirmation_native(
                AgentPermissionModeNative::Operator,
                tool,
                effect,
                0
            ));
            assert!(!requires_call_confirmation_native(
                AgentPermissionModeNative::Operator,
                tool,
                effect,
                1
            ));
            assert!(requires_call_confirmation_native(
                AgentPermissionModeNative::RequestApproval,
                tool,
                effect,
                0
            ));
        }
        assert!(!requires_call_confirmation_native(
            AgentPermissionModeNative::ScopedAutopilot,
            "list_directory",
            AgentEffectKindNative::ReadOnly,
            0
        ));
        assert!(requires_call_confirmation_native(
            AgentPermissionModeNative::ScopedAutopilot,
            "trash_file",
            AgentEffectKindNative::Destructive,
            0
        ));
    }

    #[test]
    fn literal_system_deletion_is_rejected_without_running_a_command() {
        for command in [
            "rm -rf /",
            "pwd && /bin/rm -rf /etc",
            "unlink /etc/passwd",
            "rmdir /System/Library",
            "mkfs.ext4 /dev/sda",
            "wipefs /dev/sda",
            "sudo -n rm -rf /etc",
            "env command /bin/rm /etc/passwd",
            "timeout 5 rm -rf /",
        ] {
            assert!(
                reject_literal_destructive_command(command)
                    .unwrap_err()
                    .starts_with("AGENT_CRITICAL_OPERATION_DENIED"),
                "{command}"
            );
        }
        for command in ["echo rm /etc/passwd", "rm ./old.txt", "ls /etc"] {
            assert!(
                reject_literal_destructive_command(command).is_ok(),
                "{command}"
            );
        }
    }

    #[test]
    fn relative_sensitive_paths_are_classified_against_the_frozen_root() {
        let mut call = terminal_call();
        call.tool_name = "trash_file".into();
        call.arguments = json!({"path":".ssh/id_rsa", "expectedSha256":"0".repeat(64)});
        let scope = inspect_call_policy_scope_native(&call).unwrap();
        assert_eq!(scope.sensitive_path_count, 1);
        assert!(scope.paths[0].ends_with(".ssh/id_rsa"));
    }

    fn terminal_call() -> AgentToolCallNative {
        AgentToolCallNative {
            request_id: "request-policy".into(),
            call_id: "call-policy".into(),
            tool_name: "terminal_execute".into(),
            arguments: json!({
                "command": "cat ~/.ssh/id_ed25519",
                "explanation": "inspect a sensitive value"
            }),
            target: AgentToolTargetNative::Local {
                target_id: "target-policy".into(),
                session_id: "terminal-policy".into(),
                cwd: Some("/workspace".into()),
            },
            capability_id: "pending-native-capability".into(),
        }
    }

    fn effect(kind: AgentEffectKindNative) -> AgentObservedEffectNative {
        AgentObservedEffectNative {
            kind,
            target_id: "target-policy".into(),
            summary: "classified for test".into(),
            paths: Vec::new(),
            network_destinations: Vec::new(),
        }
    }

    #[test]
    fn terminal_execute_cannot_bypass_direct_lifecycle_policy() {
        let call = terminal_call();
        let scope = inspect_call_policy_scope_native(&call).unwrap();
        for kind in [
            AgentEffectKindNative::SensitiveRead,
            AgentEffectKindNative::Destructive,
            AgentEffectKindNative::ExternalSideEffect,
        ] {
            assert!(
                enforce_native_call_policy_native(&call, &effect(kind), &scope,)
                    .unwrap_err()
                    .contains("requires Direct execution")
            );
        }
        assert!(enforce_native_call_policy_native(
            &call,
            &effect(AgentEffectKindNative::StateChange),
            &scope,
        )
        .is_ok());
    }

    #[test]
    fn direct_network_commands_retain_external_effect_without_claiming_a_sandbox() {
        let mut call = terminal_call();
        call.tool_name = "exec_command".into();
        call.arguments = json!({
            "command": "curl http://127.0.0.1:18765/",
            "explanation": "verify a loopback service"
        });
        let scope = inspect_call_policy_scope_native(&call).unwrap();
        let effect = effect(AgentEffectKindNative::ExternalSideEffect);
        assert!(scope.network_destinations.is_empty());
        assert!(enforce_native_call_policy_native(&call, &effect, &scope).is_ok());
    }

    #[test]
    fn structured_http_probe_has_exact_loopback_scope() {
        let mut call = terminal_call();
        call.tool_name = "probe_http".into();
        call.arguments = json!({
            "method": "get",
            "port": 18765,
            "path": "/index.html",
            "timeoutMs": 2_000,
            "maxBytes": 65_536
        });
        let scope = inspect_call_policy_scope_native(&call).unwrap();
        assert_eq!(
            scope.network_destinations,
            [AgentNetworkDestinationNative {
                protocol: "http".into(),
                host: "127.0.0.1".into(),
                port: 18765,
            }]
        );
        assert!(enforce_native_call_policy_native(
            &call,
            &effect(AgentEffectKindNative::ExternalSideEffect),
            &scope,
        )
        .is_ok());
    }
}
