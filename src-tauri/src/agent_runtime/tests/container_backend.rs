use super::*;

fn owned_fixture(
    root: &std::path::Path,
) -> (
    crate::keychain::CredentialManager,
    Arc<ContainerJournal>,
    crate::agent_runtime::AgentSessionHeader,
) {
    let credentials = crate::keychain::CredentialManager::isolated_native_for_tests();
    let journal = ContainerJournal::open(root, &credentials, true)
        .unwrap()
        .unwrap();
    let runtime = crate::agent_runtime::AgentRuntimeBuilder::new().build();
    runtime.configure(root.to_owned()).unwrap();
    let snapshot = runtime.create_session(serde_json::from_value(serde_json::json!({
        "sessionId": uuid::Uuid::new_v4().to_string(), "taskId": "normal-container-task", "goal": "Normal lifecycle verification",
        "sandboxPolicy": "host", "executionSurface": "direct", "target": {"kind": "local", "targetId": "local", "sessionId": "terminal", "cwd": root.to_str().unwrap()}
    })).unwrap()).unwrap();
    (credentials, journal, snapshot.header)
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}

#[test]
fn container_probe_reports_infrastructure_separately_from_admission() {
    let probe = runtime().block_on(probe_local_container_backend());
    assert!(!probe.workspace_verified);
    assert!(!probe.admission_enabled);
    let wire = serde_json::to_value(&probe).unwrap();
    assert_eq!(wire["workspaceVerified"], false);
    assert_eq!(wire["admissionEnabled"], false);
    assert!(wire.get("infrastructureAvailable").unwrap().is_boolean());
    assert!(wire.get("executionOs").is_some());
    assert!(wire.get("executionArch").is_some());
    assert!(wire.get("backendVersion").is_some());
    assert!(wire.get("failure").is_some());
}

#[test]
#[ignore = "requires a local Linux Engine and explicit prebuilt immutable image"]
fn container_backend_normal_stdin_wait_stop_and_deadline() {
    runtime().block_on(async {
        let root = tempfile::tempdir().unwrap();
        let (credentials, journal, header) = owned_fixture(root.path());
        let image =
            std::env::var("SHELLSPAN_CONTAINER_TEST_IMAGE").expect("explicit local image ID");
        let socket = if cfg!(windows) {
            "//./pipe/docker_engine"
        } else {
            "/var/run/docker.sock"
        };
        let docker = Docker::connect_with_local(socket, 3, API_DEFAULT_VERSION).unwrap();
        let process = LocalContainerProcess::start(
            journal.clone(),
            header.clone(),
            docker.clone(),
            &image,
            "read -r value; printf '%s' \"$value\"; printf diagnostic >&2; exit 23",
            Duration::from_secs(10),
            Duration::from_secs(10),
            CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(process.write_stdin(b"payload\n", true).await.unwrap(), 8);
        let snapshot = process.wait(Duration::from_secs(10)).await;
        assert_eq!(
            snapshot.lifecycle,
            ProcessLifecycleNative::Exited,
            "{snapshot:?}"
        );
        assert_eq!(snapshot.stdout, "payload");
        assert_eq!(snapshot.stderr, "diagnostic");
        assert_eq!(snapshot.exit_code, Some(23));
        assert_eq!(
            snapshot.failure.unwrap().kind,
            AgentExecutionFailureKind::CommandFailed
        );
        assert!(snapshot.termination_confirmed);
        assert!(docker.inspect_container(&process.id, None).await.is_err());
        for cancel in [false, true] {
            let process = LocalContainerProcess::start(
                journal.clone(),
                header.clone(),
                docker.clone(),
                &image,
                "sleep 10",
                if cancel {
                    Duration::from_secs(10)
                } else {
                    Duration::from_millis(100)
                },
                Duration::from_secs(10),
                CancellationToken::new(),
            )
            .await
            .unwrap();
            assert_eq!(
                process.snapshot().lifecycle,
                ProcessLifecycleNative::Running
            );
            let snapshot = if cancel {
                process.stop(Duration::from_secs(5)).await
            } else {
                process.wait(Duration::from_secs(5)).await
            };
            assert_eq!(
                snapshot.lifecycle,
                if cancel {
                    ProcessLifecycleNative::Cancelled
                } else {
                    ProcessLifecycleNative::TimedOut
                },
                "{snapshot:?}"
            );
            assert!(snapshot.termination_confirmed, "{snapshot:?}");
            assert!(docker.inspect_container(&process.id, None).await.is_err());
            assert_eq!(
                process.stop(Duration::from_secs(1)).await.lifecycle,
                snapshot.lifecycle
            );
        }
        journal.destroy_test_key(&credentials);
    });
}

#[test]
#[ignore = "requires a local Linux Engine and explicit prebuilt immutable image"]
fn container_backend_missing_image_refuses_without_pull_or_execution() {
    runtime().block_on(async {
        let root = tempfile::tempdir().unwrap();
        let (credentials, journal, header) = owned_fixture(root.path());
        let socket = if cfg!(windows) {
            "//./pipe/docker_engine"
        } else {
            "/var/run/docker.sock"
        };
        let docker = Docker::connect_with_local(socket, 3, API_DEFAULT_VERSION).unwrap();
        let missing = format!("sha256:{}", "0".repeat(64));
        let error = LocalContainerProcess::start(
            journal.clone(),
            header,
            docker,
            &missing,
            "printf should-not-start",
            Duration::from_secs(2),
            Duration::from_secs(10),
            CancellationToken::new(),
        )
        .await
        .err()
        .unwrap();
        assert_eq!(error.kind, AgentExecutionFailureKind::BackendUnavailable);
        assert_eq!(error.admission, AgentExecutionAdmission::NotStarted);
        assert_eq!(error.code, "localImageUnavailable");
        journal.destroy_test_key(&credentials);
    });
}

#[test]
fn container_exit_coordinator_is_idempotent_and_idle_exit_is_fast() {
    let supervisor = super::super::container_ownership::ContainerResourceSupervisor::default();
    assert!(supervisor.begin_shutdown());
    assert!(!supervisor.begin_shutdown());
    assert!(!supervisor.shutdown_complete());
    assert_eq!(runtime().block_on(supervisor.shutdown()).unwrap(), 0);
    supervisor.finish_shutdown();
    assert!(supervisor.shutdown_complete());
    assert!(!supervisor.begin_shutdown());
}

#[test]
#[ignore = "requires real native credential store and local Linux Engine"]
fn container_custody_unknown_create_retains_debt_and_concurrent_owner_is_unique() {
    runtime().block_on(async {
        let root = tempfile::tempdir().unwrap();
        let (credentials, journal, header) = owned_fixture(root.path());
        let mut threads = Vec::new();
        for _ in 0..4 {
            let credentials = credentials.clone();
            let path = root.path().to_owned();
            threads.push(std::thread::spawn(move || {
                ContainerJournal::open(&path, &credentials, true)
                    .unwrap()
                    .unwrap()
            }));
        }
        for thread in threads {
            assert_eq!(
                thread.join().unwrap().owner_reference(),
                journal.owner_reference()
            );
        }
        let docker =
            Docker::connect_with_local("/var/run/docker.sock", 3, API_DEFAULT_VERSION).unwrap();
        let image = std::env::var("SHELLSPAN_CONTAINER_TEST_IMAGE").unwrap();
        let intent = journal
            .reserve(&docker, &header, &image, "sleep 10")
            .await
            .unwrap();
        // Persisted prepare-to-send state is itself real: cancellation/crash can
        // happen before transport can provide an authoritative create receipt.
        journal.sent(&intent).await.unwrap();
        for _ in 0..3 {
            assert!(journal.clean(&docker, &intent).await.is_err());
            assert_eq!(journal.pending_count(), 1);
        }
        assert!(journal
            .reserve(&docker, &header, &image, "printf next")
            .await
            .is_err());
        let supervisor = super::super::container_ownership::ContainerResourceSupervisor::default();
        supervisor
            .configure(root.path().to_owned(), credentials.clone())
            .unwrap();
        assert!(supervisor.begin_shutdown());
        assert!(journal.closing.is_cancelled());
        let _ = tokio::time::timeout(Duration::ZERO, supervisor.shutdown()).await;
        assert_eq!(journal.pending_count(), 1);
        assert!(supervisor.shutdown().await.is_err());
        assert_eq!(journal.pending_count(), 1);
        supervisor.finish_shutdown();
        assert!(supervisor.shutdown_complete());
        journal.destroy_test_key(&credentials);
    });
}

#[test]
#[ignore = "requires real native credential store and local Linux Engine"]
fn container_startup_deadline_and_restart_receipt_cleanup() {
    let root = tempfile::tempdir().unwrap();
    let (credentials, journal, header) = owned_fixture(root.path());
    let image = std::env::var("SHELLSPAN_CONTAINER_TEST_IMAGE").unwrap();
    let first_runtime = runtime();
    let process = first_runtime.block_on(async {
        let docker =
            Docker::connect_with_local("/var/run/docker.sock", 3, API_DEFAULT_VERSION).unwrap();
        let timed = LocalContainerProcess::start(
            journal.clone(),
            header.clone(),
            docker.clone(),
            &image,
            "printf ordinary",
            Duration::from_secs(10),
            Duration::ZERO,
            CancellationToken::new(),
        )
        .await;
        assert!(timed.is_err());
        tokio::time::sleep(Duration::from_millis(250)).await;
        journal.recover(&docker).await.unwrap();
        LocalContainerProcess::start(
            journal.clone(),
            header,
            docker,
            &image,
            "sleep 10",
            Duration::from_secs(20),
            Duration::from_secs(5),
            CancellationToken::new(),
        )
        .await
        .unwrap()
    });
    let id = process.id.clone();
    drop(first_runtime);
    drop(process);
    drop(journal);
    runtime().block_on(async {
        let recovered = ContainerJournal::open(root.path(), &credentials, false)
            .unwrap()
            .unwrap();
        let docker =
            Docker::connect_with_local("/var/run/docker.sock", 3, API_DEFAULT_VERSION).unwrap();
        assert_eq!(recovered.pending_count(), 1);
        assert_eq!(recovered.recover(&docker).await.unwrap(), 1);
        assert_eq!(recovered.pending_count(), 0);
        assert!(matches!(
            docker.inspect_container(&id, None).await,
            Err(bollard::errors::Error::DockerResponseServerError {
                status_code: 404,
                ..
            })
        ));
        recovered.destroy_test_key(&credentials);
    });
}

#[test]
#[ignore = "requires real native credential store and local Linux Engine"]
fn container_cancelled_startup_and_unreachable_daemon_keep_ownership_scope() {
    runtime().block_on(async {
        let root = tempfile::tempdir().unwrap();
        let (credentials, journal, header) = owned_fixture(root.path());
        let image = std::env::var("SHELLSPAN_CONTAINER_TEST_IMAGE").unwrap();
        let docker =
            Docker::connect_with_local("/var/run/docker.sock", 3, API_DEFAULT_VERSION).unwrap();
        let foreign = docker
            .create_container(
                None,
                ContainerCreateBody {
                    image: Some(image.clone()),
                    entrypoint: Some(vec!["/bin/sh".into()]),
                    cmd: Some(vec!["-c".into(), "sleep 10".into()]),
                    host_config: Some(HostConfig {
                        network_mode: Some("none".into()),
                        readonly_rootfs: Some(true),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
            )
            .await
            .unwrap()
            .id;
        docker.start_container(&foreign, None).await.unwrap();
        let started = LocalContainerProcess::start(
            journal.clone(),
            header.clone(),
            docker.clone(),
            &image,
            "sleep 10",
            Duration::from_secs(20),
            Duration::from_secs(5),
            CancellationToken::new(),
        )
        .await
        .unwrap();
        let intent = started.intent.clone();
        let closed_socket = root.path().join("closed.sock");
        #[cfg(unix)]
        {
            let listener = std::os::unix::net::UnixListener::bind(&closed_socket).unwrap();
            drop(listener);
        }
        let unavailable =
            Docker::connect_with_local(closed_socket.to_str().unwrap(), 1, API_DEFAULT_VERSION)
                .unwrap();
        assert!(journal.clean(&unavailable, &intent).await.is_err());
        assert_eq!(journal.pending_count(), 1);
        assert_eq!(journal.recover(&docker).await.unwrap(), 1);
        let info = docker.inspect_container(&foreign, None).await.unwrap();
        assert_eq!(info.state.unwrap().running, Some(true));
        let owned_journal = journal.clone();
        let owned_header = header;
        let owned_docker = docker.clone();
        let owned_image = image;
        let startup = tokio::spawn(async move {
            LocalContainerProcess::start(
                owned_journal,
                owned_header,
                owned_docker,
                &owned_image,
                "printf ordinary",
                Duration::from_secs(10),
                Duration::from_secs(5),
                CancellationToken::new(),
            )
            .await
        });
        tokio::task::yield_now().await;
        startup.abort();
        assert!(startup.await.is_err());
        tokio::time::sleep(Duration::from_millis(500)).await;
        journal.recover(&docker).await.unwrap();
        assert_eq!(journal.pending_count(), 0);
        docker
            .remove_container(
                &foreign,
                Some(bollard::query_parameters::RemoveContainerOptions {
                    force: true,
                    ..Default::default()
                }),
            )
            .await
            .unwrap();
        journal.destroy_test_key(&credentials);
    });
}

#[test]
#[ignore = "subprocess helper, requires explicit private fixture root"]
fn container_process_crash_child() {
    let root = std::path::PathBuf::from(
        std::env::var("SHELLSPAN_CONTAINER_CHILD_ROOT").expect("private fixture root"),
    );
    let (_, journal, header) = owned_fixture(&root);
    runtime().block_on(async {
        let docker =
            Docker::connect_with_local("/var/run/docker.sock", 3, API_DEFAULT_VERSION).unwrap();
        let image = std::env::var("SHELLSPAN_CONTAINER_TEST_IMAGE").unwrap();
        let process = LocalContainerProcess::start(
            journal,
            header,
            docker,
            &image,
            "sleep 30",
            Duration::from_secs(45),
            Duration::from_secs(5),
            CancellationToken::new(),
        )
        .await
        .unwrap();
        let mut ready = tempfile::NamedTempFile::new_in(&root).unwrap();
        serde_json::to_writer(ready.as_file_mut(), &process.id).unwrap();
        ready.as_file().sync_all().unwrap();
        ready.persist(root.join("process-ready.json")).unwrap();
        let _ = process.wait(Duration::from_secs(40)).await;
    });
}

#[test]
#[ignore = "requires native credential store, local Engine and real child process"]
fn container_real_process_crash_then_restart_recovers_receipt() {
    let root = tempfile::tempdir().unwrap();
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "agent_runtime::native::container_backend::tests::container_process_crash_child",
            "--ignored",
            "--quiet",
        ])
        .env("SHELLSPAN_CONTAINER_CHILD_ROOT", root.path())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    while !root.path().join("process-ready.json").exists() {
        if let Some(status) = child.try_wait().unwrap() {
            panic!("lifecycle child exited before ready: {status}");
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("lifecycle child readiness timed out");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let id: String =
        serde_json::from_slice(&std::fs::read(root.path().join("process-ready.json")).unwrap())
            .unwrap();
    child.kill().unwrap();
    assert!(!child.wait().unwrap().success());
    let credentials = crate::keychain::CredentialManager::isolated_native_for_tests();
    let journal = ContainerJournal::open(root.path(), &credentials, false)
        .unwrap()
        .unwrap();
    runtime().block_on(async {
        let docker =
            Docker::connect_with_local("/var/run/docker.sock", 3, API_DEFAULT_VERSION).unwrap();
        assert_eq!(journal.pending_count(), 1);
        assert_eq!(journal.recover(&docker).await.unwrap(), 1);
        assert_eq!(journal.pending_count(), 0);
        assert!(matches!(
            docker.inspect_container(&id, None).await,
            Err(bollard::errors::Error::DockerResponseServerError {
                status_code: 404,
                ..
            })
        ));
    });
    journal.destroy_test_key(&credentials);
}

#[test]
#[ignore = "requires native credential store and local Linux Engine"]
fn container_parallel_sessions_cancel_independently_and_keep_input() {
    runtime().block_on(async {
        let root = tempfile::tempdir().unwrap();
        let (credentials, journal, first_header) = owned_fixture(root.path());
        let (_, second_journal, second_header) = owned_fixture(root.path());
        assert_ne!(first_header.session_id, second_header.session_id);
        assert_eq!(journal.owner_reference(), second_journal.owner_reference());
        let docker =
            Docker::connect_with_local("/var/run/docker.sock", 3, API_DEFAULT_VERSION).unwrap();
        let image = std::env::var("SHELLSPAN_CONTAINER_TEST_IMAGE").unwrap();
        let (first, second) = tokio::join!(
            LocalContainerProcess::start(
                journal.clone(),
                first_header,
                docker.clone(),
                &image,
                "sleep 10",
                Duration::from_secs(20),
                Duration::from_secs(5),
                CancellationToken::new()
            ),
            LocalContainerProcess::start(
                second_journal,
                second_header,
                docker,
                &image,
                "read -r value; printf '%s' \"$value\"",
                Duration::from_secs(20),
                Duration::from_secs(5),
                CancellationToken::new()
            )
        );
        let first = first.unwrap();
        let second = second.unwrap();
        assert_eq!(journal.pending_count(), 2);
        let cancelled = first.stop(Duration::from_secs(5)).await;
        assert!(cancelled.termination_confirmed);
        assert_eq!(cancelled.lifecycle, ProcessLifecycleNative::Cancelled);
        assert_eq!(second.snapshot().lifecycle, ProcessLifecycleNative::Running);
        assert_eq!(journal.pending_count(), 1);
        second.write_stdin(b"second-session\n", true).await.unwrap();
        let completed = second.wait(Duration::from_secs(5)).await;
        assert_eq!(completed.stdout, "second-session");
        assert_eq!(completed.exit_code, Some(0));
        assert!(completed.termination_confirmed);
        assert_eq!(journal.pending_count(), 0);
        journal.destroy_test_key(&credentials);
    });
}
