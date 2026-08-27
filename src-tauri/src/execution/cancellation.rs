use super::request::MAX_OPERATION_ID_BYTES;
use std::collections::HashMap;
use std::fmt;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex, Weak};

const TERMINAL_RUNNING: u8 = 0;
const TERMINAL_CANCELLED: u8 = 1;
const TERMINAL_TIMED_OUT: u8 = 2;
const TERMINAL_FINISHED: u8 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ExecutionTerminalState {
    Running,
    Cancelled,
    TimedOut,
    Finished,
}

impl ExecutionTerminalState {
    fn from_raw(value: u8) -> Self {
        match value {
            TERMINAL_CANCELLED => Self::Cancelled,
            TERMINAL_TIMED_OUT => Self::TimedOut,
            TERMINAL_FINISHED => Self::Finished,
            _ => Self::Running,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ExecutionCancellationErrorKind {
    InvalidOperationId,
    DuplicateOperationId,
    OperationNotFound,
    RegistryPoisoned,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ExecutionCancellationError {
    pub(crate) kind: ExecutionCancellationErrorKind,
}

impl ExecutionCancellationError {
    fn new(kind: ExecutionCancellationErrorKind) -> Self {
        Self { kind }
    }
}

impl fmt::Display for ExecutionCancellationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self.kind {
            ExecutionCancellationErrorKind::InvalidOperationId => {
                "reviewed execution operation ID is invalid"
            }
            ExecutionCancellationErrorKind::DuplicateOperationId => {
                "reviewed execution operation ID is already registered"
            }
            ExecutionCancellationErrorKind::OperationNotFound => {
                "reviewed execution operation was not found"
            }
            ExecutionCancellationErrorKind::RegistryPoisoned => {
                "reviewed execution cancellation registry is unavailable"
            }
        };
        formatter.write_str(message)
    }
}

struct CancellationEntry {
    terminal: AtomicU8,
}

impl CancellationEntry {
    fn new() -> Self {
        Self {
            terminal: AtomicU8::new(TERMINAL_RUNNING),
        }
    }

    fn state(&self) -> ExecutionTerminalState {
        ExecutionTerminalState::from_raw(self.terminal.load(Ordering::SeqCst))
    }

    fn claim(&self, terminal: u8) -> bool {
        self.terminal
            .compare_exchange(
                TERMINAL_RUNNING,
                terminal,
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .is_ok()
    }
}

#[derive(Default)]
struct CancellationRegistryInner {
    operations: Mutex<HashMap<String, Arc<CancellationEntry>>>,
}

/// Shared operation-level cancellation boundary for reviewed execution.
///
/// Registration is unique. The first cancel, timeout, or finished transition
/// wins, so a late worker result cannot replace an observed cancellation.
#[derive(Clone, Default)]
pub(crate) struct ExecutionCancellationRegistry {
    inner: Arc<CancellationRegistryInner>,
}

impl ExecutionCancellationRegistry {
    pub(crate) fn register(
        &self,
        operation_id: impl Into<String>,
    ) -> Result<CancellationHandle, ExecutionCancellationError> {
        let operation_id = operation_id.into();
        if !valid_operation_id(&operation_id) {
            return Err(ExecutionCancellationError::new(
                ExecutionCancellationErrorKind::InvalidOperationId,
            ));
        }
        let entry = Arc::new(CancellationEntry::new());
        let mut operations = self.inner.operations.lock().map_err(|_| {
            ExecutionCancellationError::new(ExecutionCancellationErrorKind::RegistryPoisoned)
        })?;
        if operations.contains_key(&operation_id) {
            return Err(ExecutionCancellationError::new(
                ExecutionCancellationErrorKind::DuplicateOperationId,
            ));
        }
        operations.insert(operation_id.clone(), Arc::clone(&entry));
        Ok(CancellationHandle {
            inner: Arc::new(CancellationHandleInner {
                operation_id,
                entry,
                registry: Arc::downgrade(&self.inner),
            }),
        })
    }

    pub(crate) fn cancel(&self, operation_id: &str) -> Result<(), ExecutionCancellationError> {
        let operations = self.inner.operations.lock().map_err(|_| {
            ExecutionCancellationError::new(ExecutionCancellationErrorKind::RegistryPoisoned)
        })?;
        let entry = operations.get(operation_id).ok_or_else(|| {
            ExecutionCancellationError::new(ExecutionCancellationErrorKind::OperationNotFound)
        })?;
        entry.claim(TERMINAL_CANCELLED);
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn remove(&self, operation_id: &str) -> Result<(), ExecutionCancellationError> {
        let mut operations = self.inner.operations.lock().map_err(|_| {
            ExecutionCancellationError::new(ExecutionCancellationErrorKind::RegistryPoisoned)
        })?;
        operations.remove(operation_id);
        Ok(())
    }
}

struct CancellationHandleInner {
    operation_id: String,
    entry: Arc<CancellationEntry>,
    registry: Weak<CancellationRegistryInner>,
}

impl CancellationHandleInner {
    fn remove_registration(&self) {
        let Some(registry) = self.registry.upgrade() else {
            return;
        };
        let Ok(mut operations) = registry.operations.lock() else {
            return;
        };
        if operations
            .get(&self.operation_id)
            .is_some_and(|registered| Arc::ptr_eq(registered, &self.entry))
        {
            operations.remove(&self.operation_id);
        }
    }
}

impl Drop for CancellationHandleInner {
    fn drop(&mut self) {
        self.remove_registration();
    }
}

#[derive(Clone)]
pub(crate) struct CancellationHandle {
    inner: Arc<CancellationHandleInner>,
}

impl fmt::Debug for CancellationHandle {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CancellationHandle")
            .field("operation_id", &self.inner.operation_id)
            .field("terminal_state", &self.terminal_state())
            .finish()
    }
}

impl CancellationHandle {
    pub(crate) fn terminal_state(&self) -> ExecutionTerminalState {
        self.inner.entry.state()
    }

    #[cfg(test)]
    pub(crate) fn is_cancelled(&self) -> bool {
        self.terminal_state() == ExecutionTerminalState::Cancelled
    }

    pub(crate) fn try_timeout(&self) -> bool {
        self.inner.entry.claim(TERMINAL_TIMED_OUT)
    }

    pub(crate) fn try_finish(&self) -> bool {
        self.inner.entry.claim(TERMINAL_FINISHED)
    }

    pub(crate) fn remove_registration(&self) {
        self.inner.remove_registration();
    }
}

pub(crate) fn valid_operation_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_OPERATION_ID_BYTES
        && value.is_ascii()
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | ':' | '-')
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registration_is_unique_and_duplicate_never_replaces_the_original() {
        let registry = ExecutionCancellationRegistry::default();
        let original = registry.register("execution:unique").unwrap();
        let duplicate = registry
            .register("execution:unique")
            .expect_err("duplicate registration must fail closed");
        assert_eq!(
            duplicate.kind,
            ExecutionCancellationErrorKind::DuplicateOperationId
        );

        registry.cancel("execution:unique").unwrap();
        assert!(original.is_cancelled());
    }

    #[test]
    fn first_terminal_state_wins_over_timeout_cancel_and_late_result() {
        let registry = ExecutionCancellationRegistry::default();
        let timed_out = registry.register("execution:timeout-wins").unwrap();
        assert!(timed_out.try_timeout());
        registry.cancel("execution:timeout-wins").unwrap();
        assert!(!timed_out.try_finish());
        assert_eq!(timed_out.terminal_state(), ExecutionTerminalState::TimedOut);

        let cancelled = registry.register("execution:cancel-wins").unwrap();
        registry.cancel("execution:cancel-wins").unwrap();
        assert!(!cancelled.try_timeout());
        assert!(!cancelled.try_finish());
        assert_eq!(
            cancelled.terminal_state(),
            ExecutionTerminalState::Cancelled
        );
    }

    #[test]
    fn remove_and_last_handle_drop_cleanup_allow_safe_id_reuse() {
        let registry = ExecutionCancellationRegistry::default();
        let old = registry.register("execution:reuse").unwrap();
        registry.remove("execution:reuse").unwrap();
        let replacement = registry.register("execution:reuse").unwrap();

        drop(old);
        registry.cancel("execution:reuse").unwrap();
        assert!(replacement.is_cancelled());

        let dropped = registry.register("execution:drop-cleanup").unwrap();
        let dropped_clone = dropped.clone();
        drop(dropped);
        assert!(registry.cancel("execution:drop-cleanup").is_ok());
        drop(dropped_clone);
        assert_eq!(
            registry
                .cancel("execution:drop-cleanup")
                .expect_err("last handle drop removes the registration")
                .kind,
            ExecutionCancellationErrorKind::OperationNotFound
        );
    }

    #[test]
    fn invalid_operation_ids_never_enter_the_registry() {
        let registry = ExecutionCancellationRegistry::default();
        for invalid in ["", "contains spaces", "contains/slash"] {
            assert_eq!(
                registry
                    .register(invalid)
                    .expect_err("invalid operation ID")
                    .kind,
                ExecutionCancellationErrorKind::InvalidOperationId
            );
        }
    }
}
