//! Frozen complete frontend source inventory for the next owned-project run.
//! Inspection alone neither grants access nor proves LPAC build compatibility.
use crate::{
    appcontainer_probe::{verify_retirement_object, Handle},
    fixed_tool::{ToolImageIdentity, ToolImageLease},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
};

const FILE_BUDGET: usize = 1024;
const DIRECTORY_BUDGET: usize = 256;
const BYTE_BUDGET: u64 = 64 * 1024 * 1024;
const TOP_LEVEL: [&str; 8] = [
    "index.html",
    "package.json",
    "pnpm-lock.yaml",
    "tsconfig.json",
    "tsconfig.node.json",
    "vite.config.ts",
    "vitest.config.ts",
    "components.json",
];
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SourceFile {
    relative_path: String,
    identity: ToolImageIdentity,
    sha256: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SourceManifest {
    version: u32,
    scope: String,
    source_root: PathBuf,
    files: Vec<SourceFile>,
    total_bytes: u64,
}
pub struct FrozenFrontendSource {
    manifest: SourceManifest,
    _directories: Vec<Handle>,
    _files: Vec<ToolImageLease>,
    copy_parents: std::cell::RefCell<crate::frontend_asset_copy::FileParentCache>,
}
fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
fn fixed_workspace() -> Result<PathBuf, String> {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .ok_or_else(|| "fixed frontend source workspace missing".into())
}
fn allowed_relative(path: &str) -> bool {
    let components: Vec<_> = path.split('/').collect();
    if path.len() > 512
        || components.iter().any(|part| {
            part.is_empty()
                || matches!(*part, "." | "..")
                || part
                    .chars()
                    .any(|character| character.is_control() || matches!(character, ':' | '\\'))
                || part.ends_with(['.', ' '])
        })
    {
        return false;
    }
    let leaf = components.last().unwrap_or(&"").to_ascii_lowercase();
    if leaf.starts_with(".env")
        || [".pem", ".key", ".pfx", ".p12"]
            .iter()
            .any(|extension| leaf.ends_with(extension))
    {
        return false;
    }
    TOP_LEVEL.contains(&path) || components.len() > 1 && matches!(components[0], "src" | "public")
}
impl SourceManifest {
    pub fn validate(&self) -> Result<(), String> {
        if self.version != 1 || self.scope != "complete fixed frontend source inputs; dependencies and sandbox execution pending"
            || self.source_root != fixed_workspace()? || self.files.is_empty() || self.files.len() > FILE_BUDGET {
            return Err("fixed frontend manifest scope or budget differs".into());
        }
        let mut seen = BTreeSet::new();
        let mut total = 0u64;
        let mut previous = "";
        for file in &self.files {
            if !allowed_relative(&file.relative_path)
                || file.relative_path.as_str() <= previous
                || !seen.insert(file.relative_path.to_ascii_lowercase())
                || file.identity.path != self.source_root.join(&file.relative_path)
                || file.identity.volume == 0
                || file.identity.file_index == 0
                || file.sha256.len() != 64
                || !file
                    .sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            {
                return Err("fixed frontend source path, identity or digest differs".into());
            }
            total = total
                .checked_add(file.identity.bytes)
                .ok_or("frontend source byte overflow")?;
            previous = &file.relative_path;
        }
        if total != self.total_bytes
            || total > BYTE_BUDGET
            || TOP_LEVEL.iter().any(|name| !seen.contains(*name))
            || !seen.contains("src/main.tsx")
            || !seen.contains("src/lib/terminal/terminal-output-buffer.ts")
        {
            return Err("fixed frontend source set incomplete or excessive".into());
        }
        Ok(())
    }
}
impl FrozenFrontendSource {
    pub fn manifest(&self) -> &SourceManifest {
        &self.manifest
    }
    /// Supplies bytes and digest from the same immutable source owner, never a
    /// caller-selected source path. The destination coordinator must validate
    /// its protected parent, complete journal and exact creation stamp first.
    pub fn copy_new_stamped(
        &self,
        root: &Path,
        relative: &str,
        volume: u32,
        stamp: &crate::frontend_creation_stamp::CreationStamp,
    ) -> Result<crate::frontend_asset_copy::OwnedAsset, String> {
        let index = self
            .manifest
            .files
            .binary_search_by(|file| file.relative_path.as_str().cmp(relative))
            .map_err(|_| "source copy absent from complete frozen inventory")?;
        let record = &self.manifest.files[index];
        let lease = self
            ._files
            .iter()
            .find(|lease| {
                lease.identity.path == record.identity.path
                    && lease.identity.volume == record.identity.volume
                    && lease.identity.file_index == record.identity.file_index
                    && lease.identity.bytes == record.identity.bytes
            })
            .ok_or("frozen source lease identity missing")?;
        crate::frontend_asset_copy::copy_new_stamped(
            lease,
            &record.sha256,
            root,
            relative,
            volume,
            &mut self.copy_parents.borrow_mut(),
            Some(stamp),
        )
    }
    /// Complete source namespace plan derived only from this frozen inventory.
    /// This does not create objects, grant permissions or admit execution.
    pub fn bundle_plan(&self) -> Result<crate::frontend_bundle_plan::BundlePlan, String> {
        self.manifest.validate()?;
        let root = &self.manifest.source_root;
        let mut directories = BTreeSet::new();
        let mut files = Vec::with_capacity(self.manifest.files.len());
        for file in &self.manifest.files {
            let path = root.join(&file.relative_path);
            let mut ancestor = path.parent();
            while let Some(directory) = ancestor {
                if directory == root {
                    break;
                }
                if !directory.starts_with(root) {
                    return Err("frontend source parent escaped root".into());
                }
                directories.insert(directory.to_path_buf());
                ancestor = directory.parent();
            }
            files.push(path);
        }
        crate::frontend_bundle_plan::build(
            root,
            &directories.into_iter().collect::<Vec<_>>(),
            &files,
            &[],
        )
    }
    /// Structural validation alone cannot prove completeness: bind deliveries
    /// to the actual immutable inventory retained by this owner.
    pub fn verify_delivery(&self, candidate: &SourceManifest) -> Result<(), String> {
        candidate.validate()?;
        if serde_json::to_vec(candidate).map_err(|e| e.to_string())?
            != serde_json::to_vec(&self.manifest).map_err(|e| e.to_string())?
        {
            return Err("frontend manifest differs from frozen complete inventory".into());
        }
        Ok(())
    }
    /// Only the compile-time repository is admitted; no caller-selected paths.
    pub fn freeze() -> Result<Self, String> {
        let root = fixed_workspace()?;
        let mut directories = vec![verify_retirement_object(&root)?];
        let mut pending = vec![root.join("src"), root.join("public")];
        let mut paths: Vec<_> = TOP_LEVEL.iter().map(|name| root.join(name)).collect();
        while let Some(directory) = pending.pop() {
            if directories.len() >= DIRECTORY_BUDGET {
                return Err("fixed frontend directory budget exceeded".into());
            }
            directories.push(verify_retirement_object(&directory)?);
            for entry in std::fs::read_dir(&directory).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                let metadata = entry.path().symlink_metadata().map_err(|e| e.to_string())?;
                use std::os::windows::fs::MetadataExt;
                if metadata.file_attributes()
                    & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
                    != 0
                {
                    return Err("frontend source reparse input rejected".into());
                }
                if metadata.is_dir() {
                    pending.push(entry.path());
                } else if metadata.is_file() {
                    paths.push(entry.path());
                } else {
                    return Err("frontend source object type rejected".into());
                }
                if paths.len() > FILE_BUDGET || pending.len() + directories.len() > DIRECTORY_BUDGET
                {
                    return Err("fixed frontend source inventory budget exceeded".into());
                }
            }
        }
        paths.sort();
        let mut files = Vec::new();
        let mut leases = Vec::new();
        let mut total = 0u64;
        for path in paths {
            let relative = path
                .strip_prefix(&root)
                .map_err(|_| "frontend input escaped fixed root")?
                .to_str()
                .ok_or("frontend source path is not Unicode")?
                .replace('\\', "/");
            if !allowed_relative(&relative) {
                return Err("frontend input outside fixed source scope".into());
            }
            let _single_link = verify_retirement_object(&path)?;
            let lease = ToolImageLease::open(&path)?;
            total = total
                .checked_add(lease.identity.bytes)
                .ok_or("frontend source byte overflow")?;
            if total > BYTE_BUDGET {
                return Err("fixed frontend source byte budget exceeded".into());
            }
            files.push(SourceFile {
                relative_path: relative,
                identity: lease.identity.clone(),
                sha256: digest(&lease.read_bytes()?),
            });
            leases.push(lease);
        }
        files.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
        let manifest = SourceManifest {
            version: 1,
            scope:
                "complete fixed frontend source inputs; dependencies and sandbox execution pending"
                    .into(),
            source_root: root,
            files,
            total_bytes: total,
        };
        manifest.validate()?;
        Ok(Self {
            manifest,
            _directories: directories,
            _files: leases,
            copy_parents: std::cell::RefCell::new(
                crate::frontend_asset_copy::FileParentCache::default(),
            ),
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn complete_frozen_source_transaction_has_durable_inputs_before_workload() {
        full_source_transaction(false);
    }
    #[test]
    fn complete_source_workload_failure_recovers_after_inventory_owner_drops() {
        full_source_transaction(true);
    }
    fn full_source_transaction(fail_workload: bool) {
        use crate::frontend_bundle_journal::ObjectIdentity;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };
        let source = FrozenFrontendSource::freeze().unwrap();
        let root = std::env::temp_dir().join(format!(
            "ShellSpan-source-transaction-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&root).unwrap();
        let parent = crate::appcontainer_probe::hold_journal_parent(&root).unwrap();
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        crate::appcontainer_probe::win(
            unsafe { GetFileInformationByHandle(parent.0, &mut info) },
            "full source test parent",
        )
        .unwrap();
        let identity = ObjectIdentity {
            volume: info.dwVolumeSerialNumber,
            file_id: ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
        };
        let count = source.bundle_plan().unwrap().retirement_object_count();
        let plan_bytes = serde_json::to_vec(&source.bundle_plan().unwrap()).unwrap();
        let plan_hash = digest(&plan_bytes);
        let inventory_hash = digest(&serde_json::to_vec(source.manifest()).unwrap());
        let fixture = uuid::Uuid::new_v4();
        let pages = std::cell::RefCell::new(std::collections::BTreeMap::new());
        let ran = std::cell::Cell::new(false);
        let result = crate::frontend_materialization::materialize_source_run_and_retire(
            &source,
            &root,
            identity.clone(),
            fixture,
            |index, bytes| {
                pages.borrow_mut().insert(index, bytes.to_vec());
                Ok(())
            },
            |namespace| {
                assert_eq!(namespace, root.join("frontend-source"));
                let records: Vec<serde_json::Value> = pages
                    .borrow()
                    .values()
                    .map(|bytes| serde_json::from_slice(bytes).unwrap())
                    .collect();
                assert_eq!(
                    records
                        .iter()
                        .map(|page| page["records"].as_array().unwrap().len())
                        .sum::<usize>(),
                    count
                );
                assert!(records.iter().all(|page| page["records"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|record| record["state"] == "applied")));
                for file in &source.manifest.files {
                    assert_eq!(
                        digest(&std::fs::read(namespace.join(&file.relative_path)).unwrap()),
                        file.sha256,
                        "{}",
                        file.relative_path
                    );
                }
                assert!(std::fs::write(namespace.join("package.json"), b"replacement").is_err());
                ran.set(true);
                if fail_workload {
                    Err("injected source workload failure".into())
                } else {
                    Ok(())
                }
            },
        );
        assert!(ran.get());
        let result = if fail_workload {
            assert!(
                matches!(result, Err(ref error) if error == "injected source workload failure")
            );
            assert!(root.join("frontend-source/package.json").is_file());
            assert!(pages.borrow().values().all(|bytes| {
                let page: serde_json::Value = serde_json::from_slice(bytes).unwrap();
                page["records"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|record| record["state"] == "applied")
            }));
            drop(source);
            // Bound plan/pages survive independently of the original source leases.
            let plan = crate::frontend_bundle_plan::BundlePlan::read_bound(&plan_bytes, &plan_hash)
                .unwrap();
            let journal = crate::frontend_bundle_journal::BundleJournal::restore_for_retirement(
                &plan,
                fixture,
                identity,
                &inventory_hash,
                |index| Ok(pages.borrow()[&index].clone()),
            )
            .unwrap();
            assert!(journal.creation_admitted(0).is_err());
            crate::frontend_materialization::retire_loaded_objects_in_namespace(
                &root,
                &plan,
                journal,
                crate::frontend_materialization::MaterializationNamespace::Source,
                |index, bytes| {
                    pages.borrow_mut().insert(index, bytes.to_vec());
                    Ok(())
                },
            )
            .unwrap()
        } else {
            result.unwrap()
        };
        assert_eq!(
            result.objects_created,
            if fail_workload { 0 } else { count }
        );
        assert_eq!(result.objects_retired, count);
        assert!(result.retirement_confirmed);
        assert!(!root.join("frontend-source").exists());
        assert!(pages.borrow().values().all(|bytes| {
            let page: serde_json::Value = serde_json::from_slice(bytes).unwrap();
            page["records"]
                .as_array()
                .unwrap()
                .iter()
                .all(|record| record["state"] == "retired")
        }));
        drop(parent);
        trash::delete(root).unwrap();
    }
    #[test]
    fn source_copy_uses_frozen_bytes_and_atomic_stamp_without_overwrite() {
        use crate::frontend_bundle_journal::ObjectIdentity;
        use crate::frontend_creation_stamp::{CreationKind, CreationStamp};
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };
        let source = FrozenFrontendSource::freeze().unwrap();
        let root =
            std::env::temp_dir().join(format!("ShellSpan-source-copy-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let parent = verify_retirement_object(&root).unwrap();
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        crate::appcontainer_probe::win(
            unsafe { GetFileInformationByHandle(parent.0, &mut info) },
            "source copy parent",
        )
        .unwrap();
        let fixture = uuid::Uuid::new_v4();
        let inventory_digest = digest(&serde_json::to_vec(source.manifest()).unwrap());
        let plan_digest = digest(&serde_json::to_vec(&source.bundle_plan().unwrap()).unwrap());
        let stamp = CreationStamp::new(
            fixture,
            1,
            CreationKind::File,
            &inventory_digest,
            &plan_digest,
        )
        .unwrap();
        assert!(source
            .copy_new_stamped(&root, "../package.json", info.dwVolumeSerialNumber, &stamp)
            .is_err());
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
        let asset = source
            .copy_new_stamped(&root, "package.json", info.dwVolumeSerialNumber, &stamp)
            .unwrap();
        let record = source
            .manifest
            .files
            .iter()
            .find(|file| file.relative_path == "package.json")
            .unwrap();
        assert_eq!(
            digest(&std::fs::read(root.join("package.json")).unwrap()),
            record.sha256
        );
        let identity = ObjectIdentity {
            volume: asset.identity().volume,
            file_id: asset.identity().file_index,
        };
        assert!(
            stamp
                .observe(&root.join("package.json"))
                .unwrap()
                .identity()
                == &identity
        );
        assert!(source
            .copy_new_stamped(&root, "package.json", info.dwVolumeSerialNumber, &stamp)
            .is_err());
        assert!(std::fs::write(root.join("package.json"), b"replacement").is_err());
        asset.recycle(&identity).unwrap();
        assert!(!root.join("package.json").exists());
        drop(parent);
        trash::delete(root).unwrap();
    }
    #[test]
    fn full_inventory_is_bound_to_live_leases_not_a_reduced_manifest() {
        let source = FrozenFrontendSource::freeze().unwrap();
        let plan = source.bundle_plan().unwrap();
        let objects = plan.objects();
        let copied_files: BTreeSet<_> = objects
            .iter()
            .filter(|object| object.kind == "file")
            .map(|object| object.path.as_str())
            .collect();
        let frozen_files: BTreeSet<_> = source
            .manifest
            .files
            .iter()
            .map(|file| file.relative_path.as_str())
            .collect();
        assert_eq!(
            copied_files, frozen_files,
            "every frozen source must appear exactly once"
        );
        assert_eq!(
            objects
                .iter()
                .filter(|object| object.kind == "file")
                .count(),
            frozen_files.len()
        );
        assert!(objects.iter().all(|object| object.target.is_none()));
        let planned_directories: BTreeSet<_> = objects
            .iter()
            .filter(|object| object.kind == "directory")
            .map(|object| object.path.as_str())
            .collect();
        for path in &frozen_files {
            let mut parent = Path::new(path).parent();
            while let Some(directory) = parent {
                assert!(
                    planned_directories.contains(directory.to_str().unwrap()),
                    "source parent must be journalled: {path}"
                );
                parent = directory.parent();
            }
        }
        source.verify_delivery(source.manifest()).unwrap();
        let bytes = serde_json::to_vec(source.manifest()).unwrap();
        let mut reduced: SourceManifest = serde_json::from_slice(&bytes).unwrap();
        let index = reduced
            .files
            .iter()
            .position(|file| file.relative_path.starts_with("public/"))
            .unwrap();
        reduced.total_bytes -= reduced.files.remove(index).identity.bytes;
        reduced.validate().unwrap();
        assert!(source
            .verify_delivery(&reduced)
            .unwrap_err()
            .contains("frozen complete inventory"));
        let mut replacement: SourceManifest = serde_json::from_slice(&bytes).unwrap();
        replacement.source_root = std::env::temp_dir();
        assert!(replacement.validate().is_err());
        let mut digest_changed: SourceManifest = serde_json::from_slice(&bytes).unwrap();
        digest_changed.files[0].sha256 = "0".repeat(64);
        assert!(source.verify_delivery(&digest_changed).is_err());
    }
    #[test]
    fn source_scope_rejects_escape_aliases_and_sensitive_inputs() {
        for path in ["src/main.tsx", "public/logo.svg", "package.json"] {
            assert!(allowed_relative(path));
        }
        for path in [
            "../src/main.tsx",
            "src/../main.tsx",
            "src//main.tsx",
            "src\\main.tsx",
            "src/main.tsx:stream",
            "src/.env.local",
            "public/key.pem",
            "node_modules/code.js",
            "src/main.tsx.",
        ] {
            assert!(!allowed_relative(path), "{path}");
        }
    }
}
