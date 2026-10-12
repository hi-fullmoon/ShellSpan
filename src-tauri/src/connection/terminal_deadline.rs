use super::*;
use std::time::Instant;
use tokio_util::sync::CancellationToken;

pub(crate) const TERMINAL_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

struct Attempt {
    deadline: Instant,
    cancellation: CancellationToken,
    ready: AtomicBool,
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
        assert!(session.handshake().is_err());
        assert_eq!(
            failure_reason().as_deref(),
            Some("SSH connection timed out")
        );
        assert!(started.elapsed() < Duration::from_secs(2));
        peer.join().unwrap();
    }

    #[test]
    fn terminal_cancellation_interrupts_blocked_socket_io() {
        let (mut client, _server) = socket_pair();
        client
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let watched = cancelled.clone();
        let _guard =
            TerminalConnectionGuard::new(Instant::now() + Duration::from_secs(3), move || {
                watched.load(AtomicOrdering::SeqCst)
            });
        register(&client).unwrap();
        cancelled.store(true, AtomicOrdering::SeqCst);
        let started = Instant::now();
        let mut bytes = [0; 1];
        assert!(client.read(&mut bytes).map_or(true, |size| size == 0));
        assert!(started.elapsed() < Duration::from_secs(1));
        assert_eq!(
            failure_reason().as_deref(),
            Some("SSH connection cancelled")
        );
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
