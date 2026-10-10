//! EA included in the same native create request as the new object. A stamp
//! is only recovery evidence inside an independently protected ungranted root.
use crate::appcontainer_probe::Handle;
use crate::frontend_bundle_journal::ObjectIdentity;
use std::{
    os::windows::fs::OpenOptionsExt,
    os::windows::io::{AsRawHandle, FromRawHandle},
    path::Path,
    ptr::{null, null_mut},
};
use uuid::Uuid;
use windows_sys::{
    Wdk::{Foundation::OBJECT_ATTRIBUTES, Storage::FileSystem::*},
    Win32::{
        Foundation::{GENERIC_READ, GENERIC_WRITE, HANDLE, UNICODE_STRING},
        Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY,
            FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES, FILE_READ_EA,
            FILE_SHARE_READ, FILE_WRITE_EA,
        },
        System::IO::IO_STATUS_BLOCK,
    },
};
const KEY: &[u8] = b"SHELLSPAN.BUNDLE.OWNERSHIP";
#[derive(Clone, Copy)]
pub enum CreationKind {
    Directory,
    File,
    Alias,
}
pub struct CreationStamp {
    value: Vec<u8>,
    kind: CreationKind,
}
/// Holds the observed entry against replacement until its recovery checkpoint
/// is published. The caller must independently prove the protected namespace.
pub struct ObservedCreation {
    _file: std::fs::File,
    identity: ObjectIdentity,
}
impl ObservedCreation {
    pub fn identity(&self) -> &ObjectIdentity {
        &self.identity
    }
}
impl CreationStamp {
    pub fn observe(&self, path: &Path) -> Result<ObservedCreation, String> {
        let file = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
            .open(path)
            .map_err(|e| format!("creation observation open failed: {e}"))?;
        self.verify(&file)?;
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
            return Err(format!(
                "creation observation identity failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        let directory = info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0;
        let reparse = info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0;
        let kind_matches = match self.kind {
            CreationKind::File => !directory && !reparse && info.nNumberOfLinks == 1,
            CreationKind::Directory => directory && !reparse,
            CreationKind::Alias => directory,
        };
        let identity = ObjectIdentity {
            volume: info.dwVolumeSerialNumber,
            file_id: ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
        };
        if !kind_matches || identity.volume == 0 || identity.file_id == 0 {
            return Err("creation observation type or identity invalid".into());
        }
        Ok(ObservedCreation {
            _file: file,
            identity,
        })
    }
    pub fn new(
        fixture: Uuid,
        index: usize,
        kind: CreationKind,
        inventory_sha256: &str,
        plan_sha256: &str,
    ) -> Result<Self, String> {
        if fixture.is_nil() || index >= 100000 {
            return Err("creation stamp scope invalid".into());
        }
        let decode = |text: &str| -> Result<Vec<u8>, String> {
            if text.len() != 64
                || !text
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            {
                return Err("creation stamp digest invalid".into());
            }
            (0..64)
                .step_by(2)
                .map(|i| {
                    u8::from_str_radix(&text[i..i + 2], 16)
                        .map_err(|_| "creation stamp digest invalid".into())
                })
                .collect()
        };
        let mut value = vec![
            1,
            match kind {
                CreationKind::Directory => 0,
                CreationKind::File => 1,
                CreationKind::Alias => 2,
            },
        ];
        value.extend(fixture.as_bytes());
        value.extend((index as u32).to_le_bytes());
        value.extend(decode(inventory_sha256)?);
        value.extend(decode(plan_sha256)?);
        Ok(Self { value, kind })
    }
    fn ea(&self) -> Vec<u8> {
        let mut bytes = Vec::from(0u32.to_le_bytes());
        bytes.extend([0, KEY.len() as u8]);
        bytes.extend((self.value.len() as u16).to_le_bytes());
        bytes.extend(KEY);
        bytes.push(0);
        bytes.extend(&self.value);
        bytes
    }
    pub fn create_new(&self, path: &Path) -> Result<std::fs::File, String> {
        let text = path.to_str().ok_or("invalid stamped create path")?;
        let text = text.strip_prefix(r"\\?\").unwrap_or(text);
        if !path.is_absolute()
            || text.len() < 3
            || !text.as_bytes()[0].is_ascii_alphabetic()
            || text.as_bytes()[1] != b':'
            || !matches!(text.as_bytes()[2], b'\\' | b'/')
            || text.contains('\0')
        {
            return Err("stamped create requires absolute local drive path".into());
        }
        crate::policy::classify_project_object(&text[3..], false, false, false)?;
        let mut name: Vec<u16> = format!(r"\??\{}", text.replace('/', "\\"))
            .encode_utf16()
            .collect();
        if name.len() > 32766 {
            return Err("stamped native path budget exceeded".into());
        }
        let mut unicode = UNICODE_STRING {
            Length: (name.len() * 2) as u16,
            MaximumLength: (name.len() * 2) as u16,
            Buffer: name.as_mut_ptr(),
        };
        let attributes = OBJECT_ATTRIBUTES {
            Length: std::mem::size_of::<OBJECT_ATTRIBUTES>() as u32,
            ObjectName: &mut unicode,
            Attributes: 0x40,
            ..Default::default()
        };
        let directory = !matches!(self.kind, CreationKind::File);
        let access = if directory {
            FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | FILE_READ_EA | FILE_WRITE_EA | 0x100000
        } else {
            GENERIC_READ | GENERIC_WRITE | 0x100000
        };
        let mut io = IO_STATUS_BLOCK::default();
        let mut raw = null_mut();
        let ea = self.ea();
        let status = unsafe {
            NtCreateFile(
                &mut raw,
                access,
                &attributes,
                &mut io,
                null(),
                FILE_ATTRIBUTE_NORMAL,
                FILE_SHARE_READ,
                FILE_CREATE,
                FILE_SYNCHRONOUS_IO_NONALERT
                    | FILE_OPEN_REPARSE_POINT
                    | if directory {
                        FILE_DIRECTORY_FILE
                    } else {
                        FILE_NON_DIRECTORY_FILE
                    },
                ea.as_ptr().cast(),
                ea.len() as u32,
            )
        };
        if status < 0 {
            return Err(format!(
                "stamped native create: NTSTATUS 0x{:08x}",
                status as u32
            ));
        }
        let handle = Handle(raw);
        if io.Information != 2 {
            return Err("stamped native create did not report FILE_CREATED".into());
        }
        self.verify_raw(handle.0)?;
        let raw = handle.0;
        std::mem::forget(handle);
        Ok(unsafe { std::fs::File::from_raw_handle(raw) })
    }
    pub fn verify(&self, file: &std::fs::File) -> Result<(), String> {
        self.verify_raw(file.as_raw_handle())
    }
    fn verify_raw(&self, handle: HANDLE) -> Result<(), String> {
        let mut filter = Vec::from(0u32.to_le_bytes());
        filter.push(KEY.len() as u8);
        filter.extend(KEY);
        filter.push(0);
        let mut bytes = vec![0u8; 1024];
        let mut io = IO_STATUS_BLOCK::default();
        let status = unsafe {
            NtQueryEaFile(
                handle,
                &mut io,
                bytes.as_mut_ptr().cast(),
                bytes.len() as u32,
                true,
                filter.as_ptr().cast(),
                filter.len() as u32,
                null(),
                true,
            )
        };
        if status < 0 {
            return Err(format!(
                "query creation stamp: NTSTATUS 0x{:08x}",
                status as u32
            ));
        }
        let expected = self.ea();
        if io.Information != expected.len()
            || io.Information > bytes.len()
            || bytes[..io.Information] != expected
        {
            return Err("creation stamp binding differs".into());
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::os::windows::fs::OpenOptionsExt;
    #[test]
    fn native_create_includes_bound_ea_for_files_and_directories_without_overwrite() {
        let root = std::env::temp_dir().join(format!("ShellSpan-atomic-stamp-{}", Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let fixture = Uuid::new_v4();
        for (index, kind, name) in [
            (0, CreationKind::File, "file.js"),
            (1, CreationKind::Directory, "directory"),
            (2, CreationKind::Alias, "alias-placeholder"),
        ] {
            let stamp =
                CreationStamp::new(fixture, index, kind, &"a".repeat(64), &"b".repeat(64)).unwrap();
            let path = root.join(name);
            let mut handle = stamp.create_new(&path).unwrap();
            if matches!(kind, CreationKind::File) {
                handle.write_all(b"native tagged file content").unwrap();
                handle.sync_all().unwrap();
            }
            stamp.verify(&handle).unwrap();
            let wrong =
                CreationStamp::new(fixture, index + 1, kind, &"a".repeat(64), &"b".repeat(64))
                    .unwrap();
            assert!(wrong.verify(&handle).is_err());
            assert!(stamp.create_new(&path).is_err());
            drop(handle);
            assert!(path.exists());
            let reopened = std::fs::OpenOptions::new()
                .read(true)
                .share_mode(FILE_SHARE_READ)
                .custom_flags(
                    windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT
                        | windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS,
                )
                .open(&path)
                .unwrap();
            stamp.verify(&reopened).unwrap();
            let observed = stamp.observe(&path).unwrap();
            assert_ne!(observed.identity().file_id, 0);
            assert_ne!(observed.identity().volume, 0);
            assert!(wrong.observe(&path).is_err());
            assert!(std::fs::rename(&path, root.join("replacement")).is_err());
            drop(observed);
            for altered in [
                CreationStamp::new(
                    Uuid::new_v4(),
                    index,
                    kind,
                    &"a".repeat(64),
                    &"b".repeat(64),
                )
                .unwrap(),
                CreationStamp::new(fixture, index, kind, &"c".repeat(64), &"b".repeat(64)).unwrap(),
                CreationStamp::new(fixture, index, kind, &"a".repeat(64), &"c".repeat(64)).unwrap(),
            ] {
                assert!(altered.verify(&reopened).is_err());
            }
            drop(reopened);
            assert!(stamp.create_new(&path).is_err());
            if matches!(kind, CreationKind::File) {
                assert_eq!(std::fs::read(&path).unwrap(), b"native tagged file content");
            }
        }
        let unstamped_path = root.join("unstamped.js");
        std::fs::write(&unstamped_path, b"unowned object").unwrap();
        let unstamped = std::fs::File::open(&unstamped_path).unwrap();
        let stamp = CreationStamp::new(
            fixture,
            3,
            CreationKind::File,
            &"a".repeat(64),
            &"b".repeat(64),
        )
        .unwrap();
        assert!(stamp.verify(&unstamped).is_err());
        assert!(stamp.observe(&unstamped_path).is_err());
        assert_eq!(std::fs::read(&unstamped_path).unwrap(), b"unowned object");
        assert!(stamp.create_new(&root.join("file.js:stream")).is_err());
        drop(unstamped);
        assert!(CreationStamp::new(
            Uuid::nil(),
            0,
            CreationKind::File,
            &"a".repeat(64),
            &"b".repeat(64)
        )
        .is_err());
        trash::delete(root).unwrap();
    }
}
