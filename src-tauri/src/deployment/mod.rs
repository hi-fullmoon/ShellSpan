//! Deployment Workflow protocol, persistence, artifact CAS, native executors,
//! coordinator, reconciliation, audit, and high-level command surface.

mod applications;
mod artifact_cas;
mod audit;
mod build_verification;
mod canonicalization;
pub(crate) mod commands;
mod compiler;
mod compose_release;
mod deployment_files;
mod docker_archive;
mod docker_compose_executor;
mod file_tree_artifact;
mod host_compose;
pub(crate) mod import;
mod local_artifact_executor;
mod node_executor;
mod node_registry;
mod port_types;
mod readiness;
mod repository;
mod run_coordinator;
mod runtime;
mod security;
mod source_binding;
mod static_site_template;
mod target_connection;
mod validation_error;
mod workflow_schema;

pub(crate) use runtime::DeploymentWorkflowRuntime;

#[cfg(test)]
mod application_acceptance;

#[cfg(test)]
mod release_acceptance;

#[cfg(test)]
mod host_compose_tests;
