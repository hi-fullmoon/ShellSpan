//! Controller-owned fixed DNS server; never relays or changes system DNS.
use crate::{
    dns_native_probe::query_owned,
    dns_probe::{fixed_response, read_tcp_packet, write_tcp_packet},
};
use std::net::{TcpListener, UdpSocket};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};
use uuid::Uuid;
type Result<T> = std::result::Result<T, String>;

pub struct DnsReceiver {
    id: Uuid,
    stop: Arc<AtomicBool>,
    counts: [Arc<AtomicUsize>; 2],
    workers: Vec<std::thread::JoinHandle<()>>,
    controls_verified: bool,
    tcp_owners: Arc<Mutex<Vec<Result<u32>>>>,
    terminal_tcp_owners: Option<Vec<Result<u32>>>,
    terminal: Option<Result<[usize; 2]>>,
}
impl DnsReceiver {
    pub fn bind(id: Uuid) -> Result<Self> {
        if id.is_nil() {
            return Err("DNS receiver requires owned UUID".into());
        }
        // Both binds must succeed before any API call. Existing listeners are
        // never stopped or reconfigured to obtain the diagnostic port.
        let udp = UdpSocket::bind("127.0.0.1:53").map_err(|e| e.to_string())?;
        let tcp = TcpListener::bind("127.0.0.1:53").map_err(|e| e.to_string())?;
        udp.set_nonblocking(true).map_err(|e| e.to_string())?;
        tcp.set_nonblocking(true).map_err(|e| e.to_string())?;
        let mut control = Self {
            id,
            stop: Arc::new(AtomicBool::new(false)),
            counts: [Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0))],
            workers: Vec::new(),
            controls_verified: false,
            tcp_owners: Arc::new(Mutex::new(Vec::new())),
            terminal_tcp_owners: None,
            terminal: None,
        };
        let stop = control.stop.clone();
        let count = control.counts[0].clone();
        control.workers.push(std::thread::spawn(move || {
            let mut drain_deadline = None;
            loop {
                if drain_expired(&stop, &mut drain_deadline) {
                    count.store(usize::MAX, Ordering::SeqCst);
                    break;
                }
                let mut packet = [0u8; 513];
                match udp.recv_from(&mut packet) {
                    Ok((length, peer)) => {
                        count.fetch_add(1, Ordering::SeqCst);
                        if fixed_response(id, &packet[..length])
                            .and_then(|reply| {
                                udp.send_to(&reply, peer)
                                    .map(|_| ())
                                    .map_err(|e| e.to_string())
                            })
                            .is_err()
                        {
                            count.store(usize::MAX, Ordering::SeqCst);
                            break;
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        if stop.load(Ordering::SeqCst) {
                            break;
                        }
                    }
                    Err(_) => {
                        count.store(usize::MAX, Ordering::SeqCst);
                        break;
                    }
                }
                std::thread::sleep(Duration::from_millis(2));
            }
        }));
        let stop = control.stop.clone();
        let count = control.counts[1].clone();
        let owners = control.tcp_owners.clone();
        control.workers.push(std::thread::spawn(move || {
            let mut drain_deadline = None;
            loop {
                if drain_expired(&stop, &mut drain_deadline) {
                    count.store(usize::MAX, Ordering::SeqCst);
                    break;
                }
                match tcp.accept() {
                    Ok((mut stream, _)) => {
                        count.fetch_add(1, Ordering::SeqCst);
                        let owner = crate::dns_sender_identity::tcp_sender_pid(&stream);
                        if let Ok(mut observations) = owners.lock() {
                            if observations.len() < 8 {
                                observations.push(owner);
                            } else if observations.len() == 8 {
                                observations
                                    .push(Err("DNS sender attribution budget exceeded".into()));
                            }
                        } else {
                            count.store(usize::MAX, Ordering::SeqCst);
                            break;
                        }
                        let response = (|| -> Result<()> {
                            stream.set_nonblocking(false).map_err(|e| e.to_string())?;
                            stream
                                .set_read_timeout(Some(Duration::from_secs(1)))
                                .map_err(|e| e.to_string())?;
                            stream
                                .set_write_timeout(Some(Duration::from_secs(1)))
                                .map_err(|e| e.to_string())?;
                            let request = read_tcp_packet(&mut stream)?;
                            write_tcp_packet(&mut stream, &fixed_response(id, &request)?)
                        })();
                        if response.is_err() {
                            count.store(usize::MAX, Ordering::SeqCst);
                            break;
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        if stop.load(Ordering::SeqCst) {
                            break;
                        }
                    }
                    Err(_) => {
                        count.store(usize::MAX, Ordering::SeqCst);
                        break;
                    }
                }
                std::thread::sleep(Duration::from_millis(2));
            }
        }));
        control.verify_controls()?;
        for count in &control.counts {
            count.store(0, Ordering::SeqCst);
        }
        control
            .tcp_owners
            .lock()
            .map_err(|_| "DNS sender observation lock poisoned")?
            .clear();
        control.controls_verified = true;
        Ok(control)
    }
    pub fn tcp_sender_observations(&self) -> Result<&[Result<u32>]> {
        self.terminal_tcp_owners
            .as_deref()
            .ok_or("DNS sender observation window still live".into())
    }
    fn counts(&self) -> [usize; 2] {
        self.counts
            .each_ref()
            .map(|count| count.load(Ordering::SeqCst))
    }
    fn verify_controls(&self) -> Result<()> {
        for index in 0..2 {
            let before = self.counts();
            if before.contains(&usize::MAX) {
                return Err("DNS receiver error before positive control".into());
            }
            let observation = query_owned(
                self.id,
                "127.0.0.1:53".parse().map_err(|_| "fixed DNS endpoint")?,
                index == 1,
            )?;
            let after = self.counts();
            if !observation.verified_resolution(after[index].saturating_sub(before[index]))
                || after[1 - index] != before[1 - index]
            {
                return Err(format!("DNS positive control unverified: {observation:?}"));
            }
        }
        Ok(())
    }
    /// Caller must first confirm the complete owned execution tree stopped.
    pub fn finish(&mut self) -> Result<[usize; 2]> {
        if let Some(result) = &self.terminal {
            return result.clone();
        }
        self.terminal_tcp_owners = Some(
            self.tcp_owners
                .lock()
                .map_err(|_| "DNS sender observation lock poisoned")?
                .clone(),
        );
        let controls = if self.controls_verified {
            self.verify_controls()
        } else {
            Err("DNS initial controls incomplete".into())
        };
        self.stop.store(true, Ordering::SeqCst);
        let mut failed = false;
        for worker in self.workers.drain(..) {
            failed |= worker.join().is_err();
        }
        let counts = self.counts();
        let result = if failed || counts.contains(&usize::MAX) {
            Err("DNS receiver failed during observation".into())
        } else {
            controls.and_then(|()| {
                Ok([
                    counts[0]
                        .checked_sub(1)
                        .ok_or("DNS UDP final control missing")?,
                    counts[1]
                        .checked_sub(1)
                        .ok_or("DNS TCP final control missing")?,
                ])
            })
        };
        self.terminal = Some(result.clone());
        result
    }
}
fn drain_expired(stop: &AtomicBool, deadline: &mut Option<Instant>) -> bool {
    stop.load(Ordering::SeqCst)
        && Instant::now()
            >= *deadline.get_or_insert_with(|| Instant::now() + Duration::from_secs(1))
}
impl Drop for DnsReceiver {
    fn drop(&mut self) {
        let _ = self.finish();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "requires exclusive owned loopback UDP/TCP port 53"]
    fn actual_cache_only_calibration_leaves_owned_dns_window_quiet() {
        let mut receiver = DnsReceiver::bind(Uuid::new_v4()).unwrap();
        // Use a fresh name that the positive controls never queried. If this
        // leaks a query to the owned resolver, its unknown-question gate fails.
        let observation = crate::dns_native_probe::query_cache_only(Uuid::new_v4()).unwrap();
        assert_eq!(observation.completion_status, Some(9701), "{observation:?}");
        assert!(!observation.records_returned && !observation.fixed_answer);
        assert!(!observation.timed_out && observation.cancel_status.is_none());
        assert!(!observation.explicit_api_denial());
        assert_eq!(receiver.finish().unwrap(), [0, 0]);
        assert_eq!(receiver.finish().unwrap(), [0, 0]);
    }
    #[test]
    #[ignore = "requires exclusive owned loopback UDP/TCP port 53"]
    fn actual_dns_receiver_preserves_intervening_queries_and_terminal_counts() {
        let id = Uuid::new_v4();
        let mut receiver = DnsReceiver::bind(id).unwrap();
        for tcp in [false, true] {
            assert!(query_owned(id, "127.0.0.1:53".parse().unwrap(), tcp)
                .unwrap()
                .verified_resolution(1));
        }
        assert_eq!(receiver.finish().unwrap(), [1, 1]);
        assert_eq!(receiver.tcp_sender_observations().unwrap().len(), 1);
        assert!(receiver.tcp_sender_observations().unwrap()[0].is_ok());
        assert_eq!(receiver.finish().unwrap(), [1, 1]);
        assert_eq!(receiver.tcp_sender_observations().unwrap().len(), 1);
        assert!(receiver.tcp_sender_observations().unwrap()[0].is_ok());
        drop(receiver);
        let mut quiet = DnsReceiver::bind(Uuid::new_v4()).unwrap();
        assert_eq!(quiet.finish().unwrap(), [0, 0]);
        assert!(quiet.tcp_sender_observations().unwrap().is_empty());
        drop(quiet);
        let mut invalid = DnsReceiver::bind(Uuid::new_v4()).unwrap();
        let sender = UdpSocket::bind("127.0.0.1:0").unwrap();
        sender
            .send_to(
                &crate::dns_probe::fixed_query(Uuid::new_v4(), 1).unwrap(),
                "127.0.0.1:53",
            )
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(1);
        while invalid.counts()[0] != usize::MAX && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(2));
        }
        assert_eq!(invalid.counts()[0], usize::MAX);
        let failure = invalid.finish();
        assert!(failure.is_err());
        assert_eq!(invalid.finish(), failure);
    }
}
