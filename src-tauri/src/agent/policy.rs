use super::budgets::HARD_MAX_TOOL_TIMEOUT_SECONDS;
use super::protocol::ShellExecReadOnlyArgsV1;
use std::collections::HashSet;

pub(crate) const AGENT_READ_ONLY_POLICY_VERSION_V1: &str = "p1-read-only-v1";
pub(crate) const DEFAULT_TOOL_TIMEOUT_SECONDS_V1: u16 = 15;

const PS_COLUMNS_V1: &str = "pid,ppid,user,stat,%cpu,%mem,etime,comm";
const SYSTEMCTL_SAFE_PROPERTIES_V1: &str =
    "Id,LoadState,ActiveState,SubState,UnitFileState,MainPID,ExecMainStatus,Result,ActiveEnterTimestamp";
const DOCKER_PS_FORMAT_V1: &str = "table {{.ID}}\t{{.Image}}\t{{.Names}}\t{{.Status}}\t{{.Ports}}";
const DOCKER_INSPECT_FORMAT_V1: &str =
    "{{json .Id}} {{json .Name}} {{json .State.Status}} {{json .State.Pid}} {{json .RestartCount}} {{json .Config.Image}}";
const DOCKER_STATS_FORMAT_V1: &str =
    "table {{.Container}}\t{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.NetIO}}\t{{.BlockIO}}\t{{.PIDs}}";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AgentPolicyDenialCodeV1 {
    UnknownProgram,
    ProgramDisabled,
    ControlCharacter,
    ShellStructure,
    SensitiveRead,
    PrivilegeEscalation,
    ModifyingOperation,
    InvalidArguments,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentPolicyDenialV1 {
    pub(crate) code: AgentPolicyDenialCodeV1,
    pub(crate) message: String,
}

impl AgentPolicyDenialV1 {
    fn new(code: AgentPolicyDenialCodeV1, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ValidatedShellCommandV1 {
    pub(crate) program: String,
    pub(crate) args: Vec<String>,
    pub(crate) timeout_seconds: u16,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentReadOnlyPolicyV1 {
    docker_enabled: bool,
    allowed_mounts: Vec<String>,
}

impl Default for AgentReadOnlyPolicyV1 {
    fn default() -> Self {
        Self {
            docker_enabled: false,
            allowed_mounts: vec!["/".to_string()],
        }
    }
}

impl AgentReadOnlyPolicyV1 {
    #[cfg(test)]
    pub(crate) fn with_docker_enabled_for_tests(mut self) -> Self {
        self.docker_enabled = true;
        self
    }

    #[cfg(test)]
    pub(crate) fn with_allowed_mount_for_tests(mut self, mount: &str) -> Self {
        self.allowed_mounts.push(mount.to_string());
        self
    }

    pub(crate) fn validate_shell(
        &self,
        input: &ShellExecReadOnlyArgsV1,
    ) -> Result<ValidatedShellCommandV1, AgentPolicyDenialV1> {
        validate_program_token_v1(&input.program)?;
        validate_structural_boundary_v1(&input.args)?;
        if input
            .timeout_seconds
            .is_some_and(|timeout| timeout == 0 || timeout > HARD_MAX_TOOL_TIMEOUT_SECONDS)
        {
            return Err(AgentPolicyDenialV1::new(
                AgentPolicyDenialCodeV1::InvalidArguments,
                "The tool timeout is outside the frozen P1 bounds.",
            ));
        }

        let normalized = match input.program.as_str() {
            "uname" => validate_uname_v1(&input.args),
            "hostname" => validate_hostname_v1(&input.args),
            "whoami" => validate_whoami_v1(&input.args),
            "id" => validate_id_v1(&input.args),
            "date" => validate_date_v1(&input.args),
            "uptime" => validate_uptime_v1(&input.args),
            "df" => validate_df_v1(&input.args, &self.allowed_mounts),
            "free" => validate_free_v1(&input.args),
            "ps" => validate_ps_v1(&input.args),
            "ss" => validate_ss_v1(&input.args),
            "systemctl" => validate_systemctl_v1(&input.args),
            "journalctl" => validate_journalctl_v1(&input.args),
            "docker" if self.docker_enabled => validate_docker_v1(&input.args),
            "docker" => Err(AgentPolicyDenialV1::new(
                AgentPolicyDenialCodeV1::ProgramDisabled,
                "docker observation is disabled until the run freezes a tested capability.",
            )),
            _ => Err(AgentPolicyDenialV1::new(
                AgentPolicyDenialCodeV1::UnknownProgram,
                "The requested program is not in the P1 read-only allowlist.",
            )),
        }?;

        Ok(ValidatedShellCommandV1 {
            program: input.program.clone(),
            args: normalized,
            timeout_seconds: input
                .timeout_seconds
                .unwrap_or(DEFAULT_TOOL_TIMEOUT_SECONDS_V1),
        })
    }
}

fn invalid_arguments(program: &str) -> AgentPolicyDenialV1 {
    AgentPolicyDenialV1::new(
        AgentPolicyDenialCodeV1::InvalidArguments,
        format!("{program} arguments do not match its bounded read-only grammar."),
    )
}

fn validate_program_token_v1(program: &str) -> Result<(), AgentPolicyDenialV1> {
    let lower = program.to_ascii_lowercase();
    if matches!(lower.as_str(), "sudo" | "su" | "doas" | "pkexec") {
        return Err(AgentPolicyDenialV1::new(
            AgentPolicyDenialCodeV1::PrivilegeEscalation,
            "Privilege escalation programs are forbidden in P1.",
        ));
    }
    if matches!(
        lower.as_str(),
        "rm" | "mv"
            | "cp"
            | "touch"
            | "chmod"
            | "chown"
            | "kill"
            | "pkill"
            | "apt"
            | "apt-get"
            | "dnf"
            | "yum"
            | "pacman"
            | "apk"
            | "brew"
            | "vi"
            | "vim"
            | "nano"
    ) {
        return Err(AgentPolicyDenialV1::new(
            AgentPolicyDenialCodeV1::ModifyingOperation,
            "Modifying programs are forbidden in P1.",
        ));
    }
    if program.is_empty()
        || !program.is_ascii()
        || program.chars().any(char::is_control)
        || program.contains('/')
        || program.contains('\\')
    {
        return Err(AgentPolicyDenialV1::new(
            AgentPolicyDenialCodeV1::UnknownProgram,
            "Program names must be one exact allowlisted executable name.",
        ));
    }
    Ok(())
}

fn validate_structural_boundary_v1(args: &[String]) -> Result<(), AgentPolicyDenialV1> {
    for argument in args {
        if argument.chars().any(char::is_control) {
            return Err(AgentPolicyDenialV1::new(
                AgentPolicyDenialCodeV1::ControlCharacter,
                "Control characters are forbidden in read-only tool arguments.",
            ));
        }
        if argument
            .chars()
            .any(|character| matches!(character, ';' | '|' | '&' | '<' | '>' | '`' | '$'))
            || argument.contains("$(")
            || argument.contains("<(")
            || argument.contains(">(")
            || argument.contains('*')
            || argument.contains('?')
            || argument.contains('[')
        {
            return Err(AgentPolicyDenialV1::new(
                AgentPolicyDenialCodeV1::ShellStructure,
                "Shell control, redirection, substitution, background, and glob structures are forbidden.",
            ));
        }
        let lower = argument.to_ascii_lowercase();
        if contains_sensitive_read_structure_v1(&lower) {
            return Err(AgentPolicyDenialV1::new(
                AgentPolicyDenialCodeV1::SensitiveRead,
                "Sensitive credential, history, process-environment, or metadata reads are forbidden.",
            ));
        }
        if looks_like_environment_assignment_v1(argument)
            || matches!(
                lower.as_str(),
                "nohup" | "disown" | "setsid" | "env" | "xargs" | "sh" | "bash" | "zsh"
            )
        {
            return Err(AgentPolicyDenialV1::new(
                AgentPolicyDenialCodeV1::ShellStructure,
                "Environment injection, shell evaluation, and detached execution are forbidden.",
            ));
        }
    }
    Ok(())
}

fn looks_like_environment_assignment_v1(argument: &str) -> bool {
    let Some((name, _)) = argument.split_once('=') else {
        return false;
    };
    !name.starts_with('-')
        && !name.is_empty()
        && name.chars().enumerate().all(|(index, character)| {
            character == '_'
                || character.is_ascii_alphanumeric() && (index > 0 || !character.is_ascii_digit())
        })
}

fn contains_sensitive_read_structure_v1(lower: &str) -> bool {
    (lower.contains("/proc/") && lower.contains("/environ"))
        || lower.contains("/.ssh")
        || lower.contains("~/.ssh")
        || lower.contains("id_rsa")
        || lower.contains("id_ed25519")
        || lower.contains("/etc/shadow")
        || lower.contains("/etc/gshadow")
        || lower.contains(".bash_history")
        || lower.contains(".zsh_history")
        || lower.contains("credentials")
        || lower.contains("169.254.169.254")
        || lower.contains("metadata.google.internal")
        || lower.contains("metadata.azure.com")
}

fn validate_uname_v1(args: &[String]) -> Result<Vec<String>, AgentPolicyDenialV1> {
    const ALLOWED: &[&str] = &[
        "-a",
        "-s",
        "-n",
        "-r",
        "-v",
        "-m",
        "-p",
        "-i",
        "-o",
        "--all",
        "--kernel-name",
        "--nodename",
        "--kernel-release",
        "--kernel-version",
        "--machine",
        "--processor",
        "--hardware-platform",
        "--operating-system",
    ];
    if args.len() > 3
        || args.iter().any(|arg| !ALLOWED.contains(&arg.as_str()))
        || has_duplicates_v1(args)
        || (args.len() > 1
            && args
                .iter()
                .any(|arg| matches!(arg.as_str(), "-a" | "--all")))
    {
        return Err(invalid_arguments("uname"));
    }
    Ok(args.to_vec())
}

fn validate_hostname_v1(args: &[String]) -> Result<Vec<String>, AgentPolicyDenialV1> {
    const ALLOWED: &[&str] = &[
        "-f",
        "--fqdn",
        "-s",
        "--short",
        "-d",
        "--domain",
        "-i",
        "--ip-address",
    ];
    if args.len() <= 1 && args.iter().all(|arg| ALLOWED.contains(&arg.as_str())) {
        Ok(args.to_vec())
    } else {
        Err(invalid_arguments("hostname"))
    }
}

fn validate_whoami_v1(args: &[String]) -> Result<Vec<String>, AgentPolicyDenialV1> {
    if args.is_empty() {
        Ok(Vec::new())
    } else {
        Err(invalid_arguments("whoami"))
    }
}

fn validate_id_v1(args: &[String]) -> Result<Vec<String>, AgentPolicyDenialV1> {
    const ALLOWED: &[&str] = &[
        "-u",
        "--user",
        "-g",
        "--group",
        "-G",
        "--groups",
        "-n",
        "--name",
        "-r",
        "--real",
        "-Z",
        "--context",
    ];
    if args.len() > 3
        || args.iter().any(|arg| !ALLOWED.contains(&arg.as_str()))
        || has_duplicates_v1(args)
    {
        return Err(invalid_arguments("id"));
    }
    let selects_identity = args.iter().any(|arg| {
        matches!(
            arg.as_str(),
            "-u" | "--user" | "-g" | "--group" | "-G" | "--groups"
        )
    });
    if args
        .iter()
        .any(|arg| matches!(arg.as_str(), "-n" | "--name" | "-r" | "--real"))
        && !selects_identity
    {
        return Err(invalid_arguments("id"));
    }
    Ok(args.to_vec())
}

fn validate_date_v1(args: &[String]) -> Result<Vec<String>, AgentPolicyDenialV1> {
    const FORMATS: &[&str] = &["+%Y-%m-%dT%H:%M:%S%z", "+%Y-%m-%d %H:%M:%S %Z", "+%s"];
    let allowed = match args {
        [] => true,
        [one] => matches!(one.as_str(), "-u" | "--utc") || FORMATS.contains(&one.as_str()),
        [utc, format] => {
            matches!(utc.as_str(), "-u" | "--utc") && FORMATS.contains(&format.as_str())
        }
        _ => false,
    };
    if allowed {
        Ok(args.to_vec())
    } else {
        Err(invalid_arguments("date"))
    }
}

fn validate_uptime_v1(args: &[String]) -> Result<Vec<String>, AgentPolicyDenialV1> {
    if args.is_empty()
        || (args.len() == 1 && matches!(args[0].as_str(), "-p" | "--pretty" | "-s" | "--since"))
    {
        Ok(args.to_vec())
    } else {
        Err(invalid_arguments("uptime"))
    }
}

fn validate_df_v1(
    args: &[String],
    allowed_mounts: &[String],
) -> Result<Vec<String>, AgentPolicyDenialV1> {
    let mut flags = HashSet::new();
    let mut mount = None;
    for argument in args {
        if argument.starts_with('-') {
            let short = argument
                .strip_prefix('-')
                .ok_or_else(|| invalid_arguments("df"))?;
            if short.is_empty()
                || short.chars().any(|flag| !matches!(flag, 'h' | 'P' | 'T'))
                || short.chars().any(|flag| !flags.insert(flag))
            {
                return Err(invalid_arguments("df"));
            }
        } else if mount.replace(argument.clone()).is_some() {
            return Err(invalid_arguments("df"));
        }
    }
    if mount
        .as_ref()
        .is_some_and(|value| !allowed_mounts.iter().any(|allowed| allowed == value))
    {
        return Err(invalid_arguments("df"));
    }
    let mut normalized = ['h', 'P', 'T']
        .into_iter()
        .filter(|flag| flags.contains(flag))
        .map(|flag| format!("-{flag}"))
        .collect::<Vec<_>>();
    if let Some(mount) = mount {
        normalized.push(mount);
    }
    Ok(normalized)
}

fn validate_free_v1(args: &[String]) -> Result<Vec<String>, AgentPolicyDenialV1> {
    const UNIT_FLAGS: &[&str] = &[
        "-b", "--bytes", "-k", "--kibi", "-m", "--mebi", "-g", "--gibi", "-h", "--human",
    ];
    if args.is_empty() || (args.len() == 1 && UNIT_FLAGS.contains(&args[0].as_str())) {
        Ok(args.to_vec())
    } else {
        Err(invalid_arguments("free"))
    }
}

fn validate_ps_v1(args: &[String]) -> Result<Vec<String>, AgentPolicyDenialV1> {
    let canonical = match args {
        [fields] if fields == "-eo" => None,
        [flag, fields] if flag == "-eo" && fields == PS_COLUMNS_V1 => {
            Some(vec!["-eo".to_string(), PS_COLUMNS_V1.to_string()])
        }
        [flag, fields, sort]
            if flag == "-eo"
                && fields == PS_COLUMNS_V1
                && matches!(sort.as_str(), "--sort=-%cpu" | "--sort=-%mem") =>
        {
            Some(vec![flag.clone(), fields.clone(), sort.clone()])
        }
        [all, output, fields, sort_flag, sort]
            if all == "-e"
                && output == "-o"
                && fields == PS_COLUMNS_V1
                && sort_flag == "--sort"
                && matches!(sort.as_str(), "-%cpu" | "-%mem") =>
        {
            Some(vec![
                "-eo".to_string(),
                fields.clone(),
                format!("--sort={sort}"),
            ])
        }
        _ => None,
    };
    canonical.ok_or_else(|| invalid_arguments("ps"))
}

fn validate_ss_v1(args: &[String]) -> Result<Vec<String>, AgentPolicyDenialV1> {
    const FIXED_QUERIES: &[&[&str]] = &[&["-s"], &["-ltnp"], &["-lunp"], &["-tanp"], &["-uanp"]];
    if FIXED_QUERIES.iter().any(|query| {
        query.len() == args.len()
            && query
                .iter()
                .zip(args)
                .all(|(expected, actual)| expected == actual)
    }) {
        Ok(args.to_vec())
    } else {
        Err(invalid_arguments("ss"))
    }
}

fn validate_systemctl_v1(args: &[String]) -> Result<Vec<String>, AgentPolicyDenialV1> {
    let Some(subcommand) = args.first().map(String::as_str) else {
        return Err(invalid_arguments("systemctl"));
    };
    match subcommand {
        "status" | "show" | "is-active" => {
            let mut unit = None;
            for argument in &args[1..] {
                if matches!(argument.as_str(), "--no-pager" | "--full") {
                    continue;
                }
                if argument.starts_with('-') || unit.replace(argument.as_str()).is_some() {
                    return Err(invalid_arguments("systemctl"));
                }
            }
            let unit = unit
                .filter(|value| valid_unit_name_v1(value))
                .ok_or_else(|| invalid_arguments("systemctl"))?;
            let normalized = match subcommand {
                "status" => vec![
                    "status".to_string(),
                    unit.to_string(),
                    "--no-pager".to_string(),
                    "--lines=0".to_string(),
                    "--full".to_string(),
                ],
                "show" => vec![
                    "show".to_string(),
                    unit.to_string(),
                    "--no-pager".to_string(),
                    format!("--property={SYSTEMCTL_SAFE_PROPERTIES_V1}"),
                ],
                _ => vec!["is-active".to_string(), unit.to_string()],
            };
            Ok(normalized)
        }
        "list-units" => {
            let mut normalized = vec!["list-units".to_string()];
            let mut seen_type = false;
            let mut seen_state = false;
            let mut seen_all = false;
            for argument in &args[1..] {
                if matches!(argument.as_str(), "--no-pager" | "--no-legend") {
                    continue;
                }
                if argument == "--all" && !seen_all {
                    seen_all = true;
                    normalized.push(argument.clone());
                } else if argument
                    .strip_prefix("--type=")
                    .is_some_and(valid_unit_type_v1)
                    && !seen_type
                {
                    seen_type = true;
                    normalized.push(argument.clone());
                } else if argument
                    .strip_prefix("--state=")
                    .is_some_and(valid_unit_state_list_v1)
                    && !seen_state
                {
                    seen_state = true;
                    normalized.push(argument.clone());
                } else {
                    return Err(invalid_arguments("systemctl"));
                }
            }
            normalized.push("--no-pager".to_string());
            normalized.push("--no-legend".to_string());
            Ok(normalized)
        }
        _ => Err(
            if matches!(
                subcommand,
                "start"
                    | "stop"
                    | "restart"
                    | "reload"
                    | "enable"
                    | "disable"
                    | "mask"
                    | "unmask"
                    | "kill"
            ) {
                AgentPolicyDenialV1::new(
                    AgentPolicyDenialCodeV1::ModifyingOperation,
                    "Mutating systemctl subcommands are forbidden in P1.",
                )
            } else {
                invalid_arguments("systemctl")
            },
        ),
    }
}

fn validate_journalctl_v1(args: &[String]) -> Result<Vec<String>, AgentPolicyDenialV1> {
    let mut unit = None;
    let mut lines = None;
    let mut boot = None;
    let mut since = None;
    let mut until = None;
    let mut utc = false;
    let mut output = None;
    let mut index = 0;
    while index < args.len() {
        let argument = &args[index];
        let mut take_value = |slot: &mut Option<String>, validator: fn(&str) -> bool| {
            if slot.is_some() || index + 1 >= args.len() || !validator(&args[index + 1]) {
                return false;
            }
            *slot = Some(args[index + 1].clone());
            index += 2;
            true
        };
        if argument == "--no-pager" {
            index += 1;
        } else if matches!(argument.as_str(), "-u" | "--unit") {
            if !take_value(&mut unit, valid_unit_name_v1) {
                return Err(invalid_arguments("journalctl"));
            }
        } else if let Some(value) = argument.strip_prefix("--unit=") {
            if unit.is_some() || !valid_unit_name_v1(value) {
                return Err(invalid_arguments("journalctl"));
            }
            unit = Some(value.to_string());
            index += 1;
        } else if matches!(argument.as_str(), "-n" | "--lines") {
            if !take_value(&mut lines, valid_line_count_v1) {
                return Err(invalid_arguments("journalctl"));
            }
        } else if let Some(value) = argument.strip_prefix("--lines=") {
            if lines.is_some() || !valid_line_count_v1(value) {
                return Err(invalid_arguments("journalctl"));
            }
            lines = Some(value.to_string());
            index += 1;
        } else if matches!(argument.as_str(), "-b" | "--boot") {
            if boot.is_some() {
                return Err(invalid_arguments("journalctl"));
            }
            if index + 1 < args.len() && valid_boot_offset_v1(&args[index + 1]) {
                boot = Some(args[index + 1].clone());
                index += 2;
            } else {
                boot = Some("0".to_string());
                index += 1;
            }
        } else if let Some(value) = argument.strip_prefix("--boot=") {
            if boot.is_some() || !valid_boot_offset_v1(value) {
                return Err(invalid_arguments("journalctl"));
            }
            boot = Some(value.to_string());
            index += 1;
        } else if argument == "--since" {
            if !take_value(&mut since, valid_time_filter_v1) {
                return Err(invalid_arguments("journalctl"));
            }
        } else if let Some(value) = argument.strip_prefix("--since=") {
            if since.is_some() || !valid_time_filter_v1(value) {
                return Err(invalid_arguments("journalctl"));
            }
            since = Some(value.to_string());
            index += 1;
        } else if argument == "--until" {
            if !take_value(&mut until, valid_time_filter_v1) {
                return Err(invalid_arguments("journalctl"));
            }
        } else if let Some(value) = argument.strip_prefix("--until=") {
            if until.is_some() || !valid_time_filter_v1(value) {
                return Err(invalid_arguments("journalctl"));
            }
            until = Some(value.to_string());
            index += 1;
        } else if argument == "--utc" && !utc {
            utc = true;
            index += 1;
        } else if let Some(value) = argument.strip_prefix("--output=") {
            if output.is_some()
                || !matches!(value, "short" | "short-iso" | "short-iso-precise" | "cat")
            {
                return Err(invalid_arguments("journalctl"));
            }
            output = Some(value.to_string());
            index += 1;
        } else {
            return Err(if matches!(argument.as_str(), "-f" | "--follow") {
                AgentPolicyDenialV1::new(
                    AgentPolicyDenialCodeV1::ShellStructure,
                    "journalctl follow mode is forbidden in P1.",
                )
            } else {
                invalid_arguments("journalctl")
            });
        }
    }
    let lines = lines.ok_or_else(|| invalid_arguments("journalctl"))?;
    if unit.is_none() && boot.is_none() {
        return Err(invalid_arguments("journalctl"));
    }
    let mut normalized = Vec::new();
    if let Some(unit) = unit {
        normalized.extend(["--unit".to_string(), unit]);
    }
    if let Some(boot) = boot {
        normalized.push(format!("--boot={boot}"));
    }
    if let Some(since) = since {
        normalized.push(format!("--since={since}"));
    }
    if let Some(until) = until {
        normalized.push(format!("--until={until}"));
    }
    if utc {
        normalized.push("--utc".to_string());
    }
    if let Some(output) = output {
        normalized.push(format!("--output={output}"));
    }
    normalized.push(format!("--lines={lines}"));
    normalized.push("--no-pager".to_string());
    Ok(normalized)
}

fn validate_docker_v1(args: &[String]) -> Result<Vec<String>, AgentPolicyDenialV1> {
    let Some(subcommand) = args.first().map(String::as_str) else {
        return Err(invalid_arguments("docker"));
    };
    match subcommand {
        "ps" => {
            if args.len() <= 2
                && args[1..]
                    .iter()
                    .all(|arg| matches!(arg.as_str(), "-a" | "--all"))
                && !has_duplicates_v1(&args[1..])
            {
                let mut normalized = vec!["ps".to_string()];
                if args.len() == 2 {
                    normalized.push("--all".to_string());
                }
                normalized.extend(["--format".to_string(), DOCKER_PS_FORMAT_V1.to_string()]);
                Ok(normalized)
            } else {
                Err(invalid_arguments("docker"))
            }
        }
        "inspect" if args.len() == 2 && valid_container_name_v1(&args[1]) => Ok(vec![
            "inspect".to_string(),
            "--format".to_string(),
            DOCKER_INSPECT_FORMAT_V1.to_string(),
            args[1].clone(),
        ]),
        "stats" => {
            let containers = args[1..]
                .iter()
                .filter(|arg| arg.as_str() != "--no-stream")
                .collect::<Vec<_>>();
            if containers.is_empty()
                || containers.len() > 5
                || containers.iter().any(|name| !valid_container_name_v1(name))
                || args
                    .iter()
                    .filter(|arg| arg.as_str() == "--no-stream")
                    .count()
                    > 1
            {
                return Err(invalid_arguments("docker"));
            }
            let mut normalized = vec![
                "stats".to_string(),
                "--no-stream".to_string(),
                "--format".to_string(),
                DOCKER_STATS_FORMAT_V1.to_string(),
            ];
            normalized.extend(containers.into_iter().cloned());
            Ok(normalized)
        }
        "logs" => validate_docker_logs_v1(&args[1..]),
        "exec" | "cp" | "stop" | "start" | "restart" | "kill" | "rm" | "run" => {
            Err(AgentPolicyDenialV1::new(
                AgentPolicyDenialCodeV1::ModifyingOperation,
                "Mutating or interactive docker subcommands are forbidden in P1.",
            ))
        }
        _ => Err(invalid_arguments("docker")),
    }
}

fn validate_docker_logs_v1(args: &[String]) -> Result<Vec<String>, AgentPolicyDenialV1> {
    let mut tail = None;
    let mut container = None;
    let mut index = 0;
    while index < args.len() {
        if matches!(args[index].as_str(), "-f" | "--follow") {
            return Err(AgentPolicyDenialV1::new(
                AgentPolicyDenialCodeV1::ShellStructure,
                "docker logs follow mode is forbidden in P1.",
            ));
        }
        if matches!(args[index].as_str(), "--tail" | "-n") {
            if tail.is_some() || index + 1 >= args.len() || !valid_line_count_v1(&args[index + 1]) {
                return Err(invalid_arguments("docker"));
            }
            tail = Some(args[index + 1].clone());
            index += 2;
        } else if let Some(value) = args[index].strip_prefix("--tail=") {
            if tail.is_some() || !valid_line_count_v1(value) {
                return Err(invalid_arguments("docker"));
            }
            tail = Some(value.to_string());
            index += 1;
        } else if container.is_none() && valid_container_name_v1(&args[index]) {
            container = Some(args[index].clone());
            index += 1;
        } else {
            return Err(invalid_arguments("docker"));
        }
    }
    let tail = tail.ok_or_else(|| invalid_arguments("docker"))?;
    let container = container.ok_or_else(|| invalid_arguments("docker"))?;
    Ok(vec![
        "logs".to_string(),
        "--tail".to_string(),
        tail,
        container,
    ])
}

fn has_duplicates_v1<T: Eq + std::hash::Hash>(values: &[T]) -> bool {
    let mut seen = HashSet::new();
    values.iter().any(|value| !seen.insert(value))
}

fn valid_unit_name_v1(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && !value.starts_with('-')
        && !value.contains("..")
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '@' | ':' | '-')
        })
}

fn valid_unit_type_v1(value: &str) -> bool {
    matches!(value, "service" | "socket" | "target" | "mount" | "timer")
}

fn valid_unit_state_list_v1(value: &str) -> bool {
    let allowed = ["loaded", "active", "running", "failed", "exited", "dead"];
    let states = value.split(',').collect::<Vec<_>>();
    !states.is_empty()
        && states.len() <= 3
        && states.iter().all(|state| allowed.contains(state))
        && !has_duplicates_v1(&states)
}

fn valid_line_count_v1(value: &str) -> bool {
    value
        .parse::<u16>()
        .is_ok_and(|lines| (1..=500).contains(&lines))
}

fn valid_boot_offset_v1(value: &str) -> bool {
    value
        .parse::<i8>()
        .is_ok_and(|offset| (-10..=0).contains(&offset))
}

fn valid_time_filter_v1(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 32
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric()
                || matches!(character, ' ' | '-' | ':' | '+' | '.' | 'T' | 'Z')
        })
}

fn valid_container_name_v1(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.chars().enumerate().all(|(index, character)| {
            character.is_ascii_alphanumeric() || (index > 0 && matches!(character, '.' | '_' | '-'))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(program: &str, args: &[&str]) -> ShellExecReadOnlyArgsV1 {
        ShellExecReadOnlyArgsV1 {
            program: program.to_string(),
            args: args.iter().map(|arg| (*arg).to_string()).collect(),
            timeout_seconds: Some(15),
        }
    }

    #[test]
    fn program_allow_deny_table_covers_every_first_wave_validator() {
        let policy = AgentReadOnlyPolicyV1::default()
            .with_allowed_mount_for_tests("/var")
            .with_docker_enabled_for_tests();
        let table: &[(&str, &[&str], bool)] = &[
            ("uname", &["-a"], true),
            ("uname", &["--help"], false),
            ("hostname", &["--fqdn"], true),
            ("hostname", &["changed-host"], false),
            ("whoami", &[], true),
            ("whoami", &["root"], false),
            ("id", &["-u", "-n"], true),
            ("id", &["root"], false),
            ("date", &["-u", "+%Y-%m-%dT%H:%M:%S%z"], true),
            ("date", &["--set", "tomorrow"], false),
            ("uptime", &["--pretty"], true),
            ("uptime", &["--help"], false),
            ("df", &["-hPT", "/var"], true),
            ("df", &["-a", "/"], false),
            ("free", &["--human"], true),
            ("free", &["--seconds", "1"], false),
            ("ps", &["-eo", PS_COLUMNS_V1, "--sort=-%cpu"], true),
            ("ps", &["aux"], false),
            ("ss", &["-ltnp"], true),
            ("ss", &["--kill", "dst", "1.2.3.4"], false),
            (
                "systemctl",
                &["status", "nginx.service", "--no-pager"],
                true,
            ),
            ("systemctl", &["restart", "nginx.service"], false),
            ("systemctl", &["show", "nginx.service"], true),
            (
                "systemctl",
                &["show", "nginx.service", "--property=Environment"],
                false,
            ),
            (
                "systemctl",
                &["list-units", "--type=service", "--state=failed"],
                true,
            ),
            ("systemctl", &["list-unit-files"], false),
            (
                "journalctl",
                &["--unit", "nginx.service", "--lines", "100", "--no-pager"],
                true,
            ),
            (
                "journalctl",
                &["--unit", "nginx.service", "--lines", "501"],
                false,
            ),
            (
                "journalctl",
                &["--boot=-1", "--since", "1 hour ago", "--lines=50"],
                true,
            ),
            (
                "journalctl",
                &["--unit", "nginx.service", "--lines=20", "--follow"],
                false,
            ),
            ("docker", &["ps", "--all"], true),
            ("docker", &["inspect", "api-1"], true),
            ("docker", &["stats", "api-1", "--no-stream"], true),
            ("docker", &["logs", "--tail", "100", "api-1"], true),
            ("docker", &["exec", "api-1", "sh"], false),
            (
                "docker",
                &["logs", "--tail", "20", "--follow", "api-1"],
                false,
            ),
        ];
        for (program, args, allowed) in table {
            assert_eq!(
                policy.validate_shell(&request(program, args)).is_ok(),
                *allowed,
                "unexpected policy result for {program} {args:?}"
            );
        }
    }

    #[test]
    fn docker_is_fail_closed_until_capability_is_frozen() {
        let denial = AgentReadOnlyPolicyV1::default()
            .validate_shell(&request("docker", &["ps"]))
            .expect_err("docker defaults to disabled");
        assert_eq!(denial.code, AgentPolicyDenialCodeV1::ProgramDisabled);
    }

    #[test]
    fn forced_bounds_and_safe_fields_are_canonicalized_locally() {
        let policy = AgentReadOnlyPolicyV1::default();
        let status = policy
            .validate_shell(&request("systemctl", &["status", "nginx.service"]))
            .unwrap();
        assert_eq!(
            status.args,
            [
                "status",
                "nginx.service",
                "--no-pager",
                "--lines=0",
                "--full"
            ]
        );
        let show = policy
            .validate_shell(&request("systemctl", &["show", "nginx.service"]))
            .unwrap();
        assert!(show.args.last().unwrap().contains("ActiveState"));
        assert!(!show.args.last().unwrap().contains("Environment"));
        let journal = policy
            .validate_shell(&request("journalctl", &["-u", "nginx.service", "-n", "25"]))
            .unwrap();
        assert_eq!(journal.args.last().unwrap(), "--no-pager");
        assert!(journal.args.contains(&"--lines=25".to_string()));
    }

    #[test]
    fn every_allowlisted_flag_and_subcommand_has_an_explicit_allow_case() {
        let policy = AgentReadOnlyPolicyV1::default()
            .with_allowed_mount_for_tests("/var")
            .with_docker_enabled_for_tests();
        for flag in [
            "-a",
            "-s",
            "-n",
            "-r",
            "-v",
            "-m",
            "-p",
            "-i",
            "-o",
            "--all",
            "--kernel-name",
            "--nodename",
            "--kernel-release",
            "--kernel-version",
            "--machine",
            "--processor",
            "--hardware-platform",
            "--operating-system",
        ] {
            assert!(policy.validate_shell(&request("uname", &[flag])).is_ok());
        }
        for flag in [
            "-f",
            "--fqdn",
            "-s",
            "--short",
            "-d",
            "--domain",
            "-i",
            "--ip-address",
        ] {
            assert!(policy.validate_shell(&request("hostname", &[flag])).is_ok());
        }
        for args in [
            &["-u"][..],
            &["--user"],
            &["-g"],
            &["--group"],
            &["-G"],
            &["--groups"],
            &["-u", "-n"],
            &["--group", "--name"],
            &["-G", "-r"],
            &["--groups", "--real"],
            &["-Z"],
            &["--context"],
        ] {
            assert!(policy.validate_shell(&request("id", args)).is_ok());
        }
        for flag in ["-p", "--pretty", "-s", "--since"] {
            assert!(policy.validate_shell(&request("uptime", &[flag])).is_ok());
        }
        for flag in [
            "-b", "--bytes", "-k", "--kibi", "-m", "--mebi", "-g", "--gibi", "-h", "--human",
        ] {
            assert!(policy.validate_shell(&request("free", &[flag])).is_ok());
        }
        for query in ["-s", "-ltnp", "-lunp", "-tanp", "-uanp"] {
            assert!(policy.validate_shell(&request("ss", &[query])).is_ok());
        }
        for subcommand in ["status", "show", "is-active"] {
            assert!(policy
                .validate_shell(&request("systemctl", &[subcommand, "nginx.service"]))
                .is_ok());
        }
        for unit_type in ["service", "socket", "target", "mount", "timer"] {
            assert!(policy
                .validate_shell(&request(
                    "systemctl",
                    &["list-units", &format!("--type={unit_type}")],
                ))
                .is_ok());
        }
        for state in ["loaded", "active", "running", "failed", "exited", "dead"] {
            assert!(policy
                .validate_shell(&request(
                    "systemctl",
                    &["list-units", &format!("--state={state}")],
                ))
                .is_ok());
        }
        for output in ["short", "short-iso", "short-iso-precise", "cat"] {
            assert!(policy
                .validate_shell(&request(
                    "journalctl",
                    &[
                        "--unit=nginx.service",
                        "--lines=25",
                        &format!("--output={output}"),
                        "--utc",
                        "--no-pager",
                    ],
                ))
                .is_ok());
        }
        for args in [
            &["--boot", "--lines", "25"][..],
            &["-b", "-1", "-n", "25"],
            &["--boot=-2", "--since=1 hour ago", "--lines=25"],
            &[
                "--boot=0",
                "--since",
                "2026-08-27 10:00:00",
                "--until",
                "2026-08-27 11:00:00",
                "--lines",
                "25",
            ],
            &["-u", "nginx.service", "-n", "25"],
        ] {
            assert!(policy.validate_shell(&request("journalctl", args)).is_ok());
        }
        for args in [
            &["ps"][..],
            &["ps", "-a"],
            &["inspect", "api-1"],
            &["stats", "--no-stream", "api-1"],
            &["logs", "-n", "25", "api-1"],
        ] {
            assert!(policy.validate_shell(&request("docker", args)).is_ok());
        }
    }

    #[test]
    fn every_mutating_or_unbounded_subcommand_family_has_an_explicit_deny_case() {
        let policy = AgentReadOnlyPolicyV1::default().with_docker_enabled_for_tests();
        for subcommand in [
            "start", "stop", "restart", "reload", "enable", "disable", "mask", "unmask", "kill",
        ] {
            let denial = policy
                .validate_shell(&request("systemctl", &[subcommand, "nginx.service"]))
                .expect_err("mutating systemctl subcommand");
            assert_eq!(denial.code, AgentPolicyDenialCodeV1::ModifyingOperation);
        }
        for flag in [
            "--follow",
            "--reverse",
            "--vacuum-time=1s",
            "--rotate",
            "--flush",
            "--sync",
        ] {
            assert!(policy
                .validate_shell(&request(
                    "journalctl",
                    &["--unit=nginx.service", "--lines=25", flag],
                ))
                .is_err());
        }
        for subcommand in [
            "exec", "cp", "stop", "start", "restart", "kill", "rm", "run",
        ] {
            let denial = policy
                .validate_shell(&request("docker", &[subcommand, "api-1"]))
                .expect_err("mutating docker subcommand");
            assert_eq!(denial.code, AgentPolicyDenialCodeV1::ModifyingOperation);
        }
        for (program, args) in [
            ("date", &["--set", "now"][..]),
            ("df", &["--output=source"][..]),
            ("free", &["--seconds", "1"][..]),
            ("ps", &["aux"][..]),
            ("ss", &["--events"][..]),
        ] {
            assert!(policy.validate_shell(&request(program, args)).is_err());
        }
    }

    #[test]
    fn policy_revalidates_timeout_without_trusting_the_protocol_decoder() {
        let policy = AgentReadOnlyPolicyV1::default();
        for timeout in [0, 61, u16::MAX] {
            let mut input = request("uptime", &[]);
            input.timeout_seconds = Some(timeout);
            assert!(policy.validate_shell(&input).is_err());
        }
    }

    #[test]
    fn denial_taxonomy_distinguishes_the_security_boundaries() {
        let policy = AgentReadOnlyPolicyV1::default();
        let cases: &[(&str, &[&str], AgentPolicyDenialCodeV1)] = &[
            (
                "uname",
                &["-a\n"],
                AgentPolicyDenialCodeV1::ControlCharacter,
            ),
            ("uname", &["$(id)"], AgentPolicyDenialCodeV1::ShellStructure),
            (
                "cat",
                &["/proc/1/environ"],
                AgentPolicyDenialCodeV1::SensitiveRead,
            ),
            (
                "sudo",
                &["-n", "id"],
                AgentPolicyDenialCodeV1::PrivilegeEscalation,
            ),
            ("rm", &["file"], AgentPolicyDenialCodeV1::ModifyingOperation),
            (
                "curl",
                &["https://example.invalid"],
                AgentPolicyDenialCodeV1::UnknownProgram,
            ),
        ];
        for (program, args, expected) in cases {
            assert_eq!(
                policy
                    .validate_shell(&request(program, args))
                    .expect_err("security boundary must deny")
                    .code,
                *expected
            );
        }
    }
}
