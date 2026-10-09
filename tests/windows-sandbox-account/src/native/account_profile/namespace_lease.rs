//! A new call-unique package namespace, held by the controller. No shared ACL changes.
use super::*;
use windows_sys::Wdk::{
    Foundation::OBJECT_ATTRIBUTES,
    Storage::FileSystem::{NtCreateDirectoryObject, NtOpenDirectoryObject},
};

pub(super) fn name(package: &str) -> Result<String> {
    let mut session = 0;
    win(
        unsafe {
            windows_sys::Win32::System::RemoteDesktop::ProcessIdToSessionId(
                GetCurrentProcessId(),
                &mut session,
            )
        },
        "query owned namespace session",
    )?;
    Ok(format!(
        r"\Sessions\{session}\AppContainerNamedObjects\{package}"
    ))
}
fn attributes(name: &mut [u16], unicode: &mut UNICODE_STRING) -> OBJECT_ATTRIBUTES {
    *unicode = UNICODE_STRING {
        Length: ((name.len() - 1) * 2) as u16,
        MaximumLength: (name.len() * 2) as u16,
        Buffer: name.as_mut_ptr(),
    };
    OBJECT_ATTRIBUTES {
        Length: std::mem::size_of::<OBJECT_ATTRIBUTES>() as u32,
        ObjectName: unicode,
        Attributes: 0x40,
        ..Default::default()
    }
}
pub(super) struct Lease {
    handle: Option<Handle>,
    name: String,
}
pub(super) fn create(name: String, account: &str, package: &str) -> Result<Lease> {
    let mut buffer = wide(&name);
    let mut unicode = UNICODE_STRING::default();
    let mut attrs = attributes(&mut buffer, &mut unicode);
    let (sd, _) = descriptor(&format!(
        "D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;{account})(A;;GA;;;{package})S:(ML;;NW;;;LW)"
    ))?;
    attrs.SecurityDescriptor = sd.0.cast();
    let mut handle = null_mut();
    let code = unsafe { NtCreateDirectoryObject(&mut handle, 0x000f000f, &attrs) };
    // OBJ_OPENIF is deliberately absent. A collision is never adopted.
    if code < 0 {
        return Err(format!(
            "create exact owned package namespace NTSTATUS=0x{:08x}",
            code as u32
        ));
    }
    Ok(Lease {
        handle: Some(Handle(handle)),
        name,
    })
}
impl Lease {
    pub(super) fn verify(&self, account: &str, package: &str) -> Result<()> {
        let handle = self
            .handle
            .as_ref()
            .ok_or("owned namespace handle missing")?;
        let mut sd = null_mut();
        status(
            unsafe {
                GetSecurityInfo(
                    handle.0,
                    SE_KERNEL_OBJECT,
                    DACL_SECURITY_INFORMATION | LABEL_SECURITY_INFORMATION,
                    null_mut(),
                    null_mut(),
                    null_mut(),
                    null_mut(),
                    &mut sd,
                )
            },
            "inspect actual owned namespace security",
        )?;
        let storage = Local(sd);
        let subjects = [
            sid("S-1-5-18")?,
            sid("S-1-5-32-544")?,
            sid(account)?,
            sid(package)?,
        ];
        let mut dacl = null_mut();
        let mut present = 0;
        let mut defaulted = 0;
        win(
            unsafe {
                GetSecurityDescriptorDacl(storage.0, &mut present, &mut dacl, &mut defaulted)
            },
            "inspect namespace DACL",
        )?;
        if present == 0 || dacl.is_null() || unsafe { (*dacl).AceCount } != 4 {
            return Err("owned namespace grant count mismatch".into());
        }
        let mut found = [false; 4];
        for index in 0..4 {
            let mut ace = null_mut();
            win(
                unsafe { GetAce(dacl, index, &mut ace) },
                "inspect namespace ACE",
            )?;
            let allowed = unsafe { &*ace.cast::<ACCESS_ALLOWED_ACE>() };
            if allowed.Header.AceType != 0 || allowed.Mask != 0x000f000f {
                return Err("owned namespace ACE rights mismatch".into());
            }
            let subject = (&allowed.SidStart as *const u32).cast_mut().cast();
            let position = subjects
                .iter()
                .position(|expected| unsafe { EqualSid(subject, expected.0) } != 0)
                .ok_or("foreign namespace grant")?;
            if found[position] {
                return Err("duplicate namespace grant".into());
            }
            found[position] = true;
        }
        let mut sacl = null_mut();
        win(
            unsafe {
                GetSecurityDescriptorSacl(storage.0, &mut present, &mut sacl, &mut defaulted)
            },
            "inspect namespace label",
        )?;
        if present == 0 || sacl.is_null() || unsafe { (*sacl).AceCount } != 1 {
            return Err("owned namespace low label missing".into());
        }
        let mut ace = null_mut();
        win(
            unsafe { GetAce(sacl, 0, &mut ace) },
            "inspect namespace label ACE",
        )?;
        let low = sid("S-1-16-4096")?;
        let label = unsafe { &*ace.cast::<SYSTEM_MANDATORY_LABEL_ACE>() };
        if label.Header.AceType != 0x11
            || label.Mask != 1
            || unsafe { EqualSid((&label.SidStart as *const u32).cast_mut().cast(), low.0) } == 0
        {
            return Err("owned namespace label mismatch".into());
        }
        Ok(())
    }
    pub(super) fn finish(mut self) -> Result<()> {
        drop(self.handle.take());
        if !absent(&self.name)? {
            return Err("owned namespace remains after controller close; retain debt".into());
        }
        Ok(())
    }
}
pub(super) fn absent(name: &str) -> Result<bool> {
    let mut buffer = wide(name);
    let mut unicode = UNICODE_STRING::default();
    let attrs = attributes(&mut buffer, &mut unicode);
    let mut handle = null_mut();
    let code = unsafe { NtOpenDirectoryObject(&mut handle, READ_CONTROL, &attrs) };
    if code >= 0 {
        drop(Handle(handle));
        return Ok(false);
    }
    if code as u32 == 0xc0000034 {
        return Ok(true);
    }
    Err(format!(
        "owned namespace absence unknown NTSTATUS=0x{:08x}",
        code as u32
    ))
}

pub(super) fn wait_absent_observation(name: &str) -> Result<serde_json::Value> {
    let started = std::time::Instant::now();
    let mut attempts = 0;
    let result = observe_absence(
        || {
            attempts += 1;
            absent(name)
        },
        std::time::Duration::from_secs(2),
    );
    Ok(
        serde_json::json!({"scope":"exact owned namespace read-only retirement observation", "absent":result.as_ref().ok(), "error":result.as_ref().err(), "attempts":attempts, "elapsed_ms":started.elapsed().as_millis(), "budget_ms":2000}),
    )
}
fn observe_absence(
    mut inspect: impl FnMut() -> Result<bool>,
    budget: std::time::Duration,
) -> Result<bool> {
    let deadline = std::time::Instant::now() + budget;
    loop {
        if inspect()? {
            return Ok(true);
        }
        if std::time::Instant::now() >= deadline {
            return Ok(false);
        }
        std::thread::sleep(
            std::time::Duration::from_millis(50)
                .min(deadline.saturating_duration_since(std::time::Instant::now())),
        );
    }
}
pub(super) fn valid_name(name: &str, package: &str) -> bool {
    let Some(tail) = package.strip_prefix("S-1-15-2-") else {
        return false;
    };
    let components: Vec<_> = tail.split('-').collect();
    if components.len() != 7
        || components.iter().any(|component| {
            component
                .parse::<u32>()
                .ok()
                .is_none_or(|value| value.to_string() != *component)
        })
    {
        return false;
    }
    name.strip_prefix(r"\Sessions\")
        .and_then(|tail| tail.strip_suffix(&format!(r"\AppContainerNamedObjects\{package}")))
        .and_then(|session| session.parse::<u32>().ok())
        .is_some_and(|session| {
            name == format!(r"\Sessions\{session}\AppContainerNamedObjects\{package}")
        })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn namespace_binding_rejects_noncanonical_or_foreign_package_sid() {
        for package in [
            "S-1-5-18",
            "S-1-15-3-1-2-3-4-5-6-7",
            "S-1-15-2-01-2-3-4-5-6-7",
            "S-1-15-2-1-2-3",
            "S-1-15-2-4294967296-2-3-4-5-6-7",
            "S-1-15-2-1-2-3-4-5-6-7\\other",
        ] {
            assert!(
                !valid_name(
                    &format!(r"\Sessions\0\AppContainerNamedObjects\{package}"),
                    package
                ),
                "{package}"
            );
        }
    }
    #[test]
    fn actual_service_lifetime_presence_is_not_hidden_by_retirement_wait() {
        let original: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../docs/design/evidence/windows-stage-a-2026-10-09-namespace-wait-profile.json"
        )))
        .unwrap();
        let recovered: serde_json::Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/design/evidence/windows-stage-a-2026-10-09-namespace-wait-recovered-profile.json"))).unwrap();
        let wait = &original["namespace_retirement_observation"];
        assert_eq!(wait["absent"], false);
        assert!(wait["error"].is_null());
        assert!(wait["attempts"].as_u64().unwrap() > 1);
        assert!(wait["elapsed_ms"].as_u64().unwrap() >= 2000);
        assert!(!original["cleanup_debt"].as_array().unwrap().is_empty());
        assert_eq!(recovered["fixture_id"], original["fixture_id"]);
        assert_eq!(
            recovered["namespace_retirement_observation"]["absent"],
            true
        );
        assert_eq!(recovered["namespace_retirement_observation"]["attempts"], 1);
        assert!(recovered["cleanup_debt"].as_array().unwrap().is_empty());
    }
    #[test]
    fn absence_observation_keeps_unknown_errors_and_present_timeouts() {
        let mut calls = 0;
        assert!(observe_absence(
            || {
                calls += 1;
                Ok(calls == 2)
            },
            std::time::Duration::from_millis(200)
        )
        .unwrap());
        assert_eq!(calls, 2);
        assert!(!observe_absence(|| Ok(false), std::time::Duration::ZERO).unwrap());
        let mut errors = 0;
        assert!(observe_absence(
            || {
                errors += 1;
                Err("fixed unknown query status".into())
            },
            std::time::Duration::from_secs(2)
        )
        .unwrap_err()
        .contains("unknown"));
        assert_eq!(errors, 1);
    }
    #[test]
    fn namespace_name_accepts_only_exact_numeric_session_and_package() {
        let package = "S-1-15-2-1-2-3-4-5-6-7";
        assert!(valid_name(
            &format!(r"\Sessions\1\AppContainerNamedObjects\{package}"),
            package
        ));
        for session in ["01", "..", "1\\other", "-1", "4294967296"] {
            assert!(!valid_name(
                &format!(r"\Sessions\{session}\AppContainerNamedObjects\{package}"),
                package
            ));
        }
        assert!(!valid_name(
            r"\Sessions\1\AppContainerNamedObjects\S-1-15-2-9",
            package
        ));
    }
    #[test]
    fn owned_namespace_cannot_adopt_existing_directory_and_disappears_on_close() {
        let mut raw = null_mut();
        win(
            unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) },
            "inspect namespace test Token",
        )
        .unwrap();
        let token = Handle(raw);
        let account = token_sid(token.0).unwrap();
        let id = Uuid::new_v4();
        let words: Vec<_> = id
            .as_bytes()
            .chunks_exact(4)
            .map(|chunk| u32::from_le_bytes(chunk.try_into().unwrap()))
            .collect();
        let package = format!(
            "S-1-15-2-{}-{}-{}-{}-101-102-103",
            words[0], words[1], words[2], words[3]
        );
        let name = name(&package).unwrap();
        let lease = create(name.clone(), &account, &package).unwrap();
        lease.verify(&account, &package).unwrap();
        assert!(create(name.clone(), &account, &package)
            .err()
            .unwrap()
            .contains("0xc0000035"));
        lease.finish().unwrap();
        assert!(absent(&name).unwrap());
    }
}
