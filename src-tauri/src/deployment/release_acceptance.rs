//! Full native coordinator acceptance. Source is a disposable copy of the real
//! project; SQLite, keychain, Docker, SSH, SFTP and HTTP are all real.
use super::docker_compose_executor::{
    docker_compose_executor_registry, NativeDockerComposeBackend,
};
use super::run_coordinator::*;
use super::workflow_schema::{ImmutableRunPlan, WorkflowRunOperationKind, WorkflowRunTriggerKind};
use super::{applications::*, deployment_files, readiness, source_binding};
use crate::db::Database;
use rusqlite::params;
use std::{collections::BTreeMap, io::Read, path::Path, sync::Arc};

fn git(root: &Path, args: &[&str]) {
    let result = super::docker_compose_executor::safe_local_command("git")
        .args(args)
        .current_dir(root)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}

fn remote(session: &ssh2::Session, command: &str) -> String {
    let mut channel = session.channel_session().unwrap();
    channel.exec(command).unwrap();
    let mut output = String::new();
    channel.read_to_string(&mut output).unwrap();
    let mut error = String::new();
    channel.stderr().read_to_string(&mut error).unwrap();
    channel.wait_close().unwrap();
    assert_eq!(channel.exit_status().unwrap(), 0, "{command}: {error}");
    output
}

struct FixtureCredential(crate::keychain::CredentialManager, String);
impl Drop for FixtureCredential {
    fn drop(&mut self) {
        let _ = self.0.delete_profile_password(&self.1);
    }
}

#[tokio::test]
#[ignore = "requires real for-you source and isolated Linux Docker/SSH fixture"]
async fn real_application_release_acceptance() {
    real_release_acceptance(false).await;
}

#[tokio::test]
#[ignore = "requires real for-you source and isolated Linux Docker/SSH fixture"]
async fn real_application_recovery_acceptance() {
    real_release_acceptance(true).await;
}

async fn real_release_acceptance(recovery: bool) {
    let project = std::env::var("SHELLSPAN_PHASE3_PROJECT").expect("real project required");
    let mut original_binding = source_binding::inspect(Path::new(&project))
        .unwrap()
        .binding;
    original_binding.included_untracked = serde_json::from_str(
        &std::env::var("SHELLSPAN_PHASE3_INCLUDED_UNTRACKED").unwrap_or_else(|_| "[]".into()),
    )
    .unwrap();
    original_binding.excluded_paths = vec![
        ".claude".into(),
        ".agents".into(),
        ".codex".into(),
        "data".into(),
        ".env.example".into(),
    ];
    let original = source_binding::capture(&original_binding).unwrap();
    let copy = source_binding::materialize(original.directory.path()).unwrap();
    git(copy.path(), &["init", "--quiet"]);
    git(copy.path(), &["add", "."]);
    git(
        copy.path(),
        &[
            "-c",
            "user.name=ShellSpan acceptance",
            "-c",
            "user.email=acceptance@localhost",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--quiet",
            "-m",
            "Isolated real project source",
        ],
    );
    let source = source_binding::inspect(copy.path()).unwrap().binding;
    let storage = tempfile::tempdir().unwrap();
    let database = Database::open(&storage.path().join("release.db")).unwrap();
    let runtime =
        super::runtime::DeploymentWorkflowRuntime::enabled_for_tests(storage.path()).unwrap();
    let connection = crate::execution::fixture::isolated_ssh_connection();
    assert_eq!(connection.host, "127.0.0.1");
    assert_eq!(connection.port, 22224);
    let profile_id = format!("phase3-{}", uuid::Uuid::new_v4());
    database.with_connection(|db| {
        db.execute("INSERT INTO profiles (id,name,host,port,username,auth_method,created_at,updated_at) VALUES (?1,'Isolated Linux',?2,?3,?4,'password',1,1)", params![profile_id, connection.host, connection.port, connection.username]).map_err(|e|e.to_string())?;
        Ok(())
    }).unwrap();
    let (_trust, known_hosts) =
        crate::connection::trusted_known_hosts_fixture(&connection.host, connection.port);
    let session = crate::execution::open_ssh_execution_session(&connection, &known_hosts).unwrap();
    let application_id = uuid::Uuid::new_v4().to_string();
    let project_name = format!("phase3-{}", &application_id[..8]);
    let root = format!("/srv/shellspan-deployment/{project_name}");
    // This is an explicitly authorized fixture setup, not onboarding behavior.
    remote(&session.target, &format!("mkdir -p {root}"));
    if recovery {
        remote(
            &session.target,
            &format!("mkdir -p {root}-data; chmod 770 {root}-data"),
        );
    }
    let mut entry = ApplicationEntry {
        application: Application {
            id: application_id.clone(),
            name: "for-you release acceptance".into(),
            source_binding_id: source.id.clone(),
            revision: 0,
            archived: false,
        },
        source,
        environment: Environment {
            id: uuid::Uuid::new_v4().to_string(),
            application_id,
            name: "Isolated Linux".into(),
            revision: 0,
            workflow_id: None,
            config: EnvironmentConfig {
                template_kind: "dockerCompose".into(),
                connection_profile_id: profile_id.clone(),
                remote_root: root.clone(),
                platform: "linux/arm64".into(),
                project_name: project_name.clone(),
                service: "web".into(),
                compose_file: "compose.yaml".into(),
                dockerfile: "Dockerfile".into(),
                build_context: ".".into(),
                access_url: String::new(),
                base_path: "/for-you/".into(),
                container_port: 3000,
                host_port: 3000,
                bind_address: "127.0.0.1".into(),
                data_directories: if recovery {
                    vec![DataDirectory {
                        host_path: format!("{root}-data"),
                        container_path: "/app/data".into(),
                        read_only: false,
                        container_user: "1000:1000".into(),
                        backup_policy:
                            "Isolated acceptance: preserve data across every service transition"
                                .into(),
                    }]
                } else {
                    vec![]
                },
                non_sensitive_files: vec![],
                existing_service: false,
                management_method: String::new(),
                recovery_instructions: String::new(),
            },
        },
    };
    let preview = deployment_files::preview(&entry).unwrap();
    entry.source.included_untracked = deployment_files::apply(&entry, &preview.digest).unwrap();
    entry = database
        .save_deployment_application(&SaveApplicationInput {
            entry,
            expected_application_revision: 0,
            expected_environment_revision: 0,
            expected_source_revision: 0,
            expected_workflow_revision: 0,
            workflow_id: None,
        })
        .unwrap();
    let workflow = database
        .get_deployment_workflow(entry.environment.workflow_id.as_ref().unwrap())
        .unwrap()
        .unwrap();
    let credentials = crate::keychain::CredentialManager::isolated_native_for_tests();
    credentials
        .store_profile_password(&profile_id, connection.password.as_deref().unwrap())
        .unwrap();
    let _credential_cleanup = FixtureCredential(credentials.clone(), profile_id.clone());
    let mut report = readiness::check_local(&entry).unwrap();
    readiness::check_remote(
        &entry,
        &mut report,
        &database,
        &credentials,
        &known_hosts,
        &crate::execution::ExecutionCancellationRegistry::default(),
    )
    .unwrap();
    assert!(
        report.items.iter().all(|item| matches!(
            item.status,
            readiness::CheckStatus::Passed | readiness::CheckStatus::Notice
        )),
        "{report:?}"
    );
    database
        .store_deployment_readiness(&entry, &report)
        .unwrap();
    database
        .ensure_deployment_application_ready(&workflow.id, workflow.revision)
        .unwrap();
    let backend = NativeDockerComposeBackend::isolated_native(
        database.clone(),
        credentials.clone(),
        known_hosts.clone(),
        runtime.artifacts().clone(),
    );
    let executors = docker_compose_executor_registry(Arc::new(backend)).unwrap();
    let prepared = prepare_run(
        &database,
        &runtime,
        &executors,
        PrepareRunRequest {
            run_id: format!("run-{}", uuid::Uuid::new_v4()),
            workflow_id: workflow.id.clone(),
            workflow_revision: workflow.revision,
            operation_kind: WorkflowRunOperationKind::Deploy,
            trigger_kind: WorkflowRunTriggerKind::Manual,
            parameters: BTreeMap::new(),
        },
    )
    .await
    .unwrap();
    let before = database
        .get_deployment_run(&prepared.run_id)
        .unwrap()
        .unwrap();
    let plan: ImmutableRunPlan = serde_json::from_value(before.plan.clone()).unwrap();
    assert!(
        remote(
            &session.target,
            &format!("find {root} -mindepth 1 -print -quit")
        )
        .trim()
        .is_empty(),
        "preparation must not write remotely"
    );
    // A real post-preparation configuration edit must invalidate approval.
    let mut changed = workflow.definition.clone();
    changed.policy.releases_to_keep += 1;
    let changed_workflow = database
        .update_deployment_workflow(
            &workflow.id,
            workflow.revision,
            &super::repository::UpdateDeploymentWorkflowInput {
                name: workflow.name.clone(),
                definition: changed,
                enabled: true,
            },
        )
        .unwrap();
    assert!(
        approve_run(&database, &runtime, &prepared.run_id, &prepared.plan_digest)
            .unwrap_err()
            .contains("DRIFT")
    );
    // Do not restore an old revision. Prepare a new candidate from the new head.
    let prepared = prepare_run(
        &database,
        &runtime,
        &executors,
        PrepareRunRequest {
            run_id: format!("run-{}", uuid::Uuid::new_v4()),
            workflow_id: workflow.id.clone(),
            workflow_revision: changed_workflow.revision,
            operation_kind: WorkflowRunOperationKind::Deploy,
            trigger_kind: WorkflowRunTriggerKind::Manual,
            parameters: BTreeMap::new(),
        },
    )
    .await
    .unwrap();
    approve_run(&database, &runtime, &prepared.run_id, &prepared.plan_digest).unwrap();
    let approved_detail = super::commands::run_detail(&database, &prepared.run_id)
        .unwrap()
        .unwrap();
    // Real port conflict introduced after approval; no service is killed by the product.
    remote(&session.target, "nohup nc -l -p 3000 >/tmp/phase3-port.log 2>&1 </dev/null & echo $! > /tmp/phase3-port.pid");
    let conflict = verify_pre_start_frozen_inputs(
        &database,
        &runtime,
        &executors,
        &prepared.run_id,
        &prepared.plan_digest,
    )
    .await
    .unwrap_err();
    assert!(conflict.contains("resourceConflict"), "{conflict}");
    assert!(remote(
        &session.target,
        &format!("find {root} -mindepth 1 -print -quit")
    )
    .trim()
    .is_empty());
    remote(&session.target, "kill $(cat /tmp/phase3-port.pid)");
    verify_pre_start_frozen_inputs(
        &database,
        &runtime,
        &executors,
        &prepared.run_id,
        &prepared.plan_digest,
    )
    .await
    .unwrap();
    let (_, cancellation) =
        begin_start_run(&database, &runtime, &prepared.run_id, &prepared.plan_digest).unwrap();
    execute_approved_run(
        database.clone(),
        runtime.clone(),
        executors.clone(),
        prepared.run_id.clone(),
        prepared.plan_digest.clone(),
        cancellation,
    )
    .await
    .unwrap();
    let finished = database
        .get_deployment_run(&prepared.run_id)
        .unwrap()
        .unwrap();
    if finished.status != super::repository::DeploymentRunStatus::Succeeded {
        let events = database
            .list_deployment_run_events(&prepared.run_id, None, 100)
            .unwrap();
        panic!(
            "release status {:?}; events: {}",
            finished.status,
            serde_json::to_string(&events).unwrap()
        );
    }
    let observation = observe_service(&database, &runtime, &executors, &prepared.run_id)
        .await
        .unwrap();
    assert_eq!(observation["status"], "passed", "{observation}");
    let http = remote(
        &session.target,
        "curl --fail --silent http://127.0.0.1:3000/for-you/",
    );
    assert!(http.contains("<!DOCTYPE html>") || http.contains("<!doctype html>"));
    assert_eq!(
        source_binding::capture(&original_binding)
            .unwrap()
            .snapshot
            .snapshot_digest,
        original.snapshot.snapshot_digest
    );
    let detail = super::commands::run_detail(&database, &prepared.run_id)
        .unwrap()
        .unwrap();
    if recovery {
        let posted: serde_json::Value = serde_json::from_str(&remote(&session.target,
            "curl --fail --silent -H 'Content-Type: application/json' --data '{\"text\":\"ShellSpan isolated persistence acceptance\"}' http://127.0.0.1:3000/for-you/api/danmaku/")).unwrap();
        let persisted = posted["item"].clone();
        assert!(persisted["id"].as_str().is_some());
        assert_eq!(persisted["preset"], false);
        assert_persisted_item(&session.target, &persisted);
        let initial_data_digest = remote(
            &session.target,
            &format!("sha256sum {root}-data/danmaku.json"),
        );
        remote(
            &session.target,
            &format!(
                "docker compose -f {root}/releases/{}/compose.yaml -p {project_name} restart",
                detail.summary.target_release.release_id
            ),
        );
        assert_persisted_item(&session.target, &persisted);
        assert_eq!(
            remote(
                &session.target,
                &format!("sha256sum {root}-data/danmaku.json")
            ),
            initial_data_digest
        );
        use super::node_executor::{
            FrozenNodeInput, NodeExecutionContext, NodeReconcileResult, VerifiedNodeInput,
        };
        let initial_plan: ImmutableRunPlan = serde_json::from_value(finished.plan.clone()).unwrap();
        let activation = changed_workflow
            .definition
            .nodes
            .iter()
            .find(|node| node.type_name == "deploy.compose")
            .unwrap();
        let attempt = database
            .list_deployment_node_attempts(&prepared.run_id, &activation.id, None, 1)
            .unwrap()
            .items
            .remove(0);
        let frozen = FrozenNodeInput {
            run_id: prepared.run_id.clone(),
            node: activation.clone(),
            targets: changed_workflow.definition.targets.clone(),
            inputs: BTreeMap::new(),
        };
        let restarted = docker_compose_executor_registry(Arc::new(
            NativeDockerComposeBackend::isolated_native(
                Database::open(&storage.path().join("release.db")).unwrap(),
                credentials.clone(),
                known_hosts.clone(),
                runtime.artifacts().clone(),
            ),
        ))
        .unwrap();
        let executor = restarted
            .get(&activation.type_name, activation.type_version)
            .unwrap();
        let verified = VerifiedNodeInput {
            planned: executor.plan(frozen.clone()).unwrap(),
            frozen,
            immutable_plan: Some(initial_plan),
            attempt: attempt.attempt,
            idempotency_key: attempt.idempotency_key,
        };
        let context = NodeExecutionContext {
            cancellation: tokio_util::sync::CancellationToken::new(),
        };
        assert!(matches!(
            executor
                .reconcile(verified.clone(), context.clone())
                .await
                .unwrap(),
            NodeReconcileResult::Succeeded(_)
        ));
        let ledger = format!(
            "{root}/.shellspan/runs/{}/{}/{}.json",
            prepared.run_id, activation.id, attempt.attempt
        );
        let hidden_ledger = format!("{ledger}.interrupted");
        let sftp = session.target.sftp().unwrap();
        sftp.rename(Path::new(&ledger), Path::new(&hidden_ledger), None)
            .unwrap();
        let reconciled = executor.reconcile(verified, context).await.unwrap();
        sftp.rename(Path::new(&hidden_ledger), Path::new(&ledger), None)
            .unwrap();
        assert!(
            matches!(reconciled, NodeReconcileResult::StateUnknown(_)),
            "missing effect evidence cannot authorize replay"
        );
        let request = |revision, operation_kind| PrepareRunRequest {
            run_id: format!("run-{}", uuid::Uuid::new_v4()),
            workflow_id: workflow.id.clone(),
            workflow_revision: revision,
            operation_kind,
            trigger_kind: WorkflowRunTriggerKind::Manual,
            parameters: BTreeMap::new(),
        };
        // A real source change creates a distinct image and complete release bundle.
        let dockerfile = copy.path().join("Dockerfile");
        let original_dockerfile = std::fs::read_to_string(&dockerfile).unwrap();
        std::fs::write(
            &dockerfile,
            format!("{original_dockerfile}\nLABEL shellspan.acceptance.revision=second\n"),
        )
        .unwrap();
        let upgrade = prepare_run(
            &database,
            &runtime,
            &executors,
            request(changed_workflow.revision, WorkflowRunOperationKind::Deploy),
        )
        .await
        .unwrap();
        execute_acceptance_run(&database, &runtime, &executors, &upgrade).await;
        assert_eq!(
            database
                .get_deployment_run(&upgrade.run_id)
                .unwrap()
                .unwrap()
                .status,
            super::repository::DeploymentRunStatus::Succeeded
        );
        assert_persisted_item(&session.target, &persisted);
        assert_eq!(
            remote(
                &session.target,
                &format!("sha256sum {root}-data/danmaku.json")
            ),
            initial_data_digest
        );
        let additional: serde_json::Value = serde_json::from_str(&remote(&session.target,
            "curl --fail --silent -H 'Content-Type: application/json' --data '{\"text\":\"ShellSpan data written after upgrade\"}' http://127.0.0.1:3000/for-you/api/danmaku/")).unwrap();
        let additional = additional["item"].clone();
        let upgraded_data_digest = remote(
            &session.target,
            &format!("sha256sum {root}-data/danmaku.json"),
        );
        let releases = database.list_deployment_releases(&workflow.id).unwrap();
        assert_eq!(releases.len(), 2);
        // Invalid present-day build inputs must not prevent historical rollback.
        std::fs::write(&dockerfile, "THIS IS NOT A DOCKERFILE\n").unwrap();
        let rollback = prepare_rollback_run(
            &database,
            &runtime,
            &executors,
            request(
                changed_workflow.revision,
                WorkflowRunOperationKind::Rollback,
            ),
            detail.summary.target_release.release_id.clone(),
        )
        .await
        .unwrap();
        execute_acceptance_run(&database, &runtime, &executors, &rollback).await;
        assert_eq!(
            database
                .get_deployment_run(&rollback.run_id)
                .unwrap()
                .unwrap()
                .status,
            super::repository::DeploymentRunStatus::Succeeded
        );
        assert_persisted_item(&session.target, &persisted);
        assert_persisted_item(&session.target, &additional);
        assert_eq!(
            remote(
                &session.target,
                &format!("sha256sum {root}-data/danmaku.json")
            ),
            upgraded_data_digest
        );
        let nodes = database
            .list_deployment_run_nodes(&rollback.run_id)
            .unwrap();
        assert!(nodes
            .iter()
            .filter(|node| matches!(
                node.node_type.as_str(),
                "source.snapshot" | "build.docker-buildx" | "artifact.bundle-compose"
            ))
            .all(|node| node.status == "skipped"));
        std::fs::write(
            &dockerfile,
            format!(
                "{original_dockerfile}\nLABEL shellspan.acceptance.revision=failed-health-check\n"
            ),
        )
        .unwrap();
        let mut broken = changed_workflow.definition.clone();
        for node in &mut broken.nodes {
            if node.type_name == "verify.http" {
                node.config["path"] = serde_json::json!("/for-you/nonexistent-phase4/");
            }
        }
        let broken = database
            .update_deployment_workflow(
                &workflow.id,
                changed_workflow.revision,
                &super::repository::UpdateDeploymentWorkflowInput {
                    name: workflow.name.clone(),
                    definition: broken,
                    enabled: true,
                },
            )
            .unwrap();
        let failed = prepare_run(
            &database,
            &runtime,
            &executors,
            request(broken.revision, WorkflowRunOperationKind::Deploy),
        )
        .await
        .unwrap();
        execute_acceptance_run(&database, &runtime, &executors, &failed).await;
        let failed_run = database
            .get_deployment_run(&failed.run_id)
            .unwrap()
            .unwrap();
        assert_eq!(
            failed_run.status,
            super::repository::DeploymentRunStatus::Failed
        );
        assert!(remote(
            &session.target,
            "curl --fail --silent http://127.0.0.1:3000/for-you/"
        )
        .contains("html"));
        let recovery_receipts = database
            .list_deployment_effect_receipts(&failed.run_id)
            .unwrap();
        assert!(recovery_receipts
            .iter()
            .any(|receipt| receipt.receipt_type == "compose.restore"));
        assert_persisted_item(&session.target, &persisted);
        assert_persisted_item(&session.target, &additional);
        assert_eq!(
            remote(
                &session.target,
                &format!("sha256sum {root}-data/danmaku.json")
            ),
            upgraded_data_digest
        );
        assert_eq!(
            source_binding::capture(&original_binding)
                .unwrap()
                .snapshot
                .snapshot_digest,
            original.snapshot.snapshot_digest
        );
        let protected = database
            .protected_deployment_artifact_manifests(i64::MAX)
            .unwrap();
        for release in &releases {
            let handle = database
                .get_deployment_artifact_handle(&release.artifact_reference)
                .unwrap()
                .unwrap();
            assert!(
                protected.contains(&handle.manifest_digest),
                "successful retained version must survive expired time retention"
            );
        }
        runtime.artifacts().cleanup(&protected).unwrap();
        for release in &releases {
            let handle = database
                .get_deployment_artifact_handle(&release.artifact_reference)
                .unwrap()
                .unwrap();
            runtime.artifacts().inspect(&handle).unwrap();
        }
        assert_persisted_item(&session.target, &additional);
        assert_eq!(
            remote(
                &session.target,
                &format!("sha256sum {root}-data/danmaku.json")
            ),
            upgraded_data_digest
        );
        if let Ok(path) = std::env::var("SHELLSPAN_PHASE4_REPORT") {
            std::fs::write(path, serde_json::to_vec_pretty(&serde_json::json!({
                "scope":"isolated real service lifecycle and API persistence; manual takeover platform excluded",
                "initial":detail,"upgrade":super::commands::run_detail(&database,&upgrade.run_id).unwrap(),
                "rollback":super::commands::run_detail(&database,&rollback.run_id).unwrap(),
                "failed":super::commands::run_detail(&database,&failed.run_id).unwrap(),
                "recoveryReceipts":recovery_receipts,"rollbackNodes":nodes,
                "reopenedBackendReadReceipt":true,"missingReceiptRemainedUnknown":true,
                "retainedVersionsSurvivedCleanup":true,"dataUnchangedByCleanup":true,
                "persistedItem":persisted,"postUpgradeItem":additional,
                "initialDataDigest":initial_data_digest,"upgradedDataDigest":upgraded_data_digest,
                "originalSourceDigest":original.snapshot.snapshot_digest
            })).unwrap()).unwrap();
        }
    }
    let events = database
        .list_deployment_run_events(&prepared.run_id, None, 100)
        .unwrap();
    let receipts = database
        .list_deployment_effect_receipts(&prepared.run_id)
        .unwrap();
    if let Ok(path) = std::env::var("SHELLSPAN_PHASE3_REPORT") {
        std::fs::write(path, serde_json::to_vec_pretty(&serde_json::json!({
            "entry":entry,"workflow":changed_workflow,"readiness":report,"detail":detail,"approvedDetail":approved_detail,"events":events,
            "receipts":receipts,"observation":observation,"originalSourceDigest":original.snapshot.snapshot_digest,
            "firstCandidate":plan,"configurationConflictRejected":true,"portConflictRejected":true,
            "preparationDidNotWriteRemote":true,"productionServerTouched":false
        })).unwrap()).unwrap();
    }
    remote(
        &session.target,
        &format!(
            "docker compose -f {root}/releases/{}/compose.yaml -p {project_name} down",
            detail.summary.target_release.release_id
        ),
    );
    credentials.delete_profile_password(&profile_id).unwrap();
    if std::env::var_os("SHELLSPAN_PHASE3_KEEP_SOURCE").is_some() {
        let _retained_source = copy.keep();
    }
}

fn assert_persisted_item(session: &ssh2::Session, item: &serde_json::Value) {
    let observed: serde_json::Value = serde_json::from_str(&remote(session,
        "curl --fail --silent --retry 10 --retry-delay 1 --retry-all-errors http://127.0.0.1:3000/for-you/api/danmaku/"
    )).unwrap();
    assert!(
        observed["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|actual| actual == item),
        "persisted API item missing: {item}"
    );
}

async fn execute_acceptance_run(
    database: &Database,
    runtime: &super::runtime::DeploymentWorkflowRuntime,
    executors: &super::node_executor::DeploymentNodeExecutorRegistry,
    prepared: &PreparedRun,
) {
    approve_run(database, runtime, &prepared.run_id, &prepared.plan_digest).unwrap();
    let (_, cancellation) =
        begin_start_run(database, runtime, &prepared.run_id, &prepared.plan_digest).unwrap();
    execute_approved_run(
        database.clone(),
        runtime.clone(),
        executors.clone(),
        prepared.run_id.clone(),
        prepared.plan_digest.clone(),
        cancellation,
    )
    .await
    .unwrap();
    if let Ok(path) = std::env::var("SHELLSPAN_PHASE4_REPORT") {
        std::fs::write(
            format!("{path}.last-run.json"),
            serde_json::to_vec_pretty(
                &super::commands::run_detail(database, &prepared.run_id).unwrap(),
            )
            .unwrap(),
        )
        .unwrap();
    }
}
