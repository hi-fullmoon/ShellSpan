//! NIP producer for native ZLE and PSReadLine widgets. All calls, including
//! observations and acknowledgements, belong to the editor's original thread.
//! This library never evaluates source, writes terminal input, or accepts a line.
#[path = "../../src/terminal_command/protocol.rs"]
pub mod protocol;
use protocol as nip;
use std::{
    collections::{HashSet, VecDeque},
    time::Instant,
};
use unicode_segmentation::UnicodeSegmentation;
mod ffi;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Action {
    None,
    Replace,
    Clear,
    Validate,
}
struct Draft {
    prepare: nip::Envelope,
    source: String,
    plan: String,
    execution_line: Option<String>,
    host_returned: bool,
    // Local, observed discard after EOF. It never settles the backend intent.
    local_discarded: bool,
    job: Option<nip::JobExecution>,
    source_digest: String,
    plan_digest: String,
    boundaries: Vec<usize>,
    applied: usize,
    started: Instant,
    reduced: bool,
    confirmed: bool,
    validated: bool,
    armed: Option<nip::Envelope>,
    accepted: bool,
    running: bool,
    cancel: Option<nip::Envelope>,
}
pub struct Editor {
    thread: std::thread::ThreadId,
    profile: nip::PeerProfile,
    supported: bool,
    decoder: nip::Decoder,
    connection: Option<nip::ConnectionEnvelope>,
    guard: Option<nip::RequestGuard>,
    draft: Option<Draft>,
    retired: HashSet<String>,
    last: Option<nip::Identity>,
    result: Option<i32>,
    output: VecDeque<Vec<u8>>,
    output_bytes: usize,
    failed: bool,
    observed: String,
    cursor: usize,
    action: Action,
    replacement: String,
}
impl Editor {
    pub fn new(profile: nip::PeerProfile, supported: bool) -> Self {
        Self {
            thread: std::thread::current().id(),
            profile,
            supported,
            decoder: nip::Decoder::default(),
            connection: None,
            guard: None,
            draft: None,
            retired: HashSet::new(),
            last: None,
            result: None,
            output: VecDeque::new(),
            output_bytes: 0,
            failed: false,
            observed: String::new(),
            cursor: 0,
            action: Action::None,
            replacement: String::new(),
        }
    }
    fn check_thread(&mut self) -> bool {
        if self.thread != std::thread::current().id() {
            self.failed = true;
        }
        !self.failed
    }
    pub fn observe(&mut self, buffer: &str, cursor_utf8_bytes: usize) -> bool {
        if !self.check_thread()
            || buffer.len() > 8192
            || buffer.contains('\0')
            || cursor_utf8_bytes > buffer.len()
            || !buffer.is_char_boundary(cursor_utf8_bytes)
        {
            self.failed = true;
            return false;
        }
        self.observed = buffer.into();
        self.cursor = cursor_utf8_bytes;
        true
    }
    fn owned(&self) -> bool {
        self.draft.as_ref().is_some_and(|draft| {
            self.observed == draft.source[..draft.applied] && self.cursor == self.observed.len()
        })
    }
    fn emit(&mut self, message: nip::Message) {
        let bytes = match message {
            nip::Message::Connection(v) => v.encode(),
            nip::Message::Operation(v) => v.encode(),
        };
        match bytes {
            Ok(bytes) if self.output_bytes + bytes.len() <= nip::MAX_MESSAGE_BYTES => {
                self.output_bytes += bytes.len();
                self.output.push_back(bytes);
            }
            _ => self.failed = true,
        }
    }
    fn reply(&mut self, request: &nip::Envelope, payload: nip::Payload) {
        self.emit(nip::Message::Operation(nip::Envelope {
            protocol: nip::PROTOCOL.into(),
            request_id: request.request_id.clone(),
            identity: request.identity.clone(),
            payload,
        }));
    }
    fn connection_reply(&mut self, payload: nip::ConnectionPayload) {
        if let Some(request) = &self.connection {
            self.emit(nip::Message::Connection(nip::ConnectionEnvelope {
                protocol: nip::PROTOCOL.into(),
                request_id: request.request_id.clone(),
                connection: request.connection.clone(),
                payload,
            }));
        }
    }
    fn reject(&mut self, request: &nip::Envelope, code: nip::ErrorCode) {
        self.reply(request, nip::Payload::Rejected { code });
    }
    pub fn receive(&mut self, bytes: &[u8]) -> bool {
        if !self.check_thread() {
            return false;
        }
        match self.decoder.push(bytes) {
            Ok(messages) => {
                for message in messages {
                    match message {
                        nip::Message::Connection(request) => self.probe(request),
                        nip::Message::Operation(request) => self.request(request),
                    }
                    if self.failed {
                        break;
                    }
                }
            }
            Err(_) => self.failed = true,
        }
        !self.failed
    }
    fn probe(&mut self, request: nip::ConnectionEnvelope) {
        if request.validate().is_err()
            || !matches!(request.payload, nip::ConnectionPayload::Probe)
            || self
                .connection
                .as_ref()
                .is_some_and(|old| old.connection != request.connection)
        {
            self.failed = true;
            return;
        }
        self.connection = Some(request);
        let supported = self.supported && self.retired.len() < 4096;
        self.connection_reply(nip::ConnectionPayload::Capabilities {
            profile: self.profile.clone(),
            native_inline: supported,
            source_echo: supported,
            atomic_handoff: supported,
            complete_proof: supported,
            draft_clear: supported,
            inband_display: supported,
            editor_empty: self.observed.is_empty(),
        });
    }
    fn request(&mut self, request: nip::Envelope) {
        if let Err(code) = request.validate() {
            self.reject(&request, code);
            return;
        }
        if !self.connection.as_ref().is_some_and(|c| {
            c.connection.terminal_session_id == request.identity.terminal_session_id
                && c.connection.terminal_generation == request.identity.terminal_generation
        }) {
            self.reject(&request, nip::ErrorCode::Identity);
            return;
        }
        if matches!(request.payload, nip::Payload::PrepareInput { .. }) && self.draft.is_none() {
            if self.retired.contains(&scope(&request.identity)) || self.retired.len() >= 4096 {
                self.reject(&request, nip::ErrorCode::DuplicateRequest);
                return;
            }
            if self.guard.as_ref().is_some_and(|guard| {
                request.identity.lease_generation > guard.identity().lease_generation
            }) {
                self.guard = None;
                self.result = None;
            }
        }
        if self.guard.is_none() {
            if matches!(request.payload, nip::Payload::Query) {
                self.snapshot(&request);
                return;
            }
            if !matches!(request.payload, nip::Payload::PrepareInput { .. }) {
                self.reject(&request, nip::ErrorCode::State);
                return;
            }
            self.guard = Some(nip::RequestGuard::new(request.identity.clone()));
        }
        if let Err(code) = self.guard.as_mut().unwrap().accept(&request) {
            self.reject(&request, code);
            return;
        }
        match &request.payload {
            nip::Payload::Query => self.snapshot(&request),
            nip::Payload::PrepareInput {
                source,
                source_digest,
                plan,
                plan_digest,
                reduced_motion,
                job,
                ..
            } => {
                // Each host verifies its exact execution representation. A
                // different editor family cannot inherit Bash's eval plan.
                if !self.supported
                    || self.draft.is_some()
                    || !self.observed.is_empty()
                    || self.cursor != 0
                {
                    self.reject(&request, nip::ErrorCode::State);
                    return;
                }
                let expected = if let Some(job) = job {
                    nip::native_shell_job_plan(source, self.profile.shell, job)
                } else {
                    nip::native_foreground_plan(source, self.profile.shell)
                };
                if expected.as_ref() != Ok(plan) {
                    self.reject(&request, nip::ErrorCode::Binding);
                    return;
                }
                self.last = Some(request.identity.clone());
                let editor_source = if matches!(job, Some(nip::JobExecution::Control { .. })) {
                    String::new()
                } else {
                    source.clone()
                };
                self.draft = Some(Draft {
                    prepare: request.clone(),
                    source: editor_source.clone(),
                    plan: plan.clone(),
                    execution_line: None,
                    host_returned: false,
                    local_discarded: false,
                    job: job.clone(),
                    source_digest: source_digest.clone(),
                    plan_digest: plan_digest.clone(),
                    boundaries: editor_source
                        .grapheme_indices(true)
                        .map(|(i, g)| i + g.len())
                        .collect(),
                    applied: 0,
                    started: Instant::now(),
                    reduced: *reduced_motion,
                    confirmed: false,
                    validated: false,
                    armed: None,
                    accepted: false,
                    running: false,
                    cancel: None,
                });
                self.reply(
                    &request,
                    nip::Payload::Prepared {
                        source_digest: source_digest.clone(),
                        plan_digest: plan_digest.clone(),
                    },
                );
                if matches!(job, Some(nip::JobExecution::Control { .. })) {
                    let draft = self.draft.as_mut().unwrap();
                    draft.confirmed = true;
                    draft.validated = true;
                    self.reply(
                        &request,
                        nip::Payload::ControlInputConfirmed {
                            plan_digest: plan_digest.clone(),
                            editor_empty: true,
                        },
                    );
                }
            }
            nip::Payload::Commit {
                source_digest,
                plan_digest,
            } => {
                let valid = self.owned()
                    && self.draft.as_ref().is_some_and(|draft| {
                        draft.confirmed
                            && !draft.accepted
                            && draft.armed.is_none()
                            && draft.cancel.is_none()
                            && source_digest == &draft.source_digest
                            && plan_digest == &draft.plan_digest
                    });
                if !valid {
                    self.reject(&request, nip::ErrorCode::Binding);
                    return;
                }
                self.draft.as_mut().unwrap().armed = Some(request.clone());
                self.reply(&request, nip::Payload::CommitArmed);
            }
            nip::Payload::CancelDraft => {
                if !self.owned() || self.draft.as_ref().is_none_or(|draft| draft.accepted) {
                    self.reject(&request, nip::ErrorCode::RecoveryRequired);
                    return;
                }
                self.draft.as_mut().unwrap().cancel = Some(request);
                self.action = Action::Clear;
                self.replacement.clear();
            }
            _ => self.reject(&request, nip::ErrorCode::State),
        }
    }
    fn snapshot(&mut self, request: &nip::Envelope) {
        let phase = if self.failed {
            "recoveryRequired"
        } else if self.result.is_some() {
            "completed"
        } else if self.draft.as_ref().is_some_and(|v| v.running) {
            "running"
        } else if self.draft.as_ref().is_some_and(|v| v.accepted) {
            "submissionAttempted"
        } else if self.draft.as_ref().is_some_and(|v| v.confirmed) {
            "inputConfirmed"
        } else if self.draft.is_some() {
            "typing"
        } else {
            "preparing"
        };
        self.reply(
            request,
            nip::Payload::Snapshot {
                phase: phase.into(),
                may_have_submitted: self.result.is_some()
                    || self.draft.as_ref().is_some_and(|v| v.accepted),
                editor_utf8_valid: true,
                cursor_utf8_bytes: Some(self.cursor),
                end_utf8_bytes: Some(self.observed.len()),
            },
        );
    }
    pub fn advance(&mut self) -> Action {
        if !self.check_thread() {
            return Action::None;
        }
        if self.action != Action::None {
            return self.action;
        }
        if !self.owned() {
            if self.draft.as_ref().is_some_and(|v| !v.accepted) {
                self.failed = true;
            }
            return Action::None;
        }
        let draft = self.draft.as_ref().unwrap();
        if draft.confirmed || draft.accepted || draft.cancel.is_some() {
            return Action::None;
        }
        if self.guard.as_ref().is_some_and(nip::RequestGuard::expired) {
            self.failed = true;
            return Action::None;
        }
        if !draft.validated {
            self.replacement = draft.source.clone();
            self.action = Action::Validate;
            return self.action;
        }
        let elapsed = draft.started.elapsed().as_millis() as usize;
        let count = if draft.reduced {
            draft.boundaries.len()
        } else {
            ((elapsed * draft.boundaries.len() / 1200) + 1).min(draft.boundaries.len())
        };
        let next = draft.boundaries[count - 1];
        if next > draft.applied {
            self.replacement = draft.source[..next].into();
            self.action = Action::Replace;
        }
        self.action
    }
    pub fn replacement(&self) -> &str {
        &self.replacement
    }
    pub fn validate_source(&mut self, valid: bool) -> bool {
        if !self.check_thread() || self.action != Action::Validate || !self.owned() {
            return false;
        }
        self.action = Action::None;
        self.replacement.clear();
        let valid = valid
            && (self.profile.editor != nip::EditorFamily::PsReadLine
                || self
                    .draft
                    .as_ref()
                    .is_some_and(|d| d.execution_line.is_some()));
        if valid {
            self.draft.as_mut().unwrap().validated = true;
        } else {
            let draft = self.draft.take().unwrap();
            self.retired.insert(scope(&draft.prepare.identity));
            self.reject(&draft.prepare, nip::ErrorCode::Binding);
        }
        true
    }
    pub fn acknowledge(&mut self) -> bool {
        if !self.check_thread() || self.action == Action::None {
            return false;
        }
        if self.observed != self.replacement || self.cursor != self.observed.len() {
            self.failed = true;
            return false;
        }
        if self.action == Action::Clear {
            let draft = self.draft.take().unwrap();
            self.retired.insert(scope(&draft.prepare.identity));
            self.reply(
                &draft.cancel.unwrap(),
                nip::Payload::DraftCleared { editor_empty: true },
            );
        } else {
            let draft = self.draft.as_mut().unwrap();
            draft.applied = self.observed.len();
            let request = draft.prepare.clone();
            let complete = draft.applied == draft.source.len();
            self.reply(
                &request,
                nip::Payload::InputProgress {
                    applied_utf8_bytes: self.observed.len(),
                },
            );
            if complete {
                let draft = self.draft.as_mut().unwrap();
                draft.confirmed = true;
                let payload = nip::Payload::InputConfirmed {
                    source_digest: nip::sha(&self.observed),
                    plan_digest: draft.plan_digest.clone(),
                    utf8_bytes: self.observed.len(),
                    cursor_utf8_bytes: self.cursor,
                    end_utf8_bytes: self.observed.len(),
                };
                self.reply(&request, payload);
            }
        }
        self.action = Action::None;
        self.replacement.clear();
        true
    }
    pub fn accept(&mut self) -> bool {
        if !self.check_thread()
            || !self.owned()
            || self.action != Action::None
            || self.guard.as_ref().is_none_or(nip::RequestGuard::expired)
        {
            return false;
        }
        let Some(draft) = self.draft.as_mut() else {
            return false;
        };
        if !draft.confirmed || draft.accepted || draft.cancel.is_some() {
            return false;
        }
        let Some(request) = draft.armed.take() else {
            return false;
        };
        draft.accepted = true;
        self.reply(&request, nip::Payload::SubmissionAccepted);
        true
    }
    pub fn started(&mut self) -> bool {
        if !self.check_thread() {
            return false;
        }
        let Some(draft) = self.draft.as_mut() else {
            return false;
        };
        if !draft.accepted {
            return false;
        }
        if draft.running {
            return true;
        }
        draft.running = true;
        let request = draft.prepare.clone();
        self.reply(&request, nip::Payload::Started);
        true
    }
    pub fn settled(&mut self, status: i32) -> bool {
        if !self.check_thread() {
            return false;
        }
        if self
            .draft
            .as_ref()
            .is_none_or(|v| !v.accepted || (!v.running && !v.host_returned))
        {
            return false;
        }
        let draft = self.draft.take().unwrap();
        self.result = Some(status);
        self.retired.insert(scope(&draft.prepare.identity));
        self.reply(&draft.prepare, nip::Payload::Settled { exit_code: status });
        true
    }
    pub fn ready(&mut self, cwd: &str) {
        if !self.check_thread() {
            return;
        }
        self.connection_reply(nip::ConnectionPayload::Directory { cwd: cwd.into() });
        self.connection_reply(nip::ConnectionPayload::EditorReady {
            editor_empty: self.observed.is_empty(),
            owned_draft_absent: self.draft.is_none(),
            after_command: self.last.clone(),
        });
    }
    pub fn take_output(&mut self) -> Option<Vec<u8>> {
        let bytes = self.output.pop_front()?;
        self.output_bytes -= bytes.len();
        Some(bytes)
    }
    pub fn eof(&mut self) {
        let _ = self.decoder.finish();
        self.failed = true;
    }
    pub fn failed(&self) -> bool {
        self.failed
    }
    pub fn typing(&self) -> bool {
        self.draft
            .as_ref()
            .is_some_and(|v| !v.confirmed && !v.accepted)
    }
    pub fn armed(&self) -> bool {
        self.draft.as_ref().is_some_and(|v| v.armed.is_some())
    }
    pub fn owned_draft(&self) -> bool {
        self.draft.as_ref().is_some_and(|v| !v.accepted)
    }
}
fn scope(identity: &nip::Identity) -> String {
    nip::sha(
        &serde_json::to_string(&(
            &identity.agent_session_id,
            &identity.task_id,
            &identity.operation_id,
        ))
        .unwrap(),
    )
}
