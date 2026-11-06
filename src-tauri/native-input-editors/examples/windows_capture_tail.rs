//! Real ConsoleHost preflight for the bounded tail-output test program.
//! Ordinary user input only: no Agent, approval, NIP receipt or recovery claim.
#[cfg(windows)]
mod actual {
    use portable_pty::{CommandBuilder, PtySize, PtySystem};
    use std::{
        fs,
        io::{Read, Write},
        path::PathBuf,
        sync::{Arc, Mutex},
        thread,
        time::{Duration, Instant},
    };

    pub fn run() {
        let args: Vec<_> = std::env::args_os().collect();
        assert_eq!(
            args.len(),
            7,
            "shell,dll,module manifest,ConPTY directory,fresh evidence,token required"
        );
        let shell = PathBuf::from(&args[1]);
        let library = PathBuf::from(&args[2]).canonicalize().unwrap();
        let module = PathBuf::from(&args[3]).canonicalize().unwrap();
        let conpty = PathBuf::from(&args[4]).canonicalize().unwrap();
        let evidence = PathBuf::from(&args[5]);
        let token = args[6].to_str().unwrap();
        assert!(token.len() == 36 && token.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-'));
        let owner = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .canonicalize()
            .unwrap();
        let owned = owner.join(".artifacts/tests").canonicalize().unwrap();
        assert!(library.starts_with(&owned));
        assert!(
            evidence.is_absolute()
                && evidence
                    .parent()
                    .unwrap()
                    .canonicalize()
                    .unwrap()
                    .starts_with(&owned)
        );
        assert!(!evidence.exists());
        fs::create_dir(&evidence).unwrap();
        let home = evidence.join("home");
        fs::create_dir(&home).unwrap();
        let gate = evidence.join(format!("release-capture-tail-{token}.txt"));
        let quote = |s: &str| format!("'{}'", s.replace('\'', "''"));
        let declaration = format!("using System.Runtime.InteropServices; public static class ShellSpanAcceptanceTail {{ [DllImport(@\"{}\",EntryPoint=\"Run\",CallingConvention=CallingConvention.StdCall)] public static extern void Run(); }}", shell_path(&library).replace('"', "\"\""));
        let mut script = format!("$ErrorActionPreference='Stop'\nImport-Module {} -ErrorAction Stop\nSet-PSReadLineOption -HistorySavePath {} -HistorySaveStyle SaveNothing\n$env:SHELLSPAN_CAPTURE_TAIL_TOKEN={}\n$env:SHELLSPAN_CAPTURE_TAIL_GATE={}\nAdd-Type -TypeDefinition {}\n[IO.File]::WriteAllText({},(@{{pid=$PID;engine=$PSVersionTable.PSVersion.ToString();host=$Host.Name;assembly=[Microsoft.PowerShell.PSConsoleReadLine].Assembly.Location}}|ConvertTo-Json))\n[Console]::WriteLine('C05_FIXTURE_'+'READY')\n", quote(&shell_path(&module)), quote(&home.join("history.txt").to_string_lossy()), quote(token), quote(&gate.to_string_lossy()), quote(&declaration), quote(&evidence.join("host.json").to_string_lossy()));
        if shell
            .file_name()
            .unwrap()
            .to_string_lossy()
            .eq_ignore_ascii_case("powershell.exe")
        {
            script.insert(0, '\u{feff}');
        }
        let bootstrap = evidence.join("bootstrap.ps1");
        fs::write(&bootstrap, script).unwrap();
        let pair =
            portable_pty::win::conpty::ConPtySystem::with_grapheme_host(conpty.join("conpty.dll"))
                .openpty(PtySize {
                    rows: 30,
                    cols: 100,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .unwrap();
        let mut command = CommandBuilder::new(&shell);
        command.args(["-NoLogo", "-NoProfile", "-NoExit", "-File"]);
        command.arg(&bootstrap);
        for key in ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"] {
            command.env(key, &home);
        }
        command.env(
            "PSModulePath",
            std::env::join_paths([
                PathBuf::from(shell_path(
                    module.parent().unwrap().parent().unwrap().parent().unwrap(),
                )),
                PathBuf::from(shell_path(&shell.parent().unwrap().join("Modules"))),
            ])
            .unwrap(),
        );
        command.cwd(&home);
        let mut child = pair.slave.spawn_command(command).unwrap();
        let host_pid = child.process_id().unwrap();
        drop(pair.slave);
        let writer = Arc::new(Mutex::new(pair.master.take_writer().unwrap()));
        let mut reader = pair.master.try_clone_reader().unwrap();
        let raw = Arc::new(Mutex::new(Vec::<u8>::new()));
        let captured = raw.clone();
        let responses = writer.clone();
        let output = thread::spawn(move || {
            let mut screen = vt100::Parser::new(30, 100, 1000);
            let mut parser = vte::Parser::new();
            let mut query = Query::default();
            let mut bytes = [0; 8192];
            while let Ok(count) = reader.read(&mut bytes) {
                if count == 0 {
                    break;
                }
                captured.lock().unwrap().extend_from_slice(&bytes[..count]);
                for byte in &bytes[..count] {
                    screen.process(&[*byte]);
                    parser.advance(&mut query, &[*byte]);
                    if query.cursor {
                        query.cursor = false;
                        let (row, col) = screen.screen().cursor_position();
                        write(
                            &responses,
                            format!("\x1b[{};{}R", row + 1, col + 1).as_bytes(),
                        );
                    }
                }
            }
        });
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            wait(|| text(&raw).contains("C05_FIXTURE_READY"));
            thread::sleep(Duration::from_millis(300));
            write(&writer, b"[ShellSpanAcceptanceTail]::Run()\r");
            let begin = format!("C05_BEGIN_{token}");
            let tail = format!("C05_TAIL_{token}");
            wait(|| text(&raw).contains(&begin));
            thread::sleep(Duration::from_secs(5));
            write(&writer, &[3]);
            thread::sleep(Duration::from_millis(2500));
            assert!(
                child.try_wait().unwrap().is_none(),
                "Host exited during blocked native call"
            );
            assert!(!text(&raw).contains(&tail), "Tail appeared before release");
            fs::write(&gate, format!("release:{token}")).unwrap();
            wait(|| text(&raw).contains(&tail));
            let result = text(&raw);
            assert_eq!(result.matches(&begin).count(), 1);
            assert_eq!(result.matches(&tail).count(), 1);
            assert!(
                !result.contains("C05_FIXTURE_DEADLINE") && !result.contains("C05_FIXTURE_REFUSED")
            );
            fs::write(evidence.join("result.json"),serde_json::to_vec_pretty(&serde_json::json!({"ok":true,"hostPid":host_pid,"ordinarySourceWrites":1,"interruptWrites":1,"blockedAfterInterruptMs":2500,"beginCount":1,"tailCount":1,"tailAbsentBeforeRelease":true,"nativeDeadlineMs":25000,"actualAppCases":0,"modelCalls":0,"scope":"Real ConPTY/ConsoleHost/private editor and bounded native test program preflight. No NIP,Agent,approval,coordinator,capture-retention or unknown-result proof."})).unwrap()).unwrap();
        }));
        let _ = child.kill();
        let _ = child.wait();
        drop(writer);
        drop(pair.master);
        let _ = output.join();
        fs::write(evidence.join("raw.bin"), &*raw.lock().unwrap()).unwrap();
        if let Err(error) = outcome {
            std::panic::resume_unwind(error);
        }
    }
    fn text(raw: &Arc<Mutex<Vec<u8>>>) -> String {
        String::from_utf8_lossy(&raw.lock().unwrap()).into_owned()
    }
    fn shell_path(path: &std::path::Path) -> String {
        let text = path.to_string_lossy().replace('/', "\\");
        if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
            format!(r"\\{unc}")
        } else {
            text.strip_prefix(r"\\?\").unwrap_or(&text).to_string()
        }
    }
    #[cfg(test)]
    mod tests {
        #[test]
        fn shell_module_paths_preserve_drive_and_unc_without_device_prefixes() {
            use std::path::Path;
            assert_eq!(
                super::shell_path(Path::new(r"\\?\D:\private\module.psd1")),
                r"D:\private\module.psd1"
            );
            assert_eq!(
                super::shell_path(Path::new(r"\\?\UNC\host\share\module.psd1")),
                r"\\host\share\module.psd1"
            );
            assert_eq!(
                super::shell_path(Path::new("D:/PowerShell/7/Modules")),
                r"D:\PowerShell\7\Modules"
            );
        }
    }
    fn wait(mut predicate: impl FnMut() -> bool) {
        let start = Instant::now();
        while !predicate() {
            assert!(
                start.elapsed() < Duration::from_secs(12),
                "Actual fixture boundary missing"
            );
            thread::sleep(Duration::from_millis(20));
        }
    }
    fn write(writer: &Arc<Mutex<Box<dyn Write + Send>>>, bytes: &[u8]) {
        let mut writer = writer.lock().unwrap();
        writer.write_all(bytes).unwrap();
        writer.flush().unwrap();
    }
    #[derive(Default)]
    struct Query {
        cursor: bool,
    }
    impl vte::Perform for Query {
        fn csi_dispatch(
            &mut self,
            params: &vte::Params,
            intermediates: &[u8],
            ignore: bool,
            action: char,
        ) {
            if !ignore
                && intermediates.is_empty()
                && action == 'n'
                && params.iter().collect::<Vec<_>>() == vec![&[6][..]]
            {
                self.cursor = true;
            }
        }
    }
}
#[cfg(windows)]
fn main() {
    actual::run();
}
#[cfg(not(windows))]
fn main() {
    panic!("Actual Windows host required");
}
