//! One frozen owner for complete project inputs; no grants or execution.
use crate::{
    frontend_bundle_plan::BundlePlan, frontend_runtime_inventory::RuntimeInventory,
    frontend_source_plan::FrozenFrontendSource,
};
use sha2::{Digest, Sha256};

pub struct FrozenFrontendProject {
    source: FrozenFrontendSource,
    dependencies: RuntimeInventory,
    plan: BundlePlan,
    inventory_sha256: String,
}
fn hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
impl FrozenFrontendProject {
    /// Uses only the compile-time workspace and retains both immutable leases.
    pub fn freeze() -> Result<Self, String> {
        let source = FrozenFrontendSource::freeze()?;
        let dependencies = RuntimeInventory::inspect_fixed()?;
        let plan =
            BundlePlan::compose_project(&source.bundle_plan()?, &dependencies.bundle_plan()?)?;
        // Domain separation and named fields prevent swapping the two bindings.
        let binding = serde_json::json!({"version":1,"scope":"fixed-frontend-project-inputs-v1",
            "source_sha256":hash(&serde_json::to_vec(source.manifest()).map_err(|e| e.to_string())?),
            "dependencies_sha256":hash(&serde_json::to_vec(&dependencies).map_err(|e| e.to_string())?)});
        let inventory_sha256 = hash(&serde_json::to_vec(&binding).map_err(|e| e.to_string())?);
        Ok(Self {
            source,
            dependencies,
            plan,
            inventory_sha256,
        })
    }
    pub fn source(&self) -> &FrozenFrontendSource {
        &self.source
    }
    pub fn dependencies(&self) -> &RuntimeInventory {
        &self.dependencies
    }
    pub fn plan(&self) -> &BundlePlan {
        &self.plan
    }
    pub fn inventory_sha256(&self) -> &str {
        &self.inventory_sha256
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    // Ordinary test diagnostics only. These records do not grant SYSTEM recovery authority.
    fn publish_test_record(
        root: &Path,
        name: &str,
        bytes: &[u8],
        budget: usize,
    ) -> Result<(), String> {
        use windows_sys::Win32::Storage::FileSystem::*;
        if bytes.is_empty() || bytes.len() > budget || name.contains(['/', '\\', ':']) {
            return Err("test journal name or byte budget invalid".into());
        }
        let _parent = crate::appcontainer_probe::hold_journal_parent(root)?;
        let target = root.join(name);
        match std::fs::symlink_metadata(&target) {
            Ok(metadata) => {
                use std::os::windows::fs::MetadataExt;
                if !metadata.is_file()
                    || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
                {
                    return Err("test journal target is not a regular file".into());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
        let pending = root.join(format!(
            "test-journal-pending-{}.json",
            uuid::Uuid::new_v4()
        ));
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&pending)
            .map_err(|e| e.to_string())?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        drop(file);
        let wide = |path: &Path| {
            path.as_os_str()
                .encode_wide()
                .chain(Some(0))
                .collect::<Vec<_>>()
        };
        crate::appcontainer_probe::win(
            unsafe {
                MoveFileExW(
                    wide(&pending).as_ptr(),
                    wide(&target).as_ptr(),
                    MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
                )
            },
            "publish test checkpoint",
        )
    }
    #[test]
    fn disk_checkpoint_replacement_preserves_last_record_on_budget_failure() {
        let root = std::env::temp_dir().join(format!(
            "ShellSpan-project-journal-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&root).unwrap();
        publish_test_record(&root, "page.json", b"planned", 64).unwrap();
        publish_test_record(&root, "page.json", b"applied", 64).unwrap();
        assert_eq!(std::fs::read(root.join("page.json")).unwrap(), b"applied");
        assert!(publish_test_record(&root, "page.json", &[0; 65], 64).is_err());
        assert!(publish_test_record(&root, "../escaped.json", b"x", 64).is_err());
        assert_eq!(std::fs::read(root.join("page.json")).unwrap(), b"applied");
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
        trash::delete(root).unwrap();
    }
    #[test]
    #[ignore = "full installed dependency copying and retirement; run explicitly on Windows NTFS"]
    fn actual_complete_project_materialization_and_retirement() {
        complete_project_transaction(false);
    }
    #[test]
    #[ignore = "full installed dependency failure recovery; run explicitly on Windows NTFS"]
    fn actual_complete_project_failure_recovers_without_original_inventory() {
        complete_project_transaction(true);
    }
    fn complete_project_transaction(fail_workload: bool) {
        use crate::frontend_bundle_journal::ObjectIdentity;
        use windows_sys::Win32::Storage::FileSystem::*;
        let project = FrozenFrontendProject::freeze().unwrap();
        let fixture = uuid::Uuid::new_v4();
        let root = std::env::temp_dir().join(format!("ShellSpan-project-transaction-{fixture}"));
        std::fs::create_dir(&root).unwrap();
        let held = crate::appcontainer_probe::hold_journal_parent(&root).unwrap();
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        crate::appcontainer_probe::win(
            unsafe { GetFileInformationByHandle(held.0, &mut info) },
            "project test parent",
        )
        .unwrap();
        let parent = ObjectIdentity {
            volume: info.dwVolumeSerialNumber,
            file_id: ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
        };
        let count = project.plan().retirement_object_count();
        let plan_bytes = serde_json::to_vec(project.plan()).unwrap();
        let plan_hash = hash(&plan_bytes);
        let inventory_hash = project.inventory_sha256().to_owned();
        publish_test_record(
            &root,
            "frontend-bundle-plan.json",
            &plan_bytes,
            16 * 1024 * 1024,
        )
        .unwrap();
        let ownership = serde_json::json!({"version":1,"scope":"ordinary-project-test-diagnostics-v1","fixture_id":fixture,
            "parent":parent,"plan_sha256":plan_hash,"inventory_sha256":inventory_hash,
            "objects":count,"namespace":"frontend-project","system_recovery_authorized":false});
        publish_test_record(
            &root,
            "test-ownership.json",
            &serde_json::to_vec(&ownership).unwrap(),
            65536,
        )
        .unwrap();
        let pages = std::cell::RefCell::new(std::collections::BTreeMap::<usize, Vec<u8>>::new());
        let ran = std::cell::Cell::new(false);
        let result = crate::frontend_materialization::materialize_project_run_and_retire(
            &project,
            &root,
            parent.clone(),
            fixture,
            |index, bytes| {
                publish_test_record(
                    &root,
                    &format!("frontend-bundle-page-{index:04}.json"),
                    bytes,
                    65536,
                )?;
                pages.borrow_mut().insert(index, bytes.to_vec());
                Ok(())
            },
            |namespace| {
                assert_eq!(namespace, root.join("frontend-project"));
                let records: Vec<serde_json::Value> = pages
                    .borrow()
                    .values()
                    .map(|b| serde_json::from_slice(b).unwrap())
                    .collect();
                assert_eq!(
                    records
                        .iter()
                        .map(|p| p["records"].as_array().unwrap().len())
                        .sum::<usize>(),
                    count
                );
                assert!(records
                    .iter()
                    .flat_map(|p| p["records"].as_array().unwrap())
                    .all(|r| r["state"] == "applied"));
                for object in project.plan().objects() {
                    let path = namespace.join(&object.path);
                    match object.kind.as_str() {
                        "file" => {
                            assert!(path.is_file(), "{}", object.path);
                        }
                        "directory" => {
                            assert!(path.is_dir(), "{}", object.path);
                        }
                        "alias" => {
                            assert!(path.is_dir(), "{}", object.path);
                        }
                        _ => panic!("unexpected project object"),
                    }
                }
                assert_eq!(
                    std::fs::read(namespace.join("package.json")).unwrap(),
                    std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../package.json"))
                        .unwrap()
                );
                assert!(
                    !std::fs::read(namespace.join("node_modules/typescript/lib/tsc.js"))
                        .unwrap()
                        .is_empty()
                );
                assert!(std::fs::write(namespace.join("package.json"), b"overwrite").is_err());
                ran.set(true);
                if fail_workload {
                    Err("fixed complete project workload failure".into())
                } else {
                    Ok(())
                }
            },
        );
        let receipt = serde_json::json!({"version":1,"scope":"ordinary-project-test-diagnostics-v1",
            "fixture_id":fixture,"workload_entered":ran.get(),"expected_workload_failure":fail_workload,
            "error":result.as_ref().err(),"objects_created":result.as_ref().ok().map(|r| r.objects_created),
            "objects_retired":result.as_ref().ok().map(|r| r.objects_retired),
            "retirement_confirmed":result.as_ref().ok().is_some_and(|r| r.retirement_confirmed),
            "system_recovery_authorized":false});
        publish_test_record(
            &root,
            "test-result.json",
            &serde_json::to_vec(&receipt).unwrap(),
            65536,
        )
        .unwrap();
        assert!(ran.get());
        let result = if fail_workload {
            assert_eq!(
                result.err().as_deref(),
                Some("fixed complete project workload failure")
            );
            assert!(root.join("frontend-project").is_dir());
            drop(project);
            let plan = BundlePlan::read_bound(&plan_bytes, &plan_hash).unwrap();
            let journal = crate::frontend_bundle_journal::BundleJournal::restore_for_retirement(
                &plan,
                fixture,
                parent,
                &inventory_hash,
                |index| {
                    std::fs::read(root.join(format!("frontend-bundle-page-{index:04}.json")))
                        .map_err(|e| e.to_string())
                },
            )
            .unwrap();
            let retired = crate::frontend_materialization::retire_loaded_objects_in_namespace(
                &root,
                &plan,
                journal,
                crate::frontend_materialization::MaterializationNamespace::Project,
                |index, bytes| {
                    publish_test_record(
                        &root,
                        &format!("frontend-bundle-page-{index:04}.json"),
                        bytes,
                        65536,
                    )?;
                    pages.borrow_mut().insert(index, bytes.to_vec());
                    Ok(())
                },
            )
            .unwrap();
            assert_eq!(retired.objects_created, 0);
            retired
        } else {
            let completed = result.unwrap();
            assert_eq!(completed.objects_created, count);
            drop(project);
            completed
        };
        assert_eq!(result.objects_retired, count);
        assert!(result.retirement_confirmed);
        assert!(!root.join("frontend-project").exists());
        assert!(pages.borrow().values().all(|b| {
            let p: serde_json::Value = serde_json::from_slice(b).unwrap();
            p["records"]
                .as_array()
                .unwrap()
                .iter()
                .all(|r| r["state"] == "retired")
        }));
        drop(held);
        trash::delete(&root).unwrap();
    }
    #[test]
    fn actual_complete_project_plan_survives_original_inventory_drop() {
        let frozen = FrozenFrontendProject::freeze().unwrap();
        let source = frozen.source().bundle_plan().unwrap();
        let dependencies = frozen.dependencies().bundle_plan().unwrap();
        let expected = BundlePlan::compose_project(&source, &dependencies).unwrap();
        let bytes = serde_json::to_vec(frozen.plan()).unwrap();
        assert_eq!(bytes, serde_json::to_vec(&expected).unwrap());
        assert_eq!(
            frozen.plan().retirement_object_count(),
            source.retirement_object_count() + dependencies.retirement_object_count()
        );
        assert_eq!(frozen.inventory_sha256().len(), 64);
        let objects = frozen.plan().objects();
        assert!(objects
            .iter()
            .any(|o| o.path == "package.json" && o.kind == "file"));
        assert!(objects
            .iter()
            .any(|o| o.path == "node_modules/typescript" && o.kind == "alias"));
        assert!(objects.iter().filter(|o| o.kind == "alias").all(|o| o
            .path
            .starts_with("node_modules/")
            && o.target
                .as_ref()
                .is_some_and(|t| t.starts_with("node_modules/"))));
        let count = frozen.plan().retirement_object_count();
        let digest = hash(&bytes);
        drop(frozen);
        let recovered = BundlePlan::read_bound(&bytes, &digest).unwrap();
        assert_eq!(recovered.retirement_object_count(), count);
        assert_eq!(serde_json::to_vec(&recovered).unwrap(), bytes);
        assert!(BundlePlan::read_bound(&bytes, &"0".repeat(64)).is_err());
    }
}
