use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::agent_contract_v3::{
    AgentEffectKindV3, AgentToolCallV3, AgentToolResultStatusV3, AgentToolResultV3,
};
use crate::redaction::redact_sensitive_text;

use super::{current_unix_ms, CallPolicyScopeV3};

const FLEET_STORE_VERSION: u16 = 1;
const MAX_FLEETS: usize = 64;
const MAX_TARGETS_PER_FLEET: usize = 256;
const MAX_SUB_AGENTS_PER_FLEET: usize = 64;
const MAX_CALL_HISTORY: usize = 4_096;
const MAX_STORE_BYTES: usize = 2 * 1024 * 1024;
const MAX_JITTER_MS: u64 = 30_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FleetRolloutV3 {
    Disabled,
    Enabled,
    Invalid,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FleetFeaturePolicyV3 {
    pub(crate) stage: String,
    pub(crate) default_enabled: bool,
    pub(crate) maximum_targets: usize,
    pub(crate) state_survives_restart: bool,
    pub(crate) sub_agent_authority_survives_restart: bool,
}

pub(crate) fn fleet_rollout_v3() -> FleetRolloutV3 {
    match std::env::var("SHELLSPAN_AGENT_FLEET") {
        Err(std::env::VarError::NotPresent) => FleetRolloutV3::Disabled,
        Ok(value) if value.eq_ignore_ascii_case("disabled") => FleetRolloutV3::Disabled,
        Ok(value) if value.eq_ignore_ascii_case("enabled") => FleetRolloutV3::Enabled,
        _ => FleetRolloutV3::Invalid,
    }
}

pub(crate) fn fleet_feature_policy_v3() -> FleetFeaturePolicyV3 {
    let stage = match fleet_rollout_v3() {
        FleetRolloutV3::Disabled => "disabled",
        FleetRolloutV3::Enabled => "enabled",
        FleetRolloutV3::Invalid => "invalid",
    };
    FleetFeaturePolicyV3 {
        stage: stage.into(),
        default_enabled: false,
        maximum_targets: MAX_TARGETS_PER_FLEET,
        state_survives_restart: true,
        sub_agent_authority_survives_restart: false,
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum FleetStateV3 {
    Ready,
    Running,
    FailStopped,
    NeedsReconciliation,
    Completed,
    CompletedWithFailures,
    Cancelled,
}

impl FleetStateV3 {
    fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::CompletedWithFailures | Self::Cancelled
        )
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum FleetTargetStateV3 {
    Pending,
    Canary,
    Running,
    AwaitingVerification,
    Succeeded,
    Failed,
    Blocked,
    NeedsReconciliation,
    RolledBack,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SubAgentRoleV3 {
    Explorer,
    Diagnostician,
    Operator,
    Verifier,
    Reviewer,
}

impl SubAgentRoleV3 {
    fn is_read_only(self) -> bool {
        matches!(
            self,
            Self::Explorer | Self::Diagnostician | Self::Verifier | Self::Reviewer
        )
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FleetSelectorV3 {
    #[serde(default)]
    pub(crate) labels: BTreeMap<String, String>,
    #[serde(default)]
    pub(crate) groups: Vec<String>,
    #[serde(default)]
    pub(crate) environments: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FleetMemberV3 {
    pub(crate) task_id: String,
    pub(crate) target_id: String,
    pub(crate) display_name: String,
    #[serde(default)]
    pub(crate) labels: BTreeMap<String, String>,
    pub(crate) group: String,
    pub(crate) environment: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FleetPolicyV3 {
    pub(crate) max_concurrency: u16,
    pub(crate) batch_size: u16,
    pub(crate) canary_size: u16,
    pub(crate) max_failures: u16,
    pub(crate) jitter_ms: u64,
    pub(crate) max_calls_total: u32,
    pub(crate) max_calls_per_target: u16,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RegisterFleetRequestV3 {
    pub(crate) fleet_id: String,
    pub(crate) goal: String,
    pub(crate) members: Vec<FleetMemberV3>,
    pub(crate) selector: FleetSelectorV3,
    pub(crate) policy: FleetPolicyV3,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FrozenFleetScopeV3 {
    pub(crate) task_id: String,
    pub(crate) target_id: String,
    pub(crate) plan_version: u64,
    pub(crate) allowed_tools: Vec<String>,
    pub(crate) allowed_effects: Vec<AgentEffectKindV3>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RegisterSubAgentRequestV3 {
    pub(crate) fleet_id: String,
    pub(crate) role: SubAgentRoleV3,
    pub(crate) target_ids: Vec<String>,
    pub(crate) tool_names: Vec<String>,
    pub(crate) effects: Vec<AgentEffectKindV3>,
    pub(crate) max_calls: u16,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SubmitFleetVerificationRequestV3 {
    pub(crate) fleet_id: String,
    pub(crate) sub_agent_id: String,
    pub(crate) target_id: String,
    pub(crate) evidence_call_id: String,
    pub(crate) succeeded: bool,
    pub(crate) summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FleetTargetSnapshotV3 {
    pub(crate) task_id: String,
    pub(crate) target_id: String,
    pub(crate) display_name: String,
    pub(crate) labels: BTreeMap<String, String>,
    pub(crate) group: String,
    pub(crate) environment: String,
    pub(crate) wave_index: usize,
    pub(crate) state: FleetTargetStateV3,
    pub(crate) plan_version: u64,
    pub(crate) allowed_tools: Vec<String>,
    pub(crate) allowed_effects: Vec<AgentEffectKindV3>,
    pub(crate) calls_used: u16,
    pub(crate) last_call_id: Option<String>,
    pub(crate) last_writer_sub_agent_id: Option<String>,
    pub(crate) verifier_sub_agent_id: Option<String>,
    pub(crate) verification_evidence_call_id: Option<String>,
    pub(crate) verification_summary: Option<String>,
    pub(crate) last_error: Option<String>,
    pub(crate) rollback_checkpoint_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SubAgentSnapshotV3 {
    pub(crate) sub_agent_id: String,
    pub(crate) role: SubAgentRoleV3,
    pub(crate) target_ids: Vec<String>,
    pub(crate) tool_names: Vec<String>,
    pub(crate) effects: Vec<AgentEffectKindV3>,
    pub(crate) max_calls: u16,
    pub(crate) calls_used: u16,
    pub(crate) active: bool,
    pub(crate) registered_at_unix_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentFleetSnapshotV3 {
    pub(crate) fleet_id: String,
    pub(crate) goal: String,
    pub(crate) state: FleetStateV3,
    pub(crate) selector: FleetSelectorV3,
    pub(crate) policy: FleetPolicyV3,
    pub(crate) target_snapshot_sha256: String,
    pub(crate) write_intent: bool,
    pub(crate) waves: Vec<Vec<String>>,
    pub(crate) current_wave: usize,
    pub(crate) targets: Vec<FleetTargetSnapshotV3>,
    pub(crate) sub_agents: Vec<SubAgentSnapshotV3>,
    pub(crate) calls_used: u32,
    pub(crate) active_call_count: usize,
    pub(crate) failure_count: u16,
    pub(crate) created_at_unix_ms: u64,
    pub(crate) updated_at_unix_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ActiveFleetCallV3 {
    call_id: String,
    sub_agent_id: String,
    target_id: String,
    effect: AgentEffectKindV3,
    #[serde(skip)]
    paths: Vec<String>,
    started_at_unix_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FleetCallEvidenceV3 {
    call_id: String,
    sub_agent_id: String,
    role: SubAgentRoleV3,
    target_id: String,
    effect: AgentEffectKindV3,
    status: AgentToolResultStatusV3,
    finished_at_unix_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FleetRecordV3 {
    snapshot: AgentFleetSnapshotV3,
    active_calls: HashMap<String, ActiveFleetCallV3>,
    call_history: Vec<FleetCallEvidenceV3>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FleetEnvelopeV3 {
    version: u16,
    written_at_unix_ms: u64,
    fleets: Vec<FleetRecordV3>,
}

#[derive(Debug, Default)]
struct FleetStateStoreV3 {
    root: Option<PathBuf>,
    fleets: HashMap<String, FleetRecordV3>,
}

#[derive(Debug)]
pub(crate) struct FleetDispatchGuardV3 {
    pub(crate) jitter_ms: u64,
}

#[derive(Clone, Default)]
pub(crate) struct FleetRuntimeV3 {
    inner: Arc<Mutex<FleetStateStoreV3>>,
}

impl FleetRuntimeV3 {
    pub(crate) fn configure(&self, app_data_root: &Path) -> Result<(), String> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "Agent M5 Fleet store is unavailable".to_string())?;
        let root = app_data_root.join("agent-m5");
        if let Some(existing) = state.root.as_ref() {
            return if existing == &root {
                Ok(())
            } else {
                Err("Agent M5 Fleet persistence root changed after initialization".into())
            };
        }
        fs::create_dir_all(&root)
            .map_err(|error| format!("failed to create Agent M5 store: {error}"))?;
        state.root = Some(root.clone());
        let path = root.join("fleets-v1.json");
        if !path.exists() {
            return Ok(());
        }
        let metadata = fs::metadata(&path)
            .map_err(|error| format!("failed to inspect Agent M5 store: {error}"))?;
        if metadata.len() as usize > MAX_STORE_BYTES {
            return Err("Agent M5 store exceeded its bounded size".into());
        }
        let bytes =
            fs::read(&path).map_err(|error| format!("failed to read Agent M5 store: {error}"))?;
        let envelope: FleetEnvelopeV3 = serde_json::from_slice(&bytes)
            .map_err(|_| "Agent M5 persistence JSON was invalid".to_string())?;
        if envelope.version != FLEET_STORE_VERSION || envelope.fleets.len() > MAX_FLEETS {
            return Err("Agent M5 persistence version or bounds were invalid".into());
        }
        for mut fleet in envelope.fleets {
            if fleet.snapshot.targets.len() > MAX_TARGETS_PER_FLEET
                || fleet.snapshot.sub_agents.len() > MAX_SUB_AGENTS_PER_FLEET
                || fleet.call_history.len() > MAX_CALL_HISTORY
            {
                return Err("Agent M5 persisted Fleet exceeded native bounds".into());
            }
            for agent in &mut fleet.snapshot.sub_agents {
                agent.active = false;
            }
            if !fleet.active_calls.is_empty() {
                let uncertain_targets = fleet
                    .active_calls
                    .values()
                    .map(|call| call.target_id.clone())
                    .collect::<HashSet<_>>();
                for target in &mut fleet.snapshot.targets {
                    if uncertain_targets.contains(&target.target_id) {
                        target.state = FleetTargetStateV3::NeedsReconciliation;
                        target.last_error = Some(
                            "A write or external effect was in flight at restart; inspect the host. It will not be replayed automatically."
                                .into(),
                        );
                    }
                }
                fleet.snapshot.state = FleetStateV3::NeedsReconciliation;
                fleet.snapshot.updated_at_unix_ms = current_unix_ms();
                fleet.active_calls.clear();
                fleet.snapshot.active_call_count = 0;
            }
            if state
                .fleets
                .insert(fleet.snapshot.fleet_id.clone(), fleet)
                .is_some()
            {
                return Err("Agent M5 persistence contained duplicate Fleet ids".into());
            }
        }
        persist_locked(&state)
    }

    pub(crate) fn register(
        &self,
        mut request: RegisterFleetRequestV3,
        scopes: Vec<FrozenFleetScopeV3>,
    ) -> Result<AgentFleetSnapshotV3, String> {
        request.goal = redact_sensitive_text(&request.goal);
        request.selector = sanitized_selector(request.selector);
        request.members = request.members.into_iter().map(sanitized_member).collect();
        validate_identifier(&request.fleet_id, "Fleet id")?;
        validate_text(&request.goal, 1, 512, "Fleet goal")?;
        validate_policy(&request.policy)?;
        if request.members.len() < 2 || request.members.len() > MAX_TARGETS_PER_FLEET {
            return Err("Fleet registration requires 2 to 256 bounded members".into());
        }
        validate_selector(&request.selector)?;
        let scopes_by_target = scopes
            .into_iter()
            .map(|scope| (scope.target_id.clone(), scope))
            .collect::<HashMap<_, _>>();
        let mut selected = request
            .members
            .into_iter()
            .filter(|member| selector_matches(&request.selector, member))
            .collect::<Vec<_>>();
        selected.sort_by(|left, right| left.target_id.cmp(&right.target_id));
        if selected.len() < 2 {
            return Err("Fleet selector must freeze at least two native targets".into());
        }
        let mut target_ids = HashSet::new();
        let mut task_ids = HashSet::new();
        let mut write_intent = false;
        let mut targets = Vec::with_capacity(selected.len());
        for member in &selected {
            validate_member(member)?;
            if !target_ids.insert(member.target_id.clone())
                || !task_ids.insert(member.task_id.clone())
            {
                return Err("Fleet members must have unique target and task ids".into());
            }
            let scope = scopes_by_target
                .get(&member.target_id)
                .ok_or_else(|| "Fleet member has no Rust-frozen plan scope".to_string())?;
            if scope.task_id != member.task_id
                || scope.allowed_tools.is_empty()
                || scope.allowed_effects.is_empty()
            {
                return Err("Fleet member scope does not match its Rust task and plan".into());
            }
            write_intent |= scope.allowed_effects.iter().any(is_write_effect);
            targets.push(FleetTargetSnapshotV3 {
                task_id: member.task_id.clone(),
                target_id: member.target_id.clone(),
                display_name: member.display_name.clone(),
                labels: member.labels.clone(),
                group: member.group.clone(),
                environment: member.environment.clone(),
                wave_index: 0,
                state: FleetTargetStateV3::Pending,
                plan_version: scope.plan_version,
                allowed_tools: sorted_unique(scope.allowed_tools.clone()),
                allowed_effects: sorted_unique_effects(scope.allowed_effects.clone()),
                calls_used: 0,
                last_call_id: None,
                last_writer_sub_agent_id: None,
                verifier_sub_agent_id: None,
                verification_evidence_call_id: None,
                verification_summary: None,
                last_error: None,
                rollback_checkpoint_id: None,
            });
        }
        if write_intent && request.policy.canary_size == 0 {
            return Err("multi-host writes require a non-zero native canary".into());
        }
        let waves = build_waves(&targets, &request.policy, write_intent);
        for target in &mut targets {
            target.wave_index = waves
                .iter()
                .position(|wave| wave.contains(&target.target_id))
                .ok_or_else(|| "Fleet wave construction omitted a target".to_string())?;
            if write_intent && target.wave_index == 0 {
                target.state = FleetTargetStateV3::Canary;
            }
        }
        let target_snapshot_sha256 = target_digest(&targets)?;
        let now = current_unix_ms();
        let snapshot = AgentFleetSnapshotV3 {
            fleet_id: request.fleet_id,
            goal: request.goal,
            state: FleetStateV3::Ready,
            selector: request.selector,
            policy: request.policy,
            target_snapshot_sha256,
            write_intent,
            waves,
            current_wave: 0,
            targets,
            sub_agents: Vec::new(),
            calls_used: 0,
            active_call_count: 0,
            failure_count: 0,
            created_at_unix_ms: now,
            updated_at_unix_ms: now,
        };
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "Agent M5 Fleet store is unavailable".to_string())?;
        if state.fleets.len() >= MAX_FLEETS {
            return Err("Agent M5 Fleet store reached its bounded capacity".into());
        }
        if state.fleets.contains_key(&snapshot.fleet_id) {
            return Err("Fleet id is already registered".into());
        }
        if state.fleets.values().any(|fleet| {
            !fleet.snapshot.state.is_terminal()
                && fleet
                    .snapshot
                    .targets
                    .iter()
                    .any(|target| task_ids.contains(&target.task_id))
        }) {
            return Err("a task is already controlled by another active Fleet".into());
        }
        state.fleets.insert(
            snapshot.fleet_id.clone(),
            FleetRecordV3 {
                snapshot: snapshot.clone(),
                active_calls: HashMap::new(),
                call_history: Vec::new(),
            },
        );
        persist_locked(&state)?;
        Ok(snapshot)
    }

    pub(crate) fn register_sub_agent(
        &self,
        request: RegisterSubAgentRequestV3,
    ) -> Result<SubAgentSnapshotV3, String> {
        if request.max_calls == 0 {
            return Err("sub-agent call budget must be non-zero".into());
        }
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "Agent M5 Fleet store is unavailable".to_string())?;
        let fleet = state
            .fleets
            .get_mut(&request.fleet_id)
            .ok_or_else(|| "Fleet was not found".to_string())?;
        if fleet.snapshot.state.is_terminal() || fleet.snapshot.state == FleetStateV3::FailStopped {
            return Err("sub-agents cannot join a terminal or fail-stopped Fleet".into());
        }
        if fleet.snapshot.sub_agents.len() >= MAX_SUB_AGENTS_PER_FLEET {
            return Err("Fleet sub-agent capacity was reached".into());
        }
        let target_ids = sorted_unique(request.target_ids);
        let tool_names = sorted_unique(request.tool_names);
        let effects = sorted_unique_effects(request.effects);
        if target_ids.is_empty() || tool_names.is_empty() || effects.is_empty() {
            return Err("sub-agent capability subset cannot be empty".into());
        }
        for target_id in &target_ids {
            let target = fleet
                .snapshot
                .targets
                .iter()
                .find(|target| &target.target_id == target_id)
                .ok_or_else(|| "sub-agent target exceeds the frozen Fleet".to_string())?;
            if tool_names
                .iter()
                .any(|tool| !target.allowed_tools.contains(tool))
                || effects
                    .iter()
                    .any(|effect| !target.allowed_effects.contains(effect))
            {
                return Err("sub-agent capability exceeds the parent plan scope".into());
            }
        }
        if request.role.is_read_only() && effects.iter().any(is_write_effect) {
            return Err("read-only sub-agent roles cannot receive write effects".into());
        }
        let agent = SubAgentSnapshotV3 {
            sub_agent_id: format!("subagent-{}", Uuid::new_v4().simple()),
            role: request.role,
            target_ids,
            tool_names,
            effects,
            max_calls: request.max_calls,
            calls_used: 0,
            active: true,
            registered_at_unix_ms: current_unix_ms(),
        };
        fleet.snapshot.sub_agents.push(agent.clone());
        fleet.snapshot.updated_at_unix_ms = current_unix_ms();
        persist_locked(&state)?;
        Ok(agent)
    }

    pub(crate) fn ensure_direct_dispatch_allowed(&self, task_id: &str) -> Result<(), String> {
        let state = self
            .inner
            .lock()
            .map_err(|_| "Agent M5 Fleet store is unavailable".to_string())?;
        if state.fleets.values().any(|fleet| {
            !fleet.snapshot.state.is_terminal()
                && fleet
                    .snapshot
                    .targets
                    .iter()
                    .any(|target| target.task_id == task_id)
        }) {
            return Err("task is Fleet-controlled; use the Rust Fleet dispatch boundary".into());
        }
        Ok(())
    }

    pub(crate) fn begin_dispatch(
        &self,
        fleet_id: &str,
        sub_agent_id: &str,
        call: &AgentToolCallV3,
        effect: AgentEffectKindV3,
        scope: &CallPolicyScopeV3,
    ) -> Result<FleetDispatchGuardV3, String> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "Agent M5 Fleet store is unavailable".to_string())?;
        let fleet = state
            .fleets
            .get_mut(fleet_id)
            .ok_or_else(|| "Fleet was not found".to_string())?;
        if matches!(
            fleet.snapshot.state,
            FleetStateV3::FailStopped
                | FleetStateV3::NeedsReconciliation
                | FleetStateV3::Completed
                | FleetStateV3::CompletedWithFailures
                | FleetStateV3::Cancelled
        ) {
            return Err("Fleet is not dispatchable".into());
        }
        let target_id = call.target.target_id();
        let target_index = fleet
            .snapshot
            .targets
            .iter()
            .position(|target| target.target_id == target_id)
            .ok_or_else(|| "call target is outside the frozen Fleet".to_string())?;
        let target = &fleet.snapshot.targets[target_index];
        if target.task_id.is_empty() || target.wave_index != fleet.snapshot.current_wave {
            return Err("target is outside the current native Fleet wave".into());
        }
        if matches!(
            target.state,
            FleetTargetStateV3::Succeeded
                | FleetTargetStateV3::Failed
                | FleetTargetStateV3::Blocked
                | FleetTargetStateV3::NeedsReconciliation
                | FleetTargetStateV3::RolledBack
        ) {
            return Err("target is not dispatchable in its current state".into());
        }
        let agent_index = fleet
            .snapshot
            .sub_agents
            .iter()
            .position(|agent| agent.sub_agent_id == sub_agent_id)
            .ok_or_else(|| "sub-agent was not registered by Rust".to_string())?;
        let agent = &fleet.snapshot.sub_agents[agent_index];
        if !agent.active
            || !agent.target_ids.iter().any(|value| value == target_id)
            || !agent.tool_names.contains(&call.tool_name)
            || !agent.effects.contains(&effect)
        {
            return Err("sub-agent call exceeds its exact native capability subset".into());
        }
        if agent.role.is_read_only() && is_write_effect(&effect) {
            return Err("read-only sub-agent attempted a write effect".into());
        }
        if target.state == FleetTargetStateV3::AwaitingVerification
            && agent.role != SubAgentRoleV3::Verifier
        {
            return Err("target awaits an independent Verifier before more operations".into());
        }
        if fleet.snapshot.calls_used >= fleet.snapshot.policy.max_calls_total
            || agent.calls_used >= agent.max_calls
            || target.calls_used >= fleet.snapshot.policy.max_calls_per_target
        {
            return Err("Fleet or sub-agent call budget was exhausted".into());
        }
        if fleet.active_calls.len() >= fleet.snapshot.policy.max_concurrency as usize {
            return Err("Fleet native concurrency budget was reached".into());
        }
        if fleet.active_calls.contains_key(&call.call_id) {
            return Err("Fleet call id was already active".into());
        }
        if is_write_effect(&effect)
            && fleet.active_calls.values().any(|active| {
                active.target_id == target_id
                    && is_write_effect(&active.effect)
                    && paths_conflict(&active.paths, &scope.paths)
            })
        {
            return Err("same-target write conflict must be serialized by Rust".into());
        }
        let jitter_ms = deterministic_jitter(&call.call_id, fleet.snapshot.policy.jitter_ms);
        let now = current_unix_ms();
        fleet.active_calls.insert(
            call.call_id.clone(),
            ActiveFleetCallV3 {
                call_id: call.call_id.clone(),
                sub_agent_id: sub_agent_id.to_string(),
                target_id: target_id.to_string(),
                effect,
                paths: scope.paths.clone(),
                started_at_unix_ms: now,
            },
        );
        fleet.snapshot.state = FleetStateV3::Running;
        fleet.snapshot.active_call_count = fleet.active_calls.len();
        fleet.snapshot.calls_used = fleet.snapshot.calls_used.saturating_add(1);
        fleet.snapshot.sub_agents[agent_index].calls_used = fleet.snapshot.sub_agents[agent_index]
            .calls_used
            .saturating_add(1);
        fleet.snapshot.targets[target_index].calls_used = fleet.snapshot.targets[target_index]
            .calls_used
            .saturating_add(1);
        fleet.snapshot.targets[target_index].state = FleetTargetStateV3::Running;
        fleet.snapshot.targets[target_index].last_call_id = Some(call.call_id.clone());
        if is_write_effect(&effect) {
            fleet.snapshot.targets[target_index].last_writer_sub_agent_id =
                Some(sub_agent_id.to_string());
        }
        fleet.snapshot.updated_at_unix_ms = now;
        persist_locked(&state)?;
        Ok(FleetDispatchGuardV3 { jitter_ms })
    }

    pub(crate) fn finish_dispatch(
        &self,
        fleet_id: &str,
        call_id: &str,
        result: &AgentToolResultV3,
    ) -> Result<AgentFleetSnapshotV3, String> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "Agent M5 Fleet store is unavailable".to_string())?;
        let fleet = state
            .fleets
            .get_mut(fleet_id)
            .ok_or_else(|| "Fleet was not found".to_string())?;
        let active = fleet
            .active_calls
            .remove(call_id)
            .ok_or_else(|| "Fleet active call was not found".to_string())?;
        if result.call_id != call_id || result.target_id != active.target_id {
            fleet.active_calls.insert(call_id.to_string(), active);
            return Err("Fleet result correlation failed".into());
        }
        let role = fleet
            .snapshot
            .sub_agents
            .iter()
            .find(|agent| agent.sub_agent_id == active.sub_agent_id)
            .map(|agent| agent.role)
            .ok_or_else(|| "Fleet call owner disappeared".to_string())?;
        fleet.call_history.push(FleetCallEvidenceV3 {
            call_id: call_id.to_string(),
            sub_agent_id: active.sub_agent_id.clone(),
            role,
            target_id: active.target_id.clone(),
            effect: active.effect,
            status: result.status,
            finished_at_unix_ms: current_unix_ms(),
        });
        if fleet.call_history.len() > MAX_CALL_HISTORY {
            let drain = fleet.call_history.len() - MAX_CALL_HISTORY;
            fleet.call_history.drain(0..drain);
        }
        let target = fleet
            .snapshot
            .targets
            .iter_mut()
            .find(|target| target.target_id == active.target_id)
            .ok_or_else(|| "Fleet target disappeared".to_string())?;
        if result.status == AgentToolResultStatusV3::Completed {
            target.state = FleetTargetStateV3::AwaitingVerification;
            target.last_error = None;
        } else {
            target.state = FleetTargetStateV3::Failed;
            target.last_error = Some(redact_sensitive_text(&result.summary));
            fleet.snapshot.failure_count = fleet.snapshot.failure_count.saturating_add(1);
        }
        fleet.snapshot.active_call_count = fleet.active_calls.len();
        fleet.snapshot.updated_at_unix_ms = current_unix_ms();
        advance_or_fail_stop(fleet);
        let snapshot = fleet.snapshot.clone();
        persist_locked(&state)?;
        Ok(snapshot)
    }

    pub(crate) fn abort_dispatch(
        &self,
        fleet_id: &str,
        call_id: &str,
        reason: &str,
    ) -> Result<(), String> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "Agent M5 Fleet store is unavailable".to_string())?;
        let fleet = state
            .fleets
            .get_mut(fleet_id)
            .ok_or_else(|| "Fleet was not found".to_string())?;
        let active = fleet
            .active_calls
            .remove(call_id)
            .ok_or_else(|| "Fleet active call was not found".to_string())?;
        if let Some(target) = fleet
            .snapshot
            .targets
            .iter_mut()
            .find(|target| target.target_id == active.target_id)
        {
            target.state = FleetTargetStateV3::Failed;
            target.last_error = Some(redact_sensitive_text(reason));
        }
        fleet.snapshot.active_call_count = fleet.active_calls.len();
        fleet.snapshot.failure_count = fleet.snapshot.failure_count.saturating_add(1);
        fleet.snapshot.updated_at_unix_ms = current_unix_ms();
        advance_or_fail_stop(fleet);
        persist_locked(&state)
    }

    pub(crate) fn submit_verification(
        &self,
        request: SubmitFleetVerificationRequestV3,
    ) -> Result<AgentFleetSnapshotV3, String> {
        let summary = redact_sensitive_text(&request.summary);
        validate_text(&summary, 1, 2_048, "verification summary")?;
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "Agent M5 Fleet store is unavailable".to_string())?;
        let fleet = state
            .fleets
            .get_mut(&request.fleet_id)
            .ok_or_else(|| "Fleet was not found".to_string())?;
        let verifier = fleet
            .snapshot
            .sub_agents
            .iter()
            .find(|agent| agent.sub_agent_id == request.sub_agent_id)
            .ok_or_else(|| "Verifier was not registered by Rust".to_string())?;
        if !verifier.active || verifier.role != SubAgentRoleV3::Verifier {
            return Err("only an active independent Verifier may complete a target".into());
        }
        let evidence = fleet
            .call_history
            .iter()
            .find(|evidence| evidence.call_id == request.evidence_call_id)
            .ok_or_else(|| "verification evidence is not a native Fleet result".to_string())?;
        if evidence.sub_agent_id != request.sub_agent_id
            || evidence.target_id != request.target_id
            || evidence.role != SubAgentRoleV3::Verifier
            || evidence.status != AgentToolResultStatusV3::Completed
            || is_write_effect(&evidence.effect)
        {
            return Err("verification evidence is not an independent completed read".into());
        }
        let target = fleet
            .snapshot
            .targets
            .iter_mut()
            .find(|target| target.target_id == request.target_id)
            .ok_or_else(|| "verification target is outside the Fleet".to_string())?;
        if target.state != FleetTargetStateV3::AwaitingVerification {
            return Err("target is not awaiting verification".into());
        }
        if target.last_writer_sub_agent_id.as_deref() == Some(&request.sub_agent_id) {
            return Err("a writer cannot verify its own Fleet result".into());
        }
        target.verifier_sub_agent_id = Some(request.sub_agent_id);
        target.verification_evidence_call_id = Some(request.evidence_call_id);
        target.verification_summary = Some(summary.clone());
        if request.succeeded {
            target.state = FleetTargetStateV3::Succeeded;
            target.last_error = None;
        } else {
            target.state = FleetTargetStateV3::Failed;
            target.last_error = Some(summary);
            fleet.snapshot.failure_count = fleet.snapshot.failure_count.saturating_add(1);
        }
        fleet.snapshot.updated_at_unix_ms = current_unix_ms();
        advance_or_fail_stop(fleet);
        let snapshot = fleet.snapshot.clone();
        persist_locked(&state)?;
        Ok(snapshot)
    }

    pub(crate) fn record_rollback(
        &self,
        fleet_id: &str,
        target_id: &str,
        checkpoint_id: &str,
    ) -> Result<AgentFleetSnapshotV3, String> {
        validate_identifier(checkpoint_id, "checkpoint id")?;
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "Agent M5 Fleet store is unavailable".to_string())?;
        let fleet = state
            .fleets
            .get_mut(fleet_id)
            .ok_or_else(|| "Fleet was not found".to_string())?;
        let target = fleet
            .snapshot
            .targets
            .iter_mut()
            .find(|target| target.target_id == target_id)
            .ok_or_else(|| "rollback target is outside the Fleet".to_string())?;
        if !matches!(
            target.state,
            FleetTargetStateV3::Failed
                | FleetTargetStateV3::NeedsReconciliation
                | FleetTargetStateV3::AwaitingVerification
        ) {
            return Err("only a failed or uncertain Fleet target may record rollback".into());
        }
        target.state = FleetTargetStateV3::RolledBack;
        target.rollback_checkpoint_id = Some(checkpoint_id.to_string());
        fleet.snapshot.updated_at_unix_ms = current_unix_ms();
        advance_or_fail_stop(fleet);
        let snapshot = fleet.snapshot.clone();
        persist_locked(&state)?;
        Ok(snapshot)
    }

    pub(crate) fn reconcile_target(
        &self,
        fleet_id: &str,
        target_id: &str,
        continue_with_verification: bool,
    ) -> Result<AgentFleetSnapshotV3, String> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "Agent M5 Fleet store is unavailable".to_string())?;
        let fleet = state
            .fleets
            .get_mut(fleet_id)
            .ok_or_else(|| "Fleet was not found".to_string())?;
        let target = fleet
            .snapshot
            .targets
            .iter_mut()
            .find(|target| target.target_id == target_id)
            .ok_or_else(|| "reconciliation target is outside the Fleet".to_string())?;
        if target.state != FleetTargetStateV3::NeedsReconciliation {
            return Err("target is not awaiting reconciliation".into());
        }
        target.state = if continue_with_verification {
            FleetTargetStateV3::AwaitingVerification
        } else {
            fleet.snapshot.failure_count = fleet.snapshot.failure_count.saturating_add(1);
            FleetTargetStateV3::Failed
        };
        if fleet
            .snapshot
            .targets
            .iter()
            .all(|target| target.state != FleetTargetStateV3::NeedsReconciliation)
        {
            fleet.snapshot.state = FleetStateV3::Running;
        }
        fleet.snapshot.updated_at_unix_ms = current_unix_ms();
        advance_or_fail_stop(fleet);
        let snapshot = fleet.snapshot.clone();
        persist_locked(&state)?;
        Ok(snapshot)
    }

    pub(crate) fn task_for_target(
        &self,
        fleet_id: &str,
        target_id: &str,
    ) -> Result<String, String> {
        self.inner
            .lock()
            .map_err(|_| "Agent M5 Fleet store is unavailable".to_string())?
            .fleets
            .get(fleet_id)
            .and_then(|fleet| {
                fleet
                    .snapshot
                    .targets
                    .iter()
                    .find(|target| target.target_id == target_id)
            })
            .map(|target| target.task_id.clone())
            .ok_or_else(|| "Fleet target was not found".to_string())
    }

    pub(crate) fn frozen_scope_for_target(
        &self,
        fleet_id: &str,
        target_id: &str,
    ) -> Result<FrozenFleetScopeV3, String> {
        let state = self
            .inner
            .lock()
            .map_err(|_| "Agent M5 Fleet store is unavailable".to_string())?;
        let target = state
            .fleets
            .get(fleet_id)
            .and_then(|fleet| {
                fleet
                    .snapshot
                    .targets
                    .iter()
                    .find(|target| target.target_id == target_id)
            })
            .ok_or_else(|| "Fleet target was not found".to_string())?;
        Ok(FrozenFleetScopeV3 {
            task_id: target.task_id.clone(),
            target_id: target.target_id.clone(),
            plan_version: target.plan_version,
            allowed_tools: target.allowed_tools.clone(),
            allowed_effects: target.allowed_effects.clone(),
        })
    }

    pub(crate) fn get(&self, fleet_id: &str) -> Result<AgentFleetSnapshotV3, String> {
        self.inner
            .lock()
            .map_err(|_| "Agent M5 Fleet store is unavailable".to_string())?
            .fleets
            .get(fleet_id)
            .map(|fleet| fleet.snapshot.clone())
            .ok_or_else(|| "Fleet was not found".to_string())
    }

    pub(crate) fn list(&self) -> Result<Vec<AgentFleetSnapshotV3>, String> {
        let mut fleets = self
            .inner
            .lock()
            .map_err(|_| "Agent M5 Fleet store is unavailable".to_string())?
            .fleets
            .values()
            .map(|fleet| fleet.snapshot.clone())
            .collect::<Vec<_>>();
        fleets.sort_by_key(|fleet| fleet.created_at_unix_ms);
        Ok(fleets)
    }
}

fn sanitized_selector(mut selector: FleetSelectorV3) -> FleetSelectorV3 {
    selector.labels = selector
        .labels
        .into_iter()
        .map(|(key, value)| (redact_sensitive_text(&key), redact_sensitive_text(&value)))
        .collect();
    selector.groups = selector
        .groups
        .into_iter()
        .map(|value| redact_sensitive_text(&value))
        .collect();
    selector.environments = selector
        .environments
        .into_iter()
        .map(|value| redact_sensitive_text(&value))
        .collect();
    selector
}

fn sanitized_member(mut member: FleetMemberV3) -> FleetMemberV3 {
    member.display_name = redact_sensitive_text(&member.display_name);
    member.group = redact_sensitive_text(&member.group);
    member.environment = redact_sensitive_text(&member.environment);
    member.labels = member
        .labels
        .into_iter()
        .map(|(key, value)| (redact_sensitive_text(&key), redact_sensitive_text(&value)))
        .collect();
    member
}

fn validate_policy(policy: &FleetPolicyV3) -> Result<(), String> {
    if policy.max_concurrency == 0
        || policy.max_concurrency > 32
        || policy.batch_size == 0
        || policy.batch_size > 64
        || policy.canary_size > policy.batch_size
        || policy.jitter_ms > MAX_JITTER_MS
        || policy.max_calls_total == 0
        || policy.max_calls_total > MAX_CALL_HISTORY as u32
        || policy.max_calls_per_target == 0
    {
        return Err(
            "Fleet policy is outside native concurrency, batch, jitter, or budget limits".into(),
        );
    }
    Ok(())
}

fn validate_selector(selector: &FleetSelectorV3) -> Result<(), String> {
    if selector.labels.len() > 16 || selector.groups.len() > 32 || selector.environments.len() > 32
    {
        return Err("Fleet selector exceeded native bounds".into());
    }
    for (key, value) in &selector.labels {
        validate_text(key, 1, 64, "selector label key")?;
        validate_text(value, 1, 128, "selector label value")?;
    }
    for value in selector.groups.iter().chain(selector.environments.iter()) {
        validate_text(value, 1, 128, "selector value")?;
    }
    Ok(())
}

fn validate_member(member: &FleetMemberV3) -> Result<(), String> {
    validate_identifier(&member.task_id, "task id")?;
    validate_identifier(&member.target_id, "target id")?;
    validate_text(&member.display_name, 1, 128, "target display name")?;
    validate_text(&member.group, 1, 128, "target group")?;
    validate_text(&member.environment, 1, 128, "target environment")?;
    if member.labels.len() > 16 {
        return Err("Fleet member label count exceeded native bounds".into());
    }
    for (key, value) in &member.labels {
        validate_text(key, 1, 64, "member label key")?;
        validate_text(value, 1, 128, "member label value")?;
    }
    Ok(())
}

fn validate_identifier(value: &str, name: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':'))
    {
        return Err(format!("{name} is invalid"));
    }
    Ok(())
}

fn validate_text(value: &str, min: usize, max: usize, name: &str) -> Result<(), String> {
    if value.len() < min || value.len() > max || value.contains('\0') {
        return Err(format!("{name} is outside native bounds"));
    }
    Ok(())
}

fn selector_matches(selector: &FleetSelectorV3, member: &FleetMemberV3) -> bool {
    selector
        .labels
        .iter()
        .all(|(key, value)| member.labels.get(key) == Some(value))
        && (selector.groups.is_empty() || selector.groups.contains(&member.group))
        && (selector.environments.is_empty() || selector.environments.contains(&member.environment))
}

fn build_waves(
    targets: &[FleetTargetSnapshotV3],
    policy: &FleetPolicyV3,
    write_intent: bool,
) -> Vec<Vec<String>> {
    let mut ids = targets
        .iter()
        .map(|target| target.target_id.clone())
        .collect::<Vec<_>>();
    let first_size = if write_intent {
        usize::from(policy.canary_size).min(ids.len())
    } else {
        usize::from(policy.batch_size).min(ids.len())
    };
    let mut waves = vec![ids.drain(..first_size).collect::<Vec<_>>()];
    let batch_size = usize::from(policy.batch_size);
    while !ids.is_empty() {
        let take = batch_size.min(ids.len());
        waves.push(ids.drain(..take).collect());
    }
    waves
}

fn target_digest(targets: &[FleetTargetSnapshotV3]) -> Result<String, String> {
    let bytes = serde_json::to_vec(targets)
        .map_err(|error| format!("failed to freeze Fleet target snapshot: {error}"))?;
    Ok(Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn sorted_unique(mut values: Vec<String>) -> Vec<String> {
    values.sort();
    values.dedup();
    values
}

fn sorted_unique_effects(mut values: Vec<AgentEffectKindV3>) -> Vec<AgentEffectKindV3> {
    values.sort_by_key(|effect| *effect as u8);
    values.dedup();
    values
}

fn is_write_effect(effect: &AgentEffectKindV3) -> bool {
    matches!(
        effect,
        AgentEffectKindV3::StateChange
            | AgentEffectKindV3::Destructive
            | AgentEffectKindV3::ExternalSideEffect
    )
}

fn paths_conflict(left: &[String], right: &[String]) -> bool {
    left.is_empty()
        || right.is_empty()
        || left.iter().any(|left_path| {
            right.iter().any(|right_path| {
                left_path == right_path
                    || left_path.starts_with(&format!("{right_path}/"))
                    || right_path.starts_with(&format!("{left_path}/"))
            })
        })
}

fn deterministic_jitter(call_id: &str, maximum: u64) -> u64 {
    if maximum == 0 {
        return 0;
    }
    let digest = Sha256::digest(call_id.as_bytes());
    let value = u64::from_be_bytes(digest[..8].try_into().expect("digest has eight bytes"));
    value % maximum.saturating_add(1)
}

fn advance_or_fail_stop(fleet: &mut FleetRecordV3) {
    if fleet.snapshot.state == FleetStateV3::NeedsReconciliation {
        return;
    }
    let canary_failed = fleet.snapshot.write_intent
        && fleet.snapshot.current_wave == 0
        && fleet
            .snapshot
            .targets
            .iter()
            .any(|target| target.wave_index == 0 && target.state == FleetTargetStateV3::Failed);
    if canary_failed || fleet.snapshot.failure_count > fleet.snapshot.policy.max_failures {
        fleet.snapshot.state = FleetStateV3::FailStopped;
        for target in &mut fleet.snapshot.targets {
            if matches!(
                target.state,
                FleetTargetStateV3::Pending | FleetTargetStateV3::Canary
            ) {
                target.state = FleetTargetStateV3::Blocked;
                target.last_error = Some("blocked by native Fleet failure threshold".into());
            }
        }
        return;
    }
    let current_terminal = fleet
        .snapshot
        .targets
        .iter()
        .filter(|target| target.wave_index == fleet.snapshot.current_wave)
        .all(|target| {
            matches!(
                target.state,
                FleetTargetStateV3::Succeeded
                    | FleetTargetStateV3::Failed
                    | FleetTargetStateV3::RolledBack
            )
        });
    if !current_terminal {
        return;
    }
    if fleet.snapshot.current_wave + 1 < fleet.snapshot.waves.len() {
        fleet.snapshot.current_wave += 1;
        fleet.snapshot.state = FleetStateV3::Running;
    } else {
        fleet.snapshot.state = if fleet.snapshot.failure_count == 0 {
            FleetStateV3::Completed
        } else {
            FleetStateV3::CompletedWithFailures
        };
    }
}

fn persist_locked(state: &FleetStateStoreV3) -> Result<(), String> {
    let Some(root) = state.root.as_ref() else {
        return Ok(());
    };
    let envelope = FleetEnvelopeV3 {
        version: FLEET_STORE_VERSION,
        written_at_unix_ms: current_unix_ms(),
        fleets: state.fleets.values().cloned().collect(),
    };
    let bytes = serde_json::to_vec_pretty(&envelope)
        .map_err(|error| format!("failed to serialize Agent M5 store: {error}"))?;
    if bytes.len() > MAX_STORE_BYTES {
        return Err("Agent M5 persistence exceeded its bounded size".into());
    }
    let path = root.join("fleets-v1.json");
    let mut temp = tempfile::NamedTempFile::new_in(root)
        .map_err(|error| format!("failed to create Agent M5 temporary store: {error}"))?;
    temp.write_all(&bytes)
        .and_then(|_| temp.as_file().sync_all())
        .map_err(|error| format!("failed to sync Agent M5 temporary store: {error}"))?;
    temp.persist(&path).map_err(|error| {
        format!(
            "failed to atomically replace Agent M5 store: {}",
            error.error
        )
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::agent_contract_v3::{AgentObservedEffectV3, AgentToolTargetV3};

    fn scope(task: &str, target: &str) -> FrozenFleetScopeV3 {
        FrozenFleetScopeV3 {
            task_id: task.into(),
            target_id: target.into(),
            plan_version: 1,
            allowed_tools: vec!["apply_patch".into(), "read_file".into()],
            allowed_effects: vec![AgentEffectKindV3::StateChange, AgentEffectKindV3::ReadOnly],
        }
    }

    fn registration() -> RegisterFleetRequestV3 {
        RegisterFleetRequestV3 {
            fleet_id: "fleet-1".into(),
            goal: "Roll out a verified change".into(),
            members: (1..=3)
                .map(|index| FleetMemberV3 {
                    task_id: format!("task-{index}"),
                    target_id: format!("target-{index}"),
                    display_name: format!("Host {index}"),
                    labels: BTreeMap::from([("service".into(), "api".into())]),
                    group: "production".into(),
                    environment: "prod".into(),
                })
                .collect(),
            selector: FleetSelectorV3 {
                labels: BTreeMap::from([("service".into(), "api".into())]),
                groups: vec!["production".into()],
                environments: vec!["prod".into()],
            },
            policy: FleetPolicyV3 {
                max_concurrency: 2,
                batch_size: 2,
                canary_size: 1,
                max_failures: 1,
                jitter_ms: 0,
                max_calls_total: 24,
                max_calls_per_target: 8,
            },
        }
    }

    fn call(call_id: &str, target: &str, tool: &str) -> AgentToolCallV3 {
        AgentToolCallV3 {
            request_id: format!("req-{target}"),
            call_id: call_id.into(),
            tool_name: tool.into(),
            arguments: json!({"path": "config.txt", "encoding": "utf8"}),
            target: AgentToolTargetV3::Local {
                target_id: target.into(),
                session_id: format!("session-{target}"),
                cwd: Some("/workspace".into()),
            },
            capability_id: "opaque".into(),
        }
    }

    fn result(call_id: &str, target: &str, status: AgentToolResultStatusV3) -> AgentToolResultV3 {
        AgentToolResultV3 {
            request_id: format!("req-{target}"),
            call_id: call_id.into(),
            tool_name: "read_file".into(),
            target_id: target.into(),
            status,
            summary: "native result".into(),
            data: None,
            artifacts: Vec::new(),
            effects: vec![AgentObservedEffectV3 {
                kind: AgentEffectKindV3::ReadOnly,
                target_id: target.into(),
                summary: "read".into(),
                paths: vec!["config.txt".into()],
                network_destinations: Vec::new(),
            }],
            truncated: None,
        }
    }

    #[test]
    fn freezes_selector_and_forces_write_canary_before_batches() {
        let runtime = FleetRuntimeV3::default();
        let snapshot = runtime
            .register(
                registration(),
                vec![
                    scope("task-1", "target-1"),
                    scope("task-2", "target-2"),
                    scope("task-3", "target-3"),
                ],
            )
            .unwrap();
        assert!(snapshot.write_intent);
        assert_eq!(
            snapshot.waves,
            vec![vec!["target-1"], vec!["target-2", "target-3"]]
        );
        assert_eq!(snapshot.targets[0].state, FleetTargetStateV3::Canary);
        assert_eq!(snapshot.target_snapshot_sha256.len(), 64);
    }

    #[test]
    fn role_subset_and_independent_verifier_gate_completion() {
        let runtime = FleetRuntimeV3::default();
        runtime
            .register(
                registration(),
                vec![
                    scope("task-1", "target-1"),
                    scope("task-2", "target-2"),
                    scope("task-3", "target-3"),
                ],
            )
            .unwrap();
        let operator = runtime
            .register_sub_agent(RegisterSubAgentRequestV3 {
                fleet_id: "fleet-1".into(),
                role: SubAgentRoleV3::Operator,
                target_ids: vec!["target-1".into()],
                tool_names: vec!["apply_patch".into()],
                effects: vec![AgentEffectKindV3::StateChange],
                max_calls: 2,
            })
            .unwrap();
        let verifier = runtime
            .register_sub_agent(RegisterSubAgentRequestV3 {
                fleet_id: "fleet-1".into(),
                role: SubAgentRoleV3::Verifier,
                target_ids: vec!["target-1".into()],
                tool_names: vec!["read_file".into()],
                effects: vec![AgentEffectKindV3::ReadOnly],
                max_calls: 2,
            })
            .unwrap();
        let scope = CallPolicyScopeV3 {
            paths: vec!["/workspace/.env-secret".into()],
            network_destinations: Vec::new(),
            sensitive_path_count: 0,
            critical_path_count: 0,
            unknown_write: false,
            unknown_network_egress: false,
        };
        let mut write = call("write-1", "target-1", "apply_patch");
        write.arguments = json!({"patch": "x", "preconditions": []});
        runtime
            .begin_dispatch(
                "fleet-1",
                &operator.sub_agent_id,
                &write,
                AgentEffectKindV3::StateChange,
                &scope,
            )
            .unwrap();
        runtime
            .finish_dispatch(
                "fleet-1",
                "write-1",
                &result("write-1", "target-1", AgentToolResultStatusV3::Completed),
            )
            .unwrap();
        assert_eq!(
            runtime.get("fleet-1").unwrap().targets[0].state,
            FleetTargetStateV3::AwaitingVerification
        );

        let verify = call("verify-1", "target-1", "read_file");
        runtime
            .begin_dispatch(
                "fleet-1",
                &verifier.sub_agent_id,
                &verify,
                AgentEffectKindV3::ReadOnly,
                &scope,
            )
            .unwrap();
        runtime
            .finish_dispatch(
                "fleet-1",
                "verify-1",
                &result("verify-1", "target-1", AgentToolResultStatusV3::Completed),
            )
            .unwrap();
        let advanced = runtime
            .submit_verification(SubmitFleetVerificationRequestV3 {
                fleet_id: "fleet-1".into(),
                sub_agent_id: verifier.sub_agent_id,
                target_id: "target-1".into(),
                evidence_call_id: "verify-1".into(),
                succeeded: true,
                summary: "read-back matched".into(),
            })
            .unwrap();
        assert_eq!(advanced.current_wave, 1);
        assert_eq!(advanced.targets[0].state, FleetTargetStateV3::Succeeded);
    }

    #[test]
    fn canary_failure_is_visible_and_fail_stops_every_unstarted_host() {
        let runtime = FleetRuntimeV3::default();
        runtime
            .register(
                registration(),
                vec![
                    scope("task-1", "target-1"),
                    scope("task-2", "target-2"),
                    scope("task-3", "target-3"),
                ],
            )
            .unwrap();
        let operator = runtime
            .register_sub_agent(RegisterSubAgentRequestV3 {
                fleet_id: "fleet-1".into(),
                role: SubAgentRoleV3::Operator,
                target_ids: vec!["target-1".into()],
                tool_names: vec!["apply_patch".into()],
                effects: vec![AgentEffectKindV3::StateChange],
                max_calls: 1,
            })
            .unwrap();
        let scope = CallPolicyScopeV3 {
            paths: vec!["config.txt".into()],
            network_destinations: Vec::new(),
            sensitive_path_count: 0,
            critical_path_count: 0,
            unknown_write: false,
            unknown_network_egress: false,
        };
        runtime
            .begin_dispatch(
                "fleet-1",
                &operator.sub_agent_id,
                &call("write-1", "target-1", "apply_patch"),
                AgentEffectKindV3::StateChange,
                &scope,
            )
            .unwrap();
        let snapshot = runtime
            .finish_dispatch(
                "fleet-1",
                "write-1",
                &result("write-1", "target-1", AgentToolResultStatusV3::Failed),
            )
            .unwrap();
        assert_eq!(snapshot.state, FleetStateV3::FailStopped);
        assert_eq!(snapshot.failure_count, 1);
        assert_eq!(snapshot.targets[0].state, FleetTargetStateV3::Failed);
        assert!(snapshot.targets[1..]
            .iter()
            .all(|target| target.state == FleetTargetStateV3::Blocked));
    }

    #[test]
    fn restart_marks_inflight_target_for_reconciliation_without_replay() {
        let directory = tempfile::tempdir().unwrap();
        let runtime = FleetRuntimeV3::default();
        runtime.configure(directory.path()).unwrap();
        runtime
            .register(
                registration(),
                vec![
                    scope("task-1", "target-1"),
                    scope("task-2", "target-2"),
                    scope("task-3", "target-3"),
                ],
            )
            .unwrap();
        let operator = runtime
            .register_sub_agent(RegisterSubAgentRequestV3 {
                fleet_id: "fleet-1".into(),
                role: SubAgentRoleV3::Operator,
                target_ids: vec!["target-1".into()],
                tool_names: vec!["apply_patch".into()],
                effects: vec![AgentEffectKindV3::StateChange],
                max_calls: 1,
            })
            .unwrap();
        let scope = CallPolicyScopeV3 {
            paths: vec!["/workspace/.env-secret".into()],
            network_destinations: Vec::new(),
            sensitive_path_count: 0,
            critical_path_count: 0,
            unknown_write: false,
            unknown_network_egress: false,
        };
        runtime
            .begin_dispatch(
                "fleet-1",
                &operator.sub_agent_id,
                &call("write-1", "target-1", "apply_patch"),
                AgentEffectKindV3::StateChange,
                &scope,
            )
            .unwrap();
        let persisted =
            fs::read_to_string(directory.path().join("agent-m5").join("fleets-v1.json")).unwrap();
        assert!(!persisted.contains(".env-secret"));

        let restarted = FleetRuntimeV3::default();
        restarted.configure(directory.path()).unwrap();
        let recovered = restarted.get("fleet-1").unwrap();
        assert_eq!(recovered.state, FleetStateV3::NeedsReconciliation);
        assert_eq!(
            recovered.targets[0].state,
            FleetTargetStateV3::NeedsReconciliation
        );
        assert!(recovered.targets[0]
            .last_error
            .as_deref()
            .unwrap()
            .contains("not be replayed"));
        assert!(recovered.sub_agents.iter().all(|agent| !agent.active));
    }
}
