//! Display-only request rendezvous. No PTY writer, command, lease or execution facts.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};

const MAX_CELLS: usize = 65_536;
type DisplayOriginCells = (Vec<u8>, bool);
type DisplayOriginPending = (DisplayOriginRequest, mpsc::Receiver<DisplayOriginCells>);

#[cfg(windows)]
#[path = "terminal_display_origin_windows.rs"]
pub(crate) mod windows_pipe;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DisplayOriginGeometry {
    pub columns: u16,
    pub rows: u16,
    pub cursor_x: u16,
    pub cursor_y: u16,
}
impl DisplayOriginGeometry {
    fn valid(&self) -> bool {
        self.columns > 0
            && self.rows > 0
            && self.cursor_x < self.columns
            && self.cursor_y < self.rows
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DisplayOriginBinding {
    pub session_id: String,
    pub terminal_session_id: String,
    pub terminal_generation: u64,
    epoch: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DisplayOriginRequest {
    pub session_id: String,
    pub terminal_session_id: String,
    pub terminal_generation: u64,
    pub request_id: String,
    pub request_index: u32,
    pub timeout_ms: u32,
    pub geometry: DisplayOriginGeometry,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DisplayOriginResponse {
    pub request: DisplayOriginRequest,
    #[serde(deserialize_with = "bounded_cell_widths")]
    pub cell_widths: Vec<u8>,
    pub wrap_pending: bool,
}

fn bounded_cell_widths<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<u8>, D::Error> {
    struct Widths;
    impl<'de> serde::de::Visitor<'de> for Widths {
        type Value = Vec<u8>;
        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("at most 65536 cell widths, each 1 or 2")
        }
        fn visit_seq<A: serde::de::SeqAccess<'de>>(
            self,
            mut sequence: A,
        ) -> Result<Self::Value, A::Error> {
            if sequence.size_hint().is_some_and(|n| n > MAX_CELLS) {
                return Err(serde::de::Error::custom("display origin exceeds bound"));
            }
            let mut values = Vec::new();
            while let Some(value) = sequence.next_element::<u8>()? {
                if values.len() >= MAX_CELLS || !matches!(value, 1 | 2) {
                    return Err(serde::de::Error::custom(
                        "invalid display origin cell widths",
                    ));
                }
                values.push(value);
            }
            Ok(values)
        }
    }
    deserializer.deserialize_seq(Widths)
}

struct Pending {
    request: DisplayOriginRequest,
    deadline: Instant,
    result: mpsc::SyncSender<DisplayOriginCells>,
}
struct Session {
    binding: DisplayOriginBinding,
    last_request_index: u32,
    pending: Option<Pending>,
}
#[derive(Default)]
pub(crate) struct DisplayOriginRegistry {
    sessions: Mutex<HashMap<String, Session>>,
}
impl DisplayOriginRegistry {
    /// Only a verified transport calls this; the UI cannot create a binding.
    pub(crate) fn bind(
        &self,
        session_id: &str,
        terminal_session_id: &str,
        terminal_generation: u64,
    ) -> Result<DisplayOriginBinding, String> {
        if session_id.is_empty()
            || session_id.len() > 256
            || terminal_session_id.is_empty()
            || terminal_session_id.len() > 256
            || terminal_generation == 0
        {
            return Err("TERMINAL_DISPLAY_ORIGIN_IDENTITY".into());
        }
        let binding = DisplayOriginBinding {
            session_id: session_id.into(),
            terminal_session_id: terminal_session_id.into(),
            terminal_generation,
            epoch: uuid::Uuid::new_v4().to_string(),
        };
        self.sessions
            .lock()
            .map_err(|_| "TERMINAL_DISPLAY_ORIGIN_UNAVAILABLE")?
            .insert(
                session_id.into(),
                Session {
                    binding: binding.clone(),
                    last_request_index: 0,
                    pending: None,
                },
            );
        Ok(binding)
    }

    pub(crate) fn request(
        &self,
        binding: &DisplayOriginBinding,
        request_index: u32,
        geometry: DisplayOriginGeometry,
        timeout: Duration,
    ) -> Result<DisplayOriginPending, String> {
        if !geometry.valid()
            || request_index == 0
            || request_index > i32::MAX as u32
            || timeout < Duration::from_millis(1)
            || timeout > Duration::from_secs(10)
        {
            return Err("TERMINAL_DISPLAY_ORIGIN_INVALID".into());
        }
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "TERMINAL_DISPLAY_ORIGIN_UNAVAILABLE")?;
        let session = sessions
            .get_mut(&binding.session_id)
            .filter(|s| s.binding == *binding)
            .ok_or("TERMINAL_DISPLAY_ORIGIN_IDENTITY")?;
        if request_index <= session.last_request_index
            || session
                .pending
                .as_ref()
                .is_some_and(|p| p.deadline > Instant::now())
        {
            return Err("TERMINAL_DISPLAY_ORIGIN_BUSY".into());
        }
        let request = DisplayOriginRequest {
            session_id: binding.session_id.clone(),
            terminal_session_id: binding.terminal_session_id.clone(),
            terminal_generation: binding.terminal_generation,
            request_id: uuid::Uuid::new_v4().to_string(),
            request_index,
            timeout_ms: timeout.as_millis() as u32,
            geometry,
        };
        let (sender, receiver) = mpsc::sync_channel(1);
        session.last_request_index = request_index;
        session.pending = Some(Pending {
            request: request.clone(),
            deadline: Instant::now() + timeout,
            result: sender,
        });
        Ok((request, receiver))
    }

    pub(crate) fn respond(&self, response: DisplayOriginResponse) -> Result<(), String> {
        if response.cell_widths.len() > MAX_CELLS
            || response.cell_widths.iter().any(|w| !matches!(w, 1 | 2))
            || (response.wrap_pending
                && (response.cell_widths.is_empty()
                    || response.request.geometry.cursor_x.checked_add(1)
                        != Some(response.request.geometry.columns)))
        {
            return Err("TERMINAL_DISPLAY_ORIGIN_INVALID".into());
        }
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "TERMINAL_DISPLAY_ORIGIN_UNAVAILABLE")?;
        let session = sessions
            .get_mut(&response.request.session_id)
            .ok_or("TERMINAL_DISPLAY_ORIGIN_IDENTITY")?;
        let pending = session
            .pending
            .as_ref()
            .ok_or("TERMINAL_DISPLAY_ORIGIN_STALE")?;
        if pending.request != response.request {
            return Err("TERMINAL_DISPLAY_ORIGIN_IDENTITY".into());
        }
        if Instant::now() >= pending.deadline {
            session.pending.take();
            return Err("TERMINAL_DISPLAY_ORIGIN_STALE".into());
        }
        let pending = session
            .pending
            .take()
            .ok_or("TERMINAL_DISPLAY_ORIGIN_STALE")?;
        pending
            .result
            .send((response.cell_widths, response.wrap_pending))
            .map_err(|_| "TERMINAL_DISPLAY_ORIGIN_STALE".into())
    }

    pub(crate) fn cancel(&self, binding: &DisplayOriginBinding, request_id: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            if let Some(session) = sessions
                .get_mut(&binding.session_id)
                .filter(|s| s.binding == *binding)
            {
                if session
                    .pending
                    .as_ref()
                    .is_some_and(|p| p.request.request_id == request_id)
                {
                    session.pending.take();
                }
            }
        }
    }
    pub(crate) fn unbind(&self, binding: &DisplayOriginBinding) {
        if let Ok(mut sessions) = self.sessions.lock() {
            if sessions
                .get(&binding.session_id)
                .is_some_and(|s| s.binding == *binding)
            {
                sessions.remove(&binding.session_id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn geometry() -> DisplayOriginGeometry {
        DisplayOriginGeometry {
            columns: 47,
            rows: 33,
            cursor_x: 14,
            cursor_y: 3,
        }
    }
    #[test]
    fn reply_is_exact_once_and_wrong_identity_does_not_consume_pending() {
        let registry = DisplayOriginRegistry::default();
        let binding = registry.bind("ui", "terminal", 4).unwrap();
        let (request, receiver) = registry
            .request(&binding, 1, geometry(), Duration::from_secs(1))
            .unwrap();
        let mut wrong = request.clone();
        wrong.terminal_generation += 1;
        assert!(registry
            .respond(DisplayOriginResponse {
                request: wrong,
                cell_widths: vec![1, 2],
                wrap_pending: false,
            })
            .is_err());
        registry
            .respond(DisplayOriginResponse {
                request: request.clone(),
                cell_widths: vec![1, 2],
                wrap_pending: false,
            })
            .unwrap();
        assert_eq!(receiver.recv().unwrap(), (vec![1, 2], false));
        assert!(registry
            .respond(DisplayOriginResponse {
                request,
                cell_widths: vec![1],
                wrap_pending: false,
            })
            .is_err());
    }
    #[test]
    fn replacement_and_close_cancel_only_the_current_binding() {
        let registry = DisplayOriginRegistry::default();
        let old = registry.bind("ui", "terminal", 1).unwrap();
        let (_, old_receiver) = registry
            .request(&old, 1, geometry(), Duration::from_secs(1))
            .unwrap();
        let new = registry.bind("ui", "terminal", 2).unwrap();
        assert!(old_receiver.recv().is_err());
        registry.unbind(&old);
        let (request, receiver) = registry
            .request(&new, 1, geometry(), Duration::from_secs(1))
            .unwrap();
        registry.cancel(&old, &request.request_id);
        registry
            .respond(DisplayOriginResponse {
                request,
                cell_widths: vec![],
                wrap_pending: false,
            })
            .unwrap();
        assert!(receiver.recv().unwrap().0.is_empty());
        let (_, receiver) = registry
            .request(&new, 2, geometry(), Duration::from_secs(1))
            .unwrap();
        registry.unbind(&new);
        assert!(receiver.recv().is_err());
    }
    #[test]
    fn malformed_busy_stale_and_oversized_observations_do_not_enter_other_state() {
        let registry = DisplayOriginRegistry::default();
        let binding = registry.bind("ui", "terminal", 1).unwrap();
        let mut invalid = geometry();
        invalid.cursor_x = invalid.columns;
        assert!(registry
            .request(&binding, 1, invalid, Duration::from_secs(1))
            .is_err());
        let (request, receiver) = registry
            .request(&binding, 1, geometry(), Duration::from_secs(1))
            .unwrap();
        assert!(registry
            .request(&binding, 2, geometry(), Duration::from_secs(1))
            .is_err());
        for values in [vec![0], vec![3], vec![1; MAX_CELLS + 1]] {
            assert!(registry
                .respond(DisplayOriginResponse {
                    request: request.clone(),
                    cell_widths: values,
                    wrap_pending: false,
                })
                .is_err());
        }
        assert!(receiver.try_recv().is_err());
        registry.cancel(&binding, &request.request_id);
        assert!(receiver.recv().is_err());
        assert!(registry
            .request(&binding, 1, geometry(), Duration::from_secs(1))
            .is_err());
        let (request, receiver) = registry
            .request(&binding, 2, geometry(), Duration::from_secs(1))
            .unwrap();
        registry
            .sessions
            .lock()
            .unwrap()
            .get_mut("ui")
            .unwrap()
            .pending
            .as_mut()
            .unwrap()
            .deadline = Instant::now();
        assert!(registry
            .respond(DisplayOriginResponse {
                request,
                cell_widths: vec![1],
                wrap_pending: false,
            })
            .is_err());
        assert!(receiver.recv().is_err());
    }
    #[test]
    fn wire_decoder_rejects_extra_fields_and_invalid_widths_before_accumulation() {
        let registry = DisplayOriginRegistry::default();
        let binding = registry.bind("ui", "terminal", 1).unwrap();
        let (request, _) = registry
            .request(&binding, 1, geometry(), Duration::from_secs(1))
            .unwrap();
        let valid = serde_json::json!({"request":request,"cellWidths":[1,2],"wrapPending":false});
        assert!(serde_json::from_value::<DisplayOriginResponse>(valid.clone()).is_ok());
        for bad in [
            serde_json::json!([0]),
            serde_json::json!([3]),
            serde_json::json!([-1]),
            serde_json::json!(["1"]),
            serde_json::json!(vec![1; MAX_CELLS + 1]),
        ] {
            let mut value = valid.clone();
            value["cellWidths"] = bad;
            assert!(serde_json::from_value::<DisplayOriginResponse>(value).is_err());
        }
        let mut missing = valid.clone();
        missing.as_object_mut().unwrap().remove("wrapPending");
        assert!(serde_json::from_value::<DisplayOriginResponse>(missing).is_err());
        let mut invalid_flag = valid.clone();
        invalid_flag["wrapPending"] = serde_json::json!(1);
        assert!(serde_json::from_value::<DisplayOriginResponse>(invalid_flag).is_err());
        let mut extra = valid;
        extra["sourceText"] = serde_json::json!("MUST_NOT_ENTER");
        assert!(serde_json::from_value::<DisplayOriginResponse>(extra).is_err());
    }

    #[test]
    fn pending_wrap_flag_is_display_only_and_requires_the_final_visible_column() {
        let registry = DisplayOriginRegistry::default();
        let binding = registry.bind("ui", "terminal", 1).unwrap();
        let (request, receiver) = registry
            .request(&binding, 1, geometry(), Duration::from_secs(1))
            .unwrap();
        let mut malformed = request.clone();
        malformed.geometry.cursor_x = u16::MAX;
        assert!(registry
            .respond(DisplayOriginResponse {
                request: malformed,
                cell_widths: vec![1],
                wrap_pending: true,
            })
            .is_err());
        assert!(registry
            .respond(DisplayOriginResponse {
                request: request.clone(),
                cell_widths: vec![1, 2],
                wrap_pending: true
            })
            .is_err());
        assert!(receiver.try_recv().is_err());
        registry
            .respond(DisplayOriginResponse {
                request,
                cell_widths: vec![1, 2],
                wrap_pending: false,
            })
            .unwrap();
        assert_eq!(receiver.recv().unwrap(), (vec![1, 2], false));
        let mut final_column = geometry();
        final_column.cursor_x = final_column.columns - 1;
        let (request, receiver) = registry
            .request(&binding, 2, final_column.clone(), Duration::from_secs(1))
            .unwrap();
        assert!(registry
            .respond(DisplayOriginResponse {
                request: request.clone(),
                cell_widths: vec![],
                wrap_pending: true
            })
            .is_err());
        registry
            .respond(DisplayOriginResponse {
                request,
                cell_widths: vec![1; final_column.columns as usize],
                wrap_pending: true,
            })
            .unwrap();
        assert_eq!(
            receiver.recv().unwrap(),
            (vec![1; final_column.columns as usize], true)
        );
    }
}
