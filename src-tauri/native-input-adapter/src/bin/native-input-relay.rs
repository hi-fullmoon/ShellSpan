//! Private SSH transport only. This process never evaluates or injects source.
use std::{
    fs,
    io::{self, Read, Write},
    os::unix::{fs::PermissionsExt, net::UnixListener},
    path::PathBuf,
    thread,
    time::{Duration, Instant},
};

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
    let mut outgoing = socket.try_clone()?;
    let mut incoming = socket;
    // Kernel pipe/socket queues supply bounded backpressure in both directions.
    // stdin EOF closes the private peer, so it cannot arm a late accept.
    thread::spawn(move || {
        let mut stdin = io::stdin().lock();
        let _ = io::copy(&mut stdin, &mut outgoing);
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
