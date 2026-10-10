//! Immutable borrowed dependency assets; no source ACL changes or owned copies.
use crate::{
    appcontainer_probe::{verify_retirement_object, Handle},
    fixed_tool::{ToolImageIdentity, ToolImageLease},
    frontend_dependency_graph::{resolve_recorded, DependencyGraph, SourceEntry},
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::os::windows::fs::MetadataExt;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
};

#[derive(Serialize)]
struct Asset {
    identity: ToolImageIdentity,
    sha256: String,
    source_links: u32,
}
/// Frozen lookup for copies into the combined project's node_modules tree.
/// Caller must bind each stamp to the complete project journal before creation.
pub(crate) struct ProjectAssetCopier<'a> {
    source: &'a RuntimeInventory,
    files: BTreeMap<String, (usize, String)>,
    parents: std::cell::RefCell<crate::frontend_asset_copy::FileParentCache>,
}
impl ProjectAssetCopier<'_> {
    pub(crate) fn copy_new_stamped(
        &self,
        root: &std::path::Path,
        relative: &str,
        volume: u32,
        stamp: &crate::frontend_creation_stamp::CreationStamp,
    ) -> Result<crate::frontend_asset_copy::OwnedAsset, String> {
        let input = relative
            .strip_prefix("node_modules/")
            .ok_or("project dependency prefix missing")?;
        let (index, digest) = self
            .files
            .get(input)
            .ok_or("project dependency absent from frozen inventory")?;
        crate::frontend_asset_copy::copy_new_stamped(
            &self.source._files[*index],
            digest,
            root,
            relative,
            volume,
            &mut self.parents.borrow_mut(),
            Some(stamp),
        )
    }
}
pub struct AssetCopier<'a> {
    source: &'a RuntimeInventory,
    files: BTreeMap<String, usize>,
    digests: BTreeMap<String, String>,
    directories: BTreeSet<String>,
    aliases: BTreeMap<String, String>,
    root: PathBuf,
    volume: u32,
    parent_identity: crate::frontend_bundle_journal::ObjectIdentity,
    _parent: Handle,
    file_parents: std::cell::RefCell<crate::frontend_asset_copy::FileParentCache>,
    stamps: BTreeMap<String, crate::frontend_creation_stamp::CreationStamp>,
}
impl AssetCopier<'_> {
    pub(crate) fn parent_identity(&self) -> &crate::frontend_bundle_journal::ObjectIdentity {
        &self.parent_identity
    }
    pub(crate) fn create_namespace(
        &self,
    ) -> Result<crate::frontend_asset_copy::OwnedDirectory, String> {
        crate::frontend_asset_copy::create_journal_namespace(
            self.root.parent().ok_or("materialization parent missing")?,
            self.volume,
            self.stamps
                .get("")
                .ok_or("namespace creation stamp missing")?,
        )
    }
    pub fn create_alias(
        &self,
        relative: &str,
    ) -> Result<crate::frontend_asset_copy::OwnedAlias, String> {
        let target = self
            .aliases
            .get(relative)
            .ok_or("alias absent from complete bundle plan")?;
        crate::frontend_asset_copy::create_alias_stamped(
            &self.root,
            relative,
            target,
            self.volume,
            Some(
                self.stamps
                    .get(relative)
                    .ok_or("alias creation stamp missing")?,
            ),
        )
    }
    pub fn create_directory(
        &self,
        relative: &str,
    ) -> Result<crate::frontend_asset_copy::OwnedDirectory, String> {
        if !self.directories.contains(relative) || relative.is_empty() {
            return Err("directory absent from complete bundle plan".into());
        }
        crate::frontend_asset_copy::create_directory_stamped(
            &self.root,
            relative,
            self.volume,
            Some(
                self.stamps
                    .get(relative)
                    .ok_or("directory creation stamp missing")?,
            ),
        )
    }
    pub fn copy_new(
        &self,
        relative: &str,
    ) -> Result<crate::frontend_asset_copy::OwnedAsset, String> {
        let index = *self
            .files
            .get(relative)
            .ok_or("asset absent from held complete inventory")?;
        crate::frontend_asset_copy::copy_new_stamped(
            &self.source._files[index],
            self.digests.get(relative).ok_or("asset digest missing")?,
            &self.root,
            relative,
            self.volume,
            &mut self.file_parents.borrow_mut(),
            Some(
                self.stamps
                    .get(relative)
                    .ok_or("file creation stamp missing")?,
            ),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cached_plan_preserves_frozen_inventory_bytes_and_complete_plan() {
        let graph = DependencyGraph::inspect_fixed().unwrap();
        let root = graph.store().parent().unwrap().to_path_buf();
        let inventory = RuntimeInventory {
            version: 1,
            scope: "plan cache fixture",
            production: "unavailable",
            graph,
            assets: vec![],
            entries: vec![],
            directories: 1,
            directory_paths: vec![root.join("store")],
            bytes: 0,
            owned_copy_ready: false,
            _files: vec![],
            _directories: vec![],
            _bundle_plan: std::cell::OnceCell::new(),
        };
        let before = serde_json::to_vec(&inventory).unwrap();
        assert!(inventory._bundle_plan.get().is_none());
        let first = inventory.bundle_plan().unwrap();
        assert!(inventory._bundle_plan.get().is_some());
        let second = inventory.bundle_plan().unwrap();
        assert_eq!(
            serde_json::to_vec(&first).unwrap(),
            serde_json::to_vec(&second).unwrap()
        );
        assert_eq!(serde_json::to_vec(&inventory).unwrap(), before);
        assert_eq!(first.retirement_object_count(), 2);
    }
    #[test]
    fn empty_dependency_asset_is_frozen_but_cannot_be_an_executable_image() {
        let root = std::env::temp_dir().join(format!("ShellSpan-runtime-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("empty.js");
        std::fs::write(&path, []).unwrap();
        assert!(ToolImageLease::open(&path).is_err());
        let asset = ToolImageLease::open_source(&path).unwrap();
        assert_eq!(asset.identity.bytes, 0);
        assert!(asset.read_bytes().unwrap().is_empty());
        assert_eq!(asset.source_link_count().unwrap(), 1);
        assert!(std::fs::write(&path, b"replacement").is_err());
        drop(asset);
        trash::delete(root).unwrap();
    }
    #[test]
    fn borrowed_hardlinks_are_observed_and_locked_without_source_mutation() {
        let root = std::env::temp_dir().join(format!("ShellSpan-runtime-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("asset.js");
        let alias = root.join("alias.js");
        std::fs::write(&path, b"export default 1").unwrap();
        std::fs::hard_link(&path, &alias).unwrap();
        let asset = ToolImageLease::open_source(&path).unwrap();
        assert_eq!(asset.source_link_count().unwrap(), 2);
        assert_eq!(asset.read_bytes().unwrap(), b"export default 1");
        assert!(std::fs::write(&alias, b"changed").is_err());
        drop(asset);
        assert_eq!(std::fs::read(&alias).unwrap(), b"export default 1");
        trash::delete(root).unwrap();
    }
    #[test]
    fn delivery_binds_actual_asset_identity_digest_and_complete_graph() {
        let root = std::env::temp_dir().join(format!("ShellSpan-runtime-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("asset.js");
        std::fs::write(&path, b"export default 1").unwrap();
        let lease = ToolImageLease::open_source(&path).unwrap();
        let inventory = RuntimeInventory {
            version: 1,
            scope: "delivery regression fixture",
            production: "unavailable",
            graph: DependencyGraph::inspect_fixed().unwrap(),
            assets: vec![Asset {
                identity: lease.identity.clone(),
                sha256: Sha256::digest(lease.read_bytes().unwrap())
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect(),
                source_links: 1,
            }],
            entries: vec![],
            directories: 1,
            directory_paths: vec![root.clone()],
            bytes: lease.identity.bytes,
            owned_copy_ready: false,
            _files: vec![lease],
            _directories: vec![verify_retirement_object(&root).unwrap()],
            _bundle_plan: std::cell::OnceCell::new(),
        };
        let original = serde_json::to_value(&inventory).unwrap();
        inventory
            .verify_delivery(&serde_json::to_vec(&original).unwrap())
            .unwrap();
        let mut reduced = original.clone();
        reduced["assets"] = serde_json::json!([]);
        reduced["bytes"] = serde_json::json!(0);
        assert!(inventory
            .verify_delivery(&serde_json::to_vec(&reduced).unwrap())
            .is_err());
        let mut changed = original.clone();
        changed["assets"][0]["identity"]["file_index"] = serde_json::json!(0);
        assert!(inventory
            .verify_delivery(&serde_json::to_vec(&changed).unwrap())
            .is_err());
        changed = original.clone();
        changed["assets"][0]["sha256"] = serde_json::json!("0".repeat(64));
        assert!(inventory
            .verify_delivery(&serde_json::to_vec(&changed).unwrap())
            .is_err());
        changed = original;
        changed["graph"]["edges"] = serde_json::json!([]);
        assert!(inventory
            .verify_delivery(&serde_json::to_vec(&changed).unwrap())
            .is_err());
        assert!(inventory.verify_delivery(b"invalid").is_err());
        drop(inventory);
        trash::delete(root).unwrap();
    }
}
#[derive(Serialize)]
pub struct RuntimeInventory {
    version: u32,
    scope: &'static str,
    production: &'static str,
    graph: DependencyGraph,
    assets: Vec<Asset>,
    entries: Vec<SourceEntry>,
    directories: usize,
    directory_paths: Vec<PathBuf>,
    bytes: u64,
    owned_copy_ready: bool,
    #[serde(skip)]
    _files: Vec<ToolImageLease>,
    #[serde(skip)]
    _directories: Vec<Handle>,
    #[serde(skip)]
    _bundle_plan: std::cell::OnceCell<Result<crate::frontend_bundle_plan::BundlePlan, String>>,
}
impl RuntimeInventory {
    pub(crate) fn project_asset_copier(&self) -> Result<ProjectAssetCopier<'_>, String> {
        let root = self
            .graph
            .store()
            .parent()
            .ok_or("project dependency source root missing")?;
        let mut digests = BTreeMap::new();
        for asset in &self.assets {
            let path = crate::frontend_bundle_plan::project_relative(root, &asset.identity.path)?;
            if digests.insert(path, asset.sha256.clone()).is_some() {
                return Err("project dependency digest overlaps".into());
            }
        }
        let mut files = BTreeMap::new();
        for (index, lease) in self._files.iter().enumerate() {
            let relative =
                crate::frontend_bundle_plan::project_relative(root, &lease.identity.path)?;
            let digest = digests
                .remove(&relative)
                .ok_or("project dependency lease digest missing")?;
            if files.insert(relative, (index, digest)).is_some() {
                return Err("project dependency lease overlaps".into());
            }
        }
        if !digests.is_empty() {
            return Err("project dependency lease inventory incomplete".into());
        }
        Ok(ProjectAssetCopier {
            source: self,
            files,
            parents: std::cell::RefCell::default(),
        })
    }
    /// Native coordinator must publish this distinct creation anchor before
    /// requesting copies. Old read-only journal diagnostics cannot be reused.
    pub fn asset_copier(&self, fixture: uuid::Uuid) -> Result<AssetCopier<'_>, String> {
        let parent = PathBuf::from(format!(
            r"C:\ProgramData\ShellSpan-account-profile-A-{fixture}"
        ));
        if fixture.is_nil() {
            return Err("asset copy fixture is nil".into());
        }
        let anchor: serde_json::Value =
            serde_json::from_slice(&crate::account_lpac_plan::read_protected_receipt(&parent)?)
                .map_err(|e| e.to_string())?;
        let inventory_sha256 = Sha256::digest(serde_json::to_vec(self).map_err(|e| e.to_string())?)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        if anchor["backend"] != "fixed-frontend-materialization-v1"
            || anchor["creation_stamp_version"] != 1
            || anchor["fixture_id"] != fixture.to_string()
            || anchor["phase"] != "creating; execution forbidden"
            || anchor["namespace_root"] != "frontend-dependencies"
            || anchor["inventory_sha256"] != inventory_sha256
            || anchor["permissions_granted"] != false
        {
            return Err("asset copy protected creation binding differs".into());
        }
        let held = crate::appcontainer_probe::hold_journal_parent(&parent)?;
        let mut info =
            windows_sys::Win32::Storage::FileSystem::BY_HANDLE_FILE_INFORMATION::default();
        crate::appcontainer_probe::win(
            unsafe {
                windows_sys::Win32::Storage::FileSystem::GetFileInformationByHandle(
                    held.0, &mut info,
                )
            },
            "observe asset copy anchor parent",
        )?;
        if anchor["parent"]["volume"] != info.dwVolumeSerialNumber
            || anchor["parent"]["file_id"]
                != ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64
        {
            return Err("asset copy anchor parent identity differs".into());
        }
        let source_root = self
            .graph
            .store()
            .parent()
            .ok_or("asset source root missing")?;
        let mut files = BTreeMap::new();
        let mut digests = BTreeMap::new();
        for (index, file) in self._files.iter().enumerate() {
            let relative =
                crate::frontend_bundle_plan::project_relative(source_root, &file.identity.path)?;
            if files.insert(relative, index).is_some() {
                return Err("asset source map overlaps".into());
            }
        }
        for asset in &self.assets {
            digests.insert(
                crate::frontend_bundle_plan::project_relative(source_root, &asset.identity.path)?,
                asset.sha256.clone(),
            );
        }
        if files.len() != digests.len() || files.keys().ne(digests.keys()) {
            return Err("asset source leases and digest inventory differ".into());
        }
        let plan = self.bundle_plan()?;
        let plan_sha256 = Sha256::digest(serde_json::to_vec(&plan).map_err(|e| e.to_string())?)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        if anchor["plan_sha256"] != plan_sha256 {
            return Err("creation stamp plan binding differs".into());
        }
        let objects = plan.objects();
        let stamps = objects
            .iter()
            .enumerate()
            .map(|(index, object)| {
                use crate::frontend_creation_stamp::{CreationKind, CreationStamp};
                let kind = match object.kind.as_str() {
                    "directory" => CreationKind::Directory,
                    "file" => CreationKind::File,
                    "alias" => CreationKind::Alias,
                    _ => return Err("creation stamp object kind invalid".into()),
                };
                Ok((
                    object.path.clone(),
                    CreationStamp::new(fixture, index, kind, &inventory_sha256, &plan_sha256)?,
                ))
            })
            .collect::<Result<BTreeMap<_, _>, String>>()?;
        Ok(AssetCopier {
            source: self,
            files,
            digests,
            aliases: objects
                .iter()
                .filter(|object| object.target.is_some())
                .map(|object| (object.path.clone(), object.target.clone().unwrap()))
                .collect(),
            directories: objects
                .iter()
                .filter(|object| object.kind == "directory")
                .map(|object| object.path.clone())
                .collect(),
            root: parent.join("frontend-dependencies"),
            volume: info.dwVolumeSerialNumber,
            parent_identity: crate::frontend_bundle_journal::ObjectIdentity {
                volume: info.dwVolumeSerialNumber,
                file_id: ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
            },
            _parent: held,
            file_parents: std::cell::RefCell::default(),
            stamps,
        })
    }
    /// Derives both bindings from the retained inventory. Native callers must
    /// keep this inventory alive during copying and publish into protected
    /// storage; an externally supplied digest is not accepted by this adapter.
    pub fn prepare_bundle_journal(
        &self,
        fixture_id: uuid::Uuid,
        parent: crate::frontend_bundle_journal::ObjectIdentity,
        publish_new: impl FnMut(usize, &[u8]) -> Result<(), String>,
    ) -> Result<crate::frontend_bundle_journal::BundleJournal, String> {
        let plan = self.bundle_plan()?;
        let inventory_sha256 = Sha256::digest(serde_json::to_vec(self).map_err(|e| e.to_string())?)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        crate::frontend_bundle_journal::BundleJournal::prepare(
            &plan,
            fixture_id,
            parent,
            &inventory_sha256,
            publish_new,
        )
    }
    pub fn bundle_plan(&self) -> Result<crate::frontend_bundle_plan::BundlePlan, String> {
        self._bundle_plan
            .get_or_init(|| self.build_bundle_plan())
            .clone()
    }
    fn build_bundle_plan(&self) -> Result<crate::frontend_bundle_plan::BundlePlan, String> {
        let root = self
            .graph
            .store()
            .parent()
            .ok_or("dependency source root missing")?;
        let files: Vec<_> = self
            .assets
            .iter()
            .map(|asset| asset.identity.path.clone())
            .collect();
        let aliases: Vec<_> = self
            .entries
            .iter()
            .filter(|entry| entry.reparse_tag != 0)
            .map(|entry| (entry.path.clone(), entry.target.clone()))
            .collect();
        crate::frontend_bundle_plan::build(root, &self.directory_paths, &files, &aliases)
    }
    /// Binds a delivered record to this still-held inventory, including the
    /// complete graph, aliases and assets. A structurally valid subset fails.
    pub fn verify_delivery(&self, candidate: &[u8]) -> Result<(), String> {
        if candidate.len() > 64 * 1024 * 1024 {
            return Err("dependency delivery byte budget exceeded".into());
        }
        let candidate: serde_json::Value =
            serde_json::from_slice(candidate).map_err(|_| "dependency delivery JSON invalid")?;
        if candidate != serde_json::to_value(self).map_err(|e| e.to_string())? {
            return Err("dependency delivery differs from held complete inventory".into());
        }
        Ok(())
    }
    pub fn inspect_fixed() -> Result<Self, String> {
        let graph = DependencyGraph::inspect_fixed()?;
        if graph.required_unresolved() != 0 {
            return Err("required dependency unresolved".into());
        }
        let roots: BTreeSet<PathBuf> = graph.package_roots().into_iter().collect();
        let mut pending: Vec<_> = roots.iter().cloned().collect();
        let mut visited = BTreeSet::new();
        let mut assets = Vec::new();
        let mut files = Vec::new();
        let mut held = Vec::new();
        let mut entries = graph.entries().to_vec();
        let mut bytes = 0u64;
        while let Some(directory) = pending.pop() {
            if !visited.insert(directory.clone()) {
                continue;
            }
            if visited.len() > 16384 {
                return Err("dependency directory budget exceeded".into());
            }
            held.push(verify_retirement_object(&directory)?);
            for entry in std::fs::read_dir(&directory).map_err(|e| e.to_string())? {
                let path = entry.map_err(|e| e.to_string())?.path();
                if path.to_str().is_none() {
                    return Err("dependency asset path invalid".into());
                }
                let metadata = path.symlink_metadata().map_err(|e| e.to_string())?;
                if metadata.file_attributes() & 0x400 != 0 {
                    let target = resolve_recorded(&[path], graph.store(), &mut held, &mut entries)?
                        .ok_or("dependency alias disappeared")?;
                    if !roots.contains(&target) {
                        return Err("dependency alias target absent from package graph".into());
                    }
                } else if metadata.is_dir() {
                    pending.push(path);
                    if pending.len() > 16384 {
                        return Err("dependency pending directory budget exceeded".into());
                    }
                } else {
                    if assets.len() >= 65536 {
                        return Err("dependency asset count budget exceeded".into());
                    }
                    let lease = ToolImageLease::open_source(&path)?;
                    bytes = bytes
                        .checked_add(lease.identity.bytes)
                        .ok_or("dependency byte overflow")?;
                    if bytes > 2 * 1024 * 1024 * 1024 {
                        return Err("dependency aggregate byte budget exceeded".into());
                    }
                    let sha256 = Sha256::digest(lease.read_bytes()?)
                        .iter()
                        .map(|b| format!("{b:02x}"))
                        .collect();
                    assets.push(Asset {
                        identity: lease.identity.clone(),
                        sha256,
                        source_links: lease.source_link_count()?,
                    });
                    files.push(lease);
                }
            }
        }
        assets.sort_by(|a, b| a.identity.path.cmp(&b.identity.path));
        entries.sort_by(|a, b| a.path.cmp(&b.path));
        if entries
            .windows(2)
            .any(|pair| pair[0].path == pair[1].path && pair[0] != pair[1])
        {
            return Err("dependency alias identity changed between observations".into());
        }
        entries.dedup_by(|a, b| a.path == b.path);
        Ok(Self {version:2, scope:"borrowed installed package assets held read-only; owned links, copying, runtime closure and recovery pending", production:"unavailable", graph, assets, entries, directories:visited.len(), directory_paths:visited.into_iter().collect(), bytes, owned_copy_ready:false, _files:files, _directories:held, _bundle_plan:std::cell::OnceCell::new()})
    }
}
