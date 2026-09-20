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
    if let Some(commands) = super::shell_policy::literal_command_chain(command) {
        return commands
            .into_iter()
            .map(classify_single_command_effect)
            .max_by_key(|effect| effect_priority(*effect))
            .unwrap_or(AgentEffectKindNative::StateChange);
    }
    let effect = classify_single_command_effect(command);
    // Multiline syntax that cannot be safely split is a whole shell program,
    // never a read based on its first command. Retain destructive classification.
    if command.contains(['\n', '\r']) && effect != AgentEffectKindNative::Destructive {
        AgentEffectKindNative::ExternalSideEffect
    } else {
        effect
    }
}

fn effect_priority(effect: AgentEffectKindNative) -> u8 {
    match effect {
        AgentEffectKindNative::None => 0,
        AgentEffectKindNative::ReadOnly => 1,
        AgentEffectKindNative::SensitiveRead => 2,
        AgentEffectKindNative::StateChange => 3,
        AgentEffectKindNative::ExternalSideEffect => 4,
        AgentEffectKindNative::Destructive => 5,
    }
}

fn classify_single_command_effect(command: &str) -> AgentEffectKindNative {
    let normalized = command.trim().to_ascii_lowercase();
    let executable = command_word_name(
        normalized
            .split_ascii_whitespace()
            .next()
            .unwrap_or_default(),
    );

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
    const NETWORK_CAPABLE_RUNTIMES: &[&str] = &[
        "bash",
        "bun",
        "cmd",
        "dash",
        "deno",
        "ksh",
        "lua",
        "node",
        "nodejs",
        "osascript",
        "perl",
        "php",
        "powershell",
        "pwsh",
        "pypy",
        "pypy3",
        "python",
        "python2",
        "python3",
        "rscript",
        "ruby",
        "sh",
        "zsh",
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

    let executable_names = command_executable_names(command);
    if DESTRUCTIVE.contains(&executable.as_str())
        || executable_names
            .iter()
            .any(|word| DESTRUCTIVE.contains(&word.as_str()))
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
    } else if is_plain_windows_discovery_command(&normalized) {
        AgentEffectKindNative::ReadOnly
    } else if (SENSITIVE_READ.contains(&executable.as_str())
        || executable_names
            .iter()
            .any(|word| SENSITIVE_READ.contains(&word.as_str())))
        && is_simple_shell_command(&normalized)
    {
        AgentEffectKindNative::SensitiveRead
    } else if (READ_ONLY.contains(&executable.as_str())
        || executable_names
            .iter()
            .any(|word| READ_ONLY.contains(&word.as_str())))
        && is_simple_shell_command(&normalized)
        && !normalized.contains("restart")
        && !normalized.contains(" start ")
        && !normalized.contains(" stop ")
        && !normalized.contains(" enable")
        && !normalized.contains(" disable")
    {
        AgentEffectKindNative::ReadOnly
    } else if EXTERNAL.contains(&executable.as_str())
        || executable_names
            .iter()
            .any(|word| EXTERNAL.contains(&word.as_str()))
        || NETWORK_CAPABLE_RUNTIMES.contains(&executable.as_str())
        || executable_names
            .iter()
            .any(|word| NETWORK_CAPABLE_RUNTIMES.contains(&word.as_str()))
        || normalized.contains("/dev/tcp/")
        || normalized.contains("/dev/udp/")
        || normalized.contains("http://")
        || normalized.contains("https://")
    {
        AgentEffectKindNative::ExternalSideEffect
    } else {
        // Unknown commands are never treated as reads. Native approval must
        // explicitly cover their state-changing effect before dispatch.
        AgentEffectKindNative::StateChange
    }
}

fn command_word_name(word: &str) -> String {
    let unquoted = word.trim_matches(|character: char| {
        matches!(
            character,
            '\'' | '"' | '`' | '$' | '&' | '(' | ')' | ';' | '.' | '/' | '\\'
        )
    });
    let basename = unquoted
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(unquoted)
        .to_ascii_lowercase();
    basename
        .strip_suffix(".exe")
        .unwrap_or(&basename)
        .to_string()
}

fn command_executable_names(command: &str) -> Vec<String> {
    let mut names = Vec::new();
    for segment in command.split(|character: char| {
        matches!(
            character,
            ';' | '|' | '&' | '(' | ')' | '{' | '}' | '\n' | '\r'
        )
    }) {
        let words = segment
            .split_ascii_whitespace()
            .map(|word| {
                word.trim_matches(|character: char| matches!(character, '\'' | '"' | '`' | '$'))
            })
            .filter(|word| !word.is_empty())
            .collect::<Vec<_>>();
        if words.is_empty() {
            continue;
        }
        if let Some(index) = segment_executable_index(&words) {
            let name = command_word_name(words[index]);
            if !name.is_empty() {
                names.push(name);
            }
        }
        for (index, word) in words.iter().enumerate() {
            let marker = word.to_ascii_lowercase();
            let nested = if marker == "-exec" || marker == "-execdir" {
                words.get(index + 1)
            } else if marker == "-c"
                && index > 0
                && matches!(
                    command_word_name(words[index - 1]).as_str(),
                    "sh" | "bash" | "zsh" | "dash" | "ksh" | "cmd" | "powershell" | "pwsh"
                )
            {
                words.get(index + 1)
            } else {
                None
            };
            if let Some(nested) = nested {
                let name = command_word_name(nested);
                if !name.is_empty() {
                    names.push(name);
                }
            }
        }
    }
    names
}

fn segment_executable_index(words: &[&str]) -> Option<usize> {
    const WRAPPERS: &[&str] = &[
        "command", "doas", "env", "exec", "nice", "nohup", "sudo", "time", "timeout", "watch",
        "xargs",
    ];
    const SHELL_KEYWORDS: &[&str] = &["do", "else", "then"];
    let mut index = 0;
    loop {
        let word = *words.get(index)?;
        let name = command_word_name(word);
        if SHELL_KEYWORDS.contains(&name.as_str()) {
            index += 1;
            continue;
        }
        if !WRAPPERS.contains(&name.as_str()) {
            return Some(index);
        }
        let wrapper = name;
        index += 1;
        while let Some(candidate) = words.get(index) {
            let normalized = candidate.to_ascii_lowercase();
            if wrapper_option_takes_value(&wrapper, candidate) {
                index += 2;
            } else if normalized.starts_with('-') || normalized.contains('=') {
                index += 1;
            } else {
                break;
            }
        }
        if wrapper == "timeout" && words.get(index).is_some() {
            index += 1;
        }
    }
}

fn wrapper_option_takes_value(wrapper: &str, option: &str) -> bool {
    let long = option.to_ascii_lowercase();
    match wrapper {
        "sudo" | "doas" => matches!(
            long.as_str(),
            "-c" | "--chdir"
                | "--close-from"
                | "--command-timeout"
                | "-g"
                | "--group"
                | "-h"
                | "--host"
                | "-p"
                | "--prompt"
                | "-r"
                | "--role"
                | "-t"
                | "--type"
                | "-u"
                | "--user"
        ),
        "env" => {
            matches!(option, "-C" | "-S" | "-u")
                || matches!(long.as_str(), "--chdir" | "--split-string" | "--unset")
        }
        "nice" => option == "-n" || long == "--adjustment",
        "timeout" => {
            matches!(option, "-k" | "-s") || matches!(long.as_str(), "--kill-after" | "--signal")
        }
        "watch" => option == "-n" || long == "--interval",
        "xargs" => {
            matches!(
                option,
                "-a" | "-d" | "-E" | "-I" | "-L" | "-n" | "-P" | "-s"
            ) || matches!(
                long.as_str(),
                "--arg-file"
                    | "--delimiter"
                    | "--eof"
                    | "--replace"
                    | "--max-lines"
                    | "--max-args"
                    | "--max-procs"
                    | "--max-chars"
            )
        }
        _ => false,
    }
}

fn is_plain_windows_discovery_command(command: &str) -> bool {
    if !is_simple_shell_command(command) || command.contains("://") {
        return false;
    }
    let words = command.split_ascii_whitespace().collect::<Vec<_>>();
    match words.as_slice() {
        ["where.exe" | "get-command", name] => safe_diagnostic_argument(name),
        ["docker" | "docker.exe", "--version"] => true,
        _ => false,
    }
}

pub(crate) fn command_requires_direct_lifecycle_native(command: &str) -> bool {
    if command.contains(['\n', '\r', '\t']) {
        return true;
    }
    if let Some(commands) = super::shell_policy::literal_command_chain(command) {
        if commands.into_iter().any(|part| {
            matches!(
                classify_single_command_effect(part),
                AgentEffectKindNative::SensitiveRead
                    | AgentEffectKindNative::Destructive
                    | AgentEffectKindNative::ExternalSideEffect
            )
        }) {
            return true;
        }
    }
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
    fn command_chains_retain_the_strongest_effect_and_complex_scripts_are_conservative() {
        for (command, expected) in [
            ("pwd\nls -la", AgentEffectKindNative::ReadOnly),
            ("pwd && rm ./old", AgentEffectKindNative::Destructive),
            ("pwd\nrm ./old", AgentEffectKindNative::Destructive),
            (
                "pwd\ncurl https://example.test",
                AgentEffectKindNative::ExternalSideEffect,
            ),
            ("pwd\ncat ./config", AgentEffectKindNative::SensitiveRead),
            ("pwd\ntouch ./new", AgentEffectKindNative::StateChange),
            (
                "cat <<'EOF'\nhello\nEOF",
                AgentEffectKindNative::ExternalSideEffect,
            ),
            (
                "pwd\nif true; then touch new; fi",
                AgentEffectKindNative::ExternalSideEffect,
            ),
            (
                "printf ok\necho $(touch new)",
                AgentEffectKindNative::ExternalSideEffect,
            ),
        ] {
            assert_eq!(classify_command_effect(command), expected, "{command}");
        }
    }

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
        for command in [
            "node -e \"require('http').get({host:'127.0.0.1',port:3000})\"",
            "python3 -c \"import socket; socket.create_connection(('127.0.0.1', 3000))\"",
            "bash -lc 'cat </dev/tcp/127.0.0.1/3000'",
        ] {
            assert_eq!(
                classify_command_effect(command),
                AgentEffectKindNative::ExternalSideEffect,
                "{command} must not bypass structured network scope"
            );
        }
        assert_eq!(
            classify_command_effect("node --check server.js"),
            AgentEffectKindNative::ExternalSideEffect
        );
        assert_eq!(
            classify_command_effect("node server.js"),
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
            "cat ./config; touch ./new",
            "pwd\nls",
            "/bin/cat ~/.ssh/id_ed25519",
            "rm -rf /tmp/example",
            "/bin/rm -rf /tmp/example",
            "curl https://example.test",
            "/usr/bin/curl 127.0.0.1:18765",
            r"C:\Windows\System32\format.com D:",
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
    fn absolute_executable_paths_preserve_effect_classification() {
        for (command, expected) in [
            ("/bin/ls -la", AgentEffectKindNative::ReadOnly),
            ("/bin/cat /tmp/value", AgentEffectKindNative::SensitiveRead),
            ("/bin/rm -rf /tmp/value", AgentEffectKindNative::Destructive),
            (
                "/usr/bin/curl 127.0.0.1:18765",
                AgentEffectKindNative::ExternalSideEffect,
            ),
            (
                r"C:\Windows\System32\format.com D:",
                AgentEffectKindNative::Destructive,
            ),
        ] {
            assert_eq!(
                classify_command_effect(command),
                expected,
                "{command} must keep its basename policy"
            );
        }
    }

    #[test]
    fn policy_names_ignore_argument_basenames_but_follow_command_entry_points() {
        for command in [
            "cat /tmp/curl",
            "ls /opt/docker",
            "echo /tmp/rm",
            "printf https://example.test",
            "echo curl",
            "printf rm",
            "grep docker config.txt",
        ] {
            assert_ne!(
                classify_command_effect(command),
                AgentEffectKindNative::ExternalSideEffect,
                "{command} must not turn an argument into network authority"
            );
            assert_ne!(
                classify_command_effect(command),
                AgentEffectKindNative::Destructive,
                "{command} must not turn an argument into a destructive executable"
            );
        }
        for command in [
            "sudo /bin/rm -rf /tmp/value",
            "env DEMO=1 /usr/bin/curl 127.0.0.1:18765",
            "sh -c '/bin/rm -rf /tmp/value'",
            "find /tmp -exec /bin/rm {} ;",
            "xargs -n 1 rm",
            "xargs -p rm",
            "xargs -P 2 rm",
            "env -i /usr/bin/curl 127.0.0.1:18765",
            "timeout 5 /bin/rm -rf /tmp/value",
        ] {
            assert!(
                command_requires_direct_lifecycle_native(command),
                "{command} must retain a security-sensitive executable boundary"
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
    fn plain_windows_docker_discovery_does_not_look_like_network_egress() {
        for command in [
            "where.exe docker",
            "where.exe docker.exe",
            "Get-Command docker",
            "docker --version",
            "docker.exe --version",
        ] {
            assert_eq!(
                classify_command_effect(command),
                AgentEffectKindNative::ReadOnly,
                "{command} is a local version or executable lookup"
            );
        }
        for command in [
            "where.exe docker; curl https://example.test",
            "Get-Command docker | curl https://example.test",
            "docker version",
            "docker ps",
        ] {
            assert_eq!(
                classify_command_effect(command),
                AgentEffectKindNative::ExternalSideEffect,
                "{command} must retain network egress classification"
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
