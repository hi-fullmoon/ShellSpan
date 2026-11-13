//! Explicit isolated acceptance evidence. Observations never become protocol
//! receipts, approvals, input proofs or recovery state. Absent from release builds.
use serde_json::{json, Value};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MAX_BYTES: u64 = 64 * 1024 * 1024;
const ERROR: &str = "TERMINAL_ACCEPTANCE_TRACE_UNAVAILABLE";
static TRACE: OnceLock<Result<Option<Trace>, String>> = OnceLock::new();

struct State {
    file: File,
    bytes: u64,
    sequence: u64,
    failed: bool,
}
struct Trace {
    state: Mutex<State>,
    started: Instant,
    path: PathBuf,
    cut_used: AtomicBool,
    settlement_cut_used: AtomicBool,
    active_cut: Mutex<Option<Value>>,
    expected_key: Mutex<Option<(String, super::protocol::Identity, &'static [u8])>>,
}

struct ActiveCut<'a>(&'a Mutex<Option<Value>>);
impl Drop for ActiveCut<'_> {
    fn drop(&mut self) {
        if let Ok(mut current) = self.0.lock() {
            *current = None;
        }
    }
}

fn private_directory(path: &Path) -> Result<(), String> {
    let info = fs::symlink_metadata(path).map_err(|_| ERROR)?;
    if !info.is_dir()
        || info.file_type().is_symlink()
        || info.uid() != unsafe { libc::geteuid() }
        || info.mode() & 0o777 != 0o700
        || fs::canonicalize(path).map_err(|_| ERROR)? != path
    {
        return Err(ERROR.into());
    }
    Ok(())
}

impl Trace {
    fn create(directory: &Path, name: &str) -> Result<Self, String> {
        private_directory(directory)?;
        if Path::new(name).components().count() != 1 || Path::new(name).file_name().is_none() {
            return Err(ERROR.into());
        }
        let path = directory.join(name);
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&path)
            .map_err(|_| ERROR)?;
        if file.metadata().map_err(|_| ERROR)?.mode() & 0o777 != 0o600 {
            return Err(ERROR.into());
        }
        Ok(Self {
            state: Mutex::new(State {
                file,
                bytes: 0,
                sequence: 0,
                failed: false,
            }),
            started: Instant::now(),
            path,
            cut_used: AtomicBool::new(false),
            settlement_cut_used: AtomicBool::new(false),
            active_cut: Mutex::new(None),
            expected_key: Mutex::new(None),
        })
    }

    fn record(&self, event: &'static str, details: Value) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|_| ERROR)?;
        if state.failed {
            return Err(ERROR.into());
        }
        let sequence = state.sequence.checked_add(1).ok_or(ERROR)?;
        let mut bytes = serde_json::to_vec(&json!({
            "version":1,"pid":std::process::id(),"sequence":sequence,
            "elapsedMicros":self.started.elapsed().as_micros(),
            "unixTimeMs":SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| ERROR)?.as_millis(),
            "event":event,"details":details
        }))
        .map_err(|_| ERROR)?;
        bytes.push(b'\n');
        let total = state.bytes.saturating_add(bytes.len() as u64);
        if total > MAX_BYTES {
            state.failed = true;
            return Err(ERROR.into());
        }
        if state
            .file
            .write_all(&bytes)
            .and_then(|()| state.file.sync_data())
            .is_err()
        {
            state.failed = true;
            return Err(ERROR.into());
        }
        state.bytes = total;
        state.sequence = sequence;
        Ok(())
    }

    fn pause_at_requested_cut(&self, event: &'static str, details: &Value) -> Result<(), String> {
        let cut_for_event = match event {
            "intent-record-returned" => "intent",
            "input-complete-observed" => "input-complete",
            "input-progress-observed" => "input-in-progress",
            "armed-observed" => "armed",
            "before-accept-observed" => "before-accept",
            "prepare-input-enqueued" => "prepare",
            "accept-key-write-returned" => "key",
            "submission-accepted-observed" => "after-accept",
            "submission-accepted-before-routing" => "accept-receipt",
            "settled-before-routing" => "settled-receipt",
            "native-arm-before-routing" => "arm-identity",
            _ => return Ok(()),
        };
        let Ok(cut) = std::env::var("SHELLSPAN_ACCEPTANCE_SUBMISSION_CUT") else {
            return Ok(());
        };
        if !matches!(
            cut.as_str(),
            "intent"
                | "input-complete"
                | "input-in-progress"
                | "armed"
                | "before-accept"
                | "prepare"
                | "key"
                | "after-accept"
                | "accept-receipt"
                | "arm-identity"
        ) {
            return Err(ERROR.into());
        }
        if cut != cut_for_event && (cut != "accept-receipt" || cut_for_event != "settled-receipt") {
            return Ok(());
        }
        self.hold_at_cut(cut_for_event, details)
    }

    fn hold_at_cut(&self, cut: &'static str, details: &Value) -> Result<(), String> {
        let settlement = cut == "settled-receipt";
        let used = if settlement {
            &self.settlement_cut_used
        } else {
            &self.cut_used
        };
        if used.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        let identity: super::protocol::Identity =
            serde_json::from_value(details["identity"].clone()).map_err(|_| ERROR)?;
        identity.validate().map_err(|_| ERROR)?;
        let nonce = uuid::Uuid::new_v4();
        let directory = self.path.parent().ok_or(ERROR)?;
        let prefix = if settlement {
            "submission-settled-cut"
        } else {
            "submission-cut"
        };
        let marker = directory.join(format!("{prefix}-{}-{nonce}.json", std::process::id()));
        let release = marker.with_extension("release");
        let fact = json!({"version":1,"pid":std::process::id(),"nonce":nonce,"cut":cut,"identity":identity,"trace":self.path});
        *self.active_cut.lock().map_err(|_| ERROR)? = Some(fact.clone());
        let _active = ActiveCut(&self.active_cut);
        self.record("cut-enter", fact.clone())?;
        let mut file = tempfile::Builder::new()
            .prefix("submission-cut-pending-")
            .tempfile_in(directory)
            .map_err(|_| ERROR)?;
        file.write_all(&serde_json::to_vec(&fact).map_err(|_| ERROR)?)
            .and_then(|()| file.as_file().sync_all())
            .map_err(|_| ERROR)?;
        file.persist_noclobber(&marker).map_err(|_| ERROR)?;
        File::open(directory)
            .and_then(|file| file.sync_all())
            .map_err(|_| ERROR)?;
        // Bound the observation barrier independently of all production deadlines.
        let maximum_hold = if ssh_recovery_enabled() || cut == "accept-receipt" {
            Duration::from_secs(16)
        } else {
            Duration::from_secs(2)
        };
        let started = Instant::now();
        loop {
            match fs::symlink_metadata(&release) {
                Ok(metadata) => {
                    if !metadata.is_file()
                        || metadata.file_type().is_symlink()
                        || metadata.len() > 4096
                        || metadata.mode() & 0o777 != 0o600
                    {
                        return Err(ERROR.into());
                    }
                    let value: Value =
                        serde_json::from_slice(&fs::read(&release).map_err(|_| ERROR)?)
                            .map_err(|_| ERROR)?;
                    if value != json!({"nonce":nonce,"pid":std::process::id()}) {
                        return Err(ERROR.into());
                    }
                    return self.record("cut-released", json!({"nonce":nonce,"identity":identity,"waitMicros":started.elapsed().as_micros()}));
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(_) => return Err(ERROR.into()),
            }
            if started.elapsed() >= maximum_hold {
                self.record("cut-timeout", json!({"nonce":nonce,"identity":identity}))?;
                return Err(ERROR.into());
            }
            thread::sleep(Duration::from_millis(5));
        }
    }

    fn control_request(
        &self,
        agent: &str,
        operation: Option<&str>,
        kind: &'static str,
    ) -> Result<(), String> {
        let Some(cut) = self.active_cut.lock().map_err(|_| ERROR)?.clone() else {
            return Ok(());
        };
        if cut["identity"]["agentSessionId"].as_str() != Some(agent)
            || operation
                .is_some_and(|operation| cut["identity"]["operationId"].as_str() != Some(operation))
        {
            return Ok(());
        }
        if !matches!(kind, "cancel-token" | "takeover-owner-validated") {
            return Err(ERROR.into());
        }
        let nonce = cut["nonce"].as_str().ok_or(ERROR)?;
        let fact = json!({"version":1,"pid":std::process::id(),"nonce":nonce,"requestKind":kind,"identity":cut["identity"]});
        self.record("control-request-entered", fact.clone())?;
        let directory = self.path.parent().ok_or(ERROR)?;
        let mut file = tempfile::Builder::new()
            .prefix("submission-request-pending-")
            .tempfile_in(directory)
            .map_err(|_| ERROR)?;
        file.write_all(&serde_json::to_vec(&fact).map_err(|_| ERROR)?)
            .and_then(|()| file.as_file().sync_all())
            .map_err(|_| ERROR)?;
        file.persist_noclobber(directory.join(format!("submission-request-{nonce}-{kind}.json")))
            .map_err(|_| ERROR)?;
        Ok(())
    }
}

fn initialize() -> Result<Option<Trace>, String> {
    if !enabled() {
        return if std::env::var_os("SHELLSPAN_ACCEPTANCE_SUBMISSION_CUT").is_some() {
            Err(ERROR.into())
        } else {
            Ok(None)
        };
    }
    if std::env::var("SHELLSPAN_ACCEPTANCE_SUBMISSION").as_deref() != Ok("1") {
        return Err(ERROR.into());
    }
    let directory = crate::commands::terminal_acceptance_directory()?;
    for path in [&directory, &directory.join("home"), &directory.join("data")] {
        private_directory(path)?;
    }
    if !ssh_recovery_enabled()
        && std::env::var_os("HOME") != Some(directory.join("home").into_os_string())
    {
        return Err(ERROR.into());
    }
    let manifest = std::env::var_os("SHELLSPAN_ACCEPTANCE_FROZEN_MANIFEST").ok_or(ERROR)?;
    let info = fs::symlink_metadata(manifest).map_err(|_| ERROR)?;
    if !info.is_file() || info.file_type().is_symlink() || info.len() > 16 * 1024 * 1024 {
        return Err(ERROR.into());
    }
    let trace = Trace::create(
        &directory,
        &format!(
            "native-control-trace-{}-{}.jsonl",
            std::process::id(),
            uuid::Uuid::new_v4()
        ),
    )?;
    trace.record(
        "trace-open",
        json!({"directory":directory,"file":trace.path,"authority":"observation-only"}),
    )?;
    Ok(Some(trace))
}

pub(crate) fn enabled() -> bool {
    std::env::var("SHELLSPAN_ACCEPTANCE_CONTROL_TRACE").as_deref() == Ok("1")
}

pub(crate) fn ssh_recovery_enabled() -> bool {
    matches!(
        std::env::var("SHELLSPAN_ACCEPTANCE_SSH_RECOVERY").as_deref(),
        Ok("before-key-disconnect"
            | "before-key-timeout"
            | "before-key-cancel"
            | "before-key-stop"
            | "before-key-takeover"
            | "running-stop"
            | "running-cancel"
            | "running-takeover"
            | "runtime-multi-agent"
            | "close-running-terminal"
            | "delegation"
            | "input-in-progress-stop"
            | "input-in-progress-cancel"
            | "input-in-progress-takeover"
            | "input-complete-stop"
            | "input-complete-cancel"
            | "input-complete-takeover"
            | "intent-stop"
            | "intent-cancel"
            | "intent-takeover"
            | "armed-stop"
            | "armed-cancel"
            | "armed-takeover"
            | "after-accept-stop"
            | "after-accept-cancel"
            | "after-accept-takeover"
            | "after-key-disconnect"
            | "after-key-timeout"
            | "before-key-control-eof"
            | "after-key-control-eof"
            | "crash-before-key"
            | "crash-after-key"
            | "crash-restart"
            | "history-default"
            | "history-small"
            | "history-custom"
            | "history-empty"
            | "history-unset"
            | "positive-byte-boundary"
            | "positive-source-boundaries"
            | "positive-parent-shell"
            | "positive-jobs"
            | "positive-file-chain"
            | "display-geometry"
            | "ordinary-input"
            | "raw-no-sftp"
            | "raw-unapproved-shell"
            | "raw-resource-mismatch"
            | "reconnect-tail")
    ) && enabled()
}

pub(crate) fn observe_ssh_receipt(
    message: &super::protocol::Message,
    transport: &str,
) -> Result<(), String> {
    if !ssh_recovery_enabled() {
        return Ok(());
    }
    use super::protocol::{Message, Payload};
    let Message::Operation(envelope) = message else {
        return Ok(());
    };
    let kind = match envelope.payload {
        Payload::SubmissionAccepted => "submissionAccepted",
        Payload::Started => "started",
        Payload::Settled { .. } => "settled",
        Payload::DraftCleared { .. } => "draftCleared",
        _ => return Ok(()),
    };
    record(
        "ssh-receipt-read",
        json!({"sessionId":transport,"kind":kind,
        "identity":envelope.identity,"requestId":envelope.request_id}),
    )?;
    hold_submission_receipt(message, transport)
}

pub(crate) fn repeat_commit_enabled() -> Result<bool, String> {
    if std::env::var("SHELLSPAN_ACCEPTANCE_REPEAT_COMMIT").as_deref() != Ok("1") {
        return Ok(false);
    }
    match TRACE.get_or_init(initialize) {
        Ok(Some(_)) => Ok(true),
        _ => Err(ERROR.into()),
    }
}

pub(crate) fn control_request(
    agent: &str,
    operation: Option<&str>,
    kind: &'static str,
) -> Result<(), String> {
    match TRACE.get_or_init(initialize) {
        Ok(Some(trace)) => trace.control_request(agent, operation, kind),
        Ok(None) => Ok(()),
        Err(error) => Err(error.clone()),
    }
}

pub(crate) fn record(event: &'static str, details: Value) -> Result<(), String> {
    match TRACE.get_or_init(initialize) {
        Ok(Some(trace)) => {
            trace.record(event, details.clone())?;
            trace.pause_at_requested_cut(event, &details)
        }
        Ok(None) => Ok(()),
        Err(error) => Err(error.clone()),
    }
}

pub(crate) fn hold_submission_receipt(
    message: &super::protocol::Message,
    control_id: &str,
) -> Result<(), String> {
    let super::protocol::Message::Operation(envelope) = message else {
        return Ok(());
    };
    let event = match envelope.payload {
        super::protocol::Payload::SubmissionAccepted => "submission-accepted-before-routing",
        super::protocol::Payload::Settled { .. } => "settled-before-routing",
        _ => return Ok(()),
    };
    if std::env::var("SHELLSPAN_ACCEPTANCE_SUBMISSION_CUT").as_deref() != Ok("accept-receipt") {
        return Ok(());
    }
    if event == "settled-before-routing"
        && std::env::var("SHELLSPAN_ACCEPTANCE_SUBMISSION_SCENARIO").as_deref()
            == Ok("transport-disconnect")
    {
        return Ok(());
    }
    record(
        event,
        json!({
            "identity": envelope.identity,
            "requestId": envelope.request_id,
            "controlId": control_id
        }),
    )
}

pub(crate) fn eof_at_acceptance(message: &super::protocol::Message) -> bool {
    matches!(
        message,
        super::protocol::Message::Operation(envelope)
            if matches!(envelope.payload, super::protocol::Payload::SubmissionAccepted)
    ) && std::env::var("SHELLSPAN_ACCEPTANCE_SUBMISSION_CUT").as_deref() == Ok("accept-receipt")
        && std::env::var("SHELLSPAN_ACCEPTANCE_SUBMISSION_SCENARIO").as_deref() == Ok("control-eof")
}

const WRONG_SETTLEMENT_PREFIX: &str = "acceptance-wrong-settlement-";
const LATE_SETTLEMENT_SCENARIO: &str = "late-started-and-matched-settled";

fn late_settlement_selected() -> bool {
    std::env::var("SHELLSPAN_ACCEPTANCE_SUBMISSION_CUT").as_deref() == Ok("accept-receipt")
        && std::env::var("SHELLSPAN_ACCEPTANCE_SUBMISSION_SCENARIO").as_deref()
            == Ok(LATE_SETTLEMENT_SCENARIO)
}

pub(crate) fn wrong_settlement_request(message: &super::protocol::Envelope) -> bool {
    matches!(message.payload, super::protocol::Payload::Settled { .. })
        && message.request_id.starts_with(WRONG_SETTLEMENT_PREFIX)
        && late_settlement_selected()
}

pub(crate) fn observe_arm_binding(message: &super::protocol::Envelope) -> bool {
    matches!(message.payload, super::protocol::Payload::CommitArmed)
        && std::env::var("SHELLSPAN_ACCEPTANCE_SUBMISSION_CUT").as_deref() == Ok("arm-identity")
}

pub(crate) fn wrong_arm_bindings(
    message: &super::protocol::Message,
    control_id: &str,
) -> Result<Vec<super::protocol::Message>, String> {
    use super::protocol::Message;
    let Message::Operation(actual) = message else {
        return Ok(Vec::new());
    };
    if !observe_arm_binding(actual) {
        return Ok(Vec::new());
    }
    let fields: &[&str] = match std::env::var("SHELLSPAN_ACCEPTANCE_SUBMISSION_SCENARIO").as_deref()
    {
        Ok("identity-mismatch") => &["commandId"],
        Ok("generation-mismatch") => &["terminalGeneration"],
        Ok("complete-identity-submatrix") => &[
            "terminalSessionId",
            "terminalGeneration",
            "leaseId",
            "leaseGeneration",
            "agentSessionId",
            "taskId",
            "operationId",
            "commandId",
            "sourceRevision",
        ],
        _ => return Err(ERROR.into()),
    };
    let mut negatives = Vec::with_capacity(fields.len());
    for field in fields {
        let mut wrong = actual.clone();
        match *field {
            "terminalSessionId" => wrong.identity.terminal_session_id.push_str("-wrong"),
            "terminalGeneration" => wrong.identity.terminal_generation += 1,
            "leaseId" => wrong.identity.lease_id.push_str("-wrong"),
            "leaseGeneration" => wrong.identity.lease_generation += 1,
            "agentSessionId" => wrong.identity.agent_session_id.push_str("-wrong"),
            "taskId" => wrong.identity.task_id.push_str("-wrong"),
            "operationId" => wrong.identity.operation_id.push_str("-wrong"),
            "commandId" => wrong.identity.command_id.push_str("-wrong"),
            "sourceRevision" => wrong.identity.source_revision += 1,
            _ => return Err(ERROR.into()),
        }
        wrong.validate().map_err(|_| ERROR)?;
        record(
            "wrong-arm-binding-selected",
            json!({
                "field":field,"controlId":control_id,"requestId":actual.request_id,"originalIdentity":actual.identity,"identity":wrong.identity
            }),
        )?;
        negatives.push(Message::Operation(wrong));
    }
    Ok(negatives)
}

pub(crate) fn hold_original_arm(
    message: &super::protocol::Message,
    control_id: &str,
) -> Result<(), String> {
    let super::protocol::Message::Operation(actual) = message else {
        return Ok(());
    };
    if observe_arm_binding(actual) {
        record(
            "native-arm-before-routing",
            json!({
                "identity":actual.identity,"requestId":actual.request_id,"controlId":control_id
            }),
        )?;
    }
    Ok(())
}

pub(crate) fn mismatched_settlement(
    message: &super::protocol::Message,
    control_id: &str,
) -> Result<Option<super::protocol::Message>, String> {
    let super::protocol::Message::Operation(settled) = message else {
        return Ok(None);
    };
    if !matches!(settled.payload, super::protocol::Payload::Settled { .. })
        || !late_settlement_selected()
    {
        return Ok(None);
    }
    // Deliver a deliberately wrong binding to the real router. The original
    // native message is retained byte-for-byte and routed only after release.
    let mut wrong = settled.clone();
    wrong.request_id = format!("{WRONG_SETTLEMENT_PREFIX}{}", uuid::Uuid::new_v4());
    record(
        "wrong-settlement-before-routing",
        json!({
            "identity": settled.identity,
            "controlId": control_id,
            "matchingRequestId": settled.request_id,
            "wrongRequestId": wrong.request_id
        }),
    )?;
    Ok(Some(super::protocol::Message::Operation(wrong)))
}

pub(crate) fn mismatched_prepare(
    bytes: &[u8],
    control_id: &str,
) -> Result<Option<Vec<u8>>, String> {
    use super::protocol::{Decoder, Message, Payload};

    let scenario = std::env::var("SHELLSPAN_ACCEPTANCE_SUBMISSION_SCENARIO").unwrap_or_default();
    if !matches!(
        scenario.as_str(),
        "source-mismatch" | "plan-mismatch" | "unsupported-input-native"
    ) {
        return Ok(None);
    }
    let mut decoder = Decoder::default();
    let mut messages = decoder.push(bytes).map_err(|_| ERROR)?;
    decoder.finish().map_err(|_| ERROR)?;
    let [Message::Operation(envelope)] = messages.as_mut_slice() else {
        return Err(ERROR.into());
    };
    let Payload::PrepareInput { source, plan, .. } = &mut envelope.payload else {
        return Ok(None);
    };
    // Only the explicitly selected content is changed. The original approval,
    // identity, deadline and both cryptographic bindings remain untouched.
    match scenario.as_str() {
        "source-mismatch" => source.push_str("; :"),
        "plan-mismatch" => plan.push_str("; :"),
        "unsupported-input-native" => source.push('\0'),
        _ => return Err(ERROR.into()),
    }
    let mut altered = serde_json::to_vec(envelope).map_err(|_| ERROR)?;
    altered.push(b'\n');
    if altered.len() > super::protocol::MAX_MESSAGE_BYTES {
        return Err(ERROR.into());
    }
    record(
        "mismatched-prepare-before-send",
        json!({
            "scenario": scenario,
            "controlId": control_id,
            "identity": envelope.identity,
            "requestId": envelope.request_id,
            "originalHex": hex::encode(bytes),
            "alteredHex": hex::encode(&altered)
        }),
    )?;
    Ok(Some(altered))
}

pub(crate) fn observe_next_accept_key(
    session: &str,
    identity: super::protocol::Identity,
    key: &'static [u8],
) -> Result<(), String> {
    if !ssh_recovery_enabled()
        && std::env::var("SHELLSPAN_ACCEPTANCE_SUBMISSION_CUT").as_deref() != Ok("key")
    {
        return Ok(());
    }
    identity.validate().map_err(|_| ERROR)?;
    match TRACE.get_or_init(initialize) {
        Ok(Some(trace)) => {
            let mut expected = trace.expected_key.lock().map_err(|_| ERROR)?;
            if expected.is_some() {
                if ssh_recovery_enabled() {
                    return Ok(()); // The independent SSH write trace still counts every attempt.
                }
                return Err(ERROR.into());
            }
            *expected = Some((session.into(), identity, key));
            Ok(())
        }
        _ => Err(ERROR.into()),
    }
}

pub(crate) fn actual_accept_key_written(
    session: &str,
    bytes: &[u8],
    written: usize,
) -> Result<(), String> {
    if written != bytes.len() {
        return Ok(());
    }
    let identity = match TRACE.get_or_init(initialize) {
        Ok(Some(trace)) => {
            let mut expected = trace.expected_key.lock().map_err(|_| ERROR)?;
            if expected
                .as_ref()
                .is_none_or(|(owner, _, key)| owner != session || bytes != *key)
            {
                return Ok(());
            }
            expected
                .take()
                .map(|(_, identity, _)| identity)
                .ok_or(ERROR)?
        }
        Ok(None) => return Ok(()),
        Err(error) => return Err(error.clone()),
    };
    record(
        "accept-key-write-returned",
        json!({"identity":identity,"sessionId":session,"written":written}),
    )
}

/// Wraps the actual writer; its Write return count is the underlying OS/PTY
/// result. A failed write may have an unknown partial effect and is never replayed.
pub(crate) struct PtyWriter {
    inner: Box<dyn Write + Send>,
    session_id: String,
}
impl PtyWriter {
    pub(crate) fn wrap(inner: Box<dyn Write + Send>, session_id: String) -> Self {
        Self { inner, session_id }
    }
}
impl Write for PtyWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        record(
            "pty-write-attempt",
            json!({"sessionId":self.session_id,"hex":hex::encode(bytes)}),
        )
        .map_err(io::Error::other)?;
        let result = self.inner.write(bytes);
        record("pty-write-return", json!({"sessionId":self.session_id,"written":result.as_ref().ok(),"errorKind":result.as_ref().err().map(|error|format!("{:?}",error.kind()))}))
            .map_err(io::Error::other)?;
        if let Ok(written) = result.as_ref() {
            actual_accept_key_written(&self.session_id, bytes, *written)
                .map_err(io::Error::other)?;
        }
        result
    }
    fn flush(&mut self) -> io::Result<()> {
        let result = self.inner.flush();
        record("pty-flush-return", json!({"sessionId":self.session_id,"ok":result.is_ok(),"errorKind":result.as_ref().err().map(|error|format!("{:?}",error.kind()))}))
            .map_err(io::Error::other)?;
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};

    fn directory() -> tempfile::TempDir {
        let base = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../.artifacts/tests/native-input-p3/trace-unit");
        fs::create_dir_all(&base).unwrap();
        tempfile::Builder::new()
            .permissions(fs::Permissions::from_mode(0o700))
            .tempdir_in(fs::canonicalize(base).unwrap())
            .unwrap()
    }

    #[test]
    fn raw_bytes_are_durable_and_sequence_is_serialized() {
        let directory = directory();
        let trace = Trace::create(directory.path(), "observations.jsonl").unwrap();
        let bytes = [0, 255, b'\n', b'{'];
        trace
            .record("observed-test-bytes", json!({"hex":hex::encode(bytes)}))
            .unwrap();
        trace.record("observed-test-eof", Value::Null).unwrap();
        let file = directory.path().join("observations.jsonl");
        let records = fs::read_to_string(&file)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(records.len(), 2);
        assert_eq!(records[0]["sequence"], 1);
        assert_eq!(records[1]["sequence"], 2);
        assert_eq!(
            hex::decode(records[0]["details"]["hex"].as_str().unwrap()).unwrap(),
            bytes
        );
        assert_eq!(fs::metadata(file).unwrap().mode() & 0o777, 0o600);
        assert!(
            Trace::create(directory.path(), "observations.jsonl").is_err(),
            "existing evidence must never be truncated"
        );
    }

    #[test]
    fn aliased_or_shared_storage_is_rejected() {
        let directory = directory();
        let linked = directory.path().join("alias");
        symlink(directory.path(), &linked).unwrap();
        assert!(Trace::create(&linked, "observations.jsonl").is_err());
        assert!(Trace::create(directory.path(), "../observations.jsonl").is_err());
        assert!(!directory.path().join("observations.jsonl").exists());
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o755)).unwrap();
        assert!(Trace::create(directory.path(), "observations.jsonl").is_err());
    }

    fn held_file_case(
        cut: &'static str,
        release_matches: bool,
    ) -> (Result<(), String>, Vec<Value>) {
        // File barrier unit input only, never native execution/proof evidence.
        let directory = directory();
        let trace = std::sync::Arc::new(Trace::create(directory.path(), "barrier.jsonl").unwrap());
        let details = json!({"identity":{"terminalSessionId":"file-unit","terminalGeneration":1,"leaseId":"file-unit","leaseGeneration":1,"agentSessionId":"file-unit","taskId":"file-unit","operationId":"file-unit","commandId":"file-unit","sourceRevision":1}});
        let held = trace.clone();
        let worker = thread::spawn(move || held.hold_at_cut(cut, &details));
        let until = Instant::now() + Duration::from_secs(1);
        let marker_prefix = if cut == "settled-receipt" {
            "submission-settled-cut-"
        } else {
            "submission-cut-"
        };
        let marker = loop {
            let found = fs::read_dir(directory.path())
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .find(|path| {
                    path.file_name()
                        .unwrap()
                        .to_string_lossy()
                        .starts_with(marker_prefix)
                        && path
                            .extension()
                            .is_some_and(|extension| extension == "json")
                });
            if let Some(path) = found {
                break path;
            }
            assert!(
                Instant::now() < until,
                "live file barrier did not publish its cut"
            );
            thread::sleep(Duration::from_millis(5));
        };
        let fact: Value = serde_json::from_slice(&fs::read(&marker).unwrap()).unwrap();
        assert_eq!(fact["cut"], cut);
        trace
            .control_request("another-agent", None, "cancel-token")
            .unwrap();
        let requested = directory.path().join(format!(
            "submission-request-{}-cancel-token.json",
            fact["nonce"].as_str().unwrap()
        ));
        assert!(!requested.exists());
        trace
            .control_request("file-unit", Some("file-unit"), "cancel-token")
            .unwrap();
        let request: Value = serde_json::from_slice(&fs::read(requested).unwrap()).unwrap();
        assert_eq!(request["identity"], fact["identity"]);
        assert_eq!(request["nonce"], fact["nonce"]);
        let release = json!({"pid":std::process::id(),"nonce":if release_matches {fact["nonce"].clone()} else {json!(uuid::Uuid::new_v4())}});
        let mut file = tempfile::NamedTempFile::new_in(directory.path()).unwrap();
        file.write_all(&serde_json::to_vec(&release).unwrap())
            .unwrap();
        file.as_file().sync_all().unwrap();
        file.persist_noclobber(marker.with_extension("release"))
            .unwrap();
        let result = worker.join().unwrap();
        assert!(trace.active_cut.lock().unwrap().is_none());
        let records = fs::read_to_string(directory.path().join("barrier.jsonl"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect();
        (result, records)
    }

    #[test]
    fn actual_file_release_requires_the_published_nonce() {
        for cut in [
            "intent",
            "input-complete",
            "armed",
            "before-accept",
            "prepare",
            "key",
            "accept-receipt",
            "settled-receipt",
            "arm-identity",
        ] {
            let (result, records) = held_file_case(cut, true);
            assert!(result.is_ok());
            assert_eq!(records.last().unwrap()["event"], "cut-released");
            let (result, records) = held_file_case(cut, false);
            assert!(result.is_err());
            assert_eq!(records.len(), 2);
            assert_eq!(records[0]["event"], "cut-enter");
            assert_eq!(records[1]["event"], "control-request-entered");
        }
    }

    #[test]
    fn an_unreleased_file_barrier_expires_without_release_or_proof() {
        let directory = directory();
        let trace = Trace::create(directory.path(), "timeout.jsonl").unwrap();
        let details = json!({"identity":{"terminalSessionId":"file-unit","terminalGeneration":1,"leaseId":"file-unit","leaseGeneration":1,"agentSessionId":"file-unit","taskId":"file-unit","operationId":"file-unit","commandId":"file-unit","sourceRevision":1}});
        let started = Instant::now();
        assert!(trace.hold_at_cut("intent", &details).is_err());
        assert!(started.elapsed() >= Duration::from_secs(2));
        assert!(started.elapsed() < Duration::from_secs(4));
        let records = fs::read_to_string(directory.path().join("timeout.jsonl"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            records
                .iter()
                .map(|value| value["event"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["cut-enter", "cut-timeout"]
        );
    }
}
