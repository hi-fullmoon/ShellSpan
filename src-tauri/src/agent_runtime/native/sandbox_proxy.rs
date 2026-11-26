//! Host-side filtering HTTP/CONNECT proxy for managed local Agent sandboxes.
//!
//! When enabled by user policy, sandboxed processes are restricted by OS
//! primitives (`nono` Seatbelt / Landlock `proxy_only + block_dns`) so they
//! can only connect to `127.0.0.1:<ephemeral_port>`. All DNS resolution and
//! outbound domain/IP validation happens here on the host.

#[cfg(any(target_os = "macos", test))]
use std::collections::BTreeSet;
#[cfg(any(target_os = "macos", test))]
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::IpAddr;
#[cfg(any(target_os = "macos", test))]
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
#[cfg(any(target_os = "macos", test))]
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
#[cfg(any(target_os = "macos", test))]
use std::thread::{self, JoinHandle};
#[cfg(any(target_os = "macos", test))]
use std::time::Duration;

#[cfg(any(target_os = "macos", test))]
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};

#[cfg(any(target_os = "macos", test))]
const MAX_HEADER_BYTES: usize = 16 * 1024;
#[cfg(any(target_os = "macos", test))]
const MAX_BLOCKED_RECORDED: usize = 32;
#[cfg(any(target_os = "macos", test))]
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
#[cfg(any(target_os = "macos", test))]
const IO_TIMEOUT: Duration = Duration::from_secs(60);

#[cfg(any(target_os = "macos", test))]
pub(crate) const DEV_REGISTRY_DOMAINS: &[&str] = &[
    "registry.npmjs.org",
    "pypi.org",
    "files.pythonhosted.org",
    "crates.io",
    "index.crates.io",
    "static.crates.io",
    "proxy.golang.org",
    "sum.golang.org",
    "github.com",
    "api.github.com",
    "objects.githubusercontent.com",
    "raw.githubusercontent.com",
    "codeload.github.com",
    "rubygems.org",
    "repo.maven.apache.org",
];

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SandboxNetworkMode {
    #[default]
    Blocked,
    DevRegistries,
    CustomAllowlist,
}

#[cfg(any(target_os = "macos", test))]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SandboxNetworkPolicy {
    pub(crate) mode: SandboxNetworkMode,
    #[serde(default)]
    pub(crate) custom_domains: Vec<String>,
}

#[cfg(any(target_os = "macos", test))]
impl SandboxNetworkPolicy {
    #[cfg(test)]
    pub(crate) fn blocked() -> Self {
        Self {
            mode: SandboxNetworkMode::Blocked,
            custom_domains: Vec::new(),
        }
    }

    pub(crate) fn uses_proxy(&self) -> bool {
        match self.mode {
            SandboxNetworkMode::Blocked => false,
            SandboxNetworkMode::DevRegistries => true,
            SandboxNetworkMode::CustomAllowlist => !self.effective_rules().is_empty(),
        }
    }

    pub(crate) fn effective_rules(&self) -> Vec<String> {
        let mut rules = BTreeSet::new();
        match self.mode {
            SandboxNetworkMode::Blocked => {}
            SandboxNetworkMode::DevRegistries => {
                for domain in DEV_REGISTRY_DOMAINS {
                    rules.insert((*domain).to_string());
                }
            }
            SandboxNetworkMode::CustomAllowlist => {
                for raw in &self.custom_domains {
                    if let Some(normalized) = normalize_domain_rule(raw) {
                        rules.insert(normalized);
                    }
                }
            }
        }
        rules.into_iter().collect()
    }

    pub(crate) fn allows_host(&self, host: &str) -> bool {
        let Some(host) = normalize_request_host(host) else {
            return false;
        };
        let rules = self.effective_rules();
        rules.iter().any(|rule| domain_rule_matches(rule, &host))
    }

    /// Returns an effective network policy combining this global policy with
    /// session-scoped temporary domain allowances without mutating global mode.
    pub(crate) fn with_extra_domains(&self, extra: &[String]) -> Self {
        let mut normalized_extra = Vec::new();
        for raw in extra {
            if let Some(rule) = normalize_domain_rule(raw) {
                normalized_extra.push(rule);
            }
        }
        if normalized_extra.is_empty() {
            return self.clone();
        }
        let mut merged: BTreeSet<String> = self.effective_rules().into_iter().collect();
        for rule in normalized_extra {
            merged.insert(rule);
        }
        Self {
            mode: SandboxNetworkMode::CustomAllowlist,
            custom_domains: merged.into_iter().collect(),
        }
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn prompt_summary(&self) -> String {
        match self.mode {
            SandboxNetworkMode::Blocked => "Outbound network is blocked.".into(),
            SandboxNetworkMode::DevRegistries => {
                "Outbound network is restricted via host proxy to preset package registries (npm, PyPI, crates.io, Go, GitHub). Direct sockets and DNS are blocked."
                    .into()
            }
            SandboxNetworkMode::CustomAllowlist => {
                let rules = self.effective_rules();
                if rules.is_empty() {
                    "Outbound network is blocked (custom allowlist is empty).".into()
                } else {
                    format!(
                        "Outbound network is restricted via host proxy to allowlisted domains ({}). Direct sockets and DNS are blocked.",
                        rules.join(", ")
                    )
                }
            }
        }
    }
}

pub(crate) fn normalize_domain_rule(raw: &str) -> Option<String> {
    let trimmed = raw.trim().to_ascii_lowercase();
    let trimmed = trimmed.trim_end_matches('.');
    if trimmed.is_empty() || trimmed.len() > 253 {
        return None;
    }
    let (wildcard, base) = match trimmed.strip_prefix("*.") {
        Some(rest) => (true, rest),
        None => (false, trimmed),
    };
    if base.is_empty() || base.contains('*') || base.parse::<IpAddr>().is_ok() {
        return None;
    }
    let labels: Vec<&str> = base.split('.').collect();
    // Require at least two labels (e.g. `example.com`) so wildcard rules cannot
    // match an entire TLD like `*.com`.
    if labels.len() < 2 {
        return None;
    }
    let valid_labels = labels.iter().all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    });
    if !valid_labels {
        return None;
    }
    if wildcard {
        Some(format!("*.{base}"))
    } else {
        Some(base.to_string())
    }
}

#[cfg(any(target_os = "macos", test))]
fn normalize_request_host(raw: &str) -> Option<String> {
    let trimmed = raw.trim().to_ascii_lowercase();
    let trimmed = trimmed.trim_end_matches('.');
    if trimmed.is_empty()
        || trimmed.len() > 253
        || trimmed.contains(['/', '\\', '@', ' '])
        || trimmed.chars().any(char::is_control)
        || trimmed.parse::<IpAddr>().is_ok()
    {
        return None;
    }
    Some(trimmed.to_string())
}

#[cfg(any(target_os = "macos", test))]
fn domain_rule_matches(rule: &str, host: &str) -> bool {
    if let Some(suffix) = rule.strip_prefix("*.") {
        host.len() > suffix.len() + 1
            && host.ends_with(suffix)
            && host.as_bytes()[host.len() - suffix.len() - 1] == b'.'
    } else {
        rule == host
    }
}

#[cfg(any(target_os = "macos", test))]
pub(crate) fn is_blocked_destination_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_blocked_ipv4(v4),
        IpAddr::V6(v6) => is_blocked_ipv6(v6),
    }
}

#[cfg(any(target_os = "macos", test))]
fn is_blocked_ipv4(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_documentation()
        || ip.is_multicast()
        || ip.is_unspecified()
        // "This network" (0.0.0.0/8)
        || octets[0] == 0
        // Shared Address Space / CGNAT (100.64.0.0/10)
        || (octets[0] == 100 && (octets[1] & 0b1100_0000) == 64)
        // Benchmarking (198.18.0.0/15)
        || (octets[0] == 198 && (octets[1] == 18 || octets[1] == 19))
        // Reserved (240.0.0.0/4)
        || octets[0] >= 240
}

#[cfg(any(target_os = "macos", test))]
fn is_blocked_ipv6(ip: Ipv6Addr) -> bool {
    if let Some(mapped) = ip.to_ipv4_mapped() {
        return is_blocked_ipv4(mapped);
    }
    let segs = ip.segments();
    let seg0 = segs[0];
    // IPv4-compatible (::/96)
    if segs[0..6] == [0, 0, 0, 0, 0, 0] {
        return true;
    }
    // NAT64 well-known (64:ff9b::/96) and local-use (64:ff9b:1::/48)
    if segs[0] == 0x0064 && segs[1] == 0xff9b && (segs[2..6] == [0, 0, 0, 0] || segs[2] == 0x0001) {
        return true;
    }
    // 6to4 (2002::/16), Teredo (2001::/32), Documentation (2001:db8::/32)
    if seg0 == 0x2002
        || (seg0 == 0x2001 && segs[1] == 0x0000)
        || (seg0 == 0x2001 && segs[1] == 0x0db8)
    {
        return true;
    }
    ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        // Unique local addresses (fc00::/7)
        || (seg0 & 0xfe00) == 0xfc00
        // Link-local unicast (fe80::/10)
        || (seg0 & 0xffc0) == 0xfe80
        // Deprecated site-local (fec0::/10)
        || (seg0 & 0xffc0) == 0xfec0
}

#[cfg(any(target_os = "macos", test))]
const MAX_CONCURRENT_PROXY_CONNECTIONS: usize = 64;

#[cfg(any(target_os = "macos", test))]
pub(crate) struct SandboxProxy {
    port: u16,
    token: String,
    shutdown: Arc<AtomicBool>,
    active_streams: Arc<Mutex<std::collections::HashMap<u64, TcpStream>>>,
    blocked_domains: Arc<Mutex<Vec<String>>>,
    thread: Option<JoinHandle<()>>,
}

#[cfg(any(target_os = "macos", test))]
impl SandboxProxy {
    pub(crate) fn start(policy: SandboxNetworkPolicy) -> io::Result<Self> {
        Self::start_with_options(policy, false)
    }

    fn start_with_options(
        policy: SandboxNetworkPolicy,
        allow_loopback_upstream: bool,
    ) -> io::Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let port = listener.local_addr()?.port();
        let token = uuid::Uuid::new_v4().simple().to_string();
        let expected_auth = format!(
            "Basic {}",
            STANDARD.encode(format!("ss:{token}").as_bytes())
        );
        let shutdown = Arc::new(AtomicBool::new(false));
        let active_streams: Arc<Mutex<std::collections::HashMap<u64, TcpStream>>> =
            Arc::new(Mutex::new(std::collections::HashMap::new()));
        let active_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let next_conn_id = Arc::new(std::sync::atomic::AtomicU64::new(1));
        let blocked_domains = Arc::new(Mutex::new(Vec::new()));

        let worker_shutdown = Arc::clone(&shutdown);
        let worker_streams = Arc::clone(&active_streams);
        let worker_blocked = Arc::clone(&blocked_domains);
        let worker_policy = Arc::new(policy);
        let worker_auth = Arc::new(expected_auth);

        let handle = thread::spawn(move || {
            while !worker_shutdown.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        if worker_shutdown.load(Ordering::Acquire) {
                            break;
                        }
                        if active_count.fetch_add(1, Ordering::AcqRel)
                            >= MAX_CONCURRENT_PROXY_CONNECTIONS
                        {
                            active_count.fetch_sub(1, Ordering::AcqRel);
                            let mut rejected = stream;
                            let _ = write_error_response(
                                &mut rejected,
                                "503 Service Unavailable",
                                None,
                                "Sandbox proxy connection limit reached\n",
                            );
                            continue;
                        }
                        let conn_id = next_conn_id.fetch_add(1, Ordering::Relaxed);
                        if let Ok(cloned) = stream.try_clone() {
                            if let Ok(mut map) = worker_streams.lock() {
                                map.insert(conn_id, cloned);
                            }
                        }
                        let policy = Arc::clone(&worker_policy);
                        let auth = Arc::clone(&worker_auth);
                        let blocked = Arc::clone(&worker_blocked);
                        let count = Arc::clone(&active_count);
                        let streams = Arc::clone(&worker_streams);
                        thread::spawn(move || {
                            let _ = handle_client(
                                stream,
                                &policy,
                                &auth,
                                &blocked,
                                allow_loopback_upstream,
                            );
                            if let Ok(mut map) = streams.lock() {
                                map.remove(&conn_id);
                            }
                            count.fetch_sub(1, Ordering::AcqRel);
                        });
                    }
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
        });

        Ok(Self {
            port,
            token,
            shutdown,
            active_streams,
            blocked_domains,
            thread: Some(handle),
        })
    }

    pub(crate) fn port(&self) -> u16 {
        self.port
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn proxy_url(&self) -> String {
        format!("http://ss:{}@127.0.0.1:{}", self.token, self.port)
    }

    pub(crate) fn blocked_domains(&self) -> Vec<String> {
        self.blocked_domains
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn blocked_domains_handle(&self) -> Arc<Mutex<Vec<String>>> {
        Arc::clone(&self.blocked_domains)
    }
}

#[cfg(any(target_os = "macos", test))]
impl Drop for SandboxProxy {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Release);
        if let Ok(mut map) = self.active_streams.lock() {
            for (_, stream) in map.drain() {
                let _ = stream.shutdown(std::net::Shutdown::Both);
            }
        }
        let _ = TcpStream::connect_timeout(
            &SocketAddr::from(([127, 0, 0, 1], self.port)),
            Duration::from_millis(50),
        );
        if let Some(handle) = self.thread.take() {
            let _ = handle.join();
        }
    }
}

#[cfg(any(target_os = "macos", test))]
fn record_blocked(blocked: &Mutex<Vec<String>>, host: &str) {
    if let Ok(mut list) = blocked.lock() {
        if list.len() < MAX_BLOCKED_RECORDED && !list.iter().any(|item| item == host) {
            list.push(host.to_string());
        }
    }
}

#[cfg(any(target_os = "macos", test))]
fn write_error_response(
    stream: &mut TcpStream,
    status: &str,
    extra_header: Option<&str>,
    body: &str,
) -> io::Result<()> {
    let extra = extra_header.map(|h| format!("{h}\r\n")).unwrap_or_default();
    let response = format!(
        "HTTP/1.1 {status}\r\n{extra}Content-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(response.as_bytes())?;
    stream.flush()
}

#[cfg(any(target_os = "macos", test))]
fn parse_host_port(authority: &str, default_port: u16) -> Option<(String, u16)> {
    let authority = authority.trim();
    if authority.is_empty() || authority.starts_with('[') {
        // Reject raw IPv6 literals; only allowlisted DNS hostnames are permitted.
        return None;
    }
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) => (h, p.parse::<u16>().ok()?),
        None => (authority, default_port),
    };
    let host = normalize_request_host(host)?;
    Some((host, port))
}

#[cfg(any(target_os = "macos", test))]
fn resolve_allowed_addr(
    host: &str,
    port: u16,
    allow_loopback_upstream: bool,
) -> io::Result<SocketAddr> {
    if !matches!(port, 80 | 443) && !allow_loopback_upstream {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "disallowed target port",
        ));
    }
    #[cfg(test)]
    if allow_loopback_upstream && host == "sandbox-test.local" {
        return Ok(SocketAddr::from(([127, 0, 0, 1], port)));
    }
    let addrs: Vec<SocketAddr> = (host, port).to_socket_addrs()?.collect();
    if addrs.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "no addresses resolved for host",
        ));
    }
    if !allow_loopback_upstream {
        for addr in &addrs {
            if is_blocked_destination_ip(addr.ip()) {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "destination resolved to a blocked private or loopback IP",
                ));
            }
        }
    }
    Ok(addrs[0])
}

#[cfg(any(target_os = "macos", test))]
fn handle_client(
    mut client: TcpStream,
    policy: &SandboxNetworkPolicy,
    expected_auth: &str,
    blocked: &Mutex<Vec<String>>,
    allow_loopback_upstream: bool,
) -> io::Result<()> {
    // Accepted sockets inherit non-blocking mode from the listener on macOS/BSD.
    client.set_nonblocking(false)?;
    let _ = client.set_read_timeout(Some(IO_TIMEOUT));
    let _ = client.set_write_timeout(Some(IO_TIMEOUT));

    let mut reader = BufReader::new(client.try_clone()?);
    let Some(request_line) = read_bounded_line(&mut reader, MAX_HEADER_BYTES)? else {
        return Ok(());
    };
    let mut headers = Vec::new();
    let mut total_bytes = request_line.len();
    let mut proxy_auth: Option<String> = None;
    loop {
        let remaining = MAX_HEADER_BYTES.saturating_sub(total_bytes);
        if remaining == 0 {
            return write_error_response(
                &mut client,
                "431 Request Header Fields Too Large",
                None,
                "Request headers exceeded sandbox proxy limit\n",
            );
        }
        let Some(line) = read_bounded_line(&mut reader, remaining)? else {
            return Ok(());
        };
        total_bytes += line.len();
        if total_bytes > MAX_HEADER_BYTES {
            return write_error_response(
                &mut client,
                "431 Request Header Fields Too Large",
                None,
                "Request headers exceeded sandbox proxy limit\n",
            );
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        if let Some((name, value)) = trimmed.split_once(':') {
            if name.eq_ignore_ascii_case("proxy-authorization") {
                proxy_auth = Some(value.trim().to_string());
                continue;
            }
            if name.eq_ignore_ascii_case("proxy-connection") {
                continue;
            }
            headers.push((name.trim().to_string(), value.trim().to_string()));
        }
    }

    if proxy_auth.as_deref() != Some(expected_auth) {
        log::warn!("sandbox_proxy decision=deny reason=auth_failed");
        return write_error_response(
            &mut client,
            "407 Proxy Authentication Required",
            Some("Proxy-Authenticate: Basic realm=\"ShellSpan Sandbox\""),
            "Proxy authentication required\n",
        );
    }

    let parts: Vec<&str> = request_line.split_whitespace().collect();
    if parts.len() < 3 {
        return write_error_response(&mut client, "400 Bad Request", None, "Bad request\n");
    }
    let method = parts[0];
    let target = parts[1];
    let version = parts[2];

    if method.eq_ignore_ascii_case("CONNECT") {
        let Some((host, port)) = parse_host_port(target, 443) else {
            return write_error_response(&mut client, "400 Bad Request", None, "Invalid target\n");
        };
        if (!matches!(port, 80 | 443) && !allow_loopback_upstream) || !policy.allows_host(&host) {
            record_blocked(blocked, &host);
            log::warn!(
                "sandbox_proxy decision=deny method=CONNECT host={host} port={port} reason=policy_denied"
            );
            return write_error_response(
                &mut client,
                "403 Forbidden",
                Some("X-ShellSpan-Sandbox-Blocked: 1"),
                &format!("Blocked by ShellSpan sandbox network policy: {host}\n"),
            );
        }
        let addr = match resolve_allowed_addr(&host, port, allow_loopback_upstream) {
            Ok(addr) => addr,
            Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {
                record_blocked(blocked, &host);
                log::warn!(
                    "sandbox_proxy decision=deny method=CONNECT host={host} port={port} reason=blocked_ip"
                );
                return write_error_response(
                    &mut client,
                    "403 Forbidden",
                    Some("X-ShellSpan-Sandbox-Blocked: 1"),
                    &format!("Blocked destination IP for {host}\n"),
                );
            }
            Err(_) => {
                return write_error_response(
                    &mut client,
                    "502 Bad Gateway",
                    None,
                    "Upstream DNS resolution failed\n",
                );
            }
        };
        let Ok(mut upstream) = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT) else {
            return write_error_response(
                &mut client,
                "502 Bad Gateway",
                None,
                "Upstream connection failed\n",
            );
        };
        log::info!("sandbox_proxy decision=allow method=CONNECT host={host} port={port}");
        let _ = upstream.set_read_timeout(Some(IO_TIMEOUT));
        let _ = upstream.set_write_timeout(Some(IO_TIMEOUT));
        client.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")?;
        client.flush()?;

        // Flush any bytes already buffered by BufReader after the CONNECT headers.
        let buffered = reader.buffer().to_vec();
        if !buffered.is_empty() {
            upstream.write_all(&buffered)?;
        }
        drop(reader);
        return relay_bidirectional(client, upstream);
    }

    // Plain HTTP proxy request: `METHOD http://host[:port]/path HTTP/1.1`
    let Some(rest) = target.strip_prefix("http://") else {
        return write_error_response(
            &mut client,
            "400 Bad Request",
            None,
            "Only http:// URLs or CONNECT tunnels are supported\n",
        );
    };
    let (authority, path) = match rest.find('/') {
        Some(idx) => (&rest[..idx], &rest[idx..]),
        None => (rest, "/"),
    };
    let Some((host, port)) = parse_host_port(authority, 80) else {
        return write_error_response(
            &mut client,
            "400 Bad Request",
            None,
            "Invalid target host\n",
        );
    };
    if (!matches!(port, 80 | 443) && !allow_loopback_upstream) || !policy.allows_host(&host) {
        record_blocked(blocked, &host);
        log::warn!(
            "sandbox_proxy decision=deny method={method} host={host} port={port} reason=policy_denied"
        );
        return write_error_response(
            &mut client,
            "403 Forbidden",
            Some("X-ShellSpan-Sandbox-Blocked: 1"),
            &format!("Blocked by ShellSpan sandbox network policy: {host}\n"),
        );
    }
    let addr = match resolve_allowed_addr(&host, port, allow_loopback_upstream) {
        Ok(addr) => addr,
        Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {
            record_blocked(blocked, &host);
            log::warn!(
                "sandbox_proxy decision=deny method={method} host={host} port={port} reason=blocked_ip"
            );
            return write_error_response(
                &mut client,
                "403 Forbidden",
                Some("X-ShellSpan-Sandbox-Blocked: 1"),
                &format!("Blocked destination IP for {host}\n"),
            );
        }
        Err(_) => {
            return write_error_response(
                &mut client,
                "502 Bad Gateway",
                None,
                "Upstream DNS resolution failed\n",
            );
        }
    };
    let Ok(mut upstream) = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT) else {
        return write_error_response(
            &mut client,
            "502 Bad Gateway",
            None,
            "Upstream connection failed\n",
        );
    };
    log::info!("sandbox_proxy decision=allow method={method} host={host} port={port}");
    let _ = upstream.set_read_timeout(Some(IO_TIMEOUT));
    let _ = upstream.set_write_timeout(Some(IO_TIMEOUT));

    if !matches!(version, "HTTP/1.0" | "HTTP/1.1")
        || method.is_empty()
        || !method.bytes().all(|b| b.is_ascii_uppercase())
    {
        return write_error_response(
            &mut client,
            "400 Bad Request",
            None,
            "Unsupported HTTP method or version\n",
        );
    }
    let mut content_length: Option<usize> = None;
    for (name, value) in &headers {
        if name.eq_ignore_ascii_case("transfer-encoding") {
            return write_error_response(
                &mut client,
                "501 Not Implemented",
                None,
                "Transfer-Encoding is not supported for plain HTTP proxy forwarding\n",
            );
        }
        if name.eq_ignore_ascii_case("content-length") {
            let Ok(parsed) = value.parse::<usize>() else {
                return write_error_response(
                    &mut client,
                    "400 Bad Request",
                    None,
                    "Invalid Content-Length header\n",
                );
            };
            if content_length.is_some() {
                return write_error_response(
                    &mut client,
                    "400 Bad Request",
                    None,
                    "Duplicate Content-Length header\n",
                );
            }
            content_length = Some(parsed);
        }
    }

    write!(upstream, "{method} {path} {version}\r\n")?;
    if port == 80 {
        write!(upstream, "Host: {host}\r\n")?;
    } else {
        write!(upstream, "Host: {host}:{port}\r\n")?;
    }
    for (name, value) in &headers {
        if name.eq_ignore_ascii_case("host") || name.eq_ignore_ascii_case("connection") {
            continue;
        }
        write!(upstream, "{name}: {value}\r\n")?;
    }
    upstream.write_all(b"Connection: close\r\n\r\n")?;
    if let Some(len) = content_length.filter(|len| *len > 0) {
        let mut body_reader = reader.take(len as u64);
        io::copy(&mut body_reader, &mut upstream)?;
    }
    upstream.flush()?;
    io::copy(&mut upstream, &mut client)?;
    client.flush()
}

#[cfg(any(target_os = "macos", test))]
fn read_bounded_line<R: BufRead>(reader: &mut R, max_bytes: usize) -> io::Result<Option<String>> {
    let mut buffer = Vec::new();
    let mut limited = reader.take((max_bytes + 1) as u64);
    let read = limited.read_until(b'\n', &mut buffer)?;
    if read == 0 {
        return Ok(None);
    }
    if buffer.len() > max_bytes {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "HTTP header line exceeded sandbox proxy limit",
        ));
    }
    String::from_utf8(buffer)
        .map(Some)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid UTF-8 in HTTP header"))
}

#[cfg(any(target_os = "macos", test))]
fn relay_bidirectional(mut client: TcpStream, mut upstream: TcpStream) -> io::Result<()> {
    let mut client_read = client.try_clone()?;
    let mut upstream_write = upstream.try_clone()?;
    let c2u = thread::spawn(move || {
        let _ = io::copy(&mut client_read, &mut upstream_write);
        let _ = upstream_write.shutdown(std::net::Shutdown::Write);
    });
    let _ = io::copy(&mut upstream, &mut client);
    let _ = client.shutdown(std::net::Shutdown::Write);
    let _ = c2u.join();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn domain_normalization_and_matching_rules() {
        assert_eq!(
            normalize_domain_rule("  Registry.NPMJS.org. "),
            Some("registry.npmjs.org".into())
        );
        assert_eq!(
            normalize_domain_rule("*.corp.internal"),
            Some("*.corp.internal".into())
        );
        // Reject wildcards matching whole TLDs, raw IPs, and invalid syntax.
        for invalid in [
            "*",
            "*.com",
            "127.0.0.1",
            "localhost",
            "a/b.com",
            "-bad.com",
        ] {
            assert_eq!(normalize_domain_rule(invalid), None, "{invalid}");
        }

        let policy = SandboxNetworkPolicy {
            mode: SandboxNetworkMode::CustomAllowlist,
            custom_domains: vec!["*.corp.internal".into(), "registry.npmmirror.com".into()],
        };
        assert!(policy.allows_host("registry.npmmirror.com"));
        assert!(policy.allows_host("npm.corp.internal"));
        assert!(policy.allows_host("a.b.corp.internal"));
        assert!(!policy.allows_host("corp.internal"));
        assert!(!policy.allows_host("evil.example.com"));
        assert!(!policy.allows_host("127.0.0.1"));
    }

    #[test]
    fn blocked_ip_check_denies_private_loopback_and_metadata_ranges() {
        for addr in [
            "127.0.0.1",
            "10.0.0.1",
            "172.16.0.5",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "::1",
            "fc00::1",
            "fe80::1",
            "::ffff:127.0.0.1",
            "::ffff:169.254.169.254",
        ] {
            let ip: IpAddr = addr.parse().unwrap();
            assert!(is_blocked_destination_ip(ip), "expected {addr} blocked");
        }
        for public in [
            "93.184.216.34",
            "1.1.1.1",
            "2606:2800:220:1:248:1893:25c8:1946",
        ] {
            let ip: IpAddr = public.parse().unwrap();
            assert!(!is_blocked_destination_ip(ip), "expected {public} allowed");
        }
    }

    #[test]
    fn proxy_enforces_auth_domain_allowlist_and_records_blocked_hosts() {
        let policy = SandboxNetworkPolicy {
            mode: SandboxNetworkMode::DevRegistries,
            custom_domains: Vec::new(),
        };
        let proxy = SandboxProxy::start(policy).unwrap();

        // 1. Missing Proxy-Authorization returns 407.
        let mut conn = TcpStream::connect(("127.0.0.1", proxy.port())).unwrap();
        conn.write_all(b"CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\n\r\n")
            .unwrap();
        let mut resp = String::new();
        conn.read_to_string(&mut resp).unwrap();
        assert!(resp.starts_with("HTTP/1.1 407"), "{resp}");

        // 2. Authenticated request to non-allowlisted domain returns 403 and records host.
        let auth = STANDARD.encode(format!("ss:{}", proxy.token).as_bytes());
        let mut conn = TcpStream::connect(("127.0.0.1", proxy.port())).unwrap();
        write!(
            conn,
            "CONNECT evil.example.com:443 HTTP/1.1\r\nHost: evil.example.com:443\r\nProxy-Authorization: Basic {auth}\r\n\r\n"
        )
        .unwrap();
        let mut resp = String::new();
        conn.read_to_string(&mut resp).unwrap();
        assert!(resp.starts_with("HTTP/1.1 403"), "{resp}");
        assert!(resp.contains("X-ShellSpan-Sandbox-Blocked: 1"));
        assert_eq!(proxy.blocked_domains(), vec!["evil.example.com"]);

        // 3. Disallowed port on allowlisted domain returns 403.
        let mut conn = TcpStream::connect(("127.0.0.1", proxy.port())).unwrap();
        write!(
            conn,
            "CONNECT github.com:22 HTTP/1.1\r\nHost: github.com:22\r\nProxy-Authorization: Basic {auth}\r\n\r\n"
        )
        .unwrap();
        let mut resp = String::new();
        conn.read_to_string(&mut resp).unwrap();
        assert!(resp.starts_with("HTTP/1.1 403"), "{resp}");
    }

    #[test]
    fn proxy_relays_plain_http_and_strips_proxy_auth_header() {
        // Start a local echo HTTP server and test relay with allow_loopback_upstream=true.
        let upstream = TcpListener::bind("127.0.0.1:0").unwrap();
        let upstream_port = upstream.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut stream, _) = upstream.accept().unwrap();
            let mut req = Vec::new();
            let mut buf = [0u8; 512];
            while !req.windows(4).any(|w| w == b"\r\n\r\n") {
                let n = stream.read(&mut buf).unwrap();
                if n == 0 {
                    break;
                }
                req.extend_from_slice(&buf[..n]);
            }
            let req_text = String::from_utf8_lossy(&req).to_string();
            assert!(!req_text
                .to_ascii_lowercase()
                .contains("proxy-authorization"));
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
                .unwrap();
            let _ = stream.shutdown(std::net::Shutdown::Write);
        });

        let policy = SandboxNetworkPolicy {
            mode: SandboxNetworkMode::CustomAllowlist,
            custom_domains: vec!["sandbox-test.local".into()],
        };
        let proxy = SandboxProxy::start_with_options(policy, true).unwrap();
        let auth = STANDARD.encode(format!("ss:{}", proxy.token).as_bytes());
        let mut conn = TcpStream::connect(("127.0.0.1", proxy.port())).unwrap();
        write!(
            conn,
            "GET http://sandbox-test.local:{upstream_port}/ping HTTP/1.1\r\nHost: sandbox-test.local\r\nProxy-Authorization: Basic {auth}\r\n\r\n"
        )
        .unwrap();
        let mut resp = String::new();
        conn.read_to_string(&mut resp).unwrap();
        assert!(resp.starts_with("HTTP/1.1 200"), "{resp}");
        assert!(resp.ends_with("ok"), "{resp}");
        server.join().unwrap();
    }

    #[test]
    fn with_extra_domains_layers_session_allowances_without_mutating_global_policy() {
        let blocked = SandboxNetworkPolicy::blocked();
        assert_eq!(blocked.with_extra_domains(&[]), blocked);
        let layered = blocked.with_extra_domains(&["Registry.NpmMirror.com".into()]);
        assert_eq!(layered.mode, SandboxNetworkMode::CustomAllowlist);
        assert!(layered.allows_host("registry.npmmirror.com"));
        assert!(!blocked.uses_proxy());

        let dev = SandboxNetworkPolicy {
            mode: SandboxNetworkMode::DevRegistries,
            custom_domains: Vec::new(),
        };
        let layered_dev = dev.with_extra_domains(&["api.internal.example".into()]);
        assert!(layered_dev.allows_host("registry.npmjs.org"));
        assert!(layered_dev.allows_host("api.internal.example"));
    }

    #[test]
    fn blocks_extended_ipv4_and_ipv6_ssrf_ranges_and_bounds_header_line() {
        for ip in [
            "0.1.2.3",
            "::1.2.3.4",
            "64:ff9b::8.8.8.8",
            "64:ff9b:1::1",
            "2002:c000:0204::1",
            "2001:0::1",
            "2001:db8::1",
            "fec0::1",
        ] {
            assert!(
                is_blocked_destination_ip(ip.parse().unwrap()),
                "expected {ip} to be blocked"
            );
        }
        let oversized = vec![b'A'; MAX_HEADER_BYTES + 1024];
        let mut reader = BufReader::new(oversized.as_slice());
        assert!(read_bounded_line(&mut reader, MAX_HEADER_BYTES).is_err());
    }
}
