//! Independent authenticated display pipe; never dispatches NIP operations.
use super::{DisplayOriginGeometry, DisplayOriginRegistry, DisplayOriginRequest};
use std::fs::File;
use std::os::windows::io::AsRawHandle;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};
use windows_sys::Win32::System::Pipes::PeekNamedPipe;
#[path = "terminal_display_origin_transport.rs"]
mod transport;
use transport::{connect, read_exact, response, write_all_nonblocking};

pub(crate) struct DisplayOriginPipe {
    stopped: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}
impl Drop for DisplayOriginPipe {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

pub(crate) fn decode_request(bytes: &[u8; 20]) -> Result<(u32, DisplayOriginGeometry), String> {
    let (index, [columns, rows, cursor_x, cursor_y]) = transport::decode_request(bytes)?;
    Ok((
        index,
        DisplayOriginGeometry {
            columns,
            rows,
            cursor_x,
            cursor_y,
        },
    ))
}

pub(crate) fn start(
    app: tauri::AppHandle,
    session_id: String,
    terminal_session_id: String,
    generation: u64,
    pipe_path: String,
    expected_host_pid: u32,
) -> DisplayOriginPipe {
    let stopped = Arc::new(AtomicBool::new(false));
    let stop = stopped.clone();
    let worker = thread::spawn(move || {
        let registry = app.state::<DisplayOriginRegistry>();
        let Ok(file) = connect(&pipe_path, expected_host_pid, &stop) else {
            return;
        };
        let _ = serve(
            file,
            &stop,
            &registry,
            &session_id,
            &terminal_session_id,
            generation,
            |request| {
                app.emit("terminal-prompt-origin-request", request)
                    .map_err(|_| "TERMINAL_DISPLAY_ORIGIN_UNAVAILABLE".into())
            },
        );
    });
    DisplayOriginPipe {
        stopped,
        worker: Some(worker),
    }
}

fn serve(
    mut file: File,
    stop: &AtomicBool,
    registry: &DisplayOriginRegistry,
    session_id: &str,
    terminal_session_id: &str,
    generation: u64,
    emit: impl Fn(&DisplayOriginRequest) -> Result<(), String>,
) -> Result<(), String> {
    let Ok(binding) = registry.bind(session_id, terminal_session_id, generation) else {
        return Err("TERMINAL_DISPLAY_ORIGIN_UNAVAILABLE".into());
    };
    let _result = (|| -> Result<(), String> {
        loop {
            loop {
                if stop.load(Ordering::Acquire) {
                    return Ok(());
                }
                let mut available = 0;
                if unsafe {
                    PeekNamedPipe(
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
            let mut header = [0; 20];
            read_exact(
                &mut file,
                &mut header,
                stop,
                Instant::now() + Duration::from_secs(10),
            )?;
            let (index, geometry) = decode_request(&header)?;
            let (request, receiver) =
                registry.request(&binding, index, geometry, Duration::from_secs(10))?;
            if emit(&request).is_err() {
                registry.cancel(&binding, &request.request_id);
                return Err("TERMINAL_DISPLAY_ORIGIN_UNAVAILABLE".into());
            }
            let end = Instant::now() + Duration::from_secs(10);
            let widths = loop {
                if stop.load(Ordering::Acquire) || Instant::now() >= end {
                    break None;
                }
                match receiver.recv_timeout(Duration::from_millis(20)) {
                    Ok(widths) => break Some(widths),
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break None,
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                }
            };
            registry.cancel(&binding, &request.request_id);
            if stop.load(Ordering::Acquire) {
                return Ok(());
            }
            write_all_nonblocking(
                &mut file,
                &response(index, widths),
                &stop,
                Instant::now() + Duration::from_secs(2),
            )?;
        }
    })();
    registry.unbind(&binding);
    _result
}

#[cfg(test)]
mod tests {
    use super::super::DisplayOriginResponse;
    use super::*;
    #[test]
    fn only_exact_display_headers_and_bounded_geometry_are_accepted() {
        let mut bytes = [0; 20];
        bytes[..8].copy_from_slice(b"SSDO\x02\0\0\0");
        bytes[8..12].copy_from_slice(&1u32.to_le_bytes());
        for (at, value) in [(12, 47u16), (14, 33), (16, 14), (18, 3)] {
            bytes[at..at + 2].copy_from_slice(&value.to_le_bytes());
        }
        assert!(decode_request(&bytes).is_ok());
        for at in [0, 4, 5, 6, 7] {
            let mut invalid = bytes;
            invalid[at] = 255;
            assert!(decode_request(&invalid).is_err());
        }
        let mut invalid = bytes;
        invalid[16..18].copy_from_slice(&47u16.to_le_bytes());
        assert!(decode_request(&invalid).is_err());
    }
    #[test]
    fn reply_is_numeric_and_bounded_by_registry_not_a_control_frame() {
        assert_eq!(
            response(7, Some((vec![1, 2], false))),
            b"SSDO\x02\x01\0\0\x07\0\0\0\x02\0\0\0\x01\x02"
        );
        assert_eq!(response(7, None).len(), 16);
        assert_eq!(response(7, Some((vec![1, 2], true)))[6], 1);
    }

    #[test]
    #[ignore = "requires scheduled Windows P7/P5 hosts and a fresh owned evidence directory"]
    fn actual_private_pipe_authentication_reply_and_cancellation() {
        assert_eq!(
            std::env::var("SHELLSPAN_ALLOW_FOREGROUND_TESTS").as_deref(),
            Ok("1")
        );
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf();
        let evidence = std::path::PathBuf::from(
            std::env::var_os("SHELLSPAN_DISPLAY_PIPE_TEST_EVIDENCE")
                .expect("Fresh evidence directory required"),
        );
        assert!(evidence.is_absolute() && evidence.starts_with(root.join("artifacts/tests")));
        std::fs::create_dir(&evidence).expect("Evidence directory must be fresh");
        let quote = |path: &std::path::Path| path.to_string_lossy().replace('\'', "''");
        for (host, executable) in [
            ("7", "D:/Programs/PowerShell/7/pwsh.exe"),
            (
                "51",
                "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
            ),
        ] {
            for mode in ["reply", "pending-wrap", "wrong-server", "cancel"] {
                let case = evidence.join(format!("{host}-{mode}"));
                std::fs::create_dir(&case).unwrap();
                let pipe = format!("shellspan-display-rust-test-{}", uuid::Uuid::new_v4());
                let ready = case.join("ready.json");
                let result = case.join("result.json");
                let script = case.join("server.ps1");
                let body = format!(
                    r#"$ErrorActionPreference='Stop'
Add-Type -Path '{}'
if($PSVersionTable.PSEdition -ne 'Desktop'){{Add-Type -AssemblyName System.IO.Pipes.AccessControl}}
$user=[Security.Principal.WindowsIdentity]::GetCurrent().User
$security=[IO.Pipes.PipeSecurity]::new();$security.SetAccessRuleProtection($true,$false);$security.SetOwner($user);$security.AddAccessRule([IO.Pipes.PipeAccessRule]::new($user,[IO.Pipes.PipeAccessRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow))
if($PSVersionTable.PSEdition -eq 'Desktop'){{$pipe=[IO.Pipes.NamedPipeServerStream]::new('{pipe}',[IO.Pipes.PipeDirection]::InOut,1,[IO.Pipes.PipeTransmissionMode]::Byte,[IO.Pipes.PipeOptions]::Asynchronous,131072,131072,$security)}}else{{$pipe=[IO.Pipes.NamedPipeServerStreamAcl]::Create('{pipe}',[IO.Pipes.PipeDirection]::InOut,1,[IO.Pipes.PipeTransmissionMode]::Byte,[IO.Pipes.PipeOptions]::Asynchronous,131072,131072,$security,[IO.HandleInheritability]::None,[IO.Pipes.PipeAccessRights]0)}}
$origin=[ShellSpan.Display.OriginPipe]::new($pipe,[uint32]{})
[IO.File]::WriteAllText('{}',(@{{pid=$PID}}|ConvertTo-Json -Compress))
try{{$value=$origin.Observe(47,33,{cursor_x},3);$record=@{{accepted=$true;widths=$value.Item1;wrapPending=$value.Item2}}}}catch{{$record=@{{accepted=$false;errorType=$_.Exception.GetType().FullName}}}}finally{{$origin.Dispose()}}
[IO.File]::WriteAllText('{}',($record|ConvertTo-Json -Compress))
"#,
                    quote(&root.join("src-tauri/src/terminal_display_origin_pipe.cs")),
                    std::process::id(),
                    quote(&ready),
                    quote(&result),
                    cursor_x = if mode == "pending-wrap" { 46 } else { 14 }
                );
                std::fs::write(&script, format!("\u{feff}{body}")).unwrap();
                let log = File::create(case.join("server.log")).unwrap();
                let mut command = std::process::Command::new(executable);
                use std::os::windows::process::CommandExt;
                let child = command
                    .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-File"])
                    .arg(&script)
                    .creation_flags(0x08000000)
                    .stdout(log.try_clone().unwrap())
                    .stderr(log)
                    .spawn()
                    .unwrap();
                struct OwnedChild(std::process::Child);
                impl Drop for OwnedChild {
                    fn drop(&mut self) {
                        if self.0.try_wait().ok().flatten().is_none() {
                            let _ = self.0.kill();
                            let _ = self.0.wait();
                        }
                    }
                }
                let mut child = OwnedChild(child);
                let pid = child.0.id();
                let deadline = Instant::now() + Duration::from_secs(20);
                while !ready.exists() {
                    assert!(
                        child.0.try_wait().unwrap().is_none() && Instant::now() < deadline,
                        "Owned server failed to start: {}",
                        case.display()
                    );
                    thread::sleep(Duration::from_millis(5));
                }
                let stop = AtomicBool::new(false);
                let registry = DisplayOriginRegistry::default();
                let connection = connect(
                    &format!(r"\\.\pipe\{pipe}"),
                    if mode == "wrong-server" { pid + 1 } else { pid },
                    &stop,
                );
                let mut emitted = 0;
                if mode == "wrong-server" {
                    assert_eq!(
                        connection.unwrap_err(),
                        "TERMINAL_DISPLAY_ORIGIN_PEER_MISMATCH"
                    );
                } else {
                    // A real registry response traverses the same worker loop as AppHandle::emit.
                    let count = std::cell::Cell::new(0);
                    let _ = serve(
                        connection.unwrap(),
                        &stop,
                        &registry,
                        "test-ui",
                        "test-terminal",
                        1,
                        |request| {
                            count.set(count.get() + 1);
                            if mode == "cancel" {
                                stop.store(true, Ordering::Release);
                            } else {
                                registry
                                    .respond(DisplayOriginResponse {
                                        request: request.clone(),
                                        cell_widths: if mode == "pending-wrap" {
                                            vec![1; 47]
                                        } else {
                                            vec![1, 2, 1]
                                        },
                                        wrap_pending: mode == "pending-wrap",
                                    })
                                    .unwrap();
                            }
                            Ok(())
                        },
                    );
                    emitted = count.get();
                    assert_eq!(emitted, 1);
                }
                let end = Instant::now() + Duration::from_secs(15);
                let status = loop {
                    if let Some(status) = child.0.try_wait().unwrap() {
                        break status;
                    }
                    assert!(Instant::now() < end, "Owned server did not exit");
                    thread::sleep(Duration::from_millis(5));
                };
                assert!(status.success(), "Server failed: {}", case.display());
                let observed: serde_json::Value =
                    serde_json::from_slice(&std::fs::read(&result).unwrap()).unwrap();
                assert_eq!(
                    observed["accepted"],
                    mode == "reply" || mode == "pending-wrap"
                );
                if mode == "reply" || mode == "pending-wrap" {
                    assert_eq!(
                        observed["widths"],
                        if mode == "pending-wrap" {
                            serde_json::json!(vec![1; 47])
                        } else {
                            serde_json::json!([1, 2, 1])
                        }
                    );
                    assert_eq!(observed["wrapPending"], mode == "pending-wrap");
                }
                std::fs::write(case.join("rust-observation.json"),serde_json::to_vec_pretty(&serde_json::json!({"serverPid":pid,"clientPid":std::process::id(),"host":executable,"mode":mode,"emitted":emitted,"normalServerExit0":true,"modelCalls":0,"nipOperations":0,"appAcceptance":false})).unwrap()).unwrap();
            }
        }
    }
}
