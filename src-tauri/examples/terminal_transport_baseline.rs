use crossbeam_channel::bounded;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use ssh2::Session;
use std::env;
use std::error::Error;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant};

const DEFAULT_BYTES: usize = 2 * 1024 * 1024;
const DEFAULT_REPETITIONS: usize = 5;
const DEFAULT_SESSIONS: usize = 4;
const EMIT_CHUNK_BYTES: usize = 8 * 1024;
const LOCAL_OUTPUT_QUEUE_CAPACITY: usize = 32;
const LOCAL_WORKER_POLL_INTERVAL: Duration = Duration::from_millis(16);
const LATENCY_SAMPLES: usize = 41;
const LOW_FREQUENCY_BURST_INTERVAL: Duration = Duration::from_millis(20);

#[derive(Clone, Copy)]
struct Config {
    bytes: usize,
    repetitions: usize,
    sessions: usize,
    ssh: bool,
}

fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<String> = env::args().collect();
    if args.get(1).is_some_and(|value| value == "--emit-bytes") {
        let bytes = parse_positive(args.get(2), "--emit-bytes")?;
        emit_bytes(bytes)?;
        return Ok(());
    }

    let config = parse_config(&args[1..])?;
    println!(
        "terminal_transport_baseline bytes_per_session={} repetitions={} multi_sessions={} profile={}",
        config.bytes,
        config.repetitions,
        config.sessions,
        if cfg!(debug_assertions) { "debug" } else { "release" },
    );
    println!("scenario\tmedian_ms\tp95_ms\tmedian_mib_per_s\trepetitions");

    run_suite("local_pty_single", config, 1, |bytes| run_local_pty(bytes))?;
    if config.sessions > 1 {
        run_suite("local_pty_multi", config, config.sessions, |bytes| {
            run_local_pty(bytes)
        })?;
    }

    println!("latency_scenario\tmedian_ms\tp95_ms\tmax_ms\tsamples");
    run_local_worker_latency_suite(
        "local_worker_legacy_16ms_first_byte",
        LocalWorkerWaitMode::LegacyPoll,
        None,
    )?;
    run_local_worker_latency_suite(
        "local_worker_event_first_byte",
        LocalWorkerWaitMode::EventDriven,
        None,
    )?;
    run_local_worker_latency_suite(
        "local_worker_legacy_16ms_low_frequency_burst",
        LocalWorkerWaitMode::LegacyPoll,
        Some(LOW_FREQUENCY_BURST_INTERVAL),
    )?;
    run_local_worker_latency_suite(
        "local_worker_event_low_frequency_burst",
        LocalWorkerWaitMode::EventDriven,
        Some(LOW_FREQUENCY_BURST_INTERVAL),
    )?;

    if config.ssh {
        let ssh_config = Arc::new(SshConfig::from_env()?);
        run_suite("ssh_pty_single", config, 1, {
            let ssh_config = Arc::clone(&ssh_config);
            move |bytes| run_ssh_pty(&ssh_config, bytes)
        })?;
        if config.sessions > 1 {
            run_suite("ssh_pty_multi", config, config.sessions, {
                let ssh_config = Arc::clone(&ssh_config);
                move |bytes| run_ssh_pty(&ssh_config, bytes)
            })?;
        }
    } else {
        println!(
            "ssh_pty\tSKIPPED (pass --ssh with TERMBRIDGE_E2E_SSH_* set for the isolated SSH fixture)"
        );
    }

    Ok(())
}

#[derive(Clone, Copy)]
enum LocalWorkerWaitMode {
    LegacyPoll,
    EventDriven,
}

fn run_local_worker_latency_suite(
    name: &str,
    mode: LocalWorkerWaitMode,
    interval: Option<Duration>,
) -> Result<(), Box<dyn Error>> {
    let mut elapsed_ms = measure_local_worker_latency(mode, interval, LATENCY_SAMPLES)?;
    elapsed_ms.sort_by(f64::total_cmp);
    let median_ms = percentile(&elapsed_ms, 0.50);
    let p95_ms = percentile(&elapsed_ms, 0.95);
    let max_ms = elapsed_ms.last().copied().unwrap_or_default();
    println!(
        "{name}\t{median_ms:.3}\t{p95_ms:.3}\t{max_ms:.3}\t{}",
        elapsed_ms.len()
    );
    Ok(())
}

fn measure_local_worker_latency(
    mode: LocalWorkerWaitMode,
    interval: Option<Duration>,
    samples: usize,
) -> Result<Vec<f64>, String> {
    if interval.is_none() {
        return (0..samples)
            .map(|_| measure_local_worker_first_byte(mode))
            .collect();
    }

    match mode {
        LocalWorkerWaitMode::LegacyPoll => {
            measure_legacy_poll_burst_latency(interval.unwrap(), samples)
        }
        LocalWorkerWaitMode::EventDriven => measure_event_burst_latency(interval.unwrap(), samples),
    }
}

fn measure_legacy_poll_burst_latency(
    interval: Duration,
    samples: usize,
) -> Result<Vec<f64>, String> {
    let (output_tx, output_rx) = mpsc::channel::<Instant>();
    let (ready_tx, ready_rx) = mpsc::channel::<()>();
    let worker = thread::spawn(move || -> Result<Vec<f64>, String> {
        let (command_tx, command_rx) = mpsc::channel::<()>();
        let _keep_command_channel_open = command_tx;
        let mut elapsed_ms = Vec::with_capacity(samples);
        ready_tx
            .send(())
            .map_err(|_| "latency producer stopped before worker became ready".to_string())?;

        while elapsed_ms.len() < samples {
            let _ = command_rx.recv_timeout(LOCAL_WORKER_POLL_INTERVAL);
            let arrived_at = output_rx.try_recv().ok();
            if let Some(arrived_at) = arrived_at {
                elapsed_ms.push(arrived_at.elapsed().as_secs_f64() * 1_000.0);
            }
        }
        Ok(elapsed_ms)
    });

    ready_rx
        .recv()
        .map_err(|_| "latency worker stopped before becoming ready".to_string())?;
    for index in 0..samples {
        output_tx
            .send(Instant::now())
            .map_err(|_| "latency worker stopped before receiving output".to_string())?;
        if index + 1 < samples {
            thread::sleep(interval);
        }
    }

    worker
        .join()
        .map_err(|_| "latency benchmark worker panicked".to_string())?
}

fn measure_event_burst_latency(interval: Duration, samples: usize) -> Result<Vec<f64>, String> {
    let (output_tx, output_rx) = bounded::<Instant>(LOCAL_OUTPUT_QUEUE_CAPACITY);
    let (ready_tx, ready_rx) = bounded::<()>(1);
    let worker = thread::spawn(move || -> Result<Vec<f64>, String> {
        let mut elapsed_ms = Vec::with_capacity(samples);
        ready_tx
            .send(())
            .map_err(|_| "latency producer stopped before worker became ready".to_string())?;
        while elapsed_ms.len() < samples {
            let arrived_at = output_rx
                .recv()
                .map_err(|_| "latency producer stopped during event wait".to_string())?;
            elapsed_ms.push(arrived_at.elapsed().as_secs_f64() * 1_000.0);
        }
        Ok(elapsed_ms)
    });

    ready_rx
        .recv()
        .map_err(|_| "latency worker stopped before becoming ready".to_string())?;
    for index in 0..samples {
        output_tx
            .send(Instant::now())
            .map_err(|_| "latency worker stopped before receiving output".to_string())?;
        if index + 1 < samples {
            thread::sleep(interval);
        }
    }
    worker
        .join()
        .map_err(|_| "latency benchmark worker panicked".to_string())?
}

fn measure_local_worker_first_byte(mode: LocalWorkerWaitMode) -> Result<f64, String> {
    match mode {
        LocalWorkerWaitMode::LegacyPoll => measure_legacy_poll_first_byte(),
        LocalWorkerWaitMode::EventDriven => measure_event_first_byte(),
    }
}

fn measure_legacy_poll_first_byte() -> Result<f64, String> {
    let (output_tx, output_rx) = mpsc::channel::<Instant>();
    let (ready_tx, ready_rx) = mpsc::channel::<()>();
    let worker = thread::spawn(move || -> Result<f64, String> {
        let (command_tx, command_rx) = mpsc::channel::<()>();
        let _keep_command_channel_open = command_tx;
        ready_tx
            .send(())
            .map_err(|_| "first-byte producer stopped before worker became ready".to_string())?;
        let _ = command_rx.recv_timeout(LOCAL_WORKER_POLL_INTERVAL);
        let arrived_at = output_rx
            .recv()
            .map_err(|_| "first-byte producer stopped during legacy wait".to_string())?;
        Ok(arrived_at.elapsed().as_secs_f64() * 1_000.0)
    });

    ready_rx
        .recv()
        .map_err(|_| "first-byte worker stopped before becoming ready".to_string())?;
    output_tx
        .send(Instant::now())
        .map_err(|_| "first-byte worker stopped before receiving output".to_string())?;
    worker
        .join()
        .map_err(|_| "first-byte benchmark worker panicked".to_string())?
}

fn measure_event_first_byte() -> Result<f64, String> {
    let (output_tx, output_rx) = bounded::<Instant>(1);
    let (ready_tx, ready_rx) = bounded::<()>(1);
    let worker = thread::spawn(move || -> Result<f64, String> {
        ready_tx
            .send(())
            .map_err(|_| "first-byte producer stopped before worker became ready".to_string())?;
        let arrived_at = output_rx
            .recv()
            .map_err(|_| "first-byte producer stopped during event wait".to_string())?;
        Ok(arrived_at.elapsed().as_secs_f64() * 1_000.0)
    });

    ready_rx
        .recv()
        .map_err(|_| "first-byte worker stopped before becoming ready".to_string())?;
    output_tx
        .send(Instant::now())
        .map_err(|_| "first-byte worker stopped before receiving output".to_string())?;
    worker
        .join()
        .map_err(|_| "first-byte benchmark worker panicked".to_string())?
}

fn parse_config(args: &[String]) -> Result<Config, Box<dyn Error>> {
    let mut config = Config {
        bytes: DEFAULT_BYTES,
        repetitions: DEFAULT_REPETITIONS,
        sessions: DEFAULT_SESSIONS,
        ssh: false,
    };
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--bytes" => {
                config.bytes = parse_positive(args.get(index + 1), "--bytes")?;
                index += 2;
            }
            "--repetitions" => {
                config.repetitions = parse_positive(args.get(index + 1), "--repetitions")?;
                index += 2;
            }
            "--sessions" => {
                config.sessions = parse_positive(args.get(index + 1), "--sessions")?;
                index += 2;
            }
            "--ssh" => {
                config.ssh = true;
                index += 1;
            }
            "--help" | "-h" => {
                println!(
                    "Usage: terminal_transport_baseline [--bytes N] [--repetitions N] [--sessions N] [--ssh]"
                );
                std::process::exit(0);
            }
            unknown => return Err(format!("unknown argument: {unknown}").into()),
        }
    }
    Ok(config)
}

fn parse_positive(value: Option<&String>, flag: &str) -> Result<usize, Box<dyn Error>> {
    let value = value.ok_or_else(|| format!("{flag} requires a value"))?;
    let parsed = value.parse::<usize>()?;
    if parsed == 0 {
        return Err(format!("{flag} must be greater than zero").into());
    }
    Ok(parsed)
}

fn emit_bytes(bytes: usize) -> Result<(), Box<dyn Error>> {
    let chunk = vec![b'x'; EMIT_CHUNK_BYTES];
    let mut stdout = std::io::stdout().lock();
    let mut remaining = bytes;
    while remaining > 0 {
        let count = remaining.min(chunk.len());
        stdout.write_all(&chunk[..count])?;
        remaining -= count;
    }
    stdout.flush()?;
    Ok(())
}

fn run_suite<F>(
    name: &str,
    config: Config,
    sessions: usize,
    operation: F,
) -> Result<(), Box<dyn Error>>
where
    F: Fn(usize) -> Result<usize, String> + Send + Sync + 'static,
{
    let operation = Arc::new(operation);
    run_parallel(sessions, config.bytes, Arc::clone(&operation))?;

    let mut elapsed_ms = Vec::with_capacity(config.repetitions);
    for _ in 0..config.repetitions {
        let started = Instant::now();
        let received = run_parallel(sessions, config.bytes, Arc::clone(&operation))?;
        let elapsed = started.elapsed();
        let expected = sessions * config.bytes;
        if received < expected {
            return Err(
                format!("{name} received {received} bytes, expected at least {expected}").into(),
            );
        }
        elapsed_ms.push(elapsed.as_secs_f64() * 1_000.0);
    }

    elapsed_ms.sort_by(f64::total_cmp);
    let median_ms = percentile(&elapsed_ms, 0.50);
    let p95_ms = percentile(&elapsed_ms, 0.95);
    let total_mib = (sessions * config.bytes) as f64 / (1024.0 * 1024.0);
    let median_mib_per_s = total_mib / (median_ms / 1_000.0);
    println!(
        "{name}\t{median_ms:.3}\t{p95_ms:.3}\t{median_mib_per_s:.2}\t{}",
        config.repetitions
    );
    Ok(())
}

fn run_parallel<F>(sessions: usize, bytes: usize, operation: Arc<F>) -> Result<usize, String>
where
    F: Fn(usize) -> Result<usize, String> + Send + Sync + 'static,
{
    if sessions == 1 {
        return operation(bytes);
    }
    let handles: Vec<_> = (0..sessions)
        .map(|_| {
            let operation = Arc::clone(&operation);
            thread::spawn(move || operation(bytes))
        })
        .collect();
    handles.into_iter().try_fold(0_usize, |total, handle| {
        let received = handle
            .join()
            .map_err(|_| "transport benchmark worker panicked".to_string())??;
        Ok(total + received)
    })
}

fn percentile(sorted: &[f64], quantile: f64) -> f64 {
    let index = ((sorted.len() - 1) as f64 * quantile).ceil() as usize;
    sorted[index]
}

fn run_local_pty(bytes: usize) -> Result<usize, String> {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 30,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("open local PTY: {error}"))?;
    let executable =
        env::current_exe().map_err(|error| format!("resolve benchmark executable: {error}"))?;
    let mut command = CommandBuilder::new(executable);
    command.arg("--emit-bytes");
    command.arg(bytes.to_string());
    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("spawn PTY output helper: {error}"))?;
    drop(pair.slave);
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("clone PTY reader: {error}"))?;
    let mut buffer = [0_u8; 8 * 1024];
    let mut received = 0_usize;
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => received += count,
            Err(_) if received >= bytes => break,
            Err(error) => return Err(format!("read PTY output after {received} bytes: {error}")),
        }
    }
    child
        .wait()
        .map_err(|error| format!("wait for PTY output helper: {error}"))?;
    Ok(received)
}

struct SshConfig {
    host: String,
    port: u16,
    username: String,
    password: String,
}

impl SshConfig {
    fn from_env() -> Result<Self, Box<dyn Error>> {
        Ok(Self {
            host: env::var("TERMBRIDGE_E2E_SSH_HOST")?,
            port: env::var("TERMBRIDGE_E2E_SSH_PORT")?.parse()?,
            username: env::var("TERMBRIDGE_E2E_SSH_USERNAME")?,
            password: env::var("TERMBRIDGE_E2E_SSH_PASSWORD")?,
        })
    }
}

fn run_ssh_pty(config: &SshConfig, bytes: usize) -> Result<usize, String> {
    let stream = TcpStream::connect((&*config.host, config.port))
        .map_err(|error| format!("connect SSH fixture: {error}"))?;
    stream
        .set_nodelay(true)
        .map_err(|error| format!("set SSH TCP_NODELAY: {error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(15)))
        .map_err(|error| format!("set SSH read timeout: {error}"))?;
    stream
        .set_write_timeout(Some(Duration::from_secs(15)))
        .map_err(|error| format!("set SSH write timeout: {error}"))?;

    let mut session = Session::new().map_err(|error| format!("create SSH session: {error}"))?;
    session.set_tcp_stream(stream);
    session
        .handshake()
        .map_err(|error| format!("SSH handshake: {error}"))?;
    session
        .userauth_password(&config.username, &config.password)
        .map_err(|error| format!("SSH password authentication: {error}"))?;
    let mut channel = session
        .channel_session()
        .map_err(|error| format!("open SSH channel: {error}"))?;
    channel
        .request_pty("xterm-256color", None, None)
        .map_err(|error| format!("request SSH PTY: {error}"))?;
    channel
        .exec(&format!("head -c {bytes} /dev/zero | tr '\\000' x"))
        .map_err(|error| format!("start SSH output command: {error}"))?;

    let mut buffer = [0_u8; 8 * 1024];
    let mut received = 0_usize;
    loop {
        match channel.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => received += count,
            Err(error) => {
                return Err(format!(
                    "read SSH PTY output after {received} bytes: {error}"
                ))
            }
        }
    }
    channel
        .wait_close()
        .map_err(|error| format!("close SSH channel: {error}"))?;
    Ok(received)
}
