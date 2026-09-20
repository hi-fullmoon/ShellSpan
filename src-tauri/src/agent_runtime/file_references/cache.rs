//! Cache complete directory enumerations, before prefix filtering and result truncation.
use super::*;
use std::sync::{OnceLock, TryLockError};

const TTL: Duration = Duration::from_secs(15);
const CAPACITY: usize = 64;
const MAX_DIRECTORY_BYTES: usize = 256 * 1024;

struct Snapshot {
    created: Instant,
    entries: Vec<ScopedEntry>,
}

#[derive(Default)]
struct DirectoryCache {
    // Each slot serializes only reads of the same directory. In-flight slots cannot be evicted.
    slots: Mutex<HashMap<String, Arc<Mutex<Option<Snapshot>>>>>,
}

impl DirectoryCache {
    fn list(
        &self,
        key: String,
        reader: &dyn ScopedReader,
        directory: &str,
        control: &ReadControl,
        ttl: Duration,
    ) -> Result<Vec<ScopedEntry>, ScopeReadError> {
        control.check()?;
        let slot = {
            let mut slots = self.slots.lock().map_err(|_| ScopeReadError::Unavailable)?;
            if !slots.contains_key(&key) && slots.len() >= CAPACITY {
                let oldest = slots
                    .iter()
                    .filter(|(_, slot)| Arc::strong_count(slot) == 1)
                    .filter_map(|(key, slot)| {
                        let snapshot = slot.try_lock().ok()?;
                        Some((key.clone(), snapshot.as_ref().map(|s| s.created)))
                    })
                    .min_by_key(|(_, created)| *created);
                if let Some((key, _)) = oldest {
                    slots.remove(&key);
                } else {
                    return Err(ScopeReadError::Limit);
                }
            }
            slots.entry(key).or_default().clone()
        };
        let mut snapshot = loop {
            control.check()?;
            match slot.try_lock() {
                Ok(guard) => break guard,
                Err(TryLockError::Poisoned(_)) => return Err(ScopeReadError::Unavailable),
                Err(TryLockError::WouldBlock) => {
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
        };
        if let Some(cached) = snapshot.as_ref().filter(|s| s.created.elapsed() < ttl) {
            return Ok(cached.entries.clone());
        }
        // Failed, cancelled and over-budget enumerations never become cache entries.
        *snapshot = None;
        let entries = reader.list_paths(directory, MAX_ENTRIES, control)?;
        reader.check_root()?;
        control.check()?;
        if entries.iter().map(|entry| entry.name.len()).sum::<usize>() <= MAX_DIRECTORY_BYTES {
            *snapshot = Some(Snapshot {
                created: Instant::now(),
                entries: entries.clone(),
            });
        }
        Ok(entries)
    }
}

pub(super) fn remote_entries(
    reader: &dyn ScopedReader,
    scope: &SkillScope,
    directory: &str,
    control: &ReadControl,
) -> Result<Vec<ScopedEntry>, ScopeReadError> {
    static CACHE: OnceLock<DirectoryCache> = OnceLock::new();
    // Include the entire frozen target, root identity and directory; identical paths on
    // different hosts, profiles, sessions or roots must never share suggestions.
    let key =
        serde_json::to_string(&(scope, directory)).map_err(|_| ScopeReadError::Unavailable)?;
    CACHE
        .get_or_init(DirectoryCache::default)
        .list(key, reader, directory, control, TTL)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_directory_cache_reuses_complete_listing_expires_and_isolates_keys() {
        let project = tempfile::tempdir().unwrap();
        for index in 0..60 {
            std::fs::write(project.path().join(format!("file-{index:02}")), "content").unwrap();
        }
        let root = project.path().canonicalize().unwrap();
        let reader = LocalScopedReader::open(root.to_str().unwrap()).unwrap();
        let control = ReadControl {
            cancellation: CancellationToken::new(),
            deadline: Instant::now() + TIMEOUT,
        };
        let cache = DirectoryCache::default();
        let read = |key: &str, ttl| cache.list(key.into(), &reader, "", &control, ttl).unwrap();
        assert_eq!(read("first-scope", TTL).len(), 60);
        std::fs::write(project.path().join("new-file"), "content").unwrap();
        assert_eq!(read("first-scope", TTL).len(), 60);
        assert_eq!(read("second-scope", TTL).len(), 61);
        assert_eq!(read("first-scope", Duration::ZERO).len(), 61);
        control.cancellation.cancel();
        assert_eq!(
            cache.list("first-scope".into(), &reader, "", &control, TTL),
            Err(ScopeReadError::Cancelled)
        );
    }

    #[test]
    fn remote_directory_cache_does_not_cache_errors_and_remains_bounded() {
        let project = tempfile::tempdir().unwrap();
        let root = project.path().canonicalize().unwrap();
        let reader = LocalScopedReader::open(root.to_str().unwrap()).unwrap();
        let control = ReadControl {
            cancellation: CancellationToken::new(),
            deadline: Instant::now() + TIMEOUT,
        };
        let cache = DirectoryCache::default();
        assert!(cache
            .list("child".into(), &reader, "child", &control, TTL)
            .is_err());
        std::fs::create_dir(project.path().join("child")).unwrap();
        assert!(cache
            .list("child".into(), &reader, "child", &control, TTL)
            .unwrap()
            .is_empty());
        for index in 0..CAPACITY + 1 {
            cache
                .list(index.to_string(), &reader, "", &control, TTL)
                .unwrap();
        }
        assert_eq!(cache.slots.lock().unwrap().len(), CAPACITY);
    }

    #[test]
    fn remote_directory_cache_wait_is_bounded_and_other_directories_are_independent() {
        let project = tempfile::tempdir().unwrap();
        let root = project.path().canonicalize().unwrap();
        let reader = LocalScopedReader::open(root.to_str().unwrap()).unwrap();
        let control = ReadControl {
            cancellation: CancellationToken::new(),
            deadline: Instant::now() + TIMEOUT,
        };
        let cache = DirectoryCache::default();
        cache
            .list("busy".into(), &reader, "", &control, TTL)
            .unwrap();
        let slot = cache.slots.lock().unwrap()["busy"].clone();
        let _held = slot.lock().unwrap();
        assert!(cache
            .list("other".into(), &reader, "", &control, TTL)
            .is_ok());
        let waiting = ReadControl {
            cancellation: CancellationToken::new(),
            deadline: Instant::now() + Duration::from_millis(20),
        };
        assert_eq!(
            cache.list("busy".into(), &reader, "", &waiting, TTL),
            Err(ScopeReadError::Limit)
        );
    }
}
