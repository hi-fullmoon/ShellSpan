//! Fixed installed Git dependency diagnostics in an unelevated child only.
use crate::appcontainer_probe::{query, win, Handle};
use crate::fixed_tool::{FixedTool, ToolImageLease};
use std::ptr::null_mut;
use windows_sys::Win32::{
    Foundation::*,
    Security::*,
    System::{
        Diagnostics::Debug::*, LibraryLoader::*, SystemInformation::GetSystemDirectoryW,
        Threading::*,
    },
};
type Result<T> = std::result::Result<T, String>;
#[derive(serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct FrozenImports {
    version: u32,
    image: crate::fixed_tool::ToolImageIdentity,
    imports: Vec<String>,
}
pub fn frozen_environment(lease: &ToolImageLease) -> Result<String> {
    let plan = FrozenImports {
        version: 1,
        image: lease.identity.clone(),
        imports: lease.static_imports()?,
    };
    let serialized = serde_json::to_string(&plan).map_err(|e| e.to_string())?;
    if serialized.len() > 8192 {
        return Err("frozen Git import plan exceeds budget".into());
    }
    Ok(format!("SSPA_GIT_IMPORTS={serialized}\0"))
}
fn validate(plan: &FrozenImports) -> Result<()> {
    if plan.version != 1
        || plan.image.path != FixedTool::GitRuntime.image()?
        || plan.image.file_index == 0
        || plan.image.bytes == 0
        || plan.image.bytes > 128 * 1024 * 1024
        || plan.imports.is_empty()
        || plan.imports.len() > 128
    {
        return Err("frozen Git import identity or budget invalid".into());
    }
    let mut unique = std::collections::BTreeSet::new();
    for name in &plan.imports {
        if !crate::pe_imports::valid_dll_basename(name) || !unique.insert(name) {
            return Err("frozen Git import is not a unique bounded DLL basename".into());
        }
    }
    Ok(())
}
pub fn verify_delivery(raw: &str, subject: &ToolImageLease) -> Result<()> {
    if raw.len() > 16384 {
        return Err("Git dependency delivery exceeds budget".into());
    }
    let value: serde_json::Value = serde_json::from_str(raw).map_err(|e| e.to_string())?;
    let imports = subject.static_imports()?;
    if value.as_object().is_none_or(|object| object.len() != 6)
        || value["version"].as_u64() != Some(1)
        || value["scope"].as_str()
            != Some("fixed static Git import file/load observations; not full dependency closure")
        || !(value["image_read_error"].is_null() || value["image_read_error"].is_string())
        || value["image"] != serde_json::to_value(&subject.identity).map_err(|e| e.to_string())?
        || value["imports"] != serde_json::to_value(&imports).map_err(|e| e.to_string())?
    {
        return Err("Git dependency delivery does not match frozen subject".into());
    }
    let checks = value["checks"]
        .as_array()
        .ok_or("Git dependency checks missing")?;
    if checks.len() != imports.len() * 2 {
        return Err("Git dependency checks incomplete".into());
    }
    let mut seen = std::collections::BTreeSet::new();
    let mut system = vec![0u16; 32768];
    let length = unsafe { GetSystemDirectoryW(system.as_mut_ptr(), system.len() as u32) } as usize;
    if length == 0 || length >= system.len() {
        return Err("dependency delivery System32 invalid".into());
    }
    let system =
        std::path::PathBuf::from(String::from_utf16(&system[..length]).map_err(|e| e.to_string())?);
    let local = subject
        .identity
        .path
        .parent()
        .ok_or("dependency subject directory missing")?;
    for check in checks {
        let name = check["name"]
            .as_str()
            .ok_or("Git dependency name missing")?;
        let location = check["location"]
            .as_str()
            .ok_or("Git dependency location missing")?;
        if !imports.iter().any(|expected| expected == name)
            || !["git-directory", "system32"].contains(&location)
            || !seen.insert((name, location))
            || check.as_object().is_none_or(|object| object.len() != 9)
        {
            return Err("Git dependency check unknown or duplicated".into());
        }
        let loaded = check["loaded"]
            .as_bool()
            .ok_or("Git dependency load result missing")?;
        let expected_path = if location == "git-directory" {
            local.join(name)
        } else {
            system.join(name)
        };
        let actual_path: std::path::PathBuf =
            serde_json::from_value(check["path"].clone()).map_err(|e| e.to_string())?;
        if actual_path != expected_path {
            return Err("Git dependency observation outside fixed directories".into());
        }
        if !check["file_identity"].is_null() {
            let identity: crate::fixed_tool::ToolImageIdentity =
                serde_json::from_value(check["file_identity"].clone())
                    .map_err(|e| e.to_string())?;
            if identity.path != expected_path
                || identity.file_index == 0
                || identity.bytes == 0
                || identity.bytes > 128 * 1024 * 1024
                || !check["file_error"].is_null()
            {
                return Err("Git dependency file identity inconsistent".into());
            }
        } else if !check["file_error"].is_string() {
            return Err("Git dependency file outcome missing".into());
        }
        if loaded
            && (check["freed"].as_bool() != Some(true)
                || !check["load_win32"].is_null()
                || check["loaded_path"]["Ok"].as_str().is_none())
        {
            return Err("Git dependency loaded module retirement unverified".into());
        }
        if !loaded
            && (check["load_win32"].as_u64().is_none()
                || !check["freed"].is_null()
                || !check["loaded_path"].is_null())
        {
            return Err("Git dependency failure outcome incomplete".into());
        }
    }
    Ok(())
}
struct ErrorMode(u32);
impl Drop for ErrorMode {
    fn drop(&mut self) {
        if unsafe { SetThreadErrorMode(self.0, null_mut()) } == 0 {
            std::process::abort();
        }
    }
}
pub fn observe() -> Result<serde_json::Value> {
    let mut raw = null_mut();
    if unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 1, &mut raw) } != 0 {
        drop(Handle(raw));
        return Err("dependency probe rejects thread impersonation".into());
    }
    if unsafe { GetLastError() } != ERROR_NO_TOKEN {
        return Err("dependency probe thread context unknown".into());
    }
    win(
        unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) },
        "dependency probe token",
    )?;
    let token = Handle(raw);
    let elevation = unsafe { query(token.0, TokenElevation) }?;
    if unsafe { (*elevation.as_ptr().cast::<TOKEN_ELEVATION>()).TokenIsElevated } != 0 {
        return Err("dependency probe rejects elevated primary".into());
    }
    let raw = std::env::var("SSPA_GIT_IMPORTS").map_err(|_| "frozen Git imports missing")?;
    if raw.len() > 8192 {
        return Err("frozen Git import plan exceeds budget".into());
    }
    let plan: FrozenImports = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    validate(&plan)?;
    let imports = plan.imports;
    let path = FixedTool::GitRuntime.image()?;
    let image_access = ToolImageLease::open(&path);
    let local = path.parent().ok_or("fixed Git directory missing")?;
    let mut system = vec![0u16; 32768];
    let length = unsafe { GetSystemDirectoryW(system.as_mut_ptr(), system.len() as u32) } as usize;
    if length == 0 || length >= system.len() {
        return Err("dependency probe System32 invalid".into());
    }
    let system =
        std::path::PathBuf::from(String::from_utf16(&system[..length]).map_err(|e| e.to_string())?);
    let mut previous = 0;
    win(
        unsafe {
            SetThreadErrorMode(
                SEM_FAILCRITICALERRORS | SEM_NOOPENFILEERRORBOX,
                &mut previous,
            )
        },
        "dependency probe quiet errors",
    )?;
    let _mode = ErrorMode(previous);
    let mut checks = vec![];
    for name in &imports {
        for (location, parent) in [("git-directory", local), ("system32", system.as_path())] {
            let path = parent.join(name);
            let file = ToolImageLease::open(&path);
            let wide: Vec<u16> = path
                .to_str()
                .ok_or("dependency path encoding")?
                .encode_utf16()
                .chain(Some(0))
                .collect();
            let module = unsafe {
                LoadLibraryExW(
                    wide.as_ptr(),
                    null_mut(),
                    LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32,
                )
            };
            let load_win32 = module.is_null().then(|| unsafe { GetLastError() });
            let loaded_path = if module.is_null() {
                None
            } else {
                let mut path = vec![0u16; 32768];
                let length =
                    unsafe { GetModuleFileNameW(module, path.as_mut_ptr(), path.len() as u32) }
                        as usize;
                if length == 0 || length >= path.len() {
                    None
                } else {
                    Some(String::from_utf16(&path[..length]).map_err(|e| e.to_string()))
                }
            };
            let freed = if module.is_null() {
                None
            } else {
                Some(unsafe { FreeLibrary(module) } != 0)
            };
            checks.push(serde_json::json!({"name":name,"location":location,"path":path,
                "file_identity":file.as_ref().ok().map(|lease| &lease.identity),"file_error":file.as_ref().err(),
                "loaded":!module.is_null(),"load_win32":load_win32,"loaded_path":loaded_path,"freed":freed}));
        }
    }
    Ok(
        serde_json::json!({"version":1,"scope":"fixed static Git import file/load observations; not full dependency closure",
        "image":plan.image,"image_read_error":image_access.as_ref().err(),"imports":imports,"checks":checks}),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn delivery_binds_frozen_identity_unique_complete_checks_and_retirement() {
        let path = std::env::temp_dir().join(format!(
            "ShellSpan-import-delivery-{}.exe",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&path, crate::pe_imports::tests::fixture(true)).unwrap();
        let lease = ToolImageLease::open(&path).unwrap();
        let mut system = vec![0u16; 32768];
        let length =
            unsafe { GetSystemDirectoryW(system.as_mut_ptr(), system.len() as u32) } as usize;
        assert!(length > 0 && length < system.len());
        let system = std::path::PathBuf::from(String::from_utf16(&system[..length]).unwrap());
        let checks=vec![("git-directory",path.parent().unwrap()),("system32",system.as_path())].into_iter().map(|(location,parent)|
            serde_json::json!({"name":"kernel32.dll","location":location,"path":parent.join("kernel32.dll"),"file_identity":null,"file_error":"controlled missing fixture",
                "loaded":false,"load_win32":126,"loaded_path":null,"freed":null})).collect::<Vec<_>>();
        let value = serde_json::json!({"version":1,"scope":"fixed static Git import file/load observations; not full dependency closure",
            "image":lease.identity,"image_read_error":null,"imports":["kernel32.dll"],"checks":checks});
        assert!(verify_delivery(&value.to_string(), &lease).is_ok());
        let mut bad = value.clone();
        bad["image"]["file_index"] = serde_json::json!(0);
        assert!(verify_delivery(&bad.to_string(), &lease).is_err());
        let mut bad = value.clone();
        bad["checks"][1] = bad["checks"][0].clone();
        assert!(verify_delivery(&bad.to_string(), &lease).is_err());
        let mut bad = value.clone();
        bad["checks"][0]["path"] = serde_json::json!(r"C:\outside\kernel32.dll");
        assert!(verify_delivery(&bad.to_string(), &lease).is_err());
        let mut bad = value.clone();
        bad["checks"][0]["loaded"] = serde_json::json!(true);
        assert!(verify_delivery(&bad.to_string(), &lease).is_err());
        let mut bad = value;
        bad["checks"].as_array_mut().unwrap().pop();
        assert!(verify_delivery(&bad.to_string(), &lease).is_err());
        drop(lease);
        trash::delete(path).unwrap();
    }
    #[test]
    fn frozen_import_plan_rejects_identity_path_budget_duplicate_and_device_names() {
        let mut plan = FrozenImports {
            version: 1,
            image: crate::fixed_tool::ToolImageIdentity {
                path: FixedTool::GitRuntime.image().unwrap(),
                volume: 1,
                file_index: 1,
                bytes: 1024,
            },
            imports: vec!["kernel32.dll".into()],
        };
        assert!(validate(&plan).is_ok());
        for invalid in [
            "../kernel32.dll",
            "C:\\other.dll",
            "kernel32.dll:stream",
            "nul.dll",
            "com1.dll",
            "other.exe",
        ] {
            plan.imports = vec![invalid.into()];
            assert!(validate(&plan).is_err());
        }
        plan.imports = vec!["kernel32.dll".into(), "kernel32.dll".into()];
        assert!(validate(&plan).is_err());
        plan.imports = vec!["kernel32.dll".into()];
        plan.image.file_index = 0;
        assert!(validate(&plan).is_err());
        plan.image.file_index = 1;
        plan.image.path = std::path::PathBuf::from(r"C:\unknown\git.exe");
        assert!(validate(&plan).is_err());
        assert!(
            serde_json::from_str::<FrozenImports>(r#"{"version":1,"command":"arbitrary"}"#)
                .is_err()
        );
    }
}
