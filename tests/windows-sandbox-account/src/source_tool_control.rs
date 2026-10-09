//! Fixed unelevated positive controls, isolated from LPAC acceptance.
use crate::appcontainer_probe::{query, sid_text, win, Handle};
use crate::fixed_tool::{FixedTool, ToolImageLease, ToolStdio};
use crate::fixture_runner::{accounting, end_process, job};
use crate::job_observer::{verified_source_tool_topology, JobObserver};
use std::path::PathBuf;
use std::ptr::{null, null_mut};
use windows_sys::Win32::{
    Foundation::*,
    Security::*,
    System::{
        JobObjects::AssignProcessToJobObject, SystemInformation::GetWindowsDirectoryW, Threading::*,
    },
};
type Result<T> = std::result::Result<T, String>;
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}
struct Attributes(Vec<usize>);
impl Drop for Attributes {
    fn drop(&mut self) {
        unsafe { DeleteProcThreadAttributeList(self.0.as_mut_ptr().cast()) };
    }
}
pub fn run(tool: FixedTool) -> Result<serde_json::Value> {
    let mut raw = null_mut();
    if unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 1, &mut raw) } != 0 {
        drop(Handle(raw));
        return Err("source tool control rejects thread impersonation".into());
    }
    if unsafe { GetLastError() } != ERROR_NO_TOKEN {
        return Err("source tool thread context unknown".into());
    }
    win(
        unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) },
        "source tool token",
    )?;
    let source = Handle(raw);
    let elevation = unsafe { query(source.0, TokenElevation) }?;
    let app = unsafe { query(source.0, TokenIsAppContainer) }?;
    if unsafe {
        (*elevation.as_ptr().cast::<TOKEN_ELEVATION>()).TokenIsElevated != 0
            || *app.as_ptr().cast::<u32>() != 0
    } {
        return Err("source tool control requires unelevated non-AppContainer primary".into());
    }
    let user = unsafe { query(source.0, TokenUser) }?;
    let user_sid = unsafe { sid_text((*user.as_ptr().cast::<TOKEN_USER>()).User.Sid) }?;
    let integrity = unsafe { query(source.0, TokenIntegrityLevel) }?;
    let integrity_sid = unsafe {
        (*integrity.as_ptr().cast::<TOKEN_MANDATORY_LABEL>())
            .Label
            .Sid
    };
    let count = unsafe { *GetSidSubAuthorityCount(integrity_sid) };
    if count == 0 {
        return Err("source tool integrity unknown".into());
    }
    let source_integrity = unsafe { *GetSidSubAuthority(integrity_sid, u32::from(count - 1)) };
    let root = std::env::temp_dir().join(format!("ShellSpan-AC-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir(&root).map_err(|e| e.to_string())?;
    let mut report = serde_json::json!({"production":"unavailable","scope":"unelevated shared-source positive tool control only", "tool":tool,"fixture":root,
        "source_sid":user_sid,"source_integrity":source_integrity,"process_tree_stopped":false,"fixture_recycled":false});
    let mut child = None;
    let mut pending_job = None;
    let mut observer = None;
    let mut stdio = None;
    let mut images = vec![];
    let mut build_source_lease = None;
    let operation = (|| -> Result<()> {
        std::fs::write(
            root.join("ownership.json"),
            serde_json::to_vec(&report).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        std::fs::create_dir(root.join("output")).map_err(|e| e.to_string())?;
        images.push(ToolImageLease::open(&tool.image()?)?);
        if matches!(tool, FixedTool::Git | FixedTool::GitDependencyProbe) {
            images.push(ToolImageLease::open(&PathBuf::from(
                r"D:\Programs\Git\mingw64\bin\git.exe",
            ))?);
        }
        report["images"] = serde_json::to_value(
            images
                .iter()
                .map(|image| &image.identity)
                .collect::<Vec<_>>(),
        )
        .map_err(|e| e.to_string())?;
        report["static_imports"] = serde_json::to_value(
            images
                .iter()
                .map(ToolImageLease::static_imports)
                .collect::<Result<Vec<_>>>()?,
        )
        .map_err(|e| e.to_string())?;
        if matches!(tool, FixedTool::PowerShell7RuntimeBuild) {
            build_source_lease = Some(crate::fixed_tool::create_fixed_build_source(&root)?);
        }
        stdio = Some(ToolStdio::prepare(&root)?);
        let io = stdio.as_ref().ok_or("source stdio missing")?;
        let mut bytes = 0;
        unsafe { InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut bytes) };
        if bytes == 0 || bytes > 65536 {
            return Err("source attributes exceed budget".into());
        }
        let mut storage = vec![0usize; bytes.div_ceil(std::mem::size_of::<usize>())];
        win(
            unsafe {
                InitializeProcThreadAttributeList(storage.as_mut_ptr().cast(), 1, 0, &mut bytes)
            },
            "source attributes",
        )?;
        let mut attributes = Attributes(storage);
        win(
            unsafe {
                UpdateProcThreadAttribute(
                    attributes.0.as_mut_ptr().cast(),
                    0,
                    PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                    io.inherited.as_ptr().cast(),
                    std::mem::size_of_val(&io.inherited),
                    null_mut(),
                    null(),
                )
            },
            "source exact stdio handles",
        )?;
        let startup = STARTUPINFOEXW {
            StartupInfo: STARTUPINFOW {
                cb: std::mem::size_of::<STARTUPINFOEXW>() as u32,
                dwFlags: STARTF_USESTDHANDLES,
                hStdInput: io.inherited[0],
                hStdOutput: io.inherited[1],
                hStdError: io.inherited[2],
                ..Default::default()
            },
            lpAttributeList: attributes.0.as_mut_ptr().cast(),
        };
        let mut windows = vec![0u16; 32768];
        let length =
            unsafe { GetWindowsDirectoryW(windows.as_mut_ptr(), windows.len() as u32) } as usize;
        if length == 0 || length >= windows.len() {
            return Err("source Windows directory invalid".into());
        }
        let windows = String::from_utf16(&windows[..length]).map_err(|e| e.to_string())?;
        let private = root.join("output");
        let private = private
            .to_str()
            .ok_or("source environment directory invalid")?;
        let dependency_environment = if matches!(tool, FixedTool::GitDependencyProbe) {
            crate::git_dependency_probe::frozen_environment(
                images.get(1).ok_or("frozen Git subject missing")?,
            )?
        } else {
            String::new()
        };
        let environment: Vec<u16> = format!("SSPA_FIXTURE={}\0HOME={private}\0LOCALAPPDATA={private}\0TEMP={private}\0TMP={private}\0GIT_CONFIG_NOSYSTEM=1\0GIT_CONFIG_GLOBAL=NUL\0GIT_TERMINAL_PROMPT=0\0{dependency_environment}SystemRoot={windows}\0USERPROFILE={private}\0WINDIR={windows}\0\0", root.to_str().ok_or("source fixture path invalid")?).encode_utf16().collect();
        let image = wide(
            images[0]
                .identity
                .path
                .to_str()
                .ok_or("source image invalid")?,
        );
        let environment = crate::fixed_environment::canonicalize(&environment)?;
        let working = wide(private);
        let mut command = wide(tool.command());
        pending_job = Some(job()?);
        let owned_job = pending_job.as_ref().ok_or("source pending Job missing")?;
        observer = Some(unsafe { JobObserver::start_ordinary(owned_job.0, user_sid.clone()) }?);
        let mut info = PROCESS_INFORMATION::default();
        win(
            unsafe {
                CreateProcessW(
                    image.as_ptr(),
                    command.as_mut_ptr(),
                    null(),
                    null(),
                    1,
                    CREATE_SUSPENDED
                        | CREATE_NO_WINDOW
                        | CREATE_UNICODE_ENVIRONMENT
                        | EXTENDED_STARTUPINFO_PRESENT,
                    environment.as_ptr().cast(),
                    working.as_ptr(),
                    &startup.StartupInfo,
                    &mut info,
                )
            },
            "source fixed tool creation",
        )?;
        child = Some((
            Handle(info.hProcess),
            Handle(info.hThread),
            pending_job.take().ok_or("source pending Job missing")?,
        ));
        let (process, thread, job) = child.as_ref().ok_or("source child missing")?;
        win(
            unsafe { AssignProcessToJobObject(job.0, process.0) },
            "source fixed tool Job",
        )?;
        if unsafe { ResumeThread(thread.0) } == u32::MAX {
            return Err("source tool resume failed".into());
        }
        if unsafe { WaitForSingleObject(process.0, 15000) } != WAIT_OBJECT_0 {
            return Err("source fixed tool timed out".into());
        }
        let mut exit = 0;
        win(
            unsafe { GetExitCodeProcess(process.0, &mut exit) },
            "source fixed exit",
        )?;
        report["actual_exit"] = serde_json::json!(exit);
        let entries = observer.as_mut().ok_or("source observer missing")?.finish();
        let totals = unsafe { accounting(job.0) }?;
        let paths = images
            .iter()
            .map(|image| image.identity.path.clone())
            .collect::<Vec<_>>();
        let topology = verified_source_tool_topology(
            &entries,
            totals.TotalProcesses,
            &paths,
            &PathBuf::from(&windows).join("System32").join("conhost.exe"),
            source_integrity,
        );
        report["observations"] = serde_json::to_value(entries).map_err(|e| e.to_string())?;
        report["total_processes"] = serde_json::json!(totals.TotalProcesses);
        report["topology_verified"] = serde_json::json!(topology);
        if exit != tool.expected_exit() || !topology {
            return Err("source tool positive control failed exit or complete topology".into());
        }
        Ok(())
    })();
    if let Some(observer) = &mut observer {
        observer.finish();
    }
    let stopped = child
        .as_ref()
        .is_none_or(|(process, _, job)| unsafe { end_process(process.0, job.0) });
    report["process_tree_stopped"] = serde_json::json!(stopped);
    report["error"] = serde_json::to_value(operation.err()).map_err(|e| e.to_string())?;
    if stopped {
        drop(child);
        if let Some(stdio) = stdio.take() {
            match stdio.read_after_stop(tool) {
                Ok([stdout, stderr]) => {
                    if matches!(tool, FixedTool::PowerShellEtwProbe) {
                        match crate::powershell_etw_probe::verify_delivery(&stdout) {
                            Ok(observation)
                                if observation.initializer_succeeded
                                    && observation
                                        .native_registrations
                                        .iter()
                                        .all(|entry| entry.register_code == 0) =>
                            {
                                report["etw_positive_initializer_verified"] =
                                    serde_json::json!(true);
                            }
                            Ok(_) => {
                                report["stdio_error"] =
                                    serde_json::json!("ordinary ETW initializer failed")
                            }
                            Err(error) => report["stdio_error"] = serde_json::json!(error),
                        }
                    }
                    if matches!(tool, FixedTool::GitDependencyProbe) {
                        let subject = images.get(1).ok_or("source dependency subject missing")?;
                        let bound = crate::git_dependency_probe::verify_delivery(&stdout, subject);
                        report["dependency_report_bound"] = serde_json::json!(bound.is_ok());
                        if let Err(error) = bound {
                            report["stdio_error"] = serde_json::json!(error);
                        }
                    }
                    report["stdout"] = serde_json::json!(stdout);
                    if matches!(tool, FixedTool::GitPrefixProbe) {
                        let bound = crate::git_prefix_probe::verify_delivery(&stdout, &root);
                        report["prefix_report_bound"] = serde_json::json!(bound.is_ok());
                        if let Err(error) = bound {
                            report["stdio_error"] = serde_json::json!(error);
                        }
                    }
                    report["stderr"] = serde_json::json!(stderr);
                }
                Err(error) => {
                    report["stdio_error"] = serde_json::json!(error);
                }
            }
        }
        if matches!(tool, FixedTool::PowerShell7RuntimeBuild) {
            match crate::fixed_tool::verify_powershell_build_dll(&root) {
                Ok(identity) => {
                    report["build_dll"] =
                        serde_json::to_value(identity).map_err(|e| e.to_string())?;
                    report["build_dll_verified"] = serde_json::json!(true);
                }
                Err(error) => report["error"] = serde_json::json!(error),
            }
            match crate::fixed_tool::verify_powershell_artifact(&root) {
                Ok(identity) => {
                    report["artifact"] =
                        serde_json::to_value(identity).map_err(|e| e.to_string())?;
                    report["artifact_verified"] = serde_json::json!(true);
                }
                Err(error) => report["error"] = serde_json::json!(error),
            }
        }
        if matches!(tool, FixedTool::GitBundleInit) {
            match crate::fixed_tool::verify_git_init(&root) {
                Ok(()) => report["repository_verified"] = serde_json::json!(true),
                Err(error) => report["error"] = serde_json::json!(error),
            }
        }
        drop(build_source_lease.take());
        match trash::delete(&root) {
            Ok(()) => report["fixture_recycled"] = serde_json::json!(true),
            Err(error) => report["cleanup_error"] = serde_json::json!(error.to_string()),
        }
    }
    report["positive_control_passed"] = serde_json::json!(
        report["error"].is_null()
            && report["stdio_error"].is_null()
            && report["topology_verified"].as_bool() == Some(true)
            && report["process_tree_stopped"].as_bool() == Some(true)
            && report["fixture_recycled"].as_bool() == Some(true)
    );
    Ok(report)
}
