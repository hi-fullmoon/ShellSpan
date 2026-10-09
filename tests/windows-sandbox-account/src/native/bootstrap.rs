//! Parent-side owned account launcher, private desktop and receiver controls.
use super::*;
use crate::runner::{
    accounting, end_process, environment, identity, job, read_report, Config, Report,
};
use windows_sys::Win32::System::StationsAndDesktops::*;
use windows_sys::Win32::UI::WindowsAndMessaging::{CWF_CREATE_ONLY, SW_HIDE, WINSTA_ALL_ACCESS};
pub(super) struct Desktop {
    desktop: HDESK,
    station: HWINSTA,
}
impl Drop for Desktop {
    fn drop(&mut self) {
        unsafe {
            if !self.desktop.is_null() {
                CloseDesktop(self.desktop);
            }
            if !self.station.is_null() {
                CloseWindowStation(self.station);
            }
        }
    }
}
impl Desktop {
    pub(super) fn verify(&self, config: &Config) -> Result<()> {
        let subjects = [
            sid("S-1-5-18")?,
            sid("S-1-5-32-544")?,
            sid(&config.account_sid)?,
            sid(&config.restricting_sid)?,
        ];
        for object in [self.station, self.desktop] {
            let information = DACL_SECURITY_INFORMATION;
            let mut bytes = 0;
            unsafe {
                GetUserObjectSecurity(object, &information, null_mut(), 0, &mut bytes);
            }
            if bytes == 0 || bytes > 65536 {
                return Err("private desktop security descriptor budget invalid".into());
            }
            let mut storage = vec![0usize; (bytes as usize).div_ceil(std::mem::size_of::<usize>())];
            win(
                unsafe {
                    GetUserObjectSecurity(
                        object,
                        &information,
                        storage.as_mut_ptr().cast(),
                        bytes,
                        &mut bytes,
                    )
                },
                "query actual owned desktop security",
            )?;
            let mut dacl = null_mut();
            let mut present = 0;
            let mut defaulted = 0;
            win(
                unsafe {
                    GetSecurityDescriptorDacl(
                        storage.as_mut_ptr().cast(),
                        &mut present,
                        &mut dacl,
                        &mut defaulted,
                    )
                },
                "query private desktop DACL",
            )?;
            if present == 0 || dacl.is_null() || unsafe { (*dacl).AceCount } != 4 {
                return Err("private desktop has unexpected grants".into());
            }
            let mut found = [false; 4];
            for index in 0..4 {
                let mut ace = null_mut();
                win(
                    unsafe { GetAce(dacl, index, &mut ace) },
                    "inspect private desktop ACE",
                )?;
                if unsafe { (*ace.cast::<ACE_HEADER>()).AceType } != 0 {
                    return Err("unsupported private desktop ACE".into());
                }
                let allowed = unsafe { &*ace.cast::<ACCESS_ALLOWED_ACE>() };
                let subject = (&allowed.SidStart as *const u32).cast_mut().cast();
                let position = subjects
                    .iter()
                    .position(|expected| unsafe { EqualSid(subject, expected.0) } != 0)
                    .ok_or("foreign private desktop grant")?;
                if found[position] || allowed.Mask == 0 {
                    return Err("duplicate or empty private desktop grant".into());
                }
                found[position] = true;
            }
            let information = LABEL_SECURITY_INFORMATION;
            let mut bytes = 0;
            unsafe {
                GetUserObjectSecurity(object, &information, null_mut(), 0, &mut bytes);
            }
            if bytes == 0 || bytes > 65536 {
                return Err("private desktop label budget invalid".into());
            }
            let mut label = vec![0usize; (bytes as usize).div_ceil(std::mem::size_of::<usize>())];
            win(
                unsafe {
                    GetUserObjectSecurity(
                        object,
                        &information,
                        label.as_mut_ptr().cast(),
                        bytes,
                        &mut bytes,
                    )
                },
                "inspect private desktop mandatory label",
            )?;
            let mut sacl = null_mut();
            let mut present = 0;
            let mut defaulted = 0;
            win(
                unsafe {
                    GetSecurityDescriptorSacl(
                        label.as_mut_ptr().cast(),
                        &mut present,
                        &mut sacl,
                        &mut defaulted,
                    )
                },
                "inspect actual private label ACL",
            )?;
            if present == 0 || sacl.is_null() || unsafe { (*sacl).AceCount } != 1 {
                return Err("private desktop low label missing".into());
            }
            let mut ace = null_mut();
            win(
                unsafe { GetAce(sacl, 0, &mut ace) },
                "inspect owned mandatory label ACE",
            )?;
            let low = sid("S-1-16-4096")?;
            let label = unsafe { &*ace.cast::<SYSTEM_MANDATORY_LABEL_ACE>() };
            if label.Header.AceType != 0x11
                || label.Mask != windows_sys::Win32::System::SystemServices::SYSTEM_MANDATORY_LABEL_NO_WRITE_UP
                || unsafe { EqualSid((&label.SidStart as *const u32).cast_mut().cast(), low.0) }
                    == 0
            {
                return Err(
                    "private desktop mandatory label differs from frozen low policy".into(),
                );
            }
        }
        let mut flags = USEROBJECTFLAGS::default();
        let mut size = 0;
        win(
            unsafe {
                GetUserObjectInformationW(
                    self.station,
                    UOI_FLAGS,
                    (&mut flags as *mut USEROBJECTFLAGS).cast(),
                    std::mem::size_of_val(&flags) as u32,
                    &mut size,
                )
            },
            "query private station visibility",
        )?;
        if flags.fInherit != 0
            || flags.dwFlags & windows_sys::Win32::UI::WindowsAndMessaging::WSF_VISIBLE as u32 != 0
        {
            return Err("owned private station is visible or inheritable".into());
        }
        Ok(())
    }
    pub(super) fn finish(mut self, name: &str) -> Result<()> {
        win(
            unsafe { CloseDesktop(self.desktop) },
            "close owned private desktop",
        )?;
        self.desktop = null_mut();
        win(
            unsafe { CloseWindowStation(self.station) },
            "close owned private station",
        )?;
        self.station = null_mut();
        if !station_absent(name)? {
            return Err("owned private station remains after close".into());
        }
        Ok(())
    }
}
pub(super) fn station_absent(name: &str) -> Result<bool> {
    let station = unsafe { OpenWindowStationW(wide(name).as_ptr(), 0, READ_CONTROL) };
    if !station.is_null() {
        unsafe {
            CloseWindowStation(station);
        }
        return Ok(false);
    }
    let error = unsafe { GetLastError() };
    if error == ERROR_FILE_NOT_FOUND {
        Ok(true)
    } else {
        Err(format!(
            "private station absence unconfirmed: Win32 {error}"
        ))
    }
}

pub(super) fn private_desktop(config: &Config) -> Result<Desktop> {
    // Only these newly created, noninteractive objects receive grants. Never
    // modify WinSta0/Default or host desktop permissions.
    let (sd, _) = descriptor(&format!(
        "D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;{})(A;;GA;;;{})S:(ML;;NW;;;LW)",
        config.account_sid, config.restricting_sid
    ))?;
    let attrs = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: sd.0,
        bInheritHandle: 0,
    };
    let original = unsafe { GetProcessWindowStation() };
    let station = unsafe {
        CreateWindowStationW(
            wide(&config.station).as_ptr(),
            CWF_CREATE_ONLY,
            WINSTA_ALL_ACCESS as u32 | READ_CONTROL,
            &attrs,
        )
    };
    if station.is_null() {
        return Err(format!("create private station: Win32 {}", unsafe {
            GetLastError()
        }));
    }
    let selected = win(
        unsafe { SetProcessWindowStation(station) },
        "select private station for desktop creation",
    );
    if let Err(error) = selected {
        unsafe {
            CloseWindowStation(station);
        }
        return Err(error);
    }
    let desktop = unsafe {
        CreateDesktopW(
            wide(&config.desktop).as_ptr(),
            null(),
            null(),
            0,
            0x01ff | READ_CONTROL,
            &attrs,
        )
    };
    let create_error = unsafe { GetLastError() };
    if unsafe { SetProcessWindowStation(original) } == 0 {
        // Continuing fixture cleanup from an unexpected process station is unsafe.
        std::process::abort();
    }
    if desktop.is_null() {
        unsafe {
            CloseWindowStation(station);
        }
        return Err(format!("create private desktop: Win32 {create_error}"));
    }
    Ok(Desktop { desktop, station })
}

pub(super) fn run(
    root: &Path,
    account: &Account,
    password: &Password,
    account_sid: &str,
    restricting_sid: &str,
    receipt: &mut Receipt,
) -> Result<()> {
    let tcp: [TcpListener; 2] = [
        TcpListener::bind("127.0.0.1:0"),
        TcpListener::bind("[::1]:0"),
    ]
    .into_iter()
    .collect::<std::io::Result<Vec<_>>>()
    .map_err(|e| e.to_string())?
    .try_into()
    .map_err(|_| "TCP receiver count")?;
    let udp: [UdpSocket; 2] = [UdpSocket::bind("127.0.0.1:0"), UdpSocket::bind("[::1]:0")]
        .into_iter()
        .collect::<std::io::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?
        .try_into()
        .map_err(|_| "UDP receiver count")?;
    let config = Config {
        version: 1,
        account_sid: account_sid.into(),
        restricting_sid: restricting_sid.into(),
        station: format!("SSPA-{}", Uuid::new_v4().simple()),
        desktop: "probe".into(),
        tcp: [
            tcp[0].local_addr().map_err(|e| e.to_string())?,
            tcp[1].local_addr().map_err(|e| e.to_string())?,
        ],
        udp: [
            udp[0].local_addr().map_err(|e| e.to_string())?,
            udp[1].local_addr().map_err(|e| e.to_string())?,
        ],
    };
    for receiver in &tcp {
        receiver.set_nonblocking(true).map_err(|e| e.to_string())?;
        let positive = TcpStream::connect_timeout(
            &receiver.local_addr().map_err(|e| e.to_string())?,
            Duration::from_secs(1),
        )
        .map_err(|e| e.to_string())?;
        drop(receiver.accept().map_err(|e| e.to_string())?);
        drop(positive);
    }
    for receiver in &udp {
        receiver
            .set_read_timeout(Some(Duration::from_millis(700)))
            .map_err(|e| e.to_string())?;
        let address = receiver.local_addr().map_err(|e| e.to_string())?;
        let positive = UdpSocket::bind(if address.is_ipv4() {
            "127.0.0.1:0"
        } else {
            "[::1]:0"
        })
        .map_err(|e| e.to_string())?;
        positive
            .send_to(b"owned-positive-control", address)
            .map_err(|e| e.to_string())?;
        receiver
            .recv_from(&mut [0u8; 64])
            .map_err(|e| e.to_string())?;
    }
    fs::write(
        root.join("bootstrap.json"),
        serde_json::to_vec(&config).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let _desktop = private_desktop(&config)?;
    receipt.state = format!(
        "planned two-step launch; private station {}; desktop {}; fixed runner only",
        config.station, config.desktop
    );
    save(&root.join("ownership.json"), receipt)?;
    let job = job()?;
    let environment = environment(root)?;
    let executable = wide(root.join("runner.exe").to_str().ok_or("invalid runner")?);
    let mut command = wide("runner.exe --owned-bootstrap");
    let mut desktop = wide(&format!("{}\\{}", config.station, config.desktop));
    let startup = STARTUPINFOW {
        cb: std::mem::size_of::<STARTUPINFOW>() as u32,
        lpDesktop: desktop.as_mut_ptr(),
        dwFlags: STARTF_USESHOWWINDOW,
        wShowWindow: SW_HIDE as u16,
        ..Default::default()
    };
    let mut process = PROCESS_INFORMATION::default();
    account.enabled(true)?;
    let launch = win(
        unsafe {
            CreateProcessWithLogonW(
                wide(&account.name).as_ptr(),
                wide(".").as_ptr(),
                password.0.as_ptr(),
                0,
                executable.as_ptr(),
                command.as_mut_ptr(),
                CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
                environment.as_ptr().cast(),
                wide(root.to_str().ok_or("invalid root")?).as_ptr(),
                &startup,
                &mut process,
            )
        },
        "create fixed bootstrap as ordinary dedicated account",
    );
    // Always disable after the logon call, including failed launches.
    let disabled = account.enabled(false);
    launch?;
    let process_handle = Handle(process.hProcess);
    let thread = Handle(process.hThread);
    let mut bootstrap_report = None;
    let run = (|| {
        disabled?;
        win(
            unsafe { AssignProcessToJobObject(job.0, process_handle.0) },
            "assign suspended bootstrap to owned Job",
        )?;
        let mut actual = null_mut();
        win(
            unsafe { OpenProcessToken(process_handle.0, TOKEN_QUERY, &mut actual) },
            "query actual bootstrap Token",
        )?;
        let actual = Handle(actual);
        let mut report = Report::default();
        identity(actual.0, &config, false, &mut report)?;
        receipt.checks.extend(report.checks);
        if unsafe { ResumeThread(thread.0) } == u32::MAX {
            return Err("resume fixed bootstrap failed".into());
        }
        if unsafe { WaitForSingleObject(process_handle.0, 20000) } != WAIT_OBJECT_0 {
            return Err("bootstrap timed out".into());
        }
        let report = read_report(&root.join("scratch/bootstrap.json"))?;
        let error = report.error.clone();
        bootstrap_report = Some(report);
        if let Some(error) = error {
            return Err(error);
        }
        Ok::<(), String>(())
    })();
    let root_stopped = unsafe { end_process(process_handle.0, job.0) };
    let only_root = unsafe { accounting(job.0) }.is_ok_and(|info| info.TotalProcesses == 1);
    let child_stopped = only_root
        || bootstrap_report
            .as_ref()
            .is_some_and(|report| report.child_termination_confirmed);
    record(
        receipt,
        "two-step owned process termination confirmed",
        root_stopped,
        format!(
            "stable root/member handle waits and exact Job snapshot; tree stopped={root_stopped}; only root={only_root}; runner child proof={child_stopped}"
        ),
    );
    if !root_stopped {
        receipt
            .cleanup_debt
            .push("two-step process termination uncertain; keep account/ACL/WFP protection".into());
    }
    if let Some(report) = bootstrap_report {
        receipt.checks.extend(report.checks);
    }
    // A missing/failed child report never becomes a successful network proof.
    if run.is_ok() {
        for receiver in tcp {
            let address = receiver.local_addr().map_err(|e| e.to_string())?;
            let denied =
                matches!(receiver.accept(), Err(e) if e.kind() == std::io::ErrorKind::WouldBlock);
            record(receipt, format!("primary child TCP receiver {address}"), denied, "host positive control succeeded; actual restricted child API and receiver inspected");
        }
        for receiver in udp {
            let address = receiver.local_addr().map_err(|e| e.to_string())?;
            let denied = matches!(receiver.recv_from(&mut [0u8; 64]), Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut));
            record(
                receipt,
                format!("primary child UDP receiver {address}"),
                denied,
                "host positive control succeeded; no packet required regardless of Send result",
            );
        }
    }
    run
}
