//! Fixed file/network workload, separate from production and account setup.
use crate::receiver_control::{Endpoints, ReceiverControl};
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::path::{Path, PathBuf};
use std::ptr::{null, null_mut};
use std::time::Duration;
use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::Security::Authorization::*;
use windows_sys::Win32::Security::*;
use windows_sys::Win32::Storage::FileSystem::*;
use windows_sys::Win32::System::Registry::*;
use windows_sys::Win32::System::Threading::*;
type Result<T> = std::result::Result<T, String>;
const CONTROLLER_HANDLE_RIGHTS: [(&str, u32); 6] = [
    ("memory read", PROCESS_VM_READ),
    ("memory write", PROCESS_VM_WRITE),
    ("memory operation", PROCESS_VM_OPERATION),
    ("thread creation", PROCESS_CREATE_THREAD),
    ("handle duplication", PROCESS_DUP_HANDLE),
    ("termination", PROCESS_TERMINATE),
];
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}
fn fixed_short_alias(root: &Path) -> Result<PathBuf> {
    let input = wide(root.to_str().ok_or("invalid owned short-name source")?);
    let mut output = vec![0u16; 4096];
    let length =
        unsafe { GetShortPathNameW(input.as_ptr(), output.as_mut_ptr(), output.len() as u32) };
    if length == 0 || length as usize >= output.len() {
        return Err("owned short-name query failed or exceeded budget".into());
    }
    let alias =
        PathBuf::from(String::from_utf16(&output[..length as usize]).map_err(|e| e.to_string())?);
    let long_name = root
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("invalid owned long-name root")?;
    let short_name = alias
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("invalid owned short-name root")?;
    if !alias.is_absolute() || short_name.eq_ignore_ascii_case(long_name) {
        return Err(
            "owned root has no distinct on-disk short alias; do not count as short-name coverage"
                .into(),
        );
    }
    let long = verify_retirement_object(root)?;
    let short = verify_retirement_object(&alias)?;
    let mut long_info = BY_HANDLE_FILE_INFORMATION::default();
    let mut short_info = BY_HANDLE_FILE_INFORMATION::default();
    win(
        unsafe { GetFileInformationByHandle(long.0, &mut long_info) },
        "verify owned long-name identity",
    )?;
    win(
        unsafe { GetFileInformationByHandle(short.0, &mut short_info) },
        "verify owned short-name identity",
    )?;
    if (
        long_info.dwVolumeSerialNumber,
        long_info.nFileIndexHigh,
        long_info.nFileIndexLow,
    ) != (
        short_info.dwVolumeSerialNumber,
        short_info.nFileIndexHigh,
        short_info.nFileIndexLow,
    ) {
        return Err("short alias differs from exact owned object identity".into());
    }
    Ok(alias)
}
pub(crate) fn win(ok: i32, operation: &str) -> Result<()> {
    if ok == 0 {
        Err(format!("{operation}: Win32 {}", unsafe { GetLastError() }))
    } else {
        Ok(())
    }
}
pub(crate) struct Handle(pub(crate) HANDLE);
#[cfg(test)]
fn verify_retirement_inventory(paths: &[PathBuf]) -> Result<()> {
    verify_retirement_inventory_budget(paths, 64)
}
fn verify_retirement_inventory_budget(paths: &[PathBuf], budget: usize) -> Result<()> {
    let expected: std::collections::BTreeSet<_> = paths.iter().collect();
    if expected.len() != paths.len() || paths.is_empty() || paths.len() > budget {
        return Err("invalid owned retirement inventory".into());
    }
    let mut actual = std::collections::BTreeSet::new();
    actual.insert(paths[0].clone());
    for path in paths {
        if path.is_dir() {
            for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
                let child = entry.map_err(|e| e.to_string())?.path();
                if !expected.contains(&child) {
                    return Err("owned retirement inventory changed; retain fixture debt".into());
                }
                actual.insert(child);
            }
        }
    }
    if actual.len() != expected.len() {
        return Err("owned retirement inventory missing object; retain fixture debt".into());
    }
    Ok(())
}
pub(crate) fn verify_retirement_object(path: &Path) -> Result<Handle> {
    verify_retirement_object_sharing(path, FILE_SHARE_READ)
}
pub(crate) fn native_local_path(path: &Path) -> Result<Vec<u16>> {
    let text = path.to_str().ok_or("invalid native local path")?;
    let text = text
        .strip_prefix(r"\\?\")
        .unwrap_or(text)
        .replace('/', r"\");
    let bytes = text.as_bytes();
    if text.contains('\0')
        || bytes.len() < 3
        || !bytes[0].is_ascii_alphabetic()
        || bytes[1] != b':'
        || bytes[2] != b'\\'
    {
        return Err("native path must be absolute local drive path".into());
    }
    let wide: Vec<u16> = format!(r"\\?\{text}")
        .encode_utf16()
        .chain(Some(0))
        .collect();
    if wide.len() > 32767 {
        return Err("native local path budget exceeded".into());
    }
    Ok(wide)
}
/// Caller must already establish protected, never-granted journal ownership.
/// Allow child journal transitions without permitting parent replacement.
pub(crate) fn hold_journal_parent(path: &Path) -> Result<Handle> {
    let held = verify_retirement_object_sharing(path, FILE_SHARE_READ | FILE_SHARE_WRITE)?;
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    win(
        unsafe { GetFileInformationByHandle(held.0, &mut info) },
        "inspect journal parent",
    )?;
    if info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
        return Err("journal parent is not a directory".into());
    }
    Ok(held)
}
fn verify_retirement_object_sharing(path: &Path, sharing: u32) -> Result<Handle> {
    // A metadata-only open does not enforce the desired data sharing lease.
    // FILE_READ_DATA (FILE_LIST_DIRECTORY for directories) is deliberate;
    // no file content is read through this handle.
    let handle = unsafe {
        CreateFileW(
            native_local_path(path)?.as_ptr(),
            FILE_READ_DATA | FILE_READ_ATTRIBUTES | READ_CONTROL | WRITE_DAC,
            sharing,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(format!("open retirement object: Win32 {}", unsafe {
            GetLastError()
        }));
    }
    let handle = Handle(handle);
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    win(
        unsafe { GetFileInformationByHandle(handle.0, &mut info) },
        "inspect retirement object",
    )?;
    if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err("owned AC fixture reparse rejected".into());
    }
    if info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0 && info.nNumberOfLinks != 1 {
        return Err("owned AC fixture hardlink aliases rejected".into());
    }
    Ok(handle)
}
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
pub(crate) unsafe fn query(token: HANDLE, class: TOKEN_INFORMATION_CLASS) -> Result<Vec<usize>> {
    let mut length = 0;
    unsafe {
        GetTokenInformation(token, class, null_mut(), 0, &mut length);
    }
    if length == 0 || length > 65536 {
        return Err("fixed probe Token query budget invalid".into());
    }
    let mut buffer = vec![0usize; (length as usize).div_ceil(std::mem::size_of::<usize>())];
    win(
        unsafe {
            GetTokenInformation(
                token,
                class,
                buffer.as_mut_ptr().cast(),
                length,
                &mut length,
            )
        },
        "query fixed probe Token",
    )?;
    Ok(buffer)
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProbeCheck {
    pub name: String,
    pub passed: bool,
    pub detail: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProbeReport {
    pub checks: Vec<ProbeCheck>,
    #[serde(default)]
    pub complete: bool,
}
#[derive(Clone, Copy)]
pub enum FixedReportKind {
    Workload,
    LeafNetwork,
    OrdinaryCredential,
}
impl FixedReportKind {
    pub(crate) fn specification(self) -> (&'static str, u64) {
        match self {
            Self::Workload => ("report.json", 24576),
            Self::LeafNetwork => ("leaf-network.json", 8192),
            Self::OrdinaryCredential => ("credential-primary-control.json", 4096),
        }
    }
}
fn open_report_object(path: &Path, directory: bool) -> Result<Handle> {
    let raw = unsafe {
        CreateFileW(
            wide(path.to_str().ok_or("invalid fixed report object path")?).as_ptr(),
            FILE_READ_DATA | FILE_READ_ATTRIBUTES | READ_CONTROL,
            FILE_SHARE_READ,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
            null_mut(),
        )
    };
    if raw == INVALID_HANDLE_VALUE {
        return Err(format!("open fixed report object: Win32={}", unsafe {
            GetLastError()
        }));
    }
    let handle = Handle(raw);
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    win(
        unsafe { GetFileInformationByHandle(handle.0, &mut info) },
        "inspect fixed report object",
    )?;
    if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err("fixed report reparse object rejected before read".into());
    }
    if (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0) != directory {
        return Err("fixed report object type mismatch".into());
    }
    if !directory && info.nNumberOfLinks != 1 {
        return Err("fixed report hardlink aliases rejected before read".into());
    }
    Ok(handle)
}
/// Writes only the pre-created untrusted bootstrap report; never creates a file.
pub fn write_fixed_bootstrap_report(root: &Path, data: &[u8]) -> Result<()> {
    use std::io::Write;
    use std::os::windows::io::FromRawHandle;
    let id = root
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.strip_prefix("ShellSpan-stage-A-account-lpac-"))
        .and_then(|name| uuid::Uuid::parse_str(name).ok());
    if !root.is_absolute() || id.is_none_or(|id| id.is_nil()) || data.len() > 65536 {
        return Err("fixed bootstrap report root or byte budget invalid".into());
    }
    let _root = open_report_object(root, true)?;
    let path = root.join("account-report.json");
    let raw = unsafe {
        CreateFileW(
            wide(path.to_str().ok_or("invalid fixed bootstrap report path")?).as_ptr(),
            FILE_WRITE_DATA | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    };
    if raw == INVALID_HANDLE_VALUE {
        return Err("open existing bootstrap report failed".into());
    }
    let mut file = unsafe { std::fs::File::from_raw_handle(raw) };
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    win(
        unsafe { GetFileInformationByHandle(raw, &mut info) },
        "inspect existing bootstrap report before write",
    )?;
    if info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY) != 0
        || info.nNumberOfLinks != 1
        || info.nFileSizeHigh != 0
        || info.nFileSizeLow > 65536
    {
        return Err("bootstrap report type, alias or old byte budget invalid".into());
    }
    file.write_all(data)
        .and_then(|()| file.set_len(data.len() as u64))
        .and_then(|()| file.sync_all())
        .map_err(|e| e.to_string())
}
/// Reads only fixed diagnostic filenames under a caller-owned frozen fixture.
/// This does not authorize cleanup or attest production broker ownership.
pub fn read_fixed_report(root: &Path, kind: FixedReportKind) -> Result<Vec<u8>> {
    use std::os::windows::io::FromRawHandle;
    let id = root
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.strip_prefix("ShellSpan-AC-"))
        .and_then(|id| uuid::Uuid::parse_str(id).ok())
        .ok_or("invalid fixed report fixture UUID")?;
    if !root.is_absolute() || id.is_nil() {
        return Err("fixed report requires absolute nonnil owned fixture".into());
    }
    let _root = open_report_object(root, true)?;
    let output = root.join("output");
    let _output = open_report_object(&output, true)?;
    let (name, budget) = kind.specification();
    let handle = std::mem::ManuallyDrop::new(open_report_object(&output.join(name), false)?);
    let file = unsafe { fs::File::from_raw_handle(handle.0) };
    let mut bytes = Vec::new();
    file.take(budget + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > budget {
        return Err("fixed report budget exceeded before deserialization".into());
    }
    Ok(bytes)
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct LeafNetworkObservation {
    version: u32,
    fixture_id: uuid::Uuid,
    user_sid: String,
    report: ProbeReport,
}
const LEAF_NETWORK_CHECKS: &[&str] = &[
    "actual Winsock initialization",
    "TCP 0 denied",
    "UDP 0 API observation",
    "TCP 1 denied",
    "UDP 1 API observation",
    "TCP listener 0 denied",
    "TCP listener 1 denied",
    "private TCP 0 denied",
    "private UDP 0 API observation",
    "private TCP 1 denied",
    "private UDP 1 API observation",
    "DNS UDP API denied",
    "DNS TCP API denied",
    "DNS numeric local API control",
    "DNS cache-only API admission",
    "DNS self-context comparison",
    "DNS legacy cache-only API admission",
];
fn leaf_network_bound(
    observation: &LeafNetworkObservation,
    id: uuid::Uuid,
    user_sid: &str,
) -> bool {
    observation.version == 1
        && observation.fixture_id == id
        && !id.is_nil()
        && observation.user_sid == user_sid
        && observation.report.complete
        && observation.report.checks.len() == LEAF_NETWORK_CHECKS.len()
        && LEAF_NETWORK_CHECKS.iter().all(|name| {
            observation
                .report
                .checks
                .iter()
                .filter(|check| check.name == *name)
                .count()
                == 1
        })
}
fn probe_private_network(report: &mut ProbeReport) -> Result<()> {
    let address = |name: &str| -> Result<SocketAddr> {
        std::env::var(name)
            .map_err(|e| e.to_string())?
            .parse()
            .map_err(|e: std::net::AddrParseError| e.to_string())
    };
    let endpoints = Endpoints {
        tcp: [address("SSPA_PRIVATE_TCP0")?, address("SSPA_PRIVATE_TCP1")?],
        udp: [address("SSPA_PRIVATE_UDP0")?, address("SSPA_PRIVATE_UDP1")?],
    };
    endpoints.validate_private_local()?;
    for index in 0..2 {
        operation(
            report,
            &format!("private TCP {index} denied"),
            TcpStream::connect_timeout(&endpoints.tcp[index], Duration::from_secs(1)),
            false,
        );
        let sent = UdpSocket::bind(crate::receiver_control::local_sender_address(
            endpoints.udp[index],
        ))
        .and_then(|socket| socket.send_to(b"owned-private-probe", endpoints.udp[index]));
        report.checks.push(ProbeCheck {
            name: format!("private UDP {index} API observation"),
            passed: true,
            detail: format!("private bind/send={sent:?}; owned receiver evidence required"),
        });
    }
    Ok(())
}
fn probe_owned_dns(id: uuid::Uuid, report: &mut ProbeReport) -> Result<()> {
    let legacy = crate::dns_native_probe::query_legacy_cache_only(id)?;
    report.checks.push(ProbeCheck {
        name: "DNS legacy cache-only API admission".into(),
        passed: legacy.completion_status == Some(9701) && !legacy.records_returned,
        detail: serde_json::to_string(&legacy).map_err(|e| e.to_string())?,
    });
    let context = crate::rpc_admission_probe::observe_dns_self_context(id)?;
    report.checks.push(ProbeCheck {
        name: "DNS self-context comparison".into(),
        passed: context.security_context_equal
            && context.restored
            && context.error.is_none()
            && context.dns_cache_only.is_some(),
        detail: serde_json::to_string(&context).map_err(|e| e.to_string())?,
    });
    let cached = crate::dns_native_probe::query_cache_only(id)?;
    report.checks.push(ProbeCheck {
        name: "DNS cache-only API admission".into(),
        passed: matches!(cached.dispatch_status, 9506 | 9701)
            && cached.completion_status == Some(9701)
            && !cached.records_returned
            && !cached.fixed_answer
            && !cached.timed_out
            && cached.cancel_status.is_none(),
        detail: serde_json::to_string(&cached).map_err(|e| e.to_string())?,
    });
    let numeric = crate::dns_native_probe::query_numeric_local()?;
    report.checks.push(ProbeCheck {
        name: "DNS numeric local API control".into(),
        passed: numeric.dispatch_status == 0
            && numeric.completion_status == Some(0)
            && numeric.records_returned
            && numeric.fixed_answer
            && !numeric.timed_out
            && numeric.cancel_status.is_none(),
        detail: serde_json::to_string(&numeric).map_err(|e| e.to_string())?,
    });
    let endpoint = std::env::var("SSPA_DNS_RECEIVER")
        .map_err(|e| e.to_string())?
        .parse()
        .map_err(|e: std::net::AddrParseError| e.to_string())?;
    for (label, tcp) in [("UDP", false), ("TCP", true)] {
        let observation = crate::dns_native_probe::query_owned(id, endpoint, tcp)?;
        report.checks.push(ProbeCheck {
            name: format!("DNS {label} API denied"),
            passed: observation.explicit_api_denial(),
            detail: serde_json::to_string(&observation).map_err(|e| e.to_string())?,
        });
    }
    Ok(())
}
pub fn leaf() -> Result<()> {
    if matches!(
        std::env::var("SSPA_LIFECYCLE").as_deref(),
        Ok("timeout" | "root-failure" | "concurrent-cancel")
    ) {
        std::thread::sleep(Duration::from_secs(30));
        return Ok(());
    }
    let image = std::env::current_exe().map_err(|e| e.to_string())?;
    let root = image.parent().ok_or("missing fixed leaf image directory")?;
    registry_fixture_key(root)?;
    if PathBuf::from(std::env::var("SSPA_FIXTURE").map_err(|e| e.to_string())?) != root {
        return Err("fixed leaf fixture differs from its frozen image directory".into());
    }
    let id = uuid::Uuid::parse_str(
        root.file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.strip_prefix("ShellSpan-AC-"))
            .ok_or("invalid leaf fixture name")?,
    )
    .map_err(|e| e.to_string())?;
    if id.is_nil() {
        return Err("fixed leaf requires nonnil fixture UUID".into());
    }
    let mut raw = null_mut();
    win(
        unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) },
        "query actual leaf token",
    )?;
    let token = Handle(raw);
    let app = unsafe { query(token.0, TokenIsAppContainer) }?;
    if unsafe { *app.as_ptr().cast::<u32>() } == 0 {
        return Err("fixed network leaf requires AppContainer".into());
    }
    let user = unsafe { query(token.0, TokenUser) }?;
    let user_sid = unsafe { sid_text((*user.as_ptr().cast::<TOKEN_USER>()).User.Sid) }?;
    let address = |name: &str| -> Result<SocketAddr> {
        std::env::var(name)
            .map_err(|e| e.to_string())?
            .parse()
            .map_err(|e: std::net::AddrParseError| e.to_string())
    };
    let endpoints = Endpoints {
        tcp: [address("SSPA_TCP0")?, address("SSPA_TCP1")?],
        udp: [address("SSPA_UDP0")?, address("SSPA_UDP1")?],
    };
    endpoints.validate()?;
    let mut winsock = windows_sys::Win32::Networking::WinSock::WSADATA::default();
    let status =
        unsafe { windows_sys::Win32::Networking::WinSock::WSAStartup(0x0202, &mut winsock) };
    if status != 0 {
        return Err(format!(
            "leaf WSAStartup failed={status}; no network denial proof"
        ));
    }
    struct Winsock;
    impl Drop for Winsock {
        fn drop(&mut self) {
            unsafe {
                windows_sys::Win32::Networking::WinSock::WSACleanup();
            }
        }
    }
    let _winsock = Winsock;
    let mut report = ProbeReport {
        checks: vec![ProbeCheck {
            name: "actual Winsock initialization".into(),
            passed: true,
            detail: "actual leaf WSAStartup 2.2 return=0".into(),
        }],
        complete: false,
    };
    let mut connections = vec![];
    for index in 0..2 {
        operation(
            &mut report,
            &format!("TCP listener {index} denied"),
            TcpListener::bind(if index == 0 { "127.0.0.1:0" } else { "[::1]:0" }),
            false,
        );
        match TcpStream::connect_timeout(&endpoints.tcp[index], Duration::from_secs(1)) {
            Ok(stream) => {
                connections.push(stream);
                operation(
                    &mut report,
                    &format!("TCP {index} denied"),
                    Ok::<(), std::io::Error>(()),
                    false,
                );
            }
            Err(error) => operation(
                &mut report,
                &format!("TCP {index} denied"),
                Err::<(), _>(error),
                false,
            ),
        }
        let sent = UdpSocket::bind(if index == 0 { "127.0.0.1:0" } else { "[::1]:0" })
            .and_then(|socket| socket.send_to(b"owned-leaf", endpoints.udp[index]));
        report.checks.push(ProbeCheck {
            name: format!("UDP {index} API observation"),
            passed: true,
            detail: format!(
                "actual leaf send result={sent:?}; controller receiver counts remain required"
            ),
        });
    }
    std::thread::sleep(Duration::from_millis(100));
    drop(connections);
    probe_private_network(&mut report)?;
    probe_owned_dns(id, &mut report)?;
    report.complete = true;
    let observation = LeafNetworkObservation {
        version: 1,
        fixture_id: id,
        user_sid,
        report,
    };
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(root.join("output/leaf-network.json"))
        .map_err(|e| e.to_string())?;
    output
        .write_all(&serde_json::to_vec(&observation).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

/// Bounded untrusted diagnostic output from the fixed child. Never ownership
/// evidence; require the executable and frozen fixture to share one directory.
pub fn record_fixed_child_error(error: &str) -> Result<()> {
    let image = std::env::current_exe().map_err(|e| e.to_string())?;
    let root = image
        .parent()
        .ok_or("missing fixed diagnostic image directory")?;
    if PathBuf::from(std::env::var("SSPA_FIXTURE").map_err(|e| e.to_string())?) != root {
        return Err("fixed error output differs from frozen image directory".into());
    }
    let id = root
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.strip_prefix("ShellSpan-AC-"))
        .ok_or("invalid fixed diagnostic fixture")?;
    if uuid::Uuid::parse_str(id)
        .map_err(|e| e.to_string())?
        .is_nil()
    {
        return Err("fixed error output requires owned UUID".into());
    }
    let bounded: String = error.chars().take(2048).collect();
    fs::write(
        root.join("output/child-error.json"),
        serde_json::json!({"fixed_probe_error": bounded}).to_string(),
    )
    .map_err(|e| e.to_string())
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CredentialPrimaryObservation {
    pub version: u32,
    pub fixture_id: uuid::Uuid,
    pub user_sid: String,
    pub denial_win32: Option<u32>,
    pub error: Option<String>,
    #[serde(default)]
    pub rpc_admission: Option<crate::rpc_admission_probe::RpcAdmissionObservation>,
}
pub fn ordinary_credential_child() -> Result<()> {
    let root =
        PathBuf::from(std::env::var("SSPA_FIXTURE").map_err(|_| "fixed credential root missing")?);
    let id = root
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.strip_prefix("ShellSpan-AC-"))
        .ok_or("fixed credential fixture UUID missing")?;
    let id = uuid::Uuid::parse_str(id).map_err(|_| "fixed credential UUID invalid")?;
    if !root.is_absolute() || id.is_nil() {
        return Err("invalid fixed credential root".into());
    }
    let mut raw = null_mut();
    win(
        unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) },
        "query fixed ordinary credential Token",
    )?;
    let token = Handle(raw);
    let user = unsafe { query(token.0, TokenUser) }?;
    let user_sid = unsafe { sid_text((*user.as_ptr().cast::<TOKEN_USER>()).User.Sid) }?;
    let elevation = unsafe { query(token.0, TokenElevation) }?;
    if unsafe { (*elevation.as_ptr().cast::<TOKEN_ELEVATION>()).TokenIsElevated } != 0 {
        return Err("ordinary credential probe rejects elevated identity".into());
    }
    let reference = crate::credential_reference::OwnedCredentialReference::new(id, &user_sid)?;
    if std::env::var("SSPA_CREDENTIAL_REF").ok().as_deref() != Some(reference.reference()) {
        return Err("ordinary credential reference differs from fixed UUID/account".into());
    }
    let denial = reference.probe_plain_primary_denial(&user_sid);
    let rpc_admission = crate::rpc_admission_probe::observe(id)?;
    let report = CredentialPrimaryObservation {
        version: 1,
        fixture_id: id,
        user_sid,
        denial_win32: denial.as_ref().ok().copied(),
        error: denial.err(),
        rpc_admission: Some(rpc_admission),
    };
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(root.join("output/credential-primary-control.json"))
        .map_err(|e| e.to_string())?
        .write_all(&serde_json::to_vec(&report).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}
pub struct Fixture {
    pub root: PathBuf,
    pub image: PathBuf,
    pub package: String,
    pub tcp: [TcpListener; 2],
    pub udp: [UdpSocket; 2],
    monitor: Option<ReceiverControl>,
    private_monitor: Option<ReceiverControl>,
    dns_monitor: Option<crate::dns_receiver::DnsReceiver>,
    external_endpoints: Option<Endpoints>,
    registry_created: bool,
    registry_root: Option<RegistryRoot>,
    project_snapshots: Vec<crate::policy::FrozenProject>,
    build_source_lease: Option<crate::fixed_tool::ToolImageLease>,
}
struct RegistryRoot(HKEY);
impl Drop for RegistryRoot {
    fn drop(&mut self) {
        unsafe {
            RegCloseKey(self.0);
        }
    }
}
fn current_registry(access: REG_SAM_FLAGS) -> std::result::Result<RegistryRoot, u32> {
    let mut root = null_mut();
    let status = unsafe { RegOpenCurrentUser(access, &mut root) };
    if status != 0 {
        Err(status)
    } else {
        Ok(RegistryRoot(root))
    }
}
/// # Safety
/// `sid` must point to a valid SID held alive for this call.
pub unsafe fn sid_text(sid: PSID) -> Result<String> {
    let mut value = null_mut();
    win(
        unsafe { ConvertSidToStringSidW(sid, &mut value) },
        "format owned SID",
    )?;
    let mut length = 0;
    unsafe {
        while *value.add(length) != 0 {
            length += 1;
        }
    }
    let text = unsafe { String::from_utf16_lossy(std::slice::from_raw_parts(value, length)) };
    unsafe {
        LocalFree(value.cast());
    }
    Ok(text)
}
fn descriptor(text: &str) -> Result<*mut std::ffi::c_void> {
    let mut descriptor = null_mut();
    win(
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide(text).as_ptr(),
                1,
                &mut descriptor,
                null_mut(),
            )
        },
        "build owned fixture DACL",
    )?;
    Ok(descriptor)
}
/// # Safety
/// The Token handle and both SID buffers must remain valid throughout the check.
pub unsafe fn lpac_behavior(token: HANDLE, user: PSID, package: PSID) -> Result<bool> {
    let user = unsafe { sid_text(user) }?;
    let package = unsafe { sid_text(package) }?;
    let mut impersonation = null_mut();
    win(
        unsafe {
            DuplicateTokenEx(
                token,
                TOKEN_QUERY,
                null(),
                SecurityImpersonation,
                TokenImpersonation,
                &mut impersonation,
            )
        },
        "duplicate actual candidate Token for AccessCheck",
    )?;
    let impersonation = Handle(impersonation);
    let access = |subject: &str| -> Result<bool> {
        let sd = descriptor(&format!("O:SYG:SYD:(A;;FR;;;{user})(A;;FR;;;{subject})"))?;
        let mapping = GENERIC_MAPPING {
            GenericRead: FILE_GENERIC_READ,
            GenericWrite: FILE_GENERIC_WRITE,
            GenericExecute: FILE_GENERIC_EXECUTE,
            GenericAll: FILE_ALL_ACCESS,
        };
        let mut privileges = [0usize; 128];
        let mut bytes = std::mem::size_of_val(&privileges) as u32;
        let mut granted = 0;
        let mut allowed = 0;
        let result = win(
            unsafe {
                AccessCheck(
                    sd,
                    impersonation.0,
                    FILE_READ_DATA,
                    &mapping,
                    privileges.as_mut_ptr().cast(),
                    &mut bytes,
                    &mut granted,
                    &mut allowed,
                )
            },
            "actual package/AAP access check",
        );
        unsafe {
            LocalFree(sd);
        }
        result?;
        Ok(allowed != 0)
    };
    if !access(&package)? {
        return Err("actual Token does not pass unique package positive control".into());
    }
    verify_metadata_only_token(impersonation.0, &user, &package)?;
    Ok(!access("S-1-15-2-1")?)
}
/// Validate the proposed noninheriting metadata ACE against the actual Token.
/// This is an in-memory AccessCheck calibration, not an on-disk grant or proof
/// that Git can traverse the full ancestor chain.
fn verify_metadata_only_token(token: HANDLE, user: &str, package: &str) -> Result<()> {
    let sd = descriptor(&format!(
        "O:SYG:SYD:(A;;FA;;;{user})(A;;0x100080;;;{package})"
    ))?;
    let mapping = GENERIC_MAPPING {
        GenericRead: FILE_GENERIC_READ,
        GenericWrite: FILE_GENERIC_WRITE,
        GenericExecute: FILE_GENERIC_EXECUTE,
        GenericAll: FILE_ALL_ACCESS,
    };
    let result = (|| {
        for (access, expected) in [
            (FILE_READ_ATTRIBUTES, true),
            (SYNCHRONIZE, true),
            (FILE_LIST_DIRECTORY, false),
            (FILE_ADD_FILE, false),
            (FILE_ADD_SUBDIRECTORY, false),
            (FILE_DELETE_CHILD, false),
            (WRITE_DAC, false),
        ] {
            let mut privileges = [0usize; 128];
            let mut bytes = std::mem::size_of_val(&privileges) as u32;
            let mut granted = 0;
            let mut allowed = 0;
            win(
                unsafe {
                    AccessCheck(
                        sd,
                        token,
                        access,
                        &mapping,
                        privileges.as_mut_ptr().cast(),
                        &mut bytes,
                        &mut granted,
                        &mut allowed,
                    )
                },
                "metadata-only actual Token access check",
            )?;
            if (allowed != 0) != expected || expected && granted & access != access {
                return Err(format!(
                    "metadata-only Token boundary differs for access {access:#x}"
                ));
            }
        }
        Ok(())
    })();
    unsafe { LocalFree(sd) };
    result
}
#[cfg(test)]
mod metadata_token_tests {
    use super::*;

    #[test]
    fn ordinary_token_cannot_satisfy_metadata_only_restricting_boundary() {
        let mut raw = null_mut();
        win(
            unsafe {
                OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE, &mut raw)
            },
            "metadata test source",
        )
        .unwrap();
        let source = Handle(raw);
        let user_buffer = unsafe { query(source.0, TokenUser) }.unwrap();
        let user =
            unsafe { sid_text((*user_buffer.as_ptr().cast::<TOKEN_USER>()).User.Sid) }.unwrap();
        let mut duplicate = null_mut();
        win(
            unsafe {
                DuplicateTokenEx(
                    source.0,
                    TOKEN_QUERY,
                    null(),
                    SecurityImpersonation,
                    TokenImpersonation,
                    &mut duplicate,
                )
            },
            "metadata test duplicate",
        )
        .unwrap();
        let token = Handle(duplicate);
        assert!(
            verify_metadata_only_token(token.0, &user, "S-1-15-2-111-222-333-444-555-666-777")
                .unwrap_err()
                .contains("boundary differs")
        );
    }

    #[test]
    fn actual_lpac_metadata_calibration_keeps_owned_retirement_and_production_gate() {
        let report: serde_json::Value = serde_json::from_slice(include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../docs/design/evidence/windows-stage-a-2026-10-09-metadata-token-lpac.json"
        )))
        .unwrap();
        assert!(report["error"].is_null());
        assert_eq!(report["actual_lpac"], true);
        assert_eq!(report["production"], "unavailable");
        for field in [
            "process_tree_stopped",
            "profile_removed",
            "fixture_acls_revoked",
        ] {
            assert_eq!(report[field], true, "{field}");
        }
        assert_eq!(report["tool_admission"]["actual_exit"], 73);
        assert_eq!(report["tool_admission"]["prefix_report_bound"], true);
    }
}
pub(crate) fn set_owned_dacl(path: &Path, text: &str) -> Result<()> {
    let descriptor = descriptor(text)?;
    let mut present = 0;
    let mut defaulted = 0;
    let mut dacl = null_mut();
    let read = win(
        unsafe { GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted) },
        "read owned DACL",
    );
    let result = read.and_then(|_| {
        let status = unsafe {
            SetNamedSecurityInfoW(
                wide(path.to_str().ok_or("invalid fixture path")?).as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                dacl,
                null(),
            )
        };
        if status == 0 {
            Ok(())
        } else {
            Err(format!("owned fixture ACL: Win32 {status}"))
        }
    });
    unsafe {
        LocalFree(descriptor);
    }
    result
}
impl Fixture {
    /// # Safety
    /// Both SID buffers must remain valid for the preparation call.
    pub unsafe fn prepare(profile_name: &str, package_sid: PSID, user: PSID) -> Result<Self> {
        unsafe {
            Self::prepare_at(
                profile_name,
                package_sid,
                user,
                &std::env::temp_dir(),
                uuid::Uuid::new_v4(),
            )
        }
    }
    /// # Safety
    /// Both SID buffers must remain valid for the preparation call.
    pub unsafe fn prepare_at(
        profile_name: &str,
        package_sid: PSID,
        user: PSID,
        parent: &Path,
        id: uuid::Uuid,
    ) -> Result<Self> {
        if !parent.is_absolute() || id.is_nil() {
            return Err("fixed fixture requires absolute parent and nonnil UUID".into());
        }
        let root = parent.join(format!("ShellSpan-AC-{}", id.simple()));
        let owner = unsafe { sid_text(user) }?;
        let package = unsafe { sid_text(package_sid) }?;
        let base = format!("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;{owner})");
        let descriptor = descriptor(&base)?;
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };
        let created = win(
            unsafe {
                CreateDirectoryW(
                    wide(root.to_str().ok_or("invalid fixture root")?).as_ptr(),
                    &attributes,
                )
            },
            "create protected owned AC fixture",
        );
        unsafe {
            LocalFree(descriptor);
        }
        created?;
        // Identity and authorization plan are persisted before any package grant.
        fs::write(root.join("ownership.json"), serde_json::to_vec_pretty(&serde_json::json!({"profile":profile_name,"package_sid":package,"fixture":root,"planned_private_registry_key":registry_fixture_key(&root)?,"production":"unavailable","state":"planned package grants; owned directory retained"})).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let tcp = [
            TcpListener::bind("127.0.0.1:0"),
            TcpListener::bind("[::1]:0"),
        ]
        .into_iter()
        .collect::<std::io::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?
        .try_into()
        .map_err(|_| "TCP receiver count")?;
        let udp = [UdpSocket::bind("127.0.0.1:0"), UdpSocket::bind("[::1]:0")]
            .into_iter()
            .collect::<std::io::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?
            .try_into()
            .map_err(|_| "UDP receiver count")?;
        let fixture = Self {
            root: root.clone(),
            image: root.join("probe.exe"),
            package,
            tcp,
            udp,
            monitor: None,
            private_monitor: None,
            dns_monitor: None,
            external_endpoints: None,
            registry_created: false,
            registry_root: None,
            project_snapshots: Vec::new(),
            build_source_lease: None,
        };
        Ok(fixture)
    }
    /// # Safety
    /// `user` must point to the same valid source-user SID used at preparation.
    pub unsafe fn populate(&mut self, user: PSID) -> Result<()> {
        if !self.project_snapshots.is_empty() {
            return Err("frozen execution project cannot be repopulated".into());
        }
        let mut project_snapshots = Vec::new();
        if self.registry_root.is_none() {
            self.bind_current_registry()?;
        }
        let registry_root = self
            .registry_root
            .as_ref()
            .ok_or("source registry binding missing")?
            .0;
        let root = &self.root;
        let owner = unsafe { sid_text(user) }?;
        let package = &self.package;
        let base = format!("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;{owner})");
        let key = registry_fixture_key(root)?;
        let sd = descriptor(&format!("D:P(A;;KA;;;SY)(A;;KA;;;{owner})"))?;
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: sd,
            bInheritHandle: 0,
        };
        let mut handle = null_mut();
        let mut disposition = 0;
        let status = unsafe {
            RegCreateKeyExW(
                registry_root,
                wide(&key).as_ptr(),
                0,
                null(),
                REG_OPTION_NON_VOLATILE,
                KEY_READ | KEY_WRITE,
                &attributes,
                &mut handle,
                &mut disposition,
            )
        };
        unsafe {
            LocalFree(sd);
        }
        if status != 0 {
            return Err(format!("owned registry creation Win32={status}"));
        }
        unsafe {
            RegCloseKey(handle);
        }
        if disposition != REG_CREATED_NEW_KEY {
            return Err("refuse preexisting registry fixture".into());
        }
        self.registry_created = true;
        for access in [KEY_READ, KEY_WRITE] {
            let status = registry_open_at(registry_root, &key, access);
            if status != 0 {
                return Err(format!("host registry positive control Win32={status}"));
            }
        }
        fs::create_dir(root.join("output")).map_err(|e| e.to_string())?;
        self.build_source_lease = Some(crate::fixed_tool::create_fixed_build_source(root)?);
        for name in [
            "readonly.txt",
            "workspace.txt",
            "secret.txt",
            "external.txt",
            "external-aap.txt",
            "external-everyone.txt",
            ".env.local",
        ] {
            fs::write(root.join(name), b"owned non-secret fixture\n").map_err(|e| e.to_string())?;
        }
        for name in ["readonly.txt", "workspace.txt", "secret.txt"] {
            fs::write(
                root.join(format!("{name}:owned-probe")),
                b"owned ADS fixture",
            )
            .map_err(|e| e.to_string())?;
        }
        let image = root.join("probe.exe");
        fs::copy(std::env::current_exe().map_err(|e| e.to_string())?, &image)
            .map_err(|e| e.to_string())?;
        let base_no_inherit = format!("D:P(A;;FA;;;SY)(A;;FA;;;{owner})");
        fs::create_dir(root.join("metadata-only")).map_err(|e| e.to_string())?;
        fs::write(
            root.join("metadata-only/child.txt"),
            b"owned metadata calibration",
        )
        .map_err(|e| e.to_string())?;
        set_owned_dacl(&root.join("metadata-only/child.txt"), &base_no_inherit)?;
        fs::write(root.join("output/protected.txt"), b"owned protected child")
            .map_err(|e| e.to_string())?;
        set_owned_dacl(&root.join("output/protected.txt"), &base_no_inherit)?;
        for (project_name, workspace, independently_sensitive) in [
            ("default-project", false, false),
            ("workspace-project", true, false),
            ("sensitive-project", true, true),
        ] {
            let project = root.join(project_name);
            fs::create_dir(&project).map_err(|e| e.to_string())?;
            for directory in ["nested", "rules", "ordinary-directory"] {
                fs::create_dir(project.join(directory)).map_err(|e| e.to_string())?;
            }
            for relative in [
                ".env.local",
                "nested/.env.local",
                "rules/config.json",
                "ordinary.txt",
            ] {
                fs::write(project.join(relative), b"owned default policy fixture")
                    .map_err(|e| e.to_string())?;
                set_owned_dacl(&project.join(relative), &base_no_inherit)?;
                fs::read(project.join(relative)).map_err(|e| e.to_string())?;
                OpenOptions::new()
                    .write(true)
                    .open(project.join(relative))
                    .map_err(|e| e.to_string())?;
            }
            let sensitive_targets: &[&str] = if independently_sensitive {
                &[".env.local", "rules/config.json"]
            } else {
                &[]
            };
            let project_rules = crate::policy::FrozenRules::new(sensitive_targets, &["rules"])?;
            let mut project_snapshot =
                crate::policy::freeze_owned_project_with_rules(&project, &project_rules)?;
            let root_mask =
                crate::policy::access(workspace, crate::policy::Object::PinnedDirectory);
            set_owned_dacl(
                &project,
                &format!("{base_no_inherit}(A;;0x{root_mask:08x};;;{package})"),
            )?;
            for (relative, object) in &project_snapshot.entries {
                let mask = crate::policy::access(workspace, *object);
                let package_ace = if mask == 0 {
                    String::new()
                } else {
                    format!("(A;;0x{mask:08x};;;{package})")
                };
                set_owned_dacl(
                    &project.join(relative),
                    &format!("{base_no_inherit}{package_ace}"),
                )?;
            }
            project_snapshot.verify_unchanged()?;
            project_snapshot.retain_protected_leases();
            project_snapshots.push(project_snapshot);
        }
        for name in [
            "readonly.txt",
            "workspace.txt",
            "secret.txt",
            "workspace-project/ordinary.txt",
        ] {
            let stream = root.join(format!("{name}:new-stream-source-control"));
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&stream)
                .and_then(|mut file| file.write_all(b"fixed source ADS control"))
                .map_err(|e| e.to_string())?;
            if fs::read(&stream).map_err(|e| e.to_string())? != b"fixed source ADS control" {
                return Err("source ADS creation content mismatch".into());
            }
            fs::remove_file(stream).map_err(|e| e.to_string())?;
        }
        verify_protected_delete_source_control(root)?;
        // Freeze independent negative targets before any package ACL grant.
        let rules = crate::policy::FrozenRules::new(
            &[
                "secret.txt",
                "external.txt",
                "external-aap.txt",
                "external-everyone.txt",
                ".env.local",
                "output/protected.txt",
            ],
            &["fixed-build.cs"],
        )?;
        let mut snapshot = crate::policy::freeze_owned_project_with_rules(root, &rules)?;
        if snapshot.entries.get("fixed-build.cs") != Some(&crate::policy::Object::Rules) {
            return Err("fixed build source requires retained readonly lease".into());
        }
        if snapshot.entries.get("output") != Some(&crate::policy::Object::PinnedDirectory) {
            return Err("protected child requires pinned output ancestor".into());
        }
        for (path, access, flags) in [
            (root.to_path_buf(), "FRFX", ""),
            (image.clone(), "FRFX", ""),
            (root.join("readonly.txt"), "FR", ""),
            (root.join("fixed-build.cs"), "FR", ""),
            (root.join("workspace.txt"), "FRFW", ""),
            // DELETE on an ordinary child supports rename/removal. Never grant
            // FILE_DELETE_CHILD on the parent: it bypasses protected child DACLs.
            (root.join("output"), "FRFWFX", "OICI"),
        ] {
            let host_base = if flags == "OICI" || path == *root {
                &base
            } else {
                &base_no_inherit
            };
            // DELETE is inherited only by ordinary descendants. The output
            // parent itself cannot be moved to expose its protected child.
            let child_delete = if path == root.join("output") {
                format!("(A;OICIIO;SD;;;{package})")
            } else {
                String::new()
            };
            set_owned_dacl(
                &path,
                &format!("{host_base}(A;{flags};{access};;;{package}){child_delete}"),
            )?;
        }
        set_owned_dacl(
            &root.join("external-aap.txt"),
            &format!("{base_no_inherit}(A;;FR;;;S-1-15-2-1)"),
        )?;
        // Only this owned calibration directory is changed. The package ACE
        // has no inheritance flags and does not authorize listing or children.
        set_owned_dacl(
            &root.join("metadata-only"),
            &format!("{base_no_inherit}(A;;0x100080;;;{package})"),
        )?;
        set_owned_dacl(
            &root.join("external-everyone.txt"),
            &format!("{base_no_inherit}(A;;FRFW;;;WD)"),
        )?;
        // Each negative file case must remain reachable to the ordinary source
        // user, rather than passing because the fixture removed host access.
        for name in [
            "readonly.txt",
            "workspace.txt",
            "secret.txt",
            "external.txt",
            "external-aap.txt",
            "external-everyone.txt",
            ".env.local",
        ] {
            if fs::read(root.join(name)).map_err(|e| e.to_string())?
                != b"owned non-secret fixture\n"
            {
                return Err("ordinary file positive control mismatch".into());
            }
            OpenOptions::new()
                .write(true)
                .open(root.join(name))
                .map_err(|e| e.to_string())?;
        }
        snapshot.verify_unchanged()?;

        verify_ads_source_controls(root)?;
        verify_protected_child_source_control(root)?;
        verify_everyone_control(root)?;
        verify_hardlink_source_controls(root)?;
        snapshot.verify_unchanged()?;
        snapshot.retain_protected_leases();
        project_snapshots.push(snapshot);
        self.project_snapshots = project_snapshots;
        Ok(())
    }
    pub fn bind_current_registry(&mut self) -> Result<()> {
        if self.registry_created || self.registry_root.is_some() {
            return Err("fixture registry binding cannot be replaced".into());
        }
        self.registry_root =
            Some(current_registry(KEY_READ | KEY_WRITE).map_err(|status| {
                format!("open exact current-user fixture hive: Win32 {status}")
            })?);
        Ok(())
    }
    pub fn verify_source_controls(&self) -> Result<()> {
        let root = self
            .registry_root
            .as_ref()
            .ok_or("source registry binding missing")?
            .0;
        let key = registry_fixture_key(&self.root)?;
        for access in [KEY_READ, KEY_WRITE] {
            let status = registry_open_at(root, &key, access);
            if status != 0 {
                return Err(format!("source registry positive control Win32={status}"));
            }
        }
        for name in [
            "readonly.txt",
            "workspace.txt",
            "secret.txt",
            "external.txt",
            "external-aap.txt",
            "external-everyone.txt",
            ".env.local",
        ] {
            if fs::read(self.root.join(name)).map_err(|e| e.to_string())?
                != b"owned non-secret fixture\n"
            {
                return Err("source file positive control mismatch".into());
            }
            OpenOptions::new()
                .write(true)
                .open(self.root.join(name))
                .map_err(|e| e.to_string())?;
        }
        verify_ads_source_controls(&self.root)?;
        verify_protected_child_source_control(&self.root)?;
        verify_everyone_control(&self.root)?;
        verify_hardlink_source_controls(&self.root)?;
        Ok(())
    }
    pub fn environment(&self) -> Result<String> {
        let short = fixed_short_alias(&self.root)?;
        let sensitive = fixed_short_alias(&self.root.join(".env.local"))?;
        let mut environment = format!(
            "SSPA_CONTROLLER_PID={}\0SSPA_FIXTURE={}\0",
            unsafe { GetCurrentProcessId() },
            self.root.to_str().ok_or("invalid fixture")?
        );
        environment.push_str(&format!(
            "SSPA_SHORT_FIXTURE={}\0",
            short.to_str().ok_or("invalid fixed short alias")?
        ));
        environment.push_str(&format!(
            "SSPA_SHORT_SENSITIVE={}\0",
            sensitive.to_str().ok_or("invalid short sensitive alias")?
        ));
        for (index, listener) in self.tcp.iter().enumerate() {
            environment.push_str(&format!(
                "SSPA_TCP{index}={}\0",
                if let Some(endpoints) = &self.external_endpoints {
                    endpoints.tcp[index]
                } else {
                    listener.local_addr().map_err(|e| e.to_string())?
                }
            ));
        }
        for (index, receiver) in self.udp.iter().enumerate() {
            environment.push_str(&format!(
                "SSPA_UDP{index}={}\0",
                if let Some(endpoints) = &self.external_endpoints {
                    endpoints.udp[index]
                } else {
                    receiver.local_addr().map_err(|e| e.to_string())?
                }
            ));
        }
        if let Some(monitor) = &self.private_monitor {
            let endpoints = monitor.endpoints();
            for index in 0..2 {
                environment.push_str(&format!(
                    "SSPA_PRIVATE_TCP{index}={}\0SSPA_PRIVATE_UDP{index}={}\0",
                    endpoints.tcp[index], endpoints.udp[index]
                ));
            }
        }
        if self.dns_monitor.is_some() {
            environment.push_str("SSPA_DNS_RECEIVER=127.0.0.1:53\0");
        }
        Ok(environment)
    }
    pub fn start_fixed_private_receivers(&mut self) -> Result<()> {
        if self.private_monitor.is_some() {
            return Err("private receiver ownership already frozen".into());
        }
        self.private_monitor = Some(ReceiverControl::bind_fixed_private_local()?);
        Ok(())
    }
    pub fn start_fixed_dns_receiver(&mut self) -> Result<()> {
        if self.dns_monitor.is_some() {
            return Err("DNS receiver ownership already frozen".into());
        }
        let id = self
            .root
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.strip_prefix("ShellSpan-AC-"))
            .ok_or("invalid owned DNS fixture")?;
        self.dns_monitor = Some(crate::dns_receiver::DnsReceiver::bind(
            uuid::Uuid::parse_str(id).map_err(|e| e.to_string())?,
        )?);
        Ok(())
    }
    pub fn use_controller_endpoints(&mut self, endpoints: Endpoints) -> Result<()> {
        endpoints.validate()?;
        if self.monitor.is_some() {
            return Err("receiver ownership must be frozen before monitor startup".into());
        }
        self.external_endpoints = Some(endpoints);
        Ok(())
    }
    pub fn start_receivers(&mut self) -> Result<()> {
        if self.external_endpoints.is_none() {
            self.monitor = Some(ReceiverControl::start(&self.tcp, &self.udp)?);
        }
        Ok(())
    }
    pub fn observe(&mut self) -> Result<ProbeReport> {
        std::thread::sleep(Duration::from_millis(200));
        let data = read_fixed_report(&self.root, FixedReportKind::Workload)?;
        let mut report: ProbeReport = serde_json::from_slice(&data).map_err(|e| e.to_string())?;
        if report.complete {
            report.checks.push(ProbeCheck {
                name: "controller verified protected child survived unchanged".into(),
                passed: fs::read(self.root.join("output/protected.txt"))
                    .is_ok_and(|data| data == b"owned protected child")
                    && !self.root.join("output/renamed-protected.txt").exists(),
                detail: "controller reads fixed non-sensitive fixture after exact execution tree stopped".into(),
            });
        }
        if let Some(mut monitor) = self.private_monitor.take() {
            for (index, received) in monitor.finish()?.iter().enumerate() {
                report.checks.push(ProbeCheck {
                    name: format!("private {} receiver {} no traffic", if index < 2 { "TCP" } else { "UDP" }, index % 2),
                    passed: *received == 0,
                    detail: format!("owned private receiver; before/after controls verified; received={received}"),
                });
            }
        }
        if let Some(mut monitor) = self.dns_monitor.take() {
            let counts = monitor.finish()?;
            let owners = serde_json::to_string(monitor.tcp_sender_observations()?)
                .map_err(|e| e.to_string())?;
            for (label, received) in ["UDP", "TCP"].into_iter().zip(counts) {
                report.checks.push(ProbeCheck {
                    name: format!("DNS {label} receiver no traffic"),
                    passed: received == 0,
                    detail: format!(
                        "owned DNS native before/after controls verified; received={received}{}",
                        if label == "TCP" {
                            format!("; tcp_sender_owners={owners}")
                        } else {
                            String::new()
                        }
                    ),
                });
            }
        }
        if self.external_endpoints.is_some() {
            // Only the controller holding its receiver handles can attest quietness.
            return Ok(report);
        }
        let mut monitor = self
            .monitor
            .take()
            .ok_or("receiver monitor was not started")?;
        for (index, received) in monitor.finish()?.iter().enumerate() {
            report.checks.push(ProbeCheck {
                name: format!("{} receiver {} no traffic", if index < 2 { "TCP" } else { "UDP" }, index % 2),
                passed: *received == 0,
                detail: format!("controller-owned cloned workers passed positive controls before Resume and after tree stop; final controls subtracted once; received={received}"),
            });
        }
        Ok(report)
    }
    /// Revoke only file ACEs after the caller has verified the owned root identity
    /// and established that all execution processes have stopped. This does not
    /// attest registry or profile retirement.
    pub fn revoke_files(
        root: &Path,
        package: &str,
        expected_root: Option<(u32, u64)>,
    ) -> Result<()> {
        Self::revoke_files_budget(root, package, expected_root, 64)
    }
    pub fn revoke_runtime_files(
        root: &Path,
        package: &str,
        expected_root: (u32, u64),
    ) -> Result<()> {
        Self::revoke_files_budget(root, package, Some(expected_root), 768)
    }
    fn revoke_files_budget(
        root: &Path,
        package: &str,
        expected_root: Option<(u32, u64)>,
        budget: usize,
    ) -> Result<()> {
        let mut paths = vec![root.to_path_buf()];
        let mut leases = Vec::new();
        let mut index = 0;
        while index < paths.len() {
            let path = paths[index].clone();
            leases.push(verify_retirement_object(&path)?);
            if index == 0 {
                let mut info = BY_HANDLE_FILE_INFORMATION::default();
                win(
                    unsafe { GetFileInformationByHandle(leases[0].0, &mut info) },
                    "verify held retirement root identity",
                )?;
                let actual = (
                    info.dwVolumeSerialNumber,
                    (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
                );
                if info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
                    || expected_root.is_some_and(|expected| expected != actual)
                {
                    return Err("owned retirement root identity changed; retain debt".into());
                }
            }
            if fs::symlink_metadata(&path)
                .map_err(|e| e.to_string())?
                .file_type()
                .is_symlink()
            {
                return Err("owned AC fixture reparse rejected".into());
            }
            if path.is_dir() {
                for entry in fs::read_dir(&path).map_err(|e| e.to_string())? {
                    paths.push(entry.map_err(|e| e.to_string())?.path());
                }
            }
            if paths.len() > budget {
                return Err("owned AC cleanup budget exceeded".into());
            }
            index += 1;
        }
        verify_retirement_inventory_budget(&paths, budget)?;
        for lease in leases.iter().rev() {
            let mut old = null_mut();
            let mut sd = null_mut();
            let status = unsafe {
                GetSecurityInfo(
                    lease.0,
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    null_mut(),
                    null_mut(),
                    &mut old,
                    null_mut(),
                    &mut sd,
                )
            };
            if status != 0 {
                return Err(format!("owned AC cleanup read: {status}"));
            }
            if old.is_null() {
                unsafe {
                    LocalFree(sd);
                }
                return Err("NULL owned DACL rejected during cleanup".into());
            }
            let mut sid = null_mut();
            let parsed = win(
                unsafe { ConvertStringSidToSidW(wide(package).as_ptr(), &mut sid) },
                "parse owned package SID",
            );
            if let Err(error) = parsed {
                unsafe {
                    LocalFree(sd);
                }
                return Err(error);
            }
            let entry = EXPLICIT_ACCESS_W {
                grfAccessMode: REVOKE_ACCESS,
                Trustee: TRUSTEE_W {
                    TrusteeForm: TRUSTEE_IS_SID,
                    TrusteeType: TRUSTEE_IS_UNKNOWN,
                    ptstrName: sid.cast(),
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut merged = null_mut();
            let merged_status = unsafe { SetEntriesInAclW(1, &entry, old, &mut merged) };
            let result = if merged_status == 0 {
                unsafe {
                    SetSecurityInfo(
                        lease.0,
                        SE_FILE_OBJECT,
                        DACL_SECURITY_INFORMATION,
                        null_mut(),
                        null_mut(),
                        merged,
                        null(),
                    )
                }
            } else {
                merged_status
            };
            unsafe {
                LocalFree(sd);
                LocalFree(sid);
                if !merged.is_null() {
                    LocalFree(merged.cast());
                }
            }
            if result != 0 {
                return Err(format!("owned package ACL cleanup: {result}"));
            }
        }
        // Incremental parent revocation can remove inherited ACEs. Inspect the
        // actual final DACL of every generated object, not API return codes alone.
        for lease in &leases {
            let mut old = null_mut();
            let mut sd = null_mut();
            let status = unsafe {
                GetSecurityInfo(
                    lease.0,
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    null_mut(),
                    null_mut(),
                    &mut old,
                    null_mut(),
                    &mut sd,
                )
            };
            if status != 0 {
                return Err(format!("verify owned AC ACL: {status}"));
            }
            if old.is_null() {
                unsafe {
                    LocalFree(sd);
                }
                return Err("NULL final owned DACL".into());
            }
            let mut subject = null_mut();
            let parsed = win(
                unsafe { ConvertStringSidToSidW(wide(package).as_ptr(), &mut subject) },
                "parse final package SID",
            );
            if let Err(error) = parsed {
                unsafe {
                    LocalFree(sd);
                }
                return Err(error);
            }
            let mut remains = false;
            let mut inspect_error = None;
            for index in 0..unsafe { (*old).AceCount } as u32 {
                let mut raw = null_mut();
                if unsafe { GetAce(old, index, &mut raw) } == 0 {
                    inspect_error = Some("inspect final owned ACE failed".to_string());
                    break;
                }
                let ace = unsafe { &*raw.cast::<ACCESS_ALLOWED_ACE>() };
                if ace.Header.AceType == 0
                    && unsafe { EqualSid((&ace.SidStart as *const u32).cast_mut().cast(), subject) }
                        != 0
                {
                    remains = true;
                }
            }
            unsafe {
                LocalFree(sd);
                LocalFree(subject);
            }
            if let Some(error) = inspect_error {
                return Err(error);
            }
            if remains {
                return Err("owned package ACE remains; retain profile and fixture".into());
            }
        }
        verify_retirement_inventory_budget(&paths, budget)?;
        Ok(())
    }
    pub fn revoke(&self) -> Result<()> {
        self.revoke_bound(None)
    }
    pub fn revoke_bound(&self, expected_root: Option<(u32, u64)>) -> Result<()> {
        self.revoke_budget(expected_root, 64)
    }
    /// Fixed larger inventory only for the owned PowerShell runtime experiment.
    pub fn revoke_runtime_bound(&self, expected_root: Option<(u32, u64)>) -> Result<()> {
        self.revoke_budget(expected_root, 768)
    }
    fn revoke_budget(&self, expected_root: Option<(u32, u64)>, budget: usize) -> Result<()> {
        Self::revoke_files_budget(&self.root, &self.package, expected_root, budget)?;
        if self.registry_created {
            let key = registry_fixture_key(&self.root)?;
            let registry_root = self
                .registry_root
                .as_ref()
                .ok_or("owned registry binding missing at retirement")?
                .0;
            let status = unsafe { RegDeleteTreeW(registry_root, wide(&key).as_ptr()) };
            if status != 0 {
                return Err(format!("owned registry retirement Win32={status}"));
            }
            if registry_open_at(registry_root, &key, KEY_READ) != 2 {
                return Err("owned registry absence unconfirmed".into());
            }
        }
        let receipt = self.root.join("ownership.json");
        let mut ownership: serde_json::Value =
            serde_json::from_slice(&fs::read(&receipt).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        ownership["state"] = "all owned package ACEs revoked and actual DACLs verified; fixture retained as evidence".into();
        fs::write(
            receipt,
            serde_json::to_vec_pretty(&ownership).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }
}
fn operation(
    report: &mut ProbeReport,
    name: &str,
    result: std::io::Result<impl Sized>,
    allowed: bool,
) {
    let passed = if allowed {
        result.is_ok()
    } else {
        result
            .as_ref()
            .err()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::PermissionDenied)
    };
    report.checks.push(ProbeCheck {
        name: name.into(),
        passed,
        detail: format!(
            "actual child operation Win32={:?}",
            result.err().and_then(|error| error.raw_os_error())
        ),
    });
}
fn registry_fixture_key(root: &Path) -> Result<String> {
    let id = root
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.strip_prefix("ShellSpan-AC-"))
        .ok_or("invalid owned registry fixture root")?;
    let id = uuid::Uuid::parse_str(id).map_err(|e| e.to_string())?;
    Ok(format!(r"Software\ShellSpanStageA-{}", id.simple()))
}
fn registry_open(key: &str, access: REG_SAM_FLAGS) -> u32 {
    let root = match current_registry(access) {
        Ok(root) => root,
        Err(status) => return status,
    };
    registry_open_at(root.0, key, access)
}
fn registry_open_at(root: HKEY, key: &str, access: REG_SAM_FLAGS) -> u32 {
    let mut handle = null_mut();
    let status = unsafe { RegOpenKeyExW(root, wide(key).as_ptr(), 0, access, &mut handle) };
    if status == 0 {
        unsafe {
            RegCloseKey(handle);
        }
    }
    status
}
fn verify_hardlink_source_controls(root: &Path) -> Result<()> {
    for name in ["readonly.txt", "secret.txt"] {
        let alias = root.join(format!("output/control-link-{name}"));
        fs::hard_link(root.join(name), &alias).map_err(|e| e.to_string())?;
        let valid = fs::read(&alias).is_ok_and(|data| data == b"owned non-secret fixture\n");
        // This exact, newly-created diagnostic alias must be removed so it
        // cannot leave an extra link on the owned source during ACL retirement.
        fs::remove_file(&alias).map_err(|e| e.to_string())?;
        if !valid {
            return Err("source hardlink positive control mismatch".into());
        }
    }
    Ok(())
}
fn verify_everyone_control(root: &Path) -> Result<()> {
    let path = root.join("external-everyone.txt");
    let file = unsafe {
        CreateFileW(
            wide(path.to_str().ok_or("invalid Everyone fixture path")?).as_ptr(),
            READ_CONTROL,
            FILE_SHARE_READ,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    };
    if file == INVALID_HANDLE_VALUE {
        return Err("open Everyone fixture security failed".into());
    }
    let file = Handle(file);
    let mut dacl = null_mut();
    let mut descriptor = null_mut();
    let status = unsafe {
        GetSecurityInfo(
            file.0,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            &mut dacl,
            null_mut(),
            &mut descriptor,
        )
    };
    let result = (|| {
        if status != 0 || dacl.is_null() {
            return Err("Everyone fixture DACL unavailable".into());
        }
        let mut allowed = false;
        for index in 0..unsafe { (*dacl).AceCount } as u32 {
            let mut raw = null_mut();
            win(
                unsafe { GetAce(dacl, index, &mut raw) },
                "inspect Everyone fixture ACE",
            )?;
            let ace = unsafe { &*raw.cast::<ACCESS_ALLOWED_ACE>() };
            if ace.Header.AceType != 0 {
                return Err("unexpected Everyone fixture ACE type".into());
            }
            let sid = unsafe { sid_text((&ace.SidStart as *const u32).cast_mut().cast()) }?;
            if sid.starts_with("S-1-15-") {
                return Err(
                    "Everyone fixture must not contain a package or capability grant".into(),
                );
            }
            if sid == "S-1-1-0" {
                let required = FILE_GENERIC_READ | FILE_GENERIC_WRITE;
                allowed = ace.Mask & required == required;
            }
        }
        if allowed {
            Ok(())
        } else {
            Err("actual Everyone read/write grant missing".into())
        }
    })();
    if !descriptor.is_null() {
        unsafe {
            LocalFree(descriptor);
        }
    }
    result
}
fn directory_delete_access(path: &Path) -> std::io::Result<()> {
    let path = path
        .to_str()
        .ok_or_else(|| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let raw = unsafe {
        CreateFileW(
            wide(path).as_ptr(),
            DELETE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    };
    if raw == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error());
    }
    drop(Handle(raw));
    Ok(())
}
fn verify_protected_child_source_control(root: &Path) -> Result<()> {
    let path = root.join("output/protected.txt");
    if fs::read(&path).map_err(|e| e.to_string())? != b"owned protected child" {
        return Err("protected child source control mismatch".into());
    }
    OpenOptions::new()
        .write(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    Ok(())
}
fn verify_protected_delete_source_control(root: &Path) -> Result<()> {
    directory_delete_access(&root.join("output"))
        .map_err(|e| format!("source parent DELETE control: {e}"))?;
    let path = root.join("output/protected.txt");
    let delete_access = unsafe {
        CreateFileW(
            wide(path.to_str().ok_or("invalid protected child path")?).as_ptr(),
            DELETE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    };
    if delete_access == INVALID_HANDLE_VALUE {
        return Err(format!(
            "protected child source DELETE control Win32={}",
            unsafe { GetLastError() }
        ));
    }
    drop(Handle(delete_access));
    Ok(())
}
fn verify_ads_source_controls(root: &Path) -> Result<()> {
    for name in ["readonly.txt", "workspace.txt", "secret.txt"] {
        let stream = root.join(format!("{name}:owned-probe"));
        if fs::read(&stream).map_err(|e| e.to_string())? != b"owned ADS fixture" {
            return Err("source ADS positive control mismatch".into());
        }
        OpenOptions::new()
            .write(true)
            .open(&stream)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn breakaway(report: &mut ProbeReport) -> Result<()> {
    let image = std::env::current_exe().map_err(|e| e.to_string())?;
    let image = wide(image.to_str().ok_or("invalid fixed breakaway image")?);
    let mut command = wide("probe.exe --owned-fixed-leaf");
    let mut startup: STARTUPINFOW = unsafe { std::mem::zeroed() };
    startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
    let mut info: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    let created = unsafe {
        CreateProcessW(
            image.as_ptr(),
            command.as_mut_ptr(),
            null(),
            null(),
            0,
            CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB,
            null(),
            null(),
            &startup,
            &mut info,
        )
    };
    let error = if created == 0 {
        Some(unsafe { GetLastError() })
    } else {
        None
    };
    if created != 0 {
        let process = Handle(info.hProcess);
        let _thread = Handle(info.hThread);
        win(
            unsafe { TerminateProcess(process.0, 2) },
            "retire unexpected suspended breakaway",
        )?;
        if unsafe { WaitForSingleObject(process.0, 5000) } != WAIT_OBJECT_0 {
            return Err("unexpected breakaway remains live; retain resource debt".into());
        }
    }
    report.checks.push(ProbeCheck {
        name: "explicit Job breakaway denied".into(),
        passed: breakaway_denied(created, error),
        detail: format!("same fixed image, no inherited handles, never resumed; creation={created}, Win32={error:?}"),
    });
    Ok(())
}
fn breakaway_denied(created: i32, error: Option<u32>) -> bool {
    created == 0 && error == Some(ERROR_ACCESS_DENIED)
}
fn concurrent_descendants(source: HANDLE) -> Result<()> {
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
    let mut workers = Vec::new();
    // The source Token handle remains owned by the calling root until both
    // workers join. Each worker owns its child handles and independent report.
    for marker in ["descendant-resumed-0", "descendant-resumed-1"] {
        let barrier = barrier.clone();
        let source = source as usize;
        workers.push(std::thread::spawn(move || {
            barrier.wait();
            let mut report = ProbeReport {
                checks: Vec::new(),
                complete: false,
            };
            descendant(&mut report, source as HANDLE, marker)
        }));
    }
    barrier.wait();
    let mut failure = None;
    for worker in workers {
        if let Err(error) = worker
            .join()
            .map_err(|_| "fixed concurrent worker panicked".to_owned())
            .and_then(|result| result)
        {
            failure.get_or_insert(error);
        }
    }
    failure.map_or(Ok(()), Err)
}
fn descendant(report: &mut ProbeReport, source: HANDLE, marker_name: &str) -> Result<()> {
    let image = std::env::current_exe().map_err(|e| e.to_string())?;
    let image = wide(image.to_str().ok_or("invalid fixed descendant image")?);
    let mut command = wide("probe.exe --owned-fixed-leaf");
    let mut startup: STARTUPINFOW = unsafe { std::mem::zeroed() };
    startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
    let mut info: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    win(
        unsafe {
            CreateProcessW(
                image.as_ptr(),
                command.as_mut_ptr(),
                null(),
                null(),
                0,
                CREATE_SUSPENDED | CREATE_NO_WINDOW,
                null(),
                null(),
                &startup,
                &mut info,
            )
        },
        "create fixed suspended descendant",
    )?;
    let process = Handle(info.hProcess);
    let thread = Handle(info.hThread);
    let outcome = (|| {
        let mut raw = null_mut();
        win(
            unsafe { OpenProcessToken(process.0, TOKEN_QUERY | TOKEN_DUPLICATE, &mut raw) },
            "query actual descendant Token",
        )?;
        let token = Handle(raw);
        for (name, class) in [
            ("descendant user identity", TokenUser),
            ("descendant package identity", TokenAppContainerSid),
            ("descendant low integrity", TokenIntegrityLevel),
        ] {
            let parent = unsafe { query(source, class) }?;
            let child = unsafe { query(token.0, class) }?;
            // Each queried structure starts with its relevant SID pointer.
            let parent_sid = unsafe { *parent.as_ptr().cast::<PSID>() };
            let child_sid = unsafe { *child.as_ptr().cast::<PSID>() };
            let passed = unsafe { EqualSid(parent_sid, child_sid) } != 0;
            report.checks.push(ProbeCheck {
                name: name.into(),
                passed,
                detail: "actual suspended descendant Token SID equals fixed parent Token".into(),
            });
            if !passed {
                return Err("descendant security identity mismatch".into());
            }
        }
        let parent_caps = unsafe { query(source, TokenCapabilities) }?;
        let child_caps = unsafe { query(token.0, TokenCapabilities) }?;
        let parent_caps = unsafe { &*parent_caps.as_ptr().cast::<TOKEN_GROUPS>() };
        let child_caps = unsafe { &*child_caps.as_ptr().cast::<TOKEN_GROUPS>() };
        let mut passed =
            parent_caps.GroupCount == child_caps.GroupCount && parent_caps.GroupCount <= 16;
        if passed {
            for index in 0..parent_caps.GroupCount as usize {
                let p = unsafe { &*parent_caps.Groups.as_ptr().add(index) };
                let c = unsafe { &*child_caps.Groups.as_ptr().add(index) };
                passed &= p.Attributes == c.Attributes && unsafe { EqualSid(p.Sid, c.Sid) } != 0;
            }
        }
        report.checks.push(ProbeCheck {
            name: "descendant exact capabilities".into(),
            passed,
            detail: "actual suspended Token count, SID and attributes match parent".into(),
        });
        if !passed {
            return Err("descendant capabilities mismatch".into());
        }
        let user = unsafe { query(token.0, TokenUser) }?;
        let package = unsafe { query(token.0, TokenAppContainerSid) }?;
        let lpac = unsafe {
            lpac_behavior(
                token.0,
                *user.as_ptr().cast::<PSID>(),
                *package.as_ptr().cast::<PSID>(),
            )
        }?;
        report.checks.push(ProbeCheck {
            name: "descendant actual LPAC".into(),
            passed: lpac,
            detail: "actual Token package positive control and AAP exclusion".into(),
        });
        let mut member = 0;
        win(
            unsafe {
                windows_sys::Win32::System::JobObjects::IsProcessInJob(
                    process.0,
                    null_mut(),
                    &mut member,
                )
            },
            "query descendant Job membership",
        )?;
        report.checks.push(ProbeCheck { name: "descendant Job membership".into(), passed: member != 0, detail: "created without breakaway flags or inherited handles; actual suspended process is in a Job".into() });
        if member == 0 || !lpac {
            return Err("descendant confinement mismatch".into());
        }
        if unsafe { ResumeThread(thread.0) } == u32::MAX {
            return Err("descendant resume failed".into());
        }
        if matches!(
            std::env::var("SSPA_LIFECYCLE").as_deref(),
            Ok("timeout" | "root-failure" | "concurrent-cancel")
        ) {
            let root = std::env::current_exe()
                .map_err(|e| e.to_string())?
                .parent()
                .ok_or("missing fixed image directory")?
                .to_path_buf();
            registry_fixture_key(&root)?;
            fs::write(
                root.join("output").join(marker_name),
                b"fixed descendant resumed",
            )
            .map_err(|e| e.to_string())?;
        }

        if std::env::var("SSPA_LIFECYCLE").as_deref() == Ok("root-failure") {
            // Fixed execution-root fault injection: bypass destructors while its leaf remains live.
            unsafe {
                TerminateProcess(GetCurrentProcess(), 0xe7);
            }
            return Err("fixed root failure injection did not terminate".into());
        }
        if unsafe {
            WaitForSingleObject(
                process.0,
                if matches!(
                    std::env::var("SSPA_LIFECYCLE").as_deref(),
                    Ok("timeout" | "root-failure" | "concurrent-cancel")
                ) {
                    30000
                } else {
                    5000
                },
            )
        } != WAIT_OBJECT_0
        {
            return Err("descendant did not stop within deadline".into());
        }
        let mut exit = 0;
        win(
            unsafe { GetExitCodeProcess(process.0, &mut exit) },
            "query descendant exit",
        )?;
        report.checks.push(ProbeCheck {
            name: "fixed descendant exit".into(),
            passed: exit == 73,
            detail: format!("actual exit={exit}"),
        });
        if exit != 73 {
            return Err("fixed descendant exit mismatch".into());
        }
        let root = std::env::current_exe()
            .map_err(|e| e.to_string())?
            .parent()
            .ok_or("missing fixed root")?
            .to_path_buf();
        let id = uuid::Uuid::parse_str(
            root.file_name()
                .and_then(|name| name.to_str())
                .and_then(|name| name.strip_prefix("ShellSpan-AC-"))
                .ok_or("invalid fixed root")?,
        )
        .map_err(|e| e.to_string())?;
        let data = read_fixed_report(&root, FixedReportKind::LeafNetwork)?;
        let observation: LeafNetworkObservation =
            serde_json::from_slice(&data).map_err(|e| e.to_string())?;
        let user = unsafe { query(source, TokenUser) }?;
        let user_sid = unsafe { sid_text((*user.as_ptr().cast::<TOKEN_USER>()).User.Sid) }?;
        if !leaf_network_bound(&observation, id, &user_sid) {
            return Err("fixed leaf network report contract or identity mismatch".into());
        }
        report
            .checks
            .extend(observation.report.checks.into_iter().map(|mut check| {
                check.name = format!("descendant network: {}", check.name);
                check
            }));
        Ok(())
    })();
    if outcome.is_err() {
        unsafe {
            TerminateProcess(process.0, 2);
            WaitForSingleObject(process.0, 5000);
        }
    }
    outcome
}
pub fn child() -> Result<()> {
    let mut token = null_mut();
    win(
        unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) },
        "query fixed child Token",
    )?;
    let token = Handle(token);
    let app = unsafe { query(token.0, TokenIsAppContainer) }?;
    if unsafe { *app.as_ptr().cast::<u32>() } == 0 {
        return Err("fixed probe requires AppContainer".into());
    }
    let root = PathBuf::from(std::env::var("SSPA_FIXTURE").map_err(|e| e.to_string())?);
    let name = root
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or("invalid fixture name")?;
    let id = name
        .strip_prefix("ShellSpan-AC-")
        .ok_or("invalid fixed root")?;
    if uuid::Uuid::parse_str(id).is_err() || !root.is_absolute() {
        return Err("invalid fixed root UUID".into());
    }
    let mut report = ProbeReport {
        checks: vec![],
        complete: false,
    };
    for (file, read, write) in [
        ("readonly.txt", true, false),
        ("workspace.txt", true, true),
        ("secret.txt", false, false),
        ("external.txt", false, false),
        ("external-aap.txt", false, false),
    ] {
        operation(
            &mut report,
            &format!("{file} read"),
            fs::read(root.join(file)),
            read,
        );
        operation(
            &mut report,
            &format!("{file} write"),
            OpenOptions::new()
                .write(true)
                .open(root.join(file))
                .and_then(|mut file| file.write_all(b"owned write")),
            write,
        );
    }
    let artifact = root.join("output/artifact.txt");
    operation(
        &mut report,
        "artifact create/write/close",
        fs::write(&artifact, b"owned output"),
        true,
    );
    operation(
        &mut report,
        "artifact reopen/read",
        fs::read(&artifact),
        true,
    );
    operation(
        &mut report,
        "artifact reopen/write",
        OpenOptions::new()
            .write(true)
            .open(&artifact)
            .and_then(|mut file| file.write_all(b"owned reopen")),
        true,
    );
    fs::write(
        root.join("output/report.json"),
        serde_json::to_vec(&report).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let private_key = registry_fixture_key(&root)?;
    for (name, access) in [
        ("private registry read denied", KEY_READ),
        ("private registry write denied", KEY_WRITE),
    ] {
        let status = registry_open(&private_key, access);
        report.checks.push(ProbeCheck { name: name.into(), passed: status == 5, detail: format!("actual key open Win32={status}; host read/write positive controls passed; no values read") });
    }
    breakaway(&mut report)?;
    if std::env::var("SSPA_LIFECYCLE").as_deref() == Ok("concurrent-cancel") {
        concurrent_descendants(token.0)?;
    } else {
        descendant(&mut report, token.0, "descendant-resumed")?;
    }
    let short = PathBuf::from(std::env::var("SSPA_SHORT_FIXTURE").map_err(|e| e.to_string())?);
    let sensitive =
        PathBuf::from(std::env::var("SSPA_SHORT_SENSITIVE").map_err(|e| e.to_string())?);
    if !sensitive.is_absolute()
        || sensitive
            .file_name()
            .is_some_and(|name| name.eq_ignore_ascii_case(".env.local"))
    {
        return Err("distinct sensitive file alias missing".into());
    }
    operation(
        &mut report,
        "sensitive file short-name read denied",
        fs::read(&sensitive),
        false,
    );
    operation(
        &mut report,
        "sensitive file short-name write denied",
        OpenOptions::new().write(true).open(&sensitive),
        false,
    );
    if !short.is_absolute() || short.file_name() == root.file_name() {
        return Err("distinct fixed short root missing".into());
    }
    for (file, read, write) in [
        ("readonly.txt", true, false),
        ("workspace.txt", true, true),
        ("secret.txt", false, false),
    ] {
        operation(
            &mut report,
            &format!("{file} short-root read"),
            fs::read(short.join(file)),
            read,
        );
        operation(
            &mut report,
            &format!("{file} short-root write"),
            OpenOptions::new()
                .write(true)
                .open(short.join(file))
                .and_then(|mut file| file.write_all(b"owned short-alias write")),
            write,
        );
    }
    for name in ["readonly.txt", "secret.txt"] {
        operation(
            &mut report,
            &format!("{name} hardlink alias denied"),
            fs::hard_link(
                root.join(name),
                root.join(format!("output/low-link-{name}")),
            ),
            false,
        );
    }
    let everyone = root.join("external-everyone.txt");
    operation(
        &mut report,
        "Everyone-only external file read denied",
        fs::read(&everyone),
        false,
    );
    operation(
        &mut report,
        "Everyone-only external file write denied",
        OpenOptions::new().write(true).open(&everyone),
        false,
    );
    let renamed = root.join("output/renamed-artifact.txt");
    operation(
        &mut report,
        "ordinary artifact rename",
        fs::rename(&artifact, &renamed),
        true,
    );
    operation(
        &mut report,
        "ordinary renamed artifact delete",
        fs::remove_file(&renamed),
        true,
    );
    for (project_name, label) in [
        ("default-project", "default project"),
        ("workspace-project", "workspace project"),
    ] {
        for (relative, readable) in [
            (".env.local", true),
            ("nested/.env.local", false),
            ("rules/config.json", true),
        ] {
            let path = root.join(project_name).join(relative);
            operation(
                &mut report,
                &format!("{label} {relative} read"),
                fs::read(&path),
                readable,
            );
            operation(
                &mut report,
                &format!("{label} {relative} write denied"),
                OpenOptions::new().write(true).open(&path),
                false,
            );
        }
        operation(
            &mut report,
            &format!("{label} rules directory DELETE denied"),
            directory_delete_access(&root.join(project_name).join("rules")),
            false,
        );
        operation(
            &mut report,
            &format!("{label} nested directory DELETE denied"),
            directory_delete_access(&root.join(project_name).join("nested")),
            false,
        );
    }
    for name in ["readonly.txt", "secret.txt"] {
        operation(
            &mut report,
            &format!("{name} new ADS create denied"),
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(root.join(format!("{name}:new-lpac-stream"))),
            false,
        );
    }
    let new_stream = root.join("workspace-project/ordinary.txt:new-lpac-stream");
    operation(
        &mut report,
        "workspace new ADS create/write",
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&new_stream)
            .and_then(|mut file| file.write_all(b"fixed new ADS")),
        true,
    );
    operation(
        &mut report,
        "workspace new ADS reopen/read",
        fs::read(&new_stream).and_then(|bytes| {
            if bytes == b"fixed new ADS" {
                Ok(())
            } else {
                Err(std::io::Error::from(std::io::ErrorKind::InvalidData))
            }
        }),
        true,
    );
    operation(
        &mut report,
        "workspace new ADS delete",
        fs::remove_file(&new_stream),
        true,
    );
    let readonly = root.join("default-project");
    let ordinary = readonly.join("ordinary.txt");
    operation(
        &mut report,
        "readonly ordinary file read",
        fs::read(&ordinary),
        true,
    );
    operation(
        &mut report,
        "readonly ordinary file write denied",
        OpenOptions::new().write(true).open(&ordinary),
        false,
    );
    operation(
        &mut report,
        "readonly ordinary file rename denied",
        fs::rename(&ordinary, readonly.join("moved.txt")),
        false,
    );
    operation(
        &mut report,
        "readonly ordinary file delete denied",
        fs::remove_file(&ordinary),
        false,
    );
    let directory = readonly.join("ordinary-directory");
    operation(
        &mut report,
        "readonly ordinary directory rename denied",
        fs::rename(&directory, readonly.join("moved-directory")),
        false,
    );
    operation(
        &mut report,
        "readonly ordinary directory delete denied",
        fs::remove_dir(&directory),
        false,
    );
    let workspace = root.join("workspace-project");
    let ordinary = workspace.join("ordinary.txt");
    let renamed = workspace.join("renamed.txt");
    operation(
        &mut report,
        "workspace ordinary file write",
        OpenOptions::new()
            .write(true)
            .open(&ordinary)
            .and_then(|mut file| file.write_all(b"fixed workspace write")),
        true,
    );
    operation(
        &mut report,
        "workspace ordinary file rename",
        fs::rename(&ordinary, &renamed),
        true,
    );
    operation(
        &mut report,
        "workspace ordinary file delete",
        fs::remove_file(&renamed),
        true,
    );
    let directory = workspace.join("ordinary-directory");
    let moved = workspace.join("moved-directory");
    operation(
        &mut report,
        "workspace ordinary directory rename",
        fs::rename(&directory, &moved),
        true,
    );
    operation(
        &mut report,
        "workspace ordinary directory delete",
        fs::remove_dir(&moved),
        true,
    );
    let fresh = workspace.join("created.txt");
    let fresh_moved = workspace.join("created-moved.txt");
    operation(
        &mut report,
        "new workspace file create/write",
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&fresh)
            .and_then(|mut file| file.write_all(b"fixed new object")),
        true,
    );
    operation(
        &mut report,
        "new workspace file reopen/read",
        fs::read(&fresh).and_then(|bytes| {
            if bytes == b"fixed new object" {
                Ok(())
            } else {
                Err(std::io::Error::from(std::io::ErrorKind::InvalidData))
            }
        }),
        true,
    );
    operation(
        &mut report,
        "new workspace file rename",
        fs::rename(&fresh, &fresh_moved),
        true,
    );
    operation(
        &mut report,
        "new workspace file delete",
        fs::remove_file(&fresh_moved),
        true,
    );
    let fresh_directory = workspace.join("created-directory");
    let moved_directory = workspace.join("created-moved-directory");
    operation(
        &mut report,
        "new workspace directory create",
        fs::create_dir(&fresh_directory),
        true,
    );
    let child = fresh_directory.join("child.txt");
    operation(
        &mut report,
        "new workspace nested file create/write",
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&child)
            .and_then(|mut file| file.write_all(b"fixed nested object")),
        true,
    );
    operation(
        &mut report,
        "new workspace nested file delete",
        fs::remove_file(&child),
        true,
    );
    operation(
        &mut report,
        "new workspace directory rename",
        fs::rename(&fresh_directory, &moved_directory),
        true,
    );
    operation(
        &mut report,
        "new workspace directory delete",
        fs::remove_dir(&moved_directory),
        true,
    );
    operation(
        &mut report,
        "readonly project file create denied",
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(root.join("default-project/forbidden.txt")),
        false,
    );
    operation(
        &mut report,
        "readonly project directory create denied",
        fs::create_dir(root.join("default-project/forbidden-directory")),
        false,
    );
    let sensitive_project = root.join("sensitive-project");
    for (relative, label) in [
        (".env.local", "root env"),
        ("rules/config.json", "rules overlap"),
    ] {
        let path = sensitive_project.join(relative);
        operation(
            &mut report,
            &format!("independent sensitive {label} read denied"),
            fs::read(&path),
            false,
        );
        operation(
            &mut report,
            &format!("independent sensitive {label} write denied"),
            OpenOptions::new().write(true).open(&path),
            false,
        );
    }
    let ordinary = sensitive_project.join("ordinary.txt");
    operation(
        &mut report,
        "independent sensitive ordinary read control",
        fs::read(&ordinary),
        true,
    );
    operation(
        &mut report,
        "independent sensitive ordinary write control",
        OpenOptions::new()
            .write(true)
            .open(&ordinary)
            .and_then(|mut file| file.write_all(b"fixed positive control")),
        true,
    );
    operation(
        &mut report,
        "independent sensitive parent DELETE denied",
        directory_delete_access(&sensitive_project),
        false,
    );
    let ordinary_directory = root.join("output/ordinary-directory");
    let moved_directory = root.join("output/moved-directory");
    operation(
        &mut report,
        "ordinary directory create",
        fs::create_dir(&ordinary_directory),
        true,
    );
    operation(
        &mut report,
        "ordinary directory rename",
        fs::rename(&ordinary_directory, &moved_directory),
        true,
    );
    operation(
        &mut report,
        "ordinary directory delete",
        fs::remove_dir(&moved_directory),
        true,
    );
    operation(
        &mut report,
        "protected parent DELETE access denied",
        directory_delete_access(&root.join("output")),
        false,
    );
    operation(
        &mut report,
        "protected parent rename denied",
        fs::rename(root.join("output"), root.join("moved-output")),
        false,
    );
    let protected = root.join("output/protected.txt");
    operation(
        &mut report,
        "protected child read denied",
        fs::read(&protected),
        false,
    );
    operation(
        &mut report,
        "protected child write denied",
        OpenOptions::new().write(true).open(&protected),
        false,
    );
    operation(
        &mut report,
        "protected child rename denied",
        fs::rename(&protected, root.join("output/renamed-protected.txt")),
        false,
    );
    operation(
        &mut report,
        "protected child delete denied",
        fs::remove_file(&protected),
        false,
    );
    for (file, read, write) in [
        ("readonly.txt", true, false),
        ("workspace.txt", true, true),
        ("secret.txt", false, false),
    ] {
        let stream = root.join(format!("{file}:owned-probe"));
        operation(
            &mut report,
            &format!("{file} ADS read"),
            fs::read(&stream),
            read,
        );
        operation(
            &mut report,
            &format!("{file} ADS write"),
            OpenOptions::new()
                .write(true)
                .open(&stream)
                .and_then(|mut file| file.write_all(b"owned ADS write")),
            write,
        );
    }
    let mut connections = vec![];
    for key in [
        r"SYSTEM\CurrentControlSet\Services\WinSock2\Parameters",
        r"SYSTEM\CurrentControlSet\Services\WinSock2\Parameters\Protocol_Catalog9",
        r"SYSTEM\CurrentControlSet\Services\WinSock2\Parameters\NameSpace_Catalog5",
    ] {
        let mut handle = null_mut();
        let status = unsafe {
            windows_sys::Win32::System::Registry::RegOpenKeyExW(
                windows_sys::Win32::System::Registry::HKEY_LOCAL_MACHINE,
                wide(key).as_ptr(),
                0,
                windows_sys::Win32::System::Registry::KEY_READ,
                &mut handle,
            )
        };
        if status == 0 {
            unsafe {
                windows_sys::Win32::System::Registry::RegCloseKey(handle);
            }
        }
        report.checks.push(ProbeCheck {
            name: format!("Winsock registry read admission: {key}"),
            passed: status == 0,
            detail: format!(
                "read-only key open Win32={status}; no registry values or contents recorded"
            ),
        });
    }
    let mut winsock = windows_sys::Win32::Networking::WinSock::WSADATA::default();
    let startup =
        unsafe { windows_sys::Win32::Networking::WinSock::WSAStartup(0x0202, &mut winsock) };
    report.checks.push(ProbeCheck {
        name: "actual Winsock initialization".into(),
        passed: startup == 0,
        detail: format!(
            "WSAStartup 2.2 return={startup}; initialization failure is not network denial"
        ),
    });
    fs::write(
        root.join("output/report.json"),
        serde_json::to_vec(&report).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    if startup != 0 {
        return Err(format!(
            "WSAStartup returned {startup}; network probes not executed"
        ));
    }
    struct Winsock;
    impl Drop for Winsock {
        fn drop(&mut self) {
            unsafe {
                windows_sys::Win32::Networking::WinSock::WSACleanup();
            }
        }
    }
    let _winsock = Winsock;
    for index in 0..2 {
        let tcp: SocketAddr = std::env::var(format!("SSPA_TCP{index}"))
            .map_err(|e| e.to_string())?
            .parse::<SocketAddr>()
            .map_err(|e| e.to_string())?;
        let udp: SocketAddr = std::env::var(format!("SSPA_UDP{index}"))
            .map_err(|e| e.to_string())?
            .parse::<SocketAddr>()
            .map_err(|e| e.to_string())?;
        if !tcp.ip().is_loopback() || !udp.ip().is_loopback() || tcp.port() == 0 || udp.port() == 0
        {
            return Err("fixed receiver not loopback".into());
        }
        operation(
            &mut report,
            &format!("TCP listener {index} denied"),
            TcpListener::bind(if index == 0 { "127.0.0.1:0" } else { "[::1]:0" }),
            false,
        );
        match TcpStream::connect_timeout(&tcp, Duration::from_secs(1)) {
            Ok(stream) => {
                connections.push(stream);
                operation(
                    &mut report,
                    &format!("TCP {index} denied"),
                    Ok::<_, std::io::Error>(()),
                    false,
                );
            }
            Err(error) => operation(
                &mut report,
                &format!("TCP {index} denied"),
                Err::<(), _>(error),
                false,
            ),
        }
        let sent = UdpSocket::bind(if udp.is_ipv4() {
            "127.0.0.1:0"
        } else {
            "[::1]:0"
        })
        .and_then(|socket| socket.send_to(b"owned-child", udp));
        report.checks.push(ProbeCheck {
            name: format!("UDP {index} API observation"),
            passed: true,
            detail: format!(
                "send result={sent:?}; API observation alone is not network denial proof"
            ),
        });
    }
    // Keep successful sockets alive while host receiver workers observe them.
    probe_private_network(&mut report)?;
    probe_owned_dns(
        uuid::Uuid::parse_str(id).map_err(|e| e.to_string())?,
        &mut report,
    )?;
    std::thread::sleep(Duration::from_millis(100));
    drop(connections);
    let controller_pid: u32 = std::env::var("SSPA_CONTROLLER_PID")
        .map_err(|_| "fixed controller process identity missing")?
        .parse()
        .map_err(|_| "fixed controller PID invalid")?;
    if controller_pid == 0 || controller_pid == unsafe { GetCurrentProcessId() } {
        return Err("fixed controller process identity is not external".into());
    }
    for (name, access) in CONTROLLER_HANDLE_RIGHTS {
        let process = unsafe { OpenProcess(access, 0, controller_pid) };
        let denied = if process.is_null() {
            (unsafe { GetLastError() }) == ERROR_ACCESS_DENIED
        } else {
            drop(Handle(process));
            false
        };
        report.checks.push(ProbeCheck {
            name: format!("controller {name} handle denied"),
            passed: denied,
            detail: "fixed live controller PID supplied before Resume; access-denied required; missing process does not pass; no memory or token read attempted".into(),
        });
    }
    if let Ok(target) = std::env::var("SSPA_CREDENTIAL_REF") {
        let id = root
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.strip_prefix("ShellSpan-AC-"))
            .ok_or("credential probe lacks fixed fixture UUID")?;
        let id = uuid::Uuid::parse_str(id).map_err(|_| "credential probe UUID invalid")?;
        let mut raw = null_mut();
        win(
            unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) },
            "query fixed credential probe Token",
        )?;
        let token = Handle(raw);
        let user = unsafe { query(token.0, TokenUser) }?;
        let user_sid = unsafe { sid_text((*user.as_ptr().cast::<TOKEN_USER>()).User.Sid) }?;
        let reference = crate::credential_reference::OwnedCredentialReference::new(id, &user_sid)?;
        if target != reference.reference() {
            return Err("credential probe reference differs from exact owned UUID/account".into());
        }
        let rpc_admission = crate::rpc_admission_probe::observe(id)?;
        report.checks.push(ProbeCheck {
            name: "fixed local RPC client binding created and released".into(),
            passed: rpc_admission.completed(),
            detail: serde_json::to_string(&rpc_admission).map_err(|e| e.to_string())?,
        });
        report.checks.push(ProbeCheck {
            name: "fixed local RPC client authentication configured without server invocation"
                .into(),
            passed: rpc_admission.authentication_configured(),
            detail: serde_json::to_string(&rpc_admission).map_err(|e| e.to_string())?,
        });
        let denial = reference.probe_account_denial(&user_sid);
        report.checks.push(ProbeCheck {
            name: crate::credential_reference::OWNED_CREDENTIAL_DENIAL_CHECK.into(),
            passed: denial.is_ok(),
            detail: match denial { Ok(code) => format!("exact owned SYSTEM reference denied: Win32={code}; controller verified positive before Resume"), Err(error) => error },
        });
    }
    report.complete = true;
    fs::write(
        root.join("output/report.json"),
        serde_json::to_vec(&report).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn fixed_bootstrap_writer_requires_existing_single_link_and_checks_before_mutation() {
        let root = std::env::temp_dir().join(format!(
            "ShellSpan-stage-A-account-lpac-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&root).unwrap();
        let report = root.join("account-report.json");
        assert!(super::write_fixed_bootstrap_report(&root, b"{}").is_err());
        assert!(!report.exists());
        std::fs::write(&report, b"previous longer report").unwrap();
        super::write_fixed_bootstrap_report(&root, b"{}").unwrap();
        assert_eq!(std::fs::read(&report).unwrap(), b"{}");
        assert!(super::write_fixed_bootstrap_report(&root, &vec![b'x'; 65537]).is_err());
        assert_eq!(std::fs::read(&report).unwrap(), b"{}");
        let alias = root.join("report-alias.json");
        std::fs::hard_link(&report, &alias).unwrap();
        assert!(super::write_fixed_bootstrap_report(&root, b"tampered").is_err());
        assert_eq!(std::fs::read(&alias).unwrap(), b"{}");
        trash::delete(&root).unwrap();
        let directory_root = std::env::temp_dir().join(format!(
            "ShellSpan-stage-A-account-lpac-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&directory_root).unwrap();
        std::fs::create_dir(directory_root.join("account-report.json")).unwrap();
        assert!(super::write_fixed_bootstrap_report(&directory_root, b"{}").is_err());
        trash::delete(&directory_root).unwrap();
        assert!(
            super::write_fixed_bootstrap_report(std::path::Path::new("relative"), b"{}").is_err()
        );
    }
    #[test]
    fn fixed_build_source_retirement_preserves_unrelated_acl_while_content_is_pinned() {
        use super::*;
        let root =
            std::env::temp_dir().join(format!("ShellSpan-AC-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir(&root).unwrap();
        let mut raw = null_mut();
        win(
            unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) },
            "source retirement test token",
        )
        .unwrap();
        let token = Handle(raw);
        let user = unsafe { query(token.0, TokenUser) }.unwrap();
        let owner = unsafe { sid_text((*user.as_ptr().cast::<TOKEN_USER>()).User.Sid) }.unwrap();
        let package = "S-1-15-2-111-222-333-444-555-666-777";
        let unrelated = "S-1-15-2-111-222-333-444-555-666-888";
        let source = root.join("fixed-build.cs");
        fs::write(&source, crate::fixed_tool::FIXED_BUILD_SOURCE).unwrap();
        let retained = format!("D:P(A;;FA;;;SY)(A;;FA;;;{owner})(A;;FR;;;{unrelated})");
        set_owned_dacl(&source, &retained).unwrap();
        let expected = file_dacl_snapshot(&source).unwrap();
        set_owned_dacl(&source, &format!("{retained}(A;;FR;;;{package})")).unwrap();
        let lease = crate::fixed_tool::open_fixed_build_source(&root).unwrap();
        Fixture::revoke_files(&root, package, None).unwrap();
        assert_eq!(file_dacl_snapshot(&source).unwrap(), expected);
        assert_eq!(
            lease.read_bytes().unwrap(),
            crate::fixed_tool::FIXED_BUILD_SOURCE.as_bytes()
        );
        assert!(OpenOptions::new().write(true).open(&source).is_err());
        drop(lease);
        trash::delete(root).unwrap();
    }
    #[test]
    fn runtime_budget_preserves_small_default_and_rejects_oversized_before_acl_changes() {
        use super::*;
        let root =
            std::env::temp_dir().join(format!("ShellSpan-AC-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir(&root).unwrap();
        let mut raw = null_mut();
        win(
            unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) },
            "runtime budget test source",
        )
        .unwrap();
        let token = Handle(raw);
        let user = unsafe { query(token.0, TokenUser) }.unwrap();
        let owner = unsafe { sid_text((*user.as_ptr().cast::<TOKEN_USER>()).User.Sid) }.unwrap();
        let package = "S-1-15-2-111-222-333-444-555-666-777";
        let sddl = format!("D:P(A;;FA;;;SY)(A;;FA;;;{owner})(A;;FR;;;{package})");
        set_owned_dacl(&root, &sddl).unwrap();
        for index in 0..65 {
            fs::write(root.join(format!("fixture-{index}")), b"owned").unwrap();
        }
        let before = file_dacl_snapshot(&root).unwrap();
        assert!(Fixture::revoke_files(&root, package, None)
            .unwrap_err()
            .contains("budget"));
        assert_eq!(file_dacl_snapshot(&root).unwrap(), before);
        Fixture::revoke_files_budget(&root, package, None, 512).unwrap();
        assert_ne!(file_dacl_snapshot(&root).unwrap(), before);
        set_owned_dacl(&root, &sddl).unwrap();
        for index in 65..513 {
            fs::write(root.join(format!("fixture-{index}")), b"owned").unwrap();
        }
        let before = file_dacl_snapshot(&root).unwrap();
        assert!(Fixture::revoke_files_budget(&root, package, None, 512)
            .unwrap_err()
            .contains("budget"));
        assert_eq!(file_dacl_snapshot(&root).unwrap(), before);
        trash::delete(root).unwrap();
    }
    #[test]
    fn fixed_report_reader_enforces_each_budget_before_parsing() {
        assert_eq!(FixedReportKind::Workload.specification().1, 24 * 1024);
        assert_eq!(FixedReportKind::LeafNetwork.specification().1, 8 * 1024);
        assert_eq!(
            FixedReportKind::OrdinaryCredential.specification().1,
            4 * 1024
        );
        let root =
            std::env::temp_dir().join(format!("ShellSpan-AC-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("output")).unwrap();
        for kind in [
            FixedReportKind::Workload,
            FixedReportKind::LeafNetwork,
            FixedReportKind::OrdinaryCredential,
        ] {
            let (name, budget) = kind.specification();
            let path = root.join("output").join(name);
            fs::write(&path, vec![b'x'; budget as usize]).unwrap();
            assert_eq!(
                read_fixed_report(&root, kind).unwrap().len(),
                budget as usize
            );
            fs::OpenOptions::new()
                .write(true)
                .open(&path)
                .unwrap()
                .set_len(budget + 1)
                .unwrap();
            assert!(read_fixed_report(&root, kind)
                .unwrap_err()
                .contains("budget exceeded"));
            fs::OpenOptions::new()
                .write(true)
                .open(&path)
                .unwrap()
                .set_len(16 * 1024 * 1024)
                .unwrap();
            assert!(read_fixed_report(&root, kind)
                .unwrap_err()
                .contains("budget exceeded"));
        }
        trash::delete(&root).unwrap();
        assert!(read_fixed_report(Path::new("relative"), FixedReportKind::Workload).is_err());
    }
    #[test]
    fn fixed_report_reader_rejects_hardlinks_and_output_junction_before_content() {
        use windows_sys::Win32::System::{
            Ioctl::FSCTL_DELETE_REPARSE_POINT, SystemServices::IO_REPARSE_TAG_MOUNT_POINT,
        };
        let root =
            std::env::temp_dir().join(format!("ShellSpan-AC-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir(&root).unwrap();
        let target = root.join("target");
        fs::create_dir(&target).unwrap();
        let file = target.join("report.json");
        fs::write(&file, b"owned target must not be followed").unwrap();
        let output = root.join("output");
        let junction = create_owned_test_junction(&output, &target).unwrap();
        drop(junction);
        let rejected = read_fixed_report(&root, FixedReportKind::Workload).unwrap_err();
        let raw = unsafe {
            CreateFileW(
                wide(output.to_str().unwrap()).as_ptr(),
                GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
                null_mut(),
            )
        };
        assert_ne!(raw, INVALID_HANDLE_VALUE);
        let handle = Handle(raw);
        let mut removal = Vec::from(IO_REPARSE_TAG_MOUNT_POINT.to_le_bytes());
        removal.extend([0u8; 4]);
        junction_control(handle.0, FSCTL_DELETE_REPARSE_POINT, &removal).unwrap();
        drop(handle);
        fs::hard_link(&file, output.join("report.json")).unwrap();
        let hardlink_rejected = read_fixed_report(&root, FixedReportKind::Workload).unwrap_err();
        let unchanged = fs::read(&file).unwrap();
        trash::delete(&root).unwrap();
        assert!(rejected.contains("reparse object rejected"));
        assert!(hardlink_rejected.contains("hardlink aliases rejected"));
        assert_eq!(unchanged, b"owned target must not be followed");
    }
    #[test]
    fn actual_short_alias_binds_same_new_owned_root_identity() {
        let root =
            std::env::temp_dir().join(format!("ShellSpan-short-name-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        fs::write(root.join(".env.local"), b"owned short-name fixture").unwrap();
        let result = fixed_short_alias(&root);
        let file_result = fixed_short_alias(&root.join(".env.local"));
        trash::delete(&root).unwrap();
        assert!(result.is_ok(), "{}", result.unwrap_err());
        assert!(file_result.is_ok(), "{}", file_result.unwrap_err());
    }
    #[test]
    fn leaf_network_report_requires_exact_fixture_identity_and_unique_checks() {
        let id = uuid::Uuid::new_v4();
        let sid = "S-1-5-21-1-2-3-1001";
        let mut observation = LeafNetworkObservation {
            version: 1,
            fixture_id: id,
            user_sid: sid.into(),
            report: ProbeReport {
                complete: true,
                checks: LEAF_NETWORK_CHECKS
                    .iter()
                    .map(|name| ProbeCheck {
                        name: (*name).into(),
                        passed: true,
                        detail: "leaf contract regression".into(),
                    })
                    .collect(),
            },
        };
        assert!(leaf_network_bound(&observation, id, sid));
        assert!(!leaf_network_bound(&observation, uuid::Uuid::new_v4(), sid));
        assert!(!leaf_network_bound(&observation, id, "S-1-5-18"));
        observation.report.checks[0].name = LEAF_NETWORK_CHECKS[1].into();
        assert!(!leaf_network_bound(&observation, id, sid));
        observation.report.checks[0].name = LEAF_NETWORK_CHECKS[0].into();
        observation.report.complete = false;
        assert!(!leaf_network_bound(&observation, id, sid));
        observation.report.complete = true;
        observation.version = 2;
        assert!(!leaf_network_bound(&observation, id, sid));
    }
    #[test]
    fn asset_copy_rejects_junction_parent_before_target_creation() {
        use sha2::{Digest, Sha256};
        use windows_sys::Win32::System::{
            Ioctl::FSCTL_DELETE_REPARSE_POINT, SystemServices::IO_REPARSE_TAG_MOUNT_POINT,
        };
        let root =
            std::env::temp_dir().join(format!("ShellSpan-asset-junction-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let target = root.join("target");
        fs::create_dir(&target).unwrap();
        let source_path = root.join("source.js");
        fs::write(&source_path, b"independent source").unwrap();
        let source = crate::fixed_tool::ToolImageLease::open_source(&source_path).unwrap();
        let digest = Sha256::digest(source.read_bytes().unwrap())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let output = root.join("output");
        let junction = create_owned_test_junction(&output, &target).unwrap();
        assert!(crate::frontend_asset_copy::copy_new(
            &source,
            &digest,
            &output,
            "copied.js",
            source.identity.volume
        )
        .is_err());
        assert!(!target.join("copied.js").exists());
        assert!(crate::frontend_asset_copy::create_directory(
            &output,
            "new-directory",
            source.identity.volume
        )
        .is_err());
        assert!(!target.join("new-directory").exists());
        assert_eq!(source.read_bytes().unwrap(), b"independent source");
        let mut removal = Vec::from(IO_REPARSE_TAG_MOUNT_POINT.to_le_bytes());
        removal.extend([0u8; 4]);
        junction_control(junction.0, FSCTL_DELETE_REPARSE_POINT, &removal).unwrap();
        drop((junction, source));
        trash::delete(root).unwrap();
    }
    fn junction_control(handle: HANDLE, code: u32, data: &[u8]) -> Result<()> {
        let mut returned = 0;
        win(
            unsafe {
                windows_sys::Win32::System::IO::DeviceIoControl(
                    handle,
                    code,
                    data.as_ptr().cast(),
                    data.len() as u32,
                    null_mut(),
                    0,
                    &mut returned,
                    null_mut(),
                )
            },
            "fixed owned junction control",
        )
    }
    fn create_owned_test_junction(path: &Path, target: &Path) -> Result<Handle> {
        use windows_sys::Win32::System::{
            Ioctl::FSCTL_SET_REPARSE_POINT, SystemServices::IO_REPARSE_TAG_MOUNT_POINT,
        };
        fs::create_dir(path).map_err(|error| error.to_string())?;
        let target = target.to_str().ok_or("invalid owned junction target")?;
        let substitute: Vec<u16> = format!(r"\??\{target}").encode_utf16().collect();
        let print: Vec<u16> = target.encode_utf16().collect();
        let data_length = 8 + 2 * (substitute.len() + print.len() + 2);
        if data_length + 8 > 16384 {
            return Err("owned junction buffer budget exceeded".into());
        }
        let mut data = Vec::new();
        data.extend(IO_REPARSE_TAG_MOUNT_POINT.to_le_bytes());
        for value in [
            data_length as u16,
            0,
            0,
            (substitute.len() * 2) as u16,
            ((substitute.len() + 1) * 2) as u16,
            (print.len() * 2) as u16,
        ] {
            data.extend(value.to_le_bytes());
        }
        for value in substitute
            .into_iter()
            .chain(Some(0))
            .chain(print)
            .chain(Some(0))
        {
            data.extend(value.to_le_bytes());
        }
        let handle = unsafe {
            CreateFileW(
                wide(path.to_str().ok_or("invalid owned junction path")?).as_ptr(),
                GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
                null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err("open newly-created owned junction failed".into());
        }
        let handle = Handle(handle);
        junction_control(handle.0, FSCTL_SET_REPARSE_POINT, &data)?;
        Ok(handle)
    }
    fn file_dacl_snapshot(path: &Path) -> Result<Vec<u8>> {
        let path = wide(path.to_str().ok_or("invalid fixed snapshot path")?);
        let mut needed = 0;
        unsafe {
            GetFileSecurityW(
                path.as_ptr(),
                DACL_SECURITY_INFORMATION,
                null_mut(),
                0,
                &mut needed,
            );
        }
        if needed == 0 || needed > 16384 {
            return Err("fixed DACL snapshot budget failed".into());
        }
        let mut bytes = vec![0u8; needed as usize];
        win(
            unsafe {
                GetFileSecurityW(
                    path.as_ptr(),
                    DACL_SECURITY_INFORMATION,
                    bytes.as_mut_ptr().cast(),
                    bytes.len() as u32,
                    &mut needed,
                )
            },
            "snapshot fixed owned DACL",
        )?;
        bytes.truncate(needed as usize);
        Ok(bytes)
    }
    #[test]
    fn actual_junction_rejected_before_any_owned_or_target_acl_mutation() {
        use windows_sys::Win32::System::{
            Ioctl::FSCTL_DELETE_REPARSE_POINT, SystemServices::IO_REPARSE_TAG_MOUNT_POINT,
        };
        let root = std::env::temp_dir().join(format!("ShellSpan-reparse-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let owned = root.join("owned");
        let target = root.join("target");
        fs::create_dir(&owned).unwrap();
        fs::create_dir(&target).unwrap();
        let file = owned.join("ordinary.txt");
        fs::write(&file, b"owned ACL delta fixture").unwrap();
        fs::write(target.join("marker.txt"), b"owned external junction target").unwrap();
        let mut raw = null_mut();
        win(
            unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) },
            "test source token",
        )
        .unwrap();
        let token = Handle(raw);
        let user = unsafe { query(token.0, TokenUser) }.unwrap();
        let owner = unsafe { sid_text((*user.as_ptr().cast::<TOKEN_USER>()).User.Sid) }.unwrap();
        let sddl = format!("D:P(A;;FA;;;SY)(A;;FA;;;{owner})(A;;FR;;;S-1-15-2-1)");
        set_owned_dacl(&owned, &sddl).unwrap();
        set_owned_dacl(&file, &sddl).unwrap();
        let before = [
            file_dacl_snapshot(&owned).unwrap(),
            file_dacl_snapshot(&file).unwrap(),
            file_dacl_snapshot(&target).unwrap(),
        ];
        let link = owned.join("junction");
        let junction = create_owned_test_junction(&link, &target).unwrap();
        let metadata = unsafe {
            CreateFileW(
                wide(link.to_str().unwrap()).as_ptr(),
                FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
                null_mut(),
            )
        };
        assert_ne!(metadata, INVALID_HANDLE_VALUE);
        let metadata = Handle(metadata);
        let mut original = BY_HANDLE_FILE_INFORMATION::default();
        win(
            unsafe { GetFileInformationByHandle(metadata.0, &mut original) },
            "freeze owned junction identity",
        )
        .unwrap();
        // A write handle would make retirement fail only on sharing mode, rather
        // than reach the actual reparse-attribute gate that this test exercises.
        drop(junction);
        let observation = (|| -> Result<()> {
            if fs::read(link.join("marker.txt")).map_err(|error| error.to_string())?
                != b"owned external junction target"
            {
                return Err("junction target positive control mismatch".into());
            }
            fs::create_dir(target.join("project")).map_err(|e| e.to_string())?;
            let direct = crate::policy::freeze_owned_project_with_rules(
                &target.join("project"),
                &crate::policy::FrozenRules::default(),
            )?;
            drop(direct);
            let rejected = crate::policy::freeze_owned_project_with_rules(
                &link.join("project"),
                &crate::policy::FrozenRules::default(),
            )
            .err()
            .ok_or("project ancestor junction unexpectedly accepted")?;
            if !rejected.contains("ancestor refused") {
                return Err(rejected);
            }
            for candidate in [&owned, &link] {
                let error = Fixture::revoke_files(candidate, "S-1-15-2-1", None)
                    .err()
                    .ok_or("reparse retirement unexpectedly accepted")?;
                if !error.contains("reparse rejected") {
                    return Err(error);
                }
            }
            let after = [
                file_dacl_snapshot(&owned)?,
                file_dacl_snapshot(&file)?,
                file_dacl_snapshot(&target)?,
            ];
            if before != after {
                return Err("junction rejection mutated an owned or target DACL".into());
            }
            if fs::read(target.join("marker.txt")).map_err(|error| error.to_string())?
                != b"owned external junction target"
            {
                return Err("junction target content changed".into());
            }
            Ok(())
        })();
        let mut removal = Vec::from(IO_REPARSE_TAG_MOUNT_POINT.to_le_bytes());
        removal.extend([0u8; 4]);
        let cleanup = unsafe {
            CreateFileW(
                wide(link.to_str().unwrap()).as_ptr(),
                GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
                null_mut(),
            )
        };
        assert_ne!(cleanup, INVALID_HANDLE_VALUE);
        let cleanup = Handle(cleanup);
        let mut current = BY_HANDLE_FILE_INFORMATION::default();
        win(
            unsafe { GetFileInformationByHandle(cleanup.0, &mut current) },
            "verify cleanup junction identity",
        )
        .unwrap();
        assert_eq!(
            (
                original.dwVolumeSerialNumber,
                original.nFileIndexHigh,
                original.nFileIndexLow
            ),
            (
                current.dwVolumeSerialNumber,
                current.nFileIndexHigh,
                current.nFileIndexLow
            ),
            "never clear a replacement junction"
        );
        let cleared = junction_control(cleanup.0, FSCTL_DELETE_REPARSE_POINT, &removal);
        drop(cleanup);
        drop(metadata);
        // First clear only reparse data on the exact identity, then recycle the
        // now-ordinary owned tree without following any junction.
        cleared.unwrap();
        trash::delete(&root).unwrap();
        assert!(observation.is_ok(), "{}", observation.unwrap_err());
    }
    #[test]
    #[ignore = "requires current workspace and TEMP on different local NTFS volumes"]
    fn actual_cross_volume_junction_project_is_refused_without_target_acl_changes() {
        use windows_sys::Win32::System::{
            Ioctl::FSCTL_DELETE_REPARSE_POINT, SystemServices::IO_REPARSE_TAG_MOUNT_POINT,
        };
        let id = uuid::Uuid::new_v4();
        let source = std::env::temp_dir().join(format!("ShellSpan-cross-volume-{id}"));
        let target = std::env::current_dir()
            .unwrap()
            .join(format!("ShellSpan-cross-volume-{id}"));
        fs::create_dir(&source).unwrap();
        fs::create_dir(&target).unwrap();
        fs::create_dir(target.join("project")).unwrap();
        fs::write(
            target.join("project/marker.txt"),
            b"fixed cross-volume marker",
        )
        .unwrap();
        let source_snapshot = crate::policy::freeze_owned_project_with_rules(
            &source,
            &crate::policy::FrozenRules::default(),
        )
        .unwrap();
        let target_snapshot = crate::policy::freeze_owned_project_with_rules(
            &target,
            &crate::policy::FrozenRules::default(),
        )
        .unwrap();
        let source_volume = source_snapshot.identities[""].volume;
        let target_volume = target_snapshot.identities[""].volume;
        drop(source_snapshot);
        drop(target_snapshot);
        if source_volume == target_volume {
            trash::delete(&source).unwrap();
            trash::delete(&target).unwrap();
            panic!("cross-volume test requires distinct actual volume IDs");
        }
        let before = file_dacl_snapshot(&target.join("project")).unwrap();
        let link = source.join("junction");
        let junction = create_owned_test_junction(&link, &target).unwrap();
        let mut identity = BY_HANDLE_FILE_INFORMATION::default();
        win(
            unsafe { GetFileInformationByHandle(junction.0, &mut identity) },
            "freeze cross-volume junction",
        )
        .unwrap();
        drop(junction);
        let observation = (|| -> Result<()> {
            if fs::read(link.join("project/marker.txt")).map_err(|e| e.to_string())?
                != b"fixed cross-volume marker"
            {
                return Err("cross-volume positive control mismatch".into());
            }
            let rejected = crate::policy::freeze_owned_project_with_rules(
                &link.join("project"),
                &crate::policy::FrozenRules::default(),
            )
            .err()
            .ok_or("cross-volume junction preparation unexpectedly passed")?;
            if !rejected.contains("ancestor refused") {
                return Err(rejected);
            }
            if file_dacl_snapshot(&target.join("project"))? != before {
                return Err("cross-volume target DACL changed".into());
            }
            Ok(())
        })();
        let cleanup = unsafe {
            CreateFileW(
                wide(link.to_str().unwrap()).as_ptr(),
                GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
                null_mut(),
            )
        };
        assert_ne!(cleanup, INVALID_HANDLE_VALUE);
        let cleanup = Handle(cleanup);
        let mut current = BY_HANDLE_FILE_INFORMATION::default();
        win(
            unsafe { GetFileInformationByHandle(cleanup.0, &mut current) },
            "verify cross-volume junction cleanup",
        )
        .unwrap();
        assert_eq!(
            (
                identity.dwVolumeSerialNumber,
                identity.nFileIndexHigh,
                identity.nFileIndexLow
            ),
            (
                current.dwVolumeSerialNumber,
                current.nFileIndexHigh,
                current.nFileIndexLow
            )
        );
        let mut removal = Vec::from(IO_REPARSE_TAG_MOUNT_POINT.to_le_bytes());
        removal.extend([0u8; 4]);
        junction_control(cleanup.0, FSCTL_DELETE_REPARSE_POINT, &removal).unwrap();
        drop(cleanup);
        trash::delete(&source).unwrap();
        trash::delete(&target).unwrap();
        assert!(observation.is_ok(), "{}", observation.unwrap_err());
    }
    #[test]
    fn breakaway_requires_access_denial_not_missing_image_or_success() {
        assert!(super::breakaway_denied(0, Some(ERROR_ACCESS_DENIED)));
        assert!(!super::breakaway_denied(0, Some(ERROR_FILE_NOT_FOUND)));
        assert!(!super::breakaway_denied(1, Some(ERROR_ACCESS_DENIED)));
        assert!(!super::breakaway_denied(0, None));
    }
    #[test]
    fn ordinary_controller_positive_control_can_open_each_requested_self_access() {
        for (name, access) in super::CONTROLLER_HANDLE_RIGHTS {
            let process = unsafe { super::OpenProcess(access, 0, super::GetCurrentProcessId()) };
            assert!(!process.is_null(), "positive control for {name} failed");
            drop(super::Handle(process));
        }
    }
    #[test]
    fn frozen_retirement_root_mismatch_rejects_before_parsing_or_mutating_acl() {
        let root =
            std::env::temp_dir().join(format!("ShellSpan-root-binding-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let error = super::Fixture::revoke_files(&root, "invalid SID", Some((0, 0))).unwrap_err();
        assert!(error.contains("root identity changed"));
        trash::delete(&root).unwrap();
    }
    #[test]
    fn retirement_inventory_rejects_new_nested_objects_and_missing_objects() {
        let root =
            std::env::temp_dir().join(format!("ShellSpan-inventory-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let nested = root.join("nested");
        std::fs::create_dir(&nested).unwrap();
        let file = nested.join("original.txt");
        std::fs::write(&file, b"frozen inventory").unwrap();
        let paths = vec![root.clone(), nested.clone(), file];
        assert!(super::verify_retirement_inventory(&paths).is_ok());
        let mut missing = paths.clone();
        missing.push(root.join("missing.txt"));
        assert!(super::verify_retirement_inventory(&missing).is_err());
        let added = nested.join("late.txt");
        std::fs::write(&added, b"late owned object").unwrap();
        assert!(super::verify_retirement_inventory(&paths).is_err());
        let incomplete = vec![root.clone(), nested];
        assert!(super::verify_retirement_inventory(&incomplete).is_err());
        trash::delete(&root).unwrap();
    }
    #[test]
    fn retirement_rejects_external_hardlink_before_acl_mutation() {
        let root =
            std::env::temp_dir().join(format!("ShellSpan-retirement-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let fixture = root.join("fixture");
        std::fs::create_dir(&fixture).unwrap();
        let owned = fixture.join("owned.txt");
        let alias = root.join("external-alias.txt");
        std::fs::write(&owned, b"owned retirement fixture").unwrap();
        assert!(super::verify_retirement_object(&owned).is_ok());
        std::fs::hard_link(&owned, &alias).unwrap();
        assert!(super::verify_retirement_object(&owned)
            .err()
            .unwrap()
            .contains("hardlink"));
        assert!(super::verify_retirement_object(&alias).is_err());
        trash::delete(&root).unwrap();
    }
    #[test]
    fn retirement_lease_blocks_write_and_replacement_until_released() {
        let root = std::env::temp_dir().join(format!("ShellSpan-lease-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let file = root.join("owned.txt");
        let moved = root.join("moved.txt");
        std::fs::write(&file, b"stable retirement object").unwrap();
        let lease = super::verify_retirement_object(&file).ok().unwrap();
        assert!(std::fs::rename(&file, &moved).is_err());
        assert!(std::fs::OpenOptions::new().write(true).open(&file).is_err());
        assert_eq!(std::fs::read(&file).unwrap(), b"stable retirement object");
        drop(lease);
        std::fs::rename(&file, &moved).unwrap();
        trash::delete(&root).unwrap();
    }
    use super::*;
    #[test]
    fn explicit_fixture_identity_and_registry_binding_cannot_be_replaced() {
        let mut raw = null_mut();
        win(
            unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) },
            "inspect source fixture test Token",
        )
        .unwrap();
        let token = Handle(raw);
        let user_buffer = unsafe { query(token.0, TokenUser) }.unwrap();
        let user = unsafe { (*user_buffer.as_ptr().cast::<TOKEN_USER>()).User.Sid };
        let mut package = null_mut();
        win(
            unsafe {
                ConvertStringSidToSidW(wide("S-1-15-2-11-22-33-44-55-66-77").as_ptr(), &mut package)
            },
            "parse fixture regression SID",
        )
        .unwrap();
        struct Package(PSID);
        impl Drop for Package {
            fn drop(&mut self) {
                unsafe {
                    LocalFree(self.0);
                }
            }
        }
        let package = Package(package);
        let id = uuid::Uuid::new_v4();
        assert!(unsafe {
            Fixture::prepare_at("fixed-test", package.0, user, Path::new("relative"), id)
        }
        .is_err());
        let mut fixture = unsafe {
            Fixture::prepare_at("fixed-test", package.0, user, &std::env::temp_dir(), id)
        }
        .unwrap();
        assert_eq!(
            fixture.root.file_name().unwrap(),
            format!("ShellSpan-AC-{}", id.simple()).as_str()
        );
        fixture.bind_current_registry().unwrap();
        assert!(fixture.bind_current_registry().is_err());
        unsafe { fixture.populate(user) }.unwrap();
        fixture.verify_source_controls().unwrap();
        let everyone_path = fixture.root.join("external-everyone.txt");
        let owner = unsafe { sid_text(user) }.unwrap();
        set_owned_dacl(
            &everyone_path,
            &format!("D:P(A;;FA;;;SY)(A;;FA;;;{owner})(A;;FR;;;WD)"),
        )
        .unwrap();
        assert!(
            fixture.verify_source_controls().is_err(),
            "an incomplete actual Everyone grant cannot authorize this negative control"
        );
        set_owned_dacl(
            &everyone_path,
            &format!("D:P(A;;FA;;;SY)(A;;FA;;;{owner})(A;;FRFW;;;WD)"),
        )
        .unwrap();
        fixture.verify_source_controls().unwrap();
        let secret_stream = fixture.root.join("secret.txt:owned-probe");
        fs::write(&secret_stream, b"tampered ADS fixture").unwrap();
        assert!(
            fixture.verify_source_controls().is_err(),
            "a wrong ADS control cannot authorize a negative probe"
        );
        assert_eq!(
            fs::read(fixture.root.join("secret.txt")).unwrap(),
            b"owned non-secret fixture\n"
        );
        fs::write(&secret_stream, b"owned ADS fixture").unwrap();
        fixture.verify_source_controls().unwrap();
        assert!(fixture.bind_current_registry().is_err());
        fixture.revoke().unwrap();
        let root = fixture.root.clone();
        drop(fixture);
        trash::delete(root).unwrap();
    }
    #[test]
    fn registry_fixture_identity_is_bounded_to_the_owned_uuid() {
        let id = uuid::Uuid::new_v4();
        let root = PathBuf::from(format!("ShellSpan-AC-{}", id.simple()));
        assert_eq!(
            registry_fixture_key(&root).unwrap(),
            format!(r"Software\ShellSpanStageA-{}", id.simple())
        );
        for name in ["ShellSpan-AC-invalid", "unowned", "ShellSpan-AC-.."] {
            assert!(registry_fixture_key(Path::new(name)).is_err());
        }
    }
    #[test]
    fn missing_file_is_not_counted_as_denied_access() {
        let mut report = ProbeReport {
            checks: vec![],
            complete: false,
        };
        operation(
            &mut report,
            "missing",
            Err::<(), _>(std::io::Error::from(std::io::ErrorKind::NotFound)),
            false,
        );
        operation(
            &mut report,
            "denied",
            Err::<(), _>(std::io::Error::from(std::io::ErrorKind::PermissionDenied)),
            false,
        );
        assert!(!report.checks[0].passed);
        assert!(report.checks[1].passed);
    }
}
