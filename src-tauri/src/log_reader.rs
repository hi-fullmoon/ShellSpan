use serde::{Deserialize, Serialize};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
};

const MAX_SIZE: u64 = 2 * 1024 * 1024;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LogCursor {
    identity: String,
    offset: u64,
    anchor: Vec<u8>,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    modified_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LogChunk {
    content: String,
    cursor: LogCursor,
    reset: bool,
    size: u64,
}

pub(crate) fn read_chunk(
    dir: &Path,
    name: &str,
    cursor: Option<LogCursor>,
) -> Result<LogChunk, String> {
    if name.contains(['/', '\\'])
        || !(name.starts_with("frontend") || name.starts_with("backend"))
        || !name.ends_with(".log")
    {
        return Err("invalid log file name".into());
    }
    let path = dir.join(name).canonicalize().map_err(|e| e.to_string())?;
    if path.parent() != Some(dir.canonicalize().map_err(|e| e.to_string())?.as_path()) {
        return Err("log file outside log directory".into());
    }
    read_file(&path, cursor).map_err(|e| e.to_string())
}

fn read_file(path: &Path, cursor: Option<LogCursor>) -> std::io::Result<LogChunk> {
    let mut file = File::open(path)?;
    let metadata = file.metadata()?;
    let size = metadata.len();
    // Keep nanosecond precision without passing integers beyond JavaScript's safe range.
    let modified_at = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos().to_string());
    #[cfg(unix)]
    let identity = {
        use std::os::unix::fs::MetadataExt;
        format!(
            "{}:{}:{:?}",
            metadata.dev(),
            metadata.ino(),
            metadata.created().ok()
        )
    };
    #[cfg(not(unix))]
    let identity = format!("{:?}", metadata.created().ok());
    let mut offset = 0;
    let mut reset = true;
    if let Some(previous) = cursor {
        if previous.identity == identity
            && previous.offset <= size
            && previous.size >= previous.offset
            && previous.size <= size
            // An unchanged length with a new modification time is a rewrite,
            // even if its trailing bytes happen to match (e.g. repeated stack traces).
            && (previous.size < size
                || (modified_at.is_some() && previous.modified_at == modified_at))
            && previous.anchor.len() <= 64
            && previous.anchor.len() as u64 <= previous.offset
        {
            file.seek(SeekFrom::Start(
                previous.offset - previous.anchor.len() as u64,
            ))?;
            let mut anchor = vec![0; previous.anchor.len()];
            file.read_exact(&mut anchor)?;
            if anchor == previous.anchor {
                offset = previous.offset;
                reset = false;
            }
        }
    }
    // Preserve the existing whole-file search/export scope and its 2 MiB bound.
    let end = size.min(MAX_SIZE);
    offset = offset.min(end);
    file.seek(SeekFrom::Start(offset))?;
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(end - offset)
        .read_to_end(&mut bytes)?;
    // Leave a partially written UTF-8 character for the next read.
    let complete = match std::str::from_utf8(&bytes) {
        Err(error) if error.error_len().is_none() => error.valid_up_to(),
        _ => bytes.len(),
    };
    let content = String::from_utf8_lossy(&bytes[..complete]).into_owned();
    offset += complete as u64;
    let anchor_len = offset.min(64);
    file.seek(SeekFrom::Start(offset - anchor_len))?;
    let mut anchor = vec![0; anchor_len as usize];
    file.read_exact(&mut anchor)?;
    Ok(LogChunk {
        content,
        cursor: LogCursor {
            identity,
            offset,
            anchor,
            size,
            modified_at,
        },
        reset,
        size,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn append_idle_truncate_and_rotate() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("frontend.log");
        std::fs::write(&path, "first\n").unwrap();
        let first = read_chunk(dir.path(), "frontend.log", None).unwrap();
        assert!(first.reset);
        assert_eq!(first.content, "first\n");
        let idle = read_file(&path, Some(first.cursor)).unwrap();
        assert!(!idle.reset);
        assert!(idle.content.is_empty());
        let mut writer = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        writer.write_all("中文\n".as_bytes()).unwrap();
        let appended = read_file(&path, Some(idle.cursor)).unwrap();
        assert_eq!(appended.content, "中文\n");
        assert!(!appended.reset);
        std::fs::write(&path, "rewritten and longer\n").unwrap();
        let truncated = read_file(&path, Some(appended.cursor)).unwrap();
        assert!(truncated.reset);
        std::fs::rename(&path, dir.path().join("frontend.old.log")).unwrap();
        std::fs::write(&path, "new\n").unwrap();
        let rotated = read_file(&path, Some(truncated.cursor)).unwrap();
        assert!(rotated.reset);
        assert_eq!(rotated.content, "new\n");
        assert!(read_chunk(dir.path(), "../frontend.log", None).is_err());
    }

    #[test]
    fn incomplete_utf8_is_read_on_next_refresh() {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(&[b'a', 0xe4, 0xb8]).unwrap();
        let first = read_file(file.path(), None).unwrap();
        assert_eq!(first.content, "a");
        file.write_all(&[0xad, b'\n']).unwrap();
        let next = read_file(file.path(), Some(first.cursor)).unwrap();
        assert_eq!(next.content, "中\n");
    }

    #[test]
    fn same_length_rewrite_with_identical_tail_reloads_content() {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        let suffix = "\n    at application::run (src/main.rs:100)\n    at runtime::dispatch (src/runtime.rs:200)\n";
        let before = format!("[2026-09-26][12:00:00][ERROR] old failure{suffix}");
        let after = format!("[2026-09-26][12:00:01][ERROR] new failure{suffix}");
        file.write_all(before.as_bytes()).unwrap();
        file.as_file()
            .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(1))
            .unwrap();
        let first = read_file(file.path(), None).unwrap();
        // Exercise the same cursor round trip as IPC.
        let cursor = serde_json::from_value(serde_json::to_value(&first.cursor).unwrap()).unwrap();
        std::fs::write(file.path(), &after).unwrap();
        let rewritten = read_file(file.path(), Some(cursor)).unwrap();
        assert_eq!(first.size, rewritten.size);
        assert_eq!(first.cursor.anchor, rewritten.cursor.anchor);
        assert_ne!(first.cursor.modified_at, rewritten.cursor.modified_at);
        assert!(rewritten.reset);
        assert_eq!(rewritten.content, after);
        let idle = read_file(file.path(), Some(rewritten.cursor)).unwrap();
        assert!(!idle.reset);
        assert!(idle.content.is_empty());
    }

    #[test]
    fn read_limit_remains_bounded_across_refreshes() {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(&vec![b'x'; MAX_SIZE as usize + 128])
            .unwrap();
        let first = read_file(file.path(), None).unwrap();
        assert_eq!(first.content.len(), MAX_SIZE as usize);
        assert_eq!(first.size, MAX_SIZE + 128);
        file.write_all(b"more\n").unwrap();
        let next = read_file(file.path(), Some(first.cursor)).unwrap();
        assert!(next.content.is_empty());
        assert!(!next.reset);
        assert_eq!(next.cursor.offset, MAX_SIZE);
        file.as_file_mut().set_len(0).unwrap();
        let cleared = read_file(file.path(), Some(next.cursor)).unwrap();
        assert!(cleared.reset);
        assert!(cleared.content.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_outside_log_directory() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("frontend.log")).unwrap();
        assert!(read_chunk(dir.path(), "frontend.log", None).is_err());
    }
}
