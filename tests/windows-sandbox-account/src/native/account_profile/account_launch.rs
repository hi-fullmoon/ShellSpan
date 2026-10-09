//! Fixed, suspended ordinary-account bootstrap; no user-selected commands.
use super::*;
use shellspan_account_sandbox_prototype::{
    account_lpac_plan::AccountLpacPlan, receiver_control::ReceiverControl,
};
use std::io::Read;
#[derive(Clone, Copy)]
pub(super) enum LaunchMode {
    FixedProbe,
    SystemAdmission,
    ControllerAdmission,
}

pub(super) fn run(
    receipt: &mut ProfileReceipt,
    login: &Handle,
    config: &crate::runner::Config,
    mode: LaunchMode,
) -> Result<()> {
    // Reuse the exact primary Token that loaded this profile; never acquire host credentials.
    let _impersonate = runtime_grants::RestorePrivilege::enable_named("SeImpersonatePrivilege")?;
    let mut receivers = ReceiverControl::bind()?;
    let plan = AccountLpacPlan {
        version: 1,
        fixture_id: receipt.fixture_id,
        account_sid: receipt.account_sid.clone().ok_or("missing launch SID")?,
        receivers: receivers.endpoints().clone(),
    };
    let root = receipt.root()?.join(plan.directory_name());
    receipt.state =
        "planned owned fixed LPAC bootstrap directory and bounded read/write grants".into();
    receipt.save()?;
    protected_fixture(&root)?;
    let source = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .with_file_name("shellspan-appcontainer-candidate.exe");
    let executable = root.join("candidate.exe");
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&executable)
        .map_err(|e| e.to_string())?;
    std::io::copy(
        &mut fs::File::open(source).map_err(|e| e.to_string())?,
        &mut output,
    )
    .map_err(|e| e.to_string())?;
    output.sync_all().map_err(|e| e.to_string())?;
    drop(output);
    journal::publish(
        &root.join("account-lpac.json"),
        &serde_json::to_vec(&plan).map_err(|e| e.to_string())?,
        false,
    )?;
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(root.join("account-report.json"))
        .map_err(|e| e.to_string())?;
    let subject = sid(&plan.account_sid)?;
    for path in [&root, &executable, &root.join("account-lpac.json")] {
        acl(
            path,
            &subject,
            FILE_GENERIC_READ | FILE_GENERIC_EXECUTE,
            GRANT_ACCESS,
        )?;
    }
    // No directory write or inherited ACE. This one report is untrusted diagnostic data.
    acl(
        &root.join("account-report.json"),
        &subject,
        FILE_GENERIC_READ | FILE_GENERIC_WRITE,
        GRANT_ACCESS,
    )?;
    let job = crate::runner::job()?;
    let mut desktop = wide(&format!("{}\\{}", config.station, config.desktop));
    let startup = STARTUPINFOW {
        cb: std::mem::size_of::<STARTUPINFOW>() as u32,
        lpDesktop: desktop.as_mut_ptr(),
        dwFlags: STARTF_USESHOWWINDOW,
        wShowWindow: windows_sys::Win32::UI::WindowsAndMessaging::SW_HIDE as u16,
        ..Default::default()
    };
    let mut command = wide(match mode {
        LaunchMode::FixedProbe => "candidate.exe --owned-account-lpac",
        LaunchMode::SystemAdmission => "candidate.exe --owned-account-lpac-admission",
        LaunchMode::ControllerAdmission => {
            return Err("controller admission must use the fixed controller entry".into())
        }
    });
    let mut process = PROCESS_INFORMATION::default();
    let profile = receipt
        .profile
        .as_ref()
        .ok_or("bootstrap profile binding missing")?;
    let profile_path = Path::new(&profile.path);
    if !same_profile(profile, &profile_object(profile_path)?) {
        return Err("bootstrap profile identity changed".into());
    }
    let mut windows = [0u16; 32768];
    let length = unsafe {
        windows_sys::Win32::System::SystemInformation::GetWindowsDirectoryW(
            windows.as_mut_ptr(),
            windows.len() as u32,
        )
    } as usize;
    if length == 0 || length >= windows.len() {
        return Err("bootstrap Windows directory query failed".into());
    }
    let windows = String::from_utf16(&windows[..length])
        .map_err(|_| "bootstrap Windows directory invalid")?;
    let environment: Vec<u16> = format!("SystemRoot={windows}\0WINDIR={windows}\0USERPROFILE={}\0LOCALAPPDATA={}\0TEMP={}\0TMP={}\0\0", profile_path.display(), profile_path.join("AppData/Local").display(), root.display(), root.display()).encode_utf16().collect();
    let environment =
        shellspan_account_sandbox_prototype::fixed_environment::canonicalize(&environment)?;
    receipt.account_lpac_started = true;
    receipt.state =
        "planned fixed ordinary-account process launch; LPAC cleanup requires confirmation".into();
    receipt.save()?;
    let launched = win(
        unsafe {
            CreateProcessWithTokenW(
                login.0,
                0,
                wide(executable.to_str().ok_or("invalid executable path")?).as_ptr(),
                command.as_mut_ptr(),
                CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
                environment.as_ptr().cast(),
                wide(root.to_str().ok_or("invalid owned launch directory")?).as_ptr(),
                &startup,
                &mut process,
            )
        },
        "launch fixed dedicated-account LPAC bootstrap",
    );
    if let Err(error) = launched {
        receipt.account_lpac_cleanup_verified = true; // No process was created; no package profile could be created.
        revoke(&root, &subject)?;
        return Err(error);
    }
    let process_handle = Handle(process.hProcess);
    let thread = Handle(process.hThread);
    let run = (|| -> Result<u32> {
        win(
            unsafe { AssignProcessToJobObject(job.0, process_handle.0) },
            "own suspended bootstrap tree",
        )?;
        let mut raw = null_mut();
        win(
            unsafe { OpenProcessToken(process_handle.0, TOKEN_QUERY, &mut raw) },
            "inspect actual ordinary bootstrap Token",
        )?;
        let token = Handle(raw);
        if token_sid(token.0)? != plan.account_sid {
            return Err("bootstrap SID mismatch".into());
        }
        let mut elevation = TOKEN_ELEVATION::default();
        let mut count = 0;
        win(
            unsafe {
                GetTokenInformation(
                    token.0,
                    TokenElevation,
                    (&mut elevation as *mut TOKEN_ELEVATION).cast(),
                    std::mem::size_of_val(&elevation) as u32,
                    &mut count,
                )
            },
            "inspect actual bootstrap elevation",
        )?;
        if elevation.TokenIsElevated != 0 {
            return Err("bootstrap unexpectedly elevated".into());
        }
        if unsafe { ResumeThread(thread.0) } == u32::MAX {
            return Err("resume fixed bootstrap failed".into());
        }
        if unsafe { WaitForSingleObject(process_handle.0, 20000) } != WAIT_OBJECT_0 {
            return Err("fixed LPAC bootstrap did not finish".into());
        }
        let mut exit = 0;
        win(
            unsafe { GetExitCodeProcess(process_handle.0, &mut exit) },
            "query terminal fixed bootstrap exit",
        )?;
        Ok(exit)
    })();
    receipt.account_lpac_bootstrap_exit = run.as_ref().ok().copied();
    receipt.account_lpac_outer_job_total = unsafe { crate::runner::accounting(job.0) }
        .ok()
        .map(|value| value.TotalProcesses);
    let stopped = unsafe { crate::runner::end_process(process_handle.0, job.0) };
    receipt.account_lpac_outer_tree_stopped = stopped;
    if !stopped {
        return Err("retain owned LPAC debt: outer Job tree stop unconfirmed".into());
    }
    drop(thread);
    drop(process_handle);
    drop(job);
    let counts = receivers.finish()?;
    receipt.controller_receiver_counts = Some(counts.clone());
    let mut data = Vec::new();
    fs::File::open(root.join("account-report.json"))
        .map_err(|e| e.to_string())?
        .take(65537)
        .read_to_end(&mut data)
        .map_err(|e| e.to_string())?;
    if data.len() > 65536 {
        return Err("fixed bootstrap report exceeds budget".into());
    }
    let report = decode_bootstrap_report(&data, &run)?;
    receipt.account_lpac_diagnostic_report = Some(report.clone());
    let clean = retirement_acknowledged(&report);
    if !clean {
        return Err("retain owned LPAC debt: candidate retirement report incomplete".into());
    }
    receipt.account_lpac_cleanup_verified = true;
    revoke(&root, &subject)?;
    receipt.save()?;
    run?;
    let verified = [
        "dedicated_account_plan_verified",
        "source_not_elevated",
        "appcontainer_identity",
        "same_user",
        "low_integrity",
        "actual_lpac",
        "capabilities_verified",
        "entry_exit_73",
    ]
    .iter()
    .all(|key| report[*key] == true)
        && report["actual_source_user_sid"] == plan.account_sid
        && report["error"].is_null()
        && report["profile_name"] == plan.profile_name()
        && counts == vec![0; 4];
    receipt.account_lpac_verified = verified;
    if !verified {
        return Err(
            "dedicated-account LPAC fixed experiment failed; inspect diagnostic report".into(),
        );
    }
    receipt.state =
        "dedicated account fixed LPAC experiment passed; complete stage A not accepted".into();
    receipt.save()
}
fn decode_bootstrap_report(data: &[u8], execution: &Result<u32>) -> Result<serde_json::Value> {
    serde_json::from_slice(data).map_err(|error| {
        let execution = match execution {
            Ok(exit) => format!("terminal bootstrap exit=0x{exit:08x}"),
            Err(reason) => format!("bootstrap execution failed: {reason}"),
        };
        format!("{execution}; fixed report invalid: {error}")
    })
}
// This is only the immutable fixed bootstrap's diagnostic acknowledgement.
fn verify_bootstrap_profile_checkpoint(
    profile: &ProfileObject,
    account: &str,
    files_retired: bool,
) -> Result<bool> {
    let path = Path::new(&profile.path);
    match fs::symlink_metadata(path) {
        Ok(_) => {
            if !same_profile(profile, &profile_object(path)?) {
                return Err("bootstrap recovery profile identity differs".into());
            }
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            for ancestor in path
                .parent()
                .ok_or("bootstrap profile parent missing")?
                .ancestors()
            {
                if fs::symlink_metadata(ancestor)
                    .map_err(|e| e.to_string())?
                    .file_attributes()
                    & FILE_ATTRIBUTE_REPARSE_POINT
                    != 0
                {
                    return Err("bootstrap absent profile ancestor is a reparse point".into());
                }
            }
            if !files_retired || profile_binding(account)?.is_some() {
                return Err(
                    "bootstrap profile absence lacks a verified file-retirement checkpoint".into(),
                );
            }
            Ok(false)
        }
        Err(error) => Err(error.to_string()),
    }
}
pub(super) fn inspect_recovery(receipt: &ProfileReceipt) -> Result<serde_json::Value> {
    let subject = disabled_identity(receipt)?;
    recovery::no_account_processes(&subject)?;
    let account = receipt
        .account_sid
        .as_deref()
        .ok_or("bootstrap recovery SID missing")?;
    if !hive_absent(account)? {
        return Err("bootstrap recovery hive still present".into());
    }
    let profile = receipt
        .profile
        .as_ref()
        .ok_or("bootstrap recovery profile identity missing")?;
    let profile_present = verify_bootstrap_profile_checkpoint(
        profile,
        account,
        receipt.independent_bootstrap_files_retired,
    )?;
    let root = receipt.root()?.join(format!(
        "ShellSpan-stage-A-account-lpac-{}",
        receipt.fixture_id
    ));
    let plan = shellspan_account_sandbox_prototype::account_lpac_plan::read_protected(&root)?;
    plan.validate_for_source(account, &root)?;
    if plan.fixture_id != receipt.fixture_id {
        return Err("bootstrap recovery plan UUID differs".into());
    }
    let inspect_file = |path: &Path, budget: u64| -> Result<(Handle, serde_json::Value)> {
        let held = Handle(unsafe {
            CreateFileW(
                wide(
                    path.to_str()
                        .ok_or("bootstrap recovery file path invalid")?,
                )
                .as_ptr(),
                FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_OPEN_REPARSE_POINT,
                null_mut(),
            )
        });
        if held.0 == INVALID_HANDLE_VALUE {
            return Err("bootstrap recovery file open failed".into());
        }
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        win(
            unsafe { GetFileInformationByHandle(held.0, &mut info) },
            "inspect held bootstrap recovery file",
        )?;
        let bytes = (u64::from(info.nFileSizeHigh) << 32) | u64::from(info.nFileSizeLow);
        if info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT) != 0
            || info.nNumberOfLinks != 1
            || bytes > budget
        {
            return Err("bootstrap recovery file alias, type or budget invalid".into());
        }
        Ok((
            held,
            serde_json::json!({"path":path,"bytes":bytes,"volume":info.dwVolumeSerialNumber,"file_index":(u64::from(info.nFileIndexHigh)<<32)|u64::from(info.nFileIndexLow)}),
        ))
    };
    let (_image_lease, image) = inspect_file(&root.join("candidate.exe"), 128 * 1024 * 1024)?;
    recovery::verify_evidence_acl(&root.join("candidate.exe"))?;
    let (_report_lease, report) = inspect_file(&root.join("account-report.json"), 65536)?;
    Ok(serde_json::json!({
        "scope":"read-only bootstrap recovery prerequisites; not retirement authorization",
        "fixture_id":receipt.fixture_id,
        "account_sid":account,
        "account_disabled":true,
        "account_processes_absent":true,
        "hive_absent":true,
        "profile_identity_verified":profile_present,
        "profile_absence_verified":!profile_present,
        "protected_plan_bound":true,
        "candidate":image,
        "report":report,
        "error":null,
    }))
}
// A production broker must independently verify these OS objects.
fn validate_empty_bootstrap_inventory(mut names: Vec<String>) -> Result<()> {
    names.sort();
    if names != ["account-lpac.json", "account-report.json", "candidate.exe"] {
        return Err("bootstrap recovery contains unknown or missing objects".into());
    }
    Ok(())
}
pub(super) fn retire_unreported_bootstrap_files(receipt: &mut ProfileReceipt) -> Result<()> {
    if !receipt.recovery_executed
        || receipt.controller_workload_requested
        || receipt.controller_admission_report.is_some()
        || receipt.controller_workload_planned_root.is_some()
        || receipt.account_lpac_diagnostic_report.is_some()
        || !receipt.private_namespace_removed
    {
        return Err("unreported bootstrap recovery scope invalid".into());
    }
    let observation = inspect_recovery(receipt)?;
    if observation["report"]["bytes"] != 0 {
        return Err("nonempty bootstrap report requires its existing retirement gate".into());
    }
    let root = receipt.root()?.join(format!(
        "ShellSpan-stage-A-account-lpac-{}",
        receipt.fixture_id
    ));
    let inventory = || -> Result<()> {
        let names = fs::read_dir(&root)
            .map_err(|e| e.to_string())?
            .take(4)
            .map(|entry| {
                entry.map_err(|e| e.to_string()).and_then(|entry| {
                    entry
                        .file_name()
                        .into_string()
                        .map_err(|_| "bootstrap recovery name invalid".into())
                })
            })
            .collect::<Result<Vec<_>>>()?;
        validate_empty_bootstrap_inventory(names)
    };
    let mut leases = Vec::new();
    for (path, directory) in [
        (receipt.root()?, true),
        (root.clone(), true),
        (root.join("account-lpac.json"), false),
        (root.join("candidate.exe"), false),
        (root.join("account-report.json"), false),
    ] {
        let held = Handle(unsafe {
            CreateFileW(
                wide(path.to_str().ok_or("bootstrap recovery path invalid")?).as_ptr(),
                READ_CONTROL | FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
                null_mut(),
            )
        });
        if held.0 == INVALID_HANDLE_VALUE {
            return Err("bootstrap retirement lease failed".into());
        }
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        win(
            unsafe { GetFileInformationByHandle(held.0, &mut info) },
            "inspect bootstrap retirement lease",
        )?;
        if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
            || (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0) != directory
            || (!directory && info.nNumberOfLinks != 1)
        {
            return Err("bootstrap retirement object type or alias invalid".into());
        }
        if path == root.join("account-report.json")
            && (info.nFileSizeHigh != 0 || info.nFileSizeLow != 0)
        {
            return Err("bootstrap report changed before retirement".into());
        }
        if path != root.join("account-report.json") {
            recovery::verify_evidence_acl(&path)?;
        }
        leases.push(held);
    }
    inventory()?;
    // These live no-write/no-delete leases span the named ACL operations.
    let subject = disabled_identity(receipt)?;
    receipt.state = "planned independent retirement of exact empty bootstrap file grants; profile and SID block retained".into();
    receipt.save()?;
    revoke(&root, &subject)?;
    inventory()?;
    for held in &leases[1..] {
        let mut sd = null_mut();
        let mut dacl = null_mut();
        status(
            unsafe {
                GetSecurityInfo(
                    held.0,
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    null_mut(),
                    null_mut(),
                    &mut dacl,
                    null_mut(),
                    &mut sd,
                )
            },
            "verify retired bootstrap grants",
        )?;
        let _storage = Local(sd);
        if dacl.is_null() {
            return Err("bootstrap retirement DACL missing".into());
        }
        for index in 0..unsafe { (*dacl).AceCount } as u32 {
            let mut ace = null_mut();
            win(
                unsafe { GetAce(dacl, index, &mut ace) },
                "inspect retired bootstrap grant",
            )?;
            let allowed = unsafe { &*ace.cast::<ACCESS_ALLOWED_ACE>() };
            if allowed.Header.AceType == 0
                && unsafe {
                    EqualSid(
                        (&allowed.SidStart as *const u32).cast_mut().cast(),
                        subject.0,
                    )
                } != 0
            {
                return Err("owned bootstrap grant remains after revocation".into());
            }
        }
    }
    receipt.independent_bootstrap_recovery_observation = Some(observation);
    receipt.independent_bootstrap_files_retired = true;
    receipt.state =
        "exact empty bootstrap file grants retired; owned profile retirement still required".into();
    receipt.save()
}
fn retirement_acknowledged(report: &serde_json::Value) -> bool {
    [
        "process_tree_stopped",
        "profile_removed",
        "fixture_acls_revoked",
    ]
    .iter()
    .all(|key| report[*key] == true)
}
fn revoke(root: &Path, subject: &Local) -> Result<()> {
    for path in [
        root.join("account-report.json"),
        root.join("account-lpac.json"),
        root.join("candidate.exe"),
        root.to_path_buf(),
    ] {
        acl(&path, subject, 0, REVOKE_ACCESS)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn actual_fixed_report_exposes_creation_denial_and_keeps_cleanup_independent() {
        for mode in ["fixed", "held"] {
            let read = |suffix: &str| -> serde_json::Value {
                serde_json::from_slice(&fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../docs/design/evidence/windows-stage-a-2026-10-09-bootstrap-{mode}-report-{suffix}.json"))).unwrap()).unwrap()
            };
            let receipt = read("profile");
            let audit = read("os-audit");
            let report = &receipt["account_lpac_diagnostic_report"];
            assert_eq!(report["actual_source_user_sid"], receipt["account_sid"]);
            assert_eq!(report["dedicated_account_plan_verified"], true);
            assert_eq!(
                report["error"],
                "create suspended AppContainer fixed cmd: Win32 5"
            );
            assert!(retirement_acknowledged(report));
            assert_eq!(receipt["account_lpac_verified"], false);
            assert_eq!(receipt["account_lpac_outer_tree_stopped"], true);
            assert_eq!(receipt["account_lpac_bootstrap_exit"], 2);
            for key in [
                "account_removed",
                "profile_removed",
                "filters_removed",
                "account_lpac_cleanup_verified",
            ] {
                assert_eq!(receipt[key], true, "{key}");
            }
            assert_eq!(receipt["cleanup_debt"], serde_json::json!([]));
            assert_eq!(receipt["fixture_id"], audit["fixture_id"]);
            for key in [
                "account_absent",
                "profile_absent",
                "hive_absent",
                "services_absent",
            ] {
                assert_eq!(audit[key], true, "OS {key}");
            }
        }
    }
    #[test]
    fn actual_profile_checkpoint_rejects_replacement_and_unjournaled_absence() {
        let root =
            std::env::temp_dir().join(format!("ShellSpan-bootstrap-checkpoint-{}", Uuid::new_v4()));
        let subject = "S-1-5-21-4294967294-4294967293-4294967292-4294967291";
        assert!(profile_binding(subject).unwrap().is_none());
        fs::create_dir(&root).unwrap();
        let frozen = profile_object(&root).unwrap();
        assert!(verify_bootstrap_profile_checkpoint(&frozen, subject, false).unwrap());
        trash::delete(&root).unwrap();
        assert!(verify_bootstrap_profile_checkpoint(&frozen, subject, false).is_err());
        assert!(!verify_bootstrap_profile_checkpoint(&frozen, subject, true).unwrap());
        fs::create_dir(&root).unwrap();
        assert!(verify_bootstrap_profile_checkpoint(&frozen, subject, true).is_err());
        trash::delete(&root).unwrap();
    }
    #[test]
    fn actual_empty_bootstrap_retirement_keeps_execution_failed_and_binds_os_absence() {
        let read = |suffix: &str| -> serde_json::Value {
            serde_json::from_slice(&fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../docs/design/evidence/windows-stage-a-2026-10-09-empty-bootstrap-retirement-{suffix}.json"))).unwrap()).unwrap()
        };
        let receipt = read("profile");
        let audit = read("os-audit");
        assert_eq!(receipt["fixture_id"], audit["fixture_id"]);
        assert_eq!(receipt["account_sid"], audit["account_sid"]);
        assert_eq!(audit["native_exit"], 0);
        for key in [
            "profile_removed",
            "account_removed",
            "filters_removed",
            "account_lpac_cleanup_verified",
        ] {
            assert_eq!(receipt[key], true, "retirement {key}");
        }
        assert_eq!(receipt["cleanup_debt"], serde_json::json!([]));
        assert_eq!(receipt["account_lpac_verified"], false);
        assert!(receipt["account_lpac_diagnostic_report"].is_null());
        assert_eq!(
            receipt["independent_bootstrap_recovery_observation"]["report"]["bytes"],
            0
        );
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
    fn empty_bootstrap_inventory_refuses_unknown_missing_or_duplicate_objects() {
        let expected = vec![
            "candidate.exe".to_string(),
            "account-report.json".to_string(),
            "account-lpac.json".to_string(),
        ];
        validate_empty_bootstrap_inventory(expected.clone()).unwrap();
        for names in [
            vec![],
            expected[..2].to_vec(),
            vec![
                "candidate.exe".into(),
                "candidate.exe".into(),
                "account-lpac.json".into(),
            ],
            {
                let mut names = expected.clone();
                names.push("ShellSpan-AC-untracked".into());
                names
            },
            vec![
                "Candidate.exe".into(),
                "account-report.json".into(),
                "account-lpac.json".into(),
            ],
        ] {
            assert!(validate_empty_bootstrap_inventory(names).is_err());
        }
    }
    #[test]
    fn independent_bootstrap_prerequisites_do_not_claim_retirement() {
        let evidence: serde_json::Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/design/evidence/windows-stage-a-2026-10-09-bootstrap-independent-recovery-observation.json"))).unwrap();
        assert_eq!(evidence["native_exit"], 2);
        let receipt = &evidence["receipt"];
        let observation = &receipt["independent_bootstrap_recovery_observation"];
        assert_eq!(observation["fixture_id"], receipt["fixture_id"]);
        assert_eq!(observation["account_sid"], receipt["account_sid"]);
        for key in [
            "account_disabled",
            "account_processes_absent",
            "hive_absent",
            "profile_identity_verified",
            "protected_plan_bound",
        ] {
            assert_eq!(observation[key], true, "{key}");
        }
        assert!(observation["error"].is_null());
        assert_eq!(observation["report"]["bytes"], 0);
        assert_eq!(receipt["account_lpac_cleanup_verified"], false);
        assert_eq!(receipt["account_removed"], false);
        assert_eq!(receipt["filters_removed"], false);
        assert!(!receipt["cleanup_debt"].as_array().unwrap().is_empty());
    }
    #[test]
    fn report_failure_preserves_execution_error_or_terminal_exit() {
        assert!(decode_bootstrap_report(b"", &Ok(0xc0000022))
            .unwrap_err()
            .contains("exit=0xc0000022"));
        assert!(
            decode_bootstrap_report(b"", &Err("fixed wait failed".into()))
                .unwrap_err()
                .contains("fixed wait failed")
        );
        assert_eq!(
            decode_bootstrap_report(b"{}", &Ok(2)).unwrap(),
            serde_json::json!({})
        );
        // A parseable acknowledgement may permit separate cleanup checks even after execution fails.
        assert_eq!(
            decode_bootstrap_report(b"{}", &Err("fixed timeout".into())).unwrap(),
            serde_json::json!({})
        );
    }
    #[test]
    fn actual_empty_bootstrap_report_does_not_authorize_retirement() {
        let receipt: serde_json::Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/design/evidence/windows-stage-a-2026-10-09-bootstrap-explicit-environment-profile.json"))).unwrap();
        let quarantine: serde_json::Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/design/evidence/windows-stage-a-2026-10-09-bootstrap-explicit-environment-quarantine.json"))).unwrap();
        assert_eq!(receipt["fixture_id"], quarantine["fixture_id"]);
        assert_eq!(receipt["account_sid"], quarantine["expected_sid"]);
        assert_eq!(receipt["account_lpac_started"], true);
        assert_eq!(receipt["account_lpac_cleanup_verified"], false);
        assert!(receipt["account_lpac_diagnostic_report"].is_null());
        assert!(!retirement_acknowledged(
            &receipt["account_lpac_diagnostic_report"]
        ));
        assert!(!receipt["cleanup_debt"].as_array().unwrap().is_empty());
        assert_eq!(receipt["account_removed"], false);
        assert_eq!(receipt["filters_removed"], false);
        assert_eq!(quarantine["account_sid_matches"], true);
        assert_eq!(quarantine["account_disabled"], true);
        assert_eq!(quarantine["helper_terminal"], true);
    }
    #[test]
    fn incomplete_or_nonboolean_retirement_never_authorizes_slot_cleanup() {
        let complete = serde_json::json!({"process_tree_stopped":true,"profile_removed":true,"fixture_acls_revoked":true});
        assert!(retirement_acknowledged(&complete));
        for key in [
            "process_tree_stopped",
            "profile_removed",
            "fixture_acls_revoked",
        ] {
            for value in [
                serde_json::Value::Null,
                serde_json::json!(false),
                serde_json::json!("true"),
                serde_json::json!(1),
            ] {
                let mut incomplete = complete.clone();
                incomplete[key] = value;
                assert!(!retirement_acknowledged(&incomplete));
            }
        }
        assert!(!retirement_acknowledged(&serde_json::Value::Null));
    }
}
