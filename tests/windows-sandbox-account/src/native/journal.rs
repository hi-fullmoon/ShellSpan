//! Protected receipt publication. A prepared transition never truncates the last receipt.
use super::*;

pub(super) fn publish(path: &Path, bytes: &[u8], interrupt_before_publish: bool) -> Result<()> {
    if bytes.is_empty() || bytes.len() > 65536 {
        return Err("journal transition exceeds receipt budget".into());
    }
    let parent = path.parent().ok_or("journal parent unavailable")?;
    let held_parent = Handle(unsafe {
        CreateFileW(
            wide(parent.to_str().ok_or("invalid journal parent")?).as_ptr(),
            READ_CONTROL | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    });
    if held_parent.0 == INVALID_HANDLE_VALUE {
        return Err("hold protected journal parent failed".into());
    }
    let mut parent_info = BY_HANDLE_FILE_INFORMATION::default();
    win(
        unsafe { GetFileInformationByHandle(held_parent.0, &mut parent_info) },
        "query held journal parent",
    )?;
    if parent_info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err("journal parent is a reparse point".into());
    }
    recovery::verify_evidence_acl(parent)?;
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if !metadata.is_file() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
            {
                return Err("existing journal target is not a regular owned file".into());
            }
            recovery::verify_evidence_acl(path)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    // Unique create_new prevents adopting an old or attacker-selected pending file.
    // An interrupted pending file remains protected evidence, never recovery authority.
    let pending = parent.join(format!("journal-pending-{}.json", Uuid::new_v4().simple()));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&pending)
        .map_err(|e| e.to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    drop(file);
    recovery::verify_evidence_acl(&pending)?;
    if interrupt_before_publish {
        return Err("fixed journal interruption after flush before publication".into());
    }
    win(
        unsafe {
            MoveFileExW(
                wide(pending.to_str().ok_or("invalid pending journal")?).as_ptr(),
                wide(path.to_str().ok_or("invalid journal target")?).as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        },
        "publish flushed owned journal transition",
    )
}

pub(super) fn diagnose() -> Result<()> {
    if !elevated()? {
        return Err("explicit elevated journal diagnostic required; no resources changed".into());
    }
    let root = fixture_parent()?.join(format!("ShellSpan-journal-A-{}", Uuid::new_v4()));
    protected_fixture(&root)?;
    let path = root.join("journal.json");
    let first = br#"{"revision":1,"production":"unavailable"}"#;
    let second = br#"{"revision":2,"production":"unavailable"}"#;
    publish(&path, first, false)?;
    let interruption = publish(&path, second, true).is_err();
    let retained = fs::read(&path).map_err(|e| e.to_string())? == first;
    if !interruption || !retained {
        return Err("interrupted journal failed to preserve the prior transition".into());
    }
    publish(&path, second, false)?;
    let published = fs::read(&path).map_err(|e| e.to_string())? == second;
    recovery::verify_evidence_acl(&root)?;
    recovery::verify_evidence_acl(&path)?;
    if !published {
        return Err("complete journal transition mismatch".into());
    }
    let untrusted_target = fixture_parent()?.join(format!(
        "ShellSpan-rejected-journal-{}.json",
        Uuid::new_v4().simple()
    ));
    let untrusted_rejected =
        publish(&untrusted_target, first, false).is_err() && !untrusted_target.exists();
    if !untrusted_rejected {
        return Err(
            "untrusted ProgramData parent was admitted; retain exact diagnostic file as debt"
                .into(),
        );
    }
    println!(
        "{}",
        serde_json::json!({"production":"unavailable","fixture":root,"interrupted_before_publication":interruption,"prior_complete_transition_preserved":retained,"next_complete_transition_published":published,"protected_acl_verified":true,"untrusted_parent_rejected_before_write":untrusted_rejected,"accounts_created":false,"filters_installed":false,"retained_as_evidence":true})
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unbounded_transition_is_rejected_before_touching_resources() {
        let target = Path::new("not-a-journal-parent/receipt.json");
        assert!(publish(target, &[], false).unwrap_err().contains("budget"));
        assert!(publish(target, &vec![0; 65537], false)
            .unwrap_err()
            .contains("budget"));
    }
}
