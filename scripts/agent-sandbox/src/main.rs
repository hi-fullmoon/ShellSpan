use std::env;
use std::error::Error;
use std::ffi::{CStr, OsString};
use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::FromRawFd;
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

use nono::{AccessMode, CapabilitySet, Sandbox, UnixSocketMode};

const MAX_POLICY_BYTES: usize = 64 * 1024;
const MAX_SANDBOX_FILE_BYTES: libc::rlim_t = 512 * 1024 * 1024;
const MAX_SANDBOX_OPEN_FILES: libc::rlim_t = 1024;

fn clamp_rlimit(resource: libc::c_int, max_value: libc::rlim_t) -> Result<(), Box<dyn Error>> {
    let mut current = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    if unsafe { libc::getrlimit(resource, &mut current) } != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let next_max = if current.rlim_max == libc::RLIM_INFINITY {
        max_value
    } else {
        current.rlim_max.min(max_value)
    };
    let next_cur = if current.rlim_cur == libc::RLIM_INFINITY {
        next_max
    } else {
        current.rlim_cur.min(next_max)
    };
    let updated = libc::rlimit {
        rlim_cur: next_cur,
        rlim_max: next_max,
    };
    if unsafe { libc::setrlimit(resource, &updated) } != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}

fn apply_resource_limits() -> Result<(), Box<dyn Error>> {
    clamp_rlimit(libc::RLIMIT_CORE, 0)?;
    clamp_rlimit(libc::RLIMIT_FSIZE, MAX_SANDBOX_FILE_BYTES)?;
    clamp_rlimit(libc::RLIMIT_NOFILE, MAX_SANDBOX_OPEN_FILES)?;
    Ok(())
}

#[derive(Default, Debug, PartialEq, Eq)]
struct ExtraPolicy {
    read_files: Vec<PathBuf>,
    read_paths: Vec<PathBuf>,
    write_paths: Vec<PathBuf>,
    unix_sockets: Vec<PathBuf>,
    allow_tty: bool,
    proxy_port: Option<u16>,
}

fn parse_policy(text: &str) -> Result<ExtraPolicy, Box<dyn Error>> {
    let mut lines = text
        .lines()
        .map(|line| line.trim_end_matches(['\r', '\n']))
        .filter(|line| !line.is_empty());
    if lines.next() != Some("version:1") {
        return Err("unsupported sandbox policy version".into());
    }
    let mut policy = ExtraPolicy::default();
    for line in lines {
        let Some((key, value)) = line.split_once(':') else {
            return Err("invalid sandbox policy directive".into());
        };
        match key {
            "read-file" => policy.read_files.push(PathBuf::from(value)),
            "read-path" => policy.read_paths.push(PathBuf::from(value)),
            "write-path" => policy.write_paths.push(PathBuf::from(value)),
            "unix-socket" => policy.unix_sockets.push(PathBuf::from(value)),
            "tty" if value == "allow" => policy.allow_tty = true,
            "network" if value == "block" => policy.proxy_port = None,
            "network" if value.starts_with("proxy:") => {
                let port: u16 = value
                    .strip_prefix("proxy:")
                    .unwrap_or_default()
                    .parse()
                    .map_err(|_| "invalid sandbox proxy port")?;
                if port == 0 {
                    return Err("sandbox proxy port must be non-zero".into());
                }
                policy.proxy_port = Some(port);
            }
            _ => return Err(format!("unsupported sandbox policy directive: {key}").into()),
        }
    }
    Ok(policy)
}

fn current_stdin_tty_path() -> Option<PathBuf> {
    let mut buf = [0 as libc::c_char; 256];
    let rc = unsafe { libc::ttyname_r(0, buf.as_mut_ptr(), buf.len()) };
    if rc != 0 {
        return None;
    }
    let name = unsafe { CStr::from_ptr(buf.as_ptr()) }.to_str().ok()?;
    let valid = name.starts_with("/dev/ttys")
        || name.starts_with("/dev/pts/")
        || name.starts_with("/dev/pty");
    valid.then(|| PathBuf::from(name))
}

fn directory(value: Option<OsString>) -> Result<PathBuf, Box<dyn Error>> {
    let path = value.ok_or("missing sandbox directory")?;
    let path = Path::new(&path);
    if !path.is_absolute() || !path.symlink_metadata()?.is_dir() {
        return Err("sandbox directory must be an absolute, existing directory".into());
    }
    Ok(path.canonicalize()?)
}

fn readable_file(value: &Path) -> Result<PathBuf, Box<dyn Error>> {
    if !value.is_absolute() {
        return Err("readable file path must be absolute".into());
    }
    let path = value.canonicalize()?;
    if !path.is_file() {
        return Err("readable file path must refer to a file".into());
    }
    Ok(path)
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
    mut extra_policy: ExtraPolicy,
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
    let mut inherit_cwd = false;
    let mut seccomp_network = false;
    while let Some(arg) = first.as_deref() {
        if arg == "--inherit-cwd" {
            inherit_cwd = true;
            first = args.next();
        } else if arg == "--seccomp-network" {
            seccomp_network = true;
            first = args.next();
        } else if arg == "--read-file" {
            let value = args.next().ok_or("missing --read-file path")?;
            extra_policy.read_files.push(PathBuf::from(value));
            first = args.next();
        } else if arg == "--read-path" {
            let value = args.next().ok_or("missing --read-path path")?;
            extra_policy.read_paths.push(PathBuf::from(value));
            first = args.next();
        } else if arg == "--unix-socket" {
            let value = args.next().ok_or("missing --unix-socket path")?;
            extra_policy.unix_sockets.push(PathBuf::from(value));
            first = args.next();
        } else if arg == "--allow-tty" {
            extra_policy.allow_tty = true;
            first = args.next();
        } else if arg == "--proxy-port" {
            let value = args
                .next()
                .ok_or("missing --proxy-port value")?
                .into_string()
                .map_err(|_| "invalid --proxy-port value")?;
            let port: u16 = value.parse().map_err(|_| "invalid --proxy-port number")?;
            if port == 0 {
                return Err("--proxy-port must be non-zero".into());
            }
            extra_policy.proxy_port = Some(port);
            first = args.next();
        } else {
            break;
        }
    }
    let workspace = directory(first)?;
    let temporary = directory(args.next())?;
    if args.next().as_deref() != Some("--".as_ref()) {
        return Err("expected -- before command".into());
    }
    let executable = args.next().ok_or("missing command executable")?;
    if !Path::new(&executable).is_absolute() {
        return Err("expected an absolute command executable".into());
    }
    let mut caps = CapabilitySet::new()
        .allow_path(&workspace, AccessMode::ReadWrite)?
        .allow_path(&temporary, AccessMode::ReadWrite)?
        .allow_file("/dev/null", AccessMode::ReadWrite)?
        .allow_file("/dev/urandom", AccessMode::Read)?;
    caps = match extra_policy.proxy_port {
        Some(port) => caps.proxy_only(port).block_dns(),
        None => caps.block_network(),
    };
    for device in ["/dev/zero", "/dev/random"] {
        if Path::new(device).exists() {
            caps = caps.allow_file(device, AccessMode::Read)?;
        }
    }
    for file in &extra_policy.read_files {
        caps = caps.allow_file(readable_file(file)?, AccessMode::Read)?;
    }
    for path in &extra_policy.read_paths {
        caps = caps.allow_path(
            directory(Some(path.as_os_str().to_owned()))?,
            AccessMode::Read,
        )?;
    }
    for path in &extra_policy.write_paths {
        caps = caps.allow_path(
            directory(Some(path.as_os_str().to_owned()))?,
            AccessMode::ReadWrite,
        )?;
    }
    for socket in &extra_policy.unix_sockets {
        if !socket.is_absolute() {
            return Err("unix socket path must be absolute".into());
        }
        caps = caps.allow_unix_socket(socket, UnixSocketMode::Connect)?;
    }
    if extra_policy.allow_tty {
        if Path::new("/dev/tty").exists() {
            caps = caps.allow_file("/dev/tty", AccessMode::ReadWrite)?;
        }
        if let Some(tty_path) = current_stdin_tty_path() {
            if tty_path.exists() {
                caps = caps.allow_file(&tty_path, AccessMode::ReadWrite)?;
            }
        }
    }
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
    apply_resource_limits()?;
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
    if args.next_if(|arg| arg == "--gate-socket").is_some() {
        let socket_path = args.next().ok_or("missing launch gate socket path")?;
        let socket_path = Path::new(&socket_path);
        if !socket_path.is_absolute() {
            return Err("launch gate socket path must be absolute".into());
        }
        let mut gate = UnixStream::connect(socket_path)
            .map_err(|error| format!("failed to connect launch gate socket: {error}"))?;
        let mut permit = [0];
        if gate.read_exact(&mut permit).is_err() || permit != *b"G" {
            return Err("application closed the launch gate socket without authorization".into());
        }
    }
    let result = (|| -> Result<i32, Box<dyn Error>> {
        let mut extra_policy = ExtraPolicy::default();
        if args.next_if(|arg| arg == "--policy-fd").is_some() {
            let fd: i32 = args
                .next()
                .ok_or("missing policy descriptor")?
                .into_string()
                .map_err(|_| "invalid policy descriptor")?
                .parse()?;
            if fd < 3 || unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
                return Err("could not isolate policy descriptor".into());
            }
            let file = unsafe { File::from_raw_fd(fd) };
            let mut raw = Vec::new();
            file.take((MAX_POLICY_BYTES + 1) as u64)
                .read_to_end(&mut raw)?;
            if raw.len() > MAX_POLICY_BYTES {
                return Err("sandbox policy exceeds size limit".into());
            }
            let text = String::from_utf8(raw)?;
            extra_policy = parse_policy(&text)?;
        }
        run(args, &mut receipt, extra_policy)
    })();
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_policy_accepts_valid_v1_directives() {
        let policy = parse_policy(
            "version:1\nread-file:/usr/bin/env\nread-path:/opt/homebrew\nwrite-path:/tmp/ws\nnetwork:block\n",
        )
        .unwrap();
        assert_eq!(policy.read_files, vec![PathBuf::from("/usr/bin/env")]);
        assert_eq!(policy.read_paths, vec![PathBuf::from("/opt/homebrew")]);
        assert_eq!(policy.write_paths, vec![PathBuf::from("/tmp/ws")]);
        assert_eq!(policy.proxy_port, None);

        let proxy_policy = parse_policy(
            "version:1\nnetwork:proxy:45678\ntty:allow\nunix-socket:/tmp/ss-nip/control\n",
        )
        .unwrap();
        assert_eq!(proxy_policy.proxy_port, Some(45678));
        assert!(proxy_policy.allow_tty);
        assert_eq!(
            proxy_policy.unix_sockets,
            vec![PathBuf::from("/tmp/ss-nip/control")]
        );
    }

    #[test]
    fn parse_policy_rejects_unknown_version_directive_or_network_mode() {
        assert!(parse_policy("version:2\n").is_err());
        assert!(parse_policy("version:1\nunknown:/tmp\n").is_err());
        assert!(parse_policy("version:1\nnetwork:allow\n").is_err());
        assert!(parse_policy("version:1\nnetwork:proxy:0\n").is_err());
        assert!(parse_policy("version:1\ntty:deny\n").is_err());
        assert!(parse_policy("version:1\nmalformed-line\n").is_err());
    }
}
