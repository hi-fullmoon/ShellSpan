use super::request::{FrozenJumpHostIdentity, FrozenTargetIdentity, ReviewedSshExecutionRequest};
use super::result::ExecutionErrorCategory;
use crate::db::Database;
use crate::models::AuthMethod;
use serde::Deserialize;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TargetRevalidationError {
    pub(crate) category: ExecutionErrorCategory,
    pub(crate) message: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredJumpHostIdentity {
    host: String,
    port: u16,
    username: String,
    auth_method: AuthMethod,
}

/// Reloads the bound profile and proves its current non-secret identity still
/// matches the reviewed target. No host fallback or active-tab lookup exists.
pub(super) fn revalidate_frozen_target(
    database: &Database,
    request: &ReviewedSshExecutionRequest,
) -> Result<(), TargetRevalidationError> {
    revalidate_frozen_target_identity(database, &request.target, &request.connection)
}

pub(crate) fn revalidate_frozen_target_identity(
    database: &Database,
    target: &FrozenTargetIdentity,
    connection: &crate::models::RemoteConnectionRequest,
) -> Result<(), TargetRevalidationError> {
    target
        .validate_connection(connection)
        .map_err(|error| TargetRevalidationError {
            category: error.category,
            message: error.message.to_string(),
        })?;

    let profile = database
        .get_profile(&target.profile_id)
        .map_err(|_| TargetRevalidationError {
            category: ExecutionErrorCategory::WorkerStopped,
            message: "failed to reload the reviewed target profile".to_string(),
        })?
        .ok_or_else(|| TargetRevalidationError {
            category: ExecutionErrorCategory::TargetNotFound,
            message: "reviewed target profile was not found".to_string(),
        })?;

    let jump_host = profile
        .jump_host_config
        .as_deref()
        .map(|stored| {
            let jump = serde_json::from_str::<StoredJumpHostIdentity>(stored).map_err(|_| {
                TargetRevalidationError {
                    category: ExecutionErrorCategory::TargetMismatch,
                    message: "stored jump-host identity is invalid".to_string(),
                }
            })?;
            FrozenJumpHostIdentity::new(
                jump.host,
                jump.port,
                jump.username,
                jump.auth_method.as_str().to_string(),
            )
            .map_err(|error| TargetRevalidationError {
                category: ExecutionErrorCategory::TargetMismatch,
                message: error.message.to_string(),
            })
        })
        .transpose()?;

    let current = FrozenTargetIdentity::new(
        profile.id,
        profile.host,
        profile.port,
        profile.username,
        profile.auth_method.as_str().to_string(),
        jump_host,
    )
    .map_err(|error| TargetRevalidationError {
        category: ExecutionErrorCategory::TargetMismatch,
        message: error.message.to_string(),
    })?;

    if &current != target {
        return Err(TargetRevalidationError {
            category: ExecutionErrorCategory::TargetMismatch,
            message: "stored profile identity does not match the frozen target".to_string(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::execution::{ExecutionOutputPolicy, ReviewedSshCommand};
    use crate::models::{JumpHostConfig, ProfileAuthMethod, ProfileRow, RemoteConnectionRequest};
    use std::time::Duration;

    fn profile(jump_host_config: Option<String>) -> ProfileRow {
        ProfileRow {
            id: "profile-1".to_string(),
            name: "Reviewed target".to_string(),
            host: "target.example.test".to_string(),
            port: 22,
            username: "operator".to_string(),
            auth_method: ProfileAuthMethod::Password,
            keychain_key_id: None,
            jump_host_config,
            organization_json: None,
            created_at: 1,
            updated_at: 1,
        }
    }

    fn connection(jump_host: Option<JumpHostConfig>) -> RemoteConnectionRequest {
        RemoteConnectionRequest {
            host: "target.example.test".to_string(),
            port: 22,
            username: "operator".to_string(),
            auth_method: AuthMethod::Password,
            password: Some("target-secret".to_string()),
            keychain_key_id: None,
            private_key_data: None,
            passphrase: None,
            jump_host,
        }
    }

    fn request(connection: RemoteConnectionRequest) -> ReviewedSshExecutionRequest {
        ReviewedSshExecutionRequest {
            operation_id: "execution:target-revalidation".to_string(),
            target: FrozenTargetIdentity::from_connection("profile-1".to_string(), &connection)
                .unwrap(),
            connection,
            command: ReviewedSshCommand::new("true".to_string(), "true".to_string(), Vec::new())
                .unwrap(),
            timeout: Duration::from_secs(5),
            output_policy: ExecutionOutputPolicy::default(),
        }
    }

    fn database() -> (tempfile::TempDir, Database) {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::open(&directory.path().join("termbridge.db")).unwrap();
        (directory, database)
    }

    #[test]
    fn missing_profile_has_a_stable_target_not_found_category() {
        let (_directory, database) = database();
        let error = revalidate_frozen_target(&database, &request(connection(None)))
            .expect_err("missing profile must fail closed");
        assert_eq!(error.category, ExecutionErrorCategory::TargetNotFound);
    }

    #[test]
    fn target_and_jump_identity_are_reloaded_from_the_database() {
        let jump = JumpHostConfig {
            host: "jump.example.test".to_string(),
            port: 2222,
            username: "jump-operator".to_string(),
            auth_method: AuthMethod::Key,
            password: Some("jump-secret".to_string()),
            keychain_key_id: Some("jump-key".to_string()),
            private_key_data: None,
            passphrase: None,
        };
        let stored_jump = serde_json::json!({
            "host": jump.host,
            "port": jump.port,
            "username": jump.username,
            "authMethod": jump.auth_method,
            "keychainKeyId": "jump-key"
        })
        .to_string();
        let (_directory, database) = database();
        database
            .insert_profile(&profile(Some(stored_jump)))
            .unwrap();
        let reviewed = request(connection(Some(jump)));
        revalidate_frozen_target(&database, &reviewed).unwrap();

        let mut changed_profile = profile(None);
        changed_profile.host = "changed.example.test".to_string();
        database
            .update_profile("profile-1", &changed_profile)
            .unwrap();
        let error = revalidate_frozen_target(&database, &reviewed)
            .expect_err("profile drift must fail closed before SSH");
        assert_eq!(error.category, ExecutionErrorCategory::TargetMismatch);
    }

    #[test]
    fn malformed_stored_jump_identity_fails_closed() {
        let (_directory, database) = database();
        database
            .insert_profile(&profile(Some("{not-json".to_string())))
            .unwrap();
        let error = revalidate_frozen_target(&database, &request(connection(None)))
            .expect_err("malformed jump identity must not be ignored");
        assert_eq!(error.category, ExecutionErrorCategory::TargetMismatch);
    }
}
