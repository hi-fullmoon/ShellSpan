use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use libssh2_sys as raw;
use serde::Serialize;
use ssh2::Session;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::oneshot;
use uuid::Uuid;
use zeroize::Zeroizing;

const PROMPT_EVENT: &str = "ssh-interactive-auth-prompt";
const PROMPT_CLOSED_EVENT: &str = "ssh-interactive-auth-closed";
const ROUND_TIMEOUT: Duration = Duration::from_secs(60);
pub(crate) const CONNECTION_TIMEOUT: Duration = Duration::from_secs(120);
pub(super) const CANCELLED: &str = "SSH interactive authentication cancelled";
const MAX_PROMPTS: usize = 16;
const MAX_RESPONSE_BYTES: usize = 4096;
const MAX_ROUNDS: usize = 16;

type Answers = Zeroizing<Vec<String>>;

struct PendingPrompt {
    operation_id: String,
    count: usize,
    response: oneshot::Sender<Option<Answers>>,
}

#[derive(Default)]
pub(crate) struct InteractiveAuthRegistry(Mutex<HashMap<String, PendingPrompt>>);

impl InteractiveAuthRegistry {
    fn open(
        &self,
        operation_id: &str,
        count: usize,
    ) -> Result<(String, oneshot::Receiver<Option<Answers>>), &'static str> {
        let prompt_id = Uuid::new_v4().to_string();
        let (response, receiver) = oneshot::channel();
        self.0
            .lock()
            .map_err(|_| "SSH authentication prompt registry is unavailable")?
            .insert(
                prompt_id.clone(),
                PendingPrompt {
                    operation_id: operation_id.to_string(),
                    count,
                    response,
                },
            );
        Ok((prompt_id, receiver))
    }

    fn close(&self, prompt_id: &str) {
        if let Ok(mut pending) = self.0.lock() {
            pending.remove(prompt_id);
        }
    }

    fn respond(
        &self,
        operation_id: &str,
        prompt_id: &str,
        answers: Option<Answers>,
    ) -> Result<(), &'static str> {
        let mut pending = self
            .0
            .lock()
            .map_err(|_| "SSH authentication prompt registry is unavailable")?;
        let prompt = pending
            .get(prompt_id)
            .filter(|prompt| prompt.operation_id == operation_id)
            .ok_or("SSH authentication prompt expired")?;
        if answers.as_ref().is_some_and(|answers| {
            answers.len() != prompt.count
                || answers
                    .iter()
                    .any(|value| value.len() > MAX_RESPONSE_BYTES || value.contains('\0'))
        }) {
            return Err("SSH authentication responses are invalid");
        }
        pending
            .remove(prompt_id)
            .ok_or("SSH authentication prompt expired")?
            .response
            .send(answers)
            .map_err(|_| "SSH authentication prompt expired")
    }
}

fn wait_for_response(
    mut receiver: oneshot::Receiver<Option<Answers>>,
    timeout: Duration,
    cancelled: impl Fn() -> bool,
) -> Result<Answers, &'static str> {
    let deadline = Instant::now() + timeout;
    loop {
        if cancelled() {
            return Err(CANCELLED);
        }
        if Instant::now() >= deadline {
            return Err("SSH interactive authentication timed out");
        }
        match receiver.try_recv() {
            Ok(Some(values)) => return Ok(values),
            Ok(None) | Err(oneshot::error::TryRecvError::Closed) => return Err(CANCELLED),
            Err(oneshot::error::TryRecvError::Empty) => {
                std::thread::sleep(Duration::from_millis(25))
            }
        }
    }
}

#[derive(Clone)]
struct PromptScope {
    app: AppHandle,
    operation_id: String,
    cancelled: Arc<dyn Fn() -> bool + Send + Sync>,
}

thread_local! {
    static SCOPE: RefCell<Option<PromptScope>> = const { RefCell::new(None) };
}

pub(crate) fn with_prompt_scope<T>(
    app: AppHandle,
    operation_id: String,
    cancelled: impl Fn() -> bool + Send + Sync + 'static,
    action: impl FnOnce() -> T,
) -> T {
    struct Reset(Option<PromptScope>);
    impl Drop for Reset {
        fn drop(&mut self) {
            SCOPE.with(|scope| scope.replace(self.0.take()));
        }
    }
    let _reset = Reset(SCOPE.with(|scope| {
        scope.replace(Some(PromptScope {
            app,
            operation_id,
            cancelled: Arc::new(cancelled),
        }))
    }));
    action()
}

#[derive(Clone, Serialize)]
struct PromptField {
    text: String,
    echo: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PromptEvent<'a> {
    operation_id: &'a str,
    prompt_id: &'a str,
    host: &'a str,
    username: &'a str,
    instructions: String,
    prompts: Vec<PromptField>,
}

struct PromptExchange<'a> {
    scope: PromptScope,
    host: &'a str,
    username: &'a str,
    rounds: usize,
    failure: Option<&'static str>,
}

impl PromptExchange<'_> {
    fn request(
        &mut self,
        instructions: String,
        prompts: Vec<PromptField>,
    ) -> Result<Answers, &'static str> {
        if let Some(failure) = self.failure {
            return Err(failure);
        }
        if cancelled(&self.scope) {
            return Err(CANCELLED);
        }
        self.rounds += 1;
        if self.rounds > MAX_ROUNDS {
            return Err("SSH sent too many interactive authentication rounds");
        }
        let registry = self.scope.app.state::<InteractiveAuthRegistry>();
        let (prompt_id, receiver) = registry.open(&self.scope.operation_id, prompts.len())?;
        let event = PromptEvent {
            operation_id: &self.scope.operation_id,
            prompt_id: &prompt_id,
            host: self.host,
            username: self.username,
            instructions,
            prompts,
        };
        let result = if self.scope.app.emit(PROMPT_EVENT, event).is_err() {
            Err("SSH authentication prompt could not be displayed")
        } else {
            wait_for_response(receiver, ROUND_TIMEOUT, || cancelled(&self.scope))
        };
        registry.close(&prompt_id);
        let _ = self.scope.app.emit(PROMPT_CLOSED_EVENT, prompt_id);
        result
    }
}

fn cancelled(scope: &PromptScope) -> bool {
    (scope.cancelled)() || super::terminal_deadline::failure_reason().is_some()
}

fn prompt_text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .chars()
        .filter(|character| !character.is_control() || *character == '\n')
        .take(1024)
        .collect()
}

pub(crate) fn authenticate(session: &Session, host: &str, username: &str) -> Result<(), String> {
    let scope = SCOPE
        .with(|scope| scope.borrow().clone())
        .ok_or("keyboard-interactive authentication requires an interactive connection")?;
    let mut exchange = PromptExchange {
        scope,
        host,
        username,
        rounds: 0,
        failure: None,
    };
    let previous_timeout = session.timeout();
    session.set_timeout(CONNECTION_TIMEOUT.as_millis() as u32);
    // The session is locked for the synchronous SDK call. Only the callback
    // borrows the stack exchange, and the SDK owns and frees its response bytes.
    // Keeping this adapter here lets Rust erase the received answer buffers
    // immediately after copying them across that boundary.
    let result = unsafe {
        let mut session = session.raw();
        let abstract_slot = raw::libssh2_session_abstract(&mut *session);
        let previous = abstract_slot.replace((&mut exchange as *mut PromptExchange<'_>).cast());
        let result = raw::libssh2_userauth_keyboard_interactive_ex(
            &mut *session,
            username.as_ptr().cast(),
            username.len() as _,
            Some(answer_prompts),
        );
        abstract_slot.write(previous);
        result
    };
    session.set_timeout(previous_timeout);
    if let Some(failure) = exchange.failure {
        Err(failure.into())
    } else if result != 0 {
        Err("SSH keyboard-interactive authentication failed".into())
    } else {
        Ok(())
    }
}

extern "C" fn answer_prompts(
    _name: *const libc::c_char,
    _name_len: libc::c_int,
    instructions: *const libc::c_char,
    instructions_len: libc::c_int,
    count: libc::c_int,
    prompts: *const raw::LIBSSH2_USERAUTH_KBDINT_PROMPT,
    responses: *mut raw::LIBSSH2_USERAUTH_KBDINT_RESPONSE,
    abstract_slot: *mut *mut libc::c_void,
) {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe {
        let exchange = &mut *(*abstract_slot).cast::<PromptExchange<'_>>();
        if count == 0 {
            return;
        }
        if count < 0 || count as usize > MAX_PROMPTS || prompts.is_null() || responses.is_null() {
            exchange.failure = Some("SSH returned invalid authentication prompts");
            return;
        }
        let instructions = if !instructions.is_null() && instructions_len > 0 {
            prompt_text(std::slice::from_raw_parts(
                instructions.cast(),
                instructions_len as usize,
            ))
        } else {
            String::new()
        };
        let fields = std::slice::from_raw_parts(prompts, count as usize)
            .iter()
            .map(|prompt| PromptField {
                text: if prompt.length > 0 && !prompt.text.is_null() {
                    prompt_text(std::slice::from_raw_parts(
                        prompt.text.cast(),
                        prompt.length,
                    ))
                } else {
                    String::new()
                },
                echo: prompt.echo != 0,
            })
            .collect();
        match exchange.request(instructions, fields) {
            Ok(values) => {
                for (value, response) in values
                    .iter()
                    .zip(std::slice::from_raw_parts_mut(responses, count as usize))
                {
                    let copy = libc::malloc(value.len() + 1).cast::<u8>();
                    if copy.is_null() {
                        exchange.failure = Some("SSH authentication response allocation failed");
                        break;
                    }
                    std::ptr::copy_nonoverlapping(value.as_ptr(), copy, value.len());
                    copy.add(value.len()).write(0);
                    response.text = copy.cast();
                    response.length = value.len() as _;
                }
            }
            Err(failure) => exchange.failure = Some(failure),
        }
    }));
}

#[tauri::command]
pub(crate) fn respond_to_ssh_interactive_auth(
    registry: State<'_, InteractiveAuthRegistry>,
    operation_id: String,
    prompt_id: String,
    answers: Option<Vec<String>>,
) -> Result<(), String> {
    registry
        .respond(&operation_id, &prompt_id, answers.map(Zeroizing::new))
        .map_err(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompts_are_operation_scoped_and_each_round_consumes_one_reply() {
        let registry = InteractiveAuthRegistry::default();
        let operation = Uuid::new_v4().to_string();
        let (first, first_reply) = registry.open(&operation, 1).unwrap();
        assert!(registry
            .respond("different-operation", &first, None)
            .is_err());
        assert!(registry
            .respond(&operation, &first, Some(Zeroizing::new(Vec::new())))
            .is_err());
        registry
            .respond(
                &operation,
                &first,
                Some(Zeroizing::new(vec![Uuid::new_v4().to_string()])),
            )
            .unwrap();
        assert_eq!(
            wait_for_response(first_reply, ROUND_TIMEOUT, || false)
                .unwrap()
                .len(),
            1
        );
        let (second, second_reply) = registry.open(&operation, 2).unwrap();
        assert!(registry.respond(&operation, &first, None).is_err());
        registry.respond(&operation, &second, None).unwrap();
        assert_eq!(
            wait_for_response(second_reply, ROUND_TIMEOUT, || false).unwrap_err(),
            CANCELLED
        );
    }

    #[test]
    fn cancelled_and_expired_rounds_are_closed() {
        let registry = InteractiveAuthRegistry::default();
        let operation = Uuid::new_v4().to_string();
        let (prompt, reply) = registry.open(&operation, 1).unwrap();
        assert_eq!(
            wait_for_response(reply, ROUND_TIMEOUT, || true).unwrap_err(),
            CANCELLED
        );
        registry.close(&prompt);
        assert!(registry.respond(&operation, &prompt, None).is_err());

        let (prompt, reply) = registry.open(&operation, 1).unwrap();
        assert!(wait_for_response(reply, Duration::from_millis(1), || false).is_err());
        registry.close(&prompt);
        assert!(registry.respond(&operation, &prompt, None).is_err());
    }
}
