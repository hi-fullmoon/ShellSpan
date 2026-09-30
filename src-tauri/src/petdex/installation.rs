//! Only random installation identity and conservative slot usage survive restart.
//! File's OS lock is held for the adapter lifetime, including atomic JSON writes.
use serde::{Deserialize, Serialize};
use std::{
    fs::{File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

#[derive(Default, Clone, Copy, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Usage {
    pub used: bool,
    pub possibly_busy: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Record {
    installation: uuid::Uuid,
    slots: [Usage; 3],
}

pub(super) struct Installation {
    _lock: File,
    path: PathBuf,
    record: Record,
    write_epochs: [u64; 3],
}

impl Installation {
    pub fn open(directory: &Path) -> io::Result<Self> {
        std::fs::create_dir_all(directory)?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(directory.join("petdex-messages.lock"))?;
        lock.try_lock().map_err(io::Error::other)?;
        let path = directory.join("petdex-messages.json");
        let record = match File::open(&path) {
            Ok(file) => {
                let mut bytes = Vec::new();
                file.take(4097).read_to_end(&mut bytes)?;
                if bytes.len() > 4096 {
                    return Err(io::Error::other("invalid message state"));
                }
                serde_json::from_slice::<Record>(&bytes)
                    .map_err(|_| io::Error::other("invalid message state"))?
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => Record {
                installation: uuid::Uuid::new_v4(),
                slots: [Usage::default(); 3],
            },
            Err(error) => return Err(error),
        };
        if record.installation.get_version_num() != 4 {
            return Err(io::Error::other("invalid installation identity"));
        }
        let installation = Self {
            _lock: lock,
            path,
            record,
            write_epochs: [0; 3],
        };
        installation.save()?;
        Ok(installation)
    }

    fn save(&self) -> io::Result<()> {
        let mut file = tempfile::NamedTempFile::new_in(self.path.parent().unwrap())?;
        serde_json::to_writer(&mut file, &self.record)?;
        file.flush()?;
        file.as_file().sync_all()?;
        file.persist(&self.path).map_err(|e| e.error)?;
        #[cfg(unix)]
        File::open(self.path.parent().unwrap())?.sync_all()?;
        Ok(())
    }

    pub fn key(&self, slot: usize) -> Option<String> {
        (slot < 3).then(|| {
            format!(
                "shellspan-{}-slot-{}",
                self.record.installation.simple(),
                slot + 1
            )
        })
    }

    pub fn usage(&self) -> [Usage; 3] {
        self.record.slots
    }

    pub fn attempt_version(&mut self, slot: usize, busy: bool, epoch: u64) -> io::Result<()> {
        if slot >= 3 || epoch <= self.write_epochs[slot] {
            return Err(io::Error::other("stale message attempt"));
        }
        self.write_epochs[slot] = epoch;
        self.mark_attempt(slot, busy)
    }

    pub fn settle_version(&mut self, slot: usize, epoch: u64) -> io::Result<bool> {
        if slot >= 3 || self.write_epochs[slot] != epoch {
            return Ok(false);
        }
        self.mark_settled(slot)?;
        Ok(true)
    }

    // Before a network attempt persist used/possibly_busy=true. Only a current
    // accepted settlement may clear possibly_busy. Never persist projections.
    pub fn mark_attempt(&mut self, slot: usize, busy: bool) -> io::Result<()> {
        let usage = self
            .record
            .slots
            .get_mut(slot)
            .ok_or_else(|| io::Error::other("invalid slot"))?;
        usage.used = true;
        usage.possibly_busy |= busy;
        self.save()
    }

    pub fn mark_settled(&mut self, slot: usize) -> io::Result<()> {
        let usage = self
            .record
            .slots
            .get_mut(slot)
            .ok_or_else(|| io::Error::other("invalid slot"))?;
        usage.possibly_busy = false;
        self.save()
    }
}
