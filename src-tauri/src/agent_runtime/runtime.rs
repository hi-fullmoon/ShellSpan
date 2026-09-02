use std::collections::HashMap;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::ai::AiProviderConfig;
use base64::Engine;

use super::{
    drive_agent, recover_open_scope, AgentArtifactStore, AgentCompactionManager, AgentDriverConfig,
    AgentDriverSettlement, AgentHookBus, AgentInboxLane, AgentInboxMessage, AgentLifecyclePhase,
    AgentMessageSource, AgentRegistry, AgentSessionEvent, AgentSessionEventPage,
    AgentSessionEventsRequest, AgentSessionListPage, AgentSessionListRequest, AgentSessionSnapshot,
    AgentSessionStore, AgentToolDecision, AgentToolDecisionInput, AgentToolPipeline,
    CreateAgentSessionRequest, ModelRegistry, NativeToolAdapter, NativeToolEngine,
    NativeToolRuntime, NativeToolRuntimeSlot, OrchestrationToolRuntime,
    OrchestrationToolRuntimeSlot, SubAgentManager,
};

#[cfg(test)]
use super::{
    AgentAfterToolHook, AgentBeforeToolHook, AgentPreStepHook, AgentSessionEventPayload,
    AgentToolFailedHook, ModelAdapterFactory,
};

pub(crate) struct AgentRuntimeBuilder {
    sessions: AgentSessionStore,
    models: ModelRegistry,
    hooks: AgentHookBus,
    driver_config: AgentDriverConfig,
    native_tools: Arc<dyn NativeToolRuntime>,
    native_slot: Option<NativeToolRuntimeSlot>,
    native_engine: Arc<NativeToolEngine>,
    artifacts: AgentArtifactStore,
    orchestration_slot: OrchestrationToolRuntimeSlot,
}

impl AgentRuntimeBuilder {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    #[cfg(test)]
    pub(crate) fn model_factory(mut self, factory: Arc<dyn ModelAdapterFactory>) -> Self {
        self.models = ModelRegistry::with_factory(factory);
        self
    }

    #[cfg(test)]
    pub(crate) fn pre_step_hook(mut self, hook: Arc<dyn AgentPreStepHook>) -> Self {
        self.hooks = self.hooks.with_pre_step_hook(hook);
        self
    }

    #[cfg(test)]
    pub(crate) fn before_tool_hook(mut self, hook: Arc<dyn AgentBeforeToolHook>) -> Self {
        self.hooks = self.hooks.with_before_tool_hook(hook);
        self
    }

    #[cfg(test)]
    pub(crate) fn after_tool_hook(mut self, hook: Arc<dyn AgentAfterToolHook>) -> Self {
        self.hooks = self.hooks.with_after_tool_hook(hook);
        self
    }

    #[cfg(test)]
    pub(crate) fn tool_failed_hook(mut self, hook: Arc<dyn AgentToolFailedHook>) -> Self {
        self.hooks = self.hooks.with_tool_failed_hook(hook);
        self
    }

    #[cfg(test)]
    pub(crate) fn driver_config(mut self, driver_config: AgentDriverConfig) -> Self {
        self.driver_config = driver_config;
        self
    }

    #[cfg(test)]
    pub(crate) fn native_tool_runtime(mut self, native: Arc<dyn NativeToolRuntime>) -> Self {
        self.native_tools = native;
        self.native_slot = None;
        self
    }

    pub(crate) fn build(self) -> AgentRuntime {
        let agents = AgentRegistry::default();
        let tool_pipeline = AgentToolPipeline::new(
            self.sessions.clone(),
            self.hooks.clone(),
            Arc::clone(&self.native_tools),
            self.artifacts.clone(),
            self.orchestration_slot.clone(),
        );
        let compactions =
            AgentCompactionManager::new(self.sessions.clone(), self.artifacts.clone());
        let subagents = Arc::new(SubAgentManager::new(
            self.sessions.clone(),
            agents.clone(),
            self.models.clone(),
            self.hooks.clone(),
            tool_pipeline.clone(),
            compactions.clone(),
            self.driver_config,
        ));
        let orchestration: Arc<dyn OrchestrationToolRuntime> = subagents.clone();
        self.orchestration_slot
            .install(&orchestration)
            .expect("fresh orchestration slot is available");
        AgentRuntime {
            sessions: self.sessions,
            agents,
            handles: Arc::new(Mutex::new(HashMap::new())),
            models: self.models,
            hooks: self.hooks,
            tools: tool_pipeline,
            artifacts: self.artifacts,
            compactions,
            native_slot: self.native_slot,
            native_engine: self.native_engine,
            driver_config: self.driver_config,
            subagents,
        }
    }
}

#[derive(Clone)]
pub(crate) struct AgentRuntime {
    sessions: AgentSessionStore,
    agents: AgentRegistry,
    handles: Arc<Mutex<HashMap<String, super::AgentHandle>>>,
    models: ModelRegistry,
    hooks: AgentHookBus,
    tools: AgentToolPipeline,
    artifacts: AgentArtifactStore,
    compactions: AgentCompactionManager,
    native_slot: Option<NativeToolRuntimeSlot>,
    native_engine: Arc<NativeToolEngine>,
    driver_config: AgentDriverConfig,
    subagents: Arc<SubAgentManager>,
}

struct ActiveDriverLease(Arc<super::AgentEntry>);

impl Drop for ActiveDriverLease {
    fn drop(&mut self) {
        self.0.release_driver();
    }
}

impl Default for AgentRuntime {
    fn default() -> Self {
        AgentRuntimeBuilder::new().build()
    }
}

impl Default for AgentRuntimeBuilder {
    fn default() -> Self {
        let native_slot = NativeToolRuntimeSlot::default();
        let native_engine = Arc::new(NativeToolEngine::default());
        Self {
            sessions: AgentSessionStore::default(),
            models: ModelRegistry::default(),
            hooks: AgentHookBus::default(),
            driver_config: AgentDriverConfig::default(),
            native_tools: Arc::new(native_slot.clone()),
            native_slot: Some(native_slot),
            native_engine,
            artifacts: AgentArtifactStore::default(),
            orchestration_slot: OrchestrationToolRuntimeSlot::default(),
        }
    }
}

impl AgentRuntime {
    pub(crate) fn configure_credentials(
        &self,
        credentials: crate::keychain::CredentialManager,
    ) -> Result<(), String> {
        self.subagents.set_credentials(credentials)
    }

    pub(crate) fn configure_native(&self, app: tauri::AppHandle) -> Result<(), String> {
        if let Some(slot) = &self.native_slot {
            slot.install(Arc::new(NativeToolAdapter::new(
                app,
                Arc::clone(&self.native_engine),
            )))?;
        }
        Ok(())
    }

    pub(crate) fn observe_terminal_output(&self, session_id: &str, chunk: &str) {
        self.native_engine.observe_pty_output(session_id, chunk);
    }

    pub(crate) fn prepare_for_shutdown(
        &self,
        sessions: &crate::models::SessionManager,
    ) -> Result<usize, String> {
        self.native_engine.prepare_for_shutdown(sessions)
    }

    pub(crate) fn configure(&self, app_data_root: PathBuf) -> Result<(), String> {
        self.sessions.configure(app_data_root.clone())?;
        self.artifacts.configure(&app_data_root)?;
        self.reconcile_artifacts()
    }

    pub(crate) fn set_event_publisher(
        &self,
        publisher: Arc<dyn Fn(&AgentSessionEvent) + Send + Sync>,
    ) -> Result<(), String> {
        self.sessions.set_publisher(publisher)
    }

    pub(crate) fn create_session(
        &self,
        request: CreateAgentSessionRequest,
    ) -> Result<AgentSessionSnapshot, String> {
        self.sessions.create(request)
    }

    pub(crate) fn start(
        &self,
        session_id: &str,
        provider: AiProviderConfig,
        api_key: Option<String>,
    ) -> Result<AgentSessionSnapshot, String> {
        if self.agents.get(session_id)?.is_some() {
            self.wake(session_id)?;
            return self.sessions.snapshot(session_id);
        }
        let adapter = self.models.resolve(provider.clone(), api_key)?;
        let handle = self.agents.attach(
            self.sessions.clone(),
            session_id.to_string(),
            provider,
            adapter,
        )?;
        let entry = handle.entry();
        let recovery = self.sessions.snapshot(session_id)?.recovery;
        if matches!(
            recovery.status,
            super::AgentRecoveryStatus::Available | super::AgentRecoveryStatus::Required
        ) {
            entry.set_phase(AgentLifecyclePhase::Waiting)?;
        }
        if let Err(error) = recover_open_scope(&self.sessions, &entry) {
            self.agents.detach(session_id)?;
            return Err(error);
        }
        if let Err(error) = self.tools.recover_waiting(&entry) {
            self.agents.detach(session_id)?;
            return Err(error);
        }
        let mut handles = match self.handles.lock() {
            Ok(handles) => handles,
            Err(_) => {
                self.agents.detach(session_id)?;
                return Err("Agent handle registry is unavailable".into());
            }
        };
        if handles.contains_key(session_id) {
            self.agents.detach(session_id)?;
            return Err("Agent Session already has an owning handle".into());
        }
        handles.insert(session_id.to_string(), handle);
        drop(handles);
        self.wake(session_id)?;
        self.sessions.snapshot(session_id)
    }

    pub(crate) fn followup(
        &self,
        session_id: &str,
        message_id: String,
        content: String,
    ) -> Result<AgentSessionSnapshot, String> {
        let snapshot = self.sessions.enqueue(
            session_id,
            AgentInboxLane::NextTurn,
            AgentInboxMessage {
                message_id,
                content,
                source: AgentMessageSource::User,
            },
        )?;
        self.wake(session_id)?;
        Ok(snapshot)
    }

    pub(crate) fn steer(
        &self,
        session_id: &str,
        message_id: String,
        content: String,
    ) -> Result<AgentSessionSnapshot, String> {
        let snapshot = self.sessions.enqueue(
            session_id,
            AgentInboxLane::NextStep,
            AgentInboxMessage {
                message_id,
                content,
                source: AgentMessageSource::User,
            },
        )?;
        self.wake(session_id)?;
        Ok(snapshot)
    }

    pub(crate) fn inject(
        &self,
        session_id: &str,
        message_id: String,
        label: String,
        content: String,
    ) -> Result<AgentSessionSnapshot, String> {
        self.sessions.enqueue(
            session_id,
            AgentInboxLane::NextStep,
            AgentInboxMessage {
                message_id,
                content,
                source: AgentMessageSource::Runtime { label },
            },
        )
    }

    pub(crate) async fn cancel(&self, session_id: &str) -> Result<AgentSessionSnapshot, String> {
        self.subagents.cancel_descendants(session_id).await?;
        let handle = self
            .handles
            .lock()
            .map_err(|_| "Agent handle registry is unavailable".to_string())?
            .remove(session_id);
        if let Some(handle) = handle {
            self.tools.cancel_session(&handle.entry())?;
            match handle.dispose().await {
                Ok(snapshot) => return Ok(snapshot),
                Err(error) => {
                    if self.agents.get(session_id)?.is_some() {
                        self.handles
                            .lock()
                            .map_err(|_| "Agent handle registry is unavailable".to_string())?
                            .insert(session_id.to_string(), handle);
                    }
                    return Err(error);
                }
            }
        }
        if self.agents.get(session_id)?.is_some() {
            return Err("Agent Session is already stopping".into());
        }
        self.sessions.cancel(session_id)
    }

    pub(crate) async fn spawn_subagent(
        &self,
        request: super::AgentSubagentSpawnRequest,
    ) -> Result<AgentSessionSnapshot, String> {
        self.subagents.spawn_from_command(request).await
    }

    pub(crate) async fn send_child_input(
        &self,
        request: super::AgentChildInputRequest,
    ) -> Result<AgentSessionSnapshot, String> {
        self.subagents.send_from_command(request).await
    }

    pub(crate) fn inspect_child_agent(
        &self,
        request: super::AgentChildRequest,
    ) -> Result<super::AgentChildInspection, String> {
        self.subagents.inspect_from_command(request)
    }

    pub(crate) async fn cancel_child_agent(
        &self,
        request: super::AgentChildRequest,
    ) -> Result<AgentSessionSnapshot, String> {
        self.subagents.cancel_from_command(request).await
    }

    pub(crate) fn plan_fleet(
        &self,
        request: super::AgentFleetPlanRequest,
    ) -> Result<super::AgentFleetInspection, String> {
        self.subagents.plan_fleet(request)
    }

    pub(crate) async fn start_fleet(
        &self,
        request: super::AgentFleetControlRequest,
    ) -> Result<super::AgentFleetInspection, String> {
        self.subagents.start_fleet(request).await
    }

    pub(crate) fn pause_fleet(
        &self,
        request: super::AgentFleetControlRequest,
    ) -> Result<super::AgentFleetInspection, String> {
        self.subagents.pause_fleet(request)
    }

    pub(crate) async fn abort_fleet(
        &self,
        request: super::AgentFleetControlRequest,
    ) -> Result<super::AgentFleetInspection, String> {
        self.subagents.abort_fleet(request).await
    }

    pub(crate) fn reconcile_fleet(
        &self,
        request: super::AgentFleetReconcileRequest,
    ) -> Result<super::AgentFleetInspection, String> {
        self.subagents.reconcile_fleet(request)
    }

    pub(crate) async fn approve_tool(
        &self,
        input: AgentToolDecisionInput,
    ) -> Result<AgentSessionSnapshot, String> {
        self.decide_tool(input, AgentToolDecision::Approve).await
    }

    pub(crate) async fn reject_tool(
        &self,
        input: AgentToolDecisionInput,
    ) -> Result<AgentSessionSnapshot, String> {
        self.decide_tool(input, AgentToolDecision::Reject).await
    }

    async fn decide_tool(
        &self,
        input: AgentToolDecisionInput,
        decision: AgentToolDecision,
    ) -> Result<AgentSessionSnapshot, String> {
        let entry = self
            .agents
            .get(&input.session_id)?
            .ok_or_else(|| "Agent Session is not started".to_string())?;
        self.tools.decide(&entry, input.clone(), decision).await?;
        self.wake(&input.session_id)?;
        self.sessions.snapshot(&input.session_id)
    }

    #[cfg(test)]
    pub(crate) async fn await_idle(&self, session_id: &str) -> Result<(), String> {
        if let Some(entry) = self.agents.get(session_id)? {
            loop {
                entry.await_idle().await;
                let snapshot = self.sessions.snapshot(session_id)?;
                if snapshot.inbox.next_turn.is_empty() && snapshot.inbox.next_step.is_empty()
                    || snapshot.ended
                    || entry.phase()? == AgentLifecyclePhase::Waiting
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        }
        Ok(())
    }

    pub(crate) fn session(&self, session_id: &str) -> Result<AgentSessionSnapshot, String> {
        self.sessions.snapshot(session_id)
    }

    pub(crate) fn sessions(
        &self,
        request: AgentSessionListRequest,
    ) -> Result<AgentSessionListPage, String> {
        self.sessions.list_page(request)
    }

    pub(crate) fn archive_session(&self, session_id: &str) -> Result<AgentSessionSnapshot, String> {
        if self.agents.get(session_id)?.is_some() {
            return Err("a running Agent Session cannot be archived".into());
        }
        self.sessions.archive(session_id)
    }

    pub(crate) fn events(
        &self,
        request: AgentSessionEventsRequest,
    ) -> Result<AgentSessionEventPage, String> {
        self.sessions.events_page(request)
    }

    pub(crate) fn committed_events(
        &self,
        request: super::AgentCommittedEventsRequest,
    ) -> Result<AgentSessionEventPage, String> {
        self.sessions.committed_events_page(request)
    }

    pub(crate) fn artifact(
        &self,
        request: super::AgentArtifactRequest,
    ) -> Result<super::AgentArtifactResponse, String> {
        let metadata = self
            .sessions
            .all_events(&request.session_id)?
            .iter()
            .find_map(|event| match &event.payload {
                super::AgentSessionEventPayload::ContextArtifact {
                    artifact_id,
                    kind,
                    title,
                    size_bytes: Some(size_bytes),
                    media_type: Some(media_type),
                    sha256: Some(sha256),
                    sensitivity: Some(sensitivity),
                } if artifact_id == &request.artifact_id => Some(super::AgentArtifactMetadata {
                    artifact_id: artifact_id.clone(),
                    kind: kind.clone(),
                    title: title.clone(),
                    media_type: media_type.clone(),
                    sha256: sha256.clone(),
                    size_bytes: *size_bytes,
                    sensitivity: *sensitivity,
                    created_at_unix_ms: event.time_unix_ms,
                }),
                _ => None,
            })
            .ok_or_else(|| {
                "Agent artifact metadata was not found in the committed log".to_string()
            })?;
        let bytes = self
            .artifacts
            .retrieve(&request.session_id, &metadata, request.max_bytes)?;
        Ok(super::AgentArtifactResponse {
            truncated: bytes.len() < metadata.size_bytes as usize,
            body_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
            metadata,
        })
    }

    fn reconcile_artifacts(&self) -> Result<(), String> {
        let mut referenced = HashSet::new();
        for session_id in self.sessions.session_ids()? {
            let events = self.sessions.all_events(&session_id)?;
            let mut existing_evidence = events
                .iter()
                .filter_map(|event| match &event.payload {
                    super::AgentSessionEventPayload::TaskEvidence { evidence_id, .. } => {
                        Some(evidence_id.clone())
                    }
                    _ => None,
                })
                .collect::<HashSet<_>>();
            for event in events {
                let super::AgentSessionEventPayload::ContextArtifact {
                    artifact_id,
                    kind,
                    title,
                    size_bytes: Some(size_bytes),
                    media_type: Some(media_type),
                    sha256: Some(sha256),
                    sensitivity: Some(sensitivity),
                } = event.payload
                else {
                    continue;
                };
                referenced.insert((session_id.clone(), artifact_id.clone()));
                let metadata = super::AgentArtifactMetadata {
                    artifact_id: artifact_id.clone(),
                    kind,
                    title,
                    media_type,
                    sha256,
                    size_bytes,
                    sensitivity,
                    created_at_unix_ms: event.time_unix_ms,
                };
                let integrity = self.artifacts.verify(&session_id, &metadata)?;
                if integrity == super::AgentArtifactIntegrity::Verified {
                    continue;
                }
                let evidence_id = format!("artifact-integrity-{}", artifact_id);
                if existing_evidence.contains(&evidence_id) {
                    continue;
                }
                let summary = match integrity {
                    super::AgentArtifactIntegrity::Missing => {
                        format!("Artifact {artifact_id} is missing; recovery is blocked.")
                    }
                    super::AgentArtifactIntegrity::Tampered => {
                        format!(
                            "Artifact {artifact_id} failed hash verification; recovery is blocked."
                        )
                    }
                    super::AgentArtifactIntegrity::Verified => unreachable!(),
                };
                self.sessions.append_batch(
                    &session_id,
                    vec![
                        super::AgentScopedPayload {
                            turn_id: None,
                            step_id: None,
                            payload: super::AgentSessionEventPayload::TaskEvidence {
                                evidence_id,
                                kind: "artifact-integrity".into(),
                                summary: summary.clone(),
                            },
                        },
                        super::AgentScopedPayload {
                            turn_id: None,
                            step_id: None,
                            payload: super::AgentSessionEventPayload::TaskState {
                                status: "waiting".into(),
                                phase: Some("artifact-recovery".into()),
                                progress: None,
                                recovery: Some(super::AgentRecoveryState {
                                    status: super::AgentRecoveryStatus::Required,
                                    summary: Some(summary),
                                }),
                                fleet: None,
                            },
                        },
                    ],
                )?;
                existing_evidence.insert(format!("artifact-integrity-{}", artifact_id));
            }
        }
        self.artifacts.cleanup_unreferenced(&referenced)?;
        Ok(())
    }

    pub(crate) fn inspect_recovery(
        &self,
        session_id: &str,
    ) -> Result<super::AgentRecoveryCheckpoint, String> {
        Ok(self.sessions.snapshot(session_id)?.recovery)
    }

    pub(crate) async fn resume_recovery(
        &self,
        session_id: &str,
    ) -> Result<AgentSessionSnapshot, String> {
        let checkpoint = self.sessions.snapshot(session_id)?.recovery;
        let entry = self
            .agents
            .get(session_id)?
            .ok_or_else(|| "start the Agent Session before resuming recovery".to_string())?;
        match checkpoint.kind {
            super::AgentRecoveryCheckpointKind::AuthorizedBeforeExecute => {
                if !self.tools.resume_authorized(&entry).await? {
                    return Err("authorized recovery boundary is not prepared".into());
                }
                self.wake(session_id)?;
            }
            super::AgentRecoveryCheckpointKind::OpenModelRequest
            | super::AgentRecoveryCheckpointKind::ToolResultCommitted => {
                let scope = entry
                    .scope()?
                    .ok_or_else(|| "recovery boundary lost its active Turn".to_string())?;
                let mut payloads = Vec::new();
                if let Some(step_id) = scope.step_id.clone() {
                    payloads.push(super::AgentScopedPayload {
                        turn_id: Some(scope.turn_id.clone()),
                        step_id: Some(step_id),
                        payload: super::AgentSessionEventPayload::StepEnd {
                            reason: "recoveryRetryFromCommittedSurface".into(),
                        },
                    });
                }
                payloads.extend([
                    super::AgentScopedPayload {
                        turn_id: None,
                        step_id: None,
                        payload: super::AgentSessionEventPayload::AgentStatus {
                            status: super::AgentSessionStatus::Running,
                            reason: Some("recoveryResumed".into()),
                        },
                    },
                    super::AgentScopedPayload {
                        turn_id: None,
                        step_id: None,
                        payload: super::AgentSessionEventPayload::TaskState {
                            status: "running".into(),
                            phase: Some("recovered".into()),
                            progress: None,
                            recovery: Some(super::AgentRecoveryState {
                                status: super::AgentRecoveryStatus::Completed,
                                summary: Some(
                                    "Continuation resumed from the last committed Model Surface."
                                        .into(),
                                ),
                            }),
                            fleet: None,
                        },
                    },
                ]);
                self.sessions.append_batch(session_id, payloads)?;
                entry.set_scope(Some(super::AgentActiveScope {
                    turn_id: scope.turn_id,
                    step_id: None,
                }))?;
                entry.set_phase(AgentLifecyclePhase::Running)?;
                self.wake(session_id)?;
            }
            super::AgentRecoveryCheckpointKind::WaitingApproval => {
                return Err("the durable approval request is still waiting for a decision".into())
            }
            super::AgentRecoveryCheckpointKind::ExecutionInFlight
            | super::AgentRecoveryCheckpointKind::CompactionInFlight => {
                return Err("this recovery boundary requires reconciliation or abort".into())
            }
            _ => return Err("the Agent Session has no resumable recovery boundary".into()),
        }
        self.sessions.snapshot(session_id)
    }

    pub(crate) fn reconcile_recovery(
        &self,
        input: super::AgentRecoveryReconcileInput,
    ) -> Result<AgentSessionSnapshot, String> {
        let checkpoint = self.sessions.snapshot(&input.session_id)?.recovery;
        if checkpoint.kind != super::AgentRecoveryCheckpointKind::ExecutionInFlight {
            return Err("manual reconciliation requires an uncertain native execution".into());
        }
        if input.evidence.trim().is_empty() {
            return Err("reconciliation evidence is required".into());
        }
        let call_id = checkpoint
            .call_id
            .clone()
            .ok_or_else(|| "recovery checkpoint lost callId".to_string())?;
        let events = self.sessions.all_events(&input.session_id)?;
        let (turn_id, step_id, name) = events
            .iter()
            .find_map(|event| match &event.payload {
                super::AgentSessionEventPayload::ToolCall { call } if call.call_id == call_id => {
                    Some((
                        event.turn_id.clone(),
                        event.step_id.clone(),
                        call.name.clone(),
                    ))
                }
                _ => None,
            })
            .ok_or_else(|| "recovery checkpoint lost its durable tool call".to_string())?;
        let evidence_id = format!("recovery-{}", uuid::Uuid::new_v4().simple());
        if matches!(
            input.outcome,
            super::AgentRecoveryReconcileOutcome::Probe
                | super::AgentRecoveryReconcileOutcome::Unknown
        ) {
            self.sessions.append_batch(
                &input.session_id,
                vec![
                    super::AgentScopedPayload {
                        turn_id: None,
                        step_id: None,
                        payload: super::AgentSessionEventPayload::TaskEvidence {
                            evidence_id,
                            kind: "recovery-reconciliation".into(),
                            summary: input.evidence,
                        },
                    },
                    super::AgentScopedPayload {
                        turn_id: None,
                        step_id: None,
                        payload: super::AgentSessionEventPayload::TaskState {
                            status: "waiting".into(),
                            phase: Some("reconciliation".into()),
                            progress: None,
                            recovery: Some(super::AgentRecoveryState {
                                status: super::AgentRecoveryStatus::Required,
                                summary: Some(if input.outcome
                                    == super::AgentRecoveryReconcileOutcome::Probe
                                {
                                    "No authoritative native probe is available for this tool; manual evidence is still required."
                                        .into()
                                } else {
                                    "The native outcome remains unknown; it was not replayed.".into()
                                }),
                            }),
                            fleet: None,
                        },
                    },
                ],
            )?;
            return self.sessions.snapshot(&input.session_id);
        }
        let (result_status, summary) = match input.outcome {
            super::AgentRecoveryReconcileOutcome::ConfirmedApplied => (
                super::AgentToolResultStatus::Completed,
                "Manual reconciliation confirmed that the native effect was applied.",
            ),
            super::AgentRecoveryReconcileOutcome::ConfirmedNotApplied => (
                super::AgentToolResultStatus::Cancelled,
                "Manual reconciliation confirmed that the native effect was not applied.",
            ),
            _ => unreachable!(),
        };
        let mut payloads = vec![
            super::AgentScopedPayload {
                turn_id: turn_id.clone(),
                step_id: step_id.clone(),
                payload: super::AgentSessionEventPayload::ToolResult {
                    call_id,
                    name,
                    status: result_status,
                    summary: summary.into(),
                    data: None,
                    duration_ms: None,
                    evidence_refs: vec![evidence_id.clone()],
                },
            },
            super::AgentScopedPayload {
                turn_id: None,
                step_id: None,
                payload: super::AgentSessionEventPayload::TaskEvidence {
                    evidence_id,
                    kind: "recovery-reconciliation".into(),
                    summary: input.evidence,
                },
            },
            super::AgentScopedPayload {
                turn_id: None,
                step_id: None,
                payload: super::AgentSessionEventPayload::TaskState {
                    status: "running".into(),
                    phase: Some("recovered".into()),
                    progress: None,
                    recovery: Some(super::AgentRecoveryState {
                        status: super::AgentRecoveryStatus::Completed,
                        summary: Some(summary.into()),
                    }),
                    fleet: None,
                },
            },
            super::AgentScopedPayload {
                turn_id: None,
                step_id: None,
                payload: super::AgentSessionEventPayload::AgentStatus {
                    status: super::AgentSessionStatus::Running,
                    reason: Some("reconciliationCompleted".into()),
                },
            },
        ];
        if checkpoint.step_id.is_some() {
            payloads.insert(
                1,
                super::AgentScopedPayload {
                    turn_id: turn_id.clone(),
                    step_id: step_id.clone(),
                    payload: super::AgentSessionEventPayload::StepEnd {
                        reason: "reconciled".into(),
                    },
                },
            );
        }
        self.sessions.append_batch(&input.session_id, payloads)?;
        if let Some(entry) = self.agents.get(&input.session_id)? {
            if let Some(turn_id) = turn_id {
                entry.set_scope(Some(super::AgentActiveScope {
                    turn_id,
                    step_id: None,
                }))?;
            }
            entry.set_phase(AgentLifecyclePhase::Running)?;
            self.wake(&input.session_id)?;
        }
        self.sessions.snapshot(&input.session_id)
    }

    pub(crate) async fn abort_recovery(
        &self,
        session_id: &str,
    ) -> Result<AgentSessionSnapshot, String> {
        self.sessions.append(
            session_id,
            None,
            None,
            super::AgentSessionEventPayload::TaskState {
                status: "cancelled".into(),
                phase: Some("recovery-aborted".into()),
                progress: None,
                recovery: Some(super::AgentRecoveryState {
                    status: super::AgentRecoveryStatus::Completed,
                    summary: Some(
                        "Recovery was aborted without claiming that an uncertain effect was absent."
                            .into(),
                    ),
                }),
                fleet: None,
            },
        )?;
        self.cancel(session_id).await
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
                let lease = ActiveDriverLease(Arc::clone(&entry));
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
                                super::AgentSessionStatus::Failed,
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

    #[cfg(test)]
    pub(crate) fn append_for_driver(
        &self,
        session_id: &str,
        turn_id: Option<String>,
        step_id: Option<String>,
        payload: AgentSessionEventPayload,
    ) -> Result<AgentSessionEvent, String> {
        self.sessions.append(session_id, turn_id, step_id, payload)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Mutex;

    use async_trait::async_trait;
    use serde_json::json;
    use tokio::sync::Notify;
    use tokio_util::sync::CancellationToken;

    use crate::ai::{AiProviderKind, AiReasoningEffort};

    use super::*;
    use crate::agent_runtime::{
        AgentAfterToolContext, AgentAfterToolDecision, AgentAfterToolHook, AgentBeforeToolContext,
        AgentBeforeToolDecision, AgentBeforeToolHook, AgentFleetControlRequest,
        AgentFleetPlanRequest, AgentFleetTargetRequest, AgentPreStepContext, AgentPreStepDecision,
        AgentRecoveryStatus, AgentSessionEffect, AgentSessionPermissionMode, AgentSessionStatus,
        AgentSessionTarget, AgentSubagentRole, AgentSubagentSpawnRequest, AgentToolApprovalStatus,
        AgentToolFailedHook, AgentToolResultStatus, ModelAdapter, ModelFinishReason, ModelMessage,
        ModelRequest, ModelResponse, ModelStreamSink, ModelToolCall, ModelUsage,
        NativeToolArtifact, NativeToolIdempotency, NativeToolPreparation, NativeToolRequest,
        NativeToolResult, NativeToolRuntime, NormalizedModelError, NormalizedModelErrorKind,
        RecordedToolCall, StreamDelta,
    };

    #[derive(Default)]
    struct FakeNativeRuntime;

    impl NativeToolRuntime for FakeNativeRuntime {
        fn prepare(&self, request: NativeToolRequest) -> Result<NativeToolPreparation, String> {
            let command = request
                .model_call
                .arguments
                .get("command")
                .and_then(serde_json::Value::as_str)
                .filter(|command| !command.trim().is_empty())
                .ok_or_else(|| "schema rejected command".to_string())?;
            let explanation = request
                .model_call
                .arguments
                .get("explanation")
                .and_then(serde_json::Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "schema rejected explanation".to_string())?;
            if request
                .model_call
                .arguments
                .as_object()
                .is_none_or(|arguments| arguments.len() != 2)
            {
                return Err("schema rejected unknown arguments".into());
            }
            Ok(NativeToolPreparation {
                token: format!("token-{}", request.model_call.call_id),
                call: RecordedToolCall {
                    call_id: request.model_call.call_id,
                    provider_call_id: request.model_call.provider_call_id,
                    name: request.model_call.name,
                    native_name: Some("exec_command".into()),
                    arguments: json!({
                        "command": command,
                        "explanation": explanation,
                        "channel": "direct"
                    }),
                    title: Some("exec_command".into()),
                    effect: Some(AgentSessionEffect::ReadOnly),
                    target: Some(request.target),
                },
                requires_approval: true,
                prompt: "Approve the frozen command?".into(),
                expires_at_unix_ms: 9_000_000_000_000_000,
                idempotency: NativeToolIdempotency::Yes,
                parallel: false,
                exclusive: false,
            })
        }

        fn execute(
            &self,
            token: &str,
            approved: bool,
            _cancellation: CancellationToken,
        ) -> Result<NativeToolResult, String> {
            if !approved {
                return Err("approval denied".into());
            }
            let call_id = token.trim_start_matches("token-").to_string();
            Ok(NativeToolResult {
                call_id,
                native_name: "exec_command".into(),
                target_id: "target-local".into(),
                effect: AgentSessionEffect::ReadOnly,
                status: AgentToolResultStatus::Completed,
                summary: "command completed".into(),
                data: Some(json!({ "stdout": "ok" })),
                duration_ms: Some(1),
                evidence_refs: vec!["evidence-command".into()],
                artifacts: Vec::new(),
            })
        }

        fn abandon(&self, _token: &str) {}
    }

    struct RecordingNativeRuntime {
        requires_approval: bool,
        ttl_ms: u64,
        forge_result_effect: bool,
        block_execution: bool,
        executing: AtomicBool,
        active: AtomicUsize,
        max_active: AtomicUsize,
        executions: AtomicUsize,
        trace: Mutex<Vec<String>>,
    }

    impl RecordingNativeRuntime {
        fn new(requires_approval: bool) -> Arc<Self> {
            Arc::new(Self {
                requires_approval,
                ttl_ms: 60_000,
                forge_result_effect: false,
                block_execution: false,
                executing: AtomicBool::new(false),
                active: AtomicUsize::new(0),
                max_active: AtomicUsize::new(0),
                executions: AtomicUsize::new(0),
                trace: Mutex::new(Vec::new()),
            })
        }

        fn expires_at(&self) -> u64 {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis()
                .try_into()
                .unwrap_or(u64::MAX)
                .saturating_add(self.ttl_ms)
        }
    }

    struct ActiveNativeCall<'a> {
        runtime: &'a RecordingNativeRuntime,
        call_id: String,
    }

    impl Drop for ActiveNativeCall<'_> {
        fn drop(&mut self) {
            self.runtime.active.fetch_sub(1, Ordering::AcqRel);
            self.runtime
                .trace
                .lock()
                .unwrap()
                .push(format!("end:{}", self.call_id));
        }
    }

    impl NativeToolRuntime for RecordingNativeRuntime {
        fn prepare(&self, request: NativeToolRequest) -> Result<NativeToolPreparation, String> {
            let call_id = request.model_call.call_id.clone();
            let is_parallel_read = request.model_call.name == "list_directory";
            let effect = if request.model_call.name == "apply_patch" {
                AgentSessionEffect::StateChange
            } else {
                AgentSessionEffect::ReadOnly
            };
            Ok(NativeToolPreparation {
                token: format!("{}:{}", request.model_call.name, call_id),
                call: RecordedToolCall {
                    call_id,
                    provider_call_id: request.model_call.provider_call_id,
                    name: request.model_call.name.clone(),
                    native_name: Some(request.model_call.name),
                    arguments: request.model_call.arguments,
                    title: Some("native test tool".into()),
                    effect: Some(effect),
                    target: Some(request.target),
                },
                requires_approval: self.requires_approval,
                prompt: "Approve the native test tool?".into(),
                expires_at_unix_ms: self.expires_at(),
                idempotency: if is_parallel_read {
                    NativeToolIdempotency::Yes
                } else {
                    NativeToolIdempotency::Conditional
                },
                parallel: is_parallel_read,
                exclusive: effect != AgentSessionEffect::ReadOnly,
            })
        }

        fn execute(
            &self,
            token: &str,
            approved: bool,
            cancellation: CancellationToken,
        ) -> Result<NativeToolResult, String> {
            if !approved {
                return Err("approval denied".into());
            }
            let (native_name, call_id) = token
                .split_once(':')
                .ok_or_else(|| "invalid fake native token".to_string())?;
            self.executions.fetch_add(1, Ordering::AcqRel);
            let active = self.active.fetch_add(1, Ordering::AcqRel) + 1;
            self.max_active.fetch_max(active, Ordering::AcqRel);
            self.trace.lock().unwrap().push(format!("start:{call_id}"));
            let _active = ActiveNativeCall {
                runtime: self,
                call_id: call_id.to_string(),
            };
            if self.block_execution {
                self.executing.store(true, Ordering::Release);
                while !cancellation.is_cancelled() {
                    std::thread::sleep(std::time::Duration::from_millis(1));
                }
            } else if native_name == "list_directory" {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            let effect = if self.forge_result_effect {
                AgentSessionEffect::Destructive
            } else if native_name == "apply_patch" {
                AgentSessionEffect::StateChange
            } else {
                AgentSessionEffect::ReadOnly
            };
            Ok(NativeToolResult {
                call_id: call_id.into(),
                native_name: native_name.into(),
                target_id: "target-local".into(),
                effect,
                status: if cancellation.is_cancelled() {
                    AgentToolResultStatus::Cancelled
                } else {
                    AgentToolResultStatus::Completed
                },
                summary: format!("{native_name} completed"),
                data: Some(if call_id == "call-large" {
                    json!({
                        "stdout": "x".repeat(12 * 1024),
                        "authorization": "Bearer top-secret-native-value"
                    })
                } else {
                    json!({ "callId": call_id, "secret": "top-secret-native-value" })
                }),
                duration_ms: Some(20),
                evidence_refs: vec![format!("evidence-{call_id}")],
                artifacts: vec![NativeToolArtifact {
                    artifact_id: format!("artifact-{call_id}"),
                    kind: "native-output".into(),
                    title: format!("Output for {call_id}"),
                    size_bytes: Some(8),
                    media_type: Some("text/plain".into()),
                    sha256: None,
                }],
            })
        }

        fn abandon(&self, _token: &str) {}
    }

    enum FakeScript {
        Reply {
            chunks: Vec<String>,
            response: ModelResponse,
        },
        Error(NormalizedModelError),
        Wait {
            response: Option<ModelResponse>,
        },
    }

    struct FakeAdapter {
        scripts: Mutex<VecDeque<FakeScript>>,
        requests: Mutex<Vec<ModelRequest>>,
        started: Notify,
        release: Notify,
        active: AtomicUsize,
        max_active: AtomicUsize,
    }

    impl FakeAdapter {
        fn new(scripts: Vec<FakeScript>) -> Arc<Self> {
            Arc::new(Self {
                scripts: Mutex::new(scripts.into()),
                requests: Mutex::new(Vec::new()),
                started: Notify::new(),
                release: Notify::new(),
                active: AtomicUsize::new(0),
                max_active: AtomicUsize::new(0),
            })
        }

        fn request_count(&self) -> usize {
            self.requests.lock().unwrap().len()
        }
    }

    struct ActiveCall<'a>(&'a FakeAdapter);

    impl Drop for ActiveCall<'_> {
        fn drop(&mut self) {
            self.0.active.fetch_sub(1, Ordering::AcqRel);
        }
    }

    #[async_trait]
    impl ModelAdapter for FakeAdapter {
        async fn stream(
            &self,
            request: ModelRequest,
            cancellation: CancellationToken,
            sink: Arc<dyn ModelStreamSink>,
        ) -> Result<ModelResponse, NormalizedModelError> {
            let active = self.active.fetch_add(1, Ordering::AcqRel) + 1;
            self.max_active.fetch_max(active, Ordering::AcqRel);
            let _active = ActiveCall(self);
            self.requests.lock().unwrap().push(request);
            self.started.notify_one();
            let script = self
                .scripts
                .lock()
                .unwrap()
                .pop_front()
                .expect("fake adapter received an unexpected request");
            match script {
                FakeScript::Reply { chunks, response } => {
                    for text in chunks {
                        sink.emit(StreamDelta::Text { text })?;
                    }
                    Ok(response)
                }
                FakeScript::Error(error) => Err(error),
                FakeScript::Wait { response } => {
                    tokio::select! {
                        _ = cancellation.cancelled() => Err(NormalizedModelError::cancelled()),
                        _ = self.release.notified() => response.ok_or_else(|| {
                            NormalizedModelError::new(
                                NormalizedModelErrorKind::Terminal,
                                "fake wait had no response",
                            )
                        }),
                    }
                }
            }
        }
    }

    struct FakeFactory(Arc<FakeAdapter>);

    impl ModelAdapterFactory for FakeFactory {
        fn create(
            &self,
            _provider: AiProviderConfig,
            _api_key: Option<String>,
        ) -> Result<Arc<dyn ModelAdapter>, String> {
            Ok(self.0.clone())
        }
    }

    struct FixedPreStepHook {
        decision: AgentPreStepDecision,
        contexts: Mutex<Vec<AgentPreStepContext>>,
    }

    impl FixedPreStepHook {
        fn new(decision: AgentPreStepDecision) -> Arc<Self> {
            Arc::new(Self {
                decision,
                contexts: Mutex::new(Vec::new()),
            })
        }
    }

    impl AgentPreStepHook for FixedPreStepHook {
        fn pre_step(&self, context: &AgentPreStepContext) -> Result<AgentPreStepDecision, String> {
            self.contexts.lock().unwrap().push(context.clone());
            Ok(self.decision.clone())
        }
    }

    struct FixedBeforeToolHook(AgentBeforeToolDecision);

    impl AgentBeforeToolHook for FixedBeforeToolHook {
        fn before_tool(
            &self,
            _context: &AgentBeforeToolContext,
        ) -> Result<AgentBeforeToolDecision, String> {
            Ok(self.0.clone())
        }
    }

    struct FixedAfterToolHook(AgentAfterToolDecision);

    impl AgentAfterToolHook for FixedAfterToolHook {
        fn after_tool(
            &self,
            _context: &AgentAfterToolContext,
        ) -> Result<AgentAfterToolDecision, String> {
            Ok(self.0.clone())
        }
    }

    struct FixedToolFailedHook(AgentAfterToolDecision);

    impl AgentToolFailedHook for FixedToolFailedHook {
        fn tool_failed(
            &self,
            _context: &AgentAfterToolContext,
        ) -> Result<AgentAfterToolDecision, String> {
            Ok(self.0.clone())
        }
    }

    fn response(content: &str) -> ModelResponse {
        ModelResponse {
            content: content.into(),
            tool_calls: Vec::new(),
            finish_reason: ModelFinishReason::Stop,
            usage: ModelUsage {
                input_tokens: Some(10),
                output_tokens: Some(2),
                total_tokens: Some(12),
            },
        }
    }

    fn reply(content: &str, chunks: &[&str]) -> FakeScript {
        FakeScript::Reply {
            chunks: chunks.iter().map(|chunk| (*chunk).to_string()).collect(),
            response: response(content),
        }
    }

    fn provider() -> AiProviderConfig {
        AiProviderConfig {
            id: "fake".into(),
            kind: AiProviderKind::Ollama,
            base_url: "http://127.0.0.1:11434".into(),
            model: "fake-model".into(),
            reasoning_effort: Some(AiReasoningEffort::Off),
            requires_api_key: false,
            api_key: None,
        }
    }

    fn configured(adapter: Arc<FakeAdapter>) -> (tempfile::TempDir, AgentRuntime) {
        configured_with(
            adapter,
            AgentDriverConfig {
                max_steps_per_turn: 8,
                max_turns_per_session: 64,
                max_request_attempts: 2,
            },
        )
    }

    fn configured_with(
        adapter: Arc<FakeAdapter>,
        config: AgentDriverConfig,
    ) -> (tempfile::TempDir, AgentRuntime) {
        configured_with_native(adapter, config, Arc::new(FakeNativeRuntime))
    }

    fn configured_with_native(
        adapter: Arc<FakeAdapter>,
        config: AgentDriverConfig,
        native: Arc<dyn NativeToolRuntime>,
    ) -> (tempfile::TempDir, AgentRuntime) {
        let root = tempfile::tempdir().unwrap();
        let runtime = AgentRuntimeBuilder::new()
            .model_factory(Arc::new(FakeFactory(adapter)))
            .native_tool_runtime(native)
            .driver_config(config)
            .build();
        runtime.configure(root.path().to_path_buf()).unwrap();
        (root, runtime)
    }

    fn create(runtime: &AgentRuntime, session_id: &str) {
        runtime
            .create_session(CreateAgentSessionRequest {
                session_id: session_id.into(),
                task_id: format!("task-{session_id}"),
                goal: "exercise the Agent Runtime driver".into(),
                parent_session_id: None,
                target: Some(AgentSessionTarget {
                    kind: "local".into(),
                    target_id: "target-local".into(),
                    session_id: "terminal-local".into(),
                    label: Some("Local".into()),
                    profile_id: None,
                    host: None,
                    port: None,
                    username: None,
                    cwd: None,
                    root_path: None,
                    local_root: None,
                }),
                permission_mode: Some(AgentSessionPermissionMode::RequestApproval),
                success_criteria: vec!["command result is recorded".into()],
                capability_scope: None,
                subagent: None,
            })
            .unwrap();
    }

    #[tokio::test]
    async fn continuable_child_reuses_the_same_session_and_driver() {
        let adapter = FakeAdapter::new(vec![
            reply("first child answer", &[]),
            reply("second child answer", &[]),
        ]);
        let (_root, runtime) = configured(adapter);
        create(&runtime, "parent-1");
        runtime.start("parent-1", provider(), None).unwrap();
        runtime.await_idle("parent-1").await.unwrap();

        let child = runtime
            .spawn_subagent(AgentSubagentSpawnRequest {
                parent_session_id: "parent-1".into(),
                goal: "inspect the target".into(),
                role: AgentSubagentRole::Explorer,
                inheritance_mode: "blank".into(),
                target_ids: vec!["target-local".into()],
                budget: None,
                continuable: true,
            })
            .await
            .unwrap();
        runtime.await_idle(&child.header.session_id).await.unwrap();
        runtime
            .send_child_input(super::super::AgentChildInputRequest {
                parent_session_id: "parent-1".into(),
                child_session_id: child.header.session_id.clone(),
                content: "continue with a second check".into(),
            })
            .await
            .unwrap();
        runtime.await_idle(&child.header.session_id).await.unwrap();

        let events = all_events(&runtime, &child.header.session_id);
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event.payload, AgentSessionEventPayload::TurnStart))
                .count(),
            2
        );
        assert!(all_events(&runtime, "parent-1").iter().any(|event| {
            matches!(event.payload, AgentSessionEventPayload::SubagentDescriptor { ref child_session_id, continuable: true, .. } if child_session_id == &child.header.session_id)
        }));
    }

    #[tokio::test]
    async fn one_shot_child_budget_is_forced_to_one_turn() {
        let adapter = FakeAdapter::new(vec![reply("child answer", &[])]);
        let (_root, runtime) = configured(adapter);
        create(&runtime, "parent-oneshot");
        runtime.start("parent-oneshot", provider(), None).unwrap();
        runtime.await_idle("parent-oneshot").await.unwrap();
        let child = runtime
            .spawn_subagent(AgentSubagentSpawnRequest {
                parent_session_id: "parent-oneshot".into(),
                goal: "one bounded check".into(),
                role: AgentSubagentRole::Explorer,
                inheritance_mode: "safePrefix".into(),
                target_ids: vec!["target-local".into()],
                budget: Some(super::super::AgentSubagentBudget {
                    max_steps_per_turn: 4,
                    max_turns: 9,
                    max_tool_calls: 8,
                    max_tokens: 8_192,
                    timeout_ms: 60_000,
                }),
                continuable: false,
            })
            .await
            .unwrap();
        assert_eq!(child.header.subagent.unwrap().budget.max_turns, 1);
    }

    #[tokio::test]
    async fn fleet_uses_distinct_role_children_and_persists_target_evidence() {
        let adapter = FakeAdapter::new(vec![
            reply("explorer evidence", &[]),
            reply("operator evidence", &[]),
            reply("verifier evidence", &[]),
            reply("reviewer evidence", &[]),
        ]);
        let (_root, runtime) = configured(adapter);
        create(&runtime, "fleet-parent");
        runtime.start("fleet-parent", provider(), None).unwrap();
        runtime.await_idle("fleet-parent").await.unwrap();
        let plan = runtime
            .plan_fleet(AgentFleetPlanRequest {
                parent_session_id: "fleet-parent".into(),
                targets: vec![AgentFleetTargetRequest {
                    target_id: "target-local".into(),
                    goal: "verify the target".into(),
                }],
                canary_size: 1,
                wave_size: 1,
                failure_threshold: 0,
            })
            .unwrap();
        let fleet_id = plan.fleet.fleet_id.unwrap();
        let finished = runtime
            .start_fleet(AgentFleetControlRequest {
                parent_session_id: "fleet-parent".into(),
                fleet_id,
            })
            .await
            .unwrap();
        let target = &finished.fleet.targets[0];
        assert_eq!(finished.fleet.status.as_deref(), Some("completed"));
        assert_eq!(target.state, "completed");
        assert_eq!(target.child_session_ids.len(), 4);
        assert_eq!(target.evidence_refs.len(), 1);
        assert!(all_events(&runtime, "fleet-parent").iter().any(|event| {
            matches!(event.payload, AgentSessionEventPayload::TaskEvidence { ref kind, .. } if kind == "independent-fleet-verification")
        }));
    }

    fn event_types(runtime: &AgentRuntime, session_id: &str) -> Vec<String> {
        runtime
            .events(AgentSessionEventsRequest {
                session_id: session_id.into(),
                cursor: None,
                limit: 1_024,
            })
            .unwrap()
            .events
            .iter()
            .map(|event| {
                serde_json::to_value(&event.payload).unwrap()["type"]
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect()
    }

    fn all_events(runtime: &AgentRuntime, session_id: &str) -> Vec<AgentSessionEvent> {
        runtime
            .events(AgentSessionEventsRequest {
                session_id: session_id.into(),
                cursor: None,
                limit: 1_024,
            })
            .unwrap()
            .events
    }

    fn pending_approval(runtime: &AgentRuntime, session_id: &str) -> AgentToolDecisionInput {
        all_events(runtime, session_id)
            .iter()
            .rev()
            .find_map(|event| match &event.payload {
                AgentSessionEventPayload::ToolApproval {
                    request_id,
                    call_id,
                    approval_id: Some(approval_id),
                    status: AgentToolApprovalStatus::Requested,
                    ..
                } => Some(AgentToolDecisionInput {
                    session_id: session_id.into(),
                    turn_id: event.turn_id.clone().unwrap(),
                    step_id: event.step_id.clone().unwrap(),
                    request_id: request_id.clone(),
                    call_id: call_id.clone(),
                    approval_id: approval_id.clone(),
                }),
                _ => None,
            })
            .expect("session has a pending approval")
    }

    fn native_call(call_id: &str, name: &str) -> ModelToolCall {
        ModelToolCall {
            call_id: call_id.into(),
            provider_call_id: Some(format!("provider-{call_id}")),
            name: name.into(),
            arguments: if name == "apply_patch" {
                json!({ "patch": "test", "preconditions": [{ "path": "a", "sha256": "0".repeat(64) }] })
            } else {
                json!({ "path": call_id })
            },
        }
    }

    fn tool_response(calls: Vec<ModelToolCall>) -> FakeScript {
        let mut response = response("");
        response.finish_reason = ModelFinishReason::ToolCalls;
        response.tool_calls = calls;
        FakeScript::Reply {
            chunks: Vec::new(),
            response,
        }
    }

    #[tokio::test]
    async fn steer_arriving_during_a_model_call_becomes_the_next_step() {
        let adapter = FakeAdapter::new(vec![
            FakeScript::Wait {
                response: Some(response("first response")),
            },
            reply("second response", &["second ", "response"]),
        ]);
        let (_root, runtime) = configured(adapter.clone());
        create(&runtime, "session-multi-step");
        runtime
            .followup("session-multi-step", "message-turn".into(), "first".into())
            .unwrap();
        runtime
            .start("session-multi-step", provider(), None)
            .unwrap();
        adapter.started.notified().await;
        runtime
            .steer(
                "session-multi-step",
                "message-steer".into(),
                "use this on the next Step".into(),
            )
            .unwrap();
        adapter.release.notify_one();
        runtime.await_idle("session-multi-step").await.unwrap();

        let types = event_types(&runtime, "session-multi-step");
        assert_eq!(types.iter().filter(|kind| *kind == "turn/start").count(), 1);
        assert_eq!(types.iter().filter(|kind| *kind == "step/start").count(), 2);
        assert_eq!(
            types.iter().filter(|kind| *kind == "request/usage").count(),
            2
        );
        let requests = adapter.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests[1].messages.iter().any(|message| matches!(
            message,
            crate::agent_runtime::ModelMessage::User { content }
                if content == "use this on the next Step"
        )));
        assert_eq!(
            runtime.session("session-multi-step").unwrap().status,
            AgentSessionStatus::Idle
        );
    }

    #[tokio::test]
    async fn typed_pre_step_hooks_append_bounded_context_or_reject_before_the_model() {
        let continue_hook = FixedPreStepHook::new(AgentPreStepDecision::Continue);
        let context_hook = FixedPreStepHook::new(AgentPreStepDecision::AppendContext {
            message_id: "hook-context-1".into(),
            label: "test-hook".into(),
            content: "runtime fact from a typed hook".into(),
        });
        let adapter = FakeAdapter::new(vec![reply("done", &["done"])]);
        let root = tempfile::tempdir().unwrap();
        let runtime = AgentRuntimeBuilder::new()
            .model_factory(Arc::new(FakeFactory(adapter.clone())))
            .pre_step_hook(continue_hook.clone())
            .pre_step_hook(context_hook.clone())
            .build();
        runtime.configure(root.path().to_path_buf()).unwrap();
        create(&runtime, "session-hook-context");
        runtime
            .followup(
                "session-hook-context",
                "message-hook-context".into(),
                "use hook context".into(),
            )
            .unwrap();
        runtime
            .start("session-hook-context", provider(), None)
            .unwrap();
        runtime.await_idle("session-hook-context").await.unwrap();

        assert_eq!(continue_hook.contexts.lock().unwrap().len(), 1);
        assert_eq!(context_hook.contexts.lock().unwrap()[0].step_index, 1);
        assert!(adapter.requests.lock().unwrap()[0]
            .messages
            .iter()
            .any(|message| matches!(
                message,
                crate::agent_runtime::ModelMessage::User { content }
                    if content == "runtime fact from a typed hook"
            )));

        let reject_hook = FixedPreStepHook::new(AgentPreStepDecision::Reject {
            reason: "policy denied the Step".into(),
        });
        let rejected_adapter = FakeAdapter::new(Vec::new());
        let rejected_root = tempfile::tempdir().unwrap();
        let rejected = AgentRuntimeBuilder::new()
            .model_factory(Arc::new(FakeFactory(rejected_adapter.clone())))
            .pre_step_hook(reject_hook)
            .build();
        rejected
            .configure(rejected_root.path().to_path_buf())
            .unwrap();
        create(&rejected, "session-hook-rejected");
        rejected
            .followup(
                "session-hook-rejected",
                "message-hook-rejected".into(),
                "reject this".into(),
            )
            .unwrap();
        rejected
            .start("session-hook-rejected", provider(), None)
            .unwrap();
        rejected.await_idle("session-hook-rejected").await.unwrap();

        let snapshot = rejected.session("session-hook-rejected").unwrap();
        assert!(snapshot.ended);
        assert_eq!(snapshot.status, AgentSessionStatus::Failed);
        assert_eq!(rejected_adapter.request_count(), 0);
        assert!(rejected
            .events(AgentSessionEventsRequest {
                session_id: "session-hook-rejected".into(),
                cursor: None,
                limit: 128,
            })
            .unwrap()
            .events
            .iter()
            .any(|event| matches!(
                &event.payload,
                AgentSessionEventPayload::SessionEnded { reason: Some(reason), .. }
                    if reason == "preStepRejected: policy denied the Step"
            )));
    }

    #[tokio::test]
    async fn tool_calls_commit_a_typed_waiting_boundary_without_execution() {
        let mut tool_response = response("");
        tool_response.finish_reason = ModelFinishReason::ToolCalls;
        tool_response.tool_calls = vec![ModelToolCall {
            call_id: "call-1".into(),
            provider_call_id: Some("provider-call-1".into()),
            name: "run_terminal_command".into(),
            arguments: json!({ "command": "pwd", "explanation": "inspect" }),
        }];
        let adapter = FakeAdapter::new(vec![FakeScript::Reply {
            chunks: Vec::new(),
            response: tool_response,
        }]);
        let (_root, runtime) = configured(adapter);
        create(&runtime, "session-tool");
        runtime
            .followup("session-tool", "message-tool".into(), "inspect".into())
            .unwrap();
        runtime.start("session-tool", provider(), None).unwrap();
        runtime.await_idle("session-tool").await.unwrap();

        let snapshot = runtime.session("session-tool").unwrap();
        assert_eq!(snapshot.status, AgentSessionStatus::Waiting);
        assert!(!snapshot.ended);
        let events = runtime
            .events(AgentSessionEventsRequest {
                session_id: "session-tool".into(),
                cursor: None,
                limit: 128,
            })
            .unwrap()
            .events;
        let assistant = events.iter().position(|event| {
            matches!(
                event.payload,
                AgentSessionEventPayload::AssistantMessage { .. }
            )
        });
        let call = events
            .iter()
            .position(|event| matches!(event.payload, AgentSessionEventPayload::ToolCall { .. }));
        assert!(assistant < call);
        assert!(events.iter().any(|event| matches!(
            &event.payload,
            AgentSessionEventPayload::ToolCall { call }
                if call.provider_call_id.as_deref() == Some("provider-call-1")
        )));
        assert!(!events
            .iter()
            .any(|event| { matches!(event.payload, AgentSessionEventPayload::ToolResult { .. }) }));
    }

    #[tokio::test]
    async fn update_plan_commits_in_primary_session_pipeline_and_continues_the_turn() {
        let mut plan_response = response("");
        plan_response.finish_reason = ModelFinishReason::ToolCalls;
        plan_response.tool_calls = vec![ModelToolCall {
            call_id: "call-plan".into(),
            provider_call_id: Some("provider-plan".into()),
            name: "update_plan".into(),
            arguments: json!({
                "planVersion": 1,
                "explanation": "Plan the bounded work",
                "steps": [{
                    "id": "inspect",
                    "title": "Inspect the target",
                    "status": "inProgress"
                }]
            }),
        }];
        let adapter = FakeAdapter::new(vec![
            FakeScript::Reply {
                chunks: Vec::new(),
                response: plan_response,
            },
            reply("The plan is recorded.", &[]),
        ]);
        let (_root, runtime) = configured(adapter.clone());
        create(&runtime, "session-plan");
        runtime
            .followup("session-plan", "message-plan".into(), "make a plan".into())
            .unwrap();
        runtime.start("session-plan", provider(), None).unwrap();
        runtime.await_idle("session-plan").await.unwrap();

        let events = all_events(&runtime, "session-plan");
        assert_eq!(adapter.request_count(), 2);
        assert!(events.iter().any(|event| matches!(
            &event.payload,
            AgentSessionEventPayload::TaskPlan { version: 1, steps }
                if steps.len() == 1 && steps[0].id == "inspect"
        )));
        assert!(events.iter().any(|event| matches!(
            &event.payload,
            AgentSessionEventPayload::ToolApproval { reason: Some(reason), .. }
                if reason == "sessionRuntimeAuthorized"
        )));
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event.payload, AgentSessionEventPayload::TurnStart))
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn restart_restores_a_committed_tool_boundary_without_reissuing_the_model_request() {
        let mut tool_response = response("");
        tool_response.finish_reason = ModelFinishReason::ToolCalls;
        tool_response.tool_calls = vec![ModelToolCall {
            call_id: "call-1".into(),
            provider_call_id: Some("provider-call-1".into()),
            name: "run_terminal_command".into(),
            arguments: json!({ "command": "pwd", "explanation": "inspect" }),
        }];
        let first_adapter = FakeAdapter::new(vec![FakeScript::Reply {
            chunks: Vec::new(),
            response: tool_response,
        }]);
        let (root, first) = configured(first_adapter);
        create(&first, "session-waiting-restart");
        first
            .followup(
                "session-waiting-restart",
                "message-waiting".into(),
                "inspect".into(),
            )
            .unwrap();
        first
            .start("session-waiting-restart", provider(), None)
            .unwrap();
        first.await_idle("session-waiting-restart").await.unwrap();
        drop(first);

        let restarted_adapter = FakeAdapter::new(Vec::new());
        let restarted = AgentRuntimeBuilder::new()
            .model_factory(Arc::new(FakeFactory(restarted_adapter.clone())))
            .native_tool_runtime(Arc::new(FakeNativeRuntime))
            .build();
        restarted.configure(root.path().to_path_buf()).unwrap();
        let snapshot = restarted
            .start("session-waiting-restart", provider(), None)
            .unwrap();
        assert_eq!(snapshot.status, AgentSessionStatus::Waiting);
        assert!(!snapshot.ended);
        assert_eq!(restarted_adapter.request_count(), 0);
    }

    #[tokio::test]
    async fn approved_native_call_records_evidence_and_continues_in_the_same_turn() {
        let mut command = response("");
        command.finish_reason = ModelFinishReason::ToolCalls;
        command.tool_calls = vec![ModelToolCall {
            call_id: "call-approved".into(),
            provider_call_id: Some("provider-approved".into()),
            name: "run_terminal_command".into(),
            arguments: json!({ "command": "pwd", "explanation": "inspect" }),
        }];
        let adapter = FakeAdapter::new(vec![
            FakeScript::Reply {
                chunks: Vec::new(),
                response: command,
            },
            reply("The command completed.", &[]),
        ]);
        let (_root, runtime) = configured(adapter.clone());
        create(&runtime, "session-approved");
        runtime
            .followup(
                "session-approved",
                "message-approved".into(),
                "inspect".into(),
            )
            .unwrap();
        runtime.start("session-approved", provider(), None).unwrap();
        runtime.await_idle("session-approved").await.unwrap();

        let decision = pending_approval(&runtime, "session-approved");
        runtime.approve_tool(decision.clone()).await.unwrap();
        runtime.await_idle("session-approved").await.unwrap();

        let events = all_events(&runtime, "session-approved");
        assert_eq!(adapter.request_count(), 2);
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event.payload, AgentSessionEventPayload::TurnStart))
                .count(),
            1
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event.payload, AgentSessionEventPayload::StepStart))
                .count(),
            2
        );
        let approved = events
            .iter()
            .position(|event| {
                matches!(
                    &event.payload,
                    AgentSessionEventPayload::ToolApproval {
                        call_id,
                        approval_id: Some(approval_id),
                        status: AgentToolApprovalStatus::Approved,
                        ..
                    } if call_id == &decision.call_id && approval_id == &decision.approval_id
                )
            })
            .unwrap();
        let result = events
            .iter()
            .position(|event| {
                matches!(
                    &event.payload,
                    AgentSessionEventPayload::ToolResult {
                        call_id,
                        status: AgentToolResultStatus::Completed,
                        evidence_refs,
                        ..
                    } if call_id == &decision.call_id && evidence_refs == &["evidence-command"]
                )
            })
            .unwrap();
        assert!(approved < result);
        assert!(events.iter().any(|event| matches!(
            &event.payload,
            AgentSessionEventPayload::AssistantMessage { content, .. }
                if content == "The command completed."
        )));
        assert!(adapter.requests.lock().unwrap()[1]
            .messages
            .iter()
            .any(|message| matches!(
                message,
                ModelMessage::Tool {
                    call_id,
                    content,
                    ..
                } if call_id == "call-approved" && content.contains("command completed")
            )));
        assert!(runtime.reject_tool(decision).await.is_err());
    }

    #[tokio::test]
    async fn large_native_results_become_verified_redacted_artifacts() {
        let native = RecordingNativeRuntime::new(false);
        let adapter = FakeAdapter::new(vec![
            tool_response(vec![native_call("call-large", "list_directory")]),
            reply("Large output was recorded.", &[]),
        ]);
        let (root, runtime) = configured_with_native(adapter, AgentDriverConfig::default(), native);
        create(&runtime, "session-large-result");
        runtime
            .followup(
                "session-large-result",
                "message-large-result".into(),
                "inspect a large directory".into(),
            )
            .unwrap();
        runtime
            .start("session-large-result", provider(), None)
            .unwrap();
        runtime.await_idle("session-large-result").await.unwrap();

        let events = all_events(&runtime, "session-large-result");
        let artifact_id = events
            .iter()
            .find_map(|event| match &event.payload {
                AgentSessionEventPayload::ContextArtifact {
                    artifact_id,
                    kind,
                    sha256: Some(_),
                    ..
                } if kind == "tool-result" => Some(artifact_id.clone()),
                _ => None,
            })
            .expect("large output has a durable artifact");
        let result_data = events.iter().find_map(|event| match &event.payload {
            AgentSessionEventPayload::ToolResult {
                call_id,
                data: Some(data),
                ..
            } if call_id == "call-large" => Some(data),
            _ => None,
        });
        assert_eq!(
            result_data
                .and_then(|data| data.get("artifactRef"))
                .and_then(serde_json::Value::as_str),
            Some(artifact_id.as_str())
        );
        let artifact = runtime
            .artifact(crate::agent_runtime::AgentArtifactRequest {
                session_id: "session-large-result".into(),
                artifact_id,
                max_bytes: 16 * 1024,
            })
            .unwrap();
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(artifact.body_base64)
            .unwrap();
        let text = String::from_utf8(decoded).unwrap();
        assert!(text.contains("[REDACTED]"));
        assert!(!text.contains("top-secret-native-value"));

        std::fs::remove_file(
            root.path()
                .join("agent-runtime/artifacts-v2/session-large-result")
                .join(format!("{}.bin", artifact.metadata.artifact_id)),
        )
        .unwrap();
        let restarted = AgentRuntimeBuilder::new().build();
        restarted.configure(root.path().to_path_buf()).unwrap();
        let recovered = restarted.session("session-large-result").unwrap();
        assert_eq!(
            recovered.task.recovery.as_ref().map(|state| state.status),
            Some(AgentRecoveryStatus::Required)
        );
        assert!(recovered.task.evidence.iter().any(|evidence| {
            evidence.kind == "artifact-integrity" && evidence.summary.contains("missing")
        }));
    }

    #[tokio::test]
    async fn approval_barrier_resumes_every_remaining_model_call_before_the_next_step() {
        let native = RecordingNativeRuntime::new(true);
        let adapter = FakeAdapter::new(vec![
            tool_response(vec![
                native_call("call-first", "list_directory"),
                native_call("call-second", "list_directory"),
            ]),
            reply("Both approved calls completed.", &[]),
        ]);
        let (_root, runtime) = configured_with_native(
            adapter.clone(),
            AgentDriverConfig::default(),
            native.clone(),
        );
        create(&runtime, "session-approval-barrier");
        runtime
            .followup(
                "session-approval-barrier",
                "message-approval-barrier".into(),
                "inspect twice".into(),
            )
            .unwrap();
        runtime
            .start("session-approval-barrier", provider(), None)
            .unwrap();
        runtime
            .await_idle("session-approval-barrier")
            .await
            .unwrap();

        let first = pending_approval(&runtime, "session-approval-barrier");
        assert_eq!(first.call_id, "call-first");
        runtime.approve_tool(first).await.unwrap();
        let second = pending_approval(&runtime, "session-approval-barrier");
        assert_eq!(second.call_id, "call-second");
        runtime.approve_tool(second).await.unwrap();
        runtime
            .await_idle("session-approval-barrier")
            .await
            .unwrap();

        assert_eq!(native.executions.load(Ordering::Acquire), 2);
        assert_eq!(adapter.request_count(), 2);
        let result_order = all_events(&runtime, "session-approval-barrier")
            .into_iter()
            .filter_map(|event| match event.payload {
                AgentSessionEventPayload::ToolResult { call_id, .. } => Some(call_id),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(result_order, ["call-first", "call-second"]);
    }

    #[tokio::test]
    async fn rejection_is_durable_single_use_and_never_executes_the_native_body() {
        let native = RecordingNativeRuntime::new(true);
        let adapter = FakeAdapter::new(vec![
            tool_response(vec![native_call("call-rejected", "list_directory")]),
            reply("The operation was rejected.", &[]),
        ]);
        let (_root, runtime) = configured_with_native(
            adapter.clone(),
            AgentDriverConfig::default(),
            native.clone(),
        );
        create(&runtime, "session-rejected");
        runtime
            .followup(
                "session-rejected",
                "message-rejected".into(),
                "inspect".into(),
            )
            .unwrap();
        runtime.start("session-rejected", provider(), None).unwrap();
        runtime.await_idle("session-rejected").await.unwrap();
        let decision = pending_approval(&runtime, "session-rejected");
        runtime.reject_tool(decision.clone()).await.unwrap();
        runtime.await_idle("session-rejected").await.unwrap();

        assert_eq!(native.executions.load(Ordering::Acquire), 0);
        assert_eq!(adapter.request_count(), 2);
        assert!(runtime.reject_tool(decision).await.is_err());
        assert!(all_events(&runtime, "session-rejected")
            .iter()
            .any(|event| matches!(
                event.payload,
                AgentSessionEventPayload::ToolResult {
                    status: AgentToolResultStatus::Rejected,
                    ..
                }
            )));
    }

    #[tokio::test]
    async fn malformed_tool_arguments_fail_before_authorization_or_execution() {
        let adapter = FakeAdapter::new(vec![
            tool_response(vec![ModelToolCall {
                call_id: "call-malformed".into(),
                provider_call_id: None,
                name: "run_terminal_command".into(),
                arguments: json!({ "command": "pwd", "unexpected": true }),
            }]),
            reply("The malformed call failed safely.", &[]),
        ]);
        let (_root, runtime) = configured(adapter.clone());
        create(&runtime, "session-malformed");
        runtime
            .followup(
                "session-malformed",
                "message-malformed".into(),
                "inspect".into(),
            )
            .unwrap();
        runtime
            .start("session-malformed", provider(), None)
            .unwrap();
        runtime.await_idle("session-malformed").await.unwrap();

        let events = all_events(&runtime, "session-malformed");
        assert_eq!(adapter.request_count(), 2);
        assert!(!events
            .iter()
            .any(|event| matches!(event.payload, AgentSessionEventPayload::ToolApproval { .. })));
        assert!(events.iter().any(|event| matches!(
            &event.payload,
            AgentSessionEventPayload::ToolResult {
                status: AgentToolResultStatus::Rejected,
                summary,
                ..
            } if summary.contains("schema rejected")
        )));
    }

    #[tokio::test]
    async fn adjacent_parallel_reads_preserve_model_order_and_stop_at_write_barriers() {
        let native = RecordingNativeRuntime::new(false);
        let calls = vec![
            native_call("read-1", "list_directory"),
            native_call("read-2", "list_directory"),
            native_call("write-1", "apply_patch"),
            native_call("read-3", "list_directory"),
            native_call("read-4", "list_directory"),
        ];
        let adapter = FakeAdapter::new(vec![
            tool_response(calls),
            reply("All native calls completed in order.", &[]),
        ]);
        let (_root, runtime) =
            configured_with_native(adapter, AgentDriverConfig::default(), native.clone());
        create(&runtime, "session-parallel");
        runtime
            .followup(
                "session-parallel",
                "message-parallel".into(),
                "inspect".into(),
            )
            .unwrap();
        runtime.start("session-parallel", provider(), None).unwrap();
        runtime.await_idle("session-parallel").await.unwrap();

        assert_eq!(native.max_active.load(Ordering::Acquire), 2);
        let trace = native.trace.lock().unwrap().clone();
        let position = |needle: &str| trace.iter().position(|entry| entry == needle).unwrap();
        assert!(position("end:read-1") < position("start:write-1"));
        assert!(position("end:read-2") < position("start:write-1"));
        assert!(position("end:write-1") < position("start:read-3"));
        assert!(position("end:write-1") < position("start:read-4"));
        let events = all_events(&runtime, "session-parallel");
        assert!(!serde_json::to_string(&events)
            .unwrap()
            .contains("top-secret-native-value"));
        assert!(events.iter().any(|event| matches!(
            event.payload,
            AgentSessionEventPayload::ContextArtifact { .. }
        )));
        let result_order = events
            .into_iter()
            .filter_map(|event| match event.payload {
                AgentSessionEventPayload::ToolResult { call_id, .. } => Some(call_id),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(
            result_order,
            ["read-1", "read-2", "write-1", "read-3", "read-4"]
        );
    }

    #[tokio::test]
    async fn native_result_cannot_forge_effect_target_or_evidence() {
        let native = Arc::new(RecordingNativeRuntime {
            requires_approval: false,
            ttl_ms: 60_000,
            forge_result_effect: true,
            block_execution: false,
            executing: AtomicBool::new(false),
            active: AtomicUsize::new(0),
            max_active: AtomicUsize::new(0),
            executions: AtomicUsize::new(0),
            trace: Mutex::new(Vec::new()),
        });
        let adapter = FakeAdapter::new(vec![
            tool_response(vec![native_call("call-forged", "list_directory")]),
            reply("The forged result was rejected.", &[]),
        ]);
        let root = tempfile::tempdir().unwrap();
        let runtime = AgentRuntimeBuilder::new()
            .model_factory(Arc::new(FakeFactory(adapter)))
            .native_tool_runtime(native)
            .tool_failed_hook(Arc::new(FixedToolFailedHook(
                AgentAfterToolDecision::Continue,
            )))
            .build();
        runtime.configure(root.path().to_path_buf()).unwrap();
        create(&runtime, "session-forged");
        runtime
            .followup("session-forged", "message-forged".into(), "inspect".into())
            .unwrap();
        runtime.start("session-forged", provider(), None).unwrap();
        runtime.await_idle("session-forged").await.unwrap();

        let events = all_events(&runtime, "session-forged");
        assert!(events.iter().any(|event| matches!(
            &event.payload,
            AgentSessionEventPayload::ToolResult {
                status: AgentToolResultStatus::Failed,
                summary,
                evidence_refs,
                ..
            } if summary.contains("did not match the frozen call") && evidence_refs.is_empty()
        )));
        assert!(!events.iter().any(|event| matches!(
            event.payload,
            AgentSessionEventPayload::ContextArtifact { .. }
        )));
    }

    #[tokio::test]
    async fn tool_hooks_gate_before_execution_and_append_bounded_followup_context() {
        let rejected_native = RecordingNativeRuntime::new(false);
        let rejected_adapter = FakeAdapter::new(vec![
            tool_response(vec![native_call("call-hook-rejected", "list_directory")]),
            reply("The hook rejected the call.", &[]),
        ]);
        let rejected_root = tempfile::tempdir().unwrap();
        let rejected = AgentRuntimeBuilder::new()
            .model_factory(Arc::new(FakeFactory(rejected_adapter)))
            .native_tool_runtime(rejected_native.clone())
            .before_tool_hook(Arc::new(FixedBeforeToolHook(
                AgentBeforeToolDecision::Reject {
                    reason: "policy denied native access".into(),
                },
            )))
            .build();
        rejected
            .configure(rejected_root.path().to_path_buf())
            .unwrap();
        create(&rejected, "session-before-hook");
        rejected
            .followup(
                "session-before-hook",
                "message-before-hook".into(),
                "inspect".into(),
            )
            .unwrap();
        rejected
            .start("session-before-hook", provider(), None)
            .unwrap();
        rejected.await_idle("session-before-hook").await.unwrap();
        assert_eq!(rejected_native.executions.load(Ordering::Acquire), 0);

        let native = RecordingNativeRuntime::new(false);
        let adapter = FakeAdapter::new(vec![
            tool_response(vec![native_call("call-hook", "list_directory")]),
            reply("Used the runtime context.", &[]),
        ]);
        let root = tempfile::tempdir().unwrap();
        let runtime = AgentRuntimeBuilder::new()
            .model_factory(Arc::new(FakeFactory(adapter.clone())))
            .native_tool_runtime(native)
            .before_tool_hook(Arc::new(FixedBeforeToolHook(
                AgentBeforeToolDecision::Continue,
            )))
            .after_tool_hook(Arc::new(FixedAfterToolHook(
                AgentAfterToolDecision::AppendContext {
                    message_id: "runtime-tool-context".into(),
                    label: "afterTool".into(),
                    content: "validated native evidence".into(),
                },
            )))
            .build();
        runtime.configure(root.path().to_path_buf()).unwrap();
        create(&runtime, "session-after-hook");
        runtime
            .followup(
                "session-after-hook",
                "message-after-hook".into(),
                "inspect".into(),
            )
            .unwrap();
        runtime
            .start("session-after-hook", provider(), None)
            .unwrap();
        runtime.await_idle("session-after-hook").await.unwrap();

        assert_eq!(adapter.request_count(), 2);
        assert!(all_events(&runtime, "session-after-hook")
            .iter()
            .any(|event| matches!(
                &event.payload,
                AgentSessionEventPayload::UserMessage { message }
                    if message.message_id == "runtime-tool-context"
                        && message.content == "validated native evidence"
            )));
    }

    #[tokio::test]
    async fn approval_expiry_is_durable_and_late_decisions_are_rejected() {
        let native = Arc::new(RecordingNativeRuntime {
            requires_approval: true,
            ttl_ms: 200,
            forge_result_effect: false,
            block_execution: false,
            executing: AtomicBool::new(false),
            active: AtomicUsize::new(0),
            max_active: AtomicUsize::new(0),
            executions: AtomicUsize::new(0),
            trace: Mutex::new(Vec::new()),
        });
        let adapter = FakeAdapter::new(vec![
            tool_response(vec![native_call("call-expired", "list_directory")]),
            reply("The approval expired.", &[]),
        ]);
        let (_root, runtime) = configured_with_native(
            adapter.clone(),
            AgentDriverConfig::default(),
            native.clone(),
        );
        create(&runtime, "session-expired");
        runtime
            .followup(
                "session-expired",
                "message-expired".into(),
                "inspect".into(),
            )
            .unwrap();
        runtime.start("session-expired", provider(), None).unwrap();
        runtime.await_idle("session-expired").await.unwrap();
        let decision = pending_approval(&runtime, "session-expired");

        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if adapter.request_count() == 2
                    && runtime.session("session-expired").unwrap().status
                        == AgentSessionStatus::Idle
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();

        assert_eq!(native.executions.load(Ordering::Acquire), 0);
        assert!(runtime.approve_tool(decision).await.is_err());
        let events = all_events(&runtime, "session-expired");
        assert!(events.iter().any(|event| matches!(
            event.payload,
            AgentSessionEventPayload::ToolApproval {
                status: AgentToolApprovalStatus::Expired,
                ..
            }
        )));
        assert!(events.iter().any(|event| matches!(
            event.payload,
            AgentSessionEventPayload::ToolResult {
                status: AgentToolResultStatus::TimedOut,
                ..
            }
        )));
    }

    #[tokio::test]
    async fn cancellation_resolves_waiting_approval_and_rejects_late_execution() {
        let native = RecordingNativeRuntime::new(true);
        let adapter = FakeAdapter::new(vec![tool_response(vec![native_call(
            "call-cancelled",
            "list_directory",
        )])]);
        let (_root, runtime) =
            configured_with_native(adapter, AgentDriverConfig::default(), native.clone());
        create(&runtime, "session-cancelled-tool");
        runtime
            .followup(
                "session-cancelled-tool",
                "message-cancelled-tool".into(),
                "inspect".into(),
            )
            .unwrap();
        runtime
            .start("session-cancelled-tool", provider(), None)
            .unwrap();
        runtime.await_idle("session-cancelled-tool").await.unwrap();
        let decision = pending_approval(&runtime, "session-cancelled-tool");
        runtime.cancel("session-cancelled-tool").await.unwrap();

        assert_eq!(native.executions.load(Ordering::Acquire), 0);
        assert!(runtime.approve_tool(decision).await.is_err());
        let events = all_events(&runtime, "session-cancelled-tool");
        assert!(events.iter().any(|event| matches!(
            event.payload,
            AgentSessionEventPayload::ToolApproval {
                status: AgentToolApprovalStatus::Cancelled,
                ..
            }
        )));
        assert!(events.iter().any(|event| matches!(
            event.payload,
            AgentSessionEventPayload::ToolResult {
                status: AgentToolResultStatus::Cancelled,
                ..
            }
        )));
    }

    #[tokio::test]
    async fn cancellation_wins_an_approved_execution_race_without_late_results() {
        let native = Arc::new(RecordingNativeRuntime {
            requires_approval: true,
            ttl_ms: 60_000,
            forge_result_effect: false,
            block_execution: true,
            executing: AtomicBool::new(false),
            active: AtomicUsize::new(0),
            max_active: AtomicUsize::new(0),
            executions: AtomicUsize::new(0),
            trace: Mutex::new(Vec::new()),
        });
        let adapter = FakeAdapter::new(vec![tool_response(vec![native_call(
            "call-racing",
            "list_directory",
        )])]);
        let (_root, runtime) =
            configured_with_native(adapter, AgentDriverConfig::default(), native.clone());
        create(&runtime, "session-racing-tool");
        runtime
            .followup(
                "session-racing-tool",
                "message-racing-tool".into(),
                "inspect".into(),
            )
            .unwrap();
        runtime
            .start("session-racing-tool", provider(), None)
            .unwrap();
        runtime.await_idle("session-racing-tool").await.unwrap();
        let decision = pending_approval(&runtime, "session-racing-tool");
        let approving_runtime = runtime.clone();
        let approving = tokio::spawn(async move { approving_runtime.approve_tool(decision).await });
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while !native.executing.load(Ordering::Acquire) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        runtime.cancel("session-racing-tool").await.unwrap();
        approving.await.unwrap().unwrap();

        let events = all_events(&runtime, "session-racing-tool");
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(
                    event.payload,
                    AgentSessionEventPayload::ToolResult { .. }
                ))
                .count(),
            1
        );
        assert!(events.iter().any(|event| matches!(
            event.payload,
            AgentSessionEventPayload::ToolResult {
                status: AgentToolResultStatus::Cancelled,
                ..
            }
        )));
    }

    #[tokio::test]
    async fn restart_never_replays_an_approved_side_effect_with_uncertain_outcome() {
        let native = RecordingNativeRuntime::new(true);
        let adapter = FakeAdapter::new(vec![tool_response(vec![native_call(
            "call-uncertain",
            "apply_patch",
        )])]);
        let (root, first) = configured_with_native(adapter, AgentDriverConfig::default(), native);
        create(&first, "session-uncertain");
        first
            .followup(
                "session-uncertain",
                "message-uncertain".into(),
                "change".into(),
            )
            .unwrap();
        first.start("session-uncertain", provider(), None).unwrap();
        first.await_idle("session-uncertain").await.unwrap();
        let decision = pending_approval(&first, "session-uncertain");
        first
            .append_for_driver(
                "session-uncertain",
                Some(decision.turn_id.clone()),
                Some(decision.step_id.clone()),
                AgentSessionEventPayload::ToolApproval {
                    request_id: decision.request_id,
                    call_id: decision.call_id,
                    approval_id: Some(decision.approval_id),
                    status: AgentToolApprovalStatus::Approved,
                    risk: Some(AgentSessionEffect::StateChange),
                    reason: Some("simulated crash after authorization".into()),
                    expires_at_unix_ms: None,
                    prompt: None,
                },
            )
            .unwrap();
        first
            .append_for_driver(
                "session-uncertain",
                Some(decision.turn_id.clone()),
                Some(decision.step_id.clone()),
                AgentSessionEventPayload::ToolExecution {
                    call_id: "call-uncertain".into(),
                    status: crate::agent_runtime::AgentToolExecutionStatus::Dispatched,
                    idempotency: "no".into(),
                },
            )
            .unwrap();
        drop(first);

        let restarted_native = RecordingNativeRuntime::new(true);
        let restarted_adapter = FakeAdapter::new(Vec::new());
        let restarted = AgentRuntimeBuilder::new()
            .model_factory(Arc::new(FakeFactory(restarted_adapter.clone())))
            .native_tool_runtime(restarted_native.clone())
            .build();
        restarted.configure(root.path().to_path_buf()).unwrap();
        let snapshot = restarted
            .start("session-uncertain", provider(), None)
            .unwrap();

        assert_eq!(snapshot.status, AgentSessionStatus::Waiting);
        assert_eq!(restarted_adapter.request_count(), 0);
        assert_eq!(restarted_native.executions.load(Ordering::Acquire), 0);
        assert!(all_events(&restarted, "session-uncertain").iter().any(|event| matches!(
            &event.payload,
            AgentSessionEventPayload::TaskState {
                recovery: Some(recovery),
                ..
            } if recovery.status == AgentRecoveryStatus::Required
                && recovery.summary.as_deref().is_some_and(|summary| summary.contains("uncertain outcome"))
        )));
        assert!(!all_events(&restarted, "session-uncertain")
            .iter()
            .any(|event| matches!(event.payload, AgentSessionEventPayload::ToolResult { .. })));
        let reconciled = restarted
            .reconcile_recovery(crate::agent_runtime::AgentRecoveryReconcileInput {
                session_id: "session-uncertain".into(),
                outcome: crate::agent_runtime::AgentRecoveryReconcileOutcome::ConfirmedNotApplied,
                evidence: "Operator verified the target checksum was unchanged.".into(),
            })
            .unwrap();
        assert_eq!(
            reconciled.task.recovery.as_ref().map(|state| state.status),
            Some(AgentRecoveryStatus::Completed)
        );
        assert_eq!(restarted_native.executions.load(Ordering::Acquire), 0);
        assert!(all_events(&restarted, "session-uncertain")
            .iter()
            .any(|event| matches!(
                event.payload,
                AgentSessionEventPayload::ToolResult {
                    status: AgentToolResultStatus::Cancelled,
                    ..
                }
            )));
    }

    #[tokio::test]
    async fn restart_resumes_only_the_authorized_pre_dispatch_boundary() {
        let native = RecordingNativeRuntime::new(true);
        let adapter = FakeAdapter::new(vec![tool_response(vec![native_call(
            "call-authorized",
            "apply_patch",
        )])]);
        let (root, first) = configured_with_native(adapter, AgentDriverConfig::default(), native);
        create(&first, "session-authorized");
        first
            .followup(
                "session-authorized",
                "message-authorized".into(),
                "change".into(),
            )
            .unwrap();
        first.start("session-authorized", provider(), None).unwrap();
        first.await_idle("session-authorized").await.unwrap();
        let decision = pending_approval(&first, "session-authorized");
        first
            .append_for_driver(
                "session-authorized",
                Some(decision.turn_id),
                Some(decision.step_id),
                AgentSessionEventPayload::ToolApproval {
                    request_id: decision.request_id,
                    call_id: decision.call_id,
                    approval_id: Some(decision.approval_id),
                    status: AgentToolApprovalStatus::Approved,
                    risk: Some(AgentSessionEffect::StateChange),
                    reason: Some("simulated crash before dispatch".into()),
                    expires_at_unix_ms: None,
                    prompt: None,
                },
            )
            .unwrap();
        drop(first);

        let restarted_native = RecordingNativeRuntime::new(true);
        let restarted = AgentRuntimeBuilder::new()
            .model_factory(Arc::new(FakeFactory(FakeAdapter::new(Vec::new()))))
            .native_tool_runtime(restarted_native.clone())
            .build();
        restarted.configure(root.path().to_path_buf()).unwrap();
        let snapshot = restarted
            .start("session-authorized", provider(), None)
            .unwrap();
        assert_eq!(
            snapshot.recovery.kind,
            crate::agent_runtime::AgentRecoveryCheckpointKind::AuthorizedBeforeExecute
        );
        assert_eq!(restarted_native.executions.load(Ordering::Acquire), 0);

        restarted
            .resume_recovery("session-authorized")
            .await
            .unwrap();
        assert_eq!(restarted_native.executions.load(Ordering::Acquire), 1);
        assert!(all_events(&restarted, "session-authorized")
            .iter()
            .any(|event| matches!(
                event.payload,
                AgentSessionEventPayload::ToolExecution { .. }
            )));
    }

    #[tokio::test]
    async fn retryable_failure_retries_but_typed_terminal_failures_end_the_session() {
        let adapter = FakeAdapter::new(vec![
            FakeScript::Error(NormalizedModelError::new(
                NormalizedModelErrorKind::Retryable,
                "temporary outage",
            )),
            reply("recovered", &["recovered"]),
        ]);
        let (_root, runtime) = configured(adapter);
        create(&runtime, "session-retry");
        runtime
            .followup("session-retry", "message-retry".into(), "retry".into())
            .unwrap();
        runtime.start("session-retry", provider(), None).unwrap();
        runtime.await_idle("session-retry").await.unwrap();
        let types = event_types(&runtime, "session-retry");
        assert_eq!(
            types
                .iter()
                .filter(|kind| *kind == "request/header")
                .count(),
            2
        );
        assert_eq!(
            types.iter().filter(|kind| *kind == "request/retry").count(),
            1
        );
        assert_eq!(
            runtime.session("session-retry").unwrap().status,
            AgentSessionStatus::Idle
        );

        for (index, (kind, prefix)) in [
            (NormalizedModelErrorKind::ContextTooLarge, "contextTooLarge"),
            (
                NormalizedModelErrorKind::Authentication,
                "authenticationFailed",
            ),
            (NormalizedModelErrorKind::RateLimited, "rateLimited"),
            (NormalizedModelErrorKind::Terminal, "providerFailure"),
        ]
        .into_iter()
        .enumerate()
        {
            let error = NormalizedModelError::new(kind, "typed failure");
            let scripts = if kind == NormalizedModelErrorKind::RateLimited {
                vec![FakeScript::Error(error.clone()), FakeScript::Error(error)]
            } else {
                vec![FakeScript::Error(error)]
            };
            let adapter = FakeAdapter::new(scripts);
            let (_root, runtime) = configured(adapter);
            let session_id = format!("session-terminal-{index}");
            create(&runtime, &session_id);
            runtime
                .followup(&session_id, format!("message-{index}"), "fail".into())
                .unwrap();
            runtime.start(&session_id, provider(), None).unwrap();
            runtime.await_idle(&session_id).await.unwrap();
            let snapshot = runtime.session(&session_id).unwrap();
            assert!(snapshot.ended);
            assert_eq!(snapshot.status, AgentSessionStatus::Failed);
            let events = runtime
                .events(AgentSessionEventsRequest {
                    session_id,
                    cursor: None,
                    limit: 128,
                })
                .unwrap()
                .events;
            assert!(events.iter().any(|event| matches!(
                &event.payload,
                AgentSessionEventPayload::SessionEnded { reason: Some(reason), .. }
                    if reason.starts_with(prefix)
            )));
        }
    }

    #[tokio::test]
    async fn cancellation_closes_step_and_turn_before_session_end() {
        let adapter = FakeAdapter::new(vec![FakeScript::Wait { response: None }]);
        let (_root, runtime) = configured(adapter.clone());
        create(&runtime, "session-cancel");
        runtime
            .followup("session-cancel", "message-cancel".into(), "wait".into())
            .unwrap();
        runtime.start("session-cancel", provider(), None).unwrap();
        adapter.started.notified().await;
        let snapshot = runtime.cancel("session-cancel").await.unwrap();
        assert!(snapshot.ended);
        assert_eq!(snapshot.status, AgentSessionStatus::Cancelled);
        let types = event_types(&runtime, "session-cancel");
        let step_end = types.iter().position(|kind| kind == "step/end").unwrap();
        let turn_end = types.iter().position(|kind| kind == "turn/end").unwrap();
        let session_end = types
            .iter()
            .position(|kind| kind == "session/ended")
            .unwrap();
        assert!(step_end < turn_end && turn_end < session_end);
    }

    #[tokio::test]
    async fn empty_response_and_step_and_turn_limits_have_explicit_terminal_events() {
        let empty = FakeAdapter::new(vec![reply("", &[])]);
        let (_root, runtime) = configured(empty);
        create(&runtime, "session-empty");
        runtime
            .followup("session-empty", "message-empty".into(), "empty".into())
            .unwrap();
        runtime.start("session-empty", provider(), None).unwrap();
        runtime.await_idle("session-empty").await.unwrap();
        assert!(runtime.session("session-empty").unwrap().ended);
        assert!(runtime
            .events(AgentSessionEventsRequest {
                session_id: "session-empty".into(),
                cursor: None,
                limit: 128,
            })
            .unwrap()
            .events
            .iter()
            .any(|event| matches!(
                &event.payload,
                AgentSessionEventPayload::SessionEnded { reason: Some(reason), .. }
                    if reason.starts_with("emptyResponse")
            )));

        let step_limited = FakeAdapter::new(vec![FakeScript::Wait {
            response: Some(response("first")),
        }]);
        let (_root, runtime) = configured_with(
            step_limited.clone(),
            AgentDriverConfig {
                max_steps_per_turn: 1,
                ..AgentDriverConfig::default()
            },
        );
        create(&runtime, "session-step-limit");
        runtime
            .followup(
                "session-step-limit",
                "message-step-limit".into(),
                "first".into(),
            )
            .unwrap();
        runtime
            .start("session-step-limit", provider(), None)
            .unwrap();
        step_limited.started.notified().await;
        runtime
            .steer(
                "session-step-limit",
                "message-extra-step".into(),
                "another step".into(),
            )
            .unwrap();
        step_limited.release.notify_one();
        runtime.await_idle("session-step-limit").await.unwrap();
        assert!(runtime
            .events(AgentSessionEventsRequest {
                session_id: "session-step-limit".into(),
                cursor: None,
                limit: 128,
            })
            .unwrap()
            .events
            .iter()
            .any(|event| matches!(
                &event.payload,
                AgentSessionEventPayload::SessionEnded { reason: Some(reason), .. }
                    if reason.starts_with("stepLimitExceeded")
            )));

        let turn_limited = FakeAdapter::new(vec![reply("first", &["first"])]);
        let (_root, runtime) = configured_with(
            turn_limited,
            AgentDriverConfig {
                max_turns_per_session: 1,
                ..AgentDriverConfig::default()
            },
        );
        create(&runtime, "session-turn-limit");
        for index in 0..2 {
            runtime
                .followup(
                    "session-turn-limit",
                    format!("message-turn-limit-{index}"),
                    format!("turn-{index}"),
                )
                .unwrap();
        }
        runtime
            .start("session-turn-limit", provider(), None)
            .unwrap();
        runtime.await_idle("session-turn-limit").await.unwrap();
        assert!(runtime
            .events(AgentSessionEventsRequest {
                session_id: "session-turn-limit".into(),
                cursor: None,
                limit: 128,
            })
            .unwrap()
            .events
            .iter()
            .any(|event| matches!(
                &event.payload,
                AgentSessionEventPayload::SessionEnded { reason: Some(reason), .. }
                    if reason.starts_with("turnLimitExceeded")
            )));
    }

    #[tokio::test]
    async fn concurrent_wakes_never_run_two_model_requests_for_one_session() {
        let mut scripts = vec![FakeScript::Wait {
            response: Some(response("first")),
        }];
        scripts.extend((0..8).map(|index| reply(&format!("reply-{index}"), &["reply"])));
        let adapter = FakeAdapter::new(scripts);
        let (_root, runtime) = configured(adapter.clone());
        create(&runtime, "session-wake");
        runtime
            .followup("session-wake", "message-initial".into(), "initial".into())
            .unwrap();
        runtime.start("session-wake", provider(), None).unwrap();
        adapter.started.notified().await;
        let mut tasks = Vec::new();
        for index in 0..8 {
            let runtime = runtime.clone();
            tasks.push(tokio::spawn(async move {
                runtime.followup(
                    "session-wake",
                    format!("message-wake-{index}"),
                    format!("followup-{index}"),
                )
            }));
        }
        for task in tasks {
            task.await.unwrap().unwrap();
        }
        adapter.release.notify_one();
        runtime.await_idle("session-wake").await.unwrap();
        assert_eq!(adapter.request_count(), 9);
        assert_eq!(adapter.max_active.load(Ordering::Acquire), 1);
        assert_eq!(
            event_types(&runtime, "session-wake")
                .iter()
                .filter(|kind| *kind == "turn/start")
                .count(),
            9
        );
    }

    #[test]
    fn restart_fails_closed_instead_of_replaying_an_open_model_step() {
        let root = tempfile::tempdir().unwrap();
        let first = AgentRuntime::default();
        first.configure(root.path().to_path_buf()).unwrap();
        create(&first, "session-restart");
        first
            .append_for_driver(
                "session-restart",
                Some("turn-open".into()),
                None,
                AgentSessionEventPayload::TurnStart,
            )
            .unwrap();
        first
            .append_for_driver(
                "session-restart",
                Some("turn-open".into()),
                Some("step-open".into()),
                AgentSessionEventPayload::StepStart,
            )
            .unwrap();
        drop(first);

        let adapter = FakeAdapter::new(Vec::new());
        let restarted = AgentRuntimeBuilder::new()
            .model_factory(Arc::new(FakeFactory(adapter.clone())))
            .build();
        restarted.configure(root.path().to_path_buf()).unwrap();
        assert!(restarted
            .start("session-restart", provider(), None)
            .is_err());
        let snapshot = restarted.session("session-restart").unwrap();
        assert!(snapshot.ended);
        assert_eq!(snapshot.status, AgentSessionStatus::Failed);
        assert_eq!(adapter.request_count(), 0);
    }
}
