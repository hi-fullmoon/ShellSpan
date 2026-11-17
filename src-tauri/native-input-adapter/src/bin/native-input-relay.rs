//! Private SSH transport only. This process never evaluates or injects source.
use std::{
    fs,
    io::{self, BufRead, Read, Write},
    os::unix::{
        fs::{OpenOptionsExt, PermissionsExt},
        net::UnixListener,
    },
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant},
};

fn write_tty_reply(socket: &Path, frame: &[u8]) -> io::Result<()> {
    let Ok(line) = std::str::from_utf8(frame) else {
        return Ok(());
    };
    let Some((ticket, decision)) = line.trim_end_matches('\n').split_once(' ') else {
        return Ok(());
    };
    let Ok(ticket) = ticket.parse::<u32>() else {
        return Ok(());
    };
    if !(1..=i32::MAX as u32).contains(&ticket) || !matches!(decision, "0" | "1" | "2") {
        return Ok(());
    }
    let mut path = socket.as_os_str().to_os_string();
    path.push(format!(".tty-reply-{ticket}-{decision}"));
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    Ok(())
}

fn forward_input(
    mut stdin: impl BufRead,
    mut outgoing: impl Write,
    socket: &Path,
) -> io::Result<()> {
    // The existing NIP transport is newline-delimited JSON. Consume each
    // recovery response here and pass all NIP frames through byte for byte.
    const MAX_LINE_BYTES: u64 = 131_073;
    let mut frame = Vec::new();
    loop {
        frame.clear();
        if (&mut stdin)
            .take(MAX_LINE_BYTES)
            .read_until(b'\n', &mut frame)?
            == 0
        {
            return Ok(());
        }
        if frame.last() != Some(&b'\n') {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "incomplete private control line",
            ));
        }
        if let Some(reply) = frame.strip_prefix(b"TTY-RECOVERY ") {
            // A duplicate or expired reply is best effort. It cannot close NIP.
            let _ = write_tty_reply(socket, reply);
        } else {
            outgoing.write_all(&frame)?;
        }
    }
}

fn run() -> io::Result<()> {
    let mut args = std::env::args_os().skip(1);
    let path = PathBuf::from(
        args.next()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "socket path required"))?,
    );
    if args.next().is_some()
        || !path.is_absolute()
        || !fs::metadata(path.parent().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "socket parent required")
        })?)?
        .is_dir()
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid private socket",
        ));
    }
    let listener = UnixListener::bind(&path)?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    listener.set_nonblocking(true)?;
    let deadline = Instant::now() + Duration::from_secs(5);
    let socket = loop {
        match listener.accept() {
            Ok((socket, _)) => break socket,
            Err(error)
                if error.kind() == io::ErrorKind::WouldBlock && Instant::now() < deadline =>
            {
                thread::sleep(Duration::from_millis(5))
            }
            Err(error) => return Err(error),
        }
    };
    // Darwin can pass the listener's nonblocking mode to the accepted socket.
    // The relay threads need blocking I/O for normal idle periods and writes.
    socket.set_nonblocking(false)?;
    let mut outgoing = socket.try_clone()?;
    let mut incoming = socket;
    // Kernel pipe/socket queues supply bounded backpressure in both directions.
    // stdin EOF closes the private peer, so it cannot arm a late accept.
    let reply_socket = path.clone();
    thread::spawn(move || {
        let _ = forward_input(io::stdin().lock(), &mut outgoing, &reply_socket);
        let _ = outgoing.shutdown(std::net::Shutdown::Both);
    });
    let mut stdout = io::stdout().lock();
    let mut bytes = [0; 8192];
    loop {
        let count = incoming.read(&mut bytes)?;
        if count == 0 {
            break;
        }
        stdout.write_all(&bytes[..count])?;
        stdout.flush()?;
    }
    let _ = incoming.shutdown(std::net::Shutdown::Both);
    let _ = fs::remove_file(path);
    Ok(())
}
fn main() {
    if run().is_err() {
        std::process::exit(1);
    }
}
