mod ansi;
mod auto_review;
mod call_policy;
mod capability;
mod checkpoint;
pub(crate) mod container_backend;
#[cfg(debug_assertions)]
pub(crate) use container_backend::{gui_custody_status, prepare_gui_resource};
mod container_ownership;
pub(crate) use container_ownership::ContainerResourceSupervisor;
mod diagnostics;
mod direct_ownership;
#[cfg(target_os = "macos")]
mod local_guardian;
pub(crate) use direct_ownership::DirectResourceRecovery;
#[cfg(target_os = "macos")]
pub(crate) use local_guardian::run as run_local_resource_controller;
mod effect;
mod filesystem;
mod http_probe;
#[cfg(target_os = "macos")]
mod macos_sandbox;
#[cfg(target_os = "macos")]
mod network_proxy;
#[cfg(all(target_os = "macos", debug_assertions))]
pub(crate) use macos_sandbox::run_check as run_native_sandbox_check;
#[cfg(target_os = "macos")]
pub(crate) use macos_sandbox::sensitive_paths as native_sandbox_sensitive_paths;
mod mcp;
#[cfg(all(test, target_os = "macos"))]
pub(crate) use macos_sandbox::verify_backend as verify_native_sandbox_backend;
#[cfg(target_os = "macos")]
pub(crate) use macos_sandbox::{
    verified as native_sandbox_verified,
    verify_backend_owned as verify_native_sandbox_backend_owned,
};

#[cfg(not(target_os = "macos"))]
pub(crate) fn native_sandbox_verified() -> bool {
    false
}
#[cfg(all(test, not(target_os = "macos")))]
pub(crate) fn verify_native_sandbox_backend() -> bool {
    false
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn verify_native_sandbox_backend_owned(_engine: &NativeToolEngine) -> bool {
    false
}
#[cfg(all(test, target_os = "macos"))]
#[path = "../tests/macos_direct.rs"]
mod macos_direct_tests;
mod process;
mod registry;
mod runtime;
pub(crate) mod scoped_read;
mod shell_guard;
mod shell_policy;
mod terminal_execute;
mod terminal_interactive;
mod terminal_lease;

pub(crate) use ansi::*;
pub(crate) use auto_review::*;
pub(crate) use call_policy::*;
pub(crate) use capability::*;
pub(crate) use checkpoint::*;
pub(crate) use effect::*;
pub(crate) use filesystem::*;
use http_probe::*;
pub(crate) use mcp::*;
pub(crate) use process::*;
pub(crate) use registry::*;
pub(crate) use runtime::*;
pub(crate) use terminal_execute::*;
pub(crate) use terminal_interactive::*;
pub(crate) use terminal_lease::*;
