use serde::Serialize;
use std::path::Path;
use std::sync::Mutex;
use sysinfo::{Disks, Pid, ProcessRefreshKind, ProcessesToUpdate, System};
use tauri::{AppHandle, Manager, State};

/// Managed state: a persistent `System` instance so CPU usage deltas are
/// accurate across polls. `sysinfo` needs >= ~200ms between refreshes for
/// `cpu_usage()`; the 2s monitor polling satisfies this.
pub(crate) struct HealthState(pub(crate) Mutex<System>);

impl Default for HealthState {
    fn default() -> Self {
        Self(Mutex::new(System::new()))
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppProcessInfo {
    pub(crate) pid: u32,
    pub(crate) rss_bytes: u64,
    pub(crate) vsz_bytes: u64,
    pub(crate) cpu_percent: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) threads: Option<usize>,
    pub(crate) uptime_secs: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SystemInfo {
    pub(crate) total_memory_bytes: u64,
    pub(crate) used_memory_bytes: u64,
    pub(crate) free_memory_bytes: u64,
    pub(crate) memory_usage_percent: f64,
    pub(crate) total_swap_bytes: u64,
    pub(crate) used_swap_bytes: u64,
    pub(crate) free_swap_bytes: u64,
    pub(crate) cpu_percent: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiskInfo {
    pub(crate) total_bytes: u64,
    pub(crate) used_bytes: u64,
    pub(crate) free_bytes: u64,
    pub(crate) usage_percent: f64,
    pub(crate) mount_point: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) name: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppInfo {
    pub(crate) version: String,
    pub(crate) platform: String,
    pub(crate) arch: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SystemHealth {
    pub(crate) app: AppProcessInfo,
    pub(crate) system: SystemInfo,
    pub(crate) disk: DiskInfo,
    pub(crate) app_info: AppInfo,
}

fn usage_percent(used: u64, total: u64) -> f64 {
    if total == 0 {
        0.0
    } else {
        (used as f64 / total as f64) * 100.0
    }
}

/// Collects current process + system resource usage. Runs on the IPC handling
/// thread (not the main thread), so the brief work every 2s does not jank the UI.
#[tauri::command]
pub(crate) fn get_system_health(
    app: AppHandle,
    state: State<'_, HealthState>,
) -> Result<SystemHealth, String> {
    let pid = std::process::id();
    let sys_pid = Pid::from_u32(pid);

    let mut sys = state
        .0
        .lock()
        .map_err(|e| format!("health state poisoned: {e}"))?;

    // CPU usage is a delta between refreshes; reusing the managed System makes
    // the first sample 0 and every later sample accurate.
    sys.refresh_cpu_usage();
    sys.refresh_memory();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[sys_pid]),
        true,
        ProcessRefreshKind::everything(),
    );

    let app_proc = match sys.process(sys_pid) {
        Some(proc) => AppProcessInfo {
            pid,
            rss_bytes: proc.memory(),
            vsz_bytes: proc.virtual_memory(),
            cpu_percent: proc.cpu_usage() as f64,
            threads: process_thread_count(pid),
            uptime_secs: proc.run_time(),
        },
        None => AppProcessInfo {
            pid,
            rss_bytes: 0,
            vsz_bytes: 0,
            cpu_percent: 0.0,
            threads: None,
            uptime_secs: 0,
        },
    };

    let total_mem = sys.total_memory();
    let used_mem = sys.used_memory();
    let total_swap = sys.total_swap();
    let used_swap = sys.used_swap();

    let system = SystemInfo {
        total_memory_bytes: total_mem,
        used_memory_bytes: used_mem,
        free_memory_bytes: sys.free_memory(),
        memory_usage_percent: usage_percent(used_mem, total_mem),
        total_swap_bytes: total_swap,
        used_swap_bytes: used_swap,
        free_swap_bytes: sys.free_swap(),
        cpu_percent: sys.global_cpu_usage() as f64,
    };

    let app_data_dir = app.path().app_data_dir().unwrap_or_default();
    let disk = disk_info(&app_data_dir);

    let app_info = AppInfo {
        version: app.package_info().version.to_string(),
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
    };

    Ok(SystemHealth {
        app: app_proc,
        system,
        disk,
        app_info,
    })
}

/// Disk usage of the volume hosting the app data directory (longest mount-point
/// prefix match).
fn disk_info(app_data_dir: &Path) -> DiskInfo {
    let disks = Disks::new_with_refreshed_list();
    let mut best: Option<(String, u64, u64, String)> = None;
    let mut best_len = 0usize;
    for disk in disks.list() {
        let mount = disk.mount_point().to_string_lossy().into_owned();
        if app_data_dir.starts_with(&mount) && mount.len() > best_len {
            best_len = mount.len();
            best = Some((
                mount,
                disk.total_space(),
                disk.available_space(),
                disk.name().to_string_lossy().into_owned(),
            ));
        }
    }
    let (mount, total, free, name) = best.unwrap_or_else(|| ("/".to_string(), 0, 0, String::new()));
    let used = total.saturating_sub(free);
    DiskInfo {
        total_bytes: total,
        used_bytes: used,
        free_bytes: free,
        usage_percent: usage_percent(used, total),
        mount_point: mount,
        name: if name.is_empty() { None } else { Some(name) },
    }
}

/// Best-effort thread count for the current process. Returns `None` when the
/// platform has no cheap way to read it (the frontend then shows "—").
#[cfg(target_os = "linux")]
fn process_thread_count(pid: u32) -> Option<usize> {
    let status = std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
    status.lines().find_map(|line| {
        line.strip_prefix("Threads:")
            .and_then(|value| value.trim().parse::<usize>().ok())
    })
}

#[cfg(target_os = "macos")]
fn process_thread_count(pid: u32) -> Option<usize> {
    use std::os::raw::c_int;

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct ProcTaskInfo {
        pti_virtual_size: u64,
        pti_resident_size: u64,
        pti_total_user: u64,
        pti_total_system: u64,
        pti_threads_user: u64,
        pti_threads_system: u64,
        pti_policy: c_int,
        pti_faults: i32,
        pti_pageins: i32,
        pti_cow_faults: i32,
        pti_messages_sent: i32,
        pti_messages_received: i32,
        pti_syscalls_mach: i32,
        pti_syscalls_unix: i32,
        pti_csw: i32,
        pti_threadnum: i32,
        pti_numrunning: i32,
        pti_priority: i32,
    }

    const PROC_PIDTASKINFO: c_int = 4;

    #[link(name = "proc", kind = "dylib")]
    extern "C" {
        fn proc_pidinfo(
            pid: c_int,
            flavor: c_int,
            arg: u64,
            buffer: *mut std::ffi::c_void,
            buffersize: c_int,
        ) -> c_int;
    }

    let mut info = ProcTaskInfo::default();
    let size = std::mem::size_of::<ProcTaskInfo>() as c_int;
    // SAFETY: `proc_pidinfo` writes at most `size` bytes into `info`.
    let ret = unsafe {
        proc_pidinfo(
            pid as c_int,
            PROC_PIDTASKINFO,
            0,
            &mut info as *mut _ as *mut std::ffi::c_void,
            size,
        )
    };
    if ret == size {
        Some(info.pti_threadnum.max(0) as usize)
    } else {
        None
    }
}

#[cfg(target_os = "windows")]
fn process_thread_count(pid: u32) -> Option<usize> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };

    // SAFETY: standard Toolhelp snapshot walk; entry is zero-initialized with
    // `dwSize` set before first use.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return None;
        }
        let mut entry = THREADENTRY32 {
            dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
            ..std::mem::zeroed()
        };
        let mut count = 0usize;
        let mut found = Thread32First(snapshot, &mut entry) != 0;
        while found {
            if entry.th32OwnerProcessID == pid {
                count += 1;
            }
            found = Thread32Next(snapshot, &mut entry) != 0;
        }
        CloseHandle(snapshot);
        Some(count)
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn process_thread_count(_pid: u32) -> Option<usize> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usage_percent_zeroes_out_on_empty_total() {
        assert_eq!(usage_percent(10, 0), 0.0);
        assert_eq!(usage_percent(0, 0), 0.0);
    }

    #[test]
    fn usage_percent_calculates_ratio() {
        assert_eq!(usage_percent(50, 100), 50.0);
        assert!((usage_percent(1, 3) - 33.3333).abs() < 0.001);
    }

    #[test]
    fn thread_count_is_positive_for_current_process() {
        // Exercises the platform thread-count helper (incl. the macOS FFI path),
        // validating the proc_taskinfo struct layout on this machine.
        let count = process_thread_count(std::process::id());
        assert!(count.is_some_and(|n| n >= 1), "thread count was {count:?}");
    }

    #[test]
    fn disk_info_finds_a_real_volume() {
        let home = std::env::home_dir().expect("home dir should resolve");
        let info = disk_info(&home);
        assert!(info.total_bytes > 0, "expected a real volume, got {info:?}");
        assert!((0.0..=100.0).contains(&info.usage_percent));
        assert!(!info.mount_point.is_empty());
    }
}
