mod continuation_tests {
    include!("continuation.rs");
}
mod archive_tests {
    include!("archive.rs");
}
mod response_tests {
    include!("response.rs");
}
mod inbox_steer_tests {
    include!("inbox_steer.rs");
}
mod loop_guard_tests {
    include!("loop_guard.rs");
}
mod image_tests {
    include!("images.rs");
}
mod image_bridge_tests {
    include!("image_bridge.rs");
}
mod file_reference_tests {
    include!("file_references.rs");
}
mod skill_tests {
    include!("skills.rs");
}
mod skill_bridge_tests {
    include!("skill_bridge.rs");
}
mod question_tests {
    include!("questions.rs");
}
include!("scheduler.rs");
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;

use async_trait::async_trait;
use serde_json::json;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use crate::ai::AiProviderKind;

use super::*;
use crate::agent_runtime::{
    AgentAfterToolContext, AgentAfterToolDecision, AgentAfterToolHook, AgentBeforeToolContext,
    AgentBeforeToolDecision, AgentBeforeToolHook, AgentExecutionSurface, AgentFleetControlRequest,
    AgentFleetPlanRequest, AgentFleetTargetRequest, AgentPreStepContext, AgentPreStepDecision,
    AgentRecoveryStatus, AgentSessionEffect, AgentSessionPermissionMode, AgentSessionStatus,
    AgentSessionTarget, AgentSubagentRole, AgentSubagentSpawnRequest, AgentSurfaceMessage,
    AgentTerminalContextSnapshot, AgentToolApprovalStatus, AgentToolFailedHook,
    AgentToolResultStatus, ModelAdapter, ModelContentBlock, ModelFinishReason, ModelMessage,
    ModelRequest, ModelResponse, ModelStreamSink, ModelToolCall, ModelUsage, NativeToolArtifact,
    NativeToolIdempotency, NativeToolPreparation, NativeToolRequest, NativeToolResult,
    NativeToolRuntime, NormalizedModelError, NormalizedModelErrorKind, RecordedToolCall,
    StreamDelta,
};
use crate::agent_runtime::{AgentStopReason, RetryPolicy};

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
        let effect = if matches!(
            request.model_call.name.as_str(),
            "apply_patch" | "write_file"
        ) {
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
        } else if matches!(native_name, "apply_patch" | "write_file") {
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

#[derive(Default)]
struct RedactingTerminalRuntime {
    preparations: AtomicUsize,
}

impl NativeToolRuntime for RedactingTerminalRuntime {
    fn prepare(&self, request: NativeToolRequest) -> Result<NativeToolPreparation, String> {
        self.preparations.fetch_add(1, Ordering::AcqRel);
        Ok(NativeToolPreparation {
            token: format!("ephemeral:{}", request.model_call.call_id),
            call: RecordedToolCall {
                call_id: request.model_call.call_id,
                provider_call_id: request.model_call.provider_call_id,
                name: request.model_call.name.clone(),
                native_name: Some(request.model_call.name.clone()),
                arguments: super::super::model::recorded_tool_arguments(
                    &request.model_call.name,
                    &request.model_call.arguments,
                ),
                title: Some("ephemeral terminal input".into()),
                effect: Some(AgentSessionEffect::StateChange),
                target: Some(request.target),
            },
            requires_approval: true,
            prompt: "Approve ephemeral terminal input?".into(),
            expires_at_unix_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
                .try_into()
                .unwrap_or(u64::MAX)
                .saturating_add(60_000),
            idempotency: NativeToolIdempotency::No,
            parallel: false,
            exclusive: true,
        })
    }

    fn execute(
        &self,
        _token: &str,
        _approved: bool,
        _cancellation: CancellationToken,
    ) -> Result<NativeToolResult, String> {
        Err("ephemeral terminal input must not execute in this test".into())
    }

    fn abandon(&self, _token: &str) {}
}

enum FakeScript {
    Reply {
        chunks: Vec<String>,
        response: ModelResponse,
    },
    Error(NormalizedModelError),
    PartialError {
        deltas: Vec<StreamDelta>,
        error: NormalizedModelError,
    },
    CancelThenReply {
        delta: Option<StreamDelta>,
        response: ModelResponse,
    },
    PartialThenCancelError,
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
    fn replay_codec(&self) -> &'static dyn crate::llm::adapter::ReplayCodec {
        crate::llm::registry::replay_codec("ollama").unwrap()
    }

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
            FakeScript::PartialThenCancelError => {
                sink.emit(StreamDelta::Text {
                    index: 0,
                    text: "cancelled partial".into(),
                })?;
                cancellation.cancel();
                Err(NormalizedModelError::new(
                    NormalizedModelErrorKind::Transport,
                    "ready failure",
                ))
            }
            FakeScript::Reply { chunks, response } => {
                for text in chunks {
                    sink.emit(StreamDelta::Text { index: 0, text })?;
                }
                Ok(response)
            }
            FakeScript::Error(error) => Err(error),
            FakeScript::PartialError { deltas, error } => {
                for delta in deltas {
                    sink.emit(delta)?;
                }
                Err(error)
            }
            FakeScript::CancelThenReply { delta, response } => {
                cancellation.cancel();
                if let Some(delta) = delta {
                    sink.emit(delta)?;
                }
                Ok(response)
            }
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

struct RoutedFakeAdapter {
    inner: Arc<FakeAdapter>,
    codec: &'static dyn crate::llm::adapter::ReplayCodec,
}

#[async_trait]
impl ModelAdapter for RoutedFakeAdapter {
    fn replay_codec(&self) -> &'static dyn crate::llm::adapter::ReplayCodec {
        self.codec
    }

    async fn stream(
        &self,
        request: ModelRequest,
        cancellation: CancellationToken,
        sink: Arc<dyn ModelStreamSink>,
    ) -> Result<ModelResponse, NormalizedModelError> {
        self.inner.stream(request, cancellation, sink).await
    }
}

impl ModelAdapterFactory for FakeFactory {
    fn create(
        &self,
        provider: AiProviderConfig,
        _api_key: Option<String>,
    ) -> Result<Arc<dyn ModelAdapter>, String> {
        let adapter_id = crate::llm::routes::adapter_id(provider.kind);
        let codec = crate::llm::registry::replay_codec(adapter_id)
            .ok_or_else(|| format!("unknown fake replay adapter {adapter_id}"))?;
        Ok(Arc::new(RoutedFakeAdapter {
            inner: self.0.clone(),
            codec,
        }))
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
    let content = (!content.is_empty())
        .then(|| ModelContentBlock::Text {
            text: content.into(),
        })
        .into_iter()
        .collect::<Vec<_>>();
    ModelResponse {
        replay: Some(crate::llm::types::AdapterReplayCapture {
            response: serde_json::json!({}),
            blocks: content.iter().map(|_| serde_json::json!({})).collect(),
        }),
        replay_envelope: None,
        content,
        finish_reason: ModelFinishReason::Stop,
        usage: ModelUsage {
            uncached_input_tokens: Some(10),
            output_tokens: Some(2),
            total_tokens: Some(12),
            ..ModelUsage::default()
        },
    }
}

fn set_tool_calls(response: &mut ModelResponse, calls: Vec<ModelToolCall>) {
    if let Some(replay) = &mut response.replay {
        replay.blocks.extend(calls.iter().map(|call| {
            call.provider_call_id.as_ref().map_or_else(
                || serde_json::json!({}),
                |id| serde_json::json!({"providerCallId": id}),
            )
        }));
    }
    response.content.extend(
        calls
            .into_iter()
            .map(|call| ModelContentBlock::ToolCall { call }),
    );
}

fn reply(content: &str, chunks: &[&str]) -> FakeScript {
    FakeScript::Reply {
        chunks: chunks.iter().map(|chunk| (*chunk).to_string()).collect(),
        response: response(content),
    }
}

fn provider() -> AiProviderConfig {
    AiProviderConfig {
        model_definition: Some(crate::llm::catalog::fixture_definition(
            AiProviderKind::Ollama,
            32768,
        )),
        profile: "ollama".into(),
        retry_policy: None,
        id: "fake".into(),
        kind: AiProviderKind::Ollama,
        base_url: "http://127.0.0.1:11434".into(),
        model: "fake-model".into(),
        reasoning_effort: Some("off".to_string()),
        requires_api_key: false,
        api_key: None,
    }
}

fn configured(adapter: Arc<FakeAdapter>) -> (tempfile::TempDir, AgentRuntime) {
    configured_with(
        adapter,
        AgentDriverConfig {
            retry_policy: RetryPolicy {
                max_attempts: 2,
                initial_delay_ms: 1,
                max_delay_ms: 1,
                max_server_delay_ms: 1,
                jitter_ratio: 0.0,
            },
            ..AgentDriverConfig::default()
        },
    )
}

fn configured_with(
    adapter: Arc<FakeAdapter>,
    config: AgentDriverConfig,
) -> (tempfile::TempDir, AgentRuntime) {
    configured_with_native(adapter, config, Arc::new(FakeNativeRuntime))
}

fn register_test_model(runtime: &AgentRuntime, _root: &std::path::Path, config: &AiProviderConfig) {
    runtime.configure_test_model(config.clone()).unwrap();
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
    register_test_model(&runtime, root.path(), &provider());
    (root, runtime)
}

fn create(runtime: &AgentRuntime, session_id: &str) {
    runtime
        .create_session(CreateAgentSessionRequest {
            session_id: session_id.into(),
            task_id: format!("task-{session_id}"),
            goal: "exercise the Agent Runtime driver".into(),
            parent_session_id: None,
            continued_from_session_id: None,
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
            execution_surface: crate::agent_runtime::AgentExecutionSurface::Direct,
            success_criteria: vec!["command result is recorded".into()],
            capability_scope: None,
            subagent: None,
        })
        .unwrap();
}

#[tokio::test]
async fn bound_terminal_snapshot_reaches_the_first_model_request_with_its_user_turn() {
    let adapter = FakeAdapter::new(vec![reply("The server welcomed you.", &[])]);
    let (_root, runtime) = configured(adapter.clone());
    create(&runtime, "terminal-snapshot");
    let first = AgentTerminalContextSnapshot {
        session_id: "terminal-local".into(),
        version: 1,
        max_lines: 200,
        max_bytes: 32 * 1024,
        content: "Welcome to the server\npassword=hunter2\n$ ".into(),
    };
    let accepted = runtime
        .followup_submission(
            "terminal-snapshot",
            "question".into(),
            "question".into(),
            "What did the server say?".into(),
            Some(first),
        )
        .unwrap();
    let retry = runtime
        .followup_submission(
            "terminal-snapshot",
            "question".into(),
            "question".into(),
            "What did the server say?".into(),
            Some(AgentTerminalContextSnapshot {
                session_id: "terminal-local".into(),
                version: 2,
                max_lines: 200,
                max_bytes: 32 * 1024,
                content: "newer output".into(),
            }),
        )
        .unwrap();
    assert_eq!(accepted.event_count, retry.event_count);

    runtime
        .start("terminal-snapshot", provider(), None)
        .unwrap();
    runtime.await_idle("terminal-snapshot").await.unwrap();
    let requests = adapter.requests.lock().unwrap();
    let first_request = &requests[0];
    let user_text = first_request
        .messages
        .iter()
        .filter_map(|message| match message {
            ModelMessage::User { content } => Some(content.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>();
    let welcome_index = user_text
        .iter()
        .position(|text| text.contains("Welcome to the server"))
        .expect("the first request includes terminal output");
    let question_index = user_text
        .iter()
        .position(|text| text == &"What did the server say?")
        .expect("the first request includes the user question");
    assert!(welcome_index < question_index);
    assert!(!user_text
        .iter()
        .any(|text| text.contains("hunter2") || text.contains("newer output")));
    drop(requests);
    let surface = runtime.session("terminal-snapshot").unwrap().surface;
    assert!(surface.messages.iter().any(|message| matches!(message,
        AgentSurfaceMessage::User { source, content, .. }
            if source.producer_id == "shellspan.terminal-output.v1"
                && content.contains("Welcome to the server")
                && !content.contains("hunter2")
    )));
}

#[test]
fn terminal_snapshot_must_match_the_frozen_target_before_inbox_commit() {
    let (_root, runtime) = configured(FakeAdapter::new(vec![]));
    create(&runtime, "terminal-snapshot-mismatch");
    let error = runtime.followup_submission(
        "terminal-snapshot-mismatch",
        "question".into(),
        "question".into(),
        "Read the banner".into(),
        Some(AgentTerminalContextSnapshot {
            session_id: "other-terminal".into(),
            version: 1,
            max_lines: 200,
            max_bytes: 32 * 1024,
            content: "wrong server".into(),
        }),
    );
    assert_eq!(error.unwrap_err(), "TERMINAL_CONTEXT_TARGET_MISMATCH");
    let oversized = runtime.followup_submission(
        "terminal-snapshot-mismatch",
        "question".into(),
        "question".into(),
        "Read the banner".into(),
        Some(AgentTerminalContextSnapshot {
            session_id: "terminal-local".into(),
            version: 1,
            max_lines: 200,
            max_bytes: 32 * 1024,
            content: "x".repeat(32 * 1024 + 1),
        }),
    );
    assert_eq!(oversized.unwrap_err(), "TERMINAL_CONTEXT_LIMIT");
    assert!(runtime
        .session("terminal-snapshot-mismatch")
        .unwrap()
        .inbox
        .next_turn
        .is_empty());
}

#[tokio::test]
async fn request_snapshots_span_followups_and_restart_at_resume() {
    use super::super::AgentRequestSnapshotReason;
    let adapter = FakeAdapter::new(vec![reply("one", &[]), reply("two", &[])]);
    let (root, runtime) = configured(adapter.clone());
    create(&runtime, "session-snapshots");
    runtime
        .followup("session-snapshots", "message-1".into(), "first".into())
        .unwrap();
    runtime
        .start("session-snapshots", provider(), None)
        .unwrap();
    runtime.await_idle("session-snapshots").await.unwrap();
    runtime
        .followup("session-snapshots", "message-2".into(), "second".into())
        .unwrap();
    runtime.await_idle("session-snapshots").await.unwrap();
    let events = all_events(&runtime, "session-snapshots");
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(
                event.payload,
                AgentSessionEventPayload::RequestHeader { .. }
            ))
            .count(),
        2
    );
    let starts = events
        .iter()
        .filter_map(|event| match &event.payload {
            AgentSessionEventPayload::RequestStart {
                series, attempt, ..
            } => Some((series, attempt)),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(starts.len(), 2);
    assert_eq!(starts[0].0.series_id, starts[1].0.series_id);
    assert_eq!(starts[1].0.request_index, 1);
    assert!(!starts[1].0.starts_series);
    assert_eq!(*starts[1].1, 1);

    let entry = runtime.agents.get("session-snapshots").unwrap().unwrap();
    let last_start = events
        .iter()
        .rposition(|event| matches!(event.payload, AgentSessionEventPayload::RequestStart { .. }))
        .unwrap();
    let checkpoint = super::super::derive_recovery_checkpoint(&events[..=last_start]);
    assert_eq!(
        checkpoint.kind,
        super::super::AgentRecoveryCheckpointKind::OpenModelRequest
    );
    assert_eq!(
        checkpoint.request_id.as_deref(),
        Some(adapter.requests.lock().unwrap()[1].request_id.as_str())
    );
    let request_snapshot = events
        .iter()
        .rev()
        .find_map(|event| match &event.payload {
            AgentSessionEventPayload::RequestHeader { snapshot, .. } => Some(snapshot.clone()),
            _ => None,
        })
        .unwrap();
    let mut changed = adapter.requests.lock().unwrap()[1].clone();
    changed.system_prompt.push_str("\nNew guidance.");
    let changed_events = super::super::request_log::request_events(
        &events,
        &entry,
        &entry.model().unwrap().provider,
        &changed,
        &request_snapshot,
        AgentRequestReason::Initial,
        1,
    );
    assert!(matches!(
        changed_events[0],
        AgentSessionEventPayload::RequestHeader {
            snapshot_reason: AgentRequestSnapshotReason::Change,
            ..
        }
    ));
    changed = adapter.requests.lock().unwrap()[1].clone();
    changed.tools.clear();
    assert!(matches!(
        super::super::request_log::request_events(
            &events,
            &entry,
            &entry.model().unwrap().provider,
            &changed,
            &request_snapshot,
            AgentRequestReason::Initial,
            1,
        )[0],
        AgentSessionEventPayload::RequestHeader {
            snapshot_reason: AgentRequestSnapshotReason::Change,
            ..
        }
    ));
    changed = adapter.requests.lock().unwrap()[1].clone();
    changed.surface_generation += 1;
    assert!(matches!(
        super::super::request_log::request_events(
            &events,
            &entry,
            &entry.model().unwrap().provider,
            &changed,
            &request_snapshot,
            AgentRequestReason::Recovery,
            2,
        )[0],
        AgentSessionEventPayload::RequestHeader {
            snapshot_reason: AgentRequestSnapshotReason::Series,
            series: super::super::AgentRequestSeries {
                request_index: 0,
                starts_series: true,
                ..
            },
            ..
        }
    ));
    drop(entry);
    drop(runtime);

    let resumed_adapter = FakeAdapter::new(vec![reply("three", &[])]);
    let resumed = AgentRuntimeBuilder::new()
        .model_factory(Arc::new(FakeFactory(resumed_adapter.clone())))
        .native_tool_runtime(Arc::new(FakeNativeRuntime))
        .build();
    resumed.configure(root.path().to_path_buf()).unwrap();
    resumed
        .followup("session-snapshots", "message-3".into(), "third".into())
        .unwrap();
    resumed
        .start("session-snapshots", provider(), None)
        .unwrap();
    resumed.await_idle("session-snapshots").await.unwrap();
    let events = all_events(&resumed, "session-snapshots");
    let snapshots = events
        .iter()
        .filter_map(|event| match &event.payload {
            AgentSessionEventPayload::RequestHeader {
                snapshot_reason, ..
            } => Some(*snapshot_reason),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(
        snapshots,
        vec![
            AgentRequestSnapshotReason::Initial,
            AgentRequestSnapshotReason::Change,
            AgentRequestSnapshotReason::Resume
        ]
    );
    let requests = adapter
        .requests
        .lock()
        .unwrap()
        .iter()
        .cloned()
        .chain(resumed_adapter.requests.lock().unwrap().iter().cloned())
        .collect::<Vec<_>>();
    let starts = events
        .iter()
        .filter_map(|event| match &event.payload {
            AgentSessionEventPayload::RequestStart {
                request_id,
                header_request_id,
                ..
            } => Some((request_id, header_request_id)),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(starts.len(), requests.len());
    for ((request_id, header_id), request) in starts.iter().zip(&requests) {
        assert_eq!(**request_id, request.request_id);
        assert!(events.iter().any(|event| matches!(&event.payload,
                AgentSessionEventPayload::RequestHeader { request_id, system_prompt, tool_schemas, .. }
                    if request_id == *header_id && system_prompt == &request.system_prompt && tool_schemas == &request.tools
            )));
    }
}
#[tokio::test]
async fn continuable_child_reuses_the_same_session_and_driver() {
    let adapter = FakeAdapter::new(vec![
        reply("first child answer", &[]),
        reply("second child answer", &[]),
    ]);
    let (_root, runtime) = configured(adapter.clone());
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
    let followup = super::super::AgentChildInputRequest {
        parent_session_id: "parent-1".into(),
        child_session_id: child.header.session_id.clone(),
        content: "continue with a second check".into(),
        client_submission_id: Some("child-ui-followup".into()),
    };
    runtime.send_child_input(followup.clone()).await.unwrap();
    runtime.await_idle(&child.header.session_id).await.unwrap();
    runtime.send_child_input(followup).await.unwrap();
    runtime.await_idle(&child.header.session_id).await.unwrap();

    let events = all_events(&runtime, &child.header.session_id);
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event.payload, AgentSessionEventPayload::TurnStart))
            .count(),
        2
    );
    assert!(events.iter().any(|event| {
        matches!(
            &event.payload,
            AgentSessionEventPayload::InboxSpliced {
                operation: super::super::AgentInboxOperation::Enqueued,
                messages,
                ..
            } if messages.iter().any(|message| {
                message.message_id == "child-ui-followup"
                    && message.client_submission_id.as_deref() == Some("child-ui-followup")
                    && message.source.kind == super::super::AgentMessageSourceKind::User
            })
        )
    }));
    assert!(all_events(&runtime, "parent-1").iter().any(|event| {
            matches!(event.payload, AgentSessionEventPayload::SubagentDescriptor { ref child_session_id, continuable: true, .. } if child_session_id == &child.header.session_id)
        }));
}

#[tokio::test]
async fn one_shot_child_budget_is_forced_to_one_turn() {
    let adapter = FakeAdapter::new(vec![reply("child answer", &[])]);
    let (_root, runtime) = configured(adapter.clone());
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
async fn one_shot_child_with_unfinished_plan_is_not_reported_as_completed() {
    let adapter = FakeAdapter::new(vec![
        tool_response(vec![ModelToolCall {
            call_id: "spawn-child".into(),
            provider_call_id: Some("provider-spawn-child".into()),
            name: "spawn_one_shot_agent".into(),
            arguments: json!({
                "goal": "verify the target",
                "role": "general",
                "inheritanceMode": "blank",
                "targetIds": ["target-local"]
            }),
        }]),
        tool_response(vec![ModelToolCall {
            call_id: "child-plan".into(),
            provider_call_id: Some("provider-child-plan".into()),
            name: "update_plan".into(),
            arguments: json!({
                "planVersion": 1,
                "steps": [{ "id": "verify", "title": "Verify the target", "status": "inProgress" }]
            }),
        }]),
        reply("The target is verified.", &[]),
        reply("Verification is still pending.", &[]),
        reply("The child did not finish verification.", &[]),
    ]);
    let (_root, runtime) = configured(adapter);
    create(&runtime, "parent-incomplete-child");
    runtime
        .followup("parent-incomplete-child", "initial".into(), "verify".into())
        .unwrap();
    runtime
        .start("parent-incomplete-child", provider(), None)
        .unwrap();
    runtime.await_idle("parent-incomplete-child").await.unwrap();
    let events = all_events(&runtime, "parent-incomplete-child");
    let child_id = events
        .iter()
        .find_map(|event| match &event.payload {
            AgentSessionEventPayload::SubagentDescriptor {
                child_session_id, ..
            } => Some(child_session_id.clone()),
            _ => None,
        })
        .expect("one-shot child descriptor");
    assert_eq!(
        runtime.session(&child_id).unwrap().status,
        AgentSessionStatus::Failed
    );
    assert!(all_events(&runtime, &child_id).iter().any(|event| matches!(
        &event.payload,
        AgentSessionEventPayload::SessionEnded { reason: Some(reason), .. }
            if reason == "oneShotPlanIncomplete"
    )));
    assert!(events.iter().any(|event| matches!(
        &event.payload,
        AgentSessionEventPayload::ToolResult { call_id, status: AgentToolResultStatus::Failed, .. }
            if call_id == "spawn-child"
    )));
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
    runtime.sessions.all_events(session_id).unwrap()
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
    set_tool_calls(&mut response, calls);
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
    set_tool_calls(
        &mut tool_response,
        vec![ModelToolCall {
            call_id: "call-1".into(),
            provider_call_id: Some("provider-call-1".into()),
            name: "run_terminal_command".into(),
            arguments: json!({ "command": "pwd", "explanation": "inspect" }),
        }],
    );
    let adapter = FakeAdapter::new(vec![FakeScript::Reply {
        chunks: Vec::new(),
        response: tool_response,
    }]);
    let (_root, runtime) = configured(adapter.clone());
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
    let request = adapter.requests.lock().unwrap()[0].clone();
    let header = events
        .iter()
        .find_map(|event| match &event.payload {
            AgentSessionEventPayload::RequestHeader {
                provider_id,
                model,
                reason,
                series,
                system_prompt,
                tool_schemas,
                ..
            } => Some((
                provider_id,
                model,
                reason,
                series,
                system_prompt,
                tool_schemas,
            )),
            _ => None,
        })
        .unwrap();
    assert_eq!(header.0, "fake");
    assert_eq!(header.1, "fake-model");
    assert_eq!(*header.2, AgentRequestReason::Initial);
    assert!(header.3.starts_series);
    assert_eq!(header.3.request_index, 0);
    assert_eq!(header.4, &request.system_prompt);
    assert_eq!(header.5.len(), request.tools.len());
    for (recorded, sent) in header.5.iter().zip(&request.tools) {
        assert_eq!(recorded.name, sent.name);
        assert_eq!(recorded.description, sent.description);
        assert_eq!(recorded.input_schema, sent.input_schema);
    }
    let context_sources = events
        .iter()
        .filter_map(|event| match &event.payload {
            AgentSessionEventPayload::UserMessage { message }
                if message.source.producer_id.starts_with("shellspan.") =>
            {
                Some(&message.source)
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    assert!(context_sources
        .iter()
        .any(|source| source.producer_id == "shellspan.runtime-context.v1"));
    assert!(context_sources
        .iter()
        .any(|source| source.producer_id == "shellspan.agent-instructions.v1"));
    assert!(context_sources.iter().all(|source| !matches!(
        source.kind,
        crate::agent_runtime::AgentMessageSourceKind::Plugin
            | crate::agent_runtime::AgentMessageSourceKind::SkillCatalog
    )));
    assert!(request.messages.iter().any(|message| matches!(
        message,
        ModelMessage::User { content }
            if content.contains("Current ShellSpan runtime context")
    )));
    assert!(request.messages.iter().any(|message| matches!(
        message,
        ModelMessage::User { content }
            if content.contains("command result is recorded")
    )));
    assert!(events.iter().all(|event| !matches!(
        &event.payload,
        AgentSessionEventPayload::ToolCall { call }
            if call.provider_call_id.is_some()
    )));
    let raw_events = runtime.sessions.all_events("session-tool").unwrap();
    assert!(raw_events.iter().any(|event| matches!(
            &event.payload,
            AgentSessionEventPayload::ToolCall { call }
                if call.provider_call_id.as_deref() == Some("provider-call-1")
    )));
    assert!(!events
        .iter()
        .any(|event| { matches!(event.payload, AgentSessionEventPayload::ToolResult { .. }) }));
}

#[tokio::test]
async fn update_plan_commits_in_primary_session_pipeline_and_checks_unfinished_work() {
    let mut plan_response = response("");
    plan_response.finish_reason = ModelFinishReason::ToolCalls;
    set_tool_calls(
        &mut plan_response,
        vec![ModelToolCall {
            call_id: "call-plan".into(),
            provider_call_id: Some("provider-plan".into()),
            name: "update_plan".into(),
            arguments: json!({
                "explanation": "Plan the bounded work",
                "steps": [{
                    "id": "inspect",
                    "title": "Inspect the target",
                    "status": "inProgress"
                }]
            }),
        }],
    );
    let adapter = FakeAdapter::new(vec![
        FakeScript::Reply {
            chunks: Vec::new(),
            response: plan_response,
        },
        reply("The plan is recorded.", &[]),
        reply("Target inspection remains pending.", &[]),
    ]);
    let (_root, runtime) = configured(adapter.clone());
    create(&runtime, "session-plan");
    runtime
        .followup("session-plan", "message-plan".into(), "make a plan".into())
        .unwrap();
    runtime.start("session-plan", provider(), None).unwrap();
    runtime.await_idle("session-plan").await.unwrap();

    let events = all_events(&runtime, "session-plan");
    assert_eq!(adapter.request_count(), 3);
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(
                event.payload,
                AgentSessionEventPayload::RequestHeader { .. }
            ))
            .count(),
        3
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event.payload, AgentSessionEventPayload::RequestStart { .. }))
            .count(),
        3
    );
    assert!(events.iter().any(|event| matches!(
        &event.payload,
        AgentSessionEventPayload::TaskPlan { version: 1, steps }
            if steps.len() == 1 && steps[0].id == "inspect"
    )));
    assert!(events.iter().any(|event| matches!(
        &event.payload,
        AgentSessionEventPayload::ToolResult {
            call_id,
            status: AgentToolResultStatus::Completed,
            summary,
            data: Some(data),
            ..
        } if call_id == "call-plan"
            && summary.contains("0 pending, 1 in progress, 0 completed")
            && data["planVersion"] == 1
            && data["counts"]["inProgress"] == 1
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
    assert!(events.iter().any(|event| matches!(
        &event.payload,
        AgentSessionEventPayload::TurnEnd { reason } if reason == "incomplete"
    )));
}

#[tokio::test]
async fn repeated_update_plan_without_version_uses_next_version() {
    let plan_reply = |call_id: &str, status: &str| {
        let mut result = response("");
        result.finish_reason = ModelFinishReason::ToolCalls;
        set_tool_calls(
            &mut result,
            vec![ModelToolCall {
                call_id: call_id.into(),
                provider_call_id: None,
                name: "update_plan".into(),
                arguments: json!({
                    "steps": [{ "id": "todo", "title": "Build the app", "status": status }]
                }),
            }],
        );
        result
    };
    let adapter = FakeAdapter::new(vec![
        FakeScript::Reply {
            chunks: Vec::new(),
            response: plan_reply("plan-1", "inProgress"),
        },
        FakeScript::Reply {
            chunks: Vec::new(),
            response: plan_reply("plan-2", "completed"),
        },
        reply("The app is ready.", &[]),
    ]);
    let (_root, runtime) = configured(adapter);
    create(&runtime, "session-plan-versions");
    runtime
        .followup(
            "session-plan-versions",
            "message-plan-versions".into(),
            "build it".into(),
        )
        .unwrap();
    runtime
        .start("session-plan-versions", provider(), None)
        .unwrap();
    runtime.await_idle("session-plan-versions").await.unwrap();

    let events = all_events(&runtime, "session-plan-versions");
    let versions = events
        .iter()
        .filter_map(|event| match &event.payload {
            AgentSessionEventPayload::TaskPlan { version, .. } => Some(*version),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(versions, vec![1, 2]);
    assert!(!events.iter().any(|event| matches!(
        &event.payload,
        AgentSessionEventPayload::ToolResult {
            status: AgentToolResultStatus::Failed,
            ..
        }
    )));
}

#[tokio::test]
async fn invalid_update_plan_is_a_tool_error_and_the_model_retries_in_turn() {
    let mut invalid_plan = response("");
    invalid_plan.finish_reason = ModelFinishReason::ToolCalls;
    set_tool_calls(
        &mut invalid_plan,
        vec![ModelToolCall {
            call_id: "call-invalid-plan".into(),
            provider_call_id: Some("provider-invalid-plan".into()),
            name: "update_plan".into(),
            arguments: json!({
                "planVersion": 1,
                "steps": [{
                    "id": "inspect",
                    "title": "Inspect the target",
                    "status": "inProgress",
                    "evidenceRefs": ["terminal pwd/ls/node -v"]
                }]
            }),
        }],
    );
    let mut corrected_plan = response("");
    corrected_plan.finish_reason = ModelFinishReason::ToolCalls;
    set_tool_calls(
        &mut corrected_plan,
        vec![ModelToolCall {
            call_id: "call-corrected-plan".into(),
            provider_call_id: Some("provider-corrected-plan".into()),
            name: "update_plan".into(),
            arguments: json!({
                "planVersion": 1,
                "steps": [{
                    "id": "inspect",
                    "title": "Inspect the target",
                    "status": "inProgress",
                    "evidenceRefs": ["terminal-check"]
                }]
            }),
        }],
    );
    let adapter = FakeAdapter::new(vec![
        FakeScript::Reply {
            chunks: Vec::new(),
            response: invalid_plan,
        },
        FakeScript::Reply {
            chunks: Vec::new(),
            response: corrected_plan,
        },
        reply("The corrected plan is recorded.", &[]),
        reply("Target inspection remains pending.", &[]),
    ]);
    let (_root, runtime) = configured(adapter.clone());
    create(&runtime, "session-invalid-plan");
    runtime
        .followup(
            "session-invalid-plan",
            "message-invalid-plan".into(),
            "make a plan".into(),
        )
        .unwrap();
    runtime
        .start("session-invalid-plan", provider(), None)
        .unwrap();
    runtime.await_idle("session-invalid-plan").await.unwrap();

    let events = all_events(&runtime, "session-invalid-plan");
    assert_eq!(adapter.request_count(), 4);
    assert!(events.iter().any(|event| matches!(
        &event.payload,
        AgentSessionEventPayload::ToolResult {
            call_id,
            status: AgentToolResultStatus::Failed,
            summary,
            ..
        } if call_id == "call-invalid-plan"
            && summary.contains("invalid update_plan arguments: evidenceId")
    )));
    assert!(events.iter().any(|event| matches!(
        &event.payload,
        AgentSessionEventPayload::TaskPlan { version: 1, steps }
            if steps.len() == 1
                && steps[0].evidence_refs == ["terminal-check"]
    )));
    assert!(!events.iter().any(|event| matches!(
        &event.payload,
        AgentSessionEventPayload::TaskState { recovery: Some(recovery), .. }
            if recovery.summary.as_deref().is_some_and(|summary| {
                summary.starts_with("toolSchedulerFailure:")
            })
    )));
    assert_eq!(
        runtime.session("session-invalid-plan").unwrap().status,
        AgentSessionStatus::Idle
    );
}

#[tokio::test]
async fn restart_restores_a_committed_tool_boundary_without_reissuing_the_model_request() {
    let mut tool_response = response("");
    tool_response.finish_reason = ModelFinishReason::ToolCalls;
    set_tool_calls(
        &mut tool_response,
        vec![ModelToolCall {
            call_id: "call-1".into(),
            provider_call_id: Some("provider-call-1".into()),
            name: "run_terminal_command".into(),
            arguments: json!({ "command": "pwd", "explanation": "inspect" }),
        }],
    );
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
    set_tool_calls(
        &mut command,
        vec![ModelToolCall {
            call_id: "call-approved".into(),
            provider_call_id: Some("provider-approved".into()),
            name: "run_terminal_command".into(),
            arguments: json!({ "command": "pwd", "explanation": "inspect" }),
        }],
    );
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
    let dispatched = events
        .iter()
        .position(|event| {
            matches!(
                &event.payload,
                AgentSessionEventPayload::ToolExecution { call_id, .. }
                    if call_id == &decision.call_id
            )
        })
        .unwrap();
    assert!(approved < dispatched);
    assert!(dispatched < result);
    assert!(events.iter().any(|event| matches!(
        &event.payload,
        AgentSessionEventPayload::AssistantMessage { content, .. }
            if assistant_content_text(content) == "The command completed."
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
async fn maximum_write_file_arguments_fit_the_durable_event_boundary() {
    let native = RecordingNativeRuntime::new(false);
    let call = ModelToolCall {
        call_id: "call-write-max".into(),
        provider_call_id: Some("provider-write-max".into()),
        name: "write_file".into(),
        arguments: json!({
            "path": "large.html",
            "content": "\\".repeat(crate::agent_runtime::MAX_WRITE_FILE_CONTENT_BYTES),
            "precondition": { "mustNotExist": true }
        }),
    };
    let adapter = FakeAdapter::new(vec![
        tool_response(vec![call]),
        reply("The bounded file write completed.", &[]),
    ]);
    let (_root, runtime) = configured_with_native(adapter, AgentDriverConfig::default(), native);
    create(&runtime, "session-write-max");
    runtime
        .followup(
            "session-write-max",
            "message-write-max".into(),
            "write a bounded file".into(),
        )
        .unwrap();
    runtime
        .start("session-write-max", provider(), None)
        .unwrap();
    runtime.await_idle("session-write-max").await.unwrap();

    let events = all_events(&runtime, "session-write-max");
    assert!(events.iter().any(|event| matches!(
        &event.payload,
        AgentSessionEventPayload::ToolResult { call_id, status, .. }
            if call_id == "call-write-max" && *status == AgentToolResultStatus::Completed
    )));
    assert!(!events.iter().any(|event| matches!(
        event.payload,
        AgentSessionEventPayload::SessionEnded {
            status: AgentSessionStatus::Failed,
            ..
        }
    )));
}

#[tokio::test]
async fn bound_terminal_result_is_redacted_before_model_context_and_session_persistence() {
    let native = RecordingNativeRuntime::new(false);
    let adapter = FakeAdapter::new(vec![
        tool_response(vec![native_call(
            "call-visible-secret",
            "run_terminal_command",
        )]),
        reply("The visible command completed safely.", &[]),
    ]);
    let (root, runtime) =
        configured_with_native(adapter.clone(), AgentDriverConfig::default(), native);
    runtime
        .create_session(CreateAgentSessionRequest {
            session_id: "session-visible-secret".into(),
            task_id: "task-visible-secret".into(),
            goal: "exercise bound terminal redaction boundaries".into(),
            parent_session_id: None,
            continued_from_session_id: None,
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
            execution_surface: AgentExecutionSurface::BoundTerminal,
            success_criteria: vec!["no plaintext secret crosses the Rust boundary".into()],
            capability_scope: None,
            subagent: None,
        })
        .unwrap();
    runtime
        .followup(
            "session-visible-secret",
            "message-visible-secret".into(),
            "run the fixture command".into(),
        )
        .unwrap();
    runtime
        .start("session-visible-secret", provider(), None)
        .unwrap();
    runtime.await_idle("session-visible-secret").await.unwrap();

    assert_eq!(adapter.request_count(), 2);
    let model_context = serde_json::to_string(&adapter.requests.lock().unwrap()[1]).unwrap();
    assert!(model_context.contains("[REDACTED]"));
    assert!(!model_context.contains("top-secret-native-value"));

    let events = serde_json::to_string(
        &runtime
            .sessions
            .all_events("session-visible-secret")
            .unwrap(),
    )
    .unwrap();
    assert!(events.contains("[REDACTED]"));
    assert!(!events.contains("top-secret-native-value"));
    let persisted = std::fs::read_to_string(
        root.path()
            .join("agent-runtime")
            .join("sessions-v5")
            .join("session-visible-secret.jsonl"),
    )
    .unwrap();
    assert!(persisted.contains("[REDACTED]"));
    assert!(!persisted.contains("top-secret-native-value"));
}

#[tokio::test]
async fn default_step_budget_allows_long_tool_turns_with_and_without_approvals() {
    for requires_approval in [false, true] {
        let native = RecordingNativeRuntime::new(requires_approval);
        let mut scripts = (0..9)
            .map(|index| {
                tool_response(vec![native_call(
                    &format!("call-{index}"),
                    "list_directory",
                )])
            })
            .collect::<Vec<_>>();
        scripts.push(reply("All nine tools completed.", &[]));
        let adapter = FakeAdapter::new(scripts);
        let (_root, runtime) = configured_with_native(
            adapter.clone(),
            AgentDriverConfig::default(),
            native.clone(),
        );
        let session_id = "session-long-tool-turn";
        create(&runtime, session_id);
        runtime
            .followup(
                session_id,
                "message-long-turn".into(),
                "inspect nine times".into(),
            )
            .unwrap();
        runtime.start(session_id, provider(), None).unwrap();
        runtime.await_idle(session_id).await.unwrap();

        if requires_approval {
            for index in 0..9 {
                let approval = pending_approval(&runtime, session_id);
                assert_eq!(approval.call_id, format!("call-{index}"));
                runtime.approve_tool(approval).await.unwrap();
                runtime.await_idle(session_id).await.unwrap();
            }
        }

        assert_eq!(native.executions.load(Ordering::Acquire), 9);
        assert_eq!(adapter.request_count(), 10);
        let types = event_types(&runtime, session_id);
        assert_eq!(types.iter().filter(|kind| *kind == "turn/start").count(), 1);
        assert_eq!(
            types.iter().filter(|kind| *kind == "step/start").count(),
            10
        );
        assert_eq!(types.iter().filter(|kind| *kind == "turn/end").count(), 1);
        let snapshot = runtime.session(session_id).unwrap();
        assert_eq!(snapshot.status, AgentSessionStatus::Idle);
        assert!(!snapshot.ended);
    }
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
    scheduler_tests::verify_write_barrier().await;
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

    // Exact overlap is proved by verify_write_barrier's controlled gates.
    // This short, ungated execution only promises the upper bound.
    assert!(native.max_active.load(Ordering::Acquire) <= 2);
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
                && runtime.session("session-expired").unwrap().status == AgentSessionStatus::Idle
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
            .filter(|event| matches!(event.payload, AgentSessionEventPayload::ToolResult { .. }))
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
async fn recovery_reconciliation_uses_the_checkpoint_step_when_provider_call_ids_repeat() {
    use super::super::AgentRecoveryReconcileOutcome::{ConfirmedApplied, ConfirmedNotApplied};

    for outcome in [ConfirmedApplied, ConfirmedNotApplied] {
        let session_id = "session-repeated-recovery";
        let native = RecordingNativeRuntime::new(true);
        let adapter = FakeAdapter::new(vec![
            tool_response(vec![native_call("call-1", "list_directory")]),
            tool_response(vec![native_call("call-1", "apply_patch")]),
        ]);
        let (root, first) =
            configured_with_native(adapter, AgentDriverConfig::default(), native.clone());
        create(&first, session_id);
        first
            .followup(session_id, "input".into(), "inspect then update".into())
            .unwrap();
        first.start(session_id, provider(), None).unwrap();
        first.await_idle(session_id).await.unwrap();
        let previous = pending_approval(&first, session_id);
        first.approve_tool(previous.clone()).await.unwrap();
        first.await_idle(session_id).await.unwrap();
        assert_eq!(native.executions.load(Ordering::Acquire), 1);
        let decision = pending_approval(&first, session_id);
        // The provider repeats call-1, but durable call ids are unique across requests.
        assert_ne!(previous.call_id, decision.call_id);
        assert_ne!(previous.step_id, decision.step_id);
        let previous_result = all_events(&first, session_id)
            .into_iter()
            .find(|event| {
                event.step_id.as_ref() == Some(&previous.step_id)
                    && matches!(event.payload, AgentSessionEventPayload::ToolResult { .. })
            })
            .unwrap();
        first
            .append_for_driver(
                session_id,
                Some(decision.turn_id.clone()),
                Some(decision.step_id.clone()),
                AgentSessionEventPayload::ToolApproval {
                    request_id: decision.request_id,
                    call_id: decision.call_id.clone(),
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
                session_id,
                Some(decision.turn_id.clone()),
                Some(decision.step_id.clone()),
                AgentSessionEventPayload::ToolExecution {
                    call_id: decision.call_id.clone(),
                    status: crate::agent_runtime::AgentToolExecutionStatus::Dispatched,
                    idempotency: "no".into(),
                },
            )
            .unwrap();
        drop(first);

        let restarted_native = RecordingNativeRuntime::new(true);
        let restarted = AgentRuntimeBuilder::new()
            .model_factory(Arc::new(FakeFactory(FakeAdapter::new(vec![reply(
                "recovered",
                &[],
            )]))))
            .native_tool_runtime(restarted_native.clone())
            .build();
        restarted.configure(root.path().to_path_buf()).unwrap();
        let waiting = restarted.start(session_id, provider(), None).unwrap();
        assert_eq!(
            waiting.recovery.step_id.as_ref(),
            Some(&decision.step_id),
            "unexpected checkpoint: {:?}",
            waiting.recovery
        );
        restarted
            .reconcile_recovery(crate::agent_runtime::AgentRecoveryReconcileInput {
                session_id: session_id.into(),
                outcome,
                evidence: "Operator checked the frozen target.".into(),
            })
            .unwrap();
        restarted.await_idle(session_id).await.unwrap();

        let results = all_events(&restarted, session_id)
            .into_iter()
            .filter(|event| matches!(event.payload, AgentSessionEventPayload::ToolResult { .. }))
            .collect::<Vec<_>>();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0], previous_result);
        assert_eq!(results[1].turn_id.as_ref(), Some(&decision.turn_id));
        assert_eq!(results[1].step_id.as_ref(), Some(&decision.step_id));
        let expected_status = if outcome == ConfirmedApplied {
            AgentToolResultStatus::Completed
        } else {
            AgentToolResultStatus::Cancelled
        };
        assert!(matches!(&results[1].payload,
            AgentSessionEventPayload::ToolResult { call_id, name, status, .. }
                if call_id == &decision.call_id && name == "apply_patch" && *status == expected_status
        ));
        assert_eq!(restarted_native.executions.load(Ordering::Acquire), 0);
        assert_eq!(
            all_events(&restarted, session_id)
                .iter()
                .filter(|event| {
                    event.step_id.as_ref() == Some(&decision.step_id)
                        && matches!(event.payload, AgentSessionEventPayload::StepEnd { .. })
                })
                .count(),
            1
        );
    }
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
async fn restart_cancels_pending_ephemeral_terminal_input_without_repreparing_it() {
    let call = ModelToolCall {
        call_id: "call-ephemeral".into(),
        provider_call_id: Some("provider-ephemeral".into()),
        name: "write_terminal_input".into(),
        arguments: json!({
            "inputKind": "paste",
            "text": "private-terminal-input",
        }),
    };
    let first_native = Arc::new(RedactingTerminalRuntime::default());
    let first_adapter = FakeAdapter::new(vec![tool_response(vec![call])]);
    let (root, first) = configured_with_native(
        first_adapter,
        AgentDriverConfig::default(),
        first_native.clone(),
    );
    let session_id = "session-ephemeral-restart";
    create(&first, session_id);
    first
        .followup(session_id, "message-ephemeral".into(), "interact".into())
        .unwrap();
    first.start(session_id, provider(), None).unwrap();
    first.await_idle(session_id).await.unwrap();
    assert_eq!(first_native.preparations.load(Ordering::Acquire), 1);
    let decision = pending_approval(&first, session_id);
    assert_eq!(
        first.pending_approval_arguments(&decision).unwrap(),
        Some(json!({
            "inputKind": "paste",
            "text": "private-terminal-input",
        }))
    );
    let mut stale_decision = decision.clone();
    stale_decision.approval_id = "stale-approval".into();
    assert!(first
        .pending_approval_arguments(&stale_decision)
        .unwrap_err()
        .contains("stale"));
    assert!(serde_json::to_string(&all_events(&first, session_id))
        .unwrap()
        .contains("contentPersisted"));
    assert!(!serde_json::to_string(&all_events(&first, session_id))
        .unwrap()
        .contains("private-terminal-input"));
    drop(first);

    let restarted_native = Arc::new(RedactingTerminalRuntime::default());
    let restarted_adapter = FakeAdapter::new(vec![reply("continued safely", &[])]);
    let restarted = AgentRuntimeBuilder::new()
        .model_factory(Arc::new(FakeFactory(restarted_adapter)))
        .native_tool_runtime(restarted_native.clone())
        .build();
    restarted.configure(root.path().to_path_buf()).unwrap();
    restarted.start(session_id, provider(), None).unwrap();
    restarted.await_idle(session_id).await.unwrap();

    assert_eq!(restarted_native.preparations.load(Ordering::Acquire), 0);
    let events = all_events(&restarted, session_id);
    assert!(events.iter().any(|event| matches!(
        &event.payload,
        AgentSessionEventPayload::ToolApproval {
            call_id,
            status: AgentToolApprovalStatus::Cancelled,
            reason: Some(reason),
            ..
        } if call_id == "call-ephemeral"
            && reason == "ephemeralArgumentsUnavailableAfterRestart"
    )));
    assert!(events.iter().any(|event| matches!(
        &event.payload,
        AgentSessionEventPayload::ToolResult {
            call_id,
            status: AgentToolResultStatus::Cancelled,
            ..
        } if call_id == "call-ephemeral"
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
        1
    );
    assert_eq!(
        types.iter().filter(|kind| *kind == "request/retry").count(),
        1
    );
    let headers = all_events(&runtime, "session-retry")
        .into_iter()
        .filter_map(|event| match event.payload {
            AgentSessionEventPayload::RequestStart { reason, series, .. } => Some((reason, series)),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(headers.len(), 2);
    assert_eq!(headers[0].0, AgentRequestReason::Initial);
    assert_eq!(headers[1].0, AgentRequestReason::Retry);
    assert_eq!(headers[0].1.series_id, headers[1].1.series_id);
    assert!(headers[0].1.starts_series);
    assert!(!headers[1].1.starts_series);
    assert_eq!(headers[1].1.request_index, 1);
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
async fn retry_exhaustion_preserves_attempt_wait_and_server_hint_diagnostics() {
    let mut limited = NormalizedModelError::new(
        NormalizedModelErrorKind::RateLimited,
        "provider rate limited the request",
    );
    limited.status = Some(429);
    limited.code = Some("HTTP_429".into());
    limited.retry_after_ms = Some(50);
    let adapter = FakeAdapter::new(vec![
        FakeScript::Error(limited.clone()),
        FakeScript::Error(limited),
    ]);
    let (_root, runtime) = configured(adapter.clone());
    create(&runtime, "session-retry-exhausted");
    runtime
        .followup(
            "session-retry-exhausted",
            "message-retry-exhausted".into(),
            "retry".into(),
        )
        .unwrap();
    runtime
        .start("session-retry-exhausted", provider(), None)
        .unwrap();
    runtime.await_idle("session-retry-exhausted").await.unwrap();
    assert_eq!(adapter.request_count(), 2);
    let events = all_events(&runtime, "session-retry-exhausted");
    assert!(events.iter().any(|event| matches!(
        &event.payload,
        AgentSessionEventPayload::RequestRetry {
            attempt: 2,
            delay_ms: Some(1),
            cumulative_delay_ms: Some(1),
            server_retry_after_ms: Some(50),
            server_hint_capped: true,
            error_status: Some(429),
            error_code: Some(code),
            ..
        } if code == "HTTP_429"
    )));
    assert!(events.iter().any(|event| matches!(
        &event.payload,
        AgentSessionEventPayload::RequestFailure {
            attempt: 2,
            max_attempts: 2,
            cumulative_delay_ms: 1,
            interrupted: false,
            failure,
            ..
        } if failure.status == Some(429)
            && failure.code.as_deref() == Some("HTTP_429")
            && failure.retry_after_ms == Some(50)
    )));
    assert!(events.iter().any(|event| matches!(
        &event.payload,
        AgentSessionEventPayload::SessionEnded { reason: Some(reason), .. }
            if reason.contains("attempt=2")
                && reason.contains("maxAttempts=2")
                && reason.contains("cumulativeDelayMs=1")
                && reason.contains("code=HTTP_429")
    )));
}

#[tokio::test]
async fn cancelling_retry_backoff_prevents_a_new_attempt_and_empty_message() {
    let mut retry_after =
        NormalizedModelError::new(NormalizedModelErrorKind::Transport, "connection reset");
    retry_after.retry_after_ms = Some(30_000);
    let adapter = FakeAdapter::new(vec![FakeScript::PartialError {
        deltas: vec![StreamDelta::Text {
            index: 0,
            text: "failed draft before backoff".into(),
        }],
        error: retry_after,
    }]);
    let (_root, runtime) = configured_with(
        adapter.clone(),
        AgentDriverConfig {
            retry_policy: RetryPolicy {
                max_attempts: 3,
                initial_delay_ms: 30_000,
                max_delay_ms: 30_000,
                max_server_delay_ms: 30_000,
                jitter_ratio: 0.0,
            },
            ..AgentDriverConfig::default()
        },
    );
    create(&runtime, "session-cancel-backoff");
    let backoff_started = Arc::new(Notify::new());
    let backoff_signal = backoff_started.clone();
    runtime
        .sessions
        .set_publisher(Arc::new(move |event| {
            if matches!(event.payload, AgentSessionEventPayload::RequestRetry { .. }) {
                backoff_signal.notify_one();
            }
        }))
        .unwrap();
    runtime
        .followup(
            "session-cancel-backoff",
            "message-cancel-backoff".into(),
            "retry".into(),
        )
        .unwrap();
    runtime
        .start("session-cancel-backoff", provider(), None)
        .unwrap();
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        backoff_started.notified(),
    )
    .await
    .unwrap();
    runtime.cancel("session-cancel-backoff").await.unwrap();
    assert_eq!(adapter.request_count(), 1);
    assert!(!all_events(&runtime, "session-cancel-backoff")
        .iter()
        .any(|event| matches!(
            event.payload,
            AgentSessionEventPayload::AssistantMessage { .. }
        )));
}

#[tokio::test]
async fn cancellation_rejects_a_ready_chunk_and_a_ready_success_response() {
    for emit_delta in [false, true] {
        let adapter = FakeAdapter::new(vec![FakeScript::CancelThenReply {
            delta: emit_delta.then(|| StreamDelta::Text {
                index: 0,
                text: "late output".into(),
            }),
            response: response("late output"),
        }]);
        let session_id = format!("session-ready-cancel-{emit_delta}");
        let (_root, runtime) = configured(adapter.clone());
        create(&runtime, &session_id);
        runtime
            .followup(&session_id, format!("message-{emit_delta}"), "go".into())
            .unwrap();
        runtime.start(&session_id, provider(), None).unwrap();
        runtime.await_idle(&session_id).await.unwrap();
        assert_eq!(adapter.request_count(), 1);
        assert!(!all_events(&runtime, &session_id)
            .iter()
            .any(|event| matches!(
                event.payload,
                AgentSessionEventPayload::AssistantChunk { .. }
                    | AgentSessionEventPayload::AssistantMessage { .. }
                    | AgentSessionEventPayload::RequestRetry { .. }
            )));
    }
}

#[tokio::test]
async fn partial_text_reasoning_and_tool_call_streams_recover_in_the_same_step() {
    let cases = [
        (
            "text",
            StreamDelta::Text {
                index: 0,
                text: "partial once".into(),
            },
        ),
        (
            "reasoning",
            StreamDelta::Reasoning {
                index: 0,
                text: "failed reasoning".into(),
            },
        ),
        (
            "tool",
            StreamDelta::ToolCall {
                index: 0,
                call_id: Some("call-partial".into()),
                name_delta: Some("read_file".into()),
                arguments_delta: Some("{\"path\":".into()),
            },
        ),
    ];
    for (label, delta) in cases {
        let mut error = NormalizedModelError::new(
            NormalizedModelErrorKind::Transport,
            "stream connection closed",
        );
        error.code = Some("STREAM_READ".into());
        let adapter = FakeAdapter::new(vec![
            FakeScript::PartialError {
                deltas: vec![delta],
                error,
            },
            reply("recovered answer", &["recovered answer"]),
        ]);
        let session_id = format!("session-partial-{label}");
        let (_root, runtime) = configured(adapter.clone());
        create(&runtime, &session_id);
        runtime
            .followup(&session_id, format!("message-{label}"), "go".into())
            .unwrap();
        runtime.start(&session_id, provider(), None).unwrap();
        runtime.await_idle(&session_id).await.unwrap();
        assert_eq!(adapter.request_count(), 2);
        let requests = adapter.requests.lock().unwrap();
        assert_ne!(requests[0].request_id, requests[1].request_id);
        assert_eq!(requests[0].messages, requests[1].messages);
        drop(requests);
        let events = all_events(&runtime, &session_id);
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(
                    event.payload,
                    AgentSessionEventPayload::AssistantChunk { .. }
                ))
                .count(),
            2
        );
        assert!(events.iter().any(|event| matches!(
            &event.payload,
            AgentSessionEventPayload::AssistantMessage {
                interrupted: false,
                stop_reason: AgentStopReason::Stop,
                ..
            }
        )));
        assert!(events
            .iter()
            .any(|event| matches!(event.payload, AgentSessionEventPayload::RequestRetry { .. })));
        assert!(events.iter().any(|event| matches!(
            event.payload,
            AgentSessionEventPayload::RequestFailure {
                attempt: 1,
                interrupted: true,
                ..
            }
        )));
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event.payload, AgentSessionEventPayload::StepStart))
                .count(),
            1
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(
                    event.payload,
                    AgentSessionEventPayload::AssistantMessage { .. }
                ))
                .count(),
            1
        );
        assert!(!events.iter().any(|event| matches!(
            event.payload,
            AgentSessionEventPayload::ToolExecution { .. }
                | AgentSessionEventPayload::ToolCall { .. }
        )));
        assert_eq!(
            runtime.session(&session_id).unwrap().status,
            AgentSessionStatus::Idle
        );
    }
}

fn instant_policy(max_attempts: u32) -> RetryPolicy {
    RetryPolicy {
        max_attempts,
        initial_delay_ms: 0,
        max_delay_ms: 0,
        max_server_delay_ms: 0,
        jitter_ratio: 0.0,
    }
}

#[tokio::test]
async fn real_http_partial_sse_then_503_then_success_retains_audit_and_clean_history() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    for (delta, finish_reason) in [
        (
            json!({"content":"failed wire text"}),
            serde_json::Value::Null,
        ),
        (
            json!({"reasoning_content":"failed wire reasoning"}),
            serde_json::Value::Null,
        ),
        (
            json!({"tool_calls":[{"index":0,"id":"incomplete","function":{"name":"apply_patch","arguments":"{\"patch\":"}}]}),
            serde_json::Value::Null,
        ),
        (
            json!({"content":"choice finished before broken transport"}),
            json!("stop"),
        ),
        (
            json!({"tool_calls":[{"index":0,"id":"uncommitted-complete-call","function":{"name":"apply_patch","arguments":"{\"patch\":\"*** Begin Patch\\n*** End Patch\"}"}}]}),
            json!("tool_calls"),
        ),
    ] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let bodies = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
        let captured = bodies.clone();
        let server = tokio::spawn(async move {
            for attempt in 1..=3 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = Vec::new();
                let mut buffer = [0u8; 8192];
                let (end, length) = loop {
                    let n = socket.read(&mut buffer).await.unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&buffer[..n]);
                    if let Some(end) = bytes
                        .windows(4)
                        .position(|part| part == b"\r\n\r\n")
                        .map(|i| i + 4)
                    {
                        let headers = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
                        let length = headers
                            .lines()
                            .find_map(|line| line.strip_prefix("content-length: "))
                            .unwrap()
                            .parse::<usize>()
                            .unwrap();
                        break (end, length);
                    }
                };
                while bytes.len() < end + length {
                    let n = socket.read(&mut buffer).await.unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&buffer[..n]);
                }
                captured
                    .lock()
                    .unwrap()
                    .push(serde_json::from_slice(&bytes[end..end + length]).unwrap());
                let (status, body, truncated) = match attempt {
                        1 => ("200 OK", format!("data: {}\n\n", json!({"choices":[{"delta":delta,"finish_reason":finish_reason}]})), true),
                        2 => ("503 Service Unavailable", "{\"error\":{\"message\":\"temporary\"}}".into(), false),
                        _ => ("200 OK", "data: {\"choices\":[{\"delta\":{\"content\":\"wire recovered\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n".into(), false),
                    };
                let response = format!("HTTP/1.1 {status}\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nRetry-After: 0\r\nConnection: close\r\n\r\n{body}", body.len() + if truncated { 1000 } else { 0 });
                socket.write_all(response.as_bytes()).await.unwrap();
                socket.shutdown().await.unwrap();
            }
        });
        let root = tempfile::tempdir().unwrap();
        let runtime = AgentRuntimeBuilder::new().build();
        runtime.configure(root.path().to_path_buf()).unwrap();
        create(&runtime, "wire");
        runtime
            .followup("wire", "wire-message".into(), "go".into())
            .unwrap();
        let mut config = provider();
        config.model_definition = None;
        config.kind = AiProviderKind::OpenAiCompatible;
        config.profile = "deepseek".into();
        config.model = "deepseek-flash".into();
        config.reasoning_effort = None;
        config.base_url = url;
        config.retry_policy = Some(instant_policy(3));
        runtime.start("wire", config, None).unwrap();
        tokio::time::timeout(
            std::time::Duration::from_secs(10),
            runtime.await_idle("wire"),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(
            bodies.lock().unwrap().len(),
            3,
            "events: {:?}",
            all_events(&runtime, "wire")
        );
        tokio::time::timeout(std::time::Duration::from_secs(2), server)
            .await
            .unwrap()
            .unwrap();
        let bodies = bodies.lock().unwrap();
        assert_eq!(bodies.len(), 3);
        assert_eq!(bodies[0]["messages"], bodies[1]["messages"]);
        assert_eq!(bodies[1]["messages"], bodies[2]["messages"]);
        let events = all_events(&runtime, "wire");
        assert!(events.iter().any(|event| matches!(
            event.payload,
            AgentSessionEventPayload::RequestFailure {
                attempt: 1,
                interrupted: true,
                ..
            }
        )));
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(
                    event.payload,
                    AgentSessionEventPayload::RequestFailure { .. }
                ))
                .count(),
            2
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(
                    event.payload,
                    AgentSessionEventPayload::AssistantMessage { .. }
                ))
                .count(),
            1
        );
        assert!(!events
            .iter()
            .any(|event| matches!(event.payload, AgentSessionEventPayload::ToolCall { .. })));
        assert_eq!(
            runtime.session("wire").unwrap().status,
            AgentSessionStatus::Idle
        );
    }
}

fn partial_failure(kind: NormalizedModelErrorKind) -> FakeScript {
    FakeScript::PartialError {
        deltas: vec![StreamDelta::Text {
            index: 0,
            text: "uncommitted attempt".into(),
        }],
        error: NormalizedModelError::new(kind, "stream failed"),
    }
}

#[tokio::test]
async fn cancellation_before_retry_decision_wins_over_ready_partial_transport_failure() {
    let adapter = FakeAdapter::new(vec![FakeScript::PartialThenCancelError]);
    let (_root, runtime) = configured(adapter.clone());
    create(&runtime, "cancel-failure");
    runtime
        .followup("cancel-failure", "message".into(), "go".into())
        .unwrap();
    runtime.start("cancel-failure", provider(), None).unwrap();
    runtime.await_idle("cancel-failure").await.unwrap();
    assert_eq!(adapter.request_count(), 1);
    let events = all_events(&runtime, "cancel-failure");
    assert!(!events
        .iter()
        .any(|event| matches!(event.payload, AgentSessionEventPayload::RequestRetry { .. })));
    assert!(events.iter().any(|event| matches!(
        event.payload,
        AgentSessionEventPayload::AssistantMessage {
            interrupted: true,
            stop_reason: AgentStopReason::Cancelled,
            ..
        }
    )));
}

#[tokio::test]
async fn provider_snapshot_survives_config_change_during_partial_retry_backoff() {
    let adapter = FakeAdapter::new(vec![
        partial_failure(NormalizedModelErrorKind::Transport),
        reply("recovered", &[]),
    ]);
    let (_root, runtime) = configured(adapter.clone());
    create(&runtime, "snapshot");
    runtime
        .followup("snapshot", "message".into(), "go".into())
        .unwrap();
    let mut config = provider();
    config.retry_policy = Some(RetryPolicy {
        initial_delay_ms: 30_000,
        max_delay_ms: 30_000,
        ..instant_policy(2)
    });
    runtime.start("snapshot", config.clone(), None).unwrap();
    // A long backoff keeps the retry pending until the changed config is submitted.
    for _ in 0..1000 {
        if event_types(&runtime, "snapshot")
            .iter()
            .any(|kind| kind == "request/retry")
        {
            break;
        }
        tokio::task::yield_now().await;
    }
    config.retry_policy = Some(instant_policy(1));
    assert!(event_types(&runtime, "snapshot")
        .iter()
        .any(|kind| kind == "request/retry"));
    runtime.start("snapshot", config, None).unwrap();
    assert_eq!(
        runtime
            .agents
            .get("snapshot")
            .unwrap()
            .unwrap()
            .model()
            .unwrap()
            .provider
            .retry_policy
            .unwrap()
            .max_attempts,
        2
    );
    runtime.cancel("snapshot").await.unwrap();
    assert_eq!(adapter.request_count(), 1);
}

#[tokio::test]
async fn child_inherits_provider_attempt_budget_and_persisted_descriptor() {
    for limit in [1, 3] {
        let scripts = (0..limit)
            .map(|_| partial_failure(NormalizedModelErrorKind::Transport))
            .collect();
        let adapter = FakeAdapter::new(scripts);
        let (_root, runtime) = configured(adapter.clone());
        create(&runtime, "parent-policy");
        let mut config = provider();
        config.retry_policy = Some(instant_policy(limit));
        config.profile = "ollama".into();
        runtime.start("parent-policy", config, None).unwrap();
        runtime.await_idle("parent-policy").await.unwrap();
        let child = runtime
            .spawn_subagent(AgentSubagentSpawnRequest {
                parent_session_id: "parent-policy".into(),
                goal: "inspect".into(),
                role: AgentSubagentRole::Explorer,
                inheritance_mode: "blank".into(),
                target_ids: vec!["target-local".into()],
                budget: None,
                continuable: true,
            })
            .await
            .unwrap();
        runtime.await_idle(&child.header.session_id).await.unwrap();
        assert_eq!(adapter.request_count(), limit as usize);
        let descriptor = child.header.subagent.as_ref().unwrap();
        assert_eq!(descriptor.provider.route_id, "fake");
    }
}

#[tokio::test]
async fn invalid_provider_policy_is_rejected_before_the_model_factory_or_network() {
    let adapter = FakeAdapter::new(vec![]);
    let (_root, runtime) = configured(adapter.clone());
    create(&runtime, "invalid-policy");
    runtime
        .followup("invalid-policy", "message".into(), "go".into())
        .unwrap();
    for policy in [
        instant_policy(0),
        instant_policy(9),
        RetryPolicy {
            jitter_ratio: f64::NAN,
            ..instant_policy(2)
        },
    ] {
        let mut config = provider();
        config.retry_policy = Some(policy);
        assert!(runtime.start("invalid-policy", config, None).is_err());
    }
    assert_eq!(adapter.request_count(), 0);
    assert!(!event_types(&runtime, "invalid-policy")
        .iter()
        .any(|kind| kind == "request/header"));
}

#[tokio::test]
async fn parent_cancellation_stops_a_childs_partial_retry_backoff() {
    let adapter = FakeAdapter::new(vec![partial_failure(NormalizedModelErrorKind::Transport)]);
    let (_root, runtime) = configured(adapter.clone());
    create(&runtime, "cancel-parent");
    let mut config = provider();
    config.retry_policy = Some(RetryPolicy {
        initial_delay_ms: 30_000,
        max_delay_ms: 30_000,
        ..instant_policy(3)
    });
    runtime.start("cancel-parent", config, None).unwrap();
    runtime.await_idle("cancel-parent").await.unwrap();
    let child = runtime
        .spawn_subagent(AgentSubagentSpawnRequest {
            parent_session_id: "cancel-parent".into(),
            goal: "inspect".into(),
            role: AgentSubagentRole::Explorer,
            inheritance_mode: "blank".into(),
            target_ids: vec!["target-local".into()],
            budget: None,
            continuable: true,
        })
        .await
        .unwrap();
    let id = &child.header.session_id;
    for _ in 0..1000 {
        if event_types(&runtime, id)
            .iter()
            .any(|kind| kind == "request/retry")
        {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert!(event_types(&runtime, id)
        .iter()
        .any(|kind| kind == "request/retry"));
    runtime.cancel("cancel-parent").await.unwrap();
    runtime.await_idle(id).await.unwrap();
    assert_eq!(adapter.request_count(), 1);
    assert_eq!(
        runtime.session(id).unwrap().status,
        AgentSessionStatus::Cancelled
    );
}

#[tokio::test]
async fn provider_attempt_budgets_cover_disabled_last_attempt_exhaustion_and_terminal_errors() {
    for (limit, failures, terminal) in [(1, 1, false), (3, 2, false), (3, 3, false), (8, 1, true)] {
        let success = !terminal && failures < limit;
        let mut scripts = (0..failures)
            .map(|_| {
                partial_failure(if terminal {
                    NormalizedModelErrorKind::Authentication
                } else {
                    NormalizedModelErrorKind::Timeout
                })
            })
            .collect::<Vec<_>>();
        if success {
            scripts.push(reply("success", &["success"]));
        }
        let adapter = FakeAdapter::new(scripts);
        let (_root, runtime) = configured(adapter.clone());
        create(&runtime, "budget");
        runtime
            .followup("budget", "message".into(), "go".into())
            .unwrap();
        let mut config = provider();
        config.retry_policy = Some(instant_policy(limit));
        runtime.start("budget", config, None).unwrap();
        runtime.await_idle("budget").await.unwrap();
        assert_eq!(
            adapter.request_count(),
            (failures + u32::from(success)) as usize
        );
        let events = all_events(&runtime, "budget");
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(
                    event.payload,
                    AgentSessionEventPayload::RequestFailure { .. }
                ))
                .count(),
            failures as usize
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(
                    event.payload,
                    AgentSessionEventPayload::AssistantMessage { .. }
                ))
                .count(),
            usize::from(success)
        );
        assert!(
            !serde_json::to_string(&runtime.session("budget").unwrap().surface)
                .unwrap()
                .contains("uncommitted attempt")
        );
        let requests = adapter.requests.lock().unwrap();
        for request in requests.iter().skip(1) {
            assert_eq!(request.messages, requests[0].messages);
        }
        assert_eq!(
            runtime.session("budget").unwrap().status,
            if success {
                AgentSessionStatus::Idle
            } else {
                AgentSessionStatus::Failed
            }
        );
    }
}

#[tokio::test]
async fn recovery_and_reload_do_not_repeat_a_previous_steps_write_tool() {
    let native = RecordingNativeRuntime::new(false);
    let adapter = FakeAdapter::new(vec![
        tool_response(vec![native_call("write-once", "apply_patch")]),
        partial_failure(NormalizedModelErrorKind::Transport),
        reply("write finished", &["write finished"]),
    ]);
    let (root, runtime) = configured_with_native(
        adapter.clone(),
        AgentDriverConfig::default(),
        native.clone(),
    );
    create(&runtime, "write-retry");
    runtime
        .followup("write-retry", "message".into(), "write".into())
        .unwrap();
    let mut config = provider();
    config.retry_policy = Some(instant_policy(2));
    runtime.start("write-retry", config.clone(), None).unwrap();
    runtime.await_idle("write-retry").await.unwrap();
    assert_eq!(native.executions.load(Ordering::Acquire), 1);
    assert_eq!(adapter.request_count(), 3);
    {
        let requests = adapter.requests.lock().unwrap();
        assert_eq!(requests[1].messages, requests[2].messages);
        assert!(requests[2]
            .messages
            .iter()
            .any(|message| matches!(message, ModelMessage::Tool { .. })));
    }
    let before = runtime.session("write-retry").unwrap();
    let audit = all_events(&runtime, "write-retry");
    let reloaded = AgentRuntimeBuilder::new()
        .model_factory(Arc::new(FakeFactory(adapter.clone())))
        .native_tool_runtime(native.clone())
        .build();
    reloaded.configure(root.path().to_path_buf()).unwrap();
    assert_eq!(
        reloaded.session("write-retry").unwrap().surface,
        before.surface
    );
    reloaded.start("write-retry", config, None).unwrap();
    reloaded.await_idle("write-retry").await.unwrap();
    assert_eq!(native.executions.load(Ordering::Acquire), 1);
    assert_eq!(adapter.request_count(), 3);
    let after = all_events(&reloaded, "write-retry");
    assert_eq!(&after[..audit.len()], audit.as_slice());
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
async fn empty_response_retries_and_step_and_turn_limits_have_explicit_boundaries() {
    let empty = FakeAdapter::new(vec![reply("", &[]), reply("recovered", &["recovered"])]);
    let (_root, runtime) = configured(empty.clone());
    create(&runtime, "session-empty");
    runtime
        .followup("session-empty", "message-empty".into(), "empty".into())
        .unwrap();
    runtime.start("session-empty", provider(), None).unwrap();
    runtime.await_idle("session-empty").await.unwrap();
    assert!(!runtime.session("session-empty").unwrap().ended);
    assert_eq!(empty.request_count(), 2);
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
            AgentSessionEventPayload::RequestRetry { error_code, .. }
                if error_code.as_deref() == Some("EMPTY_RESPONSE")
        )));

    let step_limited = FakeAdapter::new(vec![
        FakeScript::Wait {
            response: Some(response("first")),
        },
        reply("handled after the soft boundary", &[]),
    ]);
    let (_root, runtime) = configured_with(
        step_limited.clone(),
        AgentDriverConfig {
            max_steps_per_turn: Some(1),
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
    assert_eq!(step_limited.request_count(), 2);
    assert_eq!(
        runtime.session("session-step-limit").unwrap().status,
        AgentSessionStatus::Idle
    );
    assert!(!runtime.session("session-step-limit").unwrap().ended);
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
            AgentSessionEventPayload::TurnEnd { reason }
                if reason.starts_with("stepBudgetReached:")
        )));
    assert!(!runtime
        .events(AgentSessionEventsRequest {
            session_id: "session-step-limit".into(),
            cursor: None,
            limit: 128,
        })
        .unwrap()
        .events
        .iter()
        .any(|event| matches!(event.payload, AgentSessionEventPayload::SessionEnded { .. })));

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

#[test]
fn execution_surface_switch_is_durable_and_preserves_queued_input() {
    let (root, runtime) = configured(FakeAdapter::new(vec![]));
    create(&runtime, "surface-switch");
    let changed = runtime
        .set_execution_surface("surface-switch", AgentExecutionSurface::BoundTerminal)
        .unwrap();
    assert_eq!(
        changed.header.execution_surface,
        AgentExecutionSurface::BoundTerminal
    );
    runtime
        .set_execution_surface("surface-switch", AgentExecutionSurface::BoundTerminal)
        .unwrap();
    assert_eq!(
        runtime.session("surface-switch").unwrap().event_count,
        changed.event_count
    );
    assert!(all_events(&runtime, "surface-switch")
        .iter()
        .any(|event| matches!(
            event.payload,
            AgentSessionEventPayload::SessionExecutionSurfaceChanged {
                surface: AgentExecutionSurface::BoundTerminal
            }
        )));

    create(&runtime, "running-surface");
    runtime
        .sessions
        .append(
            "running-surface",
            None,
            None,
            AgentSessionEventPayload::AgentStatus {
                status: AgentSessionStatus::Running,
                reason: None,
            },
        )
        .unwrap();
    assert!(runtime
        .set_execution_surface("running-surface", AgentExecutionSurface::BoundTerminal)
        .unwrap_err()
        .contains("EXECUTION_SURFACE_BUSY"));

    create(&runtime, "queued-surface");
    runtime
        .sessions
        .enqueue(
            "queued-surface",
            AgentInboxLane::NextTurn,
            AgentInboxMessage {
                images: Vec::new(),
                message_id: "queued-input".into(),
                client_submission_id: Some("queued-input".into()),
                content: "later".into(),
                source: AgentMessageSource::user(),
                terminal_context: None,
            },
        )
        .unwrap();
    let queued = runtime
        .set_execution_surface("queued-surface", AgentExecutionSurface::BoundTerminal)
        .unwrap();
    assert_eq!(
        queued.header.execution_surface,
        AgentExecutionSurface::BoundTerminal
    );
    assert_eq!(queued.inbox.next_turn.len(), 1);

    let recovered = AgentRuntime::default();
    recovered.configure(root.path().to_path_buf()).unwrap();
    assert_eq!(
        recovered
            .session("surface-switch")
            .unwrap()
            .header
            .execution_surface,
        AgentExecutionSurface::BoundTerminal
    );
}

#[tokio::test]
async fn execution_surface_switch_waits_for_the_active_driver() {
    let model = FakeAdapter::new(vec![FakeScript::Wait {
        response: Some(response("done")),
    }]);
    let (_root, runtime) = configured(model.clone());
    create(&runtime, "running-switch");
    runtime
        .followup("running-switch", "initial".into(), "inspect".into())
        .unwrap();
    runtime.start("running-switch", provider(), None).unwrap();
    model.started.notified().await;
    assert!(runtime
        .set_execution_surface("running-switch", AgentExecutionSurface::BoundTerminal)
        .unwrap_err()
        .contains("EXECUTION_SURFACE_BUSY"));
    model.release.notify_one();
    runtime.await_idle("running-switch").await.unwrap();
    assert_eq!(
        runtime
            .set_execution_surface("running-switch", AgentExecutionSurface::BoundTerminal)
            .unwrap()
            .header
            .execution_surface,
        AgentExecutionSurface::BoundTerminal
    );
}

#[tokio::test]
async fn session_settings_switch_at_next_request_and_survive_restart() {
    let first = FakeAdapter::new(vec![FakeScript::Wait {
        response: Some(response("first")),
    }]);
    let second = FakeAdapter::new(vec![reply("second", &[])]);
    struct RoutingFactory(Arc<FakeAdapter>, Arc<FakeAdapter>);
    impl ModelAdapterFactory for RoutingFactory {
        fn create(
            &self,
            provider: AiProviderConfig,
            _: Option<String>,
        ) -> Result<Arc<dyn ModelAdapter>, String> {
            Ok(if provider.model == "second-model" {
                self.1.clone()
            } else {
                self.0.clone()
            })
        }
    }
    let root = tempfile::tempdir().unwrap();
    let runtime = AgentRuntimeBuilder::new()
        .model_factory(Arc::new(RoutingFactory(first.clone(), second.clone())))
        .native_tool_runtime(Arc::new(FakeNativeRuntime))
        .build();
    runtime.configure(root.path().to_path_buf()).unwrap();
    create(&runtime, "switch");
    create(&runtime, "other");
    runtime
        .followup("switch", "one".into(), "first".into())
        .unwrap();
    runtime.start("switch", provider(), None).unwrap();
    first.started.notified().await;
    let mut selected = provider();
    selected.model = "second-model".into();
    selected.reasoning_effort = None;
    runtime
        .select_model("switch", selected.clone(), None)
        .unwrap();
    runtime
        .set_permission_mode("switch", AgentSessionPermissionMode::Operator)
        .unwrap();
    let revision = runtime.session("switch").unwrap().event_count;
    runtime.select_model("switch", selected, None).unwrap();
    runtime
        .set_permission_mode("switch", AgentSessionPermissionMode::Operator)
        .unwrap();
    assert_eq!(runtime.session("switch").unwrap().event_count, revision);
    assert_eq!(second.request_count(), 0);
    runtime
        .followup("switch", "two".into(), "next".into())
        .unwrap();
    first.release.notify_one();
    runtime.await_idle("switch").await.unwrap();
    assert_eq!(first.request_count(), 1);
    assert_eq!(second.request_count(), 1);
    assert!(first.requests.lock().unwrap()[0]
        .system_prompt
        .contains("request-approval mode"));
    assert!(second.requests.lock().unwrap()[0]
        .system_prompt
        .contains("operator mode"));
    assert!(second.requests.lock().unwrap()[0]
        .messages
        .iter()
        .any(|message| matches!(message,
            super::super::ModelMessage::User { content } if content.contains("\"operator\""))));
    let models: Vec<_> = all_events(&runtime, "switch")
        .into_iter()
        .filter_map(|event| match event.payload {
            AgentSessionEventPayload::RequestStart { model, .. } => Some(model),
            _ => None,
        })
        .collect();
    assert_eq!(models, ["fake-model", "second-model"]);
    assert_eq!(
        runtime.session("other").unwrap().header.permission_mode,
        Some(AgentSessionPermissionMode::RequestApproval)
    );
    assert!(runtime
        .session("other")
        .unwrap()
        .header
        .model_selection
        .is_none());
    let recovered = AgentRuntime::default();
    recovered.configure(root.path().to_path_buf()).unwrap();
    let header = recovered.session("switch").unwrap().header;
    assert_eq!(header.model_selection.unwrap().model_id, "second-model");
    assert_eq!(
        header.permission_mode,
        Some(AgentSessionPermissionMode::Operator)
    );
    runtime
        .set_permission_mode("switch", AgentSessionPermissionMode::ScopedAutopilot)
        .unwrap();
    assert_eq!(
        runtime.session("switch").unwrap().header.permission_mode,
        Some(AgentSessionPermissionMode::ScopedAutopilot)
    );
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
