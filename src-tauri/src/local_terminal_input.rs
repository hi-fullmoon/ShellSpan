use portable_pty::MasterPty;
use std::io::Write;

pub(crate) fn take_writer(master: &dyn MasterPty) -> Result<Box<dyn Write + Send>, String> {
    let writer = master.take_writer().map_err(|error| error.to_string())?;
    #[cfg(target_os = "macos")]
    {
        use std::os::fd::FromRawFd;
        let fd = master
            .as_raw_fd()
            .ok_or("local PTY descriptor is missing")?;
        let owned = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 3) };
        if owned < 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(Box::new(MacOsInput {
            writer,
            terminal: unsafe { std::fs::File::from_raw_fd(owned) },
        }))
    }
    #[cfg(not(target_os = "macos"))]
    Ok(writer)
}

#[cfg(target_os = "macos")]
struct MacOsInput {
    writer: Box<dyn Write + Send>,
    terminal: std::fs::File,
}

#[cfg(target_os = "macos")]
fn readline_interrupt(
    fd: std::os::fd::RawFd,
    input: &[u8],
) -> Option<(libc::pid_t, libc::termios)> {
    if input.len() != 1 {
        return None;
    }
    let mut modes = std::mem::MaybeUninit::<libc::termios>::uninit();
    if unsafe { libc::tcgetattr(fd, modes.as_mut_ptr()) } != 0 {
        return None;
    }
    let modes = unsafe { modes.assume_init() };
    let intr = modes.c_cc[libc::VINTR];
    if modes.c_lflag & libc::ISIG == 0
        || modes.c_lflag & (libc::ICANON | libc::ECHO) != 0
        || intr == libc::_POSIX_VDISABLE
        || input[0] != intr
    {
        return None;
    }
    let foreground = unsafe { libc::tcgetpgrp(fd) };
    let session = unsafe { libc::tcgetsid(fd) };
    (foreground > 0 && foreground == session).then_some((foreground, modes))
}

#[cfg(target_os = "macos")]
fn foreground_members(group: libc::pid_t) -> Option<Vec<libc::pid_t>> {
    let mut members = vec![0 as libc::pid_t; 4096];
    let capacity = std::mem::size_of_val(members.as_slice());
    // libproc's convenience function returns a PID count, not a byte count.
    let count = unsafe {
        libc::proc_listpgrppids(group, members.as_mut_ptr().cast(), capacity as libc::c_int)
    };
    if count <= 0 || count as usize >= members.len() {
        return None;
    }
    members.truncate(count as usize);
    members.retain(|pid| {
        *pid > 0 && unsafe { libc::getpgid(*pid) == group && libc::getsid(*pid) == group }
    });
    members.sort_unstable();
    members.dedup();
    if !members.contains(&group) {
        return None;
    }
    // Probe permission before delivering anything. Native PTY input remains the
    // fallback for another uid or an incomplete process-group snapshot.
    if members
        .iter()
        .any(|pid| unsafe { libc::kill(*pid, 0) } != 0)
    {
        return None;
    }
    // Deliver to existing peers before the shell can fork its next prompt's
    // command substitutions. Those new children must not receive this SIGINT.
    members.sort_by_key(|pid| *pid == group);
    Some(members)
}

#[cfg(target_os = "macos")]
impl Write for MacOsInput {
    fn write(&mut self, input: &[u8]) -> std::io::Result<usize> {
        use std::os::fd::AsRawFd;
        let fd = self.terminal.as_raw_fd();
        if let Some((group, _)) = readline_interrupt(fd, input) {
            if let Some(members) = foreground_members(group) {
                if let Some((current_group, modes)) = readline_interrupt(fd, input) {
                    if current_group == group {
                        if modes.c_lflag & libc::NOFLSH == 0
                            && unsafe { libc::tcflush(fd, libc::TCIOFLUSH) } != 0
                        {
                            return Err(std::io::Error::last_os_error());
                        }
                        for pid in members {
                            // Skip peers that exited or left this terminal's
                            // foreground group after the snapshot.
                            if unsafe { libc::getpgid(pid) } != group
                                || unsafe { libc::getsid(pid) } != group
                            {
                                continue;
                            }
                            if unsafe { libc::kill(pid, libc::SIGINT) } != 0 {
                                let error = std::io::Error::last_os_error();
                                if error.raw_os_error() != Some(libc::ESRCH) {
                                    return Err(error);
                                }
                            }
                        }
                        return Ok(input.len());
                    }
                }
            }
        }
        self.writer.write(input)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.writer.flush()
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    use std::io::Read;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    #[test]
    fn macos_interrupt_routing_preserves_native_tty_controls() {
        let pair = native_pty_system().openpty(PtySize::default()).unwrap();
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = take_writer(pair.master.as_ref()).unwrap();
        let mut command = CommandBuilder::new("/bin/bash");
        command.args(["--noprofile", "--norc", "-i"]);
        command.env("PS1", "input-probe$ ");
        command.env("BASH_SILENCE_DEPRECATION_WARNING", "1");
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let (sender, receiver) = mpsc::channel();
        let output = std::thread::spawn(move || {
            let mut buffer = [0; 4096];
            while let Ok(size) = reader.read(&mut buffer) {
                if size == 0 || sender.send(buffer[..size].to_vec()).is_err() {
                    break;
                }
            }
        });
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let fd = pair.master.as_raw_fd().unwrap();
            let deadline = Instant::now() + Duration::from_secs(15);
            let mut bytes = Vec::new();
            while !String::from_utf8_lossy(&bytes).contains("input-probe$ ") {
                bytes.extend(
                    receiver
                        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                        .unwrap(),
                );
            }
            let (group, original) = loop {
                if let Some(state) = readline_interrupt(fd, b"\x03") {
                    break state;
                }
                assert!(
                    Instant::now() < deadline,
                    "shell did not enter its Readline input mode"
                );
                std::thread::sleep(Duration::from_millis(1));
            };
            assert_eq!(group as u32, child.process_id().unwrap());
            assert!(foreground_members(group).unwrap().contains(&group));
            assert!(readline_interrupt(fd, b"x").is_none());
            assert!(readline_interrupt(fd, b"\x03x").is_none());
            let mut modes = original;
            modes.c_cc[libc::VINTR] = 24;
            assert_eq!(unsafe { libc::tcsetattr(fd, libc::TCSANOW, &modes) }, 0);
            assert!(readline_interrupt(fd, b"\x03").is_none());
            assert!(readline_interrupt(fd, b"\x18").is_some());
            modes.c_cc[libc::VINTR] = libc::_POSIX_VDISABLE;
            assert_eq!(unsafe { libc::tcsetattr(fd, libc::TCSANOW, &modes) }, 0);
            assert!(readline_interrupt(fd, &[libc::_POSIX_VDISABLE]).is_none());
            modes.c_cc[libc::VINTR] = 24;
            modes.c_lflag &= !libc::ISIG;
            assert_eq!(unsafe { libc::tcsetattr(fd, libc::TCSANOW, &modes) }, 0);
            assert!(readline_interrupt(fd, b"\x18").is_none());
            modes.c_lflag |= libc::ISIG | libc::ICANON | libc::ECHO;
            assert_eq!(unsafe { libc::tcsetattr(fd, libc::TCSANOW, &modes) }, 0);
            assert!(readline_interrupt(fd, b"\x18").is_none());
            assert_eq!(unsafe { libc::tcsetattr(fd, libc::TCSANOW, &original) }, 0);
            writer.write_all(b"typed-input").unwrap();
            writer.flush().unwrap();
            let deadline = Instant::now() + Duration::from_secs(15);
            while !String::from_utf8_lossy(&bytes).contains("typed-input") {
                bytes.extend(
                    receiver
                        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                        .unwrap(),
                );
            }
            writer.write_all(b"\x03").unwrap();
            writer.flush().unwrap();
            let deadline = Instant::now() + Duration::from_secs(15);
            while String::from_utf8_lossy(&bytes)
                .matches("input-probe$ ")
                .count()
                < 2
            {
                bytes.extend(
                    receiver
                        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                        .unwrap(),
                );
            }
            writer.write_all(b"printf 'INPUT-PROBE-OK\\n'\r").unwrap();
            writer.flush().unwrap();
            let deadline = Instant::now() + Duration::from_secs(15);
            while !String::from_utf8_lossy(&bytes).contains("INPUT-PROBE-OK\r\n") {
                bytes.extend(
                    receiver
                        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                        .unwrap(),
                );
            }
            assert!(child.try_wait().unwrap().is_none());
        }));
        if child.try_wait().unwrap().is_none() {
            child.kill().unwrap();
        }
        child.wait().unwrap();
        drop(writer);
        drop(pair.master);
        output.join().unwrap();
        if let Err(error) = result {
            std::panic::resume_unwind(error);
        }
    }
}
