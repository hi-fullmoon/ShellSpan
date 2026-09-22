//! Deterministic, bounded file-tree packaging for Deployment Workflow.
//!
//! Paths in a workflow are untrusted. This module never follows links, never
//! accepts special files, and revalidates every archive entry before extraction.

use super::node_executor::NodeFailure;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use tokio_util::sync::CancellationToken;

pub(crate) const FILE_TREE_COMPONENT_NAME: &str = "file-tree.tar.zst";
pub(crate) const FILE_TREE_MEDIA_TYPE: &str = "application/vnd.shellspan.file-tree.tar+zstd";
pub(crate) const MAX_FILE_TREE_ENTRIES: usize = 50_000;
pub(crate) const MAX_FILE_TREE_DEPTH: usize = 64;
pub(crate) const MAX_FILE_TREE_SINGLE_FILE_BYTES: u64 = 512 * 1024 * 1024;
pub(crate) const MAX_FILE_TREE_TOTAL_BYTES: u64 = 4 * 1024 * 1024 * 1024;
pub(crate) const MAX_FILE_TREE_ARCHIVE_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_NORMALIZED_PATH_BYTES: usize = 512;
const MAX_COMPRESSION_RATIO: u64 = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FileTreeEntryKind {
    Directory,
    File,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FileTreeEntry {
    pub path: String,
    pub kind: FileTreeEntryKind,
    pub size: u64,
    pub mode: u32,
    pub digest: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FileTreeArchiveSummary {
    pub digest: String,
    pub size: u64,
    pub file_count: u32,
    pub directory_count: u32,
    pub unpacked_size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ExtractedFileTree {
    pub entries: Vec<FileTreeEntry>,
    pub file_count: u32,
    pub directory_count: u32,
    pub total_size: u64,
}

#[derive(Debug, Clone)]
struct SourceEntry {
    source: PathBuf,
    archived_path: String,
    kind: FileTreeEntryKind,
    size: u64,
    mode: u32,
}

fn failure(category: &str, message: impl Into<String>) -> NodeFailure {
    NodeFailure::definite(category, message)
}

fn digest_hex(bytes: impl AsRef<[u8]>) -> String {
    bytes
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn digest_reader(mut reader: impl Read) -> Result<(String, u64), NodeFailure> {
    let mut hasher = Sha256::new();
    let mut total = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|error| failure("artifactIo", error.to_string()))?;
        if count == 0 {
            break;
        }
        total = total
            .checked_add(count as u64)
            .ok_or_else(|| failure("artifactLimit", "file size overflow"))?;
        hasher.update(&buffer[..count]);
    }
    Ok((format!("sha256:{}", digest_hex(hasher.finalize())), total))
}

pub(crate) fn digest_file(path: &Path) -> Result<(String, u64), NodeFailure> {
    let metadata =
        fs::symlink_metadata(path).map_err(|error| failure("artifactIo", error.to_string()))?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
        return Err(failure(
            "unsafeFileType",
            "artifact member must be a regular file",
        ));
    }
    if metadata.len() > MAX_FILE_TREE_SINGLE_FILE_BYTES {
        return Err(failure(
            "artifactLimit",
            "artifact member exceeds the single-file limit",
        ));
    }
    let file = File::open(path).map_err(|error| failure("artifactIo", error.to_string()))?;
    digest_reader(file)
}

pub(crate) fn normalize_archive_path(path: &Path) -> Result<String, NodeFailure> {
    if path.as_os_str().is_empty() || path.is_absolute() {
        return Err(failure(
            "pathTraversal",
            "archive path must be a non-empty relative path",
        ));
    }
    let mut parts = Vec::new();
    for component in path.components() {
        let Component::Normal(component) = component else {
            return Err(failure(
                "pathTraversal",
                "archive path contains a non-normal component",
            ));
        };
        let component = component
            .to_str()
            .ok_or_else(|| failure("pathEncoding", "archive path must be valid UTF-8"))?;
        if component.is_empty()
            || component.contains('\\')
            || component.chars().any(char::is_control)
        {
            return Err(failure(
                "pathTraversal",
                "archive path contains an unsafe component",
            ));
        }
        parts.push(component);
    }
    if parts.is_empty() || parts.len() > MAX_FILE_TREE_DEPTH {
        return Err(failure(
            "artifactLimit",
            "archive path exceeds the depth limit",
        ));
    }
    let normalized = parts.join("/");
    if normalized.len() > MAX_NORMALIZED_PATH_BYTES {
        return Err(failure(
            "artifactLimit",
            "archive path exceeds the length limit",
        ));
    }
    Ok(normalized)
}

fn source_mode(_metadata: &fs::Metadata, directory: bool) -> u32 {
    if directory {
        return 0o755;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if _metadata.permissions().mode() & 0o111 != 0 {
            return 0o755;
        }
    }
    0o644
}

fn scan_member(
    source: &Path,
    archived: &Path,
    entries: &mut Vec<SourceEntry>,
    seen: &mut BTreeSet<String>,
    total_size: &mut u64,
    cancellation: &CancellationToken,
) -> Result<(), NodeFailure> {
    if cancellation.is_cancelled() {
        return Err(NodeFailure::canceled());
    }
    let metadata =
        fs::symlink_metadata(source).map_err(|error| failure("artifactIo", error.to_string()))?;
    if metadata.file_type().is_symlink() {
        return Err(failure(
            "symlinkRejected",
            "symbolic links are not supported in file-tree artifacts",
        ));
    }
    let normalized = normalize_archive_path(archived)?;
    if !seen.insert(normalized.clone()) {
        return Err(failure(
            "duplicatePath",
            format!("duplicate file-tree path '{normalized}'"),
        ));
    }
    if entries.len() >= MAX_FILE_TREE_ENTRIES {
        return Err(failure(
            "artifactLimit",
            "file-tree entry count exceeds the limit",
        ));
    }
    if metadata.is_dir() {
        entries.push(SourceEntry {
            source: source.to_path_buf(),
            archived_path: normalized,
            kind: FileTreeEntryKind::Directory,
            size: 0,
            mode: source_mode(&metadata, true),
        });
        let mut children = fs::read_dir(source)
            .map_err(|error| failure("artifactIo", error.to_string()))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| failure("artifactIo", error.to_string()))?;
        children.sort_by_key(|child| child.file_name());
        for child in children {
            scan_member(
                &child.path(),
                &archived.join(child.file_name()),
                entries,
                seen,
                total_size,
                cancellation,
            )?;
        }
    } else if metadata.is_file() {
        if metadata.len() > MAX_FILE_TREE_SINGLE_FILE_BYTES {
            return Err(failure(
                "artifactLimit",
                "file-tree member exceeds the single-file limit",
            ));
        }
        *total_size = total_size
            .checked_add(metadata.len())
            .ok_or_else(|| failure("artifactLimit", "file-tree size overflow"))?;
        if *total_size > MAX_FILE_TREE_TOTAL_BYTES {
            return Err(failure(
                "artifactLimit",
                "file-tree exceeds the total unpacked-size limit",
            ));
        }
        entries.push(SourceEntry {
            source: source.to_path_buf(),
            archived_path: normalized,
            kind: FileTreeEntryKind::File,
            size: metadata.len(),
            mode: source_mode(&metadata, false),
        });
    } else {
        return Err(failure(
            "unsafeFileType",
            "device files, sockets, FIFOs, and other special files are rejected",
        ));
    }
    Ok(())
}

fn collect_source_entries(
    source_root: &Path,
    relative_paths: &[String],
    cancellation: &CancellationToken,
) -> Result<(Vec<SourceEntry>, u64), NodeFailure> {
    if relative_paths.is_empty() || relative_paths.len() > 32 {
        return Err(failure(
            "artifactLimit",
            "file-tree sources must contain between 1 and 32 paths",
        ));
    }
    let canonical_root = fs::canonicalize(source_root)
        .map_err(|error| failure("pathBoundary", error.to_string()))?;
    let mut entries = Vec::new();
    let mut seen = BTreeSet::new();
    let mut total_size = 0_u64;
    let strip_single_directory = relative_paths.len() == 1;
    for relative in relative_paths {
        let normalized = normalize_archive_path(Path::new(relative))?;
        let source = canonical_root.join(&normalized);
        let metadata = fs::symlink_metadata(&source)
            .map_err(|error| failure("pathBoundary", error.to_string()))?;
        if metadata.file_type().is_symlink() {
            return Err(failure("symlinkRejected", "source path is a symbolic link"));
        }
        let canonical = fs::canonicalize(&source)
            .map_err(|error| failure("pathBoundary", error.to_string()))?;
        if !canonical.starts_with(&canonical_root) {
            return Err(failure(
                "pathBoundary",
                "file-tree source escapes the frozen workspace",
            ));
        }
        if strip_single_directory && metadata.is_dir() {
            let mut children = fs::read_dir(&canonical)
                .map_err(|error| failure("artifactIo", error.to_string()))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| failure("artifactIo", error.to_string()))?;
            children.sort_by_key(|child| child.file_name());
            for child in children {
                scan_member(
                    &child.path(),
                    Path::new(&child.file_name()),
                    &mut entries,
                    &mut seen,
                    &mut total_size,
                    cancellation,
                )?;
            }
        } else {
            scan_member(
                &canonical,
                Path::new(&normalized),
                &mut entries,
                &mut seen,
                &mut total_size,
                cancellation,
            )?;
        }
    }
    if entries.is_empty() {
        return Err(failure("emptyArtifact", "file-tree artifact is empty"));
    }
    entries.sort_by(|left, right| left.archived_path.cmp(&right.archived_path));
    Ok((entries, total_size))
}

pub(crate) fn create_deterministic_file_tree(
    source_root: &Path,
    relative_paths: &[String],
    destination: &Path,
    cancellation: &CancellationToken,
) -> Result<FileTreeArchiveSummary, NodeFailure> {
    let (entries, unpacked_size) =
        collect_source_entries(source_root, relative_paths, cancellation)?;
    let output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|error| failure("artifactIo", error.to_string()))?;
    let mut encoder = zstd::stream::write::Encoder::new(output, 3)
        .map_err(|error| failure("artifactCompression", error.to_string()))?;
    encoder
        .include_checksum(true)
        .map_err(|error| failure("artifactCompression", error.to_string()))?;
    let mut archive = tar::Builder::new(encoder);
    archive.mode(tar::HeaderMode::Deterministic);
    let mut file_count = 0_u32;
    let mut directory_count = 0_u32;
    for entry in &entries {
        if cancellation.is_cancelled() {
            return Err(NodeFailure::canceled());
        }
        let mut header = tar::Header::new_gnu();
        header.set_uid(0);
        header.set_gid(0);
        header.set_mtime(0);
        header.set_mode(entry.mode);
        header.set_size(entry.size);
        match entry.kind {
            FileTreeEntryKind::Directory => {
                header.set_entry_type(tar::EntryType::Directory);
                header.set_cksum();
                archive
                    .append_data(&mut header, &entry.archived_path, io::empty())
                    .map_err(|error| failure("artifactArchive", error.to_string()))?;
                directory_count = directory_count.saturating_add(1);
            }
            FileTreeEntryKind::File => {
                header.set_entry_type(tar::EntryType::Regular);
                header.set_cksum();
                let file = File::open(&entry.source)
                    .map_err(|error| failure("artifactIo", error.to_string()))?;
                archive
                    .append_data(&mut header, &entry.archived_path, file)
                    .map_err(|error| failure("artifactArchive", error.to_string()))?;
                file_count = file_count.saturating_add(1);
            }
        }
    }
    let encoder = archive
        .into_inner()
        .map_err(|error| failure("artifactArchive", error.to_string()))?;
    let mut output = encoder
        .finish()
        .map_err(|error| failure("artifactCompression", error.to_string()))?;
    output
        .flush()
        .and_then(|_| output.sync_all())
        .map_err(|error| failure("artifactIo", error.to_string()))?;
    let (digest, size) = digest_file(destination)?;
    if size > MAX_FILE_TREE_ARCHIVE_BYTES {
        return Err(failure(
            "artifactLimit",
            "file-tree archive exceeds the compressed-size limit",
        ));
    }
    Ok(FileTreeArchiveSummary {
        digest,
        size,
        file_count,
        directory_count,
        unpacked_size,
    })
}

fn safe_destination(root: &Path, normalized: &str) -> Result<PathBuf, NodeFailure> {
    let destination = root.join(normalized);
    if !destination.starts_with(root) {
        return Err(failure(
            "pathTraversal",
            "archive destination escapes the extraction root",
        ));
    }
    Ok(destination)
}

fn set_normalized_permissions(path: &Path, mode: u32) -> Result<(), NodeFailure> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(mode))
            .map_err(|error| failure("artifactIo", error.to_string()))?;
    }
    #[cfg(not(unix))]
    let _ = (path, mode);
    Ok(())
}

pub(crate) fn extract_verified_file_tree(
    archive_path: &Path,
    destination: &Path,
    cancellation: &CancellationToken,
) -> Result<ExtractedFileTree, NodeFailure> {
    let archive_metadata = fs::symlink_metadata(archive_path)
        .map_err(|error| failure("artifactIo", error.to_string()))?;
    if archive_metadata.file_type().is_symlink()
        || !archive_metadata.file_type().is_file()
        || archive_metadata.len() > MAX_FILE_TREE_ARCHIVE_BYTES
    {
        return Err(failure("artifactLimit", "invalid file-tree archive"));
    }
    fs::create_dir(destination).map_err(|error| failure("artifactIo", error.to_string()))?;
    let canonical_destination =
        fs::canonicalize(destination).map_err(|error| failure("artifactIo", error.to_string()))?;
    let file =
        File::open(archive_path).map_err(|error| failure("artifactIo", error.to_string()))?;
    let mut decoder = zstd::stream::read::Decoder::new(file)
        .map_err(|error| failure("artifactCompression", error.to_string()))?;
    decoder
        .window_log_max(27)
        .map_err(|error| failure("compressionBomb", error.to_string()))?;
    let mut archive = tar::Archive::new(decoder);
    let entries = archive
        .entries()
        .map_err(|error| failure("artifactArchive", error.to_string()))?;
    let mut seen = BTreeSet::new();
    let mut extracted = Vec::new();
    let mut file_count = 0_u32;
    let mut directory_count = 0_u32;
    let mut total_size = 0_u64;
    for entry in entries {
        if cancellation.is_cancelled() {
            return Err(NodeFailure::canceled());
        }
        if extracted.len() >= MAX_FILE_TREE_ENTRIES {
            return Err(failure(
                "artifactLimit",
                "archive entry count exceeds the limit",
            ));
        }
        let mut entry = entry.map_err(|error| failure("artifactArchive", error.to_string()))?;
        let entry_type = entry.header().entry_type();
        if !entry_type.is_file() && !entry_type.is_dir() {
            return Err(failure(
                "unsafeFileType",
                "archive contains a link, device, FIFO, or other special entry",
            ));
        }
        let raw_path = entry
            .path()
            .map_err(|error| failure("pathEncoding", error.to_string()))?;
        let normalized = normalize_archive_path(raw_path.as_ref())?;
        if !seen.insert(normalized.clone()) {
            return Err(failure(
                "duplicatePath",
                "archive contains a duplicate path",
            ));
        }
        let declared_size = entry
            .header()
            .size()
            .map_err(|error| failure("artifactArchive", error.to_string()))?;
        if declared_size > MAX_FILE_TREE_SINGLE_FILE_BYTES {
            return Err(failure(
                "artifactLimit",
                "archive member exceeds the single-file limit",
            ));
        }
        total_size = total_size
            .checked_add(declared_size)
            .ok_or_else(|| failure("artifactLimit", "archive size overflow"))?;
        if total_size > MAX_FILE_TREE_TOTAL_BYTES {
            return Err(failure(
                "compressionBomb",
                "archive exceeds the total unpacked-size limit",
            ));
        }
        let destination_path = safe_destination(&canonical_destination, &normalized)?;
        if entry_type.is_dir() {
            fs::create_dir_all(&destination_path)
                .map_err(|error| failure("artifactIo", error.to_string()))?;
            set_normalized_permissions(&destination_path, 0o755)?;
            extracted.push(FileTreeEntry {
                path: normalized,
                kind: FileTreeEntryKind::Directory,
                size: 0,
                mode: 0o755,
                digest: None,
            });
            directory_count = directory_count.saturating_add(1);
            continue;
        }
        if let Some(parent) = destination_path.parent() {
            fs::create_dir_all(parent).map_err(|error| failure("artifactIo", error.to_string()))?;
        }
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&destination_path)
            .map_err(|error| failure("artifactIo", error.to_string()))?;
        let mut hasher = Sha256::new();
        let mut written = 0_u64;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            if cancellation.is_cancelled() {
                return Err(NodeFailure::canceled());
            }
            let count = entry
                .read(&mut buffer)
                .map_err(|error| failure("artifactArchive", error.to_string()))?;
            if count == 0 {
                break;
            }
            written = written
                .checked_add(count as u64)
                .ok_or_else(|| failure("artifactLimit", "archive member size overflow"))?;
            if written > declared_size || written > MAX_FILE_TREE_SINGLE_FILE_BYTES {
                return Err(failure(
                    "compressionBomb",
                    "archive member exceeded its declared or allowed size",
                ));
            }
            hasher.update(&buffer[..count]);
            output
                .write_all(&buffer[..count])
                .map_err(|error| failure("artifactIo", error.to_string()))?;
        }
        if written != declared_size {
            return Err(failure(
                "artifactArchive",
                "archive member size does not match its header",
            ));
        }
        output
            .flush()
            .map_err(|error| failure("artifactIo", error.to_string()))?;
        let header_mode = entry.header().mode().unwrap_or(0o644);
        let mode = if header_mode & 0o111 != 0 {
            0o755
        } else {
            0o644
        };
        set_normalized_permissions(&destination_path, mode)?;
        extracted.push(FileTreeEntry {
            path: normalized,
            kind: FileTreeEntryKind::File,
            size: written,
            mode,
            digest: Some(format!("sha256:{}", digest_hex(hasher.finalize()))),
        });
        file_count = file_count.saturating_add(1);
    }
    if extracted.is_empty() {
        return Err(failure("emptyArtifact", "file-tree archive is empty"));
    }
    extracted.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(ExtractedFileTree {
        entries: extracted,
        file_count,
        directory_count,
        total_size,
    })
}

pub(crate) fn validate_zip_archive(path: &Path) -> Result<(), NodeFailure> {
    let metadata =
        fs::symlink_metadata(path).map_err(|error| failure("artifactIo", error.to_string()))?;
    if metadata.file_type().is_symlink()
        || !metadata.file_type().is_file()
        || metadata.len() > MAX_FILE_TREE_ARCHIVE_BYTES
    {
        return Err(failure("artifactLimit", "invalid zip artifact"));
    }
    let file = File::open(path).map_err(|error| failure("artifactIo", error.to_string()))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|error| failure("artifactArchive", error.to_string()))?;
    if archive.is_empty() || archive.len() > MAX_FILE_TREE_ENTRIES {
        return Err(failure(
            "artifactLimit",
            "zip entry count is outside the allowed range",
        ));
    }
    let mut seen = BTreeSet::new();
    let mut total = 0_u64;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| failure("artifactArchive", error.to_string()))?;
        let normalized = normalize_archive_path(Path::new(entry.name()))?;
        if !seen.insert(normalized) {
            return Err(failure("duplicatePath", "zip contains a duplicate path"));
        }
        if entry
            .unix_mode()
            .is_some_and(|mode| !matches!(mode & 0o170000, 0 | 0o040000 | 0o100000))
        {
            return Err(failure(
                "unsafeFileType",
                "zip contains a link or special file",
            ));
        }
        let size = entry.size();
        if size > MAX_FILE_TREE_SINGLE_FILE_BYTES {
            return Err(failure(
                "artifactLimit",
                "zip member exceeds the single-file limit",
            ));
        }
        total = total
            .checked_add(size)
            .ok_or_else(|| failure("artifactLimit", "zip size overflow"))?;
        if total > MAX_FILE_TREE_TOTAL_BYTES {
            return Err(failure(
                "compressionBomb",
                "zip exceeds the total unpacked-size limit",
            ));
        }
        let compressed = entry.compressed_size();
        if size > 1024 * 1024
            && (compressed == 0 || size > compressed.saturating_mul(MAX_COMPRESSION_RATIO))
        {
            return Err(failure(
                "compressionBomb",
                "zip member exceeds the compression-ratio limit",
            ));
        }
        let mut read = 0_u64;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let count = entry
                .read(&mut buffer)
                .map_err(|error| failure("artifactArchive", error.to_string()))?;
            if count == 0 {
                break;
            }
            read = read
                .checked_add(count as u64)
                .ok_or_else(|| failure("artifactLimit", "zip member size overflow"))?;
            if read > size || read > MAX_FILE_TREE_SINGLE_FILE_BYTES {
                return Err(failure(
                    "compressionBomb",
                    "zip member expanded beyond its bounded size",
                ));
            }
        }
        if read != size {
            return Err(failure(
                "artifactArchive",
                "zip member size does not match its descriptor",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn write_file(path: &Path, bytes: &[u8]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, bytes).unwrap();
    }

    fn malicious_tar(path: &Path, name: &[u8], entry_type: tar::EntryType, size: u64) {
        let file = File::create(path).unwrap();
        let mut encoder = zstd::stream::write::Encoder::new(file, 3).unwrap();
        let mut header = tar::Header::new_gnu();
        header.set_size(size);
        header.set_mode(0o644);
        header.set_entry_type(entry_type);
        header.as_mut_bytes()[..name.len()].copy_from_slice(name);
        header.set_cksum();
        encoder.write_all(header.as_bytes()).unwrap();
        encoder.write_all(&[0_u8; 1024]).unwrap();
        encoder.finish().unwrap();
    }

    #[test]
    fn deterministic_file_tree_ignores_root_and_mtime() {
        let left = tempfile::tempdir().unwrap();
        let right = tempfile::tempdir().unwrap();
        write_file(&left.path().join("dist/index.html"), b"hello\n");
        write_file(&left.path().join("dist/assets/app.js"), b"app\n");
        write_file(&right.path().join("dist/assets/app.js"), b"app\n");
        write_file(&right.path().join("dist/index.html"), b"hello\n");
        let left_archive = left.path().join("left.tar.zst");
        let right_archive = right.path().join("right.tar.zst");
        let left_summary = create_deterministic_file_tree(
            left.path(),
            &["dist".into()],
            &left_archive,
            &CancellationToken::new(),
        )
        .unwrap();
        let right_summary = create_deterministic_file_tree(
            right.path(),
            &["dist".into()],
            &right_archive,
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(left_summary, right_summary);
        assert_eq!(
            fs::read(left_archive).unwrap(),
            fs::read(right_archive).unwrap()
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_rejected_without_following_them() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        write_file(&root.path().join("outside.txt"), b"outside");
        fs::create_dir(root.path().join("dist")).unwrap();
        symlink("../outside.txt", root.path().join("dist/link")).unwrap();
        let error = create_deterministic_file_tree(
            root.path(),
            &["dist".into()],
            &root.path().join("archive.tar.zst"),
            &CancellationToken::new(),
        )
        .unwrap_err();
        assert_eq!(error.category, "symlinkRejected");
    }

    #[test]
    fn tar_traversal_devices_and_declared_bombs_are_rejected() {
        let root = tempfile::tempdir().unwrap();
        for (name, kind, size, expected) in [
            (
                b"../escape".as_slice(),
                tar::EntryType::Regular,
                0,
                "pathTraversal",
            ),
            (
                b"device".as_slice(),
                tar::EntryType::Block,
                0,
                "unsafeFileType",
            ),
            (
                b"huge".as_slice(),
                tar::EntryType::Regular,
                MAX_FILE_TREE_SINGLE_FILE_BYTES + 1,
                "artifactLimit",
            ),
        ] {
            let archive = root.path().join(format!("{expected}.tar.zst"));
            malicious_tar(&archive, name, kind, size);
            let destination = root.path().join(format!("extract-{expected}"));
            let error =
                extract_verified_file_tree(&archive, &destination, &CancellationToken::new())
                    .unwrap_err();
            assert_eq!(error.category, expected);
            assert!(!root.path().join("escape").exists());
        }
    }

    #[test]
    fn zip_slip_is_rejected_before_content_is_consumed() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("unsafe.zip");
        let file = File::create(&path).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        writer
            .start_file(
                "../escape.txt",
                zip::write::SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Deflated),
            )
            .unwrap();
        writer.write_all(b"escape").unwrap();
        writer.finish().unwrap();
        let error = validate_zip_archive(&path).unwrap_err();
        assert_eq!(error.category, "pathTraversal");
    }

    #[test]
    fn extraction_round_trip_preserves_only_normalized_modes() {
        let root = tempfile::tempdir().unwrap();
        write_file(&root.path().join("dist/index.html"), b"hello");
        let archive = root.path().join("site.tar.zst");
        create_deterministic_file_tree(
            root.path(),
            &["dist".into()],
            &archive,
            &CancellationToken::new(),
        )
        .unwrap();
        let extracted = root.path().join("out");
        let tree =
            extract_verified_file_tree(&archive, &extracted, &CancellationToken::new()).unwrap();
        assert_eq!(tree.file_count, 1);
        assert_eq!(tree.total_size, 5);
        assert_eq!(fs::read(extracted.join("index.html")).unwrap(), b"hello");
    }
}
