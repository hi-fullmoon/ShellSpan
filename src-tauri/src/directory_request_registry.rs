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
    include!("tests/directory_request_registry.rs");
}
