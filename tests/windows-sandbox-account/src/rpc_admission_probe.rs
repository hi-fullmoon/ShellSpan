//! Fixed RPC/LSA diagnostics and an optional exact owned-reference negative probe.
use crate::appcontainer_probe::{query, sid_text, Handle};
use serde::{Deserialize, Serialize};
use std::ptr::{null, null_mut};
use uuid::Uuid;
use windows_sys::Win32::Foundation::{GetLastError, ERROR_NO_TOKEN, HANDLE};
use windows_sys::Win32::Security::Authentication::Identity::{
    LsaConnectUntrusted, LsaDeregisterLogonProcess,
};
use windows_sys::Win32::Security::*;
use windows_sys::Win32::System::Com::{RPC_C_AUTHN_LEVEL_PKT_PRIVACY, RPC_C_IMP_LEVEL_IDENTIFY};
use windows_sys::Win32::System::Rpc::*;
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, GetCurrentThread, OpenProcessToken, OpenThreadToken,
};

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RpcAdmissionObservation {
    #[serde(default)]
    pub rpc_provider_registration: Option<crate::rpc_trace::Registration>,
    #[serde(default)]
    pub lsa_connection: Option<LsaConnectionObservation>,
    #[serde(default)]
    pub lsa_self_comparison: Option<LsaSelfObservation>,
    pub compose_status: i32,
    pub binding_status: Option<i32>,
    #[serde(default)]
    pub auth_status: Option<i32>,
    pub free_binding_status: Option<i32>,
    pub free_string_status: Option<i32>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LsaSelfObservation {
    #[serde(default)]
    pub dns_cache_only: Option<crate::dns_native_probe::DnsApiObservation>,
    #[serde(default)]
    pub dns_cache_only_sync: Option<crate::dns_native_probe::DnsApiObservation>,
    pub impersonate_win32: Option<u32>,
    pub security_context_equal: bool,
    pub connection: Option<LsaConnectionObservation>,
    pub restored: bool,
    pub error: Option<String>,
    #[serde(default)]
    pub credential_denial_win32: Option<u32>,
    #[serde(default)]
    pub credential_error: Option<String>,
}
struct SelfContext;
impl Drop for SelfContext {
    fn drop(&mut self) {
        if unsafe { RevertToSelf() } == 0 {
            std::process::abort();
        }
    }
}
fn thread_has_no_token() -> Result<bool, String> {
    let mut raw = null_mut();
    if unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 1, &mut raw) } != 0 {
        let _held = Handle(raw);
        return Ok(false);
    }
    let code = unsafe { GetLastError() };
    if code != ERROR_NO_TOKEN {
        return Err(format!("fixed LSA thread context query: Win32 {code}"));
    }
    Ok(true)
}
fn capability_array_count(count: u32, storage_bytes: usize) -> Result<usize, String> {
    let count = usize::try_from(count).map_err(|_| "capability count unavailable")?;
    if count > 64 {
        return Err("fixed LSA capability comparison exceeds budget".into());
    }
    let required = count
        .checked_mul(std::mem::size_of::<SID_AND_ATTRIBUTES>())
        .and_then(|bytes| bytes.checked_add(std::mem::offset_of!(TOKEN_GROUPS, Groups)))
        .ok_or("capability array size overflow")?;
    if required > storage_bytes {
        return Err("truncated native capability array".into());
    }
    Ok(count)
}
fn security_signature(token: HANDLE) -> Result<Vec<String>, String> {
    unsafe {
        let user = query(token, TokenUser)?;
        let integrity = query(token, TokenIntegrityLevel)?;
        let app = query(token, TokenIsAppContainer)?;
        let statistics = query(token, TokenStatistics)?;
        let stats = &*statistics.as_ptr().cast::<TOKEN_STATISTICS>();
        let is_app = *app.as_ptr().cast::<u32>();
        let mut result = vec![
            sid_text((*user.as_ptr().cast::<TOKEN_USER>()).User.Sid)?,
            sid_text(
                (*integrity.as_ptr().cast::<TOKEN_MANDATORY_LABEL>())
                    .Label
                    .Sid,
            )?,
            is_app.to_string(),
            format!(
                "{}:{}",
                stats.AuthenticationId.HighPart, stats.AuthenticationId.LowPart
            ),
        ];
        if is_app != 0 {
            let package = query(token, TokenAppContainerSid)?;
            result.push(sid_text(
                (*package.as_ptr().cast::<TOKEN_APPCONTAINER_INFORMATION>()).TokenAppContainer,
            )?);
            let caps = query(token, TokenCapabilities)?;
            let storage_bytes = std::mem::size_of_val(caps.as_slice());
            if storage_bytes < std::mem::offset_of!(TOKEN_GROUPS, Groups) {
                return Err("truncated native capability header".into());
            }
            let groups = &*caps.as_ptr().cast::<TOKEN_GROUPS>();
            let count = capability_array_count(groups.GroupCount, storage_bytes)?;
            let mut capabilities = std::slice::from_raw_parts(groups.Groups.as_ptr(), count)
                .iter()
                .map(|group| Ok(format!("{}:{}", sid_text(group.Sid)?, group.Attributes)))
                .collect::<Result<Vec<_>, String>>()?;
            let unique: std::collections::BTreeSet<_> = capabilities
                .iter()
                .map(|capability| capability.split(':').next().unwrap_or_default())
                .collect();
            if unique.len() != capabilities.len() {
                return Err("duplicate native capability SID".into());
            }
            capabilities.sort();
            result.extend(capabilities);
        }
        Ok(result)
    }
}
pub fn observe_dns_self_context(id: Uuid) -> Result<LsaSelfObservation, String> {
    if id.is_nil() {
        return Err("DNS self comparison requires owned UUID".into());
    }
    observe_self_connection(Some(id))
}

fn credential_reference_environment(
    value: Result<String, std::env::VarError>,
) -> Result<Option<String>, String> {
    match value {
        Ok(value) => Ok(Some(value)),
        Err(std::env::VarError::NotPresent) => Ok(None),
        Err(std::env::VarError::NotUnicode(_)) => {
            Err("self credential reference environment is not Unicode".into())
        }
    }
}

fn observe_self_connection(id: Option<Uuid>) -> Result<LsaSelfObservation, String> {
    if !thread_has_no_token()? {
        return Err("fixed LSA comparison rejects existing thread impersonation".into());
    }
    let mut raw = null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) } == 0 {
        return Err("fixed LSA comparison cannot open primary token".into());
    }
    let primary = Handle(raw);
    let before = security_signature(primary.0)?;
    let target = credential_reference_environment(std::env::var("SSPA_CREDENTIAL_REF"))?;
    let credential = match (id, target) {
        (Some(id), Some(target)) => {
            let reference =
                crate::credential_reference::OwnedCredentialReference::new(id, &before[0])?;
            if target != reference.reference() {
                return Err("self credential comparison differs from fixed UUID/account".into());
            }
            Some(reference)
        }
        _ => None,
    };
    let mut result = LsaSelfObservation {
        dns_cache_only: None,
        dns_cache_only_sync: None,
        impersonate_win32: None,
        security_context_equal: false,
        connection: None,
        restored: false,
        error: None,
        credential_denial_win32: None,
        credential_error: None,
    };
    if unsafe { ImpersonateSelf(SecurityImpersonation) } == 0 {
        result.impersonate_win32 = Some(unsafe { GetLastError() });
        result.restored = thread_has_no_token()?;
        return Ok(result);
    }
    let guard = SelfContext;
    let comparison = (|| {
        let mut thread = null_mut();
        if unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 1, &mut thread) } == 0 {
            return Err("fixed LSA comparison cannot inspect self token".into());
        }
        let thread = Handle(thread);
        result.security_context_equal = before == security_signature(thread.0)?;
        if !result.security_context_equal {
            return Err("fixed LSA comparison changed security context".into());
        }
        result.connection = Some(observe_lsa_connection());
        if let Some(id) = id {
            result.dns_cache_only = Some(crate::dns_native_probe::query_cache_only(id)?);
            result.dns_cache_only_sync = Some(crate::dns_native_probe::query_cache_only_sync(id)?);
        }
        if let Some(reference) = credential {
            let denial = reference.probe_self_context_denial(&before[0], before[2] != "0");
            result.credential_denial_win32 = denial.as_ref().ok().copied();
            result.credential_error = denial.err();
        }
        Ok(())
    })();
    drop(guard);
    result.restored = thread_has_no_token()? && before == security_signature(primary.0)?;
    result.error = comparison.err();
    if !result.restored {
        return Err("fixed LSA comparison failed to restore primary context".into());
    }
    Ok(result)
}
/// Connection admission only: never queries packages, sessions or credentials.
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LsaConnectionObservation {
    pub connect_status: i32,
    pub handle_returned: bool,
    pub close_status: Option<i32>,
}
fn observe_lsa_connection() -> LsaConnectionObservation {
    let mut handle = null_mut();
    let connect_status = unsafe { LsaConnectUntrusted(&mut handle) };
    let handle_returned = !handle.is_null();
    // LSA handles require their own closer, never CloseHandle.
    let close_status = handle_returned.then(|| unsafe { LsaDeregisterLogonProcess(handle) });
    LsaConnectionObservation {
        connect_status,
        handle_returned,
        close_status,
    }
}
impl RpcAdmissionObservation {
    pub fn completed(&self) -> bool {
        self.compose_status == 0
            && self
                .rpc_provider_registration
                .as_ref()
                .is_none_or(|entry| entry.consistent())
            && self.binding_status == Some(0)
            && self.free_binding_status == Some(0)
            && self.free_string_status == Some(0)
    }
    pub fn authentication_configured(&self) -> bool {
        self.completed() && self.auth_status == Some(0)
    }
}
pub fn observe(id: Uuid) -> Result<RpcAdmissionObservation, String> {
    if id.is_nil() {
        return Err("fixed RPC binding requires owned nonnil UUID".into());
    }
    // Complete fallible context checks before allocating any RPC binding.
    let lsa_connection = observe_lsa_connection();
    let lsa_self_comparison = observe_self_connection(Some(id))?;
    let protocol: Vec<u16> = "ncalrpc".encode_utf16().chain(Some(0)).collect();
    let endpoint: Vec<u16> = format!("ShellSpan-fixed-binding-{}", id.simple())
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let mut string = null_mut();
    let compose_status = unsafe {
        RpcStringBindingComposeW(
            null(),
            protocol.as_ptr(),
            null(),
            endpoint.as_ptr(),
            null(),
            &mut string,
        )
    };
    let mut result = RpcAdmissionObservation {
        rpc_provider_registration: Some(crate::rpc_trace::observe_registration()),
        lsa_connection: Some(lsa_connection),
        lsa_self_comparison: Some(lsa_self_comparison),
        compose_status,
        binding_status: None,
        auth_status: None,
        free_binding_status: None,
        free_string_status: None,
    };
    if compose_status == 0 && !string.is_null() {
        let mut binding = null_mut();
        result.binding_status = Some(unsafe { RpcBindingFromStringBindingW(string, &mut binding) });
        if !binding.is_null() {
            if result.binding_status == Some(0) {
                let qos = RPC_SECURITY_QOS {
                    Version: RPC_C_SECURITY_QOS_VERSION as u32,
                    Capabilities: RPC_C_QOS_CAPABILITIES_DEFAULT,
                    IdentityTracking: RPC_C_QOS_IDENTITY_STATIC,
                    ImpersonationType: RPC_C_IMP_LEVEL_IDENTIFY,
                };
                // Uses the current token context; configuring this unused binding
                // neither contacts a server nor proves server authentication.
                result.auth_status = Some(unsafe {
                    RpcBindingSetAuthInfoExW(
                        binding,
                        null(),
                        RPC_C_AUTHN_LEVEL_PKT_PRIVACY,
                        RPC_C_AUTHN_WINNT,
                        null(),
                        RPC_C_AUTHZ_NONE,
                        &qos,
                    )
                });
            }
            result.free_binding_status = Some(unsafe { RpcBindingFree(&mut binding) });
        }
    }
    if !string.is_null() {
        result.free_string_status = Some(unsafe { RpcStringFreeW(&mut string) });
    }
    Ok(result)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn malformed_credential_environment_cannot_skip_owned_reference_probe() {
        use std::os::windows::ffi::OsStringExt;
        assert!(
            credential_reference_environment(Err(std::env::VarError::NotUnicode(
                std::ffi::OsString::from_wide(&[0xd800]),
            )))
            .is_err()
        );
        assert_eq!(
            credential_reference_environment(Err(std::env::VarError::NotPresent)).unwrap(),
            None
        );
        assert_eq!(
            credential_reference_environment(Ok(String::new())).unwrap(),
            Some(String::new())
        );
    }
    #[test]
    fn same_identity_dns_cache_comparison_restores_primary_context() {
        let result = observe_self_connection(Some(Uuid::new_v4())).unwrap();
        assert!(
            result.security_context_equal && result.restored && result.error.is_none(),
            "equal={}, restored={}, error={:?}",
            result.security_context_equal,
            result.restored,
            result.error
        );
        let dns = result.dns_cache_only.unwrap();
        assert_eq!(dns.completion_status, Some(9701), "{dns:?}");
        assert!(!dns.records_returned && !dns.timed_out && dns.cancel_status.is_none());
        assert!(!dns.explicit_api_denial());
    }
    #[test]
    fn capability_comparison_bounds_native_storage_before_slice_creation() {
        let header = std::mem::offset_of!(TOKEN_GROUPS, Groups);
        let item = std::mem::size_of::<SID_AND_ATTRIBUTES>();
        assert_eq!(capability_array_count(0, header).unwrap(), 0);
        assert_eq!(capability_array_count(2, header + 2 * item).unwrap(), 2);
        assert!(capability_array_count(2, header + 2 * item - 1).is_err());
        assert!(capability_array_count(0, header - 1).is_err());
        assert!(capability_array_count(65, usize::MAX).is_err());
    }
    #[test]
    fn self_lsa_comparison_preserves_context_and_rejects_existing_impersonation() {
        let result = observe_self_connection(None).unwrap();
        assert!(result.security_context_equal && result.restored);
        assert!(result.error.is_none());
        assert_eq!(result.connection.unwrap().close_status, Some(0));
        assert_ne!(unsafe { ImpersonateSelf(SecurityImpersonation) }, 0);
        let guard = SelfContext;
        assert!(observe_self_connection(None).is_err());
        assert!(!thread_has_no_token().unwrap());
        drop(guard);
        assert!(thread_has_no_token().unwrap());
    }
    #[test]
    fn ordinary_lsa_connection_is_closed_without_querying_data() {
        let result = observe_lsa_connection();
        assert_eq!(result.connect_status, 0);
        assert!(result.handle_returned);
        assert_eq!(result.close_status, Some(0));
    }
    #[test]
    fn lsa_admission_does_not_replace_rpc_or_credential_authorization() {
        let mut result = observe(Uuid::new_v4()).unwrap();
        result.lsa_connection = Some(LsaConnectionObservation {
            connect_status: -1,
            handle_returned: false,
            close_status: None,
        });
        assert!(result.authentication_configured());
        result.binding_status = Some(1702);
        assert!(!result.completed());
    }
    #[test]
    fn ordinary_client_creates_and_releases_fixed_local_binding_without_server() {
        assert!(observe(Uuid::new_v4()).unwrap().completed());
        assert!(observe(Uuid::nil()).is_err());
    }
    #[test]
    fn ordinary_client_configures_current_context_authentication_without_server() {
        let observation = observe(Uuid::new_v4()).unwrap();
        assert!(observation.authentication_configured());
    }
    #[test]
    fn missing_authentication_is_not_success() {
        let mut observation = observe(Uuid::new_v4()).unwrap();
        observation.auth_status = None;
        assert!(observation.completed());
        assert!(!observation.authentication_configured());
    }
}
