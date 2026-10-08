use crate::policy::{self, Object};
use serde::Serialize;
use std::ffi::c_void;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::net::{TcpListener, TcpStream, UdpSocket};
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::ptr::{null, null_mut};
use std::time::Duration;
use uuid::Uuid;
use windows_sys::core::GUID;
use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::NetworkManagement::NetManagement::*;
use windows_sys::Win32::NetworkManagement::WindowsFilteringPlatform::*;
use windows_sys::Win32::Security::Authorization::*;
use windows_sys::Win32::Security::*;
use windows_sys::Win32::Storage::FileSystem::*;
use windows_sys::Win32::System::Threading::*;

type Result<T> = std::result::Result<T, String>;
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
fn status(code: u32, operation: &str) -> Result<()> {
    if code == 0 {
        Ok(())
    } else {
        Err(format!("{operation}: Win32 {code}"))
    }
}
struct Handle(HANDLE);
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
fn descriptor(value: &str) -> Result<(Local, u32)> {
    let mut pointer = null_mut();
    let mut length = 0;
    win(
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide(value).as_ptr(),
                1,
                &mut pointer,
                &mut length,
            )
        },
        "parse SD",
    )?;
    Ok((Local(pointer), length))
}
fn token() -> Result<Handle> {
    let mut handle = null_mut();
    win(
        unsafe {
            OpenProcessToken(
                GetCurrentProcess(),
                TOKEN_QUERY | TOKEN_DUPLICATE,
                &mut handle,
            )
        },
        "open current token",
    )?;
    Ok(Handle(handle))
}
fn elevated() -> Result<bool> {
    let token = token()?;
    let mut elevation = TOKEN_ELEVATION::default();
    let mut length = 0;
    win(
        unsafe {
            GetTokenInformation(
                token.0,
                TokenElevation,
                (&mut elevation as *mut TOKEN_ELEVATION).cast(),
                std::mem::size_of_val(&elevation) as u32,
                &mut length,
            )
        },
        "query elevation",
    )?;
    Ok(elevation.TokenIsElevated != 0)
}
pub fn preflight() -> Result<()> {
    if !elevated()? {
        return Err("administrator setup required (current token is not elevated); no accounts, ACLs or WFP filters changed".into());
    }
    Err("elevated preflight only; explicit --run-owned-fixture action required. Production remains unavailable".into())
}

// Account credentials are created and used in this process only. No reusable secret
// is stored. A crash leaves a disabled account and protected ownership receipt.
struct Password(Vec<u16>);
impl Drop for Password {
    fn drop(&mut self) {
        for word in &mut self.0 {
            unsafe {
                std::ptr::write_volatile(word, 0);
            }
        }
    }
}
struct Account {
    name: String,
    created: bool,
}
impl Account {
    fn create(name: String, password: &mut Password) -> Result<Self> {
        let mut account_name = wide(&name);
        let mut comment = wide("ShellSpan phase A owned fixture; never a production account");
        let info = USER_INFO_1 {
            usri1_name: account_name.as_mut_ptr(),
            usri1_password: password.0.as_mut_ptr(),
            usri1_priv: USER_PRIV_USER,
            usri1_comment: comment.as_mut_ptr(),
            usri1_flags: UF_NORMAL_ACCOUNT | UF_ACCOUNTDISABLE | UF_PASSWD_CANT_CHANGE,
            ..Default::default()
        };
        let mut field = 0;
        status(
            unsafe { NetUserAdd(null(), 1, (&info as *const USER_INFO_1).cast(), &mut field) },
            "create disabled fixture account",
        )?;
        Ok(Self {
            name,
            created: true,
        })
    }
    fn enabled(&self, enabled: bool) -> Result<()> {
        let info = USER_INFO_1008 {
            usri1008_flags: UF_NORMAL_ACCOUNT
                | UF_PASSWD_CANT_CHANGE
                | if enabled { 0 } else { UF_ACCOUNTDISABLE },
        };
        status(
            unsafe {
                NetUserSetInfo(
                    null(),
                    wide(&self.name).as_ptr(),
                    1008,
                    (&info as *const USER_INFO_1008).cast(),
                    null_mut(),
                )
            },
            "set fixture account state",
        )
    }
    fn logon(&self, password: &Password) -> Result<Handle> {
        let mut handle = null_mut();
        win(
            unsafe {
                LogonUserW(
                    wide(&self.name).as_ptr(),
                    wide(".").as_ptr(),
                    password.0.as_ptr(),
                    LOGON32_LOGON_INTERACTIVE,
                    LOGON32_PROVIDER_DEFAULT,
                    &mut handle,
                )
            },
            "logon fixture account",
        )?;
        Ok(Handle(handle))
    }
    fn remove(&mut self) -> Result<()> {
        self.enabled(false)?;
        status(
            unsafe { NetUserDel(null(), wide(&self.name).as_ptr()) },
            "remove owned fixture account",
        )?;
        self.created = false;
        Ok(())
    }
}
impl Drop for Account {
    fn drop(&mut self) {
        if self.created {
            let _ = self.enabled(false);
        }
    }
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
fn account_sid(name: &str) -> Result<String> {
    let name = wide(name);
    let mut length = 0;
    let mut domain_length = 0;
    let mut kind = 0;
    unsafe {
        LookupAccountNameW(
            null(),
            name.as_ptr(),
            null_mut(),
            &mut length,
            null_mut(),
            &mut domain_length,
            &mut kind,
        );
    }
    if length == 0 {
        return Err("account SID lookup unavailable".into());
    }
    let mut bytes = vec![0usize; (length as usize).div_ceil(std::mem::size_of::<usize>())];
    let mut domain = vec![0u16; domain_length as usize];
    win(
        unsafe {
            LookupAccountNameW(
                null(),
                name.as_ptr(),
                bytes.as_mut_ptr().cast(),
                &mut length,
                domain.as_mut_ptr(),
                &mut domain_length,
                &mut kind,
            )
        },
        "lookup exact account SID",
    )?;
    let mut text = null_mut();
    win(
        unsafe { ConvertSidToStringSidW(bytes.as_ptr().cast_mut().cast(), &mut text) },
        "format account SID",
    )?;
    let _storage = Local(text.cast());
    let mut count = 0;
    unsafe {
        while *text.add(count) != 0 {
            count += 1;
        }
    }
    Ok(unsafe { String::from_utf16_lossy(std::slice::from_raw_parts(text, count)) })
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

#[cfg(test)]
mod tests {
    use super::*;

    fn can_read(token: HANDLE, sddl: &str) -> Result<bool> {
        let (sd, _) = descriptor(&format!("O:SYG:SY{sddl}"))?;
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
            "duplicate access-check token",
        )?;
        let impersonation = Handle(impersonation);
        let mapping = GENERIC_MAPPING {
            GenericRead: FILE_GENERIC_READ,
            GenericWrite: FILE_GENERIC_WRITE,
            GenericExecute: FILE_GENERIC_EXECUTE,
            GenericAll: FILE_ALL_ACCESS,
        };
        let mut privileges = [0usize; 128];
        let mut size = std::mem::size_of_val(&privileges) as u32;
        let mut granted = 0;
        let mut allowed = 0;
        win(
            unsafe {
                AccessCheck(
                    sd.0,
                    impersonation.0,
                    FILE_READ_DATA,
                    &mapping,
                    privileges.as_mut_ptr().cast(),
                    &mut size,
                    &mut granted,
                    &mut allowed,
                )
            },
            "native AccessCheck",
        )?;
        Ok(allowed != 0)
    }

    #[test]
    fn actual_restricted_token_requires_both_sid_passes() {
        let base = token().unwrap();
        let ordinary = token_sid(base.0).unwrap();
        let restricting_text = "S-1-5-21-771901-771902-771903-771904";
        let restricting_sid = sid(restricting_text).unwrap();
        let restricted = restricted(base.0, &restricting_sid).unwrap();
        assert!(
            !can_read(restricted.0, &format!("D:(A;;FR;;;{ordinary})")).unwrap(),
            "ordinary SID alone must fail the restricting pass"
        );
        assert!(
            !can_read(restricted.0, &format!("D:(A;;FR;;;{restricting_text})")).unwrap(),
            "restricting SID alone must fail the ordinary pass"
        );
        assert!(can_read(
            restricted.0,
            &format!("D:(A;;FR;;;{ordinary})(A;;FR;;;{restricting_text})")
        )
        .unwrap());
        assert!(
            !can_read(restricted.0, "D:(A;;FR;;;WD)").unwrap(),
            "Everyone cannot stand in for the unique restricting SID"
        );
        assert!(!can_read(
            restricted.0,
            &format!("D:(D;;FR;;;{ordinary})(A;;FR;;;{ordinary})(A;;FR;;;{restricting_text})")
        )
        .unwrap());
    }
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

// Non-inheriting, call-unique ACEs on fixture objects only. Existing owner/DACL
// remain intact. Revocation merges with the then-current DACL, never restores it.
fn acl(path: &Path, subject: &Local, rights: u32, mode: ACCESS_MODE) -> Result<()> {
    let name = wide(path.to_str().ok_or("non-Unicode fixture path")?);
    let mut old = null_mut();
    let mut sd = null_mut();
    status(
        unsafe {
            GetNamedSecurityInfoW(
                name.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                &mut old,
                null_mut(),
                &mut sd,
            )
        },
        "read fixture ACL",
    )?;
    let _old_sd = Local(sd);
    if old.is_null() {
        return Err("NULL DACL rejected".into());
    }
    let entry = EXPLICIT_ACCESS_W {
        grfAccessPermissions: rights,
        grfAccessMode: mode,
        grfInheritance: 0,
        Trustee: TRUSTEE_W {
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_UNKNOWN,
            ptstrName: subject.0.cast(),
            ..Default::default()
        },
    };
    let mut merged = null_mut();
    status(
        unsafe { SetEntriesInAclW(1, &entry, old, &mut merged) },
        "merge owned ACE",
    )?;
    let _merged = Local(merged.cast());
    status(
        unsafe {
            SetNamedSecurityInfoW(
                name.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                merged,
                null(),
            )
        },
        "write fixture ACL",
    )
}

struct Engine(HANDLE);
impl Drop for Engine {
    fn drop(&mut self) {
        unsafe {
            FwpmEngineClose0(self.0);
        }
    }
}
fn engine() -> Result<Engine> {
    let mut handle = null_mut();
    status(
        unsafe { FwpmEngineOpen0(null(), 10, null(), null(), &mut handle) },
        "open WFP engine",
    )?;
    Ok(Engine(handle))
}
fn install_network(engine: &Engine, account_sid: &str, keys: &[GUID; 4]) -> Result<()> {
    let (sd, size) = descriptor(&format!("D:(A;;CC;;;{account_sid})"))?;
    let mut blob = FWP_BYTE_BLOB {
        size,
        data: sd.0.cast(),
    };
    let mut condition = FWPM_FILTER_CONDITION0 {
        fieldKey: FWPM_CONDITION_ALE_USER_ID,
        matchType: FWP_MATCH_EQUAL,
        conditionValue: FWP_CONDITION_VALUE0 {
            r#type: FWP_SECURITY_DESCRIPTOR_TYPE,
            Anonymous: FWP_CONDITION_VALUE0_0 { sd: &mut blob },
        },
    };
    status(
        unsafe { FwpmTransactionBegin0(engine.0, 0) },
        "begin WFP transaction",
    )?;
    let install = (|| {
        for (key, layer) in keys.iter().zip([
            FWPM_LAYER_ALE_AUTH_CONNECT_V4,
            FWPM_LAYER_ALE_AUTH_CONNECT_V6,
            FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4,
            FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V6,
        ]) {
            let mut name = wide("ShellSpan phase A SID block (owned experiment)");
            let filter = FWPM_FILTER0 {
                filterKey: *key,
                flags: FWPM_FILTER_FLAG_PERSISTENT,
                displayData: FWPM_DISPLAY_DATA0 {
                    name: name.as_mut_ptr(),
                    description: null_mut(),
                },
                layerKey: layer,
                subLayerKey: FWPM_SUBLAYER_UNIVERSAL,
                numFilterConditions: 1,
                filterCondition: &mut condition,
                action: FWPM_ACTION0 {
                    r#type: FWP_ACTION_BLOCK,
                    ..Default::default()
                },
                ..Default::default()
            };
            status(
                unsafe { FwpmFilterAdd0(engine.0, &filter, null_mut(), null_mut()) },
                "add persistent SID block",
            )?;
        }
        status(
            unsafe { FwpmTransactionCommit0(engine.0) },
            "commit WFP transaction",
        )
    })();
    if install.is_err() {
        unsafe {
            FwpmTransactionAbort0(engine.0);
        }
    }
    install
}

#[derive(Serialize)]
struct Check {
    name: String,
    passed: bool,
    detail: String,
}
#[derive(Serialize)]
struct Receipt {
    backend: &'static str,
    production: &'static str,
    account: String,
    account_sid: Option<String>,
    restricting_sid: String,
    filter_keys: Vec<String>,
    fixture: String,
    state: String,
    checks: Vec<Check>,
    cleanup_debt: Vec<String>,
    missing_evidence: Vec<&'static str>,
}
fn save(path: &Path, receipt: &Receipt) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(receipt).map_err(|e| e.to_string())?;
    // Parent is protected before this file is created. Flush each transition.
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())
}
fn protected_fixture(root: &Path) -> Result<()> {
    let (sd, _) = descriptor("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)")?;
    let attrs = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: sd.0,
        bInheritHandle: 0,
    };
    win(
        unsafe {
            CreateDirectoryW(
                wide(root.to_str().ok_or("invalid fixture path")?).as_ptr(),
                &attrs,
            )
        },
        "create protected fixture",
    )
}
fn fixture_parent() -> Result<PathBuf> {
    let parent = PathBuf::from(std::env::var_os("ProgramData").ok_or("ProgramData unavailable")?);
    if !parent.is_absolute() || parent.to_string_lossy().starts_with("\\\\") {
        return Err("fixture requires a local absolute ProgramData path".into());
    }
    for ancestor in parent.ancestors() {
        if fs::symlink_metadata(ancestor)
            .map_err(|e| e.to_string())?
            .file_attributes()
            & FILE_ATTRIBUTE_REPARSE_POINT
            != 0
        {
            return Err("fixture ancestor contains a reparse point".into());
        }
    }
    let mut volume = [0u16; 260];
    win(
        unsafe {
            GetVolumePathNameW(
                wide(parent.to_str().ok_or("invalid ProgramData")?).as_ptr(),
                volume.as_mut_ptr(),
                volume.len() as u32,
            )
        },
        "find fixture volume",
    )?;
    if unsafe { GetDriveTypeW(volume.as_ptr()) } != 3 {
        return Err("fixture volume is not a fixed local disk".into());
    }
    let mut filesystem = [0u16; 32];
    win(
        unsafe {
            GetVolumeInformationW(
                volume.as_ptr(),
                null_mut(),
                0,
                null_mut(),
                null_mut(),
                null_mut(),
                filesystem.as_mut_ptr(),
                filesystem.len() as u32,
            )
        },
        "inspect fixture filesystem",
    )?;
    let end = filesystem
        .iter()
        .position(|word| *word == 0)
        .unwrap_or(filesystem.len());
    if String::from_utf16_lossy(&filesystem[..end]) != "NTFS" {
        return Err("fixture requires NTFS".into());
    }
    Ok(parent)
}
fn record(receipt: &mut Receipt, name: impl Into<String>, passed: bool, detail: impl Into<String>) {
    receipt.checks.push(Check {
        name: name.into(),
        passed,
        detail: detail.into(),
    });
}
fn denied(result: std::io::Result<impl Sized>) -> bool {
    result
        .err()
        .is_some_and(|e| e.kind() == std::io::ErrorKind::PermissionDenied)
}
fn file_checks(root: &Path, token: HANDLE, receipt: &mut Receipt, workspace: bool) -> Result<()> {
    let prefix = if workspace { "workspace" } else { "readOnly" };
    let normal = root.join("project/normal.txt");
    let secret = root.join("project/nested/.env.secret");
    let env_local = root.join("project/.env.local");
    let outside = root.join("external.txt");
    let tests = impersonated(token, || {
        vec![
            ("read ordinary", fs::read(&normal).is_ok()),
            (
                "write ordinary",
                if workspace {
                    OpenOptions::new().write(true).open(&normal).is_ok()
                } else {
                    denied(OpenOptions::new().write(true).open(&normal))
                },
            ),
            ("read secret denied", denied(fs::read(&secret))),
            (
                "write secret denied",
                denied(OpenOptions::new().write(true).open(&secret)),
            ),
            ("read root .env.local", fs::read(&env_local).is_ok()),
            (
                "write root .env.local denied",
                denied(OpenOptions::new().write(true).open(&env_local)),
            ),
            ("external read denied", denied(fs::read(&outside))),
            (
                "external write denied",
                denied(OpenOptions::new().write(true).open(&outside)),
            ),
            // DELETE handles prove access failure without destructively deleting fixture data.
            ("secret DELETE denied", delete_denied(&secret)),
            (
                "sensitive ancestor DELETE denied",
                delete_denied(&root.join("project/nested")),
            ),
            (
                "project DELETE_CHILD denied",
                open_denied(&root.join("project"), policy::DELETE_CHILD),
            ),
            ("secret WRITE_DAC denied", open_denied(&secret, WRITE_DAC)),
            (
                "rules write denied",
                denied(
                    OpenOptions::new()
                        .write(true)
                        .open(root.join("project/.git/config")),
                ),
            ),
            (
                "build artifact create and reopen",
                if workspace {
                    let artifact = root.join("project/output/artifact.txt");
                    fs::write(&artifact, b"owned build artifact").is_ok()
                        && fs::read(&artifact).is_ok()
                } else {
                    denied(
                        OpenOptions::new()
                            .write(true)
                            .create_new(true)
                            .open(root.join("project/output/read-only-artifact.txt")),
                    )
                },
            ),
        ]
    })?;
    for (name, passed) in tests {
        record(receipt, format!("{prefix}: {name}"), passed, "actual file access under restricted impersonation; does not prove child-process identity");
    }
    Ok(())
}
fn open_denied(path: &Path, access: u32) -> bool {
    let handle = unsafe {
        CreateFileW(
            wide(path.to_str().unwrap()).as_ptr(),
            access,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        unsafe { GetLastError() == ERROR_ACCESS_DENIED }
    } else {
        drop(Handle(handle));
        false
    }
}
fn delete_denied(path: &Path) -> bool {
    open_denied(path, DELETE)
}

// Both API-side and receiver-side observations are required. UDP send success
// alone is deliberately not considered a failure or a successful block.
fn network_checks(token: HANDLE, receipt: &mut Receipt) -> Result<()> {
    for bind in ["127.0.0.1:0", "[::1]:0"] {
        let tcp = TcpListener::bind(bind).map_err(|e| format!("TCP receiver {bind}: {e}"))?;
        tcp.set_nonblocking(true).map_err(|e| e.to_string())?;
        let address = tcp.local_addr().map_err(|e| e.to_string())?;
        // Prove receiver reachability from the host before testing the sandbox.
        let baseline = TcpStream::connect_timeout(&address, Duration::from_secs(1))
            .map_err(|e| e.to_string())?;
        let accepted = tcp.accept().map_err(|e| e.to_string())?;
        drop(accepted);
        drop(baseline);
        let api_denied = impersonated(token, || {
            TcpStream::connect_timeout(&address, Duration::from_millis(500)).is_err()
        })?;
        let no_connection =
            matches!(tcp.accept(), Err(e) if e.kind() == std::io::ErrorKind::WouldBlock);
        record(receipt, format!("TCP {address}"), api_denied && no_connection, format!("API denied={api_denied}; receiver no connection={no_connection}; impersonated-thread scope only"));
        let udp = UdpSocket::bind(bind).map_err(|e| e.to_string())?;
        udp.set_read_timeout(Some(Duration::from_millis(600)))
            .map_err(|e| e.to_string())?;
        let address = udp.local_addr().map_err(|e| e.to_string())?;
        let host = UdpSocket::bind(bind).map_err(|e| e.to_string())?;
        host.send_to(b"host-positive-control", address)
            .map_err(|e| e.to_string())?;
        let mut bytes = [0; 64];
        udp.recv_from(&mut bytes).map_err(|e| e.to_string())?;
        let api = impersonated(token, || {
            UdpSocket::bind(bind)
                .and_then(|socket| socket.send_to(b"sandbox-negative-control", address))
        })?;
        let no_packet = matches!(udp.recv_from(&mut bytes), Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut));
        record(receipt, format!("UDP {address}"), no_packet, format!("API send success={}; receiver no packet={no_packet}; impersonated-thread scope only", api.is_ok()));
    }
    Ok(())
}

pub fn run() -> Result<()> {
    if !elevated()? {
        return Err("explicit elevated setup action required; no machine resources changed".into());
    }
    let id = Uuid::new_v4();
    // Never accepts a user/model-selected account, path, command or filter key.
    let root = fixture_parent()?.join(format!("ShellSpan-stage-A-{id}"));
    protected_fixture(&root)?;
    let receipt_path = root.join("ownership.json");
    let name = format!("SSPA{}", &id.simple().to_string()[..12]);
    let words = id.as_fields();
    let restricting_text = format!(
        "S-1-5-21-{}-{}-{}-{}",
        words.0,
        words.1 as u32,
        words.2 as u32,
        u32::from_le_bytes(words.3[..4].try_into().unwrap())
    );
    let keys: [GUID; 4] = std::array::from_fn(|_| GUID::from_u128(Uuid::new_v4().as_u128()));
    let mut receipt = Receipt {
        backend: "account-restricted-token-acl-wfp-prototype-v1",
        production: "unavailable",
        account: name.clone(),
        account_sid: None,
        restricting_sid: restricting_text.clone(),
        filter_keys: keys
            .iter()
            .map(|key| {
                format!(
                    "{:08x}-{:04x}-{:04x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
                    key.data1,
                    key.data2,
                    key.data3,
                    key.data4[0],
                    key.data4[1],
                    key.data4[2],
                    key.data4[3],
                    key.data4[4],
                    key.data4[5],
                    key.data4[6],
                    key.data4[7]
                )
            })
            .collect(),
        fixture: root.display().to_string(),
        state: "planned (account and filters may require recovery after interruption)".into(),
        checks: vec![],
        cleanup_debt: vec![],
        missing_evidence: vec![
            "restricted child process, private desktop and descendants",
            "minimal system/toolchain startup rights",
            "DNS/system-service delegation, private network and inbound",
            "reparse/hardlink/ADS/short names and concurrent ACL/object replacement",
            "persistent filters across crash/reboot",
            "full protected credential and immutable recovery journal (phase B)",
        ],
    };
    save(&receipt_path, &receipt)?;
    // Generate without materializing a printable password String.
    let random = Uuid::new_v4();
    let mut password = Password(wide("aA!7"));
    password.0.pop();
    for byte in random.as_bytes() {
        password.0.push((b'A' + byte % 26) as u16);
        password.0.push((b'0' + byte % 10) as u16);
    }
    password.0.push(0);
    let mut account = Account::create(name, &mut password)?;
    let mut network = None;
    let mut granted: Vec<(PathBuf, Local)> = vec![];
    let experiment = (|| {
        let account_text = account_sid(&account.name)?;
        receipt.account_sid = Some(account_text.clone());
        receipt.state = "disabled account SID resolved; planned persistent filters".into();
        save(&receipt_path, &receipt)?;
        network = Some(engine()?);
        install_network(network.as_ref().unwrap(), &account_text, &keys)?;
        receipt.state = "persistent SID filters installed; account still disabled".into();
        save(&receipt_path, &receipt)?;
        // Temporary activation is only for obtaining the local token; no processes
        // are launched. Disable immediately, including on failure via Account drop.
        account.enabled(true)?;
        let login_result = account.logon(&password);
        account.enabled(false)?;
        let login = login_result?;
        drop(password);
        if token_sid(login.0)? != account_text {
            return Err("logon account SID mismatch".into());
        }
        receipt.state = "account disabled; token acquired".into();
        save(&receipt_path, &receipt)?;
        let restrict_sid = sid(&restricting_text)?;
        let restricted = restricted(login.0, &restrict_sid)?;
        for dir in [
            "project",
            "project/nested",
            "project/.git",
            "project/output",
        ] {
            fs::create_dir(root.join(dir)).map_err(|e| e.to_string())?;
        }
        for file in [
            "project/normal.txt",
            "project/nested/.env.secret",
            "project/.env.local",
            "project/.git/config",
            "external.txt",
        ] {
            fs::write(root.join(file), b"owned non-secret fixture\n").map_err(|e| e.to_string())?;
        }
        // Ordinary account + restricting SID must independently pass. Root grants
        // traverse only and protects ownership.json against both read and writes.
        for workspace in [false, true] {
            let entries = [
                ("", Object::PinnedDirectory),
                ("project", Object::PinnedDirectory),
                ("project/nested", Object::PinnedDirectory),
                ("project/output", Object::OrdinaryDirectory),
                ("project/.git", Object::Rules),
                ("project/.git/config", Object::Rules),
                ("project/normal.txt", Object::OrdinaryFile),
                ("project/nested/.env.secret", Object::Secret),
                ("project/.env.local", Object::RootEnvLocal),
                ("external.txt", Object::External),
            ];
            for (relative, object) in entries {
                let path = root.join(relative);
                let rights = if relative.is_empty() {
                    policy::EXECUTE
                } else {
                    policy::access(workspace, object)
                };
                if rights & (policy::DELETE_CHILD | policy::CHANGE_ACL) != 0 {
                    return Err("unsafe fixture permission mask".into());
                }
                for text in [&account_text, &restricting_text] {
                    let subject = sid(text)?;
                    // Record planned ownership before mutation. Per-object receipt
                    // is fixture-only; production must bind stable file identities.
                    receipt.state = format!("applying owned ACE: {relative}");
                    save(&receipt_path, &receipt)?;
                    granted.push((path.clone(), subject));
                    acl(&path, &granted.last().unwrap().1, rights, SET_ACCESS)?;
                }
            }
            file_checks(&root, restricted.0, &mut receipt, workspace)?;
        }
        network_checks(restricted.0, &mut receipt)?;
        Ok::<(), String>(())
    })();
    if let Err(error) = &experiment {
        record(
            &mut receipt,
            "experiment infrastructure",
            false,
            error.clone(),
        );
    }
    // No processes were created: token handles are closed before cleanup. If a
    // future launcher is added, process-tree proof must precede this entire block.
    if let Err(error) = account.enabled(false) {
        receipt.cleanup_debt.push(error);
    }
    for (path, subject) in granted.iter().rev() {
        if let Err(error) = acl(path, subject, 0, REVOKE_ACCESS) {
            receipt.cleanup_debt.push(error);
        }
    }
    // Keep account/SID protection whenever cleanup is uncertain. No prefix sweep.
    if receipt.cleanup_debt.is_empty() {
        match account.remove() {
            Err(error) => receipt.cleanup_debt.push(error),
            Ok(()) => {
                if let Some(network) = &network {
                    for key in &keys {
                        if let Err(error) = status(
                            unsafe { FwpmFilterDeleteByKey0(network.0, key) },
                            "remove exact owned filter",
                        ) {
                            receipt.cleanup_debt.push(error);
                        }
                    }
                }
            }
        }
    }
    receipt.state = "NO-GO: incomplete phase A acceptance; retained fixture is evidence, not reusable authorization".into();
    save(&receipt_path, &receipt)?;
    Err(format!(
        "{} checks passed / {}; receipt {}; {} cleanup debts; mandatory evidence still missing",
        receipt.checks.iter().filter(|c| c.passed).count(),
        receipt.checks.len(),
        receipt_path.display(),
        receipt.cleanup_debt.len()
    ))
}
