//! Fixed debug lifecycle acceptance on an explicitly selected saved SSH profile.
//! No model, user-session adoption, shared-state debt changes or credential export.
use super::*;
use crate::models::SessionManager;
use std::path::PathBuf;
use std::sync::Arc;
use std::thread;
use uuid::Uuid;

fn write(root: &Path, name: &str, value: &Value) -> Result<(), String> {
    std::fs::write(
        root.join(name),
        serde_json::to_vec_pretty(value).map_err(|_| "Host report invalid")?,
    )
    .map_err(|_| "Host report unavailable".into())
}

fn ledger(root: &Path) -> Result<Value, String> {
    let db = rusqlite::Connection::open(root.join("state/agent-direct-ownership.sqlite3"))
        .map_err(|_| "Host ledger unavailable")?;
    let count = |table: &str| {
        db.query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
            row.get::<_, i64>(0)
        })
        .map_err(|_| "Host ledger count unavailable")
    };
    Ok(json!({"debt":count("dispatch_debt")?,"custody":count("remote_cleanup_custody")?}))
}

fn execute(
    engine: &NativeToolEngine,
    context: &NativeExecutionContext,
    connection: &crate::db::Database,
    credentials: &crate::keychain::CredentialManager,
    sessions: &SessionManager,
    known: &Path,
    command: &str,
    background: bool,
    timeout: u64,
) -> Result<AgentToolResultNative, String> {
    let prepared = engine.prepare_authorization(
        context.clone(),
        AgentAuthorizeCallRequestNative {
            request_id: context.request.request_id.clone(),
            call_id: Uuid::new_v4().to_string(),
            tool_name: "exec_command".into(),
            target: context.request.targets[0].clone(),
            ttl_ms: None,
            arguments: json!({"command":command,"explanation":"Fixed owned Linux lifecycle check",
                         "channel":"direct","background":background,"timeoutMs":timeout}),
        },
        sessions,
        connection,
        credentials,
        known,
    )?;
    if engine
        .issue_prepared_authorization(&prepared, false)
        .is_ok()
    {
        return Err("Host check must require explicit approval".into());
    }
    // Explicit authorization applies only to this fixed acceptance command.
    let grant = engine.issue_prepared_authorization(&prepared, true)?;
    let mut call = prepared.call.clone();
    call.capability_id = grant.capability_id;
    call.arguments = grant.effective_arguments;
    engine.execute_tool(
        context,
        call,
        sessions,
        connection,
        credentials,
        known,
        &CancellationToken::new(),
    )
}

fn await_started(
    engine: &NativeToolEngine,
    result: &AgentToolResultNative,
) -> Result<Arc<super::super::ManagedProcessNative>, String> {
    let handle = result
        .data
        .as_ref()
        .and_then(|data| data["processHandle"].as_str())
        .ok_or("Host process handle unavailable")?;
    let process = engine.acceptance_process(handle)?;
    let deadline = Instant::now() + Duration::from_secs(25);
    loop {
        let snapshot = process.snapshot()?;
        if snapshot.stdout == "host-started" {
            return Ok(process);
        }
        if snapshot.state.is_terminal() || Instant::now() >= deadline {
            return Err("Host owned command did not reach actual started effect".into());
        }
        thread::sleep(Duration::from_millis(20));
    }
}

pub(super) fn run(root: &Path, name: &str, mode: &str) -> Result<(), String> {
    if !root.is_absolute()
        || !root.is_dir()
        || !matches!(mode, "lifecycle" | "crash" | "recover" | "handshake")
    {
        return Err("Host check requires an exact owned directory and fixed mode".into());
    }
    if mode != "recover"
        && std::fs::read_dir(root)
            .map_err(|_| "Host directory unavailable")?
            .next()
            .is_some()
    {
        return Err("Host check requires a new empty directory".into());
    }
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or("Home unavailable")?;
    let data = crate::shellspan_data_dir(&home);
    let database = crate::db::Database::open(&data.join("shellspan-v1.db"))?;
    if mode == "handshake" {
        return handshake(root, name, &database, &data.join("known_hosts"));
    }
    let credentials = crate::keychain::CredentialManager::new();
    let known = data.join("known_hosts");
    let engine = NativeToolEngine::default();
    engine.configure_direct_ownership(&root.join("state"))?;
    if mode == "recover" {
        if root.join("host-checkpoint.json").exists() {
            let checkpoint: Value = serde_json::from_slice(
                &std::fs::read(root.join("host-checkpoint.json"))
                    .map_err(|_| "Original host checkpoint missing")?,
            )
            .map_err(|_| "Host checkpoint invalid")?;
            if checkpoint["profileName"] != name || checkpoint["actualStarted"] != true {
                return Err("Exact owned started checkpoint required".into());
            }
        } else {
            // An earlier owned normal check may have reached the remote command
            // but failed cleanup. Only its original protected custody is used.
            let original: Value = serde_json::from_slice(
                &std::fs::read(root.join("host-normal.json"))
                    .map_err(|_| "Original own normal result missing")?,
            )
            .map_err(|_| "Own normal result invalid")?;
            let profiles = database.list_profiles()?;
            let profile = profiles
                .iter()
                .find(|profile| profile.name == name)
                .ok_or("Original profile unavailable")?;
            let completed_effect = original["data"]["stdout"] == "Linux\n0\nhost-normal"
                && original["data"]["failure"]["admission"] == "started";
            let startup_uncertain = original["data"]["failure"]["admission"] == "unknown"
                && original["data"]["terminationConfirmed"] == false
                && ledger(root)? == json!({"debt":1, "custody":1});
            if original["data"]["executionTarget"]["profileId"] != profile.id
                || !(completed_effect || startup_uncertain)
            {
                return Err("Original own execution and protected custody required".into());
            }
        }
        let result = engine.reconcile_direct_resources(&credentials, &known)?;
        let counts = ledger(root)?;
        let passed = result.uncertain == 0 && counts["debt"] == 0 && counts["custody"] == 0;
        let report_name = if root.join("host-recovery.json").exists() {
            format!("host-recovery-{}.json", Uuid::new_v4())
        } else {
            "host-recovery.json".into()
        };
        write(
            root,
            &report_name,
            &json!({"passed":passed,"recovery":result,"ledger":counts,
            "stage3Allowed":false,"scope":"cleanup-only; no original command replay or execution grant"}),
        )?;
        return if passed {
            Ok(())
        } else {
            Err("Host cleanup remains unconfirmed".into())
        };
    }
    let mut profiles = database
        .list_profiles()?
        .into_iter()
        .filter(|profile| profile.name == name);
    let profile = profiles.next().ok_or("Selected host profile missing")?;
    if profiles.next().is_some() || profile.jump_host_config.is_some() {
        return Err("One exact direct SSH profile required".into());
    }
    let sessions = SessionManager::default();
    let source_id = format!("host-source-{}", Uuid::new_v4());
    let target = AgentSessionTarget {
        kind: "remote".into(),
        target_id: format!("terminal-{source_id}"),
        session_id: source_id.clone(),
        profile_id: Some(profile.id),
        host: Some(profile.host),
        port: Some(profile.port),
        username: Some(profile.username),
        label: Some("Owned Linux host lifecycle check".into()),
        cwd: None,
        local_root: None,
        root_path: None,
    };
    let native = AgentToolTargetNative::Remote {
        target_id: target.target_id.clone(),
        session_id: source_id.clone(),
        profile_id: target.profile_id.clone(),
        host: target.host.clone().ok_or("Host missing")?,
        port: target.port.ok_or("Port missing")?,
        username: target.username.clone().ok_or("Account missing")?,
        local_root: None,
        root_path: None,
    };
    let connection = super::super::connection_for_remote_target(&native, &database, &credentials)?;
    let mut source = super::recovery::source(
        &source_id,
        &connection,
        &known,
        &sessions,
        &root.join("source-home"),
    )?;
    let header: AgentSessionHeader = serde_json::from_value(json!({"sessionId":Uuid::new_v4().to_string(),
        "taskId":Uuid::new_v4().to_string(),"goal":"Fixed owned Linux lifecycle acceptance","executionSurface":"direct",
        "sandboxPolicy":"host","createdAtUnixMs":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_| "Clock unavailable")?.as_millis() as u64,"target":target}))
        .map_err(|_| "Host header invalid")?;
    let contract = AgentSandboxContract::freeze(
        Some(AgentSandboxPolicy::Host),
        header.target.as_ref().ok_or("Target missing")?,
        AgentExecutionSurface::Direct,
        0,
    )?
    .bind_to_session(&header);
    let context = NativeExecutionContext {
        sandbox_contract: Some(contract),
        request: AgentRequestNative {
            contract_version: NATIVE_TOOL_CONTRACT_VERSION,
            request_id: Uuid::new_v4().to_string(),
            user_session_id: header.session_id.clone(),
            task_id: header.task_id.clone(),
            goal: header.goal.clone(),
            success_criteria: vec!["Exact fixed effects and signed own cleanup".into()],
            targets: vec![native],
            permission_mode: AgentPermissionModeNative::RequestApproval,
        },
        turn_id: "host-turn".into(),
        step_id: "host-step".into(),
    };
    let run = |command: &str, background, timeout| {
        execute(
            &engine,
            &context,
            &database,
            &credentials,
            &sessions,
            &known,
            command,
            background,
            timeout,
        )
    };
    let normal = run(
        "/usr/bin/uname -s; /usr/bin/id -u; printf host-normal",
        false,
        20000,
    )?;
    write(
        root,
        "host-normal.json",
        &serde_json::to_value(&normal).map_err(|_| "Host normal report invalid")?,
    )?;
    if normal.data.as_ref().is_none_or(|value| {
        value["stdout"] != "Linux\n0\nhost-normal" || value["terminationConfirmed"] != true
    }) {
        return Err("Selected profile did not prove actual Linux root normal completion".into());
    }
    if mode == "crash" {
        let running = run("printf host-started; sleep 120", true, 30000)?;
        let process = await_started(&engine, &running)?;
        write(
            root,
            "host-checkpoint.json",
            &json!({"actualStarted":true,"profileName":name,
            "process":process.snapshot()?,"ledger":ledger(root)?,"stage3Allowed":false}),
        )?;
        // Parent owns this exact Child and waits it after the requested crash.
        loop {
            thread::sleep(Duration::from_secs(1));
        }
    }
    let timeout = run("printf host-started; sleep 120", false, 8000)?;
    write(
        root,
        "host-timeout.json",
        &serde_json::to_value(&timeout).map_err(|_| "Host timeout report invalid")?,
    )?;
    if timeout.data.as_ref().is_none_or(|value| {
        value["stdout"] != "host-started"
            || value["lifecycle"] != "timedOut"
            || value["terminationConfirmed"] != true
    }) {
        return Err("Host timeout cleanup unconfirmed".into());
    }
    let running = run("printf host-started; sleep 120", true, 30000)?;
    let process = await_started(&engine, &running)?;
    let cancelled = process.kill(ProcessSignalNative::Kill, Duration::from_secs(16))?;
    write(
        root,
        "host-cancel.json",
        &serde_json::to_value(&cancelled).map_err(|_| "Host cancellation report invalid")?,
    )?;
    if !cancelled.termination_confirmed {
        return Err("Host cancellation cleanup unconfirmed".into());
    }
    process.resolve_direct_ownership()?;
    let running = run("printf host-started; sleep 120", true, 30000)?;
    let process = await_started(&engine, &running)?;
    let writes = source.finish()?;
    let disconnected = process.wait(Duration::from_secs(20))?;
    write(
        root,
        "host-disconnect.json",
        &serde_json::to_value(&disconnected).map_err(|_| "Host disconnect report invalid")?,
    )?;
    if !disconnected.termination_confirmed {
        return Err("Host disconnect cleanup unconfirmed".into());
    }
    process.resolve_direct_ownership()?;
    let counts = ledger(root)?;
    let passed = writes == 0 && counts["debt"] == 0 && counts["custody"] == 0;
    write(
        root,
        "host-lifecycle.json",
        &json!({"passed":passed,"sourceWorkerJoined":true,"sourcePtyWrites":writes,
        "ledger":counts,"stage3Allowed":false,"scope":"fixed native Linux root checks, no model or old session adoption"}),
    )?;
    if passed {
        Ok(())
    } else {
        Err("Host lifecycle evidence incomplete".into())
    }
}

fn handshake(
    root: &Path,
    name: &str,
    database: &crate::db::Database,
    known: &Path,
) -> Result<(), String> {
    let profiles = database.list_profiles()?;
    let profile = profiles
        .iter()
        .find(|profile| profile.name == name)
        .ok_or("Profile unavailable")?;
    if profile.jump_host_config.is_some() {
        return Err("Direct handshake profile required".into());
    }
    let mut results = Vec::new();
    for (preference, cipher_preference, nodelay) in [
        (None, None, true),
        (None, None, false),
        (None, None, false),
        (None, None, false),
        (None, Some("aes128-gcm@openssh.com"), true),
        (Some("curve25519-sha256"), None, true),
        (Some("ecdh-sha2-nistp256"), None, true),
        (Some("diffie-hellman-group14-sha256"), None, true),
    ] {
        let tcp = crate::connection::connect_tcp_stream(&profile.host, profile.port)?;
        tcp.set_nodelay(nodelay)
            .map_err(|_| "Diagnostic TCP option unavailable")?;
        let mut session = ssh2::Session::new().map_err(|_| "Diagnostic SSH session unavailable")?;
        let supported = session
            .supported_algs(ssh2::MethodType::Kex)
            .map_err(|_| "KEX methods unavailable")?;
        if let Some(preference) = preference {
            session
                .method_pref(ssh2::MethodType::Kex, preference)
                .map_err(|_| "Diagnostic KEX unavailable")?;
        }
        if let Some(cipher) = cipher_preference {
            for direction in [ssh2::MethodType::CryptCs, ssh2::MethodType::CryptSc] {
                session
                    .method_pref(direction, cipher)
                    .map_err(|_| "Diagnostic cipher unavailable")?;
            }
        }
        session.set_tcp_stream(tcp);
        session.set_timeout(30000);
        let started = Instant::now();
        let outcome = session.handshake();
        let trust = if outcome.is_ok() {
            crate::known_hosts::check_host_key_against_file(
                &session,
                &profile.host,
                profile.port,
                known,
            )
            .map(|value| serde_json::to_value(value).unwrap_or(Value::Null))
            .unwrap_or(Value::Null)
        } else {
            Value::Null
        };
        results.push(json!({"preference":preference,"cipherPreference":cipher_preference,"supported":supported,"elapsedMs":started.elapsed().as_millis(),
            "serverBanner":session.banner(),"timeoutMs":30000,"tcpNodelay":nodelay,
            "handshake":outcome.is_ok(),"error":outcome.err().map(|error| error.to_string()),
            "negotiatedKex":session.methods(ssh2::MethodType::Kex),
            "cipher":session.methods(ssh2::MethodType::CryptCs),"trust":trust,"authenticated":session.authenticated()}));
        let _ = session.disconnect(None, "Owned handshake-only diagnostic", None);
        write(
            root,
            "host-handshake.json",
            &json!({"results":results,"stage3Allowed":false,"credentialsRead":false,"commandsExecuted":0}),
        )?;
    }
    Ok(())
}
