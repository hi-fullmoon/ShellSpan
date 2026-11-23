//! Host-side filtering HTTP/CONNECT proxy for managed local Agent sandboxes.
//!
//! When enabled by user policy, sandboxed processes are restricted by OS
//! primitives (`nono` Seatbelt / Landlock `proxy_only + block_dns`) so they
//! can only connect to `127.0.0.1:<ephemeral_port>`. All DNS resolution and
//! outbound domain/IP validation happens here on the host.

use std::collections::BTreeSet;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};

const MAX_HEADER_BYTES: usize = 16 * 1024;
const MAX_BLOCKED_RECORDED: usize = 32;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const IO_TIMEOUT: Duration = Duration::from_secs(60);

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

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SandboxNetworkPolicy {
    pub(crate) mode: SandboxNetworkMode,
    #[serde(default)]
    pub(crate) custom_domains: Vec<String>,
}

impl SandboxNetworkPolicy {
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

fn domain_rule_matches(rule: &str, host: &str) -> bool {
    if let Some(suffix) = rule.strip_prefix("*.") {
        host.len() > suffix.len() + 1
            && host.ends_with(suffix)
            && host.as_bytes()[host.len() - suffix.len() - 1] == b'.'
    } else {
        rule == host
    }
}

pub(crate) fn is_blocked_destination_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_blocked_ipv4(v4),
        IpAddr::V6(v6) => is_blocked_ipv6(v6),
    }
}

fn is_blocked_ipv4(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_documentation()
        || ip.is_multicast()
        || ip.is_unspecified()
        // Shared Address Space / CGNAT (100.64.0.0/10)
        || (octets[0] == 100 && (octets[1] & 0b1100_0000) == 64)
        // Benchmarking (198.18.0.0/15)
        || (octets[0] == 198 && (octets[1] == 18 || octets[1] == 19))
        // Reserved (240.0.0.0/4)
        || octets[0] >= 240
}

fn is_blocked_ipv6(ip: Ipv6Addr) -> bool {
    if let Some(mapped) = ip.to_ipv4_mapped() {
        return is_blocked_ipv4(mapped);
    }
    let seg0 = ip.segments()[0];
    ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        // Unique local addresses (fc00::/7)
        || (seg0 & 0xfe00) == 0xfc00
        // Link-local unicast (fe80::/10)
        || (seg0 & 0xffc0) == 0xfe80
}

pub(crate) struct SandboxProxy {
    port: u16,
    token: String,
    shutdown: Arc<AtomicBool>,
    blocked_domains: Arc<Mutex<Vec<String>>>,
    thread: Option<JoinHandle<()>>,
}

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
        listener.set_nonblocking(true)?;
        let token = uuid::Uuid::new_v4().simple().to_string();
        let expected_auth = format!(
            "Basic {}",
            STANDARD.encode(format!("ss:{token}").as_bytes())
        );
        let shutdown = Arc::new(AtomicBool::new(false));
        let blocked_domains = Arc::new(Mutex::new(Vec::new()));

        let worker_shutdown = Arc::clone(&shutdown);
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
                        let policy = Arc::clone(&worker_policy);
                        let auth = Arc::clone(&worker_auth);
                        let blocked = Arc::clone(&worker_blocked);
                        thread::spawn(move || {
                            let _ = handle_client(
                                stream,
                                &policy,
                                &auth,
                                &blocked,
                                allow_loopback_upstream,
                            );
                        });
                    }
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(15));
                    }
                    Err(_) => break,
                }
            }
        });

        Ok(Self {
            port,
            token,
            shutdown,
            blocked_domains,
            thread: Some(handle),
        })
    }

    pub(crate) fn port(&self) -> u16 {
        self.port
    }

    pub(crate) fn proxy_url(&self) -> String {
        format!("http://ss:{}@127.0.0.1:{}", self.token, self.port)
    }

    pub(crate) fn blocked_domains(&self) -> Vec<String> {
        self.blocked_domains
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }
}

impl Drop for SandboxProxy {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Release);
        let _ = TcpStream::connect_timeout(
            &SocketAddr::from(([127, 0, 0, 1], self.port)),
            Duration::from_millis(50),
        );
        if let Some(handle) = self.thread.take() {
            let _ = handle.join();
        }
    }
}

fn record_blocked(blocked: &Mutex<Vec<String>>, host: &str) {
    if let Ok(mut list) = blocked.lock() {
        if list.len() < MAX_BLOCKED_RECORDED && !list.iter().any(|item| item == host) {
            list.push(host.to_string());
        }
    }
}

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
    let mut request_line = String::new();
    let n = reader.read_line(&mut request_line)?;
    if n == 0 || request_line.len() > MAX_HEADER_BYTES {
        return Ok(());
    }
    let mut headers = Vec::new();
    let mut total_bytes = n;
    let mut proxy_auth: Option<String> = None;
    loop {
        let mut line = String::new();
        let count = reader.read_line(&mut line)?;
        total_bytes += count;
        if count == 0 || total_bytes > MAX_HEADER_BYTES {
            return Ok(());
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

    write!(upstream, "{method} {path} {version}\r\n")?;
    let mut has_host = false;
    let mut content_length: usize = 0;
    for (name, value) in &headers {
        if name.eq_ignore_ascii_case("host") {
            has_host = true;
        }
        if name.eq_ignore_ascii_case("content-length") {
            content_length = value.parse::<usize>().unwrap_or(0);
        }
        if name.eq_ignore_ascii_case("connection") {
            continue;
        }
        write!(upstream, "{name}: {value}\r\n")?;
    }
    if !has_host {
        if port == 80 {
            write!(upstream, "Host: {host}\r\n")?;
        } else {
            write!(upstream, "Host: {host}:{port}\r\n")?;
        }
    }
    upstream.write_all(b"Connection: close\r\n\r\n")?;
    if content_length > 0 {
        let mut body_reader = reader.take(content_length as u64);
        io::copy(&mut body_reader, &mut upstream)?;
    }
    upstream.flush()?;
    io::copy(&mut upstream, &mut client)?;
    client.flush()
}

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
            let mut req = [0u8; 2048];
            let n = stream.read(&mut req).unwrap();
            let req_text = String::from_utf8_lossy(&req[..n]).to_string();
            assert!(!req_text
                .to_ascii_lowercase()
                .contains("proxy-authorization"));
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
                .unwrap();
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
}
