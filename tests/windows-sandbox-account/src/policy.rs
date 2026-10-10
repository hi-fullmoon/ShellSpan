// File DELETE is granted only on ordinary objects; DELETE_CHILD is never granted.
// All ancestors of frozen secrets must be pinned against directory rename/delete.
pub const READ: u32 = 0x0012_0089;
pub const EXECUTE: u32 = 0x0012_00a9;
pub const WRITE: u32 = 0x0012_0116;
pub const DELETE: u32 = 0x0001_0000;
pub const DELETE_CHILD: u32 = 0x40;
pub const CHANGE_ACL: u32 = 0x000c_0000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Object {
    OrdinaryFile,
    OrdinaryDirectory,
    PinnedDirectory,
    Secret,
    RootEnvLocal,
    Rules,
    RulesDirectory,
    External,
}
pub fn access(workspace: bool, object: Object) -> u32 {
    match object {
        Object::Secret | Object::External => 0,
        Object::RootEnvLocal | Object::Rules => READ,
        Object::RulesDirectory => EXECUTE,
        Object::OrdinaryFile if workspace => READ | WRITE | DELETE,
        Object::OrdinaryDirectory if workspace => EXECUTE | WRITE | DELETE,
        Object::PinnedDirectory if workspace => EXECUTE | WRITE,
        Object::OrdinaryDirectory | Object::PinnedDirectory => EXECUTE,
        Object::OrdinaryFile => READ,
    }
}

pub(crate) fn reserved_device_component(part: &str) -> bool {
    let stem = part
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL") {
        return true;
    }
    ["COM", "LPT"].iter().any(|prefix| {
        stem.strip_prefix(prefix).is_some_and(|suffix| {
            matches!(
                suffix,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
    })
}
pub fn classify_project_object(
    relative: &str,
    directory: bool,
    independently_sensitive: bool,
    protected_rules: bool,
) -> Result<Object, String> {
    if relative.is_empty()
        || relative.encode_utf16().count() > 32767
        || relative.contains([':', '\0'])
        || relative.starts_with(['/', '\\'])
    {
        return Err("invalid frozen project-relative path".into());
    }
    let parts: Vec<_> = relative.split(['/', '\\']).collect();
    if parts.iter().any(|part| {
        part.is_empty()
            || *part == "."
            || *part == ".."
            || part.ends_with([' ', '.'])
            || reserved_device_component(part)
            || part
                .chars()
                .any(|ch| ch < ' ' || matches!(ch, '<' | '>' | '"' | '|' | '?' | '*'))
    }) {
        return Err("ambiguous frozen Windows path component".into());
    }
    if independently_sensitive {
        return Ok(Object::Secret);
    }
    if parts.iter().any(|part| {
        let folded = part.to_ascii_lowercase();
        folded == ".env" || folded.starts_with(".env.")
    }) {
        if parts.len() == 1 && !directory && parts[0].eq_ignore_ascii_case(".env.local") {
            return Ok(Object::RootEnvLocal);
        }
        return Ok(Object::Secret);
    }
    if protected_rules || parts.iter().any(|part| part.eq_ignore_ascii_case(".git")) {
        return Ok(if directory {
            Object::RulesDirectory
        } else {
            Object::Rules
        });
    }
    Ok(if directory {
        Object::OrdinaryDirectory
    } else {
        Object::OrdinaryFile
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FrozenIdentity {
    pub volume: u32,
    pub file_index: u64,
    pub bytes: u64,
    pub directory: bool,
}
pub(crate) fn windows_name_equal(left: &str, right: &str) -> Result<bool, String> {
    use windows_sys::Win32::Globalization::{CompareStringOrdinal, CSTR_EQUAL};
    if left.is_empty() || right.is_empty() {
        return Ok(left.is_empty() && right.is_empty());
    }
    let left: Vec<u16> = left.encode_utf16().collect();
    let right: Vec<u16> = right.encode_utf16().collect();
    if left.len() > 32767 || right.len() > 32767 {
        return Err("Windows name comparison budget exceeded".into());
    }
    let result = unsafe {
        CompareStringOrdinal(
            left.as_ptr(),
            left.len() as i32,
            right.as_ptr(),
            right.len() as i32,
            1,
        )
    };
    if result == 0 {
        return Err("native Windows name comparison failed".into());
    }
    Ok(result == CSTR_EQUAL)
}
#[derive(Clone, Default)]
pub struct FrozenRules {
    sensitive: Vec<String>,
    protected: Vec<String>,
}
impl FrozenRules {
    pub fn new(sensitive: &[&str], protected: &[&str]) -> Result<Self, String> {
        if sensitive.len() + protected.len() > 256 {
            return Err("frozen rules budget exceeded".into());
        }
        let mut units = 0usize;
        for path in sensitive.iter().chain(protected) {
            units = units
                .checked_add(path.encode_utf16().count())
                .ok_or("frozen rule input size overflow")?;
            if units > 65536 {
                return Err("frozen rule input length budget exceeded".into());
            }
        }
        let normalize = |paths: &[&str]| -> Result<Vec<String>, String> {
            let mut result: Vec<String> = Vec::new();
            for path in paths {
                classify_project_object(path, false, false, false)?;
                let normalized = path.replace('\\', "/");
                for existing in &result {
                    if windows_name_equal(existing, &normalized)? {
                        return Err("duplicate frozen rule target".into());
                    }
                }
                result.push(normalized);
            }
            Ok(result)
        };
        Ok(Self {
            sensitive: normalize(sensitive)?,
            protected: normalize(protected)?,
        })
    }
    fn covers(paths: &[String], relative: &str) -> Result<bool, String> {
        for target in paths {
            let prefix = relative
                .split('/')
                .take(target.split('/').count())
                .collect::<Vec<_>>()
                .join("/");
            if windows_name_equal(target, &prefix)? {
                return Ok(true);
            }
        }
        Ok(false)
    }
}
#[derive(Default)]
struct SnapshotUniqueness {
    paths: Vec<String>,
    objects: std::collections::BTreeSet<(u32, u64)>,
}
impl SnapshotUniqueness {
    fn insert(&mut self, relative: &str, identity: FrozenIdentity) -> Result<(), String> {
        for path in &self.paths {
            if windows_name_equal(path, relative)? {
                return Err("ambiguous case-equivalent project inventory path".into());
            }
        }
        self.paths.push(relative.to_owned());
        if !self.objects.insert((identity.volume, identity.file_index)) {
            return Err("duplicate stable project object identity".into());
        }
        Ok(())
    }
}
pub struct FrozenProject {
    root: std::path::PathBuf,
    rules: FrozenRules,
    pub entries: std::collections::BTreeMap<String, Object>,
    pub identities: std::collections::BTreeMap<String, FrozenIdentity>,
    _leases: Vec<(String, std::fs::File)>,
    _ancestor_leases: Vec<std::fs::File>,
}
impl FrozenProject {
    pub fn verify_unchanged(&self) -> Result<(), String> {
        let observed = freeze_owned_project_with_rules(&self.root, &self.rules)?;
        if observed.entries != self.entries || observed.identities != self.identities {
            return Err("frozen project inventory or object identity changed".into());
        }
        Ok(())
    }
    pub fn retain_protected_leases(&mut self) {
        self._leases.retain(|(path, _)| {
            path.is_empty()
                || self.entries.get(path).is_some_and(|object| {
                    matches!(
                        object,
                        Object::Secret
                            | Object::RootEnvLocal
                            | Object::Rules
                            | Object::RulesDirectory
                            | Object::PinnedDirectory
                    )
                })
        });
    }
}
#[cfg(test)]
pub fn freeze_owned_project(root: &std::path::Path) -> Result<FrozenProject, String> {
    freeze_owned_project_with_rules(root, &FrozenRules::default())
}
fn reject_home_object(root: FrozenIdentity, home: &std::path::Path) -> Result<(), String> {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::*;
    // Resolve the trusted current HOME path to its actual directory object;
    // metadata alone, with a different spelling, is not an exclusion boundary.
    let file = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(home)
        .map_err(|e| format!("current HOME identity unavailable: {e}"))?;
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    if unsafe { GetFileInformationByHandle(file.as_raw_handle().cast(), &mut info) } == 0
        || info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
    {
        return Err("current HOME directory identity unavailable".into());
    }
    let object = (
        info.dwVolumeSerialNumber,
        (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
    );
    if (root.volume, root.file_index) == object {
        return Err("whole user HOME object refused".into());
    }
    Ok(())
}
fn local_project_root(
    root: &std::path::Path,
    home: Option<&std::path::Path>,
) -> Result<String, String> {
    use std::path::{Component, Prefix};
    let mut components = root.components();
    let drive = match components.next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::Disk(drive) | Prefix::VerbatimDisk(drive) => drive,
            _ => return Err("project root must be a local drive path".into()),
        },
        _ => return Err("project root must be a local drive path".into()),
    };
    if components.next() != Some(Component::RootDir) {
        return Err("project root must be absolute".into());
    }
    let rest: Vec<_> = components.collect();
    if rest.is_empty()
        || rest
            .iter()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("drive root or ambiguous project root refused".into());
    }
    let normalize = |path: &std::path::Path| {
        let value = path.to_string_lossy().replace('/', "\\");
        value
            .strip_prefix(r"\\?\")
            .unwrap_or(&value)
            .trim_end_matches('\\')
            .to_ascii_lowercase()
    };
    if home.is_some_and(|home| normalize(root) == normalize(home)) {
        return Err("whole user HOME project root refused".into());
    }
    Ok(format!("{}:\\", char::from(drive)))
}
fn freeze_project_ancestors(
    root: &std::path::Path,
    deadline: std::time::Instant,
) -> Result<Vec<std::fs::File>, String> {
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    use windows_sys::Win32::Storage::FileSystem::*;
    let mut ancestors: Vec<_> = root
        .parent()
        .ok_or("project parent missing")?
        .ancestors()
        .collect();
    if ancestors.len() > 64 {
        return Err("project ancestor budget exceeded".into());
    }
    ancestors.reverse();
    let mut leases = Vec::new();
    for ancestor in ancestors {
        if std::time::Instant::now() >= deadline {
            return Err("project ancestor time budget exceeded".into());
        }
        let file = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(ancestor)
            .map_err(|e| format!("project ancestor unavailable: {e}"))?;
        let metadata = file.metadata().map_err(|e| e.to_string())?;
        if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err("project reparse or non-directory ancestor refused".into());
        }
        leases.push(file);
    }
    Ok(leases)
}
pub fn freeze_owned_project_with_rules(
    root: &std::path::Path,
    rules: &FrozenRules,
) -> Result<FrozenProject, String> {
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_SHARE_READ, FILE_SHARE_WRITE,
    };
    let home = std::env::var_os("USERPROFILE").map(std::path::PathBuf::from);
    let drive_root = local_project_root(root, home.as_deref())?;
    let drive_root: Vec<u16> = drive_root.encode_utf16().chain(Some(0)).collect();
    let drive_type =
        unsafe { windows_sys::Win32::Storage::FileSystem::GetDriveTypeW(drive_root.as_ptr()) };
    if !matches!(drive_type, 2 | 3 | 6) {
        return Err("network or unverified project drive refused".into());
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    let ancestor_leases = freeze_project_ancestors(root, deadline)?;
    let mut queue = vec![(root.to_path_buf(), String::new())];
    let mut entries = std::collections::BTreeMap::new();
    let mut identities = std::collections::BTreeMap::new();
    let mut root_volume = None;
    let mut uniqueness = SnapshotUniqueness::default();
    let mut leases = Vec::new();
    while let Some((path, relative)) = queue.pop() {
        if leases.len() >= 256 || std::time::Instant::now() >= deadline {
            return Err("project snapshot node/time budget exceeded".into());
        }
        let file = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(&path)
            .map_err(|error| format!("project snapshot open failed: {error}"))?;
        let metadata = file.metadata().map_err(|e| e.to_string())?;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
            || (!metadata.is_file() && !metadata.is_dir())
        {
            return Err("project snapshot alias or unsupported object".into());
        }
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        if unsafe { GetFileInformationByHandle(file.as_raw_handle().cast(), &mut info) } == 0 {
            return Err("project snapshot identity unavailable".into());
        }
        if !metadata.is_dir() && info.nNumberOfLinks != 1 {
            return Err("project snapshot hardlink alias refused".into());
        }
        if root_volume.is_some_and(|volume| volume != info.dwVolumeSerialNumber) {
            return Err("project snapshot crossed frozen volume".into());
        }
        root_volume.get_or_insert(info.dwVolumeSerialNumber);
        let identity = FrozenIdentity {
            volume: info.dwVolumeSerialNumber,
            file_index: (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
            bytes: (u64::from(info.nFileSizeHigh) << 32) | u64::from(info.nFileSizeLow),
            directory: metadata.is_dir(),
        };
        uniqueness.insert(&relative, identity)?;
        if relative.is_empty() {
            reject_home_object(
                identity,
                home.as_deref().ok_or("current HOME binding unavailable")?,
            )?;
            let mut filesystem = [0u16; 32];
            if unsafe {
                windows_sys::Win32::Storage::FileSystem::GetVolumeInformationByHandleW(
                    file.as_raw_handle().cast(),
                    std::ptr::null_mut(),
                    0,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    filesystem.as_mut_ptr(),
                    filesystem.len() as u32,
                )
            } == 0
            {
                return Err("project volume filesystem unavailable".into());
            }
            let end = filesystem
                .iter()
                .position(|ch| *ch == 0)
                .ok_or("project filesystem name exceeded budget")?;
            if String::from_utf16(&filesystem[..end]).map_err(|e| e.to_string())? != "NTFS" {
                return Err("project volume requires NTFS".into());
            }
        }
        if identities.insert(relative.clone(), identity).is_some() {
            return Err("duplicate frozen object identity path".into());
        }
        if relative.is_empty() && !metadata.is_dir() {
            return Err("project snapshot root must be directory".into());
        }
        if !relative.is_empty() {
            let object = classify_project_object(
                &relative,
                metadata.is_dir(),
                FrozenRules::covers(&rules.sensitive, &relative)?,
                FrozenRules::covers(&rules.protected, &relative)?,
            )?;
            if entries.insert(relative.clone(), object).is_some() {
                return Err("duplicate project snapshot path".into());
            }
        }
        if metadata.is_dir() {
            for entry in std::fs::read_dir(&path).map_err(|e| e.to_string())? {
                if queue.len() + leases.len() >= 256 || std::time::Instant::now() >= deadline {
                    return Err("project snapshot node/time budget exceeded".into());
                }
                let entry = entry.map_err(|e| e.to_string())?;
                let name = entry
                    .file_name()
                    .into_string()
                    .map_err(|_| "project snapshot invalid Unicode")?;
                let next = if relative.is_empty() {
                    name
                } else {
                    format!("{relative}/{name}")
                };
                queue.push((entry.path(), next));
            }
        }
        leases.push((relative, file));
    }
    for target in rules.sensitive.iter().chain(&rules.protected) {
        let mut found = false;
        for path in entries.keys() {
            if windows_name_equal(path, target)? {
                found = true;
                break;
            }
        }
        if !found {
            return Err("frozen rule target absent from project inventory".into());
        }
    }
    let protected: Vec<_> = entries
        .iter()
        .filter(|(_, object)| {
            matches!(
                object,
                Object::Secret | Object::RootEnvLocal | Object::Rules | Object::RulesDirectory
            )
        })
        .map(|(path, _)| path.clone())
        .collect();
    for path in protected {
        let mut parent = path.as_str();
        while let Some((ancestor, _)) = parent.rsplit_once('/') {
            if entries.get(ancestor) == Some(&Object::OrdinaryDirectory) {
                entries.insert(ancestor.to_owned(), Object::PinnedDirectory);
            }
            parent = ancestor;
        }
    }
    Ok(FrozenProject {
        root: root.to_path_buf(),
        rules: rules.clone(),
        entries,
        identities,
        _leases: leases,
        _ancestor_leases: ancestor_leases,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rules_bound_total_utf16_input_before_native_comparison() {
        let first = "a".repeat(32767);
        let second = "b".repeat(32767);
        assert!(FrozenRules::new(&[&first, &second], &["ccc"])
            .err()
            .unwrap()
            .contains("length budget"));
    }
    #[test]
    #[ignore = "requires NTFS per-directory case sensitivity support"]
    fn actual_case_sensitive_inventory_refuses_distinct_case_equivalent_objects() {
        use std::os::windows::fs::OpenOptionsExt;
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::*;
        let root =
            std::env::temp_dir().join(format!("ShellSpan-case-sensitive-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let result = (|| -> Result<(), String> {
            let file = std::fs::OpenOptions::new()
                .access_mode(FILE_WRITE_ATTRIBUTES | FILE_READ_ATTRIBUTES)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
                .open(&root)
                .map_err(|e| e.to_string())?;
            let info = FILE_CASE_SENSITIVE_INFO { Flags: 1 };
            if unsafe {
                SetFileInformationByHandle(
                    file.as_raw_handle().cast(),
                    FileCaseSensitiveInfo,
                    (&info as *const FILE_CASE_SENSITIVE_INFO).cast(),
                    std::mem::size_of_val(&info) as u32,
                )
            } == 0
            {
                return Err(format!(
                    "owned directory case sensitivity unsupported: {}",
                    std::io::Error::last_os_error()
                ));
            }
            let mut observed = FILE_CASE_SENSITIVE_INFO::default();
            if unsafe {
                GetFileInformationByHandleEx(
                    file.as_raw_handle().cast(),
                    FileCaseSensitiveInfo,
                    (&mut observed as *mut FILE_CASE_SENSITIVE_INFO).cast(),
                    std::mem::size_of_val(&observed) as u32,
                )
            } == 0
                || observed.Flags & 1 == 0
            {
                return Err("owned directory case-sensitive flag unconfirmed".into());
            }
            drop(file);
            let mut identities = std::collections::BTreeSet::new();
            for name in ["secret.txt", "SECRET.TXT"] {
                let object = std::fs::OpenOptions::new()
                    .read(true)
                    .write(true)
                    .create_new(true)
                    .open(root.join(name))
                    .map_err(|e| e.to_string())?;
                let mut info = BY_HANDLE_FILE_INFORMATION::default();
                if unsafe { GetFileInformationByHandle(object.as_raw_handle().cast(), &mut info) }
                    == 0
                {
                    return Err("case-sensitive object identity unavailable".into());
                }
                identities.insert((
                    info.dwVolumeSerialNumber,
                    info.nFileIndexHigh,
                    info.nFileIndexLow,
                ));
            }
            if identities.len() != 2 {
                return Err("case-sensitive objects lack distinct native identities".into());
            }
            if std::fs::read_dir(&root).map_err(|e| e.to_string())?.count() != 2 {
                return Err("distinct case-sensitive objects missing".into());
            }
            let rejected = freeze_owned_project(&root)
                .err()
                .ok_or("case-equivalent inventory unexpectedly accepted")?;
            if !rejected.contains("case-equivalent") {
                return Err(rejected);
            }
            Ok(())
        })();
        trash::delete(&root).unwrap();
        assert!(result.is_ok(), "{}", result.unwrap_err());
    }
    #[test]
    fn native_unicode_case_matching_preserves_sensitive_rule_boundaries() {
        assert!(windows_name_equal("Ä/Σ.txt", "ä/σ.TXT").unwrap());
        let rules = FrozenRules::new(&["Ä"], &[]).unwrap();
        assert!(FrozenRules::covers(&rules.sensitive, "ä/child.txt").unwrap());
        assert!(!FrozenRules::covers(&rules.sensitive, "ä-other/child.txt").unwrap());
        assert!(FrozenRules::new(&["Ä", "ä"], &[]).is_err());
        let identity = FrozenIdentity {
            volume: 1,
            file_index: 2,
            bytes: 0,
            directory: false,
        };
        let mut inventory = SnapshotUniqueness::default();
        inventory.insert("Ä.txt", identity).unwrap();
        assert!(inventory
            .insert(
                "ä.TXT",
                FrozenIdentity {
                    file_index: 3,
                    ..identity
                }
            )
            .is_err());
        assert!(windows_name_equal(&"a".repeat(32768), "a").is_err());
        let root =
            std::env::temp_dir().join(format!("ShellSpan-unicode-rule-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(root.join("Ä")).unwrap();
        std::fs::write(root.join("Ä/Σ.txt"), b"fixed unicode fixture").unwrap();
        let rules = FrozenRules::new(&["ä"], &[]).unwrap();
        let snapshot = freeze_owned_project_with_rules(&root, &rules).unwrap();
        assert_eq!(snapshot.entries["Ä/Σ.txt"], Object::Secret);
        snapshot.verify_unchanged().unwrap();
        drop(snapshot);
        trash::delete(root).unwrap();
    }
    #[test]
    fn home_exclusion_compares_real_directory_identity_and_rejects_unknown_binding() {
        let root =
            std::env::temp_dir().join(format!("ShellSpan-home-identity-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(root.join("project")).unwrap();
        let snapshot = freeze_owned_project(&root).unwrap();
        assert!(reject_home_object(snapshot.identities[""], &root)
            .unwrap_err()
            .contains("HOME object"));
        reject_home_object(snapshot.identities[""], &root.join("project")).unwrap();
        assert!(
            reject_home_object(snapshot.identities[""], &root.join("missing"))
                .unwrap_err()
                .contains("unavailable")
        );
        drop(snapshot);
        trash::delete(root).unwrap();
    }
    #[test]
    fn project_root_rejects_network_drive_root_and_whole_home_before_scanning() {
        let home = std::path::Path::new(r"C:\Users\fixture");
        for value in [
            r"\\server\share\project",
            r"C:\",
            r"C:relative",
            r"C:\Users\fixture",
            r"C:\project\..\other",
        ] {
            assert!(
                local_project_root(std::path::Path::new(value), Some(home)).is_err(),
                "{value}"
            );
        }
        assert_eq!(
            local_project_root(
                std::path::Path::new(r"C:\Users\fixture\project"),
                Some(home)
            )
            .unwrap(),
            r"C:\"
        );
    }
    #[test]
    fn inventory_rejects_case_equivalent_paths_and_duplicate_native_objects() {
        let first = FrozenIdentity {
            volume: 7,
            file_index: 11,
            bytes: 3,
            directory: false,
        };
        let second = FrozenIdentity {
            file_index: 12,
            ..first
        };
        let mut inventory = SnapshotUniqueness::default();
        inventory.insert("nested/secret.txt", first).unwrap();
        assert!(inventory
            .insert("NESTED/SECRET.TXT", second)
            .unwrap_err()
            .contains("case-equivalent"));
        let mut inventory = SnapshotUniqueness::default();
        inventory.insert("nested/secret.txt", first).unwrap();
        assert!(inventory
            .insert("ordinary.txt", first)
            .unwrap_err()
            .contains("object identity"));
        let mut inventory = SnapshotUniqueness::default();
        inventory.insert("nested/secret.txt", first).unwrap();
        inventory.insert("nested/secret.txt.other", second).unwrap();
        assert!(
            !FrozenRules::covers(&["nested/secret.txt".into()], "nested/secret.txt.other").unwrap()
        );
    }
    #[test]
    fn concurrent_host_cannot_move_protected_objects_while_ordinary_objects_remain_mutable() {
        let root = std::env::temp_dir().join(format!(
            "ShellSpan-concurrent-pins-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(root.join("private")).unwrap();
        std::fs::write(root.join("private/key.txt"), b"fixed fixture").unwrap();
        std::fs::write(root.join("ordinary.txt"), b"fixed ordinary").unwrap();
        let rules = FrozenRules::new(&["private/key.txt"], &[]).unwrap();
        let mut snapshot = freeze_owned_project_with_rules(&root, &rules).unwrap();
        snapshot.retain_protected_leases();
        let worker_root = root.clone();
        std::thread::spawn(move || {
            assert_eq!(
                std::fs::rename(
                    worker_root.join("private/key.txt"),
                    worker_root.join("leak.txt")
                )
                .unwrap_err()
                .raw_os_error(),
                Some(32)
            );
            assert_eq!(
                std::fs::rename(
                    worker_root.join("private"),
                    worker_root.join("moved-private")
                )
                .unwrap_err()
                .raw_os_error(),
                Some(32)
            );
            std::fs::rename(
                worker_root.join("ordinary.txt"),
                worker_root.join("moved.txt"),
            )
            .unwrap();
            std::fs::remove_file(worker_root.join("moved.txt")).unwrap();
        })
        .join()
        .unwrap();
        assert_eq!(
            std::fs::read(root.join("private/key.txt")).unwrap(),
            b"fixed fixture"
        );
        drop(snapshot);
        std::fs::rename(root.join("private"), root.join("retired-private")).unwrap();
        trash::delete(root).unwrap();
    }
    #[test]
    fn independent_rules_are_frozen_and_revalidated_with_the_inventory() {
        let root =
            std::env::temp_dir().join(format!("ShellSpan-rule-snapshot-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(root.join("private")).unwrap();
        std::fs::write(root.join("private/key.txt"), b"fixture").unwrap();
        std::fs::write(root.join(".env.local"), b"fixture").unwrap();
        std::fs::write(root.join("rules.json"), b"fixture").unwrap();
        std::fs::create_dir(root.join("policy-dir")).unwrap();
        std::fs::write(root.join("policy-dir/config.txt"), b"fixture").unwrap();
        let rules =
            FrozenRules::new(&[".ENV.LOCAL", "PRIVATE"], &["rules.json", "policy-dir"]).unwrap();
        let snapshot = freeze_owned_project_with_rules(&root, &rules).unwrap();
        assert_eq!(snapshot.entries[".env.local"], Object::Secret);
        assert_eq!(snapshot.entries["private/key.txt"], Object::Secret);
        assert_eq!(snapshot.entries["rules.json"], Object::Rules);
        assert_eq!(snapshot.entries["policy-dir"], Object::RulesDirectory);
        assert_eq!(snapshot.entries["policy-dir/config.txt"], Object::Rules);
        assert_eq!(access(true, snapshot.entries[".env.local"]), 0);
        snapshot.verify_unchanged().unwrap();
        drop(snapshot);
        let missing = FrozenRules::new(&["missing.txt"], &[]).unwrap();
        assert!(freeze_owned_project_with_rules(&root, &missing)
            .err()
            .unwrap()
            .contains("absent"));
        assert!(FrozenRules::new(&["../secret"], &[]).is_err());
        assert!(FrozenRules::new(&["private", "PRIVATE"], &[]).is_err());
        trash::delete(root).unwrap();
    }
    #[test]
    fn snapshot_revalidation_rejects_added_secrets_and_changed_object_lengths() {
        let root = std::env::temp_dir().join(format!(
            "ShellSpan-snapshot-recheck-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("ordinary.txt"), b"fixture").unwrap();
        let snapshot = freeze_owned_project(&root).unwrap();
        snapshot.verify_unchanged().unwrap();
        std::fs::write(root.join("ordinary.txt"), b"changed fixture length").unwrap();
        assert!(snapshot.verify_unchanged().unwrap_err().contains("changed"));
        drop(snapshot);
        let snapshot = freeze_owned_project(&root).unwrap();
        std::fs::write(root.join(".env.new"), b"new fixed sensitive fixture").unwrap();
        assert!(snapshot.verify_unchanged().unwrap_err().contains("changed"));
        drop(snapshot);
        let snapshot = freeze_owned_project(&root).unwrap();
        assert_eq!(snapshot.entries[".env.new"], Object::Secret);
        snapshot.verify_unchanged().unwrap();
        drop(snapshot);
        trash::delete(root).unwrap();
    }
    #[test]
    fn execution_pins_only_protected_objects_and_their_ancestors() {
        let root =
            std::env::temp_dir().join(format!("ShellSpan-snapshot-pins-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(root.join("nested")).unwrap();
        std::fs::create_dir(root.join("output")).unwrap();
        std::fs::write(root.join("nested/.env.secret"), b"fixture").unwrap();
        std::fs::write(root.join("ordinary.txt"), b"fixture").unwrap();
        let mut snapshot = freeze_owned_project(&root).unwrap();
        assert_eq!(snapshot.entries["nested"], Object::PinnedDirectory);
        assert_eq!(snapshot.entries["output"], Object::OrdinaryDirectory);
        snapshot.retain_protected_leases();
        std::fs::rename(root.join("ordinary.txt"), root.join("renamed.txt")).unwrap();
        std::fs::rename(root.join("output"), root.join("renamed-output")).unwrap();
        assert!(std::fs::rename(root.join("nested"), root.join("moved-secret-parent")).is_err());
        assert!(std::fs::rename(root.join("nested/.env.secret"), root.join("leaked.txt")).is_err());
        drop(snapshot);
        trash::delete(root).unwrap();
    }
    #[test]
    fn fixed_build_source_readonly_rule_pins_bytes_until_execution_ends() {
        let root =
            std::env::temp_dir().join(format!("ShellSpan-source-pins-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let source = root.join("fixed-build.cs");
        std::fs::write(&source, crate::fixed_tool::FIXED_BUILD_SOURCE).unwrap();
        let content_lease = crate::fixed_tool::open_fixed_build_source(&root).unwrap();
        let rules = FrozenRules::new(&[], &["fixed-build.cs"]).unwrap();
        let mut snapshot = freeze_owned_project_with_rules(&root, &rules).unwrap();
        assert_eq!(snapshot.entries["fixed-build.cs"], Object::Rules);
        snapshot.retain_protected_leases();
        assert_eq!(
            std::fs::read(&source).unwrap(),
            crate::fixed_tool::FIXED_BUILD_SOURCE.as_bytes()
        );
        assert!(std::fs::OpenOptions::new()
            .write(true)
            .open(&source)
            .is_err());
        assert!(std::fs::rename(&source, root.join("replaced.cs")).is_err());
        snapshot.verify_unchanged().unwrap();
        drop(snapshot);
        drop(content_lease);
        std::fs::OpenOptions::new()
            .write(true)
            .open(&source)
            .unwrap();
        trash::delete(root).unwrap();
    }
    #[test]
    fn actual_snapshot_binds_stable_identity_and_refuses_hardlinked_secret() {
        let root = std::env::temp_dir().join(format!(
            "ShellSpan-snapshot-identity-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&root).unwrap();
        let secret = root.join(".env.secret");
        std::fs::write(&secret, b"fixed fixture").unwrap();
        let snapshot = freeze_owned_project(&root).unwrap();
        let first = snapshot.identities[".env.secret"];
        assert_eq!(first.bytes, 13);
        assert_eq!(first.volume, snapshot.identities[""].volume);
        assert!(!first.directory);
        drop(snapshot);
        assert_eq!(
            freeze_owned_project(&root).unwrap().identities[".env.secret"],
            first
        );
        std::fs::hard_link(&secret, root.join("ordinary.txt")).unwrap();
        assert!(freeze_owned_project(&root)
            .err()
            .unwrap()
            .contains("hardlink"));
        trash::delete(root).unwrap();
    }
    #[test]
    fn actual_project_snapshot_covers_names_and_refuses_partial_budget() {
        let root = std::env::temp_dir().join(format!(
            "ShellSpan-policy-snapshot-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(root.join("nested")).unwrap();
        std::fs::write(root.join(".ENV.LOCAL"), b"fixture").unwrap();
        std::fs::write(root.join("nested/.env.secret"), b"fixture").unwrap();
        let frozen = freeze_owned_project(&root).unwrap();
        assert_eq!(frozen.entries[".ENV.LOCAL"], Object::RootEnvLocal);
        assert_eq!(frozen.entries["nested/.env.secret"], Object::Secret);
        assert!(std::fs::rename(root.join("nested"), root.join("replacement")).is_err());
        std::fs::write(
            root.join(".ENV.LOCAL"),
            b"host fixture write while names pinned",
        )
        .unwrap();
        drop(frozen);
        for index in 0..256 {
            std::fs::write(root.join(format!("ordinary-{index}.txt")), b"fixture").unwrap();
        }
        assert!(freeze_owned_project(&root)
            .err()
            .unwrap()
            .contains("budget"));
        trash::delete(root).unwrap();
    }
    #[test]
    fn sensitive_env_names_win_over_rules_and_devices_never_become_files() {
        for path in [".git/.env", ".git/nested/.env.production"] {
            assert_eq!(
                classify_project_object(path, false, false, true).unwrap(),
                Object::Secret
            );
        }
        for path in [
            "NUL.txt",
            "con",
            "nested/COM¹.log",
            "LPT9",
            "a?b",
            "a*b",
            "a|b",
            "a\"b",
            "a<b",
            "a>b",
            "a\u{1f}b",
        ] {
            assert!(
                classify_project_object(path, false, false, false).is_err(),
                "{path}"
            );
        }
        for path in [
            "COM10.txt",
            "LPT0.txt",
            "console.txt",
            "normal/中文文件.txt",
        ] {
            assert!(
                classify_project_object(path, false, false, false).is_ok(),
                "{path}"
            );
        }
    }
    #[test]
    fn frozen_windows_env_exception_never_overrides_independent_sensitivity() {
        assert_eq!(
            classify_project_object(".ENV.LOCAL", false, false, false).unwrap(),
            Object::RootEnvLocal
        );
        assert_eq!(
            classify_project_object(".env.local", false, true, false).unwrap(),
            Object::Secret
        );
        assert_eq!(
            classify_project_object(".env.local", true, false, false).unwrap(),
            Object::Secret
        );
        for path in [
            "nested/.env.local",
            "nested\\.ENV.secret",
            ".env",
            ".env.secret/child",
        ] {
            assert_eq!(
                classify_project_object(path, false, false, false).unwrap(),
                Object::Secret
            );
        }
        assert_eq!(
            classify_project_object(".GiT/config", false, false, false).unwrap(),
            Object::Rules
        );
        assert_eq!(
            classify_project_object("rules.json", false, false, true).unwrap(),
            Object::Rules
        );
        for path in [
            "",
            "../secret",
            "a//b",
            "C:secret",
            "file:stream",
            "a./b",
            "a /b",
            "\\server\\file",
        ] {
            assert!(
                classify_project_object(path, false, false, false).is_err(),
                "{path}"
            );
        }
    }
    #[test]
    fn rules_directories_allow_readonly_traversal_without_workspace_mutation() {
        for path in [".git", ".git/objects", "custom-rules"] {
            let object = classify_project_object(path, true, false, true).unwrap();
            assert_eq!(object, Object::RulesDirectory);
            for workspace in [false, true] {
                let mask = access(workspace, object);
                assert_ne!(mask & 0x20, 0, "directory traversal required");
                assert_eq!(mask & (0x116 | DELETE | DELETE_CHILD | CHANGE_ACL), 0);
            }
        }
        assert_eq!(
            classify_project_object(".git/.env", true, false, true).unwrap(),
            Object::Secret
        );
    }
    #[test]
    fn rights_preserve_sensitive_objects_and_ancestors() {
        for workspace in [false, true] {
            for object in [
                Object::OrdinaryFile,
                Object::OrdinaryDirectory,
                Object::PinnedDirectory,
                Object::Secret,
                Object::RootEnvLocal,
                Object::Rules,
                Object::RulesDirectory,
                Object::External,
            ] {
                assert_eq!(access(workspace, object) & (DELETE_CHILD | CHANGE_ACL), 0);
            }
            assert_eq!(access(workspace, Object::Secret), 0);
            assert_eq!(access(workspace, Object::External), 0);
            assert_eq!(
                access(workspace, Object::RootEnvLocal) & (0x116 | DELETE),
                0
            );
            assert_eq!(access(false, Object::OrdinaryFile) & (0x116 | DELETE), 0);
            assert_eq!(access(workspace, Object::PinnedDirectory) & DELETE, 0);
        }
        assert_ne!(access(true, Object::OrdinaryFile) & DELETE, 0);
        assert_eq!(access(false, Object::OrdinaryFile) & DELETE, 0);
    }
}
