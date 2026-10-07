//! Native path sandbox. Hard-link aliases and hostile same-account races are
//! explicit limitations; this is not a file-object isolation provider.
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use std::time::Duration;

use crate::agent_runtime::{
    AgentExecutionSurface, AgentSandboxContract, AgentSandboxNetworkPolicy, AgentSandboxPolicy,
};

static VERIFIED: OnceLock<bool> = OnceLock::new();

pub(crate) fn verified() -> bool {
    VERIFIED.get().copied().unwrap_or(false)
}

/// Called on the blocking execution path, never from snapshot rendering.
pub(crate) fn verify_backend() -> bool {
    *VERIFIED.get_or_init(|| {
        let check = || -> Result<bool, String> {
            let workspace = tempfile::tempdir().map_err(|_| "sandboxTempUnavailable")?;
            let target = serde_json::from_value(serde_json::json!({
                "kind": "local", "targetId": "sandbox-preflight", "sessionId": "sandbox-preflight",
                "cwd": workspace.path().to_str(),
            }))
            .map_err(|_| "sandboxPreflightInvalid")?;
            let contract = AgentSandboxContract::freeze(
                Some(AgentSandboxPolicy::ReadOnly),
                &target,
                AgentExecutionSurface::Direct,
                0,
            )?;
            let (mut child, temp) = command("printf native-ready", &contract)?;
            child.stdin(std::process::Stdio::null());
            let process = super::process::spawn_local_child_native(
                "sandbox-preflight".into(),
                "sandbox-preflight".into(),
                "sandbox-preflight".into(),
                child,
                Some(temp),
                Duration::from_secs(2),
            )?;
            let result = process.wait(Duration::from_secs(3))?;
            Ok(result.exit_code == Some(0) && result.stdout == "native-ready")
        };
        check().unwrap_or(false)
    })
}

fn quoted(path: &Path) -> Result<String, String> {
    let value = path.to_str().ok_or("sandboxPathInvalid: non UTF-8 path")?;
    if value.chars().any(char::is_control) {
        return Err("sandboxPathInvalid: control character".into());
    }
    serde_json::to_string(value).map_err(|_| "sandboxPathInvalid".into())
}

fn rule(profile: &mut String, operation: &str, path: &Path) -> Result<(), String> {
    profile.push_str(&format!(
        "(allow {operation} (subpath {}))\n",
        quoted(path)?
    ));
    Ok(())
}

pub(crate) fn sensitive_paths() -> Result<Vec<String>, String> {
    let home = std::env::home_dir().ok_or("sandboxHomeUnavailable")?;
    let mut paths = [
        ".shellspan",
        ".shellspan-dev",
        ".ssh",
        ".aws",
        ".gnupg",
        ".codex",
        ".config",
        ".cargo/credentials",
        ".cargo/credentials.toml",
        "Library/Keychains",
        "Library/Application Support/com.shellspan",
    ]
    .iter()
    .map(|relative| {
        home.join(relative)
            .to_str()
            .map(str::to_owned)
            .ok_or("sandboxPathInvalid".into())
    })
    .collect::<Result<Vec<_>, String>>()?;
    paths.extend(
        [
            "/Library/Keychains",
            "/private/etc/ssh",
            "/private/etc/master.passwd",
        ]
        .into_iter()
        .map(str::to_owned),
    );
    Ok(paths)
}

pub(super) fn command(
    input: &str,
    contract: &AgentSandboxContract,
) -> Result<(Command, tempfile::TempDir), String> {
    let (command, temp, proxy) = command_tracked(input, contract)?;
    if proxy.is_some() {
        return Err("sandboxPolicyUnsupported: network proxy requires tracked execution".into());
    }
    Ok((command, temp))
}

pub(super) fn command_tracked(
    input: &str,
    contract: &AgentSandboxContract,
) -> Result<
    (
        Command,
        tempfile::TempDir,
        Option<super::network_proxy::NetworkProxy>,
    ),
    String,
> {
    if contract.policy == AgentSandboxPolicy::Host
        || contract.target.kind != "local"
        || contract.execution_surface != AgentExecutionSurface::Direct
        || contract.network != AgentSandboxNetworkPolicy::Deny
    {
        return Err("sandboxPolicyUnsupported: native Direct deny-network policy required".into());
    }
    let root = PathBuf::from(contract.root.as_ref().ok_or("sandboxWorkspaceMissing")?);
    if !root.is_dir()
        || std::fs::canonicalize(&root).map_err(|_| "sandboxWorkspaceInvalid")? != root
        || root.parent().is_none()
    {
        return Err("sandboxWorkspaceInvalid: frozen root changed".into());
    }
    let home = std::env::home_dir().ok_or("sandboxHomeUnavailable")?;
    if !contract.resource_grants.is_empty() {
        contract.authorize_dispatch(&contract.target, current_time_ms())?;
    }
    let granted_reads = contract
        .resource_grants
        .iter()
        .filter_map(|grant| match &grant.resource {
            crate::agent_runtime::AgentSandboxResource::ReadPath { path } => Some(path.clone()),
            crate::agent_runtime::AgentSandboxResource::WritePath { .. } => None,
            crate::agent_runtime::AgentSandboxResource::NetworkTarget { .. } => None,
            crate::agent_runtime::AgentSandboxResource::LocalService { .. } => None,
        })
        .collect::<Vec<_>>();
    let verified_reads = crate::agent_runtime::sandbox_authorization::project_read_requests(
        contract,
        &granted_reads,
    )?;
    let granted_writes = contract
        .resource_grants
        .iter()
        .filter_map(|grant| match &grant.resource {
            crate::agent_runtime::AgentSandboxResource::WritePath { path } => Some(path.clone()),
            _ => None,
        })
        .collect::<Vec<_>>();
    let verified_writes = crate::agent_runtime::sandbox_authorization::cache_write_requests(
        contract,
        &granted_writes,
    )?;
    if home.starts_with(&root) {
        return Err("sandboxWorkspaceInvalid: workspace includes account home".into());
    }
    if contract.read_allow != vec![root.to_string_lossy().into_owned()]
        || contract.write_allow
            != if contract.policy == AgentSandboxPolicy::Workspace {
                vec![root.to_string_lossy().into_owned()]
            } else {
                vec![]
            }
    {
        return Err("sandboxPolicyUnsupported: unverified path grant".into());
    }
    let temp = tempfile::Builder::new()
        .prefix("shellspan-native-")
        .tempdir()
        .map_err(|_| "sandboxTempUnavailable")?;
    let temp_root = std::fs::canonicalize(temp.path()).map_err(|_| "sandboxTempUnavailable")?;
    let cache = temp_root.join("cache");
    std::fs::create_dir(&cache).map_err(|_| "sandboxTempUnavailable")?;
    let proxy = super::network_proxy::NetworkProxy::start(&temp_root, contract)?;
    let mut profile = String::from(
        "(version 1)\n(deny default)\n(import \"system.sb\")\n(allow process*)\n(allow signal (target same-sandbox))\n(deny network*)\n(deny file-write* (subpath \"/cores\"))\n",
    );
    for path in [
        "/System",
        "/usr",
        "/bin",
        "/sbin",
        "/Library",
        "/Applications/Xcode.app",
        "/opt/homebrew",
        "/dev",
        "/private/etc",
        "/private/var/db/dyld",
    ] {
        rule(&mut profile, "file-read*", Path::new(path))?;
    }
    // Permit metadata traversal without exposing all account file contents.
    profile.push_str("(allow file-read-metadata)\n");
    rule(&mut profile, "file-read*", &root)?;
    for relative in [
        ".cargo",
        ".rustup",
        ".nvm/versions/node",
        ".volta/tools/image",
        ".local/share/mise/installs",
        "Library/pnpm",
        ".local/share/pnpm",
    ] {
        rule(&mut profile, "file-read*", &home.join(relative))?;
    }
    rule(&mut profile, "file-read*", &temp_root)?;
    rule(&mut profile, "file-write*", &temp_root)?;
    profile.push_str("(allow file-write* (literal \"/dev/null\"))\n");
    if contract.policy == AgentSandboxPolicy::Workspace {
        rule(&mut profile, "file-write*", &root)?;
    }
    for path in verified_writes {
        rule(&mut profile, "file-read*", Path::new(&path))?;
        rule(&mut profile, "file-write*", Path::new(&path))?;
    }
    let mut denied: Vec<PathBuf> = sensitive_paths()?.into_iter().map(PathBuf::from).collect();
    denied.extend(contract.deny.iter().map(PathBuf::from));
    for path in denied {
        if verified_reads.iter().any(|read| Path::new(read) == path) {
            profile.push_str(&format!(
                "(deny file-write* (subpath {}))\n",
                quoted(&path)?
            ));
        } else {
            profile.push_str(&format!(
                "(deny file-read* file-write* (subpath {}))\n",
                quoted(&path)?
            ));
        }
    }
    // Project build configuration is readable only at the frozen root. Other
    // dotenv files remain denied; writes retain the sensitive-file boundary.
    let project_env = quoted(&root.join(".env.local"))?;
    let mut read_exceptions = format!("(literal {project_env})");
    for read in verified_reads {
        profile.push_str(&format!(
            "(allow file-read* (literal {}))\n",
            quoted(Path::new(&read))?
        ));
        read_exceptions.push_str(&format!(" (literal {})", quoted(Path::new(&read))?));
    }
    profile.push_str(&format!(
        "(deny file-write* (regex #\"(^|/)\\.env($|\\.)\"))\n(deny file-read* (require-all (regex #\"(^|/)\\.env($|\\.)\") (require-not (require-any {read_exceptions}))))\n"
    ));
    let mut process = Command::new("/usr/bin/sandbox-exec");
    process.env_clear();
    if let Some(proxy) = &proxy {
        for socket in [&proxy.http_socket, &proxy.socks_socket] {
            profile.push_str(&format!(
                "(allow network-outbound (literal {}))\n",
                quoted(socket)?
            ));
        }
        let adapter = temp_root.join("client.cjs");
        for service in &proxy.services {
            profile.push_str(&format!(
                "(allow network-inbound network-outbound (literal {}))\n",
                quoted(&service.socket)?
            ));
        }
        let sealed = temp_root.join("s");
        profile.push_str(&format!(
            "(deny file-write* (subpath {}))\n",
            quoted(&sealed)?
        ));
        if !proxy.services.is_empty() {
            let descriptors = proxy.service_fds();
            use std::os::unix::process::CommandExt;
            // Only app-created, already-bound listeners survive exec. No path is opened here.
            unsafe {
                process.pre_exec(move || {
                    for descriptor in &descriptors {
                        let flags = libc::fcntl(*descriptor, libc::F_GETFD);
                        if flags < 0
                            || libc::fcntl(*descriptor, libc::F_SETFD, flags & !libc::FD_CLOEXEC)
                                < 0
                        {
                            return Err(std::io::Error::last_os_error());
                        }
                    }
                    Ok(())
                });
            }
        }
        std::fs::write(&adapter, include_str!("network_client.cjs"))
            .map_err(|_| "sandboxNetworkProxyUnavailable")?;
        let socks = format!("socks5h://localhost{}", proxy.socks_socket.display());
        let curl_home = temp_root.join("curl");
        std::fs::create_dir(&curl_home).map_err(|_| "sandboxNetworkProxyUnavailable")?;
        std::fs::write(
            curl_home.join(".curlrc"),
            format!(
                "proxy = {}\n",
                serde_json::to_string(&socks).map_err(|_| "sandboxNetworkProxyUnavailable")?
            ),
        )
        .map_err(|_| "sandboxNetworkProxyUnavailable")?;
        process
            .env("HTTP_PROXY", "http://127.0.0.1:65535")
            .env("HTTPS_PROXY", "http://127.0.0.1:65535")
            .env("http_proxy", "http://127.0.0.1:65535")
            .env("https_proxy", "http://127.0.0.1:65535")
            .env("ALL_PROXY", &socks)
            .env("NO_PROXY", "")
            .env("no_proxy", "")
            .env("SHELLSPAN_PROXY_SOCKET", &proxy.http_socket)
            .env(
                "SHELLSPAN_SERVICE_ROUTES",
                serde_json::to_string(&proxy.services)
                    .map_err(|_| "sandboxNetworkProxyUnavailable")?,
            )
            .env("NODE_OPTIONS", format!("--require={}", quoted(&adapter)?))
            .env("CURL_HOME", curl_home)
            .env("GIT_CONFIG_COUNT", "2")
            .env("GIT_CONFIG_KEY_0", "credential.helper")
            .env("GIT_CONFIG_VALUE_0", "")
            .env("GIT_CONFIG_KEY_1", "http.proxy")
            .env("GIT_CONFIG_VALUE_1", socks);
    }
    process.args(["-p", &profile, "/bin/sh", "-c", input]);
    process.current_dir(&root);
    // Keep host tool locations, but never forward arbitrary ambient variables.
    let path = std::env::var_os("PATH").ok_or("sandboxToolPathUnavailable")?;
    let selected = Command::new("/usr/bin/xcode-select")
        .arg("-p")
        .output()
        .map_err(|_| "sandboxToolPathUnavailable: developer directory lookup failed")?;
    let developer = String::from_utf8(selected.stdout)
        .map_err(|_| "sandboxToolPathUnavailable: invalid developer directory")?;
    let developer = Path::new(developer.trim());
    let path = if selected.status.success()
        && [
            Path::new("/Library/Developer/CommandLineTools"),
            Path::new("/Applications/Xcode.app/Contents/Developer"),
        ]
        .contains(&developer)
        && developer.join("usr/bin/git").is_file()
    {
        std::env::join_paths(
            std::iter::once(developer.join("usr/bin")).chain(std::env::split_paths(&path)),
        )
        .map_err(|_| "sandboxToolPathUnavailable: invalid tool search path")?
    } else {
        path
    };
    process
        .env("PATH", path)
        .env("HOME", &home)
        .env("LANG", "en_US.UTF-8")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("TMPDIR", &temp_root)
        .env("TMP", &temp_root)
        .env("TEMP", &temp_root)
        .env("XDG_CACHE_HOME", &cache)
        .env("npm_config_cache", cache.join("npm"))
        .env("npm_config_store_dir", cache.join("pnpm"));
    Ok((process, temp, proxy))
}

fn current_time_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(debug_assertions)]
pub(crate) fn run_check(root: &Path, input: &str) -> Result<serde_json::Value, String> {
    let directory = tempfile::tempdir().map_err(|_| "sandboxAcceptanceStorageUnavailable")?;
    let runtime = crate::agent_runtime::AgentRuntimeBuilder::new().build();
    runtime.configure(directory.path().to_path_buf())?;
    let session_id = uuid::Uuid::new_v4().to_string();
    let snapshot = runtime.create_session(serde_json::from_value(serde_json::json!({
        "sessionId": session_id, "taskId": session_id, "goal": "Native sandbox acceptance",
        "target": {"kind": "local", "targetId": "native-check", "sessionId": "native-check", "cwd": root.to_str()},
        "sandboxPolicy": "workspace", "permissionMode": "requestApproval", "executionSurface": "direct",
    })).map_err(|_| "sandboxAcceptanceRequestInvalid")?)?;
    let target = snapshot
        .header
        .target
        .as_ref()
        .ok_or("sandboxWorkspaceMissing")?;
    let contract = AgentSandboxContract::freeze(
        snapshot.header.sandbox_policy,
        target,
        snapshot.header.execution_surface,
        0,
    )?
    .bind_to_session(&snapshot.header);
    contract.validate_session(&snapshot.header, 0)?;
    contract.authorize_call(&session_id, "native-check", target, 0)?;
    let process = super::spawn_sandboxed_local_process_native(
        session_id.clone(),
        session_id,
        target.target_id.clone(),
        input,
        &contract,
        Duration::from_secs(600),
    )?;
    let result = process.wait(Duration::from_secs(601))?;
    Ok(
        serde_json::json!({"coverage": "frozen-session-native-launcher", "capability": snapshot.sandbox_capability, "contract": contract, "result": result}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runtime::AgentSessionTarget;
    use std::time::Duration;

    include!("macos_network_acceptance.rs");
    include!("macos_ssh_network_acceptance.rs");

    #[test]
    #[ignore = "Explicit opt-in: real Git public-repository transport acceptance"]
    fn native_sandbox_git_original_command_uses_unix_socks_proxy() {
        let workspace = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(workspace.path()).unwrap();
        let socket = root.join("git.sock");
        let server_socket = socket.clone();
        let cancellation = tokio_util::sync::CancellationToken::new();
        let stopped = cancellation.clone();
        let worker = std::thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async move {
                let listener = tokio::net::UnixListener::bind(server_socket).unwrap();
                let mut connections = tokio::task::JoinSet::new();
                loop {
                    tokio::select! {
                        _ = stopped.cancelled() => break,
                        incoming = listener.accept() => {
                            let (stream, _) = incoming.unwrap();
                            connections.spawn(async move {
                                let (protocol, command, target) = fast_socks5::server::Socks5ServerProtocol::accept_no_auth(stream).await.unwrap().read_command().await.unwrap();
                                if command != fast_socks5::Socks5Command::TCPConnect || target != fast_socks5::util::target_addr::TargetAddr::Domain("github.com".into(), 443) {
                                    protocol.reply_error(&fast_socks5::ReplyError::ConnectionNotAllowed).await.unwrap();
                                    return;
                                }
                                let mut upstream = tokio::net::TcpStream::connect(("github.com", 443)).await.unwrap();
                                let mut client = protocol.reply_success(upstream.local_addr().unwrap()).await.unwrap();
                                tokio::io::copy_bidirectional(&mut client, &mut upstream).await.unwrap();
                            });
                        }
                    }
                }
                connections.abort_all();
                while connections.join_next().await.is_some() {}
            });
        });
        let waiting = std::time::Instant::now();
        while !socket.exists() && waiting.elapsed() < Duration::from_secs(5) {
            std::thread::sleep(Duration::from_millis(20));
        }
        let outcome = (|| {
            let (template, temp) = command(
                "git ls-remote https://github.com/git/git.git HEAD",
                &contract(&root, AgentSandboxPolicy::Workspace),
            )
            .unwrap();
            let mut arguments = template
                .get_args()
                .map(|arg| arg.to_os_string())
                .collect::<Vec<_>>();
            arguments[1] = format!(
                "{}\n(allow network-outbound (literal {}))\n",
                arguments[1].to_str().unwrap(),
                quoted(&socket).unwrap()
            )
            .into();
            let mut client = Command::new(template.get_program());
            client.args(arguments).current_dir(&root).env_clear();
            for (name, value) in template.get_envs() {
                if let Some(value) = value {
                    client.env(name, value);
                }
            }
            let proxy = format!("socks5h://localhost{}", socket.display());
            client
                .env("ALL_PROXY", &proxy)
                .env("HTTPS_PROXY", &proxy)
                .env("https_proxy", &proxy)
                .env("NO_PROXY", "")
                .env("GIT_TERMINAL_PROMPT", "0")
                .env("GIT_CONFIG_COUNT", "2")
                .env("GIT_CONFIG_KEY_0", "credential.helper")
                .env("GIT_CONFIG_VALUE_0", "")
                .env("GIT_CONFIG_KEY_1", "http.proxy")
                .env("GIT_CONFIG_VALUE_1", &proxy);
            let process = super::super::process::spawn_local_child_native(
                "compatibility".into(),
                "git".into(),
                "local".into(),
                client,
                Some(temp),
                Duration::from_secs(25),
            )
            .unwrap();
            process.wait(Duration::from_secs(27)).unwrap()
        })();
        cancellation.cancel();
        worker.join().unwrap();
        assert_eq!(outcome.exit_code, Some(0), "{outcome:?}");
        assert!(
            outcome.stdout.trim_end().ends_with("\tHEAD"),
            "Git returned no real HEAD reference"
        );
    }

    #[test]
    #[ignore = "Explicit opt-in: real pnpm public-registry transport acceptance"]
    fn native_sandbox_pnpm_original_command_uses_unix_proxy_adapter() {
        struct Server(std::process::Child);
        impl Drop for Server {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let workspace = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(workspace.path()).unwrap();
        let socket = root.join("proxy.sock");
        let scripts =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/agent-shell-sandbox-phase-3");
        let adapter = root.join("client.cjs");
        std::fs::copy(scripts.join("node-unix-proxy.cjs"), &adapter).unwrap();
        let mut server = Server(
            Command::new("node")
                .arg(scripts.join("registry-proxy.cjs"))
                .arg(&socket)
                .stdout(std::process::Stdio::null())
                .spawn()
                .unwrap(),
        );
        let waiting = std::time::Instant::now();
        while !socket.exists() {
            assert!(
                server.0.try_wait().unwrap().is_none(),
                "Registry transport exited before binding its Unix socket"
            );
            assert!(
                waiting.elapsed() < Duration::from_secs(5),
                "Registry transport did not bind its Unix socket"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        let (template, temp) = command(
            "pnpm view react version --registry=https://registry.npmjs.org",
            &contract(&root, AgentSandboxPolicy::Workspace),
        )
        .unwrap();
        let mut arguments = template
            .get_args()
            .map(|arg| arg.to_os_string())
            .collect::<Vec<_>>();
        assert_eq!(arguments[0], "-p");
        arguments[1] = format!(
            "{}\n(allow network-outbound (literal {}))\n",
            arguments[1].to_str().unwrap(),
            quoted(&socket).unwrap()
        )
        .into();
        let mut client = Command::new(template.get_program());
        client.args(arguments).current_dir(&root).env_clear();
        for (name, value) in template.get_envs() {
            if let Some(value) = value {
                client.env(name, value);
            }
        }
        client
            .env("HTTP_PROXY", "http://127.0.0.1:65535")
            .env("HTTPS_PROXY", "http://127.0.0.1:65535")
            .env("NO_PROXY", "")
            .env("SHELLSPAN_PROXY_SOCKET", &socket)
            .env("NODE_OPTIONS", format!("--require={}", adapter.display()))
            .env("npm_config_fetch_retries", "0")
            .env("npm_config_fetch_timeout", "10000");
        let process = super::super::process::spawn_local_child_native(
            "compatibility".into(),
            "pnpm".into(),
            "local".into(),
            client,
            Some(temp),
            Duration::from_secs(25),
        )
        .unwrap();
        let result = process.wait(Duration::from_secs(27)).unwrap();
        assert_eq!(result.exit_code, Some(0), "{result:?}");
        assert!(
            !result.stdout.trim().is_empty(),
            "Registry returned no package version"
        );
    }

    fn contract(root: &Path, policy: AgentSandboxPolicy) -> AgentSandboxContract {
        let target: AgentSessionTarget = serde_json::from_value(serde_json::json!({
            "kind": "local", "targetId": "native-sandbox", "sessionId": "native-sandbox",
            "localRoot": root.to_str().unwrap(), "cwd": root.to_str().unwrap(),
        }))
        .unwrap();
        AgentSandboxContract::freeze(Some(policy), &target, AgentExecutionSurface::Direct, 1)
            .unwrap()
    }

    #[test]
    fn native_sandbox_workspace_read_write_and_clean_environment() {
        let workspace = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink("ordinary.txt", workspace.path().join("ordinary-link.txt"))
            .unwrap();
        let frozen = contract(workspace.path(), AgentSandboxPolicy::Workspace);
        let process = super::super::spawn_sandboxed_local_process_native(
            "task".into(), "request".into(), "native-sandbox".into(),
            "printf source > ordinary.txt; /bin/sh -c 'cat ordinary-link.txt'; test -z \"$SSH_AUTH_SOCK\"; test -z \"$OPENAI_API_KEY\"; printf scratch > \"$TMPDIR/scratch\"",
            &frozen, Duration::from_secs(5),
        ).unwrap();
        let result = process.wait(Duration::from_secs(6)).unwrap();
        assert_eq!(result.exit_code, Some(0), "{result:?}");
        assert_eq!(result.stdout, "source");
        assert_eq!(
            std::fs::read_to_string(workspace.path().join("ordinary.txt")).unwrap(),
            "source"
        );
    }

    #[test]
    fn phase2_normal_links_and_nested_shell_inheritance() {
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(workspace.path().join("ordinary.txt"), "initial").unwrap();
        std::fs::write(outside.path().join("ordinary.txt"), "outside-owned-marker").unwrap();
        std::os::unix::fs::symlink("ordinary.txt", workspace.path().join("inside-link")).unwrap();
        std::os::unix::fs::symlink("missing.txt", workspace.path().join("dangling-link")).unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("ordinary.txt"),
            workspace.path().join("outside-link"),
        )
        .unwrap();
        std::fs::write(workspace.path().join("nested.sh"), "cat inside-link\nprintf changed > inside-link\nif cat outside-link; then exit 20; fi\nif printf wrong > outside-link; then exit 21; fi\nif cat dangling-link; then exit 22; fi\nprintf inherited > \"$TMPDIR/inherited\"\ntest \"$XDG_CACHE_HOME\" = \"$TMPDIR/cache\"\n").unwrap();
        std::fs::write(workspace.path().join("middle.sh"), "/bin/sh nested.sh\n").unwrap();
        let frozen = contract(workspace.path(), AgentSandboxPolicy::Workspace);
        let (mut child, temp) = command("/bin/sh -c '/bin/sh middle.sh'", &frozen).unwrap();
        let output = child.output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(output.stdout, b"initial");
        assert_eq!(
            std::fs::read_to_string(workspace.path().join("ordinary.txt")).unwrap(),
            "changed"
        );
        assert_eq!(
            std::fs::read_to_string(outside.path().join("ordinary.txt")).unwrap(),
            "outside-owned-marker"
        );
        assert_eq!(
            std::fs::read_to_string(temp.path().join("inherited")).unwrap(),
            "inherited"
        );
        assert!(!workspace.path().join("missing.txt").exists());
    }

    #[test]
    fn phase2_normal_concurrent_command_temp_and_cache_are_independent() {
        let workspace = tempfile::tempdir().unwrap();
        let frozen = contract(workspace.path(), AgentSandboxPolicy::Workspace);
        let mut commands = Vec::new();
        for marker in ["first", "second"] {
            let input = format!("printf '{marker}' > \"$TMPDIR/same-name\"; printf '{marker}' > \"$XDG_CACHE_HOME/same-name\"; sleep 0.2; cat \"$TMPDIR/same-name\"; cat \"$XDG_CACHE_HOME/same-name\"");
            let (mut command, temp) = command(&input, &frozen).unwrap();
            command
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());
            commands.push((command.spawn().unwrap(), temp, marker));
        }
        assert_ne!(commands[0].1.path(), commands[1].1.path());
        for (child, temp, marker) in commands {
            let output = child.wait_with_output().unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert_eq!(String::from_utf8(output.stdout).unwrap(), marker.repeat(2));
            assert_eq!(
                std::fs::read_to_string(temp.path().join("same-name")).unwrap(),
                marker
            );
            assert_eq!(
                std::fs::read_to_string(temp.path().join("cache/same-name")).unwrap(),
                marker
            );
        }
    }

    #[test]
    fn phase2_normal_worker_signals_stay_within_same_sandbox() {
        struct OwnedChild(std::process::Child);
        impl Drop for OwnedChild {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let mut unrelated = OwnedChild(Command::new("/bin/sleep").arg("30").spawn().unwrap());
        let workspace = tempfile::tempdir().unwrap();
        std::fs::write(workspace.path().join("signals.cjs"), format!(
            "const assert = require('node:assert/strict');\nconst cp = require('node:child_process');\nprocess.kill(process.pid, 0);\nassert.throws(() => process.kill({}, 0), error => error.code === 'EPERM');\nconst child = cp.spawn(process.execPath, ['-e', 'setInterval(() => {{}}, 1000)']);\nchild.once('spawn', () => {{ assert.equal(child.kill('SIGTERM'), true); }});\nchild.once('exit', (code, signal) => {{ assert.equal(signal, 'SIGTERM'); process.stdout.write('worker-cleaned'); }});\n", unrelated.0.id())).unwrap();
        let (mut child, _temp) = command(
            "node signals.cjs",
            &contract(workspace.path(), AgentSandboxPolicy::Workspace),
        )
        .unwrap();
        let output = child.output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(output.stdout, b"worker-cleaned");
        assert!(unrelated.0.try_wait().unwrap().is_none());
    }

    #[test]
    fn phase2_normal_independent_sandboxes_cannot_signal_each_others_workers() {
        use std::io::{BufRead, BufReader};
        use std::os::unix::process::CommandExt;
        struct OwnedGroup(std::process::Child, bool);
        impl Drop for OwnedGroup {
            fn drop(&mut self) {
                if self.1 {
                    return;
                }
                unsafe {
                    libc::kill(-(self.0.id() as i32), libc::SIGKILL);
                }
                let _ = self.0.wait();
            }
        }
        let workspace = tempfile::tempdir().unwrap();
        std::fs::write(workspace.path().join("holder.cjs"), "const cp=require('node:child_process');const child=cp.spawn(process.execPath,['-e','setInterval(() => {}, 1000)']);child.once('spawn',()=>process.stdout.write(String(child.pid)+'\\n'));\n").unwrap();
        let first = contract(workspace.path(), AgentSandboxPolicy::Workspace);
        let (mut command, _first_temp) = command("node holder.cjs", &first).unwrap();
        command
            .process_group(0)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let mut first_group = OwnedGroup(command.spawn().unwrap(), false);
        let mut line = String::new();
        BufReader::new(first_group.0.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        let worker: u32 = line.trim().parse().expect("first sandbox worker PID");
        assert!(first_group.0.try_wait().unwrap().is_none());
        std::fs::write(workspace.path().join("second.cjs"), format!("const assert=require('node:assert/strict');const cp=require('node:child_process');let failure;const child=cp.spawn(process.execPath,['-e','setInterval(() => {{}}, 1000);setTimeout(()=>process.exit(),5000)']);child.once('spawn',()=>{{try{{assert.throws(()=>process.kill({worker},0),error=>error.code==='EPERM');}}catch(error){{failure=error;}}finally{{child.kill('SIGTERM');}}}});child.once('exit',(code,signal)=>{{assert.equal(signal,'SIGTERM');if(failure)throw failure;process.stdout.write('independent');}});\n")).unwrap();
        let mut second = first.clone();
        second.target.session_id = "second-normal-session".into();
        second.target.target_id = "second-normal-target".into();
        let (mut command, _second_temp) = super::command("node second.cjs", &second).unwrap();
        command
            .process_group(0)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let mut second_group = OwnedGroup(command.spawn().unwrap(), false);
        let output = second_group.0.stdout.take().unwrap();
        let mut text = String::new();
        std::io::Read::read_to_string(&mut BufReader::new(output), &mut text).unwrap();
        let status = second_group.0.wait().unwrap();
        second_group.1 = true;
        assert!(
            status.success(),
            "second sandbox did not preserve its signal boundary"
        );
        assert_eq!(text, "independent");
        assert!(first_group.0.try_wait().unwrap().is_none());
        assert_eq!(unsafe { libc::kill(worker as i32, 0) }, 0);
    }

    #[test]
    fn native_sandbox_read_only_and_sensitive_path_rejection() {
        let workspace = tempfile::tempdir().unwrap();
        std::fs::write(workspace.path().join("ordinary.txt"), "readable").unwrap();
        std::fs::write(workspace.path().join(".env"), "fixture-private").unwrap();
        for (policy, input) in [
            (
                AgentSandboxPolicy::ReadOnly,
                "cat ordinary.txt; printf change > ordinary.txt",
            ),
            (AgentSandboxPolicy::Workspace, "cat .env"),
        ] {
            let (mut child, _temp) = command(input, &contract(workspace.path(), policy)).unwrap();
            let output = child.output().unwrap();
            assert!(!output.status.success(), "operation unexpectedly succeeded");
            assert!(!String::from_utf8_lossy(&output.stdout).contains("fixture-private"));
        }
        assert_eq!(
            std::fs::read_to_string(workspace.path().join("ordinary.txt")).unwrap(),
            "readable"
        );
    }

    #[test]
    fn native_sandbox_project_env_local_is_readable_but_not_writable() {
        let workspace = tempfile::tempdir().unwrap();
        let configuration = "PROJECT_CONFIGURATION=enabled\n";
        std::fs::write(workspace.path().join(".env.local"), configuration).unwrap();
        std::fs::write(workspace.path().join(".env.production"), configuration).unwrap();
        for policy in [AgentSandboxPolicy::ReadOnly, AgentSandboxPolicy::Workspace] {
            let frozen = contract(workspace.path(), policy);
            let (mut child, _temp) = command("cat .env.local", &frozen).unwrap();
            let output = child.output().unwrap();
            assert!(output.status.success());
            assert_eq!(output.stdout, configuration.as_bytes());
            for input in ["printf change > .env.local", "cat .env.production"] {
                let (mut child, _temp) = command(input, &frozen).unwrap();
                assert!(!child.output().unwrap().status.success());
            }
        }
        assert_eq!(
            std::fs::read_to_string(workspace.path().join(".env.local")).unwrap(),
            configuration
        );
    }

    #[test]
    fn native_sandbox_background_stdin_and_deadline() {
        let workspace = tempfile::tempdir().unwrap();
        let frozen = contract(workspace.path(), AgentSandboxPolicy::Workspace);
        let process = super::super::spawn_sandboxed_local_process_native(
            "task".into(),
            "request".into(),
            "native-sandbox".into(),
            "read line; printf '%s' \"$line\"",
            &frozen,
            Duration::from_secs(5),
        )
        .unwrap();
        process
            .validate_sandbox_input(Some(&frozen), "native-sandbox")
            .unwrap();
        let mut rebound = frozen.clone();
        rebound.binding_revision += 1;
        assert!(process
            .validate_sandbox_input(Some(&rebound), "native-sandbox")
            .is_err());
        assert!(process
            .validate_sandbox_input(None, "native-sandbox")
            .is_err());
        process
            .write_stdin("ordinary-input\n".into(), true)
            .unwrap();
        let result = process.wait(Duration::from_secs(6)).unwrap();
        assert_eq!(result.exit_code, Some(0), "{result:?}");
        assert_eq!(result.stdout, "ordinary-input");
        let process = super::super::spawn_sandboxed_local_process_native(
            "task".into(),
            "deadline".into(),
            "native-sandbox".into(),
            "sleep 30",
            &frozen,
            Duration::from_millis(100),
        )
        .unwrap();
        let result = process.wait(Duration::from_secs(3)).unwrap();
        assert_eq!(result.state, super::super::ProcessLifecycleNative::TimedOut);
        assert!(result.termination_confirmed, "{result:?}");
    }

    #[test]
    fn native_sandbox_host_toolchains_remain_executable() {
        let workspace = tempfile::tempdir().unwrap();
        let frozen = contract(workspace.path(), AgentSandboxPolicy::Workspace);
        let (mut child, _temp) = command(
            "node --version && pnpm --version && cargo --version && rustc --version",
            &frozen,
        )
        .unwrap();
        let output = child.output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn native_sandbox_git_uses_project_configuration_and_selected_toolchain() {
        let workspace = tempfile::tempdir().unwrap();
        let (mut child, _temp) = command(
            "git init --quiet && git config --local user.name 'Sandbox acceptance' && git config --get user.name && git status --porcelain",
            &contract(workspace.path(), AgentSandboxPolicy::Workspace),
        ).unwrap();
        let output = child.output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(output.stdout, b"Sandbox acceptance\n");
        assert!(!String::from_utf8_lossy(&output.stderr).contains("xcrun_db"));
    }

    #[test]
    fn native_sandbox_rejects_normal_local_network_connect() {
        let workspace = tempfile::tempdir().unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let input = format!(
            "/usr/bin/curl --noproxy '*' --connect-timeout 1 --max-time 1 http://{}",
            listener.local_addr().unwrap()
        );
        let (mut child, _temp) = command(
            &input,
            &contract(workspace.path(), AgentSandboxPolicy::Workspace),
        )
        .unwrap();
        let output = child.output().unwrap();
        assert!(!output.status.success());
        assert!(
            matches!(listener.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock)
        );
    }

    #[test]
    fn native_sandbox_exact_unix_http_transport_prototype_reads_real_file() {
        struct Server(std::process::Child);
        impl Drop for Server {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let workspace = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(workspace.path()).unwrap();
        let socket = root.join("http.sock");
        let contents =
            std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml"))
                .unwrap();
        std::fs::write(root.join("Cargo.toml"), &contents).unwrap();
        let script = root.join("server.cjs");
        std::fs::write(&script, "const http = require('node:http'); const fs = require('node:fs');\nconst [socket, file] = process.argv.slice(2);\nhttp.createServer((request, response) => { fs.createReadStream(file).pipe(response); }).listen(socket);\n").unwrap();
        let mut server = Server(
            Command::new("node")
                .arg(&script)
                .arg(&socket)
                .arg(root.join("Cargo.toml"))
                .stdout(std::process::Stdio::null())
                .spawn()
                .unwrap(),
        );
        let waiting = std::time::Instant::now();
        while !socket.exists() {
            assert!(
                server.0.try_wait().unwrap().is_none(),
                "Real HTTP server exited before binding its Unix socket"
            );
            assert!(
                waiting.elapsed() < Duration::from_secs(5),
                "Real HTTP server did not bind its Unix socket"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        let input = format!("/usr/bin/curl --silent --show-error --noproxy '*' --max-time 3 --unix-socket {} http://localhost/", quoted(&socket).unwrap());
        let (template, _temp) =
            command(&input, &contract(&root, AgentSandboxPolicy::Workspace)).unwrap();
        let mut arguments = template
            .get_args()
            .map(|arg| arg.to_os_string())
            .collect::<Vec<_>>();
        assert_eq!(arguments[0], "-p");
        let profile = arguments[1].to_str().unwrap();
        arguments[1] = format!(
            "{profile}\n(allow network-outbound (literal {}))\n",
            quoted(&socket).unwrap()
        )
        .into();
        let output = Command::new(template.get_program())
            .args(arguments)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(String::from_utf8(output.stdout).unwrap(), contents);
    }

    #[test]
    fn native_sandbox_cancellation_and_nonzero_exit_have_controller_facts() {
        let workspace = tempfile::tempdir().unwrap();
        let frozen = contract(workspace.path(), AgentSandboxPolicy::Workspace);
        let process = super::super::spawn_sandboxed_local_process_native(
            "task".into(),
            "cancel".into(),
            "native-sandbox".into(),
            "sleep 30",
            &frozen,
            Duration::from_secs(40),
        )
        .unwrap();
        let result = process
            .kill(
                crate::agent_runtime::ProcessSignalNative::Terminate,
                Duration::from_secs(3),
            )
            .unwrap();
        assert!(result.termination_confirmed, "{result:?}");
        assert_eq!(
            result.failure.unwrap().kind,
            crate::agent_runtime::AgentExecutionFailureKind::Cancelled
        );
        let process = super::super::spawn_sandboxed_local_process_native(
            "task".into(),
            "nonzero".into(),
            "native-sandbox".into(),
            "exit 7",
            &frozen,
            Duration::from_secs(5),
        )
        .unwrap();
        let result = process.wait(Duration::from_secs(6)).unwrap();
        assert_eq!(result.exit_code, Some(7));
        let failure = result.failure.unwrap();
        assert_eq!(
            failure.kind,
            crate::agent_runtime::AgentExecutionFailureKind::CommandFailed
        );
        assert_eq!(
            failure.admission,
            crate::agent_runtime::AgentExecutionAdmission::Started
        );
    }
}
