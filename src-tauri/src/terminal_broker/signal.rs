use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Condvar, LockResult, MutexGuard, WaitTimeoutResult};
use std::time::Duration;

#[derive(Debug)]
pub(super) struct BrokerSignal {
    changed: Condvar,
    waiters: AtomicUsize,
}

struct SignalWaiterGuard<'a>(&'a AtomicUsize);

impl Drop for SignalWaiterGuard<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

impl BrokerSignal {
    pub(super) fn new() -> Self {
        Self {
            changed: Condvar::new(),
            waiters: AtomicUsize::new(0),
        }
    }

    pub(super) fn notify_all(&self) {
        if self.waiters.load(Ordering::Acquire) > 0 {
            self.changed.notify_all();
        }
    }

    pub(super) fn wait_timeout<'a, T>(
        &self,
        guard: MutexGuard<'a, T>,
        dur: Duration,
    ) -> LockResult<(MutexGuard<'a, T>, WaitTimeoutResult)> {
        self.waiters.fetch_add(1, Ordering::AcqRel);
        let _waiter = SignalWaiterGuard(&self.waiters);
        self.changed.wait_timeout(guard, dur)
    }

    pub(super) fn wait_timeout_while<'a, T, F>(
        &self,
        guard: MutexGuard<'a, T>,
        dur: Duration,
        condition: F,
    ) -> LockResult<(MutexGuard<'a, T>, WaitTimeoutResult)>
    where
        F: FnMut(&mut T) -> bool,
    {
        self.waiters.fetch_add(1, Ordering::AcqRel);
        let _waiter = SignalWaiterGuard(&self.waiters);
        self.changed.wait_timeout_while(guard, dur, condition)
    }
}
