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
        None => (true, "defaultEnabled"),
        Some("1" | "true" | "on" | "enabled") => (true, "environment"),
        Some("0" | "false" | "off" | "disabled") => (false, "environment"),
        Some(_) => (false, "invalidEnvironment"),
    }
}

impl DeploymentWorkflowRuntime {
    pub(crate) fn initialize(shellspan_directory: &Path) -> Result<Self, String> {
        let (admissions_enabled, source) = match std::env::var(DEPLOYMENT_WORKFLOW_GATE_ENV) {
            Ok(configured) => parse_gate(Some(&configured)),
            Err(std::env::VarError::NotPresent) => parse_gate(None),
            Err(std::env::VarError::NotUnicode(_)) => (false, "invalidEnvironment"),
        };
        Self::for_gate_decision(shellspan_directory, admissions_enabled, source)
    }

    fn for_gate_decision(
        shellspan_directory: &Path,
        admissions_enabled: bool,
        source: &'static str,
    ) -> Result<Self, String> {
        Ok(Self {
            capabilities: DeploymentWorkflowCapabilities {
                schema_version: 1,
                admissions_enabled,
                default_enabled: true,
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
