use crate::remote_fs::RemoteIdentityKind;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Default, Clone)]
pub(crate) struct RemoteIdentityCache {
    #[allow(clippy::type_complexity)]
    entries: Arc<Mutex<HashMap<(String, u32, RemoteIdentityKind), String>>>,
}

impl RemoteIdentityCache {
    pub(crate) fn insert(
        &self,
        host: &str,
        id: u32,
        kind: RemoteIdentityKind,
        name: String,
    ) {
        self.entries
            .lock()
            .unwrap()
            .insert((host.to_string(), id, kind), name);
    }

    pub(crate) fn resolve_names(
        &self,
        host: &str,
        ids: &[u32],
        kind: RemoteIdentityKind,
    ) -> (HashMap<u32, String>, Vec<u32>) {
        let entries = self.entries.lock().unwrap();
        let mut found = HashMap::new();
        let mut missing = Vec::new();
        for id in ids {
            if let Some(name) = entries.get(&(host.to_string(), *id, kind)) {
                found.insert(*id, name.clone());
            } else {
                missing.push(*id);
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
        cache.insert("host1", 1000, RemoteIdentityKind::User, "alice".to_string());

        let (found, missing) = cache.resolve_names("host1", &[1000], RemoteIdentityKind::User);

        assert_eq!(found.get(&1000), Some(&"alice".to_string()));
        assert!(missing.is_empty());
    }

    #[test]
    fn cache_reports_missing_ids() {
        let cache = RemoteIdentityCache::default();

        let (found, missing) = cache.resolve_names("host1", &[1000], RemoteIdentityKind::User);

        assert!(found.is_empty());
        assert_eq!(missing, vec![1000]);
    }

    #[test]
    fn cache_isolated_by_host_and_kind() {
        let cache = RemoteIdentityCache::default();
        cache.insert("host1", 1000, RemoteIdentityKind::User, "alice".to_string());

        let (found, _) = cache.resolve_names("host2", &[1000], RemoteIdentityKind::User);
        let (found_group, _) = cache.resolve_names("host1", &[1000], RemoteIdentityKind::Group);

        assert!(found.is_empty());
        assert!(found_group.is_empty());
    }
}
