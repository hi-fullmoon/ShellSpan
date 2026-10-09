//! Fixed flat PowerShell engine runtime, not modules or privileged setup.
use crate::appcontainer_probe::{win, Handle};
use crate::fixed_tool::{FixedTool, ToolImageIdentity, ToolImageLease};
use serde::Serialize;
use std::collections::BTreeSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::ptr::{null, null_mut};
use windows_sys::Win32::{Foundation::*, Storage::FileSystem::*};
const FILE_BUDGET: usize = 480;
const BYTE_BUDGET: u64 = 320 * 1024 * 1024;
#[derive(Serialize)]
pub struct RuntimeFile {
    source: ToolImageIdentity,
    destination: ToolImageIdentity,
}
pub struct PowerShellRuntime {
    _directory: Handle,
    _reference_directories: Vec<Handle>,
    _sources: Vec<ToolImageLease>,
    copies: Vec<ToolImageLease>,
    pub files: Vec<RuntimeFile>,
    pub bytes: u64,
}
fn inventory(directory: &Path) -> Result<BTreeSet<String>, String> {
    let mut names = BTreeSet::new();
    let mut visited = 0;
    for entry in std::fs::read_dir(directory).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        visited += 1;
        if visited > 512 {
            return Err("fixed runtime source inventory budget exceeded".into());
        }
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "invalid runtime basename")?;
        if name == "pwsh.exe"
            || name == "pwsh.deps.json"
            || name == "pwsh.runtimeconfig.json"
            || crate::pe_imports::valid_dll_basename(&name.to_ascii_lowercase())
        {
            let metadata = entry.path().symlink_metadata().map_err(|e| e.to_string())?;
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return Err("runtime asset is not a regular source file".into());
            }
            names.insert(name);
        }
    }
    if names.len() > FILE_BUDGET
        || ![
            "pwsh.exe",
            "pwsh.dll",
            "pwsh.deps.json",
            "pwsh.runtimeconfig.json",
            "hostfxr.dll",
            "hostpolicy.dll",
            "coreclr.dll",
        ]
        .iter()
        .all(|name| names.contains(*name))
    {
        return Err("fixed runtime assets incomplete or excessive".into());
    }
    Ok(names)
}
impl PowerShellRuntime {
    pub fn image(&self) -> PathBuf {
        self.copies
            .iter()
            .find(|copy| {
                copy.identity
                    .path
                    .file_name()
                    .is_some_and(|name| name == "pwsh.exe")
            })
            .expect("validated runtime includes pwsh.exe")
            .identity
            .path
            .clone()
    }
    pub fn prepare(root: &Path, user: &str, package: &str) -> Result<Self, String> {
        Self::prepare_inner(root, user, package, false)
    }
    pub fn prepare_build(root: &Path, user: &str, package: &str) -> Result<Self, String> {
        Self::prepare_inner(root, user, package, true)
    }
    fn prepare_inner(
        root: &Path,
        user: &str,
        package: &str,
        references: bool,
    ) -> Result<Self, String> {
        let id = root
            .file_name()
            .and_then(|v| v.to_str())
            .and_then(|v| v.strip_prefix("ShellSpan-AC-"))
            .and_then(|v| uuid::Uuid::parse_str(v).ok());
        if !root.is_absolute() || id.is_none_or(|id| id.is_nil()) {
            return Err("runtime requires freshly owned UUID fixture".into());
        }
        let _root = crate::appcontainer_probe::verify_retirement_object(root)?;
        let mut root_information = BY_HANDLE_FILE_INFORMATION::default();
        win(
            unsafe { GetFileInformationByHandle(_root.0, &mut root_information) },
            "freeze runtime destination root",
        )?;
        let executable = FixedTool::PowerShell7.image()?;
        let directory = executable
            .parent()
            .ok_or("runtime source directory missing")?;
        let wide: Vec<_> = directory
            .to_str()
            .ok_or("invalid source directory")?
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let held = Handle(unsafe {
            CreateFileW(
                wide.as_ptr(),
                FILE_READ_DATA | FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                null_mut(),
            )
        });
        if held.0 == INVALID_HANDLE_VALUE {
            return Err("hold fixed runtime source directory failed".into());
        }
        let mut information = BY_HANDLE_FILE_INFORMATION::default();
        win(
            unsafe { GetFileInformationByHandle(held.0, &mut information) },
            "runtime source directory identity",
        )?;
        if information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
            || information.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
        {
            return Err("runtime source directory alias rejected".into());
        }
        let names = inventory(directory)?;
        let mut reference_directories = Vec::new();
        let reference_root = directory.join("ref");
        let reference_names = if references {
            reference_directories.push(hold_reference_source(&reference_root)?);
            reference_inventory(&reference_root)?
        } else {
            BTreeSet::new()
        };
        if names.len() + reference_names.len() > FILE_BUDGET {
            return Err("combined runtime file budget exceeded".into());
        }
        let mut sources = Vec::new();
        let mut bytes = 0u64;
        for path in names
            .iter()
            .map(|name| directory.join(name))
            .chain(reference_names.iter().map(|name| reference_root.join(name)))
        {
            let source = ToolImageLease::open(&path)?;
            bytes = bytes
                .checked_add(source.identity.bytes)
                .ok_or("runtime size overflow")?;
            if bytes > BYTE_BUDGET {
                return Err("runtime exceeds 320 MiB budget".into());
            }
            sources.push(source);
        }
        if inventory(directory)? != names {
            return Err("runtime source inventory changed".into());
        }
        let plan = serde_json::json!({"version":1,"root":root,"user":user,"package":package,
            "root_identity":{"volume":root_information.dwVolumeSerialNumber,"file_index":((root_information.nFileIndexHigh as u64)<<32)|root_information.nFileIndexLow as u64},
            "file_budget":FILE_BUDGET,"byte_budget":BYTE_BUDGET,"bytes":bytes,
            "source_directory":{"volume":information.dwVolumeSerialNumber,"file_index":((information.nFileIndexHigh as u64)<<32)|information.nFileIndexLow as u64},
            "sources":sources.iter().map(|source| &source.identity).collect::<Vec<_>>(),
            "reference_names":reference_names,
            "scope":"fixed engine DLLs/manifests and optional bounded ref DLLs; arbitrary modules/resources not accepted"});
        let serialized = serde_json::to_vec(&plan).map_err(|e| e.to_string())?;
        if serialized.len() > 128 * 1024 {
            return Err("runtime intent exceeds 128 KiB".into());
        }
        let mut manifest = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(root.join("powershell-runtime-intent.json"))
            .map_err(|e| e.to_string())?;
        manifest.write_all(&serialized).map_err(|e| e.to_string())?;
        manifest.sync_all().map_err(|e| e.to_string())?;
        drop(manifest);
        if references {
            std::fs::create_dir(root.join("ref")).map_err(|e| e.to_string())?;
            crate::appcontainer_probe::set_owned_dacl(
                &root.join("ref"),
                &format!("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;{user})"),
            )?;
            reference_directories.push(crate::appcontainer_probe::verify_retirement_object(
                &root.join("ref"),
            )?);
        }
        let mut copies = Vec::new();
        let mut files = Vec::new();
        for source in &sources {
            let name = source
                .identity
                .path
                .file_name()
                .and_then(|v| v.to_str())
                .ok_or("invalid runtime file")?;
            let destination = if source.identity.path.parent() == Some(reference_root.as_path()) {
                root.join("ref")
            } else {
                root.to_path_buf()
            };
            let copy = source.copy_new_owned(&destination, name)?;
            files.push(RuntimeFile {
                source: source.identity.clone(),
                destination: copy.identity.clone(),
            });
            copies.push(copy);
        }
        if inventory(directory)? != names {
            return Err("runtime source changed during copy".into());
        }
        if references && reference_inventory(&reference_root)? != reference_names {
            return Err("reference inventory changed during copy".into());
        }
        let completed = serde_json::to_vec(
            &serde_json::json!({"version":1,"root_identity":plan["root_identity"],"files":files}),
        )
        .map_err(|e| e.to_string())?;
        if completed.len() > 256 * 1024 {
            return Err("runtime completion manifest exceeds 256 KiB".into());
        }
        publish_copies_before_grants(root, &completed, || {
            if references {
                crate::appcontainer_probe::set_owned_dacl(
                    &root.join("ref"),
                    &format!("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;{user})(A;;FRFX;;;{package})"),
                )?;
            }
            for copy in &copies {
                copy.grant_owned_execution(user, package)?;
            }
            Ok(())
        })?;
        Ok(Self {
            _directory: held,
            _reference_directories: reference_directories,
            _sources: sources,
            copies,
            files,
            bytes,
        })
    }
}
fn reference_inventory(root: &Path) -> Result<BTreeSet<String>, String> {
    let mut names = BTreeSet::new();
    for entry in std::fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "invalid reference name")?;
        if !crate::pe_imports::valid_dll_basename(&name)
            || !entry.file_type().map_err(|e| e.to_string())?.is_file()
            || !names.insert(name)
            || names.len() > 192
        {
            return Err("reference inventory type or budget rejected".into());
        }
    }
    if !names.contains("System.Runtime.dll") || !names.contains("netstandard.dll") {
        return Err("reference inventory incomplete".into());
    }
    Ok(names)
}
fn hold_reference_source(path: &Path) -> Result<Handle, String> {
    let wide: Vec<_> = path
        .to_str()
        .ok_or("invalid reference directory")?
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let raw = unsafe {
        CreateFileW(
            wide.as_ptr(),
            FILE_READ_DATA | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    };
    if raw == INVALID_HANDLE_VALUE {
        return Err("reference source directory lease unavailable".into());
    }
    let held = Handle(raw);
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    win(
        unsafe { GetFileInformationByHandle(held.0, &mut info) },
        "reference source identity",
    )?;
    if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
    {
        return Err("reference source directory alias rejected".into());
    }
    Ok(held)
}
fn publish_copies_before_grants(
    root: &Path,
    completed: &[u8],
    grant: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    if completed.len() > 256 * 1024 {
        return Err("runtime completion manifest exceeds 256 KiB".into());
    }
    let mut receipt = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(root.join("powershell-runtime-copies.json"))
        .map_err(|e| e.to_string())?;
    receipt.write_all(completed).map_err(|e| e.to_string())?;
    receipt.sync_all().map_err(|e| e.to_string())?;
    drop(receipt);
    grant()
}
/// One fixed ordinary-user recovery for the first runtime trial; no input paths.
pub fn retire_first_runtime_debt() -> Result<serde_json::Value, String> {
    use crate::appcontainer_probe::{query, sid_text, Fixture};
    use windows_sys::Win32::Security::{Authorization::*, Isolation::*, *};
    use windows_sys::Win32::System::{Registry::*, Threading::*};
    let root = Path::new(
        r"C:\Users\ZHENGB~1\AppData\Local\Temp\ShellSpan-AC-3e4ba36e536a4419bd2bd1fecd8d8695",
    );
    let package =
        "S-1-15-2-12792318-3200849225-1124070403-1824150328-1663754005-135841814-1366678663";
    let profile = "ShellSpan-candidate-dc055dabb94848de9e222053bd4b04e2";
    let mut raw = null_mut();
    if unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 1, &mut raw) } != 0 {
        unsafe {
            CloseHandle(raw);
        }
        return Err("fixed runtime recovery refuses thread impersonation".into());
    }
    if unsafe { GetLastError() } != ERROR_NO_TOKEN {
        return Err("fixed runtime recovery thread context unavailable".into());
    }
    win(
        unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) },
        "fixed runtime recovery token",
    )?;
    let token = Handle(raw);
    let user = unsafe { query(token.0, TokenUser) }?;
    let actual = unsafe { (*user.as_ptr().cast::<TOKEN_USER>()).User.Sid };
    let elevation = unsafe { query(token.0, TokenElevation) }?;
    let app = unsafe { query(token.0, TokenIsAppContainer) }?;
    if unsafe { sid_text(actual) }? != "S-1-5-21-4017028701-367916445-1230427694-1001"
        || unsafe { (*elevation.as_ptr().cast::<TOKEN_ELEVATION>()).TokenIsElevated } != 0
        || unsafe { *app.as_ptr().cast::<u32>() } != 0
    {
        return Err("fixed runtime recovery requires exact ordinary creator".into());
    }
    let held = crate::appcontainer_probe::verify_retirement_object(root)?;
    let mut descriptor = null_mut();
    let mut owner = null_mut();
    let status = unsafe {
        GetSecurityInfo(
            held.0,
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            null_mut(),
            null_mut(),
            &mut descriptor,
        )
    };
    if status != 0 {
        return Err(format!("fixed runtime recovery owner Win32={status}"));
    }
    let matches = unsafe { EqualSid(owner, actual) } != 0;
    unsafe {
        LocalFree(descriptor);
    }
    if !matches {
        return Err("fixed runtime root owner changed".into());
    }
    let image = ToolImageLease::open(&root.join("pwsh.exe"))?;
    if image.identity.volume != 2523053325
        || image.identity.file_index != 27584547717864257
        || image.identity.bytes != 301368
    {
        return Err("original runtime image identity changed".into());
    }
    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    win(
        unsafe { GetFileInformationByHandle(held.0, &mut information) },
        "fixed runtime recovery root identity",
    )?;
    Fixture::revoke_runtime_files(
        root,
        package,
        (
            information.dwVolumeSerialNumber,
            ((information.nFileIndexHigh as u64) << 32) | information.nFileIndexLow as u64,
        ),
    )?;
    let registry: Vec<_> = "Software\\ShellSpanStageA-3e4ba36e536a4419bd2bd1fecd8d8695"
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let deleted = unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, registry.as_ptr()) };
    if deleted != 0 && deleted != ERROR_FILE_NOT_FOUND {
        return Err(format!("fixed runtime registry retirement Win32={deleted}"));
    }
    let mut key = null_mut();
    let absent =
        unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, registry.as_ptr(), 0, KEY_READ, &mut key) };
    if absent == 0 {
        unsafe {
            RegCloseKey(key);
        }
    }
    if absent != ERROR_FILE_NOT_FOUND {
        return Err("fixed runtime registry absence unconfirmed".into());
    }
    let name: Vec<_> = profile.encode_utf16().chain(Some(0)).collect();
    let removed = unsafe { DeleteAppContainerProfile(name.as_ptr()) };
    if removed < 0 {
        return Err(format!(
            "fixed runtime profile retirement HRESULT={removed:#x}"
        ));
    }
    Ok(
        serde_json::json!({"production":"unavailable","fixed_trial":"3e4ba36e536a4419bd2bd1fecd8d8695",
        "creator_verified":true,"original_image_identity_verified":true,"fixture_acls_revoked":true,
        "registry_absent":true,"profile_removed":true,"fixture_retained":true}),
    )
}
#[cfg(test)]
mod tests {
    #[test]
    fn actual_dedicated_build_binds_identity_artifact_and_recovery() {
        let read = |name: &str| -> serde_json::Value {
            serde_json::from_slice(
                &std::fs::read(
                    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                        .join("../../docs/design/evidence")
                        .join(name),
                )
                .unwrap(),
            )
            .unwrap()
        };
        let receipt = read("windows-stage-a-2026-10-09-powershell7-build-system-profile.json");
        assert_eq!(receipt["controller_tool"], "power_shell7_runtime_build");
        let admission = &receipt["controller_admission_report"];
        assert!(admission["error"].is_null());
        for field in [
            "actual_user_verified",
            "actual_package_verified",
            "actual_capabilities_verified",
            "execution_topology_verified",
            "process_tree_stopped",
        ] {
            assert_eq!(admission[field], true, "{field}");
        }
        let tool = &admission["tool_admission"];
        assert_eq!(tool["actual_exit"], 73);
        assert_eq!(tool["artifact_verified"], true);
        assert_eq!(tool["runtime_file_count"], 471);
        assert_eq!(tool["artifact"]["bytes"], 25);
        let recovery =
            read("windows-stage-a-2026-10-09-powershell7-build-system-recovered-profile.json");
        assert_eq!(receipt["fixture_id"], recovery["fixture_id"]);
        assert_eq!(receipt["account_sid"], recovery["account_sid"]);
        assert!(recovery["cleanup_debt"].as_array().unwrap().is_empty());
        for field in [
            "account_removed",
            "profile_removed",
            "filters_removed",
            "credential_removed",
        ] {
            assert_eq!(recovery[field], true, "{field}");
        }
        let audit = read("windows-stage-a-2026-10-09-powershell7-build-system-os-audit.json");
        assert_eq!(audit["fixture_id"], receipt["fixture_id"]);
        for field in [
            "account_absent",
            "profile_absent",
            "hive_absent",
            "services_absent",
        ] {
            assert_eq!(audit[field], true, "{field}");
        }
    }
    #[test]
    fn actual_fixed_reference_build_keeps_artifact_and_full_retirement() {
        let report: serde_json::Value = serde_json::from_slice(include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/design/evidence/windows-stage-a-2026-10-09-powershell7-build-reference-final-lpac.json"))).unwrap();
        assert!(report["error"].is_null());
        assert_eq!(report["tool_admission"]["actual_exit"], 73);
        assert_eq!(report["tool_admission"]["artifact_verified"], true);
        assert_eq!(report["tool_admission"]["topology_verified"], true);
        assert_eq!(report["tool_admission"]["runtime_file_count"], 471);
        for field in [
            "process_tree_stopped",
            "profile_removed",
            "fixture_acls_revoked",
        ] {
            assert_eq!(report[field], true, "{field}");
        }
    }
    #[test]
    fn reference_inventory_rejects_missing_unknown_and_nested_assets() {
        use super::*;
        let root =
            std::env::temp_dir().join(format!("ShellSpan-AC-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir(&root).unwrap();
        assert!(reference_inventory(&root).is_err());
        std::fs::write(root.join("System.Runtime.dll"), b"fixed").unwrap();
        std::fs::write(root.join("netstandard.dll"), b"fixed").unwrap();
        assert_eq!(reference_inventory(&root).unwrap().len(), 2);
        std::fs::create_dir(root.join("nested.dll")).unwrap();
        assert!(reference_inventory(&root).is_err());
        trash::delete(root).unwrap();
    }
    #[test]
    #[ignore = "exact owned successful build budget trial recovery"]
    fn recover_fixed_successful_build_budget_trial() {
        use super::*;
        let root = Path::new(
            r"C:\Users\ZHENGB~1\AppData\Local\Temp\ShellSpan-AC-3f94b32aa5cf4fcd85d382be4867723f",
        );
        let package =
            "S-1-15-2-981503276-3542853477-207866612-3647440751-2535626990-1012089740-144203871";
        let profile = "ShellSpan-candidate-2cfe25cdb32d4f4e94d018a2807e5474";
        let intent: serde_json::Value = serde_json::from_slice(
            &std::fs::read(root.join("powershell-runtime-intent.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            intent["user"],
            "S-1-5-21-4017028701-367916445-1230427694-1001"
        );
        assert_eq!(intent["package"], package);
        let receipt: serde_json::Value =
            serde_json::from_slice(&std::fs::read(root.join("ownership.json")).unwrap()).unwrap();
        assert_eq!(receipt["profile"], profile);
        assert_eq!(receipt["package_sid"], package);
        let volume = u32::try_from(intent["root_identity"]["volume"].as_u64().unwrap()).unwrap();
        let index = intent["root_identity"]["file_index"].as_u64().unwrap();
        crate::appcontainer_probe::Fixture::revoke_runtime_files(root, package, (volume, index))
            .unwrap();
        let name: Vec<_> = profile.encode_utf16().chain(Some(0)).collect();
        assert!(
            unsafe {
                windows_sys::Win32::Security::Isolation::DeleteAppContainerProfile(name.as_ptr())
            } >= 0
        );
        let result = serde_json::json!({"fixture":root,"profile":profile,"package":package,"fixture_acls_revoked":true,"profile_removed":true,"fixture_retained":true});
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/design/evidence/windows-stage-a-2026-10-09-powershell7-build-reference-budget-recovery.json");
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .unwrap();
        file.write_all(&serde_json::to_vec_pretty(&result).unwrap())
            .unwrap();
        file.sync_all().unwrap();
    }
    #[test]
    #[ignore = "single owned reference trial recovery, exact frozen identities only"]
    fn recover_fixed_reference_grant_trial() {
        use super::*;
        use windows_sys::Win32::Security::Authorization::*;
        use windows_sys::Win32::Security::*;
        let root = Path::new(
            r"C:\Users\ZHENGB~1\AppData\Local\Temp\ShellSpan-AC-bf5fe3cff7544ce9b023e613378ad468",
        );
        let user = "S-1-5-21-4017028701-367916445-1230427694-1001";
        let package =
            "S-1-15-2-1062140656-3216466628-1257565155-2243368968-1929915991-2396195172-1748154293";
        let profile = "ShellSpan-candidate-811ec01aa07b426b9f66ad7e71ce6186";
        let intent: serde_json::Value = serde_json::from_slice(
            &std::fs::read(root.join("powershell-runtime-intent.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(intent["user"], user);
        assert_eq!(intent["package"], package);
        let held_root = crate::appcontainer_probe::verify_retirement_object(root).unwrap();
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        assert_ne!(
            unsafe { GetFileInformationByHandle(held_root.0, &mut info) },
            0
        );
        assert_eq!(intent["root_identity"]["volume"], info.dwVolumeSerialNumber);
        assert_eq!(
            intent["root_identity"]["file_index"],
            (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow)
        );
        let completion: serde_json::Value = serde_json::from_slice(
            &std::fs::read(root.join("powershell-runtime-copies.json")).unwrap(),
        )
        .unwrap();
        let records = completion["files"].as_array().unwrap();
        assert_eq!(records.len(), 471);
        let ref_dir =
            crate::appcontainer_probe::verify_retirement_object(&root.join("ref")).unwrap();
        assert_eq!(reference_inventory(&root.join("ref")).unwrap().len(), 167);
        for record in records {
            let identity: ToolImageIdentity =
                serde_json::from_value(record["destination"].clone()).unwrap();
            let path: Vec<_> = identity
                .path
                .to_str()
                .unwrap()
                .encode_utf16()
                .chain(Some(0))
                .collect();
            let mut owner = null_mut();
            let mut sd = null_mut();
            assert_eq!(
                unsafe {
                    GetNamedSecurityInfoW(
                        path.as_ptr(),
                        SE_FILE_OBJECT,
                        OWNER_SECURITY_INFORMATION,
                        &mut owner,
                        null_mut(),
                        null_mut(),
                        null_mut(),
                        &mut sd,
                    )
                },
                0
            );
            let owner_text = unsafe { crate::appcontainer_probe::sid_text(owner) }.unwrap();
            unsafe {
                LocalFree(sd);
            }
            assert_eq!(owner_text, user);
        }
        // Restore only creator/SYSTEM inheritance in this exact owned directory;
        // validate every frozen file identity before package retirement.
        crate::appcontainer_probe::set_owned_dacl(
            &root.join("ref"),
            &format!("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;{user})(A;;FRFX;;;{package})"),
        )
        .unwrap();
        let mut held = Vec::new();
        for record in records {
            let identity: ToolImageIdentity =
                serde_json::from_value(record["destination"].clone()).unwrap();
            assert!(
                identity.path.parent() == Some(root)
                    || identity.path.parent() == Some(root.join("ref").as_path())
            );
            let path: Vec<_> = identity
                .path
                .to_str()
                .unwrap()
                .encode_utf16()
                .chain(Some(0))
                .collect();
            let raw = unsafe {
                CreateFileW(
                    path.as_ptr(),
                    READ_CONTROL | WRITE_DAC,
                    FILE_SHARE_READ,
                    null(),
                    OPEN_EXISTING,
                    FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_OVERLAPPED,
                    null_mut(),
                )
            };
            assert_ne!(
                raw,
                INVALID_HANDLE_VALUE,
                "{} Win32={}",
                identity.path.display(),
                unsafe { GetLastError() }
            );
            let handle = Handle(raw);
            let mut actual = BY_HANDLE_FILE_INFORMATION::default();
            assert_ne!(
                unsafe { GetFileInformationByHandle(handle.0, &mut actual) },
                0
            );
            assert_eq!(
                actual.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT),
                0
            );
            assert_eq!(actual.nNumberOfLinks, 1);
            assert_eq!(actual.dwVolumeSerialNumber, identity.volume);
            assert_eq!(
                (u64::from(actual.nFileIndexHigh) << 32) | u64::from(actual.nFileIndexLow),
                identity.file_index
            );
            assert_eq!(
                (u64::from(actual.nFileSizeHigh) << 32) | u64::from(actual.nFileSizeLow),
                identity.bytes
            );
            let mut owner = null_mut();
            let mut sd = null_mut();
            assert_eq!(
                unsafe {
                    GetNamedSecurityInfoW(
                        path.as_ptr(),
                        SE_FILE_OBJECT,
                        OWNER_SECURITY_INFORMATION,
                        &mut owner,
                        null_mut(),
                        null_mut(),
                        null_mut(),
                        &mut sd,
                    )
                },
                0
            );
            let owner_text = unsafe { crate::appcontainer_probe::sid_text(owner) }.unwrap();
            unsafe {
                LocalFree(sd);
            }
            assert_eq!(owner_text, user);
            held.push(handle);
        }
        crate::appcontainer_probe::set_owned_dacl(
            &root.join("ref"),
            &format!("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;{user})(A;;FRFX;;;{package})"),
        )
        .unwrap();
        drop(held);
        drop(ref_dir);
        crate::appcontainer_probe::Fixture::revoke_runtime_files(
            root,
            package,
            (
                info.dwVolumeSerialNumber,
                (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
            ),
        )
        .unwrap();
        let name: Vec<_> = profile.encode_utf16().chain(Some(0)).collect();
        assert!(
            unsafe {
                windows_sys::Win32::Security::Isolation::DeleteAppContainerProfile(name.as_ptr())
            } >= 0
        );
        let receipt = serde_json::json!({"fixture":root,"profile":profile,"package":package,"frozen_files_verified":471,"fixture_acls_revoked":true,"profile_removed":true,"fixture_retained":true});
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/design/evidence/windows-stage-a-2026-10-09-powershell7-build-reference-recovery.json");
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .unwrap();
        file.write_all(&serde_json::to_vec_pretty(&receipt).unwrap())
            .unwrap();
        file.sync_all().unwrap();
    }
    #[test]
    fn dedicated_fixed_artifact_and_recovery_are_independently_verified() {
        let original: serde_json::Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/design/evidence/windows-stage-a-2026-10-09-powershell7-artifact-bound-system-profile.json"))).unwrap();
        let recovered: serde_json::Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/design/evidence/windows-stage-a-2026-10-09-powershell7-artifact-bound-recovered-profile.json"))).unwrap();
        let report = &original["controller_admission_report"];
        assert!(report["error"].is_null());
        assert_eq!(report["tool_admission"]["actual_exit"], 73);
        assert_eq!(report["tool_admission"]["artifact"]["bytes"], 25);
        assert_eq!(report["tool_admission"]["artifact_verified"], true);
        assert_eq!(report["tool_admission"]["output_verified"], true);
        for field in [
            "actual_capabilities_verified",
            "actual_lpac",
            "execution_topology_verified",
            "process_tree_stopped",
            "workload_retired",
        ] {
            assert_eq!(report[field], true, "{field}");
        }
        assert_eq!(original["fixture_id"], recovered["fixture_id"]);
        assert!(recovered["cleanup_debt"].as_array().unwrap().is_empty());
        for field in [
            "account_removed",
            "profile_removed",
            "filters_removed",
            "credential_removed",
            "private_namespace_removed",
        ] {
            assert_eq!(recovered[field], true, "{field}");
        }
    }
    #[test]
    fn actual_fixed_powershell_artifact_is_independently_verified_and_retired() {
        let report: serde_json::Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/design/evidence/windows-stage-a-2026-10-09-powershell7-artifact-bound.json"))).unwrap();
        assert!(report["error"].is_null());
        assert_eq!(report["tool_admission"]["actual_exit"], 73);
        assert_eq!(report["tool_admission"]["artifact_verified"], true);
        assert_eq!(report["tool_admission"]["artifact"]["bytes"], 25);
        for field in [
            "fixture_acls_revoked",
            "profile_removed",
            "process_tree_stopped",
            "capabilities_verified",
        ] {
            assert_eq!(report[field], true, "{field}");
        }
    }
    #[test]
    fn record_before_grant_actual_runtime_startup_and_manifest_mapping_are_verified() {
        let report: serde_json::Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/design/evidence/windows-stage-a-2026-10-09-powershell7-runtime-record-before-grant.json"))).unwrap();
        let audit: serde_json::Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/design/evidence/windows-stage-a-2026-10-09-powershell7-runtime-record-manifest-audit.json"))).unwrap();
        assert!(report["error"].is_null());
        assert_eq!(report["tool_admission"]["actual_exit"], 73);
        assert_eq!(report["tool_admission"]["topology_verified"], true);
        for field in [
            "process_tree_stopped",
            "fixture_acls_revoked",
            "profile_removed",
            "capabilities_verified",
        ] {
            assert_eq!(report[field], true, "{field}");
        }
        for field in [
            "source_count",
            "copy_count",
            "valid_mapping_count",
            "unique_destinations",
        ] {
            assert_eq!(audit[field], 304, "{field}");
        }
        assert_eq!(audit["total_bytes"].as_f64(), Some(236516521.0));
        assert_eq!(audit["root_identity_equal"], true);
        let root =
            std::path::Path::new(report["tool_admission"]["runtime_intent"].as_str().unwrap())
                .parent()
                .unwrap();
        assert_eq!(audit["root"].as_str().unwrap(), root.to_str().unwrap());
        assert_eq!(report["production"], "unavailable");
    }
    #[test]
    fn manifest_conflict_and_budget_failure_never_dispatch_grants() {
        let root = std::env::temp_dir().join(format!(
            "ShellSpan-runtime-publication-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&root).unwrap();
        let invoked = std::cell::Cell::new(false);
        let oversized = vec![0; 256 * 1024 + 1];
        assert!(publish_copies_before_grants(&root, &oversized, || {
            invoked.set(true);
            Ok(())
        })
        .is_err());
        assert!(!invoked.get());
        assert!(!root.join("powershell-runtime-copies.json").exists());
        let bytes = b"fixed completion receipt";
        assert!(publish_copies_before_grants(&root, bytes, || {
            assert_eq!(
                std::fs::read(root.join("powershell-runtime-copies.json")).unwrap(),
                bytes
            );
            invoked.set(true);
            Err("fixed injected authorization failure".into())
        })
        .unwrap_err()
        .contains("authorization failure"));
        assert!(invoked.get());
        invoked.set(false);
        assert!(publish_copies_before_grants(&root, b"replacement", || {
            invoked.set(true);
            Ok(())
        })
        .is_err());
        assert!(!invoked.get());
        assert_eq!(
            std::fs::read(root.join("powershell-runtime-copies.json")).unwrap(),
            bytes
        );
        trash::delete(root).unwrap();
    }
    #[test]
    fn dedicated_actual_startup_and_independent_recovery_preserve_scope() {
        let original: serde_json::Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/design/evidence/windows-stage-a-2026-10-09-powershell7-system-profile.json"))).unwrap();
        let recovered: serde_json::Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/design/evidence/windows-stage-a-2026-10-09-powershell7-system-recovered-profile.json"))).unwrap();
        let report = &original["controller_admission_report"];
        assert!(report["error"].is_null());
        assert_eq!(report["tool_admission"]["actual_exit"], 73);
        assert_eq!(report["tool_admission"]["output_verified"], true);
        for field in [
            "actual_capabilities_verified",
            "process_tree_stopped",
            "workload_retired",
        ] {
            assert_eq!(report[field], true, "{field}");
        }
        assert!(!original["cleanup_debt"].as_array().unwrap().is_empty());
        assert!(recovered["cleanup_debt"].as_array().unwrap().is_empty());
        for field in [
            "account_removed",
            "profile_removed",
            "filters_removed",
            "credential_removed",
            "private_namespace_removed",
            "private_station_removed",
        ] {
            assert_eq!(recovered[field], true, "{field}");
        }
        for field in [
            "actual_user_verified",
            "actual_package_verified",
            "actual_low_integrity",
            "actual_lpac",
            "execution_topology_verified",
            "baseline_tree_stopped",
        ] {
            assert_eq!(report[field], true, "{field}");
        }
        assert_eq!(report["execution_job_final_active"], 0);
        let observations = report["execution_job_observations"].as_array().unwrap();
        assert_eq!(observations.len(), 2);
        for observation in observations {
            assert!(observation["error"].is_null());
            assert_eq!(observation["integrity_rid"], 4096);
            for field in [
                "actual_lpac",
                "appcontainer",
                "exact_capabilities",
                "exact_job_member",
                "expected_package",
                "expected_user",
            ] {
                assert_eq!(observation[field], true, "{field}");
            }
        }
        let audit: serde_json::Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/design/evidence/windows-stage-a-2026-10-09-powershell7-system-post-recovery-audit.json"))).unwrap();
        assert_eq!(audit["fixture_id"], original["fixture_id"]);
        for field in [
            "account_absent",
            "profile_absent",
            "hive_absent",
            "admission_service_absent",
            "recovery_service_absent",
        ] {
            assert_eq!(audit[field], true, "{field}");
        }
        assert_eq!(original["fixture_id"], recovered["fixture_id"]);
        assert_eq!(recovered["production"], "unavailable");
    }
    #[test]
    fn actual_owned_runtime_instrumentation_exit_and_retirement_are_verified() {
        let report: serde_json::Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/design/evidence/windows-stage-a-2026-10-09-powershell7-runtime-instrumentation-lpac-controller.json"))).unwrap();
        assert!(report["error"].is_null());
        assert_eq!(report["production"], "unavailable");
        assert_eq!(
            report["requested_capabilities"],
            serde_json::json!(["registryRead", "lpacInstrumentation"])
        );
        let tool = &report["tool_admission"];
        assert_eq!(tool["actual_exit"], 73);
        assert_eq!(tool["expected_exit"], 73);
        assert_eq!(tool["topology_verified"], true);
        assert_eq!(tool["runtime_file_count"], 304);
        assert_eq!(tool["runtime_bytes"], 236516521_u64);
        assert_eq!(tool["stdout"], "");
        assert_eq!(tool["stderr"], "");
        for field in [
            "capabilities_verified",
            "actual_lpac",
            "low_integrity",
            "same_user",
            "process_tree_stopped",
            "fixture_acls_revoked",
            "profile_removed",
        ] {
            assert_eq!(report[field], true, "{field}");
        }
        assert!(
            report["owned_job_process_observations"]
                .as_array()
                .unwrap()
                .len()
                >= 2
        );
    }

    use super::*;
    #[test]
    fn fixed_runtime_inventory_requires_core_assets_and_refuses_selected_aliases() {
        let root = std::env::temp_dir().join(format!(
            "ShellSpan-runtime-inventory-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&root).unwrap();
        for name in [
            "pwsh.exe",
            "pwsh.dll",
            "pwsh.deps.json",
            "pwsh.runtimeconfig.json",
            "hostfxr.dll",
            "hostpolicy.dll",
            "coreclr.dll",
        ] {
            std::fs::write(root.join(name), b"fixed inventory only").unwrap();
        }
        std::fs::write(root.join("personal.ps1"), b"not a selected runtime asset").unwrap();
        let names = inventory(&root).unwrap();
        assert_eq!(names.len(), 7);
        assert!(!names.contains("personal.ps1"));
        std::fs::create_dir(root.join("alias.dll")).unwrap();
        assert!(inventory(&root).unwrap_err().contains("regular"));
        // The negative directory remains owned; retirement uses the recycle bin.
        trash::delete(root.join("alias.dll")).unwrap();
        std::fs::rename(root.join("coreclr.dll"), root.join("coreclr.absent")).unwrap();
        assert!(inventory(&root).unwrap_err().contains("incomplete"));
        trash::delete(root).unwrap();
    }
    #[test]
    fn runtime_inventory_budget_is_checked_before_copy_or_grants() {
        let root =
            std::env::temp_dir().join(format!("ShellSpan-runtime-budget-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        for index in 0..385 {
            std::fs::write(root.join(format!("owned-{index}.dll")), b"fixture").unwrap();
        }
        assert!(inventory(&root).unwrap_err().contains("excessive"));
        assert!(PowerShellRuntime::prepare(&root, "invalid", "invalid").is_err());
        assert!(!root.join("powershell-runtime-intent.json").exists());
        trash::delete(root).unwrap();
    }
}
