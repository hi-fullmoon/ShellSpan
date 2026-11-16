//! NIP encoding at the real native producer. This maps actual Readline receipts,
//! not terminal text or a frontend acknowledgement, onto the shared wire types.
use super::*;
use nip::{Envelope, ErrorCode, Payload};
const MAX_RETIRED_OPERATIONS: usize = 4096;
fn scope_key(identity: &nip::Identity) -> String {
    nip::sha(
        &serde_json::to_string(&(
            &identity.agent_session_id,
            &identity.task_id,
            &identity.operation_id,
        ))
        .expect("opaque identity tuple"),
    )
}

impl Bridge {
    pub(super) unsafe fn receive_native_connection(&mut self, request: nip::ConnectionEnvelope) {
        if request.validate().is_err() {
            self.fail_closed();
            return;
        }
        if !matches!(request.payload, nip::ConnectionPayload::Probe) {
            self.fail_closed();
            return;
        }
        if self
            .native_connection
            .as_ref()
            .is_some_and(|old| old.connection != request.connection)
        {
            self.fail_closed();
            return;
        }
        self.receiving_until = None;
        let editor_version = CStr::from_ptr(rl_library_version)
            .to_str()
            .ok()
            .map(str::to_owned);
        let profile = nip::PeerProfile {
            shell: nip::ShellFamily::Bash,
            shell_version: self.native_shell_version.clone(),
            editor: nip::EditorFamily::Readline,
            editor_version,
            editor_numeric_version: rl_readline_version as u32,
            adapter_version: "1".into(),
            verified_profile_id: option_env!("SHELLSPAN_NIP_VERIFIED_PROFILE").map(str::to_owned),
        };
        let versions = profile
            .verified_profile_id
            .as_deref()
            .and_then(nip::native_profile_versions);
        let supported = cfg!(any(
            all(
                any(target_os = "macos", target_os = "linux"),
                target_arch = "aarch64"
            ),
            all(target_os = "linux", target_arch = "x86_64", target_env = "gnu")
        )) && p0_native_protocol_supported() == 1
            && p0_bindings_valid() == 1
            && versions.is_some_and(|(bash, _readline, numeric)| {
                profile
                    .shell_version
                    .as_ref()
                    .is_some_and(|value| value.starts_with(&format!("{bash}.")))
                    && profile.editor_numeric_version == numeric
                    && profile
                        .editor_version
                        .as_ref()
                        .is_some_and(|value| nip::native_editor_version_matches(numeric, value))
            })
            && self.retired.len() < MAX_RETIRED_OPERATIONS;
        self.native_connection = Some(request.clone());
        self.reply_connection(
            &request,
            nip::ConnectionPayload::Capabilities {
                profile,
                native_inline: supported,
                source_echo: supported,
                atomic_handoff: supported,
                complete_proof: supported,
                draft_clear: supported,
                inband_display: supported,
                editor_empty: CStr::from_ptr(rl_line_buffer).to_bytes().is_empty(),
            },
        );
        if let Ok(cwd) = std::env::current_dir() {
            if let Some(cwd) = cwd.to_str() {
                self.reply_connection(
                    &request,
                    nip::ConnectionPayload::Directory { cwd: cwd.into() },
                );
            }
        }
    }
    pub(super) fn reply_connection(
        &mut self,
        request: &nip::ConnectionEnvelope,
        payload: nip::ConnectionPayload,
    ) {
        let response = nip::ConnectionEnvelope {
            protocol: nip::PROTOCOL.into(),
            request_id: request.request_id.clone(),
            connection: request.connection.clone(),
            payload,
        };
        if let Ok(bytes) = response.encode() {
            if !self.active {
                return;
            }
            if self.output.len().saturating_add(bytes.len()) > nip::MAX_MESSAGE_BYTES {
                unsafe {
                    self.fail_closed();
                }
                return;
            }
            if self.output.is_empty() {
                self.outgoing_since = Some(Instant::now());
            }
            self.output.extend(bytes);
        }
    }
    pub(super) unsafe fn receive_native(&mut self, envelope: Envelope) {
        if let Err(code) = envelope.validate() {
            self.reply_native(&envelope, Payload::Rejected { code });
            return;
        }
        let connection_matches = self.native_connection.as_ref().is_some_and(|connection| {
            connection.connection.terminal_session_id == envelope.identity.terminal_session_id
                && connection.connection.terminal_generation
                    == envelope.identity.terminal_generation
        });
        if !connection_matches {
            self.reply_native(
                &envelope,
                Payload::Rejected {
                    code: ErrorCode::Identity,
                },
            );
            return;
        }
        self.receiving_until = None;
        if matches!(envelope.payload, Payload::PrepareInput { .. }) && self.draft.is_none() {
            if let Some(previous) = &self.native_guard {
                let old = previous.identity();
                if envelope.identity.lease_generation > old.lease_generation
                    && !self.retired.contains(&scope_key(&envelope.identity))
                {
                    self.native_guard = None;
                    self.native_result = None;
                    self.native_expired_clear = None;
                }
            }
            if self.retired.len() >= MAX_RETIRED_OPERATIONS {
                self.reply_native(
                    &envelope,
                    Payload::Rejected {
                        code: ErrorCode::Limit,
                    },
                );
                return;
            }
        }
        if self.native_guard.is_none() {
            if matches!(envelope.payload, Payload::Query) {
                let payload = self.native_snapshot(&envelope);
                self.reply_native(&envelope, payload);
                return;
            }
            if !matches!(envelope.payload, Payload::PrepareInput { .. }) {
                self.reply_native(
                    &envelope,
                    Payload::Rejected {
                        code: ErrorCode::State,
                    },
                );
                return;
            }
            self.native_guard = Some(nip::RequestGuard::new(envelope.identity.clone()));
        }
        if let Err(code) = self.native_guard.as_mut().unwrap().accept(&envelope) {
            self.reply_native(&envelope, Payload::Rejected { code });
            return;
        }
        self.native_request = Some(envelope.clone());
        if matches!(envelope.payload, Payload::CancelDraft)
            && self.native_expired_clear.as_ref() == Some(&envelope.identity)
        {
            self.native_expired_clear = None;
            let editor_empty = self.draft.is_none()
                && p0_bindings_valid() == 1
                && rl_point == 0
                && rl_end == 0
                && CStr::from_ptr(rl_line_buffer).to_bytes().is_empty();
            if !editor_empty {
                self.reply_native(
                    &envelope,
                    Payload::Rejected {
                        code: ErrorCode::RecoveryRequired,
                    },
                );
                return;
            }
            self.reply_native(&envelope, Payload::DraftCleared { editor_empty });
            if let Some(probe) = self.native_connection.clone() {
                self.reply_connection(
                    &probe,
                    nip::ConnectionPayload::EditorReady {
                        editor_empty,
                        owned_draft_absent: self.draft.is_none(),
                        after_command: self.native_last_prepared.clone(),
                    },
                );
            }
            return;
        }
        if matches!(envelope.payload, Payload::Query) {
            let payload = self.native_snapshot(&envelope);
            self.reply_native(&envelope, payload);
            return;
        }
        if matches!(envelope.payload, Payload::Interrupt) {
            if !self.draft.as_ref().is_some_and(|draft| draft.submitted) {
                self.reply_native(
                    &envelope,
                    Payload::Rejected {
                        code: ErrorCode::State,
                    },
                );
                return;
            }
            let group = libc::tcgetpgrp(libc::STDIN_FILENO);
            if group <= 0 || libc::kill(-group, libc::SIGINT) != 0 {
                self.reply_native(
                    &envelope,
                    Payload::Rejected {
                        code: ErrorCode::RecoveryRequired,
                    },
                );
            }
            return;
        }
        let (action, source, source_digest, plan, plan_digest, reduced) = match &envelope.payload {
            Payload::PrepareInput {
                source,
                source_digest,
                plan,
                reduced_motion,
                job,
                ..
            } => (
                "prepare",
                if matches!(job, Some(nip::JobExecution::Control { .. })) {
                    String::new()
                } else {
                    source.clone()
                },
                if matches!(job, Some(nip::JobExecution::Control { .. })) {
                    digest("")
                } else {
                    source_digest.clone()
                },
                plan.clone(),
                digest(plan),
                *reduced_motion,
            ),
            Payload::Commit { source_digest, .. } => {
                let plan = self
                    .draft
                    .as_ref()
                    .map(|draft| draft.request.plan.clone())
                    .unwrap_or_default();
                if !matches!(&envelope.payload, Payload::Commit { plan_digest, .. } if *plan_digest == nip::bound_plan_digest(source_digest, &plan))
                {
                    self.reply_native(
                        &envelope,
                        Payload::Rejected {
                            code: ErrorCode::Binding,
                        },
                    );
                    return;
                }
                (
                    "commit",
                    String::new(),
                    self.draft
                        .as_ref()
                        .map(|draft| draft.request.source_digest.clone())
                        .unwrap_or_default(),
                    String::new(),
                    digest(&plan),
                    false,
                )
            }
            Payload::CancelDraft => {
                let (source, plan) = self
                    .draft
                    .as_ref()
                    .map(|draft| {
                        (
                            draft.request.source_digest.clone(),
                            draft.request.plan_digest.clone(),
                        )
                    })
                    .unwrap_or_default();
                ("cancel", String::new(), source, String::new(), plan, false)
            }
            _ => {
                self.reply_native(
                    &envelope,
                    Payload::Rejected {
                        code: ErrorCode::State,
                    },
                );
                return;
            }
        };
        self.native_sequence += 1;
        let request = Request {
            private_control: matches!(
                &envelope.payload,
                Payload::PrepareInput {
                    job: Some(nip::JobExecution::Control { .. }),
                    ..
                }
            ) || self
                .draft
                .as_ref()
                .is_some_and(|draft| draft.request.private_control),
            request: self.native_sequence,
            generation: 1,
            lease: 1,
            operation: scope_key(&envelope.identity),
            revision: envelope.identity.source_revision,
            action: action.into(),
            expires_ms: u64::MAX,
            source,
            source_digest,
            plan,
            plan_digest,
            reduced,
            insertion: true,
            start_rebase: false,
            geometry_rebase: false,
            viewport_safe: false,
            append_display: true,
            native: Some(envelope),
        };
        self.receive(request);
        if let Some(draft) = &self.draft {
            self.native_last_prepared = draft
                .request
                .native
                .as_ref()
                .map(|request| request.identity.clone());
        }
    }

    unsafe fn native_snapshot(&self, request: &Envelope) -> Payload {
        let phase = if self.native_result.is_some() {
            "completed"
        } else if self
            .draft
            .as_ref()
            .is_some_and(|draft| draft.native_started)
        {
            "running"
        } else if self.draft.as_ref().is_some_and(|draft| draft.submitted) {
            "submissionAttempted"
        } else if self.draft.as_ref().is_some_and(|draft| draft.confirmed) {
            "inputConfirmed"
        } else if self.draft.is_some() {
            "typing"
        } else if self.retired.contains(&scope_key(&request.identity)) {
            "recoveryRequired"
        } else {
            "preparing"
        };
        Payload::Snapshot {
            phase: phase.into(),
            may_have_submitted: self.native_result.is_some()
                || self.draft.as_ref().is_some_and(|draft| draft.submitted),
            editor_utf8_valid: std::str::from_utf8(CStr::from_ptr(rl_line_buffer).to_bytes())
                .is_ok(),
            cursor_utf8_bytes: usize::try_from(rl_point).ok(),
            end_utf8_bytes: usize::try_from(rl_end).ok(),
        }
    }

    pub(super) fn reply_native(&mut self, request: &Envelope, payload: Payload) {
        let response = Envelope {
            protocol: nip::PROTOCOL.into(),
            request_id: request.request_id.clone(),
            identity: request.identity.clone(),
            payload,
        };
        if let Ok(bytes) = response.encode() {
            if !self.active {
                return;
            }
            if self.output.len().saturating_add(bytes.len()) > nip::MAX_MESSAGE_BYTES {
                unsafe {
                    self.fail_closed();
                }
                return;
            }
            if self.output.is_empty() {
                self.outgoing_since = Some(Instant::now());
            }
            self.output.extend(bytes);
        }
    }

    pub(super) fn emit_native(&mut self, request: Option<&Envelope>, event: &str, details: &Value) {
        let Some(request) = request.or(self.native_request.as_ref()).cloned() else {
            return;
        };
        let binding = self
            .draft
            .as_ref()
            .map(|draft| (&draft.request.source_digest, &draft.request.plan));
        let (source_digest, plan_digest) = match &request.payload {
            Payload::PrepareInput {
                source_digest,
                plan_digest,
                ..
            }
            | Payload::Commit {
                source_digest,
                plan_digest,
            } => (source_digest.clone(), plan_digest.clone()),
            _ => binding
                .map(|(source, plan)| (source.clone(), nip::bound_plan_digest(source, plan)))
                .unwrap_or_default(),
        };
        let payload = match event {
            "Prepared" => Payload::Prepared {
                source_digest,
                plan_digest,
            },
            "InputConfirmed" => unsafe {
                let bytes = CStr::from_ptr(rl_line_buffer).to_bytes();
                if matches!(
                    &request.payload,
                    Payload::PrepareInput {
                        job: Some(nip::JobExecution::Control { .. }),
                        ..
                    }
                ) {
                    self.reply_native(
                        &request,
                        Payload::ControlInputConfirmed {
                            plan_digest,
                            editor_empty: bytes.is_empty() && rl_point == 0 && rl_end == 0,
                        },
                    );
                    return;
                }
                // Strict UTF-8, raw byte count and actual native point/end. Never
                // convert malformed bytes to replacement characters as proof.
                let Ok(actual) = std::str::from_utf8(bytes) else {
                    self.reply_native(
                        &request,
                        Payload::Rejected {
                            code: ErrorCode::RecoveryRequired,
                        },
                    );
                    return;
                };
                if rl_point < 0
                    || rl_end < 0
                    || rl_point != rl_end
                    || rl_end as usize != bytes.len()
                {
                    self.reply_native(
                        &request,
                        Payload::Rejected {
                            code: ErrorCode::RecoveryRequired,
                        },
                    );
                    return;
                }
                Payload::InputConfirmed {
                    source_digest: nip::sha(actual),
                    plan_digest,
                    utf8_bytes: bytes.len(),
                    cursor_utf8_bytes: rl_point as usize,
                    end_utf8_bytes: rl_end as usize,
                }
            },
            "CommitArmed" => Payload::CommitArmed,
            "SubmissionAccepted" => Payload::SubmissionAccepted,
            "Started" => Payload::Started,
            "Settled" => {
                let Some(exit_code) = details["exit"]
                    .as_i64()
                    .and_then(|value| i32::try_from(value).ok())
                else {
                    self.reply_native(
                        &request,
                        Payload::Rejected {
                            code: ErrorCode::RecoveryRequired,
                        },
                    );
                    return;
                };
                Payload::Settled { exit_code }
            }
            "DraftCleared" => Payload::DraftCleared {
                editor_empty: unsafe { CStr::from_ptr(rl_line_buffer).to_bytes().is_empty() },
            },
            "Expired" => Payload::Rejected {
                code: ErrorCode::Expired,
            },
            "RecoveryRequired" | "ControlLost" => Payload::Rejected {
                code: ErrorCode::RecoveryRequired,
            },
            "Rejected" => Payload::Rejected {
                code: ErrorCode::State,
            },
            "SyntaxRejected" => Payload::Rejected {
                code: ErrorCode::Binding,
            },
            _ => return,
        };
        self.reply_native(&request, payload);
    }
}
