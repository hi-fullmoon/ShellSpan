//! Read-only named-object diagnostics. Never mutates the shared KnownDlls objects.
use super::*;
use windows_sys::Wdk::Foundation::OBJECT_ATTRIBUTES;
use windows_sys::Wdk::Storage::FileSystem::NtOpenDirectoryObject;
use windows_sys::Wdk::System::Memory::NtOpenSection;

const OBJECTS: [(&str, bool); 3] = [
    (r"\KnownDlls", true),
    (r"\KnownDlls\ntdll.dll", false),
    (r"\KnownDlls\kernel32.dll", false),
];

fn open_with_access(path: &str, directory: bool, access: u32) -> i32 {
    let mut name = wide(path);
    let mut unicode = UNICODE_STRING {
        Length: ((name.len() - 1) * 2) as u16,
        MaximumLength: (name.len() * 2) as u16,
        Buffer: name.as_mut_ptr(),
    };
    let attributes = OBJECT_ATTRIBUTES {
        Length: std::mem::size_of::<OBJECT_ATTRIBUTES>() as u32,
        ObjectName: &mut unicode,
        Attributes: 0x40, // OBJ_CASE_INSENSITIVE, never OBJ_KERNEL_HANDLE.
        ..Default::default()
    };
    let mut handle = null_mut();
    let status = unsafe {
        if directory {
            NtOpenDirectoryObject(&mut handle, access, &attributes)
        } else {
            NtOpenSection(&mut handle, access, &attributes)
        }
    };
    if status >= 0 {
        drop(Handle(handle));
    }
    status
}

fn open_status(path: &str, directory: bool) -> i32 {
    open_with_access(path, directory, if directory { 1 } else { 0x0c })
}

pub(super) fn setup_admission() -> Vec<Check> {
    OBJECTS.into_iter().map(|(path, directory)| {
        let control = open_with_access(path, directory, READ_CONTROL);
        let admission = open_with_access(path, directory, READ_CONTROL | WRITE_DAC);
        Check {
            name: format!("setup loader ACL admission: {path}"),
            passed: control >= 0 && admission >= 0,
            detail: format!("READ_CONTROL NTSTATUS=0x{:08x}; READ_CONTROL|WRITE_DAC NTSTATUS=0x{:08x}; handles closed; no ACL write, privilege grant or ownership takeover", control as u32, admission as u32),
        }
    }).collect()
}

pub(super) fn diagnose(
    ordinary_token: HANDLE,
    restricted: HANDLE,
    report: &mut Report,
) -> Result<()> {
    for (path, directory) in OBJECTS {
        let ordinary = impersonated(ordinary_token, || open_status(path, directory))?;
        let restricted_status = impersonated(restricted, || open_status(path, directory))?;
        report.checks.push(Check {
            name: format!("restricted loader named-object access: {path}"),
            passed: ordinary >= 0 && restricted_status >= 0,
            detail: format!(
                "read-only actual open: ordinary NTSTATUS=0x{:08x}, restricted NTSTATUS=0x{:08x}; no object ACL mutation; diagnostic does not prove loader causal path",
                ordinary as u32, restricted_status as u32
            ),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn named_object_probe_distinguishes_restriction_from_missing_object() {
        let base = token().unwrap();
        let restriction = sid("S-1-5-21-771911-771912-771913-771914").unwrap();
        let restricted = restricted(base.0, &restriction).unwrap();
        let mut report = Report {
            checks: vec![],
            child_termination_confirmed: false,
            error: None,
        };
        diagnose(base.0, restricted.0, &mut report).unwrap();
        assert_eq!(report.checks.len(), 3);
        assert!(
            report
                .checks
                .iter()
                .all(|check| !check.passed
                    && check.detail.contains("restricted NTSTATUS=0xc0000022")),
            "unique restriction must not inherit ordinary-account access to shared loader objects"
        );
        assert!(
            report
                .checks
                .iter()
                .all(|check| check.detail.contains("ordinary NTSTATUS=0x00000000")),
            "positive control must open actual objects: {:?}",
            report
                .checks
                .iter()
                .map(|check| &check.detail)
                .collect::<Vec<_>>()
        );
        assert_eq!(
            open_status(r"\KnownDlls\ShellSpan-absent-fixed-probe.dll", false) as u32,
            0xc0000034
        );
    }
}
