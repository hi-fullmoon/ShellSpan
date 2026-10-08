//! Requests are metadata only; the native capability issuer creates live grants.
use super::{
    AgentSandboxContract, AgentSandboxPolicy, AgentSandboxResource, AgentSandboxResourceGrant,
};

pub(crate) fn network_requests(
    contract: &AgentSandboxContract,
    targets: &[super::NetworkTargetRequestNative],
) -> Result<Vec<super::NetworkTargetRequestNative>, String> {
    if targets.len() > 8
        || contract.policy == AgentSandboxPolicy::Host
        || contract.target.kind != "local"
    {
        return Err(
            "sandboxResourceRequestInvalid: at most eight restricted local network targets".into(),
        );
    }
    let mut normalized = Vec::new();
    for target in targets {
        if target.host.is_empty()
            || target.host.len() > 253
            || target
                .host
                .chars()
                .any(|value| value.is_control() || value.is_whitespace())
            || target.port == 0
        {
            return Err("sandboxResourceRequestInvalid: invalid network target".into());
        }
        let url::Host::Domain(host) = url::Host::parse(&target.host)
            .map_err(|_| "sandboxResourceRequestInvalid: public hostname required")?
        else {
            return Err("sandboxResourceRequestInvalid: public hostname required".into());
        };
        let host = host.to_ascii_lowercase();
        if host == "localhost"
            || host.ends_with(".localhost")
            || host.contains('*')
            || host.ends_with('.')
        {
            return Err("sandboxResourceRequestInvalid: exact public hostname required".into());
        }
        let target = super::NetworkTargetRequestNative {
            host,
            port: target.port,
            resolver: target.resolver,
        };
        if normalized
            .iter()
            .any(|existing: &super::NetworkTargetRequestNative| {
                existing.host == target.host
                    && existing.port == target.port
                    && existing.resolver != target.resolver
            })
        {
            return Err("sandboxResourceRequestInvalid: conflicting DNS choices".into());
        }
        if !normalized.contains(&target) {
            normalized.push(target);
        }
    }
    Ok(normalized)
}

pub(crate) fn issue_network_targets(
    mut contract: AgentSandboxContract,
    targets: &[super::NetworkTargetRequestNative],
    session: &str,
    call: &str,
    now: u64,
    expires: u64,
) -> Result<AgentSandboxContract, String> {
    if expires <= now {
        return Err("sandboxAuthorizationInvalid: network authorization expired".into());
    }
    for target in network_requests(&contract, targets)? {
        contract.resource_grants.push(AgentSandboxResourceGrant {
            authorization_id: format!("resource-{}", uuid::Uuid::new_v4()),
            session_id: session.into(),
            call_id: Some(call.into()),
            target: contract.target.clone(),
            issued_at_unix_ms: now,
            expires_at_unix_ms: expires,
            source: "native-approved-call".into(),
            resource: AgentSandboxResource::NetworkTarget {
                protocol: "tcp".into(),
                host: target.host,
                port: target.port,
                allow_redirects: false,
                resolver: target.resolver,
            },
        });
    }
    Ok(contract)
}

pub(crate) fn local_service_requests(
    contract: &AgentSandboxContract,
    services: &[super::LocalServiceRequestNative],
) -> Result<Vec<super::LocalServiceRequestNative>, String> {
    if services.len() > 8
        || contract.policy == AgentSandboxPolicy::Host
        || contract.target.kind != "local"
        || services.iter().any(|service| service.port == 0)
    {
        return Err(
            "sandboxResourceRequestInvalid: at most eight exact local service ports".into(),
        );
    }
    let mut normalized = services.to_vec();
    normalized.sort_by_key(|service| service.port);
    normalized.dedup();
    Ok(normalized)
}

pub(crate) fn issue_local_services(
    mut contract: AgentSandboxContract,
    services: &[super::LocalServiceRequestNative],
    session: &str,
    call: &str,
    now: u64,
    expires: u64,
) -> Result<AgentSandboxContract, String> {
    if expires <= now {
        return Err("sandboxAuthorizationInvalid: local service authorization expired".into());
    }
    for service in local_service_requests(&contract, services)? {
        contract.resource_grants.push(AgentSandboxResourceGrant {
            authorization_id: format!("resource-{}", uuid::Uuid::new_v4()),
            session_id: session.into(),
            call_id: Some(call.into()),
            target: contract.target.clone(),
            issued_at_unix_ms: now,
            expires_at_unix_ms: expires,
            source: "native-approved-call".into(),
            resource: AgentSandboxResource::LocalService {
                address: "127.0.0.1".into(),
                port: service.port,
            },
        });
    }
    Ok(contract)
}

#[derive(Debug, Clone, Copy, Default, serde::Deserialize, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ResourceAuthorizationScope {
    #[default]
    Once,
    Session,
}

#[derive(Clone, Default)]
pub(crate) struct SessionReadAuthorizations(
    std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, SessionReadAuthorization>>>,
);

struct SessionReadAuthorization {
    writes: std::collections::BTreeSet<String>,
    networks: Vec<super::NetworkTargetRequestNative>,
    services: Vec<super::LocalServiceRequestNative>,
    binding: String,
    task: String,
    paths: std::collections::BTreeSet<String>,
    expires: u64,
}

/// Read-only, non-persistent metadata. Never exposes native capability tokens.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SandboxAuthorizationStatus {
    pub(crate) state: &'static str,
    pub(crate) checked_at_unix_ms: u64,
    pub(crate) expires_at_unix_ms: Option<u64>,
    pub(crate) read_paths: Vec<String>,
    pub(crate) write_paths: Vec<String>,
    pub(crate) network_targets: Vec<super::NetworkTargetRequestNative>,
    pub(crate) local_services: Vec<super::LocalServiceRequestNative>,
    pub(crate) active_processes: usize,
}

fn binding_digest(contract: &AgentSandboxContract) -> Result<String, String> {
    let mut binding = contract.clone();
    binding.issued_at_unix_ms = 0;
    binding.resource_grants.clear();
    contract_digest(&binding)
}

impl SessionReadAuthorizations {
    pub(crate) fn resources_for_task(
        &self,
        task: &str,
    ) -> Result<Vec<AgentSandboxResource>, String> {
        let records = self
            .0
            .lock()
            .map_err(|_| "Session resource authorization unavailable")?;
        let mut resources = Vec::new();
        for record in records.values().filter(|record| record.task == task) {
            resources.extend(
                record
                    .paths
                    .iter()
                    .cloned()
                    .map(|path| AgentSandboxResource::ReadPath { path }),
            );
            resources.extend(
                record
                    .writes
                    .iter()
                    .cloned()
                    .map(|path| AgentSandboxResource::WritePath { path }),
            );
            resources.extend(record.networks.iter().map(|target| {
                AgentSandboxResource::NetworkTarget {
                    protocol: "tcp".into(),
                    host: target.host.clone(),
                    port: target.port,
                    resolver: target.resolver,
                    allow_redirects: false,
                }
            }));
            resources.extend(record.services.iter().map(|service| {
                AgentSandboxResource::LocalService {
                    address: "127.0.0.1".into(),
                    port: service.port,
                }
            }));
        }
        Ok(resources)
    }
    pub(crate) fn status(
        &self,
        session: &str,
        base: &AgentSandboxContract,
        now: u64,
    ) -> Result<SandboxAuthorizationStatus, String> {
        let binding = binding_digest(base)?;
        let records = self
            .0
            .lock()
            .map_err(|_| "Session resource authorization unavailable")?;
        let record = records
            .get(session)
            .filter(|record| record.binding == binding);
        let active = record.filter(|record| now < record.expires);
        Ok(SandboxAuthorizationStatus {
            state: if active.is_some() {
                "active"
            } else if record.is_some() {
                "expired"
            } else {
                "none"
            },
            checked_at_unix_ms: now,
            expires_at_unix_ms: record.map(|record| record.expires),
            read_paths: active
                .map(|record| record.paths.iter().cloned().collect())
                .unwrap_or_default(),
            write_paths: active
                .map(|record| record.writes.iter().cloned().collect())
                .unwrap_or_default(),
            network_targets: active
                .map(|record| record.networks.clone())
                .unwrap_or_default(),
            local_services: active
                .map(|record| record.services.clone())
                .unwrap_or_default(),
            active_processes: 0,
        })
    }
    pub(crate) fn covers_resources(
        &self,
        session: &str,
        base: &AgentSandboxContract,
        paths: &[String],
        writes: &[String],
        networks: &[super::NetworkTargetRequestNative],
        services: &[super::LocalServiceRequestNative],
        now: u64,
    ) -> Result<bool, String> {
        let binding = binding_digest(base)?;
        let mut records = self
            .0
            .lock()
            .map_err(|_| "Session resource authorization unavailable")?;
        records.retain(|_, record| now < record.expires);
        Ok(records.get(session).is_some_and(|record| {
            record.binding == binding
                && paths.iter().all(|path| record.paths.contains(path))
                && writes.iter().all(|path| record.writes.contains(path))
                && networks
                    .iter()
                    .all(|network| record.networks.contains(network))
                && services
                    .iter()
                    .all(|service| record.services.contains(service))
        }))
    }

    pub(crate) fn remember_resources(
        &self,
        session: &str,
        task: &str,
        base: &AgentSandboxContract,
        paths: &[String],
        writes: &[String],
        networks: &[super::NetworkTargetRequestNative],
        services: &[super::LocalServiceRequestNative],
        now: u64,
    ) -> Result<(), String> {
        self.remember(session, task, base, paths, now)?;
        let mut records = self
            .0
            .lock()
            .map_err(|_| "Session resource authorization unavailable")?;
        let record = records
            .get_mut(session)
            .ok_or("Session resource authorization was revoked")?;
        if record.binding != binding_digest(base)? || record.task != task {
            return Err("Session resource authorization binding changed".into());
        }
        record.writes.extend(writes.iter().cloned());
        for network in networks {
            if !record.networks.contains(network) {
                record.networks.push(network.clone());
            }
        }
        for service in services {
            if !record.services.contains(service) {
                record.services.push(service.clone());
            }
        }
        if record.networks.len() > 64 || record.services.len() > 16 || record.writes.len() > 64 {
            records.remove(session);
            return Err("Session resource authorization limit reached".into());
        }
        Ok(())
    }
    pub(crate) fn expiry(&self, session: &str) -> Result<Option<u64>, String> {
        Ok(self
            .0
            .lock()
            .map_err(|_| "Session read authorization unavailable")?
            .get(session)
            .map(|record| record.expires))
    }
    pub(crate) fn remember(
        &self,
        session: &str,
        task: &str,
        base: &AgentSandboxContract,
        paths: &[String],
        now: u64,
    ) -> Result<(), String> {
        let binding = binding_digest(base)?;
        let mut records = self
            .0
            .lock()
            .map_err(|_| "Session read authorization unavailable")?;
        records.retain(|_, record| now < record.expires);
        if records.len() >= 256 && !records.contains_key(session) {
            return Err("Session read authorization capacity reached".into());
        }
        let record = records
            .entry(session.into())
            .or_insert_with(|| SessionReadAuthorization {
                writes: Default::default(),
                networks: Vec::new(),
                services: Vec::new(),
                binding: binding.clone(),
                task: task.into(),
                paths: Default::default(),
                expires: now.saturating_add(60 * 60 * 1000),
            });
        if record.binding != binding {
            record.writes.clear();
            record.networks.clear();
            record.services.clear();
            record.paths.clear();
            record.binding = binding;
            record.task = task.into();
            record.expires = now.saturating_add(60 * 60 * 1000);
        }
        let mut authorized_paths = record.paths.clone();
        authorized_paths.extend(paths.iter().cloned());
        if authorized_paths.len() > 64 {
            return Err("Session read authorization file limit reached".into());
        }
        record.paths = authorized_paths;
        Ok(())
    }
    pub(crate) fn revoke_task(&self, task: &str) -> Result<(), String> {
        self.0
            .lock()
            .map_err(|_| "Session read authorization unavailable")?
            .retain(|_, record| record.task != task);
        Ok(())
    }

    pub(crate) fn revoke_all(&self) -> Result<(), String> {
        self.0
            .lock()
            .map_err(|_| "Session resource authorization unavailable")?
            .clear();
        Ok(())
    }
}

/// Only concrete existing account-owned cache/temporary directories are eligible.
/// Canonical path checks implement the declared partial path boundary, not object isolation.
pub(crate) fn cache_write_requests(
    contract: &AgentSandboxContract,
    paths: &[String],
) -> Result<Vec<String>, String> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    if paths.len() > 8
        || contract.policy != AgentSandboxPolicy::Workspace
        || contract.target.kind != "local"
    {
        return Err(
            "sandboxResourceRequestInvalid: cache writes require local workspace execution".into(),
        );
    }
    let root = std::path::Path::new(contract.root.as_deref().ok_or("sandboxWorkspaceMissing")?);
    let home = std::fs::canonicalize(std::env::home_dir().ok_or("sandboxHomeUnavailable")?)
        .map_err(|_| "sandboxHomeUnavailable")?;
    let mut cache_roots = [
        std::env::temp_dir(),
        std::path::PathBuf::from("/tmp"),
        std::path::PathBuf::from("/var/tmp"),
    ]
    .into_iter()
    .filter_map(|path| std::fs::canonicalize(path).ok())
    .collect::<Vec<_>>();
    cache_roots.extend(
        [
            "Library/Caches",
            ".cache",
            ".npm/_cacache",
            ".local/share/pnpm/store",
            "Library/pnpm/store",
            ".cargo/registry",
            ".cargo/git",
        ]
        .iter()
        .map(|path| home.join(path)),
    );
    let mut result = Vec::new();
    for value in paths {
        if value.is_empty()
            || value.len() > 4096
            || value.chars().any(char::is_control)
            || !std::path::Path::new(value).is_absolute()
        {
            return Err("sandboxResourceRequestInvalid: absolute cache directory required".into());
        }
        let metadata = std::fs::symlink_metadata(value)
            .map_err(|_| "sandboxResourceRequestInvalid: cache directory unavailable")?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(
                "sandboxResourceRequestInvalid: existing regular directory required".into(),
            );
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if metadata.uid() != unsafe { libc::geteuid() } {
                return Err(
                    "sandboxResourceRequestInvalid: cache directory must belong to the account"
                        .into(),
                );
            }
        }
        let canonical = std::fs::canonicalize(value)
            .map_err(|_| "sandboxResourceRequestInvalid: cache directory unavailable")?;
        let text = canonical
            .to_str()
            .ok_or("sandboxResourceRequestInvalid: UTF-8 required")?;
        if canonical.starts_with(root)
            || root.starts_with(&canonical)
            || home.starts_with(&canonical)
            || !cache_roots
                .iter()
                .any(|base| canonical != *base && canonical.starts_with(base))
            || super::native::path_is_sensitive_native(text)
            || super::native::protected_delete_path_native(text)
            || contract.deny.iter().any(|denied| {
                canonical.starts_with(denied)
                    || std::path::Path::new(denied).starts_with(&canonical)
            })
        {
            return Err(
                "sandboxResourceRequestInvalid: protected or non-cache directory cannot be granted"
                    .into(),
            );
        }
        #[cfg(target_os = "macos")]
        if super::native_sandbox_sensitive_paths()?
            .iter()
            .any(|denied| {
                canonical.starts_with(denied)
                    || std::path::Path::new(denied).starts_with(&canonical)
            })
        {
            return Err(
                "sandboxResourceRequestInvalid: protected directory cannot be granted".into(),
            );
        }
        if !result.iter().any(|path| path == text) {
            result.push(text.to_owned());
        }
    }
    Ok(result)
}

pub(crate) fn issue_cache_writes(
    mut contract: AgentSandboxContract,
    paths: &[String],
    session: &str,
    call: &str,
    now: u64,
    expires: u64,
) -> Result<AgentSandboxContract, String> {
    if expires <= now {
        return Err("sandboxAuthorizationInvalid: cache authorization expired".into());
    }
    for path in cache_write_requests(&contract, paths)? {
        contract.resource_grants.push(AgentSandboxResourceGrant {
            authorization_id: format!("resource-{}", uuid::Uuid::new_v4()),
            session_id: session.into(),
            call_id: Some(call.into()),
            target: contract.target.clone(),
            issued_at_unix_ms: now,
            expires_at_unix_ms: expires,
            source: "native-approved-call".into(),
            resource: super::AgentSandboxResource::WritePath { path },
        });
    }
    Ok(contract)
}

pub(crate) fn project_read_requests(
    contract: &AgentSandboxContract,
    paths: &[String],
) -> Result<Vec<String>, String> {
    if paths.len() > 8
        || contract.policy == AgentSandboxPolicy::Host
        || contract.target.kind != "local"
    {
        return Err("sandboxResourceRequestInvalid: at most eight local regular files".into());
    }
    let root = std::path::Path::new(contract.root.as_deref().ok_or("sandboxWorkspaceMissing")?);
    let mut result = Vec::new();
    for value in paths {
        if value.is_empty() || value.len() > 4096 || value.chars().any(char::is_control) {
            return Err("sandboxResourceRequestInvalid: invalid path".into());
        }
        let path = std::path::Path::new(value);
        if !path.is_absolute() {
            return Err("sandboxResourceRequestInvalid: absolute path required".into());
        }
        let metadata = std::fs::symlink_metadata(path)
            .map_err(|_| "sandboxResourceRequestInvalid: file unavailable")?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err("sandboxResourceRequestInvalid: regular file required".into());
        }
        let canonical = std::fs::canonicalize(path)
            .map_err(|_| "sandboxResourceRequestInvalid: file unavailable")?;
        if !canonical.starts_with(root)
            && (super::native::path_is_sensitive_native(
                canonical
                    .to_str()
                    .ok_or("sandboxResourceRequestInvalid: UTF-8 required")?,
            ) || super::native::protected_delete_path_native(
                canonical
                    .to_str()
                    .ok_or("sandboxResourceRequestInvalid: UTF-8 required")?,
            ))
        {
            return Err(
                "sandboxResourceRequestInvalid: protected external file cannot be granted".into(),
            );
        }
        #[cfg(target_os = "macos")]
        if super::native_sandbox_sensitive_paths()?
            .iter()
            .any(|denied| canonical.starts_with(denied))
        {
            return Err(
                "sandboxResourceRequestInvalid: protected credentials cannot be granted".into(),
            );
        }
        let canonical = canonical
            .to_str()
            .ok_or("sandboxResourceRequestInvalid: UTF-8 required")?
            .to_owned();
        if !result.contains(&canonical) {
            result.push(canonical);
        }
    }
    Ok(result)
}

pub(crate) fn issue_project_reads(
    base: &AgentSandboxContract,
    paths: &[String],
    session: &str,
    call: &str,
    authorization: &str,
    now: u64,
    expires: u64,
) -> Result<AgentSandboxContract, String> {
    if !base.resource_grants.is_empty() || expires <= now {
        return Err("sandboxAuthorizationInvalid: stale base authorization".into());
    }
    let paths = project_read_requests(base, paths)?;
    let mut contract = base.clone();
    for path in paths {
        contract.resource_grants.push(AgentSandboxResourceGrant {
            authorization_id: authorization.into(),
            session_id: session.into(),
            call_id: Some(call.into()),
            target: base.target.clone(),
            issued_at_unix_ms: now,
            expires_at_unix_ms: expires,
            source: "native-approved-call".into(),
            resource: AgentSandboxResource::ReadPath { path },
        });
    }
    Ok(contract)
}

pub(crate) fn contract_digest(contract: &AgentSandboxContract) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let bytes = serde_json::to_vec(contract)
        .map_err(|_| "sandboxAuthorizationInvalid: policy serialization failed")?;
    Ok(Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}
