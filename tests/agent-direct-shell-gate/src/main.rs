//! Stage 0 only: deliberately unsafe in-band dispatcher against real PTYs.
//! This is an attack fixture, never an execution route for the application.

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::env;
use std::error::Error;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant};
use uuid::Uuid;

type GateResult<T> = Result<T, Box<dyn Error>>;
const WAIT: Duration = Duration::from_secs(12);
const NEXT_POSIX: &str = "echo GATE_NEXT_WOULD_EXECUTE";
const NEXT_PWSH: &str = "Write-Output GATE_NEXT_WOULD_EXECUTE";

#[derive(Clone, Copy, Debug)]
enum Flavor {
    Pwsh,
    Powershell51,
    WslBash,
    LocalBash,
    LocalZsh,
    SshBash,
    SshZsh,
}

impl Flavor {
    fn parse(value: &str) -> GateResult<Self> {
        let flavor = match value {
            "pwsh" => Self::Pwsh,
            "powershell51" => Self::Powershell51,
            "wsl-bash" => Self::WslBash,
            "local-bash" => Self::LocalBash,
            "local-zsh" => Self::LocalZsh,
            "ssh-bash" => Self::SshBash,
            "ssh-zsh" => Self::SshZsh,
            _ => return Err(format!("unknown target: {value}").into()),
        };
        Ok(flavor)
    }

    fn is_posix(self) -> bool {
        !matches!(self, Self::Pwsh | Self::Powershell51)
    }

    fn line_end(self) -> &'static str {
        if matches!(self, Self::Pwsh | Self::Powershell51) {
            "\r"
        } else {
            "\n"
        }
    }
}

struct Terminal {
    writer: Box<dyn Write + Send>,
    output: mpsc::Receiver<Vec<u8>>,
    captured: Vec<u8>,
    _master: Box<dyn MasterPty + Send>,
    child: Option<Box<dyn Child + Send + Sync>>,
    stop: Arc<AtomicBool>,
}

impl Drop for Terminal {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(child) = self.child.as_mut() {
            let _ = child.kill();
        }
    }
}

impl Terminal {
    fn local(command: CommandBuilder) -> GateResult<Self> {
        let pair = native_pty_system().openpty(PtySize {
            rows: 30,
            cols: 240,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        let child = pair.slave.spawn_command(command)?;
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;
        let (tx, rx) = mpsc::channel();
        let stop = Arc::new(AtomicBool::new(false));
        let reader_stop = Arc::clone(&stop);
        thread::spawn(move || {
            let mut chunk = [0u8; 4096];
            while !reader_stop.load(Ordering::Relaxed) {
                match reader.read(&mut chunk) {
                    Ok(0) => break,
                    Err(error) => {
                        eprintln!("PTY reader stopped: {error}");
                        break;
                    }
                    Ok(n) => {
                        if tx.send(chunk[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                }
            }
        });
        Ok(Self {
            writer,
            output: rx,
            captured: Vec::new(),
            _master: pair.master,
            child: Some(child),
            stop,
        })
    }

    fn open(flavor: Flavor) -> GateResult<Self> {
        match flavor {
            Flavor::Pwsh => {
                let mut command = CommandBuilder::new("pwsh.exe");
                command.args(["-NoLogo", "-NoProfile", "-NoExit"]);
                Self::local(command)
            }
            Flavor::Powershell51 => {
                let mut command = CommandBuilder::new("powershell.exe");
                command.args(["-NoLogo", "-NoProfile", "-NoExit"]);
                Self::local(command)
            }
            Flavor::WslBash => {
                let mut command = CommandBuilder::new("wsl.exe");
                command.args([
                    "-d",
                    "Ubuntu",
                    "--exec",
                    "/bin/bash",
                    "--noprofile",
                    "--norc",
                    "-i",
                ]);
                command.env("TERM", "xterm-256color");
                Self::local(command)
            }
            Flavor::LocalBash => {
                let mut command = CommandBuilder::new("/bin/bash");
                command.args(["--noprofile", "--norc", "-i"]);
                command.env("TERM", "xterm-256color");
                Self::local(command)
            }
            Flavor::LocalZsh => {
                let mut command = CommandBuilder::new("/bin/zsh");
                command.args(["-f", "-i"]);
                command.env("TERM", "xterm-256color");
                Self::local(command)
            }
            Flavor::SshBash | Flavor::SshZsh => {
                let port = env::var("GATE_SSH_PORT").unwrap_or_else(|_| "22337".into());
                let remote = if matches!(flavor, Flavor::SshBash) {
                    "exec bash --noprofile --norc -i"
                } else {
                    "exec zsh -f -i"
                };
                let mut command = CommandBuilder::new("ssh.exe");
                command.args([
                    "-tt",
                    "-o",
                    "StrictHostKeyChecking=no",
                    "-o",
                    "UserKnownHostsFile=NUL",
                    "-o",
                    "PreferredAuthentications=password",
                    "-o",
                    "PubkeyAuthentication=no",
                    "-o",
                    "NumberOfPasswordPrompts=1",
                    "-p",
                    &port,
                    "gate@127.0.0.1",
                    remote,
                ]);
                let mut terminal = Self::local(command)?;
                terminal.wait_for(b"password:", 0, WAIT)?;
                terminal.send("gate-fixture-only\r")?;
                let initial_prompt = if matches!(flavor, Flavor::SshBash) {
                    b"bash-5.2$ ".as_slice()
                } else {
                    b"% ".as_slice()
                };
                terminal.wait_for(initial_prompt, 0, WAIT)?;
                Ok(terminal)
            }
        }
    }

    fn send(&mut self, input: &str) -> GateResult<()> {
        let mut remaining = input.as_bytes();
        let deadline = Instant::now() + WAIT;
        while !remaining.is_empty() {
            match self.writer.write(remaining) {
                Ok(0) => return Err("PTY writer returned zero bytes".into()),
                Ok(n) => remaining = &remaining[n..],
                Err(error)
                    if error.kind() == std::io::ErrorKind::WouldBlock
                        && Instant::now() < deadline =>
                {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(error) => return Err(error.into()),
            }
        }
        self.writer.flush()?;
        Ok(())
    }

    fn mark(&mut self) -> usize {
        while let Ok(chunk) = self.output.try_recv() {
            self.captured.extend_from_slice(&chunk);
        }
        self.captured.len()
    }

    fn wait_for(&mut self, needle: &[u8], since: usize, timeout: Duration) -> GateResult<usize> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(offset) = self.captured[since..]
                .windows(needle.len())
                .position(|part| part == needle)
            {
                return Ok(since + offset);
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                let sample = String::from_utf8_lossy(&self.captured[since..]);
                return Err(format!(
                    "timed out waiting for {:?}; output={:?}",
                    String::from_utf8_lossy(needle),
                    sample.chars().take(1500).collect::<String>()
                )
                .into());
            }
            match self.output.recv_timeout(remaining) {
                Ok(chunk) => self.captured.extend_from_slice(&chunk),
                Err(error) => {
                    return Err(format!(
                        "PTY output ended while waiting for {:?}: {error}; output={:?}",
                        String::from_utf8_lossy(needle),
                        String::from_utf8_lossy(&self.captured[since..])
                    )
                    .into())
                }
            }
        }
    }

    fn wait_prompt(&mut self, since: usize) -> GateResult<()> {
        self.wait_for(b"GATE_PROMPT>", since, WAIT)?;
        Ok(())
    }

    fn wait_exit(&mut self) -> GateResult<u32> {
        let deadline = Instant::now() + WAIT;
        loop {
            if let Some(child) = self.child.as_mut() {
                if let Some(status) = child.try_wait()? {
                    return Ok(status.exit_code());
                }
            }
            if Instant::now() >= deadline {
                return Err("shell did not exit before deadline".into());
            }
            thread::sleep(Duration::from_millis(25));
        }
    }
}

fn frame(nonce: &str, seq: u32, kind: &str) -> Vec<u8> {
    format!("\x1b]633;ShellSpan;v2;{nonce};{seq};{kind}").into_bytes()
}

fn end_status(
    terminal: &mut Terminal,
    nonce: &str,
    seq: u32,
    since: usize,
) -> GateResult<(usize, String)> {
    let prefix = frame(nonce, seq, "end;");
    let position = terminal.wait_for(&prefix, since, WAIT)?;
    let suffix = terminal.wait_for(b"\x07", position + prefix.len(), WAIT)?;
    Ok((
        suffix + 1,
        String::from_utf8_lossy(&terminal.captured[position + prefix.len()..suffix]).into_owned(),
    ))
}

fn run_command(
    terminal: &mut Terminal,
    flavor: Flavor,
    nonce: &str,
    seq: &mut u32,
    command: &str,
) -> GateResult<String> {
    *seq += 1;
    let mark = terminal.mark();
    terminal.send(&format!("{command}{}", flavor.line_end()))?;
    if flavor.is_posix() {
        terminal.wait_for(&frame(nonce, *seq, "start\x07"), mark, WAIT)?;
    }
    let (end, status) = end_status(terminal, nonce, *seq, mark)?;
    terminal.wait_prompt(end)?;
    let hook_seen = terminal.captured[mark..]
        .windows(b"USER_HOOK".len())
        .any(|part| part == b"USER_HOOK");
    if !hook_seen && !matches!(flavor, Flavor::SshZsh | Flavor::LocalZsh) {
        return Err("pre-existing prompt hook was not observed".into());
    }
    Ok(status)
}

fn run_interrupt(
    terminal: &mut Terminal,
    flavor: Flavor,
    nonce: &str,
    seq: &mut u32,
) -> GateResult<()> {
    *seq += 1;
    let mark = terminal.mark();
    let sleep_command = if matches!(flavor, Flavor::Pwsh | Flavor::Powershell51) {
        "Start-Sleep -Seconds 10"
    } else {
        "sleep 10"
    };
    terminal.send(&format!("{sleep_command}{}", flavor.line_end()))?;
    if flavor.is_posix() {
        terminal.wait_for(&frame(nonce, *seq, "start\x07"), mark, WAIT)?;
    }
    thread::sleep(Duration::from_millis(300));
    terminal.send("\x03")?;
    let (end, status) = end_status(terminal, nonce, *seq, mark)?;
    terminal.wait_prompt(end)?;
    println!("PASS {flavor:?} Ctrl-C returned to shell; end status={status}");
    Ok(())
}

fn setup_command(flavor: Flavor, nonce: &str) -> String {
    match flavor {
        Flavor::Pwsh | Flavor::Powershell51 => format!(". '{}' '{nonce}'", PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("setup.ps1").display()),
        Flavor::WslBash | Flavor::LocalBash | Flavor::SshBash => format!(
            "GATE_NONCE='{nonce}'; GATE_SEQ=0; PS1='GATE_PROMPT>'; PROMPT_COMMAND='printf USER_HOOK'; GATE_OLD_PC=$PROMPT_COMMAND; PROMPT_COMMAND='__gate_rc=$?; GATE_SEQ=$((GATE_SEQ+1)); printf \"\\033]633;ShellSpan;v2;%s;%s;end;%s\\007\" \"$GATE_NONCE\" \"$GATE_SEQ\" \"$__gate_rc\"; eval \"$GATE_OLD_PC\"'; PS0='$(printf \"\\033]633;ShellSpan;v2;%s;%s;start\\007\" \"$GATE_NONCE\" \"$((GATE_SEQ+1))\")'"
        ),
        Flavor::LocalZsh | Flavor::SshZsh => format!(
            "GATE_NONCE='{nonce}'; GATE_SEQ=0; PS1='GATE_PROMPT>'; function gate_user_precmd {{ print -n USER_HOOK }}; precmd_functions=(gate_user_precmd); function gate_preexec {{ printf '\\033]633;ShellSpan;v2;%s;%s;start\\007' \"$GATE_NONCE\" \"$((GATE_SEQ+1))\" }}; function gate_precmd {{ local gate_rc=$?; GATE_SEQ=$((GATE_SEQ+1)); printf '\\033]633;ShellSpan;v2;%s;%s;end;%s\\007' \"$GATE_NONCE\" \"$GATE_SEQ\" \"$gate_rc\" }}; preexec_functions=(gate_preexec $preexec_functions); precmd_functions=(gate_precmd $precmd_functions)"
        ),
    }
}

fn attack_path(flavor: Flavor) -> GateResult<String> {
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    Ok(match flavor {
        Flavor::Pwsh | Flavor::Powershell51 => {
            base.join("attack.ps1").to_string_lossy().into_owned()
        }
        Flavor::LocalBash => base.join("attack.bash").to_string_lossy().into_owned(),
        Flavor::LocalZsh => base.join("attack.zsh").to_string_lossy().into_owned(),
        Flavor::WslBash => {
            let path = base
                .join("attack.bash")
                .to_string_lossy()
                .replace('\\', "/");
            let bytes = path.as_bytes();
            if bytes.len() < 3 || bytes[1] != b':' {
                return Err(format!("expected Windows drive path, got {path}").into());
            }
            format!(
                "/mnt/{}/{}",
                (bytes[0] as char).to_ascii_lowercase(),
                &path[3..]
            )
        }
        Flavor::SshBash => "/home/gate/agent-direct-shell-gate/attack.bash".into(),
        Flavor::SshZsh => "/home/gate/agent-direct-shell-gate/attack.zsh".into(),
    })
}

fn run_attack(
    terminal: &mut Terminal,
    flavor: Flavor,
    nonce: &str,
    seq: &mut u32,
) -> GateResult<()> {
    *seq += 1;
    let path = attack_path(flavor)?;
    let command = if matches!(flavor, Flavor::Pwsh | Flavor::Powershell51) {
        format!(". '{path}'")
    } else {
        format!("source '{path}'")
    };
    let next = if matches!(flavor, Flavor::Pwsh | Flavor::Powershell51) {
        NEXT_PWSH
    } else {
        NEXT_POSIX
    };
    let mark = terminal.mark();
    terminal.send(&format!("{command}{}", flavor.line_end()))?;
    terminal.wait_for(&frame(nonce, *seq, "start\x07"), mark, WAIT)?;
    let (end, status) = end_status(terminal, nonce, *seq, mark)?;
    let before_next = &terminal.captured[mark..end];
    if before_next
        .windows(b"GATE_CONSUMED:".len())
        .any(|part| part == b"GATE_CONSUMED:")
    {
        return Err("attack was not still waiting for stdin when forged end arrived".into());
    }
    terminal.send(&format!("{next}{}", flavor.line_end()))?;
    let consumed = format!("GATE_CONSUMED:{next}");
    terminal.wait_for(consumed.as_bytes(), end, WAIT)?;
    println!("PASS forged start+end matched nonce={nonce} seq={seq} status={status}; next Agent line was consumed by the still-running sourced script");
    Ok(())
}

fn run_raw_input(terminal: &mut Terminal, flavor: Flavor) -> GateResult<()> {
    if !flavor.is_posix() {
        return Ok(());
    }
    let mark = terminal.mark();
    terminal.send(&format!("python3 -i{}", flavor.line_end()))?;
    terminal.wait_for(b">>> ", mark, WAIT)?;
    let mark = terminal.mark();
    terminal.send(&format!("print('GATE_REPL_EXECUTED'){}", flavor.line_end()))?;
    terminal.wait_for(b"GATE_REPL_EXECUTED", mark, WAIT)?;
    println!("PASS raw input reached Python REPL before the outer shell returned");
    terminal.send(&format!("exit(){}", flavor.line_end()))?;
    thread::sleep(Duration::from_millis(150));

    let path = if matches!(
        flavor,
        Flavor::WslBash | Flavor::LocalBash | Flavor::LocalZsh
    ) {
        attack_path(flavor)?
            .replace("attack.bash", "raw_tui.py")
            .replace("attack.zsh", "raw_tui.py")
    } else {
        "/home/gate/agent-direct-shell-gate/raw_tui.py".into()
    };
    let mark = terminal.mark();
    terminal.send(&format!("python3 '{path}'{}", flavor.line_end()))?;
    terminal.wait_for(b"GATE_TUI_READY", mark, WAIT)?;
    let mark = terminal.mark();
    terminal.send(&format!("{NEXT_POSIX}{}", flavor.line_end()))?;
    terminal.wait_for(
        format!("GATE_TUI_CONSUMED:{NEXT_POSIX}").as_bytes(),
        mark,
        WAIT,
    )?;
    println!("PASS raw input reached a program using terminal raw mode");
    thread::sleep(Duration::from_millis(150));

    if !matches!(flavor, Flavor::SshZsh | Flavor::LocalZsh) {
        let mark = terminal.mark();
        terminal.send(&format!("read -rsp 'GATE_PASSWORD_PROMPT:' gate_password; printf 'GATE_PASSWORD_CONSUMED:%s\\n' \"$gate_password\"{}", flavor.line_end()))?;
        terminal.wait_for(b"GATE_PASSWORD_PROMPT:", mark, WAIT)?;
        let mark = terminal.mark();
        terminal.send(&format!("{NEXT_POSIX}{}", flavor.line_end()))?;
        terminal.wait_for(
            format!("GATE_PASSWORD_CONSUMED:{NEXT_POSIX}").as_bytes(),
            mark,
            WAIT,
        )?;
        println!("PASS raw input reached a hidden password prompt");
    }
    if matches!(flavor, Flavor::SshBash) {
        let mark = terminal.mark();
        terminal.send("ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o PreferredAuthentications=password -o NumberOfPasswordPrompts=1 gate@127.0.0.1\n")?;
        terminal.wait_for(b"password:", mark, WAIT)?;
        let mark = terminal.mark();
        terminal.send(&format!("{NEXT_POSIX}\n"))?;
        terminal.wait_for(b"Permission denied", mark, WAIT)?;
        println!("PASS raw input reached nested SSH password prompt");
    }
    Ok(())
}

fn main() -> GateResult<()> {
    let arg = env::args().nth(1).ok_or(
        "usage: cargo run -- <pwsh|powershell51|wsl-bash|local-bash|local-zsh|ssh-bash|ssh-zsh>",
    )?;
    let flavor = Flavor::parse(&arg)?;
    let nonce = Uuid::new_v4().to_string();
    let mut terminal = Terminal::open(flavor)?;
    let mut seq = 1u32;
    let mark = terminal.mark();
    terminal.send(&format!(
        "{}{}",
        setup_command(flavor, &nonce),
        flavor.line_end()
    ))?;
    let (end, initial_status) = end_status(&mut terminal, &nonce, 1, mark)?;
    terminal.wait_prompt(end)?;
    println!("PASS {flavor:?} real PTY setup; first end status={initial_status}");

    if flavor.is_posix() {
        let state = if matches!(flavor, Flavor::SshZsh | Flavor::LocalZsh) {
            "cd /tmp; alias gate_alias='printf GATE_ALIAS'; function gate_fn { printf GATE_FN }; gate_var=kept"
        } else {
            "cd /tmp; alias gate_alias='printf GATE_ALIAS'; gate_fn() { printf GATE_FN; }; gate_var=kept"
        };
        let state_before = terminal.mark();
        let status = run_command(&mut terminal, flavor, &nonce, &mut seq, state)?;
        println!("PASS same-shell state setup status={status}");
        if matches!(flavor, Flavor::SshZsh | Flavor::LocalZsh)
            && !terminal.captured[state_before..]
                .windows(b"USER_HOOK".len())
                .any(|part| part == b"USER_HOOK")
        {
            println!("FAIL candidate zsh hook composition: pre-existing precmd hook output was absent after a completed command");
        }
        let before = terminal.mark();
        let status = run_command(
            &mut terminal,
            flavor,
            &nonce,
            &mut seq,
            "gate_alias; gate_fn; printf 'GATE_VAR:%s\\n' \"$gate_var\"; printf 'GATE_PWD:%s\\n' \"$PWD\"",
        )?;
        if !terminal.captured[before..]
            .windows(b"GATE_ALIASGATE_FNGATE_VAR:kept".len())
            .any(|part| part == b"GATE_ALIASGATE_FNGATE_VAR:kept")
        {
            return Err(
                "alias/function/variable did not produce the expected same-shell output".into(),
            );
        }
        if !terminal.captured[before..]
            .windows(b"GATE_PWD:/tmp".len())
            .any(|part| part == b"GATE_PWD:/tmp")
        {
            return Err("directory change did not persist in the same shell".into());
        }
        println!("PASS same-shell alias/function/variable/directory status={status}");
        let status = run_command(&mut terminal, flavor, &nonce, &mut seq, "false")?;
        if status != "1" {
            return Err(format!("false reported unexpected exit status {status}").into());
        }
        println!("PASS nonzero command end status={status}");
    } else {
        for (label, command) in [
            ("cmdlet", "Get-Item . | Out-Null"),
            ("cmdlet-error", "Get-Item '__gate_missing__'"),
            ("native-exit", "cmd /d /c exit 7"),
            ("pipeline", "cmd /d /c exit 7 | Out-Null"),
            ("exception", "throw 'GATE_THROW'"),
            ("cmdlet-after-native", "'ok' | Out-Null"),
        ] {
            let status = run_command(&mut terminal, flavor, &nonce, &mut seq, command)?;
            println!("OBSERVE PowerShell {label} end status={status}");
        }
        let status = run_command(
            &mut terminal,
            flavor,
            &nonce,
            &mut seq,
            "Set-Location $env:TEMP; Set-Alias gate_alias Get-Location; $global:gate_var='kept'; function global:gate_fn { 'GATE_FN' }",
        )?;
        println!("OBSERVE PowerShell state setup end status={status}");
        let state_before = terminal.mark();
        let status = run_command(
            &mut terminal,
            flavor,
            &nonce,
            &mut seq,
            "if ((Get-Location).Path -ne $env:TEMP) { throw 'location lost' }; gate_alias; gate_fn; $global:gate_var",
        )?;
        if status != "True;7"
            || !terminal.captured[state_before..]
                .windows(b"GATE_FN".len())
                .any(|part| part == b"GATE_FN")
            || !terminal.captured[state_before..]
                .windows(b"kept".len())
                .any(|part| part == b"kept")
        {
            return Err(
                "PowerShell directory/alias/function/variable state did not persist".into(),
            );
        }
        println!("PASS PowerShell same-shell directory/alias/function/variable status={status}");
        let before = terminal.mark();
        let status = run_command(
            &mut terminal,
            flavor,
            &nonce,
            &mut seq,
            "(Get-Module PSReadLine).Version.ToString()",
        )?;
        if !terminal.captured[before..]
            .windows(b"2.".len())
            .any(|part| part == b"2.")
        {
            return Err(format!(
                "PSReadLine version was not observed in the ConPTY session: {:?}",
                String::from_utf8_lossy(&terminal.captured[before..])
            )
            .into());
        }
        println!("PASS PowerShell PSReadLine coexists with prompt hook; status={status}");
    }

    run_interrupt(&mut terminal, flavor, &nonce, &mut seq)?;
    run_attack(&mut terminal, flavor, &nonce, &mut seq)?;
    run_raw_input(&mut terminal, flavor)?;
    let exit_mark = terminal.mark();
    terminal.send(&format!("exit 9{}", flavor.line_end()))?;
    let exit_code = terminal.wait_exit()?;
    if exit_code != 9 {
        return Err(format!("exit 9 ended the PTY child with unexpected code {exit_code}").into());
    }
    while let Ok(chunk) = terminal.output.try_recv() {
        terminal.captured.extend_from_slice(&chunk);
    }
    if terminal.captured[exit_mark..]
        .windows(frame(&nonce, seq + 1, "end;").len())
        .any(|part| part == frame(&nonce, seq + 1, "end;"))
    {
        return Err("exit unexpectedly produced a completed-shell frame".into());
    }
    println!("PASS {flavor:?} exit 9 closed the session with code 9 and no end frame");
    Ok(())
}
