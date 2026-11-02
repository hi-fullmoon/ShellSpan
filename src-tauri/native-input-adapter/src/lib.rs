//! Target-side Readline adapter. Built as a Bash loadable module, separately
//! from Tauri. Every editor call runs on the current shell's Readline thread.
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::ffi::{CStr, CString};
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::raw::{c_char, c_int};
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use unicode_segmentation::UnicodeSegmentation;
mod native_protocol;
#[path = "../../src/terminal_command/protocol.rs"]
mod nip;

extern "C" {
    fn ss_native_capture_fence(value: *const c_char);
    fn ss_native_queue_control() -> c_int;
    fn ss_native_control_after_fork();
    fn p0_native_protocol_supported() -> c_int;
    fn p0_native_display_reset();
    fn p0_install_input() -> c_int;
    fn p0_finish_input();
    fn p0_release_owned_display();
    fn p0_uninstall_input();
    fn p0_refresh_input();
    fn p0_bindings_valid() -> c_int;
    fn p0_begin_display(geometry: c_int) -> c_int;
    fn p0_display_rebases() -> c_int;
    fn p0_preview_bytes() -> c_int;
    fn p0_finish_preview() -> c_int;
    fn p0_begin_append_display() -> c_int;
    fn p0_paint_line();
    fn p0_accept_line();
    static mut rl_line_buffer: *mut c_char;
    static mut rl_point: c_int;
    static mut rl_end: c_int;
    static mut rl_done: c_int;
    static rl_library_version: *const c_char;
    static rl_readline_version: c_int;
    fn rl_replace_line(text: *const c_char, clear_undo: c_int);
    fn rl_insert_text(text: *const c_char) -> c_int;
    fn rl_bind_keyseq(
        key: *const c_char,
        function: Option<extern "C" fn(c_int, c_int) -> c_int>,
    ) -> c_int;
    fn rl_get_keymap() -> *mut libc::c_void;
    fn rl_function_of_keyseq(
        key: *const c_char,
        map: *mut libc::c_void,
        kind: *mut c_int,
    ) -> *mut libc::c_void;
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    #[serde(skip)]
    private_control: bool,
    #[serde(skip)]
    native: Option<nip::Envelope>,
    request: u64,
    generation: u64,
    lease: u64,
    operation: String,
    revision: u64,
    action: String,
    expires_ms: u64,
    #[serde(default)]
    source: String,
    #[serde(default)]
    source_digest: String,
    #[serde(default)]
    plan: String,
    #[serde(default)]
    plan_digest: String,
    #[serde(default)]
    reduced: bool,
    #[serde(default)]
    insertion: bool,
    #[serde(default)]
    start_rebase: bool,
    #[serde(default)]
    geometry_rebase: bool,
    #[serde(default)]
    viewport_safe: bool,
    #[serde(default)]
    append_display: bool,
}
struct Draft {
    request: Request,
    boundaries: Vec<usize>,
    visible: usize,
    started: Instant,
    confirmed: bool,
    submitted: bool,
    native_started: bool,
    commit: Option<Request>,
}
struct Bridge {
    control_file: PathBuf,
    outgoing_since: Option<Instant>,
    native_connection: Option<nip::ConnectionEnvelope>,
    native_last_prepared: Option<nip::Identity>,
    native_shell_version: Option<String>,
    native_decoder: nip::Decoder,
    native_guard: Option<nip::RequestGuard>,
    native_request: Option<nip::Envelope>,
    native_sequence: u64,
    native_mode: bool,
    native_result: Option<i32>,
    socket: UnixStream,
    input: Vec<u8>,
    output: Vec<u8>,
    seen: HashSet<u64>,
    retired: HashSet<String>,
    lease: u64,
    draft: Option<Draft>,
    active: bool,
    receiving_until: Option<Instant>,
}
// Readline and these builtins run on the shell thread. The fork child closes
// the endpoint using only async-signal-safe close; it never runs a Rust drop.
static mut BRIDGE: *mut Bridge = std::ptr::null_mut();
static mut CONTROL_FD: c_int = -1;
static mut SAVED_MASK: std::mem::MaybeUninit<libc::sigset_t> = std::mem::MaybeUninit::uninit();
static mut MASKED: bool = false;
static mut FORK_REGISTERED: bool = false;
#[no_mangle]
pub unsafe extern "C" fn p0_control_closed() -> c_int {
    if CONTROL_FD == -1 || libc::fcntl(CONTROL_FD, libc::F_GETFD) == -1 {
        0
    } else {
        1
    }
}
unsafe extern "C" fn fork_child() {
    if CONTROL_FD >= 0 {
        libc::close(CONTROL_FD);
    }
    CONTROL_FD = -1;
    BRIDGE = std::ptr::null_mut();
    ss_native_control_after_fork();
}
fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}
unsafe fn line() -> String {
    CStr::from_ptr(rl_line_buffer)
        .to_string_lossy()
        .into_owned()
}
unsafe fn owned_line_matches(value: &str) -> bool {
    CStr::from_ptr(rl_line_buffer).to_bytes() == value.as_bytes()
        && rl_point == rl_end
        && rl_end >= 0
        && rl_end as usize == value.len()
}
unsafe fn replace(value: &str) {
    let value = CString::new(value).expect("validated NUL-free text");
    rl_replace_line(value.as_ptr(), 1);
    rl_point = rl_end;
}
impl Bridge {
    fn emit(&mut self, request: Option<&Request>, event: &str, details: Value) {
        if self.native_mode {
            self.emit_native(
                request.and_then(|request| request.native.as_ref()),
                event,
                &details,
            );
            return;
        }
        let value = json!({"event":event,"request":request.map(|r|r.request),
            "operation":request.map(|r|&r.operation),"generation":1,
            "lease":self.lease,"details":details});
        self.output.extend(serde_json::to_vec(&value).unwrap());
        self.output.push(b'\n');
    }
    fn flush(&mut self) -> bool {
        while !self.output.is_empty() {
            match self.socket.write(&self.output) {
                Ok(0) => return false,
                Ok(count) => {
                    self.output.drain(..count);
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => return false,
            }
        }
        if self.output.is_empty() {
            self.outgoing_since = None;
        }
        self.output.len() <= 131_072
            && self
                .outgoing_since
                .is_none_or(|since| since.elapsed() < std::time::Duration::from_secs(5))
    }
    unsafe fn clear_owned(&mut self) -> bool {
        if let Some(draft) = self.draft.as_ref() {
            if draft.submitted {
                return false;
            }
            if !owned_line_matches(&draft.request.source[..draft.visible]) {
                return false;
            }
            replace("");
            p0_paint_line();
            p0_release_owned_display();
        }
        true
    }
    unsafe fn fail_closed(&mut self) {
        self.active = false;
        // Private payload never enters the tty. An unchanged owned draft can
        // therefore be cleared without draining or replaying any tty bytes.
        let cleared = self.clear_owned();
        self.emit(None, "ControlLost", json!({"draft_cleared":cleared}));
        self.output.clear();
        p0_finish_input();
        if self.native_mode {
            let _ = self.socket.shutdown(std::net::Shutdown::Both);
        }
    }
    unsafe fn receive(&mut self, request: Request) {
        self.receiving_until = None;
        if request.generation != 1
            || request.lease != self.lease
            || request.operation.is_empty()
            || request.operation.len() > 128
            || request.expires_ms < now_ms()
            || !self.seen.insert(request.request)
            || self.retired.contains(&request.operation)
        {
            self.emit(Some(&request), "Rejected", json!("identity/expiry/replay"));
            return;
        }
        if self.native_mode && request.action == "query" {
            self.emit(Some(&request), "Snapshot", json!({"submitted":self.draft.as_ref().is_some_and(|draft|draft.submitted),"confirmed":self.draft.as_ref().is_some_and(|draft|draft.confirmed)}));
            return;
        }
        if request.action == "inspect" {
            let point = rl_point;
            self.emit(
                Some(&request),
                "EditorState",
                json!({"line":line(),"point_utf8_bytes":point}),
            );
            return;
        }
        if self.draft.is_none() && matches!(request.action.as_str(), "cancel" | "takeover") {
            self.retired.insert(request.operation.clone());
            if request.action == "takeover" {
                self.lease += 1;
            }
            self.emit(
                Some(&request),
                "DraftCleared",
                json!({"owned_draft_absent":true,
                "editor_empty":line().is_empty(),"user_draft_preserved":!line().is_empty()}),
            );
            return;
        }
        if request.action == "prepare" {
            let valid = request.source.len() <= 8192
                && (!request.source.is_empty() || request.private_control)
                && !request
                    .source
                    .chars()
                    .any(|c| c == '\0' || (c.is_control() && !matches!(c, '\n' | '\r' | '\t')))
                && request.source_digest == digest(&request.source)
                && request.plan_digest == digest(&request.plan)
                && request
                    .native
                    .as_ref()
                    .is_some_and(|envelope| match &envelope.payload {
                        nip::Payload::PrepareInput { source, job, .. } => {
                            let expected = if let Some(job) = job {
                                nip::native_bash_job_plan(source, job)
                            } else {
                                nip::native_bash_plan(source)
                            };
                            expected.is_ok_and(|expected| request.plan == expected)
                                && if request.private_control {
                                    request.source.is_empty()
                                } else {
                                    request.source == *source
                                }
                        }
                        _ => false,
                    });
            if !valid || self.draft.is_some() || !line().is_empty() {
                self.emit(Some(&request), "Rejected", json!("binding/busy/user-draft"));
                return;
            }
            if request.private_control {
                let job = request
                    .native
                    .as_ref()
                    .and_then(|envelope| match &envelope.payload {
                        nip::Payload::PrepareInput { job, .. } => job.as_ref(),
                        _ => None,
                    });
                if job.is_none_or(|job| self.write_control_metadata(job).is_err()) {
                    self.emit(
                        Some(&request),
                        "RecoveryRequired",
                        json!("private-control-metadata"),
                    );
                    self.fail_closed();
                    return;
                }
            }
            let boundaries = request
                .source
                .grapheme_indices(true)
                .map(|(i, _)| i)
                .skip(1)
                .chain(std::iter::once(request.source.len()))
                .collect();
            self.emit(
                Some(&request),
                "Prepared",
                json!({"source_digest":request.source_digest,"plan_digest":request.plan_digest}),
            );
            self.draft = Some(Draft {
                request,
                boundaries,
                visible: 0,
                started: Instant::now(),
                confirmed: false,
                submitted: false,
                native_started: false,
                commit: None,
            });
            return;
        }
        let matches = self.draft.as_ref().is_some_and(|draft| {
            draft.request.operation == request.operation
                && draft.request.revision == request.revision
                && draft.request.source_digest == request.source_digest
                && draft.request.plan_digest == request.plan_digest
        });
        if !matches {
            self.emit(Some(&request), "Rejected", json!("no-matching-draft"));
            return;
        }
        match request.action.as_str() {
            "cancel" | "takeover" => {
                if self.clear_owned() {
                    self.retired.insert(request.operation.clone());
                    self.draft = None;
                    if request.action == "takeover" {
                        self.lease += 1;
                    }
                    self.emit(Some(&request), "DraftCleared", json!({"line":line()}));
                } else {
                    self.emit(
                        Some(&request),
                        "RecoveryRequired",
                        json!("submitted-or-editor-changed"),
                    );
                }
            }
            "commit" => {
                if p0_bindings_valid() != 1 {
                    self.emit(Some(&request), "Rejected", json!("native-bindings-changed"));
                    return;
                }
                let draft = self.draft.as_mut().unwrap();
                if draft.submitted || !draft.confirmed || !owned_line_matches(&draft.request.source)
                {
                    self.emit(
                        Some(&request),
                        "Rejected",
                        json!("not-confirmed-or-submitted"),
                    );
                    return;
                }
                if draft.commit.is_some() {
                    self.emit(Some(&request), "Rejected", json!("commit-already-armed"));
                    return;
                }
                draft.commit = Some(request.clone());
                self.emit(Some(&request), "CommitArmed", json!({"source_digest":request.source_digest,"plan_digest":request.plan_digest}));
            }
            "query" => self.emit(
                Some(&request),
                "Snapshot",
                json!({"line":line(),"confirmed":self.draft.as_ref().unwrap().confirmed}),
            ),
            _ => self.emit(Some(&request), "Rejected", json!("unknown-action")),
        }
    }
    unsafe fn tick(&mut self) {
        if self
            .receiving_until
            .is_some_and(|deadline| Instant::now() > deadline)
        {
            self.fail_closed();
            return;
        }
        let mut chunk = [0; 8192];
        for _ in 0..16 {
            match self.socket.read(&mut chunk) {
                Ok(0) => {
                    self.fail_closed();
                    return;
                }
                Ok(count) => {
                    if self.native_mode {
                        match self.native_decoder.push(&chunk[..count]) {
                            Ok(messages) => {
                                for message in messages {
                                    match message {
                                        nip::Message::Connection(message) => {
                                            self.receive_native_connection(message)
                                        }
                                        nip::Message::Operation(message) => {
                                            self.receive_native(message)
                                        }
                                    }
                                }
                            }
                            Err(_) => {
                                self.fail_closed();
                                return;
                            }
                        }
                    } else {
                        self.input.extend_from_slice(&chunk[..count]);
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => {
                    self.fail_closed();
                    return;
                }
            }
            if self.input.len() > 131_072 {
                self.fail_closed();
                return;
            }
        }
        loop {
            let mut decoder =
                serde_json::Deserializer::from_slice(&self.input).into_iter::<Value>();
            match decoder.next() {
                Some(Ok(value)) => {
                    let consumed = decoder.byte_offset();
                    self.input.drain(..consumed);
                    match serde_json::from_value::<Request>(value) {
                        Ok(request) => self.receive(request),
                        Err(_) => {
                            self.fail_closed();
                            return;
                        }
                    }
                }
                Some(Err(error)) if error.is_eof() => break,
                None => {
                    self.input.clear();
                    break;
                }
                Some(Err(_)) => {
                    self.fail_closed();
                    return;
                }
            }
        }
        if let Some(draft) = self.draft.as_mut() {
            if !draft.submitted
                && (draft.request.expires_ms < now_ms()
                    || self
                        .native_guard
                        .as_ref()
                        .is_some_and(nip::RequestGuard::expired))
            {
                let request = draft.request.clone();
                let cleared = self.clear_owned();
                self.retired.insert(request.operation.clone());
                self.draft = None;
                self.emit(Some(&request), "Expired", json!({"draft_cleared":cleared}));
            } else if !draft.confirmed && !draft.submitted {
                if !owned_line_matches(&draft.request.source[..draft.visible]) {
                    self.emit(None, "RecoveryRequired", json!("editor-changed"));
                    self.fail_closed();
                    return;
                }
                let elapsed = draft.started.elapsed().as_millis() as usize;
                let count = if draft.request.reduced {
                    draft.boundaries.len()
                } else {
                    ((elapsed * draft.boundaries.len() / 1500) + 1).min(draft.boundaries.len())
                };
                let next =
                    if draft.request.viewport_safe && !draft.request.reduced && elapsed < 1500 {
                        let budget = p0_preview_bytes().max(0) as usize;
                        let safe = draft
                            .boundaries
                            .iter()
                            .take_while(|end| **end <= budget)
                            .count();
                        if safe == 0 {
                            0
                        } else {
                            draft.boundaries[((elapsed * safe / 1500) + 1).min(safe) - 1]
                        }
                    } else {
                        draft.boundaries[count - 1]
                    };
                if next > draft.visible {
                    if draft.visible == 0
                        && draft.request.append_display
                        && p0_begin_append_display() != 0
                    {
                        self.emit(
                            None,
                            "RecoveryRequired",
                            json!("native-append-provider-unavailable"),
                        );
                        self.fail_closed();
                        return;
                    }
                    if draft.visible == 0
                        && draft.request.start_rebase
                        && p0_begin_display(draft.request.geometry_rebase as c_int) != 0
                    {
                        self.emit(
                            None,
                            "RecoveryRequired",
                            json!("native-redisplay-provider-unavailable"),
                        );
                        self.fail_closed();
                        return;
                    }
                    if draft.request.viewport_safe && next == draft.request.source.len() {
                        p0_finish_preview();
                    }
                    if draft.request.insertion {
                        let suffix =
                            CString::new(&draft.request.source[draft.visible..next]).unwrap();
                        rl_insert_text(suffix.as_ptr());
                    } else {
                        replace(&draft.request.source[..next]);
                    }
                    p0_paint_line();
                    draft.visible = next;
                }
                if draft.visible == draft.request.source.len() {
                    if !owned_line_matches(&draft.request.source) {
                        self.emit(
                            None,
                            "RecoveryRequired",
                            json!("native-complete-buffer-mismatch"),
                        );
                        self.fail_closed();
                        return;
                    }
                    draft.confirmed = true;
                    let request = draft.request.clone();
                    let rebases = p0_display_rebases();
                    self.emit(Some(&request), "InputConfirmed", json!({"source_digest":request.source_digest,
                        "plan_digest":request.plan_digest,"utf8_bytes":request.source.len(),"elapsed_ms":elapsed,"display_rebases":rebases}));
                }
            }
        }
        if !self.flush() {
            self.fail_closed();
        }
    }
}
#[no_mangle]
pub extern "C" fn p0_tick() -> c_int {
    let result = std::panic::catch_unwind(|| unsafe {
        if let Some(bridge) = BRIDGE.as_mut() {
            if bridge.active {
                bridge.tick();
            }
        }
    });
    if result.is_err() {
        unsafe {
            if let Some(bridge) = BRIDGE.as_mut() {
                bridge.fail_closed();
            }
        }
    }
    unsafe {
        p0_refresh_input();
    }
    0
}
#[no_mangle]
pub unsafe extern "C" fn p0_needs_tick() -> c_int {
    BRIDGE.as_ref().is_some_and(|bridge| {
        bridge.active
            && (bridge.receiving_until.is_some()
                || !bridge.output.is_empty()
                || !bridge.input.is_empty()
                || bridge.draft.as_ref().is_some_and(|draft| !draft.submitted))
    }) as c_int
}
#[no_mangle]
pub unsafe extern "C" fn p0_service() {
    if let Some(bridge) = BRIDGE.as_mut().filter(|bridge| bridge.active) {
        bridge.receiving_until = Some(Instant::now() + std::time::Duration::from_secs(5));
    }
}
#[no_mangle]
pub unsafe extern "C" fn p0_editor_ready(bindings_valid: c_int) {
    if let Some(bridge) = BRIDGE.as_mut().filter(|bridge| bridge.native_mode) {
        if let Some(request) = bridge.native_connection.clone() {
            bridge.reply_connection(
                &request,
                nip::ConnectionPayload::EditorReady {
                    editor_empty: bindings_valid == 1
                        && CStr::from_ptr(rl_line_buffer).to_bytes().is_empty(),
                    owned_draft_absent: bridge.draft.is_none(),
                    after_command: bridge.native_last_prepared.clone(),
                },
            );
            bridge.flush();
        } else if bindings_valid == 1 {
            bridge.receiving_until = Some(Instant::now() + std::time::Duration::from_secs(5));
            p0_refresh_input();
        }
    }
    if let Some(bridge) = BRIDGE.as_mut() {
        if bindings_valid == 1 {
            bridge.emit(
                None,
                "EditorReady",
                json!({"line":line(),"bindings_valid":true}),
            );
        } else {
            bridge.active = false;
            bridge.emit(None, "CapabilitiesLost", json!("native-bindings-changed"));
        }
        bridge.flush();
    }
    p0_refresh_input();
}
// The executable write is one owned native chord. Using the ordinary Readline
// command dispatcher avoids accepting a line from inside its input-wait hook.
// No shell evaluation takes place in this callback.
#[no_mangle]
pub extern "C" fn p0_commit_key(_: c_int, _: c_int) -> c_int {
    unsafe {
        let Some(bridge) = BRIDGE.as_mut() else {
            return 0;
        };
        let Some(draft) = bridge.draft.as_mut() else {
            return 0;
        };
        let Some(request) = draft.commit.take() else {
            return 0;
        };
        if !bridge.active
            || draft.submitted
            || request.expires_ms < now_ms()
            || bridge
                .native_guard
                .as_ref()
                .is_some_and(nip::RequestGuard::expired)
            || request.lease != bridge.lease
            || !owned_line_matches(&draft.request.source)
        {
            bridge.emit(
                Some(&request),
                "Rejected",
                json!("commit-key-editor-or-identity"),
            );
            bridge.flush();
            return 0;
        }
        // Finish native source redisplay before swapping the returned line.
        // Bash's next ordinary parser cycle evaluates this at parent top level.
        let mut blocked: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut blocked);
        libc::sigaddset(&mut blocked, libc::SIGINT);
        if libc::sigprocmask(
            libc::SIG_BLOCK,
            &blocked,
            std::ptr::addr_of_mut!(SAVED_MASK).cast(),
        ) != 0
        {
            bridge.emit(Some(&request), "Rejected", json!("signal-mask-failed"));
            bridge.flush();
            return 0;
        }
        MASKED = true;
        let private_control = draft.request.private_control;
        if !private_control {
            p0_accept_line();
            replace(&draft.request.plan);
            rl_done = 1;
        }
        draft.submitted = true;
        p0_finish_input();
        bridge.emit(
            Some(&request),
            "SubmissionAccepted",
            json!({"source_digest":request.source_digest,"plan_digest":request.plan_digest}),
        );
        bridge.flush();
        if private_control && ss_native_queue_control() != 0 {
            release_int_mask();
            bridge.fail_closed();
        }
    }
    0
}
#[no_mangle]
pub unsafe extern "C" fn p0_begin(status: c_int) -> c_int {
    if let Some(draft) = BRIDGE.as_ref().and_then(|bridge| bridge.draft.as_ref()) {
        if let Some(request) = &draft.request.native {
            let marker = CString::new(nip::capture_marker(&request.request_id, false)).unwrap();
            ss_native_capture_fence(marker.as_ptr());
        }
    }
    // This builtin executes only AFTER Bash parsed the entire fixed wrapper.
    // It introduces no function scope and evaluates no source. Deliver pending
    // INT at this top-level boundary instead of halfway through wrapper parsing.
    release_int_mask();
    if let Some(bridge) = BRIDGE.as_mut() {
        if let Some(draft) = bridge.draft.as_mut() {
            draft.native_started = true;
            let request = draft.request.clone();
            bridge.emit(Some(&request), "Started", json!({"previous_exit":status}));
            bridge.flush();
        }
    }
    status
}
unsafe fn release_int_mask() {
    if MASKED {
        MASKED = false;
        // Readline can temporarily block INT while dispatching a key. It must
        // not become the top-level execution mask. Start refuses an inherited
        // blocked INT; remove only the bit owned by this handoff.
        libc::sigdelset(std::ptr::addr_of_mut!(SAVED_MASK).cast(), libc::SIGINT);
        libc::sigprocmask(
            libc::SIG_SETMASK,
            std::ptr::addr_of!(SAVED_MASK).cast(),
            std::ptr::null_mut(),
        );
    }
}
#[no_mangle]
pub unsafe extern "C" fn p0_start(path: *const c_char, shell_version: *const c_char) -> c_int {
    if !BRIDGE.is_null() {
        return 1;
    }
    let mut mask: libc::sigset_t = std::mem::zeroed();
    if libc::sigprocmask(libc::SIG_BLOCK, std::ptr::null(), &mut mask) != 0
        || libc::sigismember(&mask, libc::SIGINT) != 0
    {
        return 1;
    }
    let mut kind = 0;
    if !rl_function_of_keyseq(c"\x18a".as_ptr(), rl_get_keymap(), &mut kind).is_null() {
        return 1;
    }
    if !rl_function_of_keyseq(c"\x18\x1e".as_ptr(), rl_get_keymap(), &mut kind).is_null() {
        return 1;
    }
    if !rl_function_of_keyseq(c"\x18b".as_ptr(), rl_get_keymap(), &mut kind).is_null() {
        return 1;
    }
    let Ok(path) = CStr::from_ptr(path).to_str() else {
        return 2;
    };
    let Ok(socket) = UnixStream::connect(path) else {
        return 1;
    };
    if socket.set_nonblocking(true).is_err() {
        return 1;
    }
    if p0_install_input() != 0 {
        return 1;
    }
    if rl_bind_keyseq(c"\x18a".as_ptr(), Some(p0_commit_key)) != 0 {
        p0_uninstall_input();
        return 1;
    }
    CONTROL_FD = socket.as_raw_fd();
    if !FORK_REGISTERED {
        if libc::pthread_atfork(None, None, Some(fork_child)) != 0 {
            p0_uninstall_input();
            CONTROL_FD = -1;
            return 1;
        }
        FORK_REGISTERED = true;
    }
    let mut bridge = Box::new(Bridge {
        control_file: PathBuf::from(format!("{path}.control")),
        outgoing_since: None,
        native_connection: None,
        native_last_prepared: None,
        native_shell_version: if shell_version.is_null() {
            None
        } else {
            CStr::from_ptr(shell_version)
                .to_str()
                .ok()
                .map(str::to_owned)
        },
        native_decoder: nip::Decoder::default(),
        native_guard: None,
        native_request: None,
        native_sequence: 0,
        native_mode: true,
        native_result: None,
        socket,
        input: Vec::new(),
        output: Vec::new(),
        seen: HashSet::new(),
        retired: HashSet::new(),
        lease: 1,
        draft: None,
        active: true,
        receiving_until: None,
    });
    bridge.emit(
        None,
        "Capabilities",
        json!({"readline":CStr::from_ptr(rl_library_version).to_string_lossy(),
        "readline_numeric":rl_readline_version,
        "protocol":"p0-experimental-json-stream","thread":"scoped-readline-event-hook"}),
    );
    bridge.flush();
    if bridge.native_mode {
        p0_native_display_reset();
    }
    BRIDGE = Box::into_raw(bridge);
    0
}
#[no_mangle]
pub unsafe extern "C" fn p0_status(status: c_int, cwd: *const c_char) -> c_int {
    if let Some(bridge) = BRIDGE.as_mut() {
        if let Some(connection) = bridge.native_connection.clone() {
            if let Ok(cwd) = CStr::from_ptr(cwd).to_str() {
                bridge.reply_connection(
                    &connection,
                    nip::ConnectionPayload::Directory { cwd: cwd.into() },
                );
            }
        }
        if let Some(draft) = bridge.draft.take() {
            if draft.submitted {
                if draft.request.private_control {
                    bridge.draft = Some(draft);
                    bridge.fail_closed();
                    return status;
                }
                if let Some(request) = &draft.request.native {
                    let marker =
                        CString::new(nip::capture_marker(&request.request_id, true)).unwrap();
                    ss_native_capture_fence(marker.as_ptr());
                }
                bridge.native_result = Some(status);
                bridge.retired.insert(draft.request.operation.clone());
                bridge.emit(
                    Some(&draft.request),
                    "Settled",
                    json!({"exit":status,"cwd":CStr::from_ptr(cwd).to_string_lossy()}),
                );
            } else {
                bridge.draft = Some(draft);
            }
        }
        bridge.emit(None, "Prompt", json!({"exit":status}));
        bridge.flush();
    }
    status
}

#[no_mangle]
pub unsafe extern "C" fn ss_native_job(
    handle: *const c_char,
    state: *const c_char,
    exit: *const c_char,
) -> c_int {
    let Some(bridge) = BRIDGE.as_mut().filter(|bridge| bridge.active) else {
        return 1;
    };
    let Some(connection) = bridge.native_connection.clone() else {
        return 1;
    };
    let (Ok(handle), Ok(state), Ok(exit)) = (
        CStr::from_ptr(handle).to_str(),
        CStr::from_ptr(state).to_str(),
        CStr::from_ptr(exit).to_str(),
    ) else {
        return 2;
    };
    if !nip::valid_job_handle(handle) {
        return 2;
    }
    bridge.reply_connection(
        &connection,
        nip::ConnectionPayload::JobObservation {
            handle: handle.into(),
            state: state.into(),
            exit_code: exit.parse().ok(),
        },
    );
    if bridge.flush() {
        0
    } else {
        1
    }
}

impl Bridge {
    fn write_control_metadata(&self, job: &nip::JobExecution) -> std::io::Result<()> {
        let nip::JobExecution::Control {
            handle,
            stop,
            nonce,
        } = job
        else {
            return Err(std::io::Error::other("not a private control"));
        };
        let temporary = self.control_file.with_extension(format!("{nonce}.pending"));
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)?;
        // Standard TSV, normalized scalar fields only. The Bash read builtin
        // reads it; no user source or generated shell program is evaluated.
        write!(
            file,
            "NIP1-CONTROL\t{handle}\t{}\t{nonce}\n",
            if *stop { "stop" } else { "poll" }
        )?;
        drop(file);
        std::fs::rename(temporary, &self.control_file)
    }
    unsafe fn control_allowed(&self) -> bool {
        self.active
            && p0_bindings_valid() == 1
            && owned_line_matches("")
            && self
                .native_guard
                .as_ref()
                .is_some_and(|guard| !guard.expired())
            && self.draft.as_ref().is_some_and(|draft| {
                draft.request.private_control && draft.submitted && !draft.native_started
            })
    }
}
#[no_mangle]
pub unsafe extern "C" fn ss_native_control_access() -> c_int {
    if BRIDGE
        .as_ref()
        .is_some_and(|bridge| bridge.control_allowed())
    {
        0
    } else {
        1
    }
}
#[no_mangle]
pub unsafe extern "C" fn ss_native_control_begin(
    handle: *const c_char,
    action: *const c_char,
    nonce: *const c_char,
) -> c_int {
    let Some(bridge) = BRIDGE.as_mut().filter(|bridge| bridge.control_allowed()) else {
        return 1;
    };
    let matches=bridge.draft.as_ref().and_then(|draft|draft.request.native.as_ref()).is_some_and(|request|matches!(&request.payload,nip::Payload::PrepareInput{job:Some(nip::JobExecution::Control{handle:expected,stop,nonce:key}),..}
        if CStr::from_ptr(handle).to_bytes()==expected.as_bytes()&&CStr::from_ptr(action).to_bytes()==if *stop{b"stop"}else{b"poll"}&&CStr::from_ptr(nonce).to_bytes()==key.as_bytes()));
    if !matches {
        return 1;
    }
    let draft = bridge.draft.as_mut().unwrap();
    draft.native_started = true;
    let request = draft.request.clone();
    let marker = CString::new(nip::capture_marker(
        &request.native.as_ref().unwrap().request_id,
        false,
    ))
    .unwrap();
    ss_native_capture_fence(marker.as_ptr());
    bridge.emit(Some(&request), "Started", json!({}));
    bridge.flush();
    release_int_mask();
    0
}
#[no_mangle]
pub unsafe extern "C" fn ss_native_control_end(result: c_int, cwd: *const c_char) -> c_int {
    let Some(bridge) = BRIDGE.as_mut() else {
        return result;
    };
    let Some(draft) = bridge.draft.take() else {
        return result;
    };
    if !draft.request.private_control || !draft.submitted || !draft.native_started {
        bridge.draft = Some(draft);
        return 1;
    }
    let marker = CString::new(nip::capture_marker(
        &draft.request.native.as_ref().unwrap().request_id,
        true,
    ))
    .unwrap();
    ss_native_capture_fence(marker.as_ptr());
    bridge.native_result = Some(result);
    bridge.retired.insert(draft.request.operation.clone());
    let _ = std::fs::remove_file(&bridge.control_file);
    if let (Some(connection), Ok(cwd)) = (
        bridge.native_connection.clone(),
        CStr::from_ptr(cwd).to_str(),
    ) {
        bridge.reply_connection(
            &connection,
            nip::ConnectionPayload::Directory { cwd: cwd.into() },
        );
    }
    bridge.emit(Some(&draft.request), "Settled", json!({"exit":result}));
    bridge.flush();
    result
}
#[no_mangle]
pub unsafe extern "C" fn ss_native_control_returned() {
    release_int_mask();
    if let Some(bridge) = BRIDGE.as_mut() {
        if bridge
            .draft
            .as_ref()
            .is_some_and(|draft| draft.request.private_control && draft.submitted)
        {
            bridge.fail_closed();
            return;
        }
    }
    p0_editor_ready(p0_bindings_valid());
}
#[no_mangle]
pub unsafe extern "C" fn p0_stop() {
    if MASKED {
        MASKED = false;
        libc::sigprocmask(
            libc::SIG_SETMASK,
            std::ptr::addr_of!(SAVED_MASK).cast(),
            std::ptr::null_mut(),
        );
    }
    if !BRIDGE.is_null() {
        let mut bridge = Box::from_raw(BRIDGE);
        p0_uninstall_input();
        bridge.active = false;
        BRIDGE = std::ptr::null_mut();
        CONTROL_FD = -1;
    }
}
