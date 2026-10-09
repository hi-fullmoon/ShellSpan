//! Fixed owned account credentials in the SYSTEM credential set. Never serialize secrets.
use crate::appcontainer_probe::{query, win, Handle};
use std::ptr::{null_mut, write_volatile};
use uuid::Uuid;
use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::Security::Credentials::*;
use windows_sys::Win32::Security::*;
use windows_sys::Win32::System::Threading::*;

type Result<T> = std::result::Result<T, String>;
pub const OWNED_CREDENTIAL_DENIAL_CHECK: &str = "owned SYSTEM credential reference inaccessible";
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}
fn credential_denial_result(succeeded: bool, returned_object: bool, code: u32) -> Result<u32> {
    if succeeded {
        return Err(if returned_object {
            "owned SYSTEM credential unexpectedly readable by account probe"
        } else {
            "credential API succeeded without a credential object"
        }
        .into());
    }
    if returned_object {
        return Err("failed credential API returned an unexpected object".into());
    }
    if matches!(
        code,
        ERROR_NOT_FOUND | ERROR_ACCESS_DENIED | ERROR_NO_SUCH_LOGON_SESSION
    ) {
        Ok(code)
    } else {
        Err(format!(
            "owned credential negative probe unexpected Win32={code}"
        ))
    }
}
pub struct OwnedCredentialReference {
    target: String,
    account: String,
}
pub struct OwnedPassword(Vec<u16>);
impl OwnedPassword {
    pub fn as_utf16(&self) -> &[u16] {
        &self.0
    }
}
impl Drop for OwnedPassword {
    fn drop(&mut self) {
        for word in &mut self.0 {
            unsafe {
                write_volatile(word, 0);
            }
        }
    }
}
struct Credential(*mut CREDENTIALW);
impl Drop for Credential {
    fn drop(&mut self) {
        unsafe {
            let credential = &mut *self.0;
            for offset in 0..credential.CredentialBlobSize as usize {
                write_volatile(credential.CredentialBlob.add(offset), 0);
            }
            CredFree(self.0.cast());
        }
    }
}
fn require_system() -> Result<()> {
    let mut thread = null_mut();
    if unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 1, &mut thread) } != 0 {
        drop(Handle(thread));
        return Err("credential operations reject impersonation context".into());
    }
    if unsafe { GetLastError() } != ERROR_NO_TOKEN {
        return Err("credential thread identity unknown".into());
    }
    let mut raw = null_mut();
    win(
        unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) },
        "query credential owner",
    )?;
    let token = Handle(raw);
    let user = unsafe { query(token.0, TokenUser) }?;
    let sid = unsafe { (*user.as_ptr().cast::<TOKEN_USER>()).User.Sid };
    let mut size = SECURITY_MAX_SID_SIZE;
    let mut system = [0u8; SECURITY_MAX_SID_SIZE as usize];
    win(
        unsafe {
            CreateWellKnownSid(
                WinLocalSystemSid,
                null_mut(),
                system.as_mut_ptr().cast(),
                &mut size,
            )
        },
        "derive credential SYSTEM owner",
    )?;
    if unsafe { EqualSid(sid, system.as_mut_ptr().cast()) } == 0 {
        return Err("owned credential set requires actual SYSTEM primary identity".into());
    }
    Ok(())
}
fn require_primary_probe_context() -> Result<()> {
    let mut raw = null_mut();
    if unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 1, &mut raw) } != 0 {
        drop(Handle(raw));
        return Err("primary credential probe rejects thread impersonation".into());
    }
    let code = unsafe { GetLastError() };
    if code != ERROR_NO_TOKEN {
        return Err(format!(
            "primary credential thread identity unknown: Win32={code}"
        ));
    }
    Ok(())
}
impl OwnedCredentialReference {
    /// Fixed negative probe for an owned account's LPAC process. The SYSTEM
    /// controller must attest that this exact reference exists before launch.
    pub fn probe_account_denial(&self, account_sid: &str) -> Result<u32> {
        require_primary_probe_context()?;
        if !self.target.ends_with(&format!("/{account_sid}")) {
            return Err("credential denial probe account differs from fixed reference".into());
        }
        let mut raw = null_mut();
        win(
            unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) },
            "query credential probe identity",
        )?;
        let token = Handle(raw);
        self.probe_token_denial(account_sid, token, true)
    }
    pub fn probe_plain_primary_denial(&self, account_sid: &str) -> Result<u32> {
        require_primary_probe_context()?;
        let mut raw = null_mut();
        win(
            unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) },
            "query ordinary credential primary context",
        )?;
        self.probe_token_denial(account_sid, Handle(raw), false)
    }
    /// Diagnostic only. The caller must already have verified that the thread
    /// impersonates its own primary context; this never replaces the primary gate.
    pub(crate) fn probe_self_context_denial(
        &self,
        account_sid: &str,
        expected_appcontainer: bool,
    ) -> Result<u32> {
        let mut raw = null_mut();
        win(
            unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 1, &mut raw) },
            "query fixed self credential comparison context",
        )?;
        self.probe_token_denial(account_sid, Handle(raw), expected_appcontainer)
    }
    fn probe_token_denial(
        &self,
        account_sid: &str,
        token: Handle,
        expected_appcontainer: bool,
    ) -> Result<u32> {
        if !self.target.ends_with(&format!("/{account_sid}")) {
            return Err("ordinary credential primary differs from fixed reference".into());
        }
        let user = unsafe { query(token.0, TokenUser) }?;
        let actual = unsafe {
            crate::appcontainer_probe::sid_text((*user.as_ptr().cast::<TOKEN_USER>()).User.Sid)
        }?;
        let appcontainer = unsafe { query(token.0, TokenIsAppContainer) }?;
        if actual != account_sid
            || (unsafe { *appcontainer.as_ptr().cast::<u32>() } != 0) != expected_appcontainer
        {
            return Err(
                "owned credential probe requires exact account and AppContainer context".into(),
            );
        }
        self.read_denial()
    }
    /// SDK comparison only: caller must already be impersonating the exact
    /// ordinary owned account. It cannot query another account's reference.
    pub fn probe_plain_account_denial(&self, account_sid: &str) -> Result<u32> {
        if !self.target.ends_with(&format!("/{account_sid}")) {
            return Err(
                "ordinary credential comparison account differs from fixed reference".into(),
            );
        }
        let mut raw = null_mut();
        win(
            unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 1, &mut raw) },
            "query ordinary credential comparison context",
        )?;
        let token = Handle(raw);
        let user = unsafe { query(token.0, TokenUser) }?;
        let actual = unsafe {
            crate::appcontainer_probe::sid_text((*user.as_ptr().cast::<TOKEN_USER>()).User.Sid)
        }?;
        let appcontainer = unsafe { query(token.0, TokenIsAppContainer) }?;
        if actual != account_sid || unsafe { *appcontainer.as_ptr().cast::<u32>() } != 0 {
            return Err("ordinary credential comparison Token identity mismatch".into());
        }
        self.read_denial()
    }
    fn read_denial(&self) -> Result<u32> {
        let target = wide(&self.target);
        let mut credential = null_mut();
        // Reset only after argument preparation, then capture the API result
        // and last error before any destructor, formatting or another API call.
        unsafe {
            SetLastError(ERROR_SUCCESS);
        }
        let succeeded =
            unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential) } != 0;
        let code = unsafe { GetLastError() };
        let returned_object = !credential.is_null();
        if returned_object {
            drop(Credential(credential));
        }
        credential_denial_result(succeeded, returned_object, code)
    }
    fn validate_metadata(&self, credential: &CREDENTIALW) -> Result<()> {
        let same = |actual: *const u16, expected: &str| {
            if actual.is_null() {
                return false;
            }
            for (index, word) in wide(expected).iter().enumerate() {
                if unsafe { *actual.add(index) } != *word {
                    return false;
                }
            }
            true
        };
        if credential.Flags != 0
            || credential.AttributeCount != 0
            || !same(credential.TargetName, &self.target)
            || !same(credential.UserName, &self.account)
            || credential.Type != CRED_TYPE_GENERIC
            || credential.Persist != CRED_PERSIST_LOCAL_MACHINE
        {
            return Err("owned credential identity or metadata changed".into());
        }
        Ok(())
    }
    pub fn new(id: Uuid, account_sid: &str) -> Result<Self> {
        if id.is_nil() || !account_sid.starts_with("S-1-5-21-") {
            return Err("credential reference lacks exact owned account identity".into());
        }
        let parts: Vec<_> = account_sid.split('-').collect();
        if parts.len() != 8
            || parts
                .iter()
                .skip(4)
                .any(|part| part.parse::<u32>().is_err() || part.starts_with('0') && *part != "0")
        {
            return Err("credential account SID is not canonical".into());
        }
        Ok(Self {
            target: format!("ShellSpan/owned-account/v1/{id}/{account_sid}"),
            account: format!("SSPA{}", &id.simple().to_string()[..12]),
        })
    }
    pub fn reference(&self) -> &str {
        &self.target
    }
    fn lookup(&self) -> Result<Option<Credential>> {
        let mut raw = null_mut();
        if unsafe { CredReadW(wide(&self.target).as_ptr(), CRED_TYPE_GENERIC, 0, &mut raw) } == 0 {
            if unsafe { GetLastError() } == ERROR_NOT_FOUND {
                return Ok(None);
            }
            return Err(format!("owned credential lookup: Win32 {}", unsafe {
                GetLastError()
            }));
        }
        if raw.is_null() {
            return Err("owned credential lookup returned no object".into());
        }
        Ok(Some(Credential(raw)))
    }
    pub fn store(&self, password: &[u16]) -> Result<()> {
        require_system()?;
        if password.len() < 2
            || password.len() > 128
            || password.last() != Some(&0)
            || password[..password.len() - 1].contains(&0)
        {
            return Err("owned credential secret encoding invalid".into());
        }
        if self.lookup()?.is_some() {
            return Err("existing credential reference cannot be adopted".into());
        }
        let mut target = wide(&self.target);
        let mut account = wide(&self.account);
        let secret = OwnedPassword(password.to_vec());
        let credential = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: target.as_mut_ptr(),
            CredentialBlobSize: (secret.0.len() * 2) as u32,
            CredentialBlob: secret.0.as_ptr().cast_mut().cast(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            UserName: account.as_mut_ptr(),
            ..Default::default()
        };
        win(
            unsafe { CredWriteW(&credential, 0) },
            "persist owned credential reference",
        )
    }
    pub fn read(&self) -> Result<OwnedPassword> {
        require_system()?;
        let credential = self.lookup()?.ok_or("owned credential reference absent")?;
        let credential = unsafe { &*credential.0 };
        self.validate_metadata(credential)?;
        if credential.Type != CRED_TYPE_GENERIC
            || credential.Persist != CRED_PERSIST_LOCAL_MACHINE
            || credential.CredentialBlobSize < 4
            || credential.CredentialBlobSize > 256
            || credential.CredentialBlobSize % 2 != 0
            || credential.CredentialBlob.is_null()
        {
            return Err("owned credential metadata invalid".into());
        }
        let bytes = unsafe {
            std::slice::from_raw_parts(
                credential.CredentialBlob,
                credential.CredentialBlobSize as usize,
            )
        };
        let secret = OwnedPassword(
            bytes
                .chunks_exact(2)
                .map(|b| u16::from_le_bytes([b[0], b[1]]))
                .collect(),
        );
        if secret.0.last() != Some(&0) || secret.0[..secret.0.len() - 1].contains(&0) {
            return Err("owned credential secret encoding invalid".into());
        }
        Ok(secret)
    }
    pub fn remove(&self) -> Result<()> {
        require_system()?;
        let Some(credential) = self.lookup()? else {
            return Ok(());
        };
        self.validate_metadata(unsafe { &*credential.0 })?;
        drop(credential);
        win(
            unsafe { CredDeleteW(wide(&self.target).as_ptr(), CRED_TYPE_GENERIC, 0) },
            "retire owned credential reference",
        )?;
        if self.lookup()?.is_some() {
            return Err("owned credential absence unconfirmed".into());
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn actual_reset_last_error_lpac_run_still_rejects_rpc_failure_as_denial() {
        let receipt: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../docs/design/evidence/windows-stage-a-2026-10-09-credential-reset-profile.json"
        )))
        .unwrap();
        let checks = receipt["controller_admission_report"]["workload_report"]["checks"]
            .as_array()
            .unwrap();
        assert_eq!(checks.len(), 124);
        let failed: Vec<_> = checks
            .iter()
            .filter(|check| check["passed"] == false)
            .collect();
        assert_eq!(failed.len(), 1);
        assert_eq!(failed[0]["name"], OWNED_CREDENTIAL_DENIAL_CHECK);
        assert_eq!(
            failed[0]["detail"],
            "owned credential negative probe unexpected Win32=1702"
        );
        let audit: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../docs/design/evidence/windows-stage-a-2026-10-09-credential-reset-os-audit.json"
        )))
        .unwrap();
        for key in [
            "account_absent",
            "profile_absent",
            "hive_absent",
            "services_absent",
        ] {
            assert_eq!(audit[key], true, "{key}");
        }
    }
    #[test]
    fn credential_denial_requires_explicit_failure_and_a_known_denial_code() {
        for code in [
            ERROR_NOT_FOUND,
            ERROR_ACCESS_DENIED,
            ERROR_NO_SUCH_LOGON_SESSION,
        ] {
            assert_eq!(credential_denial_result(false, false, code).unwrap(), code);
            assert!(credential_denial_result(true, false, code).is_err());
            assert!(credential_denial_result(false, true, code).is_err());
        }
        for code in [0, 1702, 87, 2] {
            assert!(credential_denial_result(false, false, code).is_err());
        }
        assert!(credential_denial_result(true, true, 0)
            .unwrap_err()
            .contains("readable"));
    }
    #[test]
    fn ordinary_credential_api_overwrites_an_unrelated_prior_last_error() {
        let reference =
            OwnedCredentialReference::new(uuid::Uuid::new_v4(), "S-1-5-21-1-2-3-1001").unwrap();
        unsafe {
            SetLastError(1702);
        }
        assert_eq!(reference.read_denial().unwrap(), ERROR_NOT_FOUND);
    }
    #[test]
    fn self_credential_comparison_requires_thread_and_exact_owned_identity() {
        let reference =
            OwnedCredentialReference::new(Uuid::new_v4(), "S-1-5-21-1-2-3-1001").unwrap();
        assert!(reference
            .probe_self_context_denial("S-1-5-21-1-2-3-1001", false)
            .is_err());
        struct Revert;
        impl Drop for Revert {
            fn drop(&mut self) {
                if unsafe { RevertToSelf() } == 0 {
                    std::process::abort();
                }
            }
        }
        assert_ne!(unsafe { ImpersonateSelf(SecurityImpersonation) }, 0);
        let _guard = Revert;
        for result in [
            reference.probe_account_denial("S-1-5-21-1-2-3-1001"),
            reference.probe_plain_primary_denial("S-1-5-21-1-2-3-1001"),
        ] {
            assert_eq!(
                result.unwrap_err(),
                "primary credential probe rejects thread impersonation"
            );
        }
        let error = reference
            .probe_self_context_denial("S-1-5-21-1-2-3-1001", false)
            .unwrap_err();
        assert!(error.contains("exact account and AppContainer context"));
    }
    #[test]
    fn references_bind_uuid_and_canonical_account_sid() {
        let id = Uuid::new_v4();
        let reference = OwnedCredentialReference::new(id, "S-1-5-21-1-2-3-1001")
            .ok()
            .unwrap();
        assert!(reference.reference().contains(&id.to_string()));
        for sid in [
            "S-1-5-18",
            "S-1-5-21-1-2-3-01001",
            "S-1-5-21-1-2-3-1001/path",
        ] {
            assert!(OwnedCredentialReference::new(id, sid).is_err());
        }
        assert!(OwnedCredentialReference::new(Uuid::nil(), "S-1-5-21-1-2-3-1001").is_err());
    }
    #[test]
    fn ordinary_host_cannot_operate_system_owned_credentials() {
        let reference = OwnedCredentialReference::new(Uuid::new_v4(), "S-1-5-21-1-2-3-1001")
            .ok()
            .unwrap();
        assert!(reference
            .store(&[65, 0])
            .unwrap_err()
            .contains("actual SYSTEM"));
        assert!(reference.read().is_err());
        assert!(reference.remove().is_err());
        assert!(reference
            .probe_plain_account_denial("S-1-5-21-1-2-3-1001")
            .is_err());
    }
    #[test]
    fn mismatched_credential_account_or_target_cannot_authorize_read_or_delete() {
        let reference = OwnedCredentialReference::new(Uuid::new_v4(), "S-1-5-21-1-2-3-1001")
            .ok()
            .unwrap();
        let mut target = wide(reference.reference());
        let mut account = wide(&reference.account);
        let mut credential = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            TargetName: target.as_mut_ptr(),
            UserName: account.as_mut_ptr(),
            ..Default::default()
        };
        assert!(reference.validate_metadata(&credential).is_ok());
        let mut wrong = wide("unrelated-account");
        credential.UserName = wrong.as_mut_ptr();
        assert!(reference.validate_metadata(&credential).is_err());
        credential.UserName = account.as_mut_ptr();
        credential.TargetName = wrong.as_mut_ptr();
        assert!(reference.validate_metadata(&credential).is_err());
    }
}
