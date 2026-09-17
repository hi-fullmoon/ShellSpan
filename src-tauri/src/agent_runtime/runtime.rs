use std::collections::HashMap;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::ai::AiProviderConfig;
use base64::Engine;
use tauri::Emitter;

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
    assistant_content_text, AgentAfterToolHook, AgentBeforeToolHook, AgentPreStepHook,
    AgentRequestReason, AgentSessionEventPayload, AgentToolFailedHook, ModelAdapterFactory,
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
            agents.clone(),
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
            file_references: super::file_references::FileReferenceRuntime::new(
                self.sessions.clone(),
                self.native_tools.clone(),
            ),
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
    pub(crate) file_references: super::file_references::FileReferenceRuntime,
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
    pub(crate) async fn prepare_images(
        &self,
        uploads: Vec<super::images::ImageUpload>,
    ) -> Result<Vec<super::images::ImageUpload>, String> {
        let permit = self.models.images.import_permit()?;
        let store = self.models.images.clone();
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let refs = store.import(&uploads, &tokio_util::sync::CancellationToken::new())?;
            refs.into_iter()
                .map(|r| {
                    Ok(super::images::ImageUpload {
                        data: base64::engine::general_purpose::STANDARD.encode(store.read(&r)?),
                        name: r.name,
                        media_type: r.media_type,
                    })
                })
                .collect()
        })
        .await
        .map_err(|e| e.to_string())?
    }
    pub(crate) async fn submit_images(
        &self,
        input: super::images::ImageSubmission,
    ) -> Result<AgentSessionSnapshot, String> {
        use super::images::{digest, ImageOperation};
        super::images::validate_upload_envelope(&input.images)?;
        if input.content.len() > super::MAX_AGENT_MESSAGE_BYTES {
            return Err("IMAGE_TEXT_LIMIT".into());
        }
        let terminal_context =
            self.prepare_terminal_context(&input.session_id, input.terminal_context.clone())?;
        let operation = ImageOperation {
            session_id: input.session_id.clone(),
            client_operation_id: input.client_operation_id.clone(),
        };
        let token = self.models.images.token(&operation)?;
        // Fingerprint original input, not sanitized text or normalized pixels.
        let fingerprint = digest(&serde_json::to_vec(&serde_json::json!({"content":input.content, "lane":input.lane, "images":input.images})).map_err(|e| e.to_string())?);
        for event in self.sessions.all_events(&input.session_id)? {
            if let super::AgentSessionEventPayload::InboxSpliced {
                operation: super::AgentInboxOperation::Enqueued,
                messages,
                ..
            } = event.payload
            {
                if let Some(message) = messages
                    .iter()
                    .find(|m| m.client_submission_id.as_deref() == Some(&input.client_operation_id))
                {
                    return if message
                        .source
                        .metadata
                        .get("imageFingerprint")
                        .and_then(serde_json::Value::as_str)
                        == Some(&fingerprint)
                    {
                        self.sessions.snapshot(&input.session_id)
                    } else {
                        Err("IMAGE_SUBMISSION_CONFLICT".into())
                    };
                }
            }
        }
        let entry = self
            .agents
            .get(&input.session_id)?
            .ok_or("IMAGE_SESSION_NOT_STARTED")?;
        if entry.cancellation().is_cancelled() || token.is_cancelled() {
            return Err("IMAGE_CANCELLED".into());
        }
        let route = super::images::vision_route(&entry.model()?.provider)?;
        let store = self.models.images.clone();
        let uploads = input.images;
        let import_token = token.clone();
        let permit = self.models.images.import_permit()?;
        let images = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            store.import(&uploads, &import_token)
        })
        .await
        .map_err(|e| e.to_string())??;
        self.models.images.boundary("beforeInbox", &token)?;
        let gate = self
            .models
            .images
            .operations
            .lock()
            .map_err(|_| "IMAGE_OPERATION_UNAVAILABLE")?;
        for event in self.sessions.all_events(&input.session_id)? {
            if let super::AgentSessionEventPayload::InboxSpliced {
                operation: super::AgentInboxOperation::Enqueued,
                messages,
                ..
            } = event.payload
            {
                if let Some(message) = messages
                    .iter()
                    .find(|m| m.client_submission_id.as_deref() == Some(&input.client_operation_id))
                {
                    return if message
                        .source
                        .metadata
                        .get("imageFingerprint")
                        .and_then(serde_json::Value::as_str)
                        == Some(&fingerprint)
                    {
                        self.sessions.snapshot(&input.session_id)
                    } else {
                        Err("IMAGE_SUBMISSION_CONFLICT".into())
                    };
                }
            }
        }
        let snapshot = self.sessions.snapshot(&input.session_id)?;
        let mut request = super::ModelRequest::from_surface(
            "image-admission".into(),
            &snapshot.surface,
            String::new(),
            Vec::new(),
        );
        for pending in snapshot
            .inbox
            .next_turn
            .iter()
            .chain(snapshot.inbox.next_step.iter())
        {
            if !pending.images.is_empty() {
                request.messages.push(super::ModelMessage::UserImages {
                    content: pending.content.clone(),
                    images: pending.images.clone(),
                    data_urls: Vec::new(),
                });
            }
        }
        if let Some(context) = &terminal_context {
            request.messages.push(super::ModelMessage::User {
                content: context.model_content(),
            });
        }
        request.messages.push(super::ModelMessage::UserImages {
            content: input.content.clone(),
            images: images.clone(),
            data_urls: Vec::new(),
        });
        let count: usize = request
            .messages
            .iter()
            .map(|m| match m {
                super::ModelMessage::UserImages { images, .. } => images.len(),
                _ => 0,
            })
            .sum();
        if count > route.max_request_images {
            return Err("IMAGE_REQUEST_BUDGET: start a new session for more images".into());
        }
        let budget = super::estimate_model_surface_budget(&entry.model()?.provider, &request)?;
        if budget.estimated_input_tokens > budget.usable_input_tokens {
            return Err("IMAGE_TOKEN_BUDGET".into());
        }
        if token.is_cancelled() || entry.cancellation().is_cancelled() {
            return Err("IMAGE_CANCELLED".into());
        }
        let mut source = AgentMessageSource::user();
        source
            .metadata
            .insert("imageFingerprint".into(), fingerprint.into());
        let snapshot = self.sessions.enqueue(
            &input.session_id,
            input.lane,
            AgentInboxMessage {
                images,
                message_id: input.client_operation_id.clone(),
                client_submission_id: Some(input.client_operation_id),
                content: crate::redaction::redact_sensitive_text(&input.content),
                source,
                terminal_context,
            },
        )?;
        drop(gate);
        let _ = self.models.images.boundary("afterInbox", &token);
        // Inbox commit is the acknowledgement. A wake failure cannot undo acceptance.
        let _ = self.wake(&input.session_id);
        Ok(snapshot)
    }

    pub(crate) fn cancel_image_submission(
        &self,
        input: super::images::ImageOperation,
    ) -> Result<bool, String> {
        let token = self.models.images.token(&input)?;
        let _gate = self
            .models
            .images
            .operations
            .lock()
            .map_err(|_| "IMAGE_OPERATION_UNAVAILABLE")?;
        token.cancel();
        Ok(self.sessions.all_events(&input.session_id)?.iter().any(|e| matches!(&e.payload,
            super::AgentSessionEventPayload::InboxSpliced { operation: super::AgentInboxOperation::Enqueued, messages, .. }
                if messages.iter().any(|m| m.client_submission_id.as_deref() == Some(&input.client_operation_id)))))
    }

    pub(crate) fn image_preview(
        &self,
        input: super::images::ImagePreviewRequest,
    ) -> Result<String, String> {
        // The renderer cannot read by a guessed global blob hash. Require a committed input
        // in the addressed Session, never an arbitrary path or renderer-provided reference.
        let reference = self
            .sessions
            .all_events(&input.session_id)?
            .into_iter()
            .find_map(|e| {
                if let super::AgentSessionEventPayload::InboxSpliced {
                    operation: super::AgentInboxOperation::Enqueued,
                    messages,
                    ..
                } = e.payload
                {
                    messages
                        .into_iter()
                        .flat_map(|m| m.images)
                        .find(|r| r.sha256 == input.sha256)
                } else {
                    None
                }
            })
            .ok_or("IMAGE_REFERENCE_NOT_IN_SESSION")?;
        Ok(format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(self.models.images.read(&reference)?)
        ))
    }

    pub(crate) async fn list_skills(
        &self,
        session_id: &str,
    ) -> Result<super::skill_runtime::SkillUserList, String> {
        self.tools
            .skills
            .list(session_id, tokio_util::sync::CancellationToken::new())
            .await
    }

    pub(crate) fn answer_question(
        &self,
        input: super::user_questions::AnswerQuestionInput,
        _credentials: Option<&crate::keychain::CredentialManager>,
    ) -> Result<AgentSessionSnapshot, String> {
        input.validate()?;
        let session_id = input.identity.session_id.clone();
        let records = super::user_questions::records(&self.sessions.all_events(&session_id)?);
        let question = records
            .iter()
            .find(|r| r.identity == input.identity)
            .ok_or("unknown or stale question identity")?;
        question.arguments.normalize_answers(&input.answers)?;
        if question.cancelled
            || self.sessions.snapshot(&session_id)?.status == super::AgentSessionStatus::Cancelled
        {
            return Err("question was cancelled".into());
        }
        if question.answer.is_some()
            && !super::user_questions::is_same_submission(question, &input)?
        {
            return Err("question answer conflicts with its committed answer".into());
        }
        if self.sessions.snapshot(&session_id)?.ended {
            return if super::user_questions::is_same_submission(question, &input)? {
                self.sessions.snapshot(&session_id)
            } else {
                Err("question Session has ended".into())
            };
        }
        if self.agents.get(&session_id)?.is_none() {
            let selected = self.sessions.snapshot(&session_id)?.header.model_selection;
            let provider = self
                .models
                .restore_selection(selected.as_ref().unwrap_or(&question.provider))?;
            crate::ai::validate_provider_config(&provider, true)?;
            // Production continuations resolve the exact versioned credential in
            // LlmRuntime::prepare_model. Isolated unit tests install fixture keys.
            #[cfg(not(test))]
            let api_key = None;
            #[cfg(test)]
            let api_key = if self.models.uses_route_store() {
                None
            } else {
                match _credentials {
                    Some(credentials) => crate::ai::api_key_for_provider(credentials, &provider)?,
                    None if provider.requires_api_key => {
                        return Err("question continuation requires provider credentials".into())
                    }
                    None => None,
                }
            };
            self.start(&session_id, provider, api_key)?;
        }
        let entry = self
            .agents
            .get(&session_id)?
            .ok_or("question Agent is not live")?;
        self.tools.submit_question_answer(&entry, input)?;
        self.wake(&session_id)?;
        self.sessions.snapshot(&session_id)
    }

    pub(crate) fn configure_llm(
        &self,
        runtime: crate::llm::runtime::LlmRuntime,
    ) -> Result<(), String> {
        self.models.configure_llm(runtime)
    }

    #[cfg(test)]
    pub(crate) fn configure_test_model(
        &self,
        provider: crate::ai::AiProviderConfig,
    ) -> Result<(), String> {
        self.models.register_test_config(provider)
    }
    pub(crate) fn configure_credentials(
        &self,
        credentials: crate::keychain::CredentialManager,
    ) -> Result<(), String> {
        self.subagents.set_credentials(credentials)
    }

    pub(crate) fn configure_native(&self, app: tauri::AppHandle) -> Result<(), String> {
        self.native_engine.reconcile_remote_visible_rollout()?;
        let emitter = app.clone();
        self.native_engine
            .set_terminal_lease_publisher(Arc::new(move |event| {
                if let Err(error) = emitter.emit(super::AGENT_TERMINAL_LEASE_EVENT, event) {
                    log::warn!("Failed to publish Agent terminal lease event: {error}");
                }
            }))?;
        if let Some(slot) = &self.native_slot {
            slot.install(Arc::new(NativeToolAdapter::new(
                app,
                Arc::clone(&self.native_engine),
            )))?;
        }
        Ok(())
    }

    pub(crate) fn observe_terminal_output(&self, session_id: &str, chunk: &str) -> String {
        let _ = session_id;
        chunk.to_string()
    }

    pub(crate) fn observe_terminal_raw_output(
        &self,
        session_id: &str,
        bytes: &[u8],
    ) -> Result<Option<crate::terminal_broker::TerminalRawOutputFrame>, String> {
        self.native_engine
            .observe_terminal_raw_output(session_id, bytes)
    }

    pub(crate) fn attach_terminal_broker_transport(
        &self,
        transport_session_id: &str,
        predecessor_transport_session_id: Option<&str>,
        transport_kind: crate::terminal_broker::TerminalTransportKind,
        geometry: crate::terminal_broker::TerminalGeometry,
    ) -> Result<Option<crate::terminal_broker::TerminalBrokerAttachment>, String> {
        self.native_engine.attach_terminal_broker_transport(
            transport_session_id,
            predecessor_transport_session_id,
            transport_kind,
            geometry,
        )
    }

    pub(crate) fn terminal_broker_attachment(
        &self,
        transport_session_id: &str,
    ) -> Result<Option<crate::terminal_broker::TerminalBrokerAttachment>, String> {
        self.native_engine
            .terminal_broker_attachment(transport_session_id)
    }

    pub(crate) fn close_terminal_broker_transport(
        &self,
        transport_session_id: &str,
        reason: crate::terminal_broker::TerminalGenerationCloseReason,
    ) -> Result<bool, String> {
        self.native_engine
            .close_terminal_broker_transport(transport_session_id, reason)
    }

    pub(crate) fn resize_terminal_broker(
        &self,
        transport_session_id: &str,
        columns: u32,
        rows: u32,
    ) -> Result<(), String> {
        self.native_engine.resize_terminal_broker(
            transport_session_id,
            crate::terminal_broker::TerminalGeometry::new(columns, rows),
        )
    }

    pub(crate) fn mark_terminal_broker_output_ready(
        &self,
        transport_session_id: &str,
    ) -> Result<(), String> {
        self.native_engine
            .mark_terminal_broker_output_ready(transport_session_id)
    }

    pub(crate) fn set_terminal_broker_output_paused(
        &self,
        transport_session_id: &str,
        paused: bool,
    ) -> Result<(), String> {
        self.native_engine
            .set_terminal_broker_output_paused(transport_session_id, paused)
    }

    pub(crate) fn terminal_broker_snapshot(
        &self,
        transport_session_id: Option<&str>,
    ) -> Result<crate::terminal_broker::TerminalBrokerSnapshot, String> {
        self.native_engine
            .terminal_broker_snapshot(transport_session_id)
    }

    pub(crate) fn terminal_shell_integration_enabled(&self) -> Result<bool, String> {
        self.native_engine.terminal_shell_integration_enabled()
    }

    pub(crate) fn register_terminal_integration_channel(
        &self,
        transport_session_id: &str,
        integration_id: &str,
        shell: crate::terminal_integration::TerminalShellKind,
    ) -> Result<(), String> {
        self.native_engine.register_terminal_integration_channel(
            transport_session_id,
            integration_id,
            shell,
        )
    }

    pub(crate) fn accept_terminal_integration_event(
        &self,
        transport_session_id: &str,
        integration_id: &str,
        event: crate::terminal_integration::TerminalIntegrationControlEvent,
    ) -> Result<(), String> {
        self.native_engine.accept_terminal_integration_event(
            transport_session_id,
            integration_id,
            event,
        )
    }

    pub(crate) fn terminal_integration_channel_closed(
        &self,
        transport_session_id: &str,
        integration_id: &str,
        reason: &str,
    ) -> Result<(), String> {
        self.native_engine.terminal_integration_channel_closed(
            transport_session_id,
            integration_id,
            reason,
        )
    }

    pub(crate) fn mark_terminal_integration_degraded(
        &self,
        transport_session_id: &str,
        shell: crate::terminal_integration::TerminalShellKind,
        reason: &str,
    ) -> Result<(), String> {
        self.native_engine
            .mark_terminal_integration_degraded(transport_session_id, shell, reason)
    }

    pub(crate) fn mark_terminal_integration_unavailable(
        &self,
        transport_session_id: &str,
        shell: crate::terminal_integration::TerminalShellKind,
        reason: &str,
    ) -> Result<(), String> {
        self.native_engine.mark_terminal_integration_unavailable(
            transport_session_id,
            shell,
            reason,
        )
    }

    pub(crate) fn write_user_terminal_input(
        &self,
        sessions: &crate::models::SessionManager,
        session_id: &str,
        data: String,
    ) -> Result<(), String> {
        self.native_engine
            .write_user_terminal_input(sessions, session_id, data)
    }

    pub(crate) fn acknowledge_terminal_lease_ready(
        &self,
        session_id: &str,
        agent_session_id: &str,
        operation_id: &str,
        terminal_connected: bool,
        output_listener_ready: bool,
        has_pending_user_input: bool,
        has_unverified_user_submission: bool,
        has_credential_prompt: bool,
    ) -> Result<bool, String> {
        self.native_engine.acknowledge_terminal_lease_ready(
            session_id,
            agent_session_id,
            operation_id,
            terminal_connected,
            output_listener_ready,
            has_pending_user_input,
            has_unverified_user_submission,
            has_credential_prompt,
        )
    }

    pub(crate) fn takeover_terminal(
        &self,
        sessions: &crate::models::SessionManager,
        session_id: &str,
        agent_session_id: &str,
        operation_id: &str,
    ) -> Result<bool, String> {
        self.native_engine
            .takeover_terminal(sessions, session_id, agent_session_id, operation_id)
    }

    pub(crate) fn terminal_closed(&self, session_id: &str) -> Result<bool, String> {
        self.native_engine.terminal_closed(session_id)
    }

    pub(crate) fn prepare_for_shutdown(
        &self,
        sessions: &crate::models::SessionManager,
    ) -> Result<usize, String> {
        self.native_engine.prepare_for_shutdown(sessions)
    }

    pub(crate) fn configure(&self, app_data_root: PathBuf) -> Result<(), String> {
        self.native_engine.configure_terminal_broker_rollout()?;
        let parallelism = std::env::var("SHELLSPAN_MAX_PARALLEL_TOOL_CALLS")
            .map(Some)
            .or_else(|error| match error {
                std::env::VarError::NotPresent => Ok(None),
                _ => Err("invalid parallel tool limit environment value".to_string()),
            })?;
        self.tools.configure_parallelism(parallelism.as_deref())?;
        self.sessions.configure(app_data_root.clone())?;
        self.models.images.configure(&app_data_root)?;
        self.artifacts.configure(&app_data_root)?;
        self.reconcile_artifacts()
    }

    pub(crate) fn set_event_publisher(
        &self,
        publisher: Arc<dyn Fn(&AgentSessionEvent) + Send + Sync>,
    ) -> Result<(), String> {
        let native_engine = Arc::clone(&self.native_engine);
        let sessions = self.sessions.clone();
        let tools = self.tools.clone();
        self.sessions.set_publisher(Arc::new(move |event| {
            if matches!(event.payload, super::AgentSessionEventPayload::TurnStart) {
                tools.clear_ephemeral_terminal_results(&event.session_id);
                if let Err(error) = native_engine.release_terminal_turn(&event.session_id) {
                    log::warn!("Failed to clear previous Agent terminal turn guard: {error}");
                }
                if let Ok(snapshot) = sessions.snapshot(&event.session_id) {
                    if snapshot.header.execution_surface
                        == super::AgentExecutionSurface::BoundTerminal
                    {
                        if let Some(target) = &snapshot.header.target {
                            if let Err(error) = native_engine
                                .begin_terminal_turn(&target.session_id, &event.session_id)
                            {
                                log::warn!("Failed to lock Agent terminal for the turn: {error}");
                            }
                        }
                    }
                }
            } else if matches!(
                event.payload,
                super::AgentSessionEventPayload::TurnEnd { .. }
                    | super::AgentSessionEventPayload::SessionEnded { .. }
                    | super::AgentSessionEventPayload::SessionResumed { .. }
            ) {
                tools.clear_ephemeral_terminal_results(&event.session_id);
                if let Err(error) = native_engine.release_terminal_turn(&event.session_id) {
                    log::warn!("Failed to release Agent terminal turn input guard: {error}");
                }
            }
            publisher(event);
        }))
    }

    pub(crate) fn create_session(
        &self,
        request: CreateAgentSessionRequest,
    ) -> Result<AgentSessionSnapshot, String> {
        self.sessions.create(request)
    }

    pub(crate) fn select_model(
        &self,
        session_id: &str,
        provider: AiProviderConfig,
        api_key: Option<String>,
    ) -> Result<AgentSessionSnapshot, String> {
        let snapshot = self.sessions.snapshot(session_id)?;
        if snapshot.header.subagent.is_some() || snapshot.ended || snapshot.archived {
            return Err("Model selection requires an active root session".into());
        }
        crate::ai::validate_provider_config(&provider, true)?;
        // Retained image history must remain consumable by the selected model.
        if snapshot.surface.messages.iter().any(|message| {
            matches!(message,
            super::AgentSurfaceMessage::UserImages { images, .. } if !images.is_empty())
        }) || snapshot
            .inbox
            .next_turn
            .iter()
            .chain(&snapshot.inbox.next_step)
            .any(|message| !message.images.is_empty())
        {
            super::images::vision_route(&provider)?;
        }
        let descriptor = super::subagent::provider_descriptor(&provider);
        let adapter = self.models.resolve(provider.clone(), api_key)?;
        let entry = self.agents.get(session_id)?;
        let mut current = entry
            .as_ref()
            .map(|entry| {
                entry
                    .model
                    .lock()
                    .map_err(|_| "Agent model selection lock is unavailable".to_string())
            })
            .transpose()?;
        if self
            .sessions
            .snapshot(session_id)?
            .header
            .model_selection
            .as_ref()
            != Some(&descriptor)
        {
            self.sessions.append(
                session_id,
                None,
                None,
                super::AgentSessionEventPayload::SessionModelSelected {
                    provider: descriptor,
                },
            )?;
        }
        if let Some(current) = current.as_mut() {
            **current = super::AgentModelSelection { provider, adapter };
        }
        self.sessions.snapshot(session_id)
    }

    pub(crate) fn set_permission_mode(
        &self,
        session_id: &str,
        mode: super::AgentSessionPermissionMode,
    ) -> Result<AgentSessionSnapshot, String> {
        let snapshot = self.sessions.snapshot(session_id)?;
        if snapshot.header.subagent.is_some() || snapshot.ended || snapshot.archived {
            return Err("Permission selection requires an active root session".into());
        }
        if snapshot.header.permission_mode != Some(mode) {
            self.sessions.append(
                session_id,
                None,
                None,
                super::AgentSessionEventPayload::SessionPermissionChanged { mode },
            )?;
        }
        self.sessions.snapshot(session_id)
    }

    pub(crate) fn set_execution_surface(
        &self,
        session_id: &str,
        surface: super::AgentExecutionSurface,
    ) -> Result<AgentSessionSnapshot, String> {
        let entry = self.agents.get(session_id)?;
        let reserved = if let Some(entry) = &entry {
            if !entry.try_acquire_archive() {
                return Err(
                    "EXECUTION_SURFACE_BUSY: wait for the current operation to finish".into(),
                );
            }
            Some(ActiveDriverLease(Arc::clone(entry)))
        } else {
            None
        };
        let result = (|| {
            let snapshot = self.sessions.snapshot(session_id)?;
            if snapshot.header.subagent.is_some() || snapshot.ended || snapshot.archived {
                return Err("Execution surface selection requires an active root Session".into());
            }
            if snapshot.status != super::AgentSessionStatus::Idle
                || snapshot.uncertain_native_effects
                || snapshot.recovery.kind == super::AgentRecoveryCheckpointKind::WaitingApproval
            {
                return Err(
                    "EXECUTION_SURFACE_BUSY: wait for the Agent and terminal to become idle".into(),
                );
            }
            if let Some(agent) = &entry {
                if agent.phase()? != AgentLifecyclePhase::Idle || agent.scope()?.is_some() {
                    return Err("EXECUTION_SURFACE_BUSY: wait for the Agent to become idle".into());
                }
            }
            if let Some(target) = &snapshot.header.target {
                if self.native_engine.has_terminal_lease(&target.session_id)? {
                    return Err(
                        "EXECUTION_SURFACE_BUSY: wait for the terminal lease to be released".into(),
                    );
                }
            }
            if snapshot.header.execution_surface != surface {
                self.sessions.append(
                    session_id,
                    None,
                    None,
                    super::AgentSessionEventPayload::SessionExecutionSurfaceChanged { surface },
                )?;
            }
            self.sessions.snapshot(session_id)
        })();
        drop(reserved);
        if self.sessions.snapshot(session_id).is_ok_and(|snapshot| {
            !snapshot.inbox.next_turn.is_empty() || !snapshot.inbox.next_step.is_empty()
        }) {
            let _ = self.wake(session_id);
        }
        result
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
        if let Some(policy) = provider.retry_policy {
            policy.validate()?;
        }
        self.sessions.repair_step_claims(session_id)?;
        let adapter = self.models.resolve(provider.clone(), api_key)?;
        if self
            .sessions
            .snapshot(session_id)?
            .header
            .model_selection
            .is_none()
        {
            self.sessions.append(
                session_id,
                None,
                None,
                super::AgentSessionEventPayload::SessionModelSelected {
                    provider: super::subagent::provider_descriptor(&provider),
                },
            )?;
        }
        let handle = self.agents.attach(
            self.sessions.clone(),
            session_id.to_string(),
            provider,
            adapter,
        )?;
        let entry = handle.entry();
        *entry
            .model_registry
            .lock()
            .map_err(|_| "MODEL_REGISTRY_UNAVAILABLE")? = Some(self.models.clone());
        let recovery = self.sessions.snapshot(session_id)?.recovery;
        if matches!(
            recovery.status,
            super::AgentRecoveryStatus::Available | super::AgentRecoveryStatus::Required
        ) || recovery.kind == super::AgentRecoveryCheckpointKind::WaitingApproval
        {
            entry.set_phase(AgentLifecyclePhase::Waiting)?;
        }
        if let Err(error) = recover_open_scope(&self.sessions, &entry) {
            self.agents.detach(session_id)?;
            return Err(error);
        }
        self.tools.restore_question_phase(&entry)?;
        if let Err(error) = self.tools.recover_waiting(&entry) {
            self.agents.detach(session_id)?;
            return Err(error);
        }
        self.tools.restore_skill_phase(&entry)?;
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

    fn prepare_terminal_context(
        &self,
        session_id: &str,
        context: Option<super::AgentTerminalContextSnapshot>,
    ) -> Result<Option<super::AgentTerminalContextSnapshot>, String> {
        let Some(mut context) = context else {
            return Ok(None);
        };
        let snapshot = self.sessions.snapshot(session_id)?;
        let bound_session_id = snapshot
            .header
            .target
            .as_ref()
            .map(|target| target.session_id.as_str());
        if bound_session_id != Some(context.session_id.as_str()) {
            return Err("TERMINAL_CONTEXT_TARGET_MISMATCH".into());
        }
        if context.version == 0
            || context.version > 9_007_199_254_740_991
            || context.max_lines == 0
            || context.max_lines > 10_000
            || context.max_bytes == 0
            || context.max_bytes as usize > super::MAX_TERMINAL_CONTEXT_BYTES
            || context.content.len() > context.max_bytes as usize
        {
            return Err("TERMINAL_CONTEXT_LIMIT".into());
        }
        let plain = super::strip_ansi(&context.content);
        context.content = plain
            .lines()
            .map(|line| {
                let clean = line
                    .chars()
                    .filter(|ch| !ch.is_control() || *ch == '\t')
                    .collect::<String>();
                crate::redaction::redact_sensitive_text(&clean)
            })
            .collect::<Vec<_>>()
            .join("\n");
        if context.content.trim().is_empty()
            || crate::redaction::redact_sensitive_text(&context.content) != context.content
        {
            return Err("TERMINAL_CONTEXT_UNSAFE".into());
        }
        Ok(Some(context))
    }

    pub(crate) fn followup_submission(
        &self,
        session_id: &str,
        message_id: String,
        client_submission_id: String,
        content: String,
        terminal_context: Option<super::AgentTerminalContextSnapshot>,
    ) -> Result<AgentSessionSnapshot, String> {
        let terminal_context = self.prepare_terminal_context(session_id, terminal_context)?;
        let snapshot = self.sessions.enqueue(
            session_id,
            AgentInboxLane::NextTurn,
            AgentInboxMessage {
                images: Vec::new(),
                message_id,
                client_submission_id: Some(client_submission_id),
                content,
                source: AgentMessageSource::user(),
                terminal_context,
            },
        )?;
        self.wake(session_id)?;
        Ok(snapshot)
    }

    #[cfg(test)]
    pub(crate) fn followup(
        &self,
        session_id: &str,
        message_id: String,
        content: String,
    ) -> Result<AgentSessionSnapshot, String> {
        let client_submission_id = message_id.clone();
        self.followup_submission(session_id, message_id, client_submission_id, content, None)
    }

    pub(crate) fn steer_submission(
        &self,
        session_id: &str,
        message_id: String,
        client_submission_id: String,
        content: String,
        terminal_context: Option<super::AgentTerminalContextSnapshot>,
    ) -> Result<AgentSessionSnapshot, String> {
        let terminal_context = self.prepare_terminal_context(session_id, terminal_context)?;
        let snapshot = self.sessions.enqueue(
            session_id,
            AgentInboxLane::NextStep,
            AgentInboxMessage {
                images: Vec::new(),
                message_id,
                client_submission_id: Some(client_submission_id),
                content,
                source: AgentMessageSource::user(),
                terminal_context,
            },
        )?;
        self.wake(session_id)?;
        Ok(snapshot)
    }

    #[cfg(test)]
    pub(crate) fn steer(
        &self,
        session_id: &str,
        message_id: String,
        content: String,
    ) -> Result<AgentSessionSnapshot, String> {
        let client_submission_id = message_id.clone();
        self.steer_submission(session_id, message_id, client_submission_id, content, None)
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
                images: Vec::new(),
                message_id,
                client_submission_id: None,
                content,
                source: AgentMessageSource::runtime(label),
                terminal_context: None,
            },
        )
    }

    pub(crate) fn mutate_inbox(
        &self,
        input: super::AgentInboxMutationInput,
    ) -> Result<AgentSessionSnapshot, String> {
        // Steer only accepts a running open turn under the Session lock. Its
        // driver owns the next-step boundary (including the atomic TurnEnd
        // check); waking here could restart a stopped/recovered Session or
        // turn an already committed receipt into a scheduling failure.
        let active = self
            .agents
            .get(&input.session_id)
            .ok()
            .flatten()
            .is_some_and(|entry| {
                entry.is_driver_active()
                    && !entry.cancellation().is_cancelled()
                    && entry.phase().ok() == Some(super::AgentLifecyclePhase::Running)
            });
        // Session checks receipts before this admission flag, so cold/stopped
        // instances can still acknowledge an earlier successful operation.
        let resume = matches!(input.mutation, super::AgentInboxMutation::Resume { .. });
        let session_id = input.session_id.clone();
        let snapshot = self.sessions.mutate_inbox_with_driver(input, active)?;
        if resume {
            self.wake(&session_id)?;
        }
        Ok(snapshot)
    }

    pub(crate) fn rename_session(
        &self,
        input: super::AgentSessionRenameInput,
    ) -> Result<AgentSessionSnapshot, String> {
        self.sessions.rename(input)
    }

    pub(crate) async fn cancel(&self, session_id: &str) -> Result<AgentSessionSnapshot, String> {
        self.stop_session(session_id, true).await
    }

    pub(crate) async fn interrupt(&self, session_id: &str) -> Result<AgentSessionSnapshot, String> {
        if self
            .sessions
            .snapshot(session_id)?
            .header
            .subagent
            .is_some()
        {
            return Err("human interruption requires a root Session".into());
        }
        self.stop_session(session_id, false).await
    }

    pub(crate) async fn resume(&self, session_id: &str) -> Result<AgentSessionSnapshot, String> {
        let snapshot = self.sessions.snapshot(session_id)?;
        if snapshot.archived || snapshot.header.subagent.is_some() {
            return Err("only an unarchived root Session can be resumed".into());
        }
        if !snapshot.ended {
            return Ok(snapshot);
        }
        // Join and detach the previous entry before creating a fresh cancellation token.
        // Do not call cancel(session_id): a concurrent retry may have already resumed it.
        let handle = self
            .handles
            .lock()
            .map_err(|_| "Agent handle registry is unavailable")?
            .remove(session_id);
        if let Some(handle) = handle {
            let result = async {
                handle.entry().stop_admission()?;
                self.subagents.cancel_descendants(session_id).await?;
                self.tools.cancel_session(&handle.entry())?;
                self.tools.await_pending_executions(&handle.entry()).await?;
                handle.dispose().await
            }
            .await;
            if let Err(error) = result {
                if self.agents.get(session_id)?.is_some() {
                    self.handles
                        .lock()
                        .map_err(|_| "Agent handle registry is unavailable")?
                        .insert(session_id.to_string(), handle);
                }
                return Err(error);
            }
        } else if self.agents.get(session_id)?.is_some() {
            return Err("Agent Session is already stopping".into());
        }
        self.sessions.resume(session_id)
    }

    async fn stop_session(
        &self,
        session_id: &str,
        terminate: bool,
    ) -> Result<AgentSessionSnapshot, String> {
        if let Some(entry) = self.agents.get(session_id)? {
            entry.stop_admission()?;
        }
        self.models.images.cancel_session(session_id)?;
        self.subagents.cancel_descendants(session_id).await?;
        let handle = self
            .handles
            .lock()
            .map_err(|_| "Agent handle registry is unavailable".to_string())?
            .remove(session_id);
        if let Some(handle) = handle {
            let result = async {
                handle.entry().stop_admission()?;
                self.tools.cancel_session(&handle.entry())?;
                self.tools.await_pending_executions(&handle.entry()).await?;
                if terminate {
                    handle.dispose().await
                } else {
                    handle.interrupt().await
                }
            }
            .await;
            match result {
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
        let _gate = self
            .tools
            .question_gate
            .lock()
            .map_err(|_| "question gate unavailable")?;
        self.tools.cancel_questions(session_id)?;
        if self.sessions.snapshot(session_id)?.ended {
            self.sessions.snapshot(session_id)
        } else if terminate {
            self.sessions.cancel(session_id)
        } else {
            self.sessions.interrupt(session_id)
        }
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
                if !self.sessions.has_ready_input(session_id)?
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
        let entry = self.agents.get(session_id)?;
        let lease = if let Some(entry) = &entry {
            if !entry.try_acquire_archive() {
                return Err("AGENT_SESSION_ARCHIVE_BUSY".into());
            }
            Some(ActiveDriverLease(Arc::clone(entry)))
        } else {
            None
        };
        let result = (|| {
            if let Some(entry) = &entry {
                if !self.sessions.snapshot(session_id)?.ended
                    && (entry.phase()? != AgentLifecyclePhase::Idle || entry.scope()?.is_some())
                {
                    return Err("AGENT_SESSION_ARCHIVE_BUSY".into());
                }
            }
            let archived = self.sessions.archive(session_id)?;
            if let Some(entry) = entry {
                entry.stop_admission()?;
                entry.set_phase(AgentLifecyclePhase::Disposed)?;
                self.agents.detach(session_id)?;
                self.handles
                    .lock()
                    .map_err(|_| "Agent handle registry is unavailable".to_string())?
                    .remove(session_id);
            }
            Ok(archived)
        })();
        drop(lease);
        if result.is_err()
            && self.sessions.snapshot(session_id).is_ok_and(|snapshot| {
                !snapshot.ended
                    && (snapshot.status == super::AgentSessionStatus::Running
                        || !snapshot.inbox.next_turn.is_empty()
                        || !snapshot.inbox.next_step.is_empty())
            })
        {
            // A message may have committed while archive reserved the worker
            // slot. Its first wake was blocked; retry after releasing the slot.
            let _ = self.wake(session_id);
        }
        result
    }

    pub(crate) fn delete_session(&self, session_id: &str) -> Result<(), String> {
        self.sessions.delete_archived(session_id)
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
        if checkpoint.turn_id.is_none() || checkpoint.step_id.is_none() {
            return Err("recovery checkpoint lost its tool scope".into());
        }
        let events = self.sessions.all_events(&input.session_id)?;
        let (turn_id, step_id, name) = events
            .iter()
            .filter(|event| {
                event.turn_id == checkpoint.turn_id && event.step_id == checkpoint.step_id
            })
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
        if !events.iter().any(|event| {
            event.turn_id == turn_id
                && event.step_id == step_id
                && matches!(
                    event.payload,
                    super::AgentSessionEventPayload::StepEnd { .. }
                )
        }) {
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
        if entry.scope()?.is_none() && !self.sessions.has_ready_input(session_id)? {
            return Ok(());
        }
        if !entry.try_acquire_driver()? {
            return Ok(());
        }
        let sessions = self.sessions.clone();
        let hooks = self.hooks.clone();
        let tools = self.tools.clone();
        let compactions = self.compactions.clone();
        let config = self.driver_config;
        tauri::async_runtime::spawn(async move {
            let mut lease = Some(ActiveDriverLease(Arc::clone(&entry)));
            loop {
                let settlement = drive_agent(
                    sessions.clone(),
                    Arc::clone(&entry),
                    hooks.clone(),
                    tools.clone(),
                    compactions.clone(),
                    config,
                )
                .await;
                #[cfg(test)]
                if settlement == AgentDriverSettlement::Waiting {
                    let pause = tools.question_lease_pause.lock().unwrap().take();
                    if let Some((entered, release)) = pause {
                        entered.notify_one();
                        release.notified().await;
                    }
                }
                if settlement == AgentDriverSettlement::Waiting {
                    // Keep the current lease if an answer already committed. Otherwise
                    // publish idle while holding the same gate used by answer/cancel,
                    // so no accepted answer can fall into a release/reacquire gap.
                    let resume = {
                        let Ok(_gate) = tools.question_gate.lock() else {
                            break;
                        };
                        if entry.phase().ok() == Some(super::AgentLifecyclePhase::Running)
                            && !entry.cancellation().is_cancelled()
                        {
                            true
                        } else {
                            drop(lease.take());
                            false
                        }
                    };
                    if resume {
                        continue;
                    }
                    match tools.wait_for_expiry(&entry).await {
                        Ok(true) if !entry.cancellation().is_cancelled() => {
                            if entry.try_acquire_driver().unwrap_or(false) {
                                lease = Some(ActiveDriverLease(Arc::clone(&entry)));
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
                drop(lease.take());
                if settlement != AgentDriverSettlement::Idle || entry.cancellation().is_cancelled()
                {
                    break;
                }
                let has_work = sessions.has_ready_input(&entry.session_id).unwrap_or(false);
                if !has_work || !entry.try_acquire_driver().unwrap_or(false) {
                    break;
                }
                lease = Some(ActiveDriverLease(Arc::clone(&entry)));
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
    include!("tests/runtime/mod.rs");
}
