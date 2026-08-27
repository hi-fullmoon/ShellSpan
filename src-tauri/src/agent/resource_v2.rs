use super::protocol_v2::{AgentResourceKindV2, AgentResourceRefV2, ServiceManagerV2};

pub(crate) const MAX_SYSTEMD_SERVICE_UNIT_BYTES_V2: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AgentResourceErrorKindV2 {
    InvalidTarget,
    UnsupportedManager,
    InvalidUnit,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentResourceErrorV2 {
    pub(crate) kind: AgentResourceErrorKindV2,
    pub(crate) message: String,
}

impl AgentResourceErrorV2 {
    fn new(kind: AgentResourceErrorKindV2, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

pub(crate) fn canonical_systemd_service_resource_v2(
    target_digest: &str,
    manager: ServiceManagerV2,
    unit: &str,
) -> Result<AgentResourceRefV2, AgentResourceErrorV2> {
    if !valid_target_digest_v2(target_digest) {
        return Err(AgentResourceErrorV2::new(
            AgentResourceErrorKindV2::InvalidTarget,
            "A P2 resource requires one valid frozen target digest.",
        ));
    }
    if manager != ServiceManagerV2::Systemd {
        return Err(AgentResourceErrorV2::new(
            AgentResourceErrorKindV2::UnsupportedManager,
            "P2 only supports the systemd service manager.",
        ));
    }
    if !valid_canonical_systemd_service_unit_v2(unit) {
        return Err(AgentResourceErrorV2::new(
            AgentResourceErrorKindV2::InvalidUnit,
            "The service unit is not a canonical P2 systemd .service identity.",
        ));
    }

    Ok(AgentResourceRefV2 {
        kind: AgentResourceKindV2::SystemdService,
        identity: format!("systemd:{unit}"),
        target_digest: target_digest.to_string(),
    })
}

pub(crate) fn valid_canonical_systemd_service_unit_v2(unit: &str) -> bool {
    unit.is_ascii()
        && unit.len() <= MAX_SYSTEMD_SERVICE_UNIT_BYTES_V2
        && unit.ends_with(".service")
        && unit.len() > ".service".len()
        && unit
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && !unit.contains("..")
        // Alias/template-instance support remains disabled until a dedicated
        // canonicalization fixture can prove the exact systemd identity.
        && !unit.contains('@')
        && unit
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn valid_target_digest_v2(target_digest: &str) -> bool {
    !target_digest.trim().is_empty()
        && target_digest.len() <= 200
        && !target_digest.chars().any(char::is_control)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_resource_is_derived_from_the_frozen_target_and_plain_unit() {
        assert_eq!(
            canonical_systemd_service_resource_v2(
                "sha256-v1:target",
                ServiceManagerV2::Systemd,
                "nginx.service",
            )
            .unwrap(),
            AgentResourceRefV2 {
                kind: AgentResourceKindV2::SystemdService,
                identity: "systemd:nginx.service".to_string(),
                target_digest: "sha256-v1:target".to_string(),
            }
        );
    }

    #[test]
    fn shell_alias_template_path_and_scope_expansion_never_form_a_resource() {
        for unit in [
            "-nginx.service",
            "nginx@blue.service",
            "nginx.service/other",
            "nginx\\other.service",
            "nginx..service",
            "nginx*.service",
            "nginx service.service",
            "nginx\n.service",
            "服务.service",
            ".service",
        ] {
            assert!(
                canonical_systemd_service_resource_v2(
                    "sha256-v1:target",
                    ServiceManagerV2::Systemd,
                    unit,
                )
                .is_err(),
                "unit {unit:?} must fail closed"
            );
        }
    }
}
