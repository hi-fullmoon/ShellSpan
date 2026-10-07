//! Opt-in real dependency download through production approval and native dispatch.
use super::*;

struct Workflow {
    workspace: tempfile::TempDir,
    storage: tempfile::TempDir,
    cache: tempfile::TempDir,
    sessions: SessionManager,
    source: SourcePty,
    engine: NativeToolEngine,
    database: Database,
    credentials: CredentialManager,
    context: NativeExecutionContext,
    target: AgentToolTargetNative,
    runtime: crate::agent_runtime::AgentRuntime,
}

impl Workflow {
    fn new(label: &str) -> Self {
        let workspace = tempfile::tempdir().unwrap();
        let storage = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let sessions = SessionManager::default();
        let source_id = format!("{label}-source");
        let source = source(&sessions, &source_id, workspace.path());
        let runtime = AgentRuntimeBuilder::new().build();
        runtime.configure(storage.path().to_path_buf()).unwrap();
        let header = runtime.create_session(serde_json::from_value(json!({
            "sessionId":label,"taskId":label,"goal":"Install and execute real public dependency",
            "target":{"kind":"local","targetId":"local","sessionId":source_id,"cwd":workspace.path()},
            "executionSurface":"direct","sandboxPolicy":"workspace","permissionMode":"operator",
            "successCriteria":["Locked dependency is actually downloaded and executed"]
        })).unwrap()).unwrap().header;
        let frozen_target = header.target.as_ref().unwrap();
        let target = AgentToolTargetNative::Local {
            target_id: frozen_target.target_id.clone(),
            session_id: frozen_target.session_id.clone(),
            cwd: frozen_target.cwd.clone(),
        };
        let contract = AgentSandboxContract::freeze(
            header.sandbox_policy,
            frozen_target,
            AgentExecutionSurface::Direct,
            current_unix_ms(),
        )
        .unwrap()
        .bind_to_session(&header);
        let context = NativeExecutionContext {
            sandbox_contract: Some(contract),
            request: AgentRequestNative {
                contract_version: NATIVE_TOOL_CONTRACT_VERSION,
                request_id: label.into(),
                user_session_id: header.session_id,
                task_id: header.task_id,
                goal: header.goal,
                success_criteria: header.success_criteria,
                targets: vec![target.clone()],
                permission_mode: AgentPermissionModeNative::Operator,
            },
            turn_id: "dependency-turn".into(),
            step_id: "dependency-step".into(),
        };
        let engine = NativeToolEngine::default();
        engine
            .configure_checkpoint_root(storage.path().to_path_buf())
            .unwrap();
        let database = Database::open(&storage.path().join("native.db")).unwrap();
        Self {
            workspace,
            storage,
            cache,
            sessions,
            source,
            engine,
            database,
            credentials: CredentialManager::isolated_native_for_tests(),
            context,
            target,
            runtime,
        }
    }

    fn copy_fixture(&self, directory: &str, files: &[&str]) {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/agent-shell-sandbox-phase-5")
            .join(directory);
        for name in files {
            let destination = self.workspace.path().join(name);
            std::fs::create_dir_all(destination.parent().unwrap()).unwrap();
            std::fs::copy(root.join(name), destination).unwrap();
        }
    }

    fn execute(&self, command: &str, hosts: &[&str]) -> serde_json::Value {
        let networks = hosts
            .iter()
            .map(|host| json!({"host":host,"port":443,"resolver":"cloudflare"}))
            .collect::<Vec<_>>();
        let prepared = self.engine.prepare_authorization(self.context.clone(), AgentAuthorizeCallRequestNative {
            request_id:self.context.request.request_id.clone(),call_id:uuid::Uuid::new_v4().to_string(),
            tool_name:"exec_command".into(),target:self.target.clone(),ttl_ms:Some(180000),
            arguments:json!({"command":command,"explanation":"Install locked dependency with precise public targets and owned cache","cwd":self.context.sandbox_contract.as_ref().unwrap().root,"channel":"direct","timeoutMs":150000,"networkTargets":networks,"writePaths":[self.cache.path().canonicalize().unwrap()]}),
        }, &self.sessions,&self.database,&self.credentials,&self.storage.path().join("known_hosts")).unwrap();
        assert!(prepared.requires_native_confirmation);
        assert!(self
            .engine
            .issue_prepared_authorization(&prepared, false)
            .is_err());
        let grant = self
            .engine
            .issue_prepared_authorization(&prepared, true)
            .unwrap();
        let mut context = prepared.context;
        context.sandbox_contract = grant.sandbox_contract;
        let mut call = prepared.call;
        call.capability_id = grant.capability_id;
        call.arguments = grant.effective_arguments;
        self.engine
            .execute_tool(
                &context,
                call,
                &self.sessions,
                &self.database,
                &self.credentials,
                &self.storage.path().join("known_hosts"),
                &tokio_util::sync::CancellationToken::new(),
            )
            .unwrap()
            .data
            .unwrap()
    }

    fn assert_download_completed(&self, result: &serde_json::Value, marker: &str) {
        assert_eq!(
            result["exitCode"], 0,
            "Real dependency workflow failed: {result}"
        );
        assert_eq!(result["sandboxBackend"], "macos-seatbelt");
        assert!(result["stdout"].as_str().unwrap().contains(marker));
        assert!(
            result["networkProxy"]["connectionsStarted"]
                .as_u64()
                .unwrap()
                > 0
        );
        assert_eq!(result["networkProxy"]["closed"], true);
        assert_eq!(self.source.writes.load(Ordering::SeqCst), 0);
    }

    fn prepare_cache(&self, context: NativeExecutionContext) -> PreparedAuthorizationNative {
        self.prepare_cache_with_engine(&self.engine, context)
    }

    fn prepare_cache_with_engine(
        &self,
        engine: &NativeToolEngine,
        context: NativeExecutionContext,
    ) -> PreparedAuthorizationNative {
        let request_id = context.request.request_id.clone();
        let output = self
            .cache
            .path()
            .canonicalize()
            .unwrap()
            .join("ordinary.txt");
        assert!(!output.to_string_lossy().chars().any(char::is_whitespace));
        engine.prepare_authorization(context, AgentAuthorizeCallRequestNative {
            request_id,call_id:uuid::Uuid::new_v4().to_string(),
            tool_name:"exec_command".into(),target:self.target.clone(),ttl_ms:Some(30000),
            arguments:json!({"command":format!("touch {}",output.display()),"explanation":"Write explicitly approved owned cache","cwd":self.context.sandbox_contract.as_ref().unwrap().root,"channel":"direct","writePaths":[self.cache.path().canonicalize().unwrap()]}),
        },&self.sessions,&self.database,&self.credentials,&self.storage.path().join("known_hosts")).unwrap()
    }

    fn execute_grant(
        &self,
        prepared: PreparedAuthorizationNative,
        grant: AgentCapabilityGrantNative,
    ) -> serde_json::Value {
        let mut context = prepared.context;
        context.sandbox_contract = grant.sandbox_contract;
        let mut call = prepared.call;
        call.capability_id = grant.capability_id;
        call.arguments = grant.effective_arguments;
        self.engine
            .execute_tool(
                &context,
                call,
                &self.sessions,
                &self.database,
                &self.credentials,
                &self.storage.path().join("known_hosts"),
                &tokio_util::sync::CancellationToken::new(),
            )
            .unwrap()
            .data
            .unwrap()
    }

    fn start_service(
        &self,
        context: NativeExecutionContext,
        port: u16,
        name: &str,
    ) -> serde_json::Value {
        use crate::agent_runtime::sandbox_authorization::ResourceAuthorizationScope;
        std::fs::write(self.workspace.path().join(name),format!("require('node:http').createServer((request,response)=>response.end(require('node:fs').readFileSync('published.txt'))).listen({port},'127.0.0.1');\n")).unwrap();
        let request_id = context.request.request_id.clone();
        let prepared = self.engine.prepare_authorization(context,AgentAuthorizeCallRequestNative {
            request_id,call_id:uuid::Uuid::new_v4().to_string(),tool_name:"exec_command".into(),target:self.target.clone(),ttl_ms:Some(60000),
            arguments:json!({"command":format!("node {name}"),"explanation":"Run actual service belonging to this session","cwd":self.context.sandbox_contract.as_ref().unwrap().root,"channel":"direct","background":true,"timeoutMs":45000,"localServices":[{"port":port}]}),
        },&self.sessions,&self.database,&self.credentials,&self.storage.path().join("known_hosts")).unwrap();
        assert!(self
            .engine
            .issue_prepared_authorization(&prepared, false)
            .is_err());
        let grant = self
            .engine
            .issue_prepared_authorization_scoped(
                &prepared,
                true,
                ResourceAuthorizationScope::Session,
            )
            .unwrap();
        self.execute_grant(prepared, grant)
    }
}

#[test]
#[ignore = "Explicit opt-in: real locked pnpm install from public npm registry"]
fn approved_locked_pnpm_install_downloads_and_executes_real_dependency() {
    let workflow = Workflow::new("phase5-pnpm");
    workflow.copy_fixture(
        "pnpm",
        &["package.json", "pnpm-lock.yaml", "dependency-check.cjs"],
    );
    let lock = std::fs::read(workflow.workspace.path().join("pnpm-lock.yaml")).unwrap();
    assert!(!workflow.workspace.path().join("node_modules").exists());
    assert_eq!(std::fs::read_dir(workflow.cache.path()).unwrap().count(), 0);
    let command = format!("pnpm install --frozen-lockfile --registry=https://registry.npmjs.org --store-dir '{}' && pnpm test", workflow.cache.path().display());
    let result = workflow.execute(&command, &["registry.npmjs.org"]);
    workflow.assert_download_completed(&result, "real dependency execution completed");
    assert!(workflow
        .workspace
        .path()
        .join("node_modules/is-number/package.json")
        .is_file());
    assert_eq!(
        std::fs::read(workflow.workspace.path().join("pnpm-lock.yaml")).unwrap(),
        lock
    );
    assert!(std::fs::read_dir(workflow.cache.path()).unwrap().count() > 0);
}

#[test]
#[ignore = "Explicit opt-in: real locked cargo fetch and run from public crates registry"]
fn approved_locked_cargo_fetch_downloads_and_executes_real_dependency() {
    let workflow = Workflow::new("phase5-cargo");
    workflow.copy_fixture("rust", &["Cargo.toml", "Cargo.lock", "src/main.rs"]);
    let lock = std::fs::read(workflow.workspace.path().join("Cargo.lock")).unwrap();
    assert_eq!(std::fs::read_dir(workflow.cache.path()).unwrap().count(), 0);
    let command = format!("export CARGO_HOME='{}'; export CARGO_HTTP_PROXY=\"$ALL_PROXY\"; cargo fetch --locked && cargo run --locked --offline",workflow.cache.path().display());
    let result = workflow.execute(&command, &["index.crates.io", "static.crates.io"]);
    workflow.assert_download_completed(&result, "real Rust dependency execution completed");
    assert_eq!(
        std::fs::read(workflow.workspace.path().join("Cargo.lock")).unwrap(),
        lock
    );
}

#[test]
fn session_cache_grants_are_isolated_revoked_and_not_restored_from_checkpoint() {
    use crate::agent_runtime::sandbox_authorization::ResourceAuthorizationScope;
    let workflow = Workflow::new("phase5-session-a");
    let mut first = workflow.context.clone();
    first.request.permission_mode = AgentPermissionModeNative::ScopedAutopilot;
    let initial = workflow.prepare_cache(first.clone());
    assert!(initial.requires_native_confirmation);
    let grant = workflow
        .engine
        .issue_prepared_authorization_scoped(&initial, true, ResourceAuthorizationScope::Session)
        .unwrap();
    assert_eq!(workflow.execute_grant(initial, grant)["exitCode"], 0);
    assert!(
        !workflow
            .prepare_cache(first.clone())
            .requires_native_confirmation
    );

    let header = workflow.runtime.create_session(serde_json::from_value(json!({
        "sessionId":"phase5-session-b","taskId":"phase5-session-b","goal":"Independent ordinary session",
        "target":first.sandbox_contract.as_ref().unwrap().target,
        "executionSurface":"direct","sandboxPolicy":"workspace","permissionMode":"scopedAutopilot",
        "successCriteria":["Resource grants stay within their session"]
    })).unwrap()).unwrap().header;
    let mut second = first.clone();
    second.request.user_session_id = header.session_id.clone();
    second.request.task_id = header.task_id.clone();
    second.sandbox_contract = Some(
        AgentSandboxContract::freeze(
            header.sandbox_policy,
            header.target.as_ref().unwrap(),
            AgentExecutionSurface::Direct,
            current_unix_ms(),
        )
        .unwrap()
        .bind_to_session(&header),
    );
    let independent = workflow.prepare_cache(second.clone());
    assert!(independent.requires_native_confirmation);
    assert!(workflow
        .engine
        .issue_prepared_authorization(&independent, false)
        .is_err());
    let grant = workflow
        .engine
        .issue_prepared_authorization_scoped(
            &independent,
            true,
            ResourceAuthorizationScope::Session,
        )
        .unwrap();
    assert_eq!(workflow.execute_grant(independent, grant)["exitCode"], 0);

    let recovered = NativeToolEngine::default();
    recovered
        .configure_checkpoint_root(workflow.storage.path().to_path_buf())
        .unwrap();
    let first_contract = first.sandbox_contract.as_ref().unwrap();
    assert!(recovered
        .sandbox_authorizations(
            &first.request.user_session_id,
            &first.request.task_id,
            first_contract
        )
        .unwrap()
        .write_paths
        .is_empty());
    let recovered_request = workflow.prepare_cache_with_engine(&recovered, first.clone());
    assert!(recovered_request.requires_native_confirmation);
    assert!(recovered
        .issue_prepared_authorization(&recovered_request, false)
        .is_err());
    assert!(
        !workflow
            .prepare_cache(first.clone())
            .requires_native_confirmation
    );
    workflow
        .engine
        .cancel_task(&first.request.task_id, &workflow.sessions)
        .unwrap();
    assert!(workflow.prepare_cache(first).requires_native_confirmation);
    let remaining = workflow.prepare_cache(second.clone());
    assert!(!remaining.requires_native_confirmation);
    let grant = workflow
        .engine
        .issue_prepared_authorization(&remaining, false)
        .unwrap();
    assert_eq!(workflow.execute_grant(remaining, grant)["exitCode"], 0);
    workflow
        .engine
        .cancel_task(&second.request.task_id, &workflow.sessions)
        .unwrap();
    assert!(workflow.prepare_cache(second).requires_native_confirmation);
    assert_eq!(workflow.source.writes.load(Ordering::SeqCst), 0);
}

#[test]
fn real_node_failure_log_is_read_by_read_only_native_execution() {
    let workflow = Workflow::new("phase5-diagnostic");
    let result = workflow.execute("node -e \"require('./absent-module')\" 2> diagnostic.log; status=$?; test \"$status\" -ne 0; cat diagnostic.log",&[]);
    assert_eq!(result["exitCode"], 0);
    let logged = std::fs::read_to_string(workflow.workspace.path().join("diagnostic.log")).unwrap();
    assert!(logged.contains("MODULE_NOT_FOUND"));
    let header = workflow
        .runtime
        .create_session(
            serde_json::from_value(json!({
                "sessionId":"phase5-readonly-diagnostic","taskId":"phase5-readonly-diagnostic",
                "goal":"Inspect real Node failure log",
                "target":workflow.context.sandbox_contract.as_ref().unwrap().target,
                "executionSurface":"direct","sandboxPolicy":"readOnly","permissionMode":"operator",
                "successCriteria":["Return the actual failure log without changing project files"]
            }))
            .unwrap(),
        )
        .unwrap()
        .header;
    let mut context = workflow.context.clone();
    context.request.user_session_id = header.session_id.clone();
    context.request.task_id = header.task_id.clone();
    context.sandbox_contract = Some(
        AgentSandboxContract::freeze(
            header.sandbox_policy,
            header.target.as_ref().unwrap(),
            AgentExecutionSurface::Direct,
            current_unix_ms(),
        )
        .unwrap()
        .bind_to_session(&header),
    );
    let prepared = workflow.engine.prepare_authorization(context,AgentAuthorizeCallRequestNative {
        request_id:workflow.context.request.request_id.clone(),call_id:"read-log".into(),tool_name:"exec_command".into(),
        target:workflow.target.clone(),ttl_ms:Some(30000),
        arguments:json!({"command":"cat diagnostic.log","explanation":"Inspect actual Node failure log","cwd":workflow.context.sandbox_contract.as_ref().unwrap().root,"channel":"direct"}),
    },&workflow.sessions,&workflow.database,&workflow.credentials,&workflow.storage.path().join("known_hosts")).unwrap();
    let grant = workflow
        .engine
        .issue_prepared_authorization(&prepared, false)
        .unwrap();
    let result = workflow.execute_grant(prepared, grant);
    assert_eq!(result["exitCode"], 0, "Actual read-only result: {result}");
    assert_eq!(result["stdout"], logged);
    assert_eq!(result["sandboxBackend"], "macos-seatbelt");
    assert_eq!(workflow.source.writes.load(Ordering::SeqCst), 0);
}

#[test]
fn shutdown_cleans_normal_restricted_background_and_checkpoint_does_not_replay_it() {
    let workflow = Workflow::new("phase5-shutdown");
    let prepared = workflow.engine.prepare_authorization(workflow.context.clone(),AgentAuthorizeCallRequestNative {
        request_id:workflow.context.request.request_id.clone(),call_id:"background-before-shutdown".into(),
        tool_name:"exec_command".into(),target:workflow.target.clone(),ttl_ms:Some(60000),
        arguments:json!({"command":"printf started > rollback-marker; sleep 30; printf finished >> rollback-marker","explanation":"Verify normal owned background cleanup before rollback","cwd":workflow.context.sandbox_contract.as_ref().unwrap().root,"channel":"direct","background":true,"timeoutMs":45000}),
    },&workflow.sessions,&workflow.database,&workflow.credentials,&workflow.storage.path().join("known_hosts")).unwrap();
    let grant = workflow
        .engine
        .issue_prepared_authorization(&prepared, true)
        .unwrap();
    let result = workflow.execute_grant(prepared, grant);
    let process = workflow
        .engine
        .acceptance_process(result["processHandle"].as_str().unwrap())
        .unwrap();
    let marker = workflow.workspace.path().join("rollback-marker");
    let waiting = std::time::Instant::now();
    while std::fs::read_to_string(&marker).ok().as_deref() != Some("started") {
        assert!(
            waiting.elapsed() < std::time::Duration::from_secs(10),
            "Background did not write its actual marker"
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert!(!process.snapshot().unwrap().state.is_terminal());
    assert_eq!(
        workflow
            .engine
            .prepare_for_shutdown(&workflow.sessions)
            .unwrap(),
        1
    );
    let ended = process.snapshot().unwrap();
    assert!(ended.state.is_terminal());
    assert!(ended.termination_confirmed);
    assert!(!workflow
        .engine
        .has_task_processes(&workflow.context.request.task_id)
        .unwrap());
    let recovered = NativeToolEngine::default();
    recovered
        .configure_checkpoint_root(workflow.storage.path().to_path_buf())
        .unwrap();
    assert!(!recovered
        .has_task_processes(&workflow.context.request.task_id)
        .unwrap());
    assert_eq!(std::fs::read_to_string(&marker).unwrap(), "started");
    assert_eq!(workflow.source.writes.load(Ordering::SeqCst), 0);
    assert_eq!(
        workflow
            .runtime
            .session("phase5-shutdown")
            .unwrap()
            .header
            .sandbox_policy,
        Some(crate::agent_runtime::AgentSandboxPolicy::Workspace)
    );
}

#[test]
fn shutdown_closes_real_local_service_proxy_and_releases_owned_loopback_port() {
    use crate::agent_runtime::sandbox_authorization::ResourceAuthorizationScope;
    let workflow = Workflow::new("phase5-service-shutdown");
    let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    std::fs::write(
        workflow.workspace.path().join("published.txt"),
        "phase5-owned-service-content",
    )
    .unwrap();
    std::fs::write(workflow.workspace.path().join("service.cjs"),format!("require('node:http').createServer((request,response)=>response.end(require('node:fs').readFileSync('published.txt'))).listen({port},'127.0.0.1');\n")).unwrap();
    let prepared = workflow.engine.prepare_authorization(workflow.context.clone(),AgentAuthorizeCallRequestNative {
        request_id:workflow.context.request.request_id.clone(),call_id:"owned-service".into(),
        tool_name:"exec_command".into(),target:workflow.target.clone(),ttl_ms:Some(60000),
        arguments:json!({"command":"node service.cjs","explanation":"Verify owned local service closes before rollback","cwd":workflow.context.sandbox_contract.as_ref().unwrap().root,"channel":"direct","background":true,"timeoutMs":45000,"localServices":[{"port":port}]}),
    },&workflow.sessions,&workflow.database,&workflow.credentials,&workflow.storage.path().join("known_hosts")).unwrap();
    assert!(workflow
        .engine
        .issue_prepared_authorization(&prepared, false)
        .is_err());
    let grant = workflow
        .engine
        .issue_prepared_authorization_scoped(&prepared, true, ResourceAuthorizationScope::Session)
        .unwrap();
    let result = workflow.execute_grant(prepared, grant);
    let process = workflow
        .engine
        .acceptance_process(result["processHandle"].as_str().unwrap())
        .unwrap();
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_millis(500))
        .build()
        .unwrap();
    let waiting = std::time::Instant::now();
    loop {
        if let Ok(response) = client
            .get(format!("http://127.0.0.1:{port}/published.txt"))
            .send()
        {
            if let Ok(content) = response.text() {
                assert_eq!(content, "phase5-owned-service-content");
                break;
            }
        }
        assert!(
            waiting.elapsed() < std::time::Duration::from_secs(10),
            "Actual local service did not start: {:?}",
            process.snapshot().unwrap()
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert!(std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).is_err());
    assert_eq!(
        workflow
            .engine
            .prepare_for_shutdown(&workflow.sessions)
            .unwrap(),
        1
    );
    let ended = process.snapshot().unwrap();
    assert!(ended.state.is_terminal());
    assert!(ended.termination_confirmed);
    assert!(ended.network_proxy.unwrap().closed);
    let released = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).unwrap();
    drop(released);
    let recovered = NativeToolEngine::default();
    recovered
        .configure_checkpoint_root(workflow.storage.path().to_path_buf())
        .unwrap();
    let authorization = recovered
        .sandbox_authorizations(
            &workflow.context.request.user_session_id,
            &workflow.context.request.task_id,
            workflow.context.sandbox_contract.as_ref().unwrap(),
        )
        .unwrap();
    assert!(authorization.local_services.is_empty());
    assert!(!recovered
        .has_task_processes(&workflow.context.request.task_id)
        .unwrap());
    assert_eq!(workflow.source.writes.load(Ordering::SeqCst), 0);
}

#[test]
fn cancelling_one_session_service_keeps_other_sessions_real_service_running() {
    let workflow = Workflow::new("phase5-service-a");
    std::fs::write(
        workflow.workspace.path().join("published.txt"),
        "phase5-owned-two-service-content",
    )
    .unwrap();
    let reserved_a = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
    let reserved_b = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
    let port_a = reserved_a.local_addr().unwrap().port();
    let port_b = reserved_b.local_addr().unwrap().port();
    assert_ne!(port_a, port_b);
    drop(reserved_a);
    drop(reserved_b);
    let first = workflow.start_service(workflow.context.clone(), port_a, "service-a.cjs");
    let header = workflow.runtime.create_session(serde_json::from_value(json!({
        "sessionId":"phase5-service-b","taskId":"phase5-service-b","goal":"Independent real local service",
        "target":workflow.context.sandbox_contract.as_ref().unwrap().target,
        "executionSurface":"direct","sandboxPolicy":"workspace","permissionMode":"operator",
        "successCriteria":["Cancelling another session does not stop this service"]
    })).unwrap()).unwrap().header;
    let mut context_b = workflow.context.clone();
    context_b.request.user_session_id = header.session_id.clone();
    context_b.request.task_id = header.task_id.clone();
    context_b.sandbox_contract = Some(
        AgentSandboxContract::freeze(
            header.sandbox_policy,
            header.target.as_ref().unwrap(),
            AgentExecutionSurface::Direct,
            current_unix_ms(),
        )
        .unwrap()
        .bind_to_session(&header),
    );
    let second = workflow.start_service(context_b.clone(), port_b, "service-b.cjs");
    let process_a = workflow
        .engine
        .acceptance_process(first["processHandle"].as_str().unwrap())
        .unwrap();
    let process_b = workflow
        .engine
        .acceptance_process(second["processHandle"].as_str().unwrap())
        .unwrap();
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_millis(500))
        .build()
        .unwrap();
    for port in [port_a, port_b] {
        let waiting = std::time::Instant::now();
        loop {
            if let Ok(response) = client
                .get(format!("http://127.0.0.1:{port}/published.txt"))
                .send()
            {
                if let Ok(content) = response.text() {
                    assert_eq!(content, "phase5-owned-two-service-content");
                    break;
                }
            }
            assert!(
                waiting.elapsed() < std::time::Duration::from_secs(10),
                "Owned service did not start"
            );
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }
    workflow
        .engine
        .cancel_task(&workflow.context.request.task_id, &workflow.sessions)
        .unwrap();
    let ended_a = process_a.snapshot().unwrap();
    assert!(ended_a.state.is_terminal());
    assert!(ended_a.termination_confirmed);
    assert!(ended_a.network_proxy.unwrap().closed);
    let released_a = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port_a)).unwrap();
    drop(released_a);
    assert!(!process_b.snapshot().unwrap().state.is_terminal());
    assert!(!process_b.snapshot().unwrap().network_proxy.unwrap().closed);
    assert_eq!(
        client
            .get(format!("http://127.0.0.1:{port_b}/published.txt"))
            .send()
            .unwrap()
            .text()
            .unwrap(),
        "phase5-owned-two-service-content"
    );
    assert!(std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port_b)).is_err());
    assert_eq!(
        workflow
            .engine
            .prepare_for_shutdown(&workflow.sessions)
            .unwrap(),
        1
    );
    let ended_b = process_b.snapshot().unwrap();
    assert!(ended_b.state.is_terminal());
    assert!(ended_b.termination_confirmed);
    assert!(ended_b.network_proxy.unwrap().closed);
    let released_b = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port_b)).unwrap();
    drop(released_b);
    assert_eq!(workflow.source.writes.load(Ordering::SeqCst), 0);
}
