use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::PathBuf,
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

#[derive(Deserialize)]
struct Case {
    id: String,
    source: String,
    expect: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Observation {
    id: String,
    source: String,
    host_pid: u32,
    prompt_observed: bool,
    screen: String,
    raw_start: usize,
    raw_end: usize,
    native_protocol_loaded: bool,
    body_effect: Option<String>,
}
#[derive(Default)]
struct Queries {
    cursor: bool,
}
impl vte::Perform for Queries {
    fn csi_dispatch(&mut self, params: &vte::Params, middle: &[u8], ignore: bool, action: char) {
        if !ignore
            && middle.is_empty()
            && action == 'n'
            && params.iter().collect::<Vec<_>>() == vec![&[6][..]]
        {
            self.cursor = true;
        }
    }
}
fn fresh(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?
        .write_all(bytes)
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    if !cfg!(windows) {
        return Err("This reference requires actual Windows ConsoleHost/ConPTY".into());
    }
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 3 {
        return Err("Expected shell, plan JSON, fresh absolute evidence directory".into());
    }
    // .NET Framework initialization fails when powershell.exe is launched with
    // a verbatim \\?\ image path. Validate without changing the launch spelling.
    let shell = PathBuf::from(&args[0]);
    if !shell.is_absolute() || !shell.is_file() || shell.to_string_lossy().starts_with(r"\\?\") {
        return Err("An existing ordinary absolute Windows host path is required".into());
    }
    let directory = PathBuf::from(&args[2]);
    if !directory.is_absolute() {
        return Err("Absolute owned evidence directory required".into());
    }
    let base = std::env::current_dir()?
        .join("artifacts/tests")
        .canonicalize()?;
    let parent = directory
        .parent()
        .ok_or("Missing evidence parent")?
        .canonicalize()?;
    if !parent.starts_with(base) {
        return Err("Evidence must stay inside workspace tests".into());
    }
    let cases: Vec<Case> = serde_json::from_slice(&fs::read(&args[1])?)?;
    if cases.is_empty()
        || cases.len() > 8
        || cases.iter().any(|c| {
            c.id.is_empty()
                || !c.id.chars().all(|v| v.is_ascii_alphanumeric() || v == '-')
                || c.source.len() > 8192
                || c.source.contains(['\r', '\n', '\0', '\x1b'])
        })
    {
        return Err("Bounded one-line reference cases required".into());
    }
    fs::create_dir(&directory)?;
    let pair = native_pty_system().openpty(PtySize {
        rows: 40,
        cols: 160,
        pixel_width: 0,
        pixel_height: 0,
    })?;
    let mut command = CommandBuilder::new(&shell);
    command.args(["-NoLogo", "-NoProfile", "-NoExit", "-Command"]);
    command.cwd(&directory);
    command.env("SHELLSPAN_SEMANTICS_HOME", &directory);
    command.env("SHELLSPAN_LOCAL_HOME", &directory);
    command.env(
        "PSModulePath",
        shell
            .parent()
            .ok_or("Missing host module directory")?
            .join("Modules"),
    );
    for (name, folder) in [
        ("HOME", "profile"),
        ("USERPROFILE", "profile"),
        ("APPDATA", "roaming"),
        ("LOCALAPPDATA", "local"),
    ] {
        let path = directory.join("isolated").join(folder);
        fs::create_dir_all(&path)?;
        command.env(name, path);
    }
    let quoted = directory
        .join("history.txt")
        .to_string_lossy()
        .replace('\'', "''");
    let module = std::env::current_dir()?
        .join("src-tauri/resources/powershell/PSReadLine/2.4.5/PSReadLine.psd1");
    if !module.is_file() {
        return Err("Pinned project PSReadLine manifest missing".into());
    }
    let module = module.to_string_lossy().replace('\'', "''");
    command.arg(format!("Import-Module '{module}' -ErrorAction Stop; PSReadLine\\Set-PSReadLineOption -HistorySavePath '{quoted}' -HistorySaveStyle SaveNothing; $o=PSReadLine\\Get-PSReadLineOption; if([IO.Path]::GetFullPath($o.HistorySavePath) -ine [IO.Path]::GetFullPath('{quoted}') -or $o.HistorySaveStyle.ToString() -cne 'SaveNothing'){{throw 'REFERENCE_HISTORY_ISOLATION_FAILED'}}; [Console]::WriteLine('REF_HOST_VERSION:'+$PSVersionTable.PSVersion.ToString()); [Console]::WriteLine('REF_READER_VERSION:'+(Get-Module PSReadLine).Version.ToString()); [Console]::WriteLine('REF_SETUP_'+'ISOLATED')"));
    command.env("PSModuleAnalysisCachePath", directory.join("module.cache"));
    let mut child = pair.slave.spawn_command(command)?;
    drop(pair.slave);
    let pid = child.process_id().ok_or("Missing actual ConsoleHost PID")?;
    let mut writer = pair.master.take_writer()?;
    let mut reader = pair.master.try_clone_reader()?;
    let (sender, receiver) = mpsc::channel();
    let output = thread::spawn(move || {
        let mut bytes = [0u8; 8192];
        while let Ok(count) = reader.read(&mut bytes) {
            if count == 0 || sender.send(bytes[..count].to_vec()).is_err() {
                break;
            }
        }
    });
    let mut terminal = vt100::Parser::new(40, 160, 1000);
    let mut parser = vte::Parser::new();
    let mut queries = Queries::default();
    let mut raw = Vec::new();
    let mut observations = Vec::new();
    let outcome = (|| -> Result<(), Box<dyn std::error::Error>> {
        for item in std::iter::once(None).chain(cases.iter().map(Some)) {
            let start = raw.len();
            if let Some(case) = item {
                writer.write_all(case.source.as_bytes())?;
                writer.write_all(b"\r")?;
                writer.flush()?;
            }
            let deadline = Instant::now() + Duration::from_secs(20);
            let mut changed = Instant::now();
            loop {
                if Instant::now() >= deadline {
                    return Err(format!(
                        "Reference prompt deadline: {}",
                        item.map_or("startup", |c| c.id.as_str())
                    )
                    .into());
                }
                match receiver.recv_timeout(Duration::from_millis(30)) {
                    Ok(bytes) => {
                        if raw.len() + bytes.len() > 1_048_576 {
                            return Err("Reference capture exceeded bound".into());
                        }
                        raw.extend_from_slice(&bytes);
                        changed = Instant::now();
                        for byte in bytes {
                            terminal.process(&[byte]);
                            parser.advance(&mut queries, &[byte]);
                            if queries.cursor {
                                let (row, col) = terminal.screen().cursor_position();
                                queries.cursor = false;
                                writer.write_all(
                                    format!("\x1b[{};{}R", row + 1, col + 1).as_bytes(),
                                )?;
                                writer.flush()?;
                            }
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        return Err("ConsoleHost output closed before prompt".into())
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                }
                let screen = terminal.screen().contents();
                let prompt = screen
                    .trim_end()
                    .lines()
                    .last()
                    .is_some_and(|line| line.starts_with("PS ") && line.ends_with('>'));
                if prompt
                    && raw.len() > start
                    && changed.elapsed() >= Duration::from_millis(250)
                    && item.map_or_else(
                        || screen.contains("REF_SETUP_ISOLATED"),
                        |case| screen.contains(&case.expect),
                    )
                {
                    if let Some(case) = item {
                        observations.push(Observation {
                            id: case.id.clone(),
                            source: case.source.clone(),
                            host_pid: pid,
                            prompt_observed: true,
                            screen,
                            raw_start: start,
                            raw_end: raw.len(),
                            native_protocol_loaded: false,
                            body_effect: match fs::read_to_string(directory.join("body.txt")) {
                                Ok(value) => Some(value),
                                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                                Err(error) => return Err(error.into()),
                            },
                        });
                    }
                    break;
                }
            }
        }
        Ok(())
    })();
    // This object owns the actual child. No process-name or global process kill.
    let _ = child.kill();
    let status = child.wait();
    drop(writer);
    drop(pair.master);
    let _ = output.join();
    fresh(&directory.join("raw.bin"), &raw)?;
    fresh(
        &directory.join("observations.json"),
        &serde_json::to_vec_pretty(&observations)?,
    )?;
    fresh(
        &directory.join("outcome.json"),
        &serde_json::to_vec_pretty(
            &serde_json::json!({"hostPid":pid,"hostWaitObserved":status.is_ok(),"failure":outcome.as_ref().err().map(|e|e.to_string()),"casesObserved":observations.len(),"nativeProtocolLoaded":false,"scope":"Ordinary real ConsoleHost reference only;no private NIP,Agent/model or native acceptance proof"}),
        )?,
    )?;
    outcome
}
