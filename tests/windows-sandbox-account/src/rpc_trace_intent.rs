//! Fixed trace ownership schema. Publishing under a trusted receipt is a separate gate.
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use windows_sys::Win32::Foundation::{GetLastError, FILETIME, HANDLE};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetProcessId, GetProcessTimes};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProcessIdentity {
    pub process_id: u32,
    pub creation_time: u64,
}
impl ProcessIdentity {
    /// Query a process handle held by the caller. PID alone is never sufficient.
    /// # Safety
    /// A non-null handle must remain held through the query. Null is rejected by Windows.
    pub unsafe fn from_handle(process: HANDLE) -> Result<Self, String> {
        let pid = unsafe { GetProcessId(process) };
        if pid == 0 {
            return Err(format!(
                "query RPC trace process identity: Win32 {}",
                unsafe { GetLastError() }
            ));
        }
        let mut creation = FILETIME::default();
        let mut exit = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        if unsafe { GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user) }
            == 0
        {
            return Err(format!(
                "query RPC trace process creation time: Win32 {}",
                unsafe { GetLastError() }
            ));
        }
        let identity = Self {
            process_id: pid,
            creation_time: (u64::from(creation.dwHighDateTime) << 32)
                | u64::from(creation.dwLowDateTime),
        };
        identity.validate()?;
        Ok(identity)
    }
    fn validate(&self) -> Result<(), String> {
        if self.process_id == 0 || self.creation_time == 0 {
            return Err("RPC trace process identity is incomplete".into());
        }
        Ok(())
    }
    /// Read-only witness for the original process identity. Never terminates a process.
    pub fn observe_lifetime(&self) -> Result<ProcessLifetime, String> {
        self.validate()?;
        use windows_sys::Win32::Foundation::{
            ERROR_INVALID_PARAMETER, WAIT_OBJECT_0, WAIT_TIMEOUT,
        };
        use windows_sys::Win32::Storage::FileSystem::SYNCHRONIZE;
        use windows_sys::Win32::System::Threading::{
            OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        let raw = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
                0,
                self.process_id,
            )
        };
        if raw.is_null() {
            let code = unsafe { GetLastError() };
            if code == ERROR_INVALID_PARAMETER {
                return Ok(ProcessLifetime::Absent);
            }
            return Err(format!(
                "query original RPC trace process lifetime: Win32 {code}"
            ));
        }
        let process = crate::appcontainer_probe::Handle(raw);
        let actual = unsafe { Self::from_handle(process.0) }?;
        if &actual != self {
            return Ok(ProcessLifetime::PidReused);
        }
        match unsafe { WaitForSingleObject(process.0, 0) } {
            WAIT_OBJECT_0 => Ok(ProcessLifetime::Terminated),
            WAIT_TIMEOUT => Ok(ProcessLifetime::Alive),
            _ => Err(format!(
                "wait original RPC trace process: Win32 {}",
                unsafe { GetLastError() }
            )),
        }
    }
}

#[derive(Debug, PartialEq, Eq, Serialize)]
pub enum ProcessLifetime {
    Absent,
    PidReused,
    Terminated,
    Alive,
}
impl ProcessLifetime {
    pub fn original_stopped(&self) -> bool {
        !matches!(self, Self::Alive)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RpcTraceIntent {
    pub version: u32,
    pub fixture_id: Uuid,
    pub session_guid: Uuid,
    pub session_name: String,
    pub owner: ProcessIdentity,
    pub target: ProcessIdentity,
}
impl RpcTraceIntent {
    /// Caller must verify target Token/Job and publish this in a protected journal before StartTrace.
    pub fn new(fixture: Uuid, target: ProcessIdentity) -> Result<Self, String> {
        let intent = Self {
            version: 1,
            fixture_id: fixture,
            session_guid: fixture,
            session_name: format!("ShellSpan-RpcClient-{}", fixture.simple()),
            owner: unsafe { ProcessIdentity::from_handle(GetCurrentProcess()) }?,
            target,
        };
        intent.validate(fixture, &intent.target)?;
        Ok(intent)
    }
    pub fn validate(&self, fixture: Uuid, target: &ProcessIdentity) -> Result<(), String> {
        self.owner.validate()?;
        self.target.validate()?;
        target.validate()?;
        if self.version != 1
            || fixture.is_nil()
            || self.fixture_id != fixture
            || self.session_guid != fixture
            || self.session_name != format!("ShellSpan-RpcClient-{}", fixture.simple())
            || &self.target != target
        {
            return Err("RPC trace intent fixture/session/target identity mismatch".into());
        }
        Ok(())
    }
    /// Before starting, rebind both identities to the held process and current controller.
    /// # Safety
    /// Target must remain held through validation and subsequent StartTrace.
    pub unsafe fn validate_start(&self, fixture: Uuid, target: HANDLE) -> Result<(), String> {
        self.validate(fixture, &unsafe { ProcessIdentity::from_handle(target) }?)?;
        if self.owner != unsafe { ProcessIdentity::from_handle(GetCurrentProcess()) }? {
            return Err("RPC trace owner process identity mismatch".into());
        }
        Ok(())
    }
    /// Read-only prerequisite; trusted journal and complete execution-tree gates remain required.
    pub fn recovery_processes(
        &self,
        fixture: Uuid,
    ) -> Result<(ProcessLifetime, ProcessLifetime), String> {
        self.validate(fixture, &self.target)?;
        let owner = self.owner.observe_lifetime()?;
        if !owner.original_stopped() {
            return Err("original RPC trace controller still alive; refuse recovery".into());
        }
        let target = self.target.observe_lifetime()?;
        if !target.original_stopped() {
            return Err("original RPC trace target still alive; refuse recovery".into());
        }
        Ok((owner, target))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lifetime_witness_distinguishes_live_original_from_reused_pid() {
        let original = unsafe { ProcessIdentity::from_handle(GetCurrentProcess()) }.unwrap();
        assert_eq!(original.observe_lifetime().unwrap(), ProcessLifetime::Alive);
        assert!(!original.observe_lifetime().unwrap().original_stopped());
        let mut reused = original.clone();
        reused.creation_time += 1;
        assert_eq!(
            reused.observe_lifetime().unwrap(),
            ProcessLifetime::PidReused
        );
        assert!(reused.observe_lifetime().unwrap().original_stopped());
        let missing = ProcessIdentity {
            process_id: 0,
            creation_time: 0,
        };
        assert!(missing.observe_lifetime().is_err());
        let intent = RpcTraceIntent::new(Uuid::new_v4(), original).unwrap();
        assert!(intent
            .recovery_processes(intent.fixture_id)
            .unwrap_err()
            .contains("controller still alive"));
        let mut owner_gone = intent.clone();
        owner_gone.owner.creation_time += 1;
        assert!(owner_gone
            .recovery_processes(owner_gone.fixture_id)
            .unwrap_err()
            .contains("target still alive"));
    }
    #[test]
    fn actual_bound_control_matches_trace_pid_and_creation_identity() {
        let report: serde_json::Value=serde_json::from_str(include_str!(
            "../../../docs/design/evidence/windows-stage-a-2026-10-09-rpc-trace-bound-intent-control.json"
        )).unwrap();
        let intent: RpcTraceIntent =
            serde_json::from_value(report["trace_intent"].clone()).unwrap();
        let fixture = Uuid::parse_str(report["fixture_id"].as_str().unwrap()).unwrap();
        intent.validate(fixture, &intent.target).unwrap();
        assert_eq!(intent.owner, intent.target);
        assert_eq!(report["rpc_trace"]["process_id"], intent.target.process_id);
        assert_eq!(report["rpc_trace"]["session_name"], intent.session_name);
        assert_eq!(report["rpc_trace"]["session_absent"], true);
        assert_eq!(report["rpc_trace"]["events_lost"], 0);
        assert_eq!(report["rpc_trace"]["events"].as_array().unwrap().len(), 2);
    }
    #[test]
    fn intent_binds_actual_held_process_and_current_owner() {
        let process = unsafe { GetCurrentProcess() };
        let target = unsafe { ProcessIdentity::from_handle(process) }.unwrap();
        assert_eq!(target.process_id, std::process::id());
        let fixture = Uuid::new_v4();
        let intent = RpcTraceIntent::new(fixture, target.clone()).unwrap();
        unsafe { intent.validate_start(fixture, process) }.unwrap();
        let mut changed = intent.clone();
        changed.owner.creation_time += 1;
        assert!(unsafe { changed.validate_start(fixture, process) }.is_err());
        let mut changed = intent.clone();
        changed.target.creation_time += 1;
        assert!(unsafe { changed.validate_start(fixture, process) }.is_err());
        let mut changed = intent.clone();
        changed.target.process_id += 1;
        assert!(unsafe { changed.validate_start(fixture, process) }.is_err());
        let mut changed = intent.clone();
        changed.session_name = "NT Kernel Logger".into();
        assert!(changed.validate(fixture, &target).is_err());
        let mut changed = intent.clone();
        changed.session_guid = Uuid::new_v4();
        assert!(changed.validate(fixture, &target).is_err());
        let mut changed = intent.clone();
        changed.version = 2;
        assert!(changed.validate(fixture, &target).is_err());
        assert!(intent.validate(Uuid::new_v4(), &target).is_err());
        assert!(RpcTraceIntent::new(Uuid::nil(), target).is_err());
    }
    #[test]
    fn intent_rejects_missing_creation_identity_and_freeform_trace_configuration() {
        let target = ProcessIdentity {
            process_id: 42,
            creation_time: 1,
        };
        let intent = RpcTraceIntent::new(Uuid::new_v4(), target).unwrap();
        for field in ["provider", "event_ids", "endpoint", "command"] {
            let mut value = serde_json::to_value(&intent).unwrap();
            value[field] = serde_json::json!("arbitrary");
            assert!(serde_json::from_value::<RpcTraceIntent>(value).is_err());
        }
        let mut changed = intent.clone();
        changed.owner.creation_time = 0;
        assert!(changed.validate(intent.fixture_id, &intent.target).is_err());
        let mut changed = intent.clone();
        changed.target.process_id = 0;
        assert!(changed
            .validate(intent.fixture_id, &changed.target)
            .is_err());
        assert!(unsafe { ProcessIdentity::from_handle(std::ptr::null_mut()) }.is_err());
    }
}
