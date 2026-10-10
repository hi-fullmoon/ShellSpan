//! One-shot owned LocalSystem service. No general command or path interface.
use super::*;
use shellspan_account_sandbox_prototype::frontend_materialization::MaterializationNamespace;
use std::sync::OnceLock;
use windows_sys::Win32::System::Services::*;

static SERVICE_ID: OnceLock<Uuid> = OnceLock::new();
struct Service(SC_HANDLE);
impl Drop for Service {
    fn drop(&mut self) {
        unsafe {
            CloseServiceHandle(self.0);
        }
    }
}
pub(super) fn verify_workload_recovery_service(id: Uuid) -> Result<()> {
    let (plan, _image) = load(id)?;
    if !plan.fixed_workload || !plan.service_created || !plan.service_removed {
        return Err("workload recovery requires durably retired exact SYSTEM service".into());
    }
    let manager = manager(SC_MANAGER_CONNECT)?;
    confirm_absent(&manager, &wide(&name(id)))
}
pub(super) fn verify_frontend_retired(id: Uuid) -> Result<()> {
    let (plan, _image) = load_inner(id, false)?;
    if !plan.fixed_frontend_journal
        || !plan.service_created
        || !plan.service_removed
        || !plan.observed_service_exit.as_ref().is_some_and(|s| {
            s.process_exit_confirmed && s.win32_exit_code == 0 && s.service_specific_exit_code == 0
        })
    {
        return Err(
            "frontend recovery requires successfully retired original SYSTEM service".into(),
        );
    }
    confirm_absent(&manager(SC_MANAGER_CONNECT)?, &wide(&name(id)))
}
pub(super) fn verify_materialization_retired(id: Uuid) -> Result<()> {
    verify_materialization_retired_in_scope(id, MaterializationNamespace::Dependencies)
}
pub(super) fn verify_materialization_retired_in_scope(
    id: Uuid,
    namespace: MaterializationNamespace,
) -> Result<()> {
    let (plan, _image) = load_inner(id, false)?;
    if !plan.fixed_frontend_materialization
        || !matches!(
            (plan.materialization_namespace(), namespace),
            (
                MaterializationNamespace::Source,
                MaterializationNamespace::Source
            ) | (
                MaterializationNamespace::Dependencies,
                MaterializationNamespace::Dependencies
            ) | (
                MaterializationNamespace::Project,
                MaterializationNamespace::Project
            )
        )
        || !plan.service_created
        || !plan.service_removed
        || !plan
            .observed_service_exit
            .as_ref()
            .is_some_and(|s| s.process_exit_confirmed)
    {
        return Err(
            "materialization recovery requires original process exit and exact service retirement"
                .into(),
        );
    }
    confirm_absent(&manager(SC_MANAGER_CONNECT)?, &wide(&name(id)))
}
fn identity(text: &str) -> Result<Uuid> {
    let id = Uuid::parse_str(text).map_err(|_| "invalid SYSTEM admission UUID")?;
    if id.is_nil() || id.to_string() != text {
        return Err("SYSTEM admission requires canonical nonnil UUID".into());
    }
    Ok(id)
}
fn root(id: Uuid) -> Result<PathBuf> {
    Ok(fixture_parent()?.join(format!("ShellSpan-system-admission-A-{id}")))
}
fn name(id: Uuid) -> String {
    format!("ShellSpanAdmissionA-{}", id.simple())
}
fn command(id: Uuid) -> Result<String> {
    Ok(format!(
        "\"{}\" --fixed-system-admission-service {id}",
        root(id)?.join("fixed-admission.exe").display()
    ))
}
fn validate_recovery_dispatch(
    id: Uuid,
    target: Uuid,
    workload: bool,
    lifecycle: FixedLifecycle,
) -> Result<()> {
    if target.is_nil() || target == id || workload || lifecycle != FixedLifecycle::Normal {
        return Err("fixed recovery plan conflicts with execution plan".into());
    }
    Ok(())
}
fn validate_service_observation(plan: &Preparation) -> Result<()> {
    if (plan.service_created || plan.service_removed) && !plan.service_install_planned {
        return Err("service state lacks frozen creation intent".into());
    }
    if let Some(observed) = &plan.observed_service_exit {
        if !plan.service_install_planned
            || !plan.service_created
            || !observed.process_exit_confirmed
        {
            return Err("service exit observation lacks confirmed owned process".into());
        }
        if observed.win32_exit_code != ERROR_SERVICE_SPECIFIC_ERROR
            && observed.service_specific_exit_code != 0
        {
            return Err("service exit observation has conflicting status codes".into());
        }
        if observed.win32_exit_code == ERROR_SERVICE_SPECIFIC_ERROR
            && observed.service_specific_exit_code == 0
        {
            return Err("service-specific failure lacks failure code".into());
        }
    }
    Ok(())
}
fn load(id: Uuid) -> Result<(Preparation, fs::File)> {
    load_inner(id, true)
}
fn load_inner(id: Uuid, verify_related: bool) -> Result<(Preparation, fs::File)> {
    let root = root(id)?;
    let bytes =
        shellspan_account_sandbox_prototype::account_lpac_plan::read_protected_receipt(&root)?;
    let plan: Preparation = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    validate_frontend_dispatch(&plan)?;
    if verify_related {
        if let Some(target) = plan.frontend_materialization_recovery_target {
            verify_materialization_retired_in_scope(target, plan.materialization_namespace())?;
        }
        if let Some(target) = plan.frontend_journal_recovery_target {
            verify_frontend_retired(target)?;
        }
    }
    validate_service_observation(&plan)?;
    validate_tool_dispatch(
        plan.fixed_tool,
        plan.fixed_workload,
        plan.fixed_lifecycle,
        plan.recovery_target,
    )?;
    if let Some(target) = plan.recovery_target {
        validate_recovery_dispatch(id, target, plan.fixed_workload, plan.fixed_lifecycle)?;
        account_profile::verify_recovery_intent(target)?;
    }
    if !plan.fixed_workload && plan.fixed_lifecycle != FixedLifecycle::Normal {
        return Err("fixed lifecycle requires a frozen workload plan".into());
    }
    if plan.version != 1
        || plan.backend != "fixed-system-admission-preparation-v1"
        || plan.production != "unavailable"
        || plan.fixture_id != id
        || plan.image_size == 0
        || plan.image_size > 64 * 1024 * 1024
    {
        return Err("SYSTEM preparation binding invalid".into());
    }
    let path = root.join("fixed-admission.exe");
    let held = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(&path)
        .map_err(|e| e.to_string())?;
    recovery::verify_evidence_acl(&path)?;
    let info = held_image(&held, true)?;
    if info.dwVolumeSerialNumber != plan.image_volume
        || ((u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow))
            != plan.image_file_index
        || held.metadata().map_err(|e| e.to_string())?.len() != plan.image_size
    {
        return Err("fixed SYSTEM image differs from frozen identity".into());
    }
    Ok((plan, held))
}
fn save(plan: &Preparation) -> Result<()> {
    journal::publish(
        &root(plan.fixture_id)?.join("ownership.json"),
        &serde_json::to_vec_pretty(plan).map_err(|e| e.to_string())?,
        false,
    )
}
fn manager(access: u32) -> Result<Service> {
    let raw = unsafe { OpenSCManagerW(null(), null(), access) };
    if raw.is_null() {
        return Err(format!("open local service manager: Win32 {}", unsafe {
            GetLastError()
        }));
    }
    Ok(Service(raw))
}
unsafe extern "system" fn handler(_: u32, _: u32, _: *mut c_void, _: *mut c_void) -> u32 {
    ERROR_CALL_NOT_IMPLEMENTED
}
fn confirm_absent(manager: &Service, service_name: &[u16]) -> Result<()> {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        let raw = unsafe { OpenServiceW(manager.0, service_name.as_ptr(), SERVICE_QUERY_CONFIG) };
        if raw.is_null() {
            match unsafe { GetLastError() } {
                ERROR_SERVICE_DOES_NOT_EXIST => return Ok(()),
                ERROR_SERVICE_MARKED_FOR_DELETE => {}
                _ => return Err("owned service absence query failed".into()),
            }
        } else {
            drop(Service(raw));
        }
        if std::time::Instant::now() >= deadline {
            return Err("owned service removal still pending; retain debt".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}
unsafe extern "system" fn service_main(_: u32, _: *mut *mut u16) {
    let Some(id) = SERVICE_ID.get().copied() else {
        return;
    };
    let service_name = wide(&name(id));
    let status_handle =
        unsafe { RegisterServiceCtrlHandlerExW(service_name.as_ptr(), Some(handler), null()) };
    if status_handle.is_null() {
        return;
    }
    let mut status = SERVICE_STATUS {
        dwServiceType: SERVICE_WIN32_OWN_PROCESS,
        dwCurrentState: SERVICE_RUNNING,
        ..Default::default()
    };
    if unsafe { SetServiceStatus(status_handle, &status) } == 0 {
        return;
    }
    let result = (|| -> Result<()> {
        let (plan, _image) = load(id)?;
        if !plan.service_install_planned || !plan.service_created || plan.service_removed {
            return Err("fixed service dispatch not authorized by owned receipt".into());
        }
        let result = if let Some(target) = plan.frontend_materialization_recovery_target {
            match plan.materialization_namespace() {
                MaterializationNamespace::Source => {
                    super::super::frontend_materialization::recover_source(id, target)
                }
                MaterializationNamespace::Dependencies => {
                    super::super::frontend_materialization::recover(id, target)
                }
                MaterializationNamespace::Project => {
                    super::super::frontend_materialization::recover_project(id, target)
                }
            }
        } else if let Some(target) = plan.frontend_journal_recovery_target {
            super::super::frontend_journal::recover(id, target)
        } else if plan.fixed_frontend_materialization {
            match plan.materialization_namespace() {
                MaterializationNamespace::Source => {
                    super::super::frontend_materialization::run_source(
                        id,
                        plan.frontend_source_workload_failure,
                    )
                }
                MaterializationNamespace::Dependencies => {
                    super::super::frontend_materialization::run(id)
                }
                MaterializationNamespace::Project => {
                    super::super::frontend_materialization::run_project(
                        id,
                        plan.frontend_project_workload_failure,
                    )
                }
            }
        } else if plan.fixed_frontend_journal {
            super::super::frontend_journal::run(id)
        } else if let Some(target) = plan.recovery_target {
            account_profile::recover(&target.to_string())
        } else if plan.fixed_workload {
            account_profile::run_system_workload(id, plan.fixed_lifecycle, plan.fixed_tool)
        } else {
            account_profile::run_system_controller(id)
        };
        let result_report = serde_json::json!({"version":1,"production":"unavailable","fixture_id":id,"system_context_verified":true,"diagnostic_error":result.as_ref().err()});
        let publication = journal::publish(
            &root(id)?.join("service-result.json"),
            &serde_json::to_vec_pretty(&result_report).map_err(|e| e.to_string())?,
            false,
        );
        complete_diagnostic(publication, result)
    })();
    status.dwCurrentState = SERVICE_STOPPED;
    if result.is_err() {
        status.dwWin32ExitCode = ERROR_SERVICE_SPECIFIC_ERROR;
        status.dwServiceSpecificExitCode = 2;
    }
    unsafe {
        SetServiceStatus(status_handle, &status);
    }
}
fn complete_diagnostic(publication: Result<()>, diagnostic: Result<()>) -> Result<()> {
    publication?;
    diagnostic
}
pub(super) fn dispatch(text: &str) -> Result<()> {
    let id = identity(text)?;
    let mut raw = null_mut();
    win(
        unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) },
        "inspect actual SYSTEM entry identity",
    )?;
    let token = Handle(raw);
    if token_sid(token.0)? != "S-1-5-18" {
        return Err("fixed service entry requires actual LocalSystem Token".into());
    }
    let (plan, _image) = load(id)?;
    if !plan.service_install_planned || !plan.service_created || plan.service_removed {
        return Err("SYSTEM entry has no active owned service receipt".into());
    }
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    if executable != root(id)?.join("fixed-admission.exe") {
        return Err("SYSTEM entry image path binding mismatch".into());
    }
    SERVICE_ID
        .set(id)
        .map_err(|_| "SYSTEM service entry cannot replay")?;
    let mut service_name = wide(&name(id));
    let table = [
        SERVICE_TABLE_ENTRYW {
            lpServiceName: service_name.as_mut_ptr(),
            lpServiceProc: Some(service_main),
        },
        SERVICE_TABLE_ENTRYW::default(),
    ];
    win(
        unsafe { StartServiceCtrlDispatcherW(table.as_ptr()) },
        "connect fixed SYSTEM service dispatcher",
    )
}
fn config_string(pointer: *const u16, storage: &[usize]) -> Result<String> {
    let start = storage.as_ptr() as usize;
    let end = start + std::mem::size_of_val(storage);
    let address = pointer as usize;
    if address < start || address >= end || !address.is_multiple_of(2) {
        return Err("service config string outside query buffer".into());
    }
    let values = unsafe { std::slice::from_raw_parts(pointer, (end - address) / 2) };
    let length = values
        .iter()
        .position(|value| *value == 0)
        .ok_or("unterminated service config string")?;
    String::from_utf16(&values[..length]).map_err(|_| "invalid service config string".into())
}
fn verify_service(service: &Service, id: Uuid) -> Result<()> {
    let mut security_length = 0;
    unsafe {
        QueryServiceObjectSecurity(
            service.0,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            null_mut(),
            0,
            &mut security_length,
        );
    }
    if security_length == 0 || security_length > 65536 {
        return Err("service security query budget invalid".into());
    }
    let mut security =
        vec![0usize; (security_length as usize).div_ceil(std::mem::size_of::<usize>())];
    win(
        unsafe {
            QueryServiceObjectSecurity(
                service.0,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                security.as_mut_ptr().cast(),
                security_length,
                &mut security_length,
            )
        },
        "inspect owned service security",
    )?;
    recovery::trusted_descriptor_with_mask(
        security.as_mut_ptr().cast(),
        GENERIC_ALL
            | GENERIC_WRITE
            | WRITE_DAC
            | WRITE_OWNER
            | DELETE
            | SERVICE_CHANGE_CONFIG
            | SERVICE_START
            | SERVICE_STOP
            | SERVICE_PAUSE_CONTINUE,
    )?;
    let mut required = 0;
    unsafe {
        QueryServiceConfigW(service.0, null_mut(), 0, &mut required);
    }
    if required < std::mem::size_of::<QUERY_SERVICE_CONFIGW>() as u32 || required > 65536 {
        return Err("owned service config budget invalid".into());
    }
    let mut buffer = vec![0usize; (required as usize).div_ceil(std::mem::size_of::<usize>())];
    win(
        unsafe {
            QueryServiceConfigW(
                service.0,
                buffer.as_mut_ptr().cast(),
                required,
                &mut required,
            )
        },
        "query owned service configuration",
    )?;
    let config = unsafe { &*buffer.as_ptr().cast::<QUERY_SERVICE_CONFIGW>() };
    if config.dwServiceType != SERVICE_WIN32_OWN_PROCESS
        || config.dwStartType != SERVICE_DEMAND_START
        || config_string(config.lpBinaryPathName, &buffer)? != command(id)?
        || config_string(config.lpServiceStartName, &buffer)? != "LocalSystem"
    {
        return Err("owned service configuration changed; retain debt".into());
    }
    Ok(())
}
pub(super) fn run(text: &str) -> Result<()> {
    if !elevated()? {
        return Err("fixed SYSTEM service setup requires elevation".into());
    }
    let id = identity(text)?;
    let (mut plan, _image) = load(id)?;
    if plan.service_install_planned || plan.service_created || plan.service_removed {
        return Err("fixed service installation cannot adopt or replay prior state".into());
    }
    let manager = manager(SC_MANAGER_CONNECT | SC_MANAGER_CREATE_SERVICE)?;
    let service_name = wide(&name(id));
    let existing = unsafe { OpenServiceW(manager.0, service_name.as_ptr(), SERVICE_QUERY_CONFIG) };
    if !existing.is_null() {
        drop(Service(existing));
        return Err("same-name service already exists; no adoption".into());
    }
    if unsafe { GetLastError() } != ERROR_SERVICE_DOES_NOT_EXIST {
        return Err("owned service absence unconfirmed".into());
    }
    plan.service_install_planned = true;
    plan.state = "owned service creation planned; exact UUID image only".into();
    save(&plan)?;
    let raw = unsafe {
        CreateServiceW(
            manager.0,
            service_name.as_ptr(),
            service_name.as_ptr(),
            SERVICE_QUERY_CONFIG
                | SERVICE_QUERY_STATUS
                | SERVICE_START
                | DELETE
                | READ_CONTROL
                | WRITE_DAC,
            SERVICE_WIN32_OWN_PROCESS,
            SERVICE_DEMAND_START,
            SERVICE_ERROR_NORMAL,
            wide(&command(id)?).as_ptr(),
            null(),
            null_mut(),
            null(),
            null(),
            null(),
        )
    };
    if raw.is_null() {
        return Err(format!("create fixed owned service: Win32 {}", unsafe {
            GetLastError()
        }));
    }
    let service = Service(raw);
    // Change only this newly-created object. The fixed handler rejects all custom
    // controls; existing and shared service security is never modified.
    let (security, _) = descriptor("D:P(A;;GA;;;SY)(A;;GA;;;BA)")?;
    win(
        unsafe { SetServiceObjectSecurity(service.0, DACL_SECURITY_INFORMATION, security.0) },
        "protect newly-created owned service DACL",
    )?;
    plan.service_created = true;
    plan.state = "owned service created; fixed SYSTEM diagnostic pending".into();
    save(&plan)?;
    verify_service(&service, id)?;
    win(
        unsafe { StartServiceW(service.0, 0, null()) },
        "start fixed owned SYSTEM diagnostic",
    )?;
    let deadline = std::time::Instant::now()
        + Duration::from_secs(
            if plan.fixed_frontend_materialization
                || plan.frontend_materialization_recovery_target.is_some()
            {
                3600
            } else if plan.fixed_frontend_journal || plan.frontend_journal_recovery_target.is_some()
            {
                600
            } else {
                60
            },
        );
    let mut process = None;
    let stopped_status = loop {
        let mut observed = SERVICE_STATUS_PROCESS::default();
        let mut required = 0;
        win(
            unsafe {
                QueryServiceStatusEx(
                    service.0,
                    SC_STATUS_PROCESS_INFO,
                    (&mut observed as *mut SERVICE_STATUS_PROCESS).cast(),
                    std::mem::size_of_val(&observed) as u32,
                    &mut required,
                )
            },
            "observe owned service status",
        )?;
        if observed.dwProcessId != 0 && process.is_none() {
            let raw = unsafe {
                OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
                    0,
                    observed.dwProcessId,
                )
            };
            if raw.is_null() {
                return Err("cannot hold owned service process; retain debt".into());
            }
            process = Some(Handle(raw));
            let held = process.as_ref().ok_or("service process handle missing")?;
            let mut token = null_mut();
            win(
                unsafe { OpenProcessToken(held.0, TOKEN_QUERY, &mut token) },
                "verify owned service process Token",
            )?;
            let token = Handle(token);
            if token_sid(token.0)? != "S-1-5-18" {
                return Err("observed service process is not SYSTEM".into());
            }
            let mut path = [0u16; 32768];
            let mut length = path.len() as u32;
            win(
                unsafe { QueryFullProcessImageNameW(held.0, 0, path.as_mut_ptr(), &mut length) },
                "verify held service process image",
            )?;
            let actual = PathBuf::from(
                String::from_utf16(&path[..length as usize])
                    .map_err(|_| "service image path invalid")?,
            );
            if actual != root(id)?.join("fixed-admission.exe") {
                return Err("held service process image mismatch".into());
            }
        }
        if observed.dwCurrentState == SERVICE_STOPPED {
            break (observed.dwWin32ExitCode, observed.dwServiceSpecificExitCode);
        }
        if std::time::Instant::now() >= deadline {
            return Err(
                "owned service still live; retain service and account debt, do not restart".into(),
            );
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    let process =
        process.ok_or("service stopped before process identity could be held; retain debt")?;
    if unsafe { WaitForSingleObject(process.0, 30000) } != WAIT_OBJECT_0 {
        return Err("owned service process exit unconfirmed; retain debt".into());
    }
    plan.observed_service_exit = Some(ServiceExitObservation {
        win32_exit_code: stopped_status.0,
        service_specific_exit_code: stopped_status.1,
        process_exit_confirmed: true,
    });
    save(&plan)?;
    verify_service(&service, id)?;
    win(
        unsafe { DeleteService(service.0) },
        "delete exact stopped owned service",
    )?;
    drop(service);
    confirm_absent(&manager, &service_name)?;
    plan.service_removed = true;
    plan.state = "owned SYSTEM service stopped and removed; inspect profile receipt".into();
    save(&plan)?;
    println!(
        "{}",
        serde_json::to_string_pretty(&plan).map_err(|e| e.to_string())?
    );
    Ok(())
}

pub(super) fn recover(text: &str) -> Result<()> {
    if !elevated()? {
        return Err("fixed service recovery requires elevation".into());
    }
    let id = identity(text)?;
    let (mut plan, _image) = load(id)?;
    if !plan.service_install_planned {
        return Err("no owned service creation intent".into());
    }
    let manager = manager(SC_MANAGER_CONNECT)?;
    let service_name = wide(&name(id));
    let raw = unsafe {
        OpenServiceW(
            manager.0,
            service_name.as_ptr(),
            SERVICE_QUERY_CONFIG | SERVICE_QUERY_STATUS | READ_CONTROL | DELETE,
        )
    };
    if raw.is_null() {
        if unsafe { GetLastError() } != ERROR_SERVICE_DOES_NOT_EXIST {
            return Err("service absence unknown; retain debt".into());
        }
    } else {
        let service = Service(raw);
        verify_service(&service, id)?;
        let mut observed = SERVICE_STATUS::default();
        win(
            unsafe { QueryServiceStatus(service.0, &mut observed) },
            "inspect exact service recovery state",
        )?;
        if observed.dwCurrentState != SERVICE_STOPPED {
            return Err("owned service remains live; no restart or PID-only termination".into());
        }
        win(
            unsafe { DeleteService(service.0) },
            "recover stopped exact owned service",
        )?;
        drop(service);
        confirm_absent(&manager, &service_name)?;
    }
    plan.service_removed = true;
    plan.state =
        "exact service retirement confirmed; profile recovery is independently gated".into();
    save(&plan)?;
    println!(
        "{}",
        serde_json::to_string_pretty(&plan).map_err(|e| e.to_string())?
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn service_observation_gate_rejects_inconsistent_intent_exit_and_status() {
        let baseline: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../docs/design/evidence/windows-stage-a-2026-10-09-scm-status-service.json"
        )))
        .unwrap();
        assert!(
            validate_service_observation(&serde_json::from_value(baseline.clone()).unwrap())
                .is_ok()
        );
        for (field, value) in [
            ("service_install_planned", false),
            ("service_created", false),
        ] {
            let mut changed = baseline.clone();
            changed[field] = serde_json::json!(value);
            assert!(
                validate_service_observation(&serde_json::from_value(changed).unwrap()).is_err(),
                "{field}"
            );
        }
        for (field, value) in [
            ("process_exit_confirmed", serde_json::json!(false)),
            ("win32_exit_code", serde_json::json!(0)),
            ("service_specific_exit_code", serde_json::json!(0)),
        ] {
            let mut changed = baseline.clone();
            changed["observed_service_exit"][field] = value;
            assert!(
                validate_service_observation(&serde_json::from_value(changed).unwrap()).is_err(),
                "{field}"
            );
        }
        let mut pending = baseline;
        pending["observed_service_exit"] = serde_json::Value::Null;
        pending["service_created"] = serde_json::json!(false);
        assert!(validate_service_observation(&serde_json::from_value(pending).unwrap()).is_ok());
    }
    #[test]
    fn saved_failure_receipt_does_not_turn_diagnostic_into_service_success() {
        assert!(complete_diagnostic(Ok(()), Ok(())).is_ok());
        assert_eq!(
            complete_diagnostic(Ok(()), Err("owned cleanup unconfirmed".into())).unwrap_err(),
            "owned cleanup unconfirmed"
        );
        assert_eq!(
            complete_diagnostic(Err("receipt publication failed".into()), Ok(())).unwrap_err(),
            "receipt publication failed"
        );
        assert_eq!(
            complete_diagnostic(
                Err("receipt publication failed".into()),
                Err("owned cleanup unconfirmed".into())
            )
            .unwrap_err(),
            "receipt publication failed"
        );
    }
    #[test]
    fn recovery_dispatch_rejects_execution_modes_and_self_or_nil_targets() {
        let id = Uuid::new_v4();
        let target = Uuid::new_v4();
        assert!(validate_recovery_dispatch(id, target, false, FixedLifecycle::Normal).is_ok());
        for bad in [id, Uuid::nil()] {
            assert!(validate_recovery_dispatch(id, bad, false, FixedLifecycle::Normal).is_err());
        }
        assert!(validate_recovery_dispatch(id, target, true, FixedLifecycle::Normal).is_err());
        assert!(
            validate_recovery_dispatch(id, target, false, FixedLifecycle::ServiceCrash).is_err()
        );
    }
    #[test]
    fn service_config_strings_are_bounded_and_controls_cannot_dispatch_operations() {
        let storage = [0usize; 2];
        assert_eq!(
            config_string(storage.as_ptr().cast(), &storage).unwrap(),
            ""
        );
        assert!(config_string(null(), &storage).is_err());
        let unterminated = [usize::MAX; 2];
        assert!(config_string(unterminated.as_ptr().cast(), &unterminated).is_err());
        for control in [SERVICE_CONTROL_STOP, SERVICE_CONTROL_INTERROGATE, 128, 255] {
            assert_eq!(
                unsafe { handler(control, 0, null_mut(), null_mut()) },
                ERROR_CALL_NOT_IMPLEMENTED
            );
        }
    }
    #[test]
    fn service_identity_rejects_aliases_nil_and_command_injection() {
        let id = Uuid::new_v4();
        assert_eq!(identity(&id.to_string()).unwrap(), id);
        for text in [
            id.simple().to_string(),
            Uuid::nil().to_string(),
            format!("{id} --command cmd"),
        ] {
            assert!(identity(&text).is_err());
        }
        assert!(dispatch(&id.to_string())
            .unwrap_err()
            .contains("actual LocalSystem"));
    }
}
