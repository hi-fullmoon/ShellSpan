//! Launch Windows Direct commands with an AppContainer token and no capabilities.
use std::ffi::{c_void, OsStr, OsString};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::mem::{size_of, size_of_val, zeroed};
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::{Path, PathBuf};
use std::ptr::{null, null_mut};
use std::time::Duration;

use base64::Engine;
use sha2::{Digest, Sha256};
use windows_sys::Win32::Foundation::{
    LocalFree, SetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::Security::{
    Authorization::{ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW},
    FreeSid, GetTokenInformation,
    Isolation::{
        CreateAppContainerProfile, DeleteAppContainerProfile,
        DeriveAppContainerSidFromAppContainerName,
    },
    TokenUser, PSID, SECURITY_ATTRIBUTES, SECURITY_CAPABILITIES, TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateDirectoryW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE,
};
use windows_sys::Win32::System::JobObjects::*;
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::SystemInformation::GetSystemDirectoryW;
use windows_sys::Win32::System::Threading::*;

pub(crate) const EXECUTOR: &str = "windowsAppContainer";
const WORKSPACES: &str = "windows-agent-workspaces";
const START_FAILED: &str = "WINDOWS_SANDBOX_START_FAILED";

fn win(result: i32) -> io::Result<()> {
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn wide(value: impl AsRef<OsStr>) -> Vec<u16> {
    value.as_ref().encode_wide().chain([0]).collect()
}

fn sid_string(sid: PSID) -> io::Result<String> {
    let mut output = null_mut();
    // SAFETY: sid is a live SID and output is freed by LocalFree.
    unsafe {
        win(ConvertSidToStringSidW(sid, &mut output))?;
        let length = (0..).take_while(|i| *output.add(*i) != 0).count();
        let value = String::from_utf16_lossy(std::slice::from_raw_parts(output, length));
        LocalFree(output.cast());
        Ok(value)
    }
}

fn user_sid() -> io::Result<String> {
    let mut token = null_mut();
    // SAFETY: the process is current and the token and aligned buffer live through both calls.
    unsafe {
        win(OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_QUERY,
            &mut token,
        ))?;
        let token = OwnedHandle::from_raw_handle(token);
        let mut size = 0;
        GetTokenInformation(token.as_raw_handle(), TokenUser, null_mut(), 0, &mut size);
        if size == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut buffer = vec![0_usize; (size as usize).div_ceil(size_of::<usize>())];
        win(GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            buffer.as_mut_ptr().cast(),
            size,
            &mut size,
        ))?;
        sid_string((*buffer.as_ptr().cast::<TOKEN_USER>()).User.Sid)
    }
}

fn container_moniker(workspace: &str, user: &str) -> Vec<u16> {
    let key = hex::encode(Sha256::digest(format!("{user}\0{workspace}")));
    wide(format!("ShellSpan.Agent.{}", &key[..40]))
}

struct ContainerSid(PSID);

impl ContainerSid {
    fn for_workspace(workspace: &str, user: &str) -> io::Result<Self> {
        let name = container_moniker(workspace, user);
        let mut sid = null_mut();
        let label = wide("ShellSpan Agent");
        // SAFETY: all strings are NUL terminated and sid is a valid out pointer.
        let mut result = unsafe {
            CreateAppContainerProfile(
                name.as_ptr(),
                label.as_ptr(),
                label.as_ptr(),
                null(),
                0,
                &mut sid,
            )
        };
        const ALREADY_EXISTS: i32 = 0x800700b7_u32 as i32;
        if result == ALREADY_EXISTS {
            // SAFETY: the already-created profile uses this same NUL-terminated moniker.
            result = unsafe { DeriveAppContainerSidFromAppContainerName(name.as_ptr(), &mut sid) };
        }
        if result < 0 {
            return Err(io::Error::other(format!("AppContainer SID: {result:#x}")));
        }
        Ok(Self(sid))
    }
}

impl Drop for ContainerSid {
    fn drop(&mut self) {
        // SAFETY: DeriveAppContainerSidFromAppContainerName allocates with FreeSid.
        unsafe {
            FreeSid(self.0);
        }
    }
}

fn directory(path: &Path) -> io::Result<(File, BY_HANDLE_FILE_INFORMATION)> {
    let handle = OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    // SAFETY: the handle stays open and info is an initialized Win32 output struct.
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { zeroed() };
    unsafe {
        win(GetFileInformationByHandle(
            handle.as_raw_handle(),
            &mut info,
        ))?;
    }
    if info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)
        != FILE_ATTRIBUTE_DIRECTORY
    {
        return Err(io::Error::other(
            "Expected a real managed sandbox directory",
        ));
    }
    Ok((handle, info))
}

fn create_writable_directory(path: &Path, user: &str, sid: &ContainerSid) -> io::Result<()> {
    let sid = sid_string(sid.0)?;
    // The package may modify contents, but the workspace root and its ACL
    // remain host-owned. Descendants inherit Modify, and the low label.
    let sddl = wide(format!(
        "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;{user})(A;;0x1201bf;;;{sid})(A;OICIIO;0x1301bf;;;{sid})S:(ML;OICI;NW;;;LW)"
    ));
    let path = wide(path);
    let mut descriptor = null_mut();
    // SAFETY: the descriptor and pointer fields live through CreateDirectoryW.
    unsafe {
        win(ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1,
            &mut descriptor,
            null_mut(),
        ))?;
        let mut security = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };
        let result = win(CreateDirectoryW(path.as_ptr(), &mut security));
        LocalFree(descriptor);
        result
    }
}

fn workspace_digest(path: &Path, user: &str, info: &BY_HANDLE_FILE_INFORMATION) -> String {
    let path = crate::path_utils::portable_local_path(path);
    hex::encode(Sha256::digest(format!(
        "{EXECUTOR}\0v1\0{user}\0{path}\0{}\0{}\0{}",
        info.dwVolumeSerialNumber, info.nFileIndexHigh, info.nFileIndexLow
    )))
}

fn identity_record(path: &Path) -> PathBuf {
    path.with_extension("identity")
}

fn temp_root_for(path: &Path) -> PathBuf {
    path.with_extension("tmp")
}

pub(crate) fn create_workspace(data: &Path, session: &str) -> Result<String, String> {
    let create = || -> io::Result<String> {
        let base = data.join(WORKSPACES);
        match fs::create_dir(&base) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
        let (_base, _) = directory(&base)?;
        let digest = Sha256::digest(format!("{data:?}\0{session}"));
        let name = hex::encode(&digest[..16]);
        let user = user_sid()?;
        let sid = ContainerSid::for_workspace(&name, &user)?;
        let path = base.join(name);
        match create_writable_directory(&path, &user, &sid) {
            Ok(()) => {
                let (_workspace, info) = directory(&path)?;
                let digest = workspace_digest(&path, &user, &info);
                // The record is a host-owned sibling, outside the writable ACL.
                let mut record = File::create_new(identity_record(&path))?;
                record.write_all(digest.as_bytes())?;
                record.sync_all()?;
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                Workspace::open(data, &path).map_err(io::Error::other)?;
            }
            Err(error) => return Err(error),
        }
        Ok(crate::path_utils::portable_local_path(&path))
    };
    create().map_err(|error| format!("{START_FAILED}: {error}"))
}

fn parse_managed_workspace_path(data: &Path, cwd: &Path) -> io::Result<(PathBuf, String)> {
    let path = PathBuf::from(crate::path_utils::portable_local_path(cwd));
    let base = PathBuf::from(crate::path_utils::portable_local_path(
        &data.join(WORKSPACES),
    ));
    let name = path
        .file_name()
        .and_then(OsStr::to_str)
        .filter(|name| name.len() == 32 && uuid::Uuid::parse_str(name).is_ok())
        .filter(|_| path.parent() == Some(base.as_path()))
        .ok_or_else(|| io::Error::other("Invalid managed workspace path"))?
        .to_string();
    Ok((path, name))
}

pub(crate) fn remove_workspace(data: &Path, cwd: &Path) -> Result<(), String> {
    let (path, name) = parse_managed_workspace_path(data, cwd)
        .map_err(|error| format!("{START_FAILED}: {error}"))?;
    let user = user_sid().map_err(|error| format!("{START_FAILED}: {error}"))?;
    if path.exists() {
        // Verify identity before recycling an existing managed workspace, then
        // release directory handles so Windows allows moving it to the recycle bin.
        let workspace = Workspace::open(data, &path)?;
        drop(workspace);
        if let Err(error) = trash::TrashContext::new().delete(&path) {
            return Err(format!(
                "Failed to recycle Windows sandbox workspace: {error}"
            ));
        }
    }
    match fs::remove_dir_all(temp_root_for(&path)) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "Failed to remove Windows sandbox temp root: {error}"
            ));
        }
    }
    match fs::remove_file(identity_record(&path)) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "Failed to remove Windows sandbox identity record: {error}"
            ));
        }
    }
    let _ = fs::remove_file(super::sandbox_sync::baseline_path_for_workspace(&path));
    let moniker = container_moniker(&name, &user);
    // SAFETY: moniker is a valid NUL-terminated UTF-16 AppContainer name.
    let result = unsafe { DeleteAppContainerProfile(moniker.as_ptr()) };
    const FILE_NOT_FOUND: i32 = 0x80070002_u32 as i32;
    const NOT_FOUND: i32 = 0x80070490_u32 as i32;
    if result < 0 && result != FILE_NOT_FOUND && result != NOT_FOUND {
        return Err(format!("DeleteAppContainerProfile failed: {result:#x}"));
    }
    Ok(())
}

pub(crate) fn reclaim_orphaned_workspaces(
    data: &Path,
    known_cwds: &std::collections::HashSet<String>,
) {
    let base = data.join(WORKSPACES);
    let Ok(entries) = fs::read_dir(&base) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(OsStr::to_str) else {
            continue;
        };
        if name.len() != 32 || uuid::Uuid::parse_str(name).is_err() {
            continue;
        }
        let portable = crate::path_utils::portable_local_path(&path);
        if known_cwds.contains(&portable) {
            continue;
        }
        if let Err(error) = remove_workspace(data, &path) {
            log::warn!(
                "Failed to reclaim orphaned Windows sandbox workspace: {}",
                crate::redaction::redact_sensitive_text(&error)
            );
        }
    }
}

pub(super) struct Workspace {
    path: PathBuf,
    user: String,
    name: String,
    pub(super) digest: String,
    // Retain handles without FILE_SHARE_DELETE during process lifetime.
    _parents: Vec<File>,
}

impl Workspace {
    pub(super) fn open(data: &Path, cwd: &Path) -> Result<Self, String> {
        let open = || -> io::Result<Self> {
            let (path, name) = parse_managed_workspace_path(data, cwd)?;
            let mut parents = Vec::new();
            for ancestor in path
                .ancestors()
                .skip(1)
                .filter(|path| path.parent().is_some())
            {
                parents.push(directory(ancestor)?.0);
            }
            let (handle, info) = directory(&path)?;
            parents.push(handle);
            let user = user_sid()?;
            let digest = workspace_digest(&path, &user, &info);
            if fs::read_to_string(identity_record(&path))? != digest {
                return Err(io::Error::other(
                    "Managed sandbox workspace identity changed",
                ));
            }
            Ok(Self {
                path,
                user,
                name,
                digest,
                _parents: parents,
            })
        };
        open().map_err(|error| format!("{START_FAILED}: {error}"))
    }
}

impl super::LocalSandboxBackend for Workspace {
    fn kind(&self) -> crate::agent_runtime::LocalSandboxKind {
        crate::agent_runtime::LocalSandboxKind::WindowsAppContainer
    }

    fn digest(&self) -> &str {
        &self.digest
    }
}

struct Attributes {
    _storage: Vec<usize>,
    list: LPPROC_THREAD_ATTRIBUTE_LIST,
}

impl Attributes {
    fn new(count: u32) -> io::Result<Self> {
        let mut size = 0;
        // SAFETY: first call sizes the list, then the owned aligned buffer is initialized.
        unsafe {
            InitializeProcThreadAttributeList(null_mut(), count, 0, &mut size);
            if size == 0 {
                return Err(io::Error::last_os_error());
            }
            let mut storage = vec![0_usize; size.div_ceil(size_of::<usize>())];
            let list = storage.as_mut_ptr().cast();
            win(InitializeProcThreadAttributeList(list, count, 0, &mut size))?;
            Ok(Self {
                _storage: storage,
                list,
            })
        }
    }

    // SAFETY: each attribute value must remain live until CreateProcessW returns.
    unsafe fn set<T: ?Sized>(&mut self, name: u32, value: &T) -> io::Result<()> {
        win(unsafe {
            UpdateProcThreadAttribute(
                self.list,
                0,
                name as usize,
                (value as *const T).cast(),
                size_of_val(value),
                null_mut(),
                null_mut(),
            )
        })
    }
}

impl Drop for Attributes {
    fn drop(&mut self) {
        // SAFETY: list was successfully initialized and its buffer is still alive.
        unsafe {
            DeleteProcThreadAttributeList(self.list);
        }
    }
}

fn pipe(inherit_reader: bool) -> io::Result<(OwnedHandle, OwnedHandle)> {
    let (mut reader, mut writer) = (null_mut(), null_mut());
    let security = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: null_mut(),
        bInheritHandle: 1,
    };
    // SAFETY: CreatePipe returns two separately owned handles.
    unsafe {
        win(CreatePipe(&mut reader, &mut writer, &security, 0))?;
        let reader = OwnedHandle::from_raw_handle(reader);
        let writer = OwnedHandle::from_raw_handle(writer);
        let host = if inherit_reader {
            writer.as_raw_handle()
        } else {
            reader.as_raw_handle()
        };
        win(SetHandleInformation(host, HANDLE_FLAG_INHERIT, 0))?;
        Ok((reader, writer))
    }
}

fn system_directory() -> io::Result<PathBuf> {
    let mut buffer = [0_u16; 260];
    // SAFETY: buffer is writable for the supplied length.
    let length = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) } as usize;
    if length == 0 || length >= buffer.len() {
        return Err(io::Error::last_os_error());
    }
    Ok(PathBuf::from(OsString::from_wide(&buffer[..length])))
}

pub(super) struct Suspended {
    process: OwnedHandle,
    thread: OwnedHandle,
    job: OwnedHandle,
    stdout: Option<File>,
    stderr: Option<File>,
    _workspace: Workspace,
    _temporary: tempfile::TempDir,
}

impl Suspended {
    pub(super) fn take_output(&mut self) -> (File, File) {
        (
            self.stdout.take().expect("new stdout"),
            self.stderr.take().expect("new stderr"),
        )
    }

    pub(super) fn start(&self) -> io::Result<()> {
        // SAFETY: thread belongs to our suspended process.
        if unsafe { ResumeThread(self.thread.as_raw_handle()) } != 1 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    pub(super) fn exit_code(&self) -> io::Result<Option<i32>> {
        // SAFETY: process is owned for the lifetime of this method.
        unsafe {
            match WaitForSingleObject(self.process.as_raw_handle(), 0) {
                WAIT_OBJECT_0 => {
                    let mut code = 0;
                    win(GetExitCodeProcess(self.process.as_raw_handle(), &mut code))?;
                    Ok(Some(code as i32))
                }
                WAIT_TIMEOUT => Ok(None),
                _ => Err(io::Error::last_os_error()),
            }
        }
    }

    pub(super) fn terminate(&self) -> io::Result<()> {
        // SAFETY: the job is owned and binds only our process tree.
        unsafe { win(TerminateJobObject(self.job.as_raw_handle(), 1)) }
    }

    pub(super) fn empty(&self) -> io::Result<bool> {
        let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        // SAFETY: the job and output struct are valid for this query.
        unsafe {
            win(QueryInformationJobObject(
                self.job.as_raw_handle(),
                JobObjectBasicAccountingInformation,
                (&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                size_of_val(&info) as u32,
                null_mut(),
            ))?;
        }
        Ok(info.ActiveProcesses == 0)
    }

    pub(super) fn wait_empty(&self) -> io::Result<()> {
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while !self.empty()? {
            if std::time::Instant::now() >= deadline {
                return Err(io::Error::other(
                    "Windows sandbox process tree did not stop",
                ));
            }
            std::thread::sleep(Duration::from_millis(15));
        }
        Ok(())
    }
}

const MAX_ACTIVE_PROCESSES: u32 = 64;
const MAX_JOB_MEMORY_BYTES: usize = 2 * 1024 * 1024 * 1024;

fn windows_sandbox_path_env(system: &Path) -> String {
    let mut entries = vec![system.display().to_string()];
    if let Some(program_files) = std::env::var_os("ProgramFiles").map(PathBuf::from) {
        for relative in ["Git\\cmd", "nodejs", "PowerShell\\7"] {
            let candidate = program_files.join(relative);
            if candidate.is_dir() {
                entries.push(candidate.display().to_string());
            }
        }
    }
    entries.join(";")
}

pub(super) fn prepare(workspace: Workspace, command: &str) -> io::Result<Suspended> {
    let sid = ContainerSid::for_workspace(&workspace.name, &workspace.user)?;
    // Temp storage lives in a sibling host-managed directory outside the visible
    // workspace so crashes never leave `.shellspan-tmp-*` clutter inside user files.
    let temp_root = temp_root_for(&workspace.path);
    match create_writable_directory(&temp_root, &workspace.user, &sid) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            let _ = directory(&temp_root)?;
        }
        Err(error) => return Err(error),
    }
    let temporary = tempfile::Builder::new()
        .prefix("run-")
        .tempdir_in(&temp_root)?;
    let system = system_directory()?;
    let system_root = system
        .parent()
        .ok_or_else(|| io::Error::other("Expected Windows system root"))?;
    let program = system
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    let source: Vec<_> = command.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let encoded = base64::engine::general_purpose::STANDARD.encode(source);
    let mut line = wide(format!(
        "\"{}\" -NoLogo -NoProfile -NonInteractive -EncodedCommand {encoded}",
        program.display()
    ));
    let program = wide(program);
    let cwd = wide(&workspace.path);
    let path_env = windows_sandbox_path_env(&system);
    let env = format!(
        "HOME={}\0LOCALAPPDATA={}\0PATH={}\0SystemRoot={}\0TEMP={}\0TMP={}\0USERPROFILE={}\0",
        workspace.path.display(),
        temporary.path().display(),
        path_env,
        system_root.display(),
        temporary.path().display(),
        temporary.path().display(),
        workspace.path.display()
    );
    let env = wide(env);
    let caps = SECURITY_CAPABILITIES {
        AppContainerSid: sid.0,
        ..Default::default()
    };
    let (input, input_writer) = pipe(true)?;
    let (stdout, stdout_writer) = pipe(false)?;
    let (stderr, stderr_writer) = pipe(false)?;
    drop(input_writer);
    let child_handles = [
        input.as_raw_handle(),
        stdout_writer.as_raw_handle(),
        stderr_writer.as_raw_handle(),
    ];
    // SAFETY: all buffers and handles live through CreateProcessW. No token,
    // sockets, application data, or other parent handles are inherited.
    unsafe {
        let job = CreateJobObjectW(null(), null());
        if job.is_null() {
            return Err(io::Error::last_os_error());
        }
        let job = OwnedHandle::from_raw_handle(job);
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
            | JOB_OBJECT_LIMIT_JOB_MEMORY;
        limits.BasicLimitInformation.ActiveProcessLimit = MAX_ACTIVE_PROCESSES;
        limits.JobMemoryLimit = MAX_JOB_MEMORY_BYTES;
        win(SetInformationJobObject(
            job.as_raw_handle(),
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            size_of_val(&limits) as u32,
        ))?;
        let jobs: [HANDLE; 1] = [job.as_raw_handle()];
        let mut attrs = Attributes::new(3)?;
        attrs.set(PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, &caps)?;
        attrs.set(PROC_THREAD_ATTRIBUTE_HANDLE_LIST, &child_handles)?;
        attrs.set(PROC_THREAD_ATTRIBUTE_JOB_LIST, &jobs)?;
        let mut startup = STARTUPINFOEXW::default();
        startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = child_handles[0];
        startup.StartupInfo.hStdOutput = child_handles[1];
        startup.StartupInfo.hStdError = child_handles[2];
        startup.lpAttributeList = attrs.list;
        let mut process = PROCESS_INFORMATION::default();
        win(CreateProcessW(
            program.as_ptr(),
            line.as_mut_ptr(),
            null(),
            null(),
            1,
            CREATE_SUSPENDED
                | CREATE_NO_WINDOW
                | CREATE_UNICODE_ENVIRONMENT
                | EXTENDED_STARTUPINFO_PRESENT,
            env.as_ptr().cast::<c_void>(),
            cwd.as_ptr(),
            &startup.StartupInfo,
            &mut process,
        ))?;
        Ok(Suspended {
            process: OwnedHandle::from_raw_handle(process.hProcess),
            thread: OwnedHandle::from_raw_handle(process.hThread),
            job,
            stdout: Some(stdout.into()),
            stderr: Some(stderr.into()),
            _workspace: workspace,
            _temporary: temporary,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::net::UdpSocket;

    #[test]
    fn appcontainer_runs_with_managed_writes_and_denies_private_host_files() {
        let data = tempfile::tempdir().unwrap();
        let outside = data.path().join("host-only.txt");
        fs::write(&outside, "host data").unwrap();
        let root = create_workspace(data.path(), "appcontainer-test").unwrap();
        let workspace = Workspace::open(data.path(), Path::new(&root)).unwrap();
        let udp = UdpSocket::bind("127.0.0.1:0").unwrap();
        udp.set_nonblocking(true).unwrap();
        let udp_port = udp.local_addr().unwrap().port();
        let quote = outside.display().to_string().replace('\'', "''");
        let command = format!(
            "[IO.File]::WriteAllText('inside.txt','ok'); try {{ [IO.File]::ReadAllText('{quote}'); exit 40 }} catch {{}}; \
             try {{ [IO.File]::WriteAllText('{quote}','changed'); exit 41 }} catch {{}}; \
             try {{ $udp = [Net.Sockets.UdpClient]::new(); $payload = [byte[]]@(42); [void]$udp.Send($payload, 1, '127.0.0.1', {udp_port}) }} catch {{}}; \
             [Console]::Write('verified'); exit 7"
        );
        let mut process = prepare(workspace, &command).unwrap();
        process.start().unwrap();
        process.wait_empty().unwrap();
        let (mut output, mut error) = (String::new(), String::new());
        let (mut stdout, mut stderr) = process.take_output();
        stdout.read_to_string(&mut output).unwrap();
        stderr.read_to_string(&mut error).unwrap();
        assert_eq!(process.exit_code().unwrap(), Some(7), "{error}: {output}");
        assert_eq!(output, "verified");
        assert_eq!(
            fs::read_to_string(Path::new(&root).join("inside.txt")).unwrap(),
            "ok"
        );
        assert_eq!(fs::read_to_string(outside).unwrap(), "host data");
        assert_eq!(
            udp.recv_from(&mut [0]).unwrap_err().kind(),
            io::ErrorKind::WouldBlock
        );
        drop(process);
        remove_workspace(data.path(), Path::new(&root)).unwrap();
        assert!(!Path::new(&root).exists());
        assert!(!identity_record(Path::new(&root)).exists());
    }

    #[test]
    fn remove_workspace_rejects_unmanaged_paths() {
        let data = tempfile::tempdir().unwrap();
        let outside = data.path().join("not-a-workspace");
        fs::create_dir(&outside).unwrap();
        assert!(remove_workspace(data.path(), &outside).is_err());
        assert!(outside.exists());
    }
}
