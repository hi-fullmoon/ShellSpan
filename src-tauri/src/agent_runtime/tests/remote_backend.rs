use super::*;
use crate::execution::ExecutionCancellationRegistry;
use serde_json::json;

fn header() -> AgentSessionHeader {
    serde_json::from_value(json!({
        "sessionId": "remote-probe-session", "taskId": "remote-probe-task",
        "goal": "Inspect remote infrastructure", "executionSurface": "direct",
        "createdAtUnixMs": 1, "sandboxPolicy": "host",
        "target": { "kind": "remote", "targetId": "fixture-target", "sessionId": "fixture-ssh",
            "profileId": "sandbox-phase4", "host": "127.0.0.1", "port": 22226, "username": "shellspan" }
    })).unwrap()
}

#[test]
fn cancellation_ids_are_scoped_and_cannot_cancel_other_execution_entries() {
    let request = uuid::Uuid::new_v4().to_string();
    let a = probe_operation_id("a", &request).unwrap();
    let b = probe_operation_id("b", &request).unwrap();
    assert_ne!(a, b);
    assert!(a.starts_with("sandbox-probe-"));
    assert!(probe_operation_id("a", "deployment-run-1").is_err());
    let registry = ExecutionCancellationRegistry::default();
    let _a = registry.register(a.clone()).unwrap();
    assert!(registry.cancel(&b).is_err());
    registry.cancel(&a).unwrap();
}

#[test]
fn installed_backend_never_becomes_workspace_verification_or_authorization() {
    // Wire contract facts only; this does not simulate an SSH executor.
    let result = probe_from_facts(
        &header(),
        InfrastructureFacts {
            platform: "linux".into(),
            backend: Some("bubblewrap".into()),
            installed: true,
            launcher_available: true,
        },
    )
    .unwrap();
    assert!(!result.workspace_verified && !result.admission_enabled);
    assert!(result.infrastructure_available && result.launcher_available);
    assert_eq!(result.target, header().target.unwrap());
    assert!(!result.gaps.is_empty());
    assert!(serde_json::from_value::<InfrastructureFacts>(json!({
        "platform":"linux","backend":"bubblewrap","installed":true,
        "launcherAvailable":true,"admissionEnabled":true
    }))
    .is_err());
    assert!(probe_from_facts(
        &header(),
        InfrastructureFacts {
            platform: "linux".into(),
            backend: Some("seatbelt".into()),
            installed: true,
            launcher_available: true,
        }
    )
    .is_err());
}

#[test]
#[ignore = "requires explicit project-owned ordinary-permission SSH phase 4 fixture"]
fn remote_backend_real_ssh_probe_reconnect_and_profile_account_drift() {
    let connection = crate::execution::fixture::isolated_ssh_connection();
    let (_trust, known_hosts) =
        crate::connection::trusted_known_hosts_fixture(&connection.host, connection.port);
    let temp = tempfile::tempdir().unwrap();
    let database = Database::open(&temp.path().join("fixture.db")).unwrap();
    let credentials = CredentialManager::in_memory_for_tests();
    credentials
        .store_profile_password("sandbox-phase4", connection.password.as_deref().unwrap())
        .unwrap();
    let mut profile = crate::models::ProfileRow {
        id: "sandbox-phase4".into(),
        name: "Stage 4 isolated SSH".into(),
        host: connection.host.clone(),
        port: connection.port,
        username: connection.username.clone(),
        auth_method: crate::models::ProfileAuthMethod::Password,
        keychain_key_id: None,
        jump_host_config: None,
        organization_json: None,
        created_at: 1,
        updated_at: 1,
    };
    database.insert_profile(&profile).unwrap();
    let mut header = header();
    let target = header.target.as_mut().unwrap();
    target.host = Some(connection.host.clone());
    target.port = Some(connection.port);
    target.username = Some(connection.username.clone());
    let native = AgentToolTargetNative::Remote {
        target_id: target.target_id.clone(),
        session_id: target.session_id.clone(),
        profile_id: target.profile_id.clone(),
        host: connection.host.clone(),
        port: connection.port,
        username: connection.username.clone(),
        root_path: None,
        local_root: None,
    };
    let cancellations = ExecutionCancellationRegistry::default();
    // Each call opens a fresh, authenticated SSH session. No result/grant is
    // cached and the profile is read again on every operation.
    for _ in 0..2 {
        let id = uuid::Uuid::new_v4().to_string();
        let cancel = cancellations
            .register(probe_operation_id(&header.session_id, &id).unwrap())
            .unwrap();
        let result = probe_remote_backend(
            &header,
            &native,
            &database,
            &credentials,
            cancel,
            &known_hosts,
            &id,
        )
        .unwrap();
        assert_eq!(result.execution_os, "linux");
        assert!(result.infrastructure_available);
        assert!(!result.launcher_available, "ordinary Docker fixture unexpectedly permits namespaces; update acceptance evidence before opening any gate");
        assert!(!result.workspace_verified && !result.admission_enabled);
    }
    profile.username = "shellspan-sh".into();
    database.update_profile(&profile.id, &profile).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let cancel = cancellations
        .register(probe_operation_id(&header.session_id, &id).unwrap())
        .unwrap();
    let error = probe_remote_backend(
        &header,
        &native,
        &database,
        &credentials,
        cancel,
        &known_hosts,
        &id,
    )
    .unwrap_err();
    assert!(error.contains("identity drifted"));
}
