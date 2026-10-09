//! Receiver evidence owned by the controller, independent of sandbox account APIs.
use serde::{Deserialize, Serialize};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV6, TcpListener, TcpStream, UdpSocket};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};
use std::time::{Duration, Instant};
type Result<T> = std::result::Result<T, String>;
pub(crate) fn local_sender_address(address: SocketAddr) -> SocketAddr {
    match address {
        SocketAddr::V4(mut address) => {
            address.set_port(0);
            SocketAddr::V4(address)
        }
        SocketAddr::V6(mut address) => {
            address.set_port(0);
            SocketAddr::V6(address)
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Endpoints {
    pub tcp: [SocketAddr; 2],
    pub udp: [SocketAddr; 2],
}
impl Endpoints {
    pub(crate) fn validate_private_local(&self) -> Result<()> {
        for pair in [&self.tcp, &self.udp] {
            let (SocketAddr::V4(v4), SocketAddr::V6(v6)) = (pair[0], pair[1]) else {
                return Err("private receivers require ordered IPv4/IPv6 endpoints".into());
            };
            let octets = v6.ip().octets();
            let unique_local = octets[0] & 0xfe == 0xfc;
            let link_local = octets[0] == 0xfe && octets[1] & 0xc0 == 0x80;
            if !v4.ip().is_private()
                || !(unique_local || link_local)
                || (link_local && v6.scope_id() == 0)
                || (unique_local && v6.scope_id() != 0)
                || v6.flowinfo() != 0
                || v4.port() == 0
                || v6.port() == 0
            {
                return Err("private receiver addresses or interface scope invalid".into());
            }
        }
        Ok(())
    }
    pub fn validate(&self) -> Result<()> {
        for pair in [&self.tcp, &self.udp] {
            if !pair[0].is_ipv4()
                || !pair[1].is_ipv6()
                || pair
                    .iter()
                    .any(|address| !address.ip().is_loopback() || address.port() == 0)
            {
                return Err(
                    "controller receivers require IPv4/IPv6 loopback and assigned ports".into(),
                );
            }
        }
        Ok(())
    }
}

pub struct ReceiverControl {
    endpoints: Endpoints,
    stop: Arc<AtomicBool>,
    counts: Vec<Arc<AtomicUsize>>,
    workers: Vec<std::thread::JoinHandle<()>>,
    positive_controls_verified: bool,
    terminal_result: Option<Result<Vec<usize>>>,
}
impl ReceiverControl {
    /// Fixed machine diagnostic inventory, embedded in the frozen image. No
    /// runtime file or model-provided destination can select these interfaces.
    pub fn bind_fixed_private_local() -> Result<Self> {
        let inventory: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../docs/design/evidence/windows-stage-a-2026-10-09-local-network-inventory.json"
        )))
        .map_err(|e| e.to_string())?;
        let entries = inventory["addresses"]
            .as_array()
            .ok_or("missing local interface inventory")?;
        if entries.len() > 16 {
            return Err("local interface inventory exceeds fixed budget".into());
        }
        let (v4, interface) = entries
            .iter()
            .find_map(|entry| {
                let address = entry["IPAddress"].as_str()?.parse::<Ipv4Addr>().ok()?;
                let interface = u32::try_from(entry["InterfaceIndex"].as_u64()?).ok()?;
                (address.is_private() && interface != 0).then_some((address, interface))
            })
            .ok_or("fixed private IPv4 interface unavailable")?;
        let v6 = entries
            .iter()
            .find_map(|entry| {
                if entry["InterfaceIndex"].as_u64()? != u64::from(interface) {
                    return None;
                }
                let text = entry["IPAddress"].as_str()?;
                if text.len() > 128 {
                    return None;
                }
                let address = format!("[{text}]:0").parse::<SocketAddrV6>().ok()?;
                (address.scope_id() == interface).then_some(address)
            })
            .ok_or("fixed matching private IPv6 interface unavailable")?;
        Self::bind_private_local(v4, v6)
    }
    /// Controller diagnostics only: all four sockets must bind to local interfaces
    /// before any positive-control traffic is sent. This does not relax the
    /// loopback-only endpoint contract used by the existing sandbox launch plan.
    pub fn bind_private_local(v4: Ipv4Addr, v6: SocketAddrV6) -> Result<Self> {
        if v6.port() != 0 {
            return Err("private receiver port must be assigned by the OS".into());
        }
        let candidate = Endpoints {
            tcp: [
                SocketAddr::from((v4, 1)),
                SocketAddr::V6(SocketAddrV6::new(*v6.ip(), 1, v6.flowinfo(), v6.scope_id())),
            ],
            udp: [
                SocketAddr::from((v4, 1)),
                SocketAddr::V6(SocketAddrV6::new(*v6.ip(), 1, v6.flowinfo(), v6.scope_id())),
            ],
        };
        candidate.validate_private_local()?;
        let tcp = [
            TcpListener::bind((v4, 0)).map_err(|e| e.to_string())?,
            TcpListener::bind(v6).map_err(|e| e.to_string())?,
        ];
        let udp = [
            UdpSocket::bind((v4, 0)).map_err(|e| e.to_string())?,
            UdpSocket::bind(v6).map_err(|e| e.to_string())?,
        ];
        Self::start_validated(&tcp, &udp, true)
    }
    pub fn bind() -> Result<Self> {
        let tcp = [
            TcpListener::bind("127.0.0.1:0"),
            TcpListener::bind("[::1]:0"),
        ]
        .into_iter()
        .collect::<std::io::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
        let udp = [UdpSocket::bind("127.0.0.1:0"), UdpSocket::bind("[::1]:0")]
            .into_iter()
            .collect::<std::io::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;
        let tcp: [TcpListener; 2] = tcp.try_into().map_err(|_| "controller TCP count")?;
        let udp: [UdpSocket; 2] = udp.try_into().map_err(|_| "controller UDP count")?;
        Self::start(&tcp, &udp)
    }
    pub fn start(tcp: &[TcpListener; 2], udp: &[UdpSocket; 2]) -> Result<Self> {
        Self::start_validated(tcp, udp, false)
    }
    fn start_validated(
        tcp: &[TcpListener; 2],
        udp: &[UdpSocket; 2],
        private: bool,
    ) -> Result<Self> {
        let endpoints = Endpoints {
            tcp: [
                tcp[0].local_addr().map_err(|e| e.to_string())?,
                tcp[1].local_addr().map_err(|e| e.to_string())?,
            ],
            udp: [
                udp[0].local_addr().map_err(|e| e.to_string())?,
                udp[1].local_addr().map_err(|e| e.to_string())?,
            ],
        };
        if private {
            endpoints.validate_private_local()?;
        } else {
            endpoints.validate()?;
        }
        let mut control = Self {
            endpoints,
            stop: Arc::new(AtomicBool::new(false)),
            counts: vec![],
            workers: vec![],
            positive_controls_verified: false,
            terminal_result: None,
        };
        for listener in tcp {
            let listener = listener.try_clone().map_err(|e| e.to_string())?;
            listener.set_nonblocking(true).map_err(|e| e.to_string())?;
            let stop = control.stop.clone();
            let count = Arc::new(AtomicUsize::new(0));
            let received = count.clone();
            control.counts.push(count);
            control.workers.push(std::thread::spawn(move || {
                let mut drain_deadline = None;
                loop {
                    if stop.load(Ordering::SeqCst) {
                        let deadline = drain_deadline
                            .get_or_insert_with(|| Instant::now() + Duration::from_secs(1));
                        if Instant::now() >= *deadline {
                            received.store(usize::MAX, Ordering::SeqCst);
                            break;
                        }
                    }
                    match listener.accept() {
                        Ok(_) => {
                            received.fetch_add(1, Ordering::SeqCst);
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            if stop.load(Ordering::SeqCst) {
                                break;
                            }
                        }
                        Err(_) => {
                            received.store(usize::MAX, Ordering::SeqCst);
                            break;
                        }
                    }
                    std::thread::sleep(Duration::from_millis(2));
                }
            }));
        }
        for receiver in udp {
            let receiver = receiver.try_clone().map_err(|e| e.to_string())?;
            receiver.set_nonblocking(true).map_err(|e| e.to_string())?;
            let stop = control.stop.clone();
            let count = Arc::new(AtomicUsize::new(0));
            let received = count.clone();
            control.counts.push(count);
            control.workers.push(std::thread::spawn(move || {
                let mut drain_deadline = None;
                loop {
                    if stop.load(Ordering::SeqCst) {
                        let deadline = drain_deadline
                            .get_or_insert_with(|| Instant::now() + Duration::from_secs(1));
                        if Instant::now() >= *deadline {
                            received.store(usize::MAX, Ordering::SeqCst);
                            break;
                        }
                    }
                    match receiver.recv_from(&mut [0u8; 64]) {
                        Ok(_) => {
                            received.fetch_add(1, Ordering::SeqCst);
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            if stop.load(Ordering::SeqCst) {
                                break;
                            }
                        }
                        Err(_) => {
                            received.store(usize::MAX, Ordering::SeqCst);
                            break;
                        }
                    }
                    std::thread::sleep(Duration::from_millis(2));
                }
            }));
        }
        // These exact clones must observe controls before the frozen low-privilege launch.
        let mut clients = vec![];
        for address in &control.endpoints.tcp {
            clients.push(
                TcpStream::connect_timeout(address, Duration::from_secs(1))
                    .map_err(|e| e.to_string())?,
            );
        }
        for address in &control.endpoints.udp {
            let sender =
                UdpSocket::bind(local_sender_address(*address)).map_err(|e| e.to_string())?;
            sender
                .send_to(b"controller-positive", address)
                .map_err(|e| e.to_string())?;
        }
        let deadline = Instant::now() + Duration::from_secs(1);
        while control.counts().iter().any(|count| *count != 1) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        if control.counts().iter().any(|count| *count != 1) {
            return Err("same receiver clones did not observe all four positive controls".into());
        }
        for count in &control.counts {
            count.store(0, Ordering::SeqCst);
        }
        drop(clients);
        control.positive_controls_verified = true;
        Ok(control)
    }
    pub fn endpoints(&self) -> &Endpoints {
        &self.endpoints
    }
    pub fn counts(&self) -> Vec<usize> {
        self.counts
            .iter()
            .map(|count| count.load(Ordering::SeqCst))
            .collect()
    }
    fn verify_end_controls(&self) -> Result<()> {
        let baseline = self.counts();
        if baseline.len() != 4 || baseline.contains(&usize::MAX) {
            return Err("receiver failed before final positive controls".into());
        }
        let mut clients = Vec::new();
        for address in &self.endpoints.tcp {
            clients.push(
                TcpStream::connect_timeout(address, Duration::from_secs(1))
                    .map_err(|e| format!("final TCP positive control: {e}"))?,
            );
        }
        for address in &self.endpoints.udp {
            let sender = UdpSocket::bind(local_sender_address(*address))
                .map_err(|e| format!("final UDP positive control bind: {e}"))?;
            sender
                .send_to(b"controller-final-positive", address)
                .map_err(|e| format!("final UDP positive control send: {e}"))?;
        }
        let deadline = Instant::now() + Duration::from_secs(1);
        loop {
            let counts = self.counts();
            if counts.contains(&usize::MAX) {
                return Err("receiver failed during final positive controls".into());
            }
            if counts
                .iter()
                .zip(&baseline)
                .all(|(count, before)| count > before)
            {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err("final positive controls were not observed by every receiver".into());
            }
            std::thread::sleep(Duration::from_millis(2));
        }
    }
    pub fn finish(&mut self) -> Result<Vec<usize>> {
        if let Some(result) = &self.terminal_result {
            return result.clone();
        }
        // The caller must stop the owned process tree first. Drain queued traffic
        // before declaring quietness; stopping before recv/accept can hide it.
        let final_controls = self.verify_end_controls();
        self.stop.store(true, Ordering::SeqCst);
        let mut failed = false;
        for worker in self.workers.drain(..) {
            failed |= worker.join().is_err();
        }
        let counts = self.counts();
        let result = if failed || !self.positive_controls_verified {
            Err("controller receiver evidence incomplete".into())
        } else if counts.contains(&usize::MAX) {
            Err("controller receiver failed during observation".into())
        } else if let Err(reason) = final_controls {
            Err(reason)
        } else {
            counts
                .into_iter()
                .map(|count| {
                    count.checked_sub(1).ok_or_else(|| {
                        "final positive control count missing at retirement".to_string()
                    })
                })
                .collect()
        };
        self.terminal_result = Some(result.clone());
        result
    }
}
impl Drop for ReceiverControl {
    fn drop(&mut self) {
        let _ = self.finish();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn private_endpoints_require_private_addresses_and_exact_interface_scope() {
        let good = Endpoints {
            tcp: [
                "192.168.2.1:1".parse().unwrap(),
                "[fe80::1%11]:2".parse().unwrap(),
            ],
            udp: [
                "192.168.2.1:3".parse().unwrap(),
                "[fe80::1%11]:4".parse().unwrap(),
            ],
        };
        assert!(good.validate_private_local().is_ok());
        assert!(good.validate().is_err());
        for value in [
            "[fe80::1]:2",
            "[::1]:2",
            "[ff02::1%11]:2",
            "[2001:db8::1]:2",
            "[fc00::1%11]:2",
            "[fe80::1%11]:0",
        ] {
            let mut bad = good.clone();
            bad.tcp[1] = value.parse().unwrap();
            assert!(bad.validate_private_local().is_err(), "{value}");
        }
        let address: SocketAddr = "[fe80::1%11]:42".parse().unwrap();
        assert_eq!(
            local_sender_address(address),
            "[fe80::1%11]:0".parse().unwrap()
        );
        assert!(ReceiverControl::bind_private_local(
            Ipv4Addr::LOCALHOST,
            "[fe80::1%11]:0".parse().unwrap()
        )
        .is_err());
    }
    #[test]
    #[ignore = "requires the frozen diagnostic inventory's private local interfaces"]
    fn actual_private_local_receivers_observe_controls_and_real_traffic() {
        let mut control = ReceiverControl::bind_fixed_private_local().unwrap();
        let endpoints = control.endpoints().clone();
        let clients: Vec<_> = endpoints
            .tcp
            .into_iter()
            .map(|address| TcpStream::connect(address).unwrap())
            .collect();
        for address in endpoints.udp {
            UdpSocket::bind(local_sender_address(address))
                .unwrap()
                .send_to(b"owned-private-test", address)
                .unwrap();
        }
        assert_eq!(control.finish().unwrap(), vec![1; 4]);
        drop(clients);
    }
    #[test]
    fn stopped_receivers_cannot_attest_quietness_without_final_positive_controls() {
        let mut control = ReceiverControl::bind().unwrap();
        control.stop.store(true, Ordering::SeqCst);
        for worker in control.workers.drain(..) {
            worker.join().unwrap();
        }
        assert_eq!(control.counts(), vec![0; 4]);
        let result = control.finish();
        assert!(result.is_err());
        assert_eq!(control.finish(), result);
    }
    #[test]
    fn repeated_finish_preserves_failure_and_the_original_observation() {
        let mut failed = ReceiverControl::bind().unwrap();
        failed.positive_controls_verified = false;
        let original = failed.finish();
        assert!(original.is_err());
        failed.positive_controls_verified = true;
        assert_eq!(failed.finish(), original);

        let mut quiet = ReceiverControl::bind().unwrap();
        let original = quiet.finish();
        assert_eq!(original, Ok(vec![0; 4]));
        quiet.counts[0].store(9, Ordering::SeqCst);
        assert_eq!(quiet.finish(), original);
    }
    #[test]
    fn finish_drains_queued_traffic_without_waiting_for_worker_observation() {
        let mut control = ReceiverControl::bind().unwrap();
        let mut clients = Vec::new();
        for address in control.endpoints().tcp {
            clients.push(TcpStream::connect(address).unwrap());
        }
        for address in control.endpoints().udp {
            let sender = UdpSocket::bind(if address.is_ipv4() {
                "127.0.0.1:0"
            } else {
                "[::1]:0"
            })
            .unwrap();
            sender
                .send_to(b"queued-before-retirement", address)
                .unwrap();
        }
        assert_eq!(control.finish().unwrap(), vec![1; 4]);
        drop(clients);
    }
    #[test]
    fn controller_clones_receive_all_transports_and_stop_when_quiet() {
        let mut control = ReceiverControl::bind().unwrap();
        let endpoints = control.endpoints().clone();
        let mut clients = vec![];
        for address in endpoints.tcp {
            clients.push(TcpStream::connect(address).unwrap());
        }
        for address in endpoints.udp {
            let sender = UdpSocket::bind(if address.is_ipv4() {
                "127.0.0.1:0"
            } else {
                "[::1]:0"
            })
            .unwrap();
            sender
                .send_to(b"observable-negative-counterexample", address)
                .unwrap();
        }
        let deadline = Instant::now() + Duration::from_secs(1);
        while control.counts().iter().any(|count| *count != 1) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(
            control.finish().unwrap(),
            vec![1; 4],
            "real controller receiver evidence must catch allowed traffic"
        );
        drop(clients);
        let mut quiet = ReceiverControl::bind().unwrap();
        assert_eq!(quiet.finish().unwrap(), vec![0; 4]);
    }
    #[test]
    fn endpoints_reject_nonloopback_zero_ports_and_wrong_family_order() {
        let good = Endpoints {
            tcp: ["127.0.0.1:1".parse().unwrap(), "[::1]:2".parse().unwrap()],
            udp: ["127.0.0.1:3".parse().unwrap(), "[::1]:4".parse().unwrap()],
        };
        assert!(good.validate().is_ok());
        for address in ["192.168.1.1:1", "127.0.0.1:0", "[::1]:1"] {
            let mut bad = good.clone();
            bad.tcp[0] = address.parse().unwrap();
            assert!(bad.validate().is_err());
        }
    }
}
