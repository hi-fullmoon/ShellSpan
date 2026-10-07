//! In-memory remote approval binding. Never serialize this as a grant.

use super::AgentToolTargetNative;
use crate::db::Database;
use crate::execution::{FrozenJumpHostIdentity, FrozenTargetIdentity};
use crate::models::{JumpHostConfig, SessionManager, SessionStatus, SessionTerminalKind};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RemoteExecutionBinding {
    terminal_id: String,
    generation: uuid::Uuid,
    identity: FrozenTargetIdentity,
    keychain_key_id: Option<String>,
    jump_keychain_key_id: Option<String>,
    profile_revision: String,
}

impl RemoteExecutionBinding {
    pub(crate) fn digest(&self) -> Result<String, String> {
        use sha2::{Digest, Sha256};
        let value = serde_json::to_vec(&(
            &self.terminal_id,
            self.generation,
            &self.identity,
            &self.keychain_key_id,
            &self.jump_keychain_key_id,
            &self.profile_revision,
        ))
        .map_err(|_| "sandboxAuthorizationInvalid: remote binding digest unavailable")?;
        Ok(hex::encode(Sha256::digest(value)))
    }
    pub(crate) fn capture(
        target: &AgentToolTargetNative,
        sessions: &SessionManager,
        database: &Database,
    ) -> Result<Option<Self>, String> {
        let AgentToolTargetNative::Remote {
            session_id,
            profile_id,
            host,
            port,
            username,
            ..
        } = target
        else {
            return Ok(None);
        };
        let (state, generation) = sessions
            .execution_binding_state(session_id)
            .map_err(|error| super::normalize_terminal_target_lookup_error(session_id, error))?;
        if state.terminal_kind != SessionTerminalKind::Remote
            || state.status != SessionStatus::Connected
            || state.identity.host != *host
            || state.identity.port != *port
            || state.identity.username != *username
        {
            return Err(super::terminal_target_unavailable(
                "Remote execution identity changed or disconnected",
            ));
        }
        let profile_id = profile_id
            .as_ref()
            .ok_or("Remote execution requires a frozen profile id")?;
        let profile_revision = database.profile_execution_revision(profile_id)?;
        let profile = database
            .get_profile(profile_id)?
            .ok_or("Remote execution profile was not found")?;
        if profile.host != *host || profile.port != *port || profile.username != *username {
            return Err(super::terminal_target_unavailable(
                "Remote execution profile identity drifted",
            ));
        }
        let jump_config = profile.jump_host_config.as_deref().map(|value| {
            let jump: JumpHostConfig = serde_json::from_str(value).map_err(|_| "Stored jump-host identity is invalid")?;
            if jump.password.is_some() || jump.private_key_data.is_some() || jump.passphrase.is_some() {
                return Err("Remote execution requires migrated jump-host credential references; inline secrets are not accepted");
            }
            Ok(jump)
        }).transpose()?;
        let jump_keychain_key_id = jump_config
            .as_ref()
            .and_then(|jump| jump.keychain_key_id.clone());
        let jump = jump_config
            .map(|jump| {
                FrozenJumpHostIdentity::new(
                    jump.host,
                    jump.port,
                    jump.username,
                    jump.auth_method.as_str().into(),
                )
                .map_err(|error| error.message)
            })
            .transpose()?;
        let identity = FrozenTargetIdentity::new(
            profile.id,
            profile.host,
            profile.port,
            profile.username,
            profile.auth_method.as_str().into(),
            jump,
        )
        .map_err(|error| error.message)?;
        if database.profile_execution_revision(profile_id)? != profile_revision {
            return Err(
                "sandboxAuthorizationInvalid: remote profile changed while freezing approval"
                    .into(),
            );
        }
        Ok(Some(Self {
            terminal_id: session_id.clone(),
            generation,
            identity,
            keychain_key_id: profile.keychain_key_id,
            jump_keychain_key_id,
            profile_revision,
        }))
    }

    pub(crate) fn validate(
        &self,
        target: &AgentToolTargetNative,
        sessions: &SessionManager,
        database: &Database,
    ) -> Result<(), String> {
        if Self::capture(target, sessions, database)?.as_ref() != Some(self) {
            return Err("sandboxAuthorizationInvalid: remote connection, account or authentication binding changed; request a new approval".into());
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "tests/remote_binding.rs"]
mod tests;
