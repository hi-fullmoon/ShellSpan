//! Fixed low-privilege fixture runner. Deliberately excludes account/WFP/setup APIs.
use serde::{Deserialize, Serialize};
use std::ffi::c_void;
use std::fs::{self, OpenOptions};
use std::io::Read;
use std::net::{SocketAddr, TcpStream, UdpSocket};
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::ptr::{null, null_mut};
use std::time::Duration;
use uuid::Uuid;
use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::Security::Authorization::*;
use windows_sys::Win32::Security::*;
use windows_sys::Win32::Storage::FileSystem::*;
use windows_sys::Win32::System::JobObjects::*;
use windows_sys::Win32::System::StationsAndDesktops::*;
use windows_sys::Win32::System::SystemInformation::GetWindowsDirectoryW;
use windows_sys::Win32::System::SystemServices::SE_GROUP_ENABLED;
use windows_sys::Win32::System::Threading::*;
use windows_sys::Win32::UI::WindowsAndMessaging::SW_HIDE;
type Result<T> = std::result::Result<T, String>;
#[path = "loader_probe.rs"]
mod loader_probe;

/// Opens only fixed shared objects for ACL admission, without mutating security.
pub fn setup_loader_admission() -> Vec<Check> {
    loader_probe::setup_admission()
}

/// Read-only startup admission diagnostics; does not grant access or launch code.
/// # Safety
/// Both Token handles must remain live and identify this owned fixture's ordinary
/// and restricted identities. The caller must have no thread impersonation active.
pub unsafe fn loader_readiness(ordinary: HANDLE, restricted: HANDLE) -> Result<Report> {
    let mut report = Report {
        checks: vec![],
        child_termination_confirmed: false,
        error: None,
    };
    loader_probe::diagnose(ordinary, restricted, &mut report)?;
    Ok(report)
}
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}
fn win(ok: i32, operation: &str) -> Result<()> {
    if ok == 0 {
        Err(format!("{operation}: Win32 {}", unsafe { GetLastError() }))
    } else {
        Ok(())
    }
}
pub struct Handle(pub HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
struct Local(*mut c_void);
impl Drop for Local {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}
fn sid(value: &str) -> Result<Local> {
    let mut pointer = null_mut();
    win(
        unsafe { ConvertStringSidToSidW(wide(value).as_ptr(), &mut pointer) },
        "parse SID",
    )?;
    Ok(Local(pointer))
}
fn token() -> Result<Handle> {
    let mut handle = null_mut();
    win(
        unsafe {
            OpenProcessToken(
                GetCurrentProcess(),
                TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT,
                &mut handle,
            )
        },
        "open current token",
    )?;
    Ok(Handle(handle))
}
fn token_sid(token: HANDLE) -> Result<String> {
    let mut length = 0;
    unsafe {
        GetTokenInformation(token, TokenUser, null_mut(), 0, &mut length);
    }
    let mut buffer = vec![0usize; (length as usize).div_ceil(std::mem::size_of::<usize>())];
    win(
        unsafe {
            GetTokenInformation(
                token,
                TokenUser,
                buffer.as_mut_ptr().cast(),
                length,
                &mut length,
            )
        },
        "query account SID",
    )?;
    let user = unsafe { &*(buffer.as_ptr().cast::<TOKEN_USER>()) };
    let mut text = null_mut();
    win(
        unsafe { ConvertSidToStringSidW(user.User.Sid, &mut text) },
        "format SID",
    )?;
    let storage = Local(text.cast());
    let mut count = 0;
    unsafe {
        while *text.add(count) != 0 {
            count += 1;
        }
    }
    let value = unsafe { String::from_utf16_lossy(std::slice::from_raw_parts(text, count)) };
    drop(storage);
    Ok(value)
}
fn restricted(base: HANDLE, restricting: &Local) -> Result<Handle> {
    let entry = SID_AND_ATTRIBUTES {
        Sid: restricting.0,
        Attributes: 0,
    };
    let mut handle = null_mut();
    win(
        unsafe {
            CreateRestrictedToken(
                base,
                DISABLE_MAX_PRIVILEGE,
                0,
                null(),
                0,
                null(),
                1,
                &entry,
                &mut handle,
            )
        },
        "create restricted token",
    )?;
    let handle = Handle(handle);
    if unsafe { IsTokenRestricted(handle.0) } == 0 {
        return Err("token is not restricted".into());
    }
    Ok(handle)
}

fn impersonated<T>(token: HANDLE, action: impl FnOnce() -> T) -> Result<T> {
    win(
        unsafe { ImpersonateLoggedOnUser(token) },
        "impersonate restricted identity",
    )?;
    struct Revert;
    impl Drop for Revert {
        fn drop(&mut self) {
            // Continuing with an unexpected identity is unsafe even for this prototype.
            if unsafe { RevertToSelf() } == 0 {
                std::process::abort();
            }
        }
    }
    let guard = Revert;
    let result = action();
    drop(guard);
    Ok(result)
}

#[derive(Deserialize, Serialize)]
pub struct Check {
    pub name: String,
    pub passed: bool,
    pub detail: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub version: u32,
    pub account_sid: String,
    pub restricting_sid: String,
    pub station: String,
    pub desktop: String,
    pub tcp: [SocketAddr; 2],
    pub udp: [SocketAddr; 2],
}

#[derive(Deserialize, Serialize, Default)]
#[serde(deny_unknown_fields)]
pub struct Report {
    pub checks: Vec<Check>,
    pub child_termination_confirmed: bool,
    pub error: Option<String>,
}

fn check(report: &mut Report, name: &str, passed: bool, detail: String) -> Result<()> {
    report.checks.push(Check {
        name: name.into(),
        passed,
        detail,
    });
    if passed {
        Ok(())
    } else {
        Err(format!("identity gate failed: {name}"))
    }
}

fn information(token: HANDLE, class: TOKEN_INFORMATION_CLASS) -> Result<Vec<usize>> {
    let mut length = 0;
    unsafe {
        GetTokenInformation(token, class, null_mut(), 0, &mut length);
    }
    if length == 0 || length > 65536 {
        return Err("invalid Token information length".into());
    }
    let mut bytes = vec![0usize; (length as usize).div_ceil(std::mem::size_of::<usize>())];
    win(
        unsafe {
            GetTokenInformation(token, class, bytes.as_mut_ptr().cast(), length, &mut length)
        },
        "query actual Token",
    )?;
    Ok(bytes)
}

pub fn identity(
    token: HANDLE,
    config: &Config,
    restricted_expected: bool,
    report: &mut Report,
) -> Result<()> {
    check(
        report,
        "actual dedicated account SID",
        token_sid(token)? == config.account_sid,
        "TokenUser queried from stable process Token".into(),
    )?;
    let elevation = information(token, TokenElevation)?;
    check(
        report,
        "actual non-elevated Token",
        unsafe { (*(elevation.as_ptr().cast::<TOKEN_ELEVATION>())).TokenIsElevated } == 0,
        "actual TokenElevation".into(),
    )?;
    let groups = information(token, TokenGroups)?;
    let groups = unsafe { &*(groups.as_ptr().cast::<TOKEN_GROUPS>()) };
    let admin = sid("S-1-5-32-544")?;
    let groups =
        unsafe { std::slice::from_raw_parts(groups.Groups.as_ptr(), groups.GroupCount as usize) };
    check(report, "actual admin group disabled or absent", !groups.iter().any(|group|
        unsafe { EqualSid(group.Sid, admin.0) } != 0 && group.Attributes & SE_GROUP_ENABLED as u32 != 0),
        "actual TokenGroups".into())?;
    let users = sid("S-1-5-32-545")?;
    check(report, "actual built-in Users group enabled", groups.iter().any(|group|
        unsafe { EqualSid(group.Sid, users.0) } != 0 && group.Attributes & SE_GROUP_ENABLED as u32 != 0),
        "actual TokenGroups; no administrator group grant".into())?;
    if restricted_expected {
        check(
            report,
            "actual exact single restricting SID",
            exact_restricting_sid(token, &config.restricting_sid)?,
            "TokenRestrictedSids; no broad substitute SID".into(),
        )?;
        let privileges = information(token, TokenPrivileges)?;
        let privileges = unsafe { &*(privileges.as_ptr().cast::<TOKEN_PRIVILEGES>()) };
        let privileges = unsafe {
            std::slice::from_raw_parts(
                privileges.Privileges.as_ptr(),
                privileges.PrivilegeCount as usize,
            )
        };
        let mut notify = LUID::default();
        win(
            unsafe {
                LookupPrivilegeValueW(
                    null(),
                    wide("SeChangeNotifyPrivilege").as_ptr(),
                    &mut notify,
                )
            },
            "lookup traversal privilege",
        )?;
        check(
            report,
            "actual dangerous privileges disabled",
            !privileges.iter().any(|p| {
                p.Attributes & SE_PRIVILEGE_ENABLED != 0
                    && (p.Luid.LowPart != notify.LowPart || p.Luid.HighPart != notify.HighPart)
            }),
            "TokenPrivileges; only traversal privilege may remain enabled".into(),
        )?;
    }
    Ok(())
}

fn exact_restricting_sid(token: HANDLE, expected: &str) -> Result<bool> {
    let storage = information(token, TokenRestrictedSids)?;
    let groups = unsafe { &*(storage.as_ptr().cast::<TOKEN_GROUPS>()) };
    let expected = sid(expected)?;
    Ok(groups.GroupCount == 1 && unsafe { EqualSid(groups.Groups[0].Sid, expected.0) } != 0)
}

fn object_name(handle: HANDLE) -> Result<String> {
    let mut name = [0u16; 512];
    let mut needed = 0;
    win(
        unsafe {
            GetUserObjectInformationW(
                handle,
                UOI_NAME,
                name.as_mut_ptr().cast(),
                std::mem::size_of_val(&name) as u32,
                &mut needed,
            )
        },
        "query actual desktop/station name",
    )?;
    let end = name
        .iter()
        .position(|word| *word == 0)
        .ok_or("unterminated object name")?;
    Ok(String::from_utf16_lossy(&name[..end]))
}

fn desktop_identity(config: &Config, report: &mut Report) -> Result<()> {
    check(
        report,
        "actual private window station",
        object_name(unsafe { GetProcessWindowStation() })? == config.station,
        "actual process station; host station not reused".into(),
    )?;
    check(
        report,
        "actual private desktop",
        object_name(unsafe { GetThreadDesktop(GetCurrentThreadId()) })? == config.desktop,
        "actual thread desktop".into(),
    )
}

pub fn environment(root: &Path) -> Result<Vec<u16>> {
    let mut windows = [0u16; 32768];
    let length =
        unsafe { GetWindowsDirectoryW(windows.as_mut_ptr(), windows.len() as u32) } as usize;
    if length == 0 || length >= windows.len() {
        return Err("Windows directory query failed".into());
    }
    let windows = String::from_utf16_lossy(&windows[..length]);
    let scratch = root.join("scratch");
    let scratch = scratch.to_str().ok_or("invalid scratch path")?;
    let mut block = Vec::new();
    for item in [
        format!(
            "ProgramData={}",
            root.parent()
                .and_then(Path::to_str)
                .ok_or("invalid owned parent")?
        ),
        format!("SystemRoot={windows}"),
        format!("TEMP={scratch}"),
        format!("TMP={scratch}"),
    ] {
        block.extend(wide(&item));
    }
    block.push(0);
    crate::fixed_environment::canonicalize(&block)
}

pub fn job() -> Result<Handle> {
    let handle = Handle(unsafe { CreateJobObjectW(null(), null()) });
    if handle.0.is_null() {
        return Err("create owned Job failed".into());
    }
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    win(
        unsafe {
            SetInformationJobObject(
                handle.0,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&limits) as u32,
            )
        },
        "configure no-breakaway owned Job",
    )?;
    Ok(handle)
}

/// # Safety
/// `job` must be a live owned Job handle held for the duration of this query.
pub unsafe fn accounting(job: HANDLE) -> Result<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION> {
    let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
    win(
        unsafe {
            QueryInformationJobObject(
                job,
                JobObjectBasicAccountingInformation,
                (&mut accounting as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                std::mem::size_of_val(&accounting) as u32,
                null_mut(),
            )
        },
        "query owned Job accounting",
    )?;
    Ok(accounting)
}

/// # Safety
/// Both handles must stay live and belong to this fixture. This terminates the
/// root and verified Job members; never pass a borrowed host process or Job.
pub unsafe fn end_process(process: HANDLE, job: HANDLE) -> bool {
    // A PID is only a lookup hint. Hold stable handles and verify membership
    // in this exact owned Job before using them as cleanup authority.
    let before = unsafe { accounting(job) };
    let mut members = job_members(job);
    // A fixed runner can exit while its console member is also leaving. Retry
    // bounded kernel snapshots; never turn an unverified PID into authority.
    for _ in 0..2 {
        if members.is_ok() {
            break;
        }
        members = job_members(job);
    }
    unsafe {
        TerminateJobObject(job, 2);
        TerminateProcess(process, 2);
    }
    let exited = unsafe { WaitForSingleObject(process, 5000) } == WAIT_OBJECT_0;
    let members_stopped = members.is_ok_and(|handles| {
        handles
            .iter()
            .all(|handle| unsafe { WaitForSingleObject(handle.0, 5000) } == WAIT_OBJECT_0)
    });
    exited
        && members_stopped
        && before.is_ok_and(|before| {
            unsafe { accounting(job) }.is_ok_and(|after| {
                after.ActiveProcesses == 0 && after.TotalProcesses == before.TotalProcesses
            })
        })
}

fn job_members(job: HANDLE) -> Result<Vec<Handle>> {
    let mut bytes = vec![0usize; 258];
    win(
        unsafe {
            QueryInformationJobObject(
                job,
                JobObjectBasicProcessIdList,
                bytes.as_mut_ptr().cast(),
                (bytes.len() * std::mem::size_of::<usize>()) as u32,
                null_mut(),
            )
        },
        "snapshot exact owned Job members",
    )?;
    let list = unsafe { &*(bytes.as_ptr().cast::<JOBOBJECT_BASIC_PROCESS_ID_LIST>()) };
    if list.NumberOfAssignedProcesses != list.NumberOfProcessIdsInList
        || list.NumberOfProcessIdsInList > 256
    {
        return Err("owned Job member snapshot incomplete".into());
    }
    let ids = unsafe {
        std::slice::from_raw_parts(
            list.ProcessIdList.as_ptr(),
            list.NumberOfProcessIdsInList as usize,
        )
    };
    let mut handles = Vec::new();
    for id in ids {
        let handle = Handle(unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
                0,
                u32::try_from(*id).map_err(|_| "invalid member PID")?,
            )
        });
        if handle.0.is_null() {
            return Err("cannot hold owned Job member handle".into());
        }
        let mut member = 0;
        win(
            unsafe { IsProcessInJob(handle.0, job, &mut member) },
            "verify stable handle belongs to exact Job",
        )?;
        if member == 0 {
            return Err("member lookup no longer belongs to owned Job".into());
        }
        handles.push(handle);
    }
    Ok(handles)
}

fn owned_root() -> Result<PathBuf> {
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    if executable.file_name().and_then(|name| name.to_str()) != Some("runner.exe") {
        return Err("child mode requires owned runner image".into());
    }
    let root = executable
        .parent()
        .ok_or("missing owned root")?
        .to_path_buf();
    let parent =
        PathBuf::from(std::env::var_os("ProgramData").ok_or("missing frozen ProgramData")?);
    if !parent.is_absolute()
        || parent.to_string_lossy().starts_with("\\\\")
        || root.parent() != Some(parent.as_path())
    {
        return Err("child outside owned ProgramData fixture".into());
    }
    let name = root
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("invalid fixture name")?;
    Uuid::parse_str(
        name.strip_prefix("ShellSpan-stage-A-")
            .ok_or("invalid fixture prefix")?,
    )
    .map_err(|_| "invalid fixture UUID")?;
    if fs::symlink_metadata(&root)
        .map_err(|e| e.to_string())?
        .file_attributes()
        & FILE_ATTRIBUTE_REPARSE_POINT
        != 0
    {
        return Err("owned root reparse point".into());
    }
    Ok(root)
}

fn read_config(root: &Path) -> Result<Config> {
    decode_config(&read_bounded(&root.join("bootstrap.json"), 8192)?)
}

fn decode_config(bytes: &[u8]) -> Result<Config> {
    if bytes.len() > 8192 {
        return Err("bootstrap config exceeds budget".into());
    }
    let config: Config = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    let station = config
        .station
        .strip_prefix("SSPA-")
        .and_then(|id| Uuid::parse_str(id).ok());
    if config.version != 1
        || station.is_none()
        || config.station.contains('\0')
        || config.desktop != "probe"
    {
        return Err("invalid private desktop binding".into());
    }
    for address in config.tcp.iter().chain(config.udp.iter()) {
        if !address.ip().is_loopback() || address.port() == 0 {
            return Err("only owned loopback receiver endpoints are accepted".into());
        }
    }
    Ok(config)
}

fn read_bounded(path: &Path, budget: usize) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    OpenOptions::new()
        .read(true)
        .open(path)
        .map_err(|e| e.to_string())?
        .take((budget + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > budget {
        return Err("fixed probe input exceeds budget".into());
    }
    Ok(bytes)
}

pub fn entry(action: &str) -> Result<()> {
    // This process exists only for a fixed fixture. Prevent hidden critical
    // error dialogs from turning loader failures into ambiguous timeouts.
    unsafe {
        windows_sys::Win32::System::Diagnostics::Debug::SetErrorMode(
            windows_sys::Win32::System::Diagnostics::Debug::SEM_FAILCRITICALERRORS
                | windows_sys::Win32::System::Diagnostics::Debug::SEM_NOGPFAULTERRORBOX,
        );
    }
    let root = owned_root()?;
    let config = read_config(&root)?;
    let mut report = Report::default();
    let current = token()?;
    let restricted_child = action == "--owned-network-child";
    let run = (|| {
        identity(current.0, &config, restricted_child, &mut report)?;
        desktop_identity(&config, &mut report)?;
        if restricted_child {
            for address in config.tcp {
                let result = TcpStream::connect_timeout(&address, Duration::from_millis(700));
                report.checks.push(Check {
                    name: format!("child TCP {address}"),
                    passed: result.is_err(),
                    detail: format!(
                        "connect Win32 error={:?}",
                        result.err().and_then(|e| e.raw_os_error())
                    ),
                });
            }
            for address in config.udp {
                let bind = if address.is_ipv4() {
                    "127.0.0.1:0"
                } else {
                    "[::1]:0"
                };
                let result = UdpSocket::bind(bind)
                    .and_then(|socket| socket.send_to(b"owned-restricted-child", address));
                report.checks.push(Check {
                    name: format!("child UDP API {address}"),
                    passed: true,
                    detail: format!(
                        "send success={}; Win32 error={:?}; API result alone is not block evidence",
                        result.is_ok(),
                        result.err().and_then(|e| e.raw_os_error())
                    ),
                });
            }
        } else {
            run_restricted_child(&root, &config, current.0, &mut report)?;
        }
        Ok::<(), String>(())
    })();
    if let Err(error) = &run {
        report.error = Some(error.clone());
    }
    let name = if restricted_child {
        "child.json"
    } else {
        "bootstrap.json"
    };
    fs::write(
        root.join("scratch").join(name),
        serde_json::to_vec(&report).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("save fixed child report: {e}"))?;
    run
}

fn run_restricted_child(
    root: &Path,
    config: &Config,
    current: HANDLE,
    report: &mut Report,
) -> Result<()> {
    let restricting = sid(&config.restricting_sid)?;
    let restricted = restricted(current, &restricting)?;
    loader_probe::diagnose(current, restricted.0, report)?;
    let access = impersonated(restricted.0, || {
        let handle = unsafe {
            CreateFileW(
                wide(root.join("runner.exe").to_str().unwrap()).as_ptr(),
                FILE_GENERIC_READ | FILE_GENERIC_EXECUTE,
                FILE_SHARE_READ,
                null(),
                OPEN_EXISTING,
                0,
                null_mut(),
            )
        };
        let executable_error = if handle == INVALID_HANDLE_VALUE {
            Some(unsafe { GetLastError() })
        } else {
            drop(Handle(handle));
            None
        };
        let system_file = PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_default())
            .join("System32/kernel32.dll");
        let runtime_error = OpenOptions::new()
            .read(true)
            .open(system_file)
            .err()
            .and_then(|error| error.raw_os_error());
        (executable_error, runtime_error)
    })?;
    report.checks.push(Check {
        name: "restricted fixed image read/execute".into(),
        passed: access.0.is_none(),
        detail: format!("actual CreateFile read/execute error={:?}", access.0),
    });
    report.checks.push(Check {
        name: "restricted system runtime file read".into(),
        passed: access.1.is_none(),
        detail: format!(
            "actual fixed System32/kernel32.dll read error={:?}",
            access.1
        ),
    });
    let job = job()?;
    let mut default_descriptor = null_mut();
    win(
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide(&format!(
                    "D:P(A;;GA;;;SY)(A;;GA;;;{})(A;;GA;;;{})",
                    config.account_sid, config.restricting_sid
                ))
                .as_ptr(),
                1,
                &mut default_descriptor,
                null_mut(),
            )
        },
        "create owned restricted Token default DACL",
    )?;
    let default_descriptor = Local(default_descriptor);
    let mut present = 0;
    let mut defaulted = 0;
    let mut dacl = null_mut();
    win(
        unsafe {
            GetSecurityDescriptorDacl(
                default_descriptor.0,
                &mut present,
                &mut dacl,
                &mut defaulted,
            )
        },
        "read owned restricted Token default DACL",
    )?;
    let default_dacl = TOKEN_DEFAULT_DACL { DefaultDacl: dacl };
    win(
        unsafe {
            SetTokenInformation(
                restricted.0,
                TokenDefaultDacl,
                (&default_dacl as *const TOKEN_DEFAULT_DACL).cast(),
                std::mem::size_of_val(&default_dacl) as u32,
            )
        },
        "set owned restricted Token default DACL",
    )?;
    let environment = environment(root)?;
    let executable = wide(root.join("runner.exe").to_str().ok_or("invalid runner")?);
    let mut command = wide("runner.exe --owned-network-child");
    let mut desktop = wide(&format!("{}\\{}", config.station, config.desktop));
    let startup = STARTUPINFOW {
        cb: std::mem::size_of::<STARTUPINFOW>() as u32,
        lpDesktop: desktop.as_mut_ptr(),
        dwFlags: STARTF_USESHOWWINDOW,
        wShowWindow: SW_HIDE as u16,
        ..Default::default()
    };
    let mut process = PROCESS_INFORMATION::default();
    // The restricted Token is derived from this runner's own primary Token.
    win(
        unsafe {
            CreateProcessAsUserW(
                restricted.0,
                executable.as_ptr(),
                command.as_mut_ptr(),
                null(),
                null(),
                0,
                CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
                environment.as_ptr().cast(),
                wide(root.to_str().ok_or("invalid root")?).as_ptr(),
                &startup,
                &mut process,
            )
        },
        "runner creates own restricted primary child",
    )?;
    let process_handle = Handle(process.hProcess);
    let thread = Handle(process.hThread);
    let run = (|| {
        win(
            unsafe { AssignProcessToJobObject(job.0, process_handle.0) },
            "assign restricted child to nested owned Job",
        )?;
        let mut actual = null_mut();
        win(
            unsafe { OpenProcessToken(process_handle.0, TOKEN_QUERY, &mut actual) },
            "query suspended child Token",
        )?;
        let actual = Handle(actual);
        identity(actual.0, config, true, report)?;
        let mut belongs = 0;
        win(
            unsafe { IsProcessInJob(process_handle.0, job.0, &mut belongs) },
            "verify nested Job",
        )?;
        check(
            report,
            "suspended child exact Job membership",
            belongs != 0,
            "actual stable handles before Resume".into(),
        )?;
        if unsafe { ResumeThread(thread.0) } == u32::MAX {
            return Err("resume fixed restricted probe failed".into());
        }
        if unsafe { WaitForSingleObject(process_handle.0, 12000) } != WAIT_OBJECT_0 {
            return Err("fixed restricted child timed out".into());
        }
        let mut exit_code = 0;
        win(
            unsafe { GetExitCodeProcess(process_handle.0, &mut exit_code) },
            "query restricted child exit",
        )?;
        check(
            report,
            "restricted child initialization and fixed probe exit",
            exit_code == 0,
            format!("actual exit code {exit_code:#x}"),
        )?;
        let child = read_report(&root.join("scratch/child.json"))?;
        report.checks.extend(child.checks);
        if let Some(error) = child.error {
            return Err(error);
        }
        Ok::<(), String>(())
    })();
    report.child_termination_confirmed = unsafe { end_process(process_handle.0, job.0) };
    run
}

pub fn read_report(path: &Path) -> Result<Report> {
    let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if metadata.len() > 65536 || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err("invalid fixed probe report".into());
    }
    serde_json::from_slice(&read_bounded(path, 65536)?).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn fixed_runner_environment_contains_only_bound_directories_in_canonical_order() {
        let root = std::env::temp_dir().join(format!("ShellSpan-runner-env-{}", Uuid::new_v4()));
        let block = super::environment(&root).unwrap();
        assert_eq!(
            crate::fixed_environment::canonicalize(&block).unwrap(),
            block
        );
        let text = String::from_utf16(&block[..block.len() - 2]).unwrap();
        let entries: Vec<_> = text
            .split('\0')
            .map(|entry| entry.split_once('=').unwrap())
            .collect();
        assert_eq!(
            entries.iter().map(|(key, _)| *key).collect::<Vec<_>>(),
            ["ProgramData", "SystemRoot", "TEMP", "TMP"]
        );
        assert_eq!(entries[0].1, root.parent().unwrap().to_str().unwrap());
        assert_eq!(entries[2].1, root.join("scratch").to_str().unwrap());
        assert_eq!(entries[3].1, entries[2].1);
        assert!(Path::new(entries[1].1).is_absolute());
    }
    use super::*;

    #[test]
    fn actual_restricting_sid_must_match_exactly() {
        let base = token().unwrap();
        let text = "S-1-5-21-771911-771912-771913-771914";
        let restriction = sid(text).unwrap();
        let restricted = restricted(base.0, &restriction).unwrap();
        let mut length = 0;
        unsafe {
            GetTokenInformation(restricted.0, TokenDefaultDacl, null_mut(), 0, &mut length);
        }
        let mut default_dacl =
            vec![0usize; (length as usize).div_ceil(std::mem::size_of::<usize>())];
        win(
            unsafe {
                GetTokenInformation(
                    restricted.0,
                    TokenDefaultDacl,
                    default_dacl.as_mut_ptr().cast(),
                    length,
                    &mut length,
                )
            },
            "query actual default DACL",
        )
        .unwrap();
        assert!(
            win(
                unsafe {
                    SetTokenInformation(
                        restricted.0,
                        TokenDefaultDacl,
                        default_dacl.as_ptr().cast(),
                        std::mem::size_of::<TOKEN_DEFAULT_DACL>() as u32,
                    )
                },
                "retain default DACL on restricted Token"
            )
            .is_ok(),
            "restricted Token handle must retain TOKEN_ADJUST_DEFAULT for owned child startup"
        );
        assert!(exact_restricting_sid(restricted.0, text).unwrap());
        assert!(!exact_restricting_sid(base.0, text).unwrap());
        assert!(
            !exact_restricting_sid(restricted.0, "S-1-5-21-771911-771912-771913-771915").unwrap()
        );
    }

    #[test]
    fn fixed_config_rejects_external_receivers_commands_and_invalid_desktop() {
        let value = serde_json::json!({"version":1,"account_sid":"S-1-5-21-1-2-3-4","restricting_sid":"S-1-5-21-5-6-7-8",
            "station":"SSPA-77191100771912007719130077191400","desktop":"probe",
            "tcp":["127.0.0.1:12345","[::1]:12345"],"udp":["127.0.0.1:12346","[::1]:12346"]});
        assert!(decode_config(&serde_json::to_vec(&value).unwrap()).is_ok());
        for (field, replacement) in [
            ("tcp", serde_json::json!(["192.0.2.1:12345", "[::1]:12345"])),
            ("desktop", serde_json::json!("Default")),
            ("station", serde_json::json!("SSPA-bad\u{0}name")),
            ("command", serde_json::json!("arbitrary command")),
            ("version", serde_json::json!(2)),
        ] {
            let mut invalid = value.clone();
            invalid[field] = replacement;
            assert!(
                decode_config(&serde_json::to_vec(&invalid).unwrap()).is_err(),
                "invalid {field} must be rejected before launching"
            );
        }
        assert!(decode_config(&vec![b' '; 8193]).is_err());
    }

    fn suspended_test_process() -> (Handle, Handle) {
        let executable = wide(std::env::current_exe().unwrap().to_str().unwrap());
        let mut command = wide("owned-test-image");
        let environment = [0u16, 0];
        let startup = STARTUPINFOW {
            cb: std::mem::size_of::<STARTUPINFOW>() as u32,
            ..Default::default()
        };
        let mut process = PROCESS_INFORMATION::default();
        win(
            unsafe {
                CreateProcessW(
                    executable.as_ptr(),
                    command.as_mut_ptr(),
                    null(),
                    null(),
                    0,
                    CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
                    environment.as_ptr().cast(),
                    null(),
                    &startup,
                    &mut process,
                )
            },
            "create never-resumed test process",
        )
        .unwrap();
        (Handle(process.hProcess), Handle(process.hThread))
    }

    #[test]
    fn cleanup_waits_stable_handles_for_every_owned_job_member() {
        let job = job().unwrap();
        let (first, _first_thread) = suspended_test_process();
        let (second, _second_thread) = suspended_test_process();
        let assigned_first = unsafe { AssignProcessToJobObject(job.0, first.0) } != 0;
        let assigned_second = unsafe { AssignProcessToJobObject(job.0, second.0) } != 0;
        let stopped = unsafe { end_process(first.0, job.0) };
        // Always clean the second explicit handle, including failed assignment.
        unsafe {
            TerminateProcess(second.0, 2);
        }
        let second_stopped = unsafe { WaitForSingleObject(second.0, 5000) } == WAIT_OBJECT_0;
        assert!(
            assigned_first && assigned_second,
            "both never-resumed roots must enter the exact owned Job"
        );
        assert!(
            stopped && second_stopped,
            "all actual owned member handles must signal termination"
        );
        assert_eq!(unsafe { accounting(job.0) }.unwrap().ActiveProcesses, 0);
    }
    #[test]
    fn repeated_retirement_preserves_stopped_tree_and_total_accounting() {
        let job = job().unwrap();
        let (root, _thread) = suspended_test_process();
        let assigned = unsafe { AssignProcessToJobObject(job.0, root.0) } != 0;
        let first = unsafe { end_process(root.0, job.0) };
        let total = unsafe { accounting(job.0) }.unwrap().TotalProcesses;
        let repeated = (0..2).all(|_| unsafe { end_process(root.0, job.0) });
        assert!(
            assigned && first && repeated,
            "repeated retirement must use the same held root and Job handles"
        );
        let final_accounting = unsafe { accounting(job.0) }.unwrap();
        assert_eq!(final_accounting.ActiveProcesses, 0);
        assert_eq!(final_accounting.TotalProcesses, total);
    }
}
