use std::env;
use std::error::Error;
use std::ffi::OsString;
use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::FromRawFd;
use std::os::unix::process::CommandExt;
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

use nono::{AccessMode, CapabilitySet, Sandbox};

fn directory(value: Option<OsString>) -> Result<PathBuf, Box<dyn Error>> {
    let path = value.ok_or("missing sandbox directory")?;
    let path = Path::new(&path);
    if !path.is_absolute() || !path.symlink_metadata()?.is_dir() {
        return Err("sandbox directory must be an absolute, existing directory".into());
    }
    Ok(path.canonicalize()?)
}

fn apply(caps: &CapabilitySet, seccomp_network: bool) -> Result<(), Box<dyn Error>> {
    if seccomp_network {
        #[cfg(target_os = "linux")]
        {
            Sandbox::apply_seccomp(caps, nono::SeccompOpts::network_baseline())?;
            return Ok(());
        }
        #[cfg(not(target_os = "linux"))]
        return Err("seccomp network baseline requires Linux".into());
    }
    Sandbox::apply_auto(caps)?;
    Ok(())
}

fn run(
    mut args: impl Iterator<Item = OsString>,
    receipt: &mut Option<File>,
) -> Result<i32, Box<dyn Error>> {
    let mut first = args.next();
    if first.as_deref() == Some("--probe".as_ref()) {
        let support = Sandbox::support_info();
        println!("{}", support.details);
        return if support.is_supported {
            Ok(0)
        } else {
            Err("host does not support the nono sandbox".into())
        };
    }
    let inherit_cwd = first.as_deref() == Some("--inherit-cwd".as_ref());
    if inherit_cwd {
        first = args.next();
    }
    let seccomp_network = first.as_deref() == Some("--seccomp-network".as_ref());
    if seccomp_network {
        first = args.next();
    }
    let workspace = directory(first)?;
    let temporary = directory(args.next())?;
    let node = PathBuf::from(args.next().ok_or("missing Node executable")?).canonicalize()?;
    if !node.is_file() || args.next().as_deref() != Some("--".as_ref()) {
        return Err("expected an executable path and -- before command".into());
    }
    let executable = args.next().ok_or("missing command executable")?;
    if !Path::new(&executable).is_absolute() {
        return Err("expected an absolute command executable".into());
    }
    let mut caps = CapabilitySet::new()
        .allow_path(&workspace, AccessMode::ReadWrite)?
        .allow_path(&temporary, AccessMode::ReadWrite)?
        .allow_file(&node, AccessMode::Read)?
        .allow_file("/dev/null", AccessMode::ReadWrite)?
        .allow_file("/dev/urandom", AccessMode::Read)?
        .block_network();
    for path in [
        "/bin",
        "/sbin",
        "/lib",
        "/lib64",
        "/usr",
        "/etc",
        "/System",
        "/Library/Apple",
        "/private/var/select",
    ] {
        if Path::new(path).exists() {
            caps = caps.allow_path(path, AccessMode::Read)?;
        }
    }
    if inherit_cwd {
        if !env::current_dir()?.starts_with(&workspace) {
            return Err("reviewed working directory is outside the sandbox workspace".into());
        }
    } else {
        env::set_current_dir(&workspace)?;
    }
    apply(&caps, seccomp_network)?;
    let mut command = Command::new(executable);
    command.args(args);
    if let Some(mut receipt) = receipt.take() {
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                receipt.write_all(b"F")?;
                return Err(error.into());
            }
        };
        receipt.write_all(b"S")?;
        drop(receipt);
        let status = child.wait()?;
        return Ok(status
            .code()
            .unwrap_or_else(|| 128 + status.signal().unwrap_or(0)));
    }
    Err(command.exec().into())
}

fn entry() -> Result<i32, Box<dyn Error>> {
    let mut args = env::args_os().skip(1).peekable();
    let mut receipt = None;
    if args.next_if(|arg| arg == "--receipt-fd").is_some() {
        let fd: i32 = args
            .next()
            .ok_or("missing receipt descriptor")?
            .into_string()
            .map_err(|_| "invalid receipt descriptor")?
            .parse()?;
        if fd < 3 || unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
            return Err("could not isolate receipt descriptor".into());
        }
        receipt = Some(unsafe { File::from_raw_fd(fd) });
    }
    if args.next_if(|arg| arg == "--gate-fd").is_some() {
        let fd: i32 = args
            .next()
            .ok_or("missing launch gate descriptor")?
            .into_string()
            .map_err(|_| "invalid launch gate descriptor")?
            .parse()?;
        if fd < 3 || unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
            return Err("could not isolate launch gate descriptor".into());
        }
        let mut gate = unsafe { File::from_raw_fd(fd) };
        let mut permit = [0];
        if gate.read_exact(&mut permit).is_err() || permit != *b"G" {
            return Err("application closed the launch gate without authorization".into());
        }
    }
    let result = run(args, &mut receipt);
    if result.is_err() {
        if let Some(file) = receipt.as_mut() {
            file.write_all(b"F")?;
        }
    }
    result
}

fn main() -> ExitCode {
    match entry() {
        Ok(code) => ExitCode::from(code as u8),
        Err(error) => {
            eprintln!("sandbox launcher: {error}");
            ExitCode::from(125)
        }
    }
}
