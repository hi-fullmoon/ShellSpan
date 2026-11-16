//! NIP is independent of TSP/1 and Agent events. Private channels only.
use bytes::BytesMut;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::{Duration, Instant};
use tokio_util::codec::{Decoder as FrameDecoder, LinesCodec};

pub const PROTOCOL: &str = "shellspan.native-input";
pub const MAX_MESSAGE_BYTES: usize = 131_072;
pub const DISPLAY_OSC: u32 = 1337;
pub const DISPLAY_ENTER: &str = "SetUserVar=ShellSpanNativeInput=MQ==";
pub const DISPLAY_EXIT: &str = "SetUserVar=ShellSpanNativeInput=MA==";
pub const VERIFIED_PROFILE: &str = "gnu-bash-5.3-readline-8.3.6-macos-arm64-prototype";
pub const LINUX_ARM64_BASH_TARGET: &str = "linux-aarch64-glibc-2.36";
pub const LINUX_X86_64_BASH_TARGET: &str = "linux-x86_64-glibc-2.36";

pub fn capture_marker(request_id: &str, end: bool) -> Vec<u8> {
    let token = sha(&format!(
        "{request_id}:{}",
        if end { "end" } else { "start" }
    ));
    format!("\x1b]1337;ShellSpanCapture={token}\x07").into_bytes()
}

pub fn native_profile_versions(profile: &str) -> Option<(&'static str, &'static str, u32)> {
    for (bash, readline, numeric) in [
        ("4.1", "6.0", 0x0600),
        ("4.4", "7.0", 0x0700),
        ("5.3", "8.3.6", 0x0803),
    ] {
        for target in [
            "macos-arm64",
            LINUX_ARM64_BASH_TARGET,
            LINUX_X86_64_BASH_TARGET,
        ] {
            if target == LINUX_X86_64_BASH_TARGET && bash != "5.3" {
                continue;
            }
            if profile == format!("gnu-bash-{bash}-readline-{readline}-{target}-native") {
                return Some((bash, readline, numeric));
            }
        }
    }
    None
}
pub fn native_editor_version_matches(numeric: u32, reported: &str) -> bool {
    // These pinned Bash tarballs leave Readline's public string at 5.1 while
    // exposing the verified 6.0/7.0 numeric ABI. Hash verification is mandatory;
    // neither the string nor the numeric ABI alone establishes support.
    match numeric {
        0x0600 | 0x0700 => reported == "5.1",
        0x0803 => reported.starts_with("8.3"),
        _ => false,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionIdentity {
    pub terminal_session_id: String,
    pub terminal_generation: u64,
    pub control_id: String,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ShellFamily {
    Bash,
    Zsh,
    WindowsPowerShell,
    PowerShell7,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EditorFamily {
    Readline,
    Zle,
    PsReadLine,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerProfile {
    pub shell: ShellFamily,
    pub shell_version: Option<String>,
    pub editor: EditorFamily,
    pub editor_version: Option<String>,
    pub editor_numeric_version: u32,
    pub adapter_version: String,
    pub verified_profile_id: Option<String>,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ConnectionPayload {
    Probe,
    Capabilities {
        profile: PeerProfile,
        native_inline: bool,
        source_echo: bool,
        atomic_handoff: bool,
        complete_proof: bool,
        draft_clear: bool,
        inband_display: bool,
        editor_empty: bool,
    },
    EditorReady {
        editor_empty: bool,
        owned_draft_absent: bool,
        after_command: Option<Identity>,
    },
    Directory {
        cwd: String,
    },
    EditorOptions {
        interactive_comments: bool,
        native_jobs: bool,
    },
    JobObservation {
        handle: String,
        state: String,
        exit_code: Option<i32>,
    },
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionEnvelope {
    pub protocol: String,
    pub request_id: String,
    pub connection: ConnectionIdentity,
    pub payload: ConnectionPayload,
}
impl ConnectionEnvelope {
    pub fn validate(&self) -> Result<(), ErrorCode> {
        if self.protocol != PROTOCOL {
            return Err(ErrorCode::Version);
        }
        if !valid_identifier(&self.request_id)
            || !valid_identifier(&self.connection.terminal_session_id)
            || !valid_identifier(&self.connection.control_id)
            || self.connection.terminal_generation == 0
            || self.connection.terminal_generation > 9_007_199_254_740_991
        {
            return Err(ErrorCode::Identity);
        }
        if let ConnectionPayload::Capabilities { profile, .. } = &self.payload {
            if [
                &profile.shell_version,
                &profile.editor_version,
                &profile.verified_profile_id,
            ]
            .iter()
            .any(|value| {
                value
                    .as_ref()
                    .is_some_and(|value| value.len() > 128 || value.chars().any(char::is_control))
            }) || profile.adapter_version.is_empty()
                || profile.adapter_version.len() > 128
                || profile.adapter_version.chars().any(char::is_control)
            {
                return Err(ErrorCode::Limit);
            }
        }
        if let ConnectionPayload::EditorReady {
            after_command: Some(identity),
            ..
        } = &self.payload
        {
            identity.validate()?;
            if identity.terminal_session_id != self.connection.terminal_session_id
                || identity.terminal_generation != self.connection.terminal_generation
            {
                return Err(ErrorCode::Identity);
            }
        }
        match &self.payload {
            ConnectionPayload::Directory { cwd }
                if cwd.len() > 4096 || cwd.chars().any(char::is_control) =>
            {
                return Err(ErrorCode::Limit)
            }
            ConnectionPayload::JobObservation { handle, state, .. }
                if !valid_job_handle(handle)
                    || !matches!(
                        state.as_str(),
                        "running"
                            | "queued"
                            | "stopped"
                            | "stopRequested"
                            | "finished"
                            | "settled"
                            | "terminated"
                            | "uncertain"
                            | "rejected"
                    ) =>
            {
                return Err(ErrorCode::Binding)
            }
            _ => {}
        }
        Ok(())
    }
    pub fn encode(&self) -> Result<Vec<u8>, ErrorCode> {
        self.validate()?;
        encode_line(self)
    }
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Message {
    Connection(ConnectionEnvelope),
    Operation(Envelope),
}
impl Message {
    pub fn validate(&self) -> Result<(), ErrorCode> {
        match self {
            Self::Connection(value) => value.validate(),
            Self::Operation(value) => value.validate(),
        }
    }
    pub fn into_operation(self) -> Option<Envelope> {
        match self {
            Self::Operation(value) => Some(value),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum InputMode {
    NativeInline,
    Raw,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum DisplayUnicodeVersion {
    #[serde(rename = "11")]
    Unicode11,
    #[serde(rename = "15-graphemes")]
    Graphemes15,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayBinding {
    pub protocol: &'static str,
    pub input_mode: InputMode,
    pub osc_identifier: u32,
    pub enter_payload: &'static str,
    pub exit_payload: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unicode_version: Option<DisplayUnicodeVersion>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unicode_scope: Option<DisplayUnicodeScope>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owned_reflow_cursor_line: Option<bool>,
}
impl DisplayBinding {
    pub fn native() -> Self {
        Self {
            protocol: PROTOCOL,
            input_mode: InputMode::NativeInline,
            osc_identifier: DISPLAY_OSC,
            enter_payload: DISPLAY_ENTER,
            exit_payload: DISPLAY_EXIT,
            unicode_version: None,
            unicode_scope: None,
            owned_reflow_cursor_line: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DisplayUnicodeScope {
    Session,
}

pub fn native_bash_plan(source: &str) -> Result<String, ErrorCode> {
    shlex::try_quote(source)
        .map(|quoted| format!("builtin ss_native_input_begin \"$?\"; builtin eval -- {quoted}"))
        .map_err(|_| ErrorCode::Binding)
}

/// Source is returned to the existing host/parser; editor callbacks never eval.
pub fn native_foreground_plan(source: &str, shell: ShellFamily) -> Result<String, ErrorCode> {
    match shell {
        ShellFamily::Bash => native_bash_plan(source),
        ShellFamily::Zsh => Ok(source.into()),
        ShellFamily::WindowsPowerShell | ShellFamily::PowerShell7 => {
            serde_json::to_string(&("native-powershell-host", sha(source)))
                .map_err(|_| ErrorCode::Binding)
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum JobExecution {
    Launch {
        handle: String,
    },
    Control {
        handle: String,
        stop: bool,
        nonce: String,
    },
}
pub fn valid_job_handle(handle: &str) -> bool {
    handle.strip_prefix("job-").is_some_and(|suffix| {
        suffix.len() == 32 && suffix.bytes().all(|byte| byte.is_ascii_hexdigit())
    })
}
pub fn native_bash_job_plan(source: &str, job: &JobExecution) -> Result<String, ErrorCode> {
    let handle = match job {
        JobExecution::Launch { handle } | JobExecution::Control { handle, .. } => handle,
    };
    if !valid_job_handle(handle) {
        return Err(ErrorCode::Binding);
    }
    let body = match job {
        JobExecution::Launch { .. } => {
            let quoted = shlex::try_quote(source).map_err(|_| ErrorCode::Binding)?;
            format!("if __shellspan_native_job_arm {handle} {quoted}; then ( {handle};\nbuiltin eval -- {quoted}\n) &\nfi")
        }
        JobExecution::Control { stop, nonce, .. } => {
            if nonce.len() != 32
                || !nonce
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            {
                return Err(ErrorCode::Binding);
            }
            let expected = format!(
                "__shellspan_job_control {handle} {}",
                if *stop { "stop" } else { "poll" }
            );
            if source != expected {
                return Err(ErrorCode::Binding);
            }
            return serde_json::to_string(&("native-job-control", handle, *stop, nonce))
                .map_err(|_| ErrorCode::Binding);
        }
    };
    Ok(format!("builtin ss_native_input_begin \"$?\"; {body}"))
}

pub fn native_shell_job_plan(
    source: &str,
    shell: ShellFamily,
    job: &JobExecution,
) -> Result<String, ErrorCode> {
    if shell == ShellFamily::Bash {
        return native_bash_job_plan(source, job);
    }
    let handle = match job {
        JobExecution::Launch { handle } | JobExecution::Control { handle, .. } => handle,
    };
    if !valid_job_handle(handle) {
        return Err(ErrorCode::Binding);
    }
    match job {
        JobExecution::Launch { .. } => {
            let line = if shell == ShellFamily::Zsh {
                format!("( {handle};\n{source}\n) &")
            } else {
                format!("{handle} '{}'", source.replace('\'', "''"))
            };
            if shell == ShellFamily::Zsh {
                Ok(line)
            } else {
                serde_json::to_string(&("native-powershell-job", handle, sha(source)))
                    .map_err(|_| ErrorCode::Binding)
            }
        }
        JobExecution::Control { stop, nonce, .. } => {
            let action = if *stop { "stop" } else { "poll" };
            let expected = if shell == ShellFamily::Zsh {
                format!("__shellspan_job_control {handle} {action}")
            } else {
                format!("& $__shellspanModule {{ param($h,$a) & ${{function:Invoke-ShellSpanNativeJobControl}} $h $a }} '{handle}' '{action}'")
            };
            if source != expected
                || nonce.len() != 32
                || !nonce
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            {
                return Err(ErrorCode::Binding);
            }
            serde_json::to_string(&("native-job-control", handle, *stop, nonce))
                .map_err(|_| ErrorCode::Binding)
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Identity {
    pub terminal_session_id: String,
    pub terminal_generation: u64,
    pub lease_id: String,
    pub lease_generation: u64,
    pub agent_session_id: String,
    pub task_id: String,
    pub operation_id: String,
    pub command_id: String,
    pub source_revision: u64,
}
impl Identity {
    pub fn validate(&self) -> Result<(), ErrorCode> {
        for value in [
            &self.terminal_session_id,
            &self.lease_id,
            &self.agent_session_id,
            &self.task_id,
            &self.operation_id,
            &self.command_id,
        ] {
            if !valid_identifier(value) {
                return Err(ErrorCode::Identity);
            }
        }
        for counter in [
            self.terminal_generation,
            self.lease_generation,
            self.source_revision,
        ] {
            if counter == 0 || counter > 9_007_199_254_740_991 {
                return Err(ErrorCode::Identity);
            }
        }
        Ok(())
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Envelope {
    pub protocol: String,
    pub request_id: String,
    pub identity: Identity,
    pub payload: Payload,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Payload {
    PrepareInput {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        job: Option<JobExecution>,
        source: String,
        source_digest: String,
        plan: String,
        plan_digest: String,
        budget_ms: u32,
        reduced_motion: bool,
    },
    Prepared {
        source_digest: String,
        plan_digest: String,
    },
    InputProgress {
        applied_utf8_bytes: usize,
    },
    InputConfirmed {
        source_digest: String,
        plan_digest: String,
        utf8_bytes: usize,
        cursor_utf8_bytes: usize,
        end_utf8_bytes: usize,
    },
    ControlInputConfirmed {
        plan_digest: String,
        editor_empty: bool,
    },
    Commit {
        source_digest: String,
        plan_digest: String,
    },
    CommitArmed,
    SubmissionAccepted,
    Started,
    Settled {
        exit_code: i32,
    },
    CancelDraft,
    DraftCleared {
        editor_empty: bool,
    },
    Interrupt,
    Query,
    Snapshot {
        phase: String,
        may_have_submitted: bool,
        editor_utf8_valid: bool,
        cursor_utf8_bytes: Option<usize>,
        end_utf8_bytes: Option<usize>,
    },
    Rejected {
        code: ErrorCode,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    Version,
    Identity,
    DuplicateRequest,
    Limit,
    Expired,
    Binding,
    State,
    RecoveryRequired,
}
impl ErrorCode {
    pub fn code(self) -> &'static str {
        match self {
            Self::Version => "VERSION",
            Self::Identity => "IDENTITY",
            Self::DuplicateRequest => "DUPLICATE_REQUEST",
            Self::Limit => "LIMIT",
            Self::Expired => "EXPIRED",
            Self::Binding => "BINDING",
            Self::State => "STATE",
            Self::RecoveryRequired => "RECOVERY_REQUIRED",
        }
    }
}

impl Envelope {
    pub fn validate(&self) -> Result<(), ErrorCode> {
        if self.protocol != PROTOCOL {
            return Err(ErrorCode::Version);
        }
        self.identity.validate()?;
        if !valid_identifier(&self.request_id) {
            return Err(ErrorCode::Identity);
        }
        let binding = match &self.payload {
            Payload::Prepared {
                source_digest,
                plan_digest,
            }
            | Payload::InputConfirmed {
                source_digest,
                plan_digest,
                ..
            }
            | Payload::Commit {
                source_digest,
                plan_digest,
            } => Some((source_digest, plan_digest)),
            _ => None,
        };
        if binding.is_some_and(|(source, plan)| {
            [source, plan].iter().any(|digest| {
                digest.len() != 64
                    || !digest
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            })
        }) {
            return Err(ErrorCode::Binding);
        }
        match &self.payload {
            Payload::InputProgress { applied_utf8_bytes } if *applied_utf8_bytes > 8192 => {
                return Err(ErrorCode::Limit)
            }
            Payload::InputConfirmed {
                utf8_bytes,
                cursor_utf8_bytes,
                end_utf8_bytes,
                ..
            } if [utf8_bytes, cursor_utf8_bytes, end_utf8_bytes]
                .iter()
                .any(|value| **value > 8192) =>
            {
                return Err(ErrorCode::Limit)
            }
            Payload::Snapshot {
                phase,
                cursor_utf8_bytes,
                end_utf8_bytes,
                ..
            } if !matches!(
                phase.as_str(),
                "preparing"
                    | "typing"
                    | "inputConfirmed"
                    | "submissionAttempted"
                    | "running"
                    | "completed"
                    | "recoveryRequired"
            ) || [cursor_utf8_bytes, end_utf8_bytes]
                .iter()
                .any(|value| value.is_some_and(|value| value > 9_007_199_254_740_991)) =>
            {
                return Err(ErrorCode::Binding);
            }
            _ => {}
        }
        if let Payload::PrepareInput {
            source,
            source_digest,
            plan,
            plan_digest,
            budget_ms,
            job,
            ..
        } = &self.payload
        {
            if let Some(job) = job {
                if ![
                    ShellFamily::Bash,
                    ShellFamily::Zsh,
                    ShellFamily::WindowsPowerShell,
                    ShellFamily::PowerShell7,
                ]
                .into_iter()
                .any(|shell| {
                    native_shell_job_plan(source, shell, job)
                        .is_ok_and(|expected| expected == *plan)
                }) {
                    return Err(ErrorCode::Binding);
                }
            }
            if source.is_empty()
                || source.len() > 8192
                || plan.len() > 32768
                || *budget_ms == 0
                || *budget_ms > 5000
                || source
                    .chars()
                    .any(|c| c == '\0' || c.is_control() && !matches!(c, '\r' | '\n' | '\t'))
            {
                return Err(ErrorCode::Limit);
            }
            if sha(source) != *source_digest
                || bound_plan_digest(source_digest, plan) != *plan_digest
            {
                return Err(ErrorCode::Binding);
            }
        }
        if let Payload::ControlInputConfirmed { plan_digest, .. } = &self.payload {
            if plan_digest.len() != 64
                || !plan_digest
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            {
                return Err(ErrorCode::Binding);
            }
        }
        Ok(())
    }
    pub fn encode(&self) -> Result<Vec<u8>, ErrorCode> {
        self.validate()?;
        encode_line(self)
    }
}
fn encode_line(value: &impl Serialize) -> Result<Vec<u8>, ErrorCode> {
    let mut encoded = serde_json::to_vec(value).map_err(|_| ErrorCode::Limit)?;
    if encoded.len() >= MAX_MESSAGE_BYTES {
        return Err(ErrorCode::Limit);
    }
    encoded.push(b'\n');
    Ok(encoded)
}
pub fn sha(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}
// Exactly the existing Broker/native capability identifier contract, not a new
// UUID format or a restriction introduced by NIP. All separators remain valid.
pub fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || index > 0 && b"._:-".contains(&byte)
        })
}
pub fn bound_plan_digest(source_digest: &str, plan: &str) -> String {
    hex::encode(Sha256::digest(
        serde_json::to_vec(&(source_digest, plan)).expect("string tuple"),
    ))
}

#[derive(Debug)]
pub struct Decoder {
    pending: BytesMut,
    codec: LinesCodec,
}
impl Default for Decoder {
    fn default() -> Self {
        Self {
            pending: BytesMut::new(),
            codec: LinesCodec::new_with_max_length(MAX_MESSAGE_BYTES - 1),
        }
    }
}
impl Decoder {
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<Message>, ErrorCode> {
        let mut result = Vec::new();
        // Chunking bounds buffering even if an OS read coalesces many complete
        // messages. LinesCodec owns delimiter, partial UTF-8 and length handling.
        for chunk in bytes.chunks(8192) {
            self.pending.extend_from_slice(chunk);
            while let Some(line) = self
                .codec
                .decode(&mut self.pending)
                .map_err(|_| ErrorCode::Limit)?
            {
                let message: Message =
                    serde_json::from_str(&line).map_err(|_| ErrorCode::Binding)?;
                message.validate()?;
                result.push(message);
            }
        }
        Ok(result)
    }
    pub fn finish(&self) -> Result<(), ErrorCode> {
        if self.pending.is_empty() {
            Ok(())
        } else {
            Err(ErrorCode::RecoveryRequired)
        }
    }
}

/// Monotonic budget starts once at preparation, never resets on resize/query.
pub struct RequestGuard {
    identity: Identity,
    prepared: bool,
    committed: bool,
    cancelled: bool,
    interrupted: bool,
    deadline: Option<Instant>,
}
impl RequestGuard {
    pub fn new(identity: Identity) -> Self {
        Self {
            identity,
            prepared: false,
            committed: false,
            cancelled: false,
            interrupted: false,
            deadline: None,
        }
    }
    pub fn accept(&mut self, request: &Envelope) -> Result<(), ErrorCode> {
        request.validate()?;
        if self.identity() != &request.identity {
            return Err(ErrorCode::Identity);
        }
        // Query has no side effects or replay cache. Safety controls have their
        // own permanent one-shot slots; polling can never consume those slots.
        match request.payload {
            Payload::Query => return Ok(()),
            Payload::CancelDraft if !self.cancelled => {
                self.cancelled = true;
                return Ok(());
            }
            Payload::Interrupt if !self.interrupted => {
                self.interrupted = true;
                return Ok(());
            }
            Payload::CancelDraft | Payload::Interrupt => return Err(ErrorCode::DuplicateRequest),
            _ => {}
        }
        if self.expired() {
            return Err(ErrorCode::Expired);
        }
        match request.payload {
            Payload::PrepareInput { budget_ms, .. } if !self.prepared => {
                self.prepared = true;
                self.deadline = Some(Instant::now() + Duration::from_millis(u64::from(budget_ms)));
            }
            Payload::Commit { .. } if self.prepared && !self.committed => {
                self.committed = true;
            }
            Payload::PrepareInput { .. } | Payload::Commit { .. } => {
                return Err(ErrorCode::DuplicateRequest)
            }
            _ => return Err(ErrorCode::State),
        }
        Ok(())
    }
    pub fn expired(&self) -> bool {
        self.deadline
            .is_some_and(|deadline| Instant::now() >= deadline)
    }
    pub fn identity(&self) -> &Identity {
        &self.identity
    }
}
