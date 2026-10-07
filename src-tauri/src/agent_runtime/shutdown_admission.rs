//! One-way production admission barrier. Closing never reopens after cleanup failure.
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Condvar, Mutex,
};
use std::time::{Duration, Instant};

#[derive(Clone, Default)]
pub(crate) struct ShutdownAdmission(Arc<State>);
#[derive(Default)]
struct State {
    cancellation: tokio_util::sync::CancellationToken,
    closed: AtomicBool,
    active: Mutex<usize>,
    changed: Condvar,
}
pub(crate) struct AdmissionLease(ShutdownAdmission);
impl Drop for AdmissionLease {
    fn drop(&mut self) {
        if let Ok(mut active) = self.0 .0.active.lock() {
            *active = active.saturating_sub(1);
            self.0 .0.changed.notify_all();
        }
    }
}
impl ShutdownAdmission {
    pub(crate) fn close(&self) -> bool {
        let changed = !self.0.closed.swap(true, Ordering::AcqRel);
        self.0.cancellation.cancel();
        changed
    }
    pub(crate) fn cancellation(&self) -> tokio_util::sync::CancellationToken {
        self.0.cancellation.child_token()
    }
    pub(crate) fn ensure_open(&self) -> Result<(), String> {
        if self.0.closed.load(Ordering::Acquire) {
            Err("agentRuntimeShuttingDown: new dispatch is disabled".into())
        } else {
            Ok(())
        }
    }
    pub(crate) fn enter(&self) -> Result<AdmissionLease, String> {
        let mut active = self
            .0
            .active
            .lock()
            .map_err(|_| "Shutdown admission unavailable")?;
        self.ensure_open()?;
        *active = active
            .checked_add(1)
            .ok_or("Shutdown admission capacity exceeded")?;
        Ok(AdmissionLease(self.clone()))
    }
    pub(crate) fn await_drained(&self, timeout: Duration) -> Result<(), String> {
        let deadline = Instant::now() + timeout;
        let mut active = self
            .0
            .active
            .lock()
            .map_err(|_| "Shutdown admission unavailable")?;
        while *active > 0 {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("Shutdown dispatch remains unconfirmed".into());
            }
            active = self
                .0
                .changed
                .wait_timeout(active, remaining)
                .map_err(|_| "Shutdown admission unavailable")?
                .0;
        }
        Ok(())
    }
}

pub(crate) struct ShutdownOutcome {
    started: AtomicBool,
    result: tokio::sync::watch::Sender<Option<Result<usize, String>>>,
}
impl Default for ShutdownOutcome {
    fn default() -> Self {
        Self {
            started: AtomicBool::new(false),
            result: tokio::sync::watch::channel(None).0,
        }
    }
}
impl ShutdownOutcome {
    pub(crate) fn begin(&self) -> bool {
        !self.started.swap(true, Ordering::AcqRel)
    }
    pub(crate) fn finish(&self, result: Result<usize, String>) {
        self.result.send_replace(Some(result));
    }
    pub(crate) async fn wait(&self) -> Result<usize, String> {
        let mut receiver = self.result.subscribe();
        loop {
            if let Some(result) = receiver.borrow_and_update().clone() {
                return result;
            }
            receiver
                .changed()
                .await
                .map_err(|_| "Shutdown outcome unavailable")?;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn production_admission_closes_once_and_waits_for_existing_lease() {
        let admission = ShutdownAdmission::default();
        let lease = admission.enter().unwrap();
        assert!(admission.close());
        assert!(!admission.close());
        assert!(admission.enter().is_err());
        assert!(admission.await_drained(Duration::from_millis(10)).is_err());
        drop(lease);
        admission.await_drained(Duration::from_secs(1)).unwrap();
        assert!(admission.ensure_open().is_err());
    }
}
