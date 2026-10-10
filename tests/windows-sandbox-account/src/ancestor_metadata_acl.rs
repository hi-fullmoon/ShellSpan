//! Handle-bound incremental metadata ACE operations. Callers must durably
//! publish the fixed intent before apply and retain quarantine until retirement.
use crate::ancestor_metadata_intent::{AncestorObject, MutationState, METADATA_MASK};
use crate::appcontainer_probe::{win, Handle};
use sha2::{Digest, Sha256};
use std::{
    path::Path,
    ptr::{null, null_mut},
};
use windows_sys::Win32::{
    Foundation::*,
    Security::{Authorization::*, *},
    Storage::FileSystem::*,
};

struct Local(*mut std::ffi::c_void);
impl Drop for Local {
    fn drop(&mut self) {
        unsafe { LocalFree(self.0) };
    }
}

pub struct DirectoryLease {
    handle: Handle,
    object: AncestorObject,
}

impl DirectoryLease {
    pub fn open(path: &Path) -> Result<Self, String> {
        let text = path.to_str().ok_or("ancestor path is not Unicode")?;
        if text.contains('\0') {
            return Err("ancestor path contains NUL".into());
        }
        let wide: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
        let raw = unsafe {
            CreateFileW(
                wide.as_ptr(),
                READ_CONTROL | WRITE_DAC | FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                null_mut(),
            )
        };
        if raw == INVALID_HANDLE_VALUE {
            return Err(format!("open ancestor lease: Win32 {}", unsafe {
                GetLastError()
            }));
        }
        let handle = Handle(raw);
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        win(
            unsafe { GetFileInformationByHandle(handle.0, &mut info) },
            "ancestor identity",
        )?;
        if info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
            || info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        {
            return Err("ancestor must be an actual directory, not a reparse point".into());
        }
        let entries = read_acl(handle.0)?;
        let object = AncestorObject {
            path: path.into(),
            volume: info.dwVolumeSerialNumber,
            file_id: (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
            original_dacl_sha256: dacl_digest(handle.0, &entries)?,
        };
        Ok(Self { handle, object })
    }
    pub fn object(&self) -> &AncestorObject {
        &self.object
    }
    /// Complete the whole pair's preflight before publishing any planned delta.
    /// An existing ACE is not ours, even if it has the intended exact mask.
    pub fn verify_fresh(&self, expected: &AncestorObject, package: &str) -> Result<(), String> {
        self.matches(expected)?;
        let entries = read_acl(self.handle.0)?;
        if dacl_digest(self.handle.0, &entries)? != expected.original_dacl_sha256 {
            return Err("ancestor DACL changed before intent publication".into());
        }
        let sid = parse_sid(package)?;
        if package_index(&entries, sid.0)?.is_some() {
            return Err("ancestor preexisting package ACE cannot become owned intent".into());
        }
        Ok(())
    }
    pub fn matches(&self, expected: &AncestorObject) -> Result<(), String> {
        if self.object.path != expected.path
            || self.object.volume != expected.volume
            || self.object.file_id != expected.file_id
        {
            return Err("ancestor object identity changed; retain debt".into());
        }
        Ok(())
    }
    pub fn apply(&self, expected: &AncestorObject, package: &str) -> Result<(), String> {
        self.matches(expected)?;
        let mut entries = read_acl(self.handle.0)?;
        if dacl_digest(self.handle.0, &entries)? != expected.original_dacl_sha256 {
            return Err("ancestor DACL changed before apply; no mutation".into());
        }
        let sid = parse_sid(package)?;
        if package_index(&entries, sid.0)?.is_some() {
            return Err("ancestor package already has an ACE; cannot adopt".into());
        }
        let own = metadata_ace(sid.0)?;
        let index = entries
            .iter()
            .position(|entry| entry[1] & INHERITED_ACE as u8 != 0)
            .unwrap_or(entries.len());
        entries.insert(index, own);
        write_acl(self.handle.0, &entries)?;
        if read_acl(self.handle.0)? != entries {
            return Err("ancestor applied ACL differs; retain debt".into());
        }
        Ok(())
    }
    pub fn retire(&self, expected: &AncestorObject, package: &str) -> Result<(), String> {
        self.matches(expected)?;
        let mut entries = read_acl(self.handle.0)?;
        let sid = parse_sid(package)?;
        if let Some(index) = package_index(&entries, sid.0)? {
            if entries[index] != metadata_ace(sid.0)? {
                return Err(
                    "ancestor package ACE is not the exact owned delta; retain debt".into(),
                );
            }
            entries.remove(index);
            write_acl(self.handle.0, &entries)?;
            if read_acl(self.handle.0)? != entries {
                return Err("ancestor retirement changed unrelated ACL; retain debt".into());
            }
        }
        if package_index(&read_acl(self.handle.0)?, sid.0)?.is_some() {
            return Err("ancestor package permission still present; retain debt".into());
        }
        Ok(())
    }
    pub fn verify_absent(&self, expected: &AncestorObject, package: &str) -> Result<(), String> {
        self.matches(expected)?;
        let sid = parse_sid(package)?;
        if package_index(&read_acl(self.handle.0)?, sid.0)?.is_some() {
            return Err(
                "retired ancestor package ACE reappeared; retain unknown-state debt".into(),
            );
        }
        Ok(())
    }
    /// The publisher must commit to the protected owning journal. Publishing a
    /// planned state precedes mutation; a failed applied checkpoint leaves the
    /// durable planned intent sufficient for exact retirement, never replay.
    pub fn apply_checkpointed(
        &self,
        expected: &AncestorObject,
        package: &str,
        state: &mut MutationState,
        mut publish: impl FnMut(&MutationState) -> Result<(), String>,
    ) -> Result<(), String> {
        if *state != MutationState::Planned {
            return Err("ancestor apply cannot replay a started or retired mutation".into());
        }
        publish(state)?;
        self.apply(expected, package)?;
        *state = MutationState::Applied;
        publish(state)
    }
    pub fn retire_checkpointed(
        &self,
        expected: &AncestorObject,
        package: &str,
        state: &mut MutationState,
        mut publish: impl FnMut(&MutationState) -> Result<(), String>,
    ) -> Result<(), String> {
        if *state == MutationState::Retired {
            return self.verify_absent(expected, package);
        }
        publish(state)?;
        self.retire(expected, package)?;
        *state = MutationState::Retired;
        publish(state)
    }
}

fn parse_sid(package: &str) -> Result<Local, String> {
    let canonical = package.strip_prefix("S-1-15-2-").is_some_and(|tail| {
        let parts: Vec<_> = tail.split('-').collect();
        parts.len() == 7
            && parts.iter().all(|part| {
                part.parse::<u32>()
                    .is_ok_and(|value| value.to_string() == *part)
            })
    });
    if !canonical {
        return Err("metadata ACL requires unique package SID".into());
    }
    let wide: Vec<u16> = package.encode_utf16().chain(Some(0)).collect();
    let mut sid = null_mut();
    win(
        unsafe { ConvertStringSidToSidW(wide.as_ptr(), &mut sid) },
        "metadata package SID",
    )?;
    Ok(Local(sid))
}
fn read_acl(handle: HANDLE) -> Result<Vec<Vec<u8>>, String> {
    let mut acl = null_mut();
    let mut sd = null_mut();
    let status = unsafe {
        GetSecurityInfo(
            handle,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            &mut acl,
            null_mut(),
            &mut sd,
        )
    };
    let _sd = Local(sd);
    if status != 0 || acl.is_null() {
        return Err(format!("ancestor DACL unavailable: {status}"));
    }
    let mut info = ACL_SIZE_INFORMATION::default();
    win(
        unsafe {
            GetAclInformation(
                acl,
                (&mut info as *mut ACL_SIZE_INFORMATION).cast(),
                std::mem::size_of_val(&info) as u32,
                AclSizeInformation,
            )
        },
        "ancestor ACL size",
    )?;
    if info.AclBytesInUse > 65535 || info.AceCount > 1024 {
        return Err("ancestor ACL budget exceeded".into());
    }
    let mut entries = Vec::new();
    for index in 0..info.AceCount {
        let mut raw = null_mut();
        win(unsafe { GetAce(acl, index, &mut raw) }, "ancestor ACE")?;
        let header = unsafe { &*raw.cast::<ACE_HEADER>() };
        if header.AceSize < 8 || !matches!(header.AceType, 0 | 1) {
            return Err("unsupported ancestor ACE shape; no mutation".into());
        }
        entries.push(
            unsafe { std::slice::from_raw_parts(raw.cast::<u8>(), header.AceSize as usize) }
                .to_vec(),
        );
    }
    Ok(entries)
}
fn dacl_digest(handle: HANDLE, entries: &[Vec<u8>]) -> Result<String, String> {
    let mut sd = null_mut();
    let status = unsafe {
        GetSecurityInfo(
            handle,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            null_mut(),
            null_mut(),
            &mut sd,
        )
    };
    let sd = Local(sd);
    if status != 0 || sd.0.is_null() {
        return Err(format!("ancestor descriptor control unavailable: {status}"));
    }
    let mut control = 0;
    let mut revision = 0;
    win(
        unsafe { GetSecurityDescriptorControl(sd.0, &mut control, &mut revision) },
        "ancestor descriptor control",
    )?;
    let mut hash = Sha256::new();
    hash.update(control.to_le_bytes());
    hash.update(revision.to_le_bytes());
    for entry in entries {
        hash.update((entry.len() as u32).to_le_bytes());
        hash.update(entry);
    }
    Ok(hash
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}
fn package_index(entries: &[Vec<u8>], sid: PSID) -> Result<Option<usize>, String> {
    let mut found = None;
    for (index, entry) in entries.iter().enumerate() {
        if entry.len() < 16 {
            return Err("ancestor SID ACE truncated".into());
        }
        let size = 8 + 4 * usize::from(entry[9]);
        if entry.len() != 8 + size {
            return Err("ancestor SID ACE size differs".into());
        }
        let mut aligned = vec![0u32; size.div_ceil(4)];
        unsafe {
            std::ptr::copy_nonoverlapping(
                entry.as_ptr().add(8),
                aligned.as_mut_ptr().cast::<u8>(),
                size,
            )
        };
        let candidate = aligned.as_mut_ptr().cast();
        if unsafe { IsValidSid(candidate) } == 0 {
            return Err("ancestor ACE SID invalid".into());
        }
        if unsafe { EqualSid(candidate, sid) } != 0 {
            if found.is_some() {
                return Err("duplicate ancestor package ACEs; retain debt".into());
            }
            found = Some(index);
        }
    }
    Ok(found)
}
fn metadata_ace(sid: PSID) -> Result<Vec<u8>, String> {
    let sid_len = unsafe { GetLengthSid(sid) } as usize;
    let mut entry = vec![0u8; 8 + sid_len];
    let size = entry.len() as u16;
    entry[2..4].copy_from_slice(&size.to_le_bytes());
    entry[4..8].copy_from_slice(&METADATA_MASK.to_le_bytes());
    unsafe { std::ptr::copy_nonoverlapping(sid.cast::<u8>(), entry.as_mut_ptr().add(8), sid_len) };
    Ok(entry)
}
fn write_acl(handle: HANDLE, entries: &[Vec<u8>]) -> Result<(), String> {
    let size = std::mem::size_of::<ACL>() + entries.iter().map(Vec::len).sum::<usize>();
    if size > 65535 {
        return Err("ancestor merged ACL exceeds budget".into());
    }
    let mut buffer = vec![0u32; size.div_ceil(4)];
    let acl = buffer.as_mut_ptr().cast::<ACL>();
    win(
        unsafe { InitializeAcl(acl, size as u32, ACL_REVISION) },
        "initialize ancestor ACL",
    )?;
    for entry in entries {
        win(
            unsafe {
                AddAce(
                    acl,
                    ACL_REVISION,
                    u32::MAX,
                    entry.as_ptr().cast_mut().cast(),
                    entry.len() as u32,
                )
            },
            "preserve ancestor ACE",
        )?;
    }
    let status = unsafe {
        SetSecurityInfo(
            handle,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            acl,
            null(),
        )
    };
    if status != 0 {
        return Err(format!("ancestor incremental ACL update: {status}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;
    #[test]
    fn actual_prepublication_check_refuses_existing_delta_even_with_matching_snapshot() {
        let root = std::env::temp_dir().join(format!("ShellSpan-AC-{}", Uuid::new_v4().simple()));
        std::fs::create_dir(&root).unwrap();
        let lease = DirectoryLease::open(&root).unwrap();
        let package = crate::package_network_intent::expected_package_sid(Uuid::new_v4()).unwrap();
        lease.verify_fresh(lease.object(), &package).unwrap();
        lease.apply(lease.object(), &package).unwrap();
        // A freshly frozen matching DACL includes this unrelated preexisting ACE.
        let second = DirectoryLease::open(&root).unwrap();
        let before = read_acl(second.handle.0).unwrap();
        assert!(second
            .verify_fresh(second.object(), &package)
            .unwrap_err()
            .contains("preexisting"));
        assert_eq!(read_acl(second.handle.0).unwrap(), before);
        lease.retire(lease.object(), &package).unwrap();
        drop(second);
        drop(lease);
        trash::delete(root).unwrap();
        assert!(DirectoryLease::open(Path::new("C:\\ProgramData\0other")).is_err());
    }
    #[test]
    fn actual_journal_failures_block_mutation_and_preserve_uncheckpointed_recovery() {
        let root = std::env::temp_dir().join(format!("ShellSpan-AC-{}", Uuid::new_v4().simple()));
        std::fs::create_dir(&root).unwrap();
        let lease = DirectoryLease::open(&root).unwrap();
        let original = read_acl(lease.handle.0).unwrap();
        let package = crate::package_network_intent::expected_package_sid(Uuid::new_v4()).unwrap();
        let mut state = MutationState::Planned;
        assert!(lease
            .apply_checkpointed(&lease.object, &package, &mut state, |_| Err(
                "journal unavailable".into()
            ))
            .is_err());
        assert_eq!(read_acl(lease.handle.0).unwrap(), original);
        assert_eq!(state, MutationState::Planned);
        let mut durable = MutationState::Planned;
        assert!(lease
            .apply_checkpointed(&lease.object, &package, &mut state, |checkpoint| {
                if *checkpoint == MutationState::Applied {
                    return Err("post-apply journal unavailable".into());
                }
                durable = checkpoint.clone();
                Ok(())
            })
            .is_err());
        assert_eq!(durable, MutationState::Planned);
        assert_eq!(state, MutationState::Applied);
        // Restore from the durable pre-mutation record; recover, never reapply.
        state = durable.clone();
        assert!(lease
            .retire_checkpointed(&lease.object, &package, &mut state, |checkpoint| {
                if *checkpoint == MutationState::Retired {
                    return Err("post-retire journal unavailable".into());
                }
                Ok(())
            })
            .is_err());
        assert_eq!(read_acl(lease.handle.0).unwrap(), original);
        state = durable;
        lease
            .retire_checkpointed(&lease.object, &package, &mut state, |_| Ok(()))
            .unwrap();
        assert_eq!(state, MutationState::Retired);
        // A retired checkpoint cannot authorize deleting a reappeared grant.
        lease.apply(&lease.object, &package).unwrap();
        let reappeared = read_acl(lease.handle.0).unwrap();
        assert!(lease
            .retire_checkpointed(&lease.object, &package, &mut state, |_| Ok(()))
            .is_err());
        assert_eq!(read_acl(lease.handle.0).unwrap(), reappeared);
        lease.retire(&lease.object, &package).unwrap();
        drop(lease);
        trash::delete(root).unwrap();
    }

    #[test]
    fn actual_owned_directory_incremental_retirement_preserves_concurrent_unrelated_ace() {
        let root = std::env::temp_dir().join(format!("ShellSpan-AC-{}", Uuid::new_v4().simple()));
        std::fs::create_dir(&root).unwrap();
        let lease = DirectoryLease::open(&root).unwrap();
        let original = read_acl(lease.handle.0).unwrap();
        let package = crate::package_network_intent::expected_package_sid(Uuid::new_v4()).unwrap();
        lease.apply(&lease.object, &package).unwrap();
        assert!(lease.apply(&lease.object, &package).is_err());
        let other = crate::package_network_intent::expected_package_sid(Uuid::new_v4()).unwrap();
        let other_sid = parse_sid(&other).unwrap();
        let other_ace = metadata_ace(other_sid.0).unwrap();
        let mut changed = read_acl(lease.handle.0).unwrap();
        let index = changed
            .iter()
            .position(|entry| entry[1] & INHERITED_ACE as u8 != 0)
            .unwrap_or(changed.len());
        changed.insert(index, other_ace.clone());
        write_acl(lease.handle.0, &changed).unwrap();
        lease.retire(&lease.object, &package).unwrap();
        let mut expected = original.clone();
        let index = expected
            .iter()
            .position(|entry| entry[1] & INHERITED_ACE as u8 != 0)
            .unwrap_or(expected.len());
        expected.insert(index, other_ace);
        assert_eq!(read_acl(lease.handle.0).unwrap(), expected);
        lease.retire(&lease.object, &package).unwrap();
        lease.retire(&lease.object, &other).unwrap();
        assert_eq!(read_acl(lease.handle.0).unwrap(), original);
        drop(lease);
        trash::delete(root).unwrap();
    }

    #[test]
    fn actual_owned_directory_rejects_changed_identity_and_unknown_package_delta() {
        let root = std::env::temp_dir().join(format!("ShellSpan-AC-{}", Uuid::new_v4().simple()));
        std::fs::create_dir(&root).unwrap();
        let lease = DirectoryLease::open(&root).unwrap();
        let original = read_acl(lease.handle.0).unwrap();
        let package = crate::package_network_intent::expected_package_sid(Uuid::new_v4()).unwrap();
        let mut wrong = lease.object.clone();
        wrong.file_id += 1;
        assert!(lease.apply(&wrong, &package).is_err());
        assert!(lease.retire(&wrong, &package).is_err());
        wrong = lease.object.clone();
        wrong.original_dacl_sha256 = "0".repeat(64);
        assert!(lease.apply(&wrong, &package).is_err());
        assert_eq!(read_acl(lease.handle.0).unwrap(), original);
        lease.apply(&lease.object, &package).unwrap();
        let sid = parse_sid(&package).unwrap();
        let mut changed = read_acl(lease.handle.0).unwrap();
        let index = package_index(&changed, sid.0).unwrap().unwrap();
        changed[index][4..8].copy_from_slice(&(METADATA_MASK | FILE_LIST_DIRECTORY).to_le_bytes());
        write_acl(lease.handle.0, &changed).unwrap();
        assert!(lease.retire(&lease.object, &package).is_err());
        assert_eq!(read_acl(lease.handle.0).unwrap(), changed);
        changed[index] = metadata_ace(sid.0).unwrap();
        write_acl(lease.handle.0, &changed).unwrap();
        lease.retire(&lease.object, &package).unwrap();
        assert_eq!(read_acl(lease.handle.0).unwrap(), original);
        drop(lease);
        trash::delete(root).unwrap();
    }
}
