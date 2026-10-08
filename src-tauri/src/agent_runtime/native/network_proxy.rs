//! The only network channel granted to a native command is its private Unix socket.
//! Targets are read from the signed contract. TLS remains end-to-end with the client.
use crate::agent_runtime::NetworkTargetRequestNative;
use crate::agent_runtime::{AgentSandboxContract, AgentSandboxResource};
use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::{body::Incoming, service::service_fn, Request, Response, StatusCode};
use std::{
    net::IpAddr,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::net::{TcpStream, UnixListener, UnixStream};
use tokio_util::sync::CancellationToken;

type Body = Full<Bytes>;
trait ProxyStream: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send {}
impl<T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send> ProxyStream for T {}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub(super) struct ServiceRoute {
    pub(super) port: u16,
    pub(super) socket: PathBuf,
    pub(super) fd: i32,
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

pub(super) struct NetworkProxy {
    service_listeners: Vec<std::os::unix::net::UnixListener>,
    pub(super) services: Vec<ServiceRoute>,
    pub(super) audit: std::sync::Arc<NetworkAudit>,
    cancellation: CancellationToken,
    worker: Option<std::thread::JoinHandle<()>>,
    pub(super) http_socket: PathBuf,
    pub(super) socks_socket: PathBuf,
}

#[derive(Default)]
pub(super) struct NetworkAudit {
    client_bytes: std::sync::atomic::AtomicU64,
    upstream_bytes: std::sync::atomic::AtomicU64,
    opened: std::sync::atomic::AtomicU64,
    denied: std::sync::atomic::AtomicU64,
    closed: std::sync::atomic::AtomicBool,
}
impl NetworkAudit {
    pub(super) fn snapshot(&self) -> crate::agent_runtime::NetworkProxyAuditNative {
        use std::sync::atomic::Ordering::Acquire;
        crate::agent_runtime::NetworkProxyAuditNative {
            client_bytes: self.client_bytes.load(Acquire),
            upstream_bytes: self.upstream_bytes.load(Acquire),
            connections_started: self.opened.load(Acquire),
            denied_requests: self.denied.load(Acquire),
            closed: self.closed.load(Acquire),
        }
    }
}
impl Drop for NetworkProxy {
    fn drop(&mut self) {
        self.cancellation.cancel();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

#[derive(Clone)]
struct Policy {
    services: Vec<ServiceRoute>,
    targets: Vec<NetworkTargetRequestNative>,
    expires: u64,
    encrypted_dns: hickory_resolver::TokioResolver,
    audit: std::sync::Arc<NetworkAudit>,
}
impl Policy {
    async fn connect(&self, host: &str, port: u16) -> Result<Box<dyn ProxyStream>, String> {
        if now() < self.expires && ["localhost", "127.0.0.1"].contains(&host) {
            if let Some(service) = self.services.iter().find(|service| service.port == port) {
                let stream = UnixStream::connect(&service.socket)
                    .await
                    .map_err(|_| "localServiceUnavailable")?;
                self.audit
                    .opened
                    .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
                return Ok(Box::new(stream));
            }
        }
        let target = self
            .targets
            .iter()
            .find(|target| target.host.eq_ignore_ascii_case(host) && target.port == port);
        if now() >= self.expires || target.is_none() {
            self.audit
                .denied
                .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
            return Err("networkTargetNotAuthorized".into());
        }
        let addresses = match target.ok_or("networkTargetNotAuthorized")?.resolver {
            crate::agent_runtime::NetworkResolverNative::System => tokio::time::timeout(
                Duration::from_secs(3),
                tokio::net::lookup_host((host, port)),
            )
            .await
            .map_err(|_| "networkResolutionTimedOut")?
            .map_err(|_| "networkResolutionFailed")?
            .collect::<Vec<_>>(),
            crate::agent_runtime::NetworkResolverNative::Cloudflare => tokio::time::timeout(
                // Give the resolver's bounded retries time to complete; never switch providers.
                Duration::from_secs(12),
                self.encrypted_dns.lookup_ip(format!("{host}.")),
            )
            .await
            .map_err(|_| "networkResolutionTimedOut")?
            .map_err(|_| "networkResolutionFailed")?
            .iter()
            .map(|address| std::net::SocketAddr::new(address, port))
            .collect::<Vec<_>>(),
        };
        let own = if_addrs::get_if_addrs().map_err(|_| "networkAddressValidationFailed")?;
        if addresses.is_empty()
            || addresses.iter().any(|address| {
                !public_address(address.ip())
                    || own.iter().any(|interface| interface.ip() == address.ip())
            })
        {
            self.audit
                .denied
                .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
            return Err("networkResolvedAddressDenied".into());
        }
        for address in addresses.into_iter().take(8) {
            if now() >= self.expires {
                return Err("networkAuthorizationExpired".into());
            }
            if let Ok(Ok(stream)) =
                tokio::time::timeout(Duration::from_secs(3), TcpStream::connect(address)).await
            {
                self.audit
                    .opened
                    .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
                return Ok(Box::new(stream));
            }
        }
        Err("networkConnectionFailed".into())
    }
}

fn public_address(address: IpAddr) -> bool {
    static DENIED: std::sync::OnceLock<Vec<ipnet::IpNet>> = std::sync::OnceLock::new();
    let denied = DENIED.get_or_init(|| {
        [
            "0.0.0.0/8",
            "10.0.0.0/8",
            "100.64.0.0/10",
            "127.0.0.0/8",
            "169.254.0.0/16",
            "172.16.0.0/12",
            "192.0.0.0/24",
            "192.0.2.0/24",
            "192.168.0.0/16",
            "168.63.129.16/32",
            "198.18.0.0/15",
            "198.51.100.0/24",
            "203.0.113.0/24",
            "224.0.0.0/3",
            "::/96",
            "::ffff:0:0/96",
            "64:ff9b::/96",
            "64:ff9b:1::/48",
            "100::/64",
            "2001::/23",
            "2001:db8::/32",
            "2002::/16",
            "fc00::/7",
            "fe80::/10",
            "ff00::/8",
        ]
        .iter()
        .map(|value| value.parse().expect("static network prefix"))
        .collect()
    });
    !denied.iter().any(|network| network.contains(&address))
}

impl NetworkProxy {
    pub(super) fn start(
        root: &Path,
        contract: &AgentSandboxContract,
    ) -> Result<Option<Self>, String> {
        let mut targets = Vec::new();
        let mut services = Vec::new();
        let mut listeners = Vec::new();
        let mut service_listeners = Vec::new();
        // Darwin Unix socket names have a short sockaddr_un path limit.
        let sealed = root.join("s");
        let mut expires = u64::MAX;
        for grant in &contract.resource_grants {
            if let AgentSandboxResource::LocalService { address, port } = &grant.resource {
                if address != "127.0.0.1" || *port == 0 {
                    return Err(
                        "sandboxResourceRequestInvalid: exact IPv4 loopback service required"
                            .into(),
                    );
                }
                let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, *port))
                    .map_err(|_| "sandboxLocalServiceUnavailable: approved port cannot be bound")?;
                listener
                    .set_nonblocking(true)
                    .map_err(|_| "sandboxLocalServiceUnavailable")?;
                let service = ServiceRoute {
                    port: *port,
                    socket: sealed.join(port.to_string()),
                    fd: 0,
                };
                std::fs::create_dir_all(&sealed).map_err(|_| "sandboxLocalServiceUnavailable")?;
                let socket = std::os::unix::net::UnixListener::bind(&service.socket)
                    .map_err(|_| "sandboxLocalServiceUnavailable")?;
                use std::os::fd::AsRawFd;
                let service = ServiceRoute {
                    fd: socket.as_raw_fd(),
                    ..service
                };
                if service.fd > 4096 {
                    return Err(
                        "sandboxLocalServiceUnavailable: descriptor capacity exceeded".into(),
                    );
                }
                service_listeners.push(socket);
                listeners.push((listener, service.clone()));
                services.push(service);
                expires = expires.min(grant.expires_at_unix_ms);
            }
            if let AgentSandboxResource::NetworkTarget {
                protocol,
                host,
                port,
                allow_redirects,
                resolver,
            } = &grant.resource
            {
                if protocol != "tcp" || *allow_redirects {
                    return Err("sandboxPolicyUnsupported: target transport policy".into());
                }
                targets.push(NetworkTargetRequestNative {
                    host: host.clone(),
                    port: *port,
                    resolver: *resolver,
                });
                expires = expires.min(grant.expires_at_unix_ms);
            }
        }
        if targets.is_empty() && services.is_empty() {
            return Ok(None);
        }
        targets =
            crate::agent_runtime::sandbox_authorization::network_requests(contract, &targets)?;
        if now() >= expires {
            return Err("sandboxAuthorizationInvalid: network grant expired".into());
        }
        std::fs::create_dir_all(&sealed).map_err(|_| "sandboxNetworkProxyUnavailable")?;
        let http_socket = sealed.join("h");
        let socks_socket = sealed.join("x");
        let http = std::os::unix::net::UnixListener::bind(&http_socket)
            .map_err(|_| "sandboxNetworkProxyUnavailable")?;
        let socks = std::os::unix::net::UnixListener::bind(&socks_socket)
            .map_err(|_| "sandboxNetworkProxyUnavailable")?;
        http.set_nonblocking(true)
            .map_err(|_| "sandboxNetworkProxyUnavailable")?;
        socks
            .set_nonblocking(true)
            .map_err(|_| "sandboxNetworkProxyUnavailable")?;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|_| "sandboxNetworkProxyUnavailable")?;
        let cancellation = CancellationToken::new();
        let stopped = cancellation.clone();
        let audit = std::sync::Arc::new(NetworkAudit::default());
        let worker_audit = audit.clone();
        let policy_services = services.clone();
        let worker = std::thread::Builder::new().name("shellspan-network-proxy".into()).spawn(move || {
            let policy_audit = worker_audit.clone();
            runtime.block_on(async move {
                let encrypted_dns = hickory_resolver::TokioResolver::builder_with_config(
                    hickory_resolver::config::ResolverConfig::cloudflare_https(),
                    hickory_resolver::name_server::TokioConnectionProvider::default(),
                ).build();
                let policy = Policy { targets, expires, encrypted_dns, audit:policy_audit.clone(), services:policy_services };
                let Ok(http) = UnixListener::from_std(http) else { return; };
                let Ok(socks) = UnixListener::from_std(socks) else { return; };
                let mut jobs = tokio::task::JoinSet::new();
                let slots = std::sync::Arc::new(tokio::sync::Semaphore::new(8));
                for (listener,service) in listeners {
                    let Ok(listener) = tokio::net::TcpListener::from_std(listener) else { continue; };
                    let stopped = stopped.clone();
                    let slots = slots.clone();
                    let audit = policy_audit.clone();
                    jobs.spawn(async move {
                        let mut relays = tokio::task::JoinSet::new();
                        loop {
                            tokio::select! {
                                _ = stopped.cancelled() => break,
                                Some(_) = relays.join_next(), if !relays.is_empty() => {},
                                incoming = listener.accept(), if slots.available_permits() > 0 => {
                                    let Ok((mut client,_)) = incoming else { break; };
                                    let Ok(lease) = slots.clone().try_acquire_owned() else { continue; };
                                    let socket = service.socket.clone();
                                    let audit = audit.clone();
                                    relays.spawn(async move {
                                        let _lease = lease;
                                        if let Ok(mut upstream) = UnixStream::connect(socket).await {
                                            audit.opened.fetch_add(1,std::sync::atomic::Ordering::AcqRel);
                                            let _ = tokio::io::copy_bidirectional(&mut client,&mut upstream).await;
                                        }
                                    });
                                },
                            }
                        }
                        relays.abort_all();
                        while relays.join_next().await.is_some() {}
                    });
                }
                let deadline = tokio::time::sleep(Duration::from_millis(expires.saturating_sub(now())));
                tokio::pin!(deadline);
                loop {
                    tokio::select! {
                        _ = stopped.cancelled() => break,
                        _ = &mut deadline => break,
                        Some(_) = jobs.join_next(), if !jobs.is_empty() => {},
                        incoming = http.accept(), if jobs.len() < 32 && slots.available_permits() > 0 => {
                            let Ok((stream, _)) = incoming else { break; };
                            let Ok(lease) = slots.clone().try_acquire_owned() else { continue; };
                            let lease = std::sync::Arc::new(lease);
                            let policy = policy.clone();
                            let stopped = stopped.clone();
                            jobs.spawn(async move {
                                let connection = hyper::server::conn::http1::Builder::new().max_buf_size(65536)
                                    .serve_connection(hyper_util::rt::TokioIo::new(stream), service_fn(move |request| http_request(request, policy.clone(), stopped.clone(), lease.clone()))).with_upgrades();
                                let _ = connection.await;
                            });
                        },
                        incoming = socks.accept(), if jobs.len() < 32 && slots.available_permits() > 0 => {
                            let Ok((stream, _)) = incoming else { break; };
                            let Ok(lease) = slots.clone().try_acquire_owned() else { continue; };
                            let policy = policy.clone();
                            jobs.spawn(async move { let _lease = lease; let _ = socks_request(stream, policy).await; });
                        },
                    }
                }
                stopped.cancel();
                jobs.abort_all();
                while jobs.join_next().await.is_some() {}
            });
            runtime.shutdown_timeout(Duration::from_secs(1));
            worker_audit.closed.store(true,std::sync::atomic::Ordering::Release);
        }).map_err(|_| "sandboxNetworkProxyUnavailable")?;
        Ok(Some(Self {
            service_listeners,
            services,
            audit,
            cancellation,
            worker: Some(worker),
            http_socket,
            socks_socket,
        }))
    }

    pub(super) fn service_fds(&self) -> Vec<i32> {
        use std::os::fd::AsRawFd;
        self.service_listeners
            .iter()
            .map(AsRawFd::as_raw_fd)
            .collect()
    }
}

fn response(status: StatusCode, text: &'static str) -> Response<Body> {
    let mut response = Response::new(Full::new(Bytes::from_static(text.as_bytes())));
    *response.status_mut() = status;
    response
}
async fn http_request(
    mut request: Request<Incoming>,
    policy: Policy,
    stopped: CancellationToken,
    lease: std::sync::Arc<tokio::sync::OwnedSemaphorePermit>,
) -> Result<Response<Body>, std::convert::Infallible> {
    if request.method() == hyper::Method::CONNECT {
        let Some(authority) = request.uri().authority() else {
            return Ok(response(StatusCode::BAD_REQUEST, "Invalid proxy authority"));
        };
        let host = authority.host().to_string();
        let Some(port) = authority.port_u16() else {
            return Ok(response(StatusCode::BAD_REQUEST, "Explicit port required"));
        };
        let Ok(mut upstream) = policy.connect(&host, port).await else {
            return Ok(response(
                StatusCode::FORBIDDEN,
                "Network target unavailable or unauthorized",
            ));
        };
        let upgraded = hyper::upgrade::on(&mut request);
        let audit = policy.audit.clone();
        tokio::spawn(async move {
            let _lease = lease;
            tokio::select! {
                _ = stopped.cancelled() => {},
                _ = async {
                    if let Ok(stream) = upgraded.await {
                        let outgoing = audit.clone();
                        let mut stream = tokio_util::io::InspectReader::new(hyper_util::rt::TokioIo::new(stream), move |bytes: &[u8]| { outgoing.client_bytes.fetch_add(bytes.len() as u64,std::sync::atomic::Ordering::AcqRel); });
                        let mut upstream = tokio_util::io::InspectReader::new(&mut upstream, move |bytes: &[u8]| { audit.upstream_bytes.fetch_add(bytes.len() as u64,std::sync::atomic::Ordering::AcqRel); });
                        let _ = tokio::io::copy_bidirectional(&mut stream, &mut upstream).await;
                    }
                } => {},
            }
        });
        return Ok(response(StatusCode::OK, ""));
    }
    // Plain HTTP forwards preserve the original method and body; no redirect following.
    let Ok(url) = url::Url::parse(&request.uri().to_string()) else {
        return Ok(response(StatusCode::BAD_REQUEST, "Absolute URL required"));
    };
    if url.scheme() != "http" || !url.username().is_empty() || url.password().is_some() {
        return Ok(response(StatusCode::BAD_REQUEST, "Unsupported proxy URL"));
    }
    let Some(host) = url.host_str() else {
        return Ok(response(StatusCode::BAD_REQUEST, "Proxy hostname required"));
    };
    let Ok(stream) = policy
        .connect(host, url.port_or_known_default().unwrap_or(80))
        .await
    else {
        return Ok(response(
            StatusCode::FORBIDDEN,
            "Network target unavailable or unauthorized",
        ));
    };
    let (mut parts, body) = request.into_parts();
    let Ok(body) = Limited::new(body, 16 * 1024 * 1024).collect().await else {
        return Ok(response(
            StatusCode::PAYLOAD_TOO_LARGE,
            "Proxy body limit exceeded",
        ));
    };
    let path = parts
        .uri
        .path_and_query()
        .map(|value| value.as_str())
        .unwrap_or("/");
    let Ok(uri) = path.parse() else {
        return Ok(response(StatusCode::BAD_REQUEST, "Invalid request path"));
    };
    parts.uri = uri;
    for name in [
        "proxy-authorization",
        "proxy-connection",
        "connection",
        "transfer-encoding",
    ] {
        parts.headers.remove(name);
    }
    let Ok((mut sender, connection)) =
        hyper::client::conn::http1::handshake(hyper_util::rt::TokioIo::new(stream)).await
    else {
        return Ok(response(StatusCode::BAD_GATEWAY, "Proxy connection failed"));
    };
    tokio::spawn(async move {
        tokio::select! { _ = stopped.cancelled() => {}, _ = connection => {} }
    });
    let Ok(reply) = sender
        .send_request(Request::from_parts(parts, Full::new(body.to_bytes())))
        .await
    else {
        return Ok(response(StatusCode::BAD_GATEWAY, "Proxy request failed"));
    };
    let (mut parts, body) = reply.into_parts();
    let Ok(body) = Limited::new(body, 16 * 1024 * 1024).collect().await else {
        return Ok(response(
            StatusCode::BAD_GATEWAY,
            "Proxy response limit exceeded",
        ));
    };
    parts.headers.remove("transfer-encoding");
    parts.headers.remove("connection");
    Ok(Response::from_parts(parts, Full::new(body.to_bytes())))
}
async fn socks_request(stream: UnixStream, policy: Policy) -> Result<(), String> {
    let (protocol, command, target) =
        fast_socks5::server::Socks5ServerProtocol::accept_no_auth(stream)
            .await
            .map_err(|_| "networkProxyHandshakeFailed")?
            .read_command()
            .await
            .map_err(|_| "networkProxyHandshakeFailed")?;
    let (host, port) = match target {
        fast_socks5::util::target_addr::TargetAddr::Domain(host, port) => (host, port),
        fast_socks5::util::target_addr::TargetAddr::Ip(address)
            if address.ip() == std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST)
                && policy
                    .services
                    .iter()
                    .any(|service| service.port == address.port()) =>
        {
            ("127.0.0.1".into(), address.port())
        }
        _ => {
            let _ = protocol
                .reply_error(&fast_socks5::ReplyError::ConnectionNotAllowed)
                .await;
            return Err("networkProxyHostnameRequired".into());
        }
    };
    if command != fast_socks5::Socks5Command::TCPConnect {
        let _ = protocol
            .reply_error(&fast_socks5::ReplyError::CommandNotSupported)
            .await;
        return Err("networkProxyTcpRequired".into());
    }
    let mut upstream = match policy.connect(&host, port).await {
        Ok(stream) => stream,
        Err(error) => {
            let _ = protocol
                .reply_error(&fast_socks5::ReplyError::ConnectionNotAllowed)
                .await;
            return Err(error);
        }
    };
    let mut client = protocol
        .reply_success(std::net::SocketAddr::from(([127, 0, 0, 1], 0)))
        .await
        .map_err(|_| "networkProxyHandshakeFailed")?;
    tokio::io::copy_bidirectional(&mut client, &mut upstream)
        .await
        .map_err(|_| "networkProxyConnectionFailed")?;
    Ok(())
}
