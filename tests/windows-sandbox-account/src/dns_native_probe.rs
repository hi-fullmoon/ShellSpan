//! Owned diagnostic DNS API call; no arbitrary names or remote destinations.
use serde::{Deserialize, Serialize};
use std::cell::UnsafeCell;
use std::net::SocketAddrV4;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Condvar, Mutex,
};
use std::time::Duration;
use uuid::Uuid;
use windows_sys::Win32::Foundation::DNS_REQUEST_PENDING;
use windows_sys::Win32::NetworkManagement::Dns::*;

static LIVE_QUERIES: AtomicUsize = AtomicUsize::new(0);

struct QueryBudget<'a>(&'a AtomicUsize);
impl<'a> QueryBudget<'a> {
    fn acquire(counter: &'a AtomicUsize) -> Result<Self, String> {
        counter
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |count| {
                (count < 4).then_some(count + 1)
            })
            .map_err(|_| "native DNS live query budget exhausted")?;
        Ok(Self(counter))
    }
}
impl Drop for QueryBudget<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DnsApiObservation {
    pub dispatch_status: i32,
    #[serde(deserialize_with = "required_nullable_status")]
    pub completion_status: Option<i32>,
    pub records_returned: bool,
    pub fixed_answer: bool,
    #[serde(deserialize_with = "required_nullable_status")]
    pub cancel_status: Option<i32>,
    pub timed_out: bool,
}
fn required_nullable_status<'de, D>(deserializer: D) -> Result<Option<i32>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Deserialize::deserialize(deserializer)
}
impl DnsApiObservation {
    pub fn verified_resolution(&self, owned_questions: usize) -> bool {
        matches!(self.dispatch_status, 0 | DNS_REQUEST_PENDING)
            && self.completion_status == Some(0)
            && self.records_returned
            && self.fixed_answer
            && !self.timed_out
            && self.cancel_status.is_none()
            && owned_questions == 1
    }
    pub fn verified_denial(&self, receiver_controls_verified: bool, received: usize) -> bool {
        receiver_controls_verified && received == 0 && self.explicit_api_denial()
    }
    pub fn explicit_api_denial(&self) -> bool {
        matches!(self.dispatch_status, 0 | DNS_REQUEST_PENDING | 5 | 10013)
            && matches!(self.completion_status, Some(5 | 10013))
            && (matches!(self.dispatch_status, 0 | DNS_REQUEST_PENDING)
                || self.completion_status == Some(self.dispatch_status))
            && !self.records_returned
            && !self.fixed_answer
            && !self.timed_out
            && self.cancel_status.is_none()
    }
}
#[derive(Clone)]
struct Completion {
    status: i32,
    returned: bool,
    fixed: bool,
}
struct QueryStorage {
    _budget: QueryBudget<'static>,
    name: Vec<u16>,
    server: DNS_ADDR_ARRAY,
    request: UnsafeCell<DNS_QUERY_REQUEST>,
    result: UnsafeCell<DNS_QUERY_RESULT>,
    cancel: UnsafeCell<DNS_QUERY_CANCEL>,
    completion: Mutex<Option<Completion>>,
    ready: Condvar,
}
// Native result is accessed only by DNS and its completion callback. Request,
// name and server are immutable after dispatch. Cancel storage remains owned
// throughout cancellation. Caller and callback hold separate Arc references;
// a late callback therefore never dereferences storage freed by the waiter.
unsafe impl Send for QueryStorage {}
unsafe impl Sync for QueryStorage {}
unsafe extern "system" fn complete(
    context: *const core::ffi::c_void,
    result: *mut DNS_QUERY_RESULT,
) {
    // Exactly one reference was transferred before dispatch. Inline completion
    // invokes this path manually only when DNS promises no callback.
    let storage = unsafe { Arc::from_raw(context.cast::<QueryStorage>()) };
    let completion = if result.is_null() {
        Completion {
            status: 87,
            returned: false,
            fixed: false,
        }
    } else {
        let result = unsafe { &mut *result };
        let returned = !result.pQueryRecords.is_null();
        let fixed = if returned {
            // DnsQueryEx uses Unicode names; the windows-sys neutral result
            // pointer is declared as DNS_RECORDA. Interpret its matching ABI
            // as DNS_RECORDW before inspecting the name.
            let record = unsafe { &*result.pQueryRecords.cast::<DNS_RECORDW>() };
            record.pNext.is_null()
                && record.wType == DNS_TYPE_A
                && record.wDataLength == 4
                && unsafe { native_name_matches(record.pName, &storage.name) }
                && unsafe { record.Data.A.IpAddress }.to_ne_bytes() == [127, 0, 0, 42]
        } else {
            false
        };
        let completion = Completion {
            status: result.QueryStatus,
            returned,
            fixed,
        };
        if returned {
            unsafe { DnsFree(result.pQueryRecords.cast(), DnsFreeRecordList) };
            result.pQueryRecords = std::ptr::null_mut();
        }
        completion
    };
    *storage
        .completion
        .lock()
        .unwrap_or_else(|poison| poison.into_inner()) = Some(completion);
    storage.ready.notify_all();
}

// DNS owns a valid, terminated UTF-16 record name. Stop at the first mismatch
// (including an earlier terminator), never scan or copy an unbounded name.
unsafe fn native_name_matches(actual: *const u16, expected: &[u16]) -> bool {
    if actual.is_null() || expected.last() != Some(&0) || expected.len() < 2 {
        return false;
    }
    for (index, expected_character) in expected.iter().copied().enumerate() {
        let actual_character = unsafe { actual.add(index).read() };
        let fold = |character: u16| {
            if (u16::from(b'A')..=u16::from(b'Z')).contains(&character) {
                character + 32
            } else {
                character
            }
        };
        if fold(actual_character) != fold(expected_character) {
            return false;
        }
    }
    true
}

pub fn query_owned(
    id: Uuid,
    endpoint: SocketAddrV4,
    tcp_only: bool,
) -> Result<DnsApiObservation, String> {
    if id.is_nil() || *endpoint.ip() != std::net::Ipv4Addr::LOCALHOST || endpoint.port() != 53 {
        return Err("native DNS requires owned UUID and fixed IPv4 loopback port 53".into());
    }
    query_fixed(id, endpoint, tcp_only, QueryMode::OwnedWire)
}

/// Fixed numeric-address calibration. DnsQueryEx handles numeric IPv4 locally;
/// no host name, custom resolver or externally supplied options are accepted.
pub fn query_numeric_local() -> Result<DnsApiObservation, String> {
    query_fixed(
        Uuid::nil(),
        "127.0.0.1:53".parse().unwrap(),
        false,
        QueryMode::NumericLocal,
    )
}

pub fn query_cache_only(id: Uuid) -> Result<DnsApiObservation, String> {
    if id.is_nil() {
        return Err("cache calibration requires owned UUID".into());
    }
    query_fixed(
        id,
        "127.0.0.1:53".parse().unwrap(),
        false,
        QueryMode::CacheOnly,
    )
}

/// Synchronous counterpart for the same owned cache-only question. This never
/// uses the configured resolvers or sends a wire query. Run inside the existing
/// bounded diagnostic child, whose Job lifetime bounds native calls.
pub fn query_cache_only_sync(id: Uuid) -> Result<DnsApiObservation, String> {
    if id.is_nil() {
        return Err("synchronous cache calibration requires owned UUID".into());
    }
    let _budget = QueryBudget::acquire(&LIVE_QUERIES)?;
    let name: Vec<u16> = format!("sspa-{}.invalid", id.simple())
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let request = DNS_QUERY_REQUEST {
        Version: DNS_QUERY_REQUEST_VERSION1,
        QueryName: name.as_ptr(),
        QueryType: DNS_TYPE_A,
        QueryOptions: u64::from(
            DNS_QUERY_NO_WIRE_QUERY
                | DNS_QUERY_NO_HOSTS_FILE
                | DNS_QUERY_NO_LOCAL_NAME
                | DNS_QUERY_NO_NETBT
                | DNS_QUERY_NO_MULTICAST
                | DNS_QUERY_TREAT_AS_FQDN,
        ),
        ..Default::default()
    };
    let mut result = DNS_QUERY_RESULT {
        Version: DNS_QUERY_RESULTS_VERSION1,
        ..Default::default()
    };
    let dispatch = unsafe { DnsQueryEx(&request, &mut result, std::ptr::null_mut()) };
    let returned = !result.pQueryRecords.is_null();
    if returned {
        unsafe { DnsFree(result.pQueryRecords.cast(), DnsFreeRecordList) };
    }
    if dispatch == DNS_REQUEST_PENDING {
        return Err("synchronous DNS unexpectedly returned pending".into());
    }
    Ok(DnsApiObservation {
        dispatch_status: dispatch,
        completion_status: Some(inline_completion_status(dispatch, result.QueryStatus)),
        records_returned: returned,
        fixed_answer: false,
        cancel_status: None,
        timed_out: false,
    })
}

/// Legacy API calibration; fixed owned name and cache-only options, no server
/// list, externally supplied names or wire queries.
pub fn query_legacy_cache_only(id: Uuid) -> Result<DnsApiObservation, String> {
    if id.is_nil() {
        return Err("legacy cache calibration requires owned UUID".into());
    }
    let _budget = QueryBudget::acquire(&LIVE_QUERIES)?;
    let name: Vec<u16> = format!("sspa-{}.invalid", id.simple())
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let mut records = std::ptr::null_mut();
    let status = unsafe {
        DnsQuery_W(
            name.as_ptr(),
            DNS_TYPE_A,
            DNS_QUERY_NO_WIRE_QUERY
                | DNS_QUERY_NO_HOSTS_FILE
                | DNS_QUERY_NO_LOCAL_NAME
                | DNS_QUERY_NO_NETBT
                | DNS_QUERY_NO_MULTICAST
                | DNS_QUERY_TREAT_AS_FQDN,
            std::ptr::null_mut(),
            &mut records,
            std::ptr::null_mut(),
        )
    };
    let returned = !records.is_null();
    if returned {
        unsafe { DnsFree(records.cast(), DnsFreeRecordList) };
    }
    let status = i32::try_from(status)
        .map_err(|_| format!("legacy DNS status outside signed observation range: {status}"))?;
    Ok(DnsApiObservation {
        dispatch_status: status,
        completion_status: Some(status),
        records_returned: returned,
        fixed_answer: false,
        cancel_status: None,
        timed_out: false,
    })
}

#[derive(Clone, Copy, PartialEq)]
enum QueryMode {
    OwnedWire,
    NumericLocal,
    CacheOnly,
}

fn query_fixed(
    id: Uuid,
    endpoint: SocketAddrV4,
    tcp_only: bool,
    mode: QueryMode,
) -> Result<DnsApiObservation, String> {
    let budget = QueryBudget::acquire(&LIVE_QUERIES)?;
    let mut server = DNS_ADDR_ARRAY {
        MaxCount: 1,
        AddrCount: 1,
        Family: 2,
        ..Default::default()
    };
    let mut address = [0u8; 32];
    address[..2].copy_from_slice(&2u16.to_ne_bytes());
    // Native DnsQueryEx rejects an explicit sockaddr port (even 53) on this OS.
    // Zero selects its default DNS port; the caller must own loopback port 53.
    address[4..8].copy_from_slice(&endpoint.ip().octets());
    server.AddrArray[0].MaxSa = address.map(|byte| byte as i8);
    server.AddrArray[0].Data = DNS_ADDR_0 {
        DnsAddrUserDword: [16, 0, 0, 0, 0, 0, 0, 0],
    };
    let storage = Arc::new(QueryStorage {
        _budget: budget,
        name: if mode == QueryMode::NumericLocal {
            "127.0.0.42".to_owned()
        } else {
            format!("sspa-{}.invalid", id.simple())
        }
        .encode_utf16()
        .chain(Some(0))
        .collect(),
        server,
        request: UnsafeCell::new(DNS_QUERY_REQUEST::default()),
        result: UnsafeCell::new(DNS_QUERY_RESULT {
            Version: DNS_QUERY_RESULTS_VERSION1,
            ..Default::default()
        }),
        cancel: UnsafeCell::new(DNS_QUERY_CANCEL::default()),
        completion: Mutex::new(None),
        ready: Condvar::new(),
    });
    let context = Arc::into_raw(storage.clone());
    unsafe {
        *storage.request.get() = DNS_QUERY_REQUEST {
            Version: DNS_QUERY_REQUEST_VERSION1,
            QueryName: storage.name.as_ptr(),
            QueryType: DNS_TYPE_A,
            QueryOptions: if mode == QueryMode::NumericLocal {
                0
            } else if mode == QueryMode::CacheOnly {
                u64::from(
                    DNS_QUERY_NO_WIRE_QUERY
                        | DNS_QUERY_NO_HOSTS_FILE
                        | DNS_QUERY_NO_LOCAL_NAME
                        | DNS_QUERY_NO_NETBT
                        | DNS_QUERY_NO_MULTICAST
                        | DNS_QUERY_TREAT_AS_FQDN,
                )
            } else {
                u64::from(
                    DNS_QUERY_BYPASS_CACHE
                        | DNS_QUERY_WIRE_ONLY
                        | DNS_QUERY_NO_HOSTS_FILE
                        | DNS_QUERY_NO_LOCAL_NAME
                        | DNS_QUERY_NO_NETBT
                        | DNS_QUERY_NO_MULTICAST
                        | if tcp_only { DNS_QUERY_USE_TCP_ONLY } else { 0 },
                )
            },
            pDnsServerList: if mode != QueryMode::OwnedWire {
                std::ptr::null_mut()
            } else {
                std::ptr::addr_of!(storage.server).cast_mut()
            },
            pQueryCompletionCallback: Some(complete),
            pQueryContext: context.cast_mut().cast(),
            ..Default::default()
        };
    }
    let dispatch = unsafe {
        DnsQueryEx(
            storage.request.get(),
            storage.result.get(),
            storage.cancel.get(),
        )
    };
    if dispatch != DNS_REQUEST_PENDING {
        // On immediate parameter failure DNS can leave QueryStatus at its
        // initialized zero. Preserve the function's failure rather than
        // reporting that untouched field as successful completion.
        unsafe {
            (*storage.result.get()).QueryStatus =
                inline_completion_status(dispatch, (*storage.result.get()).QueryStatus);
        }
        unsafe { complete(context.cast(), storage.result.get()) };
    }
    let completed = storage
        .completion
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    let (completed, timeout) = storage
        .ready
        .wait_timeout_while(completed, Duration::from_secs(2), |value| value.is_none())
        .unwrap_or_else(|poison| poison.into_inner());
    let timed_out = timeout.timed_out() && completed.is_none();
    drop(completed);
    let cancel_status = timed_out.then(|| unsafe { DnsCancelQuery(storage.cancel.get()) });
    let completed = storage
        .completion
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    let (completed, _) = storage
        .ready
        .wait_timeout_while(completed, Duration::from_secs(1), |value| value.is_none())
        .unwrap_or_else(|poison| poison.into_inner());
    // If no callback arrives, the transferred Arc retains every native buffer.
    // The caller receives a failed/unknown observation, never a denial proof.
    Ok(DnsApiObservation {
        dispatch_status: dispatch,
        completion_status: completed.as_ref().map(|value| value.status),
        records_returned: completed.as_ref().is_some_and(|value| value.returned),
        fixed_answer: completed.as_ref().is_some_and(|value| value.fixed),
        cancel_status,
        timed_out,
    })
}

fn inline_completion_status(dispatch: i32, result: i32) -> i32 {
    if dispatch != 0 {
        dispatch
    } else {
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn all_dns_modes_share_bounded_slots_released_by_ownership() {
        let counter = AtomicUsize::new(0);
        let mut held = Vec::new();
        for _ in 0..4 {
            held.push(QueryBudget::acquire(&counter).unwrap());
        }
        assert!(QueryBudget::acquire(&counter).is_err());
        drop(held.pop());
        let replacement = QueryBudget::acquire(&counter).unwrap();
        assert!(QueryBudget::acquire(&counter).is_err());
        drop(replacement);
        drop(held);
        assert_eq!(counter.load(Ordering::SeqCst), 0);
    }
    #[test]
    fn actual_dedicated_sync_cache_failure_preserves_failed_gate_and_exact_recovery() {
        let read = |suffix: &str| -> serde_json::Value {
            serde_json::from_slice(&std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join(format!("../../docs/design/evidence/windows-stage-a-2026-10-09-dns-sync-cache-system-{suffix}.json"))).unwrap()).unwrap()
        };
        let receipt = read("profile");
        let report = &receipt["controller_admission_report"];
        assert!(!report["error"].is_null());
        assert_eq!(report["execution_topology_verified"], true);
        assert_eq!(report["process_tree_stopped"], true);
        let checks = report["workload_report"]["checks"].as_array().unwrap();
        let contexts: Vec<_> = checks
            .iter()
            .filter(|entry| {
                entry["name"]
                    .as_str()
                    .unwrap()
                    .ends_with("DNS self-context comparison")
            })
            .collect();
        assert_eq!(contexts.len(), 2);
        for entry in contexts {
            let context: crate::rpc_admission_probe::LsaSelfObservation =
                serde_json::from_str(entry["detail"].as_str().unwrap()).unwrap();
            assert!(context.security_context_equal && context.restored && context.error.is_none());
            let observation = context.dns_cache_only_sync.unwrap();
            assert_eq!(observation.completion_status, Some(87));
            assert!(!observation.explicit_api_denial());
        }
        let retired = read("recovered-profile");
        assert_eq!(retired["fixture_id"], receipt["fixture_id"]);
        assert_eq!(retired["account_sid"], receipt["account_sid"]);
        for field in [
            "account_removed",
            "profile_removed",
            "filters_removed",
            "credential_removed",
        ] {
            assert_eq!(retired[field], true, "{field}");
        }
        assert!(retired["cleanup_debt"].as_array().unwrap().is_empty());
        let audit = read("os-audit");
        assert_eq!(audit["fixture_id"], receipt["fixture_id"]);
        for field in [
            "account_absent",
            "profile_absent",
            "hive_absent",
            "services_absent",
        ] {
            assert_eq!(audit[field], true, "{field}");
        }
    }
    #[test]
    fn actual_lpac_sync_and_async_cache_failures_remain_unknown_not_denied() {
        let receipt: serde_json::Value = serde_json::from_slice(include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../docs/design/evidence/windows-stage-a-2026-10-09-dns-sync-cache-shared-lpac.json"
        )))
        .unwrap();
        assert!(!receipt["error"].is_null());
        for field in [
            "process_tree_stopped",
            "profile_removed",
            "fixture_acls_revoked",
        ] {
            assert_eq!(receipt[field], true, "{field}");
        }
        let checks = receipt["probe"]["checks"].as_array().unwrap();
        for name in [
            "DNS self-context comparison",
            "descendant network: DNS self-context comparison",
        ] {
            let matches: Vec<_> = checks
                .iter()
                .filter(|entry| entry["name"] == name)
                .collect();
            assert_eq!(matches.len(), 1, "{name}");
            let context: crate::rpc_admission_probe::LsaSelfObservation =
                serde_json::from_str(matches[0]["detail"].as_str().unwrap()).unwrap();
            assert!(context.security_context_equal && context.restored && context.error.is_none());
            for observation in [
                context.dns_cache_only.unwrap(),
                context.dns_cache_only_sync.unwrap(),
            ] {
                assert_eq!(observation.dispatch_status, 87);
                assert_eq!(observation.completion_status, Some(87));
                assert!(!observation.verified_denial(true, 0));
            }
        }
    }
    #[test]
    fn actual_synchronous_cache_only_owned_question_is_a_cache_miss() {
        assert!(query_cache_only_sync(Uuid::nil()).is_err());
        let observation = query_cache_only_sync(Uuid::new_v4()).unwrap();
        assert_eq!(observation.completion_status, Some(9701), "{observation:?}");
        assert!(!observation.records_returned && !observation.explicit_api_denial());
    }
    #[test]
    fn dns_delivery_requires_explicit_nullable_statuses_and_all_observation_fields() {
        let delivery = serde_json::json!({"dispatch_status":5,"completion_status":5,
            "records_returned":false,"fixed_answer":false,"cancel_status":null,"timed_out":false});
        let accepted: DnsApiObservation = serde_json::from_value(delivery.clone()).unwrap();
        assert!(accepted.verified_denial(true, 0));
        for field in [
            "dispatch_status",
            "completion_status",
            "records_returned",
            "fixed_answer",
            "cancel_status",
            "timed_out",
        ] {
            let mut missing = delivery.clone();
            missing.as_object_mut().unwrap().remove(field);
            assert!(
                serde_json::from_value::<DnsApiObservation>(missing).is_err(),
                "missing {field}"
            );
        }
        let mut pending = delivery.clone();
        pending["completion_status"] = serde_json::Value::Null;
        let pending: DnsApiObservation = serde_json::from_value(pending).unwrap();
        assert!(!pending.verified_denial(true, 0));
        let mut unknown = delivery;
        unknown["unknown"] = serde_json::json!(true);
        assert!(serde_json::from_value::<DnsApiObservation>(unknown).is_err());
    }
    #[test]
    #[ignore = "actual Windows legacy DNS fixed cache-only calibration"]
    fn actual_legacy_cache_only_unknown_owned_name_has_no_records() {
        let observation = query_legacy_cache_only(Uuid::new_v4()).unwrap();
        assert_eq!(observation.completion_status, Some(9701), "{observation:?}");
        assert!(!observation.records_returned && !observation.explicit_api_denial());
        assert!(query_legacy_cache_only(Uuid::nil()).is_err());
    }
    #[test]
    #[ignore = "actual Windows DNS cache-only fixed UUID calibration"]
    fn actual_cache_only_unknown_owned_question_has_no_records() {
        let observation = query_cache_only(Uuid::new_v4()).unwrap();
        assert_eq!(observation.completion_status, Some(9701), "{observation:?}");
        assert!(!observation.records_returned && !observation.timed_out);
        assert!(!observation.explicit_api_denial());
        assert!(query_cache_only(Uuid::nil()).is_err());
    }
    #[test]
    #[ignore = "actual Windows DNS API fixed numeric local calibration"]
    fn actual_numeric_address_is_completed_locally_with_exact_record() {
        let observation = query_numeric_local().unwrap();
        assert_eq!(observation.dispatch_status, 0, "{observation:?}");
        assert_eq!(observation.completion_status, Some(0), "{observation:?}");
        assert!(
            observation.fixed_answer && observation.records_returned,
            "{observation:?}"
        );
        assert!(!observation.timed_out && observation.cancel_status.is_none());
    }
    #[test]
    fn native_record_name_requires_exact_owned_question_with_dns_case_folding() {
        let expected: Vec<u16> = "sspa-owned.invalid".encode_utf16().chain(Some(0)).collect();
        for name in ["sspa-owned.invalid", "SSPA-OWNED.INVALID"] {
            let actual: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
            assert!(unsafe { native_name_matches(actual.as_ptr(), &expected) });
        }
        for name in ["", "sspa", "sspa-other.invalid", "sspa-owned.invalid.extra"] {
            let actual: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
            assert!(!unsafe { native_name_matches(actual.as_ptr(), &expected) });
        }
        assert!(!unsafe { native_name_matches(std::ptr::null(), &expected) });
        assert!(!unsafe { native_name_matches(expected.as_ptr(), &[]) });
    }
    #[test]
    fn immediate_dispatch_failure_cannot_report_untouched_success_status() {
        for failure in [87, 5, 10013, 1702] {
            assert_eq!(inline_completion_status(failure, 0), failure);
            assert_eq!(inline_completion_status(failure, 123), failure);
        }
        assert_eq!(inline_completion_status(0, 0), 0);
        assert_eq!(inline_completion_status(0, 9501), 9501);
    }
    #[test]
    fn dns_denial_requires_explicit_status_and_verified_quiet_receiver() {
        let mut observation = DnsApiObservation {
            dispatch_status: DNS_REQUEST_PENDING,
            completion_status: Some(5),
            records_returned: false,
            fixed_answer: false,
            cancel_status: None,
            timed_out: false,
        };
        assert!(observation.verified_denial(true, 0));
        assert!(!observation.verified_denial(false, 0));
        assert!(!observation.verified_denial(true, 1));
        for status in [None, Some(0), Some(87), Some(1702), Some(1223), Some(10060)] {
            observation.completion_status = status;
            assert!(!observation.verified_denial(true, 0), "{status:?}");
        }
        observation.completion_status = Some(10013);
        assert!(observation.verified_denial(true, 0));
        observation.timed_out = true;
        assert!(!observation.verified_denial(true, 0));
        observation.timed_out = false;
        observation.cancel_status = Some(0);
        assert!(!observation.verified_denial(true, 0));
        observation.cancel_status = None;
        observation.records_returned = true;
        assert!(!observation.verified_denial(true, 0));
    }
    #[test]
    fn immediate_dns_denial_requires_matching_completion_and_no_success_evidence() {
        for dispatch in [5, 10013] {
            let mut observation = DnsApiObservation {
                dispatch_status: dispatch,
                completion_status: Some(dispatch),
                records_returned: false,
                fixed_answer: false,
                cancel_status: None,
                timed_out: false,
            };
            assert!(observation.verified_denial(true, 0));
            observation.completion_status = Some(if dispatch == 5 { 10013 } else { 5 });
            assert!(!observation.verified_denial(true, 0));
            observation.completion_status = Some(dispatch);
            observation.fixed_answer = true;
            assert!(!observation.verified_denial(true, 0));
        }
    }
    #[test]
    #[ignore = "actual Windows DNS API TCP positive control against owned port 53"]
    fn actual_native_tcp_query_requires_received_owned_question_and_fixed_answer() {
        let id = Uuid::new_v4();
        let listener = std::net::TcpListener::bind("127.0.0.1:53").unwrap();
        listener.set_nonblocking(true).unwrap();
        let worker = std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(3);
            let mut stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error)
                        if error.kind() == std::io::ErrorKind::WouldBlock
                            && std::time::Instant::now() < deadline =>
                    {
                        std::thread::sleep(Duration::from_millis(2))
                    }
                    Err(error) => return Err(error.to_string()),
                }
            };
            stream.set_nonblocking(false).map_err(|e| e.to_string())?;
            stream
                .set_read_timeout(Some(Duration::from_secs(1)))
                .map_err(|e| e.to_string())?;
            stream
                .set_write_timeout(Some(Duration::from_secs(1)))
                .map_err(|e| e.to_string())?;
            let packet = crate::dns_probe::read_tcp_packet(&mut stream)?;
            crate::dns_probe::write_tcp_packet(
                &mut stream,
                &crate::dns_probe::fixed_response(id, &packet)?,
            )
        });
        let observation = query_owned(id, "127.0.0.1:53".parse().unwrap(), true).unwrap();
        let receiver = worker.join().unwrap();
        assert!(
            receiver.is_ok(),
            "receiver={receiver:?}; API={observation:?}"
        );
        assert_eq!(observation.completion_status, Some(0), "{observation:?}");
        assert!(
            observation.fixed_answer && observation.records_returned && !observation.timed_out,
            "{observation:?}"
        );
    }
    #[test]
    #[ignore = "actual Windows DNS cancellation against owned nonresponding UDP port 53"]
    fn actual_native_timeout_cancel_waits_for_completion_and_releases_storage() {
        let socket = std::net::UdpSocket::bind("127.0.0.1:53").unwrap();
        let observation =
            query_owned(Uuid::new_v4(), "127.0.0.1:53".parse().unwrap(), false).unwrap();
        assert_eq!(
            observation.dispatch_status, DNS_REQUEST_PENDING,
            "{observation:?}"
        );
        assert!(observation.timed_out, "{observation:?}");
        assert_eq!(observation.cancel_status, Some(0), "{observation:?}");
        assert!(
            observation
                .completion_status
                .is_some_and(|status| status != 0),
            "{observation:?}"
        );
        assert!(
            !observation.records_returned && !observation.fixed_answer,
            "{observation:?}"
        );
        let deadline = std::time::Instant::now() + Duration::from_secs(1);
        while LIVE_QUERIES.load(Ordering::SeqCst) != 0 && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(2));
        }
        assert_eq!(
            LIVE_QUERIES.load(Ordering::SeqCst),
            0,
            "callback ownership remains live: {observation:?}"
        );
        drop(socket);
    }
    #[test]
    fn native_query_rejects_unowned_names_and_remote_or_unassigned_endpoints() {
        assert!(query_owned(Uuid::nil(), "127.0.0.1:1".parse().unwrap(), false).is_err());
        for endpoint in [
            "127.0.0.1:0",
            "127.0.0.1:5300",
            "192.168.2.1:53",
            "127.0.0.2:53",
        ] {
            assert!(query_owned(Uuid::new_v4(), endpoint.parse().unwrap(), false).is_err());
        }
    }
    #[test]
    #[ignore = "actual Windows DNS API positive control against owned UDP receiver"]
    fn actual_native_udp_query_requires_received_owned_question_and_fixed_answer() {
        let id = Uuid::new_v4();
        let socket = std::net::UdpSocket::bind("127.0.0.1:53").unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let std::net::SocketAddr::V4(endpoint) = socket.local_addr().unwrap() else {
            panic!("IPv4 receiver required")
        };
        let worker = std::thread::spawn(move || {
            let mut packet = [0u8; 513];
            let (length, peer) = socket.recv_from(&mut packet).map_err(|e| e.to_string())?;
            let response =
                crate::dns_probe::fixed_response(id, &packet[..length]).map_err(|reason| {
                    format!(
                        "{reason}; length={length}; header={:?}",
                        &packet[..length.min(12)]
                    )
                })?;
            socket.send_to(&response, peer).map_err(|e| e.to_string())?;
            Ok::<_, String>(())
        });
        let observation = query_owned(id, endpoint, false).unwrap();
        let receiver = worker.join().unwrap();
        assert!(
            receiver.is_ok(),
            "receiver={receiver:?}; API={observation:?}"
        );
        assert_eq!(observation.completion_status, Some(0), "{observation:?}");
        assert!(
            observation.fixed_answer && observation.records_returned && !observation.timed_out,
            "{observation:?}"
        );
    }
}
