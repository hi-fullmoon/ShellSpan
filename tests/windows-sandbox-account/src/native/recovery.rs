//! Exact owned-fixture retirement. Not a production or general recovery API.
use super::*;
use windows_sys::Win32::System::RemoteDesktop::*;

fn same_guid(left: &GUID, right: &GUID) -> bool {
    left.data1 == right.data1
        && left.data2 == right.data2
        && left.data3 == right.data3
        && left.data4 == right.data4
}

pub(super) fn trusted_descriptor(sd: *mut c_void) -> Result<()> {
    trusted_descriptor_with_mask(
        sd,
        GENERIC_ALL
            | GENERIC_WRITE
            | WRITE_DAC
            | WRITE_OWNER
            | DELETE
            | FILE_WRITE_DATA
            | FILE_APPEND_DATA
            | FILE_DELETE_CHILD
            | FILE_WRITE_ATTRIBUTES
            | FILE_WRITE_EA,
    )
}
pub(super) fn trusted_descriptor_with_mask(sd: *mut c_void, write_mask: u32) -> Result<()> {
    let system = sid("S-1-5-18")?;
    let administrators = sid("S-1-5-32-544")?;
    let trusted = |subject: PSID| unsafe {
        EqualSid(subject, system.0) != 0 || EqualSid(subject, administrators.0) != 0
    };
    let mut owner = null_mut();
    let mut defaulted = 0;
    win(
        unsafe { GetSecurityDescriptorOwner(sd, &mut owner, &mut defaulted) },
        "query recovery ownership",
    )?;
    if owner.is_null() || !trusted(owner) {
        return Err("recovery ownership is not SYSTEM/Administrators".into());
    }
    let mut dacl = null_mut();
    let mut present = 0;
    win(
        unsafe { GetSecurityDescriptorDacl(sd, &mut present, &mut dacl, &mut defaulted) },
        "query protected recovery DACL",
    )?;
    if present == 0 || dacl.is_null() {
        return Err("recovery DACL is absent".into());
    }
    for index in 0..unsafe { (*dacl).AceCount } as u32 {
        let mut ace = null_mut();
        win(
            unsafe { GetAce(dacl, index, &mut ace) },
            "inspect recovery DACL",
        )?;
        let header = unsafe { &*(ace.cast::<ACE_HEADER>()) };
        if header.AceType != 0 {
            return Err("unsupported recovery ACE type".into());
        }
        let allowed = unsafe { &*(ace.cast::<ACCESS_ALLOWED_ACE>()) };
        if allowed.Mask & write_mask != 0
            && !trusted((&allowed.SidStart as *const u32).cast_mut().cast())
        {
            return Err("untrusted identity can modify owned recovery evidence".into());
        }
    }
    Ok(())
}

pub(super) fn verify_evidence_acl(path: &Path) -> Result<()> {
    let mut sd = null_mut();
    status(
        unsafe {
            GetNamedSecurityInfoW(
                wide(path.to_str().ok_or("invalid evidence path")?).as_ptr(),
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                null_mut(),
                null_mut(),
                &mut sd,
            )
        },
        "read protected evidence security",
    )?;
    let storage = Local(sd);
    trusted_descriptor(storage.0)
}

fn hold_objects(objects: &[PathBuf]) -> Result<Vec<Handle>> {
    let mut handles = Vec::new();
    for path in objects {
        let raw_handle = unsafe {
            CreateFileW(
                wide(path.to_str().ok_or("invalid owned path")?).as_ptr(),
                READ_CONTROL | FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                null_mut(),
            )
        };
        if raw_handle == INVALID_HANDLE_VALUE {
            return Err("cannot freeze owned object identity".into());
        }
        let handle = Handle(raw_handle);
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        win(
            unsafe { GetFileInformationByHandle(handle.0, &mut info) },
            "verify held owned object",
        )?;
        if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
            || info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0 && info.nNumberOfLinks != 1
        {
            return Err("recovery rejects reparse points and aliased file objects".into());
        }
        handles.push(handle);
    }
    Ok(handles)
}

#[derive(Deserialize)]
struct OwnedReceipt {
    backend: String,
    production: String,
    account: String,
    account_sid: String,
    restricting_sid: String,
    filter_keys: Vec<String>,
    fixture: String,
    #[serde(default)]
    runtime_grants: Vec<super::runtime_grants::RuntimeRecord>,
}

pub(super) fn no_account_processes(subject: &Local) -> Result<()> {
    let mut processes = null_mut();
    let mut count = 0;
    win(
        unsafe {
            WTSEnumerateProcessesW(WTS_CURRENT_SERVER_HANDLE, 0, 1, &mut processes, &mut count)
        },
        "enumerate actual process account SIDs",
    )?;
    struct Wts(*mut WTS_PROCESS_INFOW);
    impl Drop for Wts {
        fn drop(&mut self) {
            unsafe {
                WTSFreeMemory(self.0.cast());
            }
        }
    }
    let _memory = Wts(processes);
    if count > 65536 || (processes.is_null() && count != 0) {
        return Err("invalid WTS inventory".into());
    }
    for index in 0..count as usize {
        let process = unsafe { &*processes.add(index) };
        if process.pUserSid.is_null() {
            // Reserved kernel idle/system PIDs cannot carry this logon account.
            if ![0, 4].contains(&process.ProcessId) {
                verify_unidentified_process(process.ProcessId, subject)?;
            }
        } else if unsafe { EqualSid(process.pUserSid, subject.0) } != 0 {
            return Err("owned account still has a process; recovery never kills by PID".into());
        }
    }
    Ok(())
}

fn verify_unidentified_process(pid: u32, subject: &Local) -> Result<()> {
    // A WTS PID is only a lookup hint. This helper never terminates a process.
    let raw = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, 0, pid) };
    if raw.is_null() {
        let error = unsafe { GetLastError() };
        if error == ERROR_INVALID_PARAMETER {
            return Ok(());
        } // No process exists for this hint now.
        return Err(format!(
            "process account identity unavailable Win32={error}; retain recovery debt"
        ));
    }
    let process = Handle(raw);
    if unsafe { WaitForSingleObject(process.0, 0) } == WAIT_OBJECT_0 {
        return Ok(());
    }
    let mut raw = null_mut();
    if unsafe { OpenProcessToken(process.0, TOKEN_QUERY, &mut raw) } == 0 {
        let error = unsafe { GetLastError() };
        if unsafe { WaitForSingleObject(process.0, 0) } == WAIT_OBJECT_0 {
            return Ok(());
        }
        return Err(format!(
            "live process Token unavailable Win32={error}; retain recovery debt"
        ));
    }
    let token = Handle(raw);
    let actual = sid(&token_sid(token.0)?)?;
    if unsafe { EqualSid(actual.0, subject.0) } != 0 {
        return Err(
            "owned account still has a held live process; recovery never kills by PID".into(),
        );
    }
    Ok(())
}

fn verify_disabled_account(receipt: &OwnedReceipt) -> Result<()> {
    if account_sid(&receipt.account)? != receipt.account_sid {
        return Err("owned account SID changed".into());
    }
    let mut info = null_mut();
    status(
        unsafe { NetUserGetInfo(null(), wide(&receipt.account).as_ptr(), 1, &mut info) },
        "read owned account state",
    )?;
    struct Net(*mut u8);
    impl Drop for Net {
        fn drop(&mut self) {
            unsafe {
                NetApiBufferFree(self.0.cast());
            }
        }
    }
    let _memory = Net(info);
    let account = unsafe { &*(info.cast::<USER_INFO_1>()) };
    if account.usri1_flags & UF_ACCOUNTDISABLE == 0 || account.usri1_priv > USER_PRIV_USER {
        return Err(format!(
            "owned account must already be disabled and non-admin; flags={:#x}; privilege tier={}",
            account.usri1_flags, account.usri1_priv
        ));
    }
    Ok(())
}

pub(super) fn verified_filter(engine: &Engine, key: &GUID, account: &Local) -> Result<()> {
    let mut pointer = null_mut();
    status(
        unsafe { FwpmFilterGetByKey0(engine.0, key, &mut pointer) },
        "inspect exact owned WFP filter",
    )?;
    struct Filter(*mut FWPM_FILTER0);
    impl Drop for Filter {
        fn drop(&mut self) {
            let mut pointer = self.0.cast();
            unsafe {
                FwpmFreeMemory0(&mut pointer);
            }
        }
    }
    let _memory = Filter(pointer);
    let filter = unsafe { &*pointer };
    if filter.flags & FWPM_FILTER_FLAG_PERSISTENT == 0
        || filter.action.r#type != FWP_ACTION_BLOCK
        || filter.numFilterConditions != 1
    {
        return Err("owned filter type changed".into());
    }
    let layers = [
        FWPM_LAYER_ALE_AUTH_CONNECT_V4,
        FWPM_LAYER_ALE_AUTH_CONNECT_V6,
        FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4,
        FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V6,
    ];
    if !layers
        .iter()
        .any(|layer| same_guid(layer, &filter.layerKey))
        || filter.filterCondition.is_null()
    {
        return Err("owned filter layer changed".into());
    }
    let condition = unsafe { &*filter.filterCondition };
    if !same_guid(&condition.fieldKey, &FWPM_CONDITION_ALE_USER_ID)
        || condition.matchType != FWP_MATCH_EQUAL
        || condition.conditionValue.r#type != FWP_SECURITY_DESCRIPTOR_TYPE
    {
        return Err("owned filter account condition changed".into());
    }
    let blob = unsafe { condition.conditionValue.Anonymous.sd.as_ref() }
        .ok_or("missing filter SID descriptor")?;
    unsafe { shellspan_account_sandbox_prototype::wfp_account_descriptor::verify(blob, account.0) }
}

fn owned_objects(root: &Path) -> Result<Vec<PathBuf>> {
    let mut objects = vec![root.to_path_buf()];
    let mut index = 0;
    while index < objects.len() {
        let path = objects[index].clone();
        let metadata = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err("recovery object is a reparse point".into());
        }
        if metadata.is_dir() {
            for entry in fs::read_dir(&path).map_err(|e| e.to_string())? {
                objects.push(entry.map_err(|e| e.to_string())?.path());
                if objects.len() > 4096 {
                    return Err("owned fixture recovery exceeds object budget".into());
                }
            }
        }
        index += 1;
    }
    Ok(objects)
}

pub(super) fn run(fixture_id: &str) -> Result<()> {
    if !elevated()? {
        return Err("explicit elevated owned-fixture recovery required".into());
    }
    let id = Uuid::parse_str(fixture_id).map_err(|_| "invalid owned fixture UUID")?;
    let root = fixture_parent()?.join(format!("ShellSpan-stage-A-{id}"));
    let objects = owned_objects(&root)?;
    let path = root.join("ownership.json");
    let _held_objects = hold_objects(&objects)?;
    verify_evidence_acl(&root)?;
    verify_evidence_acl(&path)?;
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    if bytes.len() > 65536 {
        return Err("owned receipt exceeds budget".into());
    }
    let receipt: OwnedReceipt = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let fields = id.as_fields();
    let expected_restriction = format!(
        "S-1-5-21-{}-{}-{}-{}",
        fields.0,
        fields.1 as u32,
        fields.2 as u32,
        u32::from_le_bytes(fields.3[..4].try_into().unwrap())
    );
    if receipt.backend != "account-restricted-token-acl-wfp-prototype-v1"
        || receipt.production != "unavailable"
        || receipt.fixture != root.to_string_lossy()
        || receipt.account != format!("SSPA{}", &id.simple().to_string()[..12])
        || receipt.restricting_sid != expected_restriction
        || receipt.filter_keys.len() != 4
    {
        return Err("receipt does not match exact owned fixture".into());
    }
    verify_disabled_account(&receipt)?;
    let account = sid(&receipt.account_sid)?;
    let restriction = sid(&receipt.restricting_sid)?;
    no_account_processes(&account)?;
    let engine = engine()?;
    let keys: Vec<GUID> = receipt
        .filter_keys
        .iter()
        .map(|key| {
            Uuid::parse_str(key)
                .map(|id| GUID::from_u128(id.as_u128()))
                .map_err(|_| "invalid owned filter key".to_string())
        })
        .collect::<Result<_>>()?;
    if keys
        .iter()
        .enumerate()
        .any(|(index, key)| keys[..index].iter().any(|prior| same_guid(prior, key)))
    {
        return Err("duplicate owned WFP keys".into());
    }
    for key in &keys {
        verified_filter(&engine, key, &account)?;
    }
    let mut document: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    document["state"] =
        "exact owned fixture recovery in progress; account disabled and offline rules retained"
            .into();
    persist(&path, &document)?;
    let cleanup = (|| {
        let runtime_records =
            super::runtime_grants::recover(&receipt.runtime_grants, &receipt.restricting_sid)?;
        document["runtime_grants"] =
            serde_json::to_value(runtime_records).map_err(|e| e.to_string())?;
        persist(&path, &document)?;
        // Parent-first revocation removes inherited ACEs. A second per-object
        // merge removes owned explicit grants; unrelated current ACLs survive.
        for object in &objects {
            for subject in [&account, &restriction] {
                acl(object, subject, 0, REVOKE_ACCESS)?;
            }
        }
        for object in &objects {
            for subject in [&account, &restriction] {
                if has_owned_allow_ace(object, subject)? {
                    return Err("owned ACE remains after exact revocation".into());
                }
            }
        }
        verify_disabled_account(&receipt)?;
        no_account_processes(&account)?;
        let mut owned_account = Account {
            name: receipt.account.clone(),
            created: true,
        };
        owned_account.remove()?;
        for key in &keys {
            status(
                unsafe { FwpmFilterDeleteByKey0(engine.0, key) },
                "remove exact verified owned filter",
            )?;
        }
        // Independent reads after deletion, rather than treating delete return
        // codes alone as proof that the exact resources are absent.
        let mut absent_account = null_mut();
        let account_status = unsafe {
            NetUserGetInfo(
                null(),
                wide(&receipt.account).as_ptr(),
                1,
                &mut absent_account,
            )
        };
        if account_status == 0 {
            unsafe {
                NetApiBufferFree(absent_account.cast());
            }
        }
        if account_status != NERR_UserNotFound {
            return Err("account absence not confirmed after owned recovery".into());
        }
        for key in &keys {
            let mut remaining = null_mut();
            let result = unsafe { FwpmFilterGetByKey0(engine.0, key, &mut remaining) };
            if result == 0 {
                let mut storage = remaining.cast();
                unsafe {
                    FwpmFreeMemory0(&mut storage);
                }
            }
            if result != FWP_E_FILTER_NOT_FOUND as u32 {
                return Err("exact filter absence not confirmed after recovery".into());
            }
        }
        Ok::<(), String>(())
    })();
    match &cleanup {
        Ok(()) => {
            document["cleanup_debt"] = serde_json::json!([]);
            document["state"] = "owned account/ACL/WFP recovery completed; fixture retained for evidence; production unavailable".into();
            document["recovery_checks"] = serde_json::json!({"account_sid_revalidated":true,
                "process_account_inventory_empty":true,"held_fixture_objects":objects.len(),
                "verified_filters":keys.len(),"remaining_filters":0,"account_absent":true});
        }
        Err(error) => {
            document["cleanup_debt"] = serde_json::json!([error]);
            document["state"] = "owned recovery uncertain; do not reuse account or remove remaining offline protection".into();
        }
    }
    persist(&path, &document)?;
    cleanup
}

fn persist(path: &Path, document: &serde_json::Value) -> Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    file.write_all(&serde_json::to_vec_pretty(document).map_err(|e| e.to_string())?)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_wts_sid_uses_actual_held_token_and_never_hides_owned_process() {
        let mut raw = null_mut();
        win(
            unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) },
            "inspect test process Token",
        )
        .unwrap();
        let token = Handle(raw);
        let actual = sid(&token_sid(token.0).unwrap()).unwrap();
        let pid = unsafe { GetCurrentProcessId() };
        assert!(verify_unidentified_process(pid, &actual)
            .unwrap_err()
            .contains("held live process"));
        let unrelated = sid("S-1-0-0").unwrap();
        assert!(verify_unidentified_process(pid, &unrelated).is_ok());
    }

    #[test]
    fn recovery_rejects_user_writable_or_user_owned_receipts() {
        for text in [
            "O:SYG:SYD:P(A;;FA;;;SY)(A;;FA;;;WD)",
            "O:WDG:SYD:P(A;;FA;;;SY)",
        ] {
            let (sd, _) = descriptor(text).unwrap();
            assert!(
                trusted_descriptor(sd.0).is_err(),
                "untrusted recovery evidence must be refused before mutations"
            );
        }
        let (sd, _) = descriptor("O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;WD)").unwrap();
        assert!(
            trusted_descriptor(sd.0).is_ok(),
            "a read-only export grant must not weaken recovery ownership"
        );
    }
}
