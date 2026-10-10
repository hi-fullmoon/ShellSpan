//! Fixed SYSTEM journal preparation/readback only. No account or input creation.
use super::*;
use sha2::{Digest, Sha256};
use shellspan_account_sandbox_prototype::{
    account_lpac_plan,
    frontend_bundle_journal::{BundleJournal, ObjectIdentity},
    frontend_runtime_inventory::RuntimeInventory,
};
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Anchor {
    version: u32,
    backend: String,
    production: String,
    fixture_id: Uuid,
    parent: ObjectIdentity,
    inventory_sha256: String,
    plan_sha256: String,
    pages: usize,
    objects: usize,
    phase: String,
    accounts_created: bool,
    filters_installed: bool,
    input_namespace_created: bool,
}
impl Anchor {
    fn validate(&self, id: Uuid, parent: &ObjectIdentity) -> Result<()> {
        if self.version != 1
            || self.backend != "fixed-frontend-journal-v1"
            || self.production != "unavailable"
            || self.fixture_id != id
            || &self.parent != parent
            || self.phase != "prepared; execution forbidden"
            || self.accounts_created
            || self.filters_installed
            || self.input_namespace_created
            || self.objects == 0
            || self.objects > 100000
            || self.pages != self.objects.div_ceil(64)
        {
            return Err("frontend journal anchor binding or completion differs".into());
        }
        Ok(())
    }
}
fn hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
pub(super) fn recover(recovery_id: Uuid, target: Uuid) -> Result<()> {
    if recovery_id.is_nil()
        || target.is_nil()
        || recovery_id == target
        || token_sid(token()?.0)? != "S-1-5-18"
    {
        return Err(
            "independent frontend recovery requires exact SYSTEM context and distinct UUIDs".into(),
        );
    }
    let root = fixture_parent()?.join(format!("ShellSpan-account-profile-A-{target}"));
    let held = Handle(unsafe {
        CreateFileW(
            wide(root.to_str().ok_or("invalid recovery record root")?).as_ptr(),
            FILE_READ_ATTRIBUTES | READ_CONTROL,
            FILE_SHARE_READ,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    });
    if held.0 == INVALID_HANDLE_VALUE {
        return Err("hold original frontend record root failed".into());
    }
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    win(
        unsafe { GetFileInformationByHandle(held.0, &mut info) },
        "observe original frontend record identity",
    )?;
    if info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
        || info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
    {
        return Err("original frontend record root type differs".into());
    }
    let identity = ObjectIdentity {
        volume: info.dwVolumeSerialNumber,
        file_id: ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
    };
    let anchor: Anchor = serde_json::from_slice(&account_lpac_plan::read_protected_receipt(&root)?)
        .map_err(|e| e.to_string())?;
    anchor.validate(target, &identity)?;
    let plan = account_lpac_plan::read_protected_frontend_plan(&root, target, &anchor.plan_sha256)?;
    if plan.retirement_object_count() != anchor.objects {
        return Err("independent frontend plan count differs".into());
    }
    let journal = BundleJournal::restore_for_retirement(
        &plan,
        target,
        identity,
        &anchor.inventory_sha256,
        |index| account_lpac_plan::read_protected_frontend_page(&root, target, index),
    )?;
    if journal.creation_admitted(0).is_ok() || journal.retirement_confirmed() {
        return Err("independent frontend recovery gate differs".into());
    }
    let report = serde_json::json!({"version":1,"production":"unavailable","recovery_id":recovery_id,"fixture_id":target,"actual_system":true,"independent_process":true,"original_service_retired":true,"source_inventory_opened":false,"objects":anchor.objects,"pages":anchor.pages,"all_pages_bound":true,"recovery_creation_blocked":true,"planned_not_counted_as_retired":true,"accounts_created":false,"filters_installed":false,"input_namespace_created":false,"records_mutated":false});
    let result_root = fixture_parent()?.join(format!("ShellSpan-system-admission-A-{recovery_id}"));
    journal::publish(
        &result_root.join("frontend-journal-recovery-result.json"),
        &serde_json::to_vec(&report).map_err(|e| e.to_string())?,
        false,
    )
}
pub(super) fn run(id: Uuid) -> Result<()> {
    if id.is_nil() || token_sid(token()?.0)? != "S-1-5-18" {
        return Err("frontend journal requires actual SYSTEM token".into());
    }
    let parent = fixture_parent()?;
    if parent != Path::new(r"C:\ProgramData") {
        return Err("frontend journal fixed ProgramData scope differs".into());
    }
    let inventory = RuntimeInventory::inspect_fixed()?;
    let plan = inventory.bundle_plan()?;
    let plan_bytes = serde_json::to_vec(&plan).map_err(|e| e.to_string())?;
    let plan_sha256 = hash(&plan_bytes);
    let inventory_sha256 = hash(&serde_json::to_vec(&inventory).map_err(|e| e.to_string())?);
    let root = parent.join(format!("ShellSpan-account-profile-A-{id}"));
    protected_fixture(&root)?;
    let held = Handle(unsafe {
        CreateFileW(
            wide(root.to_str().ok_or("invalid frontend journal root")?).as_ptr(),
            FILE_READ_ATTRIBUTES | READ_CONTROL,
            FILE_SHARE_READ,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    });
    if held.0 == INVALID_HANDLE_VALUE {
        return Err("hold frontend journal root failed".into());
    }
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    win(
        unsafe { GetFileInformationByHandle(held.0, &mut info) },
        "observe frontend journal parent",
    )?;
    if info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
        || info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
    {
        return Err("frontend journal root type differs".into());
    }
    let identity = ObjectIdentity {
        volume: info.dwVolumeSerialNumber,
        file_id: ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
    };
    let pages = plan.retirement_object_count().div_ceil(64);
    let mut anchor = Anchor {
        version: 1,
        backend: "fixed-frontend-journal-v1".into(),
        production: "unavailable".into(),
        fixture_id: id,
        parent: identity.clone(),
        inventory_sha256: inventory_sha256.clone(),
        plan_sha256,
        pages,
        objects: plan.retirement_object_count(),
        phase: "preparing".into(),
        accounts_created: false,
        filters_installed: false,
        input_namespace_created: false,
    };
    journal::publish(
        &root.join("ownership.json"),
        &serde_json::to_vec(&anchor).map_err(|e| e.to_string())?,
        false,
    )?;
    journal::publish_frontend_plan(&root.join("frontend-bundle-plan.json"), &plan_bytes)?;
    let prepared = BundleJournal::prepare(
        &plan,
        id,
        identity.clone(),
        &inventory_sha256,
        |index, bytes| {
            let path = root.join(format!("frontend-bundle-page-{index:04}.json"));
            if path.try_exists().map_err(|e| e.to_string())? {
                return Err("frontend journal new page already exists".into());
            }
            journal::publish(&path, bytes, false)
        },
    )?;
    anchor.phase = "prepared; execution forbidden".into();
    journal::publish(
        &root.join("ownership.json"),
        &serde_json::to_vec(&anchor).map_err(|e| e.to_string())?,
        false,
    )?;
    drop(inventory);
    drop(plan);
    drop(prepared);
    drop(anchor);
    let recovered_anchor: Anchor =
        serde_json::from_slice(&account_lpac_plan::read_protected_receipt(&root)?)
            .map_err(|e| e.to_string())?;
    recovered_anchor.validate(id, &identity)?;
    let recovered_plan =
        account_lpac_plan::read_protected_frontend_plan(&root, id, &recovered_anchor.plan_sha256)?;
    if recovered_plan.retirement_object_count() != recovered_anchor.objects {
        return Err("frontend plan object count differs from protected anchor".into());
    }
    let recovered = BundleJournal::restore_for_retirement(
        &recovered_plan,
        id,
        identity,
        &recovered_anchor.inventory_sha256,
        |index| account_lpac_plan::read_protected_frontend_page(&root, id, index),
    )?;
    if recovered.creation_admitted(0).is_ok() || recovered.retirement_confirmed() {
        return Err("frontend recovery dispatch or planned debt gate differs".into());
    }
    let report = serde_json::json!({"version":1,"production":"unavailable","fixture_id":id,"actual_system":true,"objects":recovered_anchor.objects,"pages":pages,"protected_anchor_readback":true,"source_inventory_released":true,"readback_same_service":true,"protected_plan_readback":true,"all_pages_bound":true,"recovery_creation_blocked":true,"planned_not_counted_as_retired":true,"accounts_created":false,"filters_installed":false,"input_namespace_created":false,"retained_as_protected_evidence":true});
    journal::publish(
        &root.join("frontend-journal-result.json"),
        &serde_json::to_vec(&report).map_err(|e| e.to_string())?,
        false,
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn actual_independent_system_recovery_reads_complete_old_records_without_mutation() {
        let evidence = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/design/evidence");
        let read = |suffix: &str| -> serde_json::Value {
            serde_json::from_slice(
                &std::fs::read(evidence.join(format!(
                    "windows-stage-a-2026-10-10-frontend-journal-independent-{suffix}.json"
                )))
                .unwrap(),
            )
            .unwrap()
        };
        let result = read("result");
        let preparation = read("preparation");
        let service = read("service");
        let diagnostic = read("diagnostic");
        assert_ne!(result["fixture_id"], result["recovery_id"]);
        assert_eq!(preparation["fixture_id"], result["recovery_id"]);
        assert_eq!(
            preparation["frontend_journal_recovery_target"],
            result["fixture_id"]
        );
        assert_eq!(preparation["fixed_frontend_journal"], false);
        assert_eq!(preparation["fixed_workload"], false);
        assert_eq!(result["objects"], 43290);
        assert_eq!(result["pages"], 677);
        for field in [
            "actual_system",
            "independent_process",
            "original_service_retired",
            "all_pages_bound",
            "recovery_creation_blocked",
            "planned_not_counted_as_retired",
        ] {
            assert_eq!(result[field], true, "missing {field}");
        }
        for field in [
            "source_inventory_opened",
            "records_mutated",
            "accounts_created",
            "filters_installed",
            "input_namespace_created",
        ] {
            assert_eq!(result[field], false, "unexpected {field}");
        }
        assert_eq!(service["fixture_id"], result["recovery_id"]);
        assert_eq!(service["service_removed"], true);
        assert_eq!(
            service["observed_service_exit"]["process_exit_confirmed"],
            true
        );
        assert_eq!(service["observed_service_exit"]["win32_exit_code"], 0);
        assert_eq!(
            service["observed_service_exit"]["service_specific_exit_code"],
            0
        );
        assert!(diagnostic["diagnostic_error"].is_null());
        assert_eq!(result["production"], "unavailable");
    }
    #[test]
    fn actual_system_full_page_publication_keeps_execution_and_resource_scope_closed() {
        let evidence = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/design/evidence");
        let read = |suffix: &str| -> serde_json::Value {
            serde_json::from_slice(
                &std::fs::read(evidence.join(format!(
                    "windows-stage-a-2026-10-10-frontend-journal-system-{suffix}.json"
                )))
                .unwrap(),
            )
            .unwrap()
        };
        let result = read("result");
        let service = read("service");
        let preparation = read("preparation");
        let anchor: Anchor = serde_json::from_value(read("anchor")).unwrap();
        let id = Uuid::parse_str(result["fixture_id"].as_str().unwrap()).unwrap();
        anchor.validate(id, &anchor.parent).unwrap();
        assert_eq!(result["objects"], 43290);
        assert_eq!(result["pages"], 677);
        for field in [
            "actual_system",
            "all_pages_bound",
            "protected_anchor_readback",
            "protected_plan_readback",
            "source_inventory_released",
            "readback_same_service",
            "recovery_creation_blocked",
            "planned_not_counted_as_retired",
            "retained_as_protected_evidence",
        ] {
            assert_eq!(result[field], true, "missing {field}");
        }
        for field in [
            "accounts_created",
            "filters_installed",
            "input_namespace_created",
        ] {
            assert_eq!(result[field], false, "unexpected {field}");
        }
        assert_eq!(result["production"], "unavailable");
        assert_eq!(service["fixture_id"], result["fixture_id"]);
        assert_eq!(service["service_removed"], true);
        assert_eq!(
            service["observed_service_exit"]["process_exit_confirmed"],
            true
        );
        assert_eq!(service["observed_service_exit"]["win32_exit_code"], 0);
        assert_eq!(
            service["observed_service_exit"]["service_specific_exit_code"],
            0
        );
        assert_eq!(preparation["fixed_frontend_journal"], true);
        assert_eq!(preparation["fixed_workload"], false);
        assert!(preparation["fixed_tool"].is_null() && preparation["recovery_target"].is_null());
    }
    #[test]
    fn incomplete_or_cross_fixture_anchor_cannot_authorize_page_loading() {
        let id = Uuid::new_v4();
        let parent = ObjectIdentity {
            volume: 1,
            file_id: 2,
        };
        let mut anchor = Anchor {
            version: 1,
            backend: "fixed-frontend-journal-v1".into(),
            production: "unavailable".into(),
            fixture_id: id,
            parent: parent.clone(),
            inventory_sha256: "a".repeat(64),
            plan_sha256: "b".repeat(64),
            pages: 1,
            objects: 4,
            phase: "preparing".into(),
            accounts_created: false,
            filters_installed: false,
            input_namespace_created: false,
        };
        assert!(anchor.validate(id, &parent).is_err());
        anchor.phase = "prepared; execution forbidden".into();
        anchor.validate(id, &parent).unwrap();
        assert!(anchor.validate(Uuid::new_v4(), &parent).is_err());
        assert!(anchor
            .validate(
                id,
                &ObjectIdentity {
                    volume: 1,
                    file_id: 3
                }
            )
            .is_err());
        anchor.pages = 2;
        assert!(anchor.validate(id, &parent).is_err());
        anchor.pages = 1;
        anchor.accounts_created = true;
        assert!(anchor.validate(id, &parent).is_err());
    }
}
