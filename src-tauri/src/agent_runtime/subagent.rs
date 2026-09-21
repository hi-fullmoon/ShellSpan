use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[cfg(test)]
use crate::ai::api_key_for_provider;
use crate::ai::AiProviderConfig;
use crate::keychain::CredentialManager;

use super::{
    default_model_tools, drive_agent, AgentCapabilityScope, AgentCompactionManager,
    AgentDriverConfig, AgentDriverSettlement, AgentEntry, AgentFleetState, AgentFleetTargetState,
    AgentHandle, AgentHookBus, AgentInboxLane, AgentInboxMessage, AgentLifecyclePhase,
    AgentMessageSource, AgentRecoveryState, AgentRecoveryStatus, AgentRegistry, AgentSessionEffect,
    AgentSessionEventPayload, AgentSessionSnapshot, AgentSessionStatus, AgentSessionStore,
    AgentSubagentBudget, AgentSubagentInheritance, AgentSubagentModel, AgentSubagentRole,
    AgentSubagentSession, AgentSubagentToolSettlement, AgentToolPipeline, AgentToolResultStatus,
    CreateAgentSessionRequest, ModelRegistry, OrchestrationToolRequest, OrchestrationToolResult,
    OrchestrationToolRuntime,
};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentSubagentSpawnRequest {
    pub(crate) parent_session_id: String,
    pub(crate) goal: String,
    pub(crate) role: AgentSubagentRole,
    pub(crate) inheritance_mode: String,
    pub(crate) target_ids: Vec<String>,
    #[serde(default)]
    pub(crate) budget: Option<AgentSubagentBudget>,
    #[serde(default)]
    pub(crate) continuable: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentChildInputRequest {
    pub(crate) parent_session_id: String,
    pub(crate) child_session_id: String,
    pub(crate) content: String,
    #[serde(default)]
    pub(crate) client_submission_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentChildRequest {
    pub(crate) parent_session_id: String,
    pub(crate) child_session_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentChildInspection {
    pub(crate) snapshot: AgentSessionSnapshot,
    pub(crate) resident: bool,
    pub(crate) descendant_session_ids: Vec<String>,
    pub(crate) tool_calls: u32,
    pub(crate) total_tokens: u64,
    pub(crate) last_summary: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentFleetTargetRequest {
    pub(crate) target_id: String,
    pub(crate) goal: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentFleetPlanRequest {
    pub(crate) parent_session_id: String,
    pub(crate) targets: Vec<AgentFleetTargetRequest>,
    pub(crate) canary_size: u32,
    pub(crate) wave_size: u32,
    pub(crate) failure_threshold: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentFleetControlRequest {
    pub(crate) parent_session_id: String,
    pub(crate) fleet_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentFleetReconcileRequest {
    pub(crate) parent_session_id: String,
    pub(crate) fleet_id: String,
    pub(crate) target_id: String,
    pub(crate) evidence: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentFleetInspection {
    pub(crate) fleet: AgentFleetState,
    pub(crate) failure_threshold: u32,
    pub(crate) failures: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SpawnArguments {
    goal: String,
    role: AgentSubagentRole,
    inheritance_mode: String,
    target_ids: Vec<String>,
    #[serde(default)]
    required_tools: Vec<String>,
    #[serde(default)]
    budget: Option<AgentSubagentBudget>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChildInputArguments {
    child_session_id: String,
    content: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChildArguments {
    child_session_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FleetPlanArguments {
    targets: Vec<AgentFleetTargetRequest>,
    canary_size: u32,
    wave_size: u32,
    failure_threshold: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FleetControlArguments {
    fleet_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FleetReconcileArguments {
    fleet_id: String,
    target_id: String,
    evidence: String,
}

#[derive(Debug, Clone)]
struct FleetTargetRuntime {
    request: AgentFleetTargetRequest,
    task_id: String,
    wave: u32,
    state: String,
    child_session_ids: Vec<String>,
    evidence_refs: Vec<String>,
    recovery: Option<String>,
}

#[derive(Debug, Clone)]
struct FleetRuntime {
    fleet_id: String,
    parent_session_id: String,
    status: String,
    canary_size: u32,
    wave_size: u32,
    failure_threshold: u32,
    failures: u32,
    current_wave: u32,
    total_waves: u32,
    targets: Vec<FleetTargetRuntime>,
}

struct DriverLease(Arc<AgentEntry>);

impl Drop for DriverLease {
    fn drop(&mut self) {
        self.0.release_driver();
    }
}

#[derive(Clone)]
pub(crate) struct SubAgentManager {
    sessions: AgentSessionStore,
    agents: AgentRegistry,
    handles: Arc<Mutex<HashMap<String, Arc<AgentHandle>>>>,
    models: ModelRegistry,
    hooks: AgentHookBus,
    tools: AgentToolPipeline,
    compactions: AgentCompactionManager,
    driver_config: AgentDriverConfig,
    credentials: Arc<Mutex<Option<CredentialManager>>>,
    fleets: Arc<Mutex<HashMap<String, FleetRuntime>>>,
}

struct ChildSettlement {
    snapshot: AgentSessionSnapshot,
    timeout_reason: Option<String>,
}

enum ChildWaitOutcome<T> {
    Settled(T),
    Cancelled,
    TimedOut,
}

async fn wait_for_child<T>(
    wait: impl std::future::Future<Output = T>,
    cancellation: &CancellationToken,
    timeout_ms: u64,
) -> ChildWaitOutcome<T> {
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => ChildWaitOutcome::Cancelled,
        result = tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), wait) => {
            match result {
                Ok(result) => ChildWaitOutcome::Settled(result),
                Err(_) => ChildWaitOutcome::TimedOut,
            }
        }
    }
}

impl SubAgentManager {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        sessions: AgentSessionStore,
        agents: AgentRegistry,
        models: ModelRegistry,
        hooks: AgentHookBus,
        tools: AgentToolPipeline,
        compactions: AgentCompactionManager,
        driver_config: AgentDriverConfig,
    ) -> Self {
        Self {
            sessions,
            agents,
            handles: Arc::new(Mutex::new(HashMap::new())),
            models,
            hooks,
            tools,
            compactions,
            driver_config,
            credentials: Arc::new(Mutex::new(None)),
            fleets: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub(crate) fn set_credentials(&self, credentials: CredentialManager) -> Result<(), String> {
        *self
            .credentials
            .lock()
            .map_err(|_| "subagent credential resolver is unavailable".to_string())? =
            Some(credentials);
        Ok(())
    }

    pub(crate) async fn spawn_from_command(
        &self,
        request: AgentSubagentSpawnRequest,
    ) -> Result<AgentSessionSnapshot, String> {
        let child = self
            .spawn_child(
                &request.parent_session_id,
                request.goal,
                request.role,
                &request.inheritance_mode,
                request.target_ids,
                request.budget.unwrap_or_else(default_subagent_budget),
                request.continuable,
            )
            .await?;
        self.sessions.snapshot(&child)
    }

    pub(crate) async fn send_from_command(
        &self,
        request: AgentChildInputRequest,
    ) -> Result<AgentSessionSnapshot, String> {
        self.send_input(
            &request.parent_session_id,
            &request.child_session_id,
            request.content,
            request.client_submission_id,
        )
        .await?;
        self.sessions.snapshot(&request.child_session_id)
    }

    pub(crate) fn inspect_from_command(
        &self,
        request: AgentChildRequest,
    ) -> Result<AgentChildInspection, String> {
        self.inspect_child(&request.parent_session_id, &request.child_session_id)
    }

    pub(crate) async fn cancel_from_command(
        &self,
        request: AgentChildRequest,
    ) -> Result<AgentSessionSnapshot, String> {
        self.ensure_owned_child(&request.parent_session_id, &request.child_session_id)?;
        self.cancel_tree(&request.child_session_id).await?;
        self.sessions.snapshot(&request.child_session_id)
    }

    pub(crate) async fn cancel_descendants(&self, parent_session_id: &str) -> Result<(), String> {
        let children = self.sessions.child_session_ids(parent_session_id)?;
        for child in children {
            self.cancel_tree(&child).await?;
        }
        Ok(())
    }

    pub(crate) fn plan_fleet(
        &self,
        request: AgentFleetPlanRequest,
    ) -> Result<AgentFleetInspection, String> {
        self.create_fleet(
            &request.parent_session_id,
            request.targets,
            request.canary_size,
            request.wave_size,
            request.failure_threshold,
        )
    }

    pub(crate) async fn start_fleet(
        &self,
        request: AgentFleetControlRequest,
    ) -> Result<AgentFleetInspection, String> {
        self.run_fleet(
            &request.parent_session_id,
            &request.fleet_id,
            CancellationToken::new(),
        )
        .await
    }

    pub(crate) fn pause_fleet(
        &self,
        request: AgentFleetControlRequest,
    ) -> Result<AgentFleetInspection, String> {
        self.set_fleet_status(&request.parent_session_id, &request.fleet_id, "paused")
    }

    pub(crate) async fn abort_fleet(
        &self,
        request: AgentFleetControlRequest,
    ) -> Result<AgentFleetInspection, String> {
        let inspection =
            self.set_fleet_status(&request.parent_session_id, &request.fleet_id, "aborted")?;
        let child_ids = inspection
            .fleet
            .targets
            .iter()
            .flat_map(|target| target.child_session_ids.iter().cloned())
            .collect::<Vec<_>>();
        for child in child_ids {
            let snapshot = self.sessions.snapshot(&child)?;
            if !snapshot.ended {
                self.cancel_tree(&child).await?;
            }
        }
        Ok(inspection)
    }

    pub(crate) fn reconcile_fleet(
        &self,
        request: AgentFleetReconcileRequest,
    ) -> Result<AgentFleetInspection, String> {
        if request.evidence.trim().is_empty() {
            return Err("Fleet reconciliation evidence is required".into());
        }
        self.ensure_fleet_loaded(&request.parent_session_id, &request.fleet_id)?;
        let evidence_id = format!("fleet-reconcile-{}", Uuid::new_v4().simple());
        let mut fleets = self
            .fleets
            .lock()
            .map_err(|_| "Fleet coordinator is unavailable".to_string())?;
        let fleet = fleets
            .get_mut(&request.fleet_id)
            .ok_or_else(|| "Fleet was not found".to_string())?;
        ensure_fleet_owner(fleet, &request.parent_session_id)?;
        let target = fleet
            .targets
            .iter_mut()
            .find(|target| target.request.target_id == request.target_id)
            .ok_or_else(|| "Fleet target was not found".to_string())?;
        target.evidence_refs.push(evidence_id.clone());
        target.recovery = None;
        if target.state == "uncertain" {
            target.state = "reconciled".into();
        }
        let inspection = fleet_inspection(fleet);
        drop(fleets);
        self.sessions.append_batch(
            &request.parent_session_id,
            vec![
                super::AgentScopedPayload {
                    turn_id: None,
                    step_id: None,
                    payload: AgentSessionEventPayload::TaskEvidence {
                        evidence_id,
                        kind: "fleet-reconciliation".into(),
                        summary: request.evidence,
                    },
                },
                super::AgentScopedPayload {
                    turn_id: None,
                    step_id: None,
                    payload: fleet_task_state(&inspection.fleet),
                },
            ],
        )?;
        Ok(inspection)
    }

    fn create_fleet(
        &self,
        parent_session_id: &str,
        targets: Vec<AgentFleetTargetRequest>,
        canary_size: u32,
        wave_size: u32,
        failure_threshold: u32,
    ) -> Result<AgentFleetInspection, String> {
        let parent = self.sessions.snapshot(parent_session_id)?;
        if parent.ended || parent.status.is_terminal() {
            return Err("terminal parent Agent Session cannot plan a Fleet".into());
        }
        if targets.is_empty()
            || targets.len() > 128
            || canary_size == 0
            || wave_size == 0
            || canary_size as usize > targets.len()
            || failure_threshold as usize > targets.len()
        {
            return Err("Fleet policy is outside native bounds".into());
        }
        let mut target_ids = HashSet::new();
        for target in &targets {
            if target.goal.trim().is_empty() || !target_ids.insert(target.target_id.clone()) {
                return Err("Fleet targets must be unique and have non-empty goals".into());
            }
            delegated_scope(
                &parent,
                AgentSubagentRole::Operator,
                std::slice::from_ref(&target.target_id),
            )?;
            self.sessions.target_by_id(&target.target_id)?;
        }
        let remaining = targets.len().saturating_sub(canary_size as usize);
        let total_waves = 1_u32.saturating_add(
            remaining
                .saturating_add(wave_size as usize - 1)
                .checked_div(wave_size as usize)
                .unwrap_or(0) as u32,
        );
        let fleet_id = format!("fleet-{}", Uuid::new_v4().simple());
        let targets = targets
            .into_iter()
            .enumerate()
            .map(|(index, request)| FleetTargetRuntime {
                task_id: format!("fleet-task-{}", Uuid::new_v4().simple()),
                wave: if index < canary_size as usize {
                    1
                } else {
                    2 + ((index - canary_size as usize) / wave_size as usize) as u32
                },
                request,
                state: "planned".into(),
                child_session_ids: Vec::new(),
                evidence_refs: Vec::new(),
                recovery: None,
            })
            .collect();
        let fleet = FleetRuntime {
            fleet_id: fleet_id.clone(),
            parent_session_id: parent_session_id.into(),
            status: "planned".into(),
            canary_size,
            wave_size,
            failure_threshold,
            failures: 0,
            current_wave: 0,
            total_waves,
            targets,
        };
        let inspection = fleet_inspection(&fleet);
        self.fleets
            .lock()
            .map_err(|_| "Fleet coordinator is unavailable".to_string())?
            .insert(fleet_id, fleet);
        self.sessions.append(
            parent_session_id,
            None,
            None,
            fleet_task_state(&inspection.fleet),
        )?;
        Ok(inspection)
    }

    fn set_fleet_status(
        &self,
        parent_session_id: &str,
        fleet_id: &str,
        status: &str,
    ) -> Result<AgentFleetInspection, String> {
        self.ensure_fleet_loaded(parent_session_id, fleet_id)?;
        let mut fleets = self
            .fleets
            .lock()
            .map_err(|_| "Fleet coordinator is unavailable".to_string())?;
        let fleet = fleets
            .get_mut(fleet_id)
            .ok_or_else(|| "Fleet was not found".to_string())?;
        ensure_fleet_owner(fleet, parent_session_id)?;
        if matches!(fleet.status.as_str(), "completed" | "aborted" | "failed") {
            return Err("terminal Fleet cannot change state".into());
        }
        fleet.status = status.into();
        let inspection = fleet_inspection(fleet);
        drop(fleets);
        self.sessions.append(
            parent_session_id,
            None,
            None,
            fleet_task_state(&inspection.fleet),
        )?;
        Ok(inspection)
    }

    async fn run_fleet(
        &self,
        parent_session_id: &str,
        fleet_id: &str,
        cancellation: CancellationToken,
    ) -> Result<AgentFleetInspection, String> {
        self.ensure_fleet_loaded(parent_session_id, fleet_id)?;
        {
            let mut fleets = self
                .fleets
                .lock()
                .map_err(|_| "Fleet coordinator is unavailable".to_string())?;
            let fleet = fleets
                .get_mut(fleet_id)
                .ok_or_else(|| "Fleet was not found".to_string())?;
            ensure_fleet_owner(fleet, parent_session_id)?;
            if matches!(fleet.status.as_str(), "completed" | "aborted" | "failed") {
                return Ok(fleet_inspection(fleet));
            }
            fleet.status = "running".into();
        }
        loop {
            let next = {
                let fleets = self
                    .fleets
                    .lock()
                    .map_err(|_| "Fleet coordinator is unavailable".to_string())?;
                let fleet = fleets
                    .get(fleet_id)
                    .ok_or_else(|| "Fleet was not found".to_string())?;
                if fleet.status != "running" {
                    return Ok(fleet_inspection(fleet));
                }
                fleet
                    .targets
                    .iter()
                    .position(|target| target.state == "planned")
                    .map(|index| (index, fleet.targets[index].clone()))
            };
            let Some((index, target)) = next else {
                let mut fleets = self
                    .fleets
                    .lock()
                    .map_err(|_| "Fleet coordinator is unavailable".to_string())?;
                let fleet = fleets
                    .get_mut(fleet_id)
                    .ok_or_else(|| "Fleet was not found".to_string())?;
                fleet.status = if fleet.failures > fleet.failure_threshold {
                    "failed"
                } else {
                    "completed"
                }
                .into();
                let inspection = fleet_inspection(fleet);
                drop(fleets);
                self.sessions.append(
                    parent_session_id,
                    None,
                    None,
                    fleet_task_state(&inspection.fleet),
                )?;
                return Ok(inspection);
            };
            if cancellation.is_cancelled() {
                return self.set_fleet_status(parent_session_id, fleet_id, "paused");
            }
            {
                let mut fleets = self
                    .fleets
                    .lock()
                    .map_err(|_| "Fleet coordinator is unavailable".to_string())?;
                let fleet = fleets.get_mut(fleet_id).expect("Fleet remains registered");
                fleet.current_wave = target.wave;
                fleet.targets[index].state = "exploring".into();
            }
            let mut failed = None;
            for role in [
                AgentSubagentRole::Explorer,
                AgentSubagentRole::Operator,
                AgentSubagentRole::Verifier,
                AgentSubagentRole::Reviewer,
            ] {
                let goal = fleet_role_goal(role, &target.request.goal);
                let child = self
                    .spawn_child(
                        parent_session_id,
                        goal,
                        role,
                        "safePrefix",
                        vec![target.request.target_id.clone()],
                        fleet_role_budget(role),
                        false,
                    )
                    .await?;
                {
                    let mut fleets = self
                        .fleets
                        .lock()
                        .map_err(|_| "Fleet coordinator is unavailable".to_string())?;
                    let fleet = fleets.get_mut(fleet_id).expect("Fleet remains registered");
                    fleet.targets[index].child_session_ids.push(child.clone());
                    fleet.targets[index].state = match role {
                        AgentSubagentRole::Explorer => "exploring",
                        AgentSubagentRole::Operator => "operating",
                        AgentSubagentRole::Verifier => "verifying",
                        AgentSubagentRole::Reviewer => "reviewing",
                        _ => unreachable!(),
                    }
                    .into();
                }
                let settlement = self
                    .settle_fleet_child(parent_session_id, &child, cancellation.clone())
                    .await?;
                if settlement.status != AgentSessionStatus::Completed {
                    failed = Some(format!(
                        "{:?} child settled as {:?}",
                        role, settlement.status
                    ));
                    break;
                }
                if role == AgentSubagentRole::Verifier {
                    let evidence_id = format!("fleet-verifier-{}", Uuid::new_v4().simple());
                    self.sessions.append(
                        parent_session_id,
                        None,
                        None,
                        AgentSessionEventPayload::TaskEvidence {
                            evidence_id: evidence_id.clone(),
                            kind: "independent-fleet-verification".into(),
                            summary: format!(
                                "Verifier Session {child} independently completed target {}",
                                target.request.target_id
                            ),
                        },
                    )?;
                    let mut fleets = self
                        .fleets
                        .lock()
                        .map_err(|_| "Fleet coordinator is unavailable".to_string())?;
                    fleets
                        .get_mut(fleet_id)
                        .expect("Fleet remains registered")
                        .targets[index]
                        .evidence_refs
                        .push(evidence_id);
                }
            }
            let inspection = {
                let mut fleets = self
                    .fleets
                    .lock()
                    .map_err(|_| "Fleet coordinator is unavailable".to_string())?;
                let fleet = fleets.get_mut(fleet_id).expect("Fleet remains registered");
                if let Some(reason) = failed {
                    fleet.failures = fleet.failures.saturating_add(1);
                    fleet.targets[index].state = "failed".into();
                    fleet.targets[index].recovery = Some(reason);
                    if fleet.failures > fleet.failure_threshold {
                        fleet.status = "failed".into();
                    }
                } else {
                    fleet.targets[index].state = "completed".into();
                }
                fleet_inspection(fleet)
            };
            self.sessions.append(
                parent_session_id,
                None,
                None,
                fleet_task_state(&inspection.fleet),
            )?;
            if inspection.fleet.status.as_deref() == Some("failed") {
                return Ok(inspection);
            }
        }
    }

    async fn settle_fleet_child(
        &self,
        parent_session_id: &str,
        child_session_id: &str,
        cancellation: CancellationToken,
    ) -> Result<AgentSessionSnapshot, String> {
        let settlement = self
            .await_settlement(child_session_id, cancellation)
            .await?;
        let mut snapshot = settlement.snapshot;
        if snapshot.status == AgentSessionStatus::Idle {
            let incomplete = last_turn_incomplete(&self.sessions.all_events(child_session_id)?);
            snapshot = self.sessions.terminate(
                child_session_id,
                if incomplete {
                    AgentSessionStatus::Failed
                } else {
                    AgentSessionStatus::Completed
                },
                if incomplete {
                    "fleetRolePlanIncomplete"
                } else {
                    "fleetRoleTurnCompleted"
                }
                .into(),
            )?;
        }
        let subagent = snapshot
            .header
            .subagent
            .clone()
            .ok_or_else(|| "Fleet child lost subagent metadata".to_string())?;
        let events = self.sessions.all_events(child_session_id)?;
        let summary = settlement
            .timeout_reason
            .or_else(|| assistant_summary(&events))
            .unwrap_or_else(|| format!("Fleet child settled as {:?}", snapshot.status));
        self.sessions.commit_subagent_settlement(
            parent_session_id,
            &subagent.descriptor_id,
            &format!("settlement-{}", Uuid::new_v4().simple()),
            child_session_id,
            snapshot.status,
            summary,
            Vec::new(),
            false,
            None,
        )?;
        let handle = self
            .handles
            .lock()
            .map_err(|_| "subagent handle registry is unavailable".to_string())?
            .remove(child_session_id);
        if let Some(handle) = handle {
            handle.dispose().await?;
        }
        Ok(snapshot)
    }

    fn ensure_fleet_loaded(&self, parent_session_id: &str, fleet_id: &str) -> Result<(), String> {
        if self
            .fleets
            .lock()
            .map_err(|_| "Fleet coordinator is unavailable".to_string())?
            .contains_key(fleet_id)
        {
            return Ok(());
        }
        let fleet = self
            .sessions
            .all_events(parent_session_id)?
            .iter()
            .rev()
            .find_map(|event| match &event.payload {
                AgentSessionEventPayload::TaskState {
                    fleet: Some(state), ..
                } if state.fleet_id.as_deref() == Some(fleet_id) => Some(state.clone()),
                _ => None,
            })
            .ok_or_else(|| "Fleet was not found in the durable Session log".to_string())?;
        let canary_size = fleet
            .canary_size
            .ok_or_else(|| "Fleet log is missing canary policy".to_string())?;
        let wave_size = fleet
            .wave_size
            .ok_or_else(|| "Fleet log is missing wave policy".to_string())?;
        let failure_threshold = fleet
            .failure_threshold
            .ok_or_else(|| "Fleet log is missing failure policy".to_string())?;
        let targets = fleet
            .targets
            .into_iter()
            .map(|target| FleetTargetRuntime {
                request: AgentFleetTargetRequest {
                    target_id: target.target_id,
                    goal: target.goal,
                },
                task_id: target.task_id,
                wave: target.wave,
                state: target.state,
                child_session_ids: target.child_session_ids,
                evidence_refs: target.evidence_refs,
                recovery: target.recovery,
            })
            .collect::<Vec<_>>();
        let restored = FleetRuntime {
            fleet_id: fleet_id.into(),
            parent_session_id: parent_session_id.into(),
            status: fleet.status.unwrap_or_else(|| "paused".into()),
            canary_size,
            wave_size,
            failure_threshold,
            failures: fleet.failures.unwrap_or(0),
            current_wave: fleet.wave,
            total_waves: fleet.total_waves,
            targets,
        };
        self.fleets
            .lock()
            .map_err(|_| "Fleet coordinator is unavailable".to_string())?
            .insert(fleet_id.into(), restored);
        Ok(())
    }

    async fn spawn_child(
        &self,
        parent_session_id: &str,
        goal: String,
        role: AgentSubagentRole,
        inheritance_mode: &str,
        target_ids: Vec<String>,
        mut budget: AgentSubagentBudget,
        continuable: bool,
    ) -> Result<String, String> {
        if goal.trim().is_empty() {
            return Err("subagent goal cannot be empty".into());
        }
        let parent = self.sessions.snapshot(parent_session_id)?;
        if parent.ended || parent.status.is_terminal() {
            return Err("terminal parent Agent Session cannot spawn a child".into());
        }
        if target_ids.is_empty() {
            return Err("subagent target scope cannot be empty".into());
        }
        if !continuable {
            budget.max_turns = 1;
        }
        let parent_entry = self
            .agents
            .get(parent_session_id)?
            .ok_or_else(|| "parent Agent Session is not resident".to_string())?;
        let depth = parent
            .header
            .subagent
            .as_ref()
            .map_or(1, |subagent| subagent.depth.saturating_add(1));
        if depth > 16 {
            return Err("subagent nesting depth exceeds the native limit".into());
        }
        let capability_scope = delegated_scope(&parent, role, &target_ids)?;
        let target_scope = target_ids
            .iter()
            .map(|target_id| self.sessions.target_by_id(target_id))
            .collect::<Result<Vec<_>, _>>()?;
        let inheritance = match inheritance_mode {
            "blank" => AgentSubagentInheritance::Blank,
            "safePrefix" => AgentSubagentInheritance::SafePrefix {
                parent_through_seq: self.sessions.safe_inheritance_boundary(parent_session_id)?,
            },
            _ => return Err("subagent inheritanceMode is invalid".into()),
        };
        let descriptor_id = format!("descriptor-{}", Uuid::new_v4().simple());
        let child_session_id = format!("session-{}", Uuid::new_v4().simple());
        let child_task_id = format!("task-{}", Uuid::new_v4().simple());
        let parent_model = parent_entry.model()?;
        let mut provider = provider_descriptor(&parent_model.provider);
        provider.route_revision = parent_entry.prepare_model()?.route.revision.into();
        let metadata = AgentSubagentSession {
            descriptor_id: descriptor_id.clone(),
            parent_task_id: parent.header.task_id.clone(),
            role,
            continuable,
            depth,
            inheritance: inheritance.clone(),
            capability_scope: capability_scope.clone(),
            target_scope: target_scope.clone(),
            budget: budget.clone(),
            provider,
        };
        let request = CreateAgentSessionRequest {
            session_id: child_session_id.clone(),
            task_id: child_task_id,
            goal: goal.clone(),
            parent_session_id: Some(parent_session_id.into()),
            continued_from_session_id: None,
            target: target_scope.first().cloned(),
            permission_mode: parent.header.permission_mode,
            execution_surface: parent.header.execution_surface,
            success_criteria: parent.header.success_criteria.clone(),
            capability_scope: Some(capability_scope.clone()),
            subagent: Some(metadata),
        };
        self.sessions.create_child_with_descriptor(
            parent_session_id,
            request,
            AgentSessionEventPayload::SubagentDescriptor {
                descriptor_id,
                child_session_id: child_session_id.clone(),
                parent_session_id: parent_session_id.into(),
                parent_task_id: parent.header.task_id,
                role,
                continuable,
                depth,
                inheritance,
                capability_scope,
                target_scope,
                budget,
            },
        )?;
        let handle = Arc::new(self.agents.attach(
            self.sessions.clone(),
            child_session_id.clone(),
            parent_model.provider.clone(),
            Arc::clone(&parent_model.adapter),
        )?);
        *handle
            .entry()
            .model_registry
            .lock()
            .map_err(|_| "MODEL_REGISTRY_UNAVAILABLE")? = Some(self.models.clone());
        self.agents.set_owner(&handle.entry(), &parent_entry)?;
        self.handles
            .lock()
            .map_err(|_| "subagent handle registry is unavailable".to_string())?
            .insert(child_session_id.clone(), handle);
        self.sessions.enqueue(
            &child_session_id,
            AgentInboxLane::NextTurn,
            AgentInboxMessage {
                images: Vec::new(),
                message_id: format!("delegation-{}", Uuid::new_v4().simple()),
                client_submission_id: None,
                content: role_prompt(role, &goal),
                source: AgentMessageSource::session_reference(parent_session_id.into()),
                terminal_context: None,
            },
        )?;
        self.wake(&child_session_id)?;
        Ok(child_session_id)
    }

    async fn send_input(
        &self,
        parent_session_id: &str,
        child_session_id: &str,
        content: String,
        client_submission_id: Option<String>,
    ) -> Result<(), String> {
        let child = self.ensure_owned_child(parent_session_id, child_session_id)?;
        let subagent = child
            .header
            .subagent
            .as_ref()
            .ok_or_else(|| "child Session lost subagent metadata".to_string())?;
        if !subagent.continuable {
            return Err("one-shot child Agent cannot accept continuation input".into());
        }
        if child.ended || child.status.is_terminal() {
            return Err("terminal child Agent cannot be continued".into());
        }
        let events = self.sessions.all_events(child_session_id)?;
        if !child_has_remaining_budget(
            &subagent.budget,
            &events,
            self.driver_config.max_turns_per_session,
            super::driver::current_unix_ms()?,
        ) {
            return Err("subagentBudgetExhausted: cumulative child budget is exhausted; inspect its saved progress and report or take over the remaining work. Do not spawn a replacement to reset this budget.".into());
        }
        self.ensure_resident(child_session_id)?;
        self.sessions.enqueue(
            child_session_id,
            AgentInboxLane::NextTurn,
            AgentInboxMessage {
                images: Vec::new(),
                message_id: client_submission_id
                    .clone()
                    .unwrap_or_else(|| format!("child-input-{}", Uuid::new_v4().simple())),
                client_submission_id: client_submission_id.clone(),
                content,
                source: if client_submission_id.is_some() {
                    AgentMessageSource::user()
                } else {
                    AgentMessageSource::session_reference(parent_session_id.into())
                },
                terminal_context: None,
            },
        )?;
        self.wake(child_session_id)
    }

    fn ensure_resident(&self, child_session_id: &str) -> Result<Arc<AgentEntry>, String> {
        if let Some(entry) = self.agents.get(child_session_id)? {
            return Ok(entry);
        }
        let snapshot = self.sessions.snapshot(child_session_id)?;
        let subagent = snapshot
            .header
            .subagent
            .ok_or_else(|| "Session is not a subagent".to_string())?;
        let provider = self.models.restore_selection(&subagent.provider)?;
        #[cfg(test)]
        let credentials = self
            .credentials
            .lock()
            .map_err(|_| "subagent credential resolver is unavailable".to_string())?
            .clone();
        #[cfg(not(test))]
        let api_key = None;
        #[cfg(test)]
        let api_key = if self.models.uses_route_store() {
            None
        } else {
            match credentials {
                Some(credentials) => api_key_for_provider(&credentials, &provider)?,
                None if provider.requires_api_key => {
                    return Err(
                        "cold child resume requires the configured credential resolver".into(),
                    )
                }
                None => None,
            }
        };
        let adapter = self.models.resolve(provider.clone(), api_key)?;
        let handle = Arc::new(self.agents.attach(
            self.sessions.clone(),
            child_session_id.into(),
            provider,
            adapter,
        )?);
        let entry = handle.entry();
        *entry
            .model_registry
            .lock()
            .map_err(|_| "MODEL_REGISTRY_UNAVAILABLE")? = Some(self.models.clone());
        let parent_id = snapshot
            .header
            .parent_session_id
            .as_deref()
            .ok_or("child owner missing")?;
        let parent = self
            .agents
            .get(parent_id)?
            .ok_or("child owner is not live")?;
        self.agents.set_owner(&entry, &parent)?;
        self.handles
            .lock()
            .map_err(|_| "subagent handle registry is unavailable".to_string())?
            .insert(child_session_id.into(), handle);
        Ok(entry)
    }

    fn ensure_owned_child(
        &self,
        parent_session_id: &str,
        child_session_id: &str,
    ) -> Result<AgentSessionSnapshot, String> {
        let child = self.sessions.snapshot(child_session_id)?;
        if child.header.parent_session_id.as_deref() != Some(parent_session_id) {
            return Err("parent Session does not own the requested child".into());
        }
        Ok(child)
    }

    fn inspect_child(
        &self,
        parent_session_id: &str,
        child_session_id: &str,
    ) -> Result<AgentChildInspection, String> {
        let snapshot = self.ensure_owned_child(parent_session_id, child_session_id)?;
        let events = self.sessions.all_events(child_session_id)?;
        let tool_calls = super::tool_pipeline::admitted_tool_calls(&events);
        let total_tokens = events
            .iter()
            .filter_map(|event| match event.payload {
                AgentSessionEventPayload::RequestUsage { usage, .. } => usage.total_tokens,
                _ => None,
            })
            .fold(0_u64, u64::saturating_add);
        Ok(AgentChildInspection {
            snapshot,
            resident: self.agents.get(child_session_id)?.is_some(),
            descendant_session_ids: self.descendants_postorder(child_session_id)?,
            tool_calls,
            total_tokens,
            last_summary: assistant_summary(&events),
        })
    }

    async fn await_settlement(
        &self,
        child_session_id: &str,
        cancellation: CancellationToken,
    ) -> Result<ChildSettlement, String> {
        let entry = self
            .agents
            .get(child_session_id)?
            .ok_or_else(|| "child Agent is not resident".to_string())?;
        let timeout_ms = entry
            .subagent
            .as_ref()
            .map(|subagent| subagent.budget.timeout_ms)
            .unwrap_or(60_000);
        let wait = async {
            loop {
                entry.await_idle().await;
                let snapshot = self.sessions.snapshot(child_session_id)?;
                if snapshot.ended
                    || snapshot.status.is_terminal()
                    || (snapshot.status == AgentSessionStatus::Idle
                        && snapshot.inbox.next_turn.is_empty()
                        && snapshot.inbox.next_step.is_empty())
                {
                    return Ok::<_, String>(snapshot);
                }
                tokio::task::yield_now().await;
            }
        };
        let created = self
            .sessions
            .snapshot(child_session_id)?
            .header
            .created_at_unix_ms;
        let remaining_ms =
            timeout_ms.saturating_sub(super::driver::current_unix_ms()?.saturating_sub(created));
        match wait_for_child(wait, &cancellation, remaining_ms).await {
            ChildWaitOutcome::Settled(snapshot) => Ok(ChildSettlement {
                snapshot: snapshot?,
                timeout_reason: None,
            }),
            ChildWaitOutcome::Cancelled => {
                self.cancel_tree(child_session_id).await?;
                Ok(ChildSettlement {
                    snapshot: self.sessions.snapshot(child_session_id)?,
                    timeout_reason: None,
                })
            }
            ChildWaitOutcome::TimedOut => {
                self.cancel_tree(child_session_id).await?;
                Ok(ChildSettlement {
                    snapshot: self.sessions.snapshot(child_session_id)?,
                    timeout_reason: (!cancellation.is_cancelled())
                        .then(|| format!("subagentTimeout: child exceeded {timeout_ms} ms")),
                })
            }
        }
    }

    fn wake(&self, session_id: &str) -> Result<(), String> {
        let Some(entry) = self.agents.get(session_id)? else {
            return Ok(());
        };
        if !entry.try_acquire_driver()? {
            return Ok(());
        }
        let sessions = self.sessions.clone();
        let hooks = self.hooks.clone();
        let tools = self.tools.clone();
        let compactions = self.compactions.clone();
        let config = self.driver_config;
        tauri::async_runtime::spawn(async move {
            loop {
                let lease = DriverLease(Arc::clone(&entry));
                let settlement = drive_agent(
                    sessions.clone(),
                    Arc::clone(&entry),
                    hooks.clone(),
                    tools.clone(),
                    compactions.clone(),
                    config,
                )
                .await;
                drop(lease);
                if settlement == AgentDriverSettlement::Waiting {
                    match tools.wait_for_expiry(&entry).await {
                        Ok(true) if !entry.cancellation().is_cancelled() => {
                            if entry.try_acquire_driver().unwrap_or(false) {
                                continue;
                            }
                        }
                        Ok(_) => {}
                        Err(error) => {
                            let _ = sessions.terminate(
                                &entry.session_id,
                                AgentSessionStatus::Failed,
                                format!("approvalExpiryFailure: {error}"),
                            );
                        }
                    }
                    break;
                }
                if settlement != AgentDriverSettlement::Idle || entry.cancellation().is_cancelled()
                {
                    break;
                }
                let has_work = sessions
                    .snapshot(&entry.session_id)
                    .map(|snapshot| {
                        !snapshot.inbox.next_turn.is_empty() || !snapshot.inbox.next_step.is_empty()
                    })
                    .unwrap_or(false);
                if !has_work || !entry.try_acquire_driver().unwrap_or(false) {
                    break;
                }
            }
        });
        Ok(())
    }

    fn descendants_postorder(&self, session_id: &str) -> Result<Vec<String>, String> {
        fn visit(
            sessions: &AgentSessionStore,
            session_id: &str,
            visited: &mut HashSet<String>,
            output: &mut Vec<String>,
        ) -> Result<(), String> {
            for child in sessions.child_session_ids(session_id)? {
                if visited.insert(child.clone()) {
                    visit(sessions, &child, visited, output)?;
                    output.push(child);
                }
            }
            Ok(())
        }
        let mut output = Vec::new();
        visit(&self.sessions, session_id, &mut HashSet::new(), &mut output)?;
        Ok(output)
    }

    async fn cancel_tree(&self, child_session_id: &str) -> Result<(), String> {
        let mut order = self.descendants_postorder(child_session_id)?;
        order.push(child_session_id.into());
        for session_id in order {
            let handle = self
                .handles
                .lock()
                .map_err(|_| "subagent handle registry is unavailable".to_string())?
                .remove(&session_id);
            if let Some(handle) = handle {
                self.tools.cancel_session(&handle.entry())?;
                self.tools.await_pending_executions(&handle.entry()).await?;
                handle.dispose().await?;
            } else {
                let snapshot = self.sessions.snapshot(&session_id)?;
                if !snapshot.ended {
                    self.sessions.cancel(&session_id)?;
                }
            }
            if let Some(parent_session_id) = self
                .sessions
                .snapshot(&session_id)?
                .header
                .parent_session_id
            {
                let descriptor_id = self
                    .sessions
                    .snapshot(&session_id)?
                    .header
                    .subagent
                    .map(|subagent| subagent.descriptor_id)
                    .unwrap_or_else(|| "detached".into());
                let parent = self.sessions.snapshot(&parent_session_id)?;
                if !parent.ended {
                    self.sessions.append(
                        &parent_session_id,
                        None,
                        None,
                        AgentSessionEventPayload::SubagentDetached {
                            descriptor_id,
                            child_session_id: session_id,
                            reason: "cancelCascade".into(),
                        },
                    )?;
                }
            }
        }
        Ok(())
    }

    async fn release_continuable(&self, child_session_id: &str) -> Result<(), String> {
        if !self
            .sessions
            .child_session_ids(child_session_id)?
            .is_empty()
        {
            return Ok(());
        }
        let handle = self
            .handles
            .lock()
            .map_err(|_| "subagent handle registry is unavailable".to_string())?
            .remove(child_session_id);
        if let Some(handle) = handle {
            handle.suspend().await?;
            let child = self.sessions.snapshot(child_session_id)?;
            if let (Some(parent), Some(subagent)) =
                (child.header.parent_session_id, child.header.subagent)
            {
                self.sessions.append(
                    &parent,
                    None,
                    None,
                    AgentSessionEventPayload::SubagentDetached {
                        descriptor_id: subagent.descriptor_id,
                        child_session_id: child_session_id.into(),
                        reason: "idleContinuableReleased".into(),
                    },
                )?;
            }
        }
        Ok(())
    }

    async fn settle_spawn(
        &self,
        request: &OrchestrationToolRequest,
        child_session_id: &str,
        continuable: bool,
        cancellation: CancellationToken,
    ) -> Result<OrchestrationToolResult, String> {
        let child = self.await_settlement(child_session_id, cancellation).await;
        let settlement = match child {
            Ok(snapshot) => snapshot,
            Err(error) => {
                return Ok(OrchestrationToolResult {
                    status: AgentToolResultStatus::Failed,
                    summary: error,
                    data: Some(json!({ "childSessionId": child_session_id })),
                    evidence_refs: Vec::new(),
                    result_committed: false,
                })
            }
        };
        let timeout_reason = settlement.timeout_reason;
        let mut snapshot = settlement.snapshot;
        let incomplete = last_turn_incomplete(&self.sessions.all_events(child_session_id)?);
        if !continuable && snapshot.status == AgentSessionStatus::Idle {
            snapshot = self.sessions.terminate(
                child_session_id,
                if incomplete {
                    AgentSessionStatus::Failed
                } else {
                    AgentSessionStatus::Completed
                },
                if incomplete {
                    "oneShotPlanIncomplete"
                } else {
                    "oneShotTurnCompleted"
                }
                .into(),
            )?;
        }
        let events = self.sessions.all_events(child_session_id)?;
        let mut summary = assistant_summary(&events)
            .unwrap_or_else(|| format!("Child Agent settled with status {:?}", snapshot.status));
        let stop_reason = timeout_reason
            .as_deref()
            .or_else(|| child_stop_reason(&events));
        if let Some(reason) = stop_reason {
            let report = events
                .iter()
                .rev()
                .find_map(|event| match &event.payload {
                    AgentSessionEventPayload::AssistantMessage { content, .. } => {
                        let text = super::assistant_content_text(content);
                        (!text.trim().is_empty()).then_some(text)
                    }
                    _ => None,
                })
                .unwrap_or_else(|| "No final report; inspect saved tool results and plan.".into());
            summary = format!("Partial child result: {reason}. Progress is saved; this is not task completion. Latest report: {report}");
        }
        let tool_status = if timeout_reason.is_some() {
            AgentToolResultStatus::TimedOut
        } else {
            match snapshot.status {
                AgentSessionStatus::Idle if incomplete => AgentToolResultStatus::Failed,
                AgentSessionStatus::Idle | AgentSessionStatus::Completed => {
                    AgentToolResultStatus::Completed
                }
                AgentSessionStatus::Cancelled => AgentToolResultStatus::Cancelled,
                AgentSessionStatus::Failed => AgentToolResultStatus::Failed,
                AgentSessionStatus::Running | AgentSessionStatus::Waiting => {
                    AgentToolResultStatus::Failed
                }
            }
        };
        let subagent = snapshot
            .header
            .subagent
            .clone()
            .ok_or_else(|| "child Session lost subagent metadata".to_string())?;
        let can_continue = continuable
            && timeout_reason.is_none()
            && snapshot.status == AgentSessionStatus::Idle
            && !snapshot.ended
            && child_has_remaining_budget(
                &subagent.budget,
                &events,
                self.driver_config.max_turns_per_session,
                super::driver::current_unix_ms()?,
            );
        let data = child_handoff_data(
            &snapshot,
            &events,
            can_continue,
            super::driver::current_unix_ms()?,
            timeout_reason.as_deref(),
        )?;
        let parent_closing = self
            .agents
            .get(&request.parent_session_id)?
            .is_some_and(|entry| {
                matches!(
                    entry.phase(),
                    Ok(AgentLifecyclePhase::Stopping | AgentLifecyclePhase::Disposed)
                )
            });
        self.sessions.commit_subagent_settlement(
            &request.parent_session_id,
            &subagent.descriptor_id,
            &format!("settlement-{}", Uuid::new_v4().simple()),
            child_session_id,
            snapshot.status,
            summary.clone(),
            Vec::new(),
            parent_closing,
            Some(AgentSubagentToolSettlement {
                turn_id: request.turn_id.clone(),
                step_id: request.step_id.clone(),
                call_id: request.call.call_id.clone(),
                name: request.call.name.clone(),
                status: tool_status,
                data: Some(data.clone()),
            }),
        )?;
        if continuable && snapshot.status == AgentSessionStatus::Idle {
            self.release_continuable(child_session_id).await?;
        } else if !continuable {
            let handle = self
                .handles
                .lock()
                .map_err(|_| "subagent handle registry is unavailable".to_string())?
                .remove(child_session_id);
            if let Some(handle) = handle {
                handle.dispose().await?;
            }
        }
        Ok(OrchestrationToolResult {
            status: tool_status,
            summary,
            data: Some(data),
            evidence_refs: Vec::new(),
            result_committed: true,
        })
    }
}

#[async_trait]
impl OrchestrationToolRuntime for SubAgentManager {
    async fn execute(
        &self,
        request: OrchestrationToolRequest,
        cancellation: CancellationToken,
    ) -> Result<OrchestrationToolResult, String> {
        match request.call.name.as_str() {
            "spawn_one_shot_agent" | "spawn_continuable_agent" => {
                let arguments: SpawnArguments =
                    serde_json::from_value(request.call.arguments.clone())
                        .map_err(|error| format!("invalid subagent spawn arguments: {error}"))?;
                let continuable = request.call.name == "spawn_continuable_agent";
                let parent = self.sessions.snapshot(&request.parent_session_id)?;
                let scope = delegated_scope(&parent, arguments.role, &arguments.target_ids)?;
                let mut child_header = parent.header.clone();
                child_header.target = arguments
                    .target_ids
                    .first()
                    .map(|id| self.sessions.target_by_id(id))
                    .transpose()?;
                validate_required_tools(&child_header, &scope, &arguments.required_tools)?;
                let child_session_id = self
                    .spawn_child(
                        &request.parent_session_id,
                        arguments.goal,
                        arguments.role,
                        &arguments.inheritance_mode,
                        arguments.target_ids,
                        arguments.budget.unwrap_or_else(default_subagent_budget),
                        continuable,
                    )
                    .await?;
                self.settle_spawn(&request, &child_session_id, continuable, cancellation)
                    .await
            }
            "send_child_input" => {
                let arguments: ChildInputArguments =
                    serde_json::from_value(request.call.arguments.clone())
                        .map_err(|error| format!("invalid child input arguments: {error}"))?;
                self.send_input(
                    &request.parent_session_id,
                    &arguments.child_session_id,
                    arguments.content,
                    None,
                )
                .await?;
                self.settle_spawn(&request, &arguments.child_session_id, true, cancellation)
                    .await
            }
            "inspect_child_agent" => {
                let arguments: ChildArguments =
                    serde_json::from_value(request.call.arguments.clone())
                        .map_err(|error| format!("invalid child inspection arguments: {error}"))?;
                let inspection =
                    self.inspect_child(&request.parent_session_id, &arguments.child_session_id)?;
                Ok(OrchestrationToolResult {
                    status: AgentToolResultStatus::Completed,
                    summary: format!(
                        "Child {} is {:?}",
                        arguments.child_session_id, inspection.snapshot.status
                    ),
                    data: Some(serde_json::to_value(inspection).map_err(|error| {
                        format!("failed to serialize child inspection: {error}")
                    })?),
                    evidence_refs: Vec::new(),
                    result_committed: false,
                })
            }
            "cancel_child_agent" => {
                let arguments: ChildArguments =
                    serde_json::from_value(request.call.arguments.clone()).map_err(|error| {
                        format!("invalid child cancellation arguments: {error}")
                    })?;
                self.ensure_owned_child(&request.parent_session_id, &arguments.child_session_id)?;
                self.cancel_tree(&arguments.child_session_id).await?;
                Ok(OrchestrationToolResult {
                    status: AgentToolResultStatus::Completed,
                    summary: format!(
                        "Cancelled child tree rooted at {}",
                        arguments.child_session_id
                    ),
                    data: Some(json!({ "childSessionId": arguments.child_session_id })),
                    evidence_refs: Vec::new(),
                    result_committed: false,
                })
            }
            "fleet_plan" => {
                let arguments: FleetPlanArguments =
                    serde_json::from_value(request.call.arguments.clone())
                        .map_err(|error| format!("invalid Fleet plan arguments: {error}"))?;
                let inspection = self.create_fleet(
                    &request.parent_session_id,
                    arguments.targets,
                    arguments.canary_size,
                    arguments.wave_size,
                    arguments.failure_threshold,
                )?;
                Ok(fleet_tool_result("Fleet plan committed", inspection)?)
            }
            "fleet_start" | "fleet_resume" => {
                let arguments: FleetControlArguments =
                    serde_json::from_value(request.call.arguments.clone())
                        .map_err(|error| format!("invalid Fleet control arguments: {error}"))?;
                let inspection = self
                    .run_fleet(
                        &request.parent_session_id,
                        &arguments.fleet_id,
                        cancellation,
                    )
                    .await?;
                Ok(fleet_tool_result("Fleet run settled", inspection)?)
            }
            "fleet_pause" => {
                let arguments: FleetControlArguments =
                    serde_json::from_value(request.call.arguments.clone())
                        .map_err(|error| format!("invalid Fleet control arguments: {error}"))?;
                let inspection = self.set_fleet_status(
                    &request.parent_session_id,
                    &arguments.fleet_id,
                    "paused",
                )?;
                Ok(fleet_tool_result("Fleet paused", inspection)?)
            }
            "fleet_abort" => {
                let arguments: FleetControlArguments =
                    serde_json::from_value(request.call.arguments.clone())
                        .map_err(|error| format!("invalid Fleet control arguments: {error}"))?;
                let inspection = self
                    .abort_fleet(AgentFleetControlRequest {
                        parent_session_id: request.parent_session_id,
                        fleet_id: arguments.fleet_id,
                    })
                    .await?;
                Ok(fleet_tool_result("Fleet aborted", inspection)?)
            }
            "fleet_reconcile" => {
                let arguments: FleetReconcileArguments =
                    serde_json::from_value(request.call.arguments.clone())
                        .map_err(|error| format!("invalid Fleet reconcile arguments: {error}"))?;
                let inspection = self.reconcile_fleet(AgentFleetReconcileRequest {
                    parent_session_id: request.parent_session_id,
                    fleet_id: arguments.fleet_id,
                    target_id: arguments.target_id,
                    evidence: arguments.evidence,
                })?;
                Ok(fleet_tool_result("Fleet target reconciled", inspection)?)
            }
            _ => Err("unknown orchestration tool".into()),
        }
    }
}

fn delegated_scope(
    parent: &AgentSessionSnapshot,
    role: AgentSubagentRole,
    requested_targets: &[String],
) -> Result<AgentCapabilityScope, String> {
    let parent_scope =
        parent
            .header
            .capability_scope
            .clone()
            .unwrap_or_else(|| AgentCapabilityScope {
                tool_names: default_model_tools()
                    .into_iter()
                    .map(|tool| tool.name)
                    .collect(),
                effects: vec![
                    AgentSessionEffect::None,
                    AgentSessionEffect::ReadOnly,
                    AgentSessionEffect::SensitiveRead,
                    AgentSessionEffect::StateChange,
                    AgentSessionEffect::Destructive,
                    AgentSessionEffect::ExternalSideEffect,
                    AgentSessionEffect::Unknown,
                ],
                target_ids: parent
                    .header
                    .target
                    .iter()
                    .map(|target| target.target_id.clone())
                    .collect(),
            });
    let requested = requested_targets.iter().collect::<HashSet<_>>();
    if requested.len() != requested_targets.len()
        || requested_targets
            .iter()
            .any(|target| !parent_scope.target_ids.contains(target))
    {
        return Err("subagent requested targets exceed the parent capability".into());
    }
    let (allowed_tools, allowed_effects): (&[&str], &[AgentSessionEffect]) = match role {
        AgentSubagentRole::Explorer
        | AgentSubagentRole::Diagnostician
        | AgentSubagentRole::Verifier
        | AgentSubagentRole::Reviewer => (
            &[
                "read_file",
                "list_directory",
                "search_text",
                "inspect_child_agent",
                "update_plan",
            ],
            &[
                AgentSessionEffect::None,
                AgentSessionEffect::ReadOnly,
                AgentSessionEffect::SensitiveRead,
            ],
        ),
        AgentSubagentRole::Operator => (
            &[
                "run_terminal_command",
                "write_process_input",
                "wait_process",
                "kill_process",
                "probe_http",
                "read_file",
                "list_directory",
                "search_text",
                "write_file",
                "apply_patch",
                "transfer_file",
                "inspect_child_agent",
                "update_plan",
            ],
            &[
                AgentSessionEffect::None,
                AgentSessionEffect::ReadOnly,
                AgentSessionEffect::SensitiveRead,
                AgentSessionEffect::StateChange,
                AgentSessionEffect::Destructive,
                AgentSessionEffect::ExternalSideEffect,
            ],
        ),
        AgentSubagentRole::General => (&[], &[]),
    };
    let tool_names = parent_scope
        .tool_names
        .into_iter()
        .filter(|tool| allowed_tools.is_empty() || allowed_tools.contains(&tool.as_str()))
        .collect::<Vec<_>>();
    let effects = parent_scope
        .effects
        .into_iter()
        .filter(|effect| allowed_effects.is_empty() || allowed_effects.contains(effect))
        .collect::<Vec<_>>();
    if tool_names.is_empty() || effects.is_empty() {
        return Err("role allowlist has no intersection with the parent capability".into());
    }
    Ok(AgentCapabilityScope {
        tool_names,
        effects,
        target_ids: requested_targets.to_vec(),
    })
}

pub(super) fn validate_required_tools(
    header: &super::AgentSessionHeader,
    scope: &AgentCapabilityScope,
    required_tools: &[String],
) -> Result<(), String> {
    let available = super::prompt::assemble_model_input(header, default_model_tools()).tools;
    let missing = required_tools
        .iter()
        .filter(|name| {
            !scope.tool_names.contains(name) || !available.iter().any(|tool| &tool.name == *name)
        })
        .cloned()
        .collect::<Vec<_>>();
    if missing.is_empty() {
        Ok(())
    } else {
        Err(format!("subagent capability unavailable: {}. No child was created. Collect evidence with the parent's authorized tools or select a capable role; diagnostician/explorer/verifier/reviewer cannot execute terminal commands. Collection is incomplete; host health is unknown.", missing.join(", ")))
    }
}

fn default_subagent_budget() -> AgentSubagentBudget {
    AgentSubagentBudget {
        max_steps_per_turn: 6,
        max_turns: 8,
        max_tool_calls: 32,
        max_tokens: 128_000,
        timeout_ms: 10 * 60 * 1_000,
    }
}

pub(super) fn provider_descriptor(provider: &AiProviderConfig) -> AgentSubagentModel {
    AgentSubagentModel {
        route_id: provider.id.clone(),
        model_id: provider.model.clone(),
        reasoning_effort: provider.reasoning_effort.clone(),
        route_revision: None,
    }
}

fn role_prompt(role: AgentSubagentRole, goal: &str) -> String {
    format!(
        "You are a {:?} child Agent. Stay within the structured tools and exact target scope supplied by ShellSpan. Do not delegate beyond your capability. Goal: {goal}",
        role
    )
}

fn assistant_summary(events: &[super::AgentSessionEvent]) -> Option<String> {
    events.iter().rev().find_map(|event| match &event.payload {
        AgentSessionEventPayload::AssistantMessage { content, .. }
            if !super::assistant_content_text(content).trim().is_empty() =>
        {
            Some(super::assistant_content_text(content))
        }
        AgentSessionEventPayload::SessionEnded {
            reason: Some(reason),
            ..
        } => Some(reason.clone()),
        _ => None,
    })
}

fn last_turn_incomplete(events: &[super::AgentSessionEvent]) -> bool {
    events
        .iter()
        .rev()
        .find_map(|event| match &event.payload {
            AgentSessionEventPayload::TurnEnd { reason } => Some(reason == "incomplete"),
            _ => None,
        })
        .unwrap_or(false)
}

fn child_stop_reason(events: &[super::AgentSessionEvent]) -> Option<&str> {
    for event in events.iter().rev() {
        match &event.payload {
            AgentSessionEventPayload::SessionEnded { status, reason } => {
                if matches!(
                    status,
                    AgentSessionStatus::Failed | AgentSessionStatus::Cancelled
                ) {
                    return reason.as_deref();
                }
                return None;
            }
            AgentSessionEventPayload::TurnEnd { reason } => {
                return (reason != "completed").then_some(reason.as_str());
            }
            AgentSessionEventPayload::TurnStart => return None,
            _ => {}
        }
    }
    None
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ChildBudgetUsage {
    pub(super) reported_tokens: u64,
    pub(super) tool_calls: u32,
    pub(super) turns: usize,
    pub(super) elapsed_ms: u64,
}

pub(super) fn child_budget_usage(
    events: &[super::AgentSessionEvent],
    now: u64,
) -> ChildBudgetUsage {
    ChildBudgetUsage {
        reported_tokens: events
            .iter()
            .filter_map(|event| match &event.payload {
                AgentSessionEventPayload::RequestUsage { usage, .. } => usage.total_tokens,
                _ => None,
            })
            .fold(0_u64, u64::saturating_add),
        tool_calls: super::tool_pipeline::admitted_tool_calls(events),
        turns: events
            .iter()
            .filter(|event| matches!(event.payload, AgentSessionEventPayload::TurnStart))
            .count(),
        elapsed_ms: events
            .first()
            .map_or(0, |event| now.saturating_sub(event.time_unix_ms)),
    }
}

fn child_handoff_data(
    snapshot: &AgentSessionSnapshot,
    events: &[super::AgentSessionEvent],
    can_continue: bool,
    now: u64,
    timeout_reason: Option<&str>,
) -> Result<serde_json::Value, String> {
    let subagent = snapshot
        .header
        .subagent
        .as_ref()
        .ok_or_else(|| "child Session lost subagent metadata".to_string())?;
    let stop_reason = timeout_reason.or_else(|| child_stop_reason(events));
    let partial = stop_reason.is_some()
        || last_turn_incomplete(events)
        || matches!(
            snapshot.status,
            AgentSessionStatus::Failed | AgentSessionStatus::Cancelled
        );
    let plan = events.iter().rev().find_map(|event| match &event.payload {
        AgentSessionEventPayload::TaskPlan { steps, .. } => Some(steps.iter().map(|step| json!({
            "id": step.id, "title": step.title, "status": step.status,
            "detail": step.detail.as_ref().map(|detail| detail.chars().take(1_024).collect::<String>()),
            "evidenceRefs": step.evidence_refs,
        })).collect::<Vec<_>>()),
        _ => None,
    });
    let has_partial_results = events.iter().any(|event| match &event.payload {
        AgentSessionEventPayload::ToolResult {
            status: AgentToolResultStatus::Completed,
            ..
        } => true,
        AgentSessionEventPayload::AssistantMessage { content, .. } => {
            !super::assistant_content_text(content).trim().is_empty()
        }
        _ => false,
    });
    Ok(json!({
        "childSessionId": snapshot.header.session_id,
        "descriptorId": subagent.descriptor_id,
        "continuable": can_continue,
        "status": snapshot.status,
        "timedOut": timeout_reason.is_some(),
        "partial": partial,
        "hasPartialResults": partial && has_partial_results,
        "stopReason": stop_reason,
        "budget": subagent.budget,
        "usage": child_budget_usage(events, now),
        "plan": plan,
        "recentToolResults": if partial { partial_tool_results(events) } else { Vec::new() },
        "nextAction": if snapshot.status == AgentSessionStatus::Cancelled && timeout_reason.is_none() {
            "Preserve saved evidence and respect cancellation. Do not automatically restart cancelled work."
        } else if !partial {
            "Inspect the child outcome and evidence."
        } else if can_continue {
            "Inspect progress; if useful work remains, use send_child_input with this childSessionId. Continue from saved state without repeating completed actions."
        } else {
            "Inspect saved progress and other child outcomes. Take over only the remaining work within the parent's authorized tools and remaining budget, or report specific gaps. Do not repeat completed actions or create replacement children to bypass the exhausted budget. A child failure is not evidence that the target is unhealthy."
        },
    }))
}

fn child_has_remaining_budget(
    budget: &AgentSubagentBudget,
    events: &[super::AgentSessionEvent],
    max_turns: usize,
    now: u64,
) -> bool {
    let turns = events
        .iter()
        .filter(|event| matches!(event.payload, AgentSessionEventPayload::TurnStart))
        .count();
    let tokens = events
        .iter()
        .filter_map(|event| match &event.payload {
            AgentSessionEventPayload::RequestUsage { usage, .. } => usage.total_tokens,
            _ => None,
        })
        .fold(0_u64, u64::saturating_add);
    turns < max_turns.min(budget.max_turns as usize)
        && super::tool_pipeline::admitted_tool_calls(events) < budget.max_tool_calls
        && tokens < budget.max_tokens
        && events
            .first()
            .is_some_and(|event| now.saturating_sub(event.time_unix_ms) < budget.timeout_ms)
}

fn partial_tool_results(events: &[super::AgentSessionEvent]) -> Vec<serde_json::Value> {
    let mut results = events
        .iter()
        .rev()
        .filter_map(|event| match &event.payload {
            AgentSessionEventPayload::ToolResult {
                call_id,
                name,
                status,
                summary,
                evidence_refs,
                ..
            } => Some(json!({
                "callId": call_id, "name": name, "status": status,
                "summary": summary.chars().take(1_024).collect::<String>(),
                "evidenceRefs": evidence_refs,
            })),
            _ => None,
        })
        .take(8)
        .collect::<Vec<_>>();
    results.reverse();
    results
}

fn ensure_fleet_owner(fleet: &FleetRuntime, parent_session_id: &str) -> Result<(), String> {
    if fleet.parent_session_id != parent_session_id {
        return Err("parent Session does not own the Fleet".into());
    }
    Ok(())
}

fn fleet_inspection(fleet: &FleetRuntime) -> AgentFleetInspection {
    let targets_completed = fleet
        .targets
        .iter()
        .filter(|target| matches!(target.state.as_str(), "completed" | "reconciled"))
        .count() as u32;
    AgentFleetInspection {
        fleet: AgentFleetState {
            fleet_id: Some(fleet.fleet_id.clone()),
            status: Some(fleet.status.clone()),
            wave: fleet.current_wave,
            total_waves: fleet.total_waves,
            targets_completed,
            targets_total: fleet.targets.len() as u32,
            canary_size: Some(fleet.canary_size),
            wave_size: Some(fleet.wave_size),
            failure_threshold: Some(fleet.failure_threshold),
            failures: Some(fleet.failures),
            targets: fleet
                .targets
                .iter()
                .map(|target| AgentFleetTargetState {
                    target_id: target.request.target_id.clone(),
                    task_id: target.task_id.clone(),
                    goal: target.request.goal.clone(),
                    wave: target.wave,
                    state: target.state.clone(),
                    child_session_ids: target.child_session_ids.clone(),
                    evidence_refs: target.evidence_refs.clone(),
                    recovery: target.recovery.clone(),
                })
                .collect(),
        },
        failure_threshold: fleet.failure_threshold,
        failures: fleet.failures,
    }
}

fn fleet_task_state(fleet: &AgentFleetState) -> AgentSessionEventPayload {
    let status = fleet.status.clone().unwrap_or_else(|| "planned".into());
    let progress = (fleet.targets_total > 0)
        .then_some(fleet.targets_completed as f64 / fleet.targets_total as f64);
    let recovery = fleet
        .targets
        .iter()
        .any(|target| target.recovery.is_some())
        .then(|| AgentRecoveryState {
            status: AgentRecoveryStatus::Required,
            summary: Some("One or more Fleet targets require reconciliation.".into()),
        });
    AgentSessionEventPayload::TaskState {
        status: status.clone(),
        phase: Some(format!("fleet-{status}")),
        progress,
        recovery,
        fleet: Some(fleet.clone()),
    }
}

fn fleet_role_goal(role: AgentSubagentRole, goal: &str) -> String {
    match role {
        AgentSubagentRole::Explorer => {
            format!("Inspect the exact target and produce evidence before any change. {goal}")
        }
        AgentSubagentRole::Operator => {
            format!("Apply the bounded target change using only authorized native tools. {goal}")
        }
        AgentSubagentRole::Verifier => format!(
            "Independently verify the target outcome. Do not trust the Operator's conclusion. {goal}"
        ),
        AgentSubagentRole::Reviewer => format!(
            "Review the target evidence and identify residual risk without changing state. {goal}"
        ),
        _ => goal.into(),
    }
}

fn fleet_role_budget(role: AgentSubagentRole) -> AgentSubagentBudget {
    let mut budget = default_subagent_budget();
    budget.max_turns = 1;
    if matches!(
        role,
        AgentSubagentRole::Verifier | AgentSubagentRole::Reviewer
    ) {
        budget.max_tool_calls = 16;
        budget.max_tokens = 64_000;
    }
    budget
}

fn fleet_tool_result(
    summary: &str,
    inspection: AgentFleetInspection,
) -> Result<OrchestrationToolResult, String> {
    let status = if inspection.fleet.status.as_deref() == Some("failed") {
        AgentToolResultStatus::Failed
    } else if inspection.fleet.status.as_deref() == Some("aborted") {
        AgentToolResultStatus::Cancelled
    } else {
        AgentToolResultStatus::Completed
    };
    Ok(OrchestrationToolResult {
        status,
        summary: summary.into(),
        data: Some(
            serde_json::to_value(inspection)
                .map_err(|error| format!("failed to serialize Fleet state: {error}"))?,
        ),
        evidence_refs: Vec::new(),
        result_committed: false,
    })
}

#[cfg(test)]
mod retry_policy_tests {
    use super::*;

    #[test]
    fn diagnostic_preflight_preserves_role_and_parent_boundaries() {
        let root = tempfile::tempdir().unwrap();
        let store = AgentSessionStore::default();
        store.configure(root.path().to_path_buf()).unwrap();
        let mut parent = store
            .create(CreateAgentSessionRequest {
                session_id: "diagnostic-parent".into(),
                task_id: "diagnostic-task".into(),
                goal: "Collect system metrics".into(),
                parent_session_id: None,
                continued_from_session_id: None,
                target: Some(super::super::AgentSessionTarget {
                    kind: "local".into(),
                    target_id: "diagnostic-target".into(),
                    session_id: "diagnostic-terminal".into(),
                    label: None,
                    profile_id: None,
                    host: None,
                    port: None,
                    username: None,
                    cwd: Some(root.path().to_string_lossy().into_owned()),
                    root_path: None,
                    local_root: None,
                }),
                permission_mode: Some(super::super::AgentSessionPermissionMode::Operator),
                execution_surface: super::super::AgentExecutionSurface::Direct,
                success_criteria: Vec::new(),
                capability_scope: None,
                subagent: None,
            })
            .unwrap();
        let targets = vec!["diagnostic-target".into()];
        let required = vec!["run_terminal_command".into()];
        for role in [
            AgentSubagentRole::Diagnostician,
            AgentSubagentRole::Explorer,
            AgentSubagentRole::Verifier,
            AgentSubagentRole::Reviewer,
        ] {
            let scope = delegated_scope(&parent, role, &targets).unwrap();
            assert!(validate_required_tools(&parent.header, &scope, &required).is_err());
            assert!(validate_required_tools(&parent.header, &scope, &["read_file".into()]).is_ok());
        }
        let operator = delegated_scope(&parent, AgentSubagentRole::Operator, &targets).unwrap();
        assert!(validate_required_tools(&parent.header, &operator, &required).is_ok());
        let mut restricted = operator;
        restricted
            .tool_names
            .retain(|name| name != "run_terminal_command");
        parent.header.capability_scope = Some(restricted);
        let operator = delegated_scope(&parent, AgentSubagentRole::Operator, &targets).unwrap();
        assert!(validate_required_tools(&parent.header, &operator, &required).is_err());
        assert!(delegated_scope(
            &parent,
            AgentSubagentRole::Operator,
            &["another-target".into()]
        )
        .is_err());
    }

    fn budget_event(
        seq: u64,
        payload: AgentSessionEventPayload,
    ) -> super::super::AgentSessionEvent {
        super::super::AgentSessionEvent::new(
            "budget-session".into(),
            seq,
            1_000 + seq,
            Some("budget-turn".into()),
            None,
            payload,
        )
    }

    #[test]
    fn child_continuation_preserves_cumulative_budgets() {
        let mut events = vec![
            budget_event(0, AgentSessionEventPayload::TurnStart),
            budget_event(
                1,
                AgentSessionEventPayload::RequestUsage {
                    request_id: "budget-request".into(),
                    usage: super::super::AgentTokenUsage {
                        total_tokens: Some(100),
                        ..Default::default()
                    },
                    finish_reason: super::super::AgentStopReason::Stop,
                },
            ),
            budget_event(
                2,
                AgentSessionEventPayload::TurnEnd {
                    reason: "stepBudgetReached: maximum 8 Steps per Turn".into(),
                },
            ),
        ];
        let budget = AgentSubagentBudget {
            max_steps_per_turn: 8,
            max_turns: 2,
            max_tool_calls: 2,
            max_tokens: 200,
            timeout_ms: 1_000,
        };
        assert!(child_has_remaining_budget(&budget, &events, 64, 1_500));
        assert!(!child_has_remaining_budget(&budget, &events, 1, 1_500));
        assert!(!child_has_remaining_budget(&budget, &events, 64, 2_000));
        assert!(!child_has_remaining_budget(
            &AgentSubagentBudget {
                max_tokens: 100,
                ..budget.clone()
            },
            &events,
            64,
            1_500
        ));
        let call = super::super::recorded_tool_call(super::super::ModelToolCall {
            call_id: "budget-call".into(),
            provider_call_id: None,
            name: "read_terminal".into(),
            arguments: json!({}),
        });
        events.push(budget_event(3, AgentSessionEventPayload::ToolCall { call }));
        assert!(!child_has_remaining_budget(
            &AgentSubagentBudget {
                max_tool_calls: 1,
                ..budget.clone()
            },
            &events,
            64,
            1_500
        ));
        events.push(budget_event(4, AgentSessionEventPayload::TurnStart));
        assert!(!child_has_remaining_budget(&budget, &events, 64, 1_500));
    }

    #[test]
    fn only_the_latest_turn_controls_partial_budget_settlement() {
        for reason in [
            "stepBudgetReached: maximum 8 Steps per Turn",
            "stepLimitExceeded: maximum 8 Steps per Turn",
            "subagentTokenBudgetExceeded: maximum 32000 tokens",
            "subagentToolBudgetExceeded: maximum 25 calls",
            "subagentTimeout: maximum 300000 ms",
            "turnLimitExceeded: maximum 1 Turns per Session",
            "providerUnavailable",
        ] {
            let mut events = vec![budget_event(
                0,
                AgentSessionEventPayload::TurnEnd {
                    reason: reason.into(),
                },
            )];
            assert_eq!(child_stop_reason(&events), Some(reason));
            events.push(budget_event(
                1,
                AgentSessionEventPayload::TurnEnd {
                    reason: "completed".into(),
                },
            ));
            assert_eq!(child_stop_reason(&events), None);
        }
    }

    #[tokio::test]
    async fn terminal_budget_handoff_survives_store_reload_without_a_model_call() {
        for (status, reason) in [
            (
                AgentSessionStatus::Failed,
                "subagentTokenBudgetExceeded: maximum 32000 tokens",
            ),
            (
                AgentSessionStatus::Failed,
                "subagentToolBudgetExceeded: maximum 25 calls",
            ),
            (
                AgentSessionStatus::Failed,
                "subagentTimeout: maximum 300000 ms",
            ),
            (
                AgentSessionStatus::Failed,
                "turnLimitExceeded: maximum 1 Turns per Session",
            ),
            (AgentSessionStatus::Failed, "providerUnavailable"),
            (AgentSessionStatus::Cancelled, "cancelled"),
            (AgentSessionStatus::Completed, "oneShotTurnCompleted"),
        ] {
            let root = tempfile::tempdir().unwrap();
            let store = AgentSessionStore::default();
            store.configure(root.path().to_path_buf()).unwrap();
            let target = super::super::AgentSessionTarget {
                kind: "local".into(),
                target_id: "handoff-target".into(),
                session_id: "handoff-terminal".into(),
                label: None,
                profile_id: None,
                host: None,
                port: None,
                username: None,
                cwd: Some(root.path().to_string_lossy().into_owned()),
                root_path: None,
                local_root: None,
            };
            let scope = AgentCapabilityScope {
                tool_names: vec!["list_directory".into()],
                effects: vec![AgentSessionEffect::ReadOnly],
                target_ids: vec![target.target_id.clone()],
            };
            store
                .create(CreateAgentSessionRequest {
                    session_id: "handoff-child".into(),
                    task_id: "handoff-task".into(),
                    goal: "Inspect saved progress".into(),
                    parent_session_id: Some("handoff-parent".into()),
                    continued_from_session_id: None,
                    target: Some(target.clone()),
                    permission_mode: None,
                    execution_surface: super::super::AgentExecutionSurface::Direct,
                    success_criteria: Vec::new(),
                    capability_scope: Some(scope.clone()),
                    subagent: Some(AgentSubagentSession {
                        descriptor_id: "handoff-descriptor".into(),
                        parent_task_id: "parent-task".into(),
                        role: AgentSubagentRole::Explorer,
                        continuable: false,
                        depth: 1,
                        inheritance: AgentSubagentInheritance::Blank,
                        capability_scope: scope,
                        target_scope: vec![target],
                        budget: default_subagent_budget(),
                        provider: AgentSubagentModel {
                            route_id: "route".into(),
                            model_id: "model".into(),
                            reasoning_effort: None,
                            route_revision: None,
                        },
                    }),
                })
                .unwrap();
            store
                .terminate("handoff-child", status, reason.into())
                .unwrap();
            drop(store);
            let store = AgentSessionStore::default();
            store.configure(root.path().to_path_buf()).unwrap();
            let snapshot = store.snapshot("handoff-child").unwrap();
            let events = store.all_events("handoff-child").unwrap();
            let data = child_handoff_data(
                &snapshot,
                &events,
                false,
                super::super::driver::current_unix_ms().unwrap(),
                None,
            )
            .unwrap();
            assert_eq!(data["partial"], status != AgentSessionStatus::Completed);
            assert_eq!(data["continuable"], false);
            assert_eq!(data["hasPartialResults"], false);
            assert_eq!(data["usage"]["reportedTokens"], 0);
            assert_eq!(
                data["budget"]["maxTokens"],
                default_subagent_budget().max_tokens
            );
            if status == AgentSessionStatus::Completed {
                assert!(data["stopReason"].is_null());
            } else {
                assert_eq!(data["stopReason"], reason);
            }
            let action = data["nextAction"].as_str().unwrap();
            if status == AgentSessionStatus::Cancelled {
                assert!(action.contains("Do not automatically restart"));
                let signal = tokio::sync::Notify::new();
                let cancellation = CancellationToken::new();
                assert!(matches!(
                    wait_for_child(signal.notified(), &cancellation, 1).await,
                    ChildWaitOutcome::TimedOut
                ));
                let timeout = "subagentTimeout: child exceeded 1 ms";
                let timed_out = child_handoff_data(
                    &snapshot,
                    &events,
                    false,
                    super::super::driver::current_unix_ms().unwrap(),
                    Some(timeout),
                )
                .unwrap();
                assert_eq!(timed_out["timedOut"], true);
                assert_eq!(timed_out["partial"], true);
                assert_eq!(timed_out["stopReason"], timeout);
                assert!(timed_out["nextAction"]
                    .as_str()
                    .unwrap()
                    .contains("remaining work"));
                assert!(!timed_out["nextAction"]
                    .as_str()
                    .unwrap()
                    .contains("Do not automatically restart"));
                cancellation.cancel();
                assert!(matches!(
                    wait_for_child(signal.notified(), &cancellation, 0).await,
                    ChildWaitOutcome::Cancelled
                ));
                let finished = async { store.snapshot("handoff-child").unwrap() };
                assert!(matches!(
                    wait_for_child(finished, &CancellationToken::new(), 100).await,
                    ChildWaitOutcome::Settled(_)
                ));
            } else if status == AgentSessionStatus::Failed {
                assert!(action.contains("remaining work"));
                assert!(action.contains("remaining budget"));
                assert!(action.contains("Do not repeat completed actions"));
            }
        }
    }

    #[test]
    fn partial_handoff_is_bounded_and_does_not_copy_raw_tool_data() {
        let events = (0..10)
            .map(|seq| {
                budget_event(
                    seq,
                    AgentSessionEventPayload::ToolResult {
                        call_id: format!("call-{seq}"),
                        name: "read_terminal".into(),
                        status: AgentToolResultStatus::Completed,
                        summary: "终端状态已读取".repeat(300),
                        data: Some(json!({ "content": "private-terminal-content" })),
                        duration_ms: None,
                        evidence_refs: Vec::new(),
                    },
                )
            })
            .collect::<Vec<_>>();
        let results = partial_tool_results(&events);
        assert_eq!(results.len(), 8);
        assert_eq!(results[0]["callId"], "call-2");
        assert_eq!(results[7]["callId"], "call-9");
        assert_eq!(
            results[0]["summary"].as_str().unwrap().chars().count(),
            1_024
        );
        assert!(!serde_json::to_string(&results)
            .unwrap()
            .contains("private-terminal-content"));
    }

    #[test]
    fn child_descriptor_contains_only_model_selection() {
        let config: AiProviderConfig = serde_json::from_value(serde_json::json!({
            "id":"proxy", "profile":"deepseek", "kind":"openAiCompatible", "baseUrl":"https://proxy.example/v1",
            "model":"deepseek-flash", "requiresApiKey":false,
            "retryPolicy":{"maxAttempts":1,"initialDelayMs":0,"maxDelayMs":500,"maxServerDelayMs":1000,"jitterRatio":0.5}
        })).unwrap();
        let encoded = serde_json::to_value(provider_descriptor(&config)).unwrap();
        assert_eq!(
            encoded,
            serde_json::json!({"routeId":"proxy","modelId":"deepseek-flash"})
        );
    }
}
