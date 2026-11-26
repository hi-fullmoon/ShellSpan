mod ansi;
mod auto_review;
mod call_policy;
mod capability;
mod checkpoint;
mod diagnostics;
mod effect;
mod filesystem;
mod http_probe;
#[cfg(target_os = "macos")]
pub(crate) mod mac_sandbox;
#[cfg(target_os = "macos")]
mod mac_sandbox_workspace;
mod mcp;
mod process;
mod registry;
mod runtime;
pub(crate) mod sandbox_proxy;
pub(crate) mod sandbox_sync;
pub(crate) mod scoped_read;
mod shell_guard;
mod shell_policy;
mod sudo;
mod terminal_execute;
mod terminal_interactive;
mod terminal_lease;
mod tool_progress;
#[cfg(windows)]
pub(crate) mod windows_sandbox;

pub(crate) use ansi::*;
pub(crate) use auto_review::*;
pub(crate) use call_policy::*;
pub(crate) use capability::*;
pub(crate) use checkpoint::*;
pub(crate) use effect::*;
pub(crate) use filesystem::*;
use http_probe::*;
#[cfg(all(
    feature = "native-input-acceptance",
    debug_assertions,
    target_os = "macos",
    target_arch = "aarch64"
))]
pub(crate) use mac_sandbox_workspace::recover_on_startup as recover_mac_sandbox_workspace;
pub(crate) use mcp::*;
pub(crate) use process::*;
pub(crate) use registry::*;
pub(crate) use runtime::*;
pub(crate) use sandbox_proxy::SandboxNetworkMode;
#[cfg(any(target_os = "macos", test))]
pub(crate) use sandbox_proxy::SandboxNetworkPolicy;
#[cfg(test)]
pub(crate) use shell_guard::REMOTE_PRIVILEGE_DENIED;
pub(crate) use shell_guard::{
    literal_sudo_command, reject_destructive, reject_remote_privilege_command,
    sudo_policy_reference, SUDO_POLICY_DENIED,
};
pub(crate) use sudo::{SudoPrompts, AGENT_SUDO_PROMPT_EVENT};
pub(crate) use terminal_execute::*;
pub(crate) use terminal_interactive::*;
pub(crate) use terminal_lease::*;
pub(crate) use tool_progress::*;

#[cfg(any(target_os = "macos", windows))]
pub(crate) trait LocalSandboxBackend {
    fn kind(&self) -> crate::agent_runtime::LocalSandboxKind;
    fn digest(&self) -> &str;
}

#[cfg(any(target_os = "macos", windows))]
pub(super) fn local_sandbox_digest<T: LocalSandboxBackend>(
    binding: &T,
    expected: crate::agent_runtime::LocalSandboxKind,
) -> &str {
    debug_assert_eq!(binding.kind(), expected);
    binding.digest()
}
