//! Independent plain ConPTY comparison; never supplies output to an App terminal.
use base64::{engine::general_purpose::STANDARD, Engine};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Deserialize;
use std::{
    io::{Read, Write},
    path::PathBuf,
    sync::mpsc,
    time::{Duration, Instant},
};
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    executable: String,
    setup: String,
    source: String,
    marker: String,
    workspace: String,
    columns: u16,
    rows: u16,
}
fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}
struct OwnedChild(Box<dyn portable_pty::Child + Send + Sync>);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
#[cfg(windows)]
struct OwnedGroup(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
impl OwnedGroup {
    fn bind(child: &dyn portable_pty::Child) -> Result<Self, Box<dyn std::error::Error>> {
        use windows_sys::Win32::System::JobObjects::*;
        let process = child.as_raw_handle().ok_or("missing exact parent handle")?;
        unsafe {
            let group = Self(CreateJobObjectW(std::ptr::null(), std::ptr::null()));
            if group.0.is_null() {
                return Err(std::io::Error::last_os_error().into());
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                group.0,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                std::mem::size_of_val(&limits) as u32,
            ) == 0
                || AssignProcessToJobObject(group.0, process) == 0
            {
                return Err(std::io::Error::last_os_error().into());
            }
            Ok(group)
        }
    }
}
#[cfg(windows)]
impl Drop for OwnedGroup {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.0, 137);
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args_os().collect();
    let input: Input =
        serde_json::from_slice(&std::fs::read(args.get(1).ok_or("missing input")?)?)?;
    let output = PathBuf::from(args.get(2).ok_or("missing output")?);
    let gate = output.with_extension("gate");
    if gate.exists() {
        return Err("baseline gate already exists".into());
    }
    let script = output.with_extension("child.ps1");
    std::fs::write(&script, format!("{}\n{}", input.setup, input.source))?;
    let id = uuid::Uuid::new_v4().simple().to_string();
    let ready = format!("\x1b]0;READY_{id}\x07");
    let done = format!("\x1b]0;DONE_{id}\x07");
    let history = output.with_extension("history.txt");
    let history_path = output.with_extension("history-path.txt");
    let parent=format!("Import-Module PSReadLine -ErrorAction Stop; Set-PSReadLineOption -HistorySavePath {} -ErrorAction Stop; [IO.File]::WriteAllText({},(Get-PSReadLineOption).HistorySavePath,[Text.UTF8Encoding]::new($false)); $env:SHELLSPAN_ACCEPTANCE={}; $env:SHELLSPAN_NATIVE_WORKSPACE={}; $env:SHELLSPAN_NATIVE_COMPLETION_GATE={}; Set-Location -LiteralPath $env:SHELLSPAN_NATIVE_WORKSPACE; [Console]::Write({})",quote(&history.to_string_lossy()),quote(&history_path.to_string_lossy()),quote(&input.marker),quote(&input.workspace),quote(&gate.to_string_lossy()),quote(&ready));
    let encoded = STANDARD.encode(
        parent
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>(),
    );
    let pair = native_pty_system().openpty(PtySize {
        rows: input.rows,
        cols: input.columns,
        pixel_width: 0,
        pixel_height: 0,
    })?;
    let mut cmd = CommandBuilder::new(&input.executable);
    cmd.args([
        "-NoLogo",
        "-NoProfile",
        "-NoExit",
        "-EncodedCommand",
        &encoded,
    ]);
    let mut child = OwnedChild(pair.slave.spawn_command(cmd)?);
    #[cfg(windows)]
    let group = OwnedGroup::bind(child.0.as_ref())?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader()?;
    let mut writer = pair.master.take_writer()?;
    let (tx, rx) = mpsc::channel();
    let reading = std::thread::spawn(move || {
        let mut bytes = [0; 8192];
        while let Ok(n) = reader.read(&mut bytes) {
            if n == 0 || tx.send(bytes[..n].to_vec()).is_err() {
                break;
            }
        }
    });
    let mut raw = Vec::new();
    let mut phases = Vec::new();
    let result = (|| -> Result<(), Box<dyn std::error::Error>> {
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut parser = vt100::Parser::new(input.rows, input.columns, 1000);
        for marker in [&ready, &input.marker] {
            if marker == &input.marker {
                writer.write_all(format!("$global:baselineChild=Start-Process -FilePath {} -ArgumentList @('-NoLogo','-NoProfile','-File',{}) -NoNewWindow -PassThru\r",quote(&input.executable),quote(&script.to_string_lossy())).as_bytes())?;
                writer.flush()?;
            }
            while !raw.windows(marker.len()).any(|x| x == marker.as_bytes()) {
                let b = rx.recv_timeout(deadline.saturating_duration_since(Instant::now()))?;
                parser.process(&b);
                raw.extend(b);
                if raw.len() > 2 * 1024 * 1024 {
                    return Err("oversized baseline".into());
                }
            }
        }
        phases.push(serde_json::json!({"phase":"actual-background-output-arrived","rendered":parser.screen().contents()}));
        for index in 1..=3 {
            let marker = format!("native-poll-{index}");
            writer.write_all(format!("Write-Output ('native-'+'poll-{index}')\r").as_bytes())?;
            writer.flush()?;
            while !raw.windows(marker.len()).any(|x| x == marker.as_bytes()) {
                let b = rx.recv_timeout(deadline.saturating_duration_since(Instant::now()))?;
                parser.process(&b);
                raw.extend(b);
            }
            phases.push(serde_json::json!({"phase":marker,"rendered":parser.screen().contents()}));
        }
        std::fs::write(&gate, [])?;
        writer.write_all(
            format!(
                "Wait-Process -Id $global:baselineChild.Id; [Console]::Write([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String({})))\r",
                quote(&STANDARD.encode(done.as_bytes()))
            )
            .as_bytes(),
        )?;
        writer.flush()?;
        while !raw.windows(done.len()).any(|x| x == done.as_bytes()) {
            let b = rx.recv_timeout(deadline.saturating_duration_since(Instant::now()))?;
            parser.process(&b);
            raw.extend(b);
        }
        phases.push(serde_json::json!({"phase":"native-child-completed-after-owned-gate-release","rendered":parser.screen().contents()}));
        if PathBuf::from(std::fs::read_to_string(&history_path)?) != history {
            return Err("plain reference selected a different history path".into());
        }
        Ok(())
    })();
    let killed = child.0.kill();
    let waited = child.0.wait();
    #[cfg(windows)]
    drop(group);
    drop(writer);
    drop(pair.master);
    drop(rx);
    let _ = reading.join();
    std::fs::write(&output, &raw)?;
    use sha2::{Digest, Sha256};
    std::fs::write(
        format!("{}.json", output.display()),
        serde_json::to_vec_pretty(&serde_json::json!({
            "kind":"plain-powershell-conpty-output-baseline-no-app-integration",
            "sourceSha256":hex::encode(Sha256::digest(input.source.as_bytes())),
        "columns":input.columns,"rows":input.rows,"parentPromptCwd":input.workspace,
        "editingComparison":"short ordinary polls, not the product accepted carrier or its exact scrolling history",
        "completed":result.is_ok(),"error":result.as_ref().err().map(|e|e.to_string()),"phases":phases,
        "historyPath":std::fs::read_to_string(&history_path).ok()
        }))?,
    )?;
    result?;
    killed?;
    waited?;
    Ok(())
}
