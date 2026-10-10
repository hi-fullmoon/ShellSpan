//! Independent regular-file copies. No grants, alias following or tool dispatch.
use crate::{
    appcontainer_probe::{verify_retirement_object, win, Handle},
    fixed_tool::{ToolImageIdentity, ToolImageLease},
};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    rc::{Rc, Weak},
};
use std::{io::Write, os::windows::io::AsRawHandle, path::Path};
use windows_sys::Win32::Storage::FileSystem::*;
pub struct OwnedAsset {
    lease: ToolImageLease,
    _parents: Vec<Rc<Handle>>,
}
impl OwnedAsset {
    pub fn identity(&self) -> &ToolImageIdentity {
        &self.lease.identity
    }
    /// The native coordinator must stop the tree and revoke grants first.
    pub fn recycle(
        self,
        expected: &crate::frontend_bundle_journal::ObjectIdentity,
    ) -> Result<RecycledObject, String> {
        let identity = crate::frontend_bundle_journal::ObjectIdentity {
            volume: self.lease.identity.volume,
            file_id: self.lease.identity.file_index,
        };
        if &identity != expected {
            return Err("asset retirement identity differs".into());
        }
        let path = self.lease.identity.path.clone();
        let Self { lease, _parents } = self;
        drop(lease);
        let result = recycle_checked(&path, &identity, false);
        drop(_parents);
        result
    }
}
pub struct OwnedDirectory {
    identity: crate::frontend_bundle_journal::ObjectIdentity,
    path: std::path::PathBuf,
    _handle: Handle,
    _parents: Vec<Handle>,
}
impl OwnedDirectory {
    pub fn identity(&self) -> &crate::frontend_bundle_journal::ObjectIdentity {
        &self.identity
    }
    /// Empty objects only; never recursively dispose of unrecorded children.
    pub fn recycle(
        self,
        expected: &crate::frontend_bundle_journal::ObjectIdentity,
    ) -> Result<RecycledObject, String> {
        if &self.identity != expected {
            return Err("directory retirement identity differs".into());
        }
        let Self {
            identity,
            path,
            _handle,
            _parents,
        } = self;
        drop(_handle);
        let result = recycle_checked(&path, &identity, true);
        drop(_parents);
        result
    }
}
pub struct RecycledObject {
    identity: crate::frontend_bundle_journal::ObjectIdentity,
}
impl RecycledObject {
    pub fn identity(&self) -> &crate::frontend_bundle_journal::ObjectIdentity {
        &self.identity
    }
}
fn recycle_checked(
    path: &Path,
    expected: &crate::frontend_bundle_journal::ObjectIdentity,
    directory: bool,
) -> Result<RecycledObject, String> {
    let held = verify_retirement_object(path)?;
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    win(
        unsafe { GetFileInformationByHandle(held.0, &mut info) },
        "verify object before recycling",
    )?;
    if info.dwVolumeSerialNumber != expected.volume
        || (((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64) != expected.file_id
        || (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0) != directory
    {
        return Err("object replacement or type differs before recycling".into());
    }
    if directory
        && std::fs::read_dir(path)
            .map_err(|e| e.to_string())?
            .next()
            .is_some()
    {
        return Err("owned directory has unretired or unknown children".into());
    }
    // Protected native namespace and stopped-tree gates are prerequisites;
    // ancestors remain held while the Shell recycle API needs the object free.
    drop(held);
    trash::delete(path).map_err(|e| format!("recycle exact owned object: {e}"))?;
    confirm_object_absent(path)?;
    Ok(RecycledObject {
        identity: expected.clone(),
    })
}
fn confirm_object_absent(path: &Path) -> Result<(), String> {
    if object_is_absent(path)? {
        Ok(())
    } else {
        Err("recycled path still names an object".into())
    }
}
pub(crate) fn object_is_absent(path: &Path) -> Result<bool, String> {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::*;
    let wide = crate::appcontainer_probe::native_local_path(path)?;
    let raw = unsafe {
        CreateFileW(
            wide.as_ptr(),
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
            null_mut(),
        )
    };
    if raw != INVALID_HANDLE_VALUE {
        drop(Handle(raw));
        return Ok(false);
    }
    let error = unsafe { GetLastError() };
    if error != ERROR_FILE_NOT_FOUND {
        return Err(format!("retirement absence not proven: Win32 {error}"));
    }
    Ok(true)
}
fn parent_paths(root: &Path, relative: &str) -> Result<Vec<PathBuf>, String> {
    if !root.is_absolute() {
        return Err("asset copy requires absolute owned root".into());
    }
    crate::policy::classify_project_object(relative, false, false, false)?;
    if relative.contains('\\') {
        return Err("asset copy requires canonical relative path".into());
    }
    let target = root.join(relative);
    let parent = target.parent().ok_or("asset copy parent missing")?;
    let mut chain = Vec::new();
    let mut current = Some(parent);
    while let Some(path) = current {
        if !path.starts_with(root) {
            return Err("asset copy parent escaped owned root".into());
        }
        chain.push(path.to_path_buf());
        if path == root {
            break;
        }
        current = path.parent();
    }
    Ok(chain)
}
fn hold_parents(root: &Path, relative: &str, volume: u32) -> Result<Vec<Handle>, String> {
    let mut parents = Vec::new();
    for path in parent_paths(root, relative)?.iter().rev() {
        let held = verify_retirement_object(path)?;
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        win(
            unsafe { GetFileInformationByHandle(held.0, &mut info) },
            "observe copy parent",
        )?;
        if info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
            || info.dwVolumeSerialNumber != volume
        {
            return Err("asset copy parent type or volume differs".into());
        }
        parents.push(held);
    }
    Ok(parents)
}
#[derive(Default)]
pub(crate) struct FileParentCache {
    entries: BTreeMap<PathBuf, (u32, Weak<Handle>)>,
}
impl FileParentCache {
    fn hold(
        &mut self,
        root: &Path,
        relative: &str,
        volume: u32,
    ) -> Result<Vec<Rc<Handle>>, String> {
        let mut parents = Vec::new();
        for path in parent_paths(root, relative)?.into_iter().rev() {
            if let Some((observed_volume, weak)) = self.entries.get(&path) {
                if let Some(held) = weak.upgrade() {
                    if *observed_volume != volume {
                        return Err("cached copy parent volume differs".into());
                    }
                    parents.push(held);
                    continue;
                }
            }
            let held = verify_retirement_object(&path)?;
            let mut info = BY_HANDLE_FILE_INFORMATION::default();
            win(
                unsafe { GetFileInformationByHandle(held.0, &mut info) },
                "observe shared copy parent",
            )?;
            if info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
                || info.dwVolumeSerialNumber != volume
            {
                return Err("shared copy parent type or volume differs".into());
            }
            let held = Rc::new(held);
            self.entries.insert(path, (volume, Rc::downgrade(&held)));
            parents.push(held);
        }
        Ok(parents)
    }
}
#[cfg(test)]
pub(crate) fn create_directory(
    root: &Path,
    relative: &str,
    volume: u32,
) -> Result<OwnedDirectory, String> {
    create_directory_stamped(root, relative, volume, None)
}
pub(crate) fn create_directory_stamped(
    root: &Path,
    relative: &str,
    volume: u32,
    stamp: Option<&crate::frontend_creation_stamp::CreationStamp>,
) -> Result<OwnedDirectory, String> {
    let parents = hold_parents(root, relative, volume)?;
    let target = root.join(relative);
    let initial = fresh_directory(&target, stamp)?;
    let handle = verify_retirement_object(&target)?;
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    win(
        unsafe { GetFileInformationByHandle(handle.0, &mut info) },
        "observe created directory",
    )?;
    let file_id = ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64;
    if info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
        || info.dwVolumeSerialNumber != volume
        || file_id == 0
        || initial.is_some_and(|identity| identity != (info.dwVolumeSerialNumber, file_id))
    {
        return Err("created directory identity differs; retain owned debt".into());
    }
    Ok(OwnedDirectory {
        identity: crate::frontend_bundle_journal::ObjectIdentity { volume, file_id },
        _handle: handle,
        path: target,
        _parents: parents,
    })
}
/// Fixed namespace entry beneath an independently verified protected parent.
pub(crate) fn create_journal_namespace(
    parent: &Path,
    volume: u32,
    stamp: &crate::frontend_creation_stamp::CreationStamp,
) -> Result<OwnedDirectory, String> {
    create_fixed_journal_namespace(parent, volume, stamp, "frontend-dependencies")
}
pub(crate) fn create_source_journal_namespace(
    parent: &Path,
    volume: u32,
    stamp: &crate::frontend_creation_stamp::CreationStamp,
) -> Result<OwnedDirectory, String> {
    create_fixed_journal_namespace(parent, volume, stamp, "frontend-source")
}
pub(crate) fn create_project_journal_namespace(
    parent: &Path,
    volume: u32,
    stamp: &crate::frontend_creation_stamp::CreationStamp,
) -> Result<OwnedDirectory, String> {
    create_fixed_journal_namespace(parent, volume, stamp, "frontend-project")
}
fn create_fixed_journal_namespace(
    parent: &Path,
    volume: u32,
    stamp: &crate::frontend_creation_stamp::CreationStamp,
    name: &str,
) -> Result<OwnedDirectory, String> {
    let held = crate::appcontainer_probe::hold_journal_parent(parent)?;
    let mut namespace = create_directory_stamped(parent, name, volume, Some(stamp))?;
    namespace._parents = vec![held];
    Ok(namespace)
}
fn fresh_directory(
    path: &Path,
    stamp: Option<&crate::frontend_creation_stamp::CreationStamp>,
) -> Result<Option<(u32, u64)>, String> {
    if let Some(stamp) = stamp {
        let file = stamp.create_new(path)?;
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        win(
            unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) },
            "observe stamped directory creation",
        )?;
        if info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
            return Err("stamped directory creation kind differs".into());
        }
        Ok(Some((
            info.dwVolumeSerialNumber,
            ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
        )))
    } else {
        std::fs::create_dir(path).map_err(|e| format!("create owned directory: {e}"))?;
        Ok(None)
    }
}
#[cfg(test)]
pub(crate) fn copy_new(
    source: &ToolImageLease,
    expected_sha256: &str,
    root: &Path,
    relative: &str,
    volume: u32,
) -> Result<OwnedAsset, String> {
    copy_new_cached(
        source,
        expected_sha256,
        root,
        relative,
        volume,
        &mut FileParentCache::default(),
    )
}
#[cfg(test)]
pub(crate) fn copy_new_cached(
    source: &ToolImageLease,
    expected_sha256: &str,
    root: &Path,
    relative: &str,
    volume: u32,
    cache: &mut FileParentCache,
) -> Result<OwnedAsset, String> {
    copy_new_stamped(source, expected_sha256, root, relative, volume, cache, None)
}
pub(crate) fn copy_new_stamped(
    source: &ToolImageLease,
    expected_sha256: &str,
    root: &Path,
    relative: &str,
    volume: u32,
    cache: &mut FileParentCache,
    stamp: Option<&crate::frontend_creation_stamp::CreationStamp>,
) -> Result<OwnedAsset, String> {
    let parents = cache.hold(root, relative, volume)?;
    let target = root.join(relative);
    let bytes = source.read_bytes()?;
    let hash = |bytes: &[u8]| {
        Sha256::digest(bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    };
    if hash(&bytes) != expected_sha256 {
        return Err("asset source digest differs before creation".into());
    }
    let mut writer = if let Some(stamp) = stamp {
        stamp.create_new(&target)?
    } else {
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(|e| format!("create independent asset: {e}"))?
    };
    writer
        .write_all(&bytes)
        .and_then(|_| writer.sync_all())
        .map_err(|e| e.to_string())?;
    let mut written = BY_HANDLE_FILE_INFORMATION::default();
    win(
        unsafe { GetFileInformationByHandle(writer.as_raw_handle(), &mut written) },
        "observe created asset",
    )?;
    if written.nNumberOfLinks != 1 || written.dwVolumeSerialNumber != volume {
        return Err("created asset links or volume differ; retain owned debt".into());
    }
    drop(writer);
    let lease = ToolImageLease::open_source(&target)?;
    let index = ((written.nFileIndexHigh as u64) << 32) | written.nFileIndexLow as u64;
    if lease.identity.volume != volume
        || lease.identity.file_index != index
        || lease.identity.bytes != source.identity.bytes
        || lease.source_link_count()? != 1
        || hash(&lease.read_bytes()?) != expected_sha256
        || (lease.identity.volume == source.identity.volume
            && lease.identity.file_index == source.identity.file_index)
    {
        return Err("independent asset changed before immutable lease; retain owned debt".into());
    }
    Ok(OwnedAsset {
        lease,
        _parents: parents,
    })
}
pub struct OwnedAlias {
    identity: crate::frontend_bundle_journal::ObjectIdentity,
    path: std::path::PathBuf,
    reparse_data: Vec<u8>,
    _handle: Handle,
    _target: Handle,
    _parents: Vec<Handle>,
}
impl OwnedAlias {
    pub fn identity(&self) -> &crate::frontend_bundle_journal::ObjectIdentity {
        &self.identity
    }
    /// Detach only the recorded mount point. This is not object retirement:
    /// the same directory still exists and needs verified reversible disposal.
    pub fn detach(self) -> Result<OwnedDirectory, String> {
        use std::ptr::{null, null_mut};
        use windows_sys::Win32::{
            Foundation::*,
            System::{
                Ioctl::FSCTL_DELETE_REPARSE_POINT, SystemServices::IO_REPARSE_TAG_MOUNT_POINT,
                IO::DeviceIoControl,
            },
        };
        verify_alias(self._handle.0, &self.identity, &self.reparse_data)?;
        let Self {
            identity,
            path,
            reparse_data,
            _handle,
            _target,
            mut _parents,
        } = self;
        drop(_handle);
        let wide = crate::appcontainer_probe::native_local_path(&path)?;
        let raw = unsafe {
            CreateFileW(
                wide.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                FILE_SHARE_READ,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
                null_mut(),
            )
        };
        if raw == INVALID_HANDLE_VALUE {
            return Err(format!("open exact alias for detach: Win32 {}", unsafe {
                GetLastError()
            }));
        }
        let handle = Handle(raw);
        verify_alias(handle.0, &identity, &reparse_data)?;
        let mut removal = Vec::from(IO_REPARSE_TAG_MOUNT_POINT.to_le_bytes());
        removal.extend([0u8; 4]);
        let mut returned = 0;
        win(
            unsafe {
                DeviceIoControl(
                    handle.0,
                    FSCTL_DELETE_REPARSE_POINT,
                    removal.as_ptr().cast(),
                    removal.len() as u32,
                    null_mut(),
                    0,
                    &mut returned,
                    null_mut(),
                )
            },
            "detach exact owned alias",
        )?;
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        win(
            unsafe { GetFileInformationByHandle(handle.0, &mut info) },
            "observe detached alias directory",
        )?;
        if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
            || info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
            || info.dwVolumeSerialNumber != identity.volume
            || (((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64)
                != identity.file_id
        {
            return Err("detached alias identity differs; retain debt".into());
        }
        _parents.push(_target);
        Ok(OwnedDirectory {
            identity,
            path,
            _handle: handle,
            _parents,
        })
    }
}
fn verify_alias(
    handle: windows_sys::Win32::Foundation::HANDLE,
    identity: &crate::frontend_bundle_journal::ObjectIdentity,
    data: &[u8],
) -> Result<(), String> {
    use std::ptr::{null, null_mut};
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    win(
        unsafe { GetFileInformationByHandle(handle, &mut info) },
        "verify alias before detach",
    )?;
    let mut bytes = vec![0u8; 16384];
    let mut returned = 0;
    win(
        unsafe {
            windows_sys::Win32::System::IO::DeviceIoControl(
                handle,
                windows_sys::Win32::System::Ioctl::FSCTL_GET_REPARSE_POINT,
                null(),
                0,
                bytes.as_mut_ptr().cast(),
                bytes.len() as u32,
                &mut returned,
                null_mut(),
            )
        },
        "verify exact alias reparse data",
    )?;
    if info.dwVolumeSerialNumber != identity.volume
        || (((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64) != identity.file_id
        || info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)
            != FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT
        || returned as usize != data.len()
        || returned as usize > bytes.len()
        || bytes[..returned as usize] != *data
    {
        return Err("alias identity or frozen target differs before detach".into());
    }
    Ok(())
}
pub(crate) fn reopen_for_retirement(
    root: &Path,
    relative: &str,
    kind: &str,
    target_relative: Option<&str>,
    expected: &crate::frontend_bundle_journal::ObjectIdentity,
) -> Result<crate::frontend_materialization::OwnedObject, String> {
    use crate::frontend_materialization::OwnedObject;
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::*;
    let mut parents = hold_parents(root, relative, expected.volume)?;
    let path = root.join(relative);
    let wide = crate::appcontainer_probe::native_local_path(&path)?;
    let raw = unsafe {
        CreateFileW(
            wide.as_ptr(),
            FILE_READ_DATA | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
            null_mut(),
        )
    };
    if raw == INVALID_HANDLE_VALUE {
        return Err("reopen recorded object for retirement failed".into());
    }
    let handle = Handle(raw);
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    win(
        unsafe { GetFileInformationByHandle(handle.0, &mut info) },
        "observe recovery object",
    )?;
    if info.dwVolumeSerialNumber != expected.volume
        || (((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64) != expected.file_id
    {
        return Err("recorded recovery object identity differs".into());
    }
    let directory = info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0;
    let reparse = info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0;
    match kind {
        "file" if !directory && !reparse && info.nNumberOfLinks == 1 => {
            let lease = ToolImageLease::open_source(&path)?;
            if lease.identity.volume != expected.volume
                || lease.identity.file_index != expected.file_id
            {
                return Err("recovered file lease identity differs".into());
            }
            Ok(OwnedObject::File(OwnedAsset {
                lease,
                _parents: parents.into_iter().map(Rc::new).collect(),
            }))
        }
        "directory" | "alias" if directory && !reparse => {
            Ok(OwnedObject::Directory(OwnedDirectory {
                identity: expected.clone(),
                path,
                _handle: handle,
                _parents: parents,
            }))
        }
        "alias" if directory && reparse => {
            let target_relative = target_relative.ok_or("recorded alias target missing")?;
            parents.extend(hold_parents(root, target_relative, expected.volume)?);
            let target_path = root.join(target_relative);
            let target = verify_retirement_object(&target_path)?;
            let mut target_info = BY_HANDLE_FILE_INFORMATION::default();
            win(
                unsafe { GetFileInformationByHandle(target.0, &mut target_info) },
                "observe recovery alias target",
            )?;
            if target_info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
                || target_info.dwVolumeSerialNumber != expected.volume
            {
                return Err("recorded alias target type or volume differs".into());
            }
            let data = alias_data(&target_path)?;
            verify_alias(handle.0, expected, &data)?;
            Ok(OwnedObject::Alias(OwnedAlias {
                identity: expected.clone(),
                path,
                reparse_data: data,
                _handle: handle,
                _target: target,
                _parents: parents,
            }))
        }
        _ => Err("recorded recovery object kind differs".into()),
    }
}
fn alias_data(target_path: &Path) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::System::SystemServices::IO_REPARSE_TAG_MOUNT_POINT;
    let target_text = target_path.to_str().ok_or("invalid alias target path")?;
    let target_text = target_text
        .strip_prefix(r"\\?\")
        .unwrap_or(target_text)
        .replace('/', "\\");
    let substitute: Vec<u16> = format!(r"\??\{target_text}").encode_utf16().collect();
    let print: Vec<u16> = target_text.encode_utf16().collect();
    let length = 8 + 2 * (substitute.len() + print.len() + 2);
    if length + 8 > 16384 {
        return Err("alias reparse budget exceeded".into());
    }
    let mut data = Vec::from(IO_REPARSE_TAG_MOUNT_POINT.to_le_bytes());
    for value in [
        length as u16,
        0,
        0,
        (substitute.len() * 2) as u16,
        ((substitute.len() + 1) * 2) as u16,
        (print.len() * 2) as u16,
    ] {
        data.extend(value.to_le_bytes());
    }
    for value in substitute
        .into_iter()
        .chain(Some(0))
        .chain(print)
        .chain(Some(0))
    {
        data.extend(value.to_le_bytes());
    }
    Ok(data)
}
#[cfg(test)]
pub(crate) fn create_alias(
    root: &Path,
    relative: &str,
    target_relative: &str,
    volume: u32,
) -> Result<OwnedAlias, String> {
    create_alias_stamped(root, relative, target_relative, volume, None)
}
pub(crate) fn create_alias_stamped(
    root: &Path,
    relative: &str,
    target_relative: &str,
    volume: u32,
    stamp: Option<&crate::frontend_creation_stamp::CreationStamp>,
) -> Result<OwnedAlias, String> {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::{
        Foundation::*,
        System::{
            Ioctl::{FSCTL_GET_REPARSE_POINT, FSCTL_SET_REPARSE_POINT},
            IO::DeviceIoControl,
        },
    };
    let mut parents = hold_parents(root, relative, volume)?;
    parents.extend(hold_parents(root, target_relative, volume)?);
    let target_path = root.join(target_relative);
    let target = verify_retirement_object(&target_path)?;
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    win(
        unsafe { GetFileInformationByHandle(target.0, &mut info) },
        "observe alias target",
    )?;
    if info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0 || info.dwVolumeSerialNumber != volume
    {
        return Err("alias target is not an owned directory on destination volume".into());
    }
    let data = alias_data(&target_path)?;
    let path = root.join(relative);
    let initial = fresh_directory(&path, stamp)?;
    let wide = crate::appcontainer_probe::native_local_path(&path)?;
    let open = |access| {
        let raw = unsafe {
            CreateFileW(
                wide.as_ptr(),
                access,
                FILE_SHARE_READ,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
                null_mut(),
            )
        };
        if raw == INVALID_HANDLE_VALUE {
            Err(format!("open owned alias: Win32 {}", unsafe {
                GetLastError()
            }))
        } else {
            Ok(Handle(raw))
        }
    };
    let writer = open(GENERIC_WRITE)?;
    win(
        unsafe { GetFileInformationByHandle(writer.0, &mut info) },
        "observe fresh alias directory",
    )?;
    if info.dwVolumeSerialNumber != volume
        || info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
        || info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || initial.is_some_and(|identity| {
            identity
                != (
                    info.dwVolumeSerialNumber,
                    ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
                )
        })
    {
        return Err("fresh alias directory type or volume differs; retain debt".into());
    }
    let mut returned = 0;
    win(
        unsafe {
            DeviceIoControl(
                writer.0,
                FSCTL_SET_REPARSE_POINT,
                data.as_ptr().cast(),
                data.len() as u32,
                null_mut(),
                0,
                &mut returned,
                null_mut(),
            )
        },
        "set owned alias target",
    )?;
    win(
        unsafe { GetFileInformationByHandle(writer.0, &mut info) },
        "observe written alias",
    )?;
    let identity = crate::frontend_bundle_journal::ObjectIdentity {
        volume: info.dwVolumeSerialNumber,
        file_id: ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
    };
    drop(writer);
    let handle = open(FILE_READ_DATA | FILE_READ_ATTRIBUTES)?;
    win(
        unsafe { GetFileInformationByHandle(handle.0, &mut info) },
        "observe held alias",
    )?;
    let mut observed = vec![0u8; 16384];
    win(
        unsafe {
            DeviceIoControl(
                handle.0,
                FSCTL_GET_REPARSE_POINT,
                null(),
                0,
                observed.as_mut_ptr().cast(),
                observed.len() as u32,
                &mut returned,
                null_mut(),
            )
        },
        "read owned alias target",
    )?;
    if identity.volume != volume
        || identity.file_id == 0
        || info.dwVolumeSerialNumber != volume
        || (((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64) != identity.file_id
        || info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)
            != FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT
        || returned as usize > observed.len()
        || returned as usize != data.len()
        || observed[..returned as usize] != data
    {
        return Err("owned alias identity or exact reparse target differs; retain debt".into());
    }
    Ok(OwnedAlias {
        identity,
        path,
        reparse_data: data,
        _handle: handle,
        _target: target,
        _parents: parents,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_owned_long_path_file_can_be_recycled() {
        let root =
            std::env::temp_dir().join(format!("ShellSpan-long-recycle-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let source_path = root.join("source.js");
        std::fs::write(&source_path, b"owned long path asset").unwrap();
        let source = ToolImageLease::open_source(&source_path).unwrap();
        let mut relative = String::new();
        let mut directories = Vec::new();
        while root.join(&relative).join("index.js").as_os_str().len() < 310 {
            if !relative.is_empty() {
                relative.push('/');
            }
            relative.push_str("owned-directory-component");
            directories.push(create_directory(&root, &relative, source.identity.volume).unwrap());
        }
        let file = format!("{relative}/index.js");
        let digest = Sha256::digest(source.read_bytes().unwrap())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let copied = copy_new(&source, &digest, &root, &file, source.identity.volume).unwrap();
        let expected = crate::frontend_bundle_journal::ObjectIdentity {
            volume: copied.identity().volume,
            file_id: copied.identity().file_index,
        };
        let result = copied.recycle(&expected);
        // Fixture contents were all created here; the short root is retained for
        // exact test cleanup even if the individual Shell operation aborts.
        drop(directories);
        drop(source);
        trash::delete(&root).unwrap();
        assert!(
            result.is_ok(),
            "long path recycling failed: {}",
            result.err().unwrap_or_default()
        );
    }
    #[test]
    fn stamped_directory_copy_and_alias_preserve_creation_bindings() {
        use crate::frontend_creation_stamp::{CreationKind, CreationStamp};
        use std::os::windows::fs::OpenOptionsExt;
        let root =
            std::env::temp_dir().join(format!("ShellSpan-stamped-assets-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let source_path = root.join("source.js");
        std::fs::write(&source_path, b"stamped copied source").unwrap();
        let source = ToolImageLease::open_source(&source_path).unwrap();
        let volume = source.identity.volume;
        let fixture = uuid::Uuid::new_v4();
        let directory_stamp = CreationStamp::new(
            fixture,
            0,
            CreationKind::Directory,
            &"a".repeat(64),
            &"b".repeat(64),
        )
        .unwrap();
        let file_stamp = CreationStamp::new(
            fixture,
            1,
            CreationKind::File,
            &"a".repeat(64),
            &"b".repeat(64),
        )
        .unwrap();
        let alias_stamp = CreationStamp::new(
            fixture,
            2,
            CreationKind::Alias,
            &"a".repeat(64),
            &"b".repeat(64),
        )
        .unwrap();
        let directory =
            create_directory_stamped(&root, "store", volume, Some(&directory_stamp)).unwrap();
        let digest = Sha256::digest(source.read_bytes().unwrap())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let file = copy_new_stamped(
            &source,
            &digest,
            &root,
            "store/index.js",
            volume,
            &mut FileParentCache::default(),
            Some(&file_stamp),
        )
        .unwrap();
        let alias =
            create_alias_stamped(&root, "pkg", "store", volume, Some(&alias_stamp)).unwrap();
        let verify = |relative: &str, stamp: &CreationStamp| {
            let held = std::fs::OpenOptions::new()
                .read(true)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
                .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
                .open(root.join(relative))
                .unwrap();
            stamp.verify(&held).unwrap();
        };
        verify("store", &directory_stamp);
        verify("store/index.js", &file_stamp);
        verify("pkg", &alias_stamp);
        assert_eq!(
            std::fs::read(root.join("pkg/index.js")).unwrap(),
            b"stamped copied source"
        );
        let alias_id = alias.identity().clone();
        let detached = alias.detach().unwrap();
        verify("pkg", &alias_stamp);
        detached.recycle(&alias_id).unwrap();
        let file_id = crate::frontend_bundle_journal::ObjectIdentity {
            volume,
            file_id: file.identity().file_index,
        };
        file.recycle(&file_id).unwrap();
        let directory_id = directory.identity().clone();
        directory.recycle(&directory_id).unwrap();
        assert_eq!(source.read_bytes().unwrap(), b"stamped copied source");
        drop(source);
        trash::delete(root).unwrap();
    }
    #[test]
    fn shared_parent_custody_reuses_handles_and_revalidates_after_last_lease() {
        let root =
            std::env::temp_dir().join(format!("ShellSpan-parent-custody-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(root.join("store")).unwrap();
        let source_path = root.join("source.js");
        std::fs::write(&source_path, b"shared parents").unwrap();
        let source = ToolImageLease::open_source(&source_path).unwrap();
        let volume = source.identity.volume;
        let digest = Sha256::digest(source.read_bytes().unwrap())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let mut cache = FileParentCache::default();
        let first =
            copy_new_cached(&source, &digest, &root, "store/a.js", volume, &mut cache).unwrap();
        let second =
            copy_new_cached(&source, &digest, &root, "store/b.js", volume, &mut cache).unwrap();
        assert_eq!(cache.entries.len(), 2);
        for (left, right) in first._parents.iter().zip(&second._parents) {
            assert!(Rc::ptr_eq(left, right));
        }
        let mut before = BY_HANDLE_FILE_INFORMATION::default();
        win(
            unsafe { GetFileInformationByHandle(first._parents.last().unwrap().0, &mut before) },
            "observe shared parent test",
        )
        .unwrap();
        assert!(copy_new_cached(
            &source,
            &digest,
            &root,
            "store/wrong.js",
            volume.wrapping_add(1),
            &mut cache
        )
        .is_err());
        assert!(!root.join("store/wrong.js").exists());
        assert!(std::fs::rename(root.join("store"), root.join("old-store")).is_err());
        for asset in [first, second] {
            let expected = crate::frontend_bundle_journal::ObjectIdentity {
                volume,
                file_id: asset.identity().file_index,
            };
            asset.recycle(&expected).unwrap();
        }
        assert!(cache
            .entries
            .values()
            .all(|(_, weak)| weak.upgrade().is_none()));
        std::fs::rename(root.join("store"), root.join("old-store")).unwrap();
        std::fs::create_dir(root.join("store")).unwrap();
        let third =
            copy_new_cached(&source, &digest, &root, "store/c.js", volume, &mut cache).unwrap();
        let mut after = BY_HANDLE_FILE_INFORMATION::default();
        win(
            unsafe { GetFileInformationByHandle(third._parents.last().unwrap().0, &mut after) },
            "observe replacement parent test",
        )
        .unwrap();
        assert_ne!(
            (before.nFileIndexHigh, before.nFileIndexLow),
            (after.nFileIndexHigh, after.nFileIndexLow)
        );
        drop((third, source));
        trash::delete(root).unwrap();
    }
    #[test]
    fn recycling_checks_identity_empty_directories_and_native_absence() {
        let root = std::env::temp_dir().join(format!(
            "ShellSpan-owned-retirement-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&root).unwrap();
        let source_path = root.join("source.js");
        std::fs::write(&source_path, b"original asset").unwrap();
        let source = ToolImageLease::open_source(&source_path).unwrap();
        let volume = source.identity.volume;
        let directory = create_directory(&root, "store", volume).unwrap();
        let directory_id = directory.identity().clone();
        let digest = Sha256::digest(source.read_bytes().unwrap())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let copied = copy_new(&source, &digest, &root, "store/index.js", volume).unwrap();
        let file_id = crate::frontend_bundle_journal::ObjectIdentity {
            volume,
            file_id: copied.identity().file_index,
        };
        let mut wrong = directory_id.clone();
        wrong.file_id = wrong.file_id.wrapping_add(1);
        assert!(recycle_checked(&root.join("store"), &wrong, true).is_err());
        assert!(recycle_checked(&root.join("store"), &directory_id, true).is_err());
        assert_eq!(
            std::fs::read(root.join("store/index.js")).unwrap(),
            b"original asset"
        );
        let retired = copied.recycle(&file_id).unwrap();
        assert!(retired.identity() == &file_id);
        confirm_object_absent(&root.join("store/index.js")).unwrap();
        let alias = create_alias(&root, "pkg", "store", volume).unwrap();
        let alias_id = alias.identity().clone();
        let detached = alias.detach().unwrap();
        assert!(detached.recycle(&alias_id).unwrap().identity() == &alias_id);
        assert!(directory.recycle(&directory_id).unwrap().identity() == &directory_id);
        assert!(confirm_object_absent(&root.join("missing-parent/child")).is_err());
        assert!(confirm_object_absent(&source_path).is_err());
        assert_eq!(source.read_bytes().unwrap(), b"original asset");
        drop(source);
        trash::delete(root).unwrap();
    }
    #[test]
    fn directory_alias_is_fresh_bound_and_cannot_be_a_creation_parent() {
        let root =
            std::env::temp_dir().join(format!("ShellSpan-owned-alias-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(root.join("store")).unwrap();
        let source_path = root.join("source.js");
        std::fs::write(&source_path, b"alias target content").unwrap();
        let source = ToolImageLease::open_source(&source_path).unwrap();
        let volume = source.identity.volume;
        std::fs::write(root.join("store/index.js"), b"target").unwrap();
        assert!(create_alias(&root, "bad", "source.js", volume).is_err());
        assert!(!root.join("bad").exists());
        assert!(create_alias(&root, "escape", "../outside", volume).is_err());
        let alias = create_alias(&root, "pkg", "store", volume).unwrap();
        assert_eq!(alias.identity().volume, volume);
        assert_eq!(std::fs::read(root.join("pkg/index.js")).unwrap(), b"target");
        assert!(create_alias(&root, "pkg", "store", volume).is_err());
        assert!(create_directory(&root, "pkg/new", volume).is_err());
        assert!(!root.join("store/new").exists());
        assert!(std::fs::rename(root.join("pkg"), root.join("other")).is_err());
        let expected_identity = alias.identity().clone();
        let mut changed = alias.reparse_data.clone();
        changed[0] ^= 1;
        assert!(verify_alias(alias._handle.0, &expected_identity, &changed).is_err());
        let mut wrong_identity = expected_identity.clone();
        wrong_identity.file_id = wrong_identity.file_id.wrapping_add(1);
        assert!(verify_alias(alias._handle.0, &wrong_identity, &alias.reparse_data).is_err());
        assert_eq!(std::fs::read(root.join("pkg/index.js")).unwrap(), b"target");
        let detached = alias.detach().unwrap();
        assert!(detached.identity() == &expected_identity);
        assert!(!root.join("pkg/index.js").exists());
        assert!(root.join("pkg").is_dir());
        drop((detached, source));
        assert_eq!(
            std::fs::read(root.join("store/index.js")).unwrap(),
            b"target"
        );
        trash::delete(root).unwrap();
    }
    #[test]
    fn owned_directories_are_fresh_locked_and_support_independent_child_copies() {
        let root = std::env::temp_dir().join(format!(
            "ShellSpan-owned-directory-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&root).unwrap();
        let source_path = root.join("source.js");
        std::fs::write(&source_path, b"child asset").unwrap();
        let source = ToolImageLease::open_source(&source_path).unwrap();
        let volume = source.identity.volume;
        let directory = create_directory(&root, "store", volume).unwrap();
        assert_eq!(directory.identity().volume, volume);
        assert_ne!(directory.identity().file_id, 0);
        assert!(create_directory(&root, "store", volume).is_err());
        assert!(std::fs::rename(root.join("store"), root.join("replacement")).is_err());
        assert!(create_directory(&root, "missing/child", volume).is_err());
        assert!(!root.join("missing").exists());
        assert!(create_directory(&root, "../outside", volume).is_err());
        let child = create_directory(&root, "store/package", volume).unwrap();
        assert_ne!(directory.identity().file_id, child.identity().file_id);
        let digest = Sha256::digest(source.read_bytes().unwrap())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let copied = copy_new(&source, &digest, &root, "store/package/index.js", volume).unwrap();
        assert_eq!(
            std::fs::read(root.join("store/package/index.js")).unwrap(),
            b"child asset"
        );
        drop((copied, child, directory, source));
        trash::delete(root).unwrap();
    }
    #[test]
    fn hardlinked_and_empty_sources_produce_independent_locked_files_without_overwrite() {
        let root =
            std::env::temp_dir().join(format!("ShellSpan-asset-copy-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let output = root.join("output");
        std::fs::create_dir(&output).unwrap();
        let source_path = root.join("source.js");
        std::fs::write(&source_path, b"export default 1").unwrap();
        std::fs::hard_link(&source_path, root.join("source-alias.js")).unwrap();
        let source = ToolImageLease::open_source(&source_path).unwrap();
        let digest = Sha256::digest(source.read_bytes().unwrap())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let copied = copy_new(
            &source,
            &digest,
            &output,
            "index.js",
            source.identity.volume,
        )
        .unwrap();
        assert_ne!(copied.identity().file_index, source.identity.file_index);
        assert_eq!(source.source_link_count().unwrap(), 2);
        assert!(std::fs::write(output.join("index.js"), b"changed").is_err());
        assert!(copy_new(
            &source,
            &digest,
            &output,
            "index.js",
            source.identity.volume
        )
        .is_err());
        assert!(copy_new(
            &source,
            &"0".repeat(64),
            &output,
            "wrong.js",
            source.identity.volume
        )
        .is_err());
        assert!(!output.join("wrong.js").exists());
        assert!(copy_new(
            &source,
            &digest,
            &output,
            "wrong-volume.js",
            source.identity.volume.wrapping_add(1)
        )
        .is_err());
        assert!(!output.join("wrong-volume.js").exists());
        assert!(copy_new(
            &source,
            &digest,
            Path::new("relative-root"),
            "index.js",
            source.identity.volume
        )
        .is_err());
        std::fs::write(output.join("regular-parent"), b"not a directory").unwrap();
        assert!(copy_new(
            &source,
            &digest,
            &output,
            "regular-parent/child.js",
            source.identity.volume
        )
        .is_err());
        assert!(copy_new(
            &source,
            &digest,
            &output,
            "../escape.js",
            source.identity.volume
        )
        .is_err());
        let empty_path = root.join("empty.js");
        std::fs::write(&empty_path, []).unwrap();
        let empty = ToolImageLease::open_source(&empty_path).unwrap();
        let empty_digest = Sha256::digest([])
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let empty_copy = copy_new(
            &empty,
            &empty_digest,
            &output,
            "empty.js",
            empty.identity.volume,
        )
        .unwrap();
        assert_eq!(empty_copy.identity().bytes, 0);
        drop((copied, empty_copy, source, empty));
        assert_eq!(
            std::fs::read(root.join("source-alias.js")).unwrap(),
            b"export default 1"
        );
        trash::delete(root).unwrap();
    }
}
