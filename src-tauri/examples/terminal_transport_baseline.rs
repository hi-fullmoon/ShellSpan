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

use shell_span_lib::terminal_broker::TerminalBrokerBenchmarkObserver;

const DEFAULT_BYTES: usize = 2 * 1024 * 1024;
const DEFAULT_REPETITIONS: usize = 5;
const DEFAULT_SESSIONS: usize = 4;
const EMIT_CHUNK_BYTES: usize = 8 * 1024;
const EMIT_LINE_PAYLOAD_BYTES: usize = 80;
const EMIT_BEGIN_MARKER: &[u8] = b"SHELLSPAN_BENCH_PAYLOAD_BEGIN:";
const EMIT_END_MARKER: &[u8] = b":SHELLSPAN_BENCH_PAYLOAD_END";
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
    broker: bool,
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
        match (cfg!(debug_assertions), config.broker) {
            (true, true) => "debug-broker-shadow",
            (true, false) => "debug-baseline",
            (false, true) => "release-broker-shadow",
            (false, false) => "release-baseline",
        },
    );
    println!("scenario\tmedian_ms\tp95_ms\tmedian_mib_per_s\trepetitions");

    run_suite("local_pty_single", config, 1, move |bytes| {
        run_local_pty(bytes, config.broker)
    })?;
    if config.sessions > 1 {
        run_suite("local_pty_multi", config, config.sessions, move |bytes| {
            run_local_pty(bytes, config.broker)
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
            move |bytes| run_ssh_pty(&ssh_config, bytes, config.broker)
        })?;
        if config.sessions > 1 {
            run_suite("ssh_pty_multi", config, config.sessions, {
                let ssh_config = Arc::clone(&ssh_config);
                move |bytes| run_ssh_pty(&ssh_config, bytes, config.broker)
            })?;
        }
    } else {
        println!(
            "ssh_pty\tSKIPPED (pass --ssh with SHELLSPAN_E2E_SSH_* set for the isolated SSH fixture)"
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
        broker: false,
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
            "--broker" => {
                config.broker = true;
                index += 1;
            }
            "--help" | "-h" => {
                println!(
                    "Usage: terminal_transport_baseline [--bytes N] [--repetitions N] [--sessions N] [--ssh] [--broker]"
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
    let mut stdout = std::io::stdout().lock();
    stdout.write_all(EMIT_BEGIN_MARKER)?;
    let mut remaining = bytes;
    while remaining > 0 {
        let payload_bytes = remaining.min(EMIT_CHUNK_BYTES);
        let mut chunk =
            Vec::with_capacity(payload_bytes + 2 * payload_bytes.div_ceil(EMIT_LINE_PAYLOAD_BYTES));
        let mut chunk_remaining = payload_bytes;
        while chunk_remaining > 0 {
            let line_bytes = chunk_remaining.min(EMIT_LINE_PAYLOAD_BYTES);
            chunk.extend(std::iter::repeat_n(b'x', line_bytes));
            chunk.extend_from_slice(b"\r\n");
            chunk_remaining -= line_bytes;
        }
        stdout.write_all(&chunk)?;
        remaining -= payload_bytes;
    }
    stdout.write_all(EMIT_END_MARKER)?;
    stdout.flush()?;
    Ok(())
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn strip_terminal_controls(input: &[u8]) -> Vec<u8> {
    #[derive(Clone, Copy)]
    enum State {
        Ground,
        Escape,
        Csi,
        Osc,
        OscEscape,
        String,
        StringEscape,
    }

    let mut state = State::Ground;
    let mut output = Vec::with_capacity(input.len());
    for byte in input.iter().copied() {
        state = match state {
            State::Ground if byte == 0x1b => State::Escape,
            State::Ground if byte < 0x20 || byte == 0x7f => State::Ground,
            State::Ground => {
                output.push(byte);
                State::Ground
            }
            State::Escape if byte == b'[' => State::Csi,
            State::Escape if byte == b']' => State::Osc,
            State::Escape if matches!(byte, b'P' | b'X' | b'^' | b'_') => State::String,
            State::Escape if (0x20..=0x2f).contains(&byte) => State::Escape,
            State::Escape => State::Ground,
            State::Csi if (0x40..=0x7e).contains(&byte) => State::Ground,
            State::Csi => State::Csi,
            State::Osc if byte == 0x07 => State::Ground,
            State::Osc if byte == 0x1b => State::OscEscape,
            State::Osc => State::Osc,
            State::OscEscape if byte == b'\\' => State::Ground,
            State::OscEscape if byte == 0x1b => State::OscEscape,
            State::OscEscape => State::Osc,
            State::String if byte == 0x1b => State::StringEscape,
            State::String => State::String,
            State::StringEscape if byte == b'\\' => State::Ground,
            State::StringEscape if byte == 0x1b => State::StringEscape,
            State::StringEscape => State::String,
        };
    }
    output
}

fn validate_emitted_payload(output: &[u8], expected_bytes: usize) -> Result<usize, String> {
    // Windows ConPTY legitimately injects cursor and OSC title sequences while
    // physically wrapping long output. Validate the exact printable payload
    // after removing only terminal controls; Broker byte equality is measured
    // independently on the unmodified transport stream.
    let printable = strip_terminal_controls(output);
    let begin = find_subslice(&printable, EMIT_BEGIN_MARKER)
        .ok_or_else(|| "PTY benchmark output omitted the payload begin marker".to_string())?;
    let payload_start = begin + EMIT_BEGIN_MARKER.len();
    let relative_end = find_subslice(&printable[payload_start..], EMIT_END_MARKER)
        .ok_or_else(|| "PTY benchmark output omitted the payload end marker".to_string())?;
    let payload = &printable[payload_start..payload_start + relative_end];
    if payload.len() != expected_bytes {
        return Err(format!(
            "PTY benchmark payload contained {} printable bytes, expected exactly {expected_bytes}",
            payload.len(),
        ));
    }
    if payload.iter().any(|byte| *byte != b'x') {
        return Err("PTY benchmark payload bytes were corrupted or interleaved".into());
    }
    Ok(payload.len())
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

fn run_local_pty(bytes: usize, broker_enabled: bool) -> Result<usize, String> {
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
    let mut output = Vec::with_capacity(bytes + EMIT_BEGIN_MARKER.len() + EMIT_END_MARKER.len());
    let broker = broker_enabled
        .then(TerminalBrokerBenchmarkObserver::local)
        .transpose()?;
    let reader_thread = thread::spawn(move || -> Result<Vec<u8>, String> {
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    if let Some(broker) = broker.as_ref() {
                        broker.observe(&buffer[..count])?;
                    }
                    output.extend_from_slice(&buffer[..count]);
                    received += count;
                }
                Err(_) if received >= bytes => break,
                Err(error) => {
                    return Err(format!("read PTY output after {received} bytes: {error}"))
                }
            }
        }
        Ok(output)
    });
    // Read concurrently so a full ConPTY output buffer cannot block the child.
    // On Windows the reader may not observe closure until the child has been
    // reaped and the master is released, so never wait for EOF first.
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        match child
            .try_wait()
            .map_err(|error| format!("wait for PTY output helper: {error}"))?
        {
            Some(_) => break,
            None if Instant::now() < deadline => thread::sleep(Duration::from_millis(1)),
            None => {
                child
                    .kill()
                    .map_err(|error| format!("kill timed-out PTY output helper: {error}"))?;
                return Err("PTY output helper exceeded the 30-second deadline".into());
            }
        }
    }
    drop(pair.master);
    let output = reader_thread
        .join()
        .map_err(|_| "PTY output reader panicked".to_string())??;
    validate_emitted_payload(&output, bytes)
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
            host: env::var("SHELLSPAN_E2E_SSH_HOST")?,
            port: env::var("SHELLSPAN_E2E_SSH_PORT")?.parse()?,
            username: env::var("SHELLSPAN_E2E_SSH_USERNAME")?,
            password: env::var("SHELLSPAN_E2E_SSH_PASSWORD")?,
        })
    }
}

fn run_ssh_pty(config: &SshConfig, bytes: usize, broker_enabled: bool) -> Result<usize, String> {
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
    let broker = broker_enabled
        .then(TerminalBrokerBenchmarkObserver::ssh)
        .transpose()?;
    loop {
        match channel.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => {
                if let Some(broker) = broker.as_ref() {
                    broker.observe(&buffer[..count])?;
                }
                received += count;
            }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn framed_payload(payload: &[u8]) -> Vec<u8> {
        [
            b"\x1b[?25l".as_slice(),
            EMIT_BEGIN_MARKER,
            payload,
            EMIT_END_MARKER,
            b"\x1b[?25h".as_slice(),
        ]
        .concat()
    }

    #[test]
    fn payload_validation_ignores_surrounding_conpty_controls_but_requires_exact_bytes() {
        assert_eq!(validate_emitted_payload(&framed_payload(b"xxxx"), 4), Ok(4));

        let wrapped = [
            EMIT_BEGIN_MARKER,
            b"xx\x1b]0;C:\\path-with-x\x07\x1b[2Cxx",
            EMIT_END_MARKER,
        ]
        .concat();
        assert_eq!(validate_emitted_payload(&wrapped, 4), Ok(4));

        let truncated = [EMIT_BEGIN_MARKER, b"xxx", EMIT_END_MARKER].concat();
        assert!(validate_emitted_payload(&truncated, 4)
            .unwrap_err()
            .contains("expected exactly 4"));

        let corrupt = framed_payload(b"xxYx");
        assert!(validate_emitted_payload(&corrupt, 4)
            .unwrap_err()
            .contains("corrupted or interleaved"));

        let missing_end = [EMIT_BEGIN_MARKER, b"xxxx"].concat();
        assert!(validate_emitted_payload(&missing_end, 4)
            .unwrap_err()
            .contains("end marker"));
    }
}
