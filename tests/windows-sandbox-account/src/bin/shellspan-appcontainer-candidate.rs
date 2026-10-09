//! Independent admission experiment. No production fallback or arbitrary command.
use serde::Serialize;
use shellspan_account_sandbox_prototype::fixture_runner::{end_process, job};
use shellspan_account_sandbox_prototype::job_observer::{
    verified_fixed_topology, JobObserver, JobProcessObservation,
};
use std::ptr::{null, null_mut};
use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::Security::Isolation::*;
use windows_sys::Win32::Security::*;
use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
use windows_sys::Win32::System::SystemServices::{
    PROCESS_MITIGATION_CHILD_PROCESS_POLICY, SECURITY_MANDATORY_LOW_RID,
};
use windows_sys::Win32::System::Threading::*;
type Result<T> = std::result::Result<T, String>;
#[path = "../candidate_namespace.rs"]
mod candidate_namespace;
use shellspan_account_sandbox_prototype::appcontainer_probe as owned_probe;
fn probe_sid_text(sid: PSID) -> Result<String> {
    // All callers retain the SDK SID owner or queried Token buffer.
    unsafe { owned_probe::sid_text(sid) }
}
fn probe_lpac_behavior(token: HANDLE, user: PSID, package: PSID) -> Result<bool> {
    unsafe { owned_probe::lpac_behavior(token, user, package) }
}
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}
fn win(value: i32, name: &str) -> Result<()> {
    if value == 0 {
        Err(format!("{name}: Win32 {}", unsafe { GetLastError() }))
    } else {
        Ok(())
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
struct Sid(PSID);
impl Drop for Sid {
    fn drop(&mut self) {
        unsafe {
            FreeSid(self.0);
        }
    }
}
struct StartupCapability(PSID);
impl Drop for StartupCapability {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}
fn fixed_startup_capability(name: &str) -> Result<StartupCapability> {
    if !shellspan_account_sandbox_prototype::startup_capability_policy::permitted(name) {
        return Err("unsupported fixed startup capability".into());
    }
    let mut groups = null_mut();
    let mut capabilities = null_mut();
    let mut group_count = 0;
    let mut capability_count = 0;
    win(
        unsafe {
            DeriveCapabilitySidsFromName(
                wide(name).as_ptr(),
                &mut groups,
                &mut group_count,
                &mut capabilities,
                &mut capability_count,
            )
        },
        "derive fixed startup capability",
    )?;
    if group_count > 16 || capability_count > 16 {
        return Err("capability derivation budget exceeded".into());
    }
    unsafe {
        for index in 0..group_count {
            LocalFree(*groups.add(index as usize));
        }
        LocalFree(groups.cast());
    }
    let valid = capability_count == 1 && !capabilities.is_null();
    let retained = if valid {
        unsafe { *capabilities }
    } else {
        null_mut()
    };
    unsafe {
        if !valid {
            for index in 0..capability_count {
                LocalFree(*capabilities.add(index as usize));
            }
        }
        LocalFree(capabilities.cast());
    }
    if !valid || retained.is_null() {
        return Err("registryRead derivation did not return one exact SID".into());
    }
    Ok(StartupCapability(retained))
}
struct Attributes {
    storage: Vec<usize>,
    live: bool,
}
impl Drop for Attributes {
    fn drop(&mut self) {
        if self.live {
            unsafe {
                DeleteProcThreadAttributeList(self.storage.as_mut_ptr().cast());
            }
        }
    }
}
#[derive(Serialize)]
struct Report {
    tool_admission: Option<serde_json::Value>,
    production: &'static str,
    candidate: &'static str,
    profile_name: String,
    created_package_sid: Option<String>,
    namespace_admission: Option<serde_json::Value>,
    state: String,
    appcontainer_identity: bool,
    source_not_elevated: bool,
    source_creation_boundary: serde_json::Value,
    actual_source_user_sid: String,
    dedicated_account_plan_verified: bool,
    receiver_evidence_owner: &'static str,
    receiver_quietness_verified: bool,
    same_user: bool,
    low_integrity: bool,
    lpac_requested: bool,
    actual_lpac: bool,
    lpac_evidence_method: &'static str,
    capabilities_empty: bool,
    requested_capabilities: Vec<&'static str>,
    capabilities_verified: bool,
    entry_exit_73: bool,
    process_tree_stopped: bool,
    lifecycle_timeout_observed: bool,
    lifecycle_cancel_observed: bool,
    lifecycle_root_failure_observed: bool,
    active_processes_after_root_failure: Option<u32>,
    owned_job_total_processes: Option<u32>,
    owned_job_process_observations: Vec<JobProcessObservation>,
    profile_removed: bool,
    error: Option<String>,
    fixture: Option<String>,
    fixture_acls_revoked: bool,
    probe: Option<owned_probe::ProbeReport>,
}
unsafe fn query(token: HANDLE, class: TOKEN_INFORMATION_CLASS) -> Result<Vec<usize>> {
    let mut bytes = 0;
    unsafe {
        GetTokenInformation(token, class, null_mut(), 0, &mut bytes);
    }
    if bytes == 0 || bytes > 65536 {
        return Err("invalid Token query budget".into());
    }
    let mut data = vec![0usize; (bytes as usize).div_ceil(std::mem::size_of::<usize>())];
    win(
        unsafe { GetTokenInformation(token, class, data.as_mut_ptr().cast(), bytes, &mut bytes) },
        "query actual Token",
    )?;
    Ok(data)
}
fn exact_capabilities(actual: &[SID_AND_ATTRIBUTES], expected: &[SID_AND_ATTRIBUTES]) -> bool {
    if actual.len() != expected.len() || actual.len() > 16 {
        return false;
    }
    let valid =
        |entry: &SID_AND_ATTRIBUTES| !entry.Sid.is_null() && unsafe { IsValidSid(entry.Sid) != 0 };
    if !actual.iter().chain(expected).all(valid) {
        return false;
    }
    let same = |left: &SID_AND_ATTRIBUTES, right: &SID_AND_ATTRIBUTES| unsafe {
        EqualSid(left.Sid, right.Sid) != 0
    };
    for entries in [actual, expected] {
        if entries
            .iter()
            .enumerate()
            .any(|(i, entry)| entries[..i].iter().any(|prior| same(entry, prior)))
        {
            return false;
        }
    }
    expected.iter().all(|entry| {
        actual
            .iter()
            .any(|observed| same(entry, observed) && observed.Attributes == entry.Attributes)
    })
}
struct Experiment {
    tool: Option<shellspan_account_sandbox_prototype::fixed_tool::FixedTool>,
    file_network: bool,
    lpac: bool,
    registry_read: bool,
    instrumentation: bool,
    timeout_trial: bool,
    cancel_trial: bool,
    root_failure_trial: bool,
    controller_network: bool,
    dedicated_account: bool,
}
fn source_creation_boundary(token: HANDLE) -> Result<serde_json::Value> {
    use windows_sys::Win32::System::JobObjects::*;
    let mut member = 0;
    win(
        unsafe { IsProcessInJob(GetCurrentProcess(), null_mut(), &mut member) },
        "inspect bootstrap Job membership",
    )?;
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    let mut ui = JOBOBJECT_BASIC_UI_RESTRICTIONS::default();
    if member != 0 {
        win(
            unsafe {
                QueryInformationJobObject(
                    null_mut(),
                    JobObjectExtendedLimitInformation,
                    (&mut limits as *mut JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    std::mem::size_of_val(&limits) as u32,
                    null_mut(),
                )
            },
            "inspect current bootstrap Job limits",
        )?;
        win(
            unsafe {
                QueryInformationJobObject(
                    null_mut(),
                    JobObjectBasicUIRestrictions,
                    (&mut ui as *mut JOBOBJECT_BASIC_UI_RESTRICTIONS).cast(),
                    std::mem::size_of_val(&ui) as u32,
                    null_mut(),
                )
            },
            "inspect current bootstrap Job UI boundary",
        )?;
    }
    let session = unsafe { query(token, TokenSessionId) }?;
    let mut policy = PROCESS_MITIGATION_CHILD_PROCESS_POLICY::default();
    win(
        unsafe {
            GetProcessMitigationPolicy(
                GetCurrentProcess(),
                ProcessChildProcessPolicy,
                (&mut policy as *mut PROCESS_MITIGATION_CHILD_PROCESS_POLICY).cast(),
                std::mem::size_of_val(&policy),
            )
        },
        "inspect bootstrap child-process policy",
    )?;
    Ok(
        serde_json::json!({"in_job":member != 0,"current_job_limit_flags":limits.BasicLimitInformation.LimitFlags,
        "current_job_active_process_limit":limits.BasicLimitInformation.ActiveProcessLimit,"current_job_ui_restrictions":ui.UIRestrictionsClass,
        "token_session_id":unsafe { *session.as_ptr().cast::<u32>() },"token_restricted":unsafe { IsTokenRestricted(token) } != 0,
        "child_process_policy_flags":unsafe { policy.Anonymous.Flags }}),
    )
}
fn run(experiment: Experiment) -> Result<Report> {
    let Experiment {
        tool,
        file_network,
        lpac,
        registry_read,
        instrumentation,
        timeout_trial,
        cancel_trial,
        root_failure_trial,
        controller_network,
        dedicated_account,
    } = experiment;
    let mut source = null_mut();
    win(
        unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut source) },
        "open source Token",
    )?;
    let source = Handle(source);
    let source_elevation = unsafe { query(source.0, TokenElevation) }?;
    if unsafe { (*source_elevation.as_ptr().cast::<TOKEN_ELEVATION>()).TokenIsElevated } != 0 {
        return Err("candidate requires unelevated source; no profile created".into());
    }
    let source_user = unsafe { query(source.0, TokenUser) }?;
    let actual_source_sid =
        probe_sid_text(unsafe { (*source_user.as_ptr().cast::<TOKEN_USER>()).User.Sid })?;
    let account_root = if dedicated_account {
        Some(std::env::current_dir().map_err(|e| e.to_string())?)
    } else {
        None
    };
    let account_plan = account_root
        .as_ref()
        .map(|root| {
            let plan =
                shellspan_account_sandbox_prototype::account_lpac_plan::read_protected(root)?;
            plan.validate_for_source(&actual_source_sid, root)?;
            Ok::<_, String>(plan)
        })
        .transpose()?;

    let mut controller_receivers = if controller_network {
        Some(shellspan_account_sandbox_prototype::receiver_control::ReceiverControl::bind()?)
    } else {
        None
    };
    if registry_read && !lpac {
        return Err("registryRead candidate requires explicit LPAC mode".into());
    }
    if instrumentation
        && (!lpac
            || (tool.is_some()
                && !matches!(
                tool,
                Some(
                    shellspan_account_sandbox_prototype::fixed_tool::FixedTool::PowerShellEtwProbe
                        | shellspan_account_sandbox_prototype::fixed_tool::FixedTool::PowerShell
                        | shellspan_account_sandbox_prototype::fixed_tool::FixedTool::PowerShell7Runtime | shellspan_account_sandbox_prototype::fixed_tool::FixedTool::PowerShell7RuntimeArtifact | shellspan_account_sandbox_prototype::fixed_tool::FixedTool::PowerShell7RuntimeBuild
                )
            )))
    {
        return Err("instrumentation candidate requires fixed LPAC PowerShell probe".into());
    }
    let mut capability_names = Vec::new();
    if registry_read {
        capability_names.push("registryRead");
    }
    if instrumentation {
        capability_names.push("lpacInstrumentation");
    }
    let startup_capabilities = capability_names
        .iter()
        .map(|name| fixed_startup_capability(name))
        .collect::<Result<Vec<_>>>()?;
    let mut startup_entries: Vec<SID_AND_ATTRIBUTES> = startup_capabilities
        .iter()
        .map(|capability| SID_AND_ATTRIBUTES {
            Sid: capability.0,
            Attributes: windows_sys::Win32::System::SystemServices::SE_GROUP_ENABLED as u32,
        })
        .collect();
    let name = account_plan
        .as_ref()
        .map(|plan| plan.profile_name())
        .unwrap_or_else(|| format!("ShellSpan-candidate-{}", uuid::Uuid::new_v4().simple()));
    let receipt_path = account_root
        .as_ref()
        .map(|root| root.join("account-report.json"))
        .unwrap_or_else(|| std::env::temp_dir().join(format!("{name}.json")));
    let mut report = Report {
        tool_admission: None,
        production: "unavailable",
        candidate: if tool.is_some() { "lpac-fixed-tool-admission" } else if lpac { "lpac-file-network-candidate" } else if file_network { "appcontainer-file-network-candidate" } else { "appcontainer-admission-only" },
        profile_name: name.clone(),
        created_package_sid: None,
        namespace_admission: None,
        state: "planned owned empty profile".into(),
        appcontainer_identity: false,
        source_not_elevated: true,
        source_creation_boundary: source_creation_boundary(source.0)?,
        actual_source_user_sid: actual_source_sid,
        dedicated_account_plan_verified: account_plan.is_some(),
        receiver_evidence_owner: if dedicated_account { "external-controller-required" } else if controller_network { "controller" } else { "fixture-controller" },
        receiver_quietness_verified: false,
        same_user: false,
        low_integrity: false,
        lpac_requested: lpac,
        actual_lpac: false,
        lpac_evidence_method: "actual Token AccessCheck: unique package positive control plus AllApplicationPackages exclusion; not class-46 inference",
        capabilities_empty: false,
        requested_capabilities: capability_names,
        capabilities_verified: false,
        entry_exit_73: false,
        process_tree_stopped: false,
        lifecycle_timeout_observed: false,
        lifecycle_cancel_observed: false,
        lifecycle_root_failure_observed: false,
        active_processes_after_root_failure: None,
        owned_job_total_processes: None,
        owned_job_process_observations: vec![],
        profile_removed: false,
        error: None,
        fixture: None,
        fixture_acls_revoked: !file_network,
        probe: None,
    };
    let save = |report: &Report| -> Result<()> {
        let data = serde_json::to_vec_pretty(report).map_err(|e| e.to_string())?;
        if let Some(root) = &account_root {
            owned_probe::write_fixed_bootstrap_report(root, &data)?;
        } else {
            std::fs::write(&receipt_path, data).map_err(|e| e.to_string())?;
        }
        // Dedicated bootstrap writes only its pre-created fixed report. No extra
        // TEMP file or directory-write grant is required. This low-privilege
        // output remains diagnostic data, never recovery authority.
        Ok(())
    };
    save(&report)?;
    let mut sid = null_mut();
    let result = unsafe {
        CreateAppContainerProfile(
            wide(&name).as_ptr(),
            wide("ShellSpan isolated admission candidate").as_ptr(),
            wide(if registry_read {
                "Owned empty profile; fixed registryRead startup capability"
            } else {
                "Owned empty profile; no capabilities"
            })
            .as_ptr(),
            if startup_entries.is_empty() {
                null()
            } else {
                startup_entries.as_ptr()
            },
            startup_entries.len() as u32,
            &mut sid,
        )
    };
    if result < 0 {
        return Err(format!(
            "create fresh owned profile HRESULT=0x{:08x}; planned receipt {}",
            result as u32,
            receipt_path.display()
        ));
    }
    let sid = Sid(sid);
    report.created_package_sid = Some(probe_sid_text(sid.0)?);
    report.namespace_admission = Some(candidate_namespace::inspect(sid.0));
    report.state = "owned profile created; interrupted execution needs exact profile review".into();
    let mut child: Option<(
        Handle,
        Handle,
        shellspan_account_sandbox_prototype::fixture_runner::Handle,
    )> = None;
    let mut fixture = None;
    let mut observer = None;
    let mut tool_image_lease = None;
    let mut git_subject_lease = None;
    let mut git_bundle = None;
    let mut powershell_runtime = None;
    let mut powershell_probe_source = None;
    let mut dependency_environment = String::new();
    let mut tool_stdio = None;
    let probe = (|| {
        save(&report)?;
        if file_network {
            let prepared = unsafe {
                owned_probe::Fixture::prepare(
                    &name,
                    sid.0,
                    (*source_user.as_ptr().cast::<TOKEN_USER>()).User.Sid,
                )
            }?;
            report.fixture = Some(prepared.root.display().to_string());
            fixture = Some(prepared);
            if let Some(plan) = &account_plan {
                fixture
                    .as_mut()
                    .ok_or("missing dedicated account fixture")?
                    .use_controller_endpoints(plan.receivers.clone())?;
            }
            if let Some(receivers) = &controller_receivers {
                fixture
                    .as_mut()
                    .ok_or("missing controller fixture")?
                    .use_controller_endpoints(receivers.endpoints().clone())?;
            }
            save(&report)?;
            unsafe {
                fixture
                    .as_mut()
                    .ok_or("missing owned fixture")?
                    .populate((*source_user.as_ptr().cast::<TOKEN_USER>()).User.Sid)
            }?;
            if !dedicated_account
                && tool.is_none()
                && !timeout_trial
                && !cancel_trial
                && !root_failure_trial
            {
                fixture
                    .as_mut()
                    .ok_or("missing private receiver fixture")?
                    .start_fixed_private_receivers()?;
                fixture
                    .as_mut()
                    .ok_or("missing DNS receiver fixture")?
                    .start_fixed_dns_receiver()?;
            }
        }
        if tool.is_some() {
            tool_stdio = Some(
                shellspan_account_sandbox_prototype::fixed_tool::ToolStdio::prepare(
                    &fixture.as_ref().ok_or("missing tool stdio fixture")?.root,
                )?,
            );
        }
        let attribute_count = (if lpac { 2 } else { 1 }) + u32::from(tool.is_some());
        let mut size = 0;
        unsafe {
            InitializeProcThreadAttributeList(null_mut(), attribute_count, 0, &mut size);
        }
        if size == 0 || size > 65536 {
            return Err("invalid attribute budget".into());
        }
        let mut attributes = Attributes {
            storage: vec![0; size.div_ceil(std::mem::size_of::<usize>())],
            live: false,
        };
        win(
            unsafe {
                InitializeProcThreadAttributeList(
                    attributes.storage.as_mut_ptr().cast(),
                    attribute_count,
                    0,
                    &mut size,
                )
            },
            "initialize candidate attributes",
        )?;
        attributes.live = true;
        let opt_out = 1u32; // PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT.
        if lpac {
            win(
                unsafe {
                    UpdateProcThreadAttribute(
                        attributes.storage.as_mut_ptr().cast(),
                        0,
                        PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY as usize,
                        (&opt_out as *const u32).cast(),
                        std::mem::size_of_val(&opt_out),
                        null_mut(),
                        null(),
                    )
                },
                "set LPAC opt-out policy",
            )?;
        }
        let capabilities = SECURITY_CAPABILITIES {
            AppContainerSid: sid.0,
            Capabilities: if startup_entries.is_empty() {
                null_mut()
            } else {
                startup_entries.as_mut_ptr()
            },
            CapabilityCount: startup_entries.len() as u32,
            Reserved: 0,
        };
        win(
            unsafe {
                UpdateProcThreadAttribute(
                    attributes.storage.as_mut_ptr().cast(),
                    0,
                    PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
                    (&capabilities as *const SECURITY_CAPABILITIES).cast(),
                    std::mem::size_of_val(&capabilities),
                    null_mut(),
                    null(),
                )
            },
            "set zero-capability candidate",
        )?;
        let mut private_desktop = account_plan
            .as_ref()
            .map(|plan| wide(&format!("SSPA-{}\\probe", plan.fixture_id.simple())));
        if let Some(stdio) = &tool_stdio {
            win(
                unsafe {
                    UpdateProcThreadAttribute(
                        attributes.storage.as_mut_ptr().cast(),
                        0,
                        PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                        stdio.inherited.as_ptr().cast(),
                        std::mem::size_of_val(&stdio.inherited),
                        null_mut(),
                        null(),
                    )
                },
                "set exact fixed tool stdio handles",
            )?;
        }
        let mut startup = STARTUPINFOEXW {
            StartupInfo: STARTUPINFOW {
                cb: std::mem::size_of::<STARTUPINFOEXW>() as u32,
                lpDesktop: private_desktop
                    .as_mut()
                    .map_or(null_mut(), |name| name.as_mut_ptr()),
                ..Default::default()
            },
            lpAttributeList: attributes.storage.as_mut_ptr().cast(),
        };
        if let Some(stdio) = &tool_stdio {
            startup.StartupInfo.dwFlags |= STARTF_USESTDHANDLES;
            startup.StartupInfo.hStdInput = stdio.inherited[0];
            startup.StartupInfo.hStdOutput = stdio.inherited[1];
            startup.StartupInfo.hStdError = stdio.inherited[2];
        }
        let mut system = [0u16; 32768];
        let length = unsafe {
            windows_sys::Win32::System::SystemInformation::GetSystemDirectoryW(
                system.as_mut_ptr(),
                system.len() as u32,
            )
        } as usize;
        if length == 0 || length >= system.len() {
            return Err("fixed System32 query failed".into());
        }
        let mut executable = wide(&format!(
            "{}\\cmd.exe",
            String::from_utf16_lossy(&system[..length])
        ));
        let mut command = wide("cmd.exe /d /c exit 73");
        if let Some(fixture) = &fixture {
            executable = wide(fixture.image.to_str().ok_or("invalid probe image")?);
            command = wide("probe.exe --owned-fixed-probe");
        }
        if let Some(tool) = tool {
            if matches!(
                tool,
                shellspan_account_sandbox_prototype::fixed_tool::FixedTool::PowerShell7Runtime | shellspan_account_sandbox_prototype::fixed_tool::FixedTool::PowerShell7RuntimeArtifact | shellspan_account_sandbox_prototype::fixed_tool::FixedTool::PowerShell7RuntimeBuild
            ) {
                let prepare = if matches!(tool, shellspan_account_sandbox_prototype::fixed_tool::FixedTool::PowerShell7RuntimeBuild) { shellspan_account_sandbox_prototype::powershell_runtime::PowerShellRuntime::prepare_build } else { shellspan_account_sandbox_prototype::powershell_runtime::PowerShellRuntime::prepare }; powershell_runtime = Some(prepare(
                    &fixture.as_ref().ok_or("runtime fixture missing")?.root,
                    &report.actual_source_user_sid, &probe_sid_text(sid.0)?)?);
            }
            if matches!(
                tool,
                shellspan_account_sandbox_prototype::fixed_tool::FixedTool::GitBundle
                    | shellspan_account_sandbox_prototype::fixed_tool::FixedTool::GitBundleInit
            ) {
                git_bundle = Some(
                    shellspan_account_sandbox_prototype::git_bundle::GitBundle::prepare(
                        &fixture.as_ref().ok_or("Git bundle fixture missing")?.root,
                        &report.actual_source_user_sid,
                        &probe_sid_text(sid.0)?,
                    )?,
                );
            }
            let lease = if matches!(
                tool,
                shellspan_account_sandbox_prototype::fixed_tool::FixedTool::PowerShellEtwProbe
                    | shellspan_account_sandbox_prototype::fixed_tool::FixedTool::PowerShell7OwnedEntry
            ) {
                let source = shellspan_account_sandbox_prototype::fixed_tool::ToolImageLease::open(
                    &tool.image()?,
                )?;
                let copy = source.copy_new_owned(
                    &fixture
                        .as_ref()
                        .ok_or("PowerShell diagnostic fixture missing")?
                        .root,
                    if matches!(tool, shellspan_account_sandbox_prototype::fixed_tool::FixedTool::PowerShell7OwnedEntry) { "pwsh.exe" } else { "powershell-etw-probe.exe" },
                )?;
                copy.grant_owned_execution(
                    &report.actual_source_user_sid,
                    &probe_sid_text(sid.0)?,
                )?;
                powershell_probe_source = Some(source);
                copy
            } else {
                shellspan_account_sandbox_prototype::fixed_tool::ToolImageLease::open(
                    &if let Some(runtime) = &powershell_runtime {
                        runtime.image()
                    } else if let Some(bundle) = &git_bundle {
                        bundle.image().to_path_buf()
                    } else if matches!(
                    tool,
                    shellspan_account_sandbox_prototype::fixed_tool::FixedTool::GitDependencyProbe | shellspan_account_sandbox_prototype::fixed_tool::FixedTool::GitPrefixProbe
                ) {
                        fixture
                            .as_ref()
                            .ok_or("dependency probe fixture missing")?
                            .image
                            .clone()
                    } else {
                        tool.image()?
                    },
                )?
            };
            executable = wide(
                lease
                    .identity
                    .path
                    .to_str()
                    .ok_or("invalid fixed tool image")?,
            );
            command = wide(tool.command());
            report.tool_admission = Some(serde_json::json!({"tool":tool,"image":lease.identity,
                "static_imports":lease.static_imports()?,
                "expected_exit":tool.expected_exit(),"scope":"shared-source LPAC admission only; not dedicated-account compatibility acceptance"}));
            if let Some(source) = &powershell_probe_source {
                report
                    .tool_admission
                    .as_mut()
                    .ok_or("owned tool copy report missing")?["owned_copy_source"] =
                    serde_json::to_value(&source.identity).map_err(|e| e.to_string())?;
            }
            if let Some(runtime) = &powershell_runtime {
                let diagnostic = report
                    .tool_admission
                    .as_mut()
                    .ok_or("runtime diagnostic missing")?;
                diagnostic["runtime_file_count"] = serde_json::json!(runtime.files.len());
                diagnostic["runtime_bytes"] = serde_json::json!(runtime.bytes);
                diagnostic["runtime_intent"] = serde_json::json!(fixture
                    .as_ref()
                    .ok_or("runtime fixture missing")?
                    .root
                    .join("powershell-runtime-intent.json"));
            }
            if let Some(bundle) = &git_bundle {
                let diagnostic = report
                    .tool_admission
                    .as_mut()
                    .ok_or("Git bundle diagnostic missing")?;
                diagnostic["bundle_files"] =
                    serde_json::to_value(&bundle.files).map_err(|e| e.to_string())?;
                diagnostic["system_imports"] =
                    serde_json::to_value(&bundle.system_imports).map_err(|e| e.to_string())?;
            }
            tool_image_lease = Some(lease);
            if matches!(
                tool,
                shellspan_account_sandbox_prototype::fixed_tool::FixedTool::GitDependencyProbe
            ) {
                let subject =
                    shellspan_account_sandbox_prototype::fixed_tool::ToolImageLease::open(
                        &shellspan_account_sandbox_prototype::fixed_tool::FixedTool::GitRuntime
                            .image()?,
                    )?;
                dependency_environment =
                    shellspan_account_sandbox_prototype::git_dependency_probe::frozen_environment(
                        &subject,
                    )?;
                report
                    .tool_admission
                    .as_mut()
                    .ok_or("dependency diagnostic missing")?["git_subject"] =
                    serde_json::to_value(&subject.identity).map_err(|e| e.to_string())?;
                git_subject_lease = Some(subject);
            }
        }
        let mut windows = [0u16; 32768];
        let windows_length = unsafe {
            windows_sys::Win32::System::SystemInformation::GetWindowsDirectoryW(
                windows.as_mut_ptr(),
                windows.len() as u32,
            )
        } as usize;
        if windows_length == 0 || windows_length >= windows.len() {
            return Err("fixed Windows directory query failed".into());
        }
        let windows = String::from_utf16_lossy(&windows[..windows_length]);
        // AppContainer creation needs Windows profile expansion variables.
        // Copy only these directory locations, never the ambient environment.
        let user_profile = if tool.is_some() {
            fixture
                .as_ref()
                .ok_or("fixed tool requires owned environment directory")?
                .root
                .join("output")
                .to_string_lossy()
                .into_owned()
        } else {
            std::env::var("USERPROFILE").map_err(|e| e.to_string())?
        };
        let local_app_data = if tool.is_some() {
            user_profile.clone()
        } else {
            std::env::var("LOCALAPPDATA").map_err(|e| e.to_string())?
        };
        let extra = fixture
            .as_ref()
            .map(owned_probe::Fixture::environment)
            .transpose()?
            .unwrap_or_default();
        let lifecycle = if root_failure_trial {
            "SSPA_LIFECYCLE=root-failure\0"
        } else if timeout_trial || cancel_trial {
            "SSPA_LIFECYCLE=timeout\0"
        } else {
            ""
        };
        let tool_environment = if tool.is_some() {
            format!("HOME={user_profile}\0TEMP={user_profile}\0TMP={user_profile}\0GIT_CONFIG_NOSYSTEM=1\0GIT_CONFIG_GLOBAL=NUL\0GIT_TERMINAL_PROMPT=0\0")
        } else {
            String::new()
        };
        let environment: Vec<u16> = format!("{lifecycle}LOCALAPPDATA={local_app_data}\0{extra}{tool_environment}{dependency_environment}SystemRoot={windows}\0USERPROFILE={user_profile}\0WINDIR={windows}\0\0").encode_utf16().collect();
        let environment =
            shellspan_account_sandbox_prototype::fixed_environment::canonicalize(&environment)?;
        let working_directory = if tool.is_some() {
            wide(
                fixture
                    .as_ref()
                    .ok_or("tool fixture missing")?
                    .root
                    .join("output")
                    .to_str()
                    .ok_or("tool working directory invalid")?,
            )
        } else {
            wide(&String::from_utf16_lossy(&system[..length]))
        };
        let owned_job = job()?;
        observer = Some(unsafe {
            JobObserver::start(
                owned_job.0,
                probe_sid_text((*source_user.as_ptr().cast::<TOKEN_USER>()).User.Sid)?,
                probe_sid_text(sid.0)?,
                startup_entries
                    .iter()
                    .map(|entry| Ok((probe_sid_text(entry.Sid)?, entry.Attributes)))
                    .collect::<Result<Vec<_>>>()?,
            )
        }?);
        let mut process = PROCESS_INFORMATION::default();
        win(
            unsafe {
                CreateProcessW(
                    executable.as_ptr(),
                    command.as_mut_ptr(),
                    null(),
                    null(),
                    i32::from(tool.is_some()),
                    CREATE_SUSPENDED
                        | CREATE_NO_WINDOW
                        | CREATE_UNICODE_ENVIRONMENT
                        | EXTENDED_STARTUPINFO_PRESENT,
                    environment.as_ptr().cast(),
                    working_directory.as_ptr(),
                    &startup.StartupInfo,
                    &mut process,
                )
            },
            "create suspended AppContainer fixed cmd",
        )?;
        child = Some((Handle(process.hProcess), Handle(process.hThread), owned_job));
        let (process, thread, job) = child.as_ref().unwrap();
        win(
            unsafe { AssignProcessToJobObject(job.0, process.0) },
            "assign owned candidate Job",
        )?;
        let mut token = null_mut();
        win(
            unsafe { OpenProcessToken(process.0, TOKEN_QUERY | TOKEN_DUPLICATE, &mut token) },
            "open candidate actual Token",
        )?;
        let token = Handle(token);
        let child_user = unsafe { query(token.0, TokenUser) }?;
        report.same_user = unsafe {
            EqualSid(
                (*child_user.as_ptr().cast::<TOKEN_USER>()).User.Sid,
                (*source_user.as_ptr().cast::<TOKEN_USER>()).User.Sid,
            )
        } != 0;
        let integrity = unsafe { query(token.0, TokenIntegrityLevel) }?;
        let integrity_sid = unsafe {
            (*integrity.as_ptr().cast::<TOKEN_MANDATORY_LABEL>())
                .Label
                .Sid
        };
        let count = unsafe { *GetSidSubAuthorityCount(integrity_sid) };
        report.low_integrity = count > 0
            && unsafe { *GetSidSubAuthority(integrity_sid, u32::from(count - 1)) }
                == SECURITY_MANDATORY_LOW_RID as u32;
        let is_app = unsafe { query(token.0, TokenIsAppContainer) }?;
        let actual_sid = unsafe { query(token.0, TokenAppContainerSid) }?;
        let actual = unsafe { &*actual_sid.as_ptr().cast::<TOKEN_APPCONTAINER_INFORMATION>() };
        report.appcontainer_identity = unsafe { *is_app.as_ptr().cast::<u32>() } != 0
            && !actual.TokenAppContainer.is_null()
            && unsafe { EqualSid(actual.TokenAppContainer, sid.0) } != 0;
        let actual_capabilities = unsafe { query(token.0, TokenCapabilities) }?;
        report.capabilities_empty =
            unsafe { (*actual_capabilities.as_ptr().cast::<TOKEN_GROUPS>()).GroupCount } == 0;
        let group = unsafe { &*actual_capabilities.as_ptr().cast::<TOKEN_GROUPS>() };
        let count = group.GroupCount as usize;
        let offset = std::mem::offset_of!(TOKEN_GROUPS, Groups);
        let required = offset + count.min(17) * std::mem::size_of::<SID_AND_ATTRIBUTES>();
        if count > 16 || required > actual_capabilities.len() * std::mem::size_of::<usize>() {
            return Err("actual capability buffer count exceeds bound".into());
        }
        let actual_groups = unsafe { std::slice::from_raw_parts(group.Groups.as_ptr(), count) };
        report.capabilities_verified = exact_capabilities(actual_groups, &startup_entries);
        report.actual_lpac = probe_lpac_behavior(
            token.0,
            unsafe { (*source_user.as_ptr().cast::<TOKEN_USER>()).User.Sid },
            sid.0,
        )?;
        save(&report)?;
        if !report.appcontainer_identity
            || !report.capabilities_verified
            || !report.same_user
            || !report.low_integrity
            || report.actual_lpac != lpac
        {
            return Err("actual candidate identity/capability gate failed".into());
        }
        if let Some(fixture) = &mut fixture {
            fixture.start_receivers()?;
        }
        if unsafe { ResumeThread(thread.0) } == u32::MAX {
            return Err("resume candidate failed".into());
        }
        let wait = if cancel_trial {
            let cancellation = Handle(unsafe { CreateEventW(null(), 1, 0, null()) });
            if cancellation.0.is_null() {
                return Err("create owned cancellation event failed".into());
            }
            let marker = fixture
                .as_ref()
                .ok_or("missing cancellation fixture")?
                .root
                .join("output/descendant-resumed");
            let event_raw = cancellation.0 as usize;
            let request = std::thread::spawn(move || -> bool {
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
                while std::time::Instant::now() < deadline {
                    if std::fs::read(&marker).is_ok_and(|data| data == b"fixed descendant resumed")
                    {
                        return unsafe { SetEvent(event_raw as HANDLE) } != 0;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
                false
            });
            let handles = [process.0, cancellation.0];
            let result = unsafe { WaitForMultipleObjects(2, handles.as_ptr(), 0, 3000) };
            let sent = request
                .join()
                .map_err(|_| "fixed cancellation requester failed")?;
            if !sent || result != WAIT_OBJECT_0 + 1 {
                return Err("owned cancellation event did not interrupt the live root wait".into());
            }
            result
        } else {
            unsafe { WaitForSingleObject(process.0, if timeout_trial { 1500 } else { 10000 }) }
        };
        if timeout_trial || cancel_trial {
            if !cancel_trial && wait != WAIT_TIMEOUT {
                return Err("timeout trial did not observe a live root at deadline".into());
            }
            let fixture = fixture.as_ref().ok_or("missing timeout fixture")?;
            if std::fs::read(fixture.root.join("output/descendant-resumed"))
                .map_err(|e| e.to_string())?
                != b"fixed descendant resumed"
            {
                return Err("fixed descendant resume evidence missing".into());
            }

            let accounting =
                unsafe { shellspan_account_sandbox_prototype::fixture_runner::accounting(job.0) }?;
            report.owned_job_total_processes = Some(accounting.TotalProcesses);
            report.owned_job_process_observations = observer
                .as_mut()
                .ok_or("missing timeout observer")?
                .finish();
            let console = std::path::PathBuf::from(String::from_utf16_lossy(&system[..length]))
                .join("conhost.exe");
            if accounting.ActiveProcesses != 4
                || !verified_fixed_topology(
                    &report.owned_job_process_observations,
                    accounting.TotalProcesses,
                    &fixture.image,
                    &console,
                )
            {
                return Err("timeout requires the complete live confined process tree".into());
            }
            report.lifecycle_timeout_observed = timeout_trial;
            report.lifecycle_cancel_observed = cancel_trial;
            return Ok(());
        }
        if wait != WAIT_OBJECT_0 {
            return Err("candidate fixed entry timed out".into());
        }
        let mut exit = 0;
        win(
            unsafe { GetExitCodeProcess(process.0, &mut exit) },
            "read candidate fixed exit",
        )?;
        if let Some(tool) = tool {
            let accounting =
                unsafe { shellspan_account_sandbox_prototype::fixture_runner::accounting(job.0) }?;
            report.owned_job_total_processes = Some(accounting.TotalProcesses);
            report.owned_job_process_observations =
                observer.as_mut().ok_or("missing tool observer")?.finish();
            let image = &tool_image_lease
                .as_ref()
                .ok_or("missing frozen tool image")?
                .identity
                .path;
            let console = std::path::PathBuf::from(String::from_utf16_lossy(&system[..length]))
                .join("conhost.exe");
            let topology =
                shellspan_account_sandbox_prototype::job_observer::verified_tool_topology(
                    &report.owned_job_process_observations,
                    accounting.TotalProcesses,
                    image,
                    &console,
                );
            let diagnostic = report
                .tool_admission
                .as_mut()
                .ok_or("missing tool diagnostic")?;
            diagnostic["actual_exit"] = serde_json::json!(exit);
            diagnostic["topology_verified"] = serde_json::json!(topology);
            if exit != tool.expected_exit() || !topology {
                return Err(format!(
                    "fixed tool compatibility unverified: exit=0x{exit:08x}; topology={topology}"
                ));
            }
            if matches!(tool, shellspan_account_sandbox_prototype::fixed_tool::FixedTool::PowerShell7RuntimeArtifact | shellspan_account_sandbox_prototype::fixed_tool::FixedTool::PowerShell7RuntimeBuild) {
                let root = &fixture.as_ref().ok_or("missing artifact fixture")?.root;
                diagnostic["artifact"] = serde_json::to_value(shellspan_account_sandbox_prototype::fixed_tool::verify_powershell_artifact(root)?).map_err(|e| e.to_string())?;
                diagnostic["artifact_verified"] = serde_json::json!(true);
            }
            if matches!(
                tool,
                shellspan_account_sandbox_prototype::fixed_tool::FixedTool::GitBundleInit
            ) {
                shellspan_account_sandbox_prototype::fixed_tool::verify_git_init(
                    &fixture.as_ref().ok_or("Git fixture missing")?.root,
                )?;
                diagnostic["repository_verified"] = serde_json::json!(true);
            }
            if matches!(
                tool,
                shellspan_account_sandbox_prototype::fixed_tool::FixedTool::PowerShell7RuntimeBuild
            ) {
                let root = &fixture.as_ref().ok_or("missing compiled DLL fixture")?.root;
                diagnostic["build_dll"] = serde_json::to_value(
                    shellspan_account_sandbox_prototype::fixed_tool::verify_powershell_build_dll(
                        root,
                    )?,
                )
                .map_err(|e| e.to_string())?;
                diagnostic["build_dll_verified"] = serde_json::json!(true);
            }
            return Ok(());
        }
        if root_failure_trial {
            if exit != 0xe7 {
                return Err("fixed root fault exit not observed".into());
            }
            let fixture = fixture.as_ref().ok_or("missing root failure fixture")?;
            if std::fs::read(fixture.root.join("output/descendant-resumed"))
                .map_err(|e| e.to_string())?
                != b"fixed descendant resumed"
            {
                return Err("root fault preceded descendant resume".into());
            }
            let accounting =
                unsafe { shellspan_account_sandbox_prototype::fixture_runner::accounting(job.0) }?;
            report.owned_job_total_processes = Some(accounting.TotalProcesses);
            report.active_processes_after_root_failure = Some(accounting.ActiveProcesses);
            report.owned_job_process_observations =
                observer.as_mut().ok_or("missing fault observer")?.finish();
            let console = std::path::PathBuf::from(String::from_utf16_lossy(&system[..length]))
                .join("conhost.exe");
            if accounting.ActiveProcesses == 0
                || !verified_fixed_topology(
                    &report.owned_job_process_observations,
                    accounting.TotalProcesses,
                    &fixture.image,
                    &console,
                )
            {
                return Err("confined orphan tree unverified after root fault".into());
            }
            report.lifecycle_root_failure_observed = true;
            return Ok(());
        }
        report.entry_exit_73 = exit == 73;
        if !report.entry_exit_73 {
            if let Some(fixture) = &mut fixture {
                report.probe = fixture.observe().ok();
            }
            let diagnostic = fixture
                .as_ref()
                .and_then(|fixture| {
                    std::fs::read_to_string(fixture.root.join("output/child-error.json")).ok()
                })
                .filter(|text| text.len() <= 8192)
                .unwrap_or_default();
            return Err(format!(
                "candidate fixed exit 0x{exit:08x}; diagnostic={diagnostic}"
            ));
        }
        if let Some(fixture) = &mut fixture {
            report.probe = Some(fixture.observe()?);
            if let Some(receivers) = &mut controller_receivers {
                let counts = receivers.finish()?;
                let probe = report.probe.as_mut().ok_or("missing controller probe")?;
                for (index, received) in counts.iter().enumerate() {
                    probe.checks.push(owned_probe::ProbeCheck { name: format!("controller {} receiver {} no traffic", if index < 2 { "TCP" } else { "UDP" }, index % 2), passed: *received == 0, detail: format!("frozen external endpoints; same controller clones passed positive controls before any LPAC launch; received={received}") });
                }
            }

            let probe = report.probe.as_ref().ok_or("missing fixed probe report")?;
            if !probe.complete || probe.checks.iter().any(|check| !check.passed) {
                return Err("fixed file/network probe matrix failed or incomplete".into());
            }
            report.receiver_quietness_verified = !dedicated_account;
            let accounting =
                unsafe { shellspan_account_sandbox_prototype::fixture_runner::accounting(job.0) }?;
            report.owned_job_total_processes = Some(accounting.TotalProcesses);
            report.owned_job_process_observations = observer
                .as_mut()
                .ok_or("missing exact Job observer")?
                .finish();
            let console = std::path::PathBuf::from(String::from_utf16_lossy(&system[..length]))
                .join("conhost.exe");
            if lpac
                && !verified_fixed_topology(
                    &report.owned_job_process_observations,
                    accounting.TotalProcesses,
                    &fixture.image,
                    &console,
                )
            {
                return Err(
                    "fixed Job topology or exact observed Token confinement unverified".into(),
                );
            }
        }
        Ok(())
    })();
    report.error = probe.err();
    if let Some(observer) = &mut observer {
        report.owned_job_process_observations = observer.finish();
    }
    report.process_tree_stopped = child
        .as_ref()
        .is_none_or(|(process, _, job)| unsafe { end_process(process.0, job.0) });
    if report.process_tree_stopped {
        drop(child);
        if let Some(stdio) = tool_stdio.take() {
            match stdio.read_after_stop(tool.expect("stdio is created only for fixed tools")) {
                Ok([stdout, stderr]) => {
                    if let Some(diagnostic) = &mut report.tool_admission {
                        if matches!(tool, Some(shellspan_account_sandbox_prototype::fixed_tool::FixedTool::PowerShellEtwProbe)) {
                            match shellspan_account_sandbox_prototype::powershell_etw_probe::verify_delivery(&stdout) {
                                Ok(observation) => {
                                    diagnostic["etw_delivery_verified"] = serde_json::json!(true);
                                    diagnostic["initializer_succeeded"] = serde_json::json!(observation.initializer_succeeded);
                                }
                                Err(error) => {
                                    diagnostic["etw_delivery_verified"] = serde_json::json!(false);
                                    report.error = Some(error);
                                }
                            }
                        }
                        if matches!(tool, Some(shellspan_account_sandbox_prototype::fixed_tool::FixedTool::GitBundle)) {
                            let valid = shellspan_account_sandbox_prototype::fixed_tool::verified_git_version_output(&stdout, &stderr);
                            diagnostic["output_verified"] = serde_json::json!(valid);
                            if !valid { report.error = Some("fixed Git bundle version output invalid".into()); }
                        }
                        if let Some(subject) = &git_subject_lease {
                            let bound = shellspan_account_sandbox_prototype::git_dependency_probe::verify_delivery(&stdout, subject);
                            diagnostic["dependency_report_bound"] =
                                serde_json::json!(bound.is_ok());
                            if let Err(error) = bound {
                                report.error = Some(format!(
                                    "{}; {error}",
                                    report.error.take().unwrap_or_default()
                                ));
                            }
                        }
                        diagnostic["stdout"] = serde_json::json!(stdout);
                        if matches!(tool, Some(shellspan_account_sandbox_prototype::fixed_tool::FixedTool::GitPrefixProbe)) {
                            let root = &fixture.as_ref().ok_or("Git prefix fixture missing")?.root;
                            let bound = shellspan_account_sandbox_prototype::git_prefix_probe::verify_delivery(&stdout, root);
                            diagnostic["prefix_report_bound"] = serde_json::json!(bound.is_ok());
                            if let Err(error) = bound { report.error = Some(error); }
                        }
                        diagnostic["stderr"] = serde_json::json!(stderr);
                        diagnostic["stdio_handle_count"] = serde_json::json!(3);
                    }
                }
                Err(error) => {
                    report.error = Some(format!(
                        "{}; {error}",
                        report.error.take().unwrap_or_default()
                    ))
                }
            }
            drop(stdio);
        }
        if let Some(fixture) = &fixture {
            // All image leases survive tree retirement, then release before
            // the same fixture's bounded ACL inventory and revocation.
            drop(tool_image_lease.take());
            drop(git_bundle.take());
            drop(powershell_runtime.take());
            let retirement = if matches!(
                tool,
                Some(
                    shellspan_account_sandbox_prototype::fixed_tool::FixedTool::PowerShell7Runtime | shellspan_account_sandbox_prototype::fixed_tool::FixedTool::PowerShell7RuntimeArtifact | shellspan_account_sandbox_prototype::fixed_tool::FixedTool::PowerShell7RuntimeBuild
                )
            ) {
                fixture.revoke_runtime_bound(None)
            } else {
                fixture.revoke()
            };
            match retirement {
                Ok(()) => report.fixture_acls_revoked = true,
                Err(error) => {
                    report.error = Some(format!(
                        "{}; {error}",
                        report.error.take().unwrap_or_default()
                    ))
                }
            }
        }
        // Retire only the freshly created empty OS profile via its lifecycle API.
        // No user paths are deleted and no preexisting profile is adopted.
        let removed = if report.fixture_acls_revoked {
            unsafe { DeleteAppContainerProfile(wide(&name).as_ptr()) }
        } else {
            -1
        };
        report.profile_removed = removed >= 0;
        if removed < 0 {
            let reason = if report.fixture_acls_revoked {
                format!("owned profile cleanup HRESULT=0x{:08x}", removed as u32)
            } else {
                "retain owned profile: fixture ACE cleanup unconfirmed".into()
            };
            report.error = Some(format!(
                "{}; {reason}",
                report.error.take().unwrap_or_default()
            ));
        }
    }
    report.state = if report.process_tree_stopped && report.profile_removed {
        "admission experiment completed; no production acceptance; receipt retained"
    } else {
        "cleanup debt: retain exact owned profile; no automatic rerun"
    }
    .into();
    save(&report)?;
    Ok(report)
}
fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args == ["--owned-fixed-git-prefix-probe"] {
        match shellspan_account_sandbox_prototype::git_prefix_probe::child_report() {
            Ok(report) => {
                println!("{}", report);
                std::process::exit(73);
            }
            Err(error) => {
                eprintln!("fixed Git prefix probe failed: {error}");
                std::process::exit(2);
            }
        }
    }
    if args == ["--owned-fixed-git-dependency-probe"] {
        match shellspan_account_sandbox_prototype::git_dependency_probe::observe() {
            Ok(report) => {
                println!("{}", serde_json::to_string(&report).unwrap());
                std::process::exit(73);
            }
            Err(error) => {
                eprintln!("fixed dependency probe failed: {error}");
                std::process::exit(2);
            }
        }
    }
    if args.len() == 1 {
        if let Some(tool) =
            shellspan_account_sandbox_prototype::fixed_tool::FixedTool::from_source_cli(&args[0])
        {
            match shellspan_account_sandbox_prototype::source_tool_control::run(tool) {
                Ok(report) => println!("{}", serde_json::to_string_pretty(&report).unwrap()),
                Err(error) => eprintln!("source tool control failed: {error}"),
            }
            std::process::exit(2);
        }
    }
    if args == ["--owned-fixed-leaf"] {
        match owned_probe::leaf() {
            Ok(()) => std::process::exit(73),
            Err(error) => {
                eprintln!("fixed leaf failed: {error}");
                std::process::exit(2);
            }
        }
    }
    if args == ["--owned-fixed-probe"] {
        std::panic::set_hook(Box::new(|info| {
            if let Ok(root) = std::env::var("SSPA_FIXTURE") {
                let root = std::path::PathBuf::from(root);
                let owned = root
                    .file_name()
                    .and_then(|name| name.to_str())
                    .and_then(|name| name.strip_prefix("ShellSpan-AC-"))
                    .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok());
                if root.is_absolute() && owned {
                    let diagnostic: String = info.to_string().chars().take(2048).collect();
                    let _ = std::fs::write(
                        root.join("output/child-error.json"),
                        serde_json::json!({"fixed_probe_panic":diagnostic}).to_string(),
                    );
                }
            }
        }));
        match owned_probe::child() {
            Ok(()) => std::process::exit(73),
            Err(error) => {
                eprintln!("fixed probe failed: {error}");
                std::process::exit(2);
            }
        }
    }
    if args != ["--run-owned-profile"]
        && args != ["--run-file-network"]
        && args != ["--run-lpac-file-network"]
        && args != ["--run-lpac-registry-file-network"]
        && args != ["--run-lpac-powershell-etw-instrumentation"]
        && args != ["--run-lpac-powershell-instrumentation"]
        && args != ["--run-lpac-powershell7-runtime-instrumentation"]
        && args != ["--run-lpac-powershell7-runtime-artifact"]
        && args != ["--run-lpac-instrumentation-controller-network"]
        && args != ["--run-lpac-timeout"]
        && args != ["--run-lpac-cancel"]
        && args != ["--run-lpac-root-failure"]
        && args != ["--run-lpac-controller-network"]
        && args != ["--owned-account-lpac"]
        && args != ["--owned-account-lpac-admission"]
        && !(args.len() == 1
            && shellspan_account_sandbox_prototype::fixed_tool::FixedTool::from_cli(&args[0])
                .is_some())
    {
        eprintln!("only explicit owned profile or file/network experiment is supported");
        std::process::exit(2);
    }
    match run(Experiment {
        tool: if args == ["--run-lpac-powershell-etw-instrumentation"] {
            Some(shellspan_account_sandbox_prototype::fixed_tool::FixedTool::PowerShellEtwProbe)
        } else if args == ["--run-lpac-powershell7-runtime-artifact"] {
            Some(shellspan_account_sandbox_prototype::fixed_tool::FixedTool::PowerShell7RuntimeArtifact)
        } else if args == ["--run-lpac-powershell7-runtime-instrumentation"] {
            Some(shellspan_account_sandbox_prototype::fixed_tool::FixedTool::PowerShell7Runtime)
        } else if args == ["--run-lpac-powershell-instrumentation"] {
            Some(shellspan_account_sandbox_prototype::fixed_tool::FixedTool::PowerShell)
        } else {
            args.first().and_then(|value| {
                shellspan_account_sandbox_prototype::fixed_tool::FixedTool::from_cli(value)
            })
        },
        instrumentation: args == ["--run-lpac-powershell-etw-instrumentation"]
            || args == ["--run-lpac-powershell7-build"]
            || args == ["--run-lpac-powershell-instrumentation"]
            || args == ["--run-lpac-powershell7-runtime-instrumentation"]
            || args == ["--run-lpac-powershell7-runtime-artifact"]
            || args == ["--run-lpac-instrumentation-controller-network"],
        file_network: args != ["--run-owned-profile"] && args != ["--owned-account-lpac-admission"],
        lpac: args != ["--run-owned-profile"] && args != ["--run-file-network"],
        registry_read: args != ["--run-owned-profile"]
            && args != ["--run-file-network"]
            && args != ["--run-lpac-file-network"],
        timeout_trial: args == ["--run-lpac-timeout"],
        cancel_trial: args == ["--run-lpac-cancel"],
        root_failure_trial: args == ["--run-lpac-root-failure"],
        controller_network: args == ["--run-lpac-controller-network"]
            || args == ["--run-lpac-instrumentation-controller-network"],
        dedicated_account: args == ["--owned-account-lpac"]
            || args == ["--owned-account-lpac-admission"],
    }) {
        Ok(report) => {
            println!("{}", serde_json::to_string_pretty(&report).unwrap());
            std::process::exit(2);
        }
        Err(error) => {
            eprintln!("candidate NO-GO: {error}");
            std::process::exit(2);
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn actual_external_loopback_keeps_owned_private_receiver_evidence() {
        let receipt: serde_json::Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/design/evidence/windows-stage-a-2026-10-09-private-network-external-loopback.json"))).unwrap();
        assert!(receipt["error"].is_null());
        for key in [
            "profile_removed",
            "fixture_acls_revoked",
            "receiver_quietness_verified",
        ] {
            assert_eq!(receipt[key], true, "{key}");
        }
        let checks = receipt["probe"]["checks"].as_array().unwrap();
        assert_eq!(checks.len(), 142);
        assert!(checks.iter().all(|check| check["passed"] == true));
        for name in [
            "private TCP receiver 0 no traffic",
            "private TCP receiver 1 no traffic",
            "private UDP receiver 0 no traffic",
            "private UDP receiver 1 no traffic",
            "controller TCP receiver 0 no traffic",
            "controller TCP receiver 1 no traffic",
            "controller UDP receiver 0 no traffic",
            "controller UDP receiver 1 no traffic",
        ] {
            let selected: Vec<_> = checks
                .iter()
                .filter(|check| check["name"] == name)
                .collect();
            assert_eq!(selected.len(), 1, "{name}");
            assert!(selected[0]["detail"]
                .as_str()
                .unwrap()
                .ends_with("received=0"));
        }
    }
    use super::*;
    #[test]
    fn actual_new_ads_respects_readonly_secret_and_explicit_workspace_permissions() {
        let receipt: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"), "/../../docs/design/evidence/windows-stage-a-2026-10-09-new-ads-workspace-controller-network.json"
        ))).unwrap();
        assert!(receipt["error"].is_null());
        for key in [
            "entry_exit_73",
            "process_tree_stopped",
            "fixture_acls_revoked",
            "profile_removed",
        ] {
            assert_eq!(receipt[key], true, "{key}");
        }
        assert_eq!(receipt["probe"]["complete"], true);
        let checks = receipt["probe"]["checks"].as_array().unwrap();
        assert_eq!(checks.len(), 126);
        assert!(checks.iter().all(|check| check["passed"] == true));
        for name in [
            "readonly.txt new ADS create denied",
            "secret.txt new ADS create denied",
            "workspace new ADS create/write",
            "workspace new ADS reopen/read",
            "workspace new ADS delete",
        ] {
            let selected: Vec<_> = checks
                .iter()
                .filter(|check| check["name"] == name)
                .collect();
            assert_eq!(selected.len(), 1);
            assert_eq!(
                selected[0]["detail"],
                if name.ends_with("denied") {
                    "actual child operation Win32=Some(5)"
                } else {
                    "actual child operation Win32=None"
                }
            );
        }
    }
    #[test]
    fn actual_default_ordinary_objects_are_readable_without_mutation_rights() {
        let receipt: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../docs/design/evidence/windows-stage-a-2026-10-09-readonly-ordinary-controller-network.json"
        ))).unwrap();
        assert!(receipt["error"].is_null());
        for key in [
            "entry_exit_73",
            "process_tree_stopped",
            "fixture_acls_revoked",
            "profile_removed",
        ] {
            assert_eq!(receipt[key], true, "{key}");
        }
        assert_eq!(receipt["probe"]["complete"], true);
        let checks = receipt["probe"]["checks"].as_array().unwrap();
        assert_eq!(checks.len(), 121);
        assert!(checks.iter().all(|check| check["passed"] == true));
        let expected = [
            "readonly ordinary file read",
            "readonly ordinary file write denied",
            "readonly ordinary file rename denied",
            "readonly ordinary file delete denied",
            "readonly ordinary directory rename denied",
            "readonly ordinary directory delete denied",
        ];
        for name in expected {
            let selected: Vec<_> = checks
                .iter()
                .filter(|check| check["name"] == name)
                .collect();
            assert_eq!(selected.len(), 1, "{name}");
            assert_eq!(
                selected[0]["detail"],
                if name.ends_with("denied") {
                    "actual child operation Win32=Some(5)"
                } else {
                    "actual child operation Win32=None"
                }
            );
        }
    }
    #[test]
    fn actual_independent_sensitivity_overrides_env_exception_and_readonly_rules() {
        let receipt: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../docs/design/evidence/windows-stage-a-2026-10-09-independent-sensitive-controller-network.json"
        ))).unwrap();
        assert!(receipt["error"].is_null());
        for key in [
            "entry_exit_73",
            "process_tree_stopped",
            "fixture_acls_revoked",
            "profile_removed",
        ] {
            assert_eq!(receipt[key], true, "{key}");
        }
        assert_eq!(receipt["probe"]["complete"], true);
        let checks = receipt["probe"]["checks"].as_array().unwrap();
        assert_eq!(checks.len(), 115);
        assert!(checks.iter().all(|check| check["passed"] == true));
        let selected: Vec<_> = checks
            .iter()
            .filter(|check| {
                check["name"]
                    .as_str()
                    .unwrap()
                    .starts_with("independent sensitive ")
            })
            .collect();
        assert_eq!(selected.len(), 7);
        let names: std::collections::BTreeSet<_> = selected
            .iter()
            .map(|check| check["name"].as_str().unwrap())
            .collect();
        assert_eq!(names.len(), 7);
        for check in selected {
            let denied = check["name"].as_str().unwrap().ends_with("denied");
            assert_eq!(
                check["detail"],
                if denied {
                    "actual child operation Win32=Some(5)"
                } else {
                    "actual child operation Win32=None"
                }
            );
        }
    }
    #[test]
    fn actual_new_objects_remain_usable_only_in_explicit_workspace() {
        let receipt: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../docs/design/evidence/windows-stage-a-2026-10-09-new-workspace-objects-controller-network.json"
        ))).unwrap();
        assert!(receipt["error"].is_null());
        for key in [
            "entry_exit_73",
            "process_tree_stopped",
            "fixture_acls_revoked",
            "profile_removed",
        ] {
            assert_eq!(receipt[key], true, "{key}");
        }
        assert_eq!(receipt["probe"]["complete"], true);
        let checks = receipt["probe"]["checks"].as_array().unwrap();
        assert_eq!(checks.len(), 108);
        assert!(checks.iter().all(|check| check["passed"] == true));
        let selected: Vec<_> = checks
            .iter()
            .filter(|check| {
                let name = check["name"].as_str().unwrap();
                name.starts_with("new workspace ") || name.starts_with("readonly project ")
            })
            .collect();
        assert_eq!(selected.len(), 11);
        let names: std::collections::BTreeSet<_> = selected
            .iter()
            .map(|check| check["name"].as_str().unwrap())
            .collect();
        assert_eq!(names.len(), 11);
        for check in selected {
            let denied = check["name"]
                .as_str()
                .unwrap()
                .starts_with("readonly project ");
            assert_eq!(
                check["detail"],
                if denied {
                    "actual child operation Win32=Some(5)"
                } else {
                    "actual child operation Win32=None"
                }
            );
        }
    }
    #[test]
    fn actual_workspace_preserves_protected_objects_and_allows_ordinary_mutation() {
        let receipt: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../docs/design/evidence/windows-stage-a-2026-10-09-workspace-project-controller-network.json"
        ))).unwrap();
        assert!(receipt["error"].is_null());
        for key in [
            "entry_exit_73",
            "process_tree_stopped",
            "fixture_acls_revoked",
            "profile_removed",
        ] {
            assert_eq!(receipt[key], true, "{key}");
        }
        assert_eq!(receipt["probe"]["complete"], true);
        let checks = receipt["probe"]["checks"].as_array().unwrap();
        assert_eq!(checks.len(), 97);
        assert!(checks.iter().all(|check| check["passed"] == true));
        let selected: Vec<_> = checks
            .iter()
            .filter(|check| check["name"].as_str().unwrap().starts_with("workspace "))
            .collect();
        assert_eq!(selected.len(), 13);
        let names: std::collections::BTreeSet<_> = selected
            .iter()
            .map(|check| check["name"].as_str().unwrap())
            .collect();
        assert_eq!(names.len(), 13);
        for check in selected {
            let name = check["name"].as_str().unwrap();
            let denied =
                name.ends_with("denied") || name == "workspace project nested/.env.local read";
            assert_eq!(
                check["detail"],
                if denied {
                    "actual child operation Win32=Some(5)"
                } else {
                    "actual child operation Win32=None"
                }
            );
        }
    }
    #[test]
    fn actual_default_project_policy_requires_readonly_exception_and_sensitive_denials() {
        let receipt: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../docs/design/evidence/windows-stage-a-2026-10-09-default-project-controller-network.json"
        ))).unwrap();
        assert!(receipt["error"].is_null());
        for key in [
            "entry_exit_73",
            "process_tree_stopped",
            "fixture_acls_revoked",
            "profile_removed",
        ] {
            assert_eq!(receipt[key], true, "{key}");
        }
        assert_eq!(receipt["probe"]["complete"], true);
        let checks = receipt["probe"]["checks"].as_array().unwrap();
        assert_eq!(checks.len(), 84);
        assert!(checks.iter().all(|check| check["passed"] == true));
        let selected: Vec<_> = checks
            .iter()
            .filter(|check| {
                check["name"]
                    .as_str()
                    .unwrap()
                    .starts_with("default project ")
            })
            .collect();
        assert_eq!(selected.len(), 8);
        let names: std::collections::BTreeSet<_> = selected
            .iter()
            .map(|check| check["name"].as_str().unwrap())
            .collect();
        assert_eq!(names.len(), 8);
        for check in selected {
            let allowed = matches!(
                check["name"].as_str().unwrap(),
                "default project .env.local read" | "default project rules/config.json read"
            );
            assert_eq!(
                check["detail"],
                if allowed {
                    "actual child operation Win32=None"
                } else {
                    "actual child operation Win32=Some(5)"
                }
            );
        }
    }
    #[test]
    fn actual_parent_directory_boundaries_preserve_ordinary_descendant_operations() {
        let receipt: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../docs/design/evidence/windows-stage-a-2026-10-09-parent-directory-controller-network.json"
        ))).unwrap();
        assert!(receipt["error"].is_null());
        for key in [
            "entry_exit_73",
            "process_tree_stopped",
            "fixture_acls_revoked",
            "profile_removed",
        ] {
            assert_eq!(receipt[key], true, "{key}");
        }
        assert_eq!(receipt["probe"]["complete"], true);
        let checks = receipt["probe"]["checks"].as_array().unwrap();
        assert_eq!(checks.len(), 76);
        assert!(checks.iter().all(|check| check["passed"] == true));
        for name in [
            "ordinary directory create",
            "ordinary directory rename",
            "ordinary directory delete",
            "protected parent DELETE access denied",
            "protected parent rename denied",
        ] {
            let selected: Vec<_> = checks
                .iter()
                .filter(|check| check["name"] == name)
                .collect();
            assert_eq!(selected.len(), 1, "{name}");
            if name.starts_with("protected") {
                assert_eq!(
                    selected[0]["detail"],
                    "actual child operation Win32=Some(5)"
                );
            }
        }
    }
    #[test]
    fn capability_gate_requires_unique_exact_sids_and_attributes() {
        let registry = fixed_startup_capability("registryRead").unwrap();
        let instrumentation = fixed_startup_capability("lpacInstrumentation").unwrap();
        let entry = |sid| SID_AND_ATTRIBUTES {
            Sid: sid,
            Attributes: windows_sys::Win32::System::SystemServices::SE_GROUP_ENABLED as u32,
        };
        let expected = [entry(registry.0), entry(instrumentation.0)];
        assert!(exact_capabilities(&expected, &expected));
        assert!(exact_capabilities(
            &[entry(instrumentation.0), entry(registry.0)],
            &expected
        ));
        assert!(!exact_capabilities(&expected[..1], &expected));
        assert!(!exact_capabilities(
            &[entry(registry.0), entry(registry.0)],
            &expected
        ));
        assert!(!exact_capabilities(
            &[entry(registry.0), entry(registry.0)],
            &[entry(registry.0), entry(registry.0)]
        ));
        let mut wrong = [entry(registry.0), entry(instrumentation.0)];
        wrong[1].Attributes = 0;
        assert!(!exact_capabilities(&wrong, &expected));
        wrong[1].Sid = null_mut();
        assert!(!exact_capabilities(&wrong, &expected));
        assert!(exact_capabilities(&[], &[]));
        assert!(!exact_capabilities(&expected, &[]));
    }
    #[test]
    fn fixed_capability_derivation_refuses_ambient_names() {
        assert!(fixed_startup_capability("internetClient").is_err());
        assert!(fixed_startup_capability("lpacIdentityServices").is_err());
        assert!(fixed_startup_capability("lpacCryptoServices").is_err());
        assert!(fixed_startup_capability("registryRead").is_ok());
        assert!(fixed_startup_capability("lpacInstrumentation").is_ok());
    }
    #[test]
    fn actual_instrumentation_matrix_keeps_all_frozen_checks_and_cleanup() {
        let report: serde_json::Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/design/evidence/windows-stage-a-2026-10-09-instrumentation-controller-network.json"))).unwrap();
        let baseline: serde_json::Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/design/evidence/windows-stage-a-2026-10-09-controller-refactor-lpac-registry-file-network.json"))).unwrap();
        let checks = report["probe"]["checks"].as_array().unwrap();
        assert_eq!(checks.len(), 71);
        assert!(checks.iter().all(|c| c["passed"] == true));
        let names = checks
            .iter()
            .map(|c| c["name"].as_str().unwrap())
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(names.len(), checks.len());
        for check in baseline["probe"]["checks"].as_array().unwrap() {
            assert!(
                names.contains(check["name"].as_str().unwrap())
                    || names.contains(
                        format!("controller {}", check["name"].as_str().unwrap()).as_str()
                    ),
                "missing check {}",
                check["name"]
            );
        }
        assert!(report["error"].is_null());
        assert_eq!(
            report["requested_capabilities"],
            serde_json::json!(["registryRead", "lpacInstrumentation"])
        );
        for field in [
            "capabilities_verified",
            "actual_lpac",
            "process_tree_stopped",
            "fixture_acls_revoked",
            "profile_removed",
            "receiver_quietness_verified",
            "entry_exit_73",
        ] {
            assert_eq!(report[field], true, "{field}");
        }
        assert_eq!(report["probe"]["complete"], true);
        assert_eq!(report["production"], "unavailable");
    }
}
