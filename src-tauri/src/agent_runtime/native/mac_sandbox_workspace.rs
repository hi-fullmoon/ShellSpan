//! Directory ownership and recovery for the isolated macOS acceptance bundle.
use serde::{Deserialize, Serialize};
use std::ffi::CString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::mem::MaybeUninit;
use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use super::process::local_process_group_gone;

const JOURNAL: &str = "managed-directory-guard.json";

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(tag = "phase", rename_all = "camelCase")]
enum Phase {
    Prepared,
    Running {
        group: i32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        boot_time: Option<i64>,
    },
    Ended,
}

fn system_boot_time() -> io::Result<i64> {
    let mut mib = [libc::CTL_KERN, libc::KERN_BOOTTIME];
    let mut boot = MaybeUninit::<libc::timeval>::uninit();
    let mut size = std::mem::size_of::<libc::timeval>();
    if unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            mib.len() as u32,
            boot.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    } < 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { boot.assume_init() }.tv_sec)
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    anchor: (u64, u64),
    phase: Phase,
}

struct Directory {
    anchor: File,
    state: PathBuf,
    _ownership: File,
}

impl Directory {
    #[cfg(all(
        feature = "native-input-acceptance",
        debug_assertions,
        target_os = "macos",
        target_arch = "aarch64"
    ))]
    fn open(root: &Path) -> io::Result<Self> {
        let (parent, prefix) = if super::mac_sandbox_preview_active() {
            let home = std::env::var_os("HOME")
                .map(PathBuf::from)
                .filter(|path| path.is_absolute())
                .ok_or_else(|| io::Error::other("expected an absolute preview home directory"))?;
            (home.canonicalize()?, ".shellspan-agent-sandbox-preview-")
        } else {
            (PathBuf::from("/private/tmp"), "ss-sandbox-desktop-")
        };
        Self::open_in(root, &parent, prefix)
    }

    fn open_in(root: &Path, parent: &Path, prefix: &str) -> io::Result<Self> {
        validate_anchor_path(root, parent, prefix)?;
        let anchor = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
            .open(root)?;
        let state = root.join("data");
        let owner = unsafe { libc::geteuid() };
        let state_metadata = fs::symlink_metadata(&state)?;
        if anchor.metadata()?.uid() != owner
            || !state_metadata.is_dir()
            || state_metadata.uid() != owner
        {
            return Err(io::Error::other(
                "expected owned sandbox runtime and state directories",
            ));
        }
        let ownership = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .custom_flags(libc::O_NOFOLLOW)
            .open(state.join("managed-directory-guard.lock"))?;
        ownership.try_lock().map_err(io::Error::other)?;
        Ok(Self {
            anchor,
            state,
            _ownership: ownership,
        })
    }

    fn identity(&self) -> io::Result<(u64, u64)> {
        self.anchor
            .metadata()
            .map(|metadata| (metadata.dev(), metadata.ino()))
    }

    fn flags(&self) -> io::Result<u32> {
        let mut stat = MaybeUninit::<libc::stat>::uninit();
        if unsafe { libc::fstat(self.anchor.as_raw_fd(), stat.as_mut_ptr()) } < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(unsafe { stat.assume_init() }.st_flags)
    }

    fn protect(&self, protected: bool) -> io::Result<()> {
        let flags = self.flags()?;
        let requested = if protected {
            flags | libc::UF_IMMUTABLE
        } else {
            flags & !libc::UF_IMMUTABLE
        };
        if flags != requested {
            if unsafe { libc::fchflags(self.anchor.as_raw_fd(), requested) } < 0 {
                return Err(io::Error::last_os_error());
            }
            self.anchor.sync_all()?;
        }
        Ok(())
    }

    fn journal(&self) -> io::Result<Option<Record>> {
        match fs::read(self.state.join(JOURNAL)) {
            Ok(data) => serde_json::from_slice(&data)
                .map(Some)
                .map_err(io::Error::other),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }

    fn save(&self, record: Record) -> io::Result<()> {
        let mut temp = tempfile::NamedTempFile::new_in(&self.state)?;
        serde_json::to_writer(&mut temp, &record)?;
        temp.flush()?;
        temp.as_file().sync_all()?;
        temp.persist(self.state.join(JOURNAL))
            .map_err(|error| error.error)?;
        File::open(&self.state)?.sync_all()
    }

    fn recover(&self) -> io::Result<bool> {
        let Some(record) = self.journal()? else {
            return Ok(true);
        };
        if self.identity()? != record.anchor {
            return Err(io::Error::other("managed directory identity changed"));
        }
        if let Phase::Running { group, boot_time } = record.phase {
            let rebooted = boot_time.is_some_and(|recorded| {
                system_boot_time().is_ok_and(|current| current != recorded)
            });
            if !rebooted && !local_process_group_gone(group)? {
                return Ok(false);
            }
        }
        self.protect(false)?;
        fs::remove_file(self.state.join(JOURNAL))?;
        File::open(&self.state)?.sync_all()?;
        Ok(true)
    }
}

pub(super) fn validate_anchor_path(root: &Path, parent: &Path, prefix: &str) -> io::Result<()> {
    if root.parent() != Some(parent)
        || !root
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(prefix))
        || root.canonicalize()? != root
    {
        return Err(io::Error::other(
            "expected an owned desktop acceptance directory",
        ));
    }
    // The immutable anchor protects its own name and direct entries.
    // Replacing an ancestor requires mutation rights in its parent directory.
    for ancestor in parent.ancestors().skip(1) {
        let path = CString::new(ancestor.as_os_str().as_bytes())?;
        if fs::metadata(ancestor)?.uid() == unsafe { libc::geteuid() }
            || unsafe { libc::access(path.as_ptr(), libc::W_OK) } == 0
        {
            return Err(io::Error::other(
                "an ancestor of the managed sandbox directory can be replaced",
            ));
        }
        match io::Error::last_os_error().raw_os_error() {
            Some(libc::EACCES | libc::EPERM | libc::EROFS) => {}
            _ => return Err(io::Error::last_os_error()),
        }
    }
    Ok(())
}

pub(super) struct Lease {
    directory: Directory,
    record: Record,
}

impl Lease {
    #[cfg(all(
        feature = "native-input-acceptance",
        debug_assertions,
        target_os = "macos",
        target_arch = "aarch64"
    ))]
    pub(super) fn acquire(root: &Path) -> io::Result<Self> {
        let directory = Directory::open(root)?;
        Self::acquire_directory(root, directory)
    }

    pub(super) fn acquire_in(root: &Path, parent: &Path, prefix: &str) -> io::Result<Self> {
        let directory = Directory::open_in(root, parent, prefix)?;
        Self::acquire_directory(root, directory)
    }

    fn acquire_directory(root: &Path, directory: Directory) -> io::Result<Self> {
        if !directory.recover()? || directory.flags()? & libc::UF_IMMUTABLE != 0 {
            return Err(io::Error::other(
                "managed sandbox directory requires recovery",
            ));
        }
        let record = Record {
            anchor: directory.identity()?,
            phase: Phase::Prepared,
        };
        directory.save(record)?;
        directory.protect(true)?;
        if !fs::symlink_metadata(root).is_ok_and(|current| {
            current.is_dir() && (current.dev(), current.ino()) == record.anchor
        }) {
            directory.protect(false)?;
            return Err(io::Error::other(
                "managed sandbox directory changed during acquisition",
            ));
        }
        Ok(Self { directory, record })
    }

    /// The startup gate is released only after this process group is durable.
    pub(super) fn record_group(&mut self, pid: u32) -> io::Result<()> {
        let group = i32::try_from(pid).map_err(io::Error::other)?;
        if group <= 1 || unsafe { libc::getpgid(group) } != group {
            return Err(io::Error::other(
                "sandbox launcher is not a process group leader",
            ));
        }
        self.record.phase = Phase::Running {
            group,
            boot_time: Some(system_boot_time()?),
        };
        self.directory.save(self.record)
    }

    pub(super) fn record_ended(&mut self) -> io::Result<()> {
        if let Phase::Running { group, .. } = self.record.phase {
            if !local_process_group_gone(group)? {
                return Err(io::Error::other("prior sandbox process group remains live"));
            }
        }
        self.record.phase = Phase::Ended;
        self.directory.save(self.record)
    }

    pub(super) fn release(self) -> io::Result<bool> {
        self.directory.recover()
    }
}

#[cfg(all(
    feature = "native-input-acceptance",
    debug_assertions,
    target_os = "macos",
    target_arch = "aarch64"
))]
pub(crate) fn recover_on_startup(root: PathBuf) {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        match Directory::open(&root).and_then(|directory| directory.recover()) {
            Ok(true) => return,
            Ok(false) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(75)),
            Ok(false) => {
                log::warn!("Managed sandbox recovery is waiting for the previous process group");
                return;
            }
            Err(error) => {
                log::warn!("Managed sandbox recovery retained directory protection: {error}");
                return;
            }
        }
    }
}

pub(super) fn recover_once_in(root: &Path, parent: &Path, prefix: &str) -> io::Result<bool> {
    Directory::open_in(root, parent, prefix).and_then(|directory| directory.recover())
}

pub(super) fn recover_on_startup_in(root: &Path, parent: &Path, prefix: &str) {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        match recover_once_in(root, parent, prefix) {
            Ok(true) => return,
            Ok(false) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(75)),
            Ok(false) => {
                log::warn!("Managed sandbox recovery is waiting for the previous process group");
                return;
            }
            Err(error) => {
                log::warn!("Managed sandbox recovery retained directory protection: {error}");
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::process::CommandExt;
    use std::process::Command;

    #[test]
    fn managed_anchor_rejects_a_replaceable_ancestor() {
        let root = tempfile::Builder::new()
            .prefix("ss-sandbox-desktop-")
            .tempdir_in("/private/tmp")
            .unwrap();
        validate_anchor_path(
            root.path(),
            Path::new("/private/tmp"),
            "ss-sandbox-desktop-",
        )
        .unwrap();

        let parent = root.path().join("parent");
        let nested = parent.join("preview-workspace");
        fs::create_dir_all(&nested).unwrap();
        let error = validate_anchor_path(&nested, &parent, "preview-").unwrap_err();
        assert!(error.to_string().contains("ancestor"));
    }

    #[test]
    fn acquisition_recovers_a_previous_lease_once_its_group_exits() {
        let root = tempfile::Builder::new()
            .prefix("ss-sandbox-desktop-")
            .tempdir_in("/private/tmp")
            .unwrap();
        fs::create_dir(root.path().join("data")).unwrap();
        let mut lease = Lease::acquire_in(
            root.path(),
            Path::new("/private/tmp"),
            "ss-sandbox-desktop-",
        )
        .unwrap();
        let mut child = Command::new("/bin/sleep")
            .arg("30")
            .process_group(0)
            .spawn()
            .unwrap();
        lease.record_group(child.id()).unwrap();
        drop(lease);

        let acquired_while_running = Lease::acquire_in(
            root.path(),
            Path::new("/private/tmp"),
            "ss-sandbox-desktop-",
        )
        .is_ok();
        child.kill().unwrap();
        child.wait().unwrap();
        let recovered = Lease::acquire_in(
            root.path(),
            Path::new("/private/tmp"),
            "ss-sandbox-desktop-",
        )
        .unwrap();
        assert!(recovered.release().unwrap());
        assert!(!acquired_while_running);
        assert!(!root.path().join("data").join(JOURNAL).exists());
    }

    #[test]
    fn recovery_unlocks_when_recorded_boot_time_differs_from_current_host() {
        let root = tempfile::Builder::new()
            .prefix("ss-sandbox-desktop-")
            .tempdir_in("/private/tmp")
            .unwrap();
        fs::create_dir(root.path().join("data")).unwrap();
        let mut lease = Lease::acquire_in(
            root.path(),
            Path::new("/private/tmp"),
            "ss-sandbox-desktop-",
        )
        .unwrap();
        let current_group = unsafe { libc::getpgrp() };
        let stale_boot = system_boot_time().unwrap().saturating_sub(600);
        lease.record.phase = Phase::Running {
            group: current_group,
            boot_time: Some(stale_boot),
        };
        lease.directory.save(lease.record).unwrap();
        drop(lease);

        let recovered = Lease::acquire_in(
            root.path(),
            Path::new("/private/tmp"),
            "ss-sandbox-desktop-",
        )
        .unwrap();
        assert!(recovered.release().unwrap());
        assert!(!root.path().join("data").join(JOURNAL).exists());
    }
}
