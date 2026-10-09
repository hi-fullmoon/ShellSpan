//! Fresh local-account profile lifecycle. No shell or user-selected profile paths.
use super::*;
mod account_launch;
mod controller_admission;
mod namespace_lease;
use super::system_admission::{FixedLifecycle, FixedSystemTool};
use windows_sys::Win32::System::Registry::*;
use windows_sys::Win32::UI::Shell::{
    DeleteProfileW, GetUserProfileDirectoryW, LoadUserProfileW, UnloadUserProfile, PROFILEINFOW,
};

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ProfileObject {
    path: String,
    volume_serial: u32,
    file_index: u64,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ProfileReceipt {
    version: u32,
    backend: String,
    production: String,
    fixture_id: Uuid,
    account: String,
    account_sid: Option<String>,
    filter_keys: [Uuid; 4],
    #[serde(default)]
    package_network_intent:
        Option<shellspan_account_sandbox_prototype::package_network_intent::PackageNetworkIntent>,
    #[serde(default)]
    package_filters_removed: bool,
    #[serde(default)]
    rpc_network_intent:
        Option<shellspan_account_sandbox_prototype::rpc_network_intent::RpcNetworkIntent>,
    #[serde(default)]
    rpc_filter_removed: bool,
    #[serde(default)]
    rpc_trace_intent: Option<shellspan_account_sandbox_prototype::rpc_trace_intent::RpcTraceIntent>,
    #[serde(default)]
    rpc_trace_removed: bool,
    #[serde(default)]
    rpc_trace_recovery_stopped: bool,
    profile_absent_before_load: bool,
    #[serde(default)]
    profile_registry_security_verified: bool,
    #[serde(default)]
    planned_private_station: Option<String>,
    #[serde(default)]
    planned_package_sid: Option<String>,
    #[serde(default)]
    private_desktop_verified: bool,
    #[serde(default)]
    duplicate_station_rejected: bool,
    #[serde(default)]
    private_station_removed: bool,
    profile: Option<ProfileObject>,
    profile_unloaded: bool,
    profile_removed: bool,
    account_removed: bool,
    filters_removed: bool,
    non_elevated_account_token: bool,
    state: String,
    error: Option<String>,
    cleanup_debt: Vec<String>,
    #[serde(default)]
    controller_interruption_checkpoint: bool,
    #[serde(default)]
    recovery_executed: bool,
    #[serde(default)]
    account_lpac_started: bool,
    #[serde(default)]
    account_lpac_cleanup_verified: bool,
    #[serde(default)]
    account_lpac_verified: bool,
    #[serde(default)]
    controller_receiver_counts: Option<Vec<usize>>,
    #[serde(default)]
    account_lpac_outer_job_total: Option<u32>,
    #[serde(default)]
    account_lpac_bootstrap_exit: Option<u32>,
    #[serde(default)]
    account_lpac_outer_tree_stopped: bool,
    #[serde(default)]
    independent_bootstrap_recovery_observation: Option<serde_json::Value>,
    #[serde(default)]
    independent_bootstrap_files_retired: bool,
    #[serde(default)]
    account_lpac_diagnostic_report: Option<serde_json::Value>,
    #[serde(default)]
    profile_residual_recycled: bool,
    #[serde(default)]
    account_lpac_admission_only: bool,
    #[serde(default)]
    planned_private_namespace: Option<String>,
    #[serde(default)]
    private_namespace_verified: bool,
    #[serde(default)]
    private_namespace_removed: bool,
    #[serde(default)]
    namespace_retirement_observation: Option<serde_json::Value>,
    #[serde(default)]
    controller_admission_report: Option<serde_json::Value>,
    #[serde(default)]
    controller_workload_requested: bool,
    #[serde(default)]
    controller_workload_planned_root: Option<String>,
    #[serde(default)]
    controller_workload_fixture: Option<ProfileObject>,
    #[serde(default)]
    controller_workload_retired: bool,
    #[serde(default)]
    controller_workload_files_retired: bool,
    #[serde(default)]
    controller_lifecycle: FixedLifecycle,
    #[serde(default)]
    controller_tool: Option<FixedSystemTool>,
    #[serde(default)]
    credential_reference: Option<String>,
    #[serde(default)]
    credential_reference_verified: bool,
    #[serde(default)]
    credential_removed: bool,
    #[serde(default)]
    profile_recovery_api_loaded: bool,
    #[serde(default)]
    profile_recovery_api_unloaded: bool,
    #[serde(default)]
    recovery_logon_pending: bool,
}
impl ProfileReceipt {
    fn root(&self) -> Result<PathBuf> {
        Ok(fixture_parent()?.join(format!("ShellSpan-account-profile-A-{}", self.fixture_id)))
    }
    fn save(&self) -> Result<()> {
        self.validate(self.fixture_id)?;
        journal::publish(
            &self.root()?.join("ownership.json"),
            &serde_json::to_vec_pretty(self).map_err(|e| e.to_string())?,
            false,
        )
    }
    fn validate(&self, id: Uuid) -> Result<()> {
        if id.is_nil() {
            return Err("profile transaction UUID must be nonnil".into());
        }
        if self.independent_bootstrap_files_retired
            && (!self.recovery_executed
                || !self.account_lpac_started
                || self.controller_workload_requested
                || self.controller_tool.is_some()
                || self.controller_admission_report.is_some()
                || self.controller_workload_planned_root.is_some()
                || self.account_lpac_diagnostic_report.is_some()
                || !self.profile_absent_before_load
                || self.profile.is_none()
                || !self.private_namespace_removed
                || self.planned_private_namespace.is_none()
                || self.planned_package_sid.is_none()
                || !self.private_station_removed)
        {
            return Err("empty-bootstrap checkpoint lacks its exact recovery lifecycle".into());
        }
        if self.rpc_trace_recovery_stopped
            && (!self.recovery_executed
                || !self.rpc_trace_removed
                || self.rpc_trace_intent.is_none())
        {
            return Err(
                "RPC recovery STOP checkpoint lacks verified recovery/absence/intent".into(),
            );
        }
        if let Some(intent) = &self.rpc_trace_intent {
            intent.validate(id, &intent.target)?;
            if !self.controller_workload_requested
                || self.account_sid.is_none()
                || self.planned_package_sid.is_none()
                || ((self.account_removed
                    || self.profile_removed
                    || self.filters_removed
                    || self.package_filters_removed
                    || self.rpc_filter_removed)
                    && !self.rpc_trace_removed)
            {
                return Err(
                    "RPC trace must be absent before release of owned identity protection".into(),
                );
            }
        } else if self.rpc_trace_removed {
            return Err("RPC trace retirement lacks creation intent".into());
        }
        if let Some(intent) = &self.rpc_network_intent {
            let package = self
                .package_network_intent
                .as_ref()
                .ok_or("RPC intent lacks package protection intent")?;
            let mut keys = self.filter_keys.to_vec();
            keys.extend(package.filter_keys);
            intent.validate(
                id,
                self.account_sid
                    .as_deref()
                    .ok_or("RPC intent lacks frozen account")?,
                &keys,
            )?;
            if !self.controller_workload_requested
                || ((self.account_removed || self.filters_removed || self.package_filters_removed)
                    && !self.rpc_filter_removed)
            {
                return Err(
                    "RPC block retirement must precede release of owned identity protection".into(),
                );
            }
        } else if self.rpc_filter_removed {
            return Err("RPC block retirement lacks creation intent".into());
        }
        if let Some(intent) = &self.package_network_intent {
            intent.validate(
                id,
                self.planned_package_sid
                    .as_deref()
                    .ok_or("package network intent lacks frozen package")?,
                &self.filter_keys,
            )?;
            if self.account_sid.is_none()
                || !self.controller_workload_requested
                || ((self.account_removed || self.filters_removed) && !self.package_filters_removed)
            {
                return Err("package network intent lacks owned offline lifecycle".into());
            }
        } else if self.package_filters_removed {
            return Err("package filter retirement lacks creation intent".into());
        }
        super::system_admission::validate_tool_dispatch(
            self.controller_tool,
            self.controller_workload_requested,
            self.controller_lifecycle,
            None,
        )?;
        if self.recovery_logon_pending
            && (!self.recovery_executed
                || !self.credential_reference_verified
                || self.credential_reference.is_none()
                || self.account_removed
                || self.filters_removed)
        {
            return Err("recovery logon intent lacks frozen offline credential lifecycle".into());
        }
        if let Some(reference) = &self.credential_reference {
            let expected = shellspan_account_sandbox_prototype::credential_reference::OwnedCredentialReference::new(
                id, self.account_sid.as_deref().ok_or("credential reference lacks frozen account SID")?,
            )?;
            if reference != expected.reference() || !self.controller_workload_requested {
                return Err("credential reference differs from exact fixed SYSTEM workload".into());
            }
        } else if self.credential_reference_verified || self.credential_removed {
            return Err("credential completion lacks protected creation intent".into());
        }
        if self.controller_workload_files_retired && !self.recovery_executed {
            return Err("file retirement recovery checkpoint lacks recovery execution".into());
        }
        if !self.controller_workload_requested
            && self.controller_lifecycle != FixedLifecycle::Normal
        {
            return Err("profile lifecycle lacks fixed workload authorization".into());
        }
        if self.version != 1
            || self.backend != "account-profile-lifecycle-prototype-v1"
            || self.production != "unavailable"
            || self.fixture_id != id
            || self.account != format!("SSPA{}", &id.simple().to_string()[..12])
            || self
                .filter_keys
                .iter()
                .enumerate()
                .any(|(index, key)| key.is_nil() || self.filter_keys[..index].contains(key))
        {
            return Err("profile receipt does not identify the exact owned transaction".into());
        }
        if let Some(planned) = &self.controller_workload_planned_root {
            let expected = fixture_parent()?
                .join(format!("ShellSpan-AC-{}", id.simple()))
                .display()
                .to_string();
            if !self.controller_workload_requested
                || *planned != expected
                || self
                    .controller_workload_fixture
                    .as_ref()
                    .is_some_and(|object| object.path != expected || object.file_index == 0)
                || ((self.controller_workload_retired || self.controller_workload_files_retired)
                    && self.controller_workload_fixture.is_none())
            {
                return Err(
                    "controller workload does not match the exact frozen transaction".into(),
                );
            }
        } else if self.controller_workload_fixture.is_some()
            || self.controller_workload_retired
            || self.controller_workload_files_retired
        {
            return Err("controller workload evidence lacks creation intent".into());
        }
        Ok(())
    }
}
fn profile_key(subject: &str) -> String {
    format!(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\{subject}")
}
fn key_absent(base: HKEY, name: &str) -> Result<bool> {
    let mut key = null_mut();
    let code = unsafe { RegOpenKeyExW(base, wide(name).as_ptr(), 0, KEY_READ, &mut key) };
    if code == ERROR_FILE_NOT_FOUND {
        return Ok(true);
    }
    status(code, "inspect exact owned profile registry key")?;
    unsafe {
        RegCloseKey(key);
    }
    Ok(false)
}
fn hive_absent(subject: &str) -> Result<bool> {
    Ok(key_absent(HKEY_USERS, subject)? && key_absent(HKEY_USERS, &format!("{subject}_Classes"))?)
}
fn profile_binding(subject: &str) -> Result<Option<PathBuf>> {
    let mut raw = null_mut();
    let code = unsafe {
        RegOpenKeyExW(
            HKEY_LOCAL_MACHINE,
            wide(&profile_key(subject)).as_ptr(),
            0,
            KEY_READ,
            &mut raw,
        )
    };
    if code == ERROR_FILE_NOT_FOUND {
        return Ok(None);
    }
    status(code, "hold exact account profile binding")?;
    let key = ProfileKey(raw);
    verify_profile_key(key.0)?;
    let mut buffer = [0u16; 32768];
    let mut bytes = std::mem::size_of_val(&buffer) as u32;
    status(
        unsafe {
            RegGetValueW(
                key.0,
                null(),
                wide("ProfileImagePath").as_ptr(),
                RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ,
                null_mut(),
                buffer.as_mut_ptr().cast(),
                &mut bytes,
            )
        },
        "query exact account profile binding",
    )?;
    if bytes < 2 || bytes as usize > std::mem::size_of_val(&buffer) || !bytes.is_multiple_of(2) {
        return Err("invalid owned profile path size".into());
    }
    let length = buffer
        .iter()
        .position(|c| *c == 0)
        .ok_or("unterminated profile binding")?;
    Ok(Some(PathBuf::from(String::from_utf16_lossy(
        &buffer[..length],
    ))))
}

struct ProfileKey(HKEY);
impl Drop for ProfileKey {
    fn drop(&mut self) {
        unsafe {
            RegCloseKey(self.0);
        }
    }
}
fn verify_profile_key(key: HKEY) -> Result<()> {
    let mut sd = null_mut();
    status(
        unsafe {
            GetSecurityInfo(
                key,
                SE_REGISTRY_KEY,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                null_mut(),
                null_mut(),
                &mut sd,
            )
        },
        "inspect held profile registry security",
    )?;
    let storage = Local(sd);
    verify_profile_descriptor(storage.0)
}
fn verify_profile_descriptor(sd: *mut c_void) -> Result<()> {
    let system = sid("S-1-5-18")?;
    let administrators = sid("S-1-5-32-544")?;
    let trusted = |subject: PSID| unsafe {
        !subject.is_null()
            && (EqualSid(subject, system.0) != 0 || EqualSid(subject, administrators.0) != 0)
    };
    let mut owner = null_mut();
    let mut defaulted = 0;
    win(
        unsafe { GetSecurityDescriptorOwner(sd, &mut owner, &mut defaulted) },
        "inspect profile key owner",
    )?;
    if !trusted(owner) {
        return Err("profile registry owner is not SYSTEM/Administrators".into());
    }
    let mut dacl = null_mut();
    let mut present = 0;
    win(
        unsafe { GetSecurityDescriptorDacl(sd, &mut present, &mut dacl, &mut defaulted) },
        "inspect profile key DACL",
    )?;
    if present == 0 || dacl.is_null() {
        return Err("profile registry has an unrestricted DACL".into());
    }
    let write_mask = GENERIC_ALL
        | GENERIC_WRITE
        | WRITE_DAC
        | WRITE_OWNER
        | DELETE
        | KEY_SET_VALUE
        | KEY_CREATE_SUB_KEY
        | KEY_CREATE_LINK;
    for index in 0..unsafe { (*dacl).AceCount } as u32 {
        let mut ace = null_mut();
        win(
            unsafe { GetAce(dacl, index, &mut ace) },
            "inspect profile registry ACE",
        )?;
        let header = unsafe { &*ace.cast::<ACE_HEADER>() };
        if header.AceType != 0 {
            return Err("unsupported profile registry ACE".into());
        }
        let allowed = unsafe { &*ace.cast::<ACCESS_ALLOWED_ACE>() };
        if header.AceFlags & INHERIT_ONLY_ACE as u8 == 0
            && allowed.Mask & write_mask != 0
            && !trusted((&allowed.SidStart as *const u32).cast_mut().cast())
        {
            return Err("untrusted identity can change the profile registry binding".into());
        }
    }
    Ok(())
}
fn verify_profile_list() -> Result<()> {
    let mut raw = null_mut();
    status(
        unsafe {
            RegOpenKeyExW(
                HKEY_LOCAL_MACHINE,
                wide(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList").as_ptr(),
                0,
                KEY_READ,
                &mut raw,
            )
        },
        "hold profile registry parent",
    )?;
    let key = ProfileKey(raw);
    verify_profile_key(key.0)
}
fn profile_object(path: &Path) -> Result<ProfileObject> {
    if !path.is_absolute() || path.to_string_lossy().starts_with(r"\\") {
        return Err("owned profile is not a local absolute directory".into());
    }
    for ancestor in path.ancestors() {
        if fs::symlink_metadata(ancestor)
            .map_err(|e| e.to_string())?
            .file_attributes()
            & FILE_ATTRIBUTE_REPARSE_POINT
            != 0
        {
            return Err("owned profile ancestor is a reparse point".into());
        }
    }
    let held = Handle(unsafe {
        CreateFileW(
            wide(path.to_str().ok_or("invalid profile directory")?).as_ptr(),
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    });
    if held.0 == INVALID_HANDLE_VALUE {
        return Err("hold owned profile directory failed".into());
    }
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    win(
        unsafe { GetFileInformationByHandle(held.0, &mut info) },
        "inspect actual profile object identity",
    )?;
    if info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
        || info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
    {
        return Err("owned profile is not a regular directory".into());
    }
    Ok(ProfileObject {
        path: path.to_str().ok_or("invalid profile path")?.into(),
        volume_serial: info.dwVolumeSerialNumber,
        file_index: (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
    })
}
fn same_profile(expected: &ProfileObject, actual: &ProfileObject) -> bool {
    expected.path.eq_ignore_ascii_case(&actual.path)
        && expected.volume_serial == actual.volume_serial
        && expected.file_index == actual.file_index
}
fn validate_residual(root: &Path) -> Result<()> {
    let mut objects = vec![root.to_path_buf()];
    let mut index = 0;
    while index < objects.len() {
        let path = &objects[index];
        let held = Handle(unsafe {
            CreateFileW(
                wide(path.to_str().ok_or("invalid residual path")?).as_ptr(),
                FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                null_mut(),
            )
        });
        if held.0 == INVALID_HANDLE_VALUE {
            return Err("residual profile object identity unavailable".into());
        }
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        win(
            unsafe { GetFileInformationByHandle(held.0, &mut info) },
            "inspect owned residual object",
        )?;
        if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
            || info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0 && info.nNumberOfLinks != 1
        {
            return Err(
                "residual profile contains a reparse point or aliased file; retain debt".into(),
            );
        }
        if info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0 {
            for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
                if objects.len() >= 512 {
                    return Err("residual profile exceeds bounded recycling inventory".into());
                }
                objects.push(entry.map_err(|e| e.to_string())?.path());
            }
        }
        index += 1;
    }
    Ok(())
}
fn disabled_identity(receipt: &ProfileReceipt) -> Result<Local> {
    owned_recovery_identity(receipt, false)
}
fn owned_recovery_identity(receipt: &ProfileReceipt, pending_logon: bool) -> Result<Local> {
    let text = receipt
        .account_sid
        .as_deref()
        .ok_or("account SID was not durably frozen; refuse recovery")?;
    if account_sid(&receipt.account)? != text {
        return Err("owned account SID changed".into());
    }
    let mut raw = null_mut();
    status(
        unsafe { NetUserGetInfo(null(), wide(&receipt.account).as_ptr(), 1, &mut raw) },
        "inspect exact profile account",
    )?;
    let flags = unsafe { (*(raw as *const USER_INFO_1)).usri1_flags };
    let privilege = unsafe { (*(raw as *const USER_INFO_1)).usri1_priv };
    unsafe {
        NetApiBufferFree(raw.cast());
    }
    if (flags & UF_ACCOUNTDISABLE == 0 && !pending_logon) || privilege != USER_PRIV_USER {
        return Err("owned profile account must already be disabled and non-admin".into());
    }
    let subject = sid(text)?;
    recovery::no_account_processes(&subject)?;
    Ok(subject)
}
fn controller_profile_retirement_ready(receipt: &ProfileReceipt) -> bool {
    receipt.recovery_executed
        && receipt.controller_workload_requested
        && receipt.controller_workload_files_retired
        && receipt.controller_workload_fixture.is_some()
        && receipt.controller_workload_planned_root.is_some()
}
fn cleanup(receipt: &mut ProfileReceipt) -> Result<()> {
    if receipt.recovery_logon_pending {
        return Err("recovery logon quarantine not restored; retain account and SID block".into());
    }
    if receipt.controller_workload_planned_root.is_some()
        && !receipt.controller_workload_retired
        && !receipt.controller_workload_files_retired
    {
        return Err("owned workload retirement unconfirmed; retain account and SID block".into());
    }
    if let Some(name) = &receipt.planned_private_namespace {
        let package = receipt
            .planned_package_sid
            .as_deref()
            .ok_or("planned namespace package SID missing")?;
        if !namespace_lease::valid_name(name, package) {
            return Err("owned namespace name binding invalid; retain debt".into());
        }
        let observation = namespace_lease::wait_absent_observation(name)?;
        let absent = observation["absent"] == true && observation["error"].is_null();
        receipt.namespace_retirement_observation = Some(observation);
        receipt.save()?;
        if !absent {
            return Err("owned package namespace absence unconfirmed; retain debt".into());
        }
        receipt.private_namespace_removed = true;
    }
    let mut unreported_bootstrap_files_retired = false;
    if receipt.account_lpac_started && !receipt.account_lpac_cleanup_verified {
        if receipt.recovery_executed
            && !receipt.controller_workload_requested
            && receipt.controller_admission_report.is_none()
        {
            let observation = account_launch::inspect_recovery(receipt);
            receipt.independent_bootstrap_recovery_observation = Some(match observation {
                Ok(observation) => observation,
                Err(error) => {
                    serde_json::json!({"scope":"read-only bootstrap recovery prerequisites; not retirement authorization", "error":error})
                }
            });
            receipt.save()?;
            account_launch::retire_unreported_bootstrap_files(receipt)?;
            unreported_bootstrap_files_retired = true;
        }
        // A crashed controller workload has no child cleanup acknowledgement.
        // Its independent native file retirement permits profile lifecycle
        // cleanup; it does not itself prove package/profile retirement.
        if !unreported_bootstrap_files_retired && !controller_profile_retirement_ready(receipt) {
            return Err(
                "retain offline slot: owned LPAC profile/fixture retirement unconfirmed".into(),
            );
        }
    }
    verify_profile_list()?;
    receipt.profile_registry_security_verified = true;
    receipt.validate(receipt.fixture_id)?;
    if let Some(name) = &receipt.planned_private_station {
        if name != &format!("SSPA-{}", receipt.fixture_id.simple())
            || !bootstrap::station_absent(name)?
        {
            return Err(
                "owned private station name or absence unconfirmed; retain offline profile debt"
                    .into(),
            );
        }
        receipt.private_station_removed = true;
    }
    let text = receipt
        .account_sid
        .clone()
        .ok_or("no frozen profile account SID; retain debt")?;
    // Current SAM state, not the last persisted completion bit, decides whether
    // retirement already committed before a controller interruption.
    let mut account_info = null_mut();
    let account_status = unsafe {
        NetUserGetInfo(
            null(),
            wide(&receipt.account).as_ptr(),
            1,
            &mut account_info,
        )
    };
    if !account_info.is_null() {
        unsafe {
            NetApiBufferFree(account_info.cast());
        }
    }
    if account_status == NERR_UserNotFound {
        if !receipt.profile_removed {
            return Err("account absent before durably verified profile retirement; retain unknown-state debt".into());
        }
        receipt.account_removed = true;
    } else {
        status(
            account_status,
            "inspect current profile recovery account state",
        )?;
        if receipt.account_removed {
            return Err("persisted account retirement contradicts current SAM state".into());
        }
    }
    let subject = if receipt.account_removed {
        sid(&text)?
    } else {
        disabled_identity(receipt)?
    };
    recovery::no_account_processes(&subject)?;
    recover_trace_before_profile(receipt)?;
    if !hive_absent(&text)? {
        return Err(
            "owned account hive still loaded; no forced registry unload or profile deletion".into(),
        );
    }
    receipt.profile_unloaded = true;
    let binding = profile_binding(&text)?;
    let residual = receipt
        .profile
        .as_ref()
        .map(|profile| {
            Path::new(&profile.path)
                .try_exists()
                .map_err(|e| e.to_string())
        })
        .transpose()?
        .unwrap_or(false);
    if binding.is_some() || residual {
        if !receipt.profile_absent_before_load {
            return Err("profile preexistence was not excluded; refuse adoption".into());
        }
        let expected = receipt
            .profile
            .as_ref()
            .ok_or("profile directory identity was not frozen; retain debt")?;
        let path = binding
            .as_ref()
            .cloned()
            .unwrap_or_else(|| PathBuf::from(&expected.path));
        if !same_profile(expected, &profile_object(&path)?) {
            return Err("owned profile path or file identity changed".into());
        }
        receipt.state = "planned exact SID profile lifecycle retirement; account disabled and no account processes".into();
        receipt.save()?;
        if binding.is_some() {
            win(
                unsafe { DeleteProfileW(wide(&text).as_ptr(), null(), null()) },
                "retire only freshly created owned account profile",
            )?;
        } else {
            // The OS has already removed the SID binding. Its profile API cannot resume
            // this partial retirement. Recycle only this unchanged frozen root.
            receipt.state =
                "planned recycling of exact owned residual profile; SID binding and hive absent"
                    .into();
            receipt.save()?;
            validate_residual(&path)?;
            trash::delete(&path)
                .map_err(|e| format!("recycle exact owned residual profile: {e}"))?;
            receipt.profile_residual_recycled = true;
            receipt.save()?;
        }
    }
    let profile_path_remaining = receipt
        .profile
        .as_ref()
        .map(|profile| {
            Path::new(&profile.path)
                .try_exists()
                .map_err(|e| e.to_string())
        })
        .transpose()?
        .unwrap_or(false);
    if profile_binding(&text)?.is_some() || !hive_absent(&text)? || profile_path_remaining {
        return Err("profile lifecycle retirement absence unconfirmed".into());
    }
    receipt.profile_removed = true;
    if unreported_bootstrap_files_retired || controller_profile_retirement_ready(receipt) {
        // Entire frozen account profile, including package state, is actually absent.
        // The empty bootstrap had no additional fixture objects and its file grants
        // were independently revoked. No child acknowledgement is synthesized.
        receipt.account_lpac_cleanup_verified = true;
        receipt.save()?;
    }
    if receipt.controller_workload_files_retired {
        // The fixed private key is confined to this account's HKCU. Only actual
        // hive, ProfileList binding and frozen profile directory absence prove
        // its retirement when the original registry handle died with the service.
        receipt.controller_workload_retired = true;
    }
    if let Some(intent) = &receipt.rpc_network_intent {
        let network = engine()?;
        let key = GUID::from_u128(intent.filter_key.as_u128());
        if receipt.rpc_filter_removed {
            if unsafe {
                shellspan_account_sandbox_prototype::rpc_network_filter::inspect(
                    network.0, &key, subject.0,
                )
            }? {
                return Err("retired RPC block reappeared; retain unknown-state debt".into());
            }
        } else {
            // Earlier gates confirm no owned account processes, hive or profile.
            let package = receipt
                .package_network_intent
                .as_ref()
                .ok_or("RPC recovery package intent missing")?;
            let mut keys = receipt.filter_keys.to_vec();
            keys.extend(package.filter_keys);
            let (sd, size) = descriptor(&format!("D:(A;;CC;;;{text})"))?;
            let mut blob = FWP_BYTE_BLOB {
                size,
                data: sd.0.cast(),
            };
            unsafe {
                shellspan_account_sandbox_prototype::rpc_network_filter::change_owned(
                    network.0,
                    intent,
                    receipt.fixture_id,
                    &keys,
                    subject.0,
                    &mut blob,
                    false,
                )
            }?;
            receipt.rpc_filter_removed = true;
            receipt.state =
                "exact RPC rule absent; package and account SID protections retained".into();
            receipt.save()?;
        }
    }
    if let Some(intent) = &receipt.package_network_intent {
        let package = sid(&intent.package_sid)?;
        let network = engine()?;
        if receipt.package_filters_removed {
            for (index, key) in intent.filter_keys.iter().enumerate() {
                if unsafe {
                    shellspan_account_sandbox_prototype::package_network_filter::inspect(
                        network.0,
                        &GUID::from_u128(key.as_u128()),
                        index,
                        package.0,
                    )
                }? {
                    return Err(
                        "retired package filter reappeared; retain unknown-state debt".into(),
                    );
                }
            }
        } else {
            // All earlier OS gates have confirmed no account processes, hive,
            // profile, owned station, namespace or unretired workload.
            unsafe {
                shellspan_account_sandbox_prototype::package_network_filter::change_owned(
                    network.0,
                    intent,
                    receipt.fixture_id,
                    &receipt.filter_keys,
                    package.0,
                    false,
                )
            }?;
            receipt.package_filters_removed = true;
            receipt.state = "exact package filters absent; account SID protection retained".into();
            receipt.save()?;
        }
    }
    receipt.state = "profile absence verified; planned account retirement".into();
    receipt.save()?;
    if !receipt.account_removed {
        disabled_identity(receipt)?;
        status(
            unsafe { NetUserDel(null(), wide(&receipt.account).as_ptr()) },
            "retire exact owned profile account",
        )?;
    }
    let mut raw = null_mut();
    let account_status =
        unsafe { NetUserGetInfo(null(), wide(&receipt.account).as_ptr(), 1, &mut raw) };
    if !raw.is_null() {
        unsafe {
            NetApiBufferFree(raw.cast());
        }
    }
    if account_status != NERR_UserNotFound {
        return Err("owned account absence unconfirmed".into());
    }
    receipt.account_removed = true;
    receipt.save()?;
    if receipt.credential_reference.is_some() {
        let reference = shellspan_account_sandbox_prototype::credential_reference::OwnedCredentialReference::new(
            receipt.fixture_id, &text,
        )?;
        reference.remove()?;
        receipt.credential_removed = true;
        receipt.save()?;
    }
    let network = engine()?;
    for key in &receipt.filter_keys {
        let key = GUID::from_u128(key.as_u128());
        let mut filter = null_mut();
        let code = unsafe { FwpmFilterGetByKey0(network.0, &key, &mut filter) };
        if code == FWP_E_FILTER_NOT_FOUND as u32 {
            continue;
        }
        status(code, "inspect owned profile filter presence")?;
        let mut allocation = filter.cast();
        unsafe {
            FwpmFreeMemory0(&mut allocation);
        }
        recovery::verified_filter(&network, &key, &subject)?;
        status(
            unsafe { FwpmFilterDeleteByKey0(network.0, &key) },
            "retire exact profile SID filter",
        )?;
    }
    for key in &receipt.filter_keys {
        let mut filter = null_mut();
        let code =
            unsafe { FwpmFilterGetByKey0(network.0, &GUID::from_u128(key.as_u128()), &mut filter) };
        if !filter.is_null() {
            let mut allocation = filter.cast();
            unsafe {
                FwpmFreeMemory0(&mut allocation);
            }
        }
        if code != FWP_E_FILTER_NOT_FOUND as u32 {
            return Err("owned profile filter absence unconfirmed".into());
        }
    }
    receipt.filters_removed = true;
    receipt.cleanup_debt.clear();
    receipt.state =
        "owned Windows profile, account and persistent SID filters retired; evidence retained"
            .into();
    receipt.save()
}
fn verify_fixed_cross_slot_registry_targets() -> Result<serde_json::Value> {
    let ids = [
        "ba16502e-566b-4193-93d6-b6b34414ae68",
        "4bb6655d-3b91-4088-b7f3-7db3e7005b0b",
    ];
    let mut ownership = Vec::new();
    for (id, expected_sid) in ids
        .into_iter()
        .zip(shellspan_account_sandbox_prototype::cross_slot_registry_probe::OWNED_PEER_SIDS)
    {
        let id = Uuid::parse_str(id).map_err(|_| "fixed peer UUID invalid")?;
        let root = fixture_parent()?.join(format!("ShellSpan-account-profile-A-{id}"));
        let bytes =
            shellspan_account_sandbox_prototype::account_lpac_plan::read_protected_receipt(&root)?;
        let peer: ProfileReceipt = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        peer.validate(id)?;
        if peer.account_sid.as_deref() != Some(expected_sid)
            || peer.account_removed
            || peer.profile_removed
        {
            return Err("fixed peer ownership no longer matches a present owned slot".into());
        }
        disabled_identity(&peer)?;
        let profile = peer
            .profile
            .as_ref()
            .ok_or("fixed peer profile identity missing")?;
        let binding = profile_binding(expected_sid)?.ok_or("fixed peer profile binding missing")?;
        if !same_profile(profile, &profile_object(&binding)?) {
            return Err("fixed peer profile identity differs".into());
        }
        ownership.push(serde_json::json!({"fixture_id":id,"account_sid":expected_sid,"profile_identity_verified":true,"account_disabled":true}));
    }
    let positive =
        shellspan_account_sandbox_prototype::cross_slot_registry_probe::access_report(true)?;
    Ok(serde_json::json!({"ownership":ownership,"registry_access_positive":positive}))
}

pub(super) fn run() -> Result<()> {
    run_inner(false, None, None)
}
pub(super) fn interrupt() -> Result<()> {
    run_inner(true, None, None)
}
pub(super) fn run_lpac() -> Result<()> {
    run_inner(false, Some(account_launch::LaunchMode::FixedProbe), None)
}
pub(super) fn run_lpac_admission() -> Result<()> {
    run_inner(
        false,
        Some(account_launch::LaunchMode::SystemAdmission),
        None,
    )
}
pub(super) fn run_controller_admission() -> Result<()> {
    run_inner(
        false,
        Some(account_launch::LaunchMode::ControllerAdmission),
        None,
    )
}
pub(super) fn run_system_controller(id: Uuid) -> Result<()> {
    run_inner(
        false,
        Some(account_launch::LaunchMode::ControllerAdmission),
        Some((id, false, FixedLifecycle::Normal, None)),
    )
}
pub(super) fn run_system_workload(
    id: Uuid,
    lifecycle: FixedLifecycle,
    tool: Option<FixedSystemTool>,
) -> Result<()> {
    run_inner(
        false,
        Some(account_launch::LaunchMode::ControllerAdmission),
        Some((id, true, lifecycle, tool)),
    )
}
fn run_inner(
    interrupt_after_unload: bool,
    launch_lpac: Option<account_launch::LaunchMode>,
    fixed_system_id: Option<(Uuid, bool, FixedLifecycle, Option<FixedSystemTool>)>,
) -> Result<()> {
    if !elevated()? {
        return Err(
            "explicit elevated owned account-profile diagnostic required; no resources changed"
                .into(),
        );
    }
    let _backup = runtime_grants::RestorePrivilege::enable_named("SeBackupPrivilege")?;
    let _restore = runtime_grants::RestorePrivilege::enable_named("SeRestorePrivilege")?;
    // Refuse unsafe enterprise policy before creating any account or profile.
    verify_profile_list()?;
    let id = fixed_system_id
        .map(|(id, _, _, _)| id)
        .unwrap_or_else(Uuid::new_v4);
    let mut receipt = ProfileReceipt {
        version: 1,
        backend: "account-profile-lifecycle-prototype-v1".into(),
        production: "unavailable".into(),
        fixture_id: id,
        account: format!("SSPA{}", &id.simple().to_string()[..12]),
        account_sid: None,
        filter_keys: std::array::from_fn(|_| Uuid::new_v4()),
        package_network_intent: None,
        package_filters_removed: false,
        rpc_network_intent: None,
        rpc_filter_removed: false,
        rpc_trace_intent: None,
        rpc_trace_removed: false,
        rpc_trace_recovery_stopped: false,
        profile_absent_before_load: false,
        profile_registry_security_verified: true,
        planned_private_station: None,
        planned_package_sid: None,
        private_desktop_verified: false,
        duplicate_station_rejected: false,
        private_station_removed: false,
        profile: None,
        profile_unloaded: false,
        profile_removed: false,
        account_removed: false,
        filters_removed: false,
        non_elevated_account_token: false,
        state: "planned fresh disabled account; profile and SID filters have not been created"
            .into(),
        error: None,
        cleanup_debt: vec![],
        controller_interruption_checkpoint: false,
        recovery_executed: false,
        account_lpac_started: false,
        account_lpac_cleanup_verified: false,
        account_lpac_verified: false,
        controller_receiver_counts: None,
        account_lpac_outer_job_total: None,
        account_lpac_bootstrap_exit: None,
        account_lpac_outer_tree_stopped: false,
        independent_bootstrap_recovery_observation: None,
        independent_bootstrap_files_retired: false,
        account_lpac_diagnostic_report: None,
        profile_residual_recycled: false,
        account_lpac_admission_only: matches!(
            launch_lpac,
            Some(
                account_launch::LaunchMode::SystemAdmission
                    | account_launch::LaunchMode::ControllerAdmission
            )
        ) && !fixed_system_id
            .is_some_and(|(_, workload, _, _)| workload),
        planned_private_namespace: None,
        private_namespace_verified: false,
        private_namespace_removed: false,
        namespace_retirement_observation: None,
        controller_admission_report: None,
        controller_workload_requested: fixed_system_id.is_some_and(|(_, workload, _, _)| workload),
        controller_workload_planned_root: None,
        controller_workload_fixture: None,
        controller_workload_retired: false,
        controller_workload_files_retired: false,
        controller_lifecycle: fixed_system_id
            .map_or(FixedLifecycle::Normal, |(_, _, lifecycle, _)| lifecycle),
        controller_tool: fixed_system_id.and_then(|(_, _, _, tool)| tool),
        credential_reference: None,
        credential_reference_verified: false,
        credential_removed: false,
        profile_recovery_api_loaded: false,
        profile_recovery_api_unloaded: false,
        recovery_logon_pending: false,
    };
    protected_fixture(&receipt.root()?)?;
    receipt.save()?;
    let random = Uuid::new_v4();
    let mut password = Password(wide("aA!7"));
    password.0.pop();
    for byte in random.as_bytes() {
        password.0.push(u16::from(b'A' + byte % 26));
        password.0.push(u16::from(b'0' + byte % 10));
    }
    password.0.push(0);
    let account = Account::create(receipt.account.clone(), &mut password)?;
    let mut login: Option<Handle> = None;
    let mut hive: Option<HANDLE> = None;
    let experiment = (|| -> Result<()> {
        let text = account_sid(&account.name)?;
        receipt.account_sid = Some(text.clone());
        receipt.state =
            "fresh disabled account SID frozen; planned persistent offline filters".into();
        receipt.save()?;
        if fixed_system_id.is_some_and(|(_, workload, _, _)| workload) {
            let reference = shellspan_account_sandbox_prototype::credential_reference::OwnedCredentialReference::new(id, &text)?;
            receipt.credential_reference = Some(reference.reference().to_owned());
            receipt.state = "planned SYSTEM credential persistence for exact owned account; no secret in receipt".into();
            receipt.save()?;
            reference.store(&password.0)?;
            let recovered = reference.read()?;
            if recovered.as_utf16() != password.0 {
                return Err(
                    "owned SYSTEM credential readback differs from generated account secret".into(),
                );
            }
            receipt.credential_reference_verified = true;
            receipt.save()?;
        }
        account.join_builtin_users(&text)?;
        let network = engine()?;
        let keys = receipt.filter_keys.map(|id| GUID::from_u128(id.as_u128()));
        install_network(&network, &text, &keys)?;
        receipt.state =
            "persistent SID block installed; planned local token acquisition only".into();
        receipt.save()?;
        if !key_absent(HKEY_LOCAL_MACHINE, &profile_key(&text))? || !hive_absent(&text)? {
            return Err("fresh account unexpectedly has an existing profile; no adoption".into());
        }
        receipt.profile_absent_before_load = true;
        receipt.save()?;
        account.enabled(true)?;
        let result = account.logon(&password);
        let disabled = account.enabled(false);
        login = Some(result?);
        disabled?;
        let token = login.as_ref().ok_or("missing owned profile token")?;
        if token_sid(token.0)? != text {
            return Err("actual profile logon Token SID mismatch".into());
        }
        let mut elevation = TOKEN_ELEVATION::default();
        let mut size = 0;
        win(
            unsafe {
                GetTokenInformation(
                    token.0,
                    TokenElevation,
                    (&mut elevation as *mut TOKEN_ELEVATION).cast(),
                    std::mem::size_of_val(&elevation) as u32,
                    &mut size,
                )
            },
            "query profile account elevation",
        )?;
        receipt.non_elevated_account_token = elevation.TokenIsElevated == 0;
        if !receipt.non_elevated_account_token {
            return Err("profile account unexpectedly elevated".into());
        }
        disabled_identity(&receipt)?;
        receipt.state = "planned first profile load; absence, disabled account and exact ordinary Token verified".into();
        receipt.save()?;
        let mut username = wide(&account.name);
        let mut profile = PROFILEINFOW {
            dwSize: std::mem::size_of::<PROFILEINFOW>() as u32,
            dwFlags: 1,
            lpUserName: username.as_mut_ptr(),
            ..Default::default()
        };
        win(
            unsafe { LoadUserProfileW(token.0, &mut profile) },
            "load fresh dedicated account profile",
        )?;
        hive = Some(profile.hProfile);
        let mut path = [0u16; 32768];
        let mut count = path.len() as u32;
        win(
            unsafe { GetUserProfileDirectoryW(token.0, path.as_mut_ptr(), &mut count) },
            "query actual dedicated account profile directory",
        )?;
        let length = path
            .iter()
            .position(|c| *c == 0)
            .ok_or("unterminated profile directory")?;
        let path = PathBuf::from(String::from_utf16_lossy(&path[..length]));
        let binding = profile_binding(&text)?.ok_or("loaded profile registry binding missing")?;
        if !path
            .to_string_lossy()
            .eq_ignore_ascii_case(&binding.to_string_lossy())
        {
            return Err("profile API and exact SID registry binding disagree".into());
        }
        receipt.profile = Some(profile_object(&path)?);
        receipt.state =
            "fresh profile loaded; actual path and file identity frozen; no executable launched"
                .into();
        receipt.save()?;
        let profile_name = format!("ShellSpan-candidate-{}", id.simple());
        let mut package = null_mut();
        let derived = unsafe {
            windows_sys::Win32::Security::Isolation::DeriveAppContainerSidFromAppContainerName(
                wide(&profile_name).as_ptr(),
                &mut package,
            )
        };
        if derived < 0 {
            return Err(format!(
                "derive planned private desktop package HRESULT=0x{:08x}",
                derived as u32
            ));
        }
        struct DerivedSid(PSID);
        impl Drop for DerivedSid {
            fn drop(&mut self) {
                unsafe {
                    FreeSid(self.0);
                }
            }
        }
        let package = DerivedSid(package);
        let mut text_sid = null_mut();
        win(
            unsafe { ConvertSidToStringSidW(package.0, &mut text_sid) },
            "format planned desktop package SID",
        )?;
        let storage = Local(text_sid.cast());
        let mut length = 0;
        unsafe {
            while *text_sid.add(length) != 0 {
                length += 1;
            }
        }
        let package_text =
            unsafe { String::from_utf16_lossy(std::slice::from_raw_parts(text_sid, length)) };
        drop(storage);
        let station = format!("SSPA-{}", id.simple());
        receipt.planned_private_station = Some(station.clone());
        receipt.planned_package_sid = Some(package_text.clone());
        receipt.state =
            "planned fresh private station and desktop for exact account and future package SID"
                .into();
        receipt.save()?;
        let config = crate::runner::Config {
            version: 1,
            account_sid: text.clone(),
            restricting_sid: package_text,
            station: station.clone(),
            desktop: "probe".into(),
            tcp: [
                "127.0.0.1:1"
                    .parse()
                    .map_err(|_| "fixed diagnostic address")?,
                "[::1]:2".parse().map_err(|_| "fixed diagnostic address")?,
            ],
            udp: [
                "127.0.0.1:1"
                    .parse()
                    .map_err(|_| "fixed diagnostic address")?,
                "[::1]:2".parse().map_err(|_| "fixed diagnostic address")?,
            ],
        };
        let desktop = bootstrap::private_desktop(&config)?;
        let verified = desktop.verify(&config);
        receipt.private_desktop_verified = verified.is_ok();
        receipt.duplicate_station_rejected = bootstrap::private_desktop(&config).is_err();
        let mut namespace = None;
        if launch_lpac.is_some() && receipt.private_desktop_verified {
            let package = receipt
                .planned_package_sid
                .as_deref()
                .ok_or("planned package missing")?;
            let name = namespace_lease::name(package)?;
            receipt.planned_private_namespace = Some(name.clone());
            receipt.save()?;
            if matches!(
                launch_lpac,
                Some(account_launch::LaunchMode::ControllerAdmission)
            ) {
                if !namespace_lease::absent(&name)? {
                    return Err("controller package namespace preexists; refuse adoption".into());
                }
            } else {
                let lease = namespace_lease::create(name, &text, package)?;
                lease.verify(&text, package)?;
                receipt.private_namespace_verified = true;
                receipt.save()?;
                namespace = Some(lease);
            }
        }
        let launch = match launch_lpac {
            Some(account_launch::LaunchMode::ControllerAdmission)
                if receipt.private_desktop_verified =>
            {
                controller_admission::run(&mut receipt, token, &config)
            }
            Some(mode) if receipt.private_desktop_verified => {
                account_launch::run(&mut receipt, token, &config, mode)
            }
            _ => Ok(()),
        };
        if let Some(namespace) = namespace {
            let result = namespace.finish();
            receipt.private_namespace_removed = result.is_ok();
            result?;
        }
        let retired = desktop.finish(&station);
        receipt.private_station_removed = retired.is_ok();
        verified?;
        retired?;
        launch?;
        if !receipt.duplicate_station_rejected {
            return Err("private station adopted an existing name".into());
        }
        receipt.state = "fresh private desktop grants/nonvisibility verified; duplicate creation rejected; station absence verified".into();
        receipt.save()
    })();
    receipt.error = experiment.err();
    if let Err(error) = account.enabled(false) {
        receipt.cleanup_debt.push(error);
    }
    if let Some(hive_handle) = hive {
        let unload = disabled_identity(&receipt).and_then(|_| {
            let token = login.as_ref().ok_or("profile unload Token unavailable")?;
            win(
                unsafe { UnloadUserProfile(token.0, hive_handle) },
                "unload only owned profile lifecycle handle",
            )
        });
        if let Err(error) = unload {
            receipt.cleanup_debt.push(error);
        }
    }
    // No ordinary primary Token is retained across account/filter retirement.
    drop(login.take());
    if interrupt_after_unload && receipt.error.is_none() && receipt.cleanup_debt.is_empty() {
        let text = receipt
            .account_sid
            .as_deref()
            .ok_or("missing interruption account SID")?;
        if !hive_absent(text)? {
            return Err(
                "profile hive remains loaded; cannot inject the fixed clean-hive interruption"
                    .into(),
            );
        }
        receipt.profile_unloaded = true;
        receipt.controller_interruption_checkpoint = true;
        receipt.cleanup_debt.push(
            "fixed controller interruption pending exact profile/account/filter retirement".into(),
        );
        receipt.state = "fixed controller interruption after unload before resource retirement; exact UUID recovery required".into();
        receipt.save()?;
        println!(
            "{}",
            serde_json::to_string_pretty(&receipt).map_err(|e| e.to_string())?
        );
        std::io::stdout().flush().map_err(|e| e.to_string())?;
        unsafe {
            TerminateProcess(GetCurrentProcess(), 0xe8);
        }
        return Err("fixed controller interruption did not terminate".into());
    }
    if receipt.cleanup_debt.is_empty() {
        if let Err(error) = cleanup(&mut receipt) {
            receipt.cleanup_debt.push(error);
        }
    }
    receipt.save()?;
    if fixed_system_id.is_none() {
        println!(
            "{}",
            serde_json::to_string_pretty(&receipt).map_err(|e| e.to_string())?
        );
    }
    if receipt.error.is_some() || !receipt.cleanup_debt.is_empty() {
        return Err("owned account profile diagnostic failed; retain protected receipt and offline disabled-account debt".into());
    }
    Ok(())
}

fn restore_recovery_quarantine(receipt: &mut ProfileReceipt) -> Result<()> {
    if !receipt.recovery_logon_pending {
        return Ok(());
    }
    receipt.validate(receipt.fixture_id)?;
    system_admission::verify_workload_recovery_service(receipt.fixture_id)?;
    let subject = owned_recovery_identity(receipt, true)?;
    let network = engine()?;
    for key in receipt.filter_keys {
        recovery::verified_filter(&network, &GUID::from_u128(key.as_u128()), &subject)?;
    }
    let account = Account {
        name: receipt.account.clone(),
        created: true,
    };
    account.enabled(false)?;
    disabled_identity(receipt)?;
    receipt.recovery_logon_pending = false;
    receipt.state = "interrupted recovery logon quarantine restored; exact account disabled; SID filters retained".into();
    receipt.save()
}

fn recover_loaded_profile(receipt: &mut ProfileReceipt, subject: &Local) -> Result<()> {
    let text = receipt
        .account_sid
        .clone()
        .ok_or("missing frozen recovery SID")?;
    if !receipt.credential_reference_verified || receipt.credential_reference.is_none() {
        return Err("loaded profile recovery lacks verified SYSTEM credential reference".into());
    }
    let expected = receipt
        .profile
        .clone()
        .ok_or("profile recovery root was not frozen")?;
    let binding = profile_binding(&text)?.ok_or("loaded profile recovery binding absent")?;
    if !same_profile(&expected, &profile_object(&binding)?) {
        return Err("loaded profile recovery root or binding changed".into());
    }
    let network = engine()?;
    for key in receipt.filter_keys {
        recovery::verified_filter(&network, &GUID::from_u128(key.as_u128()), subject)?;
    }
    let reference =
        shellspan_account_sandbox_prototype::credential_reference::OwnedCredentialReference::new(
            receipt.fixture_id,
            &text,
        )?;
    let secret = reference.read()?;
    let password = Password(secret.as_utf16().to_vec());
    let account = Account {
        name: receipt.account.clone(),
        created: true,
    };
    receipt.state = "planned exact owned profile Token reacquisition; all SID filters verified; no child launch".into();
    receipt.recovery_logon_pending = true;
    receipt.save()?;
    account.enabled(true)?;
    let logged_on = account.logon(&password);
    let disabled = account.enabled(false);
    disabled?;
    disabled_identity(receipt)?;
    receipt.recovery_logon_pending = false;
    receipt.save()?;
    let token = logged_on?;
    if token_sid(token.0)? != text {
        return Err("recovered profile Token does not match frozen account".into());
    }
    let mut name = wide(&receipt.account);
    let mut info = PROFILEINFOW {
        dwSize: std::mem::size_of::<PROFILEINFOW>() as u32,
        dwFlags: 1,
        lpUserName: name.as_mut_ptr(),
        ..Default::default()
    };
    win(
        unsafe { LoadUserProfileW(token.0, &mut info) },
        "reacquire exact owned profile lifecycle handle",
    )?;
    receipt.profile_recovery_api_loaded = true;
    let identity = profile_binding(&text).and_then(|binding| {
        let binding = binding.ok_or("reacquired profile binding missing")?;
        if same_profile(&expected, &profile_object(&binding)?) {
            Ok(())
        } else {
            Err("profile API reacquisition changed frozen identity".into())
        }
    });
    let unloaded = win(
        unsafe { UnloadUserProfile(token.0, info.hProfile) },
        "unload reacquired owned profile lifecycle handle",
    );
    receipt.profile_recovery_api_unloaded = unloaded.is_ok();
    unloaded?;
    identity?;
    drop(token);
    if !hive_absent(&text)? {
        return Err(
            "owned hive remains after profile API reacquisition and unload; retain debt".into(),
        );
    }
    receipt.profile_unloaded = true;
    receipt.save()
}

fn recover_trace_before_profile(receipt: &mut ProfileReceipt) -> Result<()> {
    let Some(intent) = receipt.rpc_trace_intent.clone() else {
        return Ok(());
    };
    if !shellspan_account_sandbox_prototype::rpc_trace::session_absent(intent.fixture_id)? {
        if receipt.rpc_trace_removed || !receipt.recovery_executed {
            return Err(
                "RPC trace reappeared or recovery not authorized; retain quarantine".into(),
            );
        }
        intent.recovery_processes(receipt.fixture_id)?;
        receipt.state = "planned exact crashed RPC trace STOP before profile API; original processes stopped and account quarantined".into();
        receipt.save()?;
        let stopped =
            unsafe { shellspan_account_sandbox_prototype::rpc_trace::retire_after_crash(&intent) }?;
        receipt.rpc_trace_recovery_stopped = stopped;
    }
    receipt.rpc_trace_removed = true;
    receipt.state =
        "verified crashed RPC trace absent; profile lifecycle remains independent".into();
    receipt.save()
}

fn recover_workload_files(receipt: &mut ProfileReceipt) -> Result<()> {
    if receipt.controller_workload_planned_root.is_none() || receipt.controller_workload_retired {
        return Ok(());
    }
    receipt.validate(receipt.fixture_id)?;
    if !receipt.profile_absent_before_load || receipt.profile.is_none() {
        return Err("workload recovery lacks a freshly created frozen account profile".into());
    }
    system_admission::verify_workload_recovery_service(receipt.fixture_id)?;
    let subject = disabled_identity(receipt)?;
    recovery::no_account_processes(&subject)?;
    recover_trace_before_profile(receipt)?;
    let account_sid = receipt
        .account_sid
        .clone()
        .ok_or("missing frozen account SID")?;
    if !hive_absent(&account_sid)? {
        recover_loaded_profile(receipt, &subject)?;
    }
    let owned = receipt
        .controller_workload_fixture
        .as_ref()
        .ok_or("workload root identity not frozen; refuse recovery adoption")?;
    let package = receipt
        .planned_package_sid
        .as_deref()
        .ok_or("missing frozen workload package SID")?;
    let expected = sid(package)?;
    let mut derived = null_mut();
    let code = unsafe {
        windows_sys::Win32::Security::Isolation::DeriveAppContainerSidFromAppContainerName(
            wide(&format!(
                "ShellSpan-candidate-{}",
                receipt.fixture_id.simple()
            ))
            .as_ptr(),
            &mut derived,
        )
    };
    if code < 0 {
        return Err(format!(
            "derive recovery package HRESULT=0x{:08x}",
            code as u32
        ));
    }
    let matches = unsafe { EqualSid(derived, expected.0) != 0 };
    unsafe {
        FreeSid(derived);
    }
    if !matches {
        return Err("frozen recovery package differs from owned UUID".into());
    }
    if !same_profile(owned, &profile_object(Path::new(&owned.path))?) {
        return Err("frozen workload root was replaced; retain debt".into());
    }
    if receipt
        .controller_tool
        .is_some_and(FixedSystemTool::uses_powershell_runtime)
    {
        shellspan_account_sandbox_prototype::appcontainer_probe::Fixture::revoke_runtime_files(
            Path::new(&owned.path),
            package,
            (owned.volume_serial, owned.file_index),
        )?;
    } else {
        shellspan_account_sandbox_prototype::appcontainer_probe::Fixture::revoke_files(
            Path::new(&owned.path),
            package,
            Some((owned.volume_serial, owned.file_index)),
        )?;
    }
    receipt.controller_workload_files_retired = true;
    receipt.state =
        "owned file ACEs revoked; profile retirement still required before slot release".into();
    receipt.save()
}

fn record_recovery_failure(debt: &mut Vec<String>, state: &mut String, error: &str) {
    if !debt.iter().any(|item| item == error) {
        debt.push(error.to_owned());
    }
    *state =
        "exact UUID recovery incomplete; retain protected receipt and offline slot debt".into();
}

pub(super) fn verify_recovery_intent(id: Uuid) -> Result<()> {
    let root = fixture_parent()?.join(format!("ShellSpan-account-profile-A-{id}"));
    let bytes =
        shellspan_account_sandbox_prototype::account_lpac_plan::read_protected_receipt(&root)?;
    let receipt: ProfileReceipt = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    receipt.validate(id)
}
pub(super) fn recover(id: &str) -> Result<()> {
    if !elevated()? {
        return Err("explicit elevated exact owned profile recovery required".into());
    }
    let _backup = runtime_grants::RestorePrivilege::enable_named("SeBackupPrivilege")?;
    let _restore = runtime_grants::RestorePrivilege::enable_named("SeRestorePrivilege")?;
    let id = Uuid::parse_str(id).map_err(|_| "invalid profile fixture UUID")?;
    let root = fixture_parent()?.join(format!("ShellSpan-account-profile-A-{id}"));
    recovery::verify_evidence_acl(&root)?;
    recovery::verify_evidence_acl(&root.join("ownership.json"))?;
    let bytes =
        shellspan_account_sandbox_prototype::account_lpac_plan::read_protected_receipt(&root)?;
    let mut receipt: ProfileReceipt = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    receipt.validate(id)?;
    receipt.recovery_executed = true;
    if let Err(error) = restore_recovery_quarantine(&mut receipt)
        .and_then(|()| recover_workload_files(&mut receipt))
        .and_then(|()| cleanup(&mut receipt))
    {
        record_recovery_failure(&mut receipt.cleanup_debt, &mut receipt.state, &error);
        receipt.save().map_err(|save_error| {
            format!("{error}; recovery debt persistence failed: {save_error}")
        })?;
        return Err(error);
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&receipt).map_err(|e| e.to_string())?
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn relative_git_directory_still_fails_and_resources_are_retired() {
        let read = |suffix: &str| -> serde_json::Value {
            let text=fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../docs/design/evidence/windows-stage-a-2026-10-09-git-relative-init-system-{suffix}.json"))).unwrap();
            serde_json::from_str(text.trim_start_matches('\u{feff}')).unwrap()
        };
        let initial = read("profile");
        let tool = &initial["controller_admission_report"]["tool_admission"];
        assert_eq!(tool["actual_exit"], 1);
        assert_eq!(tool["repository_verified"], false);
        assert!(tool["stderr"]
            .as_str()
            .unwrap()
            .contains("cannot lock ref 'HEAD'"));
        let retired = read("recovered-profile");
        let receipt: ProfileReceipt = serde_json::from_value(retired.clone()).unwrap();
        receipt.validate(receipt.fixture_id).unwrap();
        assert!(receipt.cleanup_debt.is_empty());
        for key in ["account_removed", "profile_removed", "filters_removed"] {
            assert_eq!(retired[key], true);
        }
        let audit = read("os-audit");
        for key in [
            "account_absent",
            "profile_absent",
            "hive_absent",
            "services_absent",
        ] {
            assert_eq!(audit[key], true);
        }
    }

    #[test]
    fn git_ceiling_diagnostic_does_not_claim_repository_success() {
        let read = |suffix: &str| -> serde_json::Value {
            let text = fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../docs/design/evidence/windows-stage-a-2026-10-09-git-ceiling-init-system-{suffix}.json"))).unwrap();
            serde_json::from_str(text.trim_start_matches('\u{feff}')).unwrap()
        };
        let profile = read("profile");
        let tool = &profile["controller_admission_report"]["tool_admission"];
        assert_eq!(tool["actual_exit"], 1);
        assert_eq!(tool["repository_verified"], false);
        assert!(tool["stderr"]
            .as_str()
            .unwrap()
            .contains("cannot lock ref 'HEAD'"));
        let retired = read("recovered-profile");
        let receipt: ProfileReceipt = serde_json::from_value(retired.clone()).unwrap();
        receipt.validate(receipt.fixture_id).unwrap();
        assert!(receipt.cleanup_debt.is_empty());
        for key in ["profile_removed", "account_removed", "filters_removed"] {
            assert_eq!(retired[key], true);
        }
        let audit = read("os-audit");
        for key in [
            "account_absent",
            "profile_absent",
            "hive_absent",
            "services_absent",
        ] {
            assert_eq!(audit[key], true);
        }
    }

    #[test]
    fn three_crashed_slots_have_explicit_post_reboot_os_absence_evidence() {
        let bytes = fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/design/evidence/windows-stage-a-2026-10-09-post-reboot-explicit-os-audit.json")).unwrap();
        let rows: Vec<serde_json::Value> =
            serde_json::from_str(bytes.trim_start_matches('\u{feff}')).unwrap();
        assert_eq!(rows.len(), 3);
        for id in [
            "ba16502e-566b-4193-93d6-b6b34414ae68",
            "4bb6655d-3b91-4088-b7f3-7db3e7005b0b",
            "da9f4011-394d-4a24-8d8d-c63acecce63b",
        ] {
            let matching: Vec<_> = rows.iter().filter(|row| row["fixture_id"] == id).collect();
            assert_eq!(matching.len(), 1);
            for key in [
                "account_absent",
                "profile_absent",
                "hive_absent",
                "original_service_absent",
                "recorded_retirement",
                "retirement_consistent_with_os",
            ] {
                assert_eq!(matching[0][key], true, "{id}: {key}");
            }
        }
    }

    #[test]
    fn crashed_workload_requires_independent_file_retirement_before_profile_cleanup() {
        let text = fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/design/evidence/windows-stage-a-2026-10-09-rpc-trace-crash-independent-recovery-after.json")).unwrap();
        let mut receipt: ProfileReceipt =
            serde_json::from_str(text.trim_start_matches('\u{feff}')).unwrap();
        assert!(!controller_profile_retirement_ready(&receipt));
        receipt.controller_workload_files_retired = true;
        assert!(controller_profile_retirement_ready(&receipt));
        receipt.recovery_executed = false;
        assert!(!controller_profile_retirement_ready(&receipt));
        receipt.recovery_executed = true;
        receipt.controller_workload_fixture = None;
        assert!(!controller_profile_retirement_ready(&receipt));
    }

    #[test]
    fn actual_no_internet_instrumented_dns_remains_unknown_despite_empty_trace() {
        let read = |suffix: &str| -> serde_json::Value {
            let text = fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../docs/design/evidence/windows-stage-a-2026-10-09-dns-rpc-instrumentation-default-system-{suffix}.json"))).unwrap();
            serde_json::from_str(text.trim_start_matches('\u{feff}')).unwrap()
        };
        let initial = read("profile");
        let receipt: ProfileReceipt = serde_json::from_value(initial.clone()).unwrap();
        receipt.validate(receipt.fixture_id).unwrap();
        assert_eq!(
            receipt.controller_tool,
            Some(FixedSystemTool::DnsRpcInstrumentationDefaultProbe)
        );
        let report = &initial["controller_admission_report"];
        assert!(report["diagnostic_internet_client"].is_null());
        for key in [
            "actual_user_verified",
            "actual_package_verified",
            "actual_capabilities_verified",
            "actual_low_integrity",
            "actual_lpac",
            "execution_topology_verified",
            "rpc_block_verified_before_resume",
            "rpc_trace_started_before_resume",
        ] {
            assert_eq!(report[key], true, "{key}");
        }
        let trace = &report["rpc_client_trace"]["Ok"];
        assert!(trace["events"].as_array().unwrap().is_empty());
        for key in ["session_absent", "session_stopped", "consumer_closed"] {
            assert_eq!(trace[key], true, "{key}");
        }
        assert_eq!(trace["events_lost"], 0);
        let checks = report["workload_report"]["checks"].as_array().unwrap();
        for name in [
            "DNS UDP API denied",
            "DNS TCP API denied",
            "descendant network: DNS UDP API denied",
            "descendant network: DNS TCP API denied",
        ] {
            let check = checks.iter().find(|check| check["name"] == name).unwrap();
            assert_eq!(
                check["passed"], false,
                "unknown DNS error must not become denial"
            );
            let detail: serde_json::Value =
                serde_json::from_str(check["detail"].as_str().unwrap()).unwrap();
            assert_eq!(detail["completion_status"], 87);
        }
        for name in ["DNS UDP receiver no traffic", "DNS TCP receiver no traffic"] {
            assert_eq!(
                checks.iter().find(|check| check["name"] == name).unwrap()["passed"],
                true
            );
        }
        let check = checks
            .iter()
            .find(|check| check["name"] == "fixed local RPC client binding created and released")
            .unwrap();
        let detail: serde_json::Value =
            serde_json::from_str(check["detail"].as_str().unwrap()).unwrap();
        assert_eq!(detail["rpc_provider_registration"]["register_code"], 0);
        assert_eq!(detail["rpc_provider_registration"]["unregister_code"], 0);
        let retired = read("recovered-profile");
        let receipt: ProfileReceipt = serde_json::from_value(retired.clone()).unwrap();
        receipt.validate(receipt.fixture_id).unwrap();
        assert!(receipt.cleanup_debt.is_empty());
        for key in [
            "rpc_trace_removed",
            "rpc_filter_removed",
            "package_filters_removed",
            "filters_removed",
            "profile_removed",
            "account_removed",
        ] {
            assert_eq!(retired[key], true, "{key}");
        }
        let audit = read("os-audit");
        for key in [
            "account_absent",
            "profile_absent",
            "hive_absent",
            "services_absent",
        ] {
            assert_eq!(audit[key], true, "{key}");
        }
    }
    #[test]
    fn actual_instrumented_lpac_trace_delivers_lrpc_calls_but_dns_bypass_still_fails() {
        let read = |suffix: &str| -> serde_json::Value {
            let text=fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../docs/design/evidence/windows-stage-a-2026-10-09-dns-rpc-instrumentation-internet-system-{suffix}.json"))).unwrap();
            serde_json::from_str(text.trim_start_matches('\u{feff}')).unwrap()
        };
        let initial = read("profile");
        let report = &initial["controller_admission_report"];
        for key in [
            "actual_user_verified",
            "actual_package_verified",
            "actual_capabilities_verified",
            "actual_low_integrity",
            "actual_lpac",
            "execution_topology_verified",
            "rpc_block_verified_before_resume",
            "rpc_trace_started_before_resume",
        ] {
            assert_eq!(report[key], true, "{key}");
        }
        let trace = &report["rpc_client_trace"]["Ok"];
        let events = trace["events"].as_array().unwrap();
        assert_eq!(events.len(), 16);
        for pair in events.chunks_exact(2) {
            assert_eq!(pair[0]["event_id"], 5);
            assert_eq!(pair[1]["event_id"], 7);
            assert_eq!(pair[0]["activity_id"], pair[1]["activity_id"]);
            assert_eq!(
                pair[0]["interface_id"],
                "45776b01-5956-4485-9f80-f428f7d60129"
            );
            assert_eq!(pair[0]["operation"], 4);
            assert_eq!(
                pair[0]["protocol"],
                windows_sys::Win32::System::Rpc::RPC_PROTSEQ_LRPC
            );
            assert_eq!(pair[1]["status"], 0);
            for event in pair {
                assert_eq!(event["process_id"], trace["process_id"]);
            }
        }
        assert_eq!(trace["events_lost"], 0);
        assert_eq!(trace["session_absent"], true);
        let checks = report["workload_report"]["checks"].as_array().unwrap();
        let check = checks
            .iter()
            .find(|check| check["name"] == "fixed local RPC client binding created and released")
            .unwrap();
        let detail: serde_json::Value =
            serde_json::from_str(check["detail"].as_str().unwrap()).unwrap();
        assert_eq!(detail["rpc_provider_registration"]["register_code"], 0);
        assert_eq!(detail["rpc_provider_registration"]["unregister_code"], 0);
        for name in [
            "DNS UDP API denied",
            "DNS TCP API denied",
            "DNS UDP receiver no traffic",
            "DNS TCP receiver no traffic",
        ] {
            assert_eq!(
                checks.iter().find(|check| check["name"] == name).unwrap()["passed"],
                false,
                "{name}"
            );
        }
        let retired = read("recovered-profile");
        let receipt: ProfileReceipt = serde_json::from_value(retired.clone()).unwrap();
        receipt.validate(receipt.fixture_id).unwrap();
        for key in [
            "rpc_trace_removed",
            "rpc_filter_removed",
            "package_filters_removed",
            "filters_removed",
            "profile_removed",
            "account_removed",
        ] {
            assert_eq!(retired[key], true, "{key}");
        }
        assert!(receipt.cleanup_debt.is_empty());
        let audit = read("os-audit");
        for key in [
            "account_absent",
            "profile_absent",
            "hive_absent",
            "services_absent",
        ] {
            assert_eq!(audit[key], true, "{key}");
        }
    }
    #[test]
    fn actual_service_crash_retires_trace_without_claiming_loaded_hive_cleanup() {
        let read = |prefix: &str, suffix: &str| -> serde_json::Value {
            let text = fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join(format!(
                "../../docs/design/evidence/windows-stage-a-2026-10-09-{prefix}-{suffix}.json"
            )))
            .unwrap();
            serde_json::from_str(text.trim_start_matches('\u{feff}')).unwrap()
        };
        let initial = read("rpc-trace-service-crash-stop-hybrid-system", "profile");
        let original: ProfileReceipt = serde_json::from_value(initial.clone()).unwrap();
        original.validate(original.fixture_id).unwrap();
        let report = &initial["controller_admission_report"];
        for key in [
            "service_crash_checkpoint",
            "rpc_trace_started_before_resume",
            "execution_topology_verified",
            "actual_user_verified",
            "actual_package_verified",
            "actual_lpac",
        ] {
            assert_eq!(report[key], true, "{key}");
        }
        assert_eq!(report["active_processes_at_trigger"], 4);
        assert!(!original.rpc_trace_removed);
        let after = read("rpc-trace-crash-independent-recovery", "after");
        let recovered: ProfileReceipt = serde_json::from_value(after.clone()).unwrap();
        recovered.validate(recovered.fixture_id).unwrap();
        assert!(
            recovered.recovery_executed
                && recovered.rpc_trace_recovery_stopped
                && recovered.rpc_trace_removed
        );
        assert_eq!(after["rpc_trace_intent"], initial["rpc_trace_intent"]);
        assert!(
            !recovered.account_removed && !recovered.profile_removed && !recovered.filters_removed
        );
        assert!(recovered
            .cleanup_debt
            .iter()
            .any(|debt| debt.contains("hive remains")));
        let audit = read("rpc-trace-crash-independent-recovery", "os-audit");
        assert_eq!(audit["hive_present"], true);
        assert_eq!(audit["accounts"][0]["Disabled"], true);
        assert_eq!(audit["profiles"][0]["Loaded"], true);
        for field in ["rpc_trace_removed", "recovery_executed"] {
            let mut premature = after.clone();
            premature[field] = serde_json::json!(false);
            let receipt: ProfileReceipt = serde_json::from_value(premature).unwrap();
            assert!(receipt.validate(receipt.fixture_id).is_err(), "{field}");
        }
    }
    #[test]
    fn actual_validated_journal_preserves_node_execution_and_exact_retirement() {
        let read = |suffix: &str| -> serde_json::Value {
            serde_json::from_slice(&fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../docs/design/evidence/windows-stage-a-2026-10-09-node-validated-journal-system-{suffix}.json"))).unwrap()).unwrap()
        };
        let original = read("profile");
        let retired = read("recovered-profile");
        let audit = read("os-audit");
        for value in [&original, &retired] {
            let receipt: ProfileReceipt = serde_json::from_value(value.clone()).unwrap();
            receipt.validate(receipt.fixture_id).unwrap();
            let report = receipt.controller_admission_report.as_ref().unwrap();
            assert_eq!(report["tool_admission"]["actual_exit"], 73);
            assert_eq!(report["actual_user_sid"], value["account_sid"]);
            assert_eq!(report["execution_topology_verified"], true);
            assert_eq!(report["process_tree_stopped"], true);
            assert!(report["error"].is_null());
        }
        assert_eq!(original["fixture_id"], retired["fixture_id"]);
        assert_eq!(original["account_sid"], retired["account_sid"]);
        assert_eq!(retired["fixture_id"], audit["fixture_id"]);
        for key in [
            "account_removed",
            "profile_removed",
            "filters_removed",
            "credential_removed",
        ] {
            assert_eq!(retired[key], true, "{key}");
        }
        assert_eq!(retired["cleanup_debt"], serde_json::json!([]));
        for key in [
            "account_absent",
            "profile_absent",
            "hive_absent",
            "services_absent",
        ] {
            assert_eq!(audit[key], true, "OS {key}");
        }
    }
    #[test]
    fn invalid_profile_checkpoint_is_rejected_before_journal_publication() {
        let evidence = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/design/evidence/windows-stage-a-2026-10-09-bootstrap-terminal-exit-recovered-profile.json"));
        let mut receipt: ProfileReceipt = serde_json::from_str(evidence).unwrap();
        receipt.fixture_id = Uuid::new_v4();
        receipt.account = format!("SSPA{}", &receipt.fixture_id.simple().to_string()[..12]);
        receipt.recovery_executed = false;
        let root = receipt.root().unwrap();
        assert!(!root.try_exists().unwrap());
        let error = receipt.save().unwrap_err();
        assert!(
            error.contains("empty-bootstrap checkpoint lacks"),
            "{error}"
        );
        assert!(!root.try_exists().unwrap());
    }
    #[test]
    fn empty_bootstrap_checkpoint_requires_matching_recovery_lifecycle() {
        let evidence: serde_json::Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/design/evidence/windows-stage-a-2026-10-09-bootstrap-terminal-exit-recovered-profile.json"))).unwrap();
        let receipt: ProfileReceipt = serde_json::from_value(evidence.clone()).unwrap();
        assert!(receipt.independent_bootstrap_files_retired);
        receipt.validate(receipt.fixture_id).unwrap();
        for (key, value) in [
            ("recovery_executed", serde_json::json!(false)),
            ("account_lpac_started", serde_json::json!(false)),
            ("controller_workload_requested", serde_json::json!(true)),
            ("account_lpac_diagnostic_report", serde_json::json!({})),
            ("profile_absent_before_load", serde_json::json!(false)),
            ("profile", serde_json::Value::Null),
            ("private_namespace_removed", serde_json::json!(false)),
            ("planned_private_namespace", serde_json::Value::Null),
            ("planned_package_sid", serde_json::Value::Null),
            ("private_station_removed", serde_json::json!(false)),
        ] {
            let mut changed = evidence.clone();
            changed[key] = value;
            let receipt: ProfileReceipt = serde_json::from_value(changed).unwrap();
            assert!(receipt.validate(receipt.fixture_id).is_err(), "{key}");
        }
        let mut nil = evidence;
        nil["fixture_id"] = serde_json::json!(Uuid::nil());
        nil["account"] = "SSPA000000000000".into();
        let receipt: ProfileReceipt = serde_json::from_value(nil).unwrap();
        assert!(receipt.validate(Uuid::nil()).is_err());
    }
    #[test]
    fn file_retirement_checkpoint_requires_owned_root_and_recovery_execution() {
        let id = Uuid::new_v4();
        let root = fixture_parent()
            .unwrap()
            .join(format!("ShellSpan-AC-{}", id.simple()));
        let mut value = serde_json::json!({
            "version": 1, "backend": "account-profile-lifecycle-prototype-v1",
            "production": "unavailable", "fixture_id": id,
            "account": format!("SSPA{}", &id.simple().to_string()[..12]),
            "account_sid": null,
            "filter_keys": [Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4()],
            "profile_absent_before_load": true, "profile": null,
            "profile_unloaded": false, "profile_removed": false,
            "account_removed": false, "filters_removed": false,
            "non_elevated_account_token": false, "state": "fixed test", "error": null,
            "cleanup_debt": [], "controller_workload_requested": true,
            "controller_workload_planned_root": root.to_string_lossy(),
            "controller_workload_files_retired": true
        });
        let read = |value: &serde_json::Value| {
            serde_json::from_value::<ProfileReceipt>(value.clone()).unwrap()
        };
        let mut recovery = read(&value);
        recovery.account_sid = Some("S-1-5-21-1-2-3-1001".into());
        let before = serde_json::to_value(&recovery).unwrap();
        let subject = sid("S-1-5-21-1-2-3-1001").unwrap();
        assert!(recover_loaded_profile(&mut recovery, &subject)
            .unwrap_err()
            .contains("verified SYSTEM credential reference"));
        assert_eq!(serde_json::to_value(&recovery).unwrap(), before);
        assert!(read(&value).validate(id).is_err());
        value["recovery_executed"] = true.into();
        assert!(read(&value).validate(id).is_err());
        value["controller_workload_fixture"] = serde_json::json!({
            "path": root.to_string_lossy(), "volume_serial": 1, "file_index": 2
        });
        assert!(read(&value).validate(id).is_ok());
        let mut pending = read(&value);
        pending.account_sid = Some("S-1-5-21-1-2-3-1001".into());
        pending.credential_reference = Some(
            shellspan_account_sandbox_prototype::credential_reference::OwnedCredentialReference::new(
                id, pending.account_sid.as_deref().unwrap(),
            ).ok().unwrap().reference().to_owned(),
        );
        pending.credential_reference_verified = true;
        pending.recovery_logon_pending = true;
        assert!(pending.validate(id).is_ok());
        let before = serde_json::to_value(&pending).unwrap();
        assert!(cleanup(&mut pending)
            .unwrap_err()
            .contains("quarantine not restored"));
        assert_eq!(serde_json::to_value(&pending).unwrap(), before);
        pending.account_removed = true;
        assert!(pending.validate(id).is_err());
        pending.account_removed = false;
        pending.filters_removed = true;
        assert!(pending.validate(id).is_err());
        pending.filters_removed = false;
        pending.credential_reference_verified = false;
        assert!(pending.validate(id).is_err());
        value["controller_workload_fixture"]["file_index"] = 0.into();
        assert!(read(&value).validate(id).is_err());
    }
    #[test]
    fn repeated_failed_recovery_preserves_existing_debt_without_duplicates() {
        let mut debt = vec!["owned workload retirement unconfirmed".to_owned()];
        let mut state = "previous recovery checkpoint".to_owned();
        record_recovery_failure(&mut debt, &mut state, "owned profile hive still loaded");
        record_recovery_failure(&mut debt, &mut state, "owned profile hive still loaded");
        assert_eq!(debt.len(), 2);
        assert_eq!(debt[0], "owned workload retirement unconfirmed");
        assert_eq!(debt[1], "owned profile hive still loaded");
        assert!(state.contains("recovery incomplete"));
        assert!(state.contains("offline slot debt"));
    }
    #[test]
    fn residual_inventory_rejects_hardlink_aliases() {
        let root = std::env::temp_dir().join(format!("ShellSpan-residual-test-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let file = root.join("owned.txt");
        fs::write(&file, b"fixed regression fixture").unwrap();
        assert!(validate_residual(&root).is_ok());
        let alias = root.join("alias.txt");
        fs::hard_link(&file, &alias).unwrap();
        assert!(validate_residual(&root).unwrap_err().contains("aliased"));
        trash::delete(&root).unwrap();
    }
    #[test]
    fn registry_descriptor_rejects_binding_writers_and_accepts_read_notify() {
        let verify = |sddl: &str| {
            let mut raw = null_mut();
            win(
                unsafe {
                    ConvertStringSecurityDescriptorToSecurityDescriptorW(
                        wide(sddl).as_ptr(),
                        1,
                        &mut raw,
                        null_mut(),
                    )
                },
                "parse test registry descriptor",
            )
            .unwrap();
            let storage = Local(raw);
            verify_profile_descriptor(storage.0)
        };
        // KEY_READ includes KEY_NOTIFY (0x10); file write masks would reject this incorrectly.
        assert!(verify("O:BAG:BAD:P(A;;KA;;;SY)(A;;KA;;;BA)(A;;KR;;;BU)").is_ok());
        for mask in [
            KEY_SET_VALUE,
            KEY_CREATE_SUB_KEY,
            KEY_CREATE_LINK,
            WRITE_DAC,
            WRITE_OWNER,
            DELETE,
            GENERIC_WRITE,
            GENERIC_ALL,
        ] {
            assert!(
                verify(&format!(
                    "O:BAG:BAD:P(A;;KA;;;SY)(A;;KA;;;BA)(A;;0x{mask:x};;;BU)"
                ))
                .is_err(),
                "untrusted registry mutation mask {mask:x}"
            );
        }
        assert!(verify("O:BUG:BAD:P(A;;KA;;;SY)(A;;KA;;;BA)").is_err());
        assert!(verify("O:BAG:BAD:NO_ACCESS_CONTROL").is_err());
    }
    #[test]
    fn profile_replacement_and_path_change_never_match_owned_identity() {
        let owned = ProfileObject {
            path: r"C:\Users\SSPAowned".into(),
            volume_serial: 1,
            file_index: 2,
        };
        let mut changed = owned.clone();
        changed.file_index += 1;
        assert!(!same_profile(&owned, &changed));
        let mut changed = owned.clone();
        changed.volume_serial += 1;
        assert!(!same_profile(&owned, &changed));
        let mut changed = owned.clone();
        changed.path = r"C:\Users\unowned".into();
        assert!(!same_profile(&owned, &changed));
        assert!(same_profile(&owned, &owned));
    }
    #[test]
    fn package_network_journal_requires_identity_and_retirement_before_account_release() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/design/evidence/windows-stage-a-2026-10-09-node-validated-journal-system-recovered-profile.json");
        let text = std::fs::read_to_string(path).unwrap();
        let baseline: serde_json::Value =
            serde_json::from_str(text.trim_start_matches('\u{feff}')).unwrap();
        let mut value = baseline.clone();
        value["package_filters_removed"] = serde_json::json!(true);
        let receipt: ProfileReceipt = serde_json::from_value(value).unwrap();
        assert!(receipt.validate(receipt.fixture_id).is_err());
        let mut value = baseline.clone();
        value["package_network_intent"] = serde_json::json!({
            "version": 1, "fixture_id": baseline["fixture_id"],
            "package_sid": baseline["planned_package_sid"],
            "filter_keys": std::array::from_fn::<_, 4, _>(|_| Uuid::new_v4()),
        });
        let receipt: ProfileReceipt = serde_json::from_value(value.clone()).unwrap();
        assert!(receipt.validate(receipt.fixture_id).is_err());
        value["account_removed"] = serde_json::json!(false);
        value["filters_removed"] = serde_json::json!(false);
        let receipt: ProfileReceipt = serde_json::from_value(value.clone()).unwrap();
        receipt.validate(receipt.fixture_id).unwrap();

        assert!(!receipt.account_removed && !receipt.filters_removed);
        value["planned_package_sid"] = serde_json::Value::Null;
        let receipt: ProfileReceipt = serde_json::from_value(value).unwrap();
        assert!(receipt.validate(receipt.fixture_id).is_err());
    }
    #[test]
    fn actual_package_block_installation_and_retirement_bind_protected_intent() {
        let load = |suffix: &str| -> serde_json::Value {
            let path = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../docs/design/evidence")
                .join(format!(
                    "windows-stage-a-2026-10-09-node-package-block-indexed-system-{suffix}.json"
                ));
            let text = std::fs::read_to_string(path).unwrap();
            serde_json::from_str(text.trim_start_matches('\u{feff}')).unwrap()
        };
        let initial = load("profile");
        let receipt: ProfileReceipt = serde_json::from_value(initial.clone()).unwrap();
        receipt.validate(receipt.fixture_id).unwrap();
        assert_eq!(
            receipt.controller_tool,
            Some(FixedSystemTool::NodePackageBlock)
        );
        assert!(receipt.package_network_intent.is_some());
        let report = &initial["controller_admission_report"];
        assert_eq!(report["package_blocks_verified_before_resume"], true);
        assert_eq!(report["tool_admission"]["actual_exit"], 73);
        for key in [
            "actual_lpac",
            "actual_low_integrity",
            "actual_user_verified",
            "actual_package_verified",
            "actual_capabilities_verified",
            "execution_topology_verified",
            "process_tree_stopped",
        ] {
            assert_eq!(report[key], true, "{key}");
        }
        let recovered = load("recovered-profile");
        let receipt: ProfileReceipt = serde_json::from_value(recovered.clone()).unwrap();
        receipt.validate(receipt.fixture_id).unwrap();
        assert_eq!(
            recovered["package_network_intent"],
            initial["package_network_intent"]
        );
        assert_eq!(recovered["account_sid"], initial["account_sid"]);
        assert!(
            receipt.package_filters_removed
                && receipt.filters_removed
                && receipt.account_removed
                && receipt.profile_removed
        );
        assert!(receipt.cleanup_debt.is_empty());
        let audit = load("os-audit");
        assert_eq!(audit["fixture_id"], initial["fixture_id"]);
        for key in [
            "account_absent",
            "profile_absent",
            "hive_absent",
            "services_absent",
        ] {
            assert_eq!(audit[key], true, "{key}");
        }
    }
    #[test]
    fn actual_dns_package_matrix_retains_unknown_failure_and_cleans_owned_rules() {
        let load = |suffix: &str| -> serde_json::Value {
            let path = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../docs/design/evidence")
                .join(format!(
                    "windows-stage-a-2026-10-09-dns-package-block-matrix-system-{suffix}.json"
                ));
            let text = std::fs::read_to_string(path).unwrap();
            serde_json::from_str(text.trim_start_matches('\u{feff}')).unwrap()
        };
        let initial = load("profile");
        let receipt: ProfileReceipt = serde_json::from_value(initial.clone()).unwrap();
        receipt.validate(receipt.fixture_id).unwrap();
        assert_eq!(
            receipt.controller_tool,
            Some(FixedSystemTool::DnsPackageBlockProbe)
        );
        let report = &initial["controller_admission_report"];
        assert_eq!(report["package_blocks_verified_before_resume"], true);
        assert_eq!(report["workload_checks_passed"], false);
        assert!(!report["error"].is_null());
        let checks = report["workload_report"]["checks"].as_array().unwrap();
        assert!(checks.len() >= 156);
        for prefix in ["", "descendant network: "] {
            for transport in ["UDP", "TCP"] {
                let name = format!("{prefix}DNS {transport} API denied");
                let found: Vec<_> = checks
                    .iter()
                    .filter(|check| check["name"] == name)
                    .collect();
                assert_eq!(found.len(), 1);
                assert_eq!(found[0]["passed"], false);
                let detail: serde_json::Value =
                    serde_json::from_str(found[0]["detail"].as_str().unwrap()).unwrap();
                assert_eq!(detail["dispatch_status"], 87);
                assert_eq!(detail["completion_status"], 87);
            }
        }
        let recovered = load("recovered-profile");
        let receipt: ProfileReceipt = serde_json::from_value(recovered.clone()).unwrap();
        receipt.validate(receipt.fixture_id).unwrap();
        assert_eq!(
            recovered["package_network_intent"],
            initial["package_network_intent"]
        );
        assert!(
            receipt.package_filters_removed
                && receipt.filters_removed
                && receipt.account_removed
                && receipt.profile_removed
        );
        assert!(receipt.cleanup_debt.is_empty());
        let audit = load("os-audit");
        assert_eq!(audit["fixture_id"], initial["fixture_id"]);
        for key in [
            "account_absent",
            "profile_absent",
            "hive_absent",
            "services_absent",
        ] {
            assert_eq!(audit[key], true, "{key}");
        }
    }
    #[test]
    fn actual_dns_package_internet_bypass_is_not_counted_as_network_denial() {
        let load = |suffix: &str| -> serde_json::Value {
            let path = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../docs/design/evidence")
                .join(format!(
                    "windows-stage-a-2026-10-09-dns-package-block-internet-system-{suffix}.json"
                ));
            let text = std::fs::read_to_string(path).unwrap();
            serde_json::from_str(text.trim_start_matches('\u{feff}')).unwrap()
        };
        let initial = load("profile");
        let receipt: ProfileReceipt = serde_json::from_value(initial.clone()).unwrap();
        receipt.validate(receipt.fixture_id).unwrap();
        assert_eq!(
            receipt.controller_tool,
            Some(FixedSystemTool::DnsPackageBlockInternetProbe)
        );
        let report = &initial["controller_admission_report"];
        assert_eq!(report["package_blocks_verified_before_resume"], true);
        assert_eq!(report["workload_checks_passed"], false);
        assert!(!report["error"].is_null());
        let checks = report["workload_report"]["checks"].as_array().unwrap();
        assert!(checks.len() >= 156);
        for prefix in ["", "descendant network: "] {
            for transport in ["UDP", "TCP"] {
                let name = format!("{prefix}DNS {transport} API denied");
                let found: Vec<_> = checks
                    .iter()
                    .filter(|check| check["name"] == name)
                    .collect();
                assert_eq!(found.len(), 1);
                assert_eq!(found[0]["passed"], false);
                let detail: serde_json::Value =
                    serde_json::from_str(found[0]["detail"].as_str().unwrap()).unwrap();
                assert_eq!(detail["dispatch_status"], 9506);
                assert_eq!(detail["completion_status"], 0);
                assert_eq!(detail["records_returned"], true);
                assert_eq!(detail["fixed_answer"], true);
            }
        }
        assert_eq!(report["diagnostic_internet_client"], true);
        for transport in ["UDP", "TCP"] {
            let name = format!("DNS {transport} receiver no traffic");
            let found: Vec<_> = checks
                .iter()
                .filter(|check| check["name"] == name)
                .collect();
            assert_eq!(found.len(), 1);
            assert_eq!(found[0]["passed"], false);
            assert!(found[0]["detail"]
                .as_str()
                .unwrap()
                .contains("controls verified; received=2"));
        }
        let recovered = load("recovered-profile");
        let receipt: ProfileReceipt = serde_json::from_value(recovered.clone()).unwrap();
        receipt.validate(receipt.fixture_id).unwrap();
        assert_eq!(
            recovered["package_network_intent"],
            initial["package_network_intent"]
        );
        assert!(
            receipt.package_filters_removed
                && receipt.filters_removed
                && receipt.account_removed
                && receipt.profile_removed
        );
        assert!(receipt.cleanup_debt.is_empty());
        let audit = load("os-audit");
        assert_eq!(audit["fixture_id"], initial["fixture_id"]);
        for key in [
            "account_absent",
            "profile_absent",
            "hive_absent",
            "services_absent",
        ] {
            assert_eq!(audit[key], true, "{key}");
        }
    }
    #[test]
    fn rpc_receipt_cannot_release_protection_before_owned_rule_retirement() {
        let path=Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/design/evidence/windows-stage-a-2026-10-09-node-package-block-indexed-system-recovered-profile.json");
        let text = std::fs::read_to_string(path).unwrap();
        let mut value: serde_json::Value =
            serde_json::from_str(text.trim_start_matches('\u{feff}')).unwrap();
        value["rpc_network_intent"] = serde_json::json!({"version":1,"fixture_id":value["fixture_id"],"account_sid":value["account_sid"],"filter_key":Uuid::new_v4()});
        let receipt: ProfileReceipt = serde_json::from_value(value.clone()).unwrap();
        assert!(receipt.validate(receipt.fixture_id).is_err());
        for field in [
            "account_removed",
            "filters_removed",
            "package_filters_removed",
        ] {
            value[field] = serde_json::json!(false);
        }
        let receipt: ProfileReceipt = serde_json::from_value(value.clone()).unwrap();
        receipt.validate(receipt.fixture_id).unwrap();
        assert!(
            !receipt.account_removed
                && !receipt.filters_removed
                && !receipt.package_filters_removed
        );
        for field in [
            "account_removed",
            "filters_removed",
            "package_filters_removed",
        ] {
            let mut released = value.clone();
            released[field] = serde_json::json!(true);
            let receipt: ProfileReceipt = serde_json::from_value(released).unwrap();
            assert!(receipt.validate(receipt.fixture_id).is_err(), "{field}");
        }
        let mut retired = value.clone();
        retired["rpc_filter_removed"] = serde_json::json!(true);
        let receipt: ProfileReceipt = serde_json::from_value(retired.clone()).unwrap();
        receipt.validate(receipt.fixture_id).unwrap();
        retired["rpc_network_intent"] = serde_json::Value::Null;
        let receipt: ProfileReceipt = serde_json::from_value(retired).unwrap();
        assert!(receipt.validate(receipt.fixture_id).is_err());
        value["rpc_network_intent"]["account_sid"] = serde_json::json!("S-1-5-18");
        let receipt: ProfileReceipt = serde_json::from_value(value).unwrap();
        assert!(receipt.validate(receipt.fixture_id).is_err());
    }
    #[test]
    fn trace_receipt_cannot_release_profile_or_rules_before_session_absence() {
        let text = include_str!("../../../../docs/design/evidence/windows-stage-a-2026-10-09-node-package-block-indexed-system-recovered-profile.json");
        let mut value: serde_json::Value =
            serde_json::from_str(text.trim_start_matches('\u{feff}')).unwrap();
        let fixture = Uuid::parse_str(value["fixture_id"].as_str().unwrap()).unwrap();
        let target = unsafe {
            shellspan_account_sandbox_prototype::rpc_trace_intent::ProcessIdentity::from_handle(
                GetCurrentProcess(),
            )
        }
        .unwrap();
        let intent = shellspan_account_sandbox_prototype::rpc_trace_intent::RpcTraceIntent::new(
            fixture, target,
        )
        .unwrap();
        value["rpc_trace_intent"] = serde_json::to_value(intent).unwrap();
        let receipt: ProfileReceipt = serde_json::from_value(value.clone()).unwrap();
        assert!(receipt.validate(fixture).unwrap_err().contains("RPC trace"));
        for field in [
            "account_removed",
            "profile_removed",
            "filters_removed",
            "package_filters_removed",
        ] {
            value[field] = serde_json::json!(false);
        }
        let receipt: ProfileReceipt = serde_json::from_value(value.clone()).unwrap();
        receipt.validate(fixture).unwrap();
        for field in [
            "account_removed",
            "profile_removed",
            "filters_removed",
            "package_filters_removed",
        ] {
            let mut released = value.clone();
            released[field] = serde_json::json!(true);
            let receipt: ProfileReceipt = serde_json::from_value(released).unwrap();
            assert!(
                receipt.validate(fixture).unwrap_err().contains("RPC trace"),
                "{field}"
            );
        }
        let mut completed = value.clone();
        completed["rpc_trace_removed"] = serde_json::json!(true);
        let receipt: ProfileReceipt = serde_json::from_value(completed.clone()).unwrap();
        receipt.validate(fixture).unwrap();
        completed["rpc_trace_intent"] = serde_json::Value::Null;
        let receipt: ProfileReceipt = serde_json::from_value(completed).unwrap();
        assert!(receipt.validate(fixture).is_err());
        value["rpc_trace_intent"]["session_name"] = serde_json::json!("NT Kernel Logger");
        let receipt: ProfileReceipt = serde_json::from_value(value).unwrap();
        assert!(receipt.validate(fixture).is_err());
    }
    #[test]
    fn actual_protected_lpac_trace_keeps_empty_observation_separate_from_dns_denial() {
        let load = |suffix: &str| -> serde_json::Value {
            let path=Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../docs/design/evidence/windows-stage-a-2026-10-09-dns-protected-rpc-trace-system-{suffix}.json"));
            let text = std::fs::read_to_string(path).unwrap();
            serde_json::from_str(text.trim_start_matches('\u{feff}')).unwrap()
        };
        let initial = load("profile");
        let receipt: ProfileReceipt = serde_json::from_value(initial.clone()).unwrap();
        receipt.validate(receipt.fixture_id).unwrap();
        let intent = receipt.rpc_trace_intent.as_ref().unwrap();
        let report = &initial["controller_admission_report"];
        for key in [
            "actual_user_verified",
            "actual_package_verified",
            "actual_capabilities_verified",
            "actual_low_integrity",
            "actual_lpac",
            "execution_topology_verified",
            "rpc_trace_started_before_resume",
        ] {
            assert_eq!(report[key], true, "{key}");
        }
        let trace = &report["rpc_client_trace"]["Ok"];
        assert_eq!(trace["process_id"], intent.target.process_id);
        assert_eq!(trace["session_name"], intent.session_name);
        assert!(trace["events"].as_array().unwrap().is_empty());
        assert_eq!(trace["session_absent"], true);
        assert_eq!(trace["events_lost"], 0);
        let checks = report["workload_report"]["checks"].as_array().unwrap();
        for name in [
            "DNS UDP API denied",
            "DNS TCP API denied",
            "DNS UDP receiver no traffic",
            "DNS TCP receiver no traffic",
        ] {
            let check = checks.iter().find(|check| check["name"] == name).unwrap();
            assert_eq!(check["passed"], false, "{name}");
        }
        let retired = load("recovered-profile");
        let receipt: ProfileReceipt = serde_json::from_value(retired.clone()).unwrap();
        receipt.validate(receipt.fixture_id).unwrap();
        assert_eq!(retired["rpc_trace_intent"], initial["rpc_trace_intent"]);
        for field in [
            "rpc_trace_removed",
            "rpc_filter_removed",
            "package_filters_removed",
            "filters_removed",
            "account_removed",
            "profile_removed",
        ] {
            assert_eq!(retired[field], true, "{field}");
        }
        assert!(receipt.cleanup_debt.is_empty());
        let audit = load("os-audit");
        for field in [
            "account_absent",
            "profile_absent",
            "hive_absent",
            "services_absent",
        ] {
            assert_eq!(audit[field], true, "{field}");
        }
    }
    #[test]
    fn actual_rpc_block_installation_and_retirement_bind_protected_intent() {
        let load = |suffix: &str| -> serde_json::Value {
            let path = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../docs/design/evidence")
                .join(format!(
                    "windows-stage-a-2026-10-09-node-rpc-block-system-{suffix}.json"
                ));
            let text = std::fs::read_to_string(path).unwrap();
            serde_json::from_str(text.trim_start_matches('\u{feff}')).unwrap()
        };
        let initial = load("profile");
        let receipt: ProfileReceipt = serde_json::from_value(initial.clone()).unwrap();
        receipt.validate(receipt.fixture_id).unwrap();
        assert_eq!(receipt.controller_tool, Some(FixedSystemTool::NodeRpcBlock));
        assert!(receipt.package_network_intent.is_some());
        assert!(receipt.rpc_network_intent.is_some());
        let report = &initial["controller_admission_report"];
        assert_eq!(report["rpc_block_verified_before_resume"], true);
        assert_eq!(report["package_blocks_verified_before_resume"], true);
        assert_eq!(report["tool_admission"]["actual_exit"], 73);
        for key in [
            "actual_lpac",
            "actual_low_integrity",
            "actual_user_verified",
            "actual_package_verified",
            "actual_capabilities_verified",
            "execution_topology_verified",
            "process_tree_stopped",
        ] {
            assert_eq!(report[key], true, "{key}");
        }
        let recovered = load("recovered-profile");
        let receipt: ProfileReceipt = serde_json::from_value(recovered.clone()).unwrap();
        receipt.validate(receipt.fixture_id).unwrap();
        assert_eq!(
            recovered["package_network_intent"],
            initial["package_network_intent"]
        );
        assert_eq!(recovered["account_sid"], initial["account_sid"]);
        assert!(
            receipt.package_filters_removed
                && receipt.filters_removed
                && receipt.account_removed
                && receipt.profile_removed
        );
        assert!(receipt.cleanup_debt.is_empty());
        assert!(receipt.rpc_filter_removed);
        assert_eq!(
            recovered["rpc_network_intent"],
            initial["rpc_network_intent"]
        );
        let audit = load("os-audit");
        assert_eq!(audit["fixture_id"], initial["fixture_id"]);
        for key in [
            "account_absent",
            "profile_absent",
            "hive_absent",
            "services_absent",
        ] {
            assert_eq!(audit[key], true, "{key}");
        }
    }
    #[test]
    fn actual_dns_rpc_block_bypass_keeps_network_matrix_failed() {
        let load = |suffix: &str| -> serde_json::Value {
            let path = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../docs/design/evidence")
                .join(format!(
                    "windows-stage-a-2026-10-09-dns-rpc-block-internet-system-{suffix}.json"
                ));
            let text = std::fs::read_to_string(path).unwrap();
            serde_json::from_str(text.trim_start_matches('\u{feff}')).unwrap()
        };
        let initial = load("profile");
        let receipt: ProfileReceipt = serde_json::from_value(initial.clone()).unwrap();
        receipt.validate(receipt.fixture_id).unwrap();
        assert_eq!(
            receipt.controller_tool,
            Some(FixedSystemTool::DnsRpcBlockInternetProbe)
        );
        let report = &initial["controller_admission_report"];
        assert_eq!(report["package_blocks_verified_before_resume"], true);
        assert_eq!(report["workload_checks_passed"], false);
        assert!(!report["error"].is_null());
        let checks = report["workload_report"]["checks"].as_array().unwrap();
        assert!(checks.len() >= 156);
        for prefix in ["", "descendant network: "] {
            for transport in ["UDP", "TCP"] {
                let name = format!("{prefix}DNS {transport} API denied");
                let found: Vec<_> = checks
                    .iter()
                    .filter(|check| check["name"] == name)
                    .collect();
                assert_eq!(found.len(), 1);
                assert_eq!(found[0]["passed"], false);
                let detail: serde_json::Value =
                    serde_json::from_str(found[0]["detail"].as_str().unwrap()).unwrap();
                assert_eq!(detail["dispatch_status"], 9506);
                assert_eq!(detail["completion_status"], 0);
                assert_eq!(detail["records_returned"], true);
                assert_eq!(detail["fixed_answer"], true);
            }
        }
        assert_eq!(report["diagnostic_internet_client"], true);
        assert_eq!(report["rpc_block_verified_before_resume"], true);
        for transport in ["UDP", "TCP"] {
            let name = format!("DNS {transport} receiver no traffic");
            let found: Vec<_> = checks
                .iter()
                .filter(|check| check["name"] == name)
                .collect();
            assert_eq!(found.len(), 1);
            assert_eq!(found[0]["passed"], false);
            assert!(found[0]["detail"]
                .as_str()
                .unwrap()
                .contains("controls verified; received=2"));
        }
        let recovered = load("recovered-profile");
        let receipt: ProfileReceipt = serde_json::from_value(recovered.clone()).unwrap();
        receipt.validate(receipt.fixture_id).unwrap();
        assert_eq!(
            recovered["package_network_intent"],
            initial["package_network_intent"]
        );
        assert!(
            receipt.package_filters_removed
                && receipt.filters_removed
                && receipt.account_removed
                && receipt.profile_removed
        );
        assert!(receipt.cleanup_debt.is_empty());
        assert!(receipt.rpc_filter_removed);
        assert_eq!(
            recovered["rpc_network_intent"],
            initial["rpc_network_intent"]
        );
        let audit = load("os-audit");
        assert_eq!(audit["fixture_id"], initial["fixture_id"]);
        for key in [
            "account_absent",
            "profile_absent",
            "hive_absent",
            "services_absent",
        ] {
            assert_eq!(audit[key], true, "{key}");
        }
    }
    #[test]
    fn actual_dns_sender_is_bound_to_stable_service_process_outside_owned_tree() {
        let load = |suffix: &str| -> serde_json::Value {
            let path = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../docs/design/evidence")
                .join(format!(
                    "windows-stage-a-2026-10-09-dns-sender-identity-system-{suffix}.json"
                ));
            let text = std::fs::read_to_string(path).unwrap();
            serde_json::from_str(text.trim_start_matches('\u{feff}')).unwrap()
        };
        let profile = load("profile");
        let report = &profile["controller_admission_report"];
        let service = load("dns-service-identity");
        assert_eq!(service["fixture_id"], profile["fixture_id"]);
        assert_eq!(service["before"], service["after"]);
        assert_eq!(service["before"]["service_name"], "Dnscache");
        assert_eq!(service["before"]["state"], "Running");
        let pid = service["before"]["pid"].as_u64().unwrap();
        assert!(pid > 0);
        let checks = report["workload_report"]["checks"].as_array().unwrap();
        let found: Vec<_> = checks
            .iter()
            .filter(|check| check["name"] == "DNS TCP receiver no traffic")
            .collect();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0]["passed"], false);
        let detail = found[0]["detail"].as_str().unwrap();
        assert!(detail.contains("controls verified; received=2;"));
        let owners: Vec<std::result::Result<u32, String>> =
            serde_json::from_str(detail.split_once("tcp_sender_owners=").unwrap().1).unwrap();
        assert_eq!(owners, vec![Ok(pid as u32), Ok(pid as u32)]);
        let members = report["execution_job_observations"].as_array().unwrap();
        assert!(!members
            .iter()
            .any(|member| member["pid"].as_u64() == Some(pid)));
        assert_eq!(report["workload_checks_passed"], false);
        let recovered = load("recovered-profile");
        let receipt: ProfileReceipt = serde_json::from_value(recovered).unwrap();
        receipt.validate(receipt.fixture_id).unwrap();
        assert!(
            receipt.rpc_filter_removed
                && receipt.package_filters_removed
                && receipt.filters_removed
                && receipt.account_removed
                && receipt.profile_removed
        );
        assert!(receipt.cleanup_debt.is_empty());
        let audit = load("os-audit");
        assert_eq!(audit["fixture_id"], profile["fixture_id"]);
        for key in [
            "account_absent",
            "profile_absent",
            "hive_absent",
            "services_absent",
        ] {
            assert_eq!(audit[key], true, "{key}");
        }
    }
}
