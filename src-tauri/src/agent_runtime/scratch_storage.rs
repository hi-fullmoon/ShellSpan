//! Atomic scratch ownership metadata, shared by the runtime and storage probes.
use std::fs;
use std::io::Write;
use std::path::Path;

use serde::Serialize;

pub(super) fn private_directory(path: &Path) -> Result<(), String> {
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
    inspect_directory(path)
}

pub(super) fn inspect_directory(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
        if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
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
    let parent = path.parent().ok_or("missing scratch metadata parent")?;
    private_directory(parent)?;
    private_directory(staging)?;
    if let Ok(m) = fs::symlink_metadata(path) {
        if m.file_type().is_symlink() || !m.is_file() {
            return Err("unsafe scratch metadata".into());
        }
    }
    let mut temp = tempfile::NamedTempFile::new_in(staging).map_err(|e| e.to_string())?;
    temp.write_all(&serde_json::to_vec(value).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    temp.persist(path).map_err(|e| e.to_string())?;
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

pub(super) fn read_json<T: for<'a> serde::Deserialize<'a>>(path: &Path) -> Result<T, String> {
    let m = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !m.is_file() || m.file_type().is_symlink() || m.len() > 1024 * 1024 {
        return Err("unsafe scratch metadata".into());
    }
    serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}
