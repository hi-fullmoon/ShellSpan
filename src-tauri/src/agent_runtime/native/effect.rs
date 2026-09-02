use crate::agent_runtime::{
    AgentEffectKindNative, AgentObservedEffectNative, AgentToolCallNative,
    ApplyPatchArgumentsNative, ExecCommandArgumentsNative, TransferDirectionNative,
    TransferFileArgumentsNative,
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
    const SENSITIVE_READ: [&str; 13] = [
        "cat",
        "type",
        "get-content",
        "more",
        "less",
        "env",
        "set",
        "printenv",
        "whoami",
        "id",
        "hostname",
        "ipconfig",
        "ifconfig",
    ];
    const READ_ONLY: [&str; 18] = [
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
        "date",
        "echo",
        "printf",
        "systemctl",
        "service",
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
    } else if EXTERNAL.contains(&executable)
        || command_words.iter().any(|word| EXTERNAL.contains(word))
        || normalized.contains("http://")
        || normalized.contains("https://")
    {
        AgentEffectKindNative::ExternalSideEffect
    } else if SENSITIVE_READ.contains(&executable) {
        AgentEffectKindNative::SensitiveRead
    } else if READ_ONLY.contains(&executable)
        && !normalized
            .chars()
            .any(|character| matches!(character, ';' | '|' | '&' | '`' | '>' | '<' | '\n' | '\r'))
        && !normalized.contains("$(")
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
    }
}
