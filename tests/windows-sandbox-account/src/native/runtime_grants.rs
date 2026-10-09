//! Bounded read/execute exceptions on fixed OS runtime objects, never user paths.
use super::*;
use windows_sys::Win32::System::SystemInformation::{GetSystemDirectoryW, GetWindowsDirectoryW};

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RuntimeRecord {
    path: String,
    volume_serial: u32,
    file_index: u64,
    state: String,
}

pub(super) struct RestorePrivilege {
    token: Handle,
    previous: TOKEN_PRIVILEGES,
}
impl RestorePrivilege {
    fn enable() -> Result<Self> {
        Self::enable_named("SeRestorePrivilege")
    }
    pub(super) fn enable_named(name: &'static str) -> Result<Self> {
        if ![
            "SeRestorePrivilege",
            "SeBackupPrivilege",
            "SeImpersonatePrivilege",
            "SeIncreaseQuotaPrivilege",
        ]
        .contains(&name)
        {
            return Err("unsupported scoped setup privilege".into());
        }
        let mut handle = null_mut();
        win(
            unsafe {
                OpenProcessToken(
                    GetCurrentProcess(),
                    TOKEN_QUERY | TOKEN_ADJUST_PRIVILEGES,
                    &mut handle,
                )
            },
            "open setup privilege token",
        )?;
        let token = Handle(handle);
        let mut luid = LUID::default();
        win(
            unsafe { LookupPrivilegeValueW(null(), wide(name).as_ptr(), &mut luid) },
            "lookup existing restore privilege",
        )?;
        let requested = TOKEN_PRIVILEGES {
            PrivilegeCount: 1,
            Privileges: [LUID_AND_ATTRIBUTES {
                Luid: luid,
                Attributes: SE_PRIVILEGE_ENABLED,
            }],
        };
        let mut previous = TOKEN_PRIVILEGES::default();
        let mut length = 0;
        unsafe {
            SetLastError(0);
        }
        win(
            unsafe {
                AdjustTokenPrivileges(
                    token.0,
                    0,
                    &requested,
                    std::mem::size_of_val(&previous) as u32,
                    &mut previous,
                    &mut length,
                )
            },
            "enable existing setup restore privilege",
        )?;
        if unsafe { GetLastError() } == ERROR_NOT_ALL_ASSIGNED {
            return Err(format!("setup token lacks existing {name}; no ownership takeover or policy grant permitted"));
        }
        Ok(Self { token, previous })
    }
}
impl Drop for RestorePrivilege {
    fn drop(&mut self) {
        if unsafe {
            AdjustTokenPrivileges(self.token.0, 0, &self.previous, 0, null_mut(), null_mut())
        } == 0
        {
            std::process::abort();
        }
    }
}

pub(super) fn directory(system: bool) -> Result<PathBuf> {
    let mut buffer = [0u16; 32768];
    let length = unsafe {
        if system {
            GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32)
        } else {
            GetWindowsDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32)
        }
    } as usize;
    if length == 0 || length >= buffer.len() {
        return Err("fixed runtime directory query failed".into());
    }
    Ok(PathBuf::from(String::from_utf16_lossy(&buffer[..length])))
}

fn paths() -> Result<Vec<PathBuf>> {
    let system = directory(true)?;
    let mut paths = vec![];
    // Fixed Windows 11 x64 runtime set. Missing optional DLLs are not searched
    // elsewhere, and initialization failures never expand this list at runtime.
    for name in [
        "ntdll.dll",
        "kernel32.dll",
        "KernelBase.dll",
        "advapi32.dll",
        "sechost.dll",
        "rpcrt4.dll",
        "user32.dll",
        "win32u.dll",
        "gdi32.dll",
        "gdi32full.dll",
        "msvcp_win.dll",
        "ucrtbase.dll",
        "vcruntime140.dll",
        "ws2_32.dll",
        "bcrypt.dll",
        "bcryptPrimitives.dll",
        "cryptbase.dll",
        "cryptsp.dll",
        "sspicli.dll",
        "secur32.dll",
        "imm32.dll",
        "combase.dll",
    ] {
        let path = system.join(name);
        if path.try_exists().map_err(|e| e.to_string())? {
            paths.push(path);
        }
    }
    Ok(paths)
}

fn open(path: &Path) -> Result<(Handle, BY_HANDLE_FILE_INFORMATION)> {
    // No share-delete: freeze this actual object while applying/revoking its SID.
    let raw = unsafe {
        CreateFileW(
            wide(path.to_str().ok_or("invalid fixed runtime path")?).as_ptr(),
            READ_CONTROL | WRITE_DAC | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    };
    if raw == INVALID_HANDLE_VALUE {
        return Err(format!(
            "open fixed runtime security handle: Win32 {}",
            unsafe { GetLastError() }
        ));
    }
    let handle = Handle(raw);
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    win(
        unsafe { GetFileInformationByHandle(handle.0, &mut info) },
        "freeze runtime object identity",
    )?;
    // Never apply SetSecurityInfo to a directory: even a non-inheriting new
    // ACE can trigger propagation of its existing inheritable ACEs. The token's
    // retained traverse privilege permits fixed DLL paths without directory ACLs.
    if info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY) != 0 {
        return Err("fixed runtime directory/reparse point rejected".into());
    }
    Ok((handle, info))
}

fn index(info: &BY_HANDLE_FILE_INFORMATION) -> u64 {
    (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow)
}

fn merge(handle: HANDLE, subject: &Local, mode: ACCESS_MODE) -> Result<()> {
    let mut old = null_mut();
    let mut descriptor = null_mut();
    status(
        unsafe {
            GetSecurityInfo(
                handle,
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                &mut old,
                null_mut(),
                &mut descriptor,
            )
        },
        "read held runtime ACL",
    )?;
    let _descriptor = Local(descriptor);
    if old.is_null() {
        return Err("NULL runtime DACL rejected".into());
    }
    let merged = build_delta(old, subject, mode)?;
    status(
        unsafe {
            SetSecurityInfo(
                handle,
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                merged.0.cast(),
                null(),
            )
        },
        "write held runtime restricting SID ACL",
    )
}

fn build_delta(old: *mut ACL, subject: &Local, mode: ACCESS_MODE) -> Result<Local> {
    let entry = EXPLICIT_ACCESS_W {
        grfAccessPermissions: if mode == REVOKE_ACCESS {
            0
        } else {
            policy::EXECUTE
        },
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
        "merge only runtime restricting SID",
    )?;
    Ok(Local(merged.cast()))
}

pub(super) struct RuntimeGrants {
    subject: Local,
    objects: Vec<Handle>,
}
impl RuntimeGrants {
    pub(super) fn new(restricting_sid: &str) -> Result<Self> {
        Ok(Self {
            subject: sid(restricting_sid)?,
            objects: vec![],
        })
    }
    pub(super) fn prepare(&mut self, root: &Path, receipt: &mut Receipt) -> Result<()> {
        let _privilege = RestorePrivilege::enable()?;
        for path in paths()? {
            let (handle, info) = open(&path)?;
            if has_owned_allow_ace(&path, &self.subject)? {
                return Err("runtime restricting SID unexpectedly already present".into());
            }
            receipt.runtime_grants.push(RuntimeRecord {
                path: path.to_str().ok_or("invalid runtime path")?.into(),
                volume_serial: info.dwVolumeSerialNumber,
                file_index: index(&info),
                state: "planned".into(),
            });
            self.objects.push(handle);
            save(&root.join("ownership.json"), receipt)?;
            merge(self.objects.last().unwrap().0, &self.subject, GRANT_ACCESS)?;
            receipt.runtime_grants.last_mut().unwrap().state = "active".into();
            save(&root.join("ownership.json"), receipt)?;
        }
        Ok(())
    }
    pub(super) fn revoke(&self, root: &Path, receipt: &mut Receipt) -> Result<()> {
        for (handle, record) in self
            .objects
            .iter()
            .zip(receipt.runtime_grants.iter_mut())
            .rev()
        {
            if has_owned_allow_ace(Path::new(&record.path), &self.subject)? {
                merge(handle.0, &self.subject, REVOKE_ACCESS)?;
            }
            if has_owned_allow_ace(Path::new(&record.path), &self.subject)? {
                return Err("runtime restricting SID remains".into());
            }
            record.state = "revoked".into();
        }
        save(&root.join("ownership.json"), receipt)
    }
}

pub(super) fn recover(
    records: &[RuntimeRecord],
    restricting_sid: &str,
) -> Result<Vec<RuntimeRecord>> {
    if records.iter().all(|record| record.state == "revoked") {
        return Ok(records.to_vec());
    }
    if records.len() > 22 {
        return Err("runtime recovery exceeds fixed object budget".into());
    }
    let approved = paths()?;
    let _privilege = RestorePrivilege::enable()?;
    let subject = sid(restricting_sid)?;
    let mut recovered = records.to_vec();
    for record in &mut recovered {
        if record.state == "revoked" {
            continue;
        }
        let path = PathBuf::from(&record.path);
        if !approved.contains(&path) || !["active", "planned"].contains(&record.state.as_str()) {
            return Err("runtime recovery path/state is not approved".into());
        }
        let (handle, info) = open(&path)?;
        if info.dwVolumeSerialNumber != record.volume_serial || index(&info) != record.file_index {
            return Err("runtime object identity changed; retain debt".into());
        }
        if has_owned_allow_ace(&path, &subject)? {
            merge(handle.0, &subject, REVOKE_ACCESS)?;
        }
        if has_owned_allow_ace(&path, &subject)? {
            return Err("runtime ACE recovery not confirmed".into());
        }
        record.state = "revoked".into();
    }
    Ok(recovered)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn access(base: HANDLE, dacl: *mut ACL, desired: u32) -> bool {
        let system = sid("S-1-5-18").unwrap();
        let mut sd = SECURITY_DESCRIPTOR::default();
        win(
            unsafe {
                InitializeSecurityDescriptor((&mut sd as *mut SECURITY_DESCRIPTOR).cast(), 1)
            },
            "initialize access fixture",
        )
        .unwrap();
        win(
            unsafe {
                SetSecurityDescriptorOwner(
                    (&mut sd as *mut SECURITY_DESCRIPTOR).cast(),
                    system.0,
                    0,
                )
            },
            "set fixture owner",
        )
        .unwrap();
        win(
            unsafe {
                SetSecurityDescriptorGroup(
                    (&mut sd as *mut SECURITY_DESCRIPTOR).cast(),
                    system.0,
                    0,
                )
            },
            "set fixture group",
        )
        .unwrap();
        win(
            unsafe {
                SetSecurityDescriptorDacl((&mut sd as *mut SECURITY_DESCRIPTOR).cast(), 1, dacl, 0)
            },
            "set fixture DACL",
        )
        .unwrap();
        let mut token = null_mut();
        win(
            unsafe {
                DuplicateTokenEx(
                    base,
                    TOKEN_QUERY,
                    null(),
                    SecurityImpersonation,
                    TokenImpersonation,
                    &mut token,
                )
            },
            "duplicate actual access Token",
        )
        .unwrap();
        let token = Handle(token);
        let mapping = GENERIC_MAPPING {
            GenericRead: FILE_GENERIC_READ,
            GenericWrite: FILE_GENERIC_WRITE,
            GenericExecute: FILE_GENERIC_EXECUTE,
            GenericAll: FILE_ALL_ACCESS,
        };
        let mut privileges = [0usize; 128];
        let mut length = std::mem::size_of_val(&privileges) as u32;
        let mut granted = 0;
        let mut allowed = 0;
        win(
            unsafe {
                AccessCheck(
                    (&mut sd as *mut SECURITY_DESCRIPTOR).cast(),
                    token.0,
                    desired,
                    &mapping,
                    privileges.as_mut_ptr().cast(),
                    &mut length,
                    &mut granted,
                    &mut allowed,
                )
            },
            "actual runtime access check",
        )
        .unwrap();
        allowed != 0
    }

    #[test]
    fn runtime_delta_is_read_only_non_inheriting_and_preserves_host_access() {
        let host = token().unwrap();
        let ordinary = token_sid(host.0).unwrap();
        let subject = sid("S-1-5-21-771921-771922-771923-771924").unwrap();
        let restricted = restricted(host.0, &subject).unwrap();
        let (sd, _) = descriptor(&format!("O:SYG:SYD:(A;OICI;FA;;;{ordinary})")).unwrap();
        let mut present = 0;
        let mut defaulted = 0;
        let mut dacl = null_mut();
        win(
            unsafe { GetSecurityDescriptorDacl(sd.0, &mut present, &mut dacl, &mut defaulted) },
            "get runtime ACL fixture",
        )
        .unwrap();
        let merged = build_delta(dacl, &subject, GRANT_ACCESS).unwrap();
        assert!(!access(restricted.0, dacl, FILE_READ_DATA));
        assert!(access(restricted.0, merged.0.cast(), FILE_READ_DATA));
        assert!(!access(restricted.0, merged.0.cast(), FILE_WRITE_DATA));
        assert!(!access(restricted.0, merged.0.cast(), WRITE_DAC));
        assert!(
            access(host.0, merged.0.cast(), FILE_WRITE_DATA),
            "existing host access must survive the delta"
        );
        let mut found = false;
        for index in 0..unsafe { (*(merged.0.cast::<ACL>())).AceCount } as u32 {
            let mut ace = null_mut();
            win(
                unsafe { GetAce(merged.0.cast(), index, &mut ace) },
                "inspect actual merged ACE",
            )
            .unwrap();
            let allowed = unsafe { &*(ace.cast::<ACCESS_ALLOWED_ACE>()) };
            if unsafe {
                EqualSid(
                    (&allowed.SidStart as *const u32).cast_mut().cast(),
                    subject.0,
                )
            } != 0
            {
                found = true;
                assert_eq!(
                    allowed.Header.AceFlags, 0,
                    "runtime exception cannot propagate to unrelated children"
                );
            }
        }
        assert!(found);
        let revoked = build_delta(merged.0.cast(), &subject, REVOKE_ACCESS).unwrap();
        assert!(!access(restricted.0, revoked.0.cast(), FILE_READ_DATA));
        assert!(access(host.0, revoked.0.cast(), FILE_WRITE_DATA));
    }
}
