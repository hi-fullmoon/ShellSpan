use crate::models::RemoteFsError;
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};

pub(crate) const DIRECTORY_REQUEST_SUPERSEDED_MESSAGE: &str = "remote directory request superseded";
const MAX_DIRECTORY_REQUEST_KEY_BYTES: usize = 256;
const MAX_DIRECTORY_REQUEST_KEYS: usize = 1024;
const DIRECTORY_REQUEST_RETENTION: Duration = Duration::from_secs(30 * 60);

struct DirectoryRequestGeneration {
    request_id: u64,
    superseded: Arc<AtomicBool>,
    last_registered_at: Instant,
}

/// Tracks the newest remote-directory request for each UI pane. Generations are
/// retained for a bounded period after a request finishes so an older command
/// delivered late cannot immediately become current again.
#[derive(Default)]
pub(crate) struct DirectoryRequestRegistry {
    generations: Mutex<HashMap<String, DirectoryRequestGeneration>>,
}

impl DirectoryRequestRegistry {
    pub(crate) fn register(
        &self,
        request_key: &str,
        request_id: u64,
    ) -> Result<Arc<AtomicBool>, String> {
        self.register_at(request_key, request_id, Instant::now())
    }

    fn register_at(
        &self,
        request_key: &str,
        request_id: u64,
        now: Instant,
    ) -> Result<Arc<AtomicBool>, String> {
        if request_key.is_empty() || request_key.len() > MAX_DIRECTORY_REQUEST_KEY_BYTES {
            return Err("invalid remote directory request key".to_string());
        }
        if request_id == 0 {
            return Err("invalid remote directory request id".to_string());
        }
        let mut generations = self
            .generations
            .lock()
            .map_err(|_| "remote directory request registry poisoned".to_string())?;

        match generations.get_mut(request_key) {
            Some(current) if request_id < current.request_id => Ok(Arc::new(AtomicBool::new(true))),
            Some(current) if request_id == current.request_id => {
                current.last_registered_at = now;
                Ok(current.superseded.clone())
            }
            Some(current) => {
                current.superseded.store(true, Ordering::SeqCst);
                let superseded = Arc::new(AtomicBool::new(false));
                *current = DirectoryRequestGeneration {
                    request_id,
                    superseded: superseded.clone(),
                    last_registered_at: now,
                };
                Ok(superseded)
            }
            None => {
                Self::reclaim_expired(&mut generations, now);
                if generations.len() >= MAX_DIRECTORY_REQUEST_KEYS {
                    return Err("remote directory request registry is full".to_string());
                }
                let superseded = Arc::new(AtomicBool::new(false));
                generations.insert(
                    request_key.to_string(),
                    DirectoryRequestGeneration {
                        request_id,
                        superseded: superseded.clone(),
                        last_registered_at: now,
                    },
                );
                Ok(superseded)
            }
        }
    }

    fn reclaim_expired(
        generations: &mut HashMap<String, DirectoryRequestGeneration>,
        now: Instant,
    ) {
        generations.retain(|_, generation| {
            let expired = now.saturating_duration_since(generation.last_registered_at)
                >= DIRECTORY_REQUEST_RETENTION;
            let active = Arc::strong_count(&generation.superseded) > 1;
            !expired || active
        });
    }
}

pub(crate) fn ensure_directory_request_current(
    superseded: &AtomicBool,
) -> Result<(), RemoteFsError> {
    if superseded.load(Ordering::SeqCst) {
        Err(RemoteFsError::Other {
            message: DIRECTORY_REQUEST_SUPERSEDED_MESSAGE.to_string(),
        })
    } else {
        Ok(())
    }
}

/// Checks both before waiting for a shared connection and immediately after
/// acquiring it. A request superseded while queued therefore releases the
/// mutex without executing any SFTP or SSH operation.
pub(crate) fn with_connection_lock_if_current<T, R, F>(
    connection: &Mutex<T>,
    superseded: &AtomicBool,
    operation: F,
) -> Result<R, RemoteFsError>
where
    F: FnOnce(&T) -> Result<R, RemoteFsError>,
{
    ensure_directory_request_current(superseded)?;
    let connected = connection
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    ensure_directory_request_current(superseded)?;
    operation(&connected)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::sync::mpsc;
    use std::thread;

    #[test]
    fn newer_generation_cancels_previous_and_late_older_is_pre_cancelled() {
        let registry = DirectoryRequestRegistry::default();
        let first = registry.register("tab-1:remote", 1).unwrap();
        let second = registry.register("tab-1:remote", 2).unwrap();

        assert!(first.load(Ordering::SeqCst));
        assert!(!second.load(Ordering::SeqCst));

        let late_first = registry.register("tab-1:remote", 1).unwrap();
        assert!(late_first.load(Ordering::SeqCst));
        assert!(!second.load(Ordering::SeqCst));
    }

    #[test]
    fn same_generation_shares_the_cancellation_flag() {
        let registry = DirectoryRequestRegistry::default();
        let listing = registry.register("tab-1:remote", 7).unwrap();
        let owners = registry.register("tab-1:remote", 7).unwrap();

        assert!(Arc::ptr_eq(&listing, &owners));
        registry.register("tab-1:remote", 8).unwrap();
        assert!(listing.load(Ordering::SeqCst));
        assert!(owners.load(Ordering::SeqCst));
    }

    #[test]
    fn invalid_request_identity_is_rejected_without_growing_the_registry() {
        let registry = DirectoryRequestRegistry::default();

        assert_eq!(
            registry.register("", 1).unwrap_err(),
            "invalid remote directory request key"
        );
        assert_eq!(
            registry.register("tab-1:remote", 0).unwrap_err(),
            "invalid remote directory request id"
        );
        assert!(registry.generations.lock().unwrap().is_empty());
    }

    #[test]
    fn expired_inactive_generations_are_reclaimed_when_capacity_is_reached() {
        let registry = DirectoryRequestRegistry::default();
        let started_at = Instant::now();
        for index in 0..MAX_DIRECTORY_REQUEST_KEYS {
            drop(
                registry
                    .register_at(&format!("pane-{index}"), 1, started_at)
                    .unwrap(),
            );
        }

        let fresh = registry
            .register_at(
                "fresh-pane",
                1,
                started_at + DIRECTORY_REQUEST_RETENTION + Duration::from_millis(1),
            )
            .expect("expired inactive watermarks should free capacity");

        let generations = registry.generations.lock().unwrap();
        assert_eq!(generations.len(), 1);
        assert!(generations.contains_key("fresh-pane"));
        assert!(!fresh.load(Ordering::SeqCst));
    }

    #[test]
    fn recent_generations_are_not_reclaimed_for_capacity() {
        let registry = DirectoryRequestRegistry::default();
        let started_at = Instant::now();
        for index in 0..MAX_DIRECTORY_REQUEST_KEYS {
            drop(
                registry
                    .register_at(&format!("pane-{index}"), 1, started_at)
                    .unwrap(),
            );
        }

        let result = registry.register_at(
            "too-soon",
            1,
            started_at + DIRECTORY_REQUEST_RETENTION - Duration::from_millis(1),
        );

        assert_eq!(
            result.unwrap_err(),
            "remote directory request registry is full"
        );
        assert_eq!(
            registry.generations.lock().unwrap().len(),
            MAX_DIRECTORY_REQUEST_KEYS
        );
    }

    #[test]
    fn expired_but_active_generation_is_never_reclaimed() {
        let registry = DirectoryRequestRegistry::default();
        let started_at = Instant::now();
        let active = registry.register_at("active-pane", 1, started_at).unwrap();
        for index in 1..MAX_DIRECTORY_REQUEST_KEYS {
            drop(
                registry
                    .register_at(&format!("pane-{index}"), 1, started_at)
                    .unwrap(),
            );
        }

        let fresh = registry
            .register_at(
                "fresh-pane",
                1,
                started_at + DIRECTORY_REQUEST_RETENTION + Duration::from_millis(1),
            )
            .expect("inactive generations should make room around an active one");

        let generations = registry.generations.lock().unwrap();
        assert_eq!(generations.len(), 2);
        assert!(generations.contains_key("active-pane"));
        assert!(generations.contains_key("fresh-pane"));
        assert!(!active.load(Ordering::SeqCst));
        assert!(!fresh.load(Ordering::SeqCst));
    }

    #[test]
    fn registering_the_current_generation_refreshes_its_retention_time() {
        let registry = DirectoryRequestRegistry::default();
        let started_at = Instant::now();
        let first = registry.register_at("active-pane", 4, started_at).unwrap();
        let refreshed_at = started_at + Duration::from_secs(60);
        let refreshed = registry
            .register_at("active-pane", 4, refreshed_at)
            .unwrap();

        assert!(Arc::ptr_eq(&first, &refreshed));
        assert_eq!(
            registry
                .generations
                .lock()
                .unwrap()
                .get("active-pane")
                .unwrap()
                .last_registered_at,
            refreshed_at
        );
    }

    #[test]
    fn superseded_waiter_skips_network_closure_after_mutex_becomes_available() {
        let registry = DirectoryRequestRegistry::default();
        let old_flag = registry.register("tab-1:remote", 1).unwrap();
        let connection = Arc::new(Mutex::new(()));
        let held_connection = connection.lock().unwrap();
        let network_calls = Arc::new(AtomicUsize::new(0));
        let (waiting_tx, waiting_rx) = mpsc::channel();

        let worker_connection = connection.clone();
        let worker_calls = network_calls.clone();
        let worker = thread::spawn(move || {
            waiting_tx.send(()).unwrap();
            with_connection_lock_if_current(&worker_connection, &old_flag, |_| {
                worker_calls.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
        });

        waiting_rx.recv().unwrap();
        // Give the worker a chance to enter Mutex::lock while the guard above
        // keeps the connection unavailable.
        thread::sleep(Duration::from_millis(10));
        registry.register("tab-1:remote", 2).unwrap();
        drop(held_connection);

        assert_eq!(
            worker.join().unwrap(),
            Err(RemoteFsError::Other {
                message: DIRECTORY_REQUEST_SUPERSEDED_MESSAGE.to_string(),
            })
        );
        assert_eq!(network_calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn current_request_preserves_operation_error() {
        let connection = Mutex::new(());
        let current = AtomicBool::new(false);
        let expected = RemoteFsError::Other {
            message: "permission denied".to_string(),
        };

        let result = with_connection_lock_if_current(&connection, &current, |_| {
            Err::<(), _>(expected.clone())
        });

        assert_eq!(result, Err(expected));
    }
}
