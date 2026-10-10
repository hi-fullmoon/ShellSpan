//! Destination namespace only. Creation, ACL grants and journal are separate.
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    path::{Component, Path, PathBuf},
};

#[derive(Clone, Serialize)]
pub struct BundlePlan {
    version: u32,
    directories: Vec<String>,
    files: Vec<String>,
    aliases: Vec<Alias>,
    retirement_objects: usize,
    creation_ready: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DecodedPlan {
    version: u32,
    directories: Vec<String>,
    files: Vec<String>,
    aliases: Vec<Alias>,
    retirement_objects: usize,
    creation_ready: bool,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Alias {
    path: String,
    target: String,
}
#[derive(Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PlannedObject {
    pub path: String,
    pub kind: String,
    pub target: Option<String>,
}
impl BundlePlan {
    /// Compose frozen source and dependency plans into one ordinary project.
    /// No paths are caller selected; dependency aliases remain inside node_modules.
    /// This is a plan only, not permission to create or launch anything.
    pub fn compose_project(source: &Self, dependencies: &Self) -> Result<Self, String> {
        let root = Path::new(r"C:\ShellSpan-project-plan");
        let mut directories: Vec<_> = source.directories.iter().map(|p| root.join(p)).collect();
        directories.push(root.join("node_modules"));
        directories.extend(
            dependencies
                .directories
                .iter()
                .map(|p| root.join("node_modules").join(p)),
        );
        let mut files: Vec<_> = source.files.iter().map(|p| root.join(p)).collect();
        files.extend(
            dependencies
                .files
                .iter()
                .map(|p| root.join("node_modules").join(p)),
        );
        if !source.aliases.is_empty() {
            return Err("project source aliases are forbidden".into());
        }
        let aliases: Vec<_> = dependencies
            .aliases
            .iter()
            .map(|a| {
                (
                    root.join("node_modules").join(&a.path),
                    root.join("node_modules").join(&a.target),
                )
            })
            .collect();
        build(root, &directories, &files, &aliases)
    }
    pub fn retirement_object_count(&self) -> usize {
        self.retirement_objects
    }
    /// Only a protected native anchor can supply the expected digest. This
    /// validates a plan without requiring the original source tree to exist.
    pub fn read_bound(bytes: &[u8], expected_sha256: &str) -> Result<Self, String> {
        use sha2::{Digest, Sha256};
        if bytes.len() > 16 * 1024 * 1024 {
            return Err("bundle recovery plan byte budget exceeded".into());
        }
        let digest = Sha256::digest(bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        if digest != expected_sha256 {
            return Err("bundle recovery plan digest differs".into());
        }
        let decoded: DecodedPlan =
            serde_json::from_slice(bytes).map_err(|_| "bundle recovery plan JSON invalid")?;
        let plan = Self {
            version: decoded.version,
            directories: decoded.directories,
            files: decoded.files,
            aliases: decoded.aliases,
            retirement_objects: decoded.retirement_objects,
            creation_ready: decoded.creation_ready,
        };
        if plan.files.len() + plan.directories.len() + plan.aliases.len() > 99999 {
            return Err("bundle recovery plan object budget exceeded".into());
        }
        let root = Path::new(r"C:\ShellSpan-plan-validation");
        let directories: Vec<_> = plan.directories.iter().map(|p| root.join(p)).collect();
        let files: Vec<_> = plan.files.iter().map(|p| root.join(p)).collect();
        let aliases: Vec<_> = plan
            .aliases
            .iter()
            .map(|a| (root.join(&a.path), root.join(&a.target)))
            .collect();
        let rebuilt = build(root, &directories, &files, &aliases)?;
        if serde_json::to_value(&rebuilt).map_err(|e| e.to_string())?
            != serde_json::to_value(&plan).map_err(|e| e.to_string())?
        {
            return Err("bundle recovery plan scope or canonical inventory differs".into());
        }
        Ok(plan)
    }
    pub(crate) fn objects(&self) -> Vec<PlannedObject> {
        let mut objects = vec![PlannedObject {
            path: String::new(),
            kind: "directory".into(),
            target: None,
        }];
        objects.extend(self.directories.iter().map(|path| PlannedObject {
            path: path.clone(),
            kind: "directory".into(),
            target: None,
        }));
        objects.extend(self.files.iter().map(|path| PlannedObject {
            path: path.clone(),
            kind: "file".into(),
            target: None,
        }));
        objects.extend(self.aliases.iter().map(|alias| PlannedObject {
            path: alias.path.clone(),
            kind: "alias".into(),
            target: Some(alias.target.clone()),
        }));
        objects
    }
}
fn ordinary(path: &Path) -> Result<PathBuf, String> {
    let text = path.to_str().ok_or("bundle path is not Unicode")?;
    if text.starts_with(r"\\?\UNC\") {
        return Err("bundle source is not local".into());
    }
    Ok(PathBuf::from(text.strip_prefix(r"\\?\").unwrap_or(text)))
}
pub(crate) fn project_relative(root: &Path, path: &Path) -> Result<String, String> {
    relative(&ordinary(root)?, path)
}
fn relative(root: &Path, path: &Path) -> Result<String, String> {
    let path = ordinary(path)?;
    let path = path
        .strip_prefix(root)
        .map_err(|_| "bundle input escaped source namespace")?;
    let mut parts = Vec::new();
    for part in path.components() {
        let Component::Normal(part) = part else {
            return Err("bundle path component invalid".into());
        };
        let part = part.to_str().ok_or("bundle component is not Unicode")?;
        if part.contains(':')
            || part.ends_with(['.', ' '])
            || crate::policy::reserved_device_component(part)
            || part
                .chars()
                .any(|ch| ch < ' ' || matches!(ch, '<' | '>' | '"' | '|' | '?' | '*'))
        {
            return Err("bundle path alias invalid".into());
        }
        parts.push(part);
    }
    if parts.is_empty() {
        return Err("bundle input is source root".into());
    }
    let relative = parts.join("/");
    if relative.encode_utf16().count() > 32767 {
        return Err("bundle relative path budget exceeded".into());
    }
    Ok(relative)
}
pub(crate) fn build(
    root: &Path,
    directories: &[PathBuf],
    files: &[PathBuf],
    aliases: &[(PathBuf, PathBuf)],
) -> Result<BundlePlan, String> {
    let root = ordinary(root)?;
    let mut namespace = BTreeMap::<String, (String, u8)>::new();
    let mut insert = |path: String, kind: u8| -> Result<(), String> {
        let key = path.clone();
        if let Some((previous, previous_kind)) = namespace.get(&key) {
            if previous != &path || *previous_kind != kind {
                return Err("bundle namespace collision".into());
            }
        } else {
            namespace.insert(key, (path, kind));
        }
        Ok(())
    };
    let file_paths: Vec<_> = files
        .iter()
        .map(|p| relative(&root, p))
        .collect::<Result<_, _>>()?;
    let directory_paths: Vec<_> = directories
        .iter()
        .map(|p| relative(&root, p))
        .collect::<Result<_, _>>()?;
    let alias_paths: Vec<_> = aliases
        .iter()
        .map(|(p, t)| {
            Ok(Alias {
                path: relative(&root, p)?,
                target: relative(&root, t)?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    for path in &directory_paths {
        insert(path.clone(), 0)?;
    }
    for path in &file_paths {
        insert(path.clone(), 1)?;
    }
    for alias in &alias_paths {
        insert(alias.path.clone(), 2)?;
    }
    // Every parent belongs to the new namespace. A parent cannot be a file or
    // alias; later creation never walks a link to reach another destination.
    let initial: Vec<_> = namespace.values().map(|(path, _)| path.clone()).collect();
    for path in initial {
        let mut parent = path.rsplit_once('/').map(|(parent, _)| parent);
        while let Some(value) = parent {
            let key = value.to_owned();
            if namespace
                .get(&key)
                .is_some_and(|(p, k)| p != value || *k != 0)
            {
                return Err("bundle parent is not a regular directory".into());
            }
            namespace.entry(key).or_insert((value.into(), 0));
            parent = value.rsplit_once('/').map(|(parent, _)| parent);
        }
    }
    for alias in &alias_paths {
        if !namespace
            .get(&alias.target)
            .is_some_and(|(p, k)| p == &alias.target && *k == 0)
        {
            return Err("bundle alias target is not a planned directory".into());
        }
    }
    let mut siblings = BTreeMap::<String, Vec<String>>::new();
    for (path, _) in namespace.values() {
        let (parent, name) = path.rsplit_once('/').unwrap_or(("", path));
        let names = siblings.entry(parent.into()).or_default();
        for previous in names.iter() {
            if crate::policy::windows_name_equal(previous, name)? {
                return Err("bundle native Windows name collision".into());
            }
        }
        names.push(name.into());
    }
    if namespace.len() >= 100000 {
        return Err("bundle recovery object budget exceeded".into());
    }
    let mut directories: Vec<_> = namespace
        .values()
        .filter(|(_, k)| *k == 0)
        .map(|(p, _)| p.clone())
        .collect();
    // Presentation order only; namespace equality uses native comparison.
    directories.sort_by_cached_key(|path| path.to_lowercase());
    let mut aliases = alias_paths;
    aliases.sort_by(|a, b| a.path.cmp(&b.path));
    if aliases
        .windows(2)
        .any(|pair| pair[0].path == pair[1].path && pair[0].target != pair[1].target)
    {
        return Err("bundle alias has conflicting targets".into());
    }
    aliases.dedup_by(|a, b| a.path == b.path);
    let mut files = file_paths;
    files.sort();
    files.dedup();
    Ok(BundlePlan {
        version: 1,
        directories,
        files,
        aliases,
        retirement_objects: namespace.len() + 1,
        creation_ready: false,
    })
}
#[cfg(test)]
mod tests {
    #[test]
    fn project_composition_preserves_source_and_internal_dependency_aliases() {
        use super::*;
        let root = Path::new(r"C:\frozen");
        let source = build(
            root,
            &[],
            &[root.join("package.json"), root.join("src/main.ts")],
            &[],
        )
        .unwrap();
        let dependencies = build(
            root,
            &[root.join(".pnpm/pkg")],
            &[root.join(".pnpm/pkg/index.js")],
            &[(root.join("pkg"), root.join(".pnpm/pkg"))],
        )
        .unwrap();
        let combined = BundlePlan::compose_project(&source, &dependencies).unwrap();
        assert!(combined.files.contains(&"src/main.ts".into()));
        assert!(combined
            .files
            .contains(&"node_modules/.pnpm/pkg/index.js".into()));
        assert_eq!(combined.aliases[0].path, "node_modules/pkg");
        assert_eq!(combined.aliases[0].target, "node_modules/.pnpm/pkg");
        assert_eq!(
            combined.retirement_object_count(),
            source.retirement_object_count() + dependencies.retirement_object_count()
        );
        let colliding = build(root, &[], &[root.join("node_modules/pkg")], &[]).unwrap();
        assert!(BundlePlan::compose_project(&colliding, &dependencies).is_err());
        let alias_source = build(
            root,
            &[root.join("src")],
            &[],
            &[(root.join("linked"), root.join("src"))],
        )
        .unwrap();
        assert!(BundlePlan::compose_project(&alias_source, &dependencies).is_err());
    }
    use super::*;
    #[test]
    fn bound_recovery_plan_rebuilds_without_source_and_rejects_escaped_or_forged_scope() {
        use sha2::{Digest, Sha256};
        let root = Path::new(r"D:\absent-source\node_modules");
        let plan = build(
            root,
            &[root.join("store")],
            &[root.join("store/file.js")],
            &[(root.join("pkg"), root.join("store"))],
        )
        .unwrap();
        let bytes = serde_json::to_vec(&plan).unwrap();
        let digest = |bytes: &[u8]| {
            Sha256::digest(bytes)
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        };
        BundlePlan::read_bound(&bytes, &digest(&bytes)).unwrap();
        assert!(BundlePlan::read_bound(&bytes, &"0".repeat(64)).is_err());
        for (key, value) in [
            ("files", serde_json::json!(["../outside"])),
            ("creation_ready", serde_json::json!(true)),
            ("version", serde_json::json!(2)),
            ("retirement_objects", serde_json::json!(1)),
            ("unknown", serde_json::json!(true)),
            ("files", serde_json::json!(["NUL.txt"])),
            ("files", serde_json::json!(["name\u{0}truncated"])),
            ("files", serde_json::json!(["name*wildcard"])),
        ] {
            let mut changed = serde_json::to_value(&plan).unwrap();
            changed[key] = value;
            let bytes = serde_json::to_vec(&changed).unwrap();
            assert!(
                BundlePlan::read_bound(&bytes, &digest(&bytes)).is_err(),
                "accepted changed {key}"
            );
        }
    }
    #[test]
    fn preserves_store_and_alias_layout_with_all_parents_budgeted() {
        let root = Path::new(r"D:\repo\node_modules");
        let package = root.join(r".pnpm\pkg\node_modules\pkg");
        let plan = build(
            root,
            std::slice::from_ref(&package),
            &[package.join("index.js")],
            &[(root.join("pkg"), package.clone())],
        )
        .unwrap();
        assert_eq!(plan.files, [".pnpm/pkg/node_modules/pkg/index.js"]);
        assert_eq!(plan.aliases[0].target, ".pnpm/pkg/node_modules/pkg");
        assert_eq!(plan.directories.len(), 4);
        assert_eq!(plan.retirement_objects, 7);
        assert!(!plan.creation_ready);
    }
    #[test]
    fn refuses_escape_case_collision_missing_target_and_link_parent() {
        let root = Path::new(r"D:\repo\node_modules");
        assert!(build(root, &[], &[PathBuf::from(r"D:\outside\file")], &[]).is_err());
        assert!(build(root, &[], &[root.join("A.js"), root.join("a.js")], &[]).is_err());
        assert!(build(root, &[], &[], &[(root.join("pkg"), root.join("missing"))]).is_err());
        assert!(build(
            root,
            &[root.join("real")],
            &[root.join(r"pkg\file")],
            &[(root.join("pkg"), root.join("real"))]
        )
        .is_err());
        assert!(build(root, &[], &[root.join(r"pkg\..\escape")], &[]).is_err());
        assert!(!crate::policy::windows_name_equal("σ.js", "ς.js").unwrap());
        assert!(build(root, &[], &[root.join("σ.js"), root.join("ς.js")], &[]).is_ok());
        assert!(crate::policy::windows_name_equal("Å.js", "å.js").unwrap());
        assert!(build(root, &[], &[root.join("Å.js"), root.join("å.js")], &[]).is_err());
        assert!(build(root, &[], &[root.join("asset.js:stream")], &[]).is_err());
        assert!(build(
            root,
            &[root.join("real"), root.join("other")],
            &[],
            &[
                (root.join("pkg"), root.join("real")),
                (root.join("pkg"), root.join("other"))
            ]
        )
        .is_err());
    }
    #[test]
    fn real_complete_inventory_replays_the_measured_destination_plan() {
        let evidence = Path::new(env!("CARGO_MANIFEST_DIR")).join(
            "../../docs/design/evidence/windows-stage-a-2026-10-10-frontend-bundle-plan.json",
        );
        let record: serde_json::Value =
            serde_json::from_slice(&std::fs::read(evidence).unwrap()).unwrap();
        let inventory = &record["inventory"];
        let paths = |value: &serde_json::Value| {
            value
                .as_array()
                .unwrap()
                .iter()
                .map(|v| PathBuf::from(v.as_str().unwrap()))
                .collect::<Vec<_>>()
        };
        let directories = paths(&inventory["directory_paths"]);
        let files: Vec<_> = inventory["assets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| PathBuf::from(v["identity"]["path"].as_str().unwrap()))
            .collect();
        let aliases: Vec<_> = inventory["entries"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|v| v["reparse_tag"].as_u64().unwrap() != 0)
            .map(|v| {
                (
                    PathBuf::from(v["path"].as_str().unwrap()),
                    PathBuf::from(v["target"].as_str().unwrap()),
                )
            })
            .collect();
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("node_modules");
        let plan = build(&root, &directories, &files, &aliases).unwrap();
        assert!(
            serde_json::to_value(&plan).unwrap() == record["plan"],
            "complete measured destination plan differs"
        );
        assert_eq!(plan.files.len(), 35432);
        assert_eq!(plan.directories.len(), 5840);
        assert_eq!(plan.aliases.len(), 2017);
        assert_eq!(plan.retirement_objects, 43290);
        let bytes: u64 = inventory["assets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v["identity"]["bytes"].as_u64().unwrap())
            .sum();
        assert_eq!(bytes, 554959479);
        assert_eq!(inventory["bytes"].as_u64().unwrap(), bytes);
        assert!(inventory["assets"].as_array().unwrap().iter().all(|asset| {
            asset["identity"]["file_index"].as_u64().unwrap() != 0
                && asset["source_links"].as_u64().unwrap() > 0
                && asset["sha256"].as_str().is_some_and(|digest| {
                    digest.len() == 64 && digest.bytes().all(|b| b.is_ascii_hexdigit())
                })
        }));
        let original = Path::new(env!("CARGO_MANIFEST_DIR")).join(
            "../../docs/design/evidence/windows-stage-a-2026-10-10-frontend-runtime-inventory.json",
        );
        let original: serde_json::Value =
            serde_json::from_slice(&std::fs::read(original).unwrap()).unwrap();
        assert!(
            inventory["assets"] == original["assets"],
            "dependency asset identities or digests changed between measured scans"
        );
        assert!(
            inventory["entries"] == original["entries"],
            "dependency aliases changed between measured scans"
        );
    }
}
