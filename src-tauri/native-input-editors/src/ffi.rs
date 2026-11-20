//! Small data-only ABI. The host supplies actual public-editor observations.
//! No pointer returned by this module survives the next call on that context.
use super::*;
use std::ffi::{c_char, CStr, CString};
pub struct Context {
    editor: Editor,
    text: CString,
    output: Vec<u8>,
}
unsafe fn string<'a>(value: *const c_char) -> Option<&'a str> {
    if value.is_null() {
        None
    } else {
        CStr::from_ptr(value).to_str().ok()
    }
}
#[no_mangle]
pub unsafe extern "C" fn ss_editor_new(profile: *const c_char, supported: i32) -> *mut Context {
    let Some(profile) =
        string(profile).and_then(|s| serde_json::from_str::<nip::PeerProfile>(s).ok())
    else {
        return std::ptr::null_mut();
    };
    Box::into_raw(Box::new(Context {
        editor: Editor::new(profile, supported == 1),
        text: CString::default(),
        output: Vec::new(),
    }))
}
#[no_mangle]
pub unsafe extern "C" fn ss_editor_receive(
    context: *mut Context,
    bytes: *const u8,
    size: usize,
) -> i32 {
    let Some(context) = context.as_mut() else {
        return 0;
    };
    if bytes.is_null() || size > nip::MAX_MESSAGE_BYTES {
        context.editor.eof();
        return 0;
    }
    context
        .editor
        .receive(std::slice::from_raw_parts(bytes, size)) as i32
}
#[no_mangle]
pub unsafe extern "C" fn ss_editor_observe(
    context: *mut Context,
    text: *const c_char,
    cursor: usize,
) -> i32 {
    let Some(context) = context.as_mut() else {
        return 0;
    };
    let Some(text) = string(text) else {
        context.editor.eof();
        return 0;
    };
    context.editor.observe(text, cursor) as i32
}
#[no_mangle]
pub unsafe extern "C" fn ss_editor_observe_chars(
    context: *mut Context,
    text: *const c_char,
    cursor: usize,
) -> i32 {
    let Some(context) = context.as_mut() else {
        return 0;
    };
    let Some(text) = string(text) else {
        context.editor.eof();
        return 0;
    };
    if cursor > text.chars().count() {
        context.editor.eof();
        return 0;
    }
    let point = text.chars().take(cursor).map(char::len_utf8).sum();
    context.editor.observe(text, point) as i32
}
// A real line return is still guarded before the protected accept key, even
// while the control channel is healthy. This query never authorizes execution.
#[no_mangle]
pub unsafe extern "C" fn ss_editor_guarded_handoff(context: *mut Context) -> i32 {
    let Some(context) = context.as_ref() else {
        return 0;
    };
    (context.editor.thread == std::thread::current().id()
        && context
            .editor
            .draft
            .as_ref()
            .is_some_and(|draft| !draft.running && !draft.host_returned && !draft.local_discarded))
        as i32
}
// Read-only, same-thread local cleanup decision after the transport has failed.
// This is never a protocol DraftCleared receipt or permission to submit again.
#[no_mangle]
pub unsafe extern "C" fn ss_editor_eof_owned_chars(
    context: *mut Context,
    text: *const c_char,
    cursor: usize,
) -> i32 {
    let Some(context) = context.as_ref() else {
        return 0;
    };
    if !context.editor.failed || context.editor.thread != std::thread::current().id() {
        return 0;
    }
    let Some(text) = string(text) else {
        return 0;
    };
    let Some(draft) = context.editor.draft.as_ref() else {
        return 0;
    };
    (!draft.running
        && !draft.host_returned
        && !draft.local_discarded
        && text == &draft.source[..draft.applied]
        && cursor == text.chars().count()) as i32
}
#[no_mangle]
pub unsafe extern "C" fn ss_editor_eof_cleared(
    context: *mut Context,
    text: *const c_char,
    cursor: usize,
) -> i32 {
    let Some(context) = context.as_mut() else {
        return 0;
    };
    if !context.editor.failed
        || context.editor.thread != std::thread::current().id()
        || string(text) != Some("")
        || cursor != 0
    {
        return 0;
    }
    let Some(draft) = context.editor.draft.as_mut() else {
        return 0;
    };
    if draft.running || draft.host_returned {
        return 0;
    }
    // The host has re-read the real empty editor after its own safe clear or
    // the user's explicit discard. Preserve accepted/history and failed state;
    // retire only the local Enter guard, without emitting any receipt.
    draft.local_discarded = true;
    1
}
#[no_mangle]
pub unsafe extern "C" fn ss_editor_marker(context: *mut Context, end: i32) -> *const c_char {
    let Some(context) = context.as_mut() else {
        return std::ptr::null();
    };
    let Some(draft) = &context.editor.draft else {
        return std::ptr::null();
    };
    context.text = CString::new(nip::capture_marker(&draft.prepare.request_id, end == 1)).unwrap();
    context.text.as_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ss_editor_plan(
    context: *mut Context,
    text: *const c_char,
) -> *const c_char {
    let Some(context) = context.as_mut() else {
        return std::ptr::null();
    };
    if !context.editor.check_thread() {
        return std::ptr::null();
    }
    let Some(actual) = string(text) else {
        return std::ptr::null();
    };
    let Some(draft) = &mut context.editor.draft else {
        return std::ptr::null();
    };
    if !draft.accepted || draft.host_returned || draft.local_discarded || draft.source != actual {
        context.editor.eof();
        return std::ptr::null();
    }
    draft.host_returned = true;
    context.text = CString::new(draft.execution_line.as_deref().unwrap_or(&draft.plan)).unwrap();
    context.text.as_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ss_editor_host_plan(context: *mut Context, text: *const c_char) -> i32 {
    let Some(context) = context.as_mut() else {
        return 0;
    };
    if !context.editor.check_thread()
        || context.editor.action != Action::Validate
        || context.editor.profile.editor != nip::EditorFamily::PsReadLine
    {
        return 0;
    }
    let Some(text) = string(text).filter(|text| !text.is_empty() && text.len() <= 32768) else {
        return 0;
    };
    let Some(draft) = context.editor.draft.as_mut() else {
        return 0;
    };
    if draft.applied != 0 || draft.accepted || draft.execution_line.is_some() {
        return 0;
    }
    draft.execution_line = Some(text.into());
    1
}
#[no_mangle]
pub unsafe extern "C" fn ss_editor_validation_plan(context: *mut Context) -> *const c_char {
    let Some(context) = context.as_mut() else {
        return std::ptr::null();
    };
    if !context.editor.check_thread() {
        return std::ptr::null();
    }
    let Some(draft) = &context.editor.draft else {
        return std::ptr::null();
    };
    context.text = CString::new(draft.plan.as_str()).unwrap();
    context.text.as_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ss_editor_job(context: *mut Context, field: i32) -> *const c_char {
    let Some(context) = context.as_mut() else {
        return std::ptr::null();
    };
    let value = match context.editor.draft.as_ref().and_then(|d| d.job.as_ref()) {
        Some(nip::JobExecution::Launch { handle }) => match field {
            0 => "launch".into(),
            1 => handle.clone(),
            3 => format!(
                "{handle} '{}'",
                context
                    .editor
                    .draft
                    .as_ref()
                    .unwrap()
                    .source
                    .replace('\'', "''")
            ),
            _ => String::new(),
        },
        Some(nip::JobExecution::Control { handle, stop, .. }) => match field {
            0 => "control".into(),
            1 => handle.clone(),
            2 => {
                if *stop {
                    "stop".into()
                } else {
                    "poll".into()
                }
            }
            _ => String::new(),
        },
        None => String::new(),
    };
    context.text = CString::new(value).unwrap();
    context.text.as_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ss_editor_job_observation(
    context: *mut Context,
    handle: *const c_char,
    state: *const c_char,
    status: i32,
    has_status: i32,
) -> i32 {
    let Some(context) = context.as_mut() else {
        return 0;
    };
    let (Some(handle), Some(state)) = (string(handle), string(state)) else {
        return 0;
    };
    if !nip::valid_job_handle(handle) {
        return 0;
    }
    context
        .editor
        .connection_reply(nip::ConnectionPayload::JobObservation {
            handle: handle.into(),
            state: state.into(),
            exit_code: if has_status == 1 { Some(status) } else { None },
        });
    1
}
#[no_mangle]
pub unsafe extern "C" fn ss_editor_action(context: *mut Context) -> i32 {
    let Some(context) = context.as_mut() else {
        return -1;
    };
    let action = context.editor.advance();
    context.text = CString::new(context.editor.replacement()).unwrap_or_default();
    if context.editor.failed() {
        -1
    } else {
        match action {
            Action::None => 0,
            Action::Replace => 1,
            Action::Clear => 2,
            Action::Validate => 3,
        }
    }
}
#[no_mangle]
pub unsafe extern "C" fn ss_editor_text(context: *mut Context) -> *const c_char {
    context
        .as_ref()
        .map_or(std::ptr::null(), |c| c.text.as_ptr())
}
#[no_mangle]
pub unsafe extern "C" fn ss_editor_string_size(context: *mut Context) -> usize {
    context.as_ref().map_or(0, |c| c.text.as_bytes().len())
}
#[no_mangle]
pub unsafe extern "C" fn ss_editor_owned_source_size(context: *mut Context) -> usize {
    let Some(context) = context.as_ref() else {
        return 0;
    };
    if context.editor.failed
        || context.editor.thread != std::thread::current().id()
        || !context.editor.owned()
    {
        return 0;
    }
    context
        .editor
        .draft
        .as_ref()
        .filter(|draft| {
            draft.validated && !draft.accepted && !draft.host_returned && !draft.local_discarded
        })
        .map_or(0, |draft| draft.source.len())
}
#[no_mangle]
pub unsafe extern "C" fn ss_editor_complete_source(
    context: *mut Context,
    text: *const c_char,
) -> i32 {
    let Some(context) = context.as_ref() else {
        return 0;
    };
    if context.editor.failed || context.editor.thread != std::thread::current().id() {
        return 0;
    }
    let Some(actual) = string(text) else {
        return 0;
    };
    context.editor.draft.as_ref().is_some_and(|draft| {
        draft.validated
            && !draft.accepted
            && !draft.host_returned
            && !draft.local_discarded
            && actual == draft.source
    }) as i32
}
#[no_mangle]
pub unsafe extern "C" fn ss_editor_event(
    context: *mut Context,
    event: i32,
    status: i32,
    cwd: *const c_char,
) -> i32 {
    let Some(context) = context.as_mut() else {
        return 0;
    };
    if event == 16 {
        return context.editor.accept_failure_reason();
    }
    if event == 17 {
        return context.editor.prepare_elapsed_ms();
    }
    if event == 15 {
        if context.editor.thread != std::thread::current().id() {
            return -1;
        }
        // Keep an accepted, not-yet-returned line guarded even after EOF. Once
        // that exact line has been returned to its parent parser, later ordinary
        // user lines do not belong to this handoff and must remain usable.
        return context
            .editor
            .draft
            .as_ref()
            .is_some_and(|draft| draft.accepted && !draft.host_returned && !draft.local_discarded)
            as i32;
    }
    if !context.editor.check_thread() {
        return 0;
    }
    match event {
        1 => context.editor.acknowledge() as i32,
        2 => context.editor.accept() as i32,
        3 => context.editor.started() as i32,
        4 => context.editor.settled(status) as i32,
        5 => {
            if let Some(cwd) = string(cwd) {
                context.editor.ready(cwd);
                1
            } else {
                0
            }
        }
        6 => {
            context.editor.eof();
            0
        }
        7 => context.editor.typing() as i32,
        8 => context.editor.armed() as i32,
        9 => context.editor.owned_draft() as i32,
        10 => context.editor.validate_source(status == 1) as i32,
        11 => {
            context
                .editor
                .connection_reply(nip::ConnectionPayload::EditorOptions {
                    interactive_comments: status & 1 != 0,
                    native_jobs: status & 2 != 0,
                });
            1
        }
        _ => 0,
    }
}
#[no_mangle]
pub unsafe extern "C" fn ss_editor_display_command(
    context: *mut Context,
    end: i32,
    status: i32,
    cwd: *const c_char,
) -> u64 {
    let Some(context) = context.as_mut() else {
        return 0;
    };
    let Some(cwd) = string(cwd) else {
        return 0;
    };
    context
        .editor
        .display_command(cwd, (end != 0).then_some(status))
}

#[no_mangle]
pub unsafe extern "C" fn ss_editor_output(context: *mut Context, size: *mut usize) -> *const u8 {
    let (Some(context), Some(size)) = (context.as_mut(), size.as_mut()) else {
        return std::ptr::null();
    };
    context.output = context.editor.take_output().unwrap_or_default();
    *size = context.output.len();
    context.output.as_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ss_editor_drop(context: *mut Context) {
    if !context.is_null() {
        drop(Box::from_raw(context));
    }
}
