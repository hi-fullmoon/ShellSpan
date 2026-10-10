//! Read-only installed pnpm metadata graph. Does not grant or copy dependencies.
use crate::{
    appcontainer_probe::{verify_retirement_object, win, Handle},
    fixed_tool::{ToolImageIdentity, ToolImageLease},
};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    ptr::{null, null_mut},
};
use windows_sys::Win32::{Foundation::*, Storage::FileSystem::*};

const NODE_BUDGET: usize = 2048;
const EDGE_BUDGET: usize = 32768;
const METADATA_BUDGET: u64 = 32 * 1024 * 1024;
#[derive(Serialize)]
struct Package {
    id: String,
    name: String,
    version: String,
    metadata: ToolImageIdentity,
    metadata_sha256: String,
}
#[derive(Serialize)]
struct Edge {
    from: String,
    requested: String,
    selector_sha256: String,
    optional: bool,
    target: Option<String>,
}
#[derive(Serialize)]
pub struct DependencyGraph {
    version: u32,
    scope: String,
    production: String,
    lock_sha256: String,
    packages: Vec<Package>,
    edges: Vec<Edge>,
    required_unresolved: usize,
    code_files_frozen: bool,
    metadata_bytes: u64,
    #[serde(skip)]
    _leases: Vec<ToolImageLease>,
    #[serde(skip)]
    _directories: Vec<Handle>,
    #[serde(skip)]
    entries: Vec<SourceEntry>,
    #[serde(skip)]
    store: PathBuf,
}
#[derive(Clone, PartialEq, Eq, Serialize)]
pub(crate) struct SourceEntry {
    pub path: PathBuf,
    pub volume: u32,
    pub file_index: u64,
    pub reparse_tag: u32,
    pub target: PathBuf,
    pub target_volume: u32,
    pub target_file_index: u64,
}
fn entry_identity(handle: HANDLE) -> Result<(u32, u64, u32), String> {
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    win(
        unsafe { GetFileInformationByHandle(handle, &mut info) },
        "dependency entry observation",
    )?;
    let mut tag = FILE_ATTRIBUTE_TAG_INFO::default();
    if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        win(
            unsafe {
                GetFileInformationByHandleEx(
                    handle,
                    FileAttributeTagInfo,
                    (&mut tag as *mut FILE_ATTRIBUTE_TAG_INFO).cast(),
                    std::mem::size_of_val(&tag) as u32,
                )
            },
            "dependency entry tag observation",
        )?;
    }
    Ok((
        info.dwVolumeSerialNumber,
        ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
        tag.ReparseTag,
    ))
}
fn hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
fn valid_name(name: &str) -> bool {
    let part = |value: &str| {
        !value.is_empty()
            && value.len() <= 214
            && !value.starts_with('.')
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    };
    if let Some(scoped) = name.strip_prefix('@') {
        scoped
            .split_once('/')
            .is_some_and(|(scope, name)| part(scope) && part(name))
    } else {
        part(name)
    }
}
fn declarations(json: &Value, root: bool) -> Result<BTreeMap<String, (String, bool)>, String> {
    let mut result = BTreeMap::new();
    let fields: &[&str] = if root {
        &[
            "dependencies",
            "devDependencies",
            "peerDependencies",
            "optionalDependencies",
        ]
    } else {
        &["dependencies", "peerDependencies", "optionalDependencies"]
    };
    for field in fields {
        if let Some(value) = json.get(*field) {
            let entries = value
                .as_object()
                .ok_or("package dependency declaration is not an object")?;
            if entries.len() > 512 {
                return Err("package dependency declaration budget exceeded".into());
            }
            for (name, selector) in entries {
                let selector = selector
                    .as_str()
                    .filter(|value| !value.is_empty() && value.len() <= 1024)
                    .ok_or("package dependency selector invalid")?;
                if !valid_name(name) {
                    return Err("package dependency name invalid".into());
                }
                let optional = *field == "optionalDependencies"
                    || *field == "peerDependencies"
                        && json["peerDependenciesMeta"][name]["optional"] == true;
                // An optional peer cannot weaken a required concrete dependency.
                if *field == "peerDependencies"
                    && optional
                    && result.get(name).is_some_and(|(_, optional)| !optional)
                {
                    continue;
                }
                result.insert(name.clone(), (selector.into(), optional));
            }
        }
    }
    Ok(result)
}
fn search_paths(from: &Path, node_modules: &Path, name: &str) -> Result<Vec<PathBuf>, String> {
    if !valid_name(name) || !from.starts_with(node_modules) {
        return Err("dependency lookup escaped fixed node_modules".into());
    }
    let mut paths = Vec::new();
    let mut current = Some(from);
    while let Some(directory) = current {
        if directory == node_modules {
            paths.push(directory.join(name));
            break;
        }
        if directory
            .file_name()
            .is_none_or(|name| name != "node_modules")
        {
            paths.push(directory.join("node_modules").join(name));
        }
        current = directory.parent();
    }
    Ok(paths)
}
fn hold_directory_entry(path: &Path) -> Result<Handle, String> {
    let wide: Vec<_> = path
        .to_str()
        .ok_or("dependency path invalid")?
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let raw = unsafe {
        CreateFileW(
            wide.as_ptr(),
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    };
    if raw == INVALID_HANDLE_VALUE {
        return Err(format!("hold dependency entry: Win32 {}", unsafe {
            GetLastError()
        }));
    }
    let held = Handle(raw);
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    win(
        unsafe { GetFileInformationByHandle(raw, &mut info) },
        "dependency entry identity",
    )?;
    if info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
        return Err("dependency entry is not a directory".into());
    }
    if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        let mut tag = FILE_ATTRIBUTE_TAG_INFO::default();
        win(
            unsafe {
                GetFileInformationByHandleEx(
                    raw,
                    FileAttributeTagInfo,
                    (&mut tag as *mut FILE_ATTRIBUTE_TAG_INFO).cast(),
                    std::mem::size_of_val(&tag) as u32,
                )
            },
            "dependency reparse tag",
        )?;
        // Only directory symlink/junction metadata is inspected. These source
        // entries are never adopted as owned fixture aliases.
        if !matches!(tag.ReparseTag, 0xa0000003 | 0xa000000c) {
            return Err("dependency reparse tag unsupported".into());
        }
    }
    Ok(held)
}
#[cfg(test)]
fn resolve(
    paths: &[PathBuf],
    store: &Path,
    held: &mut Vec<Handle>,
) -> Result<Option<PathBuf>, String> {
    resolve_recorded(paths, store, held, &mut Vec::new())
}
pub(crate) fn resolve_recorded(
    paths: &[PathBuf],
    store: &Path,
    held: &mut Vec<Handle>,
    entries: &mut Vec<SourceEntry>,
) -> Result<Option<PathBuf>, String> {
    for path in paths {
        match path.symlink_metadata() {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("dependency entry query failed: {error}")),
        }
        let entry = hold_directory_entry(path)?;
        let (volume, file_index, reparse_tag) = entry_identity(entry.0)?;
        held.push(entry);
        let target = std::fs::canonicalize(path)
            .map_err(|error| format!("dependency target query failed: {error}"))?;
        if !target.starts_with(store) || target == store {
            return Err("dependency target escaped fixed pnpm store".into());
        }
        let target_held = verify_retirement_object(&target)?;
        let (target_volume, target_file_index, _) = entry_identity(target_held.0)?;
        held.push(target_held);
        if std::fs::canonicalize(path).map_err(|e| e.to_string())? != target {
            return Err("dependency alias changed during inspection".into());
        }
        entries.push(SourceEntry {
            path: path.clone(),
            volume,
            file_index,
            reparse_tag,
            target: target.clone(),
            target_volume,
            target_file_index,
        });
        return Ok(Some(target));
    }
    Ok(None)
}
fn read_json(
    path: &Path,
    total: &mut u64,
    leases: &mut Vec<ToolImageLease>,
) -> Result<(Value, ToolImageIdentity, String), String> {
    let lease = ToolImageLease::open(path)?;
    if lease.identity.bytes > 512 * 1024 {
        return Err("package metadata byte budget exceeded".into());
    }
    *total = total
        .checked_add(lease.identity.bytes)
        .ok_or("dependency metadata byte overflow")?;
    if *total > METADATA_BUDGET {
        return Err("dependency metadata aggregate budget exceeded".into());
    }
    let bytes = lease.read_bytes()?;
    let json = serde_json::from_slice(&bytes)
        .map_err(|e| format!("package metadata JSON invalid: {e}"))?;
    let identity = lease.identity.clone();
    let digest = hash(&bytes);
    leases.push(lease);
    Ok((json, identity, digest))
}
impl DependencyGraph {
    pub(crate) fn required_unresolved(&self) -> usize {
        self.required_unresolved
    }
    pub(crate) fn package_roots(&self) -> Vec<PathBuf> {
        self.packages
            .iter()
            .filter_map(|package| package.metadata.path.parent().map(Path::to_path_buf))
            .collect()
    }
    pub(crate) fn store(&self) -> &Path {
        &self.store
    }
    pub(crate) fn entries(&self) -> &[SourceEntry] {
        &self.entries
    }
    pub fn inspect_fixed() -> Result<Self, String> {
        let workspace = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(Path::parent)
            .ok_or("fixed dependency workspace missing")?;
        let mut directories = vec![verify_retirement_object(workspace)?];
        let node_modules =
            std::fs::canonicalize(workspace.join("node_modules")).map_err(|e| e.to_string())?;
        let store = std::fs::canonicalize(workspace.join("node_modules/.pnpm"))
            .map_err(|e| e.to_string())?;
        // Do not allow the entire node_modules/store roots to redirect elsewhere.
        directories.push(verify_retirement_object(&workspace.join("node_modules"))?);
        directories.push(verify_retirement_object(
            &workspace.join("node_modules/.pnpm"),
        )?);
        let lock = ToolImageLease::open(&workspace.join("pnpm-lock.yaml"))?;
        if lock.identity.bytes > 4 * 1024 * 1024 {
            return Err("fixed lockfile exceeds budget".into());
        }
        let lock_sha256 = hash(&lock.read_bytes()?);
        let mut leases = vec![lock];
        let mut metadata_bytes = 0;
        let (root, _, _) = read_json(
            &workspace.join("package.json"),
            &mut metadata_bytes,
            &mut leases,
        )?;
        let mut pending = Vec::new();
        let mut edges = Vec::new();
        let mut seen = BTreeSet::new();
        let mut entries = Vec::new();
        for (name, (selector, optional)) in declarations(&root, true)? {
            let target = resolve_recorded(
                &[node_modules.join(&name)],
                &store,
                &mut directories,
                &mut entries,
            )?;
            let id = target.as_ref().map(|target| {
                target
                    .strip_prefix(&store)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/")
            });
            if let Some(target) = target {
                pending.push(target);
            }
            edges.push(Edge {
                from: "project".into(),
                requested: name,
                selector_sha256: hash(selector.as_bytes()),
                optional,
                target: id,
            });
        }
        // Include hoisted aliases for real undeclared-import compatibility,
        // rather than claiming declared edges alone form a runtime closure.
        let hoisted = store.join("node_modules");
        directories.push(verify_retirement_object(&hoisted)?);
        let mut hoisted_paths = Vec::new();
        let mut hoisted_entries = 0usize;
        for entry in std::fs::read_dir(&hoisted).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            hoisted_entries += 1;
            if hoisted_entries > NODE_BUDGET {
                return Err("hoisted entry budget exceeded".into());
            }
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| "hoisted dependency name invalid")?;
            if name == ".bin" {
                continue;
            }
            if name.starts_with('@') {
                directories.push(verify_retirement_object(&entry.path())?);
                for child in std::fs::read_dir(entry.path()).map_err(|e| e.to_string())? {
                    let child = child.map_err(|e| e.to_string())?;
                    hoisted_entries += 1;
                    if hoisted_entries > NODE_BUDGET {
                        return Err("hoisted entry budget exceeded".into());
                    }
                    let child_name = child
                        .file_name()
                        .into_string()
                        .map_err(|_| "hoisted dependency name invalid")?;
                    hoisted_paths.push((format!("{name}/{child_name}"), child.path()));
                }
            } else {
                hoisted_paths.push((name, entry.path()));
            }
            if hoisted_paths.len() > NODE_BUDGET {
                return Err("hoisted dependency budget exceeded".into());
            }
        }
        hoisted_paths.sort_by(|left, right| left.0.cmp(&right.0));
        for (name, path) in hoisted_paths {
            if !valid_name(&name) {
                return Err("hoisted dependency name invalid".into());
            }
            let target = resolve_recorded(&[path], &store, &mut directories, &mut entries)?
                .ok_or("hoisted dependency disappeared")?;
            let id = target
                .strip_prefix(&store)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            edges.push(Edge {
                from: "hoisted".into(),
                requested: name,
                selector_sha256: hash(b"installed hoist"),
                optional: false,
                target: Some(id),
            });
            pending.push(target);
        }
        let mut packages = Vec::new();
        while let Some(directory) = pending.pop() {
            if !seen.insert(directory.clone()) {
                continue;
            }
            if seen.len() > NODE_BUDGET {
                return Err("dependency node budget exceeded".into());
            }
            let id = directory
                .strip_prefix(&store)
                .map_err(|_| "dependency package escaped store")?
                .to_string_lossy()
                .replace('\\', "/");
            let (json, identity, metadata_sha256) = read_json(
                &directory.join("package.json"),
                &mut metadata_bytes,
                &mut leases,
            )?;
            let name = json["name"]
                .as_str()
                .filter(|name| valid_name(name))
                .ok_or("installed package name invalid")?
                .to_owned();
            let version = json["version"]
                .as_str()
                .filter(|version| !version.is_empty() && version.len() <= 128)
                .ok_or("installed package version invalid")?
                .to_owned();
            for (requested, (selector, optional)) in declarations(&json, false)? {
                if edges.len() >= EDGE_BUDGET {
                    return Err("dependency edge budget exceeded".into());
                }
                let target = resolve_recorded(
                    &search_paths(&directory, &node_modules, &requested)?,
                    &store,
                    &mut directories,
                    &mut entries,
                )?;
                let target_id = target.as_ref().map(|target| {
                    target
                        .strip_prefix(&store)
                        .unwrap()
                        .to_string_lossy()
                        .replace('\\', "/")
                });
                if let Some(target) = target {
                    pending.push(target);
                }
                edges.push(Edge {
                    from: id.clone(),
                    requested,
                    selector_sha256: hash(selector.as_bytes()),
                    optional,
                    target: target_id,
                });
            }
            packages.push(Package {
                id,
                name,
                version,
                metadata: identity,
                metadata_sha256,
            });
        }
        packages.sort_by(|left, right| left.id.cmp(&right.id));
        edges.sort_by(|left, right| {
            (&left.from, &left.requested).cmp(&(&right.from, &right.requested))
        });
        let required_unresolved = edges
            .iter()
            .filter(|edge| !edge.optional && edge.target.is_none())
            .count();
        Ok(Self { version:2, scope:"fixed installed declared and hoisted pnpm metadata graph; code inventory and alias retirement pending".into(), production:"unavailable".into(), lock_sha256, packages, edges, required_unresolved, code_files_frozen:false, metadata_bytes, _leases:leases, _directories:directories, entries, store })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn actual_resolution_refuses_external_targets_and_does_not_mutate_sources() {
        let root =
            std::env::temp_dir().join(format!("ShellSpan-dependency-{}", uuid::Uuid::new_v4()));
        let store = root.join("store");
        let inside = store.join("package");
        let outside = root.join("outside");
        std::fs::create_dir_all(&inside).unwrap();
        std::fs::create_dir(&outside).unwrap();
        let marker = outside.join("marker.txt");
        std::fs::write(&marker, b"owned inspection marker").unwrap();
        let canonical_store = std::fs::canonicalize(&store).unwrap();
        let mut held = Vec::new();
        assert!(resolve(&[outside], &canonical_store, &mut held)
            .unwrap_err()
            .contains("escaped fixed pnpm store"));
        assert_eq!(std::fs::read(&marker).unwrap(), b"owned inspection marker");
        assert_eq!(
            resolve(std::slice::from_ref(&inside), &canonical_store, &mut held).unwrap(),
            Some(std::fs::canonicalize(&inside).unwrap())
        );
        assert_eq!(
            resolve(&[root.join("absent")], &canonical_store, &mut held).unwrap(),
            None
        );
        drop(held);
        trash::delete(root).unwrap();
    }
    #[test]
    fn actual_installed_graph_records_optional_absence_without_claiming_code_freeze() {
        let graph: Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/design/evidence/windows-stage-a-2026-10-10-frontend-dependency-graph-r3.json")).trim_start_matches('\u{feff}')).unwrap();
        assert_eq!(graph["version"], 2);
        assert_eq!(graph["production"], "unavailable");
        assert_eq!(graph["code_files_frozen"], false);
        let packages = graph["packages"].as_array().unwrap();
        let edges = graph["edges"].as_array().unwrap();
        assert_eq!(packages.len(), 764);
        assert_eq!(edges.len(), 2119);
        let ids: BTreeSet<_> = packages
            .iter()
            .map(|package| package["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids.len(), packages.len());
        for edge in edges {
            assert!(valid_name(edge["requested"].as_str().unwrap()));
            assert!(edge.get("selector").is_none());
            assert_eq!(edge["selector_sha256"].as_str().unwrap().len(), 64);
            if let Some(target) = edge["target"].as_str() {
                assert!(ids.contains(target));
            } else {
                assert_eq!(edge["optional"], true);
            }
        }
        assert_eq!(graph["required_unresolved"], 0);
        assert!(edges
            .iter()
            .any(|edge| edge["optional"] == true && edge["target"].is_null()));
        assert!(packages
            .iter()
            .any(|package| package["name"] == "typescript" && package["version"] == "6.0.3"));
        let source: Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/design/evidence/windows-stage-a-2026-10-10-frontend-source-manifest.json")).trim_start_matches('\u{feff}')).unwrap();
        let lock = source["files"]
            .as_array()
            .unwrap()
            .iter()
            .find(|file| file["relative_path"] == "pnpm-lock.yaml")
            .unwrap();
        assert_eq!(graph["lock_sha256"], lock["sha256"]);
    }
    #[test]
    fn dependency_names_and_optional_precedence_are_bounded() {
        for name in ["typescript", "@types/node", "string-width-cjs"] {
            assert!(valid_name(name));
        }
        for name in [
            "../src",
            "@scope/../name",
            "name:stream",
            "name\\child",
            "@scope",
            "",
        ] {
            assert!(!valid_name(name));
        }
        let json = serde_json::json!({"dependencies":{"normal":"1","override":"2"},"optionalDependencies":{"override":"3"},"peerDependencies":{"peer":"4"},"peerDependenciesMeta":{"peer":{"optional":true}}});
        let map = declarations(&json, false).unwrap();
        assert_eq!(map["override"], ("3".into(), true));
        assert!(map["peer"].1);
        assert!(!map["normal"].1);
        assert!(declarations(&serde_json::json!({"dependencies":{"../bad":"1"}}), false).is_err());
        let overlap = serde_json::json!({"dependencies":{"required":"1"},"peerDependencies":{"required":"2"},"peerDependenciesMeta":{"required":{"optional":true}}});
        assert_eq!(
            declarations(&overlap, false).unwrap()["required"],
            ("1".into(), false)
        );
    }
    #[test]
    fn dependency_specifications_are_fingerprinted_without_emitting_url_content() {
        let specification = "git+https://owned-test-marker@invalid.example/project";
        let edge = Edge {
            from: "project".into(),
            requested: "fixture".into(),
            selector_sha256: hash(specification.as_bytes()),
            optional: false,
            target: None,
        };
        let delivery = serde_json::to_string(&edge).unwrap();
        assert!(!delivery.contains("owned-test-marker"));
        assert!(!delivery.contains("invalid.example"));
        assert!(!delivery.contains("git+https"));
    }
    #[test]
    fn lookup_stays_inside_fixed_node_modules_and_skips_double_nesting() {
        let root = Path::new(r"D:\owned\node_modules");
        let paths = search_paths(&root.join(r".pnpm\a@1\node_modules\a"), root, "b").unwrap();
        assert!(paths.iter().all(|path| path.starts_with(root)));
        assert!(paths.iter().all(|path| !path
            .to_string_lossy()
            .contains(r"node_modules\node_modules")));
        assert_eq!(paths.last().unwrap(), &root.join("b"));
        assert!(search_paths(Path::new(r"C:\outside"), root, "b").is_err());
    }
}
