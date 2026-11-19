//! Directory ownership and recovery for the isolated macOS acceptance bundle.
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::mem::MaybeUninit;
use std::os::fd::AsRawFd;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const JOURNAL: &str = "managed-directory-guard.json";

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(tag = "phase", rename_all = "camelCase")]
enum Phase {
    Prepared,
    Running { group: i32 },
    Ended,
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
    fn open(root: &Path) -> io::Result<Self> {
        let (parent, prefix) = if super::mac_sandbox_preview_active() {
            let home = std::env::var_os("HOME")
                .map(PathBuf::from)
                .filter(|path| path.is_absolute())
                .ok_or_else(|| io::Error::other("expected an absolute preview home directory"))?;
            (
                home.canonicalize()?.join(".shellspan/agent-sandbox"),
                "preview-",
            )
        } else {
            (PathBuf::from("/private/tmp"), "ss-sandbox-desktop-")
        };
        if root.parent() != Some(parent.as_path())
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
        if let Phase::Running { group } = record.phase {
            if !group_gone(group)? {
                return Ok(false);
            }
        }
        self.protect(false)?;
        fs::remove_file(self.state.join(JOURNAL))?;
        File::open(&self.state)?.sync_all()?;
        Ok(true)
    }
}

fn group_gone(group: i32) -> io::Result<bool> {
    if group <= 1 {
        return Err(io::Error::other("invalid recorded process group"));
    }
    if unsafe { libc::kill(-group, 0) } == 0 {
        return Ok(false);
    }
    match io::Error::last_os_error().raw_os_error() {
        Some(libc::ESRCH) => Ok(true),
        Some(libc::EPERM) => Ok(false),
        _ => Err(io::Error::last_os_error()),
    }
}

pub(super) struct Lease {
    directory: Directory,
    record: Record,
}

impl Lease {
    pub(super) fn acquire(root: &Path) -> io::Result<Self> {
        let directory = Directory::open(root)?;
        if directory.journal()?.is_some() || directory.flags()? & libc::UF_IMMUTABLE != 0 {
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
        self.record.phase = Phase::Running { group };
        self.directory.save(self.record)
    }

    pub(super) fn record_ended(&mut self) -> io::Result<()> {
        if let Phase::Running { group } = self.record.phase {
            if !group_gone(group)? {
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
