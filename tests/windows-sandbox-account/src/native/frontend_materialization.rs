//! Fixed complete dependency transaction, before accounts, grants or tools.
use super::*;
use sha2::{Digest, Sha256};
use shellspan_account_sandbox_prototype::{
    frontend_materialization::{materialize_and_retire, MaterializationNamespace},
    frontend_runtime_inventory::RuntimeInventory,
};
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct MaterializationAnchor {
    #[serde(default)]
    creation_stamp_version: Option<u32>,
    #[serde(default)]
    journal_prepared: Option<bool>,
    version: u32,
    backend: String,
    production: String,
    fixture_id: Uuid,
    parent: shellspan_account_sandbox_prototype::frontend_bundle_journal::ObjectIdentity,
    inventory_sha256: String,
    plan_sha256: String,
    objects: usize,
    pages: usize,
    phase: String,
    namespace_root: String,
    permissions_granted: bool,
    accounts_created: bool,
    filters_installed: bool,
}
impl MaterializationAnchor {
    fn validate(
        &self,
        target: Uuid,
        parent: &shellspan_account_sandbox_prototype::frontend_bundle_journal::ObjectIdentity,
    ) -> Result<()> {
        self.validate_in_namespace(target, parent, shellspan_account_sandbox_prototype::frontend_materialization::MaterializationNamespace::Dependencies)
    }
    fn validate_in_namespace(
        &self,
        target: Uuid,
        parent: &shellspan_account_sandbox_prototype::frontend_bundle_journal::ObjectIdentity,
        namespace: shellspan_account_sandbox_prototype::frontend_materialization::MaterializationNamespace,
    ) -> Result<()> {
        use shellspan_account_sandbox_prototype::frontend_materialization::MaterializationNamespace;
        let (backend, root) = match namespace {
            MaterializationNamespace::Project => (
                "fixed-frontend-project-materialization-v1",
                "frontend-project",
            ),
            MaterializationNamespace::Dependencies => {
                ("fixed-frontend-materialization-v1", "frontend-dependencies")
            }
            MaterializationNamespace::Source => (
                "fixed-frontend-source-materialization-v1",
                "frontend-source",
            ),
        };
        if self.version != 1
            || (self.journal_prepared.is_some() && self.creation_stamp_version != Some(1))
            || self
                .creation_stamp_version
                .is_some_and(|version| version != 1)
            || self.backend != backend
            || self.production != "unavailable"
            || self.fixture_id != target
            || &self.parent != parent
            || self.namespace_root != root
            || self.permissions_granted
            || self.accounts_created
            || self.filters_installed
            || [&self.inventory_sha256, &self.plan_sha256]
                .iter()
                .any(|digest| {
                    digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit())
                })
            || self.objects == 0
            || self.objects > 100000
            || self.pages != self.objects.div_ceil(64)
            || ![
                "creating; execution forbidden",
                "failed; execution forbidden",
                "retired; execution forbidden",
            ]
            .contains(&self.phase.as_str())
        {
            return Err("materialization recovery anchor binding or scope differs".into());
        }
        Ok(())
    }
}
pub(super) fn recover(recovery_id: Uuid, target: Uuid) -> Result<()> {
    recover_in_scope(recovery_id, target, MaterializationNamespace::Dependencies)
}
pub(super) fn recover_source(recovery_id: Uuid, target: Uuid) -> Result<()> {
    recover_in_scope(recovery_id, target, MaterializationNamespace::Source)
}
pub(super) fn recover_project(recovery_id: Uuid, target: Uuid) -> Result<()> {
    recover_in_scope(recovery_id, target, MaterializationNamespace::Project)
}
fn recover_in_scope(
    recovery_id: Uuid,
    target: Uuid,
    namespace: MaterializationNamespace,
) -> Result<()> {
    let source_scope = matches!(namespace, MaterializationNamespace::Source);
    use shellspan_account_sandbox_prototype::{
        account_lpac_plan,
        frontend_bundle_journal::{BundleJournal, ObjectIdentity},
        frontend_materialization::{
            bind_stamped_pending_in_namespace, retire_loaded_objects_in_namespace,
            MaterializationNamespace,
        },
    };
    if recovery_id.is_nil()
        || target.is_nil()
        || recovery_id == target
        || token_sid(token()?.0)? != "S-1-5-18"
        || fixture_parent()? != Path::new(r"C:\ProgramData")
    {
        return Err(
            "materialization recovery requires distinct UUIDs and fixed SYSTEM context".into(),
        );
    }
    if matches!(namespace, MaterializationNamespace::Project) {
        system_admission::verify_project_materialization_recovery_target(target)?;
    } else if source_scope {
        system_admission::verify_source_materialization_recovery_target(target)?;
    } else {
        system_admission::verify_materialization_recovery_target(target)?;
    }
    let root = fixture_parent()?.join(format!("ShellSpan-account-profile-A-{target}"));
    let held = Handle(unsafe {
        CreateFileW(
            wide(
                root.to_str()
                    .ok_or("invalid materialization recovery root")?,
            )
            .as_ptr(),
            FILE_READ_ATTRIBUTES | READ_CONTROL,
            FILE_SHARE_READ,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    });
    if held.0 == INVALID_HANDLE_VALUE {
        return Err("hold materialization recovery root failed".into());
    }
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    win(
        unsafe { GetFileInformationByHandle(held.0, &mut info) },
        "observe materialization recovery parent",
    )?;
    if info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
        || info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
    {
        return Err("materialization recovery parent type differs".into());
    }
    let parent = ObjectIdentity {
        volume: info.dwVolumeSerialNumber,
        file_id: ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
    };
    let mut anchor: MaterializationAnchor =
        serde_json::from_slice(&account_lpac_plan::read_protected_receipt(&root)?)
            .map_err(|e| e.to_string())?;
    if !matches!(namespace, MaterializationNamespace::Dependencies) {
        anchor.validate_in_namespace(target, &parent, namespace)?;
    } else {
        anchor.validate(target, &parent)?;
    }
    let plan = account_lpac_plan::read_protected_frontend_plan(&root, target, &anchor.plan_sha256)?;
    if plan.retirement_object_count() != anchor.objects {
        return Err("materialization recovery plan count differs".into());
    }
    if anchor.journal_prepared == Some(false) {
        shellspan_account_sandbox_prototype::frontend_materialization::confirm_unprepared_namespace_absent_in_namespace(&root, &parent, namespace)?;
        anchor.phase = "retired; execution forbidden".into();
        journal::publish(
            &root.join("ownership.json"),
            &serde_json::to_vec(&anchor).map_err(|e| e.to_string())?,
            false,
        )?;
        let report = serde_json::json!({"version":1,"production":"unavailable","recovery_id":recovery_id,
            "fixture_id":target,"actual_system":true,"independent_process":true,"original_service_retired":true,
            "initialization_only":true,"namespace_absence_confirmed":true,"page_records_mutated":false,
            "source_inventory_opened":false,"namespace_root":anchor.namespace_root,"objects":anchor.objects,"pages":anchor.pages,
            "objects_created":0,"objects_retired":0,"retirement_confirmed":true,
            "permissions_granted":false,"accounts_created":false,"filters_installed":false,"tools_dispatched":false});
        let output = fixture_parent()?.join(format!("ShellSpan-system-admission-A-{recovery_id}"));
        return journal::publish(
            &output.join("frontend-materialization-recovery-result.json"),
            &serde_json::to_vec(&report).map_err(|e| e.to_string())?,
            false,
        );
    }
    let mut loaded = BundleJournal::restore_for_retirement(
        &plan,
        target,
        parent,
        &anchor.inventory_sha256,
        |index| account_lpac_plan::read_protected_frontend_page(&root, target, index),
    )?;
    if anchor.creation_stamp_version == Some(1) {
        bind_stamped_pending_in_namespace(&root, &plan, &mut loaded, namespace, |index, bytes| {
            journal::publish(
                &root.join(format!("frontend-bundle-page-{index:04}.json")),
                bytes,
                false,
            )
        })?;
    }
    let result =
        retire_loaded_objects_in_namespace(&root, &plan, loaded, namespace, |index, bytes| {
            journal::publish(
                &root.join(format!("frontend-bundle-page-{index:04}.json")),
                bytes,
                false,
            )
        })?;
    if result.objects_created != 0
        || result.objects_retired != anchor.objects
        || !result.retirement_confirmed
    {
        return Err("independent materialization full retirement differs".into());
    }
    anchor.phase = "retired; execution forbidden".into();
    journal::publish(
        &root.join("ownership.json"),
        &serde_json::to_vec(&anchor).map_err(|e| e.to_string())?,
        false,
    )?;
    let report = serde_json::json!({"version":1,"production":"unavailable","recovery_id":recovery_id,
        "fixture_id":target,"actual_system":true,"independent_process":true,"original_service_retired":true,
        "source_inventory_opened":false,"namespace_root":anchor.namespace_root,"objects":anchor.objects,"pages":anchor.pages,
        "objects_created":0,"objects_retired":result.objects_retired,"retirement_confirmed":true,
        "permissions_granted":false,"accounts_created":false,"filters_installed":false,"tools_dispatched":false});
    let output = fixture_parent()?.join(format!("ShellSpan-system-admission-A-{recovery_id}"));
    journal::publish(
        &output.join("frontend-materialization-recovery-result.json"),
        &serde_json::to_vec(&report).map_err(|e| e.to_string())?,
        false,
    )
}
pub(super) fn run(id: Uuid) -> Result<()> {
    run_in_scope(id, MaterializationNamespace::Dependencies, false)
}
pub(super) fn run_source(id: Uuid, fail_workload: bool) -> Result<()> {
    run_in_scope(id, MaterializationNamespace::Source, fail_workload)
}
pub(super) fn run_project(id: Uuid, fail_workload: bool) -> Result<()> {
    run_in_scope(id, MaterializationNamespace::Project, fail_workload)
}
fn run_in_scope(id: Uuid, namespace: MaterializationNamespace, fail_workload: bool) -> Result<()> {
    let source_scope = matches!(namespace, MaterializationNamespace::Source);
    if fail_workload && matches!(namespace, MaterializationNamespace::Dependencies) {
        return Err("fixed failure requires source or project scope".into());
    }
    if id.is_nil()
        || token_sid(token()?.0)? != "S-1-5-18"
        || fixture_parent()? != Path::new(r"C:\ProgramData")
    {
        return Err("frontend materialization requires fixed SYSTEM context".into());
    }
    let source = if source_scope {
        Some(shellspan_account_sandbox_prototype::frontend_source_plan::FrozenFrontendSource::freeze()?)
    } else {
        None
    };
    let project = if matches!(namespace, MaterializationNamespace::Project) {
        Some(shellspan_account_sandbox_prototype::frontend_project_inventory::FrozenFrontendProject::freeze()?)
    } else {
        None
    };
    let inventory = if source_scope || project.is_some() {
        None
    } else {
        Some(RuntimeInventory::inspect_fixed()?)
    };
    let plan = if let Some(project) = &project {
        project.plan().clone()
    } else if let Some(source) = &source {
        source.bundle_plan()?
    } else {
        inventory
            .as_ref()
            .ok_or("dependency inventory missing")?
            .bundle_plan()?
    };
    let plan_bytes = serde_json::to_vec(&plan).map_err(|e| e.to_string())?;
    let hash = |bytes: &[u8]| {
        Sha256::digest(bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    };
    let inventory_hash = if let Some(project) = &project {
        project.inventory_sha256().to_owned()
    } else {
        let inventory_bytes = if let Some(source) = &source {
            serde_json::to_vec(source.manifest())
        } else {
            serde_json::to_vec(inventory.as_ref().ok_or("dependency inventory missing")?)
        }
        .map_err(|e| e.to_string())?;
        hash(&inventory_bytes)
    };
    let root = fixture_parent()?.join(format!("ShellSpan-account-profile-A-{id}"));
    protected_fixture(&root)?;
    let held = Handle(unsafe {
        CreateFileW(
            wide(root.to_str().ok_or("invalid materialization root")?).as_ptr(),
            FILE_READ_ATTRIBUTES | READ_CONTROL,
            FILE_SHARE_READ,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    });
    if held.0 == INVALID_HANDLE_VALUE {
        return Err("hold materialization parent failed".into());
    }
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    win(
        unsafe { GetFileInformationByHandle(held.0, &mut info) },
        "observe materialization parent",
    )?;
    if info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
        || info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
    {
        return Err("materialization parent type differs".into());
    }
    let objects = plan.retirement_object_count();
    let pages = objects.div_ceil(64);
    let backend = if project.is_some() {
        "fixed-frontend-project-materialization-v1"
    } else if source_scope {
        "fixed-frontend-source-materialization-v1"
    } else {
        "fixed-frontend-materialization-v1"
    };
    let namespace = if project.is_some() {
        "frontend-project"
    } else if source_scope {
        "frontend-source"
    } else {
        "frontend-dependencies"
    };
    let mut anchor = serde_json::json!({"version":1,"backend":backend,
        "production":"unavailable","fixture_id":id,
        "parent":{"volume":info.dwVolumeSerialNumber,"file_id":((info.nFileIndexHigh as u64)<<32)|info.nFileIndexLow as u64},
        "inventory_sha256":inventory_hash,"plan_sha256":hash(&plan_bytes),"objects":objects,"pages":pages,
        "phase":"creating; execution forbidden","namespace_root":namespace,"creation_stamp_version":1,"journal_prepared":false,
        "permissions_granted":false,"accounts_created":false,"filters_installed":false});
    let save = |anchor: &serde_json::Value| {
        journal::publish(
            &root.join("ownership.json"),
            &serde_json::to_vec(anchor).map_err(|e| e.to_string())?,
            false,
        )
    };
    save(&anchor)?;
    journal::publish_frontend_plan(&root.join("frontend-bundle-plan.json"), &plan_bytes)?;
    let mut initial_pages = 0;
    let mut publish = |index, bytes: &[u8]| {
        let path = root.join(format!("frontend-bundle-page-{index:04}.json"));
        if initial_pages < pages {
            if index != initial_pages || path.try_exists().map_err(|e| e.to_string())? {
                return Err("materialization initial page is not fresh and ordered".into());
            }
            journal::publish(&path, bytes, false)?;
            initial_pages += 1;
            if initial_pages == pages {
                anchor["journal_prepared"] = serde_json::json!(true);
                save(&anchor)?;
            }
            Ok(())
        } else {
            journal::publish(&path, bytes, false)
        }
    };
    let result = if let Some(project) = &project {
        shellspan_account_sandbox_prototype::frontend_materialization::materialize_project_run_and_retire(
            project, &root,
            shellspan_account_sandbox_prototype::frontend_bundle_journal::ObjectIdentity {
                volume: info.dwVolumeSerialNumber,
                file_id: ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
            }, id, &mut publish, |_| {
                if fail_workload {
                    Err("fixed project workload failure after complete checkpoints".into())
                } else { Ok(()) }
            }
        )
    } else if let Some(source) = &source {
        use shellspan_account_sandbox_prototype::{
            frontend_bundle_journal::ObjectIdentity,
            frontend_materialization::materialize_source_run_and_retire,
        };
        materialize_source_run_and_retire(
            source,
            &root,
            ObjectIdentity {
                volume: info.dwVolumeSerialNumber,
                file_id: ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
            },
            id,
            &mut publish,
            |_| {
                if fail_workload {
                    Err("fixed source workload failure after complete checkpoints".into())
                } else {
                    Ok(())
                }
            },
        )
    } else {
        materialize_and_retire(
            inventory.as_ref().ok_or("dependency inventory missing")?,
            id,
            &mut publish,
        )
    };
    if let Err(error) = result {
        anchor["phase"] = serde_json::json!("failed; execution forbidden");
        save(&anchor)?;
        return Err(error);
    }
    let result = result?;
    if result.objects_created != objects
        || result.objects_retired != objects
        || !result.retirement_confirmed
    {
        return Err("materialization full retirement result differs".into());
    }
    anchor["phase"] = serde_json::json!("retired; execution forbidden");
    save(&anchor)?;
    let report = serde_json::json!({"version":1,"fixture_id":id,"production":"unavailable",
        "actual_system":true,"objects":objects,"pages":pages,"namespace_root":namespace,
        "objects_created":result.objects_created,"objects_retired":result.objects_retired,
        "retirement_confirmed":true,"permissions_granted":false,"accounts_created":false,
        "filters_installed":false,"tools_dispatched":false,"records_retained_as_evidence":true});
    journal::publish(
        &root.join("frontend-materialization-result.json"),
        &serde_json::to_vec(&report).map_err(|e| e.to_string())?,
        false,
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn project_scope_rejects_nil_and_self_recovery_before_mutation() {
        assert!(run_project(Uuid::nil(), false).is_err());
        assert!(run_project(Uuid::nil(), true).is_err());
        let id = Uuid::new_v4();
        assert!(recover_project(Uuid::nil(), id).is_err());
        assert!(recover_project(id, id).is_err());
        assert!(run_in_scope(Uuid::nil(), MaterializationNamespace::Project, true).is_err());
    }
    #[test]
    fn nil_materialization_fixture_is_rejected_before_any_system_mutation() {
        assert!(run(Uuid::nil()).is_err());
        assert!(run_source(Uuid::nil(), false).is_err());
        assert!(run_source(Uuid::nil(), true).is_err());
        assert!(recover(Uuid::nil(), Uuid::new_v4()).is_err());
        assert!(recover_source(Uuid::nil(), Uuid::new_v4()).is_err());
        let id = Uuid::new_v4();
        assert!(recover(id, id).is_err());
        assert!(recover_source(id, id).is_err());
    }
    #[test]
    fn recovery_anchor_rejects_changed_scope_identity_and_grants() {
        use shellspan_account_sandbox_prototype::frontend_bundle_journal::ObjectIdentity;
        let id = Uuid::new_v4();
        let parent = ObjectIdentity {
            volume: 7,
            file_id: 99,
        };
        let base = serde_json::json!({"version":1,"backend":"fixed-frontend-materialization-v1",
            "production":"unavailable","fixture_id":id,"parent":parent,
            "inventory_sha256":"a".repeat(64),"plan_sha256":"b".repeat(64),"objects":73,"pages":2,
            "phase":"failed; execution forbidden","namespace_root":"frontend-dependencies",
            "permissions_granted":false,"accounts_created":false,"filters_installed":false});
        let anchor: MaterializationAnchor = serde_json::from_value(base.clone()).unwrap();
        anchor.validate(id, &parent).unwrap();
        use shellspan_account_sandbox_prototype::frontend_materialization::MaterializationNamespace;
        assert!(anchor
            .validate_in_namespace(id, &parent, MaterializationNamespace::Source)
            .is_err());
        let mut source = base.clone();
        source["backend"] = serde_json::json!("fixed-frontend-source-materialization-v1");
        source["namespace_root"] = serde_json::json!("frontend-source");
        source["creation_stamp_version"] = serde_json::json!(1);
        source["journal_prepared"] = serde_json::json!(true);
        let source_anchor: MaterializationAnchor = serde_json::from_value(source.clone()).unwrap();
        source_anchor
            .validate_in_namespace(id, &parent, MaterializationNamespace::Source)
            .unwrap();
        let mut project = source.clone();
        project["backend"] = serde_json::json!("fixed-frontend-project-materialization-v1");
        project["namespace_root"] = serde_json::json!("frontend-project");
        let project_anchor: MaterializationAnchor =
            serde_json::from_value(project.clone()).unwrap();
        project_anchor
            .validate_in_namespace(id, &parent, MaterializationNamespace::Project)
            .unwrap();
        assert!(project_anchor.validate(id, &parent).is_err());
        assert!(project_anchor
            .validate_in_namespace(id, &parent, MaterializationNamespace::Source)
            .is_err());
        for (key, value) in [
            ("backend", source["backend"].clone()),
            ("namespace_root", source["namespace_root"].clone()),
        ] {
            let mut mixed = project.clone();
            mixed[key] = value;
            let mixed: MaterializationAnchor = serde_json::from_value(mixed).unwrap();
            assert!(mixed
                .validate_in_namespace(id, &parent, MaterializationNamespace::Project)
                .is_err());
        }
        assert!(source_anchor.validate(id, &parent).is_err());
        for (key, value) in [
            ("backend", base["backend"].clone()),
            ("namespace_root", base["namespace_root"].clone()),
        ] {
            let mut mixed = source.clone();
            mixed[key] = value;
            let mixed: MaterializationAnchor = serde_json::from_value(mixed).unwrap();
            assert!(mixed
                .validate_in_namespace(id, &parent, MaterializationNamespace::Source)
                .is_err());
        }
        assert!(anchor.journal_prepared.is_none());
        for ready in [false, true] {
            let mut modern = base.clone();
            modern["creation_stamp_version"] = serde_json::json!(1);
            modern["journal_prepared"] = serde_json::json!(ready);
            let modern: MaterializationAnchor = serde_json::from_value(modern).unwrap();
            modern.validate(id, &parent).unwrap();
            assert_eq!(modern.journal_prepared, Some(ready));
        }
        for (key, value) in [
            ("version", serde_json::json!(2)),
            ("backend", serde_json::json!("fixed-frontend-journal-v1")),
            ("production", serde_json::json!("available")),
            ("fixture_id", serde_json::json!(Uuid::new_v4())),
            ("parent", serde_json::json!({"volume":7,"file_id":100})),
            ("namespace_root", serde_json::json!("other")),
            ("permissions_granted", serde_json::json!(true)),
            ("accounts_created", serde_json::json!(true)),
            ("filters_installed", serde_json::json!(true)),
            ("inventory_sha256", serde_json::json!("a".repeat(63))),
            ("plan_sha256", serde_json::json!("g".repeat(64))),
            ("objects", serde_json::json!(0)),
            ("pages", serde_json::json!(1)),
            ("phase", serde_json::json!("executing")),
            ("unknown", serde_json::json!(true)),
            ("journal_prepared", serde_json::json!(false)),
        ] {
            let mut changed = base.clone();
            changed[key] = value;
            let decoded = serde_json::from_value::<MaterializationAnchor>(changed);
            assert!(
                decoded
                    .and_then(|anchor| anchor
                        .validate(id, &parent)
                        .map_err(serde::de::Error::custom))
                    .is_err(),
                "accepted changed {key}"
            );
        }
    }
}
