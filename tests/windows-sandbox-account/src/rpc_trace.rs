//! Diagnostic-only, memory-only RPC client trace. No arbitrary provider or payload export.
use serde::Serialize;
use std::ptr::null;
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use uuid::Uuid;
use windows_sys::core::GUID;
use windows_sys::Win32::System::Diagnostics::Etw::*;

const PROVIDER: GUID = GUID::from_u128(0x6ad52b32_d609_4be9_ae07_ce8dae937e39);
const EVENT_BUDGET: usize = 64;
#[derive(Debug, Clone, serde::Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Registration {
    pub provider: Uuid,
    pub register_code: u32,
    pub handle_nonzero: bool,
    pub unregister_code: Option<u32>,
}
impl Registration {
    pub fn consistent(&self) -> bool {
        self.provider == guid_uuid(PROVIDER)
            && if self.register_code == 0 {
                self.handle_nonzero && self.unregister_code == Some(0)
            } else {
                !self.handle_nonzero && self.unregister_code.is_none()
            }
    }
}
/// Fixed provider registration only; emits no event and changes no provider ACL.
pub fn observe_registration() -> Registration {
    let mut handle: REGHANDLE = 0;
    let code = unsafe { EventRegister(&PROVIDER, None, std::ptr::null(), &mut handle) };
    let unregister_code = if code == 0 && handle != 0 {
        Some(unsafe { EventUnregister(handle) })
    } else {
        None
    };
    Registration {
        provider: guid_uuid(PROVIDER),
        register_code: code,
        handle_nonzero: handle != 0,
        unregister_code,
    }
}
fn guid_uuid(value: GUID) -> Uuid {
    Uuid::from_fields(value.data1, value.data2, value.data3, &value.data4)
}

#[derive(Debug, Clone, Serialize)]
pub struct ClientEvent {
    pub process_id: u32,
    pub thread_id: u32,
    pub event_id: u16,
    pub activity_id: String,
    pub interface_id: Option<String>,
    pub operation: Option<u32>,
    pub protocol: Option<u32>,
    pub status: Option<u32>,
}

fn decode(
    pid: u32,
    tid: u32,
    id: u16,
    version: u8,
    activity: GUID,
    data: &[u8],
) -> Result<ClientEvent, String> {
    if pid == 0 || version != 1 || !matches!(id, 5 | 7) {
        return Err("unexpected RPC client event schema".into());
    }
    let mut event = ClientEvent {
        process_id: pid,
        thread_id: tid,
        event_id: id,
        activity_id: guid_uuid(activity).to_string(),
        interface_id: None,
        operation: None,
        protocol: None,
        status: None,
    };
    if id == 5 {
        if data.len() < 24 {
            return Err("truncated RPC client start".into());
        }
        // Manifest v1 starts with GUID + two UInt32 fields. Native GUID bytes are little-endian.
        let bytes: [u8; 16] = data[..16].try_into().map_err(|_| "RPC GUID unavailable")?;
        event.interface_id = Some(Uuid::from_bytes_le(bytes).to_string());
        event.operation = Some(u32::from_le_bytes(data[16..20].try_into().unwrap()));
        event.protocol = Some(u32::from_le_bytes(data[20..24].try_into().unwrap()));
        // Deliberately do not copy endpoint/address/options or any remaining payload.
    } else {
        if data.len() != 4 {
            return Err("unexpected RPC client stop payload".into());
        }
        event.status = Some(u32::from_le_bytes(data.try_into().unwrap()));
    }
    Ok(event)
}

struct State {
    pid: u32,
    events: Vec<ClientEvent>,
    error: Option<String>,
}
struct Context {
    state: Arc<Mutex<State>>,
}
unsafe extern "system" fn receive(record: *mut EVENT_RECORD) {
    if record.is_null() {
        return;
    }
    let record = unsafe { &*record };
    if record.UserContext.is_null() {
        return;
    }
    let context = unsafe { &*record.UserContext.cast::<Context>() };
    let Ok(mut state) = context.state.lock() else {
        return;
    };
    if state.error.is_some() {
        return;
    }
    // ETW housekeeping events are not RPC evidence.
    if guid_uuid(record.EventHeader.ProviderId) != guid_uuid(PROVIDER) {
        return;
    }
    if record.EventHeader.ProcessId != state.pid {
        state.error = Some("RPC PID filter delivered an unrelated process".into());
        return;
    }
    if state.events.len() == EVENT_BUDGET {
        state.error = Some("RPC client event budget exceeded".into());
        return;
    }
    if record.UserData.is_null() || record.UserDataLength > 8192 {
        state.error = Some("RPC client payload unavailable or exceeds bound".into());
        return;
    }
    let data = unsafe {
        std::slice::from_raw_parts(record.UserData.cast::<u8>(), record.UserDataLength as usize)
    };
    match decode(
        record.EventHeader.ProcessId,
        record.EventHeader.ThreadId,
        record.EventHeader.EventDescriptor.Id,
        record.EventHeader.EventDescriptor.Version,
        record.EventHeader.ActivityId,
        data,
    ) {
        Ok(event) => state.events.push(event),
        Err(error) => state.error = Some(error),
    }
}

#[repr(C)]
struct Properties {
    properties: EVENT_TRACE_PROPERTIES,
    name: [u16; 96],
}
#[repr(C)]
struct EventIds {
    include: bool,
    reserved: u8,
    count: u16,
    ids: [u16; 2],
}

fn query_properties(fixture: Uuid) -> Result<Box<Properties>, String> {
    if fixture.is_nil() {
        return Err("RPC trace fixture is nil".into());
    }
    let name = format!("ShellSpan-RpcClient-{}", fixture.simple());
    let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
    let mut properties = Box::new(Properties {
        properties: EVENT_TRACE_PROPERTIES::default(),
        name: [0; 96],
    });
    properties.name[..wide.len()].copy_from_slice(&wide);
    properties.properties.Wnode.BufferSize = std::mem::size_of::<Properties>() as u32;
    properties.properties.Wnode.Flags = WNODE_FLAG_TRACED_GUID;
    properties.properties.Wnode.Guid = GUID::from_u128(fixture.as_u128());
    properties.properties.LoggerNameOffset = std::mem::offset_of!(Properties, name) as u32;
    Ok(properties)
}

fn verify_session(properties: &EVENT_TRACE_PROPERTIES, fixture: Uuid) -> Result<(), String> {
    if guid_uuid(properties.Wnode.Guid) != fixture
        || properties.LogFileMode & !EVENT_TRACE_STOP_ON_HYBRID_SHUTDOWN
            != (EVENT_TRACE_REAL_TIME_MODE | EVENT_TRACE_NO_PER_PROCESSOR_BUFFERING)
        || properties.LogFileNameOffset != 0
        || properties.BufferSize != 16
        || !(2..=4).contains(&properties.MinimumBuffers)
        || !(2..=4).contains(&properties.MaximumBuffers)
        || !(2..=4).contains(&properties.NumberOfBuffers)
    {
        return Err(format!("RPC session identity or memory-only mode changed: guid_match={}, mode={}, file_offset={}, buffer_kib={}", guid_uuid(properties.Wnode.Guid)==fixture, properties.LogFileMode, properties.LogFileNameOffset, properties.BufferSize));
    }
    Ok(())
}

/// Exact name query; only ERROR_WMI_INSTANCE_NOT_FOUND proves absence.
pub fn session_absent(fixture: Uuid) -> Result<bool, String> {
    let mut properties = query_properties(fixture)?;
    let code = unsafe {
        ControlTraceW(
            CONTROLTRACE_HANDLE::default(),
            properties.name.as_ptr(),
            &mut properties.properties,
            EVENT_TRACE_CONTROL_QUERY,
        )
    };
    match code {
        windows_sys::Win32::Foundation::ERROR_WMI_INSTANCE_NOT_FOUND => Ok(true),
        0 => {
            verify_session(&properties.properties, fixture)?;
            Ok(false)
        }
        _ => Err(format!("query exact RPC session: Win32 {code}")),
    }
}

/// # Safety
/// Intent must come from a verified protected ownership receipt. Caller must establish
/// the complete owned execution tree is stopped and retain offline identity protection.
pub unsafe fn retire_after_crash(
    intent: &crate::rpc_trace_intent::RpcTraceIntent,
) -> Result<bool, String> {
    intent.recovery_processes(intent.fixture_id)?;
    let mut properties = query_properties(intent.fixture_id)?;
    let code = unsafe {
        ControlTraceW(
            CONTROLTRACE_HANDLE::default(),
            properties.name.as_ptr(),
            &mut properties.properties,
            EVENT_TRACE_CONTROL_QUERY,
        )
    };
    if code == windows_sys::Win32::Foundation::ERROR_WMI_INSTANCE_NOT_FOUND {
        return Ok(false);
    }
    if code != 0 {
        return Err(format!("query crashed RPC session: Win32 {code}"));
    }
    verify_session(&properties.properties, intent.fixture_id)?;
    let handle = unsafe { properties.properties.Wnode.Anonymous1.HistoricalContext };
    if handle == 0 {
        return Err("queried RPC session handle unavailable; retain debt".into());
    }
    let code = unsafe {
        ControlTraceW(
            CONTROLTRACE_HANDLE { Value: handle },
            null(),
            &mut properties.properties,
            EVENT_TRACE_CONTROL_STOP,
        )
    };
    if code != 0 {
        return Err(format!("stop verified crashed RPC session: Win32 {code}"));
    }
    if !session_absent(intent.fixture_id)? {
        return Err("crashed RPC session remains present after stop".into());
    }
    Ok(true)
}

#[derive(Serialize)]
pub struct Observation {
    pub session_name: String,
    pub process_id: u32,
    pub session_stopped: bool,
    pub consumer_closed: bool,
    pub session_absent: bool,
    pub events_lost: u32,
    pub realtime_buffers_lost: u32,
    pub number_of_buffers: u32,
    pub maximum_buffers: u32,
    pub events: Vec<ClientEvent>,
}

pub struct RpcTrace {
    properties: Box<Properties>,
    session: CONTROLTRACE_HANDLE,
    consumer: PROCESSTRACE_HANDLE,
    done: Option<mpsc::Receiver<u32>>,
    state: Arc<Mutex<State>>,
    name: String,
    stopped: bool,
    fixture: Uuid,
}
impl RpcTrace {
    /// Rebind held target and current controller before trace creation.
    /// Durable admission also requires publishing this intent in a protected receipt.
    /// # Safety
    /// Target handle must remain held until the trace has finished.
    pub unsafe fn start_bound(
        intent: &crate::rpc_trace_intent::RpcTraceIntent,
        target: windows_sys::Win32::Foundation::HANDLE,
    ) -> Result<Self, String> {
        unsafe { intent.validate_start(intent.fixture_id, target) }?;
        Self::start(intent.fixture_id, intent.target.process_id)
    }
    /// Caller must bind PID to a held verified process, and keep it held through finish.
    /// This diagnostic is not a durable admission/recovery mechanism.
    pub(crate) fn start(fixture: Uuid, pid: u32) -> Result<Self, String> {
        if fixture.is_nil() || pid == 0 {
            return Err("RPC trace requires exact fixture/PID".into());
        }
        let name = format!("ShellSpan-RpcClient-{}", fixture.simple());
        let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
        let mut properties = Box::new(Properties {
            properties: EVENT_TRACE_PROPERTIES::default(),
            name: [0; 96],
        });
        properties.name[..wide.len()].copy_from_slice(&wide);
        properties.properties.Wnode.BufferSize = std::mem::size_of::<Properties>() as u32;
        properties.properties.Wnode.Flags = WNODE_FLAG_TRACED_GUID;
        properties.properties.Wnode.Guid = GUID::from_u128(fixture.as_u128());
        properties.properties.Wnode.ClientContext = 1;
        properties.properties.BufferSize = 16;
        properties.properties.MinimumBuffers = 2;
        properties.properties.MaximumBuffers = 4;
        properties.properties.FlushTimer = 1;
        properties.properties.LogFileMode = EVENT_TRACE_REAL_TIME_MODE
            | EVENT_TRACE_NO_PER_PROCESSOR_BUFFERING
            | EVENT_TRACE_STOP_ON_HYBRID_SHUTDOWN;
        properties.properties.LoggerNameOffset = std::mem::offset_of!(Properties, name) as u32;
        let mut session = CONTROLTRACE_HANDLE::default();
        let code = unsafe {
            StartTraceW(
                &mut session,
                properties.name.as_ptr(),
                &mut properties.properties,
            )
        };
        if code != 0 {
            return Err(format!("start owned RPC trace: Win32 {code}"));
        }
        let state = Arc::new(Mutex::new(State {
            pid,
            events: Vec::new(),
            error: None,
        }));
        let mut trace = Self {
            properties,
            session,
            consumer: PROCESSTRACE_HANDLE { Value: u64::MAX },
            done: None,
            state,
            name,
            stopped: false,
            fixture,
        };
        let context = Box::new(Context {
            state: trace.state.clone(),
        });
        let mut logfile = EVENT_TRACE_LOGFILEW {
            LoggerName: trace.properties.name.as_mut_ptr(),
            ..Default::default()
        };
        logfile.Anonymous1.ProcessTraceMode =
            PROCESS_TRACE_MODE_REAL_TIME | PROCESS_TRACE_MODE_EVENT_RECORD;
        logfile.Anonymous2.EventRecordCallback = Some(receive);
        logfile.Context = (&*context as *const Context).cast_mut().cast();
        trace.consumer = unsafe { OpenTraceW(&mut logfile) };
        if trace.consumer.Value == u64::MAX {
            return Err(format!("open owned RPC consumer: Win32 {}", unsafe {
                windows_sys::Win32::Foundation::GetLastError()
            }));
        }
        let (send, done) = mpsc::channel();
        trace.done = Some(done);
        let raw = trace.consumer.Value;
        std::thread::spawn(move || {
            let _held_context = context;
            let handle = PROCESSTRACE_HANDLE { Value: raw };
            let code = unsafe { ProcessTrace(&handle, 1, null(), null()) };
            let _ = send.send(code);
        });
        let mut pid_filter = pid;
        let mut ids = EventIds {
            include: true,
            reserved: 0,
            count: 2,
            ids: [5, 7],
        };
        let mut filters = [
            EVENT_FILTER_DESCRIPTOR {
                Ptr: (&mut pid_filter as *mut u32) as u64,
                Size: 4,
                Type: EVENT_FILTER_TYPE_PID,
            },
            EVENT_FILTER_DESCRIPTOR {
                Ptr: (&mut ids as *mut EventIds) as u64,
                Size: std::mem::size_of::<EventIds>() as u32,
                Type: EVENT_FILTER_TYPE_EVENT_ID,
            },
        ];
        let parameters = ENABLE_TRACE_PARAMETERS {
            Version: ENABLE_TRACE_PARAMETERS_VERSION_2,
            EnableFilterDesc: filters.as_mut_ptr(),
            FilterDescCount: 2,
            ..Default::default()
        };
        let code = unsafe {
            EnableTraceEx2(
                trace.session,
                &PROVIDER,
                EVENT_CONTROL_CODE_ENABLE_PROVIDER,
                4,
                0x4000000000000000,
                0,
                1000,
                &parameters,
            )
        };
        if code != 0 {
            return Err(format!("enable fixed RPC PID/event filters: Win32 {code}"));
        }
        if session_absent(fixture)? {
            return Err("RPC trace absent immediately after creation".into());
        }
        Ok(trace)
    }

    pub fn finish(mut self) -> Result<Observation, String> {
        let code = unsafe {
            ControlTraceW(
                self.session,
                null(),
                &mut self.properties.properties,
                EVENT_TRACE_CONTROL_STOP,
            )
        };
        if code != 0 {
            return Err(format!("stop owned RPC trace: Win32 {code}"));
        }
        self.stopped = true;
        verify_session(&self.properties.properties, self.fixture)?;
        // Stop drains the realtime session. Wait before CloseTrace so buffered calls are retained.
        let code = self
            .done
            .as_ref()
            .ok_or("RPC consumer not started")?
            .recv_timeout(Duration::from_secs(3))
            .map_err(|_| "RPC consumer termination unconfirmed")?;
        if code != 0 {
            return Err(format!("RPC consumer failed: Win32 {code}"));
        }
        let code = unsafe { CloseTrace(self.consumer) };
        if code != 0 {
            return Err(format!("close RPC consumer: Win32 {code}"));
        }
        self.consumer.Value = u64::MAX;
        if !session_absent(self.fixture)? {
            return Err("RPC session still present after stop".into());
        }
        let state = self.state.lock().map_err(|_| "RPC observation poisoned")?;
        if let Some(error) = &state.error {
            return Err(error.clone());
        }
        if self.properties.properties.EventsLost != 0
            || self.properties.properties.RealTimeBuffersLost != 0
        {
            return Err("RPC trace lost events or realtime buffers".into());
        }
        Ok(Observation {
            session_name: self.name.clone(),
            process_id: state.pid,
            session_stopped: true,
            consumer_closed: true,
            session_absent: true,
            events_lost: 0,
            realtime_buffers_lost: 0,
            number_of_buffers: self.properties.properties.NumberOfBuffers,
            maximum_buffers: self.properties.properties.MaximumBuffers,
            events: state.events.clone(),
        })
    }
}
impl Drop for RpcTrace {
    fn drop(&mut self) {
        if !self.stopped {
            unsafe {
                ControlTraceW(
                    self.session,
                    null(),
                    &mut self.properties.properties,
                    EVENT_TRACE_CONTROL_STOP,
                );
            }
        }
        if self.consumer.Value != u64::MAX {
            unsafe {
                CloseTrace(self.consumer);
            }
        }
        // Context remains owned by the consumer thread until ProcessTrace returns.
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recovery_rejects_live_original_controller_before_query_or_stop() {
        let target = unsafe {
            crate::rpc_trace_intent::ProcessIdentity::from_handle(
                windows_sys::Win32::System::Threading::GetCurrentProcess(),
            )
        }
        .unwrap();
        let intent = crate::rpc_trace_intent::RpcTraceIntent::new(Uuid::new_v4(), target).unwrap();
        // The guard rejects this unstarted intent before any trace mutation.
        let error = unsafe { retire_after_crash(&intent) }.unwrap_err();
        assert!(error.contains("controller still alive"));
    }
    #[test]
    fn actual_native_buffer_budget_is_observed_after_stop() {
        let report: serde_json::Value=serde_json::from_str(include_str!(
            "../../../docs/design/evidence/windows-stage-a-2026-10-09-rpc-trace-bounded-buffers-control.json"
        )).unwrap();
        let trace = &report["rpc_trace"];
        assert_eq!(trace["number_of_buffers"], 2);
        assert_eq!(trace["maximum_buffers"], 4);
        assert_eq!(trace["session_absent"], true);
        assert_eq!(trace["events_lost"], 0);
        assert_eq!(trace["events"].as_array().unwrap().len(), 2);
    }
    #[test]
    fn native_rpc_registration_control_is_retired_and_schema_rejects_fake_success() {
        let registration = observe_registration();
        assert!(registration.consistent());
        assert_eq!(registration.register_code, 0);
        assert_eq!(registration.unregister_code, Some(0));
        let mut denied = registration.clone();
        denied.register_code = 5;
        denied.handle_nonzero = false;
        denied.unregister_code = None;
        assert!(denied.consistent());
        denied.handle_nonzero = true;
        assert!(!denied.consistent());
        let mut changed = registration.clone();
        changed.unregister_code = Some(5);
        assert!(!changed.consistent());
        let mut changed = registration;
        changed.provider = Uuid::new_v4();
        assert!(!changed.consistent());
    }
    #[test]
    fn actual_lpac_rpc_provider_registration_failure_does_not_prove_dns_denial() {
        let report: serde_json::Value=serde_json::from_str(include_str!(
            "../../../docs/design/evidence/windows-stage-a-2026-10-09-dns-rpc-provider-registration-system-profile.json"
        ).trim_start_matches('\u{feff}')).unwrap();
        let checks = report["controller_admission_report"]["workload_report"]["checks"]
            .as_array()
            .unwrap();
        let check = checks
            .iter()
            .find(|check| check["name"] == "fixed local RPC client binding created and released")
            .unwrap();
        let detail: serde_json::Value =
            serde_json::from_str(check["detail"].as_str().unwrap()).unwrap();
        let registration: Registration =
            serde_json::from_value(detail["rpc_provider_registration"].clone()).unwrap();
        assert!(registration.consistent());
        assert_eq!(registration.register_code, 5);
        assert!(!registration.handle_nonzero);
        assert_eq!(registration.unregister_code, None);
        let trace = &report["controller_admission_report"]["rpc_client_trace"]["Ok"];
        assert!(trace["events"].as_array().unwrap().is_empty());
        assert_eq!(trace["session_absent"], true);
        for name in [
            "DNS UDP API denied",
            "DNS TCP API denied",
            "DNS UDP receiver no traffic",
            "DNS TCP receiver no traffic",
        ] {
            assert_eq!(
                checks.iter().find(|check| check["name"] == name).unwrap()["passed"],
                false,
                "{name}"
            );
        }
    }
    #[test]
    fn client_schema_is_fixed_and_does_not_export_address_or_options() {
        let interface = Uuid::new_v4();
        let mut data = interface.to_bytes_le().to_vec();
        data.extend(19u32.to_le_bytes());
        data.extend(3u32.to_le_bytes());
        data.extend(b"private-host-and-options");
        let event = decode(42, 7, 5, 1, GUID::from_u128(0), &data).unwrap();
        assert_eq!(
            event.interface_id.as_deref(),
            Some(interface.to_string().as_str())
        );
        assert_eq!(event.operation, Some(19));
        assert_eq!(event.protocol, Some(3));
        assert!(!serde_json::to_string(&event)
            .unwrap()
            .contains("private-host"));
        assert!(decode(42, 7, 5, 1, GUID::from_u128(0), &data[..23]).is_err());
        assert!(decode(42, 7, 6, 1, GUID::from_u128(0), &data).is_err());
        assert!(decode(42, 7, 5, 2, GUID::from_u128(0), &data).is_err());
        assert!(decode(0, 7, 5, 1, GUID::from_u128(0), &data).is_err());
        assert!(decode(42, 7, 7, 1, GUID::from_u128(0), &[0; 5]).is_err());
        assert_eq!(
            decode(42, 7, 7, 1, GUID::from_u128(0), &5u32.to_le_bytes())
                .unwrap()
                .status,
            Some(5)
        );
    }
    #[test]
    fn unbound_trace_identity_is_rejected_before_start() {
        assert!(RpcTrace::start(Uuid::nil(), 42).is_err());
        assert!(RpcTrace::start(Uuid::new_v4(), 0).is_err());
    }
    #[test]
    fn exact_session_identity_accepts_only_known_os_added_mode() {
        let fixture = Uuid::new_v4();
        let mut properties = query_properties(fixture).unwrap();
        properties.properties.BufferSize = 16;
        properties.properties.MinimumBuffers = 2;
        properties.properties.MaximumBuffers = 4;
        properties.properties.NumberOfBuffers = 2;
        properties.properties.LogFileMode =
            EVENT_TRACE_REAL_TIME_MODE | EVENT_TRACE_NO_PER_PROCESSOR_BUFFERING;
        assert!(verify_session(&properties.properties, fixture).is_ok());
        properties.properties.LogFileMode |= EVENT_TRACE_STOP_ON_HYBRID_SHUTDOWN;
        assert!(verify_session(&properties.properties, fixture).is_ok());
        properties.properties.LogFileMode |= EVENT_TRACE_FILE_MODE_SEQUENTIAL;
        assert!(verify_session(&properties.properties, fixture).is_err());
        properties.properties.LogFileMode =
            EVENT_TRACE_REAL_TIME_MODE | EVENT_TRACE_NO_PER_PROCESSOR_BUFFERING;
        properties.properties.LogFileNameOffset = 1;
        assert!(verify_session(&properties.properties, fixture).is_err());
        properties.properties.LogFileNameOffset = 0;
        assert!(verify_session(&properties.properties, Uuid::new_v4()).is_err());
        assert!(query_properties(Uuid::nil()).is_err());
        properties.properties.MaximumBuffers = 5;
        assert!(verify_session(&properties.properties, fixture).is_err());
    }
    #[test]
    fn actual_native_query_control_confirms_session_absence_after_stop() {
        let report: serde_json::Value = serde_json::from_str(include_str!(
            "../../../docs/design/evidence/windows-stage-a-2026-10-09-rpc-trace-native-query-verified-control.json"
        )).unwrap();
        let fixture = Uuid::parse_str(report["fixture_id"].as_str().unwrap()).unwrap();
        let trace = &report["rpc_trace"];
        assert_eq!(
            trace["session_name"],
            format!("ShellSpan-RpcClient-{}", fixture.simple())
        );
        assert_eq!(trace["session_absent"], true);
        assert_eq!(trace["session_stopped"], true);
        assert_eq!(trace["consumer_closed"], true);
        assert_eq!(trace["events_lost"], 0);
        assert_eq!(trace["events"].as_array().unwrap().len(), 2);
    }
    #[test]
    fn actual_fixed_dns_control_delivers_correlated_lrpc_events() {
        let report: serde_json::Value = serde_json::from_str(include_str!(
            "../../../docs/design/evidence/windows-stage-a-2026-10-09-rpc-trace-self-control.json"
        ))
        .unwrap();
        let observation = &report["rpc_trace"];
        assert_eq!(observation["session_stopped"], true);
        assert_eq!(observation["consumer_closed"], true);
        assert_eq!(observation["events_lost"], 0);
        assert_eq!(observation["realtime_buffers_lost"], 0);
        assert_eq!(report["dns_query"]["Ok"]["completion_status"], 9701);
        let events = observation["events"].as_array().unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["event_id"], 5);
        assert_eq!(events[1]["event_id"], 7);
        for event in events {
            assert_eq!(event["process_id"], observation["process_id"]);
        }
        assert_eq!(events[0]["activity_id"], events[1]["activity_id"]);
        assert_eq!(events[0]["thread_id"], events[1]["thread_id"]);
        assert_eq!(
            events[0]["interface_id"],
            "45776b01-5956-4485-9f80-f428f7d60129"
        );
        assert_eq!(events[0]["operation"], 4);
        assert_eq!(
            events[0]["protocol"],
            windows_sys::Win32::System::Rpc::RPC_PROTSEQ_LRPC
        );
        assert_eq!(events[1]["status"], 0);
    }
    #[test]
    fn callback_rejects_unrelated_pid_and_budget_overflow_without_export() {
        let state = Arc::new(Mutex::new(State {
            pid: 42,
            events: Vec::new(),
            error: None,
        }));
        let context = Context {
            state: state.clone(),
        };
        let mut data = [0u8; 24];
        let mut record = EVENT_RECORD {
            UserContext: (&context as *const Context).cast_mut().cast(),
            UserData: data.as_mut_ptr().cast(),
            UserDataLength: 24,
            ..Default::default()
        };
        record.EventHeader.ProviderId = PROVIDER;
        record.EventHeader.ProcessId = 43;
        record.EventHeader.EventDescriptor.Id = 5;
        record.EventHeader.EventDescriptor.Version = 1;
        unsafe {
            receive(&mut record);
        }
        {
            let state = state.lock().unwrap();
            assert!(state.events.is_empty());
            assert!(state.error.is_some());
        }
        state.lock().unwrap().error = None;
        record.EventHeader.ProcessId = 42;
        for _ in 0..EVENT_BUDGET {
            unsafe {
                receive(&mut record);
            }
        }
        assert_eq!(state.lock().unwrap().events.len(), EVENT_BUDGET);
        unsafe {
            receive(&mut record);
        }
        let state = state.lock().unwrap();
        assert_eq!(state.events.len(), EVENT_BUDGET);
        assert!(state.error.as_deref().unwrap().contains("budget"));
    }
    #[test]
    #[ignore = "requires elevated fixed self-PID realtime RPC session; no admission or global tracing"]
    fn actual_self_pid_dns_trace_stops_without_loss() {
        let id = Uuid::new_v4();
        let trace = RpcTrace::start(id, std::process::id()).unwrap();
        let _result = crate::dns_native_probe::query_cache_only_sync(id).unwrap();
        let observation = trace.finish().unwrap();
        assert!(observation.session_stopped && observation.consumer_closed);
        assert_eq!(observation.events_lost, 0);
        assert!(observation
            .events
            .iter()
            .all(|event| event.process_id == std::process::id()));
        // Empty trace is only a lifecycle result, never proof of no RPC path.
    }
}
