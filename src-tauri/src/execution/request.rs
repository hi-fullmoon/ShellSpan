use super::cancellation::valid_operation_id;
use super::result::ExecutionErrorCategory;
use crate::models::{JumpHostConfig, RemoteConnectionRequest};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt;
use std::time::Duration;

pub(crate) const MAX_OPERATION_ID_BYTES: usize = 128;
pub(crate) const MAX_REVIEWED_COMMAND_BYTES: usize = 8 * 1024;
pub(crate) const MIN_EXECUTION_TIMEOUT: Duration = Duration::from_secs(1);
pub(crate) const MAX_EXECUTION_TIMEOUT: Duration = Duration::from_secs(300);
pub(crate) const DEFAULT_STDOUT_CAPTURE_BYTES: usize = 64 * 1024;
pub(crate) const DEFAULT_STDERR_CAPTURE_BYTES: usize = 16 * 1024;
pub(crate) const DEFAULT_TOTAL_READ_HARD_LIMIT_BYTES: usize = 8 * 1024 * 1024;
pub(crate) const MAX_STDOUT_CAPTURE_BYTES: usize = 256 * 1024;
pub(crate) const MAX_STDERR_CAPTURE_BYTES: usize = 64 * 1024;
pub(crate) const MAX_TOTAL_READ_HARD_LIMIT_BYTES: usize = 16 * 1024 * 1024;

const MAX_PROFILE_ID_BYTES: usize = 256;
const MAX_HOST_BYTES: usize = 1_024;
const MAX_USERNAME_BYTES: usize = 256;
const IDENTITY_DIGEST_DOMAIN: &str = "shellspan-reviewed-ssh-target";
const IDENTITY_DIGEST_VERSION: &str = "v1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ExecutionValidationError {
    pub(crate) category: ExecutionErrorCategory,
    pub(crate) message: &'static str,
}

impl ExecutionValidationError {
    fn invalid(message: &'static str) -> Self {
        Self {
            category: ExecutionErrorCategory::InvalidRequest,
            message,
        }
    }

    fn target_mismatch(message: &'static str) -> Self {
        Self {
            category: ExecutionErrorCategory::TargetMismatch,
            message,
        }
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FrozenJumpHostIdentity {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) username: String,
    pub(crate) auth_method: String,
}

impl FrozenJumpHostIdentity {
    pub(crate) fn new(
        host: String,
        port: u16,
        username: String,
        auth_method: String,
    ) -> Result<Self, ExecutionValidationError> {
        let identity = Self {
            host,
            port,
            username,
            auth_method,
        };
        identity.validate()?;
        Ok(identity)
    }

    fn from_connection(jump: &JumpHostConfig) -> Result<Self, ExecutionValidationError> {
        Self::new(
            jump.host.clone(),
            jump.port,
            jump.username.clone(),
            jump.auth_method.as_str().to_string(),
        )
    }

    fn validate(&self) -> Result<(), ExecutionValidationError> {
        validate_target_component(&self.host, MAX_HOST_BYTES, "jump host is invalid")?;
        if self.port == 0 {
            return Err(ExecutionValidationError::invalid("jump port is invalid"));
        }
        validate_target_component(
            &self.username,
            MAX_USERNAME_BYTES,
            "jump username is invalid",
        )?;
        validate_auth_method(&self.auth_method, "jump authentication method is invalid")
    }

    fn matches_connection(&self, jump: &JumpHostConfig) -> bool {
        self.host == jump.host
            && self.port == jump.port
            && self.username == jump.username
            && self.auth_method == jump.auth_method.as_str()
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FrozenTargetIdentity {
    pub(crate) profile_id: String,
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) username: String,
    pub(crate) auth_method: String,
    pub(crate) jump_host: Option<FrozenJumpHostIdentity>,
    pub(crate) identity_digest: String,
}

impl FrozenTargetIdentity {
    pub(crate) fn new(
        profile_id: String,
        host: String,
        port: u16,
        username: String,
        auth_method: String,
        jump_host: Option<FrozenJumpHostIdentity>,
    ) -> Result<Self, ExecutionValidationError> {
        let mut identity = Self {
            profile_id,
            host,
            port,
            username,
            auth_method,
            jump_host,
            identity_digest: String::new(),
        };
        identity.validate_shape()?;
        identity.identity_digest = identity.canonical_digest();
        Ok(identity)
    }

    pub(crate) fn from_connection(
        profile_id: String,
        connection: &RemoteConnectionRequest,
    ) -> Result<Self, ExecutionValidationError> {
        Self::new(
            profile_id,
            connection.host.clone(),
            connection.port,
            connection.username.clone(),
            connection.auth_method.as_str().to_string(),
            connection
                .jump_host
                .as_ref()
                .map(FrozenJumpHostIdentity::from_connection)
                .transpose()?,
        )
    }

    pub(crate) fn canonical_digest(&self) -> String {
        let mut canonical = Vec::new();
        for component in [
            IDENTITY_DIGEST_DOMAIN,
            IDENTITY_DIGEST_VERSION,
            "profileId",
            &self.profile_id,
            "host",
            &self.host,
            "port",
            &self.port.to_string(),
            "username",
            &self.username,
            "authMethod",
            &self.auth_method,
            "jump",
        ] {
            canonical.extend_from_slice(component.as_bytes());
            canonical.push(0);
        }
        match &self.jump_host {
            None => canonical.extend_from_slice(b"none\0"),
            Some(jump) => {
                for component in [
                    "some",
                    "host",
                    &jump.host,
                    "port",
                    &jump.port.to_string(),
                    "username",
                    &jump.username,
                    "authMethod",
                    &jump.auth_method,
                ] {
                    canonical.extend_from_slice(component.as_bytes());
                    canonical.push(0);
                }
            }
        }
        let hash = Sha256::digest(canonical);
        let hex = hash
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        format!("sha256-{IDENTITY_DIGEST_VERSION}:{hex}")
    }

    pub(crate) fn validate(&self) -> Result<(), ExecutionValidationError> {
        self.validate_shape()?;
        if self.identity_digest != self.canonical_digest() {
            return Err(ExecutionValidationError::target_mismatch(
                "frozen target identity digest does not match its fields",
            ));
        }
        Ok(())
    }

    pub(crate) fn validate_connection(
        &self,
        connection: &RemoteConnectionRequest,
    ) -> Result<(), ExecutionValidationError> {
        self.validate()?;
        let jump_matches = match (&self.jump_host, &connection.jump_host) {
            (None, None) => true,
            (Some(frozen), Some(current)) => frozen.matches_connection(current),
            _ => false,
        };
        if self.host != connection.host
            || self.port != connection.port
            || self.username != connection.username
            || self.auth_method != connection.auth_method.as_str()
            || !jump_matches
        {
            return Err(ExecutionValidationError::target_mismatch(
                "connection identity does not match the frozen target",
            ));
        }
        Ok(())
    }

    fn validate_shape(&self) -> Result<(), ExecutionValidationError> {
        validate_target_component(
            &self.profile_id,
            MAX_PROFILE_ID_BYTES,
            "target profile ID is invalid",
        )?;
        validate_target_component(&self.host, MAX_HOST_BYTES, "target host is invalid")?;
        if self.port == 0 {
            return Err(ExecutionValidationError::invalid("target port is invalid"));
        }
        validate_target_component(
            &self.username,
            MAX_USERNAME_BYTES,
            "target username is invalid",
        )?;
        validate_auth_method(&self.auth_method, "target authentication method is invalid")?;
        if let Some(jump) = &self.jump_host {
            jump.validate()?;
        }
        Ok(())
    }
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct ReviewedSshCommand {
    pub(crate) command: String,
    pub(crate) preview: String,
    pub(crate) redaction_values: Vec<String>,
}

impl fmt::Debug for ReviewedSshCommand {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ReviewedSshCommand")
            .field("preview", &self.preview)
            .field("redaction_value_count", &self.redaction_values.len())
            .finish_non_exhaustive()
    }
}

impl ReviewedSshCommand {
    pub(crate) fn new(
        command: String,
        preview: String,
        redaction_values: Vec<String>,
    ) -> Result<Self, ExecutionValidationError> {
        let reviewed = Self {
            command,
            preview,
            redaction_values,
        };
        reviewed.validate()?;
        Ok(reviewed)
    }

    pub(crate) fn validate(&self) -> Result<(), ExecutionValidationError> {
        if self.command.trim().is_empty() {
            return Err(ExecutionValidationError::invalid(
                "reviewed SSH command is empty",
            ));
        }
        if self.command.as_bytes().contains(&0) {
            return Err(ExecutionValidationError::invalid(
                "reviewed SSH command contains NUL",
            ));
        }
        if self.command.len() > MAX_REVIEWED_COMMAND_BYTES {
            return Err(ExecutionValidationError::invalid(
                "reviewed SSH command exceeds 8 KiB",
            ));
        }
        if self.preview.trim().is_empty()
            || self.preview.as_bytes().contains(&0)
            || self.preview.len() > MAX_REVIEWED_COMMAND_BYTES
        {
            return Err(ExecutionValidationError::invalid(
                "reviewed SSH command preview is invalid",
            ));
        }
        if self
            .redaction_values
            .iter()
            .filter(|secret| !secret.is_empty())
            .any(|secret| self.preview.contains(secret))
        {
            return Err(ExecutionValidationError::invalid(
                "reviewed SSH command preview contains a known secret",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ExecutionOutputPolicy {
    pub(crate) stdout_capture_bytes: usize,
    pub(crate) stderr_capture_bytes: usize,
    pub(crate) total_read_hard_limit_bytes: usize,
}

impl Default for ExecutionOutputPolicy {
    fn default() -> Self {
        Self {
            stdout_capture_bytes: DEFAULT_STDOUT_CAPTURE_BYTES,
            stderr_capture_bytes: DEFAULT_STDERR_CAPTURE_BYTES,
            total_read_hard_limit_bytes: DEFAULT_TOTAL_READ_HARD_LIMIT_BYTES,
        }
    }
}

impl ExecutionOutputPolicy {
    pub(crate) fn new(
        stdout_capture_bytes: usize,
        stderr_capture_bytes: usize,
        total_read_hard_limit_bytes: usize,
    ) -> Result<Self, ExecutionValidationError> {
        let policy = Self {
            stdout_capture_bytes,
            stderr_capture_bytes,
            total_read_hard_limit_bytes,
        };
        policy.validate()?;
        Ok(policy)
    }

    pub(crate) fn validate(&self) -> Result<(), ExecutionValidationError> {
        if self.stdout_capture_bytes > MAX_STDOUT_CAPTURE_BYTES {
            return Err(ExecutionValidationError::invalid(
                "stdout capture limit exceeds 256 KiB",
            ));
        }
        if self.stderr_capture_bytes > MAX_STDERR_CAPTURE_BYTES {
            return Err(ExecutionValidationError::invalid(
                "stderr capture limit exceeds 64 KiB",
            ));
        }
        if self.total_read_hard_limit_bytes == 0
            || self.total_read_hard_limit_bytes > MAX_TOTAL_READ_HARD_LIMIT_BYTES
        {
            return Err(ExecutionValidationError::invalid(
                "total output hard limit is invalid",
            ));
        }
        Ok(())
    }
}

#[derive(Clone)]
pub(crate) struct ReviewedSshExecutionRequest {
    pub(crate) operation_id: String,
    pub(crate) target: FrozenTargetIdentity,
    pub(crate) connection: RemoteConnectionRequest,
    pub(crate) command: ReviewedSshCommand,
    pub(crate) timeout: Duration,
    pub(crate) output_policy: ExecutionOutputPolicy,
}

impl ReviewedSshExecutionRequest {
    pub(crate) fn validate(&self) -> Result<(), ExecutionValidationError> {
        if !valid_operation_id(&self.operation_id) {
            return Err(ExecutionValidationError::invalid(
                "reviewed execution operation ID is invalid",
            ));
        }
        self.target.validate_connection(&self.connection)?;
        self.command.validate()?;
        if self.preview_contains_known_secret() {
            return Err(ExecutionValidationError::invalid(
                "reviewed SSH command preview contains a known secret",
            ));
        }
        if self.timeout < MIN_EXECUTION_TIMEOUT || self.timeout > MAX_EXECUTION_TIMEOUT {
            return Err(ExecutionValidationError::invalid(
                "reviewed execution timeout must be between 1 and 300 seconds",
            ));
        }
        self.output_policy.validate()
    }

    pub(crate) fn known_secret_values(&self) -> Vec<String> {
        let mut secrets = self.command.redaction_values.clone();
        secrets.extend(known_connection_secret_values(&self.connection));
        secrets.retain(|secret| !secret.is_empty());
        secrets.sort_unstable_by(|left, right| {
            right.len().cmp(&left.len()).then_with(|| left.cmp(right))
        });
        secrets.dedup();
        secrets
    }

    fn preview_contains_known_secret(&self) -> bool {
        self.command
            .redaction_values
            .iter()
            .map(String::as_str)
            .chain(
                [
                    self.connection.password.as_deref(),
                    self.connection.private_key_data.as_deref(),
                    self.connection.passphrase.as_deref(),
                ]
                .into_iter()
                .flatten(),
            )
            .chain(self.connection.jump_host.iter().flat_map(|jump| {
                [
                    jump.password.as_deref(),
                    jump.private_key_data.as_deref(),
                    jump.passphrase.as_deref(),
                ]
                .into_iter()
                .flatten()
            }))
            .any(|secret| !secret.is_empty() && self.command.preview.contains(secret))
    }
}

fn validate_target_component(
    value: &str,
    maximum_bytes: usize,
    message: &'static str,
) -> Result<(), ExecutionValidationError> {
    if value.trim().is_empty()
        || value.len() > maximum_bytes
        || value.as_bytes().contains(&0)
        || value.chars().any(char::is_control)
    {
        return Err(ExecutionValidationError::invalid(message));
    }
    Ok(())
}

fn validate_auth_method(
    value: &str,
    message: &'static str,
) -> Result<(), ExecutionValidationError> {
    if !matches!(value, "password" | "key") {
        return Err(ExecutionValidationError::invalid(message));
    }
    Ok(())
}

fn add_secret(secrets: &mut Vec<String>, value: Option<&str>) {
    if let Some(value) = value.filter(|value| !value.is_empty()) {
        secrets.push(value.to_string());
    }
}

pub(crate) fn known_connection_secret_values(connection: &RemoteConnectionRequest) -> Vec<String> {
    let mut secrets = Vec::new();
    add_secret(&mut secrets, connection.password.as_deref());
    add_secret(&mut secrets, connection.private_key_data.as_deref());
    add_secret(&mut secrets, connection.passphrase.as_deref());
    if let Some(jump) = &connection.jump_host {
        add_secret(&mut secrets, jump.password.as_deref());
        add_secret(&mut secrets, jump.private_key_data.as_deref());
        add_secret(&mut secrets, jump.passphrase.as_deref());
    }
    secrets
}

#[cfg(test)]
mod tests {
    include!("tests/request.rs");
}
