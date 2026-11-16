use super::*;
use std::time::Instant;
use tokio_util::sync::CancellationToken;

pub(crate) const TERMINAL_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
pub(crate) const PLAIN_SSH_FALLBACK_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TerminalStartupMode {
    Initial,
    PlainAfterNativeTimeout,
}

struct Attempt {
    deadline: Instant,
    cancellation: CancellationToken,
    ready: AtomicBool,
    native_startup_started: AtomicBool,
    finished: AtomicBool,
    closed: AtomicBool,
    sockets: Mutex<Vec<TcpStream>>,
    workers: Mutex<Vec<thread::JoinHandle<()>>>,
}

impl Attempt {
    fn check(&self) -> Result<(), String> {
        if Instant::now() >= self.deadline {
            return Err("SSH connection timed out".into());
        }
        if self.cancellation.is_cancelled() {
            return Err("SSH connection cancelled".into());
        }
        Ok(())
    }

    fn interrupt(&self) {
        if let Ok(sockets) = self.sockets.lock() {
            if self.ready.load(AtomicOrdering::SeqCst) {
                return;
            }
            for socket in sockets.iter() {
                let _ = socket.shutdown(std::net::Shutdown::Both);
            }
        }
    }
}

thread_local! {
    static ATTEMPT: std::cell::RefCell<Option<Arc<Attempt>>> = const { std::cell::RefCell::new(None) };
}

pub(crate) struct TerminalConnectionGuard {
    attempt: Arc<Attempt>,
    watcher: Option<thread::JoinHandle<()>>,
}

impl TerminalConnectionGuard {
    pub(crate) fn new(deadline: Instant, cancelled: impl Fn() -> bool + Send + 'static) -> Self {
        let attempt = Arc::new(Attempt {
            deadline,
            cancellation: CancellationToken::new(),
            ready: AtomicBool::new(false),
            native_startup_started: AtomicBool::new(false),
            finished: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            sockets: Mutex::new(Vec::new()),
            workers: Mutex::new(Vec::new()),
        });
        ATTEMPT.with(|slot| {
            assert!(
                slot.borrow().is_none(),
                "nested terminal connection attempt"
            );
            *slot.borrow_mut() = Some(attempt.clone());
        });
        let watched = attempt.clone();
        let watcher = thread::spawn(move || {
            while !watched.finished.load(AtomicOrdering::SeqCst) {
                if cancelled() || Instant::now() >= watched.deadline {
                    watched.cancellation.cancel();
                    watched.interrupt();
                    break;
                }
                thread::sleep(Duration::from_millis(10));
            }
        });
        Self {
            attempt,
            watcher: Some(watcher),
        }
    }

    pub(crate) fn finish(&mut self) {
        self.attempt.closed.store(true, AtomicOrdering::SeqCst);
        self.attempt.finished.store(true, AtomicOrdering::SeqCst);
        self.attempt.interrupt();
        if let Some(watcher) = self.watcher.take() {
            let _ = watcher.join();
        }
        if let Ok(mut workers) = self.attempt.workers.lock() {
            for worker in workers.drain(..) {
                let _ = worker.join();
            }
        }
    }
}

impl Drop for TerminalConnectionGuard {
    fn drop(&mut self) {
        self.finish();
        ATTEMPT.with(|slot| *slot.borrow_mut() = None);
    }
}

/// An expired libssh2 operation can leave an in-flight SFTP or channel request.
/// Retire that transport before trying ordinary SSH with its reserved budget.
pub(crate) fn run_with_plain_ssh_fallback<T, E>(
    deadline: Instant,
    cancelled: impl Fn() -> bool + Clone + Send + 'static,
    mut run: impl FnMut(TerminalStartupMode) -> Result<T, E>,
) -> (Result<T, E>, Option<String>) {
    let (result, failure, retry) = {
        let guard = TerminalConnectionGuard::new(deadline, cancelled.clone());
        let result = run(TerminalStartupMode::Initial);
        let failure = failure_reason();
        let retry = result.is_err()
            && guard
                .attempt
                .native_startup_started
                .load(AtomicOrdering::SeqCst)
            && !guard.attempt.ready.load(AtomicOrdering::SeqCst)
            && Instant::now() >= deadline;
        (result, failure, retry)
    };
    if !retry || cancelled() {
        return (result, failure);
    }
    let _fallback = TerminalConnectionGuard::new(deadline + PLAIN_SSH_FALLBACK_TIMEOUT, cancelled);
    let result = run(TerminalStartupMode::PlainAfterNativeTimeout);
    (result, failure_reason())
}

#[derive(Clone)]
pub(super) struct BridgeCancellation(Arc<Attempt>);

impl BridgeCancellation {
    pub(super) fn stopped(&self) -> bool {
        self.0.closed.load(AtomicOrdering::SeqCst)
            || (!self.0.ready.load(AtomicOrdering::SeqCst) && self.0.check().is_err())
    }

    pub(super) fn own_worker(&self, worker: thread::JoinHandle<()>) {
        self.0
            .workers
            .lock()
            .expect("terminal bridge worker registry")
            .push(worker);
    }
}

pub(super) fn bridge_context() -> Option<BridgeCancellation> {
    active().map(BridgeCancellation)
}

fn active() -> Option<Arc<Attempt>> {
    ATTEMPT
        .with(|slot| slot.borrow().clone())
        .filter(|attempt| !attempt.ready.load(AtomicOrdering::SeqCst))
}

pub(crate) fn failure_reason() -> Option<String> {
    active().and_then(|attempt| attempt.check().err())
}

/// Only optional native work on an authenticated transport enables a retry.
pub(crate) fn mark_native_startup_started() -> Result<(), String> {
    if let Some(attempt) = active() {
        attempt.check()?;
        attempt
            .native_startup_started
            .store(true, AtomicOrdering::SeqCst);
    }
    Ok(())
}

pub(crate) fn finish_native_probe_without_startup() {
    if let Some(attempt) = active() {
        // A quick rejection leaves ordinary SSH its budget on this transport.
        // Keep the reserved retry if optional work already used most of it.
        if attempt.deadline.saturating_duration_since(Instant::now()) >= PLAIN_SSH_FALLBACK_TIMEOUT
        {
            attempt
                .native_startup_started
                .store(false, AtomicOrdering::SeqCst);
        }
    }
}

pub(super) fn handshake(session: &mut Session) -> Result<(), String> {
    let attempt = active();
    let scoped = SCOPED_CONNECTION_IO.with(|slot| slot.borrow().clone());
    if attempt.is_none() && scoped.is_none() {
        return session.handshake().map_err(|error| error.to_string());
    }
    let check = || {
        if let Some(attempt) = &attempt {
            attempt.check()?;
        }
        if let Some(scoped) = &scoped {
            if scoped.cancellation.is_cancelled() {
                return Err("scoped connection cancelled".to_string());
            }
            if scoped.finished.load(AtomicOrdering::SeqCst) {
                return Err("scoped connection closed".to_string());
            }
            if Instant::now() >= scoped.deadline {
                return Err("scoped connection deadline exceeded".to_string());
            }
        }
        Ok(())
    };
    let operation_deadline = attempt
        .as_ref()
        .map(|value| value.deadline)
        .into_iter()
        .chain(scoped.as_ref().map(|value| value.deadline))
        .min()
        .expect("a connection context is present");
    let blocking = session.is_blocking();
    let deadline = if session.timeout() == 0 {
        operation_deadline
    } else {
        operation_deadline.min(Instant::now() + Duration::from_millis(u64::from(session.timeout())))
    };
    // Winsock shutdown does not reliably wake libssh2's blocking wait. Use
    // libssh2's resumable nonblocking handshake and check each owning context.
    session.set_blocking(false);
    let result = (|| loop {
        check()?;
        if Instant::now() >= deadline {
            return Err("SSH handshake timed out".into());
        }
        match session.handshake() {
            Ok(()) => return check(),
            Err(error) if error.code() == ssh2::ErrorCode::Session(-37) => {
                thread::sleep(Duration::from_millis(10));
            }
            Err(error) => {
                check()?;
                return Err(error.to_string());
            }
        }
    })();
    session.set_blocking(blocking);
    result
}

pub(crate) fn complete() -> Result<(), String> {
    if let Some(attempt) = active() {
        let mut sockets = attempt
            .sockets
            .lock()
            .map_err(|_| "terminal socket registry poisoned")?;
        attempt.check()?;
        attempt.ready.store(true, AtomicOrdering::SeqCst);
        attempt.finished.store(true, AtomicOrdering::SeqCst);
        sockets.clear();
    }
    Ok(())
}

pub(super) fn register(tcp: &TcpStream) -> Result<(), String> {
    if let Some(attempt) = active() {
        let mut sockets = attempt
            .sockets
            .lock()
            .map_err(|_| "terminal socket registry poisoned")?;
        attempt.check()?;
        sockets.push(tcp.try_clone().map_err(|error| error.to_string())?);
    }
    Ok(())
}

pub(super) fn resolve(address: &str) -> Option<Result<Vec<SocketAddr>, String>> {
    active().map(|attempt| tauri::async_runtime::block_on(async {
        tokio::select! {
            biased;
            _ = attempt.cancellation.cancelled() => Err("SSH connection cancelled or timed out".into()),
            result = tokio::time::timeout_at(tokio::time::Instant::from_std(attempt.deadline), tokio::net::lookup_host(address)) => {
                result.map_err(|_| "SSH DNS lookup timed out".to_string())?
                    .map(|addresses| addresses.take(32).collect()).map_err(|error| error.to_string())
            }
        }
    }))
}

pub(super) fn connect(address: &SocketAddr) -> Option<Result<TcpStream, String>> {
    active().map(|attempt| {
        let deadline = (Instant::now() + TCP_CONNECT_ATTEMPT_TIMEOUT).min(attempt.deadline);
        attempt.check()?;
        let stream = tauri::async_runtime::block_on(async {
            tokio::select! {
                biased;
                _ = attempt.cancellation.cancelled() => Err("SSH connection cancelled or timed out".to_string()),
                result = tokio::time::timeout_at(tokio::time::Instant::from_std(deadline), tokio::net::TcpStream::connect(address)) => {
                    result.map_err(|_| "TCP connection timed out".to_string())?
                        .map_err(|error| error.to_string())
                }
            }
        })?;
        let stream = stream.into_std().map_err(|error| error.to_string())?;
        stream.set_nonblocking(false).map_err(|error| error.to_string())?;
        register(&stream)?;
        Ok(stream)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn socket_pair() -> (TcpStream, TcpStream) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (server, _) = listener.accept().unwrap();
        (client, server)
    }

    #[test]
    fn plain_fallback_does_not_retry_early_timeouts_or_user_cancellation() {
        for cancel_during_native in [false, true] {
            let (mut client, mut peer) = socket_pair();
            let cancelled = Arc::new(AtomicBool::new(false));
            let peer_cancelled = Arc::clone(&cancelled);
            let server = thread::spawn(move || {
                let mut byte = [0];
                peer.read_exact(&mut byte).unwrap();
                if cancel_during_native {
                    peer_cancelled.store(true, AtomicOrdering::SeqCst);
                }
                assert_eq!(peer.read(&mut byte).unwrap(), 0);
            });
            let deadline = Instant::now()
                + if cancel_during_native {
                    Duration::from_secs(3)
                } else {
                    Duration::from_millis(300)
                };
            let (_, failure) = run_with_plain_ssh_fallback(
                deadline,
                move || cancelled.load(AtomicOrdering::SeqCst),
                |mode| {
                    assert_eq!(mode, TerminalStartupMode::Initial);
                    register(&client).unwrap();
                    if cancel_during_native {
                        mark_native_startup_started().unwrap();
                    }
                    client.write_all(b"x").unwrap();
                    let _ = client.read(&mut [0]);
                    Err::<(), _>("connection interrupted")
                },
            );
            assert_eq!(
                failure.as_deref(),
                Some(if cancel_during_native {
                    "SSH connection cancelled"
                } else {
                    "SSH connection timed out"
                })
            );
            server.join().unwrap();
        }
    }

    #[test]
    fn scoped_nonblocking_handshake_obeys_deadline_and_restores_caller_mode() {
        use std::io::{BufRead, BufReader, Read};
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut reader = BufReader::new(socket);
            let mut banner = String::new();
            reader.read_line(&mut banner).unwrap();
            assert!(banner.starts_with("SSH-"));
            let mut bytes = [0; 1024];
            loop {
                match reader.read(&mut bytes) {
                    Ok(0) => break,
                    Ok(_) => continue,
                    Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => break,
                    Err(error) => panic!("scoped handshake left its real socket open: {error}"),
                }
            }
        });
        let started = Instant::now();
        with_scoped_connection_io(
            CancellationToken::new(),
            started + Duration::from_millis(200),
            || {
                let tcp = Arc::new(TcpStream::connect(address).unwrap());
                register_scoped_socket(&tcp).unwrap();
                let mut session = Session::new().unwrap();
                session.set_tcp_stream(SharedTcpStream(tcp));
                session.set_blocking(false);
                session.set_timeout(15_000);
                let error = handshake(&mut session).unwrap_err();
                assert!(error.contains("deadline"), "{error}");
                assert!(!session.is_blocking());
            },
        );
        server.join().unwrap();
        assert!(started.elapsed() >= Duration::from_millis(150));
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn scoped_ssh_transport_shares_one_os_socket_and_closes_retained_owner() {
        let (mut client, mut server) = socket_pair();
        server
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        client.write_all(b"live").unwrap();
        let peer = thread::spawn(move || {
            let mut sent = [0; 4];
            server.read_exact(&mut sent).unwrap();
            assert_eq!(&sent, b"live");
            let mut byte = [0; 1];
            assert_eq!(
                server.read(&mut byte).unwrap(),
                0,
                "scope must close the real peer before returning"
            );
        });
        let retained = Arc::new(client);
        let session = with_scoped_connection_io(
            CancellationToken::new(),
            Instant::now() + Duration::from_secs(2),
            || {
                register_scoped_socket(&retained).unwrap();
                let mut session = Session::new().unwrap();
                session.set_tcp_stream(SharedTcpStream(Arc::clone(&retained)));
                let context = context_clone();
                let sockets = context.sockets.lock().unwrap();
                #[cfg(windows)]
                {
                    use std::os::windows::io::AsRawSocket;
                    assert_eq!(session.as_raw_socket(), sockets[0].as_ref().as_raw_socket());
                    assert_eq!(session.as_raw_socket(), retained.as_ref().as_raw_socket());
                }
                #[cfg(unix)]
                {
                    use std::os::fd::AsRawFd;
                    assert_eq!(session.as_raw_fd(), sockets[0].as_ref().as_raw_fd());
                    assert_eq!(session.as_raw_fd(), retained.as_ref().as_raw_fd());
                }
                drop(sockets);
                session
            },
        );
        // Keep both real socket owners alive across the scope's cleanup.
        peer.join().unwrap();
        assert!(!session.authenticated());
        assert!(retained.as_ref().write_all(b"late").is_err());
    }

    #[test]
    fn terminal_bridge_accept_observes_deadline_and_is_joined() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let mut guard =
            TerminalConnectionGuard::new(Instant::now() + Duration::from_millis(100), || false);
        let context = bridge_context().unwrap();
        let worker_context = context.clone();
        let exited = Arc::new(AtomicBool::new(false));
        let worker_exited = exited.clone();
        let (sender, receiver) = std::sync::mpsc::channel();
        context.own_worker(thread::spawn(move || {
            let error = accept_bridge_with_timeout(
                &listener,
                Duration::from_secs(15),
                None,
                Some(&worker_context),
            )
            .unwrap_err();
            worker_exited.store(true, AtomicOrdering::SeqCst);
            sender.send(error.kind()).unwrap();
        }));
        assert_eq!(
            receiver.recv_timeout(Duration::from_secs(1)).unwrap(),
            std::io::ErrorKind::Interrupted
        );
        guard.finish();
        assert!(exited.load(AtomicOrdering::SeqCst));
    }

    #[test]
    fn ready_bridge_survives_startup_deadline_until_session_cleanup() {
        let guard =
            TerminalConnectionGuard::new(Instant::now() + Duration::from_millis(100), || false);
        let context = bridge_context().unwrap();
        complete().unwrap();
        thread::sleep(Duration::from_millis(150));
        assert!(!context.stopped());
        drop(guard);
        assert!(context.stopped());
    }

    #[test]
    fn terminal_cleanup_joins_bridge_before_returning() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let guard =
            TerminalConnectionGuard::new(Instant::now() + Duration::from_secs(15), || false);
        let context = bridge_context().unwrap();
        let worker_context = context.clone();
        let exited = Arc::new(AtomicBool::new(false));
        let worker_exited = exited.clone();
        context.own_worker(thread::spawn(move || {
            assert!(accept_bridge_with_timeout(
                &listener,
                Duration::from_secs(15),
                None,
                Some(&worker_context)
            )
            .is_err());
            worker_exited.store(true, AtomicOrdering::SeqCst);
        }));
        let started = Instant::now();
        drop(guard);
        assert!(exited.load(AtomicOrdering::SeqCst));
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn terminal_connect_and_dns_use_the_real_runtime_and_socket() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let _guard =
            TerminalConnectionGuard::new(Instant::now() + Duration::from_secs(2), || false);
        let mut client = connect_tcp_stream("127.0.0.1", port).unwrap();
        let (mut server, _) = listener.accept().unwrap();
        server
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        client.write_all(b"live").unwrap();
        let mut bytes = [0; 4];
        server.read_exact(&mut bytes).unwrap();
        assert_eq!(&bytes, b"live");
    }

    #[test]
    fn terminal_deadline_interrupts_a_real_stalled_ssh_handshake() {
        let (client, mut server) = socket_pair();
        server
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let peer = thread::spawn(move || {
            let mut bytes = [0; 256];
            while server.read(&mut bytes).unwrap_or(0) != 0 {}
        });
        let started = Instant::now();
        let _guard = TerminalConnectionGuard::new(started + Duration::from_millis(150), || false);
        register(&client).unwrap();
        let mut session = Session::new().unwrap();
        session.set_tcp_stream(client);
        session.set_timeout(3_000);
        assert!(handshake(&mut session).is_err());
        assert!(session.is_blocking());
        assert_eq!(
            failure_reason().as_deref(),
            Some("SSH connection timed out")
        );
        assert!(started.elapsed() < Duration::from_secs(2));
        peer.join().unwrap();
    }

    #[test]
    fn terminal_cancellation_interrupts_a_real_stalled_ssh_handshake() {
        let (client, mut server) = socket_pair();
        server
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let watched = cancelled.clone();
        let peer_cancelled = cancelled.clone();
        let (sender, receiver) = std::sync::mpsc::channel();
        let (release_peer, wait_for_release) = std::sync::mpsc::channel();
        let peer = thread::spawn(move || {
            let mut bytes = [0; 256];
            // Wait for libssh2 to send its greeting before cancelling. Keep
            // the peer open and silent so only cancellation can end the wait.
            assert!(server.read(&mut bytes).unwrap() > 0);
            let cancelled_at = Instant::now();
            peer_cancelled.store(true, AtomicOrdering::SeqCst);
            sender.send(cancelled_at).unwrap();
            while server.read(&mut bytes).unwrap_or(0) != 0 {}
            // Do not let peer closure wake the handshake under test.
            wait_for_release
                .recv_timeout(Duration::from_secs(5))
                .unwrap();
            drop(server);
        });
        let _guard =
            TerminalConnectionGuard::new(Instant::now() + Duration::from_secs(10), move || {
                watched.load(AtomicOrdering::SeqCst)
            });
        register(&client).unwrap();
        // Exercise the production cancellable SSH handshake.
        let mut session = Session::new().unwrap();
        session.set_tcp_stream(client);
        session.set_timeout(3_000);
        assert!(handshake(&mut session).is_err());
        assert!(session.is_blocking());
        let returned_at = Instant::now();
        let cancelled_at = receiver.recv_timeout(Duration::from_secs(1)).unwrap();
        release_peer.send(()).unwrap();
        peer.join().unwrap();
        assert!(returned_at.duration_since(cancelled_at) < Duration::from_secs(1));
        assert_eq!(
            failure_reason().as_deref(),
            Some("SSH connection cancelled")
        );
    }

    #[test]
    fn terminal_handshake_preserves_session_timeout_and_nonblocking_mode() {
        let (client, _server) = socket_pair();
        let _guard =
            TerminalConnectionGuard::new(Instant::now() + Duration::from_secs(5), || false);
        let mut session = Session::new().unwrap();
        session.set_tcp_stream(client);
        session.set_blocking(false);
        session.set_timeout(150);
        let started = Instant::now();
        assert_eq!(
            handshake(&mut session).unwrap_err(),
            "SSH handshake timed out"
        );
        assert!(!session.is_blocking());
        assert_eq!(session.timeout(), 150);
        assert!(started.elapsed() < Duration::from_secs(1));
        assert!(failure_reason().is_none());
    }

    #[test]
    fn terminal_readiness_disarms_deadline_and_preserves_transport() {
        let (mut client, mut server) = socket_pair();
        server
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        let guard =
            TerminalConnectionGuard::new(Instant::now() + Duration::from_millis(100), || false);
        register(&client).unwrap();
        complete().unwrap();
        thread::sleep(Duration::from_millis(150));
        drop(guard);
        client.write_all(b"live").unwrap();
        let mut bytes = [0; 4];
        server.read_exact(&mut bytes).unwrap();
        assert_eq!(&bytes, b"live");
    }

    #[test]
    fn terminal_expired_budget_rejects_new_connections_and_readiness() {
        let _guard =
            TerminalConnectionGuard::new(Instant::now() - Duration::from_millis(1), || false);
        assert!(complete().unwrap_err().contains("timed out"));
        assert!(connect(&"127.0.0.1:22".parse().unwrap()).unwrap().is_err());
        assert!(resolve("localhost:22").unwrap().is_err());
    }
}
