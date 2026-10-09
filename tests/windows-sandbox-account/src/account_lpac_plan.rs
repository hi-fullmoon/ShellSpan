//! Fixed dedicated-account bootstrap contract, excluding passwords and arbitrary commands.
use crate::receiver_control::Endpoints;
use serde::{Deserialize, Serialize};
use std::path::Path;
type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AccountLpacPlan {
    pub version: u32,
    pub fixture_id: uuid::Uuid,
    pub account_sid: String,
    pub receivers: Endpoints,
}
impl AccountLpacPlan {
    pub fn profile_name(&self) -> String {
        format!("ShellSpan-candidate-{}", self.fixture_id.simple())
    }
    pub fn account_name(&self) -> String {
        format!("SSPA{}", &self.fixture_id.simple().to_string()[..12])
    }
    pub fn directory_name(&self) -> String {
        format!("ShellSpan-stage-A-account-lpac-{}", self.fixture_id)
    }
    pub fn validate_for_source(&self, source_sid: &str, root: &Path) -> Result<()> {
        self.receivers.validate()?;
        let local_disk = matches!(root.components().next(), Some(std::path::Component::Prefix(prefix)) if matches!(prefix.kind(), std::path::Prefix::Disk(_)));
        if self.version != 1
            || self.fixture_id.is_nil()
            || !local_disk
            || root.components().any(|component| {
                matches!(
                    component,
                    std::path::Component::ParentDir | std::path::Component::CurDir
                )
            })
            || self.account_sid != source_sid
            || !self.account_sid.starts_with("S-1-5-21-")
            || !root.is_absolute()
            || root.file_name().and_then(|name| name.to_str())
                != Some(self.directory_name().as_str())
        {
            return Err(
                "fixed LPAC plan does not match the actual dedicated account and owned directory"
                    .into(),
            );
        }
        Ok(())
    }
}

#[cfg(windows)]
pub fn read_protected(root: &Path) -> Result<AccountLpacPlan> {
    serde_json::from_slice(&read_protected_bytes(root, "account-lpac.json", 8192)?)
        .map_err(|e| e.to_string())
}
#[cfg(windows)]
pub fn read_protected_receipt(root: &Path) -> Result<Vec<u8>> {
    read_protected_bytes(root, "ownership.json", 65536)
}
#[cfg(windows)]
fn read_protected_bytes(root: &Path, filename: &'static str, budget: u32) -> Result<Vec<u8>> {
    use std::io::Read;
    use std::os::windows::io::FromRawHandle;
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::{
        Foundation::*,
        Security::{Authorization::*, *},
        Storage::FileSystem::*,
    };
    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(Some(0)).collect()
    }
    struct Handle(HANDLE);
    impl Drop for Handle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    struct Local(*mut std::ffi::c_void);
    impl Drop for Local {
        fn drop(&mut self) {
            unsafe {
                LocalFree(self.0);
            }
        }
    }
    fn verify(handle: HANDLE) -> Result<()> {
        let mut sd = null_mut();
        let mut owner = null_mut();
        let mut dacl = null_mut();
        let status = unsafe {
            GetSecurityInfo(
                handle,
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                &mut owner,
                null_mut(),
                &mut dacl,
                null_mut(),
                &mut sd,
            )
        };
        if status != 0 {
            return Err(format!("read protected plan security Win32={status}"));
        }
        let _sd = Local(sd);
        let mut system = null_mut();
        let mut administrators = null_mut();
        if unsafe { ConvertStringSidToSidW(wide("S-1-5-18").as_ptr(), &mut system) } == 0 {
            return Err("parse plan SYSTEM SID failed".into());
        }
        let system = Local(system);
        if unsafe { ConvertStringSidToSidW(wide("S-1-5-32-544").as_ptr(), &mut administrators) }
            == 0
        {
            return Err("parse plan administrators SID failed".into());
        }
        let administrators = Local(administrators);
        let trusted = |subject: PSID| unsafe {
            !subject.is_null()
                && (EqualSid(subject, system.0) != 0 || EqualSid(subject, administrators.0) != 0)
        };
        if !trusted(owner) || dacl.is_null() {
            return Err("plan ownership or DACL is untrusted".into());
        }
        let writes = GENERIC_ALL
            | GENERIC_WRITE
            | WRITE_DAC
            | WRITE_OWNER
            | DELETE
            | FILE_WRITE_DATA
            | FILE_APPEND_DATA
            | FILE_DELETE_CHILD
            | FILE_WRITE_ATTRIBUTES
            | FILE_WRITE_EA;
        for index in 0..unsafe { (*dacl).AceCount } as u32 {
            let mut ace = null_mut();
            if unsafe { GetAce(dacl, index, &mut ace) } == 0 {
                return Err("plan ACE query failed".into());
            }
            let allowed = unsafe { &*ace.cast::<ACCESS_ALLOWED_ACE>() };
            if allowed.Header.AceType != 0
                || (allowed.Mask & writes != 0
                    && !trusted((&allowed.SidStart as *const u32).cast_mut().cast()))
            {
                return Err("untrusted identity may mutate the dedicated account plan".into());
            }
        }
        Ok(())
    }
    let parent = Handle(unsafe {
        CreateFileW(
            wide(root.to_str().ok_or("invalid plan root")?).as_ptr(),
            READ_CONTROL | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    });
    if parent.0 == INVALID_HANDLE_VALUE {
        return Err("hold fixed plan parent failed".into());
    }
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    if unsafe { GetFileInformationByHandle(parent.0, &mut info) } == 0
        || info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
    {
        return Err("fixed plan parent identity unverified".into());
    }
    verify(parent.0)?;
    let path = root.join(filename);
    let raw = unsafe {
        CreateFileW(
            wide(path.to_str().ok_or("invalid fixed plan path")?).as_ptr(),
            GENERIC_READ | READ_CONTROL,
            FILE_SHARE_READ,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    };
    if raw == INVALID_HANDLE_VALUE {
        return Err("open fixed protected account plan failed".into());
    }
    let mut file = unsafe { std::fs::File::from_raw_handle(raw) };
    if unsafe { GetFileInformationByHandle(raw, &mut info) } == 0
        || info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY) != 0
        || info.nNumberOfLinks != 1
        || info.nFileSizeHigh != 0
        || info.nFileSizeLow > budget
    {
        return Err("fixed account plan object identity or budget unverified".into());
    }
    verify(raw)?;
    let mut bytes = Vec::new();
    (&mut file)
        .take(u64::from(budget) + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > budget as usize {
        return Err("fixed account plan exceeds budget".into());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn untrusted_desktop_directory_cannot_supply_a_privileged_plan() {
        let error = read_protected(&std::env::temp_dir()).unwrap_err();
        assert!(error.contains("untrusted"), "ordinary user Temp directory must fail the security gate before plan contents are read: {error}");
    }
    #[test]
    fn plan_binds_actual_source_and_owned_uuid_without_arbitrary_resource_fields() {
        let id = uuid::Uuid::new_v4();
        let sid = "S-1-5-21-1-2-3-1001";
        let plan = AccountLpacPlan {
            version: 1,
            fixture_id: id,
            account_sid: sid.into(),
            receivers: Endpoints {
                tcp: ["127.0.0.1:1".parse().unwrap(), "[::1]:2".parse().unwrap()],
                udp: ["127.0.0.1:3".parse().unwrap(), "[::1]:4".parse().unwrap()],
            },
        };
        let root = std::env::temp_dir().join(plan.directory_name());
        assert!(plan.validate_for_source(sid, &root).is_ok());
        let mut nil = plan.clone();
        nil.fixture_id = uuid::Uuid::nil();
        assert!(nil
            .validate_for_source(sid, &std::env::temp_dir().join(nil.directory_name()))
            .is_err());
        for prefix in [
            r"\\server\share",
            r"\\?\C:\",
            r"\\.\C:\",
            r"C:\owned\..\outside",
        ] {
            assert!(
                plan.validate_for_source(sid, &Path::new(prefix).join(plan.directory_name()))
                    .is_err(),
                "{prefix}"
            );
        }
        assert!(plan
            .validate_for_source("S-1-5-21-1-2-3-1002", &root)
            .is_err());
        assert!(plan
            .validate_for_source(sid, &std::env::temp_dir())
            .is_err());
        let mut value = serde_json::to_value(&plan).unwrap();
        value["command"] = "arbitrary command".into();
        assert!(serde_json::from_value::<AccountLpacPlan>(value).is_err());
        assert_eq!(
            plan.profile_name(),
            format!("ShellSpan-candidate-{}", id.simple())
        );
    }
}
