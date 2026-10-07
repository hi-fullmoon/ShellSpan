//! One worker owns the nonblocking libssh2 session. A blocking read on one
//! clone would otherwise hold its shared session mutex across an upload.
use std::io::{ErrorKind, Read, Write};
use std::net::{Shutdown, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

struct Pending {
    bytes: [u8; 16 * 1024],
    start: usize,
    end: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires project-owned SSH phase 4 real loopback transport services"]
    fn scoped_ssh_real_duplex_half_close_backpressure_cancel_and_deadline() {
        let connection = crate::execution::fixture::isolated_ssh_connection();
        let (_trust, known_hosts) =
            crate::connection::trusted_known_hosts_fixture(&connection.host, connection.port);
        let mut transport = crate::port_forward::open_scoped_loopback_connection(
            &connection,
            18082,
            &known_hosts,
            Instant::now() + Duration::from_secs(10),
        )
        .unwrap();
        let mut client = transport.take_stream().unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut writer = client.try_clone().unwrap();
        writer
            .set_write_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let payload: Vec<u8> = (0..2 * 1024 * 1024).map(|i| (i % 251) as u8).collect();
        let expected = payload.clone();
        let upload = std::thread::spawn(move || {
            writer.write_all(&payload).unwrap();
            writer.shutdown(Shutdown::Write).unwrap();
        });
        let mut received = Vec::new();
        Read::by_ref(&mut client)
            .take((expected.len() + 1) as u64)
            .read_to_end(&mut received)
            .unwrap();
        assert_eq!(received, expected);
        upload.join().unwrap();
        drop(client);
        transport
            .finish(Instant::now() + Duration::from_secs(2))
            .unwrap();

        for cancelled in [false, true] {
            let mut transport = crate::port_forward::open_scoped_loopback_connection(
                &connection,
                18083,
                &known_hosts,
                Instant::now()
                    + if cancelled {
                        Duration::from_secs(5)
                    } else {
                        Duration::from_millis(400)
                    },
            )
            .unwrap();
            let mut client = transport.take_stream().unwrap();
            client
                .set_write_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let upload = std::thread::spawn(move || {
                let block = [7_u8; 64 * 1024];
                for _ in 0..256 {
                    if client.write_all(&block).is_err() {
                        return;
                    }
                }
            });
            if cancelled {
                transport.cancel();
            }
            let stop_deadline = Instant::now() + Duration::from_secs(2);
            while !transport.worker_finished() {
                assert!(
                    Instant::now() < stop_deadline,
                    "scoped worker did not exit after cancellation/deadline under backpressure"
                );
                std::thread::sleep(Duration::from_millis(5));
            }
            let error = transport
                .finish(Instant::now() + Duration::from_secs(1))
                .unwrap_err();
            assert!(
                error.contains(if cancelled { "cancelled" } else { "deadline" }),
                "{error}"
            );
            upload.join().unwrap();
        }
    }
}

impl Pending {
    fn new() -> Self {
        Self {
            bytes: [0; 16 * 1024],
            start: 0,
            end: 0,
        }
    }
    fn empty(&self) -> bool {
        self.start == self.end
    }
    fn read(&mut self, reader: &mut impl Read, eof: &mut bool) -> Result<bool, String> {
        if !self.empty() || *eof {
            return Ok(false);
        }
        match reader.read(&mut self.bytes) {
            Ok(0) => {
                *eof = true;
                Ok(true)
            }
            Ok(n) => {
                self.start = 0;
                self.end = n;
                Ok(true)
            }
            Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::Interrupted) => {
                Ok(false)
            }
            Err(e) => Err(format!("scoped SSH bridge read failed: {e}")),
        }
    }
    fn write(&mut self, writer: &mut impl Write) -> Result<bool, String> {
        if self.empty() {
            return Ok(false);
        }
        match writer.write(&self.bytes[self.start..self.end]) {
            Ok(0) => Err("scoped SSH bridge write returned zero".into()),
            Ok(n) => {
                self.start += n;
                Ok(true)
            }
            Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::Interrupted) => {
                Ok(false)
            }
            Err(e) => Err(format!("scoped SSH bridge write failed: {e}")),
        }
    }
}

pub(crate) fn bridge(
    session: &ssh2::Session,
    mut channel: ssh2::Channel,
    mut tcp: TcpStream,
    cancel: &AtomicBool,
    deadline: Instant,
) -> Result<(), String> {
    tcp.set_nonblocking(true)
        .map_err(|e| format!("scoped SSH bridge setup failed: {e}"))?;
    // The session is private to this worker; no concurrent SSH operation uses
    // it. Keep it nonblocking through channel destruction as well.
    session.set_blocking(false);
    let mut upload = Pending::new();
    let mut download = Pending::new();
    let (mut tcp_eof, mut ssh_eof, mut sent_eof, mut sent_shutdown) = (false, false, false, false);
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err("scoped SSH bridge cancelled".into());
        }
        if Instant::now() >= deadline {
            return Err("scoped SSH bridge exceeded its total deadline".into());
        }
        let mut progress = upload.write(&mut channel)?;
        progress |= download.write(&mut tcp)?;
        progress |= upload.read(&mut tcp, &mut tcp_eof)?;
        progress |= download.read(&mut channel, &mut ssh_eof)?;
        if tcp_eof && upload.empty() && !sent_eof {
            match channel.send_eof() {
                Ok(()) => {
                    sent_eof = true;
                    progress = true;
                }
                Err(e)
                    if e.code() == ssh2::ErrorCode::Session(libssh2_sys::LIBSSH2_ERROR_EAGAIN) => {}
                Err(e) => return Err(format!("scoped SSH bridge EOF failed: {e}")),
            }
        }
        if ssh_eof && download.empty() && !sent_shutdown {
            tcp.shutdown(Shutdown::Write)
                .map_err(|e| format!("scoped SSH bridge shutdown failed: {e}"))?;
            sent_shutdown = true;
            progress = true;
        }
        if sent_eof && sent_shutdown {
            return Ok(());
        }
        if !progress {
            std::thread::sleep(
                Duration::from_millis(5).min(deadline.saturating_duration_since(Instant::now())),
            );
        }
    }
}
