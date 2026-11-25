use std::borrow::Cow;
use std::future::Future;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use russh_sftp::{
    client::{error::Error as ClientError, RawSftpSession},
    protocol::{FileAttributes, OpenFlags, StatusCode},
};
use ssh2::{Error, ErrorCode, FileStat};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    runtime::Runtime,
    time::{sleep, Sleep},
};
use uuid::Uuid;

use super::{
    ensure_verified, invalidate_verify_cache, open_channel, read_frame, send_frame, setup, Binding,
    Control, Mode, Policy, Reply, OUTSIDE, POLICY_VERSION,
};
use crate::{db::Database, models::RemoteConnectionRequest};

const IO_CHUNK: usize = 32 * 1024;
const DIRECTORY_LIMIT: usize = 10_000;

// Only transports bytes. Version negotiation, packet framing, and request IDs
// belong to russh-sftp, which runs over the already authenticated SSH channel.
struct ChannelIo {
    channel: ssh2::Channel,
    read_wait: Option<Pin<Box<Sleep>>>,
    write_wait: Option<Pin<Box<Sleep>>>,
}

fn ready(wait: &mut Option<Pin<Box<Sleep>>>, cx: &mut Context<'_>) -> bool {
    if let Some(timer) = wait {
        if timer.as_mut().poll(cx).is_pending() {
            return false;
        }
        *wait = None;
    }
    true
}

fn defer<T>(wait: &mut Option<Pin<Box<Sleep>>>, cx: &mut Context<'_>) -> Poll<io::Result<T>> {
    let mut timer = Box::pin(sleep(super::POLL));
    let _ = timer.as_mut().poll(cx);
    *wait = Some(timer);
    Poll::Pending
}

impl AsyncRead for ChannelIo {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if !ready(&mut self.read_wait, cx) {
            return Poll::Pending;
        }
        match self.channel.read(buf.initialize_unfilled()) {
            Ok(n) => {
                buf.advance(n);
                Poll::Ready(Ok(()))
            }
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => defer(&mut self.read_wait, cx),
            Err(e) => Poll::Ready(Err(e)),
        }
    }
}

impl AsyncWrite for ChannelIo {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        if !ready(&mut self.write_wait, cx) {
            return Poll::Pending;
        }
        match self.channel.write(buf) {
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => defer(&mut self.write_wait, cx),
            result => Poll::Ready(result),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        if !ready(&mut self.write_wait, cx) {
            return Poll::Pending;
        }
        match self.channel.send_eof() {
            Err(e) if e.code() == ErrorCode::Session(libssh2_sys::LIBSSH2_ERROR_EAGAIN) => {
                defer(&mut self.write_wait, cx)
            }
            result => Poll::Ready(result.map_err(io::Error::other)),
        }
    }
}

pub(crate) struct SandboxSftp {
    sftp: RawSftpSession,
    runtime: Runtime,
    control: Control,
    _ssh: Option<super::SandboxSession>,
}

impl SandboxSftp {
    fn start(
        session: &ssh2::Session,
        policy: &Policy,
        control: &Control,
        binding: Option<(&Database, &Binding, &Path)>,
        probe_file: Option<&str>,
    ) -> Result<Self, String> {
        let mut channel = open_channel(session, control)?;
        let mut request = policy.request("sftp");
        if let Some(name) = probe_file {
            request["probeFile"] = serde_json::json!(name);
        }
        send_frame(&mut channel, control, &request, |c, bytes| match binding {
            Some((db, binding, known_hosts)) => binding.write(db, known_hosts, || {
                if control.check().is_err() {
                    return Err(io::ErrorKind::Interrupted.into());
                }
                c.write(bytes)
            }),
            None => Ok(c.write(bytes)),
        })?;
        if !matches!(
            read_frame(&mut channel, control, &mut Vec::new())?,
            Reply::Sftp {
                version: POLICY_VERSION
            }
        ) {
            return Err("SANDBOX_SFTP_UNAVAILABLE".into());
        }
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .map_err(|_| "SANDBOX_SFTP_UNAVAILABLE")?;
        let sftp = runtime.block_on(async {
            RawSftpSession::new(ChannelIo {
                channel,
                read_wait: None,
                write_wait: None,
            })
        });
        let result = Self {
            sftp,
            runtime,
            control: control.clone(),
            _ssh: None,
        };
        let version = result
            .wait(result.sftp.init())
            .map_err(|_| "SANDBOX_SFTP_UNAVAILABLE: could not negotiate OpenSSH SFTP")?;
        if version.version != 3 {
            return Err("SANDBOX_SFTP_VERSION_MISMATCH".into());
        }
        Ok(result)
    }

    pub(crate) fn connect(
        db: &Database,
        binding: &Binding,
        connection: &RemoteConnectionRequest,
        known_hosts: &Path,
        control: Control,
    ) -> Result<Self, String> {
        let policy = binding
            .state
            .policy
            .as_ref()
            .ok_or("SANDBOX_POLICY_CHANGED")?;
        binding.check(db, known_hosts)?;
        let session = setup(connection, known_hosts, &control)?;
        let preflight = Control::new(
            control
                .deadline
                .min(Instant::now() + Duration::from_secs(25)),
            control.cancelled.clone(),
        );
        ensure_verified(&session.ssh.target, binding, policy, &preflight)?;
        let mut sftp = Self::start(
            &session.ssh.target,
            policy,
            &control,
            Some((db, binding, known_hosts)),
            None,
        )
        .inspect_err(|_| invalidate_verify_cache(&binding.profile_id))?;
        sftp._ssh = Some(session);
        Ok(sftp)
    }

    fn wait<T>(&self, fut: impl Future<Output = Result<T, ClientError>>) -> Result<T, Error> {
        self.runtime.block_on(async {
            tokio::select! { biased;
                _ = self.control.wait_cancel() => Err(transport_error()),
                _ = tokio::time::sleep_until(self.control.deadline.into()) => Err(transport_error()),
                result = fut => result.map_err(map_error),
            }
        })
    }

    fn lstat(&self, path: &Path) -> Result<FileStat, Error> {
        Ok(to_stat(
            self.wait(self.sftp.lstat(path_string(path)?))?.attrs,
        ))
    }

    fn realpath(&self, path: &Path) -> Result<PathBuf, Error> {
        self.wait(self.sftp.realpath(path_string(path)?))?
            .files
            .into_iter()
            .next()
            .map(|f| PathBuf::from(f.filename))
            .ok_or_else(transport_error)
    }

    fn readdir(&self, path: &Path) -> Result<Vec<(PathBuf, FileStat)>, Error> {
        self.runtime.block_on(async {
            tokio::select! { biased;
                _ = self.control.wait_cancel() => Err(transport_error()),
                _ = tokio::time::sleep_until(self.control.deadline.into()) => Err(transport_error()),
                result = self.read_directory(path) => result,
            }
        })
    }

    async fn read_directory(&self, path: &Path) -> Result<Vec<(PathBuf, FileStat)>, Error> {
        let handle = self
            .sftp
            .opendir(path_string(path)?)
            .await
            .map_err(map_error)?
            .handle;
        let mut entries = Vec::new();
        let result = loop {
            match self.sftp.readdir(&handle).await {
                Ok(reply) => {
                    for item in reply.files {
                        if matches!(item.filename.as_str(), "." | "..") {
                            continue;
                        }
                        if item.filename.contains(['/', '\\', '\0'])
                            || item.filename.is_empty()
                            || entries.len() >= DIRECTORY_LIMIT
                        {
                            let _ = self.sftp.close(&handle).await;
                            return Err(Error::new(
                                ErrorCode::SFTP(4),
                                "Sandbox SFTP directory bounds exceeded",
                            ));
                        }
                        entries.push((path.join(item.filename), to_stat(item.attrs)));
                    }
                }
                Err(ClientError::Status(s)) if s.status_code == StatusCode::Eof => {
                    break Ok(entries)
                }
                Err(e) => break Err(map_error(e)),
            }
        };
        self.sftp.close(&handle).await.map_err(map_error)?;
        result
    }

    fn open(
        &self,
        path: &Path,
        flags: OpenFlags,
        mode: Option<u32>,
    ) -> Result<SandboxFile<'_>, Error> {
        let handle = self
            .wait(self.sftp.open(
                path_string(path)?,
                flags,
                FileAttributes {
                    permissions: mode,
                    ..Default::default()
                },
            ))?
            .handle;
        Ok(SandboxFile {
            sftp: self,
            handle: Some(handle),
            offset: 0,
        })
    }

    fn unlink(&self, path: &Path) -> Result<(), Error> {
        self.wait(self.sftp.remove(path_string(path)?)).map(|_| ())
    }
}

impl Drop for SandboxSftp {
    fn drop(&mut self) {
        let _ = self.sftp.close_session();
    }
}

fn path_string(path: &Path) -> Result<Cow<'_, str>, Error> {
    let path = path
        .to_str()
        .ok_or_else(|| Error::new(ErrorCode::SFTP(4), "Invalid sandbox SFTP path"))?;
    // PathBuf joins use the client OS separator, while the server is always Linux.
    if cfg!(windows) && path.contains('\\') {
        return Ok(Cow::Owned(path.replace('\\', "/")));
    }
    Ok(Cow::Borrowed(path))
}

fn to_stat(a: FileAttributes) -> FileStat {
    FileStat {
        size: a.size,
        uid: a.uid,
        gid: a.gid,
        perm: a.permissions,
        atime: a.atime.map(u64::from),
        mtime: a.mtime.map(u64::from),
    }
}

fn transport_error() -> Error {
    Error::new(
        ErrorCode::Session(libssh2_sys::LIBSSH2_ERROR_SOCKET_DISCONNECT),
        super::SFTP_UNCERTAIN,
    )
}

fn map_error(e: ClientError) -> Error {
    match e {
        ClientError::Status(s)
            if matches!(
                s.status_code,
                StatusCode::NoConnection | StatusCode::ConnectionLost
            ) =>
        {
            transport_error()
        }
        ClientError::Status(s) => Error::new(
            ErrorCode::SFTP(s.status_code as i32),
            "Sandbox SFTP rejected the request",
        ),
        _ => transport_error(),
    }
}

pub(crate) struct SandboxFile<'a> {
    sftp: &'a SandboxSftp,
    handle: Option<String>,
    offset: u64,
}

impl SandboxFile<'_> {
    fn close(&mut self) -> io::Result<()> {
        if let Some(handle) = self.handle.take() {
            self.sftp
                .wait(self.sftp.sftp.close(handle))
                .map_err(io::Error::other)?;
        }
        Ok(())
    }
}

impl Drop for SandboxFile<'_> {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

impl Read for SandboxFile<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let handle = self.handle.as_ref().ok_or(io::ErrorKind::BrokenPipe)?;
        let len = buf.len().min(IO_CHUNK);
        if len == 0 {
            return Ok(0);
        }
        match self
            .sftp
            .wait(self.sftp.sftp.read(handle, self.offset, len as u32))
        {
            Ok(data) if data.data.len() <= len => {
                let n = data.data.len();
                buf[..n].copy_from_slice(&data.data);
                self.offset += n as u64;
                Ok(n)
            }
            Err(e) if e.code() == ErrorCode::SFTP(StatusCode::Eof as i32) => Ok(0),
            Err(e) => Err(io::Error::other(e)),
            _ => Err(io::Error::other(super::SFTP_UNCERTAIN)),
        }
    }
}

impl Write for SandboxFile<'_> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let handle = self.handle.as_ref().ok_or(io::ErrorKind::BrokenPipe)?;
        let len = buf.len().min(IO_CHUNK);
        self.sftp
            .wait(
                self.sftp
                    .sftp
                    .write(handle, self.offset, buf[..len].to_vec()),
            )
            .map_err(io::Error::other)?;
        self.offset += len as u64;
        Ok(len)
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

pub(super) fn probe(
    session: &ssh2::Session,
    policy: &Policy,
    control: &Control,
    host_pid: &str,
    host_net: &str,
) -> Result<(), Error> {
    let name = format!(".shellspan-probe-{}", Uuid::new_v4().simple());
    let sftp = SandboxSftp::start(session, policy, control, None, Some(&name))
        .map_err(|_| transport_error())?;
    let root = Path::new(&policy.workspace);
    if sftp.realpath(root)? != root || !sftp.lstat(root)?.is_dir() {
        return Err(transport_error());
    }
    if !matches!(sftp.lstat(Path::new(OUTSIDE)), Err(e) if e.code() == ErrorCode::SFTP(StatusCode::NoSuchFile as i32))
    {
        return Err(transport_error());
    }
    for (ns, kind, host) in [("pid", "pid:[", host_pid), ("net", "net:[", host_net)] {
        let response = sftp.wait(sftp.sftp.readlink(format!("/proc/self/ns/{ns}")))?;
        let name = response
            .files
            .first()
            .map(|entry| entry.filename.as_str())
            .ok_or_else(transport_error)?;
        if !name.starts_with(kind) || name == host {
            return Err(transport_error());
        }
    }
    let temp = root.join(name);
    let open = sftp.open(
        &temp,
        OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::EXCLUDE,
        Some(0o600),
    );
    match open {
        Ok(mut file) => {
            let result = (|| -> io::Result<()> {
                file.write_all(b"shellspan")?;
                file.close()?;
                let mut file = sftp
                    .open(&temp, OpenFlags::READ, None)
                    .map_err(io::Error::other)?;
                let mut data = [0; 9];
                file.read_exact(&mut data)?;
                file.close()?;
                if &data != b"shellspan" || policy.mode != Mode::WorkspaceWrite {
                    return Err(io::Error::other("sandbox SFTP policy mismatch"));
                }
                Ok(())
            })();
            let _ = file.close();
            sftp.unlink(&temp)?;
            result.map_err(|_| transport_error())
        }
        Err(e) if policy.mode == Mode::ReadOnly && matches!(e.code(), ErrorCode::SFTP(3 | 4)) => {
            Ok(())
        }
        Err(e) => Err(e),
    }
}

pub(crate) enum AgentSftp<'a> {
    Host(&'a ssh2::Sftp),
    Sandbox(&'a SandboxSftp),
}
pub(crate) enum AgentFile<'a> {
    Host(ssh2::File),
    Sandbox(SandboxFile<'a>),
}

pub(crate) enum AgentSftpConnection {
    Host(crate::models::ConnectedSftp),
    Sandbox(Box<SandboxSftp>),
}

impl AgentSftpConnection {
    pub(crate) fn connect(
        db: &Database,
        binding: Option<&Binding>,
        connection: &RemoteConnectionRequest,
        known_hosts: &Path,
        control: Control,
    ) -> Result<Self, String> {
        if let Some(binding) = binding {
            binding.check(db, known_hosts)?;
            if binding
                .state
                .policy
                .as_ref()
                .is_some_and(|policy| policy.mode.uses_bubblewrap())
            {
                return SandboxSftp::connect(db, binding, connection, known_hosts, control)
                    .map(Box::new)
                    .map(Self::Sandbox);
            }
        }
        let connected = crate::connection::connect_sftp(connection, None, Some(known_hosts))
            .map_err(|e| format!("Native SFTP connection failed: {e:?}"))?;
        if let Some(binding) = binding {
            binding.check(db, known_hosts)?;
        }
        let connected = std::sync::Arc::try_unwrap(connected)
            .map_err(|_| "Native SFTP connection unexpectedly shared")?
            .into_inner()
            .map_err(|_| "Native SFTP connection is unavailable")?;
        Ok(Self::Host(connected))
    }

    pub(crate) fn sftp(&self) -> AgentSftp<'_> {
        match self {
            Self::Host(s) => AgentSftp::Host(&s.sftp),
            Self::Sandbox(s) => AgentSftp::Sandbox(s),
        }
    }

    pub(crate) fn set_host_timeout_ms(&self, timeout_ms: u32) {
        if let Self::Host(connected) = self {
            connected.session.set_timeout(timeout_ms);
        }
    }
}

impl Read for AgentFile<'_> {
    fn read(&mut self, data: &mut [u8]) -> io::Result<usize> {
        match self {
            Self::Host(f) => f.read(data),
            Self::Sandbox(f) => f.read(data),
        }
    }
}
impl Write for AgentFile<'_> {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        match self {
            Self::Host(f) => f.write(data),
            Self::Sandbox(f) => f.write(data),
        }
    }
    fn flush(&mut self) -> io::Result<()> {
        match self {
            Self::Host(f) => f.flush(),
            Self::Sandbox(f) => f.flush(),
        }
    }
}
impl AgentFile<'_> {
    pub(crate) fn close(mut self) -> io::Result<()> {
        match &mut self {
            Self::Host(f) => f.close().map_err(io::Error::other),
            Self::Sandbox(f) => f.close(),
        }
    }
}

impl AgentSftp<'_> {
    pub(crate) fn lstat(&self, p: &Path) -> Result<FileStat, Error> {
        match self {
            Self::Host(s) => s.lstat(p),
            Self::Sandbox(s) => s.lstat(p),
        }
    }
    pub(crate) fn realpath(&self, p: &Path) -> Result<PathBuf, Error> {
        match self {
            Self::Host(s) => s.realpath(p),
            Self::Sandbox(s) => s.realpath(p),
        }
    }
    pub(crate) fn readdir(&self, p: &Path) -> Result<Vec<(PathBuf, FileStat)>, Error> {
        match self {
            Self::Host(s) => s.readdir(p),
            Self::Sandbox(s) => s.readdir(p),
        }
    }
    pub(crate) fn open(&self, p: &Path) -> Result<AgentFile<'_>, Error> {
        match self {
            Self::Host(s) => s.open(p).map(AgentFile::Host),
            Self::Sandbox(s) => s.open(p, OpenFlags::READ, None).map(AgentFile::Sandbox),
        }
    }
    pub(crate) fn create_exclusive(&self, p: &Path) -> Result<AgentFile<'_>, Error> {
        match self {
            Self::Host(s) => s
                .open_mode(
                    p,
                    ssh2::OpenFlags::CREATE
                        | ssh2::OpenFlags::WRITE
                        | ssh2::OpenFlags::TRUNCATE
                        | ssh2::OpenFlags::EXCLUSIVE,
                    0o600,
                    ssh2::OpenType::File,
                )
                .map(AgentFile::Host),
            Self::Sandbox(s) => s
                .open(
                    p,
                    OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::EXCLUDE,
                    Some(0o600),
                )
                .map(AgentFile::Sandbox),
        }
    }
    pub(crate) fn unlink(&self, p: &Path) -> Result<(), Error> {
        match self {
            Self::Host(s) => s.unlink(p),
            Self::Sandbox(s) => s.unlink(p),
        }
    }
    pub(crate) fn setstat(&self, p: &Path, stat: FileStat) -> Result<(), Error> {
        match self {
            Self::Host(s) => s.setstat(p, stat),
            Self::Sandbox(s) => s
                .wait(s.sftp.setstat(
                    path_string(p)?,
                    FileAttributes {
                        permissions: stat.perm.map(|mode| mode & 0o777),
                        ..Default::default()
                    },
                ))
                .map(|_| ()),
        }
    }
    pub(crate) fn rename(
        &self,
        a: &Path,
        b: &Path,
        flags: Option<ssh2::RenameFlags>,
    ) -> Result<(), Error> {
        match self {
            Self::Host(s) => s.rename(a, b, flags),
            // The caller stages distinct names and checks the destination. OpenSSH
            // implements v3 rename without replacing an existing regular file.
            Self::Sandbox(s) => s
                .wait(s.sftp.rename(path_string(a)?, path_string(b)?))
                .map(|_| ()),
        }
    }
}
