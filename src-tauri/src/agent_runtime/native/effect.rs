use crate::agent_runtime::{
    AgentEffectKindNative, AgentObservedEffectNative, AgentToolCallNative,
    ApplyPatchArgumentsNative, ExecCommandArgumentsNative, TerminalExecuteArgumentsNative,
    TransferDirectionNative, TransferFileArgumentsNative,
};

use super::inspect_call_policy_scope_native;
use super::registry::{ToolEffectModeNative, ToolManifestDescriptorNative};

pub(crate) fn assess_effect_native(
    descriptor: &ToolManifestDescriptorNative,
    call: &AgentToolCallNative,
) -> Result<AgentObservedEffectNative, String> {
    let kind = match descriptor.effect_mode {
        ToolEffectModeNative::Fixed => *descriptor
            .allowed_effects
            .first()
            .ok_or_else(|| "tool has no native effect declaration".to_string())?,
        ToolEffectModeNative::NativeClassifier if call.tool_name == "exec_command" => {
            let arguments =
                serde_json::from_value::<ExecCommandArgumentsNative>(call.arguments.clone())
                    .map_err(|_| "exec_command arguments cannot be classified".to_string())?;
            classify_command_effect(&arguments.command)
        }
        ToolEffectModeNative::NativeClassifier if call.tool_name == "terminal_execute" => {
            let arguments =
                serde_json::from_value::<TerminalExecuteArgumentsNative>(call.arguments.clone())
                    .map_err(|_| "terminal_execute arguments cannot be classified".to_string())?;
            classify_command_effect(&arguments.command)
        }
        ToolEffectModeNative::NativeClassifier if call.tool_name == "apply_patch" => {
            let arguments =
                serde_json::from_value::<ApplyPatchArgumentsNative>(call.arguments.clone())
                    .map_err(|_| "apply_patch arguments cannot be classified".to_string())?;
            if arguments.dry_run.unwrap_or(false) {
                AgentEffectKindNative::StateChange
            } else if arguments.patch.contains("/dev/null")
                || arguments
                    .patch
                    .lines()
                    .any(|line| line.starts_with("deleted file mode"))
            {
                AgentEffectKindNative::Destructive
            } else {
                AgentEffectKindNative::StateChange
            }
        }
        ToolEffectModeNative::NativeClassifier if call.tool_name == "transfer_file" => {
            let arguments =
                serde_json::from_value::<TransferFileArgumentsNative>(call.arguments.clone())
                    .map_err(|_| "transfer_file arguments cannot be classified".to_string())?;
            match arguments.direction {
                TransferDirectionNative::Upload => AgentEffectKindNative::ExternalSideEffect,
                TransferDirectionNative::Download if arguments.overwrite => {
                    AgentEffectKindNative::StateChange
                }
                TransferDirectionNative::Download => AgentEffectKindNative::SensitiveRead,
            }
        }
        ToolEffectModeNative::NativeClassifier => {
            return Err("native effect classifier is unavailable for this Native tool".into())
        }
    };
    if !descriptor.allowed_effects.contains(&kind) {
        return Err("native effect is outside the tool manifest".into());
    }
    let scope = inspect_call_policy_scope_native(call)?;
    Ok(AgentObservedEffectNative {
        kind,
        target_id: call.target.target_id().to_string(),
        summary: format!("Native policy classified {} as {kind:?}.", call.tool_name),
        paths: scope.paths,
        network_destinations: scope.network_destinations,
    })
}

fn classify_command_effect(command: &str) -> AgentEffectKindNative {
    let normalized = command.trim().to_ascii_lowercase();
    let executable = normalized
        .split_ascii_whitespace()
        .next()
        .unwrap_or_default()
        .trim_matches(|character: char| matches!(character, '&' | '(' | ')' | ';'));

    const DESTRUCTIVE: [&str; 15] = [
        "rm",
        "rmdir",
        "del",
        "erase",
        "remove-item",
        "format",
        "format.com",
        "mkfs",
        "diskpart",
        "dd",
        "shutdown",
        "reboot",
        "restart-computer",
        "stop-computer",
        "bcdedit",
    ];
    const EXTERNAL: [&str; 13] = [
        "curl",
        "wget",
        "invoke-webrequest",
        "invoke-restmethod",
        "ssh",
        "scp",
        "sftp",
        "nc",
        "ncat",
        "telnet",
        "ftp",
        "git",
        "docker",
    ];
    const SENSITIVE_READ: [&str; 8] = [
        "cat",
        "type",
        "get-content",
        "more",
        "less",
        "printenv",
        "whoami",
        "id",
    ];
    const READ_ONLY: [&str; 15] = [
        "pwd",
        "cd",
        "ls",
        "dir",
        "get-childitem",
        "uname",
        "ver",
        "ps",
        "get-process",
        "df",
        "du",
        "free",
        "uptime",
        "echo",
        "printf",
    ];

    let command_words = normalized
        .split(|character: char| {
            character.is_ascii_whitespace()
                || matches!(character, ';' | '|' | '&' | '(' | ')' | '{' | '}')
        })
        .map(|word| {
            word.trim_matches(|character: char| {
                matches!(character, '\'' | '"' | '`' | '$' | '.' | '/' | '\\')
            })
        })
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>();

    if DESTRUCTIVE.contains(&executable)
        || command_words.iter().any(|word| DESTRUCTIVE.contains(word))
        || normalized.contains(" remove-item ")
        || normalized.contains("clear-disk")
        || normalized.contains("initialize-disk")
        || normalized.contains("format-volume")
        || normalized.contains(" --delete")
        || normalized.contains(" /s /q")
    {
        AgentEffectKindNative::Destructive
    } else if is_bounded_journal_command(&normalized) {
        AgentEffectKindNative::SensitiveRead
    } else if is_bounded_diagnostic_command(&normalized) {
        AgentEffectKindNative::ReadOnly
    } else if EXTERNAL.contains(&executable)
        || command_words.iter().any(|word| EXTERNAL.contains(word))
        || normalized.contains("http://")
        || normalized.contains("https://")
    {
        AgentEffectKindNative::ExternalSideEffect
    } else if SENSITIVE_READ.contains(&executable) && is_simple_shell_command(&normalized) {
        AgentEffectKindNative::SensitiveRead
    } else if READ_ONLY.contains(&executable)
        && is_simple_shell_command(&normalized)
        && !normalized.contains("restart")
        && !normalized.contains(" start ")
        && !normalized.contains(" stop ")
        && !normalized.contains(" enable")
        && !normalized.contains(" disable")
    {
        AgentEffectKindNative::ReadOnly
    } else {
        // Unknown commands are never treated as reads. Native approval must
        // explicitly cover their state-changing effect before dispatch.
        AgentEffectKindNative::StateChange
    }
}

pub(crate) fn command_requires_direct_lifecycle_native(command: &str) -> bool {
    matches!(
        classify_command_effect(command),
        AgentEffectKindNative::SensitiveRead
            | AgentEffectKindNative::Destructive
            | AgentEffectKindNative::ExternalSideEffect
    )
}

fn is_bounded_diagnostic_command(command: &str) -> bool {
    if !is_plain_diagnostic_command(command) {
        return false;
    }
    let words = command.split_ascii_whitespace().collect::<Vec<_>>();
    match words.as_slice() {
        ["systemctl", "status", "--no-pager", unit]
        | ["systemctl", "status", unit, "--no-pager"] => safe_diagnostic_argument(unit),
        ["systemctl", "is-active" | "is-failed", unit] => safe_diagnostic_argument(unit),
        ["ip", "address" | "addr" | "route"] => true,
        ["ss", flags] => matches!(*flags, "-ltn" | "-ltnp" | "-lntu" | "-lntup"),
        _ => false,
    }
}

fn is_bounded_journal_command(command: &str) -> bool {
    if !is_plain_diagnostic_command(command) {
        return false;
    }
    let mut words = command.split_ascii_whitespace();
    if words.next() != Some("journalctl") {
        return false;
    }
    let (mut unit, mut lines, mut no_pager) = (false, false, false);
    while let Some(word) = words.next() {
        match word {
            "-u" | "--unit" if !unit => {
                unit = words.next().is_some_and(safe_diagnostic_argument);
                if !unit {
                    return false;
                }
            }
            "-n" | "--lines" if !lines => {
                lines = words
                    .next()
                    .and_then(|value| value.parse::<u16>().ok())
                    .is_some_and(|value| (1..=1_000).contains(&value));
                if !lines {
                    return false;
                }
            }
            "--no-pager" if !no_pager => no_pager = true,
            _ => return false,
        }
    }
    unit && lines && no_pager
}

fn is_plain_diagnostic_command(command: &str) -> bool {
    is_simple_shell_command(command)
        && !command
            .chars()
            .any(|character| matches!(character, '$' | '\\' | '*' | '?' | '[' | ']'))
}

fn safe_diagnostic_argument(argument: &str) -> bool {
    let unquoted = argument
        .strip_prefix('\'')
        .and_then(|value| value.strip_suffix('\''))
        .or_else(|| {
            argument
                .strip_prefix('"')
                .and_then(|value| value.strip_suffix('"'))
        })
        .unwrap_or(argument);
    !unquoted.is_empty()
        && unquoted
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b'@'))
}

fn is_simple_shell_command(command: &str) -> bool {
    !command.chars().any(|character| {
        matches!(
            character,
            ';' | '|' | '&' | '`' | '>' | '<' | '(' | ')' | '{' | '}' | '\n' | '\r'
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_classifier_is_conservative_for_unknown_and_high_impact_commands() {
        assert_eq!(
            classify_command_effect("df -h"),
            AgentEffectKindNative::ReadOnly
        );
        assert_eq!(
            classify_command_effect("Get-Content ./config"),
            AgentEffectKindNative::SensitiveRead
        );
        assert_eq!(
            classify_command_effect("rm -rf /tmp/example"),
            AgentEffectKindNative::Destructive
        );
        assert_eq!(
            classify_command_effect("sudo sh -c 'rm -rf /tmp/example'"),
            AgentEffectKindNative::Destructive
        );
        assert_eq!(
            classify_command_effect("curl https://example.test"),
            AgentEffectKindNative::ExternalSideEffect
        );
        assert_eq!(
            classify_command_effect("custom-maintenance-tool"),
            AgentEffectKindNative::StateChange
        );
        assert_eq!(
            classify_command_effect("echo ok; custom-maintenance-tool"),
            AgentEffectKindNative::StateChange
        );
        assert_eq!(
            classify_command_effect("echo $(touch /tmp/changed)"),
            AgentEffectKindNative::StateChange
        );
        for command in [
            "cat /tmp/input > /tmp/output",
            "Get-Content (Set-Content ./file value)",
            "service nginx reload",
            "systemctl mask nginx",
            "date --set tomorrow",
            "env custom-maintenance-tool",
            "hostname changed-name",
            "ipconfig /release",
            "ifconfig eth0 down",
        ] {
            assert_eq!(
                classify_command_effect(command),
                AgentEffectKindNative::StateChange,
                "{command} must require state-change authorization"
            );
        }
    }

    #[test]
    fn security_sensitive_command_effects_require_direct_lifecycle_evidence() {
        for command in [
            "cat ~/.ssh/id_ed25519",
            "rm -rf /tmp/example",
            "curl https://example.test",
        ] {
            assert!(
                command_requires_direct_lifecycle_native(command),
                "{command} must not rely on cooperative terminal lifecycle evidence"
            );
        }
        for command in ["cd /tmp", "export DEMO=value", "alias ll='ls -l'"] {
            assert!(
                !command_requires_direct_lifecycle_native(command),
                "{command} must remain eligible for the stateful visible shell"
            );
        }
    }

    #[test]
    fn bounded_service_and_socket_diagnostics_remain_read_only() {
        for command in [
            "systemctl status --no-pager nginx.service",
            "systemctl status 'nginx.service' --no-pager",
            "systemctl is-active nginx.service",
            "systemctl is-failed nginx.service",
            "systemctl status --no-pager docker",
            "ip address",
            "ip route",
            "ss -ltnp",
        ] {
            assert_eq!(
                classify_command_effect(command),
                AgentEffectKindNative::ReadOnly,
                "{command} should be available as a read-only diagnostic"
            );
        }
        for command in [
            "systemctl restart nginx.service",
            "systemctl status --no-pager nginx.service; touch /tmp/changed",
            "systemctl status --no-pager $(touch /tmp/changed)",
            "systemctl status -H remote nginx.service",
            "ip route delete default",
            "ss --kill dst 127.0.0.1",
        ] {
            assert_eq!(
                classify_command_effect(command),
                AgentEffectKindNative::StateChange,
                "{command} must still require state-change authorization"
            );
        }
    }

    #[test]
    fn bounded_journal_reads_are_sensitive_and_unbounded_forms_need_approval() {
        for command in [
            "journalctl -u nginx.service --no-pager -n 100",
            "journalctl --no-pager -n 20 -u 'nginx.service'",
            "journalctl -u ssh --no-pager -n 100",
        ] {
            assert_eq!(
                classify_command_effect(command),
                AgentEffectKindNative::SensitiveRead
            );
        }
        for command in [
            "journalctl -u nginx.service",
            "journalctl -u nginx.service --no-pager -n 1001",
            "journalctl -u nginx.service --vacuum-time=1d",
            "journalctl -u $(touch /tmp/changed) --no-pager -n 100",
        ] {
            assert_eq!(
                classify_command_effect(command),
                AgentEffectKindNative::StateChange,
                "{command} must not be classified as a bounded log read"
            );
        }
    }
}
