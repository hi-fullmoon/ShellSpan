//! Actual held-handle Job member security observations for fixed experiments.
use crate::appcontainer_probe::{query, win, Handle};
use serde::Serialize;
use std::ptr::null_mut;
use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::Security::*;
use windows_sys::Win32::System::SystemServices::SECURITY_MANDATORY_LOW_RID;
use windows_sys::Win32::System::Threading::*;
type Result<T> = std::result::Result<T, String>;
fn probe_sid_text(sid: PSID) -> Result<String> {
    unsafe { crate::appcontainer_probe::sid_text(sid) }
}
fn probe_lpac_behavior(token: HANDLE, user: PSID, package: PSID) -> Result<bool> {
    unsafe { crate::appcontainer_probe::lpac_behavior(token, user, package) }
}
#[derive(Clone, Serialize)]
pub struct JobProcessObservation {
    pid: u32,
    image: Option<String>,
    exact_job_member: bool,
    appcontainer: Option<bool>,
    integrity_rid: Option<u32>,
    expected_user: bool,
    expected_package: bool,
    exact_capabilities: bool,
    actual_lpac: bool,
    error: Option<u32>,
}
pub fn verified_fixed_topology(
    entries: &[JobProcessObservation],
    total: u32,
    image: &std::path::Path,
    console: &std::path::Path,
) -> bool {
    verified_probe_topology(entries, total, image, console, 2)
}
/// Fixed concurrent workload: one root plus two leaves, each with its own console.
pub fn verified_concurrent_topology(
    entries: &[JobProcessObservation],
    total: u32,
    image: &std::path::Path,
    console: &std::path::Path,
) -> bool {
    verified_probe_topology(entries, total, image, console, 3)
}
fn verified_probe_topology(
    entries: &[JobProcessObservation],
    total: u32,
    image: &std::path::Path,
    console: &std::path::Path,
    expected_pairs: usize,
) -> bool {
    if !matches!(expected_pairs, 2 | 3)
        || total as usize != expected_pairs * 2
        || entries.len() != expected_pairs * 2
    {
        return false;
    }
    let mut ids = std::collections::HashSet::new();
    let mut probes = 0;
    let mut consoles = 0;
    for entry in entries {
        if !ids.insert(entry.pid)
            || entry.error.is_some()
            || !entry.exact_job_member
            || entry.appcontainer != Some(true)
            || entry.integrity_rid != Some(SECURITY_MANDATORY_LOW_RID as u32)
            || !entry.expected_user
            || !entry.expected_package
            || !entry.exact_capabilities
            || !entry.actual_lpac
        {
            return false;
        }
        match entry.image.as_deref().map(std::path::Path::new) {
            Some(path)
                if path
                    .to_string_lossy()
                    .eq_ignore_ascii_case(&image.to_string_lossy()) =>
            {
                probes += 1
            }
            Some(path)
                if path
                    .to_string_lossy()
                    .eq_ignore_ascii_case(&console.to_string_lossy()) =>
            {
                consoles += 1
            }
            _ => return false,
        }
    }
    probes == expected_pairs && consoles == expected_pairs
}
pub struct JobObserver {
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    entries: std::sync::Arc<std::sync::Mutex<Vec<JobProcessObservation>>>,
    worker: Option<std::thread::JoinHandle<()>>,
}
pub fn verified_source_tool_topology(
    entries: &[JobProcessObservation],
    total: u32,
    images: &[std::path::PathBuf],
    console: &std::path::Path,
    source_integrity: u32,
) -> bool {
    if images.is_empty()
        || images.len() > 2
        || total == 0
        || total > 4
        || entries.len() != total as usize
    {
        return false;
    }
    let mut ids = std::collections::HashSet::new();
    let mut counts = vec![0; images.len()];
    let mut consoles = 0;
    for entry in entries {
        if !ids.insert(entry.pid)
            || entry.error.is_some()
            || !entry.exact_job_member
            || entry.appcontainer != Some(false)
            || entry.integrity_rid != Some(source_integrity)
            || !entry.expected_user
            || !entry.expected_package
            || !entry.exact_capabilities
            || entry.actual_lpac
        {
            return false;
        }
        let Some(image) = &entry.image else {
            return false;
        };
        if let Some(index) = images
            .iter()
            .position(|path| image.eq_ignore_ascii_case(&path.to_string_lossy()))
        {
            counts[index] += 1;
        } else if image.eq_ignore_ascii_case(&console.to_string_lossy()) {
            consoles += 1;
        } else {
            return false;
        }
    }
    counts[0] == 1 && counts.iter().all(|count| *count <= 1) && consoles <= 2
}
pub fn verified_tool_topology(
    entries: &[JobProcessObservation],
    total: u32,
    image: &std::path::Path,
    console: &std::path::Path,
) -> bool {
    if !(1..=2).contains(&total) || entries.len() != total as usize {
        return false;
    }
    let mut ids = std::collections::HashSet::new();
    let mut tools = 0;
    let mut consoles = 0;
    for entry in entries {
        if !ids.insert(entry.pid)
            || entry.error.is_some()
            || !entry.exact_job_member
            || entry.appcontainer != Some(true)
            || entry.integrity_rid != Some(SECURITY_MANDATORY_LOW_RID as u32)
            || !entry.expected_user
            || !entry.expected_package
            || !entry.exact_capabilities
            || !entry.actual_lpac
        {
            return false;
        }
        let Some(actual) = entry.image.as_deref() else {
            return false;
        };
        if actual.eq_ignore_ascii_case(&image.to_string_lossy()) {
            tools += 1;
        } else if actual.eq_ignore_ascii_case(&console.to_string_lossy()) {
            consoles += 1;
        } else {
            return false;
        }
    }
    tools == 1 && consoles <= 1
}
impl JobObserver {
    /// # Safety
    /// The owned Job handle must remain valid until this observer is finished or dropped.
    pub unsafe fn start(
        job: HANDLE,
        expected_user: String,
        expected_package: String,
        expected_capabilities: Vec<(String, u32)>,
    ) -> Result<Self> {
        unsafe {
            Self::start_context(
                job,
                expected_user,
                Some(expected_package),
                expected_capabilities,
            )
        }
    }
    /// # Safety
    /// The owned Job must remain valid until this observer finishes or drops.
    pub unsafe fn start_ordinary(job: HANDLE, expected_user: String) -> Result<Self> {
        unsafe { Self::start_context(job, expected_user, None, vec![]) }
    }
    unsafe fn start_context(
        job: HANDLE,
        expected_user: String,
        expected_package: Option<String>,
        expected_capabilities: Vec<(String, u32)>,
    ) -> Result<Self> {
        use windows_sys::Win32::System::{JobObjects::*, IO::*};
        let port =
            Handle(unsafe { CreateIoCompletionPort(INVALID_HANDLE_VALUE, null_mut(), 0, 1) });
        if port.0.is_null() {
            return Err("create owned Job completion port failed".into());
        }
        let association = JOBOBJECT_ASSOCIATE_COMPLETION_PORT {
            CompletionKey: std::ptr::dangling_mut::<u8>().cast(),
            CompletionPort: port.0,
        };
        win(
            unsafe {
                SetInformationJobObject(
                    job,
                    JobObjectAssociateCompletionPortInformation,
                    (&association as *const JOBOBJECT_ASSOCIATE_COMPLETION_PORT).cast(),
                    std::mem::size_of_val(&association) as u32,
                )
            },
            "associate exact owned Job observer",
        )?;
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let entries = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let worker_stop = stop.clone();
        let worker_entries = entries.clone();
        let port_raw = port.0 as usize;
        std::mem::forget(port);
        let job_raw = job as usize;
        let worker = std::thread::spawn(move || {
            let port = Handle(port_raw as HANDLE);
            while !worker_stop.load(std::sync::atomic::Ordering::SeqCst) {
                let mut message = 0;
                let mut key = 0;
                let mut overlapped = null_mut();
                let ok = unsafe {
                    GetQueuedCompletionStatus(port.0, &mut message, &mut key, &mut overlapped, 50)
                };
                if ok == 0
                    || key != 1
                    || message
                        != windows_sys::Win32::System::SystemServices::JOB_OBJECT_MSG_NEW_PROCESS
                {
                    continue;
                }
                let pid = overlapped as usize as u32;
                let process =
                    Handle(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) });
                let mut observation = JobProcessObservation {
                    pid,
                    image: None,
                    exact_job_member: false,
                    appcontainer: None,
                    integrity_rid: None,
                    expected_user: false,
                    expected_package: false,
                    exact_capabilities: false,
                    actual_lpac: false,
                    error: None,
                };
                if process.0.is_null() {
                    observation.error = Some(unsafe { GetLastError() });
                } else {
                    let mut member = 0;
                    if unsafe { IsProcessInJob(process.0, job_raw as HANDLE, &mut member) } != 0
                        && member != 0
                    {
                        observation.exact_job_member = true;
                        let mut raw = null_mut();
                        if unsafe {
                            OpenProcessToken(process.0, TOKEN_QUERY | TOKEN_DUPLICATE, &mut raw)
                        } != 0
                        {
                            let token = Handle(raw);
                            let identity = (|| -> Result<()> {
                                let user = unsafe { query(token.0, TokenUser) }?;
                                let package = unsafe { query(token.0, TokenAppContainerSid) }?;
                                let user_sid =
                                    unsafe { (*user.as_ptr().cast::<TOKEN_USER>()).User.Sid };
                                let package_sid = unsafe { *package.as_ptr().cast::<PSID>() };
                                observation.expected_user =
                                    probe_sid_text(user_sid)? == expected_user;
                                if let Some(expected_package) = &expected_package {
                                    observation.expected_package =
                                        probe_sid_text(package_sid)? == *expected_package;
                                    observation.actual_lpac =
                                        probe_lpac_behavior(token.0, user_sid, package_sid)?;
                                } else {
                                    observation.expected_package = package_sid.is_null();
                                }
                                let capabilities = unsafe { query(token.0, TokenCapabilities) }?;
                                let groups =
                                    unsafe { &*capabilities.as_ptr().cast::<TOKEN_GROUPS>() };
                                if groups.GroupCount > 16 {
                                    return Err("observed capability budget exceeded".into());
                                }
                                let mut actual = Vec::new();
                                for index in 0..groups.GroupCount as usize {
                                    let group = unsafe { &*groups.Groups.as_ptr().add(index) };
                                    actual.push((probe_sid_text(group.Sid)?, group.Attributes));
                                }
                                observation.exact_capabilities = actual == expected_capabilities;
                                Ok(())
                            })();
                            if identity.is_err() {
                                observation.error = Some(ERROR_INVALID_DATA);
                            }

                            if let Ok(app) = unsafe { query(token.0, TokenIsAppContainer) } {
                                observation.appcontainer =
                                    Some(unsafe { *app.as_ptr().cast::<u32>() } != 0);
                            }
                            if let Ok(integrity) = unsafe { query(token.0, TokenIntegrityLevel) } {
                                let sid = unsafe {
                                    (*integrity.as_ptr().cast::<TOKEN_MANDATORY_LABEL>())
                                        .Label
                                        .Sid
                                };
                                let count = unsafe { *GetSidSubAuthorityCount(sid) };
                                if count != 0 {
                                    observation.integrity_rid = Some(unsafe {
                                        *GetSidSubAuthority(sid, u32::from(count - 1))
                                    });
                                }
                            }
                        } else {
                            observation.error = Some(unsafe { GetLastError() });
                        }

                        let mut image = vec![0u16; 32768];
                        let mut size = image.len() as u32;
                        if unsafe {
                            QueryFullProcessImageNameW(process.0, 0, image.as_mut_ptr(), &mut size)
                        } != 0
                        {
                            observation.image =
                                Some(String::from_utf16_lossy(&image[..size as usize]));
                        } else {
                            observation.error = Some(unsafe { GetLastError() });
                        }
                    } else {
                        observation.error = Some(unsafe { GetLastError() });
                    }
                }
                if let Ok(mut entries) = worker_entries.lock() {
                    if entries.len() < 64 {
                        entries.push(observation);
                    }
                }
            }
        });
        Ok(Self {
            stop,
            entries,
            worker: Some(worker),
        })
    }
    pub fn finish(&mut self) -> Vec<JobProcessObservation> {
        self.stop.store(true, std::sync::atomic::Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
        self.entries
            .lock()
            .map(|entries| entries.clone())
            .unwrap_or_default()
    }
}
impl Drop for JobObserver {
    fn drop(&mut self) {
        self.finish();
    }
}
#[cfg(test)]
mod topology_tests {
    use super::*;
    #[test]
    fn concurrent_topology_requires_all_six_unique_fully_verified_members() {
        let image = std::path::Path::new("probe.exe");
        let console = std::path::Path::new("conhost.exe");
        let entries: Vec<_> = (0..6)
            .map(|index| JobProcessObservation {
                pid: index + 1,
                image: Some(
                    if index < 3 {
                        "probe.exe"
                    } else {
                        "conhost.exe"
                    }
                    .into(),
                ),
                exact_job_member: true,
                appcontainer: Some(true),
                integrity_rid: Some(SECURITY_MANDATORY_LOW_RID as u32),
                expected_user: true,
                expected_package: true,
                exact_capabilities: true,
                actual_lpac: true,
                error: None,
            })
            .collect();
        assert!(verified_concurrent_topology(&entries, 6, image, console));
        assert!(!verified_fixed_topology(&entries, 6, image, console));
        assert!(!verified_concurrent_topology(
            &entries[..5],
            6,
            image,
            console
        ));
        assert!(!verified_concurrent_topology(&entries, 5, image, console));
        for index in 0..6 {
            let mut changed = entries.clone();
            changed[index].exact_capabilities = false;
            assert!(!verified_concurrent_topology(&changed, 6, image, console));
            let mut changed = entries.clone();
            changed[index].expected_user = false;
            assert!(!verified_concurrent_topology(&changed, 6, image, console));
            let mut changed = entries.clone();
            changed[index].pid = entries[(index + 1) % 6].pid;
            assert!(!verified_concurrent_topology(&changed, 6, image, console));
            let mut changed = entries.clone();
            changed[index].image = Some("unowned.exe".into());
            assert!(!verified_concurrent_topology(&changed, 6, image, console));
        }
    }
    #[test]
    fn ordinary_control_requires_complete_frozen_images_and_ordinary_context() {
        let image = std::path::PathBuf::from("git.exe");
        let console = std::path::Path::new("conhost.exe");
        let entry = JobProcessObservation {
            pid: 1,
            image: Some("git.exe".into()),
            exact_job_member: true,
            appcontainer: Some(false),
            integrity_rid: Some(8192),
            expected_user: true,
            expected_package: true,
            exact_capabilities: true,
            actual_lpac: false,
            error: None,
        };
        let images = vec![image];
        assert!(verified_source_tool_topology(
            std::slice::from_ref(&entry),
            1,
            &images,
            console,
            8192
        ));
        assert!(!verified_source_tool_topology(
            std::slice::from_ref(&entry),
            2,
            &images,
            console,
            8192
        ));
        assert!(!verified_source_tool_topology(
            std::slice::from_ref(&entry),
            1,
            &images,
            console,
            4096
        ));
        let mut bad = entry.clone();
        bad.appcontainer = Some(true);
        assert!(!verified_source_tool_topology(
            &[bad],
            1,
            &images,
            console,
            8192
        ));
        let mut bad = entry.clone();
        bad.image = Some("unknown helper.exe".into());
        assert!(!verified_source_tool_topology(
            &[bad],
            1,
            &images,
            console,
            8192
        ));
        let mut bad = entry.clone();
        bad.actual_lpac = true;
        assert!(!verified_source_tool_topology(
            &[bad],
            1,
            &images,
            console,
            8192
        ));
        let mut bad = entry.clone();
        bad.error = Some(ERROR_ACCESS_DENIED);
        assert!(!verified_source_tool_topology(
            &[bad],
            1,
            &images,
            console,
            8192
        ));
        assert!(!verified_source_tool_topology(
            &[entry.clone(), entry],
            2,
            &images,
            console,
            8192
        ));
    }
    #[test]
    fn topology_requires_exact_images_unique_processes_and_every_security_fact() {
        let image = std::path::Path::new("probe.exe");
        let console = std::path::Path::new("conhost.exe");
        let entries: Vec<_> = (0..4)
            .map(|index| JobProcessObservation {
                pid: index + 1,
                image: Some(
                    if index < 2 {
                        "probe.exe"
                    } else {
                        "conhost.exe"
                    }
                    .into(),
                ),
                exact_job_member: true,
                appcontainer: Some(true),
                integrity_rid: Some(SECURITY_MANDATORY_LOW_RID as u32),
                expected_user: true,
                expected_package: true,
                exact_capabilities: true,
                actual_lpac: true,
                error: None,
            })
            .collect();
        assert!(verified_fixed_topology(&entries, 4, image, console));
        for index in 0..4 {
            let mut changed = entries.clone();
            changed[index].expected_user = false;
            assert!(!verified_fixed_topology(&changed, 4, image, console));
            let mut changed = entries.clone();
            changed[index].exact_capabilities = false;
            assert!(!verified_fixed_topology(&changed, 4, image, console));
            let mut changed = entries.clone();
            changed[index].integrity_rid = Some(8192);
            assert!(!verified_fixed_topology(&changed, 4, image, console));
            let mut changed = entries.clone();
            changed[index].appcontainer = Some(false);
            assert!(!verified_fixed_topology(&changed, 4, image, console));
            let mut changed = entries.clone();
            changed[index].exact_job_member = false;
            assert!(!verified_fixed_topology(&changed, 4, image, console));
            let mut changed = entries.clone();
            changed[index].error = Some(ERROR_ACCESS_DENIED);
            assert!(!verified_fixed_topology(&changed, 4, image, console));
            let mut changed = entries.clone();
            changed[index].actual_lpac = false;
            assert!(!verified_fixed_topology(&changed, 4, image, console));
            let mut changed = entries.clone();
            changed[index].expected_package = false;
            assert!(!verified_fixed_topology(&changed, 4, image, console));
            let mut changed = entries.clone();
            changed[index].image = Some("unknown.exe".into());
            assert!(!verified_fixed_topology(&changed, 4, image, console));
        }
        let mut changed = entries.clone();
        changed[3].pid = changed[0].pid;
        assert!(!verified_fixed_topology(&changed, 4, image, console));
        assert!(!verified_fixed_topology(&entries[..3], 4, image, console));
        assert!(!verified_fixed_topology(&entries, 5, image, console));
        let tool_entries = vec![entries[0].clone(), entries[2].clone()];
        assert!(verified_tool_topology(&tool_entries, 2, image, console));
        assert!(verified_tool_topology(
            &tool_entries[..1],
            1,
            image,
            console
        ));
        assert!(!verified_tool_topology(&tool_entries, 1, image, console));
        assert!(!verified_tool_topology(&entries, 4, image, console));
        for index in 0..2 {
            let mut changed = tool_entries.clone();
            changed[index].expected_package = false;
            assert!(!verified_tool_topology(&changed, 2, image, console));
            let mut changed = tool_entries.clone();
            changed[index].actual_lpac = false;
            assert!(!verified_tool_topology(&changed, 2, image, console));
            let mut changed = tool_entries.clone();
            changed[index].image = Some("unknown.exe".into());
            assert!(!verified_tool_topology(&changed, 2, image, console));
        }
        assert!(!verified_tool_topology(
            &[entries[0].clone(), entries[1].clone()],
            2,
            image,
            console
        ));
    }
}
