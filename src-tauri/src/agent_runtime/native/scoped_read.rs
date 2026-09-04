//! Shared, bounded, handle-checked target reads. Never resolves against process cwd.
use std::{
    fs::{self, File},
    io::Read,
    path::{Component, Path, PathBuf},
    time::Instant,
};
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ScopeReadError {
    Absent,
    Unavailable,
    Denied,
    Io,
    Drift,
    Cancelled,
    Limit,
}
impl std::fmt::Display for ScopeReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl From<std::io::Error> for ScopeReadError {
    fn from(e: std::io::Error) -> Self {
        match e.kind() {
            std::io::ErrorKind::NotFound => Self::Absent,
            std::io::ErrorKind::PermissionDenied => Self::Denied,
            _ => Self::Io,
        }
    }
}
impl From<ssh2::Error> for ScopeReadError {
    fn from(e: ssh2::Error) -> Self {
        match e.code() {
            ssh2::ErrorCode::SFTP(2) => Self::Absent,
            ssh2::ErrorCode::SFTP(3) => Self::Denied,
            _ => Self::Io,
        }
    }
}

pub(crate) struct ReadControl {
    pub(crate) cancellation: CancellationToken,
    pub(crate) deadline: Instant,
}
impl ReadControl {
    pub(crate) fn check(&self) -> Result<(), ScopeReadError> {
        if self.cancellation.is_cancelled() {
            Err(ScopeReadError::Cancelled)
        } else if Instant::now() >= self.deadline {
            Err(ScopeReadError::Limit)
        } else {
            Ok(())
        }
    }
}
#[derive(Debug, Clone, serde::Deserialize, PartialEq, Eq)]
pub(crate) struct ScopedEntry {
    pub(crate) name: String,
    pub(crate) directory: bool,
    pub(crate) file: bool,
}
pub(crate) trait ScopedReader {
    fn identity(&self) -> &str;
    fn root(&self) -> &str;
    fn check_root(&self) -> Result<(), ScopeReadError>;
    fn list(
        &self,
        path: &str,
        limit: usize,
        control: &ReadControl,
    ) -> Result<Vec<ScopedEntry>, ScopeReadError>;
    fn list_paths(
        &self,
        path: &str,
        limit: usize,
        control: &ReadControl,
    ) -> Result<Vec<ScopedEntry>, ScopeReadError> {
        self.list(path, limit, control)
    }
    fn read(
        &self,
        path: &str,
        limit: usize,
        control: &ReadControl,
    ) -> Result<Vec<u8>, ScopeReadError>;
}
fn relative(path: &str) -> Result<Vec<&str>, ScopeReadError> {
    if path.is_empty() || path.contains(['\\', '\0']) || path.starts_with('/') {
        return Err(ScopeReadError::Denied);
    }
    let parts: Vec<_> = path.split('/').collect();
    if parts
        .iter()
        .any(|p| p.is_empty() || *p == "." || *p == ".." || p.chars().any(char::is_control))
    {
        return Err(ScopeReadError::Denied);
    }
    Ok(parts)
}
fn identity(meta: &fs::Metadata) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        format!("{}:{}", meta.dev(), meta.ino())
    }
    #[cfg(not(unix))]
    {
        format!("{:?}:{:?}", meta.created(), meta.file_type())
    }
}
fn file_version(meta: &fs::Metadata) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        format!(
            "{}:{}:{}:{}:{}:{}",
            identity(meta),
            meta.len(),
            meta.mtime(),
            meta.mtime_nsec(),
            meta.ctime(),
            meta.ctime_nsec()
        )
    }
    #[cfg(windows)]
    {
        format!("{}:{}:{:?}", identity(meta), meta.len(), meta.modified())
    }
}

pub(crate) struct LocalScopedReader {
    root: String,
    directory: File,
    identity: String,
    _ancestors: Vec<File>,
}
impl LocalScopedReader {
    pub(crate) fn open(root: &str) -> Result<Self, ScopeReadError> {
        let (directory, ancestors, normalized) = open_root_chain(Path::new(root))?;
        let root = normalized
            .to_str()
            .ok_or(ScopeReadError::Denied)?
            .to_owned();
        let root_identity = opened_identity(&directory)?;
        let reader = Self {
            root,
            directory,
            identity: root_identity,
            _ancestors: ancestors,
        };
        reader.check_root()?;
        Ok(reader)
    }
    fn open_relative(
        &self,
        path: &str,
        is_directory: bool,
    ) -> Result<LocalReadHandle, ScopeReadError> {
        if path.is_empty() && is_directory {
            #[cfg(unix)]
            {
                use std::os::fd::{AsRawFd, FromRawFd};
                let fd = unsafe {
                    libc::openat(
                        self.directory.as_raw_fd(),
                        c".".as_ptr(),
                        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
                    )
                };
                if fd < 0 {
                    return Err(std::io::Error::last_os_error().into());
                }
                return Ok(unsafe { File::from_raw_fd(fd) });
            }
            #[cfg(windows)]
            {
                return Ok(LocalReadHandle {
                    file: open_component(Path::new(&self.root))?,
                    _parents: vec![],
                });
            }
        }
        let parts = relative(path)?;
        #[cfg(unix)]
        {
            use std::{
                ffi::CString,
                os::fd::{AsRawFd, FromRawFd},
            };
            let mut current = self.directory.try_clone()?;
            for (index, part) in parts.iter().enumerate() {
                let part = CString::new(*part).map_err(|_| ScopeReadError::Denied)?;
                let flags = libc::O_RDONLY
                    | libc::O_NOFOLLOW
                    | libc::O_CLOEXEC
                    | libc::O_NONBLOCK
                    | if index + 1 < parts.len() || is_directory {
                        libc::O_DIRECTORY
                    } else {
                        0
                    };
                // Each component is opened relative to the preceding directory handle;
                // renaming an ancestor cannot redirect this operation outside the root.
                let fd = unsafe { libc::openat(current.as_raw_fd(), part.as_ptr(), flags) };
                if fd < 0 {
                    let error = std::io::Error::last_os_error();
                    return Err(if error.raw_os_error() == Some(libc::ELOOP) {
                        ScopeReadError::Denied
                    } else {
                        error.into()
                    });
                }
                current = unsafe { File::from_raw_fd(fd) };
            }
            Ok(current)
        }
        #[cfg(not(unix))]
        {
            let mut current = PathBuf::from(&self.root);
            let mut handles = Vec::new();
            for part in parts {
                current.push(part);
                let m = fs::symlink_metadata(&current)?;
                use std::os::windows::fs::MetadataExt;
                if m.file_attributes() & 0x400 != 0 {
                    return Err(ScopeReadError::Denied);
                }
                handles.push(open_component(&current)?);
            }
            let f = handles.pop().ok_or(ScopeReadError::Denied)?;
            if is_directory && !f.metadata()?.is_dir() {
                return Err(ScopeReadError::Denied);
            }
            Ok(LocalReadHandle {
                file: f,
                _parents: handles,
            })
        }
    }
    pub(crate) fn read_checked(
        &self,
        path: &str,
        limit: usize,
        mut check: impl FnMut() -> Result<(), ScopeReadError>,
    ) -> Result<Vec<u8>, ScopeReadError> {
        check()?;
        self.check_root()?;
        let mut handle = self.open_relative(path, false)?;
        let m = handle.metadata()?;
        if !m.is_file() {
            return Err(ScopeReadError::Denied);
        }
        if m.len() > limit as u64 {
            return Err(ScopeReadError::Limit);
        }
        let handle_identity = opened_identity(&handle)?;
        let before = file_version(&m);
        let bytes = read_bounded_checked(&mut handle, limit, &mut check)?;
        let current = self.open_relative(path, false)?;
        if handle_identity != opened_identity(&current)?
            || before != file_version(&handle.metadata()?)
            || before != file_version(&current.metadata()?)
        {
            return Err(ScopeReadError::Drift);
        }
        self.check_root()?;
        check()?;
        Ok(bytes)
    }
}
impl ScopedReader for LocalScopedReader {
    fn root(&self) -> &str {
        &self.root
    }
    fn identity(&self) -> &str {
        &self.identity
    }
    fn check_root(&self) -> Result<(), ScopeReadError> {
        let (current, _, _) =
            open_root_chain(Path::new(&self.root)).map_err(|_| ScopeReadError::Drift)?;
        if opened_identity(&current)? != self.identity
            || opened_identity(&self.directory)? != self.identity
        {
            return Err(ScopeReadError::Drift);
        }
        Ok(())
    }
    fn list(
        &self,
        path: &str,
        limit: usize,
        control: &ReadControl,
    ) -> Result<Vec<ScopedEntry>, ScopeReadError> {
        control.check()?;
        self.check_root()?;
        let handle = self.open_relative(path, true)?;
        let before = file_version(&handle.metadata()?);
        let mut entries = list_handle(&handle, &Path::new(&self.root).join(path), limit, control)?;
        if before != file_version(&handle.metadata()?)
            || before != file_version(&self.open_relative(path, true)?.metadata()?)
        {
            return Err(ScopeReadError::Drift);
        }
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        self.check_root()?;
        control.check()?;
        Ok(entries)
    }
    fn read(
        &self,
        path: &str,
        limit: usize,
        control: &ReadControl,
    ) -> Result<Vec<u8>, ScopeReadError> {
        self.read_checked(path, limit, || control.check())
    }
}
pub(crate) fn read_bounded_checked(
    reader: &mut impl Read,
    limit: usize,
    mut check: impl FnMut() -> Result<(), ScopeReadError>,
) -> Result<Vec<u8>, ScopeReadError> {
    let mut bytes = Vec::new();
    let mut block = [0; 8192];
    loop {
        check()?;
        let n = reader.read(&mut block)?;
        if n == 0 {
            break;
        }
        if bytes.len() + n > limit {
            return Err(ScopeReadError::Limit);
        }
        bytes.extend_from_slice(&block[..n]);
    }
    check()?;
    Ok(bytes)
}
#[cfg(unix)]
fn list_handle(
    handle: &File,
    _path: &Path,
    limit: usize,
    control: &ReadControl,
) -> Result<Vec<ScopedEntry>, ScopeReadError> {
    use std::{ffi::CStr, os::fd::IntoRawFd};
    struct Directory(*mut libc::DIR);
    impl Drop for Directory {
        fn drop(&mut self) {
            unsafe {
                libc::closedir(self.0);
            }
        }
    }
    let fd = handle.try_clone()?.into_raw_fd();
    let stream = unsafe { libc::fdopendir(fd) };
    if stream.is_null() {
        unsafe {
            libc::close(fd);
        }
        return Err(std::io::Error::last_os_error().into());
    }
    let stream = Directory(stream);
    let mut entries = Vec::new();
    loop {
        control.check()?;
        // POSIX requires clearing errno to distinguish EOF from readdir failure.
        #[cfg(target_os = "macos")]
        unsafe {
            *libc::__error() = 0;
        }
        #[cfg(target_os = "linux")]
        unsafe {
            *libc::__errno_location() = 0;
        }
        let entry = unsafe { libc::readdir(stream.0) };
        if entry.is_null() {
            if std::io::Error::last_os_error().raw_os_error().unwrap_or(0) != 0 {
                return Err(ScopeReadError::Io);
            }
            break;
        }
        let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
        if matches!(name.to_bytes(), b"." | b"..") {
            continue;
        }
        if entries.len() >= limit {
            return Err(ScopeReadError::Limit);
        }
        let mut stat: libc::stat = unsafe { std::mem::zeroed() };
        if unsafe { libc::fstatat(fd, name.as_ptr(), &mut stat, libc::AT_SYMLINK_NOFOLLOW) } != 0 {
            return Err(ScopeReadError::Io);
        }
        entries.push(ScopedEntry {
            name: name.to_str().map_err(|_| ScopeReadError::Denied)?.into(),
            directory: stat.st_mode & libc::S_IFMT == libc::S_IFDIR,
            file: stat.st_mode & libc::S_IFMT == libc::S_IFREG,
        });
    }
    Ok(entries)
}
#[cfg(windows)]
fn list_handle(
    _handle: &LocalReadHandle,
    path: &Path,
    limit: usize,
    control: &ReadControl,
) -> Result<Vec<ScopedEntry>, ScopeReadError> {
    // Traversed directories are held without FILE_SHARE_DELETE for this enumeration.
    use std::os::windows::fs::MetadataExt;
    let mut entries = Vec::new();
    for entry in fs::read_dir(path)? {
        control.check()?;
        if entries.len() >= limit {
            return Err(ScopeReadError::Limit);
        }
        let entry = entry?;
        let m = fs::symlink_metadata(entry.path())?;
        entries.push(ScopedEntry {
            name: entry
                .file_name()
                .into_string()
                .map_err(|_| ScopeReadError::Denied)?,
            directory: m.is_dir() && m.file_attributes() & 0x400 == 0,
            file: m.is_file() && m.file_attributes() & 0x400 == 0,
        });
    }
    Ok(entries)
}
// SFTP v3 cannot atomically express no-follow traversal. Reads therefore use
// a fixed Python helper over the same authenticated SSH connection, with all
// target/path input sent as JSON on stdin. A missing helper runtime is unavailable.
pub(crate) struct RemoteScopedReader<'a> {
    session: &'a ssh2::Session,
    root: String,
    identity: String,
}
impl<'a> RemoteScopedReader<'a> {
    pub(crate) fn open(
        session: &'a ssh2::Session,
        _sftp: &'a ssh2::Sftp,
        root: &str,
    ) -> Result<Self, ScopeReadError> {
        if !root.starts_with('/') || root.contains('\\') {
            return Err(ScopeReadError::Denied);
        }
        let response = remote_read(
            session,
            serde_json::json!({"root":root,"operation":"identity"}),
        )?;
        let identity = response
            .get("identity")
            .and_then(serde_json::Value::as_str)
            .ok_or(ScopeReadError::Denied)?
            .into();
        Ok(Self {
            session,
            root: root.into(),
            identity,
        })
    }
    fn request(
        &self,
        operation: &str,
        path: &str,
        limit: usize,
    ) -> Result<serde_json::Value, ScopeReadError> {
        remote_read(
            self.session,
            serde_json::json!({"root":self.root,"identity":self.identity,"operation":operation,"path":path,"limit":limit}),
        )
    }
}
impl ScopedReader for RemoteScopedReader<'_> {
    fn root(&self) -> &str {
        &self.root
    }
    fn identity(&self) -> &str {
        &self.identity
    }
    fn check_root(&self) -> Result<(), ScopeReadError> {
        self.request("identity", "", 0).map(|_| ())
    }
    fn list(
        &self,
        path: &str,
        limit: usize,
        control: &ReadControl,
    ) -> Result<Vec<ScopedEntry>, ScopeReadError> {
        control.check()?;
        let response = self.request("list", path, limit)?;
        let entries: Vec<ScopedEntry> =
            serde_json::from_value(response.get("entries").cloned().ok_or(ScopeReadError::Io)?)
                .map_err(|_| ScopeReadError::Io)?;
        if entries.len() > limit {
            return Err(ScopeReadError::Limit);
        }
        control.check()?;
        Ok(entries)
    }
    fn list_paths(
        &self,
        path: &str,
        limit: usize,
        control: &ReadControl,
    ) -> Result<Vec<ScopedEntry>, ScopeReadError> {
        control.check()?;
        let response = self.request("listPaths", path, limit)?;
        let entries: Vec<ScopedEntry> =
            serde_json::from_value(response.get("entries").cloned().ok_or(ScopeReadError::Io)?)
                .map_err(|_| ScopeReadError::Denied)?;
        if entries.len() > limit {
            return Err(ScopeReadError::Limit);
        }
        control.check()?;
        Ok(entries)
    }
    fn read(
        &self,
        path: &str,
        limit: usize,
        control: &ReadControl,
    ) -> Result<Vec<u8>, ScopeReadError> {
        use base64::Engine;
        control.check()?;
        let response = self.request("read", path, limit)?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(
                response
                    .get("bytes")
                    .and_then(serde_json::Value::as_str)
                    .ok_or(ScopeReadError::Io)?,
            )
            .map_err(|_| ScopeReadError::Io)?;
        if bytes.len() > limit {
            return Err(ScopeReadError::Limit);
        }
        control.check()?;
        Ok(bytes)
    }
}
fn remote_read(
    session: &ssh2::Session,
    request: serde_json::Value,
) -> Result<serde_json::Value, ScopeReadError> {
    use std::io::Write;
    let script = include_str!("skill_reader.py").replace('\'', "'\"'\"'");
    let mut channel = session.channel_session()?;
    channel.exec(&format!("python3 -I -c '{script}'"))?;
    let mut input = serde_json::to_vec(&request).map_err(|_| ScopeReadError::Denied)?;
    if input.len() > 16384 {
        return Err(ScopeReadError::Limit);
    }
    input.push(b'\n');
    channel.write_all(&input)?;
    channel.send_eof()?;
    let mut bytes = Vec::new();
    std::io::Read::by_ref(&mut channel)
        .take(256 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 256 * 1024 {
        return Err(ScopeReadError::Limit);
    }
    channel.wait_close()?;
    let exit = channel.exit_status()?;
    if exit != 0 {
        return Err(if exit == 127 {
            ScopeReadError::Unavailable
        } else {
            ScopeReadError::Denied
        });
    }
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| ScopeReadError::Io)?;
    if let Some(error) = value.get("error").and_then(serde_json::Value::as_str) {
        return Err(match error {
            "Absent" => ScopeReadError::Absent,
            "Denied" => ScopeReadError::Denied,
            "Drift" => ScopeReadError::Drift,
            "Limit" => ScopeReadError::Limit,
            _ => ScopeReadError::Io,
        });
    }
    Ok(value)
}

#[cfg(unix)]
type LocalReadHandle = File;
#[cfg(windows)]
struct LocalReadHandle {
    file: File,
    _parents: Vec<File>,
}
#[cfg(windows)]
impl std::ops::Deref for LocalReadHandle {
    type Target = File;
    fn deref(&self) -> &File {
        &self.file
    }
}
#[cfg(windows)]
impl Read for LocalReadHandle {
    fn read(&mut self, b: &mut [u8]) -> std::io::Result<usize> {
        self.file.read(b)
    }
}
fn open_component(path: &Path) -> Result<File, ScopeReadError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        Ok(fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
            .open(path)?)
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
            FILE_SHARE_WRITE,
        };
        // No FILE_SHARE_DELETE: keep every traversed directory pinned while its child is open.
        let file = fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)?;
        if file.metadata()?.file_attributes() & 0x400 != 0 {
            return Err(ScopeReadError::Denied);
        }
        Ok(file)
    }
}
fn opened_identity(file: &File) -> Result<String, ScopeReadError> {
    #[cfg(unix)]
    {
        Ok(identity(&file.metadata()?))
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(format!(
            "{}:{}:{}",
            info.dwVolumeSerialNumber, info.nFileIndexHigh, info.nFileIndexLow
        ))
    }
}

fn open_root_chain(path: &Path) -> Result<(File, Vec<File>, PathBuf), ScopeReadError> {
    open_root_chain_with(path, |_| {})
}
fn open_root_chain_with(
    path: &Path,
    mut before_open: impl FnMut(&Path),
) -> Result<(File, Vec<File>, PathBuf), ScopeReadError> {
    if !path.is_absolute() {
        return Err(ScopeReadError::Denied);
    }
    let mut parents = Vec::new();
    let mut normalized = PathBuf::new();
    #[cfg(unix)]
    {
        use std::{
            ffi::CString,
            os::fd::{AsRawFd, FromRawFd},
        };
        let mut current = open_component(Path::new("/"))?;
        for component in path.components() {
            match component {
                Component::RootDir => normalized.push("/"),
                Component::Normal(name) => {
                    before_open(&normalized.join(name));
                    use std::os::unix::ffi::OsStrExt;
                    let name_c =
                        CString::new(name.as_bytes()).map_err(|_| ScopeReadError::Denied)?;
                    let fd = unsafe {
                        libc::openat(
                            current.as_raw_fd(),
                            name_c.as_ptr(),
                            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                        )
                    };
                    if fd < 0 {
                        return Err(ScopeReadError::Denied);
                    }
                    parents.push(current);
                    current = unsafe { File::from_raw_fd(fd) };
                    normalized.push(name);
                }
                _ => return Err(ScopeReadError::Denied),
            }
        }
        Ok((current, parents, normalized))
    }
    #[cfg(windows)]
    {
        for component in path.components() {
            match component {
                Component::Prefix(_) => normalized.push(component.as_os_str()),
                Component::RootDir | Component::Normal(_) => {
                    normalized.push(component.as_os_str());
                    before_open(&normalized);
                    parents.push(open_component(&normalized)?);
                }
                _ => return Err(ScopeReadError::Denied),
            }
        }
        let root = parents.pop().ok_or(ScopeReadError::Denied)?;
        if !root.metadata()?.is_dir() {
            return Err(ScopeReadError::Denied);
        }
        Ok((root, parents, normalized))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[cfg(unix)]
    fn skill_local_controlled_root_swap_never_opens_outside_directory() {
        let temp = tempfile::tempdir().unwrap();
        let base = fs::canonicalize(temp.path()).unwrap();
        let root = base.join("root");
        let outside = base.join("outside");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&outside).unwrap();
        let result = open_root_chain_with(&root, |path| {
            if path == root {
                fs::rename(&root, base.join("saved")).unwrap();
                std::os::unix::fs::symlink(&outside, &root).unwrap();
            }
        });
        assert!(result.is_err());
    }
    #[test]
    #[cfg(unix)]
    fn skill_local_component_swaps_and_root_replacement_fail_closed() {
        let temp = tempfile::tempdir().unwrap();
        let base = fs::canonicalize(temp.path()).unwrap();
        let root = base.join("root");
        let outside = base.join("outside");
        fs::create_dir_all(root.join(".agents/skills")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(root.join(".agents/skills/a.md"), b"inside").unwrap();
        fs::write(outside.join("a.md"), b"outside secret").unwrap();
        let reader = LocalScopedReader::open(root.to_str().unwrap()).unwrap();
        fs::rename(root.join(".agents/skills"), root.join("saved")).unwrap();
        std::os::unix::fs::symlink(&outside, root.join(".agents/skills")).unwrap();
        assert!(reader
            .read_checked(".agents/skills/a.md", 100, || Ok(()))
            .is_err());
        fs::rename(&root, base.join("saved-root")).unwrap();
        fs::create_dir(&root).unwrap();
        assert_eq!(reader.check_root(), Err(ScopeReadError::Drift));
    }
    #[test]
    #[cfg(unix)]
    fn skill_remote_fixed_helper_controlled_symlink_open_race_and_path_bounds() {
        use std::io::Write;
        for swap in ["root", "a.md", "none"] {
            let temp = tempfile::tempdir().unwrap();
            let base = fs::canonicalize(temp.path()).unwrap();
            let root = base.join("root");
            fs::create_dir_all(root.join(".agents/skills")).unwrap();
            let file = root.join(".agents/skills/a.md");
            fs::write(&file, b"inside").unwrap();
            let outside = base.join("outside");
            fs::create_dir_all(outside.join(".agents/skills")).unwrap();
            fs::write(outside.join(".agents/skills/a.md"), b"OUTSIDE SECRET").unwrap();
            let victim = if swap == "root" {
                root.clone()
            } else {
                file.clone()
            };
            let destination = if swap == "root" {
                outside.clone()
            } else {
                outside.join(".agents/skills/a.md")
            };
            let prefix = format!("import os\n_real_open = os.open\ndef racing_open(path, flags, *args, **kwargs):\n    if path == {}:\n        os.rename({}, {})\n        os.symlink({}, {})\n    return _real_open(path, flags, *args, **kwargs)\nos.open = racing_open\n", serde_json::to_string(swap).unwrap(), serde_json::to_string(&victim).unwrap(), serde_json::to_string(&base.join("saved")).unwrap(), serde_json::to_string(&destination).unwrap(), serde_json::to_string(&victim).unwrap());
            let mut child = std::process::Command::new("python3")
                .args(["-I", "-c", &(prefix + include_str!("skill_reader.py"))])
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .spawn()
                .unwrap();
            let request = serde_json::json!({"root":root,"operation":"read","path":if swap == "none" { ".agents/skills/../../outside" } else { ".agents/skills/a.md" },"limit":100});
            child
                .stdin
                .take()
                .unwrap()
                .write_all(serde_json::to_string(&request).unwrap().as_bytes())
                .unwrap();
            let output = child.wait_with_output().unwrap();
            assert!(output.status.success());
            let result: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(result["error"], "Denied");
            assert!(result.get("bytes").is_none());
        }
    }
    #[test]
    fn skill_shared_bounded_reads_exact_limit_and_mid_read_cancel() {
        for length in [8191, 8192, 8193] {
            let bytes = vec![0; length];
            assert_eq!(
                read_bounded_checked(&mut &bytes[..], 8192, || Ok(())).is_ok(),
                length <= 8192
            );
        }
        let mut checks = 0;
        let bytes = vec![0; 16384];
        assert_eq!(
            read_bounded_checked(&mut &bytes[..], 16384, || {
                checks += 1;
                if checks == 2 {
                    Err(ScopeReadError::Cancelled)
                } else {
                    Ok(())
                }
            }),
            Err(ScopeReadError::Cancelled)
        );
    }
}
