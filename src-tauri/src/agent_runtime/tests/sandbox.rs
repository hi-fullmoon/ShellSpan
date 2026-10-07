use super::*;
use crate::agent_runtime::{AgentRuntimeBuilder, AgentSessionStore, CreateAgentSessionRequest};
use serde_json::json;

#[test]
fn sandbox_backend_refusal_has_typed_not_started_facts() {
    for policy in [AgentSandboxPolicy::ReadOnly, AgentSandboxPolicy::Workspace] {
        let error = host_policy_failure(Some(policy)).unwrap();
        assert_eq!(
            error.kind,
            crate::agent_runtime::AgentExecutionFailureKind::BackendUnavailable
        );
        assert_eq!(
            error.admission,
            crate::agent_runtime::AgentExecutionAdmission::NotStarted
        );
        assert_eq!(error.code, "sandboxBackendUnavailable");
    }
    assert!(host_policy_failure(None).is_none());
    assert!(host_policy_failure(Some(AgentSandboxPolicy::Host)).is_none());
}

fn target(root: Option<&std::path::Path>) -> AgentSessionTarget {
    serde_json::from_value(json!({
        "kind": "local", "targetId": "local", "sessionId": "terminal",
        "cwd": root.map(|path| path.to_str().unwrap()),
    }))
    .unwrap()
}

#[test]
fn sandbox_authorization_status_expires_rebinds_and_never_restores_from_history() {
    use crate::agent_runtime::sandbox_authorization::SessionReadAuthorizations;
    let project = tempfile::tempdir().unwrap();
    let store = AgentSessionStore::default();
    let storage = tempfile::tempdir().unwrap();
    store.configure(storage.path().to_path_buf()).unwrap();
    let header = store
        .create(request(
            "live-status",
            target(Some(project.path())),
            Some(AgentSandboxPolicy::Workspace),
        ))
        .unwrap()
        .header;
    let base = AgentSandboxContract::freeze(
        header.sandbox_policy,
        header.target.as_ref().unwrap(),
        header.execution_surface,
        10,
    )
    .unwrap()
    .bind_to_session(&header);
    let records = SessionReadAuthorizations::default();
    assert_eq!(
        records.status(&header.session_id, &base, 10).unwrap().state,
        "none"
    );
    records
        .remember_resources(
            &header.session_id,
            &header.task_id,
            &base,
            &[],
            &[],
            &[crate::agent_runtime::NetworkTargetRequestNative {
                host: "registry.npmjs.org".into(),
                port: 443,
                resolver: crate::agent_runtime::NetworkResolverNative::Cloudflare,
            }],
            &[crate::agent_runtime::LocalServiceRequestNative { port: 5173 }],
            10,
        )
        .unwrap();
    let status = records.status(&header.session_id, &base, 11).unwrap();
    assert_eq!(status.state, "active");
    assert_eq!(
        status.network_targets[0].resolver,
        crate::agent_runtime::NetworkResolverNative::Cloudflare
    );
    assert_eq!(status.local_services[0].port, 5173);
    let expired = records
        .status(
            &header.session_id,
            &base,
            status.expires_at_unix_ms.unwrap(),
        )
        .unwrap();
    assert_eq!(expired.state, "expired");
    assert!(expired.network_targets.is_empty() && expired.local_services.is_empty());
    let mut rebound = base.clone();
    rebound.binding_revision += 1;
    assert_eq!(
        records
            .status(&header.session_id, &rebound, 11)
            .unwrap()
            .state,
        "none"
    );
    assert_eq!(
        SessionReadAuthorizations::default()
            .status(&header.session_id, &base, 11)
            .unwrap()
            .state,
        "none"
    );
    records.revoke_task(&header.task_id).unwrap();
    assert_eq!(
        records.status(&header.session_id, &base, 11).unwrap().state,
        "none"
    );
}

fn request(
    id: &str,
    target: AgentSessionTarget,
    policy: Option<AgentSandboxPolicy>,
) -> CreateAgentSessionRequest {
    serde_json::from_value(json!({
        "sessionId": id, "taskId": id, "goal": "Inspect project",
        "target": target, "sandboxPolicy": policy,
        "permissionMode": "requestApproval", "executionSurface": "direct",
    }))
    .unwrap()
}

#[test]
fn sandbox_local_project_default_is_intent_and_never_backend_capability() {
    let root = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    let runtime = AgentRuntimeBuilder::new().build();
    runtime.configure(root.path().to_path_buf()).unwrap();
    let snapshot = runtime
        .create_session(request("project", target(Some(project.path())), None))
        .unwrap();
    assert_eq!(
        snapshot.header.sandbox_policy,
        Some(AgentSandboxPolicy::Workspace)
    );
    assert_eq!(
        snapshot.header.permission_mode,
        Some(crate::agent_runtime::AgentSessionPermissionMode::RequestApproval)
    );
    assert_eq!(
        snapshot.sandbox_capability.status,
        if cfg!(target_os = "macos") {
            AgentSandboxCapabilityStatus::Partial
        } else {
            AgentSandboxCapabilityStatus::Unavailable
        }
    );
    assert!(
        snapshot.sandbox_capability.files == cfg!(target_os = "macos")
            && snapshot.sandbox_capability.network == cfg!(target_os = "macos")
            && !snapshot.sandbox_capability.process_lifecycle
    );
    let normalized = std::fs::canonicalize(project.path()).unwrap();
    assert_eq!(
        snapshot.header.target.unwrap().local_root.as_deref(),
        normalized.to_str()
    );
    let events = runtime
        .events(crate::agent_runtime::AgentSessionEventsRequest {
            session_id: "project".into(),
            cursor: None,
            limit: 10,
        })
        .unwrap();
    assert!(matches!(
        &events.events[0].payload,
        crate::agent_runtime::AgentSessionEventPayload::SessionCreated {
            sandbox_policy: Some(AgentSandboxPolicy::Workspace),
            ..
        }
    ));
}

#[test]
fn sandbox_explicit_host_and_remote_defaults_preserve_approval() {
    let root = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    let runtime = AgentRuntimeBuilder::new().build();
    runtime.configure(root.path().to_path_buf()).unwrap();
    let host = runtime
        .create_session(request(
            "host",
            target(Some(project.path())),
            Some(AgentSandboxPolicy::Host),
        ))
        .unwrap();
    assert_eq!(host.header.sandbox_policy, Some(AgentSandboxPolicy::Host));
    let remote = serde_json::from_value(json!({
        "kind": "remote", "targetId": "ssh", "sessionId": "ssh-terminal",
        "host": "localhost", "port": 22, "username": "operator",
    }))
    .unwrap();
    let remote = runtime
        .create_session(request("remote", remote, None))
        .unwrap();
    assert_eq!(remote.header.sandbox_policy, Some(AgentSandboxPolicy::Host));
    assert_eq!(remote.header.permission_mode, host.header.permission_mode);
    assert_eq!(
        remote.sandbox_capability.status,
        AgentSandboxCapabilityStatus::Unavailable
    );
}

#[test]
fn sandbox_legacy_disk_recovery_preserves_absence_and_account_access() {
    let root = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    let store = AgentSessionStore::default();
    store.configure(root.path().to_path_buf()).unwrap();
    store
        .create(request("legacy", target(Some(project.path())), None))
        .unwrap();
    drop(store);
    let recovered = AgentSessionStore::default();
    recovered.configure(root.path().to_path_buf()).unwrap();
    let header = recovered.snapshot("legacy").unwrap().header;
    assert_eq!(header.sandbox_policy, None);
    let frozen = AgentSandboxContract::freeze(
        header.sandbox_policy,
        header.target.as_ref().unwrap(),
        header.execution_surface,
        1,
    )
    .unwrap()
    .bind_to_session(&header);
    frozen.validate_session(&header, 86_400_001).unwrap();
    assert!(frozen.resource_grants.is_empty());
    drop(recovered);
    let runtime = AgentRuntimeBuilder::new().build();
    runtime.configure(root.path().to_path_buf()).unwrap();
    let existing = runtime
        .create_session(request("legacy", target(Some(project.path())), None))
        .unwrap();
    assert_eq!(existing.header.sandbox_policy, None);
    let mut next_target = target(Some(project.path()));
    next_target.target_id = "new-local".into();
    next_target.session_id = "new-terminal".into();
    let mut continuation = request("continued", next_target, None);
    continuation.continued_from_session_id = Some("legacy".into());
    let continued = runtime.create_session(continuation).unwrap();
    assert_eq!(continued.header.sandbox_policy, None);
}

#[test]
fn sandbox_host_frozen_facts_add_no_sixty_second_approval_deadline() {
    for policy in [None, Some(AgentSandboxPolicy::Host)] {
        let target = target(None);
        let frozen =
            AgentSandboxContract::freeze(policy, &target, AgentExecutionSurface::Direct, 1_000)
                .unwrap();
        frozen.authorize_dispatch(&target, 61_001).unwrap();
        frozen.authorize_dispatch(&target, 86_401_000).unwrap();
        assert_eq!(frozen.network, AgentSandboxNetworkPolicy::Account);
    }
}

#[test]
fn sandbox_restricted_policies_never_fall_back_for_local_remote_or_terminal() {
    let project = tempfile::tempdir().unwrap();
    let local = target(Some(project.path()));
    let remote: AgentSessionTarget = serde_json::from_value(json!({
        "kind": "remote", "targetId": "remote", "sessionId": "ssh",
        "host": "localhost", "port": 22, "username": "operator", "rootPath": "/project",
    }))
    .unwrap();
    for target in [local, remote] {
        for policy in [AgentSandboxPolicy::Workspace, AgentSandboxPolicy::ReadOnly] {
            for surface in [
                AgentExecutionSurface::Direct,
                AgentExecutionSurface::BoundTerminal,
            ] {
                let frozen =
                    AgentSandboxContract::freeze(Some(policy), &target, surface, 1).unwrap();
                super::super::verify_native_sandbox_backend();
                if cfg!(target_os = "macos")
                    && target.kind == "local"
                    && surface == AgentExecutionSurface::Direct
                {
                    frozen.authorize_dispatch(&target, 2).unwrap();
                } else {
                    assert!(frozen
                        .authorize_dispatch(&target, 2)
                        .unwrap_err()
                        .starts_with("sandboxBackendUnavailable:"));
                }
                assert_eq!(frozen.network, AgentSandboxNetworkPolicy::Deny);
                assert!(frozen.resource_grants.is_empty());
                if policy == AgentSandboxPolicy::ReadOnly {
                    assert!(frozen.write_allow.is_empty());
                }
            }
        }
    }
}

#[test]
fn sandbox_missing_or_non_directory_project_is_rejected() {
    assert!(AgentSandboxContract::freeze(
        Some(AgentSandboxPolicy::Workspace),
        &target(None),
        AgentExecutionSurface::Direct,
        0
    )
    .unwrap_err()
    .starts_with("sandboxWorkspaceMissing:"));
    let file = tempfile::NamedTempFile::new().unwrap();
    assert!(AgentSandboxContract::freeze(
        Some(AgentSandboxPolicy::Workspace),
        &target(Some(file.path())),
        AgentExecutionSurface::Direct,
        0
    )
    .unwrap_err()
    .starts_with("sandboxWorkspaceInvalid:"));
}

#[test]
fn sandbox_latest_session_binding_is_checked_instead_of_self_comparison() {
    let root = tempfile::tempdir().unwrap();
    let store = AgentSessionStore::default();
    store.configure(root.path().to_path_buf()).unwrap();
    let original = target(None);
    let header = store
        .create(request(
            "bound",
            original.clone(),
            Some(AgentSandboxPolicy::Host),
        ))
        .unwrap()
        .header;
    let frozen = AgentSandboxContract::freeze(
        header.sandbox_policy,
        &original,
        header.execution_surface,
        1,
    )
    .unwrap()
    .bind_to_session(&header);
    frozen.validate_session(&header, 2).unwrap();
    for change in [
        "session",
        "account",
        "host",
        "root",
        "surface",
        "policy",
        "revision",
        "incarnation",
    ] {
        let mut changed = header.clone();
        let target = changed.target.as_mut().unwrap();
        match change {
            "session" => target.session_id = "new-terminal".into(),
            "account" => target.username = Some("other-account".into()),
            "host" => target.host = Some("other-host".into()),
            "root" => target.cwd = Some("/other-project".into()),
            "surface" => changed.execution_surface = AgentExecutionSurface::BoundTerminal,
            "policy" => changed.sandbox_policy = Some(AgentSandboxPolicy::Workspace),
            "revision" => changed.sandbox_binding_revision += 1,
            "incarnation" => changed.created_at_unix_ms += 1,
            _ => unreachable!(),
        }
        assert!(
            frozen
                .validate_session(&changed, 2)
                .unwrap_err()
                .starts_with("sandboxAuthorizationInvalid:"),
            "change: {change}"
        );
    }
}

#[test]
fn sandbox_binding_revision_invalidates_switch_back_and_survives_real_disk_replay() {
    use crate::agent_runtime::AgentSessionEventPayload;
    let root = tempfile::tempdir().unwrap();
    let store = AgentSessionStore::default();
    store.configure(root.path().to_path_buf()).unwrap();
    let header = store
        .create(request(
            "binding",
            target(None),
            Some(AgentSandboxPolicy::Host),
        ))
        .unwrap()
        .header;
    let frozen = AgentSandboxContract::freeze(
        header.sandbox_policy,
        header.target.as_ref().unwrap(),
        header.execution_surface,
        1,
    )
    .unwrap()
    .bind_to_session(&header);
    for surface in [
        AgentExecutionSurface::BoundTerminal,
        AgentExecutionSurface::Direct,
    ] {
        store
            .append(
                "binding",
                None,
                None,
                AgentSessionEventPayload::SessionExecutionSurfaceChanged { surface },
            )
            .unwrap();
    }
    let changed = store.snapshot("binding").unwrap().header;
    assert_eq!(changed.target, header.target);
    assert_eq!(changed.execution_surface, header.execution_surface);
    assert!(changed.sandbox_binding_revision > header.sandbox_binding_revision);
    assert!(frozen
        .validate_session(&changed, 2)
        .unwrap_err()
        .starts_with("sandboxAuthorizationInvalid:"));
    drop(store);
    let restored = AgentSessionStore::default();
    restored.configure(root.path().to_path_buf()).unwrap();
    assert_eq!(
        restored
            .snapshot("binding")
            .unwrap()
            .header
            .sandbox_binding_revision,
        changed.sandbox_binding_revision
    );
}

#[test]
fn sandbox_resource_grants_expire_without_refreshing_frozen_facts() {
    let target = target(None);
    let mut frozen = AgentSandboxContract::freeze(
        Some(AgentSandboxPolicy::Host),
        &target,
        AgentExecutionSurface::Direct,
        1,
    )
    .unwrap();
    frozen.resource_grants.push(AgentSandboxResourceGrant {
        authorization_id: "grant".into(),
        session_id: "session".into(),
        call_id: Some("call".into()),
        target: target.clone(),
        issued_at_unix_ms: 10,
        expires_at_unix_ms: 20,
        source: "explicit-human".into(),
        resource: AgentSandboxResource::WritePath {
            path: "/cache".into(),
        },
    });
    assert!(frozen.authorize_dispatch(&target, 9).is_err());
    frozen.authorize_dispatch(&target, 10).unwrap();
    frozen
        .authorize_call("session", "call", &target, 10)
        .unwrap();
    assert!(frozen
        .authorize_call("other-session", "call", &target, 10)
        .is_err());
    assert!(frozen
        .authorize_call("session", "other-call", &target, 10)
        .is_err());
    assert!(frozen.authorize_dispatch(&target, 20).is_err());
    assert_eq!(frozen.resource_grants[0].expires_at_unix_ms, 20);
    let recovered = AgentSandboxContract::freeze(
        Some(AgentSandboxPolicy::Host),
        &target,
        AgentExecutionSurface::Direct,
        21,
    )
    .unwrap();
    assert!(recovered.resource_grants.is_empty());
}

#[test]
fn sandbox_restricted_start_and_disk_restore_refuse_before_model_or_native_dispatch() {
    let root = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    let runtime = AgentRuntimeBuilder::new().build();
    runtime.configure(root.path().to_path_buf()).unwrap();
    let mut restricted = request("restricted", target(Some(project.path())), None);
    restricted.execution_surface = AgentExecutionSurface::BoundTerminal;
    runtime.create_session(restricted).unwrap();
    let provider = || {
        serde_json::from_value(json!({
            "id": "local-ollama", "profile": "ollama", "kind": "ollama",
            "baseUrl": "http://127.0.0.1:11434", "model": "llama3.2", "requiresApiKey": false,
        }))
        .unwrap()
    };
    assert!(runtime
        .start("restricted", provider(), None)
        .unwrap_err()
        .starts_with("sandboxBackendUnavailable:"));
    assert_eq!(
        runtime.session("restricted").unwrap().header.sandbox_policy,
        Some(AgentSandboxPolicy::Workspace)
    );
    drop(runtime);
    let restored = AgentRuntimeBuilder::new().build();
    restored.configure(root.path().to_path_buf()).unwrap();
    assert!(restored
        .start("restricted", provider(), None)
        .unwrap_err()
        .starts_with("sandboxBackendUnavailable:"));
    let events = restored
        .events(crate::agent_runtime::AgentSessionEventsRequest {
            session_id: "restricted".into(),
            cursor: None,
            limit: 100,
        })
        .unwrap()
        .events;
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(
                event.payload,
                crate::agent_runtime::AgentSessionEventPayload::SandboxStartRejected { .. }
            ))
            .count(),
        2
    );
    assert!(!events.iter().any(|event| matches!(
        event.payload,
        crate::agent_runtime::AgentSessionEventPayload::ToolExecution { .. }
            | crate::agent_runtime::AgentSessionEventPayload::RequestStart { .. }
    )));
}

#[test]
fn sandbox_wire_policy_is_independent_and_rejects_unknown_values() {
    for (policy, wire) in [
        (AgentSandboxPolicy::ReadOnly, "readOnly"),
        (AgentSandboxPolicy::Workspace, "workspace"),
        (AgentSandboxPolicy::Host, "host"),
    ] {
        assert_eq!(serde_json::to_value(policy).unwrap(), wire);
        assert_eq!(
            serde_json::from_value::<AgentSandboxPolicy>(json!(wire)).unwrap(),
            policy
        );
    }
    assert!(serde_json::from_value::<AgentSandboxPolicy>(json!("operator")).is_err());
    assert!(serde_json::from_value::<AgentSandboxPolicy>(json!("full")).is_err());
}

#[test]
fn sandbox_unsupported_network_protocols_and_nonloopback_services_are_rejected() {
    let project = tempfile::tempdir().unwrap();
    let target = target(Some(project.path()));
    for resource in [
        AgentSandboxResource::NetworkTarget {
            protocol: "https".into(),
            host: "example.com".into(),
            port: 443,
            allow_redirects: false,
            resolver: Default::default(),
        },
        AgentSandboxResource::LocalService {
            address: "0.0.0.0".into(),
            port: 8080,
        },
    ] {
        let mut contract = AgentSandboxContract::freeze(
            Some(AgentSandboxPolicy::Workspace),
            &target,
            AgentExecutionSurface::Direct,
            10,
        )
        .unwrap();
        contract.resource_grants.push(AgentSandboxResourceGrant {
            authorization_id: "not-issued-network-request".into(),
            session_id: "session".into(),
            call_id: Some("call".into()),
            target: target.clone(),
            issued_at_unix_ms: 10,
            expires_at_unix_ms: 20,
            source: "native-approved-call".into(),
            resource,
        });
        assert!(contract
            .authorize_dispatch(&target, 10)
            .unwrap_err()
            .starts_with("sandboxPolicyUnsupported:"));
    }
}
