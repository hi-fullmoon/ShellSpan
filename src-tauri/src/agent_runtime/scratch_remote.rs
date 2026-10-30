//! Credential-backed SFTP provisioning and collection. Never execute cleanup shell text.
use std::path::Path;

use ssh2::{FileStat, Sftp};

use super::{Record, ScratchServices, MAX_TREE_ENTRIES};

fn with_sftp<T>(
    record: &Record,
    services: &ScratchServices<'_>,
    operation: impl FnOnce(&Sftp, &str) -> Result<T, String>,
) -> Result<T, String> {
    let target = super::super::native_adapter::target_native(&record.target)?;
    let connection = super::super::connection_for_remote_target(
        &target,
        services.database,
        services.credentials,
    )?;
    let connected = crate::connection::connect_sftp(&connection, None, Some(services.known_hosts))
        .map_err(|e| format!("scratch SFTP connection failed: {e:?}"))?;
    let connected = connected
        .lock()
        .map_err(|_| "scratch SFTP connection unavailable")?;
    connected.session.set_timeout(1_000);
    let home = connected
        .sftp
        .realpath(Path::new("."))
        .map_err(|e| e.to_string())?;
    let home = home.to_str().ok_or("remote home is not UTF-8")?;
    if !home.starts_with('/') || home == "/" {
        return Err("remote scratch needs a private account home".into());
    }
    operation(&connected.sftp, home)
}

fn paths(home: &str, instance: &str, key: &str) -> (String, String) {
    let base = format!(
        "{}/.shellspan-agent-scratch-{instance}",
        home.trim_end_matches('/')
    );
    let workspace = format!("{base}/{key}");
    (base, workspace)
}

pub(super) fn provision(
    instance: &str,
    key: &str,
    record: &Record,
    services: &ScratchServices<'_>,
) -> Result<String, String> {
    with_sftp(record, services, |sftp, home| {
        let (base, workspace) = paths(home, instance, key);
        let uid = sftp
            .stat(Path::new(home))
            .map_err(|e| e.to_string())?
            .uid
            .ok_or("missing remote owner")?;
        for path in [&base, &workspace, &format!("{workspace}/files")] {
            match sftp.lstat(Path::new(path)) {
                Ok(stat) => private_directory(&stat, uid)?,
                Err(e) if missing(&e) => {
                    sftp.mkdir(Path::new(path), 0o700)
                        .map_err(|e| e.to_string())?;
                    private_directory(
                        &sftp.lstat(Path::new(path)).map_err(|e| e.to_string())?,
                        uid,
                    )?;
                }
                Err(e) => return Err(e.to_string()),
            }
        }
        let root = format!("{workspace}/files");
        if record.remote_root.as_ref().is_some_and(|old| old != &root) {
            return Err("remote scratch home changed; existing files were retained".into());
        }
        Ok(root)
    })
}

pub(super) fn bytes(
    instance: &str,
    record: &Record,
    services: &ScratchServices<'_>,
) -> Result<u64, String> {
    if record.remote_root.is_none() {
        return Ok(0);
    }
    with_sftp(record, services, |sftp, home| {
        let workspace = validate(sftp, home, instance, record)?;
        let Some(workspace) = workspace else {
            return Ok(0);
        };
        let entries = tree(sftp, &workspace)?;
        Ok(entries.iter().fold(0_u64, |total, (_, stat)| {
            total.saturating_add(stat.size.unwrap_or(0))
        }))
    })
}

pub(super) fn cleanup(
    instance: &str,
    record: &Record,
    services: &ScratchServices<'_>,
) -> Result<(), String> {
    if record.remote_root.is_none() {
        return Ok(());
    }
    with_sftp(record, services, |sftp, home| {
        let Some(workspace) = validate(sftp, home, instance, record)? else {
            return Ok(());
        };
        let entries = tree(sftp, &workspace)?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        // Validate the complete tree first. A symlink or special file leaves the
        // workspace pending cleanup instead of following a path outside it.
        for (path, stat) in entries.into_iter().rev() {
            if std::time::Instant::now() >= deadline {
                return Err("remote scratch cleanup deadline exceeded".into());
            }
            if stat.is_dir() {
                sftp.rmdir(Path::new(&path))
            } else {
                sftp.unlink(Path::new(&path))
            }
            .map_err(|e| format!("remote scratch cleanup deferred: {e}"))?;
        }
        Ok(())
    })
}

fn validate(
    sftp: &Sftp,
    home: &str,
    instance: &str,
    record: &Record,
) -> Result<Option<String>, String> {
    let (base, workspace) = paths(home, instance, &record.key);
    if record.remote_root.as_deref() != Some(&format!("{workspace}/files")) {
        return Err("remote scratch ownership mismatch".into());
    }
    let uid = sftp
        .stat(Path::new(home))
        .map_err(|e| e.to_string())?
        .uid
        .ok_or("missing remote owner")?;
    for path in [&base, &workspace] {
        match sftp.lstat(Path::new(path)) {
            Ok(stat) => private_directory(&stat, uid)?,
            Err(e) if missing(&e) => return Ok(None),
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(Some(workspace))
}

fn private_directory(stat: &FileStat, uid: u32) -> Result<(), String> {
    if !stat.is_dir() || stat.uid != Some(uid) || stat.perm.is_none_or(|mode| mode & 0o077 != 0) {
        return Err("remote scratch directory is not private or its owner changed".into());
    }
    Ok(())
}

fn tree(sftp: &Sftp, root: &str) -> Result<Vec<(String, FileStat)>, String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    let mut pending = vec![(root.to_string(), 0)];
    let mut result = Vec::new();
    while let Some((path, depth)) = pending.pop() {
        if std::time::Instant::now() >= deadline {
            return Err("remote scratch inspection deadline exceeded".into());
        }
        if result.len() >= MAX_TREE_ENTRIES || depth > 32 {
            return Err("remote scratch inspection limit exceeded".into());
        }
        let stat = sftp.lstat(Path::new(&path)).map_err(|e| e.to_string())?;
        if stat.is_dir() {
            for (child, _) in sftp.readdir(Path::new(&path)).map_err(|e| e.to_string())? {
                let name = child
                    .file_name()
                    .and_then(|n| n.to_str())
                    .ok_or("invalid remote scratch name")?;
                if matches!(name, "." | "..") {
                    continue;
                }
                if name.contains(['/', '\\']) || name.chars().any(char::is_control) {
                    return Err("unsupported remote scratch filename".into());
                }
                pending.push((format!("{path}/{name}"), depth + 1));
                if pending.len() > MAX_TREE_ENTRIES {
                    return Err("remote scratch inspection limit exceeded".into());
                }
            }
        } else if !stat.is_file() {
            return Err("remote scratch symlink or special file rejected".into());
        }
        result.push((path, stat));
    }
    Ok(result)
}

fn missing(error: &ssh2::Error) -> bool {
    matches!(error.code(), ssh2::ErrorCode::SFTP(2 | 10))
}
