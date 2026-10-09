//! Fixed, diagnostic-only Git runtime bundle. No caller-provided source paths.
use crate::fixed_tool::{FixedTool, ToolImageIdentity, ToolImageLease};
use serde::Serialize;
use std::collections::{BTreeSet, VecDeque};
use std::io::Write;
use std::path::Path;

#[derive(Serialize)]
pub struct BundleFile {
    source: ToolImageIdentity,
    destination: ToolImageIdentity,
    imports: Vec<String>,
}
pub struct GitBundle {
    _sources: Vec<ToolImageLease>,
    destinations: Vec<ToolImageLease>,
    pub files: Vec<BundleFile>,
    pub system_imports: BTreeSet<String>,
}
impl GitBundle {
    pub fn image(&self) -> &Path {
        &self.destinations[0].identity.path
    }
    pub fn prepare(root: &Path, user: &str, package: &str) -> Result<Self, String> {
        let id = root
            .file_name()
            .and_then(|v| v.to_str())
            .and_then(|v| v.strip_prefix("ShellSpan-AC-"))
            .and_then(|v| uuid::Uuid::parse_str(v).ok());
        if !root.is_absolute() || id.is_none_or(|id| id.is_nil()) {
            return Err("Git bundle requires fixed owned fixture".into());
        }
        let _root_lease = crate::appcontainer_probe::verify_retirement_object(root)?;
        let source = FixedTool::GitRuntime.image()?;
        let directory = source.parent().ok_or("fixed Git directory missing")?;
        let mut sources = vec![ToolImageLease::open(&source)?];
        let mut imports = vec![sources[0].static_imports()?];
        let mut queue: VecDeque<_> = imports[0].iter().cloned().collect();
        let mut seen = BTreeSet::new();
        let mut system_imports = BTreeSet::new();
        let mut bytes = sources[0].identity.bytes;
        while let Some(name) = queue.pop_front() {
            if !seen.insert(name.clone()) {
                continue;
            }
            if seen.len() > 128 {
                return Err("Git dependency traversal budget exceeded".into());
            }
            let path = directory.join(&name);
            match std::fs::symlink_metadata(&path) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    system_imports.insert(name);
                    continue;
                }
                Err(error) => return Err(format!("fixed dependency inventory: {error}")),
                Ok(_) => {}
            }
            let lease = ToolImageLease::open(&path)?;
            bytes = bytes
                .checked_add(lease.identity.bytes)
                .ok_or("Git byte budget overflow")?;
            if sources.len() >= 16 || bytes > 64 * 1024 * 1024 {
                return Err("Git bundle exceeds 16 images or 64 MiB".into());
            }
            let dependencies = lease.static_imports()?;
            queue.extend(dependencies.iter().cloned());
            imports.push(dependencies);
            sources.push(lease);
        }
        // Durable intent precedes every copy and grant. This ordinary diagnostic
        // file is not a privileged broker authorization or recovery journal.
        let plan = serde_json::json!({"version":1,"root":root,"user":user,"package":package,
            "sources":sources.iter().map(|v| &v.identity).collect::<Vec<_>>(),
            "imports":imports,"system_imports":system_imports,
            "scope":"static local dependency closure only; dynamic imports require actual execution"});
        let mut manifest = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(root.join("git-bundle-intent.json"))
            .map_err(|e| e.to_string())?;
        manifest
            .write_all(&serde_json::to_vec(&plan).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        manifest.sync_all().map_err(|e| e.to_string())?;
        drop(manifest);
        let mut destinations = Vec::new();
        let mut files = Vec::new();
        for (index, source) in sources.iter().enumerate() {
            let name = source
                .identity
                .path
                .file_name()
                .and_then(|v| v.to_str())
                .ok_or("invalid fixed source basename")?;
            let destination = source.copy_new_owned(root, name)?;
            destination.grant_owned_execution(user, package)?;
            files.push(BundleFile {
                source: source.identity.clone(),
                destination: destination.identity.clone(),
                imports: imports[index].clone(),
            });
            destinations.push(destination);
        }
        Ok(Self {
            _sources: sources,
            destinations,
            files,
            system_imports,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::appcontainer_probe::{query, win, Handle};
    use std::ptr::null_mut;
    use windows_sys::Win32::Foundation::*;
    use windows_sys::Win32::Security::Authorization::*;
    use windows_sys::Win32::Security::*;
    use windows_sys::Win32::System::Threading::*;

    fn dacl(path: &Path) -> Vec<u8> {
        let wide: Vec<_> = path
            .to_str()
            .unwrap()
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let mut descriptor = null_mut();
        let mut acl = null_mut();
        assert_eq!(
            unsafe {
                GetNamedSecurityInfoW(
                    wide.as_ptr(),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    null_mut(),
                    null_mut(),
                    &mut acl,
                    null_mut(),
                    &mut descriptor,
                )
            },
            0
        );
        assert!(!acl.is_null());
        let bytes = unsafe {
            std::slice::from_raw_parts(acl.cast::<u8>(), (*acl).AclSize as usize).to_vec()
        };
        unsafe {
            LocalFree(descriptor);
        }
        bytes
    }
    #[test]
    fn fixed_git_bundle_preserves_installed_acls_and_retires_only_copy_grants() {
        let root =
            std::env::temp_dir().join(format!("ShellSpan-AC-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir(&root).unwrap();
        let mut token = null_mut();
        win(
            unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) },
            "test source token",
        )
        .unwrap();
        let token = Handle(token);
        let info = unsafe { query(token.0, TokenUser) }.unwrap();
        let mut text = null_mut();
        assert_ne!(
            unsafe {
                ConvertSidToStringSidW((*info.as_ptr().cast::<TOKEN_USER>()).User.Sid, &mut text)
            },
            0
        );
        let mut length = 0;
        unsafe {
            while *text.add(length) != 0 {
                length += 1;
            }
        }
        let user = unsafe { String::from_utf16(std::slice::from_raw_parts(text, length)).unwrap() };
        unsafe {
            LocalFree(text.cast());
        }
        let package = "S-1-15-2-111-222-333-444-555-666-777";
        let directory = FixedTool::GitRuntime
            .image()
            .unwrap()
            .parent()
            .unwrap()
            .to_path_buf();
        let installed: Vec<_> = [
            "git.exe",
            "libiconv-2.dll",
            "libintl-8.dll",
            "libpcre2-8-0.dll",
            "zlib1.dll",
        ]
        .iter()
        .map(|name| {
            let path = directory.join(name);
            let acl = dacl(&path);
            (path, acl)
        })
        .collect();
        let bundle = GitBundle::prepare(&root, &user, package).unwrap();
        assert_eq!(bundle.files.len(), 5);
        let manifest = std::fs::read(root.join("git-bundle-intent.json")).unwrap();
        assert!(GitBundle::prepare(&root, &user, package).is_err());
        assert_eq!(
            std::fs::read(root.join("git-bundle-intent.json")).unwrap(),
            manifest
        );
        let before = dacl(bundle.image());
        assert!(bundle.destinations[0]
            .grant_owned_execution(&format!("{user});injection"), package)
            .is_err());
        assert_eq!(dacl(bundle.image()), before);
        assert!(bundle._sources[0]
            .grant_owned_execution(&user, package)
            .is_err());
        for (source, acl) in &installed {
            assert_eq!(&dacl(source), acl);
        }
        drop(bundle);
        crate::appcontainer_probe::Fixture::revoke_files(&root, package, None).unwrap();
        assert_ne!(dacl(&root.join("git.exe")), before);
        for (source, acl) in &installed {
            assert_eq!(&dacl(source), acl);
        }
        assert!(std::fs::OpenOptions::new()
            .write(true)
            .open(root.join("git.exe"))
            .is_ok());
        trash::delete(root).unwrap();
    }
}
