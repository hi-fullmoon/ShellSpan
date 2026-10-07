//! Session policy changes are serialized with the driver; configuration is not authority.
use super::*;

impl AgentRuntime {
    pub(crate) fn set_cache_directory_candidates(
        &self,
        session_id: &str,
        directories: Vec<String>,
    ) -> Result<AgentSessionSnapshot, String> {
        let _shutdown_admission = self.native_engine.admit_operation()?;
        let transition = self.policy_transition(session_id)?;
        let _transition = transition
            .try_lock()
            .map_err(|_| "SANDBOX_POLICY_BUSY: session transition in progress")?;
        let before = self.session(session_id)?;
        if before.ended || before.archived || self.agents.get(session_id)?.is_some() {
            return Err("Configuration hints must be frozen before session startup".into());
        }
        if before.header.cache_directory_candidates == directories {
            return Ok(before);
        }
        self.sessions.append(
            session_id,
            None,
            None,
            super::super::AgentSessionEventPayload::SessionCacheDirectoryCandidates { directories },
        )?;
        self.session(session_id)
    }
    pub(crate) fn rollback_sandbox_audit(
        &self,
        session_id: &str,
        task_id: &str,
        sessions: &crate::models::SessionManager,
        error: String,
    ) -> String {
        let mut errors = vec![error];
        if let Err(error) = self.pause_resource_admission(session_id) {
            errors.push(format!("Resource audit admission pause failed: {error}"));
        }
        if let Err(error) = self.native_engine.revoke_task_authorizations(task_id) {
            errors.push(format!("Resource audit authority rollback failed: {error}"));
        }
        if let Err(error) = self.native_engine.cancel_task(task_id, sessions) {
            errors.push(format!("Resource audit cleanup unconfirmed: {error}"));
        }
        errors.join("; ")
    }
    pub(crate) fn pause_resource_admission(&self, session_id: &str) -> Result<(), String> {
        if let Some(entry) = self.agents.get(session_id)? {
            entry.stop_admission()?;
        }
        Ok(())
    }
    pub(crate) fn policy_transition(&self, session_id: &str) -> Result<Arc<Mutex<()>>, String> {
        self.sessions.snapshot(session_id)?;
        let mut gates = self
            .policy_transitions
            .lock()
            .map_err(|_| "Session transition registry unavailable")?;
        gates.retain(|_, gate| gate.strong_count() > 0);
        if let Some(gate) = gates.get(session_id).and_then(std::sync::Weak::upgrade) {
            return Ok(gate);
        }
        let gate = Arc::new(Mutex::new(()));
        gates.insert(session_id.into(), Arc::downgrade(&gate));
        Ok(gate)
    }

    pub(crate) fn set_sandbox_policy(
        &self,
        session_id: &str,
        policy: super::super::AgentSandboxPolicy,
    ) -> Result<AgentSessionSnapshot, String> {
        let _shutdown_admission = self.native_engine.admit_operation()?;
        let transition = self.policy_transition(session_id)?;
        let _transition = transition
            .try_lock()
            .map_err(|_| "SANDBOX_POLICY_BUSY: session transition in progress")?;
        let entry = self.agents.get(session_id)?;
        let reserved = if let Some(entry) = &entry {
            if !entry.try_acquire_archive() {
                return Err("SANDBOX_POLICY_BUSY: wait for the current operation".into());
            }
            Some(ActiveDriverLease(Arc::clone(entry)))
        } else {
            None
        };
        let result = (|| {
            let before = self.sessions.snapshot(session_id)?;
            if before.header.subagent.is_some() || before.ended || before.archived {
                return Err("SANDBOX_POLICY_BUSY: active root session required".into());
            }
            if before.status != super::super::AgentSessionStatus::Idle
                || before.uncertain_native_effects
                || before.recovery.kind
                    == super::super::AgentRecoveryCheckpointKind::WaitingApproval
                || !before.inbox.next_turn.is_empty()
                || !before.inbox.next_step.is_empty()
                || self.sessions.has_unfinished_children(session_id)?
                || self
                    .native_engine
                    .has_task_processes(&before.header.task_id)?
            {
                return Err(
                    "SANDBOX_POLICY_BUSY: stop affected background and child work first".into(),
                );
            }
            for task in self.sessions.family_task_ids(session_id)? {
                if self.native_engine.has_task_processes(&task)? {
                    return Err("SANDBOX_POLICY_BUSY: stop affected child background work".into());
                }
            }
            if let Some(entry) = &entry {
                if entry.phase()? != AgentLifecyclePhase::Idle || entry.scope()?.is_some() {
                    return Err("SANDBOX_POLICY_BUSY: wait for the Agent to become idle".into());
                }
            }
            if let Some(target) = &before.header.target {
                if self.native_engine.has_terminal_lease(&target.session_id)? {
                    return Err("SANDBOX_POLICY_BUSY: wait for the terminal lease".into());
                }
            }
            if before.header.sandbox_policy == Some(policy) {
                return Ok(before);
            }
            let mut proposed = before.header.clone();
            proposed.sandbox_policy = Some(policy);
            self.tools.prepare_sandbox(&proposed)?;
            super::super::require_session_sandbox(&proposed)?;
            // No affected process is running. Invalidate memory and unconsumed capabilities
            // before changing the binding; a journal failure never restores authority.
            let resources = self
                .native_engine
                .audit_resources_for_task(&before.header.task_id)?;
            self.native_engine
                .revoke_task_authorizations(&before.header.task_id)?;
            if !resources.is_empty() {
                self.record_sandbox_revocation(&before.header, resources, true)?;
            }
            self.sessions.append(
                session_id,
                None,
                None,
                super::super::AgentSessionEventPayload::SessionSandboxPolicyChanged { policy },
            )?;
            self.sessions.snapshot(session_id)
        })();
        drop(reserved);
        drop(_transition);
        if self.sessions.snapshot(session_id).is_ok_and(|snapshot| {
            !snapshot.inbox.next_turn.is_empty() || !snapshot.inbox.next_step.is_empty()
        }) {
            let _ = self.wake(session_id);
        }
        result
    }
}
