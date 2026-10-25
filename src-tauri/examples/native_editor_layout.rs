//! Native PSReadLine layout reference. Inserts bytes as editor data; never submits source.
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
struct Request {
    accepted_line: String,
    columns: u16,
    rows: u16,
    prefix_columns: u16,
    executable: String,
}
struct OwnedChild(Box<dyn portable_pty::Child + Send + Sync>);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args_os().collect();
    let input = PathBuf::from(args.get(1).ok_or("missing request")?);
    let output = PathBuf::from(args.get(2).ok_or("missing output")?);
    let request: Request = serde_json::from_slice(&std::fs::read(&input)?)?;
    if !(32..=1000).contains(&request.columns)
        || !(10..=300).contains(&request.rows)
        || request.prefix_columns >= request.columns
        || request.accepted_line.len() > 32768
        || request
            .accepted_line
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
    {
        return Err("invalid native layout request".into());
    }
    let buffer = output.with_extension("buffer");
    let source = output.with_extension("source");
    std::fs::write(&source, request.accepted_line.as_bytes())?;
    let token = uuid::Uuid::new_v4().simple().to_string();
    let ready = format!("\x1b]0;READY_{token}\x07");
    let ack = format!("\x1b]0;LAYOUT_{token}\x07");
    let history = output.with_extension("history.txt");
    let history_path = output.with_extension("history-path.txt");
    let setup = format!(
        "Import-Module PSReadLine -ErrorAction Stop; Set-PSReadLineOption -HistorySavePath {} -ErrorAction Stop; [IO.File]::WriteAllText({},(Get-PSReadLineOption).HistorySavePath,[Text.UTF8Encoding]::new($false)); function global:prompt {{ {} }}; $global:layoutSource=[IO.File]::ReadAllText({}); Set-PSReadLineKeyHandler -Chord 'Ctrl+x,Ctrl+a' -ScriptBlock {{ $line=$null; $cursor=0; [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line,[ref]$cursor); [Microsoft.PowerShell.PSConsoleReadLine]::Replace($cursor,0,$global:layoutSource); [Microsoft.PowerShell.PSConsoleReadLine]::ClearScreen(); [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line,[ref]$cursor); [IO.File]::WriteAllText({},$line,[Text.UTF8Encoding]::new($false)); [Console]::Write({}) }}; [Console]::Write({})",
        quote(&history.to_string_lossy()), quote(&history_path.to_string_lossy()), quote(&" ".repeat(request.prefix_columns as usize)), quote(&source.to_string_lossy()),
        quote(&buffer.to_string_lossy()), quote(&ack), quote(&ready));
    let encoded = STANDARD.encode(
        setup
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>(),
    );
    let pair = native_pty_system().openpty(PtySize {
        rows: request.rows,
        cols: request.columns,
        pixel_width: 0,
        pixel_height: 0,
    })?;
    let mut command = CommandBuilder::new(&request.executable);
    command.args([
        "-NoLogo",
        "-NoProfile",
        "-NoExit",
        "-EncodedCommand",
        &encoded,
    ]);
    let mut child = OwnedChild(pair.slave.spawn_command(command)?);
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader()?;
    let mut writer = pair.master.take_writer()?;
    let (tx, rx) = mpsc::channel();
    let reading = std::thread::spawn(move || {
        let mut bytes = [0; 8192];
        while let Ok(count) = reader.read(&mut bytes) {
            if count == 0 || tx.send(bytes[..count].to_vec()).is_err() {
                break;
            }
        }
    });
    let result = (|| -> Result<(), Box<dyn std::error::Error>> {
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut trace = Vec::new();
        let mut inserted = false;
        loop {
            let chunk = rx.recv_timeout(deadline.saturating_duration_since(Instant::now()))?;
            trace.extend(chunk);
            if trace.len() > 2 * 1024 * 1024 {
                return Err("layout trace too large".into());
            }
            if !inserted
                && trace
                    .windows(ready.len())
                    .any(|bytes| bytes == ready.as_bytes())
            {
                writer.write_all(b"\x18\x01")?;
                writer.flush()?;
                inserted = true;
            }
            if inserted
                && trace
                    .windows(ack.len())
                    .any(|bytes| bytes == ack.as_bytes())
            {
                break;
            }
        }
        if std::fs::read(&buffer)? != request.accepted_line.as_bytes() {
            return Err("native editor changed accepted buffer".into());
        }
        let selected_history = std::fs::read_to_string(&history_path)?;
        if PathBuf::from(&selected_history) != history {
            return Err("native editor reference selected a different history path".into());
        }
        std::fs::write(&output, trace)?;
        use sha2::{Digest, Sha256};
        let digest = hex::encode(Sha256::digest(request.accepted_line.as_bytes()));
        std::fs::write(
            format!("{}.json", output.display()),
            serde_json::to_vec_pretty(&serde_json::json!({
                "kind":"native-editor-layout-only-no-source-execution", "sourceSha256":digest,
                "nativeBufferSha256":digest, "columns":request.columns, "rows":request.rows, "prefixColumns":request.prefix_columns,
                "historyPath":selected_history
            }))?,
        )?;
        Ok(())
    })();
    let killed = child.0.kill();
    let waited = child.0.wait();
    drop(writer);
    drop(pair.master);
    drop(rx);
    let _ = reading.join();
    result?;
    killed?;
    waited?;
    Ok(())
}
