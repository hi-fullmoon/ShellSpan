use crate::connection::{
    connect_tcp_stream, connect_through_jump_host, open_authenticated_session,
};
use crate::models::{RemoteConnectionRequest, RemoteHealthCancellationRegistry};
use serde::{Deserialize, Serialize};
use ssh2::Session;
use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};
use tauri::{AppHandle, State};

const COMMAND_SET_VERSION: &str = "termbridge-read-only-v1";
const PLATFORM_PROBE_COMMAND: &str = "uname -s";
const MAX_REMOTE_OUTPUT_BYTES: usize = 64 * 1024;
const MAX_REMOTE_ERROR_BYTES: usize = 4 * 1024;
const MIN_TIMEOUT_MS: u64 = 1_000;
const MAX_TIMEOUT_MS: u64 = 60_000;
const WORKER_POLL_INTERVAL: Duration = Duration::from_millis(50);

// These commands are compile-time constants. No command text, path, or shell
// fragment is accepted from the frontend. Every invoked program only reads
// system state or prints delimiters; no remote file or service is mutated.
const LINUX_SNAPSHOT_COMMAND: &str = r#"LC_ALL=C; export LC_ALL;
printf 'TB_HOSTNAME='; hostname;
printf 'TB_KERNEL='; uname -r;
printf 'TB_ARCH='; uname -m;
printf 'TB_OS_VERSION='; awk -F= '/^PRETTY_NAME=/ {sub(/^"/, "", $2); sub(/"$/, "", $2); print $2; found=1} END {if (!found) print "Linux"}' /etc/os-release;
printf 'TB_CPU_COUNT='; getconf _NPROCESSORS_ONLN;
printf 'TB_UPTIME='; cut -d ' ' -f 1 /proc/uptime;
printf 'TB_LOAD='; cut -d ' ' -f 1-3 /proc/loadavg;
printf 'TB_CPU_1='; sed -n '1p' /proc/stat;
sleep 1;
printf 'TB_CPU_2='; sed -n '1p' /proc/stat;
printf 'TB_MEM='; awk '/^MemTotal:/ {total=$2} /^MemAvailable:/ {available=$2} END {used=total-available; printf "%.0f %.0f %.0f\n", total*1024, used*1024, available*1024}' /proc/meminfo;
printf 'TB_DISK='; df -Pk / | awk 'NR==2 {print $2, $3, $4, $5, $6}'"#;

const MACOS_SNAPSHOT_COMMAND: &str = r#"LC_ALL=C; export LC_ALL;
printf 'TB_HOSTNAME='; hostname;
printf 'TB_KERNEL='; uname -r;
printf 'TB_ARCH='; uname -m;
printf 'TB_OS_VERSION='; sw_vers -productVersion;
printf 'TB_CPU_COUNT='; sysctl -n hw.ncpu;
printf 'TB_LOAD='; sysctl -n vm.loadavg;
printf 'TB_CPU='; top -l 2 -n 0 -s 1 | awk '/CPU usage/ {idle=$7} END {gsub(/%/, "", idle); print 100-idle}';
printf 'TB_MEM_TOTAL='; sysctl -n hw.memsize;
printf 'TB_MEM_AVAILABLE='; vm_stat | awk 'NR==1 {page=$8; gsub(/[^0-9]/, "", page)} /^Pages free:/ {free=$3} /^Pages inactive:/ {inactive=$3} /^Pages speculative:/ {speculative=$3} END {gsub(/\./, "", free); gsub(/\./, "", inactive); gsub(/\./, "", speculative); printf "%.0f\n", (free+inactive+speculative)*page}';
printf 'TB_NOW='; date +%s;
printf 'TB_BOOT='; sysctl -n kern.boottime;
printf 'TB_DISK='; df -Pk / | awk 'NR==2 {print $2, $3, $4, $5, $6}'"#;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteHealthSnapshotRequest {
    operation_id: String,
    profile_id: String,
    authorized: bool,
    timeout_ms: u64,
    connection: RemoteConnectionRequest,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteHealthSource {
    kind: &'static str,
    command_set_version: &'static str,
    profile_id: String,
    host: String,
    port: u16,
    username: String,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RemoteHealthResultStatus {
    Success,
    Unauthorized,
    Cancelled,
    TimedOut,
    Unsupported,
    Failed,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteSystemInfo {
    os_family: String,
    os_version: Option<String>,
    hostname: String,
    kernel_version: String,
    architecture: String,
    cpu_count: u32,
    uptime_secs: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteCpuInfo {
    usage_percent: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteMemoryInfo {
    total_bytes: u64,
    used_bytes: u64,
    available_bytes: u64,
    usage_percent: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteDiskInfo {
    total_bytes: u64,
    used_bytes: u64,
    available_bytes: u64,
    usage_percent: f64,
    mount_point: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteLoadInfo {
    one_minute: f64,
    five_minutes: f64,
    fifteen_minutes: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteHealthSnapshot {
    system: RemoteSystemInfo,
    cpu: RemoteCpuInfo,
    memory: RemoteMemoryInfo,
    disk: RemoteDiskInfo,
    load: RemoteLoadInfo,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteHealthSnapshotResult {
    operation_id: String,
    profile_id: String,
    status: RemoteHealthResultStatus,
    checked_at: i64,
    source: RemoteHealthSource,
    snapshot: Option<RemoteHealthSnapshot>,
    error: Option<String>,
}

struct HealthSshSession {
    target: Session,
    _jump: Option<Session>,
}

enum CollectionOutcome {
    Success(Box<RemoteHealthSnapshot>),
    Cancelled,
    Unsupported(String),
    Failed(String),
}

fn checked_at() -> i64 {
    crate::db::current_timestamp_ms()
}

fn result(
    request: &RemoteHealthSnapshotRequest,
    status: RemoteHealthResultStatus,
    snapshot: Option<RemoteHealthSnapshot>,
    error: Option<String>,
) -> RemoteHealthSnapshotResult {
    RemoteHealthSnapshotResult {
        operation_id: request.operation_id.clone(),
        profile_id: request.profile_id.clone(),
        status,
        checked_at: checked_at(),
        source: RemoteHealthSource {
            kind: "sshReadOnly",
            command_set_version: COMMAND_SET_VERSION,
            profile_id: request.profile_id.clone(),
            host: request.connection.host.clone(),
            port: request.connection.port,
            username: request.connection.username.clone(),
        },
        snapshot,
        error,
    }
}

fn validate_operation_id(value: &str) -> bool {
    !value.is_empty()
        && value.is_ascii()
        && value.len() <= 128
        && value.chars().enumerate().all(|(index, character)| {
            (index == 0 && character.is_ascii_alphanumeric())
                || (index > 0
                    && (character.is_ascii_alphanumeric()
                        || matches!(character, '.' | '_' | ':' | '-')))
        })
}

fn cancelled(flag: &AtomicBool) -> bool {
    flag.load(Ordering::SeqCst)
}

fn open_health_session(
    request: &RemoteConnectionRequest,
    known_hosts_path: &Path,
) -> Result<HealthSshSession, String> {
    if let Some(jump) = &request.jump_host {
        let (jump, target) = connect_through_jump_host(
            jump,
            &request.host,
            request.port,
            &request.username,
            request.auth_method,
            request.password.as_deref(),
            request.private_key_data.as_deref(),
            request.passphrase.as_deref(),
            Some(known_hosts_path),
        )
        .map_err(|error| error.message())?;
        return Ok(HealthSshSession {
            target,
            _jump: Some(jump),
        });
    }

    let tcp = connect_tcp_stream(&request.host, request.port)?;
    let target = open_authenticated_session(
        tcp,
        &request.username,
        request.auth_method,
        request.password.as_deref(),
        request.private_key_data.as_deref(),
        request.passphrase.as_deref(),
        &request.host,
        request.port,
        Some(known_hosts_path),
    )
    .map_err(|error| error.message())?;
    Ok(HealthSshSession {
        target,
        _jump: None,
    })
}

fn read_limited(reader: &mut impl Read, limit: usize) -> Result<String, String> {
    let mut bytes = Vec::new();
    reader
        .take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("failed to read remote command output: {error}"))?;
    if bytes.len() > limit {
        return Err("remote command output exceeded the safety limit".to_string());
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn exec_read_only(session: &Session, command: &'static str) -> Result<String, String> {
    let mut channel = session
        .channel_session()
        .map_err(|error| format!("failed to open remote command channel: {error}"))?;
    channel
        .exec(command)
        .map_err(|error| format!("failed to start remote read-only command: {error}"))?;
    let stdout = read_limited(&mut channel, MAX_REMOTE_OUTPUT_BYTES)?;
    let stderr = read_limited(&mut channel.stderr(), MAX_REMOTE_ERROR_BYTES)?;
    channel
        .wait_close()
        .map_err(|error| format!("failed to close remote command channel: {error}"))?;
    let exit_status = channel
        .exit_status()
        .map_err(|error| format!("failed to read remote command status: {error}"))?;
    if exit_status != 0 {
        let detail = stderr.trim();
        return Err(if detail.is_empty() {
            format!("remote read-only command exited with status {exit_status}")
        } else {
            format!("remote read-only command exited with status {exit_status}: {detail}")
        });
    }
    Ok(stdout)
}

fn snapshot_command(platform: &str) -> Option<&'static str> {
    match platform {
        "Linux" => Some(LINUX_SNAPSHOT_COMMAND),
        "Darwin" => Some(MACOS_SNAPSHOT_COMMAND),
        _ => None,
    }
}

fn key_value<'a>(output: &'a str, key: &str) -> Result<&'a str, String> {
    output
        .lines()
        .find_map(|line| line.strip_prefix(key))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("remote health output is missing {key}"))
}

fn parse_u64(value: &str, field: &str) -> Result<u64, String> {
    value
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|number| number.is_finite() && *number >= 0.0 && *number <= u64::MAX as f64)
        .map(|number| number.floor() as u64)
        .ok_or_else(|| format!("remote health output has invalid {field}"))
}

fn parse_f64(value: &str, field: &str) -> Result<f64, String> {
    value
        .trim()
        .trim_end_matches('%')
        .parse::<f64>()
        .ok()
        .filter(|number| number.is_finite())
        .ok_or_else(|| format!("remote health output has invalid {field}"))
}

fn parse_numbers(value: &str) -> Vec<f64> {
    value
        .split_whitespace()
        .filter_map(|part| {
            part.trim_matches(|character: char| {
                !character.is_ascii_digit() && character != '.' && character != '-'
            })
            .parse::<f64>()
            .ok()
            .filter(|number| number.is_finite())
        })
        .collect()
}

fn usage_percent(used: u64, total: u64) -> f64 {
    if total == 0 {
        0.0
    } else {
        ((used as f64 / total as f64) * 100.0).clamp(0.0, 100.0)
    }
}

fn parse_cpu_stat(value: &str) -> Result<(u64, u64), String> {
    let numbers = value
        .split_whitespace()
        .skip_while(|part| *part == "cpu")
        .take(8)
        .map(|part| part.parse::<u64>())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "remote health output has invalid CPU counters".to_string())?;
    if numbers.len() < 5 {
        return Err("remote health output has incomplete CPU counters".to_string());
    }
    let idle = numbers[3].saturating_add(numbers[4]);
    Ok((numbers.iter().copied().sum(), idle))
}

fn parse_disk(value: &str) -> Result<RemoteDiskInfo, String> {
    let mut parts = value.split_whitespace();
    let total_kib = parse_u64(parts.next().unwrap_or_default(), "disk total")?;
    let used_kib = parse_u64(parts.next().unwrap_or_default(), "disk used")?;
    let available_kib = parse_u64(parts.next().unwrap_or_default(), "disk available")?;
    let reported_percent = parse_f64(parts.next().unwrap_or_default(), "disk usage")?;
    let mount_point = parts.collect::<Vec<_>>().join(" ");
    if mount_point.is_empty() {
        return Err("remote health output has invalid disk mount point".to_string());
    }
    Ok(RemoteDiskInfo {
        total_bytes: total_kib.saturating_mul(1024),
        used_bytes: used_kib.saturating_mul(1024),
        available_bytes: available_kib.saturating_mul(1024),
        usage_percent: reported_percent.clamp(0.0, 100.0),
        mount_point,
    })
}

fn parse_load(value: &str) -> Result<RemoteLoadInfo, String> {
    let values = parse_numbers(value);
    if values.len() < 3 {
        return Err("remote health output has incomplete load averages".to_string());
    }
    Ok(RemoteLoadInfo {
        one_minute: values[0],
        five_minutes: values[1],
        fifteen_minutes: values[2],
    })
}

fn parse_linux_snapshot(output: &str) -> Result<RemoteHealthSnapshot, String> {
    let (total_1, idle_1) = parse_cpu_stat(key_value(output, "TB_CPU_1=")?)?;
    let (total_2, idle_2) = parse_cpu_stat(key_value(output, "TB_CPU_2=")?)?;
    let total_delta = total_2.saturating_sub(total_1);
    let idle_delta = idle_2.saturating_sub(idle_1);
    let cpu_percent = if total_delta == 0 {
        0.0
    } else {
        (100.0 * (total_delta.saturating_sub(idle_delta)) as f64 / total_delta as f64)
            .clamp(0.0, 100.0)
    };
    let memory = parse_numbers(key_value(output, "TB_MEM=")?);
    if memory.len() < 3 {
        return Err("remote health output has incomplete memory values".to_string());
    }
    let total_memory = memory[0].max(0.0) as u64;
    let used_memory = memory[1].max(0.0) as u64;
    let available_memory = memory[2].max(0.0) as u64;

    Ok(RemoteHealthSnapshot {
        system: RemoteSystemInfo {
            os_family: "linux".to_string(),
            os_version: Some(key_value(output, "TB_OS_VERSION=")?.to_string()),
            hostname: key_value(output, "TB_HOSTNAME=")?.to_string(),
            kernel_version: key_value(output, "TB_KERNEL=")?.to_string(),
            architecture: key_value(output, "TB_ARCH=")?.to_string(),
            cpu_count: parse_u64(key_value(output, "TB_CPU_COUNT=")?, "CPU count")?
                .try_into()
                .map_err(|_| "remote health CPU count is too large".to_string())?,
            uptime_secs: parse_u64(key_value(output, "TB_UPTIME=")?, "uptime")?,
        },
        cpu: RemoteCpuInfo {
            usage_percent: cpu_percent,
        },
        memory: RemoteMemoryInfo {
            total_bytes: total_memory,
            used_bytes: used_memory,
            available_bytes: available_memory,
            usage_percent: usage_percent(used_memory, total_memory),
        },
        disk: parse_disk(key_value(output, "TB_DISK=")?)?,
        load: parse_load(key_value(output, "TB_LOAD=")?)?,
    })
}

fn parse_macos_snapshot(output: &str) -> Result<RemoteHealthSnapshot, String> {
    let total_memory = parse_u64(key_value(output, "TB_MEM_TOTAL=")?, "memory total")?;
    let available_memory =
        parse_u64(key_value(output, "TB_MEM_AVAILABLE=")?, "memory available")?.min(total_memory);
    let used_memory = total_memory.saturating_sub(available_memory);
    let boot_values = parse_numbers(key_value(output, "TB_BOOT=")?);
    let boot_time = boot_values
        .first()
        .copied()
        .filter(|value| *value >= 0.0)
        .ok_or_else(|| "remote health output has invalid boot time".to_string())?
        as u64;
    let remote_now = parse_u64(key_value(output, "TB_NOW=")?, "current time")?;
    Ok(RemoteHealthSnapshot {
        system: RemoteSystemInfo {
            os_family: "macos".to_string(),
            os_version: Some(key_value(output, "TB_OS_VERSION=")?.to_string()),
            hostname: key_value(output, "TB_HOSTNAME=")?.to_string(),
            kernel_version: key_value(output, "TB_KERNEL=")?.to_string(),
            architecture: key_value(output, "TB_ARCH=")?.to_string(),
            cpu_count: parse_u64(key_value(output, "TB_CPU_COUNT=")?, "CPU count")?
                .try_into()
                .map_err(|_| "remote health CPU count is too large".to_string())?,
            uptime_secs: remote_now.saturating_sub(boot_time),
        },
        cpu: RemoteCpuInfo {
            usage_percent: parse_f64(key_value(output, "TB_CPU=")?, "CPU usage")?.clamp(0.0, 100.0),
        },
        memory: RemoteMemoryInfo {
            total_bytes: total_memory,
            used_bytes: used_memory,
            available_bytes: available_memory,
            usage_percent: usage_percent(used_memory, total_memory),
        },
        disk: parse_disk(key_value(output, "TB_DISK=")?)?,
        load: parse_load(key_value(output, "TB_LOAD=")?)?,
    })
}

fn collect_blocking(
    request: RemoteHealthSnapshotRequest,
    known_hosts_path: String,
    cancel_flag: Arc<AtomicBool>,
) -> CollectionOutcome {
    if cancelled(&cancel_flag) {
        return CollectionOutcome::Cancelled;
    }
    let session = match open_health_session(&request.connection, Path::new(&known_hosts_path)) {
        Ok(session) => session,
        Err(error) => return CollectionOutcome::Failed(error),
    };
    if cancelled(&cancel_flag) {
        return CollectionOutcome::Cancelled;
    }
    let platform = match exec_read_only(&session.target, PLATFORM_PROBE_COMMAND) {
        Ok(platform) => platform.trim().to_string(),
        Err(error) => {
            return CollectionOutcome::Unsupported(format!(
                "remote platform probe is unavailable: {error}"
            ))
        }
    };
    if cancelled(&cancel_flag) {
        return CollectionOutcome::Cancelled;
    }
    let Some(command) = snapshot_command(&platform) else {
        return CollectionOutcome::Unsupported(format!(
            "remote health snapshots do not support platform {platform}"
        ));
    };
    let parsed = match exec_read_only(&session.target, command) {
        Ok(output) if platform == "Linux" => parse_linux_snapshot(&output),
        Ok(output) => parse_macos_snapshot(&output),
        Err(error) => Err(error),
    };
    if cancelled(&cancel_flag) {
        return CollectionOutcome::Cancelled;
    }
    match parsed {
        Ok(snapshot) => CollectionOutcome::Success(Box::new(snapshot)),
        Err(error) => CollectionOutcome::Failed(error),
    }
}

#[tauri::command]
pub(crate) fn collect_remote_health_snapshot(
    app: AppHandle,
    credentials: State<'_, crate::keychain::CredentialManager>,
    cancellations: State<'_, RemoteHealthCancellationRegistry>,
    mut request: RemoteHealthSnapshotRequest,
) -> Result<RemoteHealthSnapshotResult, String> {
    if !request.authorized {
        return Ok(result(
            &request,
            RemoteHealthResultStatus::Unauthorized,
            None,
            Some("remote health collection requires explicit user authorization".to_string()),
        ));
    }
    if !validate_operation_id(&request.operation_id) {
        return Ok(result(
            &request,
            RemoteHealthResultStatus::Failed,
            None,
            Some("invalid remote health operation id".to_string()),
        ));
    }
    if request.profile_id.trim().is_empty() {
        return Ok(result(
            &request,
            RemoteHealthResultStatus::Failed,
            None,
            Some("remote health profile id is required".to_string()),
        ));
    }
    if !(MIN_TIMEOUT_MS..=MAX_TIMEOUT_MS).contains(&request.timeout_ms) {
        return Ok(result(
            &request,
            RemoteHealthResultStatus::Failed,
            None,
            Some(format!(
                "remote health timeout must be between {MIN_TIMEOUT_MS} and {MAX_TIMEOUT_MS} ms"
            )),
        ));
    }

    if let Err(error) =
        crate::validate_connection_fields(&request.connection.host, &request.connection.username)
    {
        return Ok(result(
            &request,
            RemoteHealthResultStatus::Failed,
            None,
            Some(error),
        ));
    }
    if let Err(error) =
        crate::commands::resolve_keychain_key_for_remote(&credentials, &mut request.connection)
    {
        return Ok(result(
            &request,
            RemoteHealthResultStatus::Failed,
            None,
            Some(error),
        ));
    }
    let known_hosts_path = match crate::known_hosts::known_hosts_path(&app) {
        Ok(path) => path.to_string_lossy().to_string(),
        Err(error) => {
            return Ok(result(
                &request,
                RemoteHealthResultStatus::Failed,
                None,
                Some(error),
            ))
        }
    };
    let cancel_flag = match cancellations.register(request.operation_id.clone()) {
        Ok(flag) => flag,
        Err(error) => {
            return Ok(result(
                &request,
                RemoteHealthResultStatus::Failed,
                None,
                Some(error),
            ))
        }
    };
    let worker_request = request.clone();
    let worker_cancel_flag = cancel_flag.clone();
    let (sender, receiver) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let outcome = collect_blocking(worker_request, known_hosts_path, worker_cancel_flag);
        let _ = sender.send(outcome);
    });

    let started_at = Instant::now();
    let timeout = Duration::from_millis(request.timeout_ms);
    let outcome = loop {
        if cancelled(&cancel_flag) {
            break CollectionOutcome::Cancelled;
        }
        let elapsed = started_at.elapsed();
        if elapsed >= timeout {
            cancel_flag.store(true, Ordering::SeqCst);
            break CollectionOutcome::Failed("__timeout__".to_string());
        }
        let wait = WORKER_POLL_INTERVAL.min(timeout.saturating_sub(elapsed));
        match receiver.recv_timeout(wait) {
            Ok(outcome) => break outcome,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                break CollectionOutcome::Failed(
                    "remote health collection worker stopped unexpectedly".to_string(),
                )
            }
        }
    };
    let _ = cancellations.remove(&request.operation_id);

    Ok(match outcome {
        CollectionOutcome::Success(snapshot) => result(
            &request,
            RemoteHealthResultStatus::Success,
            Some(*snapshot),
            None,
        ),
        CollectionOutcome::Cancelled => result(
            &request,
            RemoteHealthResultStatus::Cancelled,
            None,
            Some("remote health collection was cancelled".to_string()),
        ),
        CollectionOutcome::Unsupported(error) => result(
            &request,
            RemoteHealthResultStatus::Unsupported,
            None,
            Some(error),
        ),
        CollectionOutcome::Failed(error) if error == "__timeout__" => result(
            &request,
            RemoteHealthResultStatus::TimedOut,
            None,
            Some(format!(
                "remote health collection timed out after {} ms",
                request.timeout_ms
            )),
        ),
        CollectionOutcome::Failed(error) => result(
            &request,
            RemoteHealthResultStatus::Failed,
            None,
            Some(error),
        ),
    })
}

#[tauri::command]
pub(crate) fn cancel_remote_health_snapshot(
    cancellations: State<'_, RemoteHealthCancellationRegistry>,
    operation_id: String,
) -> Result<(), String> {
    cancellations.cancel(&operation_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::AuthMethod;

    fn request(authorized: bool) -> RemoteHealthSnapshotRequest {
        RemoteHealthSnapshotRequest {
            operation_id: "remote-health:test".to_string(),
            profile_id: "profile-1".to_string(),
            authorized,
            timeout_ms: 20_000,
            connection: RemoteConnectionRequest {
                host: "example.test".to_string(),
                port: 22,
                username: "operator".to_string(),
                auth_method: AuthMethod::Password,
                password: Some("secret".to_string()),
                keychain_key_id: None,
                private_key_data: None,
                passphrase: None,
                jump_host: None,
            },
        }
    }

    #[test]
    fn built_in_command_set_contains_no_mutating_programs_or_redirects() {
        for command in [
            PLATFORM_PROBE_COMMAND,
            LINUX_SNAPSHOT_COMMAND,
            MACOS_SNAPSHOT_COMMAND,
        ] {
            let normalized = command.to_ascii_lowercase();
            for forbidden in [
                "sudo ",
                " rm ",
                " mv ",
                " cp ",
                " tee ",
                "chmod",
                "chown",
                "kill",
                "systemctl",
                "service ",
                "apt ",
                "yum ",
                "dnf ",
                "brew ",
                "curl ",
                "wget ",
                ">",
                "truncate",
                "mount ",
                "reboot",
                "shutdown",
            ] {
                assert!(
                    !normalized.contains(forbidden),
                    "read-only command set contains {forbidden:?}"
                );
            }
        }
    }

    #[test]
    fn unauthorized_result_keeps_time_source_and_profile_identity() {
        let request = request(false);
        let result = result(
            &request,
            RemoteHealthResultStatus::Unauthorized,
            None,
            Some("authorization required".to_string()),
        );
        assert_eq!(result.profile_id, "profile-1");
        assert_eq!(result.source.profile_id, "profile-1");
        assert_eq!(result.source.host, "example.test");
        assert_eq!(result.source.kind, "sshReadOnly");
        assert!(result.checked_at > 0);
        assert_eq!(result.status, RemoteHealthResultStatus::Unauthorized);
    }

    #[test]
    fn unsupported_platform_has_no_snapshot_command() {
        assert_eq!(snapshot_command("Linux"), Some(LINUX_SNAPSHOT_COMMAND));
        assert_eq!(snapshot_command("Darwin"), Some(MACOS_SNAPSHOT_COMMAND));
        assert_eq!(snapshot_command("FreeBSD"), None);
        assert_eq!(snapshot_command("Windows_NT"), None);
    }

    #[test]
    fn timeout_and_unsupported_results_keep_auditable_metadata() {
        let request = request(true);
        for status in [
            RemoteHealthResultStatus::TimedOut,
            RemoteHealthResultStatus::Unsupported,
        ] {
            let result = result(&request, status, None, Some("bounded failure".to_string()));
            assert_eq!(result.profile_id, request.profile_id);
            assert_eq!(result.source.profile_id, request.profile_id);
            assert_eq!(result.source.command_set_version, COMMAND_SET_VERSION);
            assert!(result.snapshot.is_none());
            assert!(result.checked_at > 0);
        }
    }

    #[test]
    fn parses_linux_snapshot_metrics() {
        let output = "\
TB_HOSTNAME=prod-1\n\
TB_KERNEL=6.8.0\n\
TB_ARCH=x86_64\n\
TB_OS_VERSION=Ubuntu 24.04.1 LTS\n\
TB_CPU_COUNT=4\n\
TB_UPTIME=3600.25\n\
TB_LOAD=0.50 0.25 0.10\n\
TB_CPU_1=cpu 100 0 50 850 0 0 0 0\n\
TB_CPU_2=cpu 120 0 60 920 0 0 0 0\n\
TB_MEM=8589934592 4294967296 4294967296\n\
TB_DISK=104857600 52428800 52428800 50% /\n";
        let snapshot = parse_linux_snapshot(output).expect("parse linux snapshot");
        assert_eq!(snapshot.system.hostname, "prod-1");
        assert_eq!(
            snapshot.system.os_version.as_deref(),
            Some("Ubuntu 24.04.1 LTS")
        );
        assert_eq!(snapshot.system.cpu_count, 4);
        assert_eq!(snapshot.system.uptime_secs, 3600);
        assert!((snapshot.cpu.usage_percent - 30.0).abs() < 0.001);
        assert_eq!(snapshot.memory.usage_percent, 50.0);
        assert_eq!(snapshot.disk.usage_percent, 50.0);
        assert_eq!(snapshot.load.one_minute, 0.5);
    }

    #[test]
    fn parses_macos_snapshot_metrics() {
        let output = "\
TB_HOSTNAME=mac-mini\n\
TB_KERNEL=25.0.0\n\
TB_ARCH=arm64\n\
TB_OS_VERSION=15.5\n\
TB_CPU_COUNT=10\n\
TB_LOAD={ 1.50 1.25 1.00 }\n\
TB_CPU=17.5\n\
TB_MEM_TOTAL=17179869184\n\
TB_MEM_AVAILABLE=8589934592\n\
TB_NOW=1724407200\n\
TB_BOOT={ sec = 1724400000, usec = 0 } Fri Aug 23 06:00:00 2026\n\
TB_DISK=1000000 250000 750000 25% /\n";
        let snapshot = parse_macos_snapshot(output).expect("parse macOS snapshot");
        assert_eq!(snapshot.system.os_family, "macos");
        assert_eq!(snapshot.system.os_version.as_deref(), Some("15.5"));
        assert_eq!(snapshot.cpu.usage_percent, 17.5);
        assert_eq!(snapshot.memory.usage_percent, 50.0);
        assert_eq!(snapshot.load.fifteen_minutes, 1.0);
    }

    #[test]
    fn cancellation_is_observed_before_any_connection_attempt() {
        let flag = Arc::new(AtomicBool::new(true));
        let outcome = collect_blocking(request(true), "unused".to_string(), flag);
        assert!(matches!(outcome, CollectionOutcome::Cancelled));
    }

    #[test]
    #[ignore = "requires the isolated tests/ssh-e2e Docker service"]
    fn isolated_ssh_sftp_end_to_end_remote_health() {
        let host =
            std::env::var("TERMBRIDGE_E2E_SSH_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
        let port = std::env::var("TERMBRIDGE_E2E_SSH_PORT")
            .ok()
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(22222);
        let username = std::env::var("TERMBRIDGE_E2E_SSH_USERNAME")
            .unwrap_or_else(|_| "termbridge".to_string());
        let password = std::env::var("TERMBRIDGE_E2E_SSH_PASSWORD")
            .unwrap_or_else(|_| "termbridge-e2e".to_string());
        let connection = RemoteConnectionRequest {
            host,
            port,
            username,
            auth_method: AuthMethod::Password,
            password: Some(password),
            keychain_key_id: None,
            private_key_data: None,
            passphrase: None,
            jump_host: None,
        };
        let (_known_hosts_temp, known_hosts_path) =
            crate::connection::trusted_known_hosts_fixture(&connection.host, connection.port);
        let session = open_health_session(&connection, &known_hosts_path)
            .expect("authenticate with the trusted host key");
        let output =
            exec_read_only(&session.target, LINUX_SNAPSHOT_COMMAND).expect("collect snapshot");
        let snapshot = parse_linux_snapshot(&output).expect("parse snapshot");
        assert_eq!(snapshot.system.os_family, "linux");
        assert!(snapshot.system.cpu_count >= 1);
        assert!(snapshot.memory.total_bytes > 0);
        assert!(snapshot.disk.total_bytes > 0);
    }
}
