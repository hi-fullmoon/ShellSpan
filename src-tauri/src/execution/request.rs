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
const IDENTITY_DIGEST_DOMAIN: &str = "termbridge-reviewed-ssh-target";
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
    use super::*;
    use crate::models::AuthMethod;

    fn connection() -> RemoteConnectionRequest {
        RemoteConnectionRequest {
            host: "target.example.test".to_string(),
            port: 22,
            username: "operator".to_string(),
            auth_method: AuthMethod::Password,
            password: Some("target-password".to_string()),
            keychain_key_id: None,
            private_key_data: Some("target-private-key".to_string()),
            passphrase: Some("target-passphrase".to_string()),
            jump_host: Some(JumpHostConfig {
                host: "jump.example.test".to_string(),
                port: 2222,
                username: "jump-operator".to_string(),
                auth_method: AuthMethod::Key,
                password: Some("jump-password".to_string()),
                keychain_key_id: None,
                private_key_data: Some("jump-private-key".to_string()),
                passphrase: Some("jump-passphrase".to_string()),
            }),
        }
    }

    fn valid_request() -> ReviewedSshExecutionRequest {
        let connection = connection();
        ReviewedSshExecutionRequest {
            operation_id: "execution:test-1".to_string(),
            target: FrozenTargetIdentity::from_connection("profile-1".to_string(), &connection)
                .expect("freeze target"),
            connection,
            command: ReviewedSshCommand::new(
                "printf '%s' 'target-password'".to_string(),
                "printf '%s' '<keychain://profile/password>'".to_string(),
                vec!["target-password".to_string()],
            )
            .expect("review command"),
            timeout: Duration::from_secs(30),
            output_policy: ExecutionOutputPolicy::default(),
        }
    }

    #[test]
    fn request_hard_limit_matrix_fails_closed() {
        let mut request = valid_request();
        assert!(request.validate().is_ok());

        for invalid_operation_id in [
            "".to_string(),
            "invalid operation".to_string(),
            "x".repeat(MAX_OPERATION_ID_BYTES + 1),
        ] {
            request.operation_id = invalid_operation_id;
            assert_eq!(
                request
                    .validate()
                    .expect_err("reject operation ID")
                    .category,
                ExecutionErrorCategory::InvalidRequest
            );
        }
        request = valid_request();

        for invalid_command in [
            String::new(),
            " \t".to_string(),
            "printf '\0'".replace("\\0", "\0"),
            "x".repeat(MAX_REVIEWED_COMMAND_BYTES + 1),
        ] {
            request.command.command = invalid_command;
            assert_eq!(
                request.validate().expect_err("reject command").category,
                ExecutionErrorCategory::InvalidRequest
            );
        }
        request = valid_request();

        for invalid_timeout in [
            MIN_EXECUTION_TIMEOUT - Duration::from_millis(1),
            MAX_EXECUTION_TIMEOUT + Duration::from_millis(1),
        ] {
            request.timeout = invalid_timeout;
            assert_eq!(
                request.validate().expect_err("reject timeout").category,
                ExecutionErrorCategory::InvalidRequest
            );
        }
        request = valid_request();

        for invalid_policy in [
            ExecutionOutputPolicy {
                stdout_capture_bytes: MAX_STDOUT_CAPTURE_BYTES + 1,
                ..ExecutionOutputPolicy::default()
            },
            ExecutionOutputPolicy {
                stderr_capture_bytes: MAX_STDERR_CAPTURE_BYTES + 1,
                ..ExecutionOutputPolicy::default()
            },
            ExecutionOutputPolicy {
                total_read_hard_limit_bytes: 0,
                ..ExecutionOutputPolicy::default()
            },
            ExecutionOutputPolicy {
                total_read_hard_limit_bytes: MAX_TOTAL_READ_HARD_LIMIT_BYTES + 1,
                ..ExecutionOutputPolicy::default()
            },
        ] {
            request.output_policy = invalid_policy;
            assert_eq!(
                request
                    .validate()
                    .expect_err("reject output policy")
                    .category,
                ExecutionErrorCategory::InvalidRequest
            );
        }
    }

    #[test]
    fn reviewed_command_constructor_rejects_invalid_commands() {
        for invalid_command in [
            String::new(),
            " \t".to_string(),
            "printf '\0'".replace("\\0", "\0"),
            "x".repeat(MAX_REVIEWED_COMMAND_BYTES + 1),
        ] {
            let error =
                ReviewedSshCommand::new(invalid_command, "safe preview".to_string(), Vec::new())
                    .expect_err("constructor rejects an invalid command");
            assert_eq!(error.category, ExecutionErrorCategory::InvalidRequest);
        }

        let error = ReviewedSshCommand::new(
            "printf target-password".to_string(),
            "printf target-password".to_string(),
            vec!["target-password".to_string()],
        )
        .expect_err("constructor rejects a preview containing a known secret");
        assert_eq!(error.category, ExecutionErrorCategory::InvalidRequest);

        let mut request = valid_request();
        request.command.preview = "printf target-passphrase".to_string();
        let error = request
            .validate()
            .expect_err("request rejects a preview containing a connection secret");
        assert_eq!(error.category, ExecutionErrorCategory::InvalidRequest);
    }

    #[test]
    fn request_hard_limit_boundaries_are_inclusive() {
        let mut request = valid_request();
        request.command.command = "x".repeat(MAX_REVIEWED_COMMAND_BYTES);
        request.command.preview = "x".repeat(MAX_REVIEWED_COMMAND_BYTES);
        request.timeout = MIN_EXECUTION_TIMEOUT;
        request.output_policy = ExecutionOutputPolicy::new(
            MAX_STDOUT_CAPTURE_BYTES,
            MAX_STDERR_CAPTURE_BYTES,
            MAX_TOTAL_READ_HARD_LIMIT_BYTES,
        )
        .expect("backend maxima are accepted");
        assert!(request.validate().is_ok());

        request.timeout = MAX_EXECUTION_TIMEOUT;
        assert!(request.validate().is_ok());
    }

    #[test]
    fn canonical_identity_digest_is_versioned_and_stable() {
        let target = FrozenTargetIdentity::from_connection("profile-1".to_string(), &connection())
            .expect("freeze target identity");

        assert_eq!(
            target.identity_digest,
            "sha256-v1:0032514ca8828ffb0a9a6084b825d1b0687e4a7bda772bf8aef846674fc289b7"
        );
        assert_eq!(target.identity_digest, target.canonical_digest());

        let mut changed_secrets = connection();
        changed_secrets.password = Some("different-target-password".to_string());
        changed_secrets.private_key_data = Some("different-target-key".to_string());
        changed_secrets.passphrase = Some("different-target-passphrase".to_string());
        changed_secrets.jump_host.as_mut().unwrap().password =
            Some("different-jump-password".to_string());
        changed_secrets.jump_host.as_mut().unwrap().private_key_data =
            Some("different-jump-key".to_string());
        changed_secrets.jump_host.as_mut().unwrap().passphrase =
            Some("different-jump-passphrase".to_string());
        let same_non_secret_identity =
            FrozenTargetIdentity::from_connection("profile-1".to_string(), &changed_secrets)
                .expect("freeze identity with changed secrets");
        assert_eq!(
            target.identity_digest,
            same_non_secret_identity.identity_digest
        );
    }

    #[test]
    fn target_and_jump_identity_drift_change_digest_and_fail_validation() {
        let baseline_connection = connection();
        let baseline =
            FrozenTargetIdentity::from_connection("profile-1".to_string(), &baseline_connection)
                .expect("freeze baseline identity");

        let mut variants = Vec::new();
        let mut changed = baseline_connection.clone();
        changed.host = "changed.example.test".to_string();
        variants.push(("target host", changed));
        let mut changed = baseline_connection.clone();
        changed.port = 2200;
        variants.push(("target port", changed));
        let mut changed = baseline_connection.clone();
        changed.username = "other-operator".to_string();
        variants.push(("target username", changed));
        let mut changed = baseline_connection.clone();
        changed.auth_method = AuthMethod::Key;
        variants.push(("target auth method", changed));
        let mut changed = baseline_connection.clone();
        changed.jump_host.as_mut().unwrap().host = "other-jump.example.test".to_string();
        variants.push(("jump host", changed));
        let mut changed = baseline_connection.clone();
        changed.jump_host.as_mut().unwrap().port = 2201;
        variants.push(("jump port", changed));
        let mut changed = baseline_connection.clone();
        changed.jump_host.as_mut().unwrap().username = "other-jump-user".to_string();
        variants.push(("jump username", changed));
        let mut changed = baseline_connection.clone();
        changed.jump_host.as_mut().unwrap().auth_method = AuthMethod::Password;
        variants.push(("jump auth method", changed));
        let mut changed = baseline_connection.clone();
        changed.jump_host = None;
        variants.push(("jump removal", changed));

        for (label, changed_connection) in variants {
            let error = baseline
                .validate_connection(&changed_connection)
                .expect_err("identity drift must fail closed");
            assert_eq!(
                error.category,
                ExecutionErrorCategory::TargetMismatch,
                "{label}"
            );

            let changed =
                FrozenTargetIdentity::from_connection("profile-1".to_string(), &changed_connection)
                    .expect("freeze changed identity");
            assert_ne!(baseline.identity_digest, changed.identity_digest, "{label}");
        }

        let changed_profile =
            FrozenTargetIdentity::from_connection("profile-2".to_string(), &baseline_connection)
                .expect("freeze changed profile identity");
        assert_ne!(baseline.identity_digest, changed_profile.identity_digest);
    }

    #[test]
    fn target_digest_tampering_has_stable_mismatch_category() {
        let mut request = valid_request();
        request.target.identity_digest = "sha256-v1:tampered".to_string();
        let error = request.validate().expect_err("reject tampered digest");
        assert_eq!(error.category, ExecutionErrorCategory::TargetMismatch);
        assert_eq!(
            error.message,
            "frozen target identity digest does not match its fields"
        );
    }

    #[test]
    fn known_secret_values_include_target_jump_and_command_secrets() {
        let request = valid_request();
        let secrets = request.known_secret_values();
        for expected in [
            "target-password",
            "target-private-key",
            "target-passphrase",
            "jump-password",
            "jump-private-key",
            "jump-passphrase",
        ] {
            assert!(secrets.iter().any(|secret| secret == expected));
        }
    }

    #[test]
    fn reviewed_command_debug_never_contains_command_or_secrets() {
        let command = ReviewedSshCommand::new(
            "printf target-password".to_string(),
            "printf <keychain://profile/password>".to_string(),
            vec!["target-password".to_string()],
        )
        .expect("review command");
        let debug = format!("{command:?}");
        assert!(!debug.contains("target-password"));
        assert!(!debug.contains("printf target-password"));
        assert!(debug.contains("redaction_value_count"));
    }
}
