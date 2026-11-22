//! Result-only fences. PTY display bytes are never changed and these markers
//! cannot establish input proof, submission, execution or editor readiness.
//! The unguessable request ID is received solely on the private NIP channel.
pub use super::protocol::capture_marker as marker;
use std::collections::VecDeque;

#[derive(Default)]
struct ObservedOsc {
    osc_1337_seen: bool,
}
impl vte_capture::Perform for ObservedOsc {
    fn osc_dispatch(&mut self, params: &[&[u8]], bell_terminated: bool) {
        if bell_terminated && params.len() == 2 && params[0] == b"1337" {
            self.osc_1337_seen = true;
        }
    }
}

pub(crate) struct CaptureFence {
    // Separate package version: vt100 enables std on vte 0.15. The explicit
    // no_std feature on 0.14.1 selects its fixed-capacity OSC ArrayVec even
    // under Cargo feature unification. The parser still handles all ANSI state.
    parser: vte_capture::Parser,
    start: Vec<u8>,
    end: Vec<u8>,
    tail: VecDeque<u8>,
    started: bool,
    complete: bool,
    closed: bool,
}
impl std::fmt::Debug for CaptureFence {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CaptureFence")
            .field("started", &self.started)
            .field("complete", &self.complete)
            .finish_non_exhaustive()
    }
}
impl CaptureFence {
    pub fn new(request_id: &str) -> Self {
        Self {
            parser: vte_capture::Parser::new(),
            start: marker(request_id, false),
            end: marker(request_id, true),
            tail: VecDeque::new(),
            started: false,
            complete: false,
            closed: false,
        }
    }
    pub fn complete(&self) -> bool {
        self.complete
    }
    pub fn finished(&self) -> bool {
        self.complete || self.closed
    }
    pub fn finish_incomplete(&mut self) -> Vec<u8> {
        self.closed = true;
        if self.started {
            self.tail.drain(..).collect()
        } else {
            self.tail.clear();
            Vec::new()
        }
    }

    /// Return only bytes between the two registered boundaries, including all
    /// ordinary OSC/control text. Retaining one marker length makes the result
    /// independent of PTY reads, private receipt order and UTF-8 fragmentation.
    pub fn push(&mut self, bytes: &[u8]) -> Vec<u8> {
        let mut output = if self.started {
            Vec::with_capacity(bytes.len())
        } else {
            Vec::new()
        };
        let mut observed = ObservedOsc::default();
        for byte in bytes {
            if self.finished() {
                break;
            }
            self.tail.push_back(*byte);
            self.parser.advance(&mut observed, &[*byte]);
            if std::mem::take(&mut observed.osc_1337_seen) {
                let expected = if self.started { &self.end } else { &self.start };
                if self.tail.len() >= expected.len()
                    && self
                        .tail
                        .iter()
                        .rev()
                        .take(expected.len())
                        .eq(expected.iter().rev())
                {
                    if self.started {
                        self.tail.truncate(self.tail.len() - expected.len());
                        output.extend(self.tail.drain(..));
                        self.complete = true;
                    } else {
                        self.tail.clear();
                        self.started = true;
                    }
                    continue;
                }
            }
            if self.tail.len() > self.end.len() {
                let value = self.tail.pop_front().expect("bounded nonempty tail");
                if self.started {
                    output.push(value);
                }
            }
        }
        output
    }
}
