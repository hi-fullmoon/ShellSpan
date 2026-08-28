use crate::runbook::{contains_secret_literal, RunbookRisk};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use url::Url;

const MAX_DOCUMENT_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DeploymentRunbookKindV2 {
    Deployment,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DeploymentArtifactKindV2 {
    File,
    Archive,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DeploymentArchiveFormatV2 {
    Tar,
    TarGz,
    Zip,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DeploymentActivationStrategyV2 {
    AtomicSymlinkSwap,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DeploymentServiceManagerV2 {
    Systemd,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DeploymentServiceActionKindV2 {
    Start,
    Restart,
    Reload,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DeploymentHealthCheckKindV2 {
    Http,
    Service,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DeploymentExpectedServiceStateV2 {
    Active,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DeploymentRollbackStrategyV2 {
    ReactivatePreviousRelease,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DeploymentApprovalModeV2 {
    Explicit,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DeploymentRollbackApprovalModeV2 {
    Separate,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DeploymentDestructiveApprovalModeV2 {
    DoubleConfirmation,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DeploymentTargetBindingV2 {
    FrozenProfile,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeploymentIdentityV2 {
    pub(crate) id: String,
    pub(crate) application_id: String,
    pub(crate) environment: String,
    pub(crate) version: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeploymentArtifactUnpackV2 {
    pub(crate) format: DeploymentArchiveFormatV2,
    pub(crate) destination_path: String,
    pub(crate) strip_components: u8,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeploymentArtifactV2 {
    pub(crate) id: String,
    pub(crate) description: String,
    pub(crate) kind: DeploymentArtifactKindV2,
    pub(crate) source_uri: String,
    pub(crate) sha256: String,
    pub(crate) target_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) size_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) credential_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) unpack: Option<DeploymentArtifactUnpackV2>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeploymentReleaseV2 {
    pub(crate) root_directory: String,
    pub(crate) releases_directory: String,
    pub(crate) release_directory: String,
    pub(crate) active_symlink: String,
    pub(crate) activation_strategy: DeploymentActivationStrategyV2,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeploymentServiceV2 {
    pub(crate) id: String,
    pub(crate) manager: DeploymentServiceManagerV2,
    pub(crate) unit: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeploymentServiceActionV2 {
    pub(crate) id: String,
    pub(crate) service_id: String,
    pub(crate) action: DeploymentServiceActionKindV2,
    pub(crate) risk: RunbookRisk,
    pub(crate) timeout_seconds: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeploymentHealthCheckV2 {
    pub(crate) id: String,
    pub(crate) kind: DeploymentHealthCheckKindV2,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) expected_status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) service_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) expected_state: Option<DeploymentExpectedServiceStateV2>,
    pub(crate) timeout_seconds: u64,
    pub(crate) attempts: u8,
    pub(crate) interval_seconds: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeploymentVerificationV2 {
    pub(crate) checks: Vec<DeploymentHealthCheckV2>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeploymentRollbackV2 {
    pub(crate) strategy: DeploymentRollbackStrategyV2,
    pub(crate) service_actions: Vec<DeploymentServiceActionV2>,
    pub(crate) verification_check_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeploymentSecretReferenceV2 {
    pub(crate) id: String,
    pub(crate) keychain_ref: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeploymentApprovalPolicyV2 {
    deployment: DeploymentApprovalModeV2,
    rollback: DeploymentRollbackApprovalModeV2,
    destructive: DeploymentDestructiveApprovalModeV2,
    target_binding: DeploymentTargetBindingV2,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeploymentSecurityV2 {
    pub(crate) declared_risk: RunbookRisk,
    pub(crate) allow_privilege_escalation: bool,
    pub(crate) approval: DeploymentApprovalPolicyV2,
    pub(crate) secret_refs: Vec<DeploymentSecretReferenceV2>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeploymentRunbookDocumentV2 {
    pub(crate) schema_version: u8,
    pub(crate) kind: DeploymentRunbookKindV2,
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) deployment: DeploymentIdentityV2,
    pub(crate) artifacts: Vec<DeploymentArtifactV2>,
    pub(crate) release: DeploymentReleaseV2,
    pub(crate) services: Vec<DeploymentServiceV2>,
    pub(crate) service_actions: Vec<DeploymentServiceActionV2>,
    pub(crate) verification: DeploymentVerificationV2,
    pub(crate) rollback: DeploymentRollbackV2,
    pub(crate) security: DeploymentSecurityV2,
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.is_ascii()
        && value.chars().enumerate().all(|(index, character)| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || (index > 0 && matches!(character, '.' | '_' | '-'))
        })
}

fn valid_version(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.is_ascii()
        && value.chars().enumerate().all(|(index, character)| {
            character.is_ascii_alphanumeric()
                || (index > 0 && matches!(character, '.' | '_' | '+' | '-'))
        })
}

fn normalize_id(value: &mut String, field: &str) -> Result<(), String> {
    *value = value.trim().to_string();
    if !valid_id(value) {
        return Err(format!(
            "Deployment Runbook v2 {field} has an invalid identifier"
        ));
    }
    Ok(())
}

fn normalize_text(
    value: &mut String,
    field: &str,
    max: usize,
    secret_safe: bool,
) -> Result<(), String> {
    *value = value.trim().to_string();
    if value.is_empty()
        || value.len() > max
        || value.chars().any(|character| {
            (character.is_control() && !matches!(character, '\t' | '\n' | '\r'))
                || character == '\u{7f}'
        })
    {
        return Err(format!("Deployment Runbook v2 {field} is invalid"));
    }
    if secret_safe && contains_deployment_secret_literal(value) {
        return Err(format!(
            "Deployment Runbook v2 {field} appears to contain a literal secret; use security.secretRefs"
        ));
    }
    Ok(())
}

fn contains_deployment_secret_literal(value: &str) -> bool {
    if contains_secret_literal(value) {
        return true;
    }
    let compact = value
        .to_ascii_lowercase()
        .chars()
        .filter(|character| !character.is_ascii_whitespace())
        .collect::<String>();
    [
        "apikey=",
        "apikey:",
        "api_key=",
        "api_key:",
        "api-key=",
        "api-key:",
        "-----beginrsaprivatekey-----",
        "-----beginecprivatekey-----",
        "-----begindsaprivatekey-----",
    ]
    .iter()
    .any(|needle| compact.contains(needle))
}

fn valid_path_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment.len() <= 128
        && segment.is_ascii()
        && segment.chars().enumerate().all(|(index, character)| {
            character.is_ascii_alphanumeric() || (index > 0 && matches!(character, '.' | '_' | '-'))
        })
}

fn normalize_absolute_path(value: &mut String, field: &str) -> Result<(), String> {
    *value = value.trim().to_string();
    if value == "/"
        || !value.starts_with('/')
        || value.ends_with('/')
        || value.contains("//")
        || value.contains('\\')
        || value[1..]
            .split('/')
            .any(|segment| !valid_path_segment(segment))
    {
        return Err(format!(
            "Deployment Runbook v2 {field} must be a normalized absolute POSIX path below /"
        ));
    }
    Ok(())
}

fn normalize_relative_path(value: &mut String, field: &str, allow_dot: bool) -> Result<(), String> {
    *value = value.trim().to_string();
    if allow_dot && value == "." {
        return Ok(());
    }
    if value.starts_with('/')
        || value.ends_with('/')
        || value.contains("//")
        || value.contains('\\')
        || value.split('/').any(|segment| !valid_path_segment(segment))
    {
        return Err(format!(
            "Deployment Runbook v2 {field} must be a normalized relative POSIX path"
        ));
    }
    Ok(())
}

fn strict_child_of(child: &str, parent: &str) -> bool {
    child
        .strip_prefix(parent)
        .is_some_and(|suffix| suffix.starts_with('/'))
}

fn normalize_uri(value: &mut String, field: &str, allowed_schemes: &[&str]) -> Result<(), String> {
    normalize_text(value, field, 2_048, true)?;
    let parsed = Url::parse(value)
        .map_err(|_| format!("Deployment Runbook v2 {field} is not a valid URI"))?;
    if !allowed_schemes.contains(&parsed.scheme()) {
        return Err(format!(
            "Deployment Runbook v2 {field} uses an unsupported scheme"
        ));
    }
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(format!(
            "Deployment Runbook v2 {field} must not contain credentials, query parameters, or fragments"
        ));
    }
    if matches!(parsed.scheme(), "http" | "https") && parsed.host_str().is_none() {
        return Err(format!("Deployment Runbook v2 {field} must include a host"));
    }
    if parsed.scheme() == "file" && parsed.host_str().is_some_and(|host| !host.is_empty()) {
        return Err(format!(
            "Deployment Runbook v2 {field} file URIs must not include a remote host"
        ));
    }
    *value = parsed.to_string();
    Ok(())
}

fn risk_rank(value: RunbookRisk) -> u8 {
    match value {
        RunbookRisk::ReadOnly => 0,
        RunbookRisk::StateChange => 1,
        RunbookRisk::Destructive => 2,
    }
}

fn normalize_service_action(
    action: &mut DeploymentServiceActionV2,
    field: &str,
) -> Result<(), String> {
    normalize_id(&mut action.id, &format!("{field}.id"))?;
    normalize_id(&mut action.service_id, &format!("{field}.serviceId"))?;
    if risk_rank(action.risk) < risk_rank(RunbookRisk::StateChange) {
        return Err(format!(
            "Deployment Runbook v2 {field}.risk understates a mutating service action"
        ));
    }
    if !(1..=300).contains(&action.timeout_seconds) {
        return Err(format!(
            "Deployment Runbook v2 {field}.timeoutSeconds must be from 1 to 300"
        ));
    }
    Ok(())
}

fn insert_unique(ids: &mut HashSet<String>, id: &str, field: &str) -> Result<(), String> {
    if !ids.insert(id.to_string()) {
        return Err(format!(
            "Deployment Runbook v2 {field} contains duplicate id {id}"
        ));
    }
    Ok(())
}

fn validate_and_normalize(
    mut document: DeploymentRunbookDocumentV2,
) -> Result<DeploymentRunbookDocumentV2, String> {
    if document.schema_version != 2 {
        return Err("Deployment Runbook v2 schemaVersion must be 2".to_string());
    }
    let _ = document.kind;
    normalize_id(&mut document.id, "id")?;
    normalize_text(&mut document.name, "name", 200, true)?;
    normalize_text(&mut document.description, "description", 4_000, true)?;

    normalize_id(&mut document.deployment.id, "deployment.id")?;
    normalize_id(
        &mut document.deployment.application_id,
        "deployment.applicationId",
    )?;
    normalize_id(
        &mut document.deployment.environment,
        "deployment.environment",
    )?;
    document.deployment.version = document.deployment.version.trim().to_string();
    if !valid_version(&document.deployment.version) {
        return Err("Deployment Runbook v2 deployment.version is invalid".to_string());
    }

    if document.artifacts.is_empty() || document.artifacts.len() > 16 {
        return Err("Deployment Runbook v2 artifacts must contain 1-16 entries".to_string());
    }
    let mut artifact_ids = HashSet::new();
    let mut artifact_paths = HashSet::new();
    for (index, artifact) in document.artifacts.iter_mut().enumerate() {
        let field = format!("artifacts[{index}]");
        normalize_id(&mut artifact.id, &format!("{field}.id"))?;
        insert_unique(&mut artifact_ids, &artifact.id, "artifacts")?;
        normalize_text(
            &mut artifact.description,
            &format!("{field}.description"),
            4_000,
            true,
        )?;
        normalize_uri(
            &mut artifact.source_uri,
            &format!("{field}.sourceUri"),
            &["https", "file"],
        )?;
        artifact.sha256 = artifact.sha256.trim().to_string();
        if artifact.sha256.len() != 64
            || !artifact
                .sha256
                .chars()
                .all(|character| character.is_ascii_digit() || ('a'..='f').contains(&character))
        {
            return Err(format!(
                "Deployment Runbook v2 {field}.sha256 must be a lowercase SHA-256 digest"
            ));
        }
        normalize_relative_path(
            &mut artifact.target_path,
            &format!("{field}.targetPath"),
            false,
        )?;
        if !artifact_paths.insert(artifact.target_path.clone()) {
            return Err(format!(
                "Deployment Runbook v2 artifacts contains duplicate targetPath {}",
                artifact.target_path
            ));
        }
        if artifact
            .size_bytes
            .is_some_and(|size| !(1..=10_000_000_000_000).contains(&size))
        {
            return Err(format!(
                "Deployment Runbook v2 {field}.sizeBytes is invalid"
            ));
        }
        if let Some(reference) = artifact.credential_ref.as_mut() {
            normalize_id(reference, &format!("{field}.credentialRef"))?;
        }
        match (artifact.kind, artifact.unpack.as_mut()) {
            (DeploymentArtifactKindV2::Archive, Some(unpack)) => {
                normalize_relative_path(
                    &mut unpack.destination_path,
                    &format!("{field}.unpack.destinationPath"),
                    true,
                )?;
                if unpack.strip_components > 16 {
                    return Err(format!(
                        "Deployment Runbook v2 {field}.unpack.stripComponents is invalid"
                    ));
                }
            }
            (DeploymentArtifactKindV2::Archive, None) => {
                return Err(format!(
                    "Deployment Runbook v2 {field}.unpack is required for archive artifacts"
                ));
            }
            (DeploymentArtifactKindV2::File, Some(_)) => {
                return Err(format!(
                    "Deployment Runbook v2 {field}.unpack is not allowed for file artifacts"
                ));
            }
            (DeploymentArtifactKindV2::File, None) => {}
        }
    }

    normalize_absolute_path(
        &mut document.release.root_directory,
        "release.rootDirectory",
    )?;
    normalize_absolute_path(
        &mut document.release.releases_directory,
        "release.releasesDirectory",
    )?;
    normalize_absolute_path(
        &mut document.release.release_directory,
        "release.releaseDirectory",
    )?;
    normalize_absolute_path(
        &mut document.release.active_symlink,
        "release.activeSymlink",
    )?;
    if !strict_child_of(
        &document.release.releases_directory,
        &document.release.root_directory,
    ) {
        return Err(
            "Deployment Runbook v2 release.releasesDirectory must be below rootDirectory"
                .to_string(),
        );
    }
    if !strict_child_of(
        &document.release.release_directory,
        &document.release.releases_directory,
    ) {
        return Err(
            "Deployment Runbook v2 release.releaseDirectory must be below releasesDirectory"
                .to_string(),
        );
    }
    if document.release.release_directory.rsplit('/').next()
        != Some(document.deployment.id.as_str())
    {
        return Err(
            "Deployment Runbook v2 release.releaseDirectory must end with deployment.id"
                .to_string(),
        );
    }
    if !strict_child_of(
        &document.release.active_symlink,
        &document.release.root_directory,
    ) || strict_child_of(
        &document.release.active_symlink,
        &document.release.releases_directory,
    ) {
        return Err("Deployment Runbook v2 release.activeSymlink must be below rootDirectory and outside releasesDirectory".to_string());
    }

    if document.services.len() > 16 || document.service_actions.len() > 32 {
        return Err("Deployment Runbook v2 service count is invalid".to_string());
    }
    let mut service_ids = HashSet::new();
    for (index, service) in document.services.iter_mut().enumerate() {
        let field = format!("services[{index}]");
        normalize_id(&mut service.id, &format!("{field}.id"))?;
        insert_unique(&mut service_ids, &service.id, "services")?;
        service.unit = service.unit.trim().to_string();
        if !service.unit.ends_with(".service")
            || service.unit.len() > 200
            || !service.unit.is_ascii()
            || !service
                .unit
                .chars()
                .enumerate()
                .all(|(position, character)| {
                    character.is_ascii_alphanumeric()
                        || (position > 0 && matches!(character, '@' | '_' | '.' | ':' | '-'))
                })
        {
            return Err(format!(
                "Deployment Runbook v2 {field}.unit is not a valid systemd service unit"
            ));
        }
    }

    let mut forward_action_ids = HashSet::new();
    for (index, action) in document.service_actions.iter_mut().enumerate() {
        let field = format!("serviceActions[{index}]");
        normalize_service_action(action, &field)?;
        insert_unique(&mut forward_action_ids, &action.id, "serviceActions")?;
        if !service_ids.contains(action.service_id.as_str()) {
            return Err(format!(
                "Deployment Runbook v2 service action {} references unknown service {}",
                action.id, action.service_id
            ));
        }
    }

    if document.verification.checks.is_empty() || document.verification.checks.len() > 16 {
        return Err(
            "Deployment Runbook v2 verification.checks must contain 1-16 entries".to_string(),
        );
    }
    let mut health_ids = HashSet::new();
    for (index, check) in document.verification.checks.iter_mut().enumerate() {
        let field = format!("verification.checks[{index}]");
        normalize_id(&mut check.id, &format!("{field}.id"))?;
        insert_unique(&mut health_ids, &check.id, "verification.checks")?;
        if !(1..=300).contains(&check.timeout_seconds)
            || !(1..=60).contains(&check.attempts)
            || !(1..=300).contains(&check.interval_seconds)
        {
            return Err(format!("Deployment Runbook v2 {field} timing is invalid"));
        }
        match check.kind {
            DeploymentHealthCheckKindV2::Http => {
                if check.service_id.is_some() || check.expected_state.is_some() {
                    return Err(format!(
                        "Deployment Runbook v2 {field} mixes HTTP and service fields"
                    ));
                }
                let url = check
                    .url
                    .as_mut()
                    .ok_or_else(|| format!("Deployment Runbook v2 {field}.url is required"))?;
                normalize_uri(url, &format!("{field}.url"), &["http", "https"])?;
                if !check
                    .expected_status
                    .is_some_and(|status| (200..=399).contains(&status))
                {
                    return Err(format!(
                        "Deployment Runbook v2 {field}.expectedStatus is invalid"
                    ));
                }
            }
            DeploymentHealthCheckKindV2::Service => {
                if check.url.is_some() || check.expected_status.is_some() {
                    return Err(format!(
                        "Deployment Runbook v2 {field} mixes service and HTTP fields"
                    ));
                }
                let service_id = check.service_id.as_mut().ok_or_else(|| {
                    format!("Deployment Runbook v2 {field}.serviceId is required")
                })?;
                normalize_id(service_id, &format!("{field}.serviceId"))?;
                if !service_ids.contains(service_id.as_str()) {
                    return Err(format!(
                        "Deployment Runbook v2 health check {} references unknown service {}",
                        check.id, service_id
                    ));
                }
                if check.expected_state.is_none() {
                    return Err(format!(
                        "Deployment Runbook v2 {field}.expectedState is required"
                    ));
                }
            }
        }
    }

    if document.rollback.service_actions.len() > 32
        || document.rollback.verification_check_ids.is_empty()
        || document.rollback.verification_check_ids.len() > 16
    {
        return Err("Deployment Runbook v2 rollback is incomplete".to_string());
    }
    let mut rollback_action_ids = HashSet::new();
    for (index, action) in document.rollback.service_actions.iter_mut().enumerate() {
        let field = format!("rollback.serviceActions[{index}]");
        normalize_service_action(action, &field)?;
        insert_unique(
            &mut rollback_action_ids,
            &action.id,
            "rollback.serviceActions",
        )?;
        if forward_action_ids.contains(action.id.as_str()) {
            return Err(format!(
                "Deployment Runbook v2 rollback service action id {} must be distinct",
                action.id
            ));
        }
        if !service_ids.contains(action.service_id.as_str()) {
            return Err(format!(
                "Deployment Runbook v2 rollback service action {} references unknown service {}",
                action.id, action.service_id
            ));
        }
    }
    let forward_services = document
        .service_actions
        .iter()
        .map(|action| action.service_id.as_str())
        .collect::<HashSet<_>>();
    let rollback_services = document
        .rollback
        .service_actions
        .iter()
        .map(|action| action.service_id.as_str())
        .collect::<HashSet<_>>();
    if forward_services != rollback_services {
        return Err("Deployment Runbook v2 rollback.serviceActions must cover exactly the services changed by serviceActions".to_string());
    }

    let mut rollback_health_ids = HashSet::new();
    for (index, check_id) in document
        .rollback
        .verification_check_ids
        .iter_mut()
        .enumerate()
    {
        normalize_id(check_id, &format!("rollback.verificationCheckIds[{index}]"))?;
        if !rollback_health_ids.insert(check_id.clone()) {
            return Err(
                "Deployment Runbook v2 rollback.verificationCheckIds contains duplicates"
                    .to_string(),
            );
        }
    }
    if health_ids != rollback_health_ids {
        return Err("Deployment Runbook v2 rollback.verificationCheckIds must reference every declared health check exactly once".to_string());
    }

    if document.security.secret_refs.len() > 16 {
        return Err("Deployment Runbook v2 security.secretRefs has too many entries".to_string());
    }
    let mut secret_ids = HashSet::new();
    for (index, secret) in document.security.secret_refs.iter_mut().enumerate() {
        let field = format!("security.secretRefs[{index}]");
        normalize_id(&mut secret.id, &format!("{field}.id"))?;
        insert_unique(&mut secret_ids, &secret.id, "security.secretRefs")?;
        secret.keychain_ref = secret.keychain_ref.trim().to_string();
        let Some(reference_id) = secret.keychain_ref.strip_prefix("keychain://deployment/") else {
            return Err(format!(
                "Deployment Runbook v2 {field}.keychainRef must be an opaque deployment keychain reference"
            ));
        };
        if !valid_id(reference_id) {
            return Err(format!(
                "Deployment Runbook v2 {field}.keychainRef must be an opaque deployment keychain reference"
            ));
        }
    }
    for artifact in &document.artifacts {
        if let Some(reference) = artifact.credential_ref.as_deref() {
            if !secret_ids.contains(reference) {
                return Err(format!(
                    "Deployment Runbook v2 artifact {} references unknown credential {reference}",
                    artifact.id
                ));
            }
        }
    }

    let detected_risk = document
        .service_actions
        .iter()
        .chain(document.rollback.service_actions.iter())
        .fold(RunbookRisk::StateChange, |highest, action| {
            if risk_rank(action.risk) > risk_rank(highest) {
                action.risk
            } else {
                highest
            }
        });
    if risk_rank(document.security.declared_risk) < risk_rank(detected_risk) {
        return Err(format!(
            "Deployment Runbook v2 security.declaredRisk understates detected {detected_risk:?} deployment behavior"
        ));
    }
    let _ = (
        document.release.activation_strategy,
        document.rollback.strategy,
        document.security.allow_privilege_escalation,
        &document.security.approval,
    );
    Ok(document)
}

pub(crate) fn parse_deployment_runbook_v2(
    text: &str,
) -> Result<DeploymentRunbookDocumentV2, String> {
    if text.trim().is_empty() || text.len() > MAX_DOCUMENT_BYTES {
        return Err("Deployment Runbook v2 text is empty or exceeds 512 KiB".to_string());
    }
    let document = serde_json::from_str::<DeploymentRunbookDocumentV2>(text)
        .map_err(|error| format!("failed to parse Deployment Runbook v2 JSON: {error}"))?;
    validate_and_normalize(document)
}

pub(crate) fn serialize_deployment_runbook_v2(
    document: &DeploymentRunbookDocumentV2,
) -> Result<String, String> {
    let normalized = validate_and_normalize(document.clone())?;
    Ok(format!(
        "{}\n",
        serde_json::to_string_pretty(&normalized).map_err(|error| {
            format!("failed to normalize Deployment Runbook v2 JSON: {error}")
        })?
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use serde_json::Value;
    use std::collections::BTreeMap;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct FixtureEnvelope {
        schema_version: u8,
        cases: Vec<FixtureCase>,
        v1_document: Value,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct FixtureCase {
        name: String,
        valid: bool,
        #[serde(default)]
        value: Option<Value>,
        #[serde(default)]
        derive_from: Option<usize>,
        #[serde(default)]
        patch: BTreeMap<String, Value>,
    }

    fn fixture() -> FixtureEnvelope {
        serde_json::from_str(include_str!(
            "../../tests/fixtures/deployment-runbook/v2/deployment-runbooks.json"
        ))
        .expect("parse shared Deployment Runbook v2 fixture")
    }

    fn apply_patch(root: &mut Value, path: &str, replacement: Value) {
        let parts = path.split('.').collect::<Vec<_>>();
        let mut current = root;
        for part in &parts[..parts.len() - 1] {
            current = match current {
                Value::Array(values) => &mut values[part.parse::<usize>().expect("array index")],
                Value::Object(values) => values.get_mut(*part).expect("object patch path"),
                _ => panic!("invalid patch path {path}"),
            };
        }
        let last = parts.last().expect("patch leaf");
        match current {
            Value::Array(values) => {
                values[last.parse::<usize>().expect("array index")] = replacement;
            }
            Value::Object(values) => {
                values.insert((*last).to_string(), replacement);
            }
            _ => panic!("invalid patch leaf {path}"),
        }
    }

    fn materialize(cases: &[FixtureCase], fixture_case: &FixtureCase) -> Value {
        let mut value = fixture_case
            .derive_from
            .and_then(|index| cases[index].value.clone())
            .or_else(|| fixture_case.value.clone())
            .expect("fixture case value");
        for (path, replacement) in &fixture_case.patch {
            apply_patch(&mut value, path, replacement.clone());
        }
        value
    }

    #[test]
    fn shared_fixture_matrix_fails_closed_on_both_contract_boundaries() {
        let fixture = fixture();
        assert_eq!(fixture.schema_version, 2);
        assert_eq!(fixture.v1_document["schemaVersion"], 1);
        for fixture_case in &fixture.cases {
            let value = materialize(&fixture.cases, fixture_case);
            let parsed = parse_deployment_runbook_v2(&value.to_string());
            assert_eq!(
                parsed.is_ok(),
                fixture_case.valid,
                "unexpected result for {}: {parsed:?}",
                fixture_case.name
            );
            if let Ok(document) = parsed {
                assert_eq!(
                    serde_json::to_value(document).expect("serialize parsed document"),
                    value,
                    "normalized fixture changed for {}",
                    fixture_case.name
                );
            }
        }
    }

    #[test]
    fn serialization_is_canonical_and_revalidates_mutated_documents() {
        let fixture = fixture();
        let value = materialize(&fixture.cases, &fixture.cases[0]);
        let document = parse_deployment_runbook_v2(&value.to_string()).expect("valid document");
        let first = serialize_deployment_runbook_v2(&document).expect("serialize document");
        let second = serialize_deployment_runbook_v2(
            &parse_deployment_runbook_v2(&first).expect("reparse canonical document"),
        )
        .expect("serialize canonical document again");
        assert_eq!(first, second);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&first).unwrap(),
            value
        );

        let mut understated = document;
        understated.security.declared_risk = RunbookRisk::ReadOnly;
        assert!(serialize_deployment_runbook_v2(&understated).is_err());
    }

    #[test]
    fn documented_example_is_valid_and_canonical() {
        let source = include_str!("../../docs/examples/deployment-runbook-v2.runbook.json");
        let document = parse_deployment_runbook_v2(source).expect("parse documented example");
        assert_eq!(
            serialize_deployment_runbook_v2(&document).expect("normalize documented example"),
            source
        );
    }
}
