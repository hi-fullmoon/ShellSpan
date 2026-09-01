use crate::agent_contract_v3::{
    AgentEffectKindV3, AgentObservedEffectV3, AgentToolCallV3, ApplyPatchArgumentsV3,
    ExecCommandArgumentsV3, TransferDirectionV3, TransferFileArgumentsV3,
};

use super::inspect_call_policy_scope_v3;
use super::registry::{ToolEffectModeV3, ToolManifestDescriptorV3};

pub(crate) fn assess_effect_v3(
    descriptor: &ToolManifestDescriptorV3,
    call: &AgentToolCallV3,
) -> Result<AgentObservedEffectV3, String> {
    let kind = match descriptor.effect_mode {
        ToolEffectModeV3::Fixed => *descriptor
            .allowed_effects
            .first()
            .ok_or_else(|| "tool has no native effect declaration".to_string())?,
        ToolEffectModeV3::NativeClassifier if call.tool_name == "exec_command" => {
            let arguments =
                serde_json::from_value::<ExecCommandArgumentsV3>(call.arguments.clone())
                    .map_err(|_| "exec_command arguments cannot be classified".to_string())?;
            classify_command_effect(&arguments.command)
        }
        ToolEffectModeV3::NativeClassifier if call.tool_name == "apply_patch" => {
            let arguments = serde_json::from_value::<ApplyPatchArgumentsV3>(call.arguments.clone())
                .map_err(|_| "apply_patch arguments cannot be classified".to_string())?;
            if arguments.dry_run.unwrap_or(false) {
                AgentEffectKindV3::StateChange
            } else if arguments.patch.contains("/dev/null")
                || arguments
                    .patch
                    .lines()
                    .any(|line| line.starts_with("deleted file mode"))
            {
                AgentEffectKindV3::Destructive
            } else {
                AgentEffectKindV3::StateChange
            }
        }
        ToolEffectModeV3::NativeClassifier if call.tool_name == "transfer_file" => {
            let arguments =
                serde_json::from_value::<TransferFileArgumentsV3>(call.arguments.clone())
                    .map_err(|_| "transfer_file arguments cannot be classified".to_string())?;
            match arguments.direction {
                TransferDirectionV3::Upload => AgentEffectKindV3::ExternalSideEffect,
                TransferDirectionV3::Download if arguments.overwrite => {
                    AgentEffectKindV3::StateChange
                }
                TransferDirectionV3::Download => AgentEffectKindV3::SensitiveRead,
            }
        }
        ToolEffectModeV3::NativeClassifier => {
            return Err("native effect classifier is unavailable for this M1 tool".into())
        }
    };
    if !descriptor.allowed_effects.contains(&kind) {
        return Err("native effect is outside the tool manifest".into());
    }
    let scope = inspect_call_policy_scope_v3(call)?;
    Ok(AgentObservedEffectV3 {
        kind,
        target_id: call.target.target_id().to_string(),
        summary: format!("Native policy classified {} as {kind:?}.", call.tool_name),
        paths: scope.paths,
        network_destinations: scope.network_destinations,
    })
}

fn classify_command_effect(command: &str) -> AgentEffectKindV3 {
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
        AgentEffectKindV3::Destructive
    } else if EXTERNAL.contains(&executable)
        || command_words.iter().any(|word| EXTERNAL.contains(word))
        || normalized.contains("http://")
        || normalized.contains("https://")
    {
        AgentEffectKindV3::ExternalSideEffect
    } else if SENSITIVE_READ.contains(&executable) {
        AgentEffectKindV3::SensitiveRead
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
        AgentEffectKindV3::ReadOnly
    } else {
        // Unknown commands are never treated as reads. Native approval must
        // explicitly cover their state-changing effect before dispatch.
        AgentEffectKindV3::StateChange
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_classifier_is_conservative_for_unknown_and_high_impact_commands() {
        assert_eq!(
            classify_command_effect("df -h"),
            AgentEffectKindV3::ReadOnly
        );
        assert_eq!(
            classify_command_effect("Get-Content ./config"),
            AgentEffectKindV3::SensitiveRead
        );
        assert_eq!(
            classify_command_effect("rm -rf /tmp/example"),
            AgentEffectKindV3::Destructive
        );
        assert_eq!(
            classify_command_effect("sudo sh -c 'rm -rf /tmp/example'"),
            AgentEffectKindV3::Destructive
        );
        assert_eq!(
            classify_command_effect("curl https://example.test"),
            AgentEffectKindV3::ExternalSideEffect
        );
        assert_eq!(
            classify_command_effect("custom-maintenance-tool"),
            AgentEffectKindV3::StateChange
        );
        assert_eq!(
            classify_command_effect("echo ok; custom-maintenance-tool"),
            AgentEffectKindV3::StateChange
        );
        assert_eq!(
            classify_command_effect("echo $(touch /tmp/changed)"),
            AgentEffectKindV3::StateChange
        );
    }
}
