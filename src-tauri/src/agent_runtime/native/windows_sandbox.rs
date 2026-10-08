//! Windows admission gate and native development probes.
//! Production stays unavailable until driver and complete policy acceptance.
pub(crate) fn verified() -> bool {
    false
}
pub(crate) fn verify_backend() -> bool {
    false
}
pub(crate) const POLICY_GAP: &str = "Windows file filter and complete network enforcement are not verified; restricted execution remains unavailable";

#[cfg(test)]
mod prototype {
    use super::{verified, verify_backend, POLICY_GAP};
    use mxc_alpha_process_security_environment_spec::process_security_environment_layout as spec;
    use std::ffi::c_void;
    use std::fs::File;
    use std::io;
    use std::mem::{size_of, zeroed};
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::os::windows::process::ExitStatusExt;
    use std::path::Path;
    use std::process::ExitStatus;
    use std::ptr::{null, null_mut};
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::{
        HANDLE, HANDLE_FLAG_INHERIT, WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows_sys::Win32::System::JobObjects::*;
    use windows_sys::Win32::System::LibraryLoader::*;
    use windows_sys::Win32::System::Threading::*;

    type CreateEnvironment = unsafe extern "system" fn(*const c_void, u32, u32, *mut HANDLE) -> i32;
    type CloseEnvironment = unsafe extern "system" fn(HANDLE);
    type QuerySupport = unsafe extern "system" fn(*mut u64) -> i32;
    type QueryVersion = unsafe extern "system" fn(u32, *mut u8, *mut u32) -> i32;
    #[derive(Clone, Copy)]
    struct Api {
        create: CreateEnvironment,
        close: CloseEnvironment,
    }

    fn api() -> Result<Api, String> {
        static API: OnceLock<Result<Api, String>> = OnceLock::new();
        API.get_or_init(|| unsafe {
            // Load only the system DLL; successful cached exports live for the process lifetime.
            let module = LoadLibraryExW(
                wide("processmodel.dll")?.as_ptr(),
                null_mut(),
                LOAD_LIBRARY_SEARCH_SYSTEM32,
            );
            if module.is_null() {
                return Err(win_error("processmodel.dll"));
            }
            let create =
                GetProcAddress(module, c"CreateProcessSecurityEnvironment".as_ptr().cast());
            let close = GetProcAddress(module, c"CloseProcessSecurityEnvironment".as_ptr().cast());
            let query = GetProcAddress(
                module,
                c"QueryProcessSecurityEnvironmentSupport".as_ptr().cast(),
            );
            let version = GetProcAddress(
                module,
                c"IsProcessSecurityEnvironmentVersionSupported"
                    .as_ptr()
                    .cast(),
            );
            let (Some(create), Some(close), Some(query), Some(version)) =
                (create, close, query, version)
            else {
                return Err("sandboxBackendUnavailable: incomplete PSEC API".into());
            };
            let query: QuerySupport = std::mem::transmute(query);
            let version: QueryVersion = std::mem::transmute(version);
            let (mut support, mut available, mut minor) = (0, 0, 0);
            if query(&mut support) < 0
                || support & 9 != 9
                || version(1, &mut available, &mut minor) < 0
                || available == 0
                || minor < 1
            {
                return Err("sandboxBackendUnavailable: required PSEC controls unavailable".into());
            }
            Ok(Api {
                create: std::mem::transmute(create),
                close: std::mem::transmute(close),
            })
        })
        .clone()
    }
    fn wide(value: &str) -> Result<Vec<u16>, String> {
        if value.contains('\0') {
            return Err("sandboxPathInvalid: NUL character".into());
        }
        Ok(value.encode_utf16().chain(Some(0)).collect())
    }
    fn canonical_path(path: &Path) -> Result<String, String> {
        let canonical = std::fs::canonicalize(path)
            .map_err(|_| "sandboxPathInvalid: canonical path unavailable")?;
        let value = canonical
            .to_str()
            .ok_or("sandboxPathInvalid: UTF-8 path required")?;
        let value = value.strip_prefix(r"\\?\").unwrap_or(value);
        if value.starts_with(r"\\")
            || value.starts_with("UNC\\")
            || value.as_bytes().get(1) != Some(&b':')
        {
            return Err("sandboxPathInvalid: local drive required".into());
        }
        Ok(value.to_owned())
    }
    fn win_error(operation: &str) -> String {
        format!(
            "sandboxBackendUnavailable: {operation}: {}",
            io::Error::last_os_error()
        )
    }
    struct Environment {
        handle: HANDLE,
        close: CloseEnvironment,
    }
    // Uniquely owned opaque OS environment moved to one worker.
    unsafe impl Send for Environment {}
    impl Drop for Environment {
        fn drop(&mut self) {
            unsafe { (self.close)(self.handle) };
        }
    }
    fn environment(
        read: Vec<String>,
        write: Vec<String>,
        deny: Vec<String>,
    ) -> Result<Environment, String> {
        let api = api()?;
        let mut network = spec::NetworkPolicyT::default();
        let mut egress = spec::EndpointPolicyT::default();
        let mut rule = spec::EndpointRuleT::default();
        let mut port = spec::PortRuleT::default();
        port.end_port = u16::MAX;
        rule.ports = Some(vec![port]);
        egress.deny = Some(vec![rule]);
        network.egress = Some(Box::new(egress));
        let mut data = spec::ProcessSecurityEnvironmentT::default();
        data.version = spec::SchemaVersionT { major: 1, minor: 0 };
        // PowerShell initialization requires these; GUI isolation is not claimed.
        data.disallow_win32k_system_calls = false;
        data.ui_restrictions = 0;
        data.fs_read_only = Some(read);
        data.fs_read_write = Some(write);
        data.fs_deny = Some(deny);
        data.network_policy = Some(Box::new(network));
        let mut builder = flatbuffers::FlatBufferBuilder::new();
        let root = data.pack(&mut builder);
        spec::finish_process_security_environment_buffer(&mut builder, root);
        let bytes = builder.finished_data();
        let mut handle = null_mut();
        // Generated schema buffer and output remain valid for the call.
        let status =
            unsafe { (api.create)(bytes.as_ptr().cast(), bytes.len() as u32, 0, &mut handle) };
        if status < 0 || handle.is_null() {
            return Err(format!(
                "sandboxBackendUnavailable: CreateProcessSecurityEnvironment HRESULT {status:#x}"
            ));
        }
        Ok(Environment {
            handle,
            close: api.close,
        })
    }
    struct Attributes {
        _storage: Vec<usize>,
        list: LPPROC_THREAD_ATTRIBUTE_LIST,
    }
    impl Attributes {
        fn new() -> Result<Self, String> {
            let mut bytes = 0;
            unsafe { InitializeProcThreadAttributeList(null_mut(), 2, 0, &mut bytes) };
            if bytes == 0 {
                return Err(win_error("attribute sizing"));
            }
            let mut storage = vec![0usize; bytes.div_ceil(size_of::<usize>())];
            let list = storage.as_mut_ptr().cast();
            // Pointer-aligned storage contains at least the requested bytes.
            if unsafe { InitializeProcThreadAttributeList(list, 2, 0, &mut bytes) } == 0 {
                return Err(win_error("attribute initialization"));
            }
            Ok(Self {
                _storage: storage,
                list,
            })
        }
        fn add(&self, attribute: usize, value: *const c_void, bytes: usize) -> Result<(), String> {
            // Callers retain all referenced attribute values through process creation.
            if unsafe {
                UpdateProcThreadAttribute(self.list, 0, attribute, value, bytes, null_mut(), null())
            } == 0
            {
                return Err(win_error("process attribute"));
            }
            Ok(())
        }
    }
    impl Drop for Attributes {
        fn drop(&mut self) {
            unsafe { DeleteProcThreadAttributeList(self.list) };
        }
    }
    fn pipe(parent_reads: bool) -> Result<(File, OwnedHandle), String> {
        let (mut read, mut write) = (null_mut(), null_mut());
        let attributes = windows_sys::Win32::Security::SECURITY_ATTRIBUTES {
            nLength: size_of::<windows_sys::Win32::Security::SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: null_mut(),
            bInheritHandle: 1,
        };
        if unsafe {
            windows_sys::Win32::System::Pipes::CreatePipe(&mut read, &mut write, &attributes, 0)
        } == 0
        {
            return Err(win_error("stdio pipe"));
        }
        // Both successful handles become uniquely owned before any further failure.
        let read = unsafe { OwnedHandle::from_raw_handle(read) };
        let write = unsafe { OwnedHandle::from_raw_handle(write) };
        let (parent, child) = if parent_reads {
            (read, write)
        } else {
            (write, read)
        };
        if unsafe {
            windows_sys::Win32::Foundation::SetHandleInformation(
                parent.as_raw_handle(),
                HANDLE_FLAG_INHERIT,
                0,
            )
        } == 0
        {
            return Err(win_error("stdio inheritance"));
        }
        Ok((File::from(parent), child))
    }
    struct WindowsChild {
        process: OwnedHandle,
        job: OwnedHandle,
        environment: Option<Environment>,
        stdin: Option<File>,
        stdout: Option<File>,
        stderr: Option<File>,
        pid: u32,
        assigned: bool,
        teardown_confirmed: std::cell::Cell<bool>,
    }
    impl WindowsChild {
        fn try_wait(&self) -> io::Result<Option<ExitStatus>> {
            match unsafe { WaitForSingleObject(self.process.as_raw_handle(), 0) } {
                WAIT_TIMEOUT => Ok(None),
                WAIT_OBJECT_0 => {
                    let mut code = 0;
                    if unsafe { GetExitCodeProcess(self.process.as_raw_handle(), &mut code) } == 0 {
                        return Err(io::Error::last_os_error());
                    }
                    Ok(Some(ExitStatus::from_raw(code)))
                }
                _ => Err(io::Error::last_os_error()),
            }
        }
        fn wait(&self) -> io::Result<ExitStatus> {
            if unsafe { WaitForSingleObject(self.process.as_raw_handle(), 2_000) } != WAIT_OBJECT_0
            {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "sandbox process termination unconfirmed",
                ));
            }
            self.try_wait()?
                .ok_or_else(|| io::Error::other("sandbox process termination unconfirmed"))
        }
        fn terminate(&self) -> bool {
            unsafe {
                if self.assigned {
                    TerminateJobObject(self.job.as_raw_handle(), 1) != 0
                } else {
                    TerminateProcess(self.process.as_raw_handle(), 1) != 0
                }
            }
        }
        fn terminate_and_confirm(&self) -> bool {
            if self.teardown_confirmed.get() {
                return true;
            }
            // Hold process objects before termination. Job active count reaches
            // zero before the process objects are necessarily signaled.
            let mut descendants = Vec::new();
            let mut accounted = 1;
            if self.assigned {
                let mut ids = vec![0usize; 1026];
                if unsafe {
                    QueryInformationJobObject(
                        self.job.as_raw_handle(),
                        JobObjectBasicProcessIdList,
                        ids.as_mut_ptr().cast(),
                        (ids.len() * size_of::<usize>()) as u32,
                        null_mut(),
                    )
                } == 0
                {
                    self.terminate();
                    return false;
                }
                let list = unsafe { &*ids.as_ptr().cast::<JOBOBJECT_BASIC_PROCESS_ID_LIST>() };
                let count = list.NumberOfProcessIdsInList as usize;
                if count > 1024 {
                    self.terminate();
                    return false;
                }
                let process_ids =
                    unsafe { std::slice::from_raw_parts(list.ProcessIdList.as_ptr(), count) };
                for &id in process_ids {
                    if id == self.pid as usize {
                        continue;
                    }
                    let handle = unsafe {
                        OpenProcess(
                            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                            0,
                            id as u32,
                        )
                    };
                    if handle.is_null() {
                        self.terminate();
                        return false;
                    }
                    let handle = unsafe { OwnedHandle::from_raw_handle(handle) };
                    let mut in_job = 0;
                    if unsafe {
                        IsProcessInJob(
                            handle.as_raw_handle(),
                            self.job.as_raw_handle(),
                            &mut in_job,
                        )
                    } == 0
                        || in_job == 0
                    {
                        self.terminate();
                        return false;
                    }
                    descendants.push(handle);
                }
                accounted += descendants.len() as u32;
            }
            if !self.terminate() {
                return false;
            }
            let until = std::time::Instant::now() + std::time::Duration::from_secs(2);
            loop {
                let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { zeroed() };
                if unsafe {
                    QueryInformationJobObject(
                        self.job.as_raw_handle(),
                        JobObjectBasicAccountingInformation,
                        (&raw mut accounting).cast(),
                        size_of_val(&accounting) as u32,
                        null_mut(),
                    )
                } == 0
                {
                    return false;
                }
                let signaled = unsafe { WaitForSingleObject(self.process.as_raw_handle(), 0) } == WAIT_OBJECT_0
                    && descendants.iter().all(|process| unsafe { WaitForSingleObject(process.as_raw_handle(), 0) } == WAIT_OBJECT_0);
                // Missing exited/concurrently created descendants remain uncertain.
                if signaled
                    && (!self.assigned
                        || (accounting.ActiveProcesses == 0
                            && accounting.TotalProcesses == accounted))
                {
                    self.teardown_confirmed.set(true);
                    return true;
                }
                if std::time::Instant::now() >= until {
                    return false;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        }
    }
    impl Drop for WindowsChild {
        fn drop(&mut self) {
            if !self.terminate_and_confirm() {
                // Closing the Job requests termination but does not prove exit.
                if let Some(environment) = self.environment.take() {
                    std::mem::forget(environment);
                }
                log::warn!("Windows sandbox teardown unconfirmed; security environment retained");
            }
        }
    }
    fn system_root() -> Result<String, String> {
        let mut path = vec![0u16; 32768];
        let length = unsafe {
            windows_sys::Win32::System::SystemInformation::GetWindowsDirectoryW(
                path.as_mut_ptr(),
                path.len() as u32,
            )
        };
        if length == 0 || length as usize >= path.len() {
            return Err(win_error("Windows directory"));
        }
        String::from_utf16(&path[..length as usize]).map_err(|_| "sandboxPathInvalid".into())
    }
    fn launch(
        input: &str,
        cwd: &Path,
        read: Vec<String>,
        write: Vec<String>,
        deny: Vec<String>,
        temp: &Path,
    ) -> Result<WindowsChild, String> {
        use base64::Engine;
        let environment = environment(read, write, deny)?;
        let windows = system_root()?;
        let executable = wide(&format!(
            "{windows}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
        ))?;
        let encoded = base64::engine::general_purpose::STANDARD.encode(
            input
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<_>>(),
        );
        let mut command = wide(&format!("\"{windows}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" -NoLogo -NoProfile -NonInteractive -EncodedCommand {encoded}"))?;
        let cwd = wide(&canonical_path(cwd)?)?;
        let temp = canonical_path(temp)?;
        // Explicit command-private environment; no ambient secrets or PATH lookup.
        let entries = [
            format!("APPDATA={temp}"),
            format!("HOME={temp}"),
            format!("LOCALAPPDATA={temp}"),
            format!("PATH={windows}\\System32;{windows}\\System32\\WindowsPowerShell\\v1.0"),
            format!("SystemRoot={windows}"),
            format!("TEMP={temp}"),
            format!("TMP={temp}"),
            format!("USERPROFILE={temp}"),
            format!("WINDIR={windows}"),
        ];
        let mut env = entries
            .iter()
            .flat_map(|entry| entry.encode_utf16().chain(Some(0)))
            .collect::<Vec<_>>();
        env.push(0);
        let (stdin, stdin_child) = pipe(false)?;
        let (stdout, stdout_child) = pipe(true)?;
        let (stderr, stderr_child) = pipe(true)?;
        let inherited = [
            stdin_child.as_raw_handle(),
            stdout_child.as_raw_handle(),
            stderr_child.as_raw_handle(),
        ];
        let attributes = Attributes::new()?;
        attributes.add(
            35 | 0x0002_0000,
            (&raw const environment.handle).cast(),
            size_of::<HANDLE>(),
        )?;
        attributes.add(
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
            inherited.as_ptr().cast(),
            size_of_val(&inherited),
        )?;
        let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
        startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = inherited[0];
        startup.StartupInfo.hStdOutput = inherited[1];
        startup.StartupInfo.hStdError = inherited[2];
        startup.lpAttributeList = attributes.list;
        let job = unsafe { CreateJobObjectW(null(), null()) };
        if job.is_null() {
            return Err(win_error("sandbox job creation"));
        }
        let job = unsafe { OwnedHandle::from_raw_handle(job) };
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if unsafe {
            SetInformationJobObject(
                job.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                (&raw const limits).cast(),
                size_of_val(&limits) as u32,
            )
        } == 0
        {
            return Err(win_error("sandbox job configuration"));
        }
        let mut info: PROCESS_INFORMATION = unsafe { zeroed() };
        // All buffers remain alive. Assign the suspended root before it can run.
        if unsafe {
            CreateProcessW(
                executable.as_ptr(),
                command.as_mut_ptr(),
                null(),
                null(),
                1,
                EXTENDED_STARTUPINFO_PRESENT
                    | CREATE_UNICODE_ENVIRONMENT
                    | CREATE_SUSPENDED
                    | CREATE_NO_WINDOW,
                env.as_ptr().cast(),
                cwd.as_ptr(),
                &startup.StartupInfo,
                &mut info,
            )
        } == 0
        {
            return Err(win_error("contained process creation"));
        }
        let process = unsafe { OwnedHandle::from_raw_handle(info.hProcess) };
        let thread = unsafe { OwnedHandle::from_raw_handle(info.hThread) };
        let mut child = WindowsChild {
            process,
            job,
            environment: Some(environment),
            stdin: Some(stdin),
            stdout: Some(stdout),
            stderr: Some(stderr),
            pid: info.dwProcessId,
            assigned: false,
            teardown_confirmed: std::cell::Cell::new(false),
        };
        if unsafe {
            AssignProcessToJobObject(child.job.as_raw_handle(), child.process.as_raw_handle())
        } == 0
        {
            return Err(win_error("sandbox job assignment"));
        }
        child.assigned = true;
        if unsafe { ResumeThread(thread.as_raw_handle()) } == u32::MAX {
            return Err(win_error("sandbox resume"));
        }
        Ok(child)
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        use std::io::{BufRead, Read};
        fn collect(mut child: WindowsChild) -> (ExitStatus, String, String) {
            assert!(child.pid > 0);
            child.stdin.take();
            let mut stdout = child.stdout.take().unwrap();
            let mut stderr = child.stderr.take().unwrap();
            let out = std::thread::spawn(move || {
                let mut text = String::new();
                stdout.read_to_string(&mut text).unwrap();
                text
            });
            let err = std::thread::spawn(move || {
                let mut text = String::new();
                stderr.read_to_string(&mut text).unwrap();
                text
            });
            let until = std::time::Instant::now() + std::time::Duration::from_secs(15);
            while child.try_wait().unwrap().is_none() {
                assert!(
                    std::time::Instant::now() < until,
                    "native Windows fixture deadline"
                );
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            let status = child.wait().unwrap();
            if !child.terminate_and_confirm() {
                assert!(!verified(), "uncertain tree cannot admit production");
                assert!(
                    child.environment.is_some(),
                    "uncertain teardown must retain policy"
                );
            }
            (status, out.join().unwrap(), err.join().unwrap())
        }
        #[test]
        fn native_security_environment_enforces_exact_paths() {
            let root = tempfile::tempdir().unwrap();
            let temp = tempfile::tempdir().unwrap();
            std::fs::write(root.path().join("allowed.txt"), "fixture").unwrap();
            std::fs::write(root.path().join(".env"), "fixture-secret").unwrap();
            let root_path = canonical_path(root.path()).unwrap();
            let child = launch("$ErrorActionPreference='Stop'; Get-Content -LiteralPath allowed.txt; try { Get-Content -LiteralPath .env; exit 3 } catch {}; try { Set-Content -LiteralPath denied.txt -Value x; exit 4 } catch {}; exit 0",
                root.path(), vec![system_root().unwrap(), root_path.clone()], vec![canonical_path(temp.path()).unwrap()], vec![format!("{root_path}\\.env")], temp.path()).unwrap();
            let (status, stdout, stderr) = collect(child);
            assert_eq!(status.code(), Some(0), "stdout={stdout}, stderr={stderr}");
            assert!(stdout.contains("fixture"));
            assert!(!stdout.contains("fixture-secret"));
            assert!(!root.path().join("denied.txt").exists());
        }
        #[test]
        fn native_security_environment_rejects_unrepresentable_dotenv_name_rules() {
            let root = tempfile::tempdir().unwrap();
            let temp = tempfile::tempdir().unwrap();
            let root_path = canonical_path(root.path()).unwrap();
            let error = launch(
                "Set-Content -LiteralPath .env.new -Value x",
                root.path(),
                vec![system_root().unwrap()],
                vec![root_path.clone(), canonical_path(temp.path()).unwrap()],
                vec![format!("{root_path}\\.env*")],
                temp.path(),
            )
            .err()
            .expect("OS must reject unsupported wildcard policy");
            assert!(error.starts_with("sandboxBackendUnavailable:"), "{error}");
            assert!(!root.path().join(".env.new").exists());
        }
        #[test]
        fn native_security_environment_allows_workspace_writes_without_outside_access() {
            let root = tempfile::tempdir().unwrap();
            let temp = tempfile::tempdir().unwrap();
            let outside = tempfile::tempdir().unwrap();
            let outside_file = outside.path().join("private.txt");
            std::fs::write(&outside_file, "outside-fixture").unwrap();
            let script = format!("$ErrorActionPreference='Stop'; Set-Content -LiteralPath normal.txt -Value ok; Write-Output ($env:TEMP); Set-Content -LiteralPath ($env:TEMP+'\\temp.txt') -Value ok; try {{ Get-Content -LiteralPath '{}'; exit 3 }} catch {{}}; try {{ Set-Content -LiteralPath '{}' -Value x; exit 4 }} catch {{}}; exit 0",
                canonical_path(&outside_file).unwrap().replace('\'', "''"), canonical_path(outside.path()).unwrap().replace('\'', "''") + "\\outside.txt");
            let child = launch(
                &script,
                root.path(),
                vec![system_root().unwrap()],
                vec![
                    canonical_path(root.path()).unwrap(),
                    canonical_path(temp.path()).unwrap(),
                ],
                vec![],
                temp.path(),
            )
            .unwrap();
            let (status, stdout, stderr) = collect(child);
            assert_eq!(status.code(), Some(0), "stdout={stdout}, stderr={stderr}");
            assert!(root.path().join("normal.txt").exists());
            let effective_temp = Path::new(stdout.trim());
            assert!(
                effective_temp.starts_with(canonical_path(temp.path()).unwrap()),
                "temp must remain under command-owned root"
            );
            assert!(effective_temp.join("temp.txt").exists());
            assert!(!outside.path().join("outside.txt").exists());
            assert!(!stdout.contains("outside-fixture"));
        }
        #[test]
        fn native_network_probe_denies_loopback_packets_without_admitting_production() {
            let root = tempfile::tempdir().unwrap();
            let temp = tempfile::tempdir().unwrap();
            let tcp = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let udp = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
            let script = format!("$ErrorActionPreference='Stop'; $t=New-Object System.Net.Sockets.TcpClient; try {{ $t.Connect('127.0.0.1',{}); exit 3 }} catch {{ if ($_.Exception.InnerException.NativeErrorCode -ne 10013) {{ throw }} }}; $u=New-Object System.Net.Sockets.UdpClient; try {{ $u.Send([byte[]](1,2,3),3,'127.0.0.1',{}); exit 4 }} catch {{ if ($_.Exception.InnerException.NativeErrorCode -ne 10013) {{ throw }} }}; exit 0",
                tcp.local_addr().unwrap().port(), udp.local_addr().unwrap().port());
            let child = launch(
                &script,
                root.path(),
                vec![system_root().unwrap(), canonical_path(root.path()).unwrap()],
                vec![canonical_path(temp.path()).unwrap()],
                vec![],
                temp.path(),
            )
            .unwrap();
            let (status, stdout, stderr) = collect(child);
            // UDP Send can succeed for a dropped packet. Inspect the receiver;
            // this proves only IPv4 loopback, not complete network acceptance.
            assert!(
                matches!(status.code(), Some(0 | 4)),
                "stdout={stdout}, stderr={stderr}"
            );
            tcp.set_nonblocking(true).unwrap();
            udp.set_nonblocking(true).unwrap();
            assert_eq!(tcp.accept().unwrap_err().kind(), io::ErrorKind::WouldBlock);
            assert_eq!(
                udp.recv_from(&mut [0u8; 8]).unwrap_err().kind(),
                io::ErrorKind::WouldBlock
            );
            assert!(!verify_backend());
        }
        #[test]
        fn native_job_terminates_owned_descendants_before_policy_teardown() {
            let root = tempfile::tempdir().unwrap();
            let temp = tempfile::tempdir().unwrap();
            let script = "$p=Start-Process -FilePath ($env:WINDIR+'\\System32\\WindowsPowerShell\\v1.0\\powershell.exe') -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 60' -PassThru; Write-Output $p.Id; Start-Sleep -Seconds 60";
            let mut child = launch(
                script,
                root.path(),
                vec![system_root().unwrap(), canonical_path(root.path()).unwrap()],
                vec![canonical_path(temp.path()).unwrap()],
                vec![],
                temp.path(),
            )
            .unwrap();
            let stdout = child.stdout.take().unwrap();
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let mut reader = io::BufReader::new(stdout);
                let mut line = String::new();
                let _ = reader.read_line(&mut line);
                let _ = tx.send(line);
            });
            let pid = rx
                .recv_timeout(std::time::Duration::from_secs(15))
                .expect("descendant launch deadline")
                .trim()
                .parse::<u32>()
                .unwrap();
            let descendant = unsafe {
                OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                    0,
                    pid,
                )
            };
            assert!(
                !descendant.is_null(),
                "owned descendant must exist before cancellation"
            );
            let descendant = unsafe { OwnedHandle::from_raw_handle(descendant) };
            let mut assigned = 0;
            assert_ne!(
                unsafe {
                    IsProcessInJob(
                        descendant.as_raw_handle(),
                        child.job.as_raw_handle(),
                        &mut assigned,
                    )
                },
                0
            );
            assert_ne!(assigned, 0);
            assert!(child.terminate_and_confirm());
            assert_eq!(
                unsafe { WaitForSingleObject(descendant.as_raw_handle(), 0) },
                WAIT_OBJECT_0
            );
            assert!(child.wait().is_ok());
        }
        #[test]
        fn production_admission_stays_closed_until_the_filter_is_verified() {
            assert!(!verify_backend());
            assert!(!verified());
            assert!(!POLICY_GAP.is_empty());
        }
    }
}
