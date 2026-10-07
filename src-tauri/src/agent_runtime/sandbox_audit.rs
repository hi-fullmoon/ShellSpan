//! Historical audit metadata is never live or restorable authorization.
use super::sandbox_authorization::ResourceAuthorizationScope;
use super::{
    AgentSandboxContract, AgentSandboxResource, AgentSessionEventPayload, AgentSessionHeader,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SandboxResourceAudit {
    pub(crate) action: SandboxResourceAuditAction,
    pub(crate) scope: Option<ResourceAuthorizationScope>,
    pub(crate) resources: Vec<AgentSandboxResource>,
    pub(crate) binding_revision: u64,
    pub(crate) call_expires_at_unix_ms: Option<u64>,
    pub(crate) session_expires_at_unix_ms: Option<u64>,
    pub(crate) cleanup_confirmed: Option<bool>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SandboxResourceAuditAction {
    Approved,
    Reused,
    Revoked,
    RevocationFailed,
}

impl super::AgentRuntime {
    pub(crate) fn record_sandbox_authorization(
        &self,
        session_id: &str,
        turn_id: &str,
        step_id: &str,
        call_id: &str,
        contract: &AgentSandboxContract,
        scope: ResourceAuthorizationScope,
        approved: bool,
        session_expiry: Option<u64>,
    ) -> Result<(), String> {
        if contract.resource_grants.is_empty() {
            return Ok(());
        }
        let snapshot = self.session(session_id)?;
        contract.validate_session(&snapshot.header, super::driver::current_unix_ms()?)?;
        self.sessions.append(
            session_id,
            Some(turn_id.into()),
            Some(step_id.into()),
            AgentSessionEventPayload::SandboxResourceAudit {
                call_id: Some(call_id.into()),
                audit: SandboxResourceAudit {
                    action: if approved {
                        SandboxResourceAuditAction::Approved
                    } else {
                        SandboxResourceAuditAction::Reused
                    },
                    scope: Some(if approved {
                        scope
                    } else {
                        ResourceAuthorizationScope::Session
                    }),
                    resources: contract
                        .resource_grants
                        .iter()
                        .map(|grant| grant.resource.clone())
                        .collect(),
                    binding_revision: contract.binding_revision,
                    call_expires_at_unix_ms: contract
                        .resource_grants
                        .iter()
                        .map(|grant| grant.expires_at_unix_ms)
                        .min(),
                    session_expires_at_unix_ms: session_expiry,
                    cleanup_confirmed: None,
                },
            },
        )?;
        Ok(())
    }

    pub(crate) fn record_sandbox_revocation(
        &self,
        header: &AgentSessionHeader,
        resources: Vec<AgentSandboxResource>,
        confirmed: bool,
    ) -> Result<(), String> {
        self.sessions.append(
            &header.session_id,
            None,
            None,
            AgentSessionEventPayload::SandboxResourceAudit {
                call_id: None,
                audit: SandboxResourceAudit {
                    action: if confirmed {
                        SandboxResourceAuditAction::Revoked
                    } else {
                        SandboxResourceAuditAction::RevocationFailed
                    },
                    scope: None,
                    resources,
                    binding_revision: header.sandbox_binding_revision,
                    call_expires_at_unix_ms: None,
                    session_expires_at_unix_ms: None,
                    cleanup_confirmed: Some(confirmed),
                },
            },
        )?;
        Ok(())
    }
}
