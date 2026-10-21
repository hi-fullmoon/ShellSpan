use crate::terminal_integration::TerminalShellKind;
use portable_pty::MasterPty;
use std::io::Write;

pub(crate) fn take_writer(
    master: &dyn MasterPty,
    shell: TerminalShellKind,
) -> Result<Box<dyn Write + Send>, String> {
    let writer = master.take_writer().map_err(|error| error.to_string())?;
    #[cfg(target_os = "macos")]
    {
        if shell != TerminalShellKind::Bash {
            return Ok(writer);
        }
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
    {
        let _ = shell;
        Ok(writer)
    }
}

#[cfg(target_os = "macos")]
struct MacOsInput {
    writer: Box<dyn Write + Send>,
    terminal: std::fs::File,
}

#[cfg(all(test, target_os = "macos"))]
#[derive(Clone, Copy, Default)]
struct InterruptTrace {
    phase: u8,
    flags: libc::tcflag_t,
    intr: u8,
    foreground: libc::pid_t,
    session: libc::pid_t,
    count: i32,
    info_bytes: i32,
    run_state: i32,
    output_pending: i32,
    polls: u32,
    permission_error: i32,
}

#[cfg(all(test, target_os = "macos"))]
thread_local! {
    static INTERRUPT_TRACE: std::cell::Cell<Option<InterruptTrace>> = const { std::cell::Cell::new(None) };
}

#[cfg(all(test, target_os = "macos"))]
fn trace(update: impl FnOnce(&mut InterruptTrace)) {
    INTERRUPT_TRACE.with(|last| {
        let mut value = last.get().unwrap_or_default();
        update(&mut value);
        last.set(Some(value));
    });
}

#[cfg(all(test, target_os = "macos"))]
pub(crate) fn interrupt_diagnostic() -> String {
    INTERRUPT_TRACE.with(|last| {
        let value = last.get().unwrap_or_default();
        format!("phase={} flags={} intr={} foreground={} session={} thread_bytes={} info_bytes={} run_state={} output_pending={} polls={} inspection_error={}",
            value.phase, value.flags, value.intr, value.foreground, value.session, value.count, value.info_bytes, value.run_state, value.output_pending, value.polls, value.permission_error)
    })
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
    #[cfg(test)]
    trace(|state| {
        state.phase = 1;
        state.flags = modes.c_lflag;
        state.intr = intr;
    });
    if modes.c_lflag & libc::ISIG == 0
        || modes.c_lflag & (libc::ICANON | libc::ECHO) != 0
        || intr == libc::_POSIX_VDISABLE
        || input[0] != intr
    {
        return None;
    }
    let foreground = unsafe { libc::tcgetpgrp(fd) };
    let session = unsafe { libc::tcgetsid(fd) };
    #[cfg(test)]
    trace(|state| {
        state.phase = 2;
        state.foreground = foreground;
        state.session = session;
    });
    (foreground > 0 && foreground == session).then_some((foreground, modes))
}

#[cfg(target_os = "macos")]
fn input_thread_waiting(fd: std::os::fd::RawFd, pid: libc::pid_t) -> Option<bool> {
    let mut pending: libc::c_int = 0;
    if unsafe { libc::ioctl(fd, libc::TIOCOUTQ, &mut pending) } != 0 {
        return None;
    }
    #[cfg(test)]
    trace(|state| state.output_pending = pending);
    if pending != 0 {
        return Some(false);
    }
    // PROC_PIDLISTTHREADS is defined as flavor 6 in macOS sys/proc_info.h.
    const PROC_PIDLISTTHREADS: libc::c_int = 6;
    let mut threads = [0_u64; 2];
    let count = unsafe {
        libc::proc_pidinfo(
            pid,
            PROC_PIDLISTTHREADS,
            0,
            threads.as_mut_ptr().cast(),
            std::mem::size_of_val(&threads) as libc::c_int,
        )
    };
    #[cfg(test)]
    trace(|state| {
        state.phase = 3;
        state.count = count;
    });
    if count as usize != std::mem::size_of::<u64>() || threads[0] == 0 {
        return None;
    }
    let mut info = std::mem::MaybeUninit::<libc::proc_threadinfo>::uninit();
    let size = std::mem::size_of::<libc::proc_threadinfo>();
    let received = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTHREADINFO,
            threads[0],
            info.as_mut_ptr().cast(),
            size as libc::c_int,
        )
    };
    #[cfg(test)]
    trace(|state| state.info_bytes = received);
    if received as usize != size {
        return None;
    }
    let info = unsafe { info.assume_init() };
    #[cfg(test)]
    trace(|state| state.run_state = info.pth_run_state);
    Some(info.pth_run_state == libc::TH_STATE_WAITING)
}

#[cfg(target_os = "macos")]
impl Write for MacOsInput {
    fn write(&mut self, input: &[u8]) -> std::io::Result<usize> {
        use std::os::fd::AsRawFd;
        let fd = self.terminal.as_raw_fd();
        #[cfg(test)]
        if input == b"\x03" {
            INTERRUPT_TRACE.with(|last| last.set(None));
        }
        if let Some((group, _)) = readline_interrupt(fd, input) {
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(50);
            let mut was_waiting = false;
            // Legacy Readline can longjmp out of fileno() on SIGINT, leaving a
            // libc FILE lock inherited by its next command-substitution child.
            // Serialize the interrupt with the single Bash thread's idle input
            // wait, outside redisplay/stdio, then use the native line discipline.
            loop {
                if readline_interrupt(fd, input).map(|state| state.0) != Some(group) {
                    break;
                }
                #[cfg(test)]
                trace(|state| state.polls += 1);
                match input_thread_waiting(fd, group) {
                    Some(true) if was_waiting => {
                        #[cfg(test)]
                        trace(|state| state.phase = 5);
                        break;
                    }
                    None => break,
                    Some(true) => was_waiting = true,
                    Some(false) => was_waiting = false,
                }
                if std::time::Instant::now() >= deadline {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(1));
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
        let mut writer = take_writer(pair.master.as_ref(), TerminalShellKind::Bash).unwrap();
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
            let deadline = Instant::now() + Duration::from_secs(15);
            while input_thread_waiting(fd, group) != Some(true) {
                assert!(
                    Instant::now() < deadline,
                    "Bash did not reach a verified idle input wait: {}",
                    interrupt_diagnostic()
                );
                std::thread::sleep(Duration::from_millis(1));
            }
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
