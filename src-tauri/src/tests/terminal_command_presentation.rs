use super::*;
use portable_pty::{native_pty_system, PtySize};
use std::sync::{mpsc, Mutex};

fn capture_command_presentation(shell_path: &str, shell: TerminalShellKind, columns: u16) {
    let home = tempfile::tempdir().unwrap();
    let integration = PreparedLocalShellIntegration::prepare(shell, home.path()).unwrap();
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 24,
            cols: columns,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();
    let mut reader = pair.master.try_clone_reader().unwrap();
    let mut writer = pair.master.take_writer().unwrap();
    let mut command = CommandBuilder::new(shell_path);
    command.env("HOME", home.path());
    command.env("TERM", "xterm-256color");
    command.cwd(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap());
    integration.configure_command(&mut command).unwrap();
    writeln!(
        File::options()
            .append(true)
            .open(&integration.bootstrap_path)
            .unwrap(),
        "\nPS1='presentation> '"
    )
    .unwrap();
    let (events_tx, events_rx) = mpsc::channel();
    let mut control = integration.start_reader(
        move |event| {
            let _ = events_tx.send(event);
            Ok(())
        },
        |_| {},
    );
    let output = Arc::new(Mutex::new(Vec::new()));
    let captured = Arc::clone(&output);
    let output_thread = thread::spawn(move || {
        let mut bytes = [0; 4096];
        while let Ok(count) = reader.read(&mut bytes) {
            if count == 0 {
                break;
            }
            captured.lock().unwrap().extend_from_slice(&bytes[..count]);
        }
    });
    let mut child = pair.slave.spawn_command(command).unwrap();
    drop(pair.slave);
    let wait_prompt = |expected_boundaries: usize| {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let event = events_rx
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .unwrap();
            if matches!(event, TerminalIntegrationControlEvent::PromptEnd) {
                break;
            }
        }
        loop {
            let bytes = output.lock().unwrap().clone();
            let mut parser = vt100::Parser::new(24, columns, 0);
            parser.process(&bytes);
            let boundaries = bytes
                .windows(b"\x1b]133;C\x07".len())
                .filter(|part| *part == b"\x1b]133;C\x07")
                .count();
            if boundaries >= expected_boundaries
                && parser
                    .screen()
                    .contents()
                    .trim_end()
                    .ends_with("presentation>")
            {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "PTY prompt was not rendered: {}",
                parser.screen().contents()
            );
            thread::sleep(Duration::from_millis(5));
        }
    };
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        wait_prompt(0);
        let startup = output.lock().unwrap().clone();
        let mut executions = Vec::new();
        for (index, source) in [
            "git ls-files src/components/terminal/registry; git log -1 --format=%s",
            "git diff --numstat -- src/components/terminal/registry",
        ]
        .into_iter()
        .enumerate()
        {
            let start = output.lock().unwrap().len();
            writer.write_all(source.as_bytes()).unwrap();
            writer.write_all(b"\r").unwrap();
            writer.flush().unwrap();
            wait_prompt(index + 1);
            let bytes = output.lock().unwrap()[start..].to_vec();
            let boundary = b"\x1b]133;C\x07";
            assert_eq!(
                bytes
                    .windows(boundary.len())
                    .filter(|part| *part == boundary)
                    .count(),
                1,
                "one display boundary per real shell command"
            );
            let boundary_at = bytes
                .windows(boundary.len())
                .position(|part| part == boundary)
                .unwrap();
            let display = String::from_utf8_lossy(&bytes);
            assert!(
                boundary_at > 0,
                "command echo must precede output boundary: {display}"
            );
            assert!(bytes[boundary_at + boundary.len()..].len() > b"presentation> ".len());
            executions.push(serde_json::json!({ "command": source, "trace": display }));
        }
        if let Ok(directory) = std::env::var("SHELLSPAN_COMMAND_PRESENTATION_DIR") {
            fs::create_dir_all(&directory).unwrap();
            fs::write(
                Path::new(&directory).join(format!("{}-{columns}.json", shell.protocol_name())),
                serde_json::to_vec(&serde_json::json!({
                    "startup": String::from_utf8_lossy(&startup),
                    "executions": executions,
                    "columns": columns,
                    "rows": 24,
                }))
                .unwrap(),
            )
            .unwrap();
        }
    }));
    let _ = child.kill();
    let _ = child.wait();
    drop(writer);
    drop(pair.master);
    output_thread.join().unwrap();
    control.stop();
    if let Err(error) = result {
        std::panic::resume_unwind(error);
    }
}

#[test]
fn bash_command_presentation_boundary_precedes_real_output() {
    for columns in [40, 100] {
        capture_command_presentation("/bin/bash", TerminalShellKind::Bash, columns);
    }
}

#[cfg(target_os = "macos")]
#[test]
fn zsh_command_presentation_boundary_precedes_real_output() {
    for columns in [40, 100] {
        capture_command_presentation("/bin/zsh", TerminalShellKind::Zsh, columns);
    }
}
