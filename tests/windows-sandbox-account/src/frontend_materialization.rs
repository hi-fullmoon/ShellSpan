//! Complete dependency creation and reverse retirement. Native callers supply
//! a protected fresh anchor/page publisher; no permissions or tools are granted.
use crate::{
    frontend_asset_copy::{OwnedAlias, OwnedAsset, OwnedDirectory},
    frontend_bundle_journal::{BundleJournal, ObjectIdentity},
    frontend_bundle_plan::BundlePlan,
    frontend_runtime_inventory::RuntimeInventory,
};
use uuid::Uuid;

pub(crate) enum OwnedObject {
    Directory(OwnedDirectory),
    File(OwnedAsset),
    Alias(OwnedAlias),
}
impl OwnedObject {
    fn identity(&self) -> ObjectIdentity {
        match self {
            Self::Directory(value) => value.identity().clone(),
            Self::Alias(value) => value.identity().clone(),
            Self::File(value) => ObjectIdentity {
                volume: value.identity().volume,
                file_id: value.identity().file_index,
            },
        }
    }
    fn retire(self, expected: &ObjectIdentity) -> Result<ObjectIdentity, String> {
        let result = match self {
            Self::Directory(value) => value.recycle(expected)?,
            Self::File(value) => value.recycle(expected)?,
            Self::Alias(value) => value.detach()?.recycle(expected)?,
        };
        Ok(result.identity().clone())
    }
}
pub struct MaterializationResult {
    pub objects_created: usize,
    pub objects_retired: usize,
    pub retirement_confirmed: bool,
}
#[derive(Clone, Copy)]
pub enum MaterializationNamespace {
    Dependencies,
    Source,
    Project,
}
impl MaterializationNamespace {
    fn name(self) -> &'static str {
        match self {
            Self::Dependencies => "frontend-dependencies",
            Self::Source => "frontend-source",
            Self::Project => "frontend-project",
        }
    }
}
/// Native caller must verify a protected unprepared anchor and retired service.
/// This checks absence only; it never synthesizes pages or retires objects.
pub fn confirm_unprepared_namespace_absent(
    parent: &std::path::Path,
    expected: &ObjectIdentity,
) -> Result<(), String> {
    confirm_unprepared_namespace_absent_in_namespace(
        parent,
        expected,
        MaterializationNamespace::Dependencies,
    )
}
pub fn confirm_unprepared_namespace_absent_in_namespace(
    parent: &std::path::Path,
    expected: &ObjectIdentity,
    namespace: MaterializationNamespace,
) -> Result<(), String> {
    use crate::appcontainer_probe::win;
    use windows_sys::Win32::Storage::FileSystem::*;
    let held = crate::appcontainer_probe::hold_journal_parent(parent)?;
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    win(
        unsafe { GetFileInformationByHandle(held.0, &mut info) },
        "observe unprepared owning parent",
    )?;
    if info.dwVolumeSerialNumber != expected.volume
        || (((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64) != expected.file_id
    {
        return Err("unprepared owning parent differs".into());
    }
    if !crate::frontend_asset_copy::object_is_absent(&parent.join(namespace.name()))? {
        return Err("unprepared namespace exists; retain debt".into());
    }
    Ok(())
}
/// Only for a protected, never-granted namespace after its original service
/// has exited and been removed. Markers alone authorize no recovery adoption.
pub fn bind_stamped_pending(
    parent: &std::path::Path,
    plan: &BundlePlan,
    journal: &mut BundleJournal,
    publish: impl FnMut(usize, &[u8]) -> Result<(), String>,
) -> Result<(), String> {
    bind_stamped_pending_in_namespace(
        parent,
        plan,
        journal,
        MaterializationNamespace::Dependencies,
        publish,
    )
}
pub fn bind_stamped_pending_in_namespace(
    parent: &std::path::Path,
    plan: &BundlePlan,
    journal: &mut BundleJournal,
    namespace: MaterializationNamespace,
    mut publish: impl FnMut(usize, &[u8]) -> Result<(), String>,
) -> Result<(), String> {
    use crate::appcontainer_probe::win;
    use windows_sys::Win32::Storage::FileSystem::*;
    journal.stop_creation();
    let held = crate::appcontainer_probe::hold_journal_parent(parent)?;
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    win(
        unsafe { GetFileInformationByHandle(held.0, &mut info) },
        "observe stamped recovery parent",
    )?;
    if info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
        || info.dwVolumeSerialNumber != journal.owning_parent().volume
        || (((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64)
            != journal.owning_parent().file_id
    {
        return Err("stamped recovery owning parent differs".into());
    }
    let objects = plan.objects();
    if objects.len() != journal.retirement_object_count() {
        return Err("stamped recovery full object count differs".into());
    }
    for (index, object) in objects.iter().enumerate() {
        let view = journal.retirement_view(index)?;
        if view.path != object.path
            || view.kind != object.kind
            || view.target != object.target.as_deref()
        {
            return Err("stamped recovery plan differs from bound records".into());
        }
    }
    for (index, object) in objects.iter().enumerate() {
        let view = journal.retirement_view(index)?;
        let relative = if object.path.is_empty() {
            namespace.name().to_owned()
        } else {
            format!("{}/{}", namespace.name(), object.path)
        };
        if namespace_absent(parent, &relative)? {
            continue;
        }
        if view.retired {
            return Err("retired materialization object reappeared".into());
        }
        if view.identity.is_some() {
            continue;
        }
        let stamp = journal.creation_stamp(index)?;
        let observed = stamp.observe(&parent.join(&relative))?;
        journal.checkpoint_recovered_creation(index, observed.identity().clone(), &mut publish)?;
    }
    Ok(())
}
/// Only after native original-service retirement and protected-anchor gates.
/// Loaded records never authorize creation, replay, or adoption of planned objects.
pub fn retire_loaded_objects(
    parent: &std::path::Path,
    plan: &BundlePlan,
    journal: BundleJournal,
    publish: impl FnMut(usize, &[u8]) -> Result<(), String>,
) -> Result<MaterializationResult, String> {
    retire_loaded_objects_in_namespace(
        parent,
        plan,
        journal,
        MaterializationNamespace::Dependencies,
        publish,
    )
}
pub fn retire_loaded_objects_in_namespace(
    parent: &std::path::Path,
    plan: &BundlePlan,
    mut journal: BundleJournal,
    namespace: MaterializationNamespace,
    mut publish: impl FnMut(usize, &[u8]) -> Result<(), String>,
) -> Result<MaterializationResult, String> {
    use crate::{appcontainer_probe::win, frontend_asset_copy};
    use windows_sys::Win32::Storage::FileSystem::*;
    let held = crate::appcontainer_probe::hold_journal_parent(parent)?;
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    win(
        unsafe { GetFileInformationByHandle(held.0, &mut info) },
        "observe loaded retirement parent",
    )?;
    if info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
        || info.dwVolumeSerialNumber != journal.owning_parent().volume
        || (((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64)
            != journal.owning_parent().file_id
    {
        return Err("loaded retirement owning parent differs".into());
    }
    journal.stop_creation();
    let root = parent.join(namespace.name());
    let objects = plan.objects();
    if objects.len() != journal.retirement_object_count() {
        return Err("loaded retirement full object count differs".into());
    }
    for (index, object) in objects.iter().enumerate() {
        let view = journal.retirement_view(index)?;
        if view.path != object.path
            || view.kind != object.kind
            || view.target != object.target.as_deref()
        {
            return Err("loaded retirement plan differs from bound records".into());
        }
    }
    let mut retired = 0;
    for index in (0..objects.len()).rev() {
        let view = journal.retirement_view(index)?;
        let expected = view.identity.cloned();
        let path = if view.path.is_empty() {
            namespace.name().into()
        } else {
            format!("{}/{}", namespace.name(), view.path)
        };
        let absent = namespace_absent(parent, &path)?;
        if !absent {
            if view.retired {
                return Err("retired materialization object reappeared".into());
            }
            let identity = expected.as_ref().ok_or(
                "planned materialization object exists without recorded identity; retain debt",
            )?;
            let target = view.target.map(|p| format!("{}/{p}", namespace.name()));
            let value = frontend_asset_copy::reopen_for_retirement(
                parent,
                &path,
                view.kind,
                target.as_deref(),
                identity,
            )?;
            value.retire(identity)?;
        }
        journal.checkpoint_retired(index, expected.as_ref(), &mut publish)?;
        retired += 1;
    }
    if !journal.retirement_confirmed() || !frontend_asset_copy::object_is_absent(&root)? {
        return Err("loaded materialization complete absence not proven".into());
    }
    Ok(MaterializationResult {
        objects_created: 0,
        objects_retired: retired,
        retirement_confirmed: true,
    })
}
fn namespace_absent(parent: &std::path::Path, relative: &str) -> Result<bool, String> {
    use crate::{
        appcontainer_probe::{verify_retirement_object, win},
        frontend_asset_copy,
    };
    use windows_sys::Win32::Storage::FileSystem::*;
    let mut path = parent.to_path_buf();
    let parts: Vec<_> = relative.split('/').collect();
    let mut held = Vec::new();
    for (index, part) in parts.iter().enumerate() {
        path.push(part);
        if frontend_asset_copy::object_is_absent(&path)? {
            return Ok(true);
        }
        if index + 1 < parts.len() {
            let handle = verify_retirement_object(&path)?;
            let mut info = BY_HANDLE_FILE_INFORMATION::default();
            win(
                unsafe { GetFileInformationByHandle(handle.0, &mut info) },
                "observe recovery ancestor",
            )?;
            if info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
                return Err("loaded retirement ancestor is not a directory".into());
            }
            held.push(handle);
        }
    }
    Ok(false)
}
/// Intended only for the fixed SYSTEM creation experiment, before any grants.
pub fn materialize_and_retire(
    inventory: &RuntimeInventory,
    fixture: Uuid,
    publish: impl FnMut(usize, &[u8]) -> Result<(), String>,
) -> Result<MaterializationResult, String> {
    materialize_run_and_retire(inventory, fixture, publish, || Ok(()))
}
/// Keeps complete object custody through a native-coordinated workload.
/// The coordinator must authenticate the target and journal grants before
/// launch. Success must mean the execution tree has stopped and all grants
/// have been revoked. An error leaves objects and checkpoints for independent
/// recovery; it must never be interpreted as permission to recycle live input.
pub fn materialize_run_and_retire(
    inventory: &RuntimeInventory,
    fixture: Uuid,
    mut publish: impl FnMut(usize, &[u8]) -> Result<(), String>,
    workload: impl FnOnce() -> Result<(), String>,
) -> Result<MaterializationResult, String> {
    let copier = inventory.asset_copier(fixture)?;
    let plan = inventory.bundle_plan()?;
    let journal = inventory.prepare_bundle_journal(
        fixture,
        copier.parent_identity().clone(),
        &mut publish,
    )?;
    transact_with_workload(
        &plan,
        journal,
        |object| match object.kind.as_str() {
            "directory" if object.path.is_empty() => {
                copier.create_namespace().map(OwnedObject::Directory)
            }
            "directory" => copier
                .create_directory(&object.path)
                .map(OwnedObject::Directory),
            "file" => copier.copy_new(&object.path).map(OwnedObject::File),
            _ if object.target.is_some() => {
                copier.create_alias(&object.path).map(OwnedObject::Alias)
            }
            _ => Err("materialization object kind unsupported".into()),
        },
        &mut publish,
        workload,
    )
}
/// Native caller must first publish a protected source anchor/full plan and
/// prove this parent was never granted. Publisher must create fresh planned
/// pages. Workload success requires a stopped tree and revoked owned grants.
pub fn materialize_source_run_and_retire(
    source: &crate::frontend_source_plan::FrozenFrontendSource,
    parent: &std::path::Path,
    expected_parent: ObjectIdentity,
    fixture: Uuid,
    mut publish: impl FnMut(usize, &[u8]) -> Result<(), String>,
    workload: impl FnOnce(&std::path::Path) -> Result<(), String>,
) -> Result<MaterializationResult, String> {
    use windows_sys::Win32::Storage::FileSystem::*;
    let held = crate::appcontainer_probe::hold_journal_parent(parent)?;
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    crate::appcontainer_probe::win(
        unsafe { GetFileInformationByHandle(held.0, &mut info) },
        "source owning parent",
    )?;
    if info.dwVolumeSerialNumber != expected_parent.volume
        || (((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64)
            != expected_parent.file_id
    {
        return Err("source owning parent differs before preparation".into());
    }
    let plan = source.bundle_plan()?;
    let digest = {
        use sha2::{Digest, Sha256};
        Sha256::digest(serde_json::to_vec(source.manifest()).map_err(|e| e.to_string())?)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    };
    let journal = BundleJournal::prepare(
        &plan,
        fixture,
        expected_parent.clone(),
        &digest,
        &mut publish,
    )?;
    let stamps = plan
        .objects()
        .iter()
        .enumerate()
        .map(|(index, object)| Ok((object.path.clone(), journal.creation_stamp(index)?)))
        .collect::<Result<std::collections::BTreeMap<_, _>, String>>()?;
    let root = parent.join("frontend-source");
    transact_with_workload(
        &plan,
        journal,
        |object| {
            let stamp = stamps
                .get(&object.path)
                .ok_or("source creation stamp missing")?;
            match object.kind.as_str() {
                "directory" if object.path.is_empty() => {
                    crate::frontend_asset_copy::create_source_journal_namespace(
                        parent,
                        expected_parent.volume,
                        stamp,
                    )
                    .map(OwnedObject::Directory)
                }
                "directory" => crate::frontend_asset_copy::create_directory_stamped(
                    &root,
                    &object.path,
                    expected_parent.volume,
                    Some(stamp),
                )
                .map(OwnedObject::Directory),
                "file" => source
                    .copy_new_stamped(&root, &object.path, expected_parent.volume, stamp)
                    .map(OwnedObject::File),
                _ => Err("source plan contains unsupported alias".into()),
            }
        },
        &mut publish,
        || workload(&root),
    )
}
pub fn materialize_project_run_and_retire(
    project: &crate::frontend_project_inventory::FrozenFrontendProject,
    parent: &std::path::Path,
    expected_parent: ObjectIdentity,
    fixture: Uuid,
    mut publish: impl FnMut(usize, &[u8]) -> Result<(), String>,
    workload: impl FnOnce(&std::path::Path) -> Result<(), String>,
) -> Result<MaterializationResult, String> {
    use windows_sys::Win32::Storage::FileSystem::*;
    let held = crate::appcontainer_probe::hold_journal_parent(parent)?;
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    crate::appcontainer_probe::win(
        unsafe { GetFileInformationByHandle(held.0, &mut info) },
        "source owning parent",
    )?;
    if info.dwVolumeSerialNumber != expected_parent.volume
        || (((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64)
            != expected_parent.file_id
    {
        return Err("source owning parent differs before preparation".into());
    }
    let plan = project.plan().clone();
    let digest = project.inventory_sha256();
    let copier = project.dependencies().project_asset_copier()?;
    let journal = BundleJournal::prepare(
        &plan,
        fixture,
        expected_parent.clone(),
        digest,
        &mut publish,
    )?;
    let stamps = plan
        .objects()
        .iter()
        .enumerate()
        .map(|(index, object)| Ok((object.path.clone(), journal.creation_stamp(index)?)))
        .collect::<Result<std::collections::BTreeMap<_, _>, String>>()?;
    let root = parent.join("frontend-project");
    transact_with_workload(
        &plan,
        journal,
        |object| {
            let stamp = stamps
                .get(&object.path)
                .ok_or("source creation stamp missing")?;
            match object.kind.as_str() {
                "directory" if object.path.is_empty() => {
                    crate::frontend_asset_copy::create_project_journal_namespace(
                        parent,
                        expected_parent.volume,
                        stamp,
                    )
                    .map(OwnedObject::Directory)
                }
                "directory" => crate::frontend_asset_copy::create_directory_stamped(
                    &root,
                    &object.path,
                    expected_parent.volume,
                    Some(stamp),
                )
                .map(OwnedObject::Directory),
                "file" if object.path.starts_with("node_modules/") => copier
                    .copy_new_stamped(&root, &object.path, expected_parent.volume, stamp)
                    .map(OwnedObject::File),
                "alias" => crate::frontend_asset_copy::create_alias_stamped(
                    &root,
                    &object.path,
                    object
                        .target
                        .as_deref()
                        .ok_or("project alias target missing")?,
                    expected_parent.volume,
                    Some(stamp),
                )
                .map(OwnedObject::Alias),
                "file" => project
                    .source()
                    .copy_new_stamped(&root, &object.path, expected_parent.volume, stamp)
                    .map(OwnedObject::File),
                _ => Err("source plan contains unsupported alias".into()),
            }
        },
        &mut publish,
        || workload(&root),
    )
}
fn transact_with_workload(
    plan: &BundlePlan,
    mut journal: BundleJournal,
    mut create: impl FnMut(&crate::frontend_bundle_plan::PlannedObject) -> Result<OwnedObject, String>,
    mut publish: impl FnMut(usize, &[u8]) -> Result<(), String>,
    workload: impl FnOnce() -> Result<(), String>,
) -> Result<MaterializationResult, String> {
    let objects = plan.objects();
    let mut owned = Vec::with_capacity(objects.len());
    let mut pending: Vec<(usize, ObjectIdentity)> = Vec::new();
    for (index, object) in objects.iter().enumerate() {
        if !pending.is_empty() && (object.kind != "file" || pending[0].0 / 64 != index / 64) {
            journal.checkpoint_created_batch(&pending, &mut publish)?;
            pending.clear();
        }
        journal.creation_admitted(index)?;
        let value = create(object)?;
        let identity = value.identity();
        owned.push(Some(value));
        if object.kind == "file" {
            pending.push((index, identity));
        } else {
            journal.checkpoint_created(index, identity, &mut publish)?;
        }
    }
    if !pending.is_empty() {
        journal.checkpoint_created_batch(&pending, &mut publish)?;
    }
    journal.stop_creation();
    workload()?;
    let mut retired = 0;
    for index in (0..objects.len()).rev() {
        let value = owned[index]
            .take()
            .ok_or("materialization custody missing")?;
        let expected = value.identity();
        let actual = value.retire(&expected).map_err(|error| {
            format!(
                "retirement index {index}, volume {}, file ID {}: {error}",
                expected.volume, expected.file_id
            )
        })?;
        journal.checkpoint_retired(index, Some(&actual), &mut publish)?;
        retired += 1;
    }
    if !journal.retirement_confirmed() {
        return Err("complete materialization retirement not proven".into());
    }
    Ok(MaterializationResult {
        objects_created: objects.len(),
        objects_retired: retired,
        retirement_confirmed: true,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        appcontainer_probe::{verify_retirement_object, win},
        fixed_tool::ToolImageLease,
        frontend_asset_copy,
    };
    use sha2::{Digest, Sha256};
    use std::collections::BTreeMap;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };
    #[test]
    fn workload_error_retains_complete_checkpoint_and_namespace_for_recovery() {
        let root =
            std::env::temp_dir().join(format!("ShellSpan-workload-failure-{}", Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let parent = verify_retirement_object(&root).unwrap();
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        win(
            unsafe { GetFileInformationByHandle(parent.0, &mut info) },
            "observe workload parent",
        )
        .unwrap();
        let parent_id = ObjectIdentity {
            volume: info.dwVolumeSerialNumber,
            file_id: ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
        };
        let namespace = root.join("frontend-dependencies");
        let plan = crate::frontend_bundle_plan::build(&namespace, &[], &[], &[]).unwrap();
        let fixture = Uuid::new_v4();
        let mut pages = BTreeMap::new();
        let journal = BundleJournal::prepare(
            &plan,
            fixture,
            parent_id.clone(),
            &"a".repeat(64),
            |index, bytes| {
                pages.insert(index, bytes.to_vec());
                Ok(())
            },
        )
        .unwrap();
        let mut publications = 0;
        let error = transact_with_workload(
            &plan,
            journal,
            |_| {
                frontend_asset_copy::create_directory(
                    &root,
                    "frontend-dependencies",
                    parent_id.volume,
                )
                .map(OwnedObject::Directory)
            },
            |index, bytes| {
                publications += 1;
                pages.insert(index, bytes.to_vec());
                Ok(())
            },
            || {
                assert!(namespace.is_dir());
                Err("execution stop or revoke unconfirmed".into())
            },
        )
        .err()
        .expect("workload failure must stop transaction");
        assert_eq!(error, "execution stop or revoke unconfirmed");
        assert_eq!(
            publications, 1,
            "no retirement checkpoint after workload failure"
        );
        assert!(namespace.is_dir());
        let record: serde_json::Value = serde_json::from_slice(&pages[&0]).unwrap();
        assert_eq!(record["records"][0]["state"], "applied");
        let loaded = BundleJournal::restore_for_retirement(
            &plan,
            fixture,
            parent_id,
            &"a".repeat(64),
            |index| Ok(pages[&index].clone()),
        )
        .unwrap();
        assert!(!loaded.retirement_confirmed());
        // This fixture dispatched no process or grant, so independent retirement is safe.
        let result = retire_loaded_objects(&root, &plan, loaded, |index, bytes| {
            pages.insert(index, bytes.to_vec());
            Ok(())
        })
        .unwrap();
        assert!(result.retirement_confirmed);
        assert!(!namespace.exists());
        drop(parent);
        trash::delete(root).unwrap();
    }
    #[test]
    fn source_recovery_preserves_neighbor_dependency_namespace() {
        let root =
            std::env::temp_dir().join(format!("ShellSpan-workload-failure-{}", Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let parent = verify_retirement_object(&root).unwrap();
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        win(
            unsafe { GetFileInformationByHandle(parent.0, &mut info) },
            "observe workload parent",
        )
        .unwrap();
        let parent_id = ObjectIdentity {
            volume: info.dwVolumeSerialNumber,
            file_id: ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
        };
        let neighbor = root.join("frontend-dependencies");
        std::fs::create_dir(&neighbor).unwrap();
        std::fs::write(neighbor.join("sentinel.js"), b"neighbor must remain").unwrap();
        let namespace = root.join("frontend-source");
        let plan = crate::frontend_bundle_plan::build(&namespace, &[], &[], &[]).unwrap();
        let fixture = Uuid::new_v4();
        let mut pages = BTreeMap::new();
        let journal = BundleJournal::prepare(
            &plan,
            fixture,
            parent_id.clone(),
            &"a".repeat(64),
            |index, bytes| {
                pages.insert(index, bytes.to_vec());
                Ok(())
            },
        )
        .unwrap();
        let mut publications = 0;
        let error = transact_with_workload(
            &plan,
            journal,
            |_| {
                frontend_asset_copy::create_directory(&root, "frontend-source", parent_id.volume)
                    .map(OwnedObject::Directory)
            },
            |index, bytes| {
                publications += 1;
                pages.insert(index, bytes.to_vec());
                Ok(())
            },
            || {
                assert!(namespace.is_dir());
                Err("execution stop or revoke unconfirmed".into())
            },
        )
        .err()
        .expect("workload failure must stop transaction");
        assert_eq!(error, "execution stop or revoke unconfirmed");
        assert_eq!(
            publications, 1,
            "no retirement checkpoint after workload failure"
        );
        assert!(namespace.is_dir());
        let record: serde_json::Value = serde_json::from_slice(&pages[&0]).unwrap();
        assert_eq!(record["records"][0]["state"], "applied");
        let loaded = BundleJournal::restore_for_retirement(
            &plan,
            fixture,
            parent_id,
            &"a".repeat(64),
            |index| Ok(pages[&index].clone()),
        )
        .unwrap();
        assert!(!loaded.retirement_confirmed());
        // This fixture dispatched no process or grant, so independent retirement is safe.
        let result = retire_loaded_objects_in_namespace(
            &root,
            &plan,
            loaded,
            MaterializationNamespace::Source,
            |index, bytes| {
                pages.insert(index, bytes.to_vec());
                Ok(())
            },
        )
        .unwrap();
        assert!(result.retirement_confirmed);
        assert!(!namespace.exists());
        assert_eq!(
            std::fs::read(neighbor.join("sentinel.js")).unwrap(),
            b"neighbor must remain"
        );
        drop(parent);
        trash::delete(root).unwrap();
    }
    #[test]
    fn long_copied_asset_path_reopens_without_canonicalizing_entry() {
        let root = std::env::temp_dir().join(format!("ShellSpan-long-lease-{}", Uuid::new_v4()));
        let mut directory = root.clone();
        for _ in 0..6 {
            directory.push("owned-directory-component-1234567890");
        }
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("asset.js");
        assert!(path.to_string_lossy().len() > 260);
        std::fs::write(&path, b"long independent asset").unwrap();
        assert!(!frontend_asset_copy::object_is_absent(&path).unwrap());
        assert!(frontend_asset_copy::object_is_absent(&directory.join("missing.js")).unwrap());
        let entry = verify_retirement_object(&path).unwrap();
        drop(entry);
        let held = ToolImageLease::open_source(&path).unwrap();
        assert_eq!(held.read_bytes().unwrap(), b"long independent asset");
        assert!(std::fs::write(&path, b"replacement").is_err());
        drop(held);
        trash::delete(root).unwrap();
    }
    #[test]
    fn writable_sharing_parent_lease_allows_publication_but_prevents_replacement() {
        let root =
            std::env::temp_dir().join(format!("ShellSpan-parent-publication-{}", Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let held = verify_retirement_object(&root).unwrap();
        let pending = root.join("pending.json");
        let target = root.join("plan.json");
        std::fs::write(&pending, b"bound plan").unwrap();
        assert_eq!(
            std::fs::rename(&pending, &target)
                .unwrap_err()
                .raw_os_error(),
            Some(32)
        );
        drop(held);
        let metadata = crate::appcontainer_probe::hold_journal_parent(&root).unwrap();
        std::fs::rename(&pending, &target)
            .expect("write-sharing parent must allow child publication");
        assert_eq!(std::fs::read(&target).unwrap(), b"bound plan");
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        win(
            unsafe { GetFileInformationByHandle(metadata.0, &mut info) },
            "observe publication fixture",
        )
        .unwrap();
        let parent_identity = ObjectIdentity {
            volume: info.dwVolumeSerialNumber,
            file_id: ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
        };
        confirm_unprepared_namespace_absent(&root, &parent_identity).unwrap();
        let wrong_parent = ObjectIdentity {
            volume: parent_identity.volume,
            file_id: parent_identity.file_id ^ 1,
        };
        assert!(confirm_unprepared_namespace_absent(&root, &wrong_parent).is_err());
        assert!(confirm_unprepared_namespace_absent(
            &root.join("missing-parent"),
            &parent_identity
        )
        .is_err());
        let stamp = crate::frontend_creation_stamp::CreationStamp::new(
            Uuid::new_v4(),
            0,
            crate::frontend_creation_stamp::CreationKind::Directory,
            &"a".repeat(64),
            &"b".repeat(64),
        )
        .unwrap();
        let namespace =
            frontend_asset_copy::create_journal_namespace(&root, info.dwVolumeSerialNumber, &stamp)
                .unwrap();
        // Holding the created namespace must not freeze its sibling journal.
        assert!(confirm_unprepared_namespace_absent(&root, &parent_identity).is_err());
        std::fs::write(&pending, b"updated checkpoint").unwrap();
        let updated = root.join("checkpoint.json");
        std::fs::rename(&pending, &updated)
            .expect("namespace lease must permit sibling publication");
        assert_eq!(std::fs::read(&updated).unwrap(), b"updated checkpoint");
        assert!(std::fs::rename(&root, root.with_extension("moved")).is_err());
        let expected = namespace.identity().clone();
        namespace.recycle(&expected).unwrap();
        drop(metadata);
        trash::delete(root).unwrap();
    }
    #[test]
    fn stamped_recovery_rejects_unmarked_and_wrong_fixture_without_publication() {
        use crate::frontend_creation_stamp::{CreationKind, CreationStamp};
        for wrong_fixture in [false, true] {
            let root =
                std::env::temp_dir().join(format!("ShellSpan-stamp-refusal-{}", Uuid::new_v4()));
            std::fs::create_dir(&root).unwrap();
            let parent = verify_retirement_object(&root).unwrap();
            let mut info = BY_HANDLE_FILE_INFORMATION::default();
            win(
                unsafe { GetFileInformationByHandle(parent.0, &mut info) },
                "observe refusal parent",
            )
            .unwrap();
            let parent_id = ObjectIdentity {
                volume: info.dwVolumeSerialNumber,
                file_id: ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
            };
            let namespace = root.join("frontend-dependencies");
            let plan = crate::frontend_bundle_plan::build(&namespace, &[], &[], &[]).unwrap();
            let fixture = Uuid::new_v4();
            let mut pages = BTreeMap::new();
            let mut journal = BundleJournal::prepare(
                &plan,
                fixture,
                parent_id,
                &"a".repeat(64),
                |index, bytes| {
                    pages.insert(index, bytes.to_vec());
                    Ok(())
                },
            )
            .unwrap();
            if wrong_fixture {
                let plan_hash = Sha256::digest(serde_json::to_vec(&plan).unwrap())
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect::<String>();
                drop(
                    CreationStamp::new(
                        Uuid::new_v4(),
                        0,
                        CreationKind::Directory,
                        &"a".repeat(64),
                        &plan_hash,
                    )
                    .unwrap()
                    .create_new(&namespace)
                    .unwrap(),
                );
            } else {
                std::fs::create_dir(&namespace).unwrap();
            }
            let before = pages.clone();
            assert!(bind_stamped_pending(&root, &plan, &mut journal, |_, _| {
                panic!("invalid marker must not publish ownership")
            })
            .is_err());
            assert_eq!(pages, before);
            assert!(journal.retirement_view(0).unwrap().identity.is_none());
            assert!(journal.creation_admitted(0).is_err());
            assert!(namespace.is_dir());
            drop(parent);
            trash::delete(root).unwrap();
        }
    }
    #[test]
    fn stamped_pending_objects_bind_and_retire_after_original_handles_close() {
        let root =
            std::env::temp_dir().join(format!("ShellSpan-stamped-recovery-{}", Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let parent = verify_retirement_object(&root).unwrap();
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        win(
            unsafe { GetFileInformationByHandle(parent.0, &mut info) },
            "observe stamped test parent",
        )
        .unwrap();
        let parent_id = ObjectIdentity {
            volume: info.dwVolumeSerialNumber,
            file_id: ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
        };
        let namespace = root.join("frontend-dependencies");
        let plan = crate::frontend_bundle_plan::build(
            &namespace,
            &[namespace.join("store")],
            &[namespace.join("store/index.js")],
            &[(namespace.join("pkg"), namespace.join("store"))],
        )
        .unwrap();
        let fixture = Uuid::new_v4();
        let mut pages = BTreeMap::new();
        let journal = BundleJournal::prepare(
            &plan,
            fixture,
            parent_id.clone(),
            &"a".repeat(64),
            |index, bytes| {
                pages.insert(index, bytes.to_vec());
                Ok(())
            },
        )
        .unwrap();
        for (index, object) in plan.objects().iter().enumerate() {
            let path = if object.path.is_empty() {
                namespace.clone()
            } else {
                namespace.join(&object.path)
            };
            drop(
                journal
                    .creation_stamp(index)
                    .unwrap()
                    .create_new(&path)
                    .unwrap(),
            );
        }
        drop(journal);
        let mut loaded = BundleJournal::restore_for_retirement(
            &plan,
            fixture,
            parent_id,
            &"a".repeat(64),
            |index| Ok(pages[&index].clone()),
        )
        .unwrap();
        assert!(bind_stamped_pending(&root, &plan, &mut loaded, |_, _| Err(
            "publication failure".into()
        ))
        .is_err());
        assert!(loaded.retirement_view(0).unwrap().identity.is_none());
        assert!(namespace.exists());
        bind_stamped_pending(&root, &plan, &mut loaded, |index, bytes| {
            pages.insert(index, bytes.to_vec());
            Ok(())
        })
        .unwrap();
        for index in 0..plan.retirement_object_count() {
            assert!(loaded.retirement_view(index).unwrap().identity.is_some());
            assert!(loaded.creation_admitted(index).is_err());
        }
        let result = retire_loaded_objects(&root, &plan, loaded, |index, bytes| {
            pages.insert(index, bytes.to_vec());
            Ok(())
        })
        .unwrap();
        assert!(result.retirement_confirmed);
        assert_eq!(result.objects_created, 0);
        assert!(!namespace.exists());
        drop(parent);
        trash::delete(root).unwrap();
    }
    #[test]
    fn loaded_recovery_retires_recorded_objects_without_source_or_original_leases() {
        for detached_before_restart in [false, true] {
            let root =
                std::env::temp_dir().join(format!("ShellSpan-loaded-recovery-{}", Uuid::new_v4()));
            std::fs::create_dir(&root).unwrap();
            let parent = verify_retirement_object(&root).unwrap();
            let mut info = BY_HANDLE_FILE_INFORMATION::default();
            win(
                unsafe { GetFileInformationByHandle(parent.0, &mut info) },
                "observe loaded recovery test parent",
            )
            .unwrap();
            let parent_id = ObjectIdentity {
                volume: info.dwVolumeSerialNumber,
                file_id: ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
            };
            let source_path = root.join("source.js");
            std::fs::write(&source_path, b"independent recovery content").unwrap();
            let source = ToolImageLease::open_source(&source_path).unwrap();
            let digest = Sha256::digest(source.read_bytes().unwrap())
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>();
            let namespace = root.join("frontend-dependencies");
            let plan = crate::frontend_bundle_plan::build(
                &namespace,
                &[namespace.join("store")],
                &[namespace.join("store/index.js")],
                &[(namespace.join("pkg"), namespace.join("store"))],
            )
            .unwrap();
            let fixture = Uuid::new_v4();
            let mut pages = BTreeMap::new();
            let mut journal = BundleJournal::prepare(
                &plan,
                fixture,
                parent_id.clone(),
                &"a".repeat(64),
                |index, bytes| {
                    pages.insert(index, bytes.to_vec());
                    Ok(())
                },
            )
            .unwrap();
            let namespace_lease = frontend_asset_copy::create_directory(
                &root,
                "frontend-dependencies",
                parent_id.volume,
            )
            .unwrap();
            let directory =
                frontend_asset_copy::create_directory(&namespace, "store", parent_id.volume)
                    .unwrap();
            let file = frontend_asset_copy::copy_new(
                &source,
                &digest,
                &namespace,
                "store/index.js",
                parent_id.volume,
            )
            .unwrap();
            let alias =
                frontend_asset_copy::create_alias(&namespace, "pkg", "store", parent_id.volume)
                    .unwrap();
            for (index, identity) in [
                namespace_lease.identity().clone(),
                directory.identity().clone(),
                ObjectIdentity {
                    volume: file.identity().volume,
                    file_id: file.identity().file_index,
                },
                alias.identity().clone(),
            ]
            .into_iter()
            .enumerate()
            {
                journal
                    .checkpoint_created(index, identity, |page, bytes| {
                        pages.insert(page, bytes.to_vec());
                        Ok(())
                    })
                    .unwrap();
            }
            if detached_before_restart {
                drop(alias.detach().unwrap());
            } else {
                drop(alias);
            }
            drop((namespace_lease, directory, file, source, journal));
            trash::delete(&source_path).unwrap();
            assert!(!source_path.exists());
            let loaded = BundleJournal::restore_for_retirement(
                &plan,
                fixture,
                parent_id,
                &"a".repeat(64),
                |index| Ok(pages[&index].clone()),
            )
            .unwrap();
            let result = retire_loaded_objects(&root, &plan, loaded, |index, bytes| {
                pages.insert(index, bytes.to_vec());
                Ok(())
            })
            .unwrap();
            assert_eq!(result.objects_created, 0);
            assert_eq!(result.objects_retired, 4);
            assert!(result.retirement_confirmed);
            assert!(!namespace.exists());
            drop(parent);
            trash::delete(root).unwrap();
        }
    }
    #[test]
    fn failed_file_batch_publication_stops_transaction_and_retains_owned_debt() {
        let root = std::env::temp_dir().join(format!(
            "ShellSpan-materialization-failure-{}",
            Uuid::new_v4()
        ));
        std::fs::create_dir(&root).unwrap();
        let parent = verify_retirement_object(&root).unwrap();
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        win(
            unsafe { GetFileInformationByHandle(parent.0, &mut info) },
            "observe failure parent",
        )
        .unwrap();
        let parent_id = ObjectIdentity {
            volume: info.dwVolumeSerialNumber,
            file_id: ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
        };
        let source_path = root.join("source.js");
        std::fs::write(&source_path, b"retained source").unwrap();
        let source = ToolImageLease::open_source(&source_path).unwrap();
        let digest = Sha256::digest(source.read_bytes().unwrap())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let namespace = root.join("frontend-dependencies");
        let plan = crate::frontend_bundle_plan::build(
            &namespace,
            &[],
            &[namespace.join("a.js"), namespace.join("b.js")],
            &[],
        )
        .unwrap();
        let fixture = Uuid::new_v4();
        let mut pages = BTreeMap::new();
        let journal = BundleJournal::prepare(
            &plan,
            fixture,
            parent_id.clone(),
            &"a".repeat(64),
            |index, bytes| {
                pages.insert(index, bytes.to_vec());
                Ok(())
            },
        )
        .unwrap();
        let mut publications = 0;
        let mut file_parents = frontend_asset_copy::FileParentCache::default();
        let result = transact_with_workload(
            &plan,
            journal,
            |object| {
                if object.path.is_empty() {
                    frontend_asset_copy::create_directory(
                        &root,
                        "frontend-dependencies",
                        parent_id.volume,
                    )
                    .map(OwnedObject::Directory)
                } else {
                    frontend_asset_copy::copy_new_cached(
                        &source,
                        &digest,
                        &namespace,
                        &object.path,
                        parent_id.volume,
                        &mut file_parents,
                    )
                    .map(OwnedObject::File)
                }
            },
            |index, bytes| {
                publications += 1;
                if publications == 2 {
                    return Err("injected protected page failure".into());
                }
                pages.insert(index, bytes.to_vec());
                Ok(())
            },
            || panic!("failed creation checkpoint must forbid workload dispatch"),
        );
        assert!(result.is_err());
        assert_eq!(publications, 2);
        for name in ["a.js", "b.js"] {
            assert_eq!(
                std::fs::read(namespace.join(name)).unwrap(),
                b"retained source"
            );
        }
        let recorded: serde_json::Value = serde_json::from_slice(&pages[&0]).unwrap();
        assert_eq!(recorded["records"][0]["state"], "applied");
        for index in [1, 2] {
            assert_eq!(recorded["records"][index]["state"], "planned");
            assert!(recorded["records"][index]["identity"].is_null());
        }
        let restored = BundleJournal::restore_for_retirement(
            &plan,
            fixture,
            parent_id,
            &"a".repeat(64),
            |index| Ok(pages[&index].clone()),
        )
        .unwrap();
        assert!(!restored.retirement_confirmed());
        assert!(restored.creation_admitted(1).is_err());
        assert!(retire_loaded_objects(&root, &plan, restored, |_, _| {
            panic!("unrecorded live file must not publish retirement")
        })
        .is_err());
        assert!(namespace.join("a.js").exists());
        assert!(namespace.join("b.js").exists());
        assert_eq!(source.read_bytes().unwrap(), b"retained source");
        drop((source, parent));
        trash::delete(root).unwrap();
    }
    #[test]
    fn real_cross_page_transaction_creates_and_retires_every_object() {
        let root =
            std::env::temp_dir().join(format!("ShellSpan-materialization-{}", Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let parent = verify_retirement_object(&root).unwrap();
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        win(
            unsafe { GetFileInformationByHandle(parent.0, &mut info) },
            "observe test parent",
        )
        .unwrap();
        let parent_id = ObjectIdentity {
            volume: info.dwVolumeSerialNumber,
            file_id: ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
        };
        let source_path = root.join("source.js");
        std::fs::write(&source_path, b"complete transaction source").unwrap();
        let source = ToolImageLease::open_source(&source_path).unwrap();
        let digest = Sha256::digest(source.read_bytes().unwrap())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let namespace = root.join("dependencies");
        let files: Vec<_> = (0..70)
            .map(|index| namespace.join(format!("store/{index:03}.js")))
            .collect();
        let plan = crate::frontend_bundle_plan::build(
            &namespace,
            &[namespace.join("store")],
            &files,
            &[(namespace.join("pkg"), namespace.join("store"))],
        )
        .unwrap();
        let fixture = Uuid::new_v4();
        let mut pages = BTreeMap::new();
        let journal = BundleJournal::prepare(
            &plan,
            fixture,
            parent_id.clone(),
            &"a".repeat(64),
            |index, bytes| {
                pages.insert(index, bytes.to_vec());
                Ok(())
            },
        )
        .unwrap();
        let mut publications = 0;
        let mut file_parents = frontend_asset_copy::FileParentCache::default();
        let workload_ran = std::cell::Cell::new(false);
        let result = transact_with_workload(
            &plan,
            journal,
            |object| match object.kind.as_str() {
                "directory" if object.path.is_empty() => {
                    frontend_asset_copy::create_directory(&root, "dependencies", parent_id.volume)
                        .map(OwnedObject::Directory)
                }
                "directory" => frontend_asset_copy::create_directory(
                    &namespace,
                    &object.path,
                    parent_id.volume,
                )
                .map(OwnedObject::Directory),
                "file" => frontend_asset_copy::copy_new_cached(
                    &source,
                    &digest,
                    &namespace,
                    &object.path,
                    parent_id.volume,
                    &mut file_parents,
                )
                .map(OwnedObject::File),
                "alias" => frontend_asset_copy::create_alias(
                    &namespace,
                    &object.path,
                    object.target.as_ref().unwrap(),
                    parent_id.volume,
                )
                .map(OwnedObject::Alias),
                _ => Err("unexpected test object".into()),
            },
            |index, bytes| {
                publications += 1;
                pages.insert(index, bytes.to_vec());
                Ok(())
            },
            || {
                assert!(files.iter().all(|path| path.is_file()));
                assert_eq!(
                    std::fs::read(namespace.join("pkg/000.js")).unwrap(),
                    b"complete transaction source"
                );
                assert!(std::fs::write(&files[0], b"replacement").is_err());
                workload_ran.set(true);
                Ok(())
            },
        )
        .unwrap();
        assert!(workload_ran.get());
        assert_eq!(result.objects_created, 73);
        assert_eq!(result.objects_retired, 73);
        assert!(result.retirement_confirmed);
        assert_eq!(publications, 78); // Five creation publications plus 73 retirements.
        assert!(!namespace.exists());
        assert_eq!(source.read_bytes().unwrap(), b"complete transaction source");
        let restored = BundleJournal::restore_for_retirement(
            &plan,
            fixture,
            parent_id,
            &"a".repeat(64),
            |index| Ok(pages[&index].clone()),
        )
        .unwrap();
        assert!(restored.retirement_confirmed());
        assert!(restored.creation_admitted(0).is_err());
        drop((source, parent));
        trash::delete(root).unwrap();
    }
}
