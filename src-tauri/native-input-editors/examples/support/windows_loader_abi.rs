//! Actual ConsoleHost/provider ABI admission; no source or accept key is sent.
use super::*;

pub(super) struct Fixture<'a> {
    pub pipe_name: &'a str,
    pub writer: &'a Arc<Mutex<Box<dyn Write + Send>>>,
    pub messages: &'a Arc<Mutex<Vec<nip::Message>>>,
    pub control_raw: &'a Arc<Mutex<Vec<u8>>>,
    pub evidence: &'a std::path::Path,
    pub shell: &'a std::path::Path,
    pub library: &'a std::path::Path,
    pub child_pid: u32,
    pub root: &'a std::path::Path,
}

impl Fixture<'_> {
    pub(super) fn verify(self) {
        let Self {
            pipe_name,
            writer,
            messages,
            control_raw,
            evidence,
            shell,
            library,
            child_pid,
            root,
        } = self;
        let expected_refusal =
            match std::env::var("SHELLSPAN_ACCEPTANCE_EXPECT_ABI_REFUSAL").as_deref() {
                Ok("1") => true,
                Ok("0") => false,
                _ => panic!("Explicit loader expectation required"),
            };
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut control = None;
        let mut decoder = nip::Decoder::default();
        let mut probe_sent = false;
        let mut probe_attempted = false;
        let mut control_read_error = false;
        let mut native_granted = false;
        let mut explicit_refusal = false;
        let mut refusal_at = None;
        while Instant::now() < deadline {
            let startup_error = fs::read(evidence.join("loader-startup-error.json"))
                .ok()
                .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
            explicit_refusal = startup_error
                .as_ref()
                .and_then(|value| value["code"].as_str())
                .is_some_and(|code| {
                    code.starts_with("TERMINAL_NATIVE_REQUIRED_SYMBOL_UNAVAILABLE")
                });
            if explicit_refusal && refusal_at.is_none() {
                refusal_at = Some(Instant::now());
            }
            if control.is_none() {
                control = fs::OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(format!(r"\\.\pipe\{pipe_name}"))
                    .ok();
            }
            if let Some(channel) = &mut control {
                if !probe_attempted {
                    probe_attempted = true;
                    let probe = nip::ConnectionEnvelope {
                        protocol: nip::PROTOCOL.into(),
                        request_id: "loader-read-only-probe".into(),
                        connection: nip::ConnectionIdentity {
                            terminal_session_id: "loader-test-terminal".into(),
                            terminal_generation: 1,
                            control_id: "loader-test-control".into(),
                        },
                        payload: nip::ConnectionPayload::Probe,
                    };
                    if channel.write_all(&probe.encode().unwrap()).is_ok() {
                        write(writer, b"\x18\x02");
                        probe_sent = true;
                    }
                }
                if available(channel).is_some_and(|count| count > 0) {
                    let mut bytes = [0; 8192];
                    let count = match channel.read(&mut bytes) {
                        Ok(count) => count,
                        Err(_) => {
                            control_read_error = true;
                            0
                        }
                    };
                    control_raw
                        .lock()
                        .unwrap()
                        .extend_from_slice(&bytes[..count]);
                    for message in decoder.push(&bytes[..count]).unwrap() {
                        assert!(
                            matches!(&message, nip::Message::Connection(_)),
                            "Readonly loader emitted an operation receipt"
                        );
                        if matches!(&message,nip::Message::Connection(v)if matches!(v.payload,nip::ConnectionPayload::Capabilities{native_inline:true,..}))
                        {
                            native_granted = true;
                        }
                        messages.lock().unwrap().push(message);
                    }
                }
            }
            if native_granted {
                break;
            }
            if refusal_at.is_some_and(|at| at.elapsed() >= Duration::from_millis(500)) {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        fs::write(evidence.join("loader-observation.json"),serde_json::to_vec_pretty(&serde_json::json!({
        "expectedRefusal":expected_refusal,"nativeCapabilityGranted":native_granted,"explicitSymbolRefusal":explicit_refusal,
        "probeRequestsSent":usize::from(probe_sent),"operationRequestsSent":0,"sourceBytesSent":0,"acceptKeysSent":0,
        "qualification":"Observation before image inspection;not a complete case pass."
    })).unwrap()).unwrap();
        let mut inspector = std::process::Command::new(
            std::path::Path::new(&std::env::var_os("SystemRoot").unwrap())
                .join("System32/WindowsPowerShell/v1.0/powershell.exe"),
        );
        inspector
            .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-File"])
            .arg(root.join("../../scripts/native-input-p3/windows-loader-image.ps1"))
            .args([
                "-ConsoleProcessId",
                &child_pid.to_string(),
                "-OwnerProcessId",
                &std::process::id().to_string(),
                "-ShellPath",
            ])
            .arg(shell)
            .arg("-LibraryPath")
            .arg(library);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            inspector.creation_flags(0x08000000);
        }
        let inspected = inspector.output().unwrap();
        fs::write(evidence.join("loaded-image.json"), &inspected.stdout).unwrap();
        fs::write(evidence.join("loaded-image-error.log"), &inspected.stderr).unwrap();
        assert!(
            inspected.status.success(),
            "Owned host image inspection failed"
        );
        let image: serde_json::Value = serde_json::from_slice(&inspected.stdout).unwrap();
        if native_granted {
            assert_eq!(image["moduleCount"], 1);
            assert_eq!(
                image["sha256"],
                std::env::var("SHELLSPAN_ACCEPTANCE_NATIVE_SHA256").unwrap()
            );
        }
        let passed = if expected_refusal {
            explicit_refusal && !native_granted && !control_read_error
        } else {
            native_granted && !explicit_refusal && !control_read_error
        };
        fs::write(evidence.join("loader-result.json"),serde_json::to_vec_pretty(&serde_json::json!({
        "passed":passed,"expectedRefusal":expected_refusal,"nativeCapabilityGranted":native_granted,"explicitSymbolRefusal":explicit_refusal,
            "probeRequestsSent":usize::from(probe_sent),"probeWriteAttempts":usize::from(probe_attempted),"controlReadError":control_read_error,"operationRequestsSent":0,"sourceBytesSent":0,"acceptKeysSent":0,
        "observationDeadlineMs":20000,"qualification":"Actual ConsoleHost/PSReadLine loader and native capability only;no Agent/App/model/source execution proof. Release candidate path/hash explicit;not the example default debug DLL."
    })).unwrap()).unwrap();
        assert!(
            passed,
            "Native ABI admission differed;original receipt and image evidence retained"
        );
    }
}
