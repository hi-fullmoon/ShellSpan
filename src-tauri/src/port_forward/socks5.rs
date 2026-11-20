use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use socks5_protocol::sync::FromIO;
use socks5_protocol::{
    Address, AuthMethod, AuthRequest, AuthResponse, Command, CommandReply, CommandRequest,
    CommandResponse, Version,
};

const MAX_CONNECTIONS: usize = 64;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

fn negotiate(socket: &mut (impl Read + Write)) -> Result<(String, u16), String> {
    Version::read_from(socket).map_err(|error| error.to_string())?;
    let request = AuthRequest::read_from(socket).map_err(|error| error.to_string())?;
    let permits_noauth = request
        .0
        .iter()
        .any(|method| matches!(method, AuthMethod::Noauth));
    Version::V5
        .write_to(socket)
        .map_err(|error| error.to_string())?;
    let method = if permits_noauth {
        AuthMethod::Noauth
    } else {
        AuthMethod::NoAcceptableMethod
    };
    AuthResponse::new(method)
        .write_to(socket)
        .map_err(|error| error.to_string())?;
    if !permits_noauth {
        return Err("SOCKS5 client does not allow unauthenticated negotiation".into());
    }
    let request = match CommandRequest::read_from(socket) {
        Ok(request) => request,
        Err(error) => {
            let _ = CommandResponse::reply_error(CommandReply::GeneralSocksServerFailure)
                .write_to(socket);
            return Err(error.to_string());
        }
    };
    if !matches!(request.command, Command::Connect) {
        let _ = CommandResponse::reply_error(CommandReply::CommandNotSupported).write_to(socket);
        return Err("SOCKS5 dynamic forwarding supports CONNECT".into());
    }
    let (host, port) = match request.address {
        Address::SocketAddr(address) => (address.ip().to_string(), address.port()),
        Address::Domain(host, port) => (host, port),
    };
    if port == 0 || crate::connection::validate_host(&host).is_err() {
        let _ =
            CommandResponse::reply_error(CommandReply::AddressTypeNotSupported).write_to(socket);
        return Err("invalid SOCKS5 destination".into());
    }
    Ok((host, port))
}

struct DeadlineSocket<'a> {
    stream: &'a mut TcpStream,
    cancellation: &'a AtomicBool,
    deadline: Instant,
}

impl DeadlineSocket<'_> {
    fn retry<T>(
        &mut self,
        mut action: impl FnMut(&mut TcpStream) -> io::Result<T>,
    ) -> io::Result<T> {
        loop {
            if self.cancellation.load(Ordering::Relaxed) {
                return Err(io::Error::new(
                    io::ErrorKind::ConnectionAborted,
                    "SOCKS5 forward stopped",
                ));
            }
            if Instant::now() >= self.deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "SOCKS5 handshake timed out",
                ));
            }
            match action(self.stream) {
                Err(error) if super::scoped_bridge_retryable(&error) => {
                    thread::sleep(Duration::from_millis(2))
                }
                result => return result,
            }
        }
    }
}

impl Read for DeadlineSocket<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.retry(|stream| stream.read(buffer))
    }
}

impl Write for DeadlineSocket<'_> {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.retry(|stream| stream.write(buffer))
    }
    fn flush(&mut self) -> io::Result<()> {
        self.retry(|stream| stream.flush())
    }
}

fn connect(
    mut socket: TcpStream,
    session: &ssh2::Session,
    opening_channel: &Mutex<()>,
    cancel: &AtomicBool,
    sent: &AtomicU64,
    received: &AtomicU64,
) -> Result<(), String> {
    socket
        .set_nonblocking(true)
        .map_err(|error| error.to_string())?;
    let mut handshake = DeadlineSocket {
        stream: &mut socket,
        cancellation: cancel,
        deadline: Instant::now() + HANDSHAKE_TIMEOUT,
    };
    let (host, port) = negotiate(&mut handshake)?;
    let channel = {
        // libssh2 keeps a single in-flight direct-tcpip open request per session.
        let _opening = opening_channel
            .lock()
            .map_err(|_| "SOCKS5 channel registry unavailable")?;
        let mut opening = false;
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Ok(());
            }
            if Instant::now() >= handshake.deadline {
                // Retire the transport before it can reuse a partially opened request.
                if opening {
                    cancel.store(true, Ordering::Relaxed);
                }
                return Err("SOCKS5 channel establishment timed out".into());
            }
            match session.channel_direct_tcpip(&host, port, None) {
                Ok(channel) => break channel,
                Err(error) if error.code() == ssh2::ErrorCode::Session(-37) => {
                    opening = true;
                    thread::sleep(Duration::from_millis(2));
                }
                Err(_) => {
                    let _ = CommandResponse::reply_error(CommandReply::ConnectionRefused)
                        .write_to(&mut handshake);
                    return Err("SOCKS5 destination rejected the connection".into());
                }
            }
        }
    };
    CommandResponse::success(Address::default())
        .write_to(&mut handshake)
        .map_err(|error| error.to_string())?;
    super::bridge_nonblocking_connection(
        channel,
        socket,
        None,
        || cancel.load(Ordering::Relaxed),
        Some((sent, received)),
    )
}

pub(super) fn serve(
    listener: TcpListener,
    session: &ssh2::Session,
    cancel: Arc<AtomicBool>,
    sent: Arc<AtomicU64>,
    received: Arc<AtomicU64>,
    on_tick: impl Fn(),
) -> Result<(), String> {
    let opening = Arc::new(Mutex::new(()));
    let mut clients: Vec<JoinHandle<()>> = Vec::new();
    let result = loop {
        if cancel.load(Ordering::Relaxed) {
            break Ok(());
        }
        clients.retain(|client| !client.is_finished());
        if clients.len() < MAX_CONNECTIONS {
            match listener.accept() {
                Ok((socket, _)) => {
                    let session = session.clone();
                    let (opening, cancel, sent, received) = (
                        opening.clone(),
                        cancel.clone(),
                        sent.clone(),
                        received.clone(),
                    );
                    clients.push(thread::spawn(move || {
                        // A malformed local request must not change the state of the listener.
                        let _ = connect(socket, &session, &opening, &cancel, &sent, &received);
                    }));
                    continue;
                }
                Err(error) if super::scoped_bridge_retryable(&error) => {}
                Err(error) => break Err(format!("SOCKS5 listener failed: {error}")),
            }
        }
        on_tick();
        thread::sleep(Duration::from_millis(50));
    };
    cancel.store(true, Ordering::Relaxed);
    for client in clients {
        let _ = client.join();
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ipv4_ipv6_and_domain_connections_on_a_real_socket() {
        for (address, expected) in [
            (
                Address::SocketAddr("127.0.0.1:443".parse().unwrap()),
                "127.0.0.1",
            ),
            (Address::SocketAddr("[::1]:443".parse().unwrap()), "::1"),
            (Address::Domain("localhost".into(), 443), "localhost"),
        ] {
            let (mut client, mut server) =
                super::super::connected_loopback_pair(Instant::now() + Duration::from_secs(2))
                    .unwrap();
            Version::V5.write_to(&mut client).unwrap();
            AuthRequest(vec![AuthMethod::Noauth])
                .write_to(&mut client)
                .unwrap();
            CommandRequest::connect(address)
                .write_to(&mut client)
                .unwrap();
            assert_eq!(negotiate(&mut server).unwrap(), (expected.to_owned(), 443));
            Version::read_from(&mut client).unwrap();
            assert!(matches!(
                AuthResponse::read_from(&mut client).unwrap().method(),
                AuthMethod::Noauth
            ));
        }
    }

    #[test]
    fn refuses_unsupported_authentication_and_commands() {
        let (mut client, mut server) =
            super::super::connected_loopback_pair(Instant::now() + Duration::from_secs(2)).unwrap();
        Version::V5.write_to(&mut client).unwrap();
        AuthRequest(vec![AuthMethod::UsernamePassword])
            .write_to(&mut client)
            .unwrap();
        assert!(negotiate(&mut server).is_err());
        Version::read_from(&mut client).unwrap();
        assert!(matches!(
            AuthResponse::read_from(&mut client).unwrap().method(),
            AuthMethod::NoAcceptableMethod
        ));

        let (mut client, mut server) =
            super::super::connected_loopback_pair(Instant::now() + Duration::from_secs(2)).unwrap();
        Version::V5.write_to(&mut client).unwrap();
        AuthRequest(vec![AuthMethod::Noauth])
            .write_to(&mut client)
            .unwrap();
        CommandRequest::udp_associate(Address::default())
            .write_to(&mut client)
            .unwrap();
        assert!(negotiate(&mut server).is_err());
        Version::read_from(&mut client).unwrap();
        AuthResponse::read_from(&mut client).unwrap();
        assert!(matches!(
            CommandResponse::read_from(&mut client),
            Err(socks5_protocol::Error::CommandReply(
                CommandReply::CommandNotSupported
            ))
        ));
    }
}
