use serde::{Deserialize, Serialize};

use super::{AgentExecutionSurface, AgentSessionTarget};

/// Resource intent is independent of operation approval. Missing policy in old
/// logs means legacy host access, never an inferred restricted policy.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentSandboxPolicy {
    ReadOnly,
    Workspace,
    Host,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentSandboxCapabilityStatus {
    Full,
    Partial,
    Unavailable,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentSandboxNetworkPolicy {
    Account,
    Deny,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
pub(crate) enum AgentSandboxPolicySource {
    #[serde(rename = "legacy")]
    Legacy,
    #[serde(rename = "session-intent")]
    SessionIntent,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentSandboxContract {
    pub(crate) version: u32,
    pub(crate) binding_revision: u64,
    pub(crate) session_created_at_unix_ms: u64,
    pub(crate) policy: AgentSandboxPolicy,
    pub(crate) target: AgentSessionTarget,
    pub(crate) execution_surface: AgentExecutionSurface,
    pub(crate) root: Option<String>,
    pub(crate) read_allow: Vec<String>,
    pub(crate) write_allow: Vec<String>,
    pub(crate) deny: Vec<String>,
    pub(crate) network: AgentSandboxNetworkPolicy,
    pub(crate) source: AgentSandboxPolicySource,
    pub(crate) issued_at_unix_ms: u64,
    /// Frozen intent is not a resource grant. Host/legacy access retains the
    /// existing operation-approval TTL instead of gaining a second deadline.
    pub(crate) resource_grants: Vec<AgentSandboxResourceGrant>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentSandboxResourceGrant {
    pub(crate) authorization_id: String,
    pub(crate) session_id: String,
    pub(crate) call_id: Option<String>,
    pub(crate) target: AgentSessionTarget,
    pub(crate) issued_at_unix_ms: u64,
    pub(crate) expires_at_unix_ms: u64,
    pub(crate) source: String,
    pub(crate) resource: AgentSandboxResource,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum AgentSandboxResource {
    ReadPath {
        path: String,
    },
    WritePath {
        path: String,
    },
    NetworkTarget {
        protocol: String,
        host: String,
        port: u16,
        allow_redirects: bool,
        #[serde(default)]
        resolver: super::NetworkResolverNative,
    },
    LocalService {
        address: String,
        port: u16,
    },
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentSandboxCapability {
    pub(crate) status: AgentSandboxCapabilityStatus,
    pub(crate) files: bool,
    pub(crate) network: bool,
    pub(crate) process_lifecycle: bool,
    pub(crate) gaps: Vec<&'static str>,
}

pub(crate) fn sandbox_capability() -> AgentSandboxCapability {
    AgentSandboxCapability {
        status: AgentSandboxCapabilityStatus::Unavailable,
        files: false,
        network: false,
        process_lifecycle: false,
        gaps: vec!["No verified production sandbox backend; host operations are not isolated"],
    }
}

pub(crate) fn sandbox_capability_for(header: &super::AgentSessionHeader) -> AgentSandboxCapability {
    if header.sandbox_policy.is_some_and(|policy| policy != AgentSandboxPolicy::Host)
        && header.execution_surface == AgentExecutionSurface::Direct
        && header.target.as_ref().is_some_and(|target| target.kind == "remote") {
        return super::remote_seatbelt::capability(header).unwrap_or_else(sandbox_capability);
    }
    if header
        .sandbox_policy
        .is_some_and(|policy| policy != AgentSandboxPolicy::Host)
        && header.execution_surface == AgentExecutionSurface::Direct
        && header
            .target
            .as_ref()
            .is_some_and(|target| target.kind == "local")
        && super::native_sandbox_verified()
    {
        return native_sandbox_capability();
    }
    sandbox_capability()
}

pub(crate) fn native_sandbox_capability() -> AgentSandboxCapability {
    if super::native_sandbox_verified() {
        return AgentSandboxCapability {
            status: AgentSandboxCapabilityStatus::Partial,
            files: true, network: true, process_lifecycle: false,
            gaps: vec![
                "Native path restrictions do not isolate hard-link aliases or hostile same-account filesystem races",
                "Process groups do not guarantee containment of all hostile descendants",
                "Native Direct shell, process controls, project and approved non-sensitive external file reads, cache-directory read/write grants, public TCP proxies and Node loopback service relays are available; other tools and runtimes are unsupported",
            ],
        };
    }
    sandbox_capability()
}

pub(crate) fn require_session_sandbox(header: &super::AgentSessionHeader) -> Result<(), String> {
    if header.sandbox_policy.unwrap_or(AgentSandboxPolicy::Host) == AgentSandboxPolicy::Host {
        return Ok(());
    }
    let target = header.target.as_ref().ok_or("sandboxWorkspaceMissing")?;
    AgentSandboxContract::freeze(header.sandbox_policy, target, header.execution_surface, 0)?
        .bind_to_session(header)
        .authorize_dispatch(target, 0)
}

pub(crate) fn restricted_model_tool(name: &str) -> bool {
    matches!(
        name,
        "run_terminal_command"
            | "write_process_input"
            | "wait_process"
            | "kill_process"
            | "probe_http"
    )
}

pub(crate) fn host_policy_failure(
    policy: Option<AgentSandboxPolicy>,
) -> Option<super::AgentExecutionFailure> {
    if policy.is_some_and(|policy| policy != AgentSandboxPolicy::Host) {
        return Some(super::AgentExecutionFailure::new(
            super::AgentExecutionFailureKind::BackendUnavailable,
            "sandboxBackendUnavailable",
            super::AgentExecutionAdmission::NotStarted,
        ));
    }
    None
}

pub(crate) fn require_host_policy(policy: Option<AgentSandboxPolicy>) -> Result<(), String> {
    if host_policy_failure(policy).is_some() {
        return Err("sandboxBackendUnavailable: restricted tools cannot dispatch; explicitly create a host policy session to use account access".into());
    }
    Ok(())
}

impl AgentSandboxContract {
    pub(crate) fn freeze(
        policy: Option<AgentSandboxPolicy>,
        target: &AgentSessionTarget,
        surface: AgentExecutionSurface,
        now: u64,
    ) -> Result<Self, String> {
        let source = if policy.is_none() {
            AgentSandboxPolicySource::Legacy
        } else {
            AgentSandboxPolicySource::SessionIntent
        };
        let policy = policy.unwrap_or(AgentSandboxPolicy::Host);
        let root = if policy != AgentSandboxPolicy::Host && target.kind == "local" {
            let path = target
                .local_root
                .as_ref()
                .or(target.root_path.as_ref())
                .or(target.cwd.as_ref())
                .ok_or_else(|| "sandboxWorkspaceMissing: select a project directory".to_string())?;
            let canonical = std::fs::canonicalize(path).map_err(|_| {
                "sandboxWorkspaceInvalid: project directory is unavailable".to_string()
            })?;
            if !canonical.is_dir() {
                return Err("sandboxWorkspaceInvalid: project root must be a directory".into());
            }
            Some(
                canonical
                    .to_str()
                    .ok_or("sandboxWorkspaceInvalid: project root is not valid UTF-8")?
                    .to_owned(),
            )
        } else if policy != AgentSandboxPolicy::Host && target.kind == "remote" {
            super::remote_seatbelt::root_for(target).ok()
        } else {
            None
        };
        #[cfg(not(target_os = "macos"))]
        let deny = Vec::new();
        #[cfg(target_os = "macos")]
        let deny = if policy != AgentSandboxPolicy::Host && target.kind == "local" {
            let mut paths = super::native_sandbox_sensitive_paths()?;
            if let Some(root) = &root {
                for file in [".env", ".npmrc", ".netrc", ".pypirc", ".git-credentials"] {
                    paths.push(
                        std::path::Path::new(root)
                            .join(file)
                            .to_string_lossy()
                            .into_owned(),
                    );
                }
            }
            paths
        } else {
            Vec::new()
        };
        let deny = if policy != AgentSandboxPolicy::Host && target.kind == "remote" {
            super::remote_seatbelt::deny_for(target).unwrap_or_default()
        } else { deny };
        Ok(Self {
            version: 1,
            binding_revision: 0,
            session_created_at_unix_ms: 0,
            policy,
            target: target.clone(),
            execution_surface: surface,
            read_allow: root.iter().cloned().collect(),
            write_allow: if policy == AgentSandboxPolicy::Workspace {
                root.iter().cloned().collect()
            } else {
                vec![]
            },
            root,
            deny,
            network: if policy == AgentSandboxPolicy::Host {
                AgentSandboxNetworkPolicy::Account
            } else {
                AgentSandboxNetworkPolicy::Deny
            },
            source,
            issued_at_unix_ms: now,
            resource_grants: vec![],
        })
    }

    pub(crate) fn authorize_dispatch(
        &self,
        target: &AgentSessionTarget,
        now: u64,
    ) -> Result<(), String> {
        if &self.target != target {
            return Err("sandboxAuthorizationInvalid: target changed".into());
        }
        if self.resource_grants.iter().any(|grant| {
            &grant.target != target
                || now < grant.issued_at_unix_ms
                || now >= grant.expires_at_unix_ms
        }) {
            return Err(
                "sandboxAuthorizationInvalid: resource grant expired or target changed".into(),
            );
        }
        if self.policy == AgentSandboxPolicy::Host {
            return Ok(());
        }
        if self.target.kind == "remote" {
            return super::remote_seatbelt::authorize(self);
        }
        if self.resource_grants.iter().any(|grant| matches!(&grant.resource,
            AgentSandboxResource::NetworkTarget {protocol, allow_redirects, ..} if protocol != "tcp" || *allow_redirects
        )) {
            return Err("sandboxPolicyUnsupported: network grants authorize TCP targets, not HTTP content or redirects".into());
        }
        if self.resource_grants.iter().any(|grant| matches!(&grant.resource, AgentSandboxResource::LocalService {address,port} if address != "127.0.0.1" || *port == 0)) {
            return Err("sandboxPolicyUnsupported: only exact IPv4 loopback services are supported".into());
        }
        if self.target.kind == "local"
            && self.execution_surface == AgentExecutionSurface::Direct
            && self.root.is_some()
            && self.network == AgentSandboxNetworkPolicy::Deny
            && self.resource_grants.iter().all(|grant| {
                grant.source == "native-approved-call"
                    && grant.call_id.is_some()
                    && match &grant.resource {
                        AgentSandboxResource::ReadPath { path } => super::sandbox_authorization::project_read_requests(self,&[path.clone()]).is_ok(),
                        AgentSandboxResource::WritePath { path } => {
                            super::sandbox_authorization::cache_write_requests(
                                self,
                                &[path.clone()],
                            )
                            .is_ok()
                        }
                        AgentSandboxResource::NetworkTarget {
                            protocol,
                            host,
                            port,
                            allow_redirects,
                            resolver,
                        } => {
                            protocol == "tcp"
                                && !allow_redirects
                                && super::sandbox_authorization::network_requests(
                                    self,
                                    &[super::NetworkTargetRequestNative {
                                        host: host.clone(),
                                        port: *port,
                                        resolver: *resolver,
                                    }],
                                )
                                .is_ok()
                        }
                        AgentSandboxResource::LocalService { address, port } => {
                            address == "127.0.0.1" && *port > 0
                        }
                    }
            })
            && super::native_sandbox_verified()
        {
            return Ok(());
        }
        Err("sandboxBackendUnavailable: required native Direct boundary is unavailable".into())
    }

    pub(crate) fn validate_session(
        &self,
        header: &super::AgentSessionHeader,
        now: u64,
    ) -> Result<(), String> {
        if header.sandbox_binding_revision != self.binding_revision
            || header.created_at_unix_ms != self.session_created_at_unix_ms
            || header.target.as_ref() != Some(&self.target)
            || header.sandbox_policy.unwrap_or(AgentSandboxPolicy::Host) != self.policy
            || header.execution_surface != self.execution_surface
        {
            return Err("sandboxAuthorizationInvalid: session binding or policy changed".into());
        }
        if self
            .resource_grants
            .iter()
            .any(|grant| grant.session_id != header.session_id)
        {
            return Err(
                "sandboxAuthorizationInvalid: resource grant belongs to another session".into(),
            );
        }
        self.authorize_dispatch(&self.target, now)
    }

    pub(crate) fn bind_to_session(mut self, header: &super::AgentSessionHeader) -> Self {
        self.binding_revision = header.sandbox_binding_revision;
        self.session_created_at_unix_ms = header.created_at_unix_ms;
        self
    }

    pub(crate) fn authorize_call(
        &self,
        session_id: &str,
        call_id: &str,
        target: &AgentSessionTarget,
        now: u64,
    ) -> Result<(), String> {
        if self.version != 1
            || self.resource_grants.iter().any(|grant| {
                grant.authorization_id.is_empty()
                    || grant.source.is_empty()
                    || grant.session_id != session_id
                    || grant
                        .call_id
                        .as_deref()
                        .is_some_and(|bound| bound != call_id)
            })
        {
            return Err(
                "sandboxAuthorizationInvalid: resource grant belongs to another call or session"
                    .into(),
            );
        }
        self.authorize_dispatch(target, now)
    }
}

#[cfg(test)]
#[path = "tests/sandbox.rs"]
mod tests;
