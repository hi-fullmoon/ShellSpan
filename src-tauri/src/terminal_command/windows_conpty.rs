//! Exact private ConPTY for the verified Windows native-input profile.
//! Embedded inputs keep dev/release identical without a resource-path lookup.
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
};

const FILES: &[(&str, &[u8])] = &[
    (
        "conpty.dll",
        include_bytes!("../../resources/conpty/1.25.260930003/conpty.dll"),
    ),
    (
        "x64/OpenConsole.exe",
        include_bytes!("../../resources/conpty/1.25.260930003/x64/OpenConsole.exe"),
    ),
    (
        "LICENSE",
        include_bytes!("../../resources/conpty/1.25.260930003/LICENSE"),
    ),
    (
        "pin.json",
        include_bytes!("../../resources/conpty/1.25.260930003/pin.json"),
    ),
];

pub(crate) fn prepare(data: &Path) -> Result<PathBuf, String> {
    let mut digest = Sha256::new();
    for (name, bytes) in FILES {
        digest.update(name);
        digest.update([0]);
        digest.update(bytes);
    }
    let parent = data.join("conpty");
    fs::create_dir_all(&parent).map_err(|_| "TERMINAL_NATIVE_CONPTY_UNAVAILABLE")?;
    let root = parent.join(hex::encode(digest.finalize()));
    if !root.exists() {
        let staging = tempfile::Builder::new()
            .prefix(".conpty-")
            .tempdir_in(&parent)
            .map_err(|_| "TERMINAL_NATIVE_CONPTY_UNAVAILABLE")?;
        for (name, bytes) in FILES {
            let path = staging.path().join(name);
            fs::create_dir_all(path.parent().ok_or("TERMINAL_NATIVE_PATH_INVALID")?)
                .and_then(|()| fs::write(path, bytes))
                .map_err(|_| "TERMINAL_NATIVE_CONPTY_UNAVAILABLE")?;
        }
        if fs::rename(staging.path(), &root).is_err() && !root.exists() {
            return Err("TERMINAL_NATIVE_CONPTY_UNAVAILABLE".into());
        }
    }
    // A stale/tampered cache must fail closed, never silently use system ConPTY.
    for (name, bytes) in FILES {
        let actual = fs::read(root.join(name)).map_err(|_| "TERMINAL_NATIVE_CONPTY_UNAVAILABLE")?;
        if actual != *bytes {
            return Err("TERMINAL_NATIVE_CONPTY_MISMATCH".into());
        }
    }
    fs::canonicalize(root.join("conpty.dll"))
        .map_err(|_| "TERMINAL_NATIVE_CONPTY_UNAVAILABLE".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exercise_suspended_startup(resume: bool) {
        use portable_pty::{CommandBuilder, PtySize, PtySystem};
        use std::{
            io::Read,
            thread,
            time::{Duration, Instant},
        };
        let data = tempfile::tempdir().unwrap();
        let library = prepare(data.path()).unwrap();
        let pair = portable_pty::win::conpty::ConPtySystem::with_grapheme_host(library)
            .openpty(PtySize {
                rows: 30,
                cols: 100,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let effect = data.path().join("effect.txt");
        let source = format!(
            "[IO.File]::AppendAllText('{}','once')",
            crate::path_utils::portable_local_path(&effect).replace('\'', "''")
        );
        let shell = PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let mut command = CommandBuilder::new(shell);
        command.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &source,
        ]);
        command.set_start_suspended(true);
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let output = thread::spawn(move || {
            let mut bytes = [0; 4096];
            while reader.read(&mut bytes).is_ok_and(|n| n > 0) {}
        });
        let mut controller = child.clone_killer();
        let observed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            thread::sleep(Duration::from_millis(100));
            assert!(
                child.try_wait().unwrap().is_none(),
                "Suspended startup exited before readiness"
            );
            assert!(
                !effect.exists(),
                "Startup script ran before viewport readiness"
            );
            if resume {
                pair.master
                    .resize(PtySize {
                        rows: 37,
                        cols: 199,
                        pixel_width: 0,
                        pixel_height: 0,
                    })
                    .unwrap();
                controller.resume_startup().unwrap();
                controller.resume_startup().unwrap();
            } else {
                controller.kill().unwrap();
            }
            let end = Instant::now() + Duration::from_secs(10);
            let status = loop {
                if let Some(status) = child.try_wait().unwrap() {
                    break status;
                }
                assert!(
                    Instant::now() < end,
                    "Owned startup did not terminate; pid={:?}",
                    child.process_id()
                );
                thread::sleep(Duration::from_millis(10));
            };
            if resume {
                assert!(status.success());
                assert_eq!(fs::read_to_string(&effect).unwrap(), "once");
            } else {
                assert!(!status.success());
                assert!(!effect.exists(), "Cancelled startup executed its script");
            }
        }));
        if child.try_wait().unwrap().is_none() {
            let _ = controller.kill();
            let _ = child.wait();
        }
        drop(pair.master);
        output.join().unwrap();
        if let Err(failure) = observed {
            std::panic::resume_unwind(failure);
        }
    }

    #[test]
    fn viewport_ready_resumes_the_actual_windows_startup_once() {
        exercise_suspended_startup(true);
    }

    #[test]
    fn closing_before_viewport_ready_never_runs_the_startup_script() {
        exercise_suspended_startup(false);
    }
    #[test]
    fn pinned_runtime_is_reused_and_tampering_is_rejected() {
        let data = tempfile::tempdir().unwrap();
        let library = prepare(data.path()).unwrap();
        assert!(library.is_absolute());
        assert_eq!(prepare(data.path()).unwrap(), library);
        let host = library.parent().unwrap().join("x64/OpenConsole.exe");
        fs::write(&host, b"invalid host").unwrap();
        assert_eq!(
            prepare(data.path()).unwrap_err(),
            "TERMINAL_NATIVE_CONPTY_MISMATCH"
        );
        assert_eq!(fs::read(host).unwrap(), b"invalid host");
    }
    #[test]
    fn embedded_binaries_match_reviewed_pin() {
        let pin: serde_json::Value = serde_json::from_slice(FILES[3].1).unwrap();
        for (name, bytes) in &FILES[..2] {
            assert_eq!(
                hex::encode(Sha256::digest(bytes)),
                pin["files"][name].as_str().unwrap()
            );
        }
    }
    #[test]
    fn missing_private_host_never_falls_back_to_system_console() {
        use portable_pty::PtySystem;
        let data = tempfile::tempdir().unwrap();
        let system = portable_pty::win::conpty::ConPtySystem::with_grapheme_host(
            data.path().join("missing.dll"),
        );
        assert!(system
            .openpty(portable_pty::PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0
            })
            .is_err());
    }
}
