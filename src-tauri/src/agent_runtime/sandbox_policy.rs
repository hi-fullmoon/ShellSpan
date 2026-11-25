//! Unified sandbox policy model shared across local and remote Agent backends.
//!
//! Normalizes macOS `nono`, Windows `AppContainer`, SSH `ClientReadOnly` (L1),
//! SSH `Bubblewrap` (L3), and future `OpenSandbox` PTY sandboxes into a single
//! inspectable contract with a canonical SHA-256 digest for approval binding.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::agent_runtime::{SandboxNetworkMode, SandboxNetworkPolicy};
use crate::remote_sandbox;

pub(crate) const SANDBOX_POLICY_CONTRACT_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SandboxBackendKind {
    MacNono,
    WindowsAppContainer,
    SshClientReadOnly,
    SshBubblewrap,
    OpenSandboxPty,
}

impl SandboxBackendKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::MacNono => "macNono",
            Self::WindowsAppContainer => "windowsAppContainer",
            Self::SshClientReadOnly => "sshClientReadOnly",
            Self::SshBubblewrap => "sshBubblewrap",
            Self::OpenSandboxPty => "openSandboxPty",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SandboxFilesystemMode {
    ReadOnly,
    WorkspaceWrite,
}

impl SandboxFilesystemMode {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::ReadOnly => "readOnly",
            Self::WorkspaceWrite => "workspaceWrite",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum SandboxNetworkPosture {
    Blocked,
    FilteredProxy {
        mode: SandboxNetworkMode,
        allowed_domains: Vec<String>,
    },
}

impl SandboxNetworkPosture {
    pub(crate) fn from_local_policy(policy: &SandboxNetworkPolicy) -> Self {
        if !policy.uses_proxy() {
            return Self::Blocked;
        }
        let allowed_domains = policy
            .effective_rules()
            .into_iter()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        Self::FilteredProxy {
            mode: policy.mode,
            allowed_domains,
        }
    }

    fn feed_digest(&self, hasher: &mut Sha256) {
        match self {
            Self::Blocked => hasher.update(b"network:blocked\0"),
            Self::FilteredProxy {
                mode,
                allowed_domains,
            } => {
                let mode_name = match mode {
                    SandboxNetworkMode::Blocked => "blocked",
                    SandboxNetworkMode::DevRegistries => "devRegistries",
                    SandboxNetworkMode::CustomAllowlist => "customAllowlist",
                };
                hasher.update(b"network:proxy:");
                hasher.update(mode_name.as_bytes());
                hasher.update(b"\0");
                let canonical: BTreeSet<&str> =
                    allowed_domains.iter().map(String::as_str).collect();
                for domain in canonical {
                    hasher.update(domain.as_bytes());
                    hasher.update(b"\0");
                }
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SandboxPolicy {
    pub(crate) version: u32,
    pub(crate) backend: SandboxBackendKind,
    pub(crate) filesystem_mode: SandboxFilesystemMode,
    pub(crate) workspace_root: String,
    pub(crate) network: SandboxNetworkPosture,
    pub(crate) supports_visible_pty: bool,
    pub(crate) supports_shell_commands: bool,
}

impl SandboxPolicy {
    pub(crate) fn for_mac_nono(
        workspace_root: impl Into<String>,
        network_policy: &SandboxNetworkPolicy,
    ) -> Self {
        Self {
            version: SANDBOX_POLICY_CONTRACT_VERSION,
            backend: SandboxBackendKind::MacNono,
            filesystem_mode: SandboxFilesystemMode::WorkspaceWrite,
            workspace_root: workspace_root.into(),
            network: SandboxNetworkPosture::from_local_policy(network_policy),
            supports_visible_pty: true,
            supports_shell_commands: true,
        }
    }

    #[cfg(test)]
    pub(crate) fn for_windows_app_container(workspace_root: impl Into<String>) -> Self {
        Self {
            version: SANDBOX_POLICY_CONTRACT_VERSION,
            backend: SandboxBackendKind::WindowsAppContainer,
            filesystem_mode: SandboxFilesystemMode::WorkspaceWrite,
            workspace_root: workspace_root.into(),
            network: SandboxNetworkPosture::Blocked,
            supports_visible_pty: false,
            supports_shell_commands: true,
        }
    }

    pub(crate) fn for_remote(policy: &remote_sandbox::Policy) -> Self {
        match policy.mode {
            remote_sandbox::Mode::ClientReadOnly => Self {
                version: SANDBOX_POLICY_CONTRACT_VERSION,
                backend: SandboxBackendKind::SshClientReadOnly,
                filesystem_mode: SandboxFilesystemMode::ReadOnly,
                workspace_root: policy.workspace.clone(),
                network: SandboxNetworkPosture::Blocked,
                supports_visible_pty: false,
                supports_shell_commands: false,
            },
            remote_sandbox::Mode::ReadOnly => Self {
                version: SANDBOX_POLICY_CONTRACT_VERSION,
                backend: SandboxBackendKind::SshBubblewrap,
                filesystem_mode: SandboxFilesystemMode::ReadOnly,
                workspace_root: policy.workspace.clone(),
                network: SandboxNetworkPosture::Blocked,
                supports_visible_pty: false,
                supports_shell_commands: true,
            },
            remote_sandbox::Mode::WorkspaceWrite => Self {
                version: SANDBOX_POLICY_CONTRACT_VERSION,
                backend: SandboxBackendKind::SshBubblewrap,
                filesystem_mode: SandboxFilesystemMode::WorkspaceWrite,
                workspace_root: policy.workspace.clone(),
                network: SandboxNetworkPosture::Blocked,
                supports_visible_pty: false,
                supports_shell_commands: true,
            },
        }
    }

    #[cfg(test)]
    pub(crate) fn for_open_sandbox(
        workspace_root: impl Into<String>,
        filesystem_mode: SandboxFilesystemMode,
        network_policy: &SandboxNetworkPolicy,
    ) -> Self {
        Self {
            version: SANDBOX_POLICY_CONTRACT_VERSION,
            backend: SandboxBackendKind::OpenSandboxPty,
            filesystem_mode,
            workspace_root: workspace_root.into(),
            network: SandboxNetworkPosture::from_local_policy(network_policy),
            supports_visible_pty: true,
            supports_shell_commands: true,
        }
    }

    /// Canonical SHA-256 digest covering all policy dimensions for approval and
    /// session drift checks.
    pub(crate) fn digest(&self) -> String {
        let mut hasher = Sha256::new();
        hasher.update(format!("v{}\0", self.version).as_bytes());
        hasher.update(self.backend.as_str().as_bytes());
        hasher.update(b"\0");
        hasher.update(self.filesystem_mode.as_str().as_bytes());
        hasher.update(b"\0");
        hasher.update(self.workspace_root.as_bytes());
        hasher.update(b"\0");
        self.network.feed_digest(&mut hasher);
        hasher.update(if self.supports_visible_pty {
            b"pty:1\0"
        } else {
            b"pty:0\0"
        });
        hasher.update(if self.supports_shell_commands {
            b"shell:1\0"
        } else {
            b"shell:0\0"
        });
        hex::encode(hasher.finalize())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mac_nono_policy_maps_network_modes_and_stable_digest() {
        let blocked = SandboxPolicy::for_mac_nono(
            "/Users/demo/.shellspan/sandboxes/0123456789abcdef0123456789abcdef/workspace",
            &SandboxNetworkPolicy::blocked(),
        );
        assert_eq!(blocked.backend, SandboxBackendKind::MacNono);
        assert_eq!(
            blocked.filesystem_mode,
            SandboxFilesystemMode::WorkspaceWrite
        );
        assert_eq!(blocked.network, SandboxNetworkPosture::Blocked);
        assert!(blocked.supports_visible_pty);
        assert!(blocked.supports_shell_commands);

        let custom_a = SandboxPolicy::for_mac_nono(
            "/Users/demo/.shellspan/sandboxes/0123456789abcdef0123456789abcdef/workspace",
            &SandboxNetworkPolicy {
                mode: SandboxNetworkMode::CustomAllowlist,
                custom_domains: vec!["b.example.com".into(), "a.example.com".into()],
            },
        );
        let custom_b = SandboxPolicy::for_mac_nono(
            "/Users/demo/.shellspan/sandboxes/0123456789abcdef0123456789abcdef/workspace",
            &SandboxNetworkPolicy {
                mode: SandboxNetworkMode::CustomAllowlist,
                custom_domains: vec![
                    "a.example.com".into(),
                    "b.example.com".into(),
                    "a.example.com".into(),
                ],
            },
        );
        assert_eq!(custom_a.digest(), custom_b.digest());
        assert_ne!(blocked.digest(), custom_a.digest());
    }

    #[test]
    fn remote_policy_distinguishes_l1_client_read_only_and_l3_bubblewrap() {
        let l1 = SandboxPolicy::for_remote(&remote_sandbox::Policy {
            mode: remote_sandbox::Mode::ClientReadOnly,
            workspace: "/etc/nginx".into(),
        });
        assert_eq!(l1.backend, SandboxBackendKind::SshClientReadOnly);
        assert_eq!(l1.filesystem_mode, SandboxFilesystemMode::ReadOnly);
        assert!(!l1.supports_shell_commands);

        let l3_ro = SandboxPolicy::for_remote(&remote_sandbox::Policy {
            mode: remote_sandbox::Mode::ReadOnly,
            workspace: "/srv/shellspan-workspaces/app".into(),
        });
        assert_eq!(l3_ro.backend, SandboxBackendKind::SshBubblewrap);
        assert_eq!(l3_ro.filesystem_mode, SandboxFilesystemMode::ReadOnly);
        assert!(l3_ro.supports_shell_commands);

        let l3_rw = SandboxPolicy::for_remote(&remote_sandbox::Policy {
            mode: remote_sandbox::Mode::WorkspaceWrite,
            workspace: "/srv/shellspan-workspaces/app".into(),
        });
        assert_eq!(l3_rw.backend, SandboxBackendKind::SshBubblewrap);
        assert_eq!(l3_rw.filesystem_mode, SandboxFilesystemMode::WorkspaceWrite);
        assert_ne!(l3_ro.digest(), l3_rw.digest());
    }

    #[test]
    fn windows_and_open_sandbox_policies_reflect_backend_capabilities() {
        let win = SandboxPolicy::for_windows_app_container("C:\\Users\\demo\\ws");
        assert_eq!(win.backend, SandboxBackendKind::WindowsAppContainer);
        assert_eq!(win.network, SandboxNetworkPosture::Blocked);
        assert!(!win.supports_visible_pty);

        let open = SandboxPolicy::for_open_sandbox(
            "/workspace",
            SandboxFilesystemMode::WorkspaceWrite,
            &SandboxNetworkPolicy {
                mode: SandboxNetworkMode::DevRegistries,
                custom_domains: Vec::new(),
            },
        );
        assert_eq!(open.backend, SandboxBackendKind::OpenSandboxPty);
        assert!(open.supports_visible_pty);
        assert!(matches!(
            open.network,
            SandboxNetworkPosture::FilteredProxy {
                mode: SandboxNetworkMode::DevRegistries,
                ..
            }
        ));
    }
}
