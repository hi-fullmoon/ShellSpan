use super::artifact_cas::DeploymentArtifactCas;
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};
use tokio_util::sync::CancellationToken;

pub(crate) const DEPLOYMENT_WORKFLOW_GATE_ENV: &str = "SHELLSPAN_DEPLOYMENT_WORKFLOW";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DeploymentWorkflowAdmission {
    ReadOnly,
    Mutating,
    Continuity,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentWorkflowCapabilities {
    pub schema_version: u32,
    pub admissions_enabled: bool,
    pub default_enabled: bool,
    pub flag_name: &'static str,
    pub source: &'static str,
    pub read_only_available: bool,
    pub cancel_recovery_audit_available: bool,
    pub coordinator_available: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct DeploymentWorkflowRuntime {
    capabilities: DeploymentWorkflowCapabilities,
    artifacts: DeploymentArtifactCas,
    target_locks: Arc<Mutex<BTreeMap<String, Arc<AsyncMutex<()>>>>>,
    cancellations: Arc<Mutex<BTreeMap<String, CancellationToken>>>,
}

fn parse_gate(value: Option<&str>) -> (bool, &'static str) {
    match value.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
        None => (false, "defaultDisabled"),
        Some("1" | "true" | "on" | "enabled") => (true, "environment"),
        Some("0" | "false" | "off" | "disabled") => (false, "environment"),
        Some(_) => (false, "invalidEnvironment"),
    }
}

impl DeploymentWorkflowRuntime {
    pub(crate) fn initialize(shellspan_directory: &Path) -> Result<Self, String> {
        let configured = std::env::var(DEPLOYMENT_WORKFLOW_GATE_ENV).ok();
        Self::for_value(shellspan_directory, configured.as_deref())
    }

    fn for_value(shellspan_directory: &Path, value: Option<&str>) -> Result<Self, String> {
        let (admissions_enabled, source) = parse_gate(value);
        Ok(Self {
            capabilities: DeploymentWorkflowCapabilities {
                schema_version: 1,
                admissions_enabled,
                default_enabled: false,
                flag_name: DEPLOYMENT_WORKFLOW_GATE_ENV,
                source,
                read_only_available: true,
                cancel_recovery_audit_available: true,
                coordinator_available: true,
            },
            artifacts: DeploymentArtifactCas::new(
                shellspan_directory.join("deployment-artifacts"),
            )?,
            target_locks: Arc::new(Mutex::new(BTreeMap::new())),
            cancellations: Arc::new(Mutex::new(BTreeMap::new())),
        })
    }

    #[cfg(test)]
    pub(crate) fn enabled_for_tests(shellspan_directory: &Path) -> Result<Self, String> {
        Self::for_value(shellspan_directory, Some("true"))
    }

    pub(crate) fn capabilities(&self) -> DeploymentWorkflowCapabilities {
        self.capabilities.clone()
    }

    pub(crate) fn artifacts(&self) -> &DeploymentArtifactCas {
        &self.artifacts
    }

    pub(crate) async fn acquire_target_lock(
        &self,
        target_id: &str,
    ) -> Result<OwnedMutexGuard<()>, String> {
        let target_lock = {
            let mut locks = self
                .target_locks
                .lock()
                .map_err(|_| "DEPLOYMENT_WORKFLOW_TARGET_LOCK_UNAVAILABLE".to_string())?;
            locks
                .entry(target_id.to_string())
                .or_insert_with(|| Arc::new(AsyncMutex::new(())))
                .clone()
        };
        Ok(target_lock.lock_owned().await)
    }

    pub(crate) fn register_run_cancellation(
        &self,
        run_id: &str,
    ) -> Result<CancellationToken, String> {
        let mut cancellations = self
            .cancellations
            .lock()
            .map_err(|_| "DEPLOYMENT_WORKFLOW_CANCELLATION_UNAVAILABLE".to_string())?;
        if cancellations.contains_key(run_id) {
            return Err("DEPLOYMENT_WORKFLOW_RUN_ALREADY_ACTIVE".into());
        }
        let token = CancellationToken::new();
        cancellations.insert(run_id.to_string(), token.clone());
        Ok(token)
    }

    pub(crate) fn cancel_run(&self, run_id: &str) -> Result<bool, String> {
        let cancellations = self
            .cancellations
            .lock()
            .map_err(|_| "DEPLOYMENT_WORKFLOW_CANCELLATION_UNAVAILABLE".to_string())?;
        let Some(token) = cancellations.get(run_id) else {
            return Ok(false);
        };
        token.cancel();
        Ok(true)
    }

    pub(crate) fn finish_run(&self, run_id: &str) {
        if let Ok(mut cancellations) = self.cancellations.lock() {
            cancellations.remove(run_id);
        }
    }

    pub(crate) fn ensure(&self, admission: DeploymentWorkflowAdmission) -> Result<(), String> {
        match admission {
            DeploymentWorkflowAdmission::ReadOnly | DeploymentWorkflowAdmission::Continuity => {
                Ok(())
            }
            DeploymentWorkflowAdmission::Mutating if self.capabilities.admissions_enabled => Ok(()),
            DeploymentWorkflowAdmission::Mutating => Err("DEPLOYMENT_WORKFLOW_DISABLED".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gate_is_default_off_and_invalid_values_fail_closed() {
        let directory = tempfile::tempdir().unwrap();
        let missing = DeploymentWorkflowRuntime::for_value(directory.path(), None).unwrap();
        assert!(!missing.capabilities().admissions_enabled);
        assert_eq!(missing.capabilities().source, "defaultDisabled");
        assert!(missing
            .ensure(DeploymentWorkflowAdmission::Mutating)
            .is_err());

        let invalid =
            DeploymentWorkflowRuntime::for_value(directory.path(), Some("sometimes")).unwrap();
        assert!(!invalid.capabilities().admissions_enabled);
        assert_eq!(invalid.capabilities().source, "invalidEnvironment");
    }

    #[test]
    fn enabled_gate_admits_mutations_and_closed_gate_preserves_continuity() {
        let directory = tempfile::tempdir().unwrap();
        let enabled = DeploymentWorkflowRuntime::for_value(directory.path(), Some("true")).unwrap();
        assert!(enabled.capabilities().coordinator_available);
        assert!(enabled
            .ensure(DeploymentWorkflowAdmission::Mutating)
            .is_ok());

        let disabled =
            DeploymentWorkflowRuntime::for_value(directory.path(), Some("false")).unwrap();
        assert!(disabled
            .ensure(DeploymentWorkflowAdmission::ReadOnly)
            .is_ok());
        assert!(disabled
            .ensure(DeploymentWorkflowAdmission::Continuity)
            .is_ok());
        assert!(disabled
            .ensure(DeploymentWorkflowAdmission::Mutating)
            .is_err());
    }

    #[tokio::test]
    async fn target_effect_lock_serializes_the_same_target_only() {
        let directory = tempfile::tempdir().unwrap();
        let runtime = DeploymentWorkflowRuntime::enabled_for_tests(directory.path()).unwrap();
        let production = runtime.acquire_target_lock("production").await.unwrap();
        let other = runtime.acquire_target_lock("staging").await.unwrap();
        drop(other);
        let second_runtime = runtime.clone();
        let acquired = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let observed = acquired.clone();
        let task = tokio::spawn(async move {
            let _guard = second_runtime
                .acquire_target_lock("production")
                .await
                .unwrap();
            observed.store(true, std::sync::atomic::Ordering::SeqCst);
        });
        tokio::task::yield_now().await;
        assert!(!acquired.load(std::sync::atomic::Ordering::SeqCst));
        drop(production);
        task.await.unwrap();
        assert!(acquired.load(std::sync::atomic::Ordering::SeqCst));
    }
}
