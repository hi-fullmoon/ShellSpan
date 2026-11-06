//! Real stock ConsoleHost control. No NIP, integration, or simulated receipts.
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::{
    fs,
    io::{Read, Write},
    path::PathBuf,
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

fn main() {
    assert!(cfg!(windows));
    let args = std::env::args().collect::<Vec<_>>();
    assert_eq!(args.len(), 3);
    let shell = &args[1];
    let directory = PathBuf::from(&args[2]);
    fs::create_dir_all(&directory).unwrap();
    let quote =
        |path: &std::path::Path| format!("'{}'", path.to_string_lossy().replace('\'', "''"));
    let script = directory.join("bootstrap.ps1");
    fs::write(&script,format!(r#"$ErrorActionPreference='Stop'
Import-Module PSReadLine -ErrorAction Stop
if($PSVersionTable.PSVersion.ToString()-cne '7.6.9'-or(Get-Module PSReadLine).Version.ToString()-cne '2.4.5'){{throw 'Frozen stock host mismatch'}}
Set-PSReadLineOption -HistorySaveStyle SaveAtExit -ErrorAction Stop
$o=Get-PSReadLineOption
$path=[IO.Path]::GetFullPath($o.HistorySavePath)
$root=[IO.Path]::GetFullPath({})+[IO.Path]::DirectorySeparatorChar
if(-not $path.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)){{throw 'Stock history escaped isolated scope'}}
if(Test-Path -LiteralPath $path){{throw 'Do not replay stock history scope'}}
$null=[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path))
[IO.File]::WriteAllText($path,"Write-Output 'STOCK_SEED_A'`nWrite-Output 'STOCK_SEED_B'`n",[Text.UTF8Encoding]::new($false))
$record=@{{engine=$PSVersionTable.PSVersion.ToString();editor=(Get-Module PSReadLine).Version.ToString();readerModule=(Get-Command PSConsoleHostReadLine).ModuleName;historyPath=$path;style=[string]$o.HistorySaveStyle;assemblySha256=(Get-FileHash ([Microsoft.PowerShell.PSConsoleReadLine].Assembly.Location) -Algorithm SHA256).Hash;pid=$PID}}
[IO.File]::WriteAllText({},($record|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
PSReadLine\Set-PSReadLineKeyHandler -Chord 'Ctrl+x,Ctrl+t' -ScriptBlock {{
  $line=$null;$cursor=0;[Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line,[ref]$cursor)
  $active=$false;foreach($frame in [Diagnostics.StackTrace]::new().GetFrames()){{$method=$frame.GetMethod();if($null-ne$method-and$method.DeclaringType-eq[Microsoft.PowerShell.PSConsoleReadLine]-and$method.Name-ceq'ReadLine'){{$active=$true;break}}}}
  $data=@{{text=[string]$line;cursor=$cursor;activeEditor=$active;readerModule=(Get-Command PSConsoleHostReadLine).ModuleName;history=@([Microsoft.PowerShell.PSConsoleReadLine]::GetHistoryItems()|ForEach-Object{{$_.CommandLine}})}}
  [IO.File]::WriteAllText({},($data|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
}}
[Console]::WriteLine('STOCK_BOOTSTRAP_READY')
"#,quote(&directory),quote(&directory.join("actual.json")),quote(&directory.join("actual-history.json")))).unwrap();
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 30,
            cols: 100,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();
    let mut command = CommandBuilder::new(shell);
    command.args(["-NoLogo", "-NoProfile", "-NoExit", "-File"]);
    command.arg(&script);
    for (name, folder) in [
        ("HOME", "profile"),
        ("USERPROFILE", "profile"),
        ("APPDATA", "roaming"),
        ("LOCALAPPDATA", "local"),
    ] {
        let path = directory.join("isolated").join(folder);
        fs::create_dir_all(&path).unwrap();
        command.env(name, path);
    }
    let mut child = pair.slave.spawn_command(command).unwrap();
    drop(pair.slave);
    let writer = Arc::new(Mutex::new(pair.master.take_writer().unwrap()));
    let output = Arc::new(Mutex::new(Vec::<u8>::new()));
    let mut reader = pair.master.try_clone_reader().unwrap();
    let observed = output.clone();
    let vt = Arc::new(Mutex::new(vt100::Parser::new(30, 100, 1000)));
    let terminal = vt.clone();
    let responses = writer.clone();
    let reading = thread::spawn(move || {
        let mut chunk = [0; 8192];
        let mut state = vte::Parser::new();
        let mut queries = Queries::default();
        while let Ok(count) = reader.read(&mut chunk) {
            if count == 0 {
                break;
            }
            observed.lock().unwrap().extend_from_slice(&chunk[..count]);
            for byte in &chunk[..count] {
                let mut screen = terminal.lock().unwrap();
                screen.process(&[*byte]);
                state.advance(&mut queries, &[*byte]);
                if queries.cursor {
                    queries.cursor = false;
                    let (row, col) = screen.screen().cursor_position();
                    let mut writer = responses.lock().unwrap();
                    writer
                        .write_all(format!("\x1b[{};{}R", row + 1, col + 1).as_bytes())
                        .unwrap();
                    writer.flush().unwrap();
                }
            }
        }
    });
    let mut success_exit = false;
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        wait(|| String::from_utf8_lossy(&output.lock().unwrap()).contains("STOCK_BOOTSTRAP_READY"));
        for index in 1..=5 {
            send(
                &writer,
                format!("[Console]::WriteLine('STOCK_DONE_'+'{index}')\r").as_bytes(),
            );
            wait(|| {
                String::from_utf8_lossy(&output.lock().unwrap())
                    .contains(&format!("STOCK_DONE_{index}"))
            });
        }
        let snapshot = directory.join("actual-history.json");
        let mut next = Instant::now();
        wait(|| {
            if fs::read(&snapshot)
                .is_ok_and(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).is_ok())
            {
                return true;
            }
            if Instant::now() >= next {
                send(&writer, b"\x18\x14");
                next = Instant::now() + Duration::from_millis(100);
            }
            false
        });
        let data: serde_json::Value =
            serde_json::from_slice(&fs::read(&snapshot).unwrap()).unwrap();
        assert_eq!(data["activeEditor"], true);
        assert_eq!(data["readerModule"], "PSReadLine");
        assert_eq!(data["text"], "");
        assert_eq!(data["history"].as_array().unwrap().len(), 7);
        send(&writer, b"exit\r");
        wait(|| {
            if let Some(status) = child.try_wait().unwrap() {
                success_exit = status.success();
                true
            } else {
                false
            }
        });
    }));
    let _ = child.kill();
    let _ = child.wait();
    drop(writer);
    drop(pair.master);
    let _ = reading.join();
    fs::write(directory.join("raw.bin"), &*output.lock().unwrap()).unwrap();
    if let Err(error) = outcome {
        std::panic::resume_unwind(error);
    }
    assert!(success_exit);
    let data: serde_json::Value =
        serde_json::from_slice(&fs::read(directory.join("actual.json")).unwrap()).unwrap();
    let history = fs::read_to_string(data["historyPath"].as_str().unwrap()).unwrap();
    let commands = history
        .lines()
        .filter(|line| line.contains("STOCK_DONE_"))
        .count();
    fs::write(directory.join("result.json"),serde_json::to_vec_pretty(&serde_json::json!({"expectedCommands":5,"persistedCommands":commands,"savedAll":commands==5,"normalExitCode":0,"integrationInstalled":false,"readerModule":data["readerModule"],"scope":"Actual stock ConsoleHost/PSReadLine control, no NIP or production integration"})).unwrap()).unwrap();
    assert_eq!(
        commands, 5,
        "Stock SaveAtExit did not persist accepted ordinary commands"
    );
}
fn send(writer: &Arc<Mutex<Box<dyn Write + Send>>>, bytes: &[u8]) {
    let mut writer = writer.lock().unwrap();
    writer.write_all(bytes).unwrap();
    writer.flush().unwrap();
}
fn wait(mut test: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if test() {
            return;
        }
        thread::sleep(Duration::from_millis(10));
    }
    panic!("Actual stock history boundary missing");
}
#[derive(Default)]
struct Queries {
    cursor: bool,
}
impl vte::Perform for Queries {
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
