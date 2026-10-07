//! Real PTY identity, session store, native approval and Direct dispatch.
use super::*;
use crate::agent_runtime::{
    AgentExecutionSurface, AgentPermissionModeNative, AgentRequestNative, AgentRuntimeBuilder,
    AgentSandboxContract, AgentToolResultStatusNative, AgentToolTargetNative,
    NATIVE_TOOL_CONTRACT_VERSION,
};
use crate::db::Database;
use crate::keychain::CredentialManager;
use crate::models::{
    ManagedSession, SessionCommand, SessionCommandSender, SessionIdentity, SessionManager,
    SessionStatus, SessionTerminalKind, StatusEvent,
};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde_json::json;
use std::io::Write;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    mpsc, Arc,
};

#[path = "external_read.rs"]
mod external_read;
#[path = "sandbox_audit.rs"]
mod sandbox_audit;
#[path = "sandbox_policy_switch.rs"]
mod sandbox_policy_switch;

#[test]
#[ignore = "Explicit opt-in: signed native network authorization with real public endpoints"]
fn native_direct_network_authorization_dispatch_and_cleanup() {
    let workspace = tempfile::tempdir().unwrap();
    let storage = tempfile::tempdir().unwrap();
    let sessions = SessionManager::default();
    let source = source(&sessions, "network-source", workspace.path());
    let runtime = AgentRuntimeBuilder::new().build();
    runtime.configure(storage.path().to_path_buf()).unwrap();
    let snapshot = runtime.create_session(serde_json::from_value(json!({
        "sessionId":"network-native", "taskId":"network-native", "goal":"Read public package and Git metadata",
        "target":{"kind":"local", "targetId":"local", "sessionId":"network-source", "cwd":workspace.path()},
        "executionSurface":"direct", "sandboxPolicy":"workspace", "permissionMode":"operator", "successCriteria":["Real metadata returned"],
    })).unwrap()).unwrap();
    let header = snapshot.header;
    let target = header.target.as_ref().unwrap();
    let base = AgentSandboxContract::freeze(
        header.sandbox_policy,
        target,
        AgentExecutionSurface::Direct,
        0,
    )
    .unwrap()
    .bind_to_session(&header);
    let native_target = AgentToolTargetNative::Local {
        target_id: target.target_id.clone(),
        session_id: target.session_id.clone(),
        cwd: target.cwd.clone(),
    };
    let context = NativeExecutionContext {
        sandbox_contract: Some(base),
        request: AgentRequestNative {
            contract_version: NATIVE_TOOL_CONTRACT_VERSION,
            request_id: "request".into(),
            user_session_id: header.session_id.clone(),
            task_id: header.task_id.clone(),
            goal: header.goal.clone(),
            success_criteria: header.success_criteria.clone(),
            targets: vec![native_target.clone()],
            permission_mode: AgentPermissionModeNative::Operator,
        },
        turn_id: "turn".into(),
        step_id: "step".into(),
    };
    let engine = NativeToolEngine::default();
    engine
        .configure_checkpoint_root(storage.path().to_path_buf())
        .unwrap();
    let database = Database::open(&storage.path().join("native.db")).unwrap();
    let credentials = CredentialManager::isolated_native_for_tests();
    let prepare = |id: &str, command: &str, host: &str, background: bool, ttl: u64| {
        engine.prepare_authorization(context.clone(), AgentAuthorizeCallRequestNative {
        request_id:"request".into(),call_id:id.into(),tool_name:"exec_command".into(),
        arguments:json!({"command":command,"explanation":"Read authorized public metadata","cwd":target.cwd,"channel":"direct","background":background,"networkTargets":[{"host":host,"port":443,"resolver":"cloudflare"}]}),
        target:native_target.clone(),ttl_ms:Some(ttl),
    }, &sessions,&database,&credentials,&storage.path().join("known_hosts"))
    };
    for (id, command, host) in [
        ("curl-first", "curl --silent --show-error --fail --max-time 10 https://registry.npmjs.org/react/latest", "registry.npmjs.org"),
        ("pnpm", "pnpm view react version --registry=https://registry.npmjs.org", "registry.npmjs.org"),
        ("git", "git ls-remote https://github.com/git/git.git HEAD", "github.com"),
        ("curl", "curl --silent --show-error --fail --max-time 10 https://registry.npmjs.org/react/latest", "registry.npmjs.org"),
    ] {
        let prepared = prepare(id,command,host,false,120000).unwrap();
        let requires = id == "curl-first" || id == "git";
        assert_eq!(prepared.requires_native_confirmation, requires);
        if requires { assert!(engine.issue_prepared_authorization(&prepared,false).is_err()); }
        let grant = if id == "curl-first" {
            engine.issue_prepared_authorization_scoped(&prepared,true,crate::agent_runtime::sandbox_authorization::ResourceAuthorizationScope::Session).unwrap()
        } else { engine.issue_prepared_authorization(&prepared,requires).unwrap() };
        let mut execution = prepared.context.clone();
        execution.sandbox_contract = grant.sandbox_contract;
        let mut call = prepared.call.clone(); call.capability_id=grant.capability_id; call.arguments=grant.effective_arguments;
        let result = engine.execute_tool(&execution,call.clone(),&sessions,&database,&credentials,&storage.path().join("known_hosts"),&tokio_util::sync::CancellationToken::new()).unwrap();
        let data=result.data.unwrap();
        assert_eq!(data["exitCode"],0,"{data}");
        assert_eq!(data["sandboxBackend"],"macos-seatbelt");
        assert!(!data["stdout"].as_str().unwrap().trim().is_empty());
        assert!(engine.execute_tool(&execution,call,&sessions,&database,&credentials,&storage.path().join("known_hosts"),&tokio_util::sync::CancellationToken::new()).is_err());
    }
    let denied = prepare(
        "denied-target",
        "curl --silent --show-error --fail --max-time 5 https://github.com",
        "registry.npmjs.org",
        false,
        10000,
    )
    .unwrap();
    let grant = engine.issue_prepared_authorization(&denied, true).unwrap();
    let mut denied_context = denied.context.clone();
    denied_context.sandbox_contract = grant.sandbox_contract;
    let mut denied_call = denied.call.clone();
    denied_call.capability_id = grant.capability_id;
    denied_call.arguments = grant.effective_arguments;
    let denied_result = engine
        .execute_tool(
            &denied_context,
            denied_call,
            &sessions,
            &database,
            &credentials,
            &storage.path().join("known_hosts"),
            &tokio_util::sync::CancellationToken::new(),
        )
        .unwrap()
        .data
        .unwrap();
    assert_ne!(denied_result["exitCode"], 0);
    assert_eq!(denied_result["networkProxy"]["connectionsStarted"], 0);
    assert_eq!(denied_result["networkProxy"]["deniedRequests"], 1);
    assert_eq!(denied_result["networkProxy"]["closed"], true);
    let prepared = prepare(
        "cancel",
        "curl --silent --show-error --limit-rate 1024 --max-time 60 https://registry.npmjs.org/react",
        "registry.npmjs.org",
        true,
        30000,
    )
    .unwrap();
    let grant = engine
        .issue_prepared_authorization_scoped(
            &prepared,
            true,
            crate::agent_runtime::sandbox_authorization::ResourceAuthorizationScope::Session,
        )
        .unwrap();
    let mut execution = prepared.context.clone();
    execution.sandbox_contract = grant.sandbox_contract;
    let mut call = prepared.call.clone();
    call.capability_id = grant.capability_id;
    call.arguments = grant.effective_arguments;
    let result = engine
        .execute_tool(
            &execution,
            call,
            &sessions,
            &database,
            &credentials,
            &storage.path().join("known_hosts"),
            &tokio_util::sync::CancellationToken::new(),
        )
        .unwrap();
    let data = result.data.unwrap();
    let handle = data["processHandle"].as_str().unwrap();
    let process = engine.acceptance_process(handle).unwrap();
    let waiting = std::time::Instant::now();
    while process
        .snapshot()
        .unwrap()
        .network_proxy
        .as_ref()
        .unwrap()
        .connections_started
        == 0
    {
        assert!(
            waiting.elapsed() < std::time::Duration::from_secs(10),
            "No actual upstream connection was observed: {:#?}",
            process.snapshot().unwrap()
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert!(!process.snapshot().unwrap().state.is_terminal());
    engine.cancel_task(&header.task_id, &sessions).unwrap();
    assert!(process.snapshot().unwrap().termination_confirmed);
    assert!(process.snapshot().unwrap().network_proxy.unwrap().closed);
    assert_eq!(source.writes.load(Ordering::SeqCst), 0);
}

struct SourcePty {
    sender: mpsc::Sender<SessionCommand>,
    worker: Option<std::thread::JoinHandle<()>>,
    writes: Arc<AtomicUsize>,
}

#[test]
fn native_direct_local_service_publishes_real_file_and_closes_owned_port() {
    local_service_acceptance(false);
}

#[test]
#[ignore = "Explicit opt-in: Vite fixture dependency installation and actual service"]
fn native_direct_vite_service_retains_pnpm_dev_command() {
    local_service_acceptance(true);
}

fn local_service_acceptance(vite: bool) {
    let workspace = tempfile::tempdir().unwrap();
    let storage = tempfile::tempdir().unwrap();
    let sessions = SessionManager::default();
    let source = source(&sessions, "service-source", workspace.path());
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let file = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml"),
    )
    .unwrap();
    std::fs::write(workspace.path().join("Cargo.toml"), &file).unwrap();
    std::fs::write(workspace.path().join("package.json"), serde_json::to_vec(&json!({"name":"shellspan-service-acceptance","private":true,"scripts":{"dev":"node server.cjs"}})).unwrap()).unwrap();
    if vite {
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../node_modules/vite/package.json");
        let installed: serde_json::Value =
            serde_json::from_slice(&std::fs::read(manifest).unwrap()).unwrap();
        std::fs::write(workspace.path().join("package.json"),serde_json::to_vec(&json!({"name":"shellspan-vite-acceptance","private":true,"scripts":{"dev":format!("vite --host localhost --port {port} --strictPort")},"devDependencies":{"vite":installed["version"]}})).unwrap()).unwrap();
        let install = std::process::Command::new("pnpm")
            .args(["install", "--registry=https://registry.npmjs.org"])
            .current_dir(workspace.path())
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap())
            .env("HOME", workspace.path())
            .env("npm_config_userconfig", "/dev/null")
            .output()
            .unwrap();
        assert!(
            install.status.success(),
            "Fixture dependency installation failed: {} {}",
            String::from_utf8_lossy(&install.stdout),
            String::from_utf8_lossy(&install.stderr)
        );
    }
    std::fs::write(workspace.path().join("server.cjs"),format!("const http=require('node:http');const fs=require('node:fs');const server=http.createServer((req,res)=>fs.createReadStream('Cargo.toml').pipe(res));server.listen({{port:{port},host:'127.0.0.1'}});\n")).unwrap();
    let runtime = AgentRuntimeBuilder::new().build();
    runtime.configure(storage.path().to_path_buf()).unwrap();
    let header = runtime.create_session(serde_json::from_value(json!({
        "sessionId":"local-service", "taskId":"local-service", "goal":"Publish ordinary project file",
        "target":{"kind":"local","targetId":"local","sessionId":"service-source","cwd":workspace.path()},
        "executionSurface":"direct","sandboxPolicy":"workspace","permissionMode":"operator","successCriteria":["Actual file served"],
    })).unwrap()).unwrap().header;
    let target = header.target.as_ref().unwrap();
    let native_target = AgentToolTargetNative::Local {
        target_id: target.target_id.clone(),
        session_id: target.session_id.clone(),
        cwd: target.cwd.clone(),
    };
    let base = AgentSandboxContract::freeze(
        header.sandbox_policy,
        target,
        AgentExecutionSurface::Direct,
        0,
    )
    .unwrap()
    .bind_to_session(&header);
    let engine = NativeToolEngine::default();
    engine
        .configure_checkpoint_root(storage.path().to_path_buf())
        .unwrap();
    let database = Database::open(&storage.path().join("native.db")).unwrap();
    let credentials = CredentialManager::isolated_native_for_tests();
    let prepared=engine.prepare_authorization(NativeExecutionContext {
        sandbox_contract:Some(base),request:AgentRequestNative {contract_version:NATIVE_TOOL_CONTRACT_VERSION,request_id:"request".into(),user_session_id:header.session_id.clone(),task_id:header.task_id.clone(),goal:header.goal.clone(),success_criteria:header.success_criteria.clone(),targets:vec![native_target.clone()],permission_mode:AgentPermissionModeNative::Operator},turn_id:"turn".into(),step_id:"step".into(),
    }, AgentAuthorizeCallRequestNative {request_id:"request".into(),call_id:"start-service".into(),tool_name:"exec_command".into(),arguments:json!({"command":"pnpm dev","explanation":"Publish the project file on an approved local port","channel":"direct","cwd":target.cwd,"background":true,"timeoutMs":20000,"localServices":[{"port":port}]}),target:native_target,ttl_ms:Some(1000)}, &sessions,&database,&credentials,&storage.path().join("known_hosts")).unwrap();
    assert!(prepared.requires_native_confirmation);
    assert!(engine
        .issue_prepared_authorization(&prepared, false)
        .is_err());
    let grant = engine
        .issue_prepared_authorization_scoped(
            &prepared,
            true,
            crate::agent_runtime::sandbox_authorization::ResourceAuthorizationScope::Session,
        )
        .unwrap();
    let mut execution = prepared.context.clone();
    execution.sandbox_contract = grant.sandbox_contract;
    let mut call = prepared.call.clone();
    call.capability_id = grant.capability_id;
    call.arguments = grant.effective_arguments;
    let data = engine
        .execute_tool(
            &execution,
            call,
            &sessions,
            &database,
            &credentials,
            &storage.path().join("known_hosts"),
            &tokio_util::sync::CancellationToken::new(),
        )
        .unwrap()
        .data
        .unwrap();
    let process = engine
        .acceptance_process(
            data["processHandle"]
                .as_str()
                .unwrap_or_else(|| panic!("Local service did not start: {data}")),
        )
        .unwrap();
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_millis(500))
        .build()
        .unwrap();
    let waiting = std::time::Instant::now();
    loop {
        if let Ok(response) = client
            .get(format!("http://127.0.0.1:{port}/Cargo.toml"))
            .send()
        {
            if let Ok(contents) = response.text() {
                assert_eq!(contents, file);
                break;
            }
        }
        assert!(
            waiting.elapsed() < std::time::Duration::from_secs(5),
            "{:#?}",
            process.snapshot().unwrap()
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert!(std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).is_err());
    let prepare_probe = |probe_port| {
        engine.prepare_authorization(
            prepared.context.clone(),
            AgentAuthorizeCallRequestNative {
                request_id: "request".into(),
                call_id: "probe".into(),
                tool_name: "probe_http".into(),
                    arguments: json!({"method":"get","port":probe_port,"path":"/Cargo.toml","timeoutMs":1000}),
                target: prepared.call.target.clone(),
                ttl_ms: None,
            },
            &sessions,
            &database,
            &credentials,
            &storage.path().join("known_hosts"),
        )
    };
    assert!(prepare_probe(if port == 65535 { port - 1 } else { port + 1 }).is_err());
    let probe = prepare_probe(port).unwrap();
    let grant = engine.issue_prepared_authorization(&probe, true).unwrap();
    let mut call = probe.call.clone();
    call.capability_id = grant.capability_id;
    call.arguments = grant.effective_arguments;
    let result = engine
        .execute_tool(
            &probe.context,
            call,
            &sessions,
            &database,
            &credentials,
            &storage.path().join("known_hosts"),
            &tokio_util::sync::CancellationToken::new(),
        )
        .unwrap();
    assert_eq!(result.data.unwrap()["body"], file);
    let repeat_service = engine
        .prepare_authorization(
            prepared.context.clone(),
            AgentAuthorizeCallRequestNative {
                request_id: "request".into(),
                call_id: "repeat-service".into(),
                tool_name: "exec_command".into(),
                arguments: prepared.call.arguments.clone(),
                target: prepared.call.target.clone(),
                ttl_ms: None,
            },
            &sessions,
            &database,
            &credentials,
            &storage.path().join("known_hosts"),
        )
        .unwrap();
    assert!(!repeat_service.requires_native_confirmation);
    engine.cancel_task(&header.task_id, &sessions).unwrap();
    assert!(engine
        .issue_prepared_authorization(&repeat_service, false)
        .is_err());
    assert!(prepare_probe(port).is_err());
    assert!(process.snapshot().unwrap().termination_confirmed);
    assert!(process.snapshot().unwrap().network_proxy.unwrap().closed);
    assert!(client
        .get(format!("http://127.0.0.1:{port}/"))
        .send()
        .is_err());
    assert!(std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).is_ok());
    let expired = engine.prepare_authorization(prepared.context.clone(),AgentAuthorizeCallRequestNative {
        request_id:"request".into(),call_id:"expiry".into(),tool_name:"exec_command".into(),arguments:json!({"command":"node server.cjs","explanation":"Verify local service expiry","channel":"direct","cwd":target.cwd,"background":true,"timeoutMs":1500,"localServices":[{"port":port}]}),target:prepared.call.target.clone(),ttl_ms:None,
    },&sessions,&database,&credentials,&storage.path().join("known_hosts")).unwrap();
    assert!(expired.requires_native_confirmation);
    let grant = engine.issue_prepared_authorization(&expired, true).unwrap();
    let mut context = expired.context.clone();
    context.sandbox_contract = grant.sandbox_contract;
    let mut call = expired.call.clone();
    call.capability_id = grant.capability_id;
    call.arguments = grant.effective_arguments;
    let data = engine
        .execute_tool(
            &context,
            call,
            &sessions,
            &database,
            &credentials,
            &storage.path().join("known_hosts"),
            &tokio_util::sync::CancellationToken::new(),
        )
        .unwrap()
        .data
        .unwrap();
    let process = engine
        .acceptance_process(data["processHandle"].as_str().unwrap())
        .unwrap();
    let result = process.wait(std::time::Duration::from_secs(4)).unwrap();
    assert_eq!(result.state, ProcessLifecycleNative::TimedOut);
    assert!(result.termination_confirmed);
    assert!(result.network_proxy.unwrap().closed);
    assert!(std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).is_ok());
    assert_eq!(source.writes.load(Ordering::SeqCst), 0);
}
impl Drop for SourcePty {
    fn drop(&mut self) {
        let _ = self.sender.send(SessionCommand::Close);
        if let Some(worker) = self.worker.take() {
            worker.join().expect("source PTY worker");
        }
    }
}

fn source(sessions: &SessionManager, id: &str, root: &std::path::Path) -> SourcePty {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();
    let mut command = CommandBuilder::new("/bin/sh");
    command.cwd(root);
    let mut child = pair.slave.spawn_command(command).unwrap();
    assert!(child.try_wait().unwrap().is_none());
    let mut writer = pair.master.take_writer().unwrap();
    let (sender, receiver) = mpsc::channel();
    let writes = Arc::new(AtomicUsize::new(0));
    let counter = writes.clone();
    let worker = std::thread::spawn(move || {
        while let Ok(command) = receiver.recv() {
            match command {
                SessionCommand::Write(input) => {
                    counter.fetch_add(1, Ordering::SeqCst);
                    writer.write_all(input.as_bytes()).unwrap();
                    writer.flush().unwrap();
                }
                SessionCommand::WriteBytes(input) => {
                    counter.fetch_add(1, Ordering::SeqCst);
                    writer.write_all(&input).unwrap();
                    writer.flush().unwrap();
                }
                SessionCommand::Resize { cols, rows } => pair
                    .master
                    .resize(PtySize {
                        cols: cols as u16,
                        rows: rows as u16,
                        pixel_width: 0,
                        pixel_height: 0,
                    })
                    .unwrap(),
                SessionCommand::Close => break,
            }
        }
        drop(writer);
        drop(pair);
        child.kill().unwrap();
        child.wait().unwrap();
    });
    sessions
        .insert(
            id.into(),
            ManagedSession {
                sender: SessionCommandSender::Standard(sender.clone()),
                waker: None,
                output_state_sender: None,
                status: StatusEvent {
                    session_id: id.into(),
                    status: SessionStatus::Connected,
                    message: None,
                },
                output_ready: Arc::new(AtomicBool::new(true)),
                output_paused: Arc::new(AtomicBool::new(false)),
                terminal_kind: SessionTerminalKind::Local,
                identity: SessionIdentity {
                    title: "Native acceptance source".into(),
                    host: "local".into(),
                    port: 0,
                    username: std::env::var("USER").unwrap(),
                },
            },
        )
        .unwrap();
    SourcePty {
        sender,
        worker: Some(worker),
        writes,
    }
}

#[test]
fn native_direct_frozen_session_approval_dispatch_uses_seatbelt_not_source_pty() {
    let workspace = tempfile::tempdir().unwrap();
    let storage = tempfile::tempdir().unwrap();
    let sessions = SessionManager::default();
    let source = source(&sessions, "source-native-direct", workspace.path());
    let runtime = AgentRuntimeBuilder::new().build();
    runtime.configure(storage.path().to_path_buf()).unwrap();
    let snapshot = runtime.create_session(serde_json::from_value(json!({
        "sessionId":"native-direct", "taskId":"native-direct", "goal":"Write ordinary project file",
        "target":{"kind":"local", "targetId":"local", "sessionId":"source-native-direct", "cwd":workspace.path()},
        "executionSurface":"direct", "sandboxPolicy":"workspace", "permissionMode":"requestApproval", "successCriteria":["Project file contains ordinary"],
    })).unwrap()).unwrap();
    let header = snapshot.header;
    let target = header.target.as_ref().unwrap();
    let contract = AgentSandboxContract::freeze(
        header.sandbox_policy,
        target,
        AgentExecutionSurface::Direct,
        0,
    )
    .unwrap()
    .bind_to_session(&header);
    contract.validate_session(&header, 0).unwrap();
    let native_target = AgentToolTargetNative::Local {
        target_id: target.target_id.clone(),
        session_id: target.session_id.clone(),
        cwd: target.cwd.clone(),
    };
    let engine = NativeToolEngine::default();
    engine
        .configure_checkpoint_root(storage.path().to_path_buf())
        .unwrap();
    let database = Database::open(&storage.path().join("native.db")).unwrap();
    let credentials = CredentialManager::isolated_native_for_tests();
    let prepared = engine.prepare_authorization(NativeExecutionContext {
        sandbox_contract: Some(contract.clone()),
        request: AgentRequestNative {contract_version: NATIVE_TOOL_CONTRACT_VERSION, request_id: "request".into(), user_session_id: header.session_id.clone(), task_id: header.task_id.clone(), goal: header.goal.clone(), success_criteria: header.success_criteria.clone(), targets: vec![native_target.clone()], permission_mode: AgentPermissionModeNative::RequestApproval},
        turn_id: "turn".into(), step_id: "step".into(),
    }, AgentAuthorizeCallRequestNative {
        request_id: "request".into(), call_id: "call".into(), tool_name: "exec_command".into(),
        arguments: json!({"command":"printf ordinary > ordinary.txt; cat ordinary.txt", "explanation":"Write project acceptance file", "cwd":target.cwd, "channel":"direct"}),
        target: native_target, ttl_ms: None,
    }, &sessions, &database, &credentials, &storage.path().join("known_hosts")).unwrap();
    assert!(prepared.requires_native_confirmation);
    assert!(engine
        .issue_prepared_authorization(&prepared, false)
        .is_err());
    let grant = engine
        .issue_prepared_authorization(&prepared, true)
        .unwrap();
    let mut call = prepared.call.clone();
    call.capability_id = grant.capability_id;
    call.arguments = grant.effective_arguments;
    let result = engine
        .execute_tool(
            &prepared.context,
            call,
            &sessions,
            &database,
            &credentials,
            &storage.path().join("known_hosts"),
            &tokio_util::sync::CancellationToken::new(),
        )
        .unwrap();
    assert_eq!(result.status, AgentToolResultStatusNative::Completed);
    let data = result.data.unwrap();
    assert_eq!(data["exitCode"], 0, "{data}");
    assert_eq!(data["sandboxBackend"], "macos-seatbelt");
    assert_eq!(data["sandboxContract"], json!(contract));
    assert_eq!(data["sandboxCapability"]["status"], "partial");
    assert_eq!(
        std::fs::read_to_string(workspace.path().join("ordinary.txt")).unwrap(),
        "ordinary"
    );
    assert_eq!(
        source.writes.load(Ordering::SeqCst),
        0,
        "Direct must not inject into source PTY"
    );

    let protected = workspace.path().join(".env.production");
    std::fs::write(&protected, "PROJECT_CONFIGURATION=approved\n").unwrap();
    runtime
        .set_permission_mode(
            &header.session_id,
            crate::agent_runtime::AgentSessionPermissionMode::Operator,
        )
        .unwrap();
    let mut context = prepared.context.clone();
    context.request.permission_mode = AgentPermissionModeNative::Operator;
    let prepared_read = engine.prepare_authorization(context, AgentAuthorizeCallRequestNative {
        request_id:"request".into(), call_id:"read-config".into(), tool_name:"exec_command".into(),
        arguments:json!({"command":"cat .env.production", "explanation":"Read project configuration once", "channel":"direct", "cwd":target.cwd, "readPaths":[protected]}),
        target:prepared.call.target.clone(), ttl_ms:Some(1000),
    }, &sessions, &database, &credentials, &storage.path().join("known_hosts")).unwrap();
    assert!(
        prepared_read.requires_native_confirmation,
        "Operator must still approve resource expansion"
    );
    assert!(engine
        .issue_prepared_authorization(&prepared_read, false)
        .is_err());
    let grant = engine
        .issue_prepared_authorization(&prepared_read, true)
        .unwrap();
    let mut read_context = prepared_read.context.clone();
    read_context.sandbox_contract = grant.sandbox_contract;
    let mut read_call = prepared_read.call.clone();
    read_call.capability_id = grant.capability_id;
    read_call.arguments = grant.effective_arguments;
    let mut changed_context = read_context.clone();
    changed_context
        .sandbox_contract
        .as_mut()
        .unwrap()
        .resource_grants
        .clear();
    assert!(engine
        .execute_tool(
            &changed_context,
            read_call.clone(),
            &sessions,
            &database,
            &credentials,
            &storage.path().join("known_hosts"),
            &tokio_util::sync::CancellationToken::new()
        )
        .is_err());
    let result = engine
        .execute_tool(
            &read_context,
            read_call.clone(),
            &sessions,
            &database,
            &credentials,
            &storage.path().join("known_hosts"),
            &tokio_util::sync::CancellationToken::new(),
        )
        .unwrap();
    let data = result.data.unwrap();
    assert_eq!(data["exitCode"], 0, "{data}");
    assert_eq!(data["stdout"], "PROJECT_CONFIGURATION=approved\n");
    assert_eq!(
        data["sandboxContract"]["resourceGrants"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(
        engine
            .execute_tool(
                &read_context,
                read_call,
                &sessions,
                &database,
                &credentials,
                &storage.path().join("known_hosts"),
                &tokio_util::sync::CancellationToken::new()
            )
            .is_err(),
        "Call authorization cannot be reused"
    );

    let prepare_session_read = |call_id: &str| {
        engine.prepare_authorization(prepared_read.context.clone(), AgentAuthorizeCallRequestNative {
        request_id:"request".into(), call_id:call_id.into(), tool_name:"exec_command".into(),
        arguments:json!({"command":"cat .env.production", "explanation":"Read authorized project config", "channel":"direct", "cwd":target.cwd, "readPaths":[protected]}),
        target:prepared.call.target.clone(), ttl_ms:Some(1000),
    }, &sessions, &database, &credentials, &storage.path().join("known_hosts"))
    };
    let first_session_read = prepare_session_read("session-first").unwrap();
    let session_grant = engine
        .issue_prepared_authorization_scoped(
            &first_session_read,
            true,
            crate::agent_runtime::sandbox_authorization::ResourceAuthorizationScope::Session,
        )
        .unwrap();
    assert!(session_grant.sandbox_contract.is_some());
    let status = engine
        .sandbox_authorizations(&header.session_id, &header.task_id, &contract)
        .unwrap();
    assert_eq!(status.state, "active");
    assert_eq!(
        status.read_paths,
        vec![protected
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .to_string()]
    );
    assert!(status.expires_at_unix_ms.unwrap() > status.checked_at_unix_ms);
    let repeat_session_read = prepare_session_read("session-repeat").unwrap();
    assert!(
        !repeat_session_read.requires_native_confirmation,
        "Session resource approval is reused in Operator mode"
    );
    let repeat_grant = engine
        .issue_prepared_authorization(&repeat_session_read, false)
        .unwrap();
    let mut repeat_context = repeat_session_read.context.clone();
    repeat_context.sandbox_contract = repeat_grant.sandbox_contract;
    let mut repeat_call = repeat_session_read.call.clone();
    repeat_call.capability_id = repeat_grant.capability_id;
    repeat_call.arguments = repeat_grant.effective_arguments;
    assert_eq!(
        engine
            .execute_tool(
                &repeat_context,
                repeat_call,
                &sessions,
                &database,
                &credentials,
                &storage.path().join("known_hosts"),
                &tokio_util::sync::CancellationToken::new()
            )
            .unwrap()
            .data
            .unwrap()["exitCode"],
        0
    );
    engine.cancel_task(&header.task_id, &sessions).unwrap();
    assert_eq!(
        engine
            .sandbox_authorizations(&header.session_id, &header.task_id, &contract)
            .unwrap()
            .state,
        "none"
    );
    assert!(
        engine
            .issue_prepared_authorization(&repeat_session_read, false)
            .is_err(),
        "Revocation invalidates prepared automatic resource reuse"
    );
    assert!(
        prepare_session_read("session-after-revoke")
            .unwrap()
            .requires_native_confirmation
    );

    let expiring = engine.prepare_authorization(prepared_read.context.clone(), AgentAuthorizeCallRequestNative {
        request_id:"request".into(), call_id:"expiry".into(), tool_name:"exec_command".into(),
        arguments:json!({"command":"sleep 30; cat .env.production", "explanation":"Verify real authorization deadline", "channel":"direct", "cwd":target.cwd, "readPaths":[protected]}),
        target:prepared.call.target.clone(), ttl_ms:Some(300),
    }, &sessions, &database, &credentials, &storage.path().join("known_hosts")).unwrap();
    let grant = engine
        .issue_prepared_authorization(&expiring, true)
        .unwrap();
    let mut expiring_context = expiring.context.clone();
    expiring_context.sandbox_contract = grant.sandbox_contract;
    let mut expiring_call = expiring.call.clone();
    expiring_call.capability_id = grant.capability_id;
    expiring_call.arguments = grant.effective_arguments;
    let result = engine
        .execute_tool(
            &expiring_context,
            expiring_call,
            &sessions,
            &database,
            &credentials,
            &storage.path().join("known_hosts"),
            &tokio_util::sync::CancellationToken::new(),
        )
        .unwrap();
    assert_eq!(result.status, AgentToolResultStatusNative::TimedOut);
    assert_eq!(result.data.unwrap()["terminationConfirmed"], true);
    let latest = tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(runtime.cancel(&header.session_id))
        .unwrap();
    assert!(latest.ended);
    assert_ne!(
        latest.header.sandbox_binding_revision,
        header.sandbox_binding_revision
    );
    assert!(read_context
        .sandbox_contract
        .as_ref()
        .unwrap()
        .validate_session(&latest.header, 0)
        .unwrap_err()
        .contains("session binding or policy changed"));
}

#[test]
fn native_workspace_scoped_autopilot_executes_ordinary_build_test_and_modification() {
    let workspace = tempfile::tempdir().unwrap();
    let storage = tempfile::tempdir().unwrap();
    for name in ["package.json", "sum.js", "sum.node-check.mjs"] {
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/agent-shell-sandbox-phase-2/projects/node")
            .join(name);
        std::fs::copy(fixture, workspace.path().join(name)).unwrap();
    }
    let rust_fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../tests/agent-shell-sandbox-phase-2/projects/rust");
    std::fs::create_dir(workspace.path().join("src")).unwrap();
    std::fs::copy(
        rust_fixture.join("Cargo.toml"),
        workspace.path().join("Cargo.toml"),
    )
    .unwrap();
    std::fs::copy(
        rust_fixture.join("src/lib.rs"),
        workspace.path().join("src/lib.rs"),
    )
    .unwrap();
    std::fs::write(
        workspace.path().join(".env.production"),
        "AUTOPILOT_CHECK=ordinary\n",
    )
    .unwrap();
    let sessions = SessionManager::default();
    let source = source(&sessions, "autopilot-source", workspace.path());
    let runtime = AgentRuntimeBuilder::new().build();
    runtime.configure(storage.path().to_path_buf()).unwrap();
    let snapshot = runtime.create_session(serde_json::from_value(json!({
        "sessionId":"workspace-autopilot", "taskId":"workspace-autopilot", "goal":"Build and test ordinary project",
        "target":{"kind":"local", "targetId":"local", "sessionId":"autopilot-source", "cwd":workspace.path()},
        "executionSurface":"direct", "sandboxPolicy":"workspace", "permissionMode":"scopedAutopilot",
        "successCriteria":["Ordinary project builds and tests complete"],
    })).unwrap()).unwrap();
    let header = snapshot.header;
    let target = header.target.as_ref().unwrap();
    let contract = AgentSandboxContract::freeze(
        header.sandbox_policy,
        target,
        AgentExecutionSurface::Direct,
        current_unix_ms(),
    )
    .unwrap()
    .bind_to_session(&header);
    let native_target = AgentToolTargetNative::Local {
        target_id: target.target_id.clone(),
        session_id: target.session_id.clone(),
        cwd: target.cwd.clone(),
    };
    let engine = NativeToolEngine::default();
    engine
        .configure_checkpoint_root(storage.path().to_path_buf())
        .unwrap();
    let database = Database::open(&storage.path().join("native.db")).unwrap();
    let credentials = CredentialManager::isolated_native_for_tests();
    let prepare = |command: &str, mode, policy, reads: Vec<String>| {
        let mut binding = contract.clone();
        binding.policy = policy;
        engine.prepare_authorization(NativeExecutionContext {
            sandbox_contract: Some(binding),
            request: AgentRequestNative { contract_version:NATIVE_TOOL_CONTRACT_VERSION, request_id:"request".into(), user_session_id:header.session_id.clone(), task_id:header.task_id.clone(), goal:header.goal.clone(), success_criteria:header.success_criteria.clone(), targets:vec![native_target.clone()], permission_mode:mode },
            turn_id:"turn".into(), step_id:"step".into(),
        }, AgentAuthorizeCallRequestNative {
            request_id:"request".into(), call_id:uuid::Uuid::new_v4().to_string(), tool_name:"exec_command".into(),
            arguments:json!({"command":command,"explanation":"Ordinary acceptance operation","cwd":target.cwd,"channel":"direct","readPaths":reads}), target:native_target.clone(),ttl_ms:None,
        }, &sessions, &database, &credentials, &storage.path().join("known_hosts"))
    };
    for command in [
        "pnpm build",
        "pnpm test",
        "cargo check --offline",
        "cargo test --offline",
        "touch ordinary.txt",
        "mkdir generated",
    ] {
        let prepared = prepare(
            command,
            AgentPermissionModeNative::ScopedAutopilot,
            crate::agent_runtime::AgentSandboxPolicy::Workspace,
            vec![],
        )
        .unwrap();
        assert!(!prepared.requires_native_confirmation, "{command}");
        let grant = engine
            .issue_prepared_authorization(&prepared, false)
            .unwrap();
        let mut context = prepared.context.clone();
        context.sandbox_contract = grant.sandbox_contract;
        let mut call = prepared.call.clone();
        call.capability_id = grant.capability_id;
        call.arguments = grant.effective_arguments;
        let result = engine
            .execute_tool(
                &context,
                call,
                &sessions,
                &database,
                &credentials,
                &storage.path().join("known_hosts"),
                &tokio_util::sync::CancellationToken::new(),
            )
            .unwrap()
            .data
            .unwrap();
        assert_eq!(result["exitCode"], 0, "{command}: {result}");
    }
    assert!(workspace.path().join("ordinary.txt").is_file());
    assert!(workspace.path().join("generated").is_dir());
    for command in [
        "rm ordinary.txt",
        "curl https://registry.npmjs.org",
        "custom-maintenance-tool",
        "pnpm publish",
    ] {
        let prepared = prepare(
            command,
            AgentPermissionModeNative::ScopedAutopilot,
            crate::agent_runtime::AgentSandboxPolicy::Workspace,
            vec![],
        );
        assert!(
            prepared.is_err() || prepared.unwrap().requires_native_confirmation,
            "{command}"
        );
    }
    let protected = workspace
        .path()
        .join(".env.production")
        .to_string_lossy()
        .to_string();
    let sensitive = prepare(
        "cat .env.production",
        AgentPermissionModeNative::ScopedAutopilot,
        crate::agent_runtime::AgentSandboxPolicy::Workspace,
        vec![protected.clone()],
    )
    .unwrap();
    assert!(sensitive.requires_native_confirmation);
    engine
        .issue_prepared_authorization_scoped(
            &sensitive,
            true,
            crate::agent_runtime::sandbox_authorization::ResourceAuthorizationScope::Session,
        )
        .unwrap();
    assert!(
        prepare(
            "cat .env.production",
            AgentPermissionModeNative::ScopedAutopilot,
            crate::agent_runtime::AgentSandboxPolicy::Workspace,
            vec![protected]
        )
        .unwrap()
        .requires_native_confirmation
    );
    for (mode, policy) in [
        (
            AgentPermissionModeNative::RequestApproval,
            crate::agent_runtime::AgentSandboxPolicy::Workspace,
        ),
        (
            AgentPermissionModeNative::ScopedAutopilot,
            crate::agent_runtime::AgentSandboxPolicy::Host,
        ),
        (
            AgentPermissionModeNative::ScopedAutopilot,
            crate::agent_runtime::AgentSandboxPolicy::ReadOnly,
        ),
    ] {
        assert!(
            prepare("pnpm build", mode, policy, vec![])
                .unwrap()
                .requires_native_confirmation
        );
    }
    let _source_sender = &source.sender;
    assert_eq!(source.writes.load(std::sync::atomic::Ordering::SeqCst), 0);
}

#[test]
fn native_cache_write_authorization_once_session_expiry_and_revocation() {
    use crate::agent_runtime::sandbox_authorization::ResourceAuthorizationScope;
    let workspace = tempfile::tempdir().unwrap();
    let storage = tempfile::tempdir().unwrap();
    let cache = tempfile::tempdir().unwrap();
    let unrelated = tempfile::tempdir().unwrap();
    let cache_path = cache
        .path()
        .canonicalize()
        .unwrap()
        .to_string_lossy()
        .to_string();
    let output = cache.path().join("ordinary.txt");
    let command = format!(
        "printf cache-value > {}; cat {}",
        output.display(),
        output.display()
    );
    let sessions = SessionManager::default();
    let source = source(&sessions, "cache-source", workspace.path());
    let runtime = AgentRuntimeBuilder::new().build();
    runtime.configure(storage.path().to_path_buf()).unwrap();
    let snapshot = runtime.create_session(serde_json::from_value(json!({
        "sessionId":"cache-native", "taskId":"cache-native", "goal":"Write ordinary cache file",
        "target":{"kind":"local", "targetId":"local", "sessionId":"cache-source", "cwd":workspace.path()},
        "executionSurface":"direct", "sandboxPolicy":"workspace", "permissionMode":"operator", "successCriteria":["Owned cache file is written only after approval"],
    })).unwrap()).unwrap();
    let header = snapshot.header;
    let target = header.target.as_ref().unwrap();
    let contract = AgentSandboxContract::freeze(
        header.sandbox_policy,
        target,
        AgentExecutionSurface::Direct,
        current_unix_ms(),
    )
    .unwrap()
    .bind_to_session(&header);
    let native_target = AgentToolTargetNative::Local {
        target_id: target.target_id.clone(),
        session_id: target.session_id.clone(),
        cwd: target.cwd.clone(),
    };
    let engine = NativeToolEngine::default();
    engine
        .configure_checkpoint_root(storage.path().to_path_buf())
        .unwrap();
    let database = Database::open(&storage.path().join("native.db")).unwrap();
    let credentials = CredentialManager::isolated_native_for_tests();
    let prepare = |command: &str, writes: Vec<String>, background: bool, ttl: Option<u64>, mode| {
        engine.prepare_authorization(NativeExecutionContext {
            sandbox_contract:Some(contract.clone()),
            request:AgentRequestNative {contract_version:NATIVE_TOOL_CONTRACT_VERSION,request_id:"request".into(),user_session_id:header.session_id.clone(),task_id:header.task_id.clone(),goal:header.goal.clone(),success_criteria:header.success_criteria.clone(),targets:vec![native_target.clone()],permission_mode:mode},turn_id:"turn".into(),step_id:"step".into(),
        }, AgentAuthorizeCallRequestNative {
            request_id:"request".into(),call_id:uuid::Uuid::new_v4().to_string(),tool_name:"exec_command".into(),target:native_target.clone(),ttl_ms:ttl,
            arguments:json!({"command":command,"explanation":"Write an explicitly approved owned cache","cwd":target.cwd,"channel":"direct","background":background,"timeoutMs":30000,"writePaths":writes}),
        }, &sessions,&database,&credentials,&storage.path().join("known_hosts"))
    };
    let execute = |prepared: &PreparedAuthorizationNative, grant: AgentCapabilityGrantNative| {
        let mut context = prepared.context.clone();
        context.sandbox_contract = grant.sandbox_contract;
        let mut call = prepared.call.clone();
        call.capability_id = grant.capability_id;
        call.arguments = grant.effective_arguments;
        engine.execute_tool(
            &context,
            call,
            &sessions,
            &database,
            &credentials,
            &storage.path().join("known_hosts"),
            &tokio_util::sync::CancellationToken::new(),
        )
    };
    let ungranted = prepare(
        &command,
        vec![],
        false,
        None,
        AgentPermissionModeNative::Operator,
    )
    .unwrap();
    let ungranted_result = execute(
        &ungranted,
        engine
            .issue_prepared_authorization(&ungranted, false)
            .unwrap(),
    )
    .unwrap()
    .data
    .unwrap();
    assert_ne!(ungranted_result["exitCode"], 0);
    assert!(!output.exists());
    let first = prepare(
        &command,
        vec![cache_path.clone()],
        false,
        None,
        AgentPermissionModeNative::Operator,
    )
    .unwrap();
    assert!(first.requires_native_confirmation);
    assert!(engine.issue_prepared_authorization(&first, false).is_err());
    let grant = engine.issue_prepared_authorization(&first, true).unwrap();
    let frozen = grant.sandbox_contract.as_ref().unwrap();
    assert!(frozen.resource_grants.iter().any(|grant| matches!(&grant.resource,crate::agent_runtime::AgentSandboxResource::WritePath {path} if path == &cache_path)));
    let result = execute(&first, grant).unwrap().data.unwrap();
    assert_eq!(result["exitCode"], 0, "{result}");
    assert_eq!(std::fs::read_to_string(&output).unwrap(), "cache-value");
    assert_eq!(
        engine
            .sandbox_authorizations(&header.session_id, &header.task_id, &contract)
            .unwrap()
            .state,
        "none"
    );
    let next = prepare(
        &command,
        vec![cache_path.clone()],
        false,
        None,
        AgentPermissionModeNative::Operator,
    )
    .unwrap();
    assert!(
        next.requires_native_confirmation,
        "Once scope never becomes session scope"
    );
    let timed = prepare(
        &format!(
            "touch {}; sleep 30",
            cache.path().join("timed.txt").display()
        ),
        vec![cache_path.clone()],
        true,
        Some(500),
        AgentPermissionModeNative::Operator,
    )
    .unwrap();
    let timed_result = execute(
        &timed,
        engine.issue_prepared_authorization(&timed, true).unwrap(),
    )
    .unwrap()
    .data
    .unwrap();
    let timed_process = engine
        .acceptance_process(timed_result["processHandle"].as_str().unwrap())
        .unwrap();
    let expired = timed_process
        .wait(std::time::Duration::from_secs(3))
        .unwrap();
    assert_eq!(expired.state, ProcessLifecycleNative::TimedOut);
    assert!(expired.termination_confirmed);
    let session = prepare(
        &command,
        vec![cache_path.clone()],
        false,
        None,
        AgentPermissionModeNative::Operator,
    )
    .unwrap();
    let session_grant = engine
        .issue_prepared_authorization_scoped(&session, true, ResourceAuthorizationScope::Session)
        .unwrap();
    assert_eq!(
        execute(&session, session_grant).unwrap().data.unwrap()["exitCode"],
        0
    );
    let status = engine
        .sandbox_authorizations(&header.session_id, &header.task_id, &contract)
        .unwrap();
    assert_eq!(status.state, "active");
    assert_eq!(status.write_paths, vec![cache_path.clone()]);
    let reused = prepare(
        &format!("touch {}", cache.path().join("reused.txt").display()),
        vec![cache_path.clone()],
        false,
        None,
        AgentPermissionModeNative::ScopedAutopilot,
    )
    .unwrap();
    assert!(
        !reused.requires_native_confirmation,
        "Approved cache resources permit recognized workspace operations"
    );
    assert_eq!(
        execute(
            &reused,
            engine.issue_prepared_authorization(&reused, false).unwrap()
        )
        .unwrap()
        .data
        .unwrap()["exitCode"],
        0
    );
    let denied = prepare(
        &format!(
            "touch {}",
            unrelated.path().join("not-authorized.txt").display()
        ),
        vec![cache_path.clone()],
        false,
        None,
        AgentPermissionModeNative::Operator,
    )
    .unwrap();
    assert_ne!(
        execute(
            &denied,
            engine.issue_prepared_authorization(&denied, false).unwrap()
        )
        .unwrap()
        .data
        .unwrap()["exitCode"],
        0
    );
    assert!(!unrelated.path().join("not-authorized.txt").exists());
    let prepared_before_revoke = prepare(
        &command,
        vec![cache_path.clone()],
        false,
        None,
        AgentPermissionModeNative::Operator,
    )
    .unwrap();
    let issued_before_revoke = engine
        .issue_prepared_authorization(&prepared_before_revoke, false)
        .unwrap();
    engine.cancel_task(&header.task_id, &sessions).unwrap();
    assert!(
        execute(&prepared_before_revoke, issued_before_revoke).is_err(),
        "Revocation invalidates already issued native authority"
    );
    assert_eq!(
        engine
            .sandbox_authorizations(&header.session_id, &header.task_id, &contract)
            .unwrap()
            .state,
        "none"
    );
    assert!(
        prepare(
            &command,
            vec![cache_path.clone()],
            false,
            None,
            AgentPermissionModeNative::Operator
        )
        .unwrap()
        .requires_native_confirmation
    );
    let mut read_only = contract.clone();
    read_only.policy = crate::agent_runtime::AgentSandboxPolicy::ReadOnly;
    assert!(
        crate::agent_runtime::sandbox_authorization::cache_write_requests(
            &read_only,
            &[cache_path.clone()]
        )
        .is_err()
    );
    for directory in [
        std::env::home_dir().unwrap(),
        std::env::temp_dir(),
        workspace.path().to_path_buf(),
        std::path::PathBuf::from("/etc"),
    ] {
        assert!(
            crate::agent_runtime::sandbox_authorization::cache_write_requests(
                &contract,
                &[directory.to_string_lossy().to_string()]
            )
            .is_err()
        );
    }
    assert!(
        prepare(
            &command,
            vec![storage
                .path()
                .canonicalize()
                .unwrap()
                .to_string_lossy()
                .to_string()],
            false,
            None,
            AgentPermissionModeNative::Operator
        )
        .is_err(),
        "Runtime storage cannot be authorized as a cache"
    );
    assert_eq!(source.writes.load(std::sync::atomic::Ordering::SeqCst), 0);
}

#[path = "developer_workflow.rs"]
mod developer_workflow;
