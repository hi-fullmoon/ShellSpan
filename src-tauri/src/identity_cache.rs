use crate::remote_fs::RemoteIdentityKind;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

// Ids that could not be resolved (missing getent/python on the server, or an
// id with no name) are cached as unresolved for this long. Without this the
// lookup exec would re-run on every single directory listing.
const UNRESOLVED_TTL: Duration = Duration::from_secs(300);

#[derive(Clone)]
enum CachedIdentity {
    Resolved(String),
    Unresolved(Instant),
}

#[derive(Default, Clone)]
pub(crate) struct RemoteIdentityCache {
    #[allow(clippy::type_complexity)]
    entries: Arc<Mutex<HashMap<(String, u32, RemoteIdentityKind), CachedIdentity>>>,
}

impl RemoteIdentityCache {
    pub(crate) fn insert(&self, scope: &str, id: u32, kind: RemoteIdentityKind, name: String) {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(
                (scope.to_string(), id, kind),
                CachedIdentity::Resolved(name),
            );
    }

    pub(crate) fn insert_unresolved(&self, scope: &str, id: u32, kind: RemoteIdentityKind) {
        self.insert_unresolved_at(scope, id, kind, Instant::now());
    }

    fn insert_unresolved_at(&self, scope: &str, id: u32, kind: RemoteIdentityKind, at: Instant) {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(
                (scope.to_string(), id, kind),
                CachedIdentity::Unresolved(at),
            );
    }

    /// Returns the names found in the cache plus the ids that still need a
    /// remote lookup. Ids cached as unresolved (within the TTL) appear in
    /// neither: they are treated as known to have no name.
    pub(crate) fn resolve_names(
        &self,
        scope: &str,
        ids: &[u32],
        kind: RemoteIdentityKind,
    ) -> (HashMap<u32, String>, Vec<u32>) {
        let entries = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut found = HashMap::new();
        let mut missing = Vec::new();
        for id in ids {
            match entries.get(&(scope.to_string(), *id, kind)) {
                Some(CachedIdentity::Resolved(name)) => {
                    found.insert(*id, name.clone());
                }
                Some(CachedIdentity::Unresolved(at)) if at.elapsed() < UNRESOLVED_TTL => {}
                _ => missing.push(*id),
            }
        }
        (found, missing)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_returns_cached_user_name() {
        let cache = RemoteIdentityCache::default();
        cache.insert(
            "host1:22:alice",
            1000,
            RemoteIdentityKind::User,
            "alice".to_string(),
        );

        let (found, missing) =
            cache.resolve_names("host1:22:alice", &[1000], RemoteIdentityKind::User);

        assert_eq!(found.get(&1000), Some(&"alice".to_string()));
        assert!(missing.is_empty());
    }

    #[test]
    fn cache_reports_missing_ids() {
        let cache = RemoteIdentityCache::default();

        let (found, missing) =
            cache.resolve_names("host1:22:alice", &[1000], RemoteIdentityKind::User);

        assert!(found.is_empty());
        assert_eq!(missing, vec![1000]);
    }

    #[test]
    fn cache_isolated_by_scope_and_kind() {
        let cache = RemoteIdentityCache::default();
        cache.insert(
            "host1:22:alice",
            1000,
            RemoteIdentityKind::User,
            "alice".to_string(),
        );

        let (found_other_host, _) =
            cache.resolve_names("host2:22:alice", &[1000], RemoteIdentityKind::User);
        let (found_other_user, _) =
            cache.resolve_names("host1:22:bob", &[1000], RemoteIdentityKind::User);
        let (found_group, _) =
            cache.resolve_names("host1:22:alice", &[1000], RemoteIdentityKind::Group);

        assert!(found_other_host.is_empty());
        assert!(found_other_user.is_empty());
        assert!(found_group.is_empty());
    }

    #[test]
    fn unresolved_ids_are_not_looked_up_again() {
        let cache = RemoteIdentityCache::default();
        cache.insert_unresolved("host1:22:alice", 1000, RemoteIdentityKind::User);

        let (found, missing) =
            cache.resolve_names("host1:22:alice", &[1000], RemoteIdentityKind::User);

        assert!(found.is_empty());
        assert!(missing.is_empty());
    }

    #[test]
    fn unresolved_entries_expire_after_ttl() {
        let cache = RemoteIdentityCache::default();
        cache.insert_unresolved_at(
            "host1:22:alice",
            1000,
            RemoteIdentityKind::User,
            Instant::now() - UNRESOLVED_TTL - Duration::from_secs(1),
        );

        let (found, missing) =
            cache.resolve_names("host1:22:alice", &[1000], RemoteIdentityKind::User);

        assert!(found.is_empty());
        assert_eq!(missing, vec![1000]);
    }

    #[test]
    fn resolved_insert_overwrites_unresolved_entry() {
        let cache = RemoteIdentityCache::default();
        cache.insert_unresolved("host1:22:alice", 1000, RemoteIdentityKind::User);
        cache.insert(
            "host1:22:alice",
            1000,
            RemoteIdentityKind::User,
            "alice".to_string(),
        );

        let (found, missing) =
            cache.resolve_names("host1:22:alice", &[1000], RemoteIdentityKind::User);

        assert_eq!(found.get(&1000), Some(&"alice".to_string()));
        assert!(missing.is_empty());
    }
}
