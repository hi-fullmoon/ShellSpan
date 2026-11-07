//! Acceptance bridge for the real SDK3 display pipe, using the app's I/O codec.
//! Files carry numeric requests/replies to a live xterm observer, never editor input.
#[cfg(windows)]
#[path = "../../../src/terminal_display_origin_transport.rs"]
mod transport;

#[cfg(windows)]
mod implementation {
    use super::transport;
    use serde::{Deserialize, Serialize};
    use std::fs::{self, OpenOptions};
    use std::io::Write;
    use std::os::windows::io::AsRawHandle;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::thread;
    use std::time::{Duration, Instant};

    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Request {
        request_index: u32,
        columns: u16,
        rows: u16,
        cursor_x: u16,
        cursor_y: u16,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Reply {
        request: Request,
        cell_widths: Vec<u8>,
        wrap_pending: bool,
    }

    pub struct Worker {
        stop: Arc<AtomicBool>,
        thread: Option<thread::JoinHandle<()>>,
    }
    impl Drop for Worker {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Release);
            if let Some(thread) = self.thread.take() {
                thread.join().expect("Display observation bridge panicked");
            }
        }
    }

    pub fn start(pipe_name: &str, host_pid: u32, evidence: PathBuf) -> Worker {
        let path = format!(r"\\.\pipe\{pipe_name}-display-origin");
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let thread = thread::spawn(move || {
            let mut requests = 0;
            let mut answered = Vec::new();
            let mut pending_request = None;
            let result = (|| -> Result<(), String> {
                let mut file = transport::connect(&path, host_pid, &stopping)?;
                let mut previous = 0;
                loop {
                    // An idle prompt is not a request deadline.
                    loop {
                        if stopping.load(Ordering::Acquire) {
                            return Ok(());
                        }
                        let mut available = 0;
                        if unsafe {
                            windows_sys::Win32::System::Pipes::PeekNamedPipe(
                                file.as_raw_handle(),
                                std::ptr::null_mut(),
                                0,
                                std::ptr::null_mut(),
                                &mut available,
                                std::ptr::null_mut(),
                            )
                        } == 0
                        {
                            return Err("TERMINAL_DISPLAY_ORIGIN_CLOSED".into());
                        }
                        if available > 0 {
                            break;
                        }
                        thread::sleep(Duration::from_millis(5));
                    }
                    let deadline = Instant::now() + Duration::from_secs(10);
                    let mut header = [0; 20];
                    transport::read_exact(&mut file, &mut header, &stopping, deadline)?;
                    let (index, [columns, rows, cursor_x, cursor_y]) =
                        transport::decode_request(&header)?;
                    if index <= previous {
                        return Err("DISPLAY_BRIDGE_REQUEST_ORDER".into());
                    }
                    previous = index;
                    pending_request = Some(index);
                    let request = Request {
                        request_index: index,
                        columns,
                        rows,
                        cursor_x,
                        cursor_y,
                    };
                    let target = evidence.join(format!("display-request-{index}.json"));
                    let mut output = OpenOptions::new()
                        .create_new(true)
                        .write(true)
                        .open(target)
                        .map_err(|_| "DISPLAY_BRIDGE_REQUEST_WRITE")?;
                    output
                        .write_all(
                            &serde_json::to_vec(&request)
                                .map_err(|_| "DISPLAY_BRIDGE_REQUEST_ENCODE")?,
                        )
                        .map_err(|_| "DISPLAY_BRIDGE_REQUEST_WRITE")?;
                    drop(output);
                    let reply_path = evidence.join(format!("display-reply-{index}.json"));
                    while !reply_path.exists() {
                        if stopping.load(Ordering::Acquire) {
                            return Err("DISPLAY_BRIDGE_CANCELLED".into());
                        }
                        if Instant::now() >= deadline {
                            return Err("DISPLAY_BRIDGE_REPLY_DEADLINE".into());
                        }
                        thread::sleep(Duration::from_millis(5));
                    }
                    if fs::metadata(&reply_path)
                        .map_err(|_| "DISPLAY_BRIDGE_REPLY_READ")?
                        .len()
                        > 262144
                    {
                        return Err("DISPLAY_BRIDGE_REPLY_BOUND".into());
                    }
                    let reply: Reply = serde_json::from_slice(
                        &fs::read(reply_path).map_err(|_| "DISPLAY_BRIDGE_REPLY_READ")?,
                    )
                    .map_err(|_| "DISPLAY_BRIDGE_REPLY_DECODE")?;
                    if reply.request != request
                        || reply.cell_widths.len() > 65536
                        || reply
                            .cell_widths
                            .iter()
                            .any(|width| !matches!(width, 1 | 2))
                    {
                        return Err("DISPLAY_BRIDGE_REPLY_IDENTITY".into());
                    }
                    if stopping.load(Ordering::Acquire) {
                        return Err("DISPLAY_BRIDGE_CANCELLED".into());
                    }
                    if Instant::now() >= deadline {
                        return Err("DISPLAY_BRIDGE_REPLY_DEADLINE".into());
                    }
                    file.write_all(&transport::response(
                        index,
                        Some((reply.cell_widths, reply.wrap_pending)),
                    ))
                    .map_err(|_| "TERMINAL_DISPLAY_ORIGIN_CLOSED")?;
                    requests += 1;
                    answered.push(index);
                    pending_request = None;
                }
            })();
            fs::write(evidence.join("display-origin-bridge.json"), serde_json::to_vec_pretty(&serde_json::json!({
                "authenticatedServerPid":host_pid,"clientPid":std::process::id(),"requestsAnswered":requests,
                "answeredRequestIndexes":answered,"pendingRequestIndex":pending_request,
                "stopped":stopping.load(Ordering::Acquire),"end":result.err(),
                "source":"Shared app numeric transport and actual xterm observer;not an App/NIP execution receipt"
            })).unwrap()).expect("Display observation summary unavailable");
        });
        Worker {
            stop,
            thread: Some(thread),
        }
    }
}

#[cfg(windows)]
pub use implementation::start;

#[cfg(not(windows))]
pub fn start(_: &str, _: u32, _: std::path::PathBuf) {
    panic!("Windows display observation requires the actual host")
}
