use serde::Deserialize;

use crate::agent_contract_v3::{
    AgentExecutionChannelV3, AgentToolResultStatusV3, AgentToolResultV3,
};

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum ExecStateV3 {
    Running,
    Exited,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExecResultDataV3 {
    channel: AgentExecutionChannelV3,
    state: ExecStateV3,
    #[serde(default)]
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    #[serde(default)]
    combined_output: Option<String>,
    #[serde(default)]
    process_handle: Option<String>,
    #[serde(default)]
    duration_ms: Option<u64>,
    truncated: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WriteStdinResultDataV3 {
    accepted_bytes: u64,
    closed: bool,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum WaitStateV3 {
    Running,
    Exited,
    Unknown,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WaitResultDataV3 {
    state: WaitStateV3,
    #[serde(default)]
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    truncated: bool,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum KillStateV3 {
    TerminationRequested,
    Terminated,
    Unknown,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KillResultDataV3 {
    state: KillStateV3,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadFileResultDataV3 {
    path: String,
    encoding: crate::agent_contract_v3::FileEncodingV3,
    byte_length: u64,
    sha256: String,
    #[serde(default)]
    content: Option<String>,
    offset: u64,
    truncated: bool,
    is_binary: bool,
    sensitive: bool,
    untrusted: bool,
    #[serde(default)]
    permissions: Option<u32>,
    #[serde(default)]
    modified_at_unix_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DirectoryEntryResultDataV3 {
    name: String,
    path: String,
    kind: String,
    #[serde(default)]
    byte_length: Option<u64>,
    sensitive: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListDirectoryResultDataV3 {
    path: String,
    entries: Vec<DirectoryEntryResultDataV3>,
    #[serde(default)]
    next_cursor: Option<String>,
    sensitive: bool,
    untrusted: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SearchMatchResultDataV3 {
    path: String,
    #[serde(default)]
    line: Option<u64>,
    #[serde(default)]
    column: Option<u64>,
    #[serde(default)]
    preview: Option<String>,
    sensitive: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SearchTextResultDataV3 {
    root_path: String,
    matches: Vec<SearchMatchResultDataV3>,
    #[serde(default)]
    next_cursor: Option<String>,
    truncated: bool,
    sensitive: bool,
    untrusted: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PatchedFileResultDataV3 {
    path: String,
    before_sha256: String,
    after_sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ApplyPatchResultDataV3 {
    applied: bool,
    diff: String,
    #[serde(default)]
    checkpoint_id: Option<String>,
    #[serde(default)]
    verified: Option<bool>,
    files: Vec<PatchedFileResultDataV3>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TransferFileResultDataV3 {
    direction: crate::agent_contract_v3::TransferDirectionV3,
    source_path: String,
    destination_path: String,
    bytes_transferred: u64,
    sha256: String,
    checkpoint_id: String,
    verified: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdatePlanResultDataV3 {
    plan_version: u64,
    accepted_steps: u64,
}

pub(crate) fn validate_m1_result_data_v3(result: &AgentToolResultV3) -> Result<(), String> {
    if result.summary.trim().is_empty() || result.summary.len() > 4096 {
        return Err("tool result summary is invalid".into());
    }
    if result.status == AgentToolResultStatusV3::Completed && result.data.is_none() {
        return Err("completed tool result has no data".into());
    }
    let Some(data) = result.data.clone() else {
        return Ok(());
    };
    match result.tool_name.as_str() {
        "exec_command" => {
            let data: ExecResultDataV3 = serde_json::from_value(data)
                .map_err(|error| format!("invalid exec result data: {error}"))?;
            if data.stdout.len() > 1_048_576
                || data.stderr.len() > 1_048_576
                || data
                    .combined_output
                    .as_deref()
                    .is_some_and(|output| output.len() > 1_048_576)
                || (data.state == ExecStateV3::Running && data.process_handle.is_none())
                || (data.state == ExecStateV3::Running && data.exit_code.is_some())
                || (data.channel == AgentExecutionChannelV3::Pty && data.combined_output.is_none())
            {
                return Err("exec result data is semantically invalid".into());
            }
            let _ = (data.duration_ms, data.truncated);
        }
        "write_stdin" => {
            let data: WriteStdinResultDataV3 = serde_json::from_value(data)
                .map_err(|error| format!("invalid stdin result data: {error}"))?;
            if data.accepted_bytes > 65_536 {
                return Err("stdin accepted byte count exceeds the call contract".into());
            }
            let _ = data.closed;
        }
        "wait_process" => {
            let data: WaitResultDataV3 = serde_json::from_value(data)
                .map_err(|error| format!("invalid wait result data: {error}"))?;
            if data.stdout.len() > 1_048_576
                || data.stderr.len() > 1_048_576
                || (data.state == WaitStateV3::Running && data.exit_code.is_some())
            {
                return Err("wait result data is semantically invalid".into());
            }
            let _ = data.truncated;
        }
        "kill_process" => {
            let data: KillResultDataV3 = serde_json::from_value(data)
                .map_err(|error| format!("invalid kill result data: {error}"))?;
            let _ = data.state;
        }
        "read_file" => {
            let data: ReadFileResultDataV3 = serde_json::from_value(data)
                .map_err(|error| format!("invalid read_file result data: {error}"))?;
            if data.path.is_empty()
                || data.sha256.len() != 64
                || data
                    .content
                    .as_deref()
                    .is_some_and(|content| content.len() > 1_398_104)
                || !data.untrusted
            {
                return Err("read_file result data is semantically invalid".into());
            }
            let _ = (
                data.encoding,
                data.byte_length,
                data.offset,
                data.truncated,
                data.is_binary,
                data.sensitive,
                data.permissions,
                data.modified_at_unix_ms,
            );
        }
        "list_directory" => {
            let data: ListDirectoryResultDataV3 = serde_json::from_value(data)
                .map_err(|error| format!("invalid list_directory result data: {error}"))?;
            if data.path.is_empty() || data.entries.len() > 1_000 || !data.untrusted {
                return Err("list_directory result data is semantically invalid".into());
            }
            for entry in data.entries {
                if entry.name.is_empty()
                    || entry.path.is_empty()
                    || !matches!(
                        entry.kind.as_str(),
                        "file" | "directory" | "symlink" | "other"
                    )
                {
                    return Err("directory entry is semantically invalid".into());
                }
                let _ = (entry.byte_length, entry.sensitive);
            }
            let _ = (data.next_cursor, data.sensitive);
        }
        "search_text" => {
            let data: SearchTextResultDataV3 = serde_json::from_value(data)
                .map_err(|error| format!("invalid search_text result data: {error}"))?;
            if data.root_path.is_empty() || data.matches.len() > 1_000 || !data.untrusted {
                return Err("search_text result data is semantically invalid".into());
            }
            for found in data.matches {
                if found.path.is_empty()
                    || found
                        .preview
                        .as_deref()
                        .is_some_and(|preview| preview.len() > 4_096)
                {
                    return Err("search match is semantically invalid".into());
                }
                let _ = (found.line, found.column, found.sensitive);
            }
            let _ = (data.next_cursor, data.truncated, data.sensitive);
        }
        "apply_patch" => {
            let data: ApplyPatchResultDataV3 = serde_json::from_value(data)
                .map_err(|error| format!("invalid apply_patch result data: {error}"))?;
            if data.diff.is_empty()
                || data.diff.len() > 1_048_576
                || data.files.is_empty()
                || data.files.len() > 128
                || (data.applied && (data.checkpoint_id.is_none() || data.verified != Some(true)))
            {
                return Err("apply_patch result data is semantically invalid".into());
            }
            for file in data.files {
                if file.path.is_empty()
                    || file.before_sha256.len() != 64
                    || file.after_sha256.len() != 64
                {
                    return Err("patched file result is semantically invalid".into());
                }
            }
        }
        "transfer_file" => {
            let data: TransferFileResultDataV3 = serde_json::from_value(data)
                .map_err(|error| format!("invalid transfer_file result data: {error}"))?;
            if data.source_path.is_empty()
                || data.destination_path.is_empty()
                || data.sha256.len() != 64
                || data.checkpoint_id.is_empty()
                || !data.verified
            {
                return Err("transfer_file result data is semantically invalid".into());
            }
            let _ = (data.direction, data.bytes_transferred);
        }
        "update_plan" => {
            let data: UpdatePlanResultDataV3 = serde_json::from_value(data)
                .map_err(|error| format!("invalid update_plan result data: {error}"))?;
            if data.plan_version == 0 || data.accepted_steps == 0 || data.accepted_steps > 100 {
                return Err("update_plan result data is semantically invalid".into());
            }
        }
        _ => return Err("M2 result validator refuses an unavailable tool".into()),
    }
    Ok(())
}
