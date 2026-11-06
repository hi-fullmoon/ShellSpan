//! Atomic scratch ownership metadata, shared by the runtime and storage probes.
use std::fs;
use std::io::Write;
use std::path::Path;

use serde::Serialize;

// Independent ScratchStore instances can reopen the same metadata. Windows
// replacement must not race our own open readers; keep this I/O gate separate
// from runtime/approval state and retain the bounded retry for external handles.
#[cfg(windows)]
static METADATA_IO_GATE: std::sync::RwLock<()> = std::sync::RwLock::new(());

pub(super) fn private_directory(path: &Path) -> Result<(), String> {
    create_directory(path)?;
    inspect_directory(path)
}

// Terminal integration also uses this parent and may have created it as 0755.
// Session file roots remain private even when their parent is readable.
pub(super) fn temporary_directory(path: &Path) -> Result<(), String> {
    create_directory(path)?;
    inspect_directory_permissions(path, 0o022)
}

fn create_directory(path: &Path) -> Result<(), String> {
    #[allow(unused_mut)]
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    match builder.create(path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e.to_string()),
    }
    Ok(())
}

pub(super) fn inspect_directory(path: &Path) -> Result<(), String> {
    inspect_directory_permissions(path, 0o077)
}

fn inspect_directory_permissions(path: &Path, denied_permissions: u32) -> Result<(), String> {
    #[cfg(not(unix))]
    let _ = denied_permissions;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
        if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & denied_permissions != 0
        {
            return Err("scratch directory permissions or ownership changed".into());
        }
    }
    // Check every ancestor; do not canonicalize a user-controlled symlink away.
    for ancestor in path.ancestors() {
        let m = fs::symlink_metadata(ancestor).map_err(|e| e.to_string())?;
        if m.file_type().is_symlink() || !m.is_dir() {
            return Err("unsafe scratch directory".into());
        }
    }
    Ok(())
}

pub(super) fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    write_json_staged(
        path,
        value,
        path.parent().ok_or("missing scratch metadata parent")?,
    )
}

pub(super) fn write_json_staged(
    path: &Path,
    value: &impl Serialize,
    staging: &Path,
) -> Result<(), String> {
    #[cfg(windows)]
    let _io = METADATA_IO_GATE
        .write()
        .map_err(|_| "scratch metadata I/O gate is unavailable".to_string())?;
    let parent = path.parent().ok_or("missing scratch metadata parent")?;
    private_directory(parent)?;
    private_directory(staging)?;
    inspect_metadata_target(path)?;
    let mut temp = tempfile::NamedTempFile::new_in(staging).map_err(|e| e.to_string())?;
    temp.write_all(&serde_json::to_vec(value).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    persist_metadata(temp, path, staging)?;
    #[cfg(unix)]
    for directory in [parent, staging] {
        fs::File::open(directory)
            .and_then(|file| file.sync_all())
            .map_err(|e| e.to_string())?;
        if staging == parent {
            break;
        }
    }
    Ok(())
}

fn inspect_metadata_target(path: &Path) -> Result<(), String> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("unsafe scratch metadata".into());
        }
    }
    Ok(())
}

#[cfg(not(windows))]
fn persist_metadata(
    temp: tempfile::NamedTempFile,
    path: &Path,
    _staging: &Path,
) -> Result<(), String> {
    temp.persist(path).map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(windows)]
fn persist_metadata(
    mut temp: tempfile::NamedTempFile,
    path: &Path,
    staging: &Path,
) -> Result<(), String> {
    use std::time::{Duration, Instant};

    // Windows replacement can briefly collide with readers/antivirus handles.
    // Reuse the already synced file, keeping the replacement atomic. A bounded
    // retry must never remove the target or clear its access restrictions.
    let deadline = Instant::now() + Duration::from_millis(100);
    loop {
        private_directory(path.parent().ok_or("missing scratch metadata parent")?)?;
        private_directory(staging)?;
        inspect_metadata_target(path)?;
        match temp.persist(path) {
            Ok(_) => return Ok(()),
            Err(error) => {
                if !matches!(error.error.raw_os_error(), Some(5 | 32)) || Instant::now() >= deadline
                {
                    return Err(error.to_string());
                }
                temp = error.file;
                std::thread::sleep(Duration::from_millis(1));
            }
        }
    }
}

pub(super) fn read_json<T: for<'a> serde::Deserialize<'a>>(path: &Path) -> Result<T, String> {
    #[cfg(windows)]
    let _io = METADATA_IO_GATE
        .read()
        .map_err(|_| "scratch metadata I/O gate is unavailable".to_string())?;
    let m = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !m.is_file() || m.file_type().is_symlink() || m.len() > 1024 * 1024 {
        return Err("unsafe scratch metadata".into());
    }
    serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier, Mutex};

    #[test]
    fn atomic_metadata_replacement_survives_concurrent_readers() {
        let directory = tempfile::tempdir().unwrap();
        let path = Arc::new(directory.path().join("ownership.json"));
        write_json(&path, &serde_json::json!({"body":"x".repeat(512)})).unwrap();
        let barrier = Arc::new(Barrier::new(9));
        let writers = Arc::new(Mutex::new(()));
        let workers: Vec<_> = (0..8)
            .map(|worker| {
                let (path, barrier, writers) = (path.clone(), barrier.clone(), writers.clone());
                std::thread::spawn(move || {
                    barrier.wait();
                    for sequence in 0..200 {
                        if worker < 2 {
                            let _writer = writers.lock().unwrap();
                            write_json(
                                &path,
                                &serde_json::json!({"body":"x".repeat(512),"sequence":sequence}),
                            )
                            .unwrap();
                        } else {
                            let value: serde_json::Value = read_json(&path).unwrap();
                            assert_eq!(value["body"].as_str().unwrap().len(), 512);
                        }
                    }
                })
            })
            .collect();
        barrier.wait();
        // Join every reader before dropping the owned directory, even when a
        // writer fails. Otherwise cleanup adds misleading file-not-found errors.
        let outcomes: Vec<_> = workers.into_iter().map(|worker| worker.join()).collect();
        assert!(outcomes.iter().all(Result::is_ok), "metadata worker failed");
    }

    #[test]
    fn metadata_replacement_preserves_a_read_only_target() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("ownership.json");
        write_json(&path, &serde_json::json!({"owner":"original"})).unwrap();
        let permissions = fs::metadata(&path).unwrap().permissions();
        let mut read_only = permissions.clone();
        read_only.set_readonly(true);
        fs::set_permissions(&path, read_only).unwrap();
        let outcome = write_json(&path, &serde_json::json!({"owner":"replacement"}));
        let still_read_only = fs::metadata(&path).unwrap().permissions().readonly();
        let value = read_json::<serde_json::Value>(&path).unwrap();
        fs::set_permissions(&path, permissions).unwrap();
        assert!(outcome.is_err());
        assert!(still_read_only);
        assert_eq!(value["owner"], "original");
    }
}
