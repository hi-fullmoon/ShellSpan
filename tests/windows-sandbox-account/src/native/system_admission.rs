//! Immutable preparation for the fixed SYSTEM admission experiment, not a broker.
use super::*;
use std::io::{Read, Seek, SeekFrom};
use std::os::windows::fs::OpenOptionsExt;
mod service;
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum FixedSystemTool {
    GitBundle,
    GitBundleInit,
    GitPrefixProbe,
    CrossSlotRegistryProbe,
    Node,
    NodePackageBlock,
    NodeRpcBlock,
    DnsPackageBlockProbe,
    DnsPackageBlockInternetProbe,
    DnsRpcBlockInternetProbe,
    DnsRpcInstrumentationInternetProbe,
    DnsRpcInstrumentationDefaultProbe,
    PowerShell,
    PowerShell7RuntimeInstrumentation,
    PowerShell7RuntimeArtifact,
    PowerShell7RuntimeBuild,
}
impl FixedSystemTool {
    pub(super) fn uses_instrumentation(self) -> bool {
        self.uses_powershell_runtime()
            || matches!(
                self,
                Self::DnsRpcInstrumentationInternetProbe | Self::DnsRpcInstrumentationDefaultProbe
            )
    }
    pub(super) fn uses_diagnostic_internet(self) -> bool {
        matches!(
            self,
            Self::DnsPackageBlockInternetProbe
                | Self::DnsRpcBlockInternetProbe
                | Self::DnsRpcInstrumentationInternetProbe
        )
    }
    pub(super) fn uses_powershell_runtime(self) -> bool {
        matches!(
            self,
            Self::PowerShell7RuntimeInstrumentation
                | Self::PowerShell7RuntimeArtifact
                | Self::PowerShell7RuntimeBuild
        )
    }
    pub(super) fn fixed_tool(
        self,
    ) -> Option<shellspan_account_sandbox_prototype::fixed_tool::FixedTool> {
        use shellspan_account_sandbox_prototype::fixed_tool::FixedTool;
        Some(match self {
            Self::DnsPackageBlockProbe
            | Self::DnsPackageBlockInternetProbe
            | Self::DnsRpcBlockInternetProbe
            | Self::DnsRpcInstrumentationInternetProbe
            | Self::DnsRpcInstrumentationDefaultProbe => return None,
            Self::GitBundle => FixedTool::GitBundle,
            Self::GitBundleInit => FixedTool::GitBundleInit,
            Self::GitPrefixProbe => FixedTool::GitPrefixProbe,
            Self::CrossSlotRegistryProbe => FixedTool::CrossSlotRegistryProbe,
            Self::Node | Self::NodePackageBlock | Self::NodeRpcBlock => FixedTool::Node,
            Self::PowerShell => FixedTool::PowerShell,
            Self::PowerShell7RuntimeInstrumentation => FixedTool::PowerShell7Runtime,
            Self::PowerShell7RuntimeArtifact => FixedTool::PowerShell7RuntimeArtifact,
            Self::PowerShell7RuntimeBuild => FixedTool::PowerShell7RuntimeBuild,
        })
    }
}
pub(super) fn validate_tool_dispatch(
    tool: Option<FixedSystemTool>,
    workload: bool,
    lifecycle: FixedLifecycle,
    recovery: Option<Uuid>,
) -> Result<()> {
    if tool.is_some() && (!workload || lifecycle != FixedLifecycle::Normal || recovery.is_some()) {
        return Err("fixed tool conflicts with workload, lifecycle or recovery dispatch".into());
    }
    Ok(())
}
pub(super) fn verify_workload_recovery_service(id: Uuid) -> Result<()> {
    service::verify_workload_recovery_service(id)
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum FixedLifecycle {
    #[default]
    Normal,
    Timeout,
    Cancel,
    RepeatedCancel,
    ConcurrentCancel,
    RootFailure,
    ServiceCrash,
}
impl FixedLifecycle {
    fn experiment(value: &str) -> Result<Self> {
        match value {
            "timeout" => Ok(Self::Timeout),
            "cancel" => Ok(Self::Cancel),
            "repeated-cancel" => Ok(Self::RepeatedCancel),
            "concurrent-cancel" => Ok(Self::ConcurrentCancel),
            "root-failure" => Ok(Self::RootFailure),
            "service-crash" => Ok(Self::ServiceCrash),
            _ => Err("only fixed timeout, cancel, repeated-cancel, concurrent-cancel, root-failure or service-crash experiments are supported".into()),
        }
    }
    pub(super) fn environment(self) -> &'static str {
        match self {
            Self::Normal => "",
            Self::Timeout | Self::Cancel | Self::RepeatedCancel | Self::ServiceCrash => {
                "SSPA_LIFECYCLE=timeout\0"
            }
            Self::ConcurrentCancel => "SSPA_LIFECYCLE=concurrent-cancel\0",
            Self::RootFailure => "SSPA_LIFECYCLE=root-failure\0",
        }
    }
}
pub(super) fn dispatch(id: &str) -> Result<()> {
    service::dispatch(id)
}
pub(super) fn run(id: &str) -> Result<()> {
    service::run(id)
}
pub(super) fn recover(id: &str) -> Result<()> {
    service::recover(id)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ServiceExitObservation {
    win32_exit_code: u32,
    service_specific_exit_code: u32,
    process_exit_confirmed: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Preparation {
    version: u32,
    backend: String,
    production: String,
    fixture_id: Uuid,
    image_volume: u32,
    image_file_index: u64,
    image_size: u64,
    state: String,
    #[serde(default)]
    service_install_planned: bool,
    #[serde(default)]
    service_created: bool,
    #[serde(default)]
    service_removed: bool,
    #[serde(default)]
    observed_service_exit: Option<ServiceExitObservation>,
    #[serde(default)]
    fixed_workload: bool,
    #[serde(default)]
    fixed_lifecycle: FixedLifecycle,
    #[serde(default)]
    fixed_tool: Option<FixedSystemTool>,
    #[serde(default)]
    recovery_target: Option<Uuid>,
}

fn held_image(file: &fs::File, require_single_link: bool) -> Result<BY_HANDLE_FILE_INFORMATION> {
    use std::os::windows::io::AsRawHandle;
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    win(
        unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) },
        "freeze fixed SYSTEM image identity",
    )?;
    if info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT) != 0
        || (require_single_link && info.nNumberOfLinks != 1)
    {
        return Err("SYSTEM image must be a single-link regular file".into());
    }
    Ok(info)
}

pub(super) fn prepare() -> Result<()> {
    prepare_inner(false, FixedLifecycle::Normal, None, None)
}
pub(super) fn prepare_workload() -> Result<()> {
    prepare_inner(true, FixedLifecycle::Normal, None, None)
}
pub(super) fn prepare_git_bundle() -> Result<()> {
    prepare_inner(
        true,
        FixedLifecycle::Normal,
        None,
        Some(FixedSystemTool::GitBundle),
    )
}
pub(super) fn prepare_dns_rpc_block_internet() -> Result<()> {
    prepare_inner(
        true,
        FixedLifecycle::Normal,
        None,
        Some(FixedSystemTool::DnsRpcBlockInternetProbe),
    )
}
pub(super) fn prepare_dns_rpc_instrumentation_internet() -> Result<()> {
    prepare_inner(
        true,
        FixedLifecycle::Normal,
        None,
        Some(FixedSystemTool::DnsRpcInstrumentationInternetProbe),
    )
}
pub(super) fn prepare_dns_rpc_instrumentation_default() -> Result<()> {
    prepare_inner(
        true,
        FixedLifecycle::Normal,
        None,
        Some(FixedSystemTool::DnsRpcInstrumentationDefaultProbe),
    )
}
pub(super) fn prepare_dns_package_block_internet() -> Result<()> {
    prepare_inner(
        true,
        FixedLifecycle::Normal,
        None,
        Some(FixedSystemTool::DnsPackageBlockInternetProbe),
    )
}
pub(super) fn prepare_dns_package_block() -> Result<()> {
    prepare_inner(
        true,
        FixedLifecycle::Normal,
        None,
        Some(FixedSystemTool::DnsPackageBlockProbe),
    )
}
pub(super) fn prepare_node_rpc_block() -> Result<()> {
    prepare_inner(
        true,
        FixedLifecycle::Normal,
        None,
        Some(FixedSystemTool::NodeRpcBlock),
    )
}
pub(super) fn prepare_node_package_block() -> Result<()> {
    prepare_inner(
        true,
        FixedLifecycle::Normal,
        None,
        Some(FixedSystemTool::NodePackageBlock),
    )
}
pub(super) fn prepare_node() -> Result<()> {
    prepare_inner(
        true,
        FixedLifecycle::Normal,
        None,
        Some(FixedSystemTool::Node),
    )
}
pub(super) fn prepare_powershell() -> Result<()> {
    prepare_inner(
        true,
        FixedLifecycle::Normal,
        None,
        Some(FixedSystemTool::PowerShell),
    )
}
pub(super) fn prepare_powershell7_runtime() -> Result<()> {
    prepare_inner(
        true,
        FixedLifecycle::Normal,
        None,
        Some(FixedSystemTool::PowerShell7RuntimeInstrumentation),
    )
}
pub(super) fn prepare_powershell7_artifact() -> Result<()> {
    prepare_inner(
        true,
        FixedLifecycle::Normal,
        None,
        Some(FixedSystemTool::PowerShell7RuntimeArtifact),
    )
}
pub(super) fn prepare_powershell7_build() -> Result<()> {
    prepare_inner(
        true,
        FixedLifecycle::Normal,
        None,
        Some(FixedSystemTool::PowerShell7RuntimeBuild),
    )
}
pub(super) fn prepare_git_init() -> Result<()> {
    prepare_inner(
        true,
        FixedLifecycle::Normal,
        None,
        Some(FixedSystemTool::GitBundleInit),
    )
}
pub(super) fn prepare_git_prefix_probe() -> Result<()> {
    prepare_inner(
        true,
        FixedLifecycle::Normal,
        None,
        Some(FixedSystemTool::GitPrefixProbe),
    )
}
pub(super) fn prepare_cross_slot_registry_probe() -> Result<()> {
    prepare_inner(
        true,
        FixedLifecycle::Normal,
        None,
        Some(FixedSystemTool::CrossSlotRegistryProbe),
    )
}
pub(super) fn prepare_lifecycle(value: &str) -> Result<()> {
    prepare_inner(true, FixedLifecycle::experiment(value)?, None, None)
}
pub(super) fn prepare_recovery(value: &str) -> Result<()> {
    let id = Uuid::parse_str(value).map_err(|_| "invalid recovery target UUID")?;
    if id.is_nil() || id.to_string() != value {
        return Err("recovery target requires canonical nonnil UUID".into());
    }
    account_profile::verify_recovery_intent(id)?;
    prepare_inner(false, FixedLifecycle::Normal, Some(id), None)
}
fn prepare_inner(
    fixed_workload: bool,
    fixed_lifecycle: FixedLifecycle,
    recovery_target: Option<Uuid>,
    fixed_tool: Option<FixedSystemTool>,
) -> Result<()> {
    validate_tool_dispatch(fixed_tool, fixed_workload, fixed_lifecycle, recovery_target)?;
    if !elevated()? {
        return Err(
            "fixed SYSTEM preparation requires elevated setup; no resources changed".into(),
        );
    }
    let id = Uuid::new_v4();
    let root = fixture_parent()?.join(format!("ShellSpan-system-admission-A-{id}"));
    protected_fixture(&root)?;
    recovery::verify_evidence_acl(&root)?;
    // Publish intent before creating the image. No service/task is installed here.
    let mut plan = Preparation {
        version: 1,
        backend: "fixed-system-admission-preparation-v1".into(),
        production: "unavailable".into(),
        fixture_id: id,
        image_volume: 0,
        image_file_index: 0,
        image_size: 0,
        state: "copy planned; SYSTEM dispatch forbidden".into(),
        service_install_planned: false,
        service_created: false,
        service_removed: false,
        observed_service_exit: None,
        fixed_workload,
        recovery_target,
        fixed_lifecycle,
        fixed_tool,
    };
    journal::publish(
        &root.join("ownership.json"),
        &serde_json::to_vec_pretty(&plan).map_err(|e| e.to_string())?,
        false,
    )?;
    let mut source = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(std::env::current_exe().map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    // Cargo may hardlink its output. The read-only sharing lease prevents writes
    // through every source alias during copying; the protected target must be unique.
    held_image(&source, false)?;
    let path = root.join("fixed-admission.exe");
    let mut target = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .share_mode(FILE_SHARE_READ)
        .open(&path)
        .map_err(|e| e.to_string())?;
    let copied = std::io::copy(
        &mut Read::by_ref(&mut source).take(64 * 1024 * 1024 + 1),
        &mut target,
    )
    .map_err(|e| e.to_string())?;
    if copied == 0 || copied > 64 * 1024 * 1024 {
        return Err("fixed SYSTEM image copy budget exceeded".into());
    }
    target.sync_all().map_err(|e| e.to_string())?;
    source.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    target.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    let mut source_bytes = [0u8; 65536];
    let mut target_bytes = [0u8; 65536];
    loop {
        let length = source.read(&mut source_bytes).map_err(|e| e.to_string())?;
        target
            .read_exact(&mut target_bytes[..length])
            .map_err(|e| e.to_string())?;
        if source_bytes[..length] != target_bytes[..length] {
            return Err("fixed SYSTEM image copy differs".into());
        }
        if length == 0 {
            break;
        }
    }
    recovery::verify_evidence_acl(&path)?;
    let info = held_image(&target, true)?;
    plan.image_volume = info.dwVolumeSerialNumber;
    plan.image_file_index = (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow);
    plan.image_size = copied;
    plan.state = "protected image prepared; service installation not requested".into();
    journal::publish(
        &root.join("ownership.json"),
        &serde_json::to_vec_pretty(&plan).map_err(|e| e.to_string())?,
        false,
    )?;
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
    fn actual_scm_failure_and_recovery_success_remain_distinct() {
        let failed: Preparation = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../docs/design/evidence/windows-stage-a-2026-10-09-scm-status-service.json"
        )))
        .unwrap();
        let recovered: Preparation = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/design/evidence/windows-stage-a-2026-10-09-scm-status-recovery-service.json"))).unwrap();
        assert!(failed.service_removed && recovered.service_removed);
        let failure = failed.observed_service_exit.unwrap();
        assert_eq!(failure.win32_exit_code, 1066);
        assert_eq!(failure.service_specific_exit_code, 2);
        assert!(failure.process_exit_confirmed);
        let success = recovered.observed_service_exit.unwrap();
        assert_eq!(success.win32_exit_code, 0);
        assert_eq!(success.service_specific_exit_code, 0);
        assert!(success.process_exit_confirmed);
        assert_eq!(recovered.recovery_target, Some(failed.fixture_id));
    }
    #[test]
    fn service_exit_observation_preserves_failure_and_legacy_unknown_state() {
        let legacy: Preparation = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../docs/design/evidence/windows-stage-a-2026-10-09-namespace-wait-service.json"
        )))
        .unwrap();
        assert!(legacy.service_removed);
        assert!(legacy.observed_service_exit.is_none());
        let observed = ServiceExitObservation {
            win32_exit_code: windows_sys::Win32::Foundation::ERROR_SERVICE_SPECIFIC_ERROR,
            service_specific_exit_code: 2,
            process_exit_confirmed: true,
        };
        let value = serde_json::to_value(&observed).unwrap();
        assert_eq!(
            value["win32_exit_code"],
            windows_sys::Win32::Foundation::ERROR_SERVICE_SPECIFIC_ERROR
        );
        assert_eq!(value["service_specific_exit_code"], 2);
        let parsed: ServiceExitObservation = serde_json::from_value(value.clone()).unwrap();
        assert!(parsed.process_exit_confirmed);
        let mut changed = value;
        changed["untrusted_extra"] = serde_json::json!(true);
        assert!(serde_json::from_value::<ServiceExitObservation>(changed).is_err());
    }
    #[test]
    fn instrumentation_without_network_is_a_distinct_frozen_dispatch() {
        let default = FixedSystemTool::DnsRpcInstrumentationDefaultProbe;
        assert!(default.uses_instrumentation());
        assert!(!default.uses_diagnostic_internet());
        assert!(!default.uses_powershell_runtime());
        assert!(default.fixed_tool().is_none());
        let internet = FixedSystemTool::DnsRpcInstrumentationInternetProbe;
        assert!(internet.uses_instrumentation());
        assert!(internet.uses_diagnostic_internet());
        for tool in [
            FixedSystemTool::Node,
            FixedSystemTool::NodePackageBlock,
            FixedSystemTool::NodeRpcBlock,
            FixedSystemTool::DnsPackageBlockProbe,
            FixedSystemTool::PowerShell7RuntimeBuild,
        ] {
            assert!(!tool.uses_diagnostic_internet());
        }
        assert!(!FixedSystemTool::DnsRpcBlockInternetProbe.uses_instrumentation());
        let parsed: FixedSystemTool =
            serde_json::from_str("\"dns_rpc_instrumentation_default_probe\"").unwrap();
        assert_eq!(parsed, default);
        assert!(serde_json::from_str::<FixedSystemTool>(
            "\"dns_rpc_instrumentation_default_probe internetClient\""
        )
        .is_err());
    }
    #[test]
    fn only_fixed_powershell_runtime_variants_use_expanded_recovery_budget() {
        for tool in [
            FixedSystemTool::PowerShell7RuntimeInstrumentation,
            FixedSystemTool::PowerShell7RuntimeArtifact,
            FixedSystemTool::PowerShell7RuntimeBuild,
        ] {
            assert!(tool.uses_powershell_runtime());
        }
        for tool in [
            FixedSystemTool::GitBundle,
            FixedSystemTool::GitBundleInit,
            FixedSystemTool::GitPrefixProbe,
            FixedSystemTool::CrossSlotRegistryProbe,
            FixedSystemTool::Node,
            FixedSystemTool::NodePackageBlock,
            FixedSystemTool::NodeRpcBlock,
            FixedSystemTool::DnsPackageBlockProbe,
            FixedSystemTool::DnsPackageBlockInternetProbe,
            FixedSystemTool::DnsRpcBlockInternetProbe,
            FixedSystemTool::DnsRpcInstrumentationInternetProbe,
            FixedSystemTool::DnsRpcInstrumentationDefaultProbe,
            FixedSystemTool::PowerShell,
        ] {
            assert!(!tool.uses_powershell_runtime());
        }
        assert!(matches!(
            FixedSystemTool::PowerShell7RuntimeArtifact.fixed_tool(),
            Some(shellspan_account_sandbox_prototype::fixed_tool::FixedTool::PowerShell7RuntimeArtifact)
        ));
        let parsed: FixedSystemTool =
            serde_json::from_str("\"power_shell7_runtime_artifact\"").unwrap();
        assert_eq!(parsed, FixedSystemTool::PowerShell7RuntimeArtifact);
        assert!(
            serde_json::from_str::<FixedSystemTool>("\"power_shell7_runtime_artifact extra\"")
                .is_err()
        );
    }
    #[test]
    fn tool_dispatch_requires_frozen_normal_workload_without_recovery() {
        for tool in [
            FixedSystemTool::GitBundle,
            FixedSystemTool::GitBundleInit,
            FixedSystemTool::GitPrefixProbe,
            FixedSystemTool::CrossSlotRegistryProbe,
            FixedSystemTool::Node,
            FixedSystemTool::NodePackageBlock,
            FixedSystemTool::NodeRpcBlock,
            FixedSystemTool::DnsPackageBlockProbe,
            FixedSystemTool::DnsPackageBlockInternetProbe,
            FixedSystemTool::DnsRpcBlockInternetProbe,
            FixedSystemTool::DnsRpcInstrumentationInternetProbe,
            FixedSystemTool::DnsRpcInstrumentationDefaultProbe,
            FixedSystemTool::PowerShell,
            FixedSystemTool::PowerShell7RuntimeInstrumentation,
            FixedSystemTool::PowerShell7RuntimeArtifact,
            FixedSystemTool::PowerShell7RuntimeBuild,
        ] {
            let tool = Some(tool);
            assert!(validate_tool_dispatch(tool, true, FixedLifecycle::Normal, None).is_ok());
            assert!(validate_tool_dispatch(tool, false, FixedLifecycle::Normal, None).is_err());
            assert!(validate_tool_dispatch(
                tool,
                true,
                FixedLifecycle::Normal,
                Some(Uuid::new_v4())
            )
            .is_err());
            for mode in [
                FixedLifecycle::Timeout,
                FixedLifecycle::Cancel,
                FixedLifecycle::RepeatedCancel,
                FixedLifecycle::ConcurrentCancel,
                FixedLifecycle::RootFailure,
                FixedLifecycle::ServiceCrash,
            ] {
                assert!(validate_tool_dispatch(tool, true, mode, None).is_err());
            }
        }
        for value in ["\"git\"", "\"git_bundle extra\"", "{\"command\":\"git\"}"] {
            assert!(serde_json::from_str::<FixedSystemTool>(value).is_err());
        }
    }
    #[test]
    fn lifecycle_contract_rejects_unknown_modes_and_freezes_fixed_leaf_behavior() {
        assert_eq!(
            FixedLifecycle::experiment("concurrent-cancel").unwrap(),
            FixedLifecycle::ConcurrentCancel
        );
        assert_eq!(
            FixedLifecycle::ConcurrentCancel.environment(),
            "SSPA_LIFECYCLE=concurrent-cancel\0"
        );
        assert_eq!(
            FixedLifecycle::experiment("timeout").unwrap(),
            FixedLifecycle::Timeout
        );
        assert_eq!(
            FixedLifecycle::experiment("cancel").unwrap().environment(),
            FixedLifecycle::Timeout.environment()
        );
        assert_eq!(
            FixedLifecycle::experiment("repeated-cancel").unwrap(),
            FixedLifecycle::RepeatedCancel
        );
        assert_eq!(
            FixedLifecycle::RepeatedCancel.environment(),
            FixedLifecycle::Timeout.environment()
        );
        assert_eq!(
            FixedLifecycle::experiment("root-failure").unwrap(),
            FixedLifecycle::RootFailure
        );
        assert_eq!(
            FixedLifecycle::experiment("service-crash")
                .unwrap()
                .environment(),
            FixedLifecycle::Timeout.environment()
        );
        for value in ["normal", "cmd.exe", "timeout --command arbitrary", ""] {
            assert!(FixedLifecycle::experiment(value).is_err());
        }
        assert!(serde_json::from_str::<FixedLifecycle>("\"arbitrary\"").is_err());
    }
    #[test]
    fn protected_target_rejects_hardlink_alias_while_source_lease_blocks_writes() {
        let root =
            std::env::temp_dir().join(format!("ShellSpan-system-copy-test-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let path = root.join("image");
        let alias = root.join("alias");
        fs::write(&path, b"fixed test image").unwrap();
        fs::hard_link(&path, &alias).unwrap();
        let held = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ)
            .open(&path)
            .unwrap();
        assert!(held_image(&held, false).is_ok());
        assert!(held_image(&held, true).is_err());
        assert!(OpenOptions::new().write(true).open(&alias).is_err());
        drop(held);
        // Test fixtures follow the same recoverable deletion policy as local files.
        trash::delete(&root).unwrap();
    }
    #[test]
    fn system_preparation_rejects_arbitrary_dispatch_fields() {
        let value = serde_json::json!({"version":1,"backend":"fixed-system-admission-preparation-v1","production":"unavailable","fixture_id":Uuid::new_v4(),"image_volume":1,"image_file_index":2,"image_size":3,"state":"prepared","command":"powershell arbitrary"});
        assert!(serde_json::from_value::<Preparation>(value).is_err());
    }
    #[test]
    fn dns_package_block_uses_full_probe_without_a_tool_command() {
        assert!(FixedSystemTool::DnsPackageBlockProbe.fixed_tool().is_none());
        assert!(!FixedSystemTool::DnsPackageBlockProbe.uses_powershell_runtime());
        assert!(validate_tool_dispatch(
            Some(FixedSystemTool::DnsPackageBlockProbe),
            true,
            FixedLifecycle::Normal,
            None
        )
        .is_ok());
        assert!(validate_tool_dispatch(
            Some(FixedSystemTool::DnsPackageBlockProbe),
            false,
            FixedLifecycle::Normal,
            None
        )
        .is_err());
    }
}
