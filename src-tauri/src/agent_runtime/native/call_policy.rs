//! Policy inspection utilities.  Durable Agent state is owned by SessionStore.
use crate::agent_runtime::{
    AgentEffectKindNative, AgentNetworkDestinationNative, AgentObservedEffectNative,
    AgentToolCallNative, ApplyPatchArgumentsNative, ListDirectoryArgumentsNative,
    ReadFileArgumentsNative, SearchTextArgumentsNative, TransferFileArgumentsNative,
};
use serde_json::Value;
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CallPolicyScopeNative {
    pub(crate) paths: Vec<String>,
    pub(crate) network_destinations: Vec<AgentNetworkDestinationNative>,
    pub(crate) sensitive_path_count: usize,
    pub(crate) critical_path_count: usize,
    pub(crate) unknown_write: bool,
    pub(crate) unknown_network_egress: bool,
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
            vec![a.source_path, a.destination_path]
        }
        "exec_command" => call
            .arguments
            .get("cwd")
            .and_then(Value::as_str)
            .map(|p| vec![p.to_string()])
            .unwrap_or_default(),
        _ => Vec::new(),
    };
    let sensitive_path_count = paths.iter().filter(|p| path_is_sensitive_native(p)).count();
    let critical_path_count = paths.iter().filter(|p| path_is_critical_native(p)).count();
    Ok(CallPolicyScopeNative {
        paths,
        network_destinations: Vec::new(),
        sensitive_path_count,
        critical_path_count,
        unknown_write: matches!(call.tool_name.as_str(), "exec_command" | "terminal_execute"),
        unknown_network_egress: call.arguments.get("command").is_some(),
    })
}
pub(crate) fn path_is_sensitive_native(path: &str) -> bool {
    let p = path.replace('\\', "/").to_ascii_lowercase();
    p.contains(".env")
        || p.contains(".ssh")
        || p.contains(".aws")
        || p.contains("secret")
        || p.ends_with(".pem")
        || p.ends_with(".key")
        || p == "/etc/shadow"
}
fn path_is_critical_native(path: &str) -> bool {
    let p = path.replace('\\', "/");
    p == "/"
        || p.starts_with("/dev/")
        || p.starts_with("/proc/")
        || p.starts_with("/sys/")
        || p == "/etc/shadow"
}
pub(crate) fn enforce_native_call_policy_native(
    call: &AgentToolCallNative,
    effect: &AgentObservedEffectNative,
    scope: &CallPolicyScopeNative,
) -> Result<(), String> {
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
    if scope.critical_path_count > 0
        && matches!(
            effect.kind,
            AgentEffectKindNative::StateChange | AgentEffectKindNative::Destructive
        )
    {
        return Err("native policy rejects state changes on critical paths".into());
    }
    if matches!(call.tool_name.as_str(), "exec_command" | "terminal_execute")
        && scope.unknown_network_egress
        && effect.kind == AgentEffectKindNative::ExternalSideEffect
    {
        return Err("native policy rejects unscoped command network egress".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runtime::AgentToolTargetNative;
    use serde_json::json;

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
                enforce_native_call_policy_native(&call, &effect(kind), &scope)
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
}
