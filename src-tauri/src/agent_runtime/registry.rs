use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use crate::ai::AiProviderConfig;

use super::{
    AgentCapabilityScope, AgentScopedPayload, AgentSessionEventPayload, AgentSessionSnapshot,
    AgentSessionStore, AgentSubagentSession, ModelAdapter,
};

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentLifecyclePhase {
    Idle,
    Running,
    Waiting,
    Stopping,
    Disposed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentActiveScope {
    pub(crate) turn_id: String,
    pub(crate) step_id: Option<String>,
}

pub(crate) struct AgentEntry {
    pub(crate) session_id: String,
    // A new in-memory Agent starts a new series when a persisted session resumes.
    pub(crate) request_series_id: String,
    pub(crate) provider: AiProviderConfig,
    pub(crate) adapter: Arc<dyn ModelAdapter>,
    pub(crate) capability_scope: Option<AgentCapabilityScope>,
    pub(crate) subagent: Option<AgentSubagentSession>,
    owner: Mutex<Option<std::sync::Weak<AgentEntry>>>,
    cancellation: CancellationToken,
    admitting: AtomicBool,
    driver_active: AtomicBool,
    phase: Mutex<AgentLifecyclePhase>,
    scope: Mutex<Option<AgentActiveScope>>,
    idle: Notify,
    #[cfg(test)]
    lifecycle: Mutex<Vec<&'static str>>,
}

impl AgentEntry {
    fn new(
        session_id: String,
        provider: AiProviderConfig,
        adapter: Arc<dyn ModelAdapter>,
        capability_scope: Option<AgentCapabilityScope>,
        subagent: Option<AgentSubagentSession>,
        initial_phase: AgentLifecyclePhase,
    ) -> Self {
        Self {
            session_id,
            request_series_id: format!("series-{}", uuid::Uuid::new_v4().simple()),
            provider,
            adapter,
            capability_scope,
            subagent,
            owner: Mutex::new(None),
            cancellation: CancellationToken::new(),
            admitting: AtomicBool::new(true),
            driver_active: AtomicBool::new(false),
            phase: Mutex::new(initial_phase),
            scope: Mutex::new(None),
            idle: Notify::new(),
            #[cfg(test)]
            lifecycle: Mutex::new(Vec::new()),
        }
    }

    pub(crate) fn cancellation(&self) -> CancellationToken {
        self.cancellation.clone()
    }

    pub(crate) fn phase(&self) -> Result<AgentLifecyclePhase, String> {
        self.phase
            .lock()
            .map(|phase| *phase)
            .map_err(|_| "Agent lifecycle lock is unavailable".to_string())
    }

    pub(crate) fn set_phase(&self, phase: AgentLifecyclePhase) -> Result<(), String> {
        *self
            .phase
            .lock()
            .map_err(|_| "Agent lifecycle lock is unavailable".to_string())? = phase;
        Ok(())
    }

    pub(crate) fn set_scope(&self, scope: Option<AgentActiveScope>) -> Result<(), String> {
        *self
            .scope
            .lock()
            .map_err(|_| "Agent scope lock is unavailable".to_string())? = scope;
        Ok(())
    }

    pub(crate) fn scope(&self) -> Result<Option<AgentActiveScope>, String> {
        self.scope
            .lock()
            .map(|scope| scope.clone())
            .map_err(|_| "Agent scope lock is unavailable".to_string())
    }

    pub(crate) fn try_acquire_driver(&self) -> Result<bool, String> {
        if !self.admitting.load(Ordering::Acquire)
            || matches!(
                self.phase()?,
                AgentLifecyclePhase::Waiting
                    | AgentLifecyclePhase::Stopping
                    | AgentLifecyclePhase::Disposed
            )
        {
            return Ok(false);
        }
        Ok(self
            .driver_active
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok())
    }

    pub(crate) fn release_driver(&self) {
        self.driver_active.store(false, Ordering::Release);
        self.idle.notify_waiters();
    }

    pub(crate) fn is_driver_active(&self) -> bool {
        self.driver_active.load(Ordering::Acquire)
    }

    pub(crate) fn stop_admission(&self) -> Result<(), String> {
        self.admitting.store(false, Ordering::Release);
        self.set_phase(AgentLifecyclePhase::Stopping)?;
        self.record_lifecycle("stop-admission");
        Ok(())
    }

    pub(crate) fn cancel(&self) {
        self.cancellation.cancel();
        self.record_lifecycle("cancel");
    }

    pub(crate) async fn await_idle(&self) {
        loop {
            let notified = self.idle.notified();
            if !self.is_driver_active() {
                break;
            }
            notified.await;
        }
        self.record_lifecycle("await-idle");
    }

    fn record_lifecycle(&self, action: &'static str) {
        #[cfg(test)]
        if let Ok(mut lifecycle) = self.lifecycle.lock() {
            lifecycle.push(action);
        }
        #[cfg(not(test))]
        let _ = action;
    }
}

#[derive(Clone, Default)]
pub(crate) struct AgentRegistry {
    entries: Arc<Mutex<HashMap<String, Arc<AgentEntry>>>>,
}

impl AgentRegistry {
    pub(crate) fn set_owner(
        &self,
        child: &Arc<AgentEntry>,
        parent: &Arc<AgentEntry>,
    ) -> Result<(), String> {
        *child
            .owner
            .lock()
            .map_err(|_| "Agent ownership lock unavailable")? = Some(Arc::downgrade(parent));
        Ok(())
    }

    pub(crate) fn require_live_root(&self, entry: &Arc<AgentEntry>) -> Result<(), String> {
        if !self
            .get(&entry.session_id)?
            .is_some_and(|live| Arc::ptr_eq(&live, entry))
        {
            return Err("CALLER_NOT_LIVE: human input requires the exact live agent".into());
        }
        let owner = entry
            .owner
            .lock()
            .map_err(|_| "Agent ownership lock unavailable")?
            .as_ref()
            .and_then(std::sync::Weak::upgrade);
        if let Some(owner) = owner {
            if self
                .get(&owner.session_id)?
                .is_some_and(|live| Arc::ptr_eq(&live, &owner))
            {
                return Err(
                    "DELEGATED_CALLER: report unresolved questions in the child result".into(),
                );
            }
        }
        Ok(())
    }
    pub(crate) fn attach(
        &self,
        sessions: AgentSessionStore,
        session_id: String,
        provider: AiProviderConfig,
        adapter: Arc<dyn ModelAdapter>,
    ) -> Result<AgentHandle, String> {
        let snapshot = sessions.snapshot(&session_id)?;
        if snapshot.ended {
            return Err("ended Agent session cannot attach an Agent".into());
        }
        let initial_phase = if snapshot.status == super::AgentSessionStatus::Waiting {
            AgentLifecyclePhase::Waiting
        } else {
            AgentLifecyclePhase::Idle
        };
        let entry = Arc::new(AgentEntry::new(
            session_id.clone(),
            provider,
            adapter,
            snapshot.header.capability_scope,
            snapshot.header.subagent,
            initial_phase,
        ));
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| "Agent registry is unavailable".to_string())?;
        if entries.contains_key(&session_id) {
            return Err("Agent Session already has a registered Agent".into());
        }
        entries.insert(session_id, Arc::clone(&entry));
        Ok(AgentHandle {
            registry: self.clone(),
            sessions,
            entry,
        })
    }

    pub(crate) fn get(&self, session_id: &str) -> Result<Option<Arc<AgentEntry>>, String> {
        self.entries
            .lock()
            .map_err(|_| "Agent registry is unavailable".to_string())
            .map(|entries| entries.get(session_id).cloned())
    }

    pub(crate) fn detach(&self, session_id: &str) -> Result<(), String> {
        self.entries
            .lock()
            .map_err(|_| "Agent registry is unavailable".to_string())?
            .remove(session_id);
        Ok(())
    }

    #[cfg(test)]
    fn count(&self) -> usize {
        self.entries.lock().unwrap().len()
    }
}

pub(crate) struct AgentHandle {
    registry: AgentRegistry,
    sessions: AgentSessionStore,
    entry: Arc<AgentEntry>,
}

impl AgentHandle {
    pub(crate) fn entry(&self) -> Arc<AgentEntry> {
        Arc::clone(&self.entry)
    }

    pub(crate) async fn dispose(&self) -> Result<AgentSessionSnapshot, String> {
        self.entry.stop_admission()?;
        self.entry.cancel();
        self.entry.await_idle().await;
        if let Some(scope) = self.entry.scope()? {
            let mut payloads = Vec::new();
            if let Some(step_id) = scope.step_id {
                payloads.push(AgentScopedPayload {
                    turn_id: Some(scope.turn_id.clone()),
                    step_id: Some(step_id),
                    payload: AgentSessionEventPayload::StepEnd {
                        reason: "cancelled".into(),
                    },
                });
            }
            payloads.push(AgentScopedPayload {
                turn_id: Some(scope.turn_id),
                step_id: None,
                payload: AgentSessionEventPayload::TurnEnd {
                    reason: "cancelled".into(),
                },
            });
            self.sessions
                .append_batch(&self.entry.session_id, payloads)?;
            self.entry.set_scope(None)?;
        }
        self.entry.record_lifecycle("flush-session");
        let current = self.sessions.snapshot(&self.entry.session_id)?;
        let snapshot = if current.ended {
            current
        } else {
            self.sessions.cancel(&self.entry.session_id)?
        };
        self.entry.record_lifecycle("dispose-resources");
        self.entry.set_phase(AgentLifecyclePhase::Disposed)?;
        self.registry.detach(&self.entry.session_id)?;
        self.entry.record_lifecycle("detach-agent");
        self.entry.record_lifecycle("detach-session");
        Ok(snapshot)
    }

    /// Release a continuable child from memory without ending or cancelling
    /// its durable Session. A later input may attach a fresh Entry to the same
    /// log and Model Surface.
    pub(crate) async fn suspend(&self) -> Result<AgentSessionSnapshot, String> {
        if self.entry.is_driver_active() || self.entry.scope()?.is_some() {
            return Err("an active Agent cannot be suspended".into());
        }
        if self.entry.phase()? != AgentLifecyclePhase::Idle {
            return Err("only an idle Agent can be suspended".into());
        }
        self.entry.admitting.store(false, Ordering::Release);
        self.entry.set_phase(AgentLifecyclePhase::Disposed)?;
        self.registry.detach(&self.entry.session_id)?;
        self.entry.record_lifecycle("detach-agent");
        self.entry.record_lifecycle("detach-session");
        self.sessions.snapshot(&self.entry.session_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use tempfile::TempDir;

    use crate::ai::{AiProviderKind, AiReasoningEffort};

    use super::super::{
        CreateAgentSessionRequest, ModelRequest, ModelResponse, ModelStreamSink,
        NormalizedModelError,
    };

    struct IdleAdapter;

    #[async_trait]
    impl ModelAdapter for IdleAdapter {
        async fn stream(
            &self,
            _request: ModelRequest,
            _cancellation: CancellationToken,
            _sink: Arc<dyn ModelStreamSink>,
        ) -> Result<ModelResponse, NormalizedModelError> {
            unreachable!("lifecycle test does not start the driver")
        }
    }

    fn setup() -> (TempDir, AgentSessionStore, AgentRegistry) {
        let root = tempfile::tempdir().unwrap();
        let sessions = AgentSessionStore::default();
        sessions.configure(root.path().to_path_buf()).unwrap();
        sessions
            .create(CreateAgentSessionRequest {
                session_id: "session-1".into(),
                task_id: "task-1".into(),
                goal: "test lifecycle".into(),
                parent_session_id: None,
                target: None,
                permission_mode: None,
                success_criteria: Vec::new(),
                capability_scope: None,
                subagent: None,
            })
            .unwrap();
        (root, sessions, AgentRegistry::default())
    }

    fn provider() -> AiProviderConfig {
        AiProviderConfig {
            profile: None,
            retry_policy: None,
            id: "fake".into(),
            kind: AiProviderKind::Ollama,
            base_url: "http://127.0.0.1:11434".into(),
            model: "fake".into(),
            reasoning_effort: Some(AiReasoningEffort::Off),
            requires_api_key: false,
            api_key: None,
        }
    }

    #[tokio::test]
    async fn handle_disposes_in_the_declared_order_and_detaches_once() {
        let (_root, sessions, registry) = setup();
        let handle = registry
            .attach(
                sessions,
                "session-1".into(),
                provider(),
                Arc::new(IdleAdapter),
            )
            .unwrap();
        let entry = handle.entry();
        handle.dispose().await.unwrap();
        assert_eq!(registry.count(), 0);
        assert_eq!(entry.phase().unwrap(), AgentLifecyclePhase::Disposed);
        assert_eq!(
            *entry.lifecycle.lock().unwrap(),
            [
                "stop-admission",
                "cancel",
                "await-idle",
                "flush-session",
                "dispose-resources",
                "detach-agent",
                "detach-session",
            ]
        );
    }

    #[test]
    fn registry_rejects_a_second_agent_for_the_same_session() {
        let (_root, sessions, registry) = setup();
        let _handle = registry
            .attach(
                sessions.clone(),
                "session-1".into(),
                provider(),
                Arc::new(IdleAdapter),
            )
            .unwrap();
        assert!(registry
            .attach(
                sessions,
                "session-1".into(),
                provider(),
                Arc::new(IdleAdapter),
            )
            .is_err());
    }
}
