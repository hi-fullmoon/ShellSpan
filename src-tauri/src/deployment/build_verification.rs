use super::docker_compose_executor::fixed_command;
use super::node_executor::NodeFailure;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BuildVerification {
    pub package_manager: PackageManager,
    pub script: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum PackageManager {
    Npm,
    Pnpm,
}

impl BuildVerification {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.script.is_empty()
            || self.script.starts_with('-')
            || self.script.len() > 128
            || !self
                .script
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"-_:".contains(&byte))
        {
            return Err("DEPLOYMENT_VERIFICATION_SCRIPT_INVALID".into());
        }
        Ok(())
    }

    pub(crate) fn execute(
        &self,
        root: &Path,
        cancellation: &CancellationToken,
        timeout: Duration,
    ) -> Result<(), NodeFailure> {
        self.validate()
            .map_err(|error| NodeFailure::definite("buildVerification", error))?;
        let copy = super::source_binding::materialize(root)
            .map_err(|error| NodeFailure::definite("buildVerification", error))?;
        let (program, install, lockfile) = match self.package_manager {
            PackageManager::Npm => ("npm", vec!["ci".into()], "package-lock.json"),
            PackageManager::Pnpm => (
                "pnpm",
                vec!["install".into(), "--frozen-lockfile".into()],
                "pnpm-lock.yaml",
            ),
        };
        if !copy.path().join(lockfile).is_file() {
            return Err(NodeFailure::definite(
                "buildVerification",
                "verification requires a committed lockfile",
            ));
        }
        fixed_command(program, &install, copy.path(), cancellation, timeout)?;
        fixed_command(
            program,
            &["run".into(), self.script.clone()],
            copy.path(),
            cancellation,
            timeout,
        )
    }
}
