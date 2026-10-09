//! Fixed SDK creation from the controller with an explicit dedicated-account Token.
use super::*;
use shellspan_account_sandbox_prototype::appcontainer_probe::{Fixture, ProbeReport};
use shellspan_account_sandbox_prototype::credential_reference::OWNED_CREDENTIAL_DENIAL_CHECK;
use shellspan_account_sandbox_prototype::fixed_tool::{FixedTool, ToolImageLease, ToolStdio};
use shellspan_account_sandbox_prototype::job_observer::{
    verified_concurrent_topology, verified_fixed_topology, verified_tool_topology, JobObserver,
};
use windows_sys::Win32::Security::Isolation::*;
use windows_sys::Win32::System::SystemServices::SE_GROUP_ENABLED;

struct Impersonation;
fn verified_ordinary_credential_observation(
    observation: &shellspan_account_sandbox_prototype::appcontainer_probe::CredentialPrimaryObservation,
    id: Uuid,
    user_sid: &str,
) -> bool {
    observation.version == 1
        && observation.fixture_id == id
        && observation.user_sid == user_sid
        && (observation.denial_win32.is_some() != observation.error.is_some())
}
// Contract of this fixed prototype workload, not a declaration of full A/B coverage.
const FIXED_PROBE_CHECKS: &[&str] = &[
    "sensitive file short-name read denied",
    "sensitive file short-name write denied",
    "readonly.txt short-root read",
    "readonly.txt short-root write",
    "workspace.txt short-root read",
    "workspace.txt short-root write",
    "secret.txt short-root read",
    "secret.txt short-root write",
    "descendant network: actual Winsock initialization",
    "descendant network: TCP 0 denied",
    "descendant network: UDP 0 API observation",
    "descendant network: TCP 1 denied",
    "descendant network: UDP 1 API observation",
    "descendant network: TCP listener 0 denied",
    "descendant network: TCP listener 1 denied",
    "descendant network: private TCP 0 denied",
    "descendant network: private UDP 0 API observation",
    "descendant network: private TCP 1 denied",
    "descendant network: private UDP 1 API observation",
    "descendant network: DNS UDP API denied",
    "descendant network: DNS TCP API denied",
    "descendant network: DNS numeric local API control",
    "descendant network: DNS cache-only API admission",
    "descendant network: DNS self-context comparison",
    "descendant network: DNS legacy cache-only API admission",
    "readonly.txt read",
    "readonly.txt write",
    "workspace.txt read",
    "workspace.txt write",
    "secret.txt read",
    "secret.txt write",
    "external.txt read",
    "external.txt write",
    "external-aap.txt read",
    "external-aap.txt write",
    "artifact create/write/close",
    "artifact reopen/read",
    "artifact reopen/write",
    "private registry read denied",
    "private registry write denied",
    "explicit Job breakaway denied",
    "descendant user identity",
    "descendant package identity",
    "descendant low integrity",
    "descendant exact capabilities",
    "descendant actual LPAC",
    "descendant Job membership",
    "fixed descendant exit",
    "readonly.txt hardlink alias denied",
    "secret.txt hardlink alias denied",
    "Everyone-only external file read denied",
    "Everyone-only external file write denied",
    "ordinary artifact rename",
    "ordinary renamed artifact delete",
    "default project .env.local read",
    "default project .env.local write denied",
    "default project nested/.env.local read",
    "default project nested/.env.local write denied",
    "default project rules/config.json read",
    "default project rules/config.json write denied",
    "default project rules directory DELETE denied",
    "default project nested directory DELETE denied",
    "workspace project .env.local read",
    "workspace project .env.local write denied",
    "workspace project nested/.env.local read",
    "workspace project nested/.env.local write denied",
    "workspace project rules/config.json read",
    "workspace project rules/config.json write denied",
    "workspace project rules directory DELETE denied",
    "workspace project nested directory DELETE denied",
    "workspace ordinary file write",
    "workspace ordinary file rename",
    "workspace ordinary file delete",
    "workspace ordinary directory rename",
    "workspace ordinary directory delete",
    "new workspace file create/write",
    "new workspace file reopen/read",
    "new workspace file rename",
    "new workspace file delete",
    "new workspace directory create",
    "new workspace nested file create/write",
    "new workspace nested file delete",
    "new workspace directory rename",
    "new workspace directory delete",
    "readonly project file create denied",
    "readonly project directory create denied",
    "independent sensitive root env read denied",
    "independent sensitive root env write denied",
    "independent sensitive rules overlap read denied",
    "independent sensitive rules overlap write denied",
    "independent sensitive ordinary read control",
    "independent sensitive ordinary write control",
    "independent sensitive parent DELETE denied",
    "readonly ordinary file read",
    "readonly ordinary file write denied",
    "readonly ordinary file rename denied",
    "readonly ordinary file delete denied",
    "readonly ordinary directory rename denied",
    "readonly ordinary directory delete denied",
    "readonly.txt new ADS create denied",
    "secret.txt new ADS create denied",
    "workspace new ADS create/write",
    "workspace new ADS reopen/read",
    "workspace new ADS delete",
    "ordinary directory create",
    "ordinary directory rename",
    "ordinary directory delete",
    "protected parent DELETE access denied",
    "protected parent rename denied",
    "protected child read denied",
    "protected child write denied",
    "protected child rename denied",
    "protected child delete denied",
    "readonly.txt ADS read",
    "readonly.txt ADS write",
    "workspace.txt ADS read",
    "workspace.txt ADS write",
    "secret.txt ADS read",
    "secret.txt ADS write",
    "Winsock registry read admission: SYSTEM\\CurrentControlSet\\Services\\WinSock2\\Parameters",
    "Winsock registry read admission: SYSTEM\\CurrentControlSet\\Services\\WinSock2\\Parameters\\Protocol_Catalog9",
    "Winsock registry read admission: SYSTEM\\CurrentControlSet\\Services\\WinSock2\\Parameters\\NameSpace_Catalog5",
    "actual Winsock initialization",
    "TCP 0 denied",
    "TCP listener 0 denied",
    "TCP listener 1 denied",
    "private TCP 0 denied",
    "private UDP 0 API observation",
    "private TCP 1 denied",
    "private UDP 1 API observation",
    "private TCP receiver 0 no traffic",
    "private TCP receiver 1 no traffic",
    "private UDP receiver 0 no traffic",
    "private UDP receiver 1 no traffic",
    "DNS UDP API denied",
    "DNS TCP API denied",
    "DNS numeric local API control",
    "DNS cache-only API admission",
    "DNS self-context comparison",
    "DNS legacy cache-only API admission",
    "DNS UDP receiver no traffic",
    "DNS TCP receiver no traffic",
    "UDP 0 API observation",
    "TCP 1 denied",
    "UDP 1 API observation",
    "controller memory read handle denied",
    "controller memory write handle denied",
    "controller memory operation handle denied",
    "controller thread creation handle denied",
    "controller handle duplication handle denied",
    "controller termination handle denied",
    "controller verified protected child survived unchanged",
    "TCP receiver 0 no traffic",
    "TCP receiver 1 no traffic",
    "UDP receiver 0 no traffic",
    "UDP receiver 1 no traffic",
];
const CREDENTIAL_PROBE_CHECKS: &[&str] = &[
    "fixed local RPC client binding created and released",
    "fixed local RPC client authentication configured without server invocation",
    OWNED_CREDENTIAL_DENIAL_CHECK,
];
fn verified_fixed_probe(probe: &ProbeReport, credential_required: bool) -> bool {
    probe.complete
        && probe.checks.iter().all(|check| check.passed)
        && probe.checks.len()
            == FIXED_PROBE_CHECKS.len()
                + if credential_required {
                    CREDENTIAL_PROBE_CHECKS.len()
                } else {
                    0
                }
        && FIXED_PROBE_CHECKS
            .iter()
            .chain(if credential_required {
                CREDENTIAL_PROBE_CHECKS
            } else {
                &[]
            })
            .all(|name| {
                probe
                    .checks
                    .iter()
                    .filter(|check| check.name == *name)
                    .count()
                    == 1
            })
}
const INTERRUPTED_PROBE_CHECKS: &[&str] = &[
    "readonly.txt read",
    "readonly.txt write",
    "workspace.txt read",
    "workspace.txt write",
    "secret.txt read",
    "secret.txt write",
    "external.txt read",
    "external.txt write",
    "external-aap.txt read",
    "external-aap.txt write",
    "artifact create/write/close",
    "artifact reopen/read",
    "artifact reopen/write",
    "TCP receiver 0 no traffic",
    "TCP receiver 1 no traffic",
    "UDP receiver 0 no traffic",
    "UDP receiver 1 no traffic",
];
fn verified_interrupted_probe(probe: &ProbeReport) -> bool {
    !probe.complete
        && probe.checks.len() == INTERRUPTED_PROBE_CHECKS.len()
        && probe.checks.iter().all(|check| check.passed)
        && INTERRUPTED_PROBE_CHECKS.iter().all(|name| {
            probe
                .checks
                .iter()
                .filter(|check| check.name == *name)
                .count()
                == 1
        })
}
impl Drop for Impersonation {
    fn drop(&mut self) {
        if unsafe { RevertToSelf() } == 0 {
            std::process::abort();
        }
    }
}
fn as_account<T>(token: HANDLE, operation: impl FnOnce() -> Result<T>) -> Result<T> {
    let mut existing = null_mut();
    if unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 1, &mut existing) } != 0 {
        drop(Handle(existing));
        return Err("controller already impersonating; no context adoption".into());
    }
    if unsafe { GetLastError() } != ERROR_NO_TOKEN {
        return Err("controller thread identity unavailable".into());
    }
    win(
        unsafe { ImpersonateLoggedOnUser(token) },
        "enter exact owned account context",
    )?;
    let guard = Impersonation;
    let mut actual = null_mut();
    win(
        unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 1, &mut actual) },
        "verify scoped target thread Token",
    )?;
    let actual = Handle(actual);
    if token_sid(actual.0)? != token_sid(token)? {
        return Err("scoped thread identity differs from frozen source Token".into());
    }
    let result = operation();
    drop(guard);
    result
}
struct Package(PSID);
impl Drop for Package {
    fn drop(&mut self) {
        unsafe {
            FreeSid(self.0);
        }
    }
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
fn exact_startup_capabilities(
    actual: &[SID_AND_ATTRIBUTES],
    expected: &[SID_AND_ATTRIBUTES],
) -> bool {
    if actual.len() != expected.len() || actual.len() > 16 {
        return false;
    }
    if !actual
        .iter()
        .chain(expected)
        .all(|entry| !entry.Sid.is_null() && unsafe { IsValidSid(entry.Sid) != 0 })
    {
        return false;
    }
    let same = |left: &SID_AND_ATTRIBUTES, right: &SID_AND_ATTRIBUTES| unsafe {
        EqualSid(left.Sid, right.Sid) != 0
    };
    for entries in [actual, expected] {
        if entries
            .iter()
            .enumerate()
            .any(|(index, entry)| entries[..index].iter().any(|prior| same(entry, prior)))
        {
            return false;
        }
    }
    expected.iter().all(|entry| {
        actual
            .iter()
            .any(|observed| same(entry, observed) && entry.Attributes == observed.Attributes)
    })
}
fn startup_capability(name: &str) -> Result<Local> {
    if !shellspan_account_sandbox_prototype::startup_capability_policy::permitted(name) {
        return Err("unsupported fixed startup capability".into());
    }
    let mut groups = null_mut();
    let mut capabilities = null_mut();
    let mut group_count = 0;
    let mut count = 0;
    win(
        unsafe {
            DeriveCapabilitySidsFromName(
                wide(name).as_ptr(),
                &mut groups,
                &mut group_count,
                &mut capabilities,
                &mut count,
            )
        },
        "derive fixed controller startup capability",
    )?;
    if group_count > 16 || count > 16 {
        return Err("capability derivation budget exceeded".into());
    }
    unsafe {
        for index in 0..group_count {
            LocalFree(*groups.add(index as usize));
        }
        LocalFree(groups.cast());
    }
    let retained = if count == 1 && !capabilities.is_null() {
        unsafe { *capabilities }
    } else {
        null_mut()
    };
    unsafe {
        if retained.is_null() {
            for index in 0..count {
                LocalFree(*capabilities.add(index as usize));
            }
        }
        LocalFree(capabilities.cast());
    }
    if retained.is_null() {
        return Err("registryRead SID derivation did not yield one capability".into());
    }
    Ok(Local(retained))
}
fn query(token: HANDLE, class: TOKEN_INFORMATION_CLASS) -> Result<Vec<usize>> {
    let mut bytes = 0;
    unsafe {
        GetTokenInformation(token, class, null_mut(), 0, &mut bytes);
    }
    if bytes == 0 || bytes > 65536 {
        return Err("controller Token query budget invalid".into());
    }
    let mut storage = vec![0usize; (bytes as usize).div_ceil(std::mem::size_of::<usize>())];
    win(
        unsafe {
            GetTokenInformation(token, class, storage.as_mut_ptr().cast(), bytes, &mut bytes)
        },
        "query actual controller-created Token",
    )?;
    Ok(storage)
}
fn actual_lpac(token: HANDLE, account: &str, package: &str) -> Result<bool> {
    let mut raw = null_mut();
    win(
        unsafe {
            DuplicateTokenEx(
                token,
                TOKEN_QUERY,
                null(),
                SecurityImpersonation,
                TokenImpersonation,
                &mut raw,
            )
        },
        "duplicate actual LPAC Token for AccessCheck",
    )?;
    let token = Handle(raw);
    let access = |subject: &str| -> Result<bool> {
        let (sd, _) = descriptor(&format!("O:SYG:SYD:(A;;FR;;;{account})(A;;FR;;;{subject})"))?;
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
        win(
            unsafe {
                AccessCheck(
                    sd.0,
                    token.0,
                    FILE_READ_DATA,
                    &mapping,
                    privileges.as_mut_ptr().cast(),
                    &mut bytes,
                    &mut granted,
                    &mut allowed,
                )
            },
            "check actual package/AAP access",
        )?;
        Ok(allowed != 0)
    };
    if !access(package)? {
        return Err("actual package positive control failed".into());
    }
    Ok(!access("S-1-15-2-1")?)
}

fn controller_privileges() -> Result<serde_json::Value> {
    let mut raw = null_mut();
    win(
        unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) },
        "inspect controller privilege membership",
    )?;
    let token = Handle(raw);
    let storage = query(token.0, TokenPrivileges)?;
    let privileges = unsafe { &*storage.as_ptr().cast::<TOKEN_PRIVILEGES>() };
    let count = privileges.PrivilegeCount as usize;
    let offset = std::mem::offset_of!(TOKEN_PRIVILEGES, Privileges);
    let capacity = std::mem::size_of_val(storage.as_slice());
    if count > 256 || offset + count * std::mem::size_of::<LUID_AND_ATTRIBUTES>() > capacity {
        return Err("controller privilege membership budget invalid".into());
    }
    let entries = unsafe { std::slice::from_raw_parts(privileges.Privileges.as_ptr(), count) };
    let mut result = serde_json::Map::new();
    for name in [
        "SeAssignPrimaryTokenPrivilege",
        "SeIncreaseQuotaPrivilege",
        "SeImpersonatePrivilege",
    ] {
        let mut luid = LUID::default();
        win(
            unsafe { LookupPrivilegeValueW(null(), wide(name).as_ptr(), &mut luid) },
            "resolve fixed controller privilege",
        )?;
        let entry = entries.iter().find(|entry| {
            entry.Luid.LowPart == luid.LowPart && entry.Luid.HighPart == luid.HighPart
        });
        result.insert(name.into(), serde_json::json!({"present":entry.is_some(), "enabled":entry.is_some_and(|entry| entry.Attributes & SE_PRIVILEGE_ENABLED != 0)}));
    }
    Ok(serde_json::Value::Object(result))
}
pub(super) fn run(
    receipt: &mut ProfileReceipt,
    login: &Handle,
    config: &crate::runner::Config,
) -> Result<()> {
    let cross_slot_control =
        if receipt.controller_tool == Some(FixedSystemTool::CrossSlotRegistryProbe) {
            Some(super::verify_fixed_cross_slot_registry_targets()?)
        } else {
            None
        };
    let _privilege = runtime_grants::RestorePrivilege::enable_named("SeImpersonatePrivilege")?;
    let name = format!("ShellSpan-candidate-{}", receipt.fixture_id.simple());
    let account = receipt
        .account_sid
        .as_deref()
        .ok_or("controller account SID missing")?
        .to_owned();
    let package_text = receipt
        .planned_package_sid
        .as_deref()
        .ok_or("controller package SID missing")?
        .to_owned();
    let expected = sid(&package_text)?;
    if matches!(
        receipt.controller_tool,
        Some(
            FixedSystemTool::NodePackageBlock
                | FixedSystemTool::NodeRpcBlock
                | FixedSystemTool::DnsPackageBlockProbe
                | FixedSystemTool::DnsPackageBlockInternetProbe
                | FixedSystemTool::DnsRpcBlockInternetProbe
                | FixedSystemTool::DnsRpcInstrumentationInternetProbe
                | FixedSystemTool::DnsRpcInstrumentationDefaultProbe
        )
    ) {
        if receipt.package_network_intent.is_some() {
            return Err("fixed package block installation cannot repeat".into());
        }
        receipt.package_network_intent = Some(
            shellspan_account_sandbox_prototype::package_network_intent::PackageNetworkIntent {
                version: 1,
                fixture_id: receipt.fixture_id,
                package_sid: package_text.clone(),
                filter_keys: std::array::from_fn(|_| Uuid::new_v4()),
            },
        );
        receipt.state = "planned four independent package blocks before LPAC creation".into();
        receipt.save()?;
        let network = engine()?;
        unsafe {
            shellspan_account_sandbox_prototype::package_network_filter::change_owned(
                network.0,
                receipt.package_network_intent.as_ref().unwrap(),
                receipt.fixture_id,
                &receipt.filter_keys,
                expected.0,
                true,
            )
        }?;
        receipt.state = "four exact package blocks installed; account blocks retained".into();
        receipt.save()?;
    }
    if matches!(
        receipt.controller_tool,
        Some(
            FixedSystemTool::NodeRpcBlock
                | FixedSystemTool::DnsRpcBlockInternetProbe
                | FixedSystemTool::DnsRpcInstrumentationInternetProbe
                | FixedSystemTool::DnsRpcInstrumentationDefaultProbe
        )
    ) {
        if receipt.rpc_network_intent.is_some() {
            return Err("fixed RPC installation cannot repeat".into());
        }
        receipt.rpc_network_intent = Some(
            shellspan_account_sandbox_prototype::rpc_network_intent::RpcNetworkIntent {
                version: 1,
                fixture_id: receipt.fixture_id,
                account_sid: account.clone(),
                filter_key: Uuid::new_v4(),
            },
        );
        receipt.state = "planned exact account RPC block before LPAC creation".into();
        receipt.save()?;
        let package = receipt
            .package_network_intent
            .as_ref()
            .ok_or("RPC package protection intent missing")?;
        let mut keys = receipt.filter_keys.to_vec();
        keys.extend(package.filter_keys);
        let subject = sid(&account)?;
        let (sd, size) = descriptor(&format!("D:(A;;CC;;;{account})"))?;
        let mut blob = FWP_BYTE_BLOB {
            size,
            data: sd.0.cast(),
        };
        let network = engine()?;
        unsafe {
            shellspan_account_sandbox_prototype::rpc_network_filter::change_owned(
                network.0,
                receipt.rpc_network_intent.as_ref().unwrap(),
                receipt.fixture_id,
                &keys,
                subject.0,
                &mut blob,
                true,
            )
        }?;
        receipt.state = "exact account RPC block installed; other protections retained".into();
        receipt.save()?;
    }
    receipt.account_lpac_started = true;
    receipt.state =
        "planned profile creation under exact source Token; fixed SDK controller admission only"
            .into();
    receipt.save()?;
    let mut package = null_mut();
    let created = as_account(login.0, || {
        let result = unsafe {
            CreateAppContainerProfile(
                wide(&name).as_ptr(),
                wide(&name).as_ptr(),
                wide("owned controller admission").as_ptr(),
                null(),
                0,
                &mut package,
            )
        };
        if result < 0 {
            return Err(format!(
                "controller-owned profile creation HRESULT=0x{:08x}",
                result as u32
            ));
        }
        Ok(())
    });
    if created.is_err() {
        receipt.account_lpac_cleanup_verified = false;
        receipt.save()?;
        return created;
    }
    let package = Package(package);
    let mut report = serde_json::json!({"production":"unavailable","scope":"controller fixed System32 admission only","actual_user_verified":false,"actual_package_verified":false,
        "actual_capabilities_verified":false,"actual_low_integrity":false,"actual_lpac":false,"root_exit_73":false,
        "process_tree_stopped":true,"profile_removed":false,"profile_folder":null,"profile_folder_in_dedicated_account":false,"error":null});
    let mut child = None;
    let mut rpc_trace = None;
    if let Some(control) = cross_slot_control {
        report["cross_slot_control"] = control;
    }
    let mut source_process = None;
    let mut source_token = None;
    let mut fixture = None;
    let mut tool_bundle = None;
    let mut powershell_runtime = None;
    let mut tool_image_lease = None;
    let mut tool_stdio = None;
    let fixed_tool = receipt
        .controller_tool
        .and_then(FixedSystemTool::fixed_tool);
    let owned_job = crate::runner::job()?;
    let baseline_job = crate::runner::job()?;
    let mut observer = None;
    let experiment = (|| -> Result<()> {
        report["controller_privileges_before_creation"] = controller_privileges()?;
        if receipt.controller_workload_requested {
            let parent = fixture_parent()?;
            receipt.controller_workload_planned_root = Some(
                parent
                    .join(format!("ShellSpan-AC-{}", receipt.fixture_id.simple()))
                    .display()
                    .to_string(),
            );
            receipt.save()?;
            let source = sid(&account)?;
            let prepared = unsafe {
                Fixture::prepare_at(&name, package.0, source.0, &parent, receipt.fixture_id)
            }?;
            fixture = Some(prepared);
            let workload = fixture.as_mut().ok_or("controller workload missing")?;
            receipt.controller_workload_fixture = Some(profile_object(&workload.root)?);
            receipt.save()?;
            as_account(login.0, || workload.bind_current_registry())?;
            unsafe { workload.populate(source.0) }?;
            as_account(login.0, || workload.verify_source_controls())?;
            report["source_file_registry_controls_verified"] = serde_json::json!(true);
            if receipt.credential_reference_verified {
                let reference = shellspan_account_sandbox_prototype::credential_reference::OwnedCredentialReference::new(receipt.fixture_id, &account)?;
                let comparison =
                    as_account(login.0, || reference.probe_plain_account_denial(&account));
                report["ordinary_account_credential_comparison"] = serde_json::json!({
                    "context": "exact owned account impersonation; not primary child evidence",
                    "denial_win32": comparison.as_ref().ok(),
                    "error": comparison.as_ref().err(),
                });
            }
            workload.start_receivers()?;
            if receipt.controller_lifecycle == FixedLifecycle::Normal && fixed_tool.is_none() {
                workload.start_fixed_private_receivers()?;
                workload.start_fixed_dns_receiver()?;
            }
            if matches!(
                receipt.controller_tool,
                Some(FixedSystemTool::GitBundle | FixedSystemTool::GitBundleInit)
            ) {
                tool_bundle = Some(
                    shellspan_account_sandbox_prototype::git_bundle::GitBundle::prepare(
                        &workload.root,
                        &account,
                        &package_text,
                    )?,
                );
                let bundle = tool_bundle
                    .as_ref()
                    .ok_or("dedicated tool bundle missing")?;
                report["tool_admission"] = serde_json::json!({"tool":"git_bundle",
                    "files":bundle.files,"system_imports":bundle.system_imports,
                    "scope":"fixed dedicated-account Git --version only; not complete stage A"});
            }
            if receipt
                .controller_tool
                .is_some_and(FixedSystemTool::uses_powershell_runtime)
            {
                let prepare = if matches!(fixed_tool, Some(FixedTool::PowerShell7RuntimeBuild)) {
                    shellspan_account_sandbox_prototype::powershell_runtime::PowerShellRuntime::prepare_build
                } else {
                    shellspan_account_sandbox_prototype::powershell_runtime::PowerShellRuntime::prepare
                };
                powershell_runtime = Some(prepare(&workload.root, &account, &package_text)?);
                let runtime = powershell_runtime
                    .as_ref()
                    .ok_or("dedicated PowerShell runtime missing")?;
                report["tool_admission"] = serde_json::json!({"tool":"power_shell7_runtime", "runtime_file_count":runtime.files.len(), "runtime_bytes":runtime.bytes, "scope":"fixed dedicated-account PowerShell startup only; not complete stage A"});
            }
            if let Some(tool) = fixed_tool {
                let image = powershell_runtime
                    .as_ref()
                    .map(|runtime| runtime.image().to_path_buf())
                    .or_else(|| {
                        tool_bundle
                            .as_ref()
                            .map(|bundle| bundle.image().to_path_buf())
                    })
                    .or_else(|| {
                        matches!(
                            tool,
                            FixedTool::GitPrefixProbe | FixedTool::CrossSlotRegistryProbe
                        )
                        .then(|| workload.image.clone())
                    })
                    .map_or_else(|| tool.image(), Ok)?;
                let lease = ToolImageLease::open(&image)?;
                if report["tool_admission"].is_null() {
                    report["tool_admission"] = serde_json::json!({"tool":tool,
                        "scope":"fixed dedicated-account tool startup only; not complete stage A"});
                }
                report["tool_admission"]["image"] =
                    serde_json::to_value(&lease.identity).map_err(|e| e.to_string())?;
                report["tool_admission"]["static_imports"] =
                    serde_json::json!(lease.static_imports()?);
                report["tool_admission"]["expected_exit"] = serde_json::json!(tool.expected_exit());
                tool_image_lease = Some(lease);
                tool_stdio = Some(ToolStdio::prepare(&workload.root)?);
            }
            report["scope"] = serde_json::json!(if fixed_tool.is_some() {
                "controller fixed dedicated-account tool admission; incomplete stage A matrix"
            } else {
                "controller fixed file/registry/loopback workload; incomplete stage A matrix"
            });
            report["fixture"] = serde_json::json!(workload.root);
        }
        if package.0.is_null() || unsafe { EqualSid(package.0, expected.0) } == 0 {
            return Err("actual created package SID mismatch".into());
        }
        let folder = as_account(login.0, || {
            let mut raw = null_mut();
            let code = unsafe { GetAppContainerFolderPath(wide(&package_text).as_ptr(), &mut raw) };
            if code < 0 {
                return Err(format!(
                    "query source account package folder HRESULT=0x{:08x}",
                    code as u32
                ));
            }
            struct TaskMem(*mut c_void);
            impl Drop for TaskMem {
                fn drop(&mut self) {
                    unsafe {
                        windows_sys::Win32::System::Com::CoTaskMemFree(self.0);
                    }
                }
            }
            let _storage = TaskMem(raw.cast());
            if raw.is_null() {
                return Err("package folder API returned no path".into());
            }
            let mut length = 0;
            unsafe {
                while length < 32768 && *raw.add(length) != 0 {
                    length += 1;
                }
            }
            if length == 32768 {
                return Err("package folder path exceeds budget".into());
            }
            Ok(PathBuf::from(unsafe {
                String::from_utf16_lossy(std::slice::from_raw_parts(raw, length))
            }))
        })?;
        report["profile_folder"] = serde_json::json!(folder);
        let profile = Path::new(
            &receipt
                .profile
                .as_ref()
                .ok_or("source profile identity missing")?
                .path,
        );
        let normalized = fs::canonicalize(&folder).map_err(|e| e.to_string())?;
        let source_profile = fs::canonicalize(profile).map_err(|e| e.to_string())?;
        if !normalized.starts_with(&source_profile) {
            return Err("profile API resolved outside dedicated account; refuse launch".into());
        }
        report["profile_folder_in_dedicated_account"] = serde_json::json!(true);
        let capability = startup_capability("registryRead")?;
        let instrumentation = if receipt
            .controller_tool
            .is_some_and(FixedSystemTool::uses_instrumentation)
        {
            Some(startup_capability("lpacInstrumentation")?)
        } else {
            None
        };
        let mut entries = vec![SID_AND_ATTRIBUTES {
            Sid: capability.0,
            Attributes: SE_GROUP_ENABLED as u32,
        }];
        if let Some(capability) = &instrumentation {
            entries.push(SID_AND_ATTRIBUTES {
                Sid: capability.0,
                Attributes: SE_GROUP_ENABLED as u32,
            });
        }
        let internet = if receipt
            .controller_tool
            .is_some_and(FixedSystemTool::uses_diagnostic_internet)
        {
            if receipt.package_network_intent.is_none() {
                return Err("DNS diagnostic requires protected package block intent".into());
            }
            // Fixed well-known internetClient SID only, never the default policy.
            let capability = sid("S-1-15-3-1")?;
            entries.push(SID_AND_ATTRIBUTES {
                Sid: capability.0,
                Attributes: SE_GROUP_ENABLED as u32,
            });
            report["diagnostic_internet_client"] = serde_json::json!(true);
            Some(capability)
        } else {
            None
        };
        let security = SECURITY_CAPABILITIES {
            AppContainerSid: package.0,
            Capabilities: entries.as_mut_ptr(),
            CapabilityCount: entries.len() as u32,
            Reserved: 0,
        };
        let mut bytes = 0;
        unsafe {
            InitializeProcThreadAttributeList(
                null_mut(),
                if tool_stdio.is_some() { 3 } else { 2 },
                0,
                &mut bytes,
            );
        }
        if bytes == 0 || bytes > 65536 {
            return Err("controller attribute budget invalid".into());
        }
        let mut attributes = Attributes {
            storage: vec![0usize; bytes.div_ceil(std::mem::size_of::<usize>())],
            live: false,
        };
        win(
            unsafe {
                InitializeProcThreadAttributeList(
                    attributes.storage.as_mut_ptr().cast(),
                    if tool_stdio.is_some() { 3 } else { 2 },
                    0,
                    &mut bytes,
                )
            },
            "initialize fixed controller attributes",
        )?;
        attributes.live = true;
        let mut opt_out = 1u32;
        for (key, value, length) in [
            (
                PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
                (&security as *const SECURITY_CAPABILITIES).cast::<c_void>(),
                std::mem::size_of_val(&security),
            ),
            (
                PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY as usize,
                (&mut opt_out as *mut u32).cast::<c_void>().cast_const(),
                std::mem::size_of_val(&opt_out),
            ),
        ] {
            win(
                unsafe {
                    UpdateProcThreadAttribute(
                        attributes.storage.as_mut_ptr().cast(),
                        0,
                        key,
                        value,
                        length,
                        null_mut(),
                        null(),
                    )
                },
                "set fixed controller LPAC attributes",
            )?;
        }
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
                "dedicated fixed tool handle list",
            )?;
        }
        let mut desktop = wide(&format!("{}\\{}", config.station, config.desktop));
        let mut startup = STARTUPINFOEXW {
            StartupInfo: STARTUPINFOW {
                cb: std::mem::size_of::<STARTUPINFOEXW>() as u32,
                lpDesktop: desktop.as_mut_ptr(),
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
        let system = runtime_grants::directory(true)?;
        let windows = runtime_grants::directory(false)?;
        let root_image = if let Some(lease) = &tool_image_lease {
            lease.identity.path.clone()
        } else {
            fixture
                .as_ref()
                .map(|fixture| fixture.image.clone())
                .unwrap_or_else(|| system.join("cmd.exe"))
        };
        let root_command = if let Some(tool) = fixed_tool {
            tool.command()
        } else if fixture.is_some() {
            "probe.exe --owned-fixed-probe"
        } else {
            "cmd.exe /d /c exit 73"
        };
        let root_working = if fixed_tool.is_some() {
            fixture
                .as_ref()
                .ok_or("tool fixture missing")?
                .root
                .join("output")
        } else {
            system.clone()
        };
        let workload_environment = fixture
            .as_ref()
            .map(Fixture::environment)
            .transpose()?
            .unwrap_or_default();
        let environment: Vec<u16> = if fixed_tool.is_some() {
            let output = fixture
                .as_ref()
                .ok_or("tool output directory missing")?
                .root
                .join("output");
            let git_ceiling = if matches!(fixed_tool, Some(FixedTool::GitBundleInit)) {
                format!(
                    "GIT_CEILING_DIRECTORIES={}\0",
                    fixture
                        .as_ref()
                        .ok_or("missing Git fixture")?
                        .root
                        .display()
                )
            } else {
                String::new()
            };
            format!("SSPA_FIXTURE={2}\0HOME={0}\0USERPROFILE={0}\0LOCALAPPDATA={0}\0TEMP={0}\0TMP={0}\0SystemRoot={1}\0WINDIR={1}\0GIT_CONFIG_NOSYSTEM=1\0GIT_CONFIG_GLOBAL=NUL\0GIT_TERMINAL_PROMPT=0\0{3}\0", output.display(), windows.display(), fixture.as_ref().ok_or("missing tool fixture binding")?.root.display(), git_ceiling).encode_utf16().collect()
        } else {
            format!(
            "LOCALAPPDATA={}\\AppData\\Local\0{}{}{}SystemRoot={}\0USERPROFILE={}\0WINDIR={}\0\0",
            profile.display(),
            receipt.controller_lifecycle.environment(),
            receipt
                .credential_reference
                .as_ref()
                .map(|reference| format!("SSPA_CREDENTIAL_REF={reference}\0"))
                .unwrap_or_default(),
            workload_environment,
            windows.display(),
            profile.display(),
            windows.display()
        )
            .encode_utf16()
            .collect()
        };
        let environment =
            shellspan_account_sandbox_prototype::fixed_environment::canonicalize(&environment)?;
        let mut command = wide(root_command);
        let source_startup = STARTUPINFOW {
            cb: std::mem::size_of::<STARTUPINFOW>() as u32,
            lpDesktop: desktop.as_mut_ptr(),
            ..Default::default()
        };
        let mut source_command = wide("cmd.exe /d /c exit 0");
        let mut source = PROCESS_INFORMATION::default();
        win(
            unsafe {
                CreateProcessWithTokenW(
                    login.0,
                    0,
                    wide(
                        system
                            .join("cmd.exe")
                            .to_str()
                            .ok_or("invalid fixed source path")?,
                    )
                    .as_ptr(),
                    source_command.as_mut_ptr(),
                    CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
                    null(),
                    wide(system.to_str().ok_or("invalid source directory")?).as_ptr(),
                    &source_startup,
                    &mut source,
                )
            },
            "create never-resumed fixed source process",
        )?;
        source_process = Some((Handle(source.hProcess), Handle(source.hThread)));
        report["process_tree_stopped"] = serde_json::json!(false);
        let source = source_process
            .as_ref()
            .ok_or("fixed source process missing")?;
        win(
            unsafe { AssignProcessToJobObject(baseline_job.0, source.0 .0) },
            "own suspended source process tree",
        )?;
        let raw = as_account(login.0, || {
            let mut raw = null_mut();
            win(
                unsafe { OpenProcessToken(source.0 .0, TOKEN_QUERY | TOKEN_DUPLICATE, &mut raw) },
                "query source-session primary Token",
            )?;
            Ok(Handle(raw))
        })?;
        let mut duplicate = null_mut();
        win(
            unsafe {
                DuplicateTokenEx(
                    raw.0,
                    TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY,
                    null(),
                    SecurityImpersonation,
                    TokenPrimary,
                    &mut duplicate,
                )
            },
            "duplicate exact source primary Token",
        )?;
        source_token = Some(Handle(duplicate));
        let source_token = source_token.as_ref().ok_or("source Token missing")?;
        if token_sid(source_token.0)? != account {
            return Err("source-session Token account mismatch".into());
        }
        let session = query(source_token.0, TokenSessionId)?;
        report["source_token_session"] =
            serde_json::json!(unsafe { *session.as_ptr().cast::<u32>() });
        let elevation = query(source_token.0, TokenElevation)?;
        let elevated =
            unsafe { (*elevation.as_ptr().cast::<TOKEN_ELEVATION>()).TokenIsElevated } != 0;
        report["source_token_non_elevated"] = serde_json::json!(!elevated);
        if elevated {
            return Err("source-session Token unexpectedly elevated".into());
        }
        let mut controller_session = 0;
        win(
            unsafe {
                windows_sys::Win32::System::RemoteDesktop::ProcessIdToSessionId(
                    GetCurrentProcessId(),
                    &mut controller_session,
                )
            },
            "inspect actual controller session",
        )?;
        if unsafe { *session.as_ptr().cast::<u32>() } != controller_session {
            return Err("source-session Token does not match owned desktop session".into());
        }
        let mut process = PROCESS_INFORMATION::default();
        // Hold the same source identity, desktop, image and environment constant.
        // Only the fixed credential comparison is resumed after identity/Job gates.
        let _quota = runtime_grants::RestorePrivilege::enable_named("SeIncreaseQuotaPrivilege")?;
        let credential_control =
            fixture.is_some() && receipt.credential_reference_verified && fixed_tool.is_none();
        let control_image = if credential_control {
            root_image.clone()
        } else {
            system.join("cmd.exe")
        };
        let mut control_command = wide(if credential_control {
            "probe.exe --owned-fixed-credential-control"
        } else {
            "cmd.exe /d /c exit 73"
        });
        let ordinary = win(
            unsafe {
                CreateProcessAsUserW(
                    source_token.0,
                    wide(control_image.to_str().ok_or("invalid control image")?).as_ptr(),
                    control_command.as_mut_ptr(),
                    null(),
                    null(),
                    0,
                    CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
                    environment.as_ptr().cast(),
                    wide(system.to_str().ok_or("invalid control directory")?).as_ptr(),
                    &source_startup,
                    &mut process,
                )
            },
            "controller ordinary account creation control",
        );
        report["ordinary_creation_error"] = serde_json::json!(ordinary.as_ref().err());
        report["ordinary_creation_succeeded"] = serde_json::json!(ordinary.is_ok());
        if ordinary.is_ok() {
            child = Some((Handle(process.hProcess), Handle(process.hThread)));
            let control = child.as_ref().ok_or("ordinary control missing")?;
            win(
                unsafe { AssignProcessToJobObject(baseline_job.0, control.0 .0) },
                "own ordinary control",
            )?;
            if credential_control {
                let mut raw = null_mut();
                win(
                    unsafe { OpenProcessToken(control.0 .0, TOKEN_QUERY, &mut raw) },
                    "query ordinary primary control identity",
                )?;
                let actual = Handle(raw);
                let appcontainer = query(actual.0, TokenIsAppContainer)?;
                let elevation = query(actual.0, TokenElevation)?;
                let mut in_job = 0;
                win(
                    unsafe { IsProcessInJob(control.0 .0, baseline_job.0, &mut in_job) },
                    "verify ordinary primary control Job",
                )?;
                if token_sid(actual.0)? != account
                    || unsafe { *appcontainer.as_ptr().cast::<u32>() } != 0
                    || unsafe { (*elevation.as_ptr().cast::<TOKEN_ELEVATION>()).TokenIsElevated }
                        != 0
                    || in_job == 0
                {
                    return Err("ordinary primary control identity/Job gate failed".into());
                }
                report["ordinary_primary_security_verified"] = serde_json::json!(true);
                if unsafe { ResumeThread(control.1 .0) } == u32::MAX {
                    return Err("resume fixed ordinary credential control failed".into());
                }
            } else {
                win(
                    unsafe { TerminateProcess(control.0 .0, 0) },
                    "stop never-resumed ordinary control",
                )?;
            }
            if unsafe { WaitForSingleObject(control.0 .0, 5000) } != WAIT_OBJECT_0 {
                return Err("ordinary control retirement timeout".into());
            }
            if credential_control {
                let mut exit = 0;
                win(
                    unsafe { GetExitCodeProcess(control.0 .0, &mut exit) },
                    "verify fixed ordinary credential control exit",
                )?;
                if exit != 73 {
                    return Err("ordinary credential control did not deliver report".into());
                }
                let report_root = fixture
                    .as_ref()
                    .ok_or("ordinary credential fixture missing")?
                    .root
                    .clone();
                let bytes = shellspan_account_sandbox_prototype::appcontainer_probe::read_fixed_report(&report_root, shellspan_account_sandbox_prototype::appcontainer_probe::FixedReportKind::OrdinaryCredential)?;
                let observation: shellspan_account_sandbox_prototype::appcontainer_probe::CredentialPrimaryObservation = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
                if !verified_ordinary_credential_observation(
                    &observation,
                    receipt.fixture_id,
                    &account,
                ) {
                    return Err(
                        "ordinary credential report binding differs from verified control".into(),
                    );
                }
                report["ordinary_primary_credential_comparison"] =
                    serde_json::to_value(observation).map_err(|e| e.to_string())?;
            }
            drop(child.take());
        }
        process = PROCESS_INFORMATION::default();
        if fixture.is_some() {
            let capability_text = unsafe {
                shellspan_account_sandbox_prototype::appcontainer_probe::sid_text(capability.0)
            }?;
            observer = Some(unsafe {
                JobObserver::start(owned_job.0, account.clone(), package_text.clone(), {
                    let mut caps = vec![(capability_text, SE_GROUP_ENABLED as u32)];
                    if let Some(capability) = &instrumentation {
                        caps.push((
                            shellspan_account_sandbox_prototype::appcontainer_probe::sid_text(
                                capability.0,
                            )?,
                            SE_GROUP_ENABLED as u32,
                        ));
                    }
                    if let Some(capability) = &internet {
                        caps.push((
                            shellspan_account_sandbox_prototype::appcontainer_probe::sid_text(
                                capability.0,
                            )?,
                            SE_GROUP_ENABLED as u32,
                        ));
                    }
                    caps
                })
            }?);
        }
        let with_token = win(
            unsafe {
                CreateProcessWithTokenW(
                    source_token.0,
                    0,
                    wide(root_image.to_str().ok_or("invalid fixed root image")?).as_ptr(),
                    command.as_mut_ptr(),
                    CREATE_SUSPENDED
                        | CREATE_NO_WINDOW
                        | CREATE_UNICODE_ENVIRONMENT
                        | EXTENDED_STARTUPINFO_PRESENT,
                    environment.as_ptr().cast(),
                    wide(root_working.to_str().ok_or("invalid root directory")?).as_ptr(),
                    &startup.StartupInfo,
                    &mut process,
                )
            },
            "controller create fixed source-account LPAC process",
        );
        if let Err(reason) = with_token {
            report["with_token_creation_error"] = serde_json::json!(reason);
            let _quota =
                runtime_grants::RestorePrivilege::enable_named("SeIncreaseQuotaPrivilege")?;
            // Each SDK attempt gets a fresh mutable command buffer. Only thread
            // identity changes for the fixed target-context comparison.
            let mut create_as_user = || -> Result<()> {
                command = wide(root_command);
                win(
                    unsafe {
                        CreateProcessAsUserW(
                            source_token.0,
                            wide(root_image.to_str().ok_or("invalid fixed LPAC path")?).as_ptr(),
                            command.as_mut_ptr(),
                            null(),
                            null(),
                            i32::from(tool_stdio.is_some()),
                            CREATE_SUSPENDED
                                | CREATE_NO_WINDOW
                                | CREATE_UNICODE_ENVIRONMENT
                                | EXTENDED_STARTUPINFO_PRESENT,
                            environment.as_ptr().cast(),
                            wide(
                                root_working
                                    .to_str()
                                    .ok_or("invalid fixed LPAC directory")?,
                            )
                            .as_ptr(),
                            &startup.StartupInfo,
                            &mut process,
                        )
                    },
                    "controller CreateProcessAsUser fixed account LPAC comparison",
                )
            };
            let controller_result = create_as_user();
            report["as_user_controller_error"] =
                serde_json::json!(controller_result.as_ref().err());
            if controller_result.is_err() {
                let target_result = as_account(login.0, create_as_user);
                report["as_user_target_context_error"] =
                    serde_json::json!(target_result.as_ref().err());
                target_result?;
                report["creation_api"] =
                    serde_json::json!("CreateProcessAsUserW target account context");
            } else {
                report["creation_api"] = serde_json::json!("CreateProcessAsUserW");
            }
        } else {
            report["creation_api"] = serde_json::json!("CreateProcessWithTokenW");
        }
        child = Some((Handle(process.hProcess), Handle(process.hThread)));
        let (process, thread) = child.as_ref().ok_or("controller child unavailable")?;
        report["process_tree_stopped"] = serde_json::json!(false);
        win(
            unsafe { AssignProcessToJobObject(owned_job.0, process.0) },
            "own suspended controller LPAC tree",
        )?;
        let mut raw = null_mut();
        win(
            unsafe { OpenProcessToken(process.0, TOKEN_QUERY | TOKEN_DUPLICATE, &mut raw) },
            "query actual controller-created LPAC Token",
        )?;
        let token = Handle(raw);
        let user = token_sid(token.0)?;
        report["actual_user_sid"] = serde_json::json!(user);
        report["actual_user_verified"] = serde_json::json!(user == account);
        let app = query(token.0, TokenIsAppContainer)?;
        let actual = query(token.0, TokenAppContainerSid)?;
        let actual = unsafe { &*actual.as_ptr().cast::<TOKEN_APPCONTAINER_INFORMATION>() };
        report["actual_package_verified"] = serde_json::json!(
            unsafe { *app.as_ptr().cast::<u32>() } != 0
                && !actual.TokenAppContainer.is_null()
                && unsafe { EqualSid(actual.TokenAppContainer, package.0) } != 0
        );
        let capability_storage = query(token.0, TokenCapabilities)?;
        let caps = unsafe { &*capability_storage.as_ptr().cast::<TOKEN_GROUPS>() };
        let count = caps.GroupCount as usize;
        let required = std::mem::offset_of!(TOKEN_GROUPS, Groups)
            + count.min(17) * std::mem::size_of::<SID_AND_ATTRIBUTES>();
        if count > 16 || required > capability_storage.len() * std::mem::size_of::<usize>() {
            return Err("controller capability buffer exceeds bound".into());
        }
        let actual_caps = unsafe { std::slice::from_raw_parts(caps.Groups.as_ptr(), count) };
        report["actual_capabilities_verified"] =
            serde_json::json!(exact_startup_capabilities(actual_caps, &entries));
        let integrity = query(token.0, TokenIntegrityLevel)?;
        let integrity = unsafe {
            (*integrity.as_ptr().cast::<TOKEN_MANDATORY_LABEL>())
                .Label
                .Sid
        };
        let count = unsafe { *GetSidSubAuthorityCount(integrity) };
        report["actual_low_integrity"] = serde_json::json!(
            count > 0 && unsafe { *GetSidSubAuthority(integrity, u32::from(count - 1)) } == 4096
        );
        report["actual_lpac"] = serde_json::json!(actual_lpac(token.0, &account, &package_text)?);
        for key in [
            "actual_user_verified",
            "actual_package_verified",
            "actual_capabilities_verified",
            "actual_low_integrity",
            "actual_lpac",
        ] {
            if report[key] != true {
                return Err(format!("controller actual Token check failed: {key}"));
            }
        }
        if let Some(intent) = &receipt.package_network_intent {
            let network = engine()?;
            for (index, key) in intent.filter_keys.iter().enumerate() {
                if !unsafe {
                    shellspan_account_sandbox_prototype::package_network_filter::inspect(
                        network.0,
                        &GUID::from_u128(key.as_u128()),
                        index,
                        expected.0,
                    )
                }? {
                    return Err("package block absent before Resume; refuse dispatch".into());
                }
            }
            report["package_blocks_verified_before_resume"] = serde_json::json!(true);
        }
        if let Some(intent) = &receipt.rpc_network_intent {
            let network = engine()?;
            let subject = sid(&account)?;
            if !unsafe {
                shellspan_account_sandbox_prototype::rpc_network_filter::inspect(
                    network.0,
                    &GUID::from_u128(intent.filter_key.as_u128()),
                    subject.0,
                )
            }? {
                return Err("RPC block absent before Resume; refuse dispatch".into());
            }
            report["rpc_block_verified_before_resume"] = serde_json::json!(true);
        }
        if matches!(
            receipt.controller_tool,
            Some(
                FixedSystemTool::DnsRpcBlockInternetProbe
                    | FixedSystemTool::DnsRpcInstrumentationInternetProbe
                    | FixedSystemTool::DnsRpcInstrumentationDefaultProbe
            )
        ) || receipt.controller_lifecycle == FixedLifecycle::ServiceCrash
        {
            if receipt.rpc_trace_intent.is_some() {
                return Err("RPC trace intent already exists; refuse repeated dispatch".into());
            }
            let target = unsafe {
                shellspan_account_sandbox_prototype::rpc_trace_intent::ProcessIdentity::from_handle(
                    process.0,
                )
            }?;
            let intent =
                shellspan_account_sandbox_prototype::rpc_trace_intent::RpcTraceIntent::new(
                    receipt.fixture_id,
                    target,
                )?;
            receipt.rpc_trace_intent = Some(intent.clone());
            receipt.state = "planned fixed root-PID RPC trace before Resume".into();
            receipt.save()?;
            rpc_trace = Some(unsafe {
                shellspan_account_sandbox_prototype::rpc_trace::RpcTrace::start_bound(
                    &intent, process.0,
                )
            }?);
            report["rpc_trace_started_before_resume"] = serde_json::json!(true);
        }
        if unsafe { ResumeThread(thread.0) } == u32::MAX {
            return Err("controller resume failed".into());
        }
        let lifecycle = receipt.controller_lifecycle;
        let wait = if matches!(
            lifecycle,
            FixedLifecycle::Cancel
                | FixedLifecycle::RepeatedCancel
                | FixedLifecycle::ConcurrentCancel
        ) {
            let event = Handle(unsafe { CreateEventW(null(), 1, 0, null()) });
            if event.0.is_null() {
                return Err("create fixed cancellation event failed".into());
            }
            let marker = fixture
                .as_ref()
                .ok_or("cancel workload missing")?
                .root
                .join("output/descendant-resumed");
            let raw_event = event.0 as usize;
            let requests = if lifecycle == FixedLifecycle::RepeatedCancel {
                3
            } else {
                1
            };
            let requester = std::thread::spawn(move || -> u32 {
                let deadline = std::time::Instant::now() + Duration::from_secs(2);
                while std::time::Instant::now() < deadline {
                    let ready = if lifecycle == FixedLifecycle::ConcurrentCancel {
                        marker.parent().is_some_and(|output| {
                            ["descendant-resumed-0", "descendant-resumed-1"]
                                .iter()
                                .all(|name| {
                                    fs::read(output.join(name))
                                        .is_ok_and(|data| data == b"fixed descendant resumed")
                                })
                        })
                    } else {
                        fs::read(&marker).is_ok_and(|data| data == b"fixed descendant resumed")
                    };
                    if ready {
                        let mut sent = 0;
                        for _ in 0..requests {
                            if unsafe { SetEvent(raw_event as HANDLE) } != 0 {
                                sent += 1;
                            }
                        }
                        return sent;
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
                0
            });
            let handles = [process.0, event.0];
            let waited = unsafe { WaitForMultipleObjects(2, handles.as_ptr(), 0, 3000) };
            let sent = requester
                .join()
                .map_err(|_| "fixed cancellation requester failed")?;
            report["cancellation_requests_sent"] = serde_json::json!(sent);
            if sent != requests {
                return Err("fixed cancellation event was not sent".into());
            }
            waited
        } else {
            unsafe {
                WaitForSingleObject(
                    process.0,
                    if matches!(
                        lifecycle,
                        FixedLifecycle::Timeout | FixedLifecycle::ServiceCrash
                    ) {
                        1500
                    } else {
                        5000
                    },
                )
            }
        };
        let mut exit = 0;
        win(
            unsafe { GetExitCodeProcess(process.0, &mut exit) },
            "inspect fixed controller child exit",
        )?;
        report["root_exit_73"] = serde_json::json!(exit == 73);
        if fixed_tool.is_some() {
            report["tool_admission"]["actual_exit"] = serde_json::json!(exit);
        }
        if lifecycle == FixedLifecycle::Normal {
            if wait != WAIT_OBJECT_0 || exit != fixed_tool.map_or(73, FixedTool::expected_exit) {
                return Err(format!("fixed normal wait={wait}, exit={exit}"));
            }
        } else {
            let workload = fixture.as_ref().ok_or("lifecycle workload missing")?;
            let marker = if lifecycle == FixedLifecycle::ConcurrentCancel {
                ["descendant-resumed-0", "descendant-resumed-1"]
                    .iter()
                    .all(|name| {
                        fs::read(workload.root.join("output").join(name))
                            .is_ok_and(|data| data == b"fixed descendant resumed")
                    })
            } else {
                fs::read(workload.root.join("output/descendant-resumed"))
                    .is_ok_and(|data| data == b"fixed descendant resumed")
            };
            let accounting = unsafe { crate::runner::accounting(owned_job.0) }?;
            report["lifecycle"] = serde_json::to_value(lifecycle).map_err(|e| e.to_string())?;
            report["root_exit_code_at_trigger"] = serde_json::json!(exit);
            report["active_processes_at_trigger"] = serde_json::json!(accounting.ActiveProcesses);
            if !verified_lifecycle_trigger(
                lifecycle,
                wait,
                exit,
                accounting.TotalProcesses,
                accounting.ActiveProcesses,
                marker,
            ) {
                return Err(
                    "fixed lifecycle did not observe the required live confined tree".into(),
                );
            }
            report["lifecycle_timeout_observed"] =
                serde_json::json!(lifecycle == FixedLifecycle::Timeout);
            report["lifecycle_cancel_observed"] = serde_json::json!(matches!(
                lifecycle,
                FixedLifecycle::Cancel
                    | FixedLifecycle::RepeatedCancel
                    | FixedLifecycle::ConcurrentCancel
            ));
            report["lifecycle_root_failure_observed"] =
                serde_json::json!(lifecycle == FixedLifecycle::RootFailure);
        }
        Ok(())
    })();
    report["owned_job_total"] =
        serde_json::json!(unsafe { crate::runner::accounting(owned_job.0) }
            .ok()
            .map(|accounting| accounting.TotalProcesses));
    let mut error = experiment.err();
    if let Some(observer) = &mut observer {
        let entries = observer.finish();
        let topology = fixture.as_ref().is_some_and(|workload| {
            let console = runtime_grants::directory(true).map(|system| system.join("conhost.exe"));
            console.is_ok_and(|console| {
                if let Some(lease) = &tool_image_lease {
                    verified_tool_topology(
                        &entries,
                        report["owned_job_total"].as_u64().unwrap_or(0) as u32,
                        &lease.identity.path,
                        &console,
                    )
                } else if receipt.controller_lifecycle == FixedLifecycle::ConcurrentCancel {
                    verified_concurrent_topology(
                        &entries,
                        report["owned_job_total"].as_u64().unwrap_or(0) as u32,
                        &workload.image,
                        &console,
                    )
                } else {
                    verified_fixed_topology(
                        &entries,
                        report["owned_job_total"].as_u64().unwrap_or(0) as u32,
                        &workload.image,
                        &console,
                    )
                }
            })
        });
        report["execution_topology_verified"] = serde_json::json!(topology);
        report["execution_job_observations"] =
            serde_json::to_value(&entries).map_err(|e| e.to_string())?;
        if !topology {
            error = Some(format!(
                "{}; execution Job members not fully verified",
                error.unwrap_or_default()
            ));
        }
    }
    if receipt.controller_lifecycle == FixedLifecycle::ServiceCrash && error.is_none() {
        let mut raw = null_mut();
        win(
            unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) },
            "verify fixed crashing service Token",
        )?;
        let actual_system = Handle(raw);
        if token_sid(actual_system.0)? != "S-1-5-18"
            || report["execution_topology_verified"] != true
            || report["active_processes_at_trigger"] != 4
        {
            error = Some("fixed service crash checkpoint lacks actual SYSTEM confined tree".into());
        } else {
            report["service_crash_checkpoint"] = serde_json::json!(true);
            receipt.controller_admission_report = Some(report.clone());
            receipt.cleanup_debt.push(
                "fixed running SYSTEM service interruption; exact UUID recovery required".into(),
            );
            receipt.state = "durable running service crash checkpoint; execution tree live; no resource retirement claimed".into();
            receipt.save()?;
            unsafe {
                TerminateProcess(GetCurrentProcess(), 0xe8);
            }
            error = Some("fixed service self-termination failed".into());
        }
    }
    if let Some((process, _)) = &child {
        report["owned_job_total"] =
            serde_json::json!(unsafe { crate::runner::accounting(owned_job.0) }
                .ok()
                .map(|accounting| accounting.TotalProcesses));
        report["process_tree_stopped"] =
            serde_json::json!(unsafe { crate::runner::end_process(process.0, owned_job.0) });
        if receipt.controller_lifecycle == FixedLifecycle::RepeatedCancel {
            let first_stopped = report["process_tree_stopped"] == true;
            let repeated_stopped =
                (0..2).all(|_| unsafe { crate::runner::end_process(process.0, owned_job.0) });
            report["repeated_cancellation_retirement_verified"] =
                serde_json::json!(first_stopped && repeated_stopped);
            if !first_stopped || !repeated_stopped {
                report["process_tree_stopped"] = serde_json::json!(false);
                error = Some("repeated cancellation retirement did not converge".into());
            }
        }
    } else {
        report["process_tree_stopped"] =
            serde_json::json!(unsafe { crate::runner::accounting(owned_job.0) }
                .is_ok_and(|accounting| accounting.ActiveProcesses == 0));
    }
    report["baseline_job_total"] =
        serde_json::json!(unsafe { crate::runner::accounting(baseline_job.0) }
            .ok()
            .map(|accounting| accounting.TotalProcesses));
    let baseline_stopped = if let Some((source, _)) = &source_process {
        unsafe { crate::runner::end_process(source.0, baseline_job.0) }
    } else {
        unsafe { crate::runner::accounting(baseline_job.0) }
            .is_ok_and(|accounting| accounting.ActiveProcesses == 0)
    };
    report["baseline_tree_stopped"] = serde_json::json!(baseline_stopped);
    if !baseline_stopped {
        report["process_tree_stopped"] = serde_json::json!(false);
        error = Some(format!(
            "{}; baseline tree retirement unconfirmed",
            error.unwrap_or_default()
        ));
    }
    let final_execution = unsafe { crate::runner::accounting(owned_job.0) };
    if let Ok(final_execution) = final_execution {
        report["execution_job_final_total"] = serde_json::json!(final_execution.TotalProcesses);
        report["execution_job_final_active"] = serde_json::json!(final_execution.ActiveProcesses);
        if observer.is_some()
            && (report["owned_job_total"] != final_execution.TotalProcesses
                || final_execution.ActiveProcesses != 0)
        {
            report["execution_topology_verified"] = serde_json::json!(false);
            report["process_tree_stopped"] = serde_json::json!(false);
            error = Some(format!(
                "{}; execution membership changed after topology verification",
                error.unwrap_or_default()
            ));
        }
    } else {
        report["process_tree_stopped"] = serde_json::json!(false);
        error = Some(format!(
            "{}; final execution Job accounting unavailable",
            error.unwrap_or_default()
        ));
    }
    if let Some(trace) = rpc_trace.take() {
        let observation = trace.finish();
        if let Err(reason) = &observation {
            error = Some(format!("{}; {reason}", error.take().unwrap_or_default()));
        }
        report["rpc_client_trace"] =
            serde_json::to_value(observation).map_err(|e| e.to_string())?;
    }
    if receipt.rpc_trace_intent.is_some() {
        match shellspan_account_sandbox_prototype::rpc_trace::session_absent(receipt.fixture_id) {
            Ok(true) => {
                receipt.rpc_trace_removed = true;
                receipt.state =
                    "verified fixed RPC trace absent after execution stop attempt".into();
                receipt.save()?;
            }
            Ok(false) => {
                error = Some(format!(
                    "{}; owned RPC trace remains live",
                    error.take().unwrap_or_default()
                ))
            }
            Err(reason) => error = Some(format!("{}; {reason}", error.take().unwrap_or_default())),
        }
    }
    drop(child);
    drop(source_token);
    drop(source_process);
    drop(owned_job);
    drop(baseline_job);
    if report["process_tree_stopped"] == true {
        if let Some(stdio) = tool_stdio.take() {
            let tool = fixed_tool.ok_or("fixed tool stdio lacks frozen tool")?;
            match stdio.read_after_stop(tool) {
                Ok([stdout, stderr]) => {
                    let valid = if matches!(tool, FixedTool::GitBundle) {
                        shellspan_account_sandbox_prototype::fixed_tool::verified_git_version_output(
                            &stdout, &stderr,
                        )
                    } else if matches!(tool, FixedTool::GitBundleInit) {
                        stderr.is_empty()
                            && stdout.starts_with("Initialized empty Git repository in ")
                    } else if matches!(tool, FixedTool::CrossSlotRegistryProbe) {
                        let bound = shellspan_account_sandbox_prototype::cross_slot_registry_probe::verify_access_delivery(&stdout, &account).is_ok();
                        report["tool_admission"]["cross_slot_report_bound"] =
                            serde_json::json!(bound);
                        stderr.is_empty() && bound
                    } else if matches!(tool, FixedTool::GitPrefixProbe) {
                        let bound = fixture.as_ref().is_some_and(|fixture| {
                            shellspan_account_sandbox_prototype::git_prefix_probe::verify_delivery(
                                &stdout,
                                &fixture.root,
                            )
                            .is_ok()
                        });
                        report["tool_admission"]["prefix_report_bound"] = serde_json::json!(bound);
                        stderr.is_empty() && bound
                    } else {
                        stdout.is_empty() && stderr.is_empty()
                    };
                    report["tool_admission"]["stdout"] = serde_json::json!(stdout);
                    report["tool_admission"]["stderr"] = serde_json::json!(stderr);
                    report["tool_admission"]["output_verified"] = serde_json::json!(valid);
                    if matches!(
                        tool,
                        FixedTool::PowerShell7RuntimeArtifact | FixedTool::PowerShell7RuntimeBuild
                    ) {
                        let result = fixture.as_ref().ok_or_else(|| "missing artifact fixture".to_string()).and_then(|fixture| shellspan_account_sandbox_prototype::fixed_tool::verify_powershell_artifact(&fixture.root));
                        report["tool_admission"]["artifact_verified"] =
                            serde_json::json!(result.is_ok());
                        match result {
                            Ok(identity) => {
                                report["tool_admission"]["artifact"] =
                                    serde_json::to_value(identity).map_err(|e| e.to_string())?
                            }
                            Err(reason) => {
                                error =
                                    Some(format!("{}; {reason}", error.take().unwrap_or_default()))
                            }
                        }
                    }

                    if matches!(tool, FixedTool::PowerShell7RuntimeBuild) {
                        let result = fixture.as_ref().ok_or_else(|| "missing compiled DLL fixture".to_string()).and_then(|fixture| shellspan_account_sandbox_prototype::fixed_tool::verify_powershell_build_dll(&fixture.root));
                        report["tool_admission"]["build_dll_verified"] =
                            serde_json::json!(result.is_ok());
                        match result {
                            Ok(identity) => {
                                report["tool_admission"]["build_dll"] =
                                    serde_json::to_value(identity).map_err(|e| e.to_string())?
                            }
                            Err(reason) => {
                                error =
                                    Some(format!("{}; {reason}", error.take().unwrap_or_default()))
                            }
                        }
                    }
                    if matches!(tool, FixedTool::GitBundleInit) {
                        let result = fixture
                            .as_ref()
                            .ok_or_else(|| "Git fixture missing".to_string())
                            .and_then(|fixture| {
                                shellspan_account_sandbox_prototype::fixed_tool::verify_git_init(
                                    &fixture.root,
                                )
                            });
                        report["tool_admission"]["repository_verified"] =
                            serde_json::json!(result.is_ok());
                        if let Err(reason) = result {
                            error = Some(format!("{}; {reason}", error.take().unwrap_or_default()));
                        }
                    }
                    if !valid {
                        error = Some(format!(
                            "{}; fixed dedicated tool output invalid",
                            error.unwrap_or_default()
                        ));
                    }
                }
                Err(reason) => error = Some(format!("{}; {reason}", error.unwrap_or_default())),
            }
        }
        drop(tool_bundle.take());
        drop(powershell_runtime.take());
        drop(tool_image_lease.take());
        if let Some(workload) = &mut fixture {
            if fixed_tool.is_none() {
                let observation = workload.observe();
                if let Ok(probe) = &observation {
                    report["workload_checks_passed"] = serde_json::json!(verified_fixed_probe(
                        probe,
                        receipt.credential_reference_verified
                    ));
                    report["workload_report"] =
                        serde_json::to_value(probe).map_err(|e| e.to_string())?;
                    let expected_report = if receipt.controller_lifecycle == FixedLifecycle::Normal
                    {
                        verified_fixed_probe(probe, receipt.credential_reference_verified)
                    } else {
                        verified_interrupted_probe(probe)
                    };
                    report["lifecycle_fixture_prefix_verified"] = serde_json::json!(
                        receipt.controller_lifecycle != FixedLifecycle::Normal && expected_report
                    );
                    if !expected_report {
                        error = Some(format!(
                            "{}; fixed workload checks incomplete or failed",
                            error.unwrap_or_default()
                        ));
                    }
                } else {
                    report["workload_observation_error"] =
                        serde_json::json!(observation.as_ref().err());
                    error = Some(format!(
                        "{}; fixed workload report unavailable",
                        error.unwrap_or_default()
                    ));
                }
            }
            let retirement = profile_object(&workload.root).and_then(|actual| {
                if !receipt
                    .controller_workload_fixture
                    .as_ref()
                    .is_some_and(|owned| same_profile(owned, &actual))
                {
                    return Err(
                        "owned workload root identity changed; no revocation against replacement"
                            .into(),
                    );
                }
                let owned = receipt
                    .controller_workload_fixture
                    .as_ref()
                    .ok_or("frozen workload root missing at retirement")?;
                if receipt
                    .controller_tool
                    .is_some_and(FixedSystemTool::uses_powershell_runtime)
                {
                    workload.revoke_runtime_bound(Some((owned.volume_serial, owned.file_index)))
                } else {
                    workload.revoke_bound(Some((owned.volume_serial, owned.file_index)))
                }
            });
            receipt.controller_workload_retired = retirement.is_ok();
            report["workload_retired"] = serde_json::json!(retirement.is_ok());
            if let Err(reason) = retirement {
                error = Some(format!("{}; {reason}", error.unwrap_or_default()));
            }
            receipt.save()?;
        }
    }
    if report["process_tree_stopped"] == true {
        let removed = as_account(login.0, || {
            let code = unsafe { DeleteAppContainerProfile(wide(&name).as_ptr()) };
            if code < 0 {
                return Err(format!(
                    "retire controller-owned package HRESULT=0x{:08x}",
                    code as u32
                ));
            }
            Ok(())
        });
        report["profile_removed"] = serde_json::json!(removed.is_ok());
        if let Err(reason) = removed {
            error = Some(format!("{}; {reason}", error.unwrap_or_default()));
        }
    }
    receipt.account_lpac_cleanup_verified = report["profile_removed"] == true
        && report["process_tree_stopped"] == true
        && (!receipt.controller_workload_requested || receipt.controller_workload_retired);
    report["error"] = serde_json::json!(error);
    receipt.controller_admission_report = Some(report);
    receipt.save()?;
    if let Some(error) = error {
        return Err(error);
    }
    if !receipt.account_lpac_cleanup_verified {
        return Err("controller admission cleanup unconfirmed".into());
    }
    Ok(())
}

fn verified_lifecycle_trigger(
    mode: FixedLifecycle,
    wait: u32,
    exit: u32,
    total: u32,
    active: u32,
    marker: bool,
) -> bool {
    if mode == FixedLifecycle::ConcurrentCancel {
        return marker
            && total == 6
            && active == 6
            && wait == WAIT_OBJECT_0 + 1
            && exit == STILL_ACTIVE as u32;
    }
    if !marker || total != 4 {
        return false;
    }
    match mode {
        FixedLifecycle::Timeout | FixedLifecycle::ServiceCrash => {
            wait == WAIT_TIMEOUT && exit == STILL_ACTIVE as u32 && active == 4
        }
        FixedLifecycle::Cancel
        | FixedLifecycle::RepeatedCancel
        | FixedLifecycle::ConcurrentCancel => {
            wait == WAIT_OBJECT_0 + 1 && exit == STILL_ACTIVE as u32 && active == 4
        }
        FixedLifecycle::RootFailure => wait == WAIT_OBJECT_0 && exit == 0xe7 && active == 3,
        FixedLifecycle::Normal => false,
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn actual_concurrent_cancel_tracks_six_members_and_retires_the_owned_resources() {
        let receipt: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"), "/../../docs/design/evidence/windows-stage-a-2026-10-09-concurrent-cancel-system-profile.json"
        ))).unwrap();
        let report = &receipt["controller_admission_report"];
        assert!(report["error"].is_null());
        assert_eq!(report["lifecycle"], "concurrent_cancel");
        assert_eq!(report["owned_job_total"], 6);
        assert_eq!(report["active_processes_at_trigger"], 6);
        for key in [
            "lifecycle_cancel_observed",
            "execution_topology_verified",
            "process_tree_stopped",
            "lifecycle_fixture_prefix_verified",
            "workload_retired",
        ] {
            assert_eq!(report[key], true, "{key}");
        }
        let entries = report["execution_job_observations"].as_array().unwrap();
        assert_eq!(entries.len(), 6);
        let mut ids = std::collections::BTreeSet::new();
        for entry in entries {
            assert!(ids.insert(entry["pid"].as_u64().unwrap()));
            for key in [
                "exact_job_member",
                "appcontainer",
                "expected_user",
                "expected_package",
                "exact_capabilities",
                "actual_lpac",
            ] {
                assert_eq!(entry[key], true, "{key}");
            }
            assert_eq!(entry["integrity_rid"], 4096);
            assert!(entry["error"].is_null());
        }
        let probe: ProbeReport = serde_json::from_value(report["workload_report"].clone()).unwrap();
        assert!(verified_interrupted_probe(&probe));
        assert!(!verified_fixed_probe(&probe, false));
        let audit: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"), "/../../docs/design/evidence/windows-stage-a-2026-10-09-concurrent-cancel-system-os-audit.json"
        ))).unwrap();
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
    fn concurrent_cancel_trigger_requires_both_ready_and_six_live_members() {
        let mode = FixedLifecycle::ConcurrentCancel;
        assert!(verified_lifecycle_trigger(
            mode,
            WAIT_OBJECT_0 + 1,
            STILL_ACTIVE as u32,
            6,
            6,
            true
        ));
        assert!(!verified_lifecycle_trigger(
            mode,
            WAIT_OBJECT_0 + 1,
            STILL_ACTIVE as u32,
            6,
            6,
            false
        ));
        for (total, active) in [(4, 4), (6, 5), (7, 6)] {
            assert!(!verified_lifecycle_trigger(
                mode,
                WAIT_OBJECT_0 + 1,
                STILL_ACTIVE as u32,
                total,
                active,
                true
            ));
        }
        assert!(!verified_lifecycle_trigger(
            mode,
            WAIT_TIMEOUT,
            STILL_ACTIVE as u32,
            6,
            6,
            true
        ));
        assert!(!verified_lifecycle_trigger(
            mode,
            WAIT_OBJECT_0 + 1,
            73,
            6,
            6,
            true
        ));
    }
    #[test]
    fn dedicated_historical_ads_matrix_cannot_replace_listener_or_credential_checks() {
        let receipt: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../docs/design/evidence/windows-stage-a-2026-10-09-new-ads-system-profile.json"
        )))
        .unwrap();
        let report = &receipt["controller_admission_report"];
        for key in [
            "actual_user_verified",
            "actual_package_verified",
            "actual_capabilities_verified",
            "actual_low_integrity",
            "actual_lpac",
            "execution_topology_verified",
            "process_tree_stopped",
            "workload_retired",
            "root_exit_73",
        ] {
            assert_eq!(report[key], true, "{key}");
        }
        let mut probe: ProbeReport =
            serde_json::from_value(report["workload_report"].clone()).unwrap();
        assert_eq!(probe.checks.len(), 129);
        assert!(!verified_fixed_probe(&probe, true));
        probe
            .checks
            .retain(|check| !CREDENTIAL_PROBE_CHECKS.contains(&check.name.as_str()));
        assert!(probe.complete && probe.checks.iter().all(|check| check.passed));
        assert!(!verified_fixed_probe(&probe, false));
        let recovered: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"), "/../../docs/design/evidence/windows-stage-a-2026-10-09-new-ads-system-recovered-profile.json"
        ))).unwrap();
        for key in [
            "account_removed",
            "profile_removed",
            "credential_removed",
            "filters_removed",
        ] {
            assert_eq!(recovered[key], true, "{key}");
        }
        assert!(recovered["cleanup_debt"].as_array().unwrap().is_empty());
        let audit: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../docs/design/evidence/windows-stage-a-2026-10-09-new-ads-system-os-audit.json"
        )))
        .unwrap();
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
    fn actual_root_and_leaf_listener_denials_preserve_the_full_credential_failure() {
        let receipt: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../docs/design/evidence/windows-stage-a-2026-10-09-tcp-listener-bounded-system-profile.json"
        ))).unwrap();
        let report = &receipt["controller_admission_report"];
        for key in [
            "actual_user_verified",
            "actual_package_verified",
            "actual_capabilities_verified",
            "actual_low_integrity",
            "actual_lpac",
            "execution_topology_verified",
            "process_tree_stopped",
            "workload_retired",
        ] {
            assert_eq!(report[key], true, "{key}");
        }
        let mut probe: ProbeReport =
            serde_json::from_value(report["workload_report"].clone()).unwrap();
        assert!(!verified_fixed_probe(&probe, true));
        assert_eq!(probe.checks.iter().filter(|check| !check.passed).count(), 1);
        for name in [
            "TCP listener 0 denied",
            "TCP listener 1 denied",
            "descendant network: TCP listener 0 denied",
            "descendant network: TCP listener 1 denied",
        ] {
            let check = probe
                .checks
                .iter()
                .find(|check| check.name == name)
                .unwrap();
            assert!(check.passed && check.detail.contains("10013"), "{name}");
        }
        probe
            .checks
            .retain(|check| !CREDENTIAL_PROBE_CHECKS.contains(&check.name.as_str()));
        assert!(probe.complete && probe.checks.iter().all(|check| check.passed));
        assert!(!verified_fixed_probe(&probe, false));
    }
    #[test]
    fn dedicated_project_matrix_passes_core_without_accepting_failed_credentials() {
        let receipt: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"), "/../../docs/design/evidence/windows-stage-a-2026-10-09-project-matrix-system-profile.json"
        ))).unwrap();
        let report = &receipt["controller_admission_report"];
        for key in [
            "actual_user_verified",
            "actual_package_verified",
            "actual_capabilities_verified",
            "actual_low_integrity",
            "actual_lpac",
            "execution_topology_verified",
            "process_tree_stopped",
            "workload_retired",
        ] {
            assert_eq!(report[key], true, "{key}");
        }
        let mut probe: ProbeReport =
            serde_json::from_value(report["workload_report"].clone()).unwrap();
        assert!(!verified_fixed_probe(&probe, true));
        assert_eq!(probe.checks.len(), 124);
        probe
            .checks
            .retain(|check| !CREDENTIAL_PROBE_CHECKS.contains(&check.name.as_str()));
        assert_eq!(probe.checks.len(), 121);
        assert!(probe.complete && probe.checks.iter().all(|check| check.passed));
        assert!(
            !verified_fixed_probe(&probe, false),
            "historical receipt lacks new ADS checks"
        );
        let recovered: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"), "/../../docs/design/evidence/windows-stage-a-2026-10-09-project-matrix-recovered-profile.json"
        ))).unwrap();
        for key in [
            "account_removed",
            "profile_removed",
            "credential_removed",
            "filters_removed",
        ] {
            assert_eq!(recovered[key], true, "{key}");
        }
        assert!(recovered["cleanup_debt"].as_array().unwrap().is_empty());
    }
    #[test]
    fn actual_private_network_matrix_passes_core_and_requires_recovery_after_partial_failure() {
        let shared: serde_json::Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/design/evidence/windows-stage-a-2026-10-09-private-network-shared-source.json"))).unwrap();
        let shared_probe: ProbeReport = serde_json::from_value(shared["probe"].clone()).unwrap();
        assert!(shared_probe.checks.iter().all(|check| check.passed));
        assert!(
            !verified_fixed_probe(&shared_probe, false),
            "historical receipt lacks DNS scope"
        );
        assert!(!verified_fixed_probe(&shared_probe, true));
        assert!(shared["error"].is_null());
        for key in [
            "profile_removed",
            "fixture_acls_revoked",
            "receiver_quietness_verified",
        ] {
            assert_eq!(shared[key], true, "{key}");
        }
        let receipt: serde_json::Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/design/evidence/windows-stage-a-2026-10-09-private-network-system-profile.json"))).unwrap();
        let report = &receipt["controller_admission_report"];
        assert_eq!(report["execution_topology_verified"], true);
        assert_eq!(report["process_tree_stopped"], true);
        let mut probe: ProbeReport =
            serde_json::from_value(report["workload_report"].clone()).unwrap();
        assert!(!verified_fixed_probe(&probe, true));
        assert_eq!(probe.checks.iter().filter(|check| !check.passed).count(), 1);
        probe
            .checks
            .retain(|check| !CREDENTIAL_PROBE_CHECKS.contains(&check.name.as_str()));
        assert!(probe.checks.iter().all(|check| check.passed));
        assert!(
            !verified_fixed_probe(&probe, false),
            "historical receipt lacks DNS scope"
        );
        let partial: serde_json::Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/design/evidence/windows-stage-a-2026-10-09-private-network-system-recovered-profile.json"))).unwrap();
        assert_eq!(partial["filters_removed"], false);
        assert!(!partial["cleanup_debt"].as_array().unwrap().is_empty());
        let recovered: serde_json::Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/design/evidence/windows-stage-a-2026-10-09-private-network-second-recovery-profile.json"))).unwrap();
        assert_eq!(recovered["fixture_id"], receipt["fixture_id"]);
        for key in [
            "account_removed",
            "profile_removed",
            "filters_removed",
            "credential_removed",
        ] {
            assert_eq!(recovered[key], true, "{key}");
        }
        assert!(recovered["cleanup_debt"].as_array().unwrap().is_empty());
    }
    #[test]
    fn actual_identity_service_calibration_denies_system_credential_but_not_lsa_admission() {
        let receipt: serde_json::Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/design/evidence/windows-stage-a-2026-10-09-identity-credential-system-profile.json"))).unwrap();
        let report = &receipt["controller_admission_report"];
        assert_eq!(report["actual_capabilities_verified"], true);
        let probe: ProbeReport = serde_json::from_value(report["workload_report"].clone()).unwrap();
        assert_eq!(probe.checks.len(), 159);
        assert!(!verified_fixed_probe(&probe, true));
        let credential = probe
            .checks
            .iter()
            .find(|check| check.name == "owned SYSTEM credential reference inaccessible")
            .unwrap();
        assert!(credential.passed && credential.detail.contains("Win32=5;"));
        let contexts: Vec<_> = probe
            .checks
            .iter()
            .filter(|check| check.name.ends_with("DNS self-context comparison"))
            .collect();
        assert_eq!(contexts.len(), 2);
        for check in contexts {
            let context: shellspan_account_sandbox_prototype::rpc_admission_probe::LsaSelfObservation = serde_json::from_str(&check.detail).unwrap();
            assert!(context.security_context_equal && context.restored && context.error.is_none());
            assert_eq!(context.connection.unwrap().connect_status, 0);
            assert_eq!(context.credential_denial_win32, Some(5));
            assert!(context.credential_error.is_none());
            assert_eq!(context.dns_cache_only.unwrap().completion_status, Some(87));
        }
        let retired: serde_json::Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/design/evidence/windows-stage-a-2026-10-09-identity-credential-system-recovered-profile.json"))).unwrap();
        assert_eq!(retired["fixture_id"], receipt["fixture_id"]);
        assert!(retired["cleanup_debt"].as_array().unwrap().is_empty());
        for key in [
            "account_removed",
            "profile_removed",
            "filters_removed",
            "credential_removed",
        ] {
            assert_eq!(retired[key], true);
        }
    }
    #[test]
    fn actual_account_sid_filters_do_not_cover_owned_dns_relay() {
        let receipt: serde_json::Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/design/evidence/windows-stage-a-2026-10-09-dns-sid-block-system-profile.json"))).unwrap();
        assert_eq!(receipt["filter_keys"].as_array().unwrap().len(), 4);
        let report = &receipt["controller_admission_report"];
        assert_eq!(report["process_tree_stopped"], true);
        let probe: ProbeReport = serde_json::from_value(report["workload_report"].clone()).unwrap();
        assert!(!verified_fixed_probe(&probe, true));
        for name in [
            "descendant network: DNS UDP API denied",
            "descendant network: DNS TCP API denied",
        ] {
            let check = probe
                .checks
                .iter()
                .find(|check| check.name == name)
                .unwrap();
            let observation: shellspan_account_sandbox_prototype::dns_native_probe::DnsApiObservation = serde_json::from_str(&check.detail).unwrap();
            assert!(!check.passed && observation.completion_status == Some(0));
            assert!(observation.records_returned && observation.fixed_answer);
        }
        for name in ["DNS UDP receiver no traffic", "DNS TCP receiver no traffic"] {
            let check = probe
                .checks
                .iter()
                .find(|check| check.name == name)
                .unwrap();
            assert!(!check.passed);
            assert_eq!(
                check.detail,
                "owned DNS native before/after controls verified; received=1"
            );
        }
        let retired: serde_json::Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/design/evidence/windows-stage-a-2026-10-09-dns-sid-block-system-recovered-profile.json"))).unwrap();
        assert_eq!(retired["fixture_id"], receipt["fixture_id"]);
        assert!(retired["cleanup_debt"].as_array().unwrap().is_empty());
        for key in [
            "account_removed",
            "profile_removed",
            "filters_removed",
            "credential_removed",
        ] {
            assert_eq!(retired[key], true);
        }
    }
    #[test]
    fn actual_dns_parameter_failures_cannot_pass_network_gate() {
        let legacy: serde_json::Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/design/evidence/windows-stage-a-2026-10-09-dns-legacy-cache-shared-source.json"))).unwrap();
        for key in ["profile_removed", "fixture_acls_revoked"] {
            assert_eq!(legacy[key], true);
        }
        let internet: serde_json::Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/design/evidence/windows-stage-a-2026-10-09-dns-internet-capability-shared-source.json"))).unwrap();
        let internet_probe: ProbeReport =
            serde_json::from_value(internet["probe"].clone()).unwrap();
        assert!(!verified_fixed_probe(&internet_probe, false));
        let wire: Vec<_> = internet_probe
            .checks
            .iter()
            .filter(|check| {
                check.name.ends_with("DNS UDP API denied")
                    || check.name.ends_with("DNS TCP API denied")
            })
            .collect();
        assert_eq!(wire.len(), 4);
        for check in wire {
            let observation: shellspan_account_sandbox_prototype::dns_native_probe::DnsApiObservation = serde_json::from_str(&check.detail).unwrap();
            assert!(!check.passed && observation.completion_status == Some(0));
            assert!(observation.records_returned && observation.fixed_answer);
            assert!(!observation.explicit_api_denial());
        }
        let receivers: Vec<_> = internet_probe
            .checks
            .iter()
            .filter(|check| check.name.starts_with("DNS") && check.name.contains("receiver"))
            .collect();
        assert_eq!(receivers.len(), 2);
        assert!(receivers.iter().all(|check| !check.passed
            && check.detail == "owned DNS native before/after controls verified; received=2"));
        for key in ["profile_removed", "fixture_acls_revoked"] {
            assert_eq!(internet[key], true);
        }
        let crypto: serde_json::Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/design/evidence/windows-stage-a-2026-10-09-dns-crypto-capability-shared-source.json"))).unwrap();
        for key in ["profile_removed", "fixture_acls_revoked"] {
            assert_eq!(crypto[key], true);
        }
        let identity: serde_json::Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/design/evidence/windows-stage-a-2026-10-09-dns-identity-capability-shared-source.json"))).unwrap();
        let identity_probe: ProbeReport =
            serde_json::from_value(identity["probe"].clone()).unwrap();
        let contexts: Vec<_> = identity_probe
            .checks
            .iter()
            .filter(|check| check.name.ends_with("DNS self-context comparison"))
            .collect();
        assert_eq!(contexts.len(), 2);
        for check in contexts {
            let context: shellspan_account_sandbox_prototype::rpc_admission_probe::LsaSelfObservation = serde_json::from_str(&check.detail).unwrap();
            assert!(context.security_context_equal && context.restored);
            assert_eq!(context.connection.unwrap().connect_status, 0);
            assert_eq!(context.dns_cache_only.unwrap().completion_status, Some(87));
        }
        for key in ["profile_removed", "fixture_acls_revoked"] {
            assert_eq!(identity[key], true);
        }
        let latest_dedicated: serde_json::Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/design/evidence/windows-stage-a-2026-10-09-dns-contexts-system-profile.json"))).unwrap();
        let latest_report = &latest_dedicated["controller_admission_report"];
        assert_eq!(latest_report["execution_topology_verified"], true);
        assert_eq!(latest_report["process_tree_stopped"], true);
        let retired: serde_json::Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/design/evidence/windows-stage-a-2026-10-09-dns-contexts-system-recovered-profile.json"))).unwrap();
        assert_eq!(retired["fixture_id"], latest_dedicated["fixture_id"]);
        for key in [
            "account_removed",
            "profile_removed",
            "filters_removed",
            "credential_removed",
        ] {
            assert_eq!(retired[key], true, "{key}");
        }
        assert!(retired["cleanup_debt"].as_array().unwrap().is_empty());
        let audit: serde_json::Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/design/evidence/windows-stage-a-2026-10-09-dns-contexts-system-os-audit.json"))).unwrap();
        assert_eq!(audit["fixture_id"], retired["fixture_id"]);
        for key in [
            "account_absent",
            "profile_absent",
            "hive_absent",
            "services_absent",
        ] {
            assert_eq!(audit[key], true, "{key}");
        }
        let self_shared: serde_json::Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/design/evidence/windows-stage-a-2026-10-09-dns-self-bound-shared-source.json"))).unwrap();
        let self_probe: ProbeReport = serde_json::from_value(self_shared["probe"].clone()).unwrap();
        let comparisons: Vec<_> = self_probe
            .checks
            .iter()
            .filter(|check| check.name.ends_with("DNS self-context comparison"))
            .collect();
        assert_eq!(comparisons.len(), 2);
        for check in comparisons {
            let observation: shellspan_account_sandbox_prototype::rpc_admission_probe::LsaSelfObservation = serde_json::from_str(&check.detail).unwrap();
            assert!(
                check.passed
                    && observation.security_context_equal
                    && observation.restored
                    && observation.error.is_none()
            );
            let dns = observation.dns_cache_only.unwrap();
            assert_eq!(dns.completion_status, Some(87));
            assert!(!dns.explicit_api_denial());
        }
        let cache_shared: serde_json::Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/design/evidence/windows-stage-a-2026-10-09-dns-cache-only-shared-source.json"))).unwrap();
        for key in ["profile_removed", "fixture_acls_revoked"] {
            assert_eq!(cache_shared[key], true, "{key}");
        }
        let numeric_shared: serde_json::Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/design/evidence/windows-stage-a-2026-10-09-dns-numeric-local-shared-source.json"))).unwrap();
        for key in ["profile_removed", "fixture_acls_revoked"] {
            assert_eq!(numeric_shared[key], true, "{key}");
        }
        let numeric_probe: ProbeReport =
            serde_json::from_value(numeric_shared["probe"].clone()).unwrap();
        let numeric_controls: Vec<_> = numeric_probe
            .checks
            .iter()
            .filter(|check| check.name.ends_with("DNS numeric local API control"))
            .collect();
        assert_eq!(numeric_controls.len(), 2);
        for check in numeric_controls {
            let observation: shellspan_account_sandbox_prototype::dns_native_probe::DnsApiObservation = serde_json::from_str(&check.detail).unwrap();
            assert!(
                check.passed
                    && observation.dispatch_status == 0
                    && observation.completion_status == Some(0)
            );
            assert!(observation.records_returned && observation.fixed_answer);
            assert!(!observation.explicit_api_denial());
        }
        let current_shared: serde_json::Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/design/evidence/windows-stage-a-2026-10-09-dns-name-bound-shared-source.json"))).unwrap();
        assert!(!current_shared["error"].is_null());
        for key in ["profile_removed", "fixture_acls_revoked"] {
            assert_eq!(current_shared[key], true, "{key}");
        }
        // The candidate publishes the aggregate verification only after the
        // entire matrix passes. Individual receiver observations below are
        // positive, but failed DNS admission must keep this aggregate closed.
        assert_eq!(current_shared["receiver_quietness_verified"], false);
        let shared: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../docs/design/evidence/windows-stage-a-2026-10-09-dns-lpac-shared-source.json"
        )))
        .unwrap();
        let dedicated: serde_json::Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/design/evidence/windows-stage-a-2026-10-09-dns-network-system-profile.json"))).unwrap();
        for (value, expected_count) in [
            (&legacy["probe"], 156),
            (&crypto["probe"], 154),
            (&identity["probe"], 154),
            (&latest_report["workload_report"], 157),
            (&self_shared["probe"], 154),
            (&cache_shared["probe"], 152),
            (&numeric_shared["probe"], 150),
            (&current_shared["probe"], 148),
            (&shared["probe"], 148),
            (
                &dedicated["controller_admission_report"]["workload_report"],
                151,
            ),
        ] {
            let probe: ProbeReport = serde_json::from_value(value.clone()).unwrap();
            assert_eq!(probe.checks.len(), expected_count);
            assert!(!verified_fixed_probe(&probe, false));
            assert!(!verified_fixed_probe(&probe, true));
            let failed_dns: Vec<_> = probe
                .checks
                .iter()
                .filter(|check| check.name.contains("DNS") && !check.passed)
                .collect();
            assert_eq!(
                failed_dns.len(),
                if expected_count == 156 {
                    8
                } else if expected_count >= 152 {
                    6
                } else {
                    4
                }
            );
            for check in failed_dns {
                let observation: shellspan_account_sandbox_prototype::dns_native_probe::DnsApiObservation =
                    serde_json::from_str(&check.detail).unwrap();
                assert_eq!(observation.dispatch_status, 87, "{}", check.name);
                assert_eq!(observation.completion_status, Some(87), "{}", check.name);
                assert!(!observation.records_returned && !observation.fixed_answer);
                assert!(!observation.timed_out && observation.cancel_status.is_none());
                assert!(!observation.explicit_api_denial());
                assert!(!observation.verified_denial(true, 0));
            }
            let receivers: Vec<_> = probe
                .checks
                .iter()
                .filter(|check| check.name.contains("DNS") && check.name.contains("receiver"))
                .collect();
            assert_eq!(receivers.len(), 2);
            assert!(receivers.iter().all(|check| check.passed));
            assert!(receivers.iter().all(|check| check.detail
                == "owned DNS native before/after controls verified; received=0"));
        }
        let recovered: serde_json::Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/design/evidence/windows-stage-a-2026-10-09-dns-network-second-recovery-profile.json"))).unwrap();
        assert_eq!(recovered["fixture_id"], dedicated["fixture_id"]);
        for key in [
            "account_removed",
            "profile_removed",
            "filters_removed",
            "credential_removed",
        ] {
            assert_eq!(recovered[key], true, "{key}");
        }
        assert!(recovered["cleanup_debt"].as_array().unwrap().is_empty());
        let audit: serde_json::Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/design/evidence/windows-stage-a-2026-10-09-dns-network-second-recovery-os-audit.json"))).unwrap();
        assert_eq!(audit["fixture_id"], dedicated["fixture_id"]);
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
    fn dedicated_node_success_and_powershell_failure_remain_scoped_after_recovery() {
        for (bytes, expected, passed) in [
            (include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/design/evidence/windows-stage-a-2026-10-09-node-recovered-profile.json")), 73u64, true),
            (include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/design/evidence/windows-stage-a-2026-10-09-powershell-recovered-profile.json")), 0xffff0000u64, false),
        ] {
            let receipt: super::ProfileReceipt = serde_json::from_str(bytes).unwrap();
            receipt.validate(receipt.fixture_id).unwrap();
            assert!(receipt.cleanup_debt.is_empty());
            assert!(receipt.profile_removed && receipt.account_removed && receipt.filters_removed && receipt.credential_removed);
            let report = receipt.controller_admission_report.as_ref().unwrap();
            assert_eq!(report["tool_admission"]["actual_exit"], expected);
            assert_eq!(report["tool_admission"]["output_verified"], passed);
            assert_eq!(report["error"].is_null(), passed);
            assert_eq!(report["execution_topology_verified"], true);
            assert_eq!(report["execution_job_final_active"], 0);
            assert!(serde_json::from_value::<super::ProbeReport>(report["workload_report"].clone()).is_err());
            assert!(!receipt.account_lpac_verified);
            if !passed {
                assert!(report["tool_admission"]["stderr"].as_str().unwrap().contains("PSEtwLog"));
                assert!(receipt.error.as_ref().unwrap().contains("4294901760"));
            }
        }
    }
    #[test]
    fn dedicated_git_receipt_cannot_substitute_complete_workload_or_initial_cleanup() {
        let receipt: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../docs/design/evidence/windows-stage-a-2026-10-09-git-bundle-system-profile.json"
        )))
        .unwrap();
        let report = &receipt["controller_admission_report"];
        assert_eq!(report["tool_admission"]["actual_exit"], 0);
        assert!(
            shellspan_account_sandbox_prototype::fixed_tool::verified_git_version_output(
                report["tool_admission"]["stdout"].as_str().unwrap(),
                report["tool_admission"]["stderr"].as_str().unwrap()
            )
        );
        assert_eq!(report["execution_topology_verified"], true);
        assert_eq!(report["process_tree_stopped"], true);
        assert_eq!(report["execution_job_final_active"], 0);
        assert_eq!(report["workload_retired"], true);
        assert!(
            serde_json::from_value::<super::ProbeReport>(report["workload_report"].clone())
                .is_err()
        );
        assert!(!receipt["cleanup_debt"].as_array().unwrap().is_empty());
        let mut recovered: super::ProfileReceipt = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"),
            "/../../docs/design/evidence/windows-stage-a-2026-10-09-git-bundle-recovered-profile.json"))).unwrap();
        recovered.validate(recovered.fixture_id).unwrap();
        assert!(recovered.cleanup_debt.is_empty());
        assert!(
            recovered.profile_removed
                && recovered.account_removed
                && recovered.filters_removed
                && recovered.credential_removed
                && recovered.private_namespace_removed
                && recovered.private_station_removed
        );
        assert!(!recovered.account_lpac_verified);
        recovered.controller_lifecycle = super::FixedLifecycle::Timeout;
        assert!(recovered.validate(recovered.fixture_id).is_err());
    }
    use super::*;
    #[test]
    fn ordinary_primary_report_requires_exact_identity_and_one_outcome() {
        use shellspan_account_sandbox_prototype::appcontainer_probe::CredentialPrimaryObservation;
        let id = Uuid::new_v4();
        let sid = "S-1-5-21-1-2-3-1001";
        let mut observation = CredentialPrimaryObservation {
            version: 1,
            fixture_id: id,
            user_sid: sid.into(),
            denial_win32: Some(ERROR_NOT_FOUND),
            error: None,
            rpc_admission: None,
        };
        assert!(verified_ordinary_credential_observation(
            &observation,
            id,
            sid
        ));
        assert!(!verified_ordinary_credential_observation(
            &observation,
            Uuid::new_v4(),
            sid
        ));
        assert!(!verified_ordinary_credential_observation(
            &observation,
            id,
            "S-1-5-18"
        ));
        observation.error = Some("conflicting outcome".into());
        assert!(!verified_ordinary_credential_observation(
            &observation,
            id,
            sid
        ));
        observation.denial_win32 = None;
        observation.error = None;
        assert!(!verified_ordinary_credential_observation(
            &observation,
            id,
            sid
        ));
    }
    #[test]
    fn system_credential_negative_cannot_be_omitted_duplicated_or_failed() {
        use shellspan_account_sandbox_prototype::appcontainer_probe::ProbeCheck;
        let mut probe = ProbeReport {
            complete: true,
            checks: FIXED_PROBE_CHECKS
                .iter()
                .map(|name| ProbeCheck {
                    name: (*name).into(),
                    passed: true,
                    detail: "fixed test".into(),
                })
                .collect(),
        };
        assert!(!verified_fixed_probe(&probe, true));
        probe
            .checks
            .extend(CREDENTIAL_PROBE_CHECKS.iter().map(|name| ProbeCheck {
                name: (*name).into(),
                passed: true,
                detail: "fixed test".into(),
            }));
        assert!(verified_fixed_probe(&probe, true));
        let credential_index = probe.checks.len() - 1;
        probe.checks[credential_index].passed = false;
        assert!(!verified_fixed_probe(&probe, true));
        probe.checks[credential_index].passed = true;
        probe.checks.push(ProbeCheck {
            name: OWNED_CREDENTIAL_DENIAL_CHECK.into(),
            passed: true,
            detail: "replayed test".into(),
        });
        assert!(!verified_fixed_probe(&probe, true));
    }
    #[test]
    fn every_fixed_workload_check_must_be_present_once_and_pass() {
        use shellspan_account_sandbox_prototype::appcontainer_probe::ProbeCheck;
        let complete = || ProbeReport {
            complete: true,
            checks: FIXED_PROBE_CHECKS
                .iter()
                .map(|name| ProbeCheck {
                    name: (*name).into(),
                    passed: true,
                    detail: "contract regression".into(),
                })
                .collect(),
        };
        assert!(verified_fixed_probe(&complete(), false));
        for index in 0..FIXED_PROBE_CHECKS.len() {
            let mut missing = complete();
            missing.checks.remove(index);
            assert!(
                !verified_fixed_probe(&missing, false),
                "missing {}",
                FIXED_PROBE_CHECKS[index]
            );
            let mut failed = complete();
            failed.checks[index].passed = false;
            assert!(!verified_fixed_probe(&failed, false));
            let mut renamed = complete();
            renamed.checks[index].name = "unknown passing check".into();
            assert!(!verified_fixed_probe(&renamed, false));
            let mut duplicate = complete();
            duplicate.checks[index].name =
                FIXED_PROBE_CHECKS[(index + 1) % FIXED_PROBE_CHECKS.len()].into();
            assert!(!verified_fixed_probe(&duplicate, false));
        }
        let mut incomplete = complete();
        incomplete.complete = false;
        assert!(!verified_fixed_probe(&incomplete, false));
        assert!(!verified_fixed_probe(
            &ProbeReport {
                complete: true,
                checks: vec![]
            },
            false
        ));
    }
    #[test]
    fn interrupted_workload_cannot_substitute_repeated_or_unknown_passing_checks() {
        use shellspan_account_sandbox_prototype::appcontainer_probe::ProbeCheck;
        let mut probe = ProbeReport {
            complete: false,
            checks: INTERRUPTED_PROBE_CHECKS
                .iter()
                .map(|name| ProbeCheck {
                    name: (*name).into(),
                    passed: true,
                    detail: "interrupted fixture prefix".into(),
                })
                .collect(),
        };
        assert!(verified_interrupted_probe(&probe));
        for index in 0..probe.checks.len() {
            let original = probe.checks[index].name.clone();
            probe.checks[index].name =
                INTERRUPTED_PROBE_CHECKS[(index + 1) % INTERRUPTED_PROBE_CHECKS.len()].into();
            assert!(!verified_interrupted_probe(&probe));
            probe.checks[index].name = "unrelated passing check".into();
            assert!(!verified_interrupted_probe(&probe));
            probe.checks[index].name = original;
        }
        probe.complete = true;
        assert!(!verified_interrupted_probe(&probe));
    }
    #[test]
    fn actual_normal_os_receipt_keeps_failed_credential_gate_closed() {
        let receipt: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../docs/design/evidence/windows-stage-a-2026-10-09-hardlink-profile.json"
        )))
        .unwrap();
        let mut probe: ProbeReport = serde_json::from_value(
            receipt["controller_admission_report"]["workload_report"].clone(),
        )
        .unwrap();
        assert!(
            !verified_fixed_probe(&probe, true),
            "real LPAC credential 1702 must not become accepted by a stronger manifest"
        );
        assert!(probe
            .checks
            .iter()
            .any(|check| check.name == OWNED_CREDENTIAL_DENIAL_CHECK && !check.passed));
        probe
            .checks
            .retain(|check| !CREDENTIAL_PROBE_CHECKS.contains(&check.name.as_str()));
        assert!(
            !verified_fixed_probe(&probe, false),
            "old root-only observations cannot satisfy the expanded descendant network scope"
        );
    }
    #[test]
    fn actual_repeated_cancel_receipt_matches_only_interrupted_contract() {
        let receipt: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../docs/design/evidence/windows-stage-a-2026-10-09-repeated-cancel-profile.json"
        )))
        .unwrap();
        let probe: ProbeReport = serde_json::from_value(
            receipt["controller_admission_report"]["workload_report"].clone(),
        )
        .unwrap();
        assert!(verified_interrupted_probe(&probe));
        assert!(!verified_fixed_probe(&probe, false));
    }
    #[test]
    fn actual_descendant_network_receipt_cannot_cover_later_short_alias_scope() {
        let receipt: serde_json::Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/design/evidence/windows-stage-a-2026-10-09-descendant-network-profile.json"))).unwrap();
        let mut probe: ProbeReport = serde_json::from_value(
            receipt["controller_admission_report"]["workload_report"].clone(),
        )
        .unwrap();
        assert!(!verified_fixed_probe(&probe, true));
        probe
            .checks
            .retain(|check| !CREDENTIAL_PROBE_CHECKS.contains(&check.name.as_str()));
        assert!(
            !verified_fixed_probe(&probe, false),
            "this earlier receipt lacks short-alias observations"
        );
        assert_eq!(
            receipt["controller_admission_report"]["execution_job_final_active"],
            0
        );
        assert_eq!(
            receipt["controller_admission_report"]["execution_topology_verified"],
            true
        );
        let receivers: Vec<_> = probe
            .checks
            .iter()
            .filter(|check| check.name.contains("receiver") && check.name.ends_with("no traffic"))
            .collect();
        assert_eq!(receivers.len(), 4);
        assert!(receivers
            .iter()
            .all(|check| check.passed && check.detail.ends_with("received=0")));
    }
    #[test]
    fn historical_short_alias_receipt_lacks_new_parent_directory_checks() {
        let receipt: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../docs/design/evidence/windows-stage-a-2026-10-09-short-alias-profile.json"
        )))
        .unwrap();
        let mut probe: ProbeReport = serde_json::from_value(
            receipt["controller_admission_report"]["workload_report"].clone(),
        )
        .unwrap();
        assert!(!verified_fixed_probe(&probe, true));
        probe
            .checks
            .retain(|check| !CREDENTIAL_PROBE_CHECKS.contains(&check.name.as_str()));
        assert!(!verified_fixed_probe(&probe, false));
    }
    fn current_token() -> Handle {
        let mut raw = null_mut();
        win(
            unsafe {
                OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE, &mut raw)
            },
            "inspect regression Token",
        )
        .unwrap();
        Handle(raw)
    }
    fn assert_no_thread_token() {
        let mut raw = null_mut();
        assert_eq!(
            unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 1, &mut raw) },
            0
        );
        assert_eq!(unsafe { GetLastError() }, ERROR_NO_TOKEN);
    }
    #[test]
    fn lifecycle_trigger_requires_real_checkpoint_exit_and_full_live_membership() {
        for (mode, wait, exit, active) in [
            (
                FixedLifecycle::Timeout,
                WAIT_TIMEOUT,
                STILL_ACTIVE as u32,
                4,
            ),
            (
                FixedLifecycle::Cancel,
                WAIT_OBJECT_0 + 1,
                STILL_ACTIVE as u32,
                4,
            ),
            (FixedLifecycle::RootFailure, WAIT_OBJECT_0, 0xe7, 3),
            (
                FixedLifecycle::RepeatedCancel,
                WAIT_OBJECT_0 + 1,
                STILL_ACTIVE as u32,
                4,
            ),
            (
                FixedLifecycle::ServiceCrash,
                WAIT_TIMEOUT,
                STILL_ACTIVE as u32,
                4,
            ),
        ] {
            assert!(verified_lifecycle_trigger(
                mode, wait, exit, 4, active, true
            ));
            assert!(!verified_lifecycle_trigger(
                mode, wait, exit, 4, active, false
            ));
            assert!(!verified_lifecycle_trigger(
                mode, wait, exit, 5, active, true
            ));
            assert!(!verified_lifecycle_trigger(mode, wait, exit, 4, 0, true));
            assert!(!verified_lifecycle_trigger(
                mode,
                WAIT_FAILED,
                exit,
                4,
                active,
                true
            ));
            assert!(!verified_lifecycle_trigger(mode, wait, 73, 4, active, true));
        }
    }
    #[test]
    fn target_context_has_exact_thread_identity_and_restores_before_return() {
        let source = current_token();
        let expected = token_sid(source.0).unwrap();
        as_account(source.0, || {
            let mut raw = null_mut();
            win(
                unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 1, &mut raw) },
                "query actual SDK target context",
            )?;
            let actual = Handle(raw);
            assert_eq!(token_sid(actual.0)?, expected);
            Ok(())
        })
        .unwrap();
        assert_no_thread_token();
    }
    #[test]
    fn controller_privilege_audit_is_read_only_and_bounded_to_creation_rights() {
        let before = controller_privileges().unwrap();
        let after = controller_privileges().unwrap();
        assert_eq!(before, after);
        assert_eq!(before.as_object().unwrap().len(), 3);
        for value in before.as_object().unwrap().values() {
            assert!(value["present"].is_boolean());
            assert!(value["enabled"].is_boolean());
            if value["enabled"] == true {
                assert_eq!(value["present"], true);
            }
        }
    }
    #[test]
    fn account_context_restores_after_failure_and_rejects_nested_adoption() {
        let token = current_token();
        assert_no_thread_token();
        let result = as_account(token.0, || -> Result<()> {
            let nested = as_account(token.0, || Ok(()));
            assert!(nested.unwrap_err().contains("already impersonating"));
            Err("fixed injected failure".into())
        });
        assert!(result.unwrap_err().contains("injected failure"));
        assert_no_thread_token();
        as_account(token.0, || Ok(())).unwrap();
        assert_no_thread_token();
    }
    #[test]
    fn dedicated_capability_gate_rejects_duplicates_extra_and_attribute_changes() {
        let registry = startup_capability("registryRead").unwrap();
        let instrumentation = startup_capability("lpacInstrumentation").unwrap();
        assert!(startup_capability("internetClient").is_err());
        let entry = |sid| SID_AND_ATTRIBUTES {
            Sid: sid,
            Attributes: SE_GROUP_ENABLED as u32,
        };
        let expected = [entry(registry.0), entry(instrumentation.0)];
        assert!(exact_startup_capabilities(&expected, &expected));
        assert!(exact_startup_capabilities(
            &[entry(instrumentation.0), entry(registry.0)],
            &expected
        ));
        assert!(!exact_startup_capabilities(&expected[..1], &expected));
        let duplicate = [entry(registry.0), entry(registry.0)];
        assert!(!exact_startup_capabilities(&duplicate, &expected));
        assert!(!exact_startup_capabilities(&duplicate, &duplicate));
        let mut changed = [entry(registry.0), entry(instrumentation.0)];
        changed[1].Attributes = 0;
        assert!(!exact_startup_capabilities(&changed, &expected));
        changed[1].Sid = null_mut();
        assert!(!exact_startup_capabilities(&changed, &expected));
        assert!(!exact_startup_capabilities(&expected, &[]));
        assert!(exact_startup_capabilities(&[], &[]));
    }
    #[test]
    fn ordinary_token_does_not_pass_actual_lpac_negative_control() {
        let token = current_token();
        let user = token_sid(token.0).unwrap();
        assert!(!actual_lpac(token.0, &user, "S-1-15-2-11-22-33-44-55-66-77").unwrap());
        let capability = startup_capability("registryRead").unwrap();
        assert_ne!(unsafe { IsValidSid(capability.0) }, 0);
    }
}
