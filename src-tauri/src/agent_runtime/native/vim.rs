use super::*;
use crate::terminal_vim_bridge::{
    self as bridge, BridgeFailure, EditAction, EditorCommand, EditorError, EditorKind, EditorReply,
    EditorSnapshot, EditorTarget, InsertArguments,
};

impl NativeToolEngine {
    pub(super) fn execute_vim_tool(
        &self,
        context: &NativeExecutionContext,
        call: &AgentToolCallNative,
        effect: &AgentObservedEffectNative,
        sessions: &SessionManager,
        cancellation: &CancellationToken,
        dispatch: &VisibleTerminalDispatch<'_>,
    ) -> Result<AgentToolResultNative, String> {
        let AgentToolTargetNative::Remote {
            session_id,
            root_path,
            ..
        } = &call.target
        else {
            return Err("Vim tools require a bound SSH terminal".into());
        };
        let root = root_path.as_deref().unwrap_or("");
        let root = if root == "/" {
            root
        } else {
            root.trim_end_matches('/')
        };
        if !root.is_empty() && root != "/" && !bridge::valid_path(root) {
            return Err("The frozen SSH workspace path is invalid for Vim editing".into());
        }
        let check = || {
            let snapshot = self.terminal_broker.snapshot(Some(session_id))?;
            let terminal = snapshot
                .session
                .ok_or("The bound SSH terminal is unavailable")?;
            if !snapshot.remote_bound_terminal_rollout.enabled
                || !terminal.open
                || terminal.transport_kind != TerminalTransportKind::SshPty
                || terminal.transport_session_id != *session_id
                || terminal.integration_state != TerminalIntegrationState::Ready
                || terminal.input_observation.native_recovery_required
                || terminal.input_observation.native_clear_pending
                || terminal.input_observation.command_input_pending
                || !terminal
                    .lease
                    .as_ref()
                    .is_some_and(|lease| matches!(lease.owner, TerminalLeaseOwner::User { .. }))
                || (terminal.active_command_id.is_some()
                    && !terminal.input_observation.foreground_handoff_active)
                || self.terminal_leases.turn_owner(session_id)?.as_deref()
                    != Some(context.request.user_session_id.as_str())
            {
                return Err(
                    "The bound SSH terminal is unavailable for this editor operation".to_owned(),
                );
            }
            Ok(())
        };
        let result = |status, summary: &str, data| AgentToolResultNative {
            request_id: context.request.request_id.clone(),
            call_id: call.call_id.clone(),
            tool_name: call.tool_name.clone(),
            target_id: call.target.target_id().into(),
            status,
            summary: summary.into(),
            data: Some(data),
            artifacts: Vec::new(),
            effects: vec![effect.clone()],
            truncated: Some(false),
        };
        let failed = |failure| {
            use AgentToolResultStatusNative as Status;
            let (status, summary, reason) = match failure {
                BridgeFailure::NotAttached => (Status::Rejected, "Activate the bridge in the current Vim or Neovim from Normal mode.", "editorNotAttached"),
                BridgeFailure::Unavailable => (Status::Rejected, "The SSH editor bridge is unavailable.", "bridgeUnavailable"),
                BridgeFailure::Busy => (Status::Rejected, "The editor bridge already has a pending request.", "bridgeBusy"),
                BridgeFailure::Cancelled => (Status::Cancelled, "The editor operation was cancelled before dispatch.", "cancelled"),
                BridgeFailure::TimedOut => (Status::TimedOut, "The editor did not acknowledge the request in time.", "timedOut"),
                BridgeFailure::Uncertain => (Status::Uncertain, "The editor may have applied the operation. Inspect the current buffer and disk before taking any further action.", "outcomeUnknown"),
            };
            let mut data = json!({ "reason": reason });
            if failure == BridgeFailure::NotAttached {
                data["activationCommand"] = json!(bridge::ACTIVATE);
            }
            if failure == BridgeFailure::Uncertain {
                data["noAutoReplay"] = json!(true);
            }
            result(status, summary, data)
        };
        let editor_failure = |reply| {
            match reply {
            EditorReply::Rejected { code } => result(
                AgentToolResultStatusNative::Rejected,
                match code {
                    EditorError::DiskBaselineUnavailable => "The editor has no verified disk version for this buffer. Ask the user to compare the on-disk file with their edits and save it manually if intended.",
                    EditorError::MultipleHardLinks => "The file has multiple hard links. The editor did not save it.",
                    EditorError::DiskChanged => "The file on disk changed since this buffer was read or saved. The editor did not overwrite it.",
                    _ => "The editor refused the operation. The requested mutation did not run.",
                },
                json!({ "reason": code }),
            ),
            EditorReply::Uncertain { code } => result(
                AgentToolResultStatusNative::Uncertain,
                "Part or all of the operation may have run. Inspect the buffer and disk before further writes.",
                json!({ "reason": code, "noAutoReplay": true }),
            ),
            _ => failed(BridgeFailure::Uncertain),
        }
        };
        let owner = format!("{}:{}", context.request.user_session_id, context.turn_id);
        let validate_path = |path: &str| {
            bridge::valid_path(path)
                && !super::super::path_is_sensitive_native(path)
                && !super::super::protected_delete_path_native(path)
                && !path.split('/').any(|part| {
                    [
                        ".shellspan-vim-",
                        ".ss-nip-",
                        ".shellspan-terminal-integration-",
                    ]
                    .iter()
                    .any(|prefix| part.starts_with(prefix))
                })
                && (root.is_empty()
                    || root == "/"
                    || path
                        .strip_prefix(root)
                        .is_some_and(|suffix| suffix.starts_with('/')))
        };
        let response = |kind: EditorKind,
                        snapshot: EditorSnapshot,
                        outcome: &str,
                        summary: &str,
                        path: Option<&str>| {
            if !validate_path(&snapshot.path)
                || !bridge::valid_id(&snapshot.id)
                || path.is_some_and(|path| snapshot.path != path)
            {
                if path.is_some() {
                    failed(BridgeFailure::Uncertain)
                } else {
                    result(
                        AgentToolResultStatusNative::Rejected,
                        "The active buffer is outside the supported file scope.",
                        json!({ "reason": "unsupportedFile" }),
                    )
                }
            } else {
                result(
                    AgentToolResultStatusNative::Completed,
                    summary,
                    json!({ "outcome": outcome, "editor": kind, "snapshot": snapshot }),
                )
            }
        };
        self.revalidate_target(context, &call.target, sessions, dispatch.database)?;
        check()?;
        if cancellation.is_cancelled() {
            return Ok(failed(BridgeFailure::Cancelled));
        }
        if call.tool_name == bridge::INSPECT {
            let command = EditorCommand::Inspect {
                root: root.into(),
                owner,
            };
            return Ok(
                match sessions
                    .enqueue_vim_command(session_id, command)
                    .and_then(|pending| pending.wait(cancellation))
                {
                    Ok((kind, EditorReply::Observed { snapshot })) => response(
                        kind,
                        snapshot,
                        "observed",
                        "Inspected the active editor buffer.",
                        None,
                    ),
                    Ok((_, reply)) => editor_failure(reply),
                    Err(failure) => failed(failure),
                },
            );
        }

        let (target, action) = if call.tool_name == bridge::INSERT {
            let args: InsertArguments = serde_json::from_value(call.arguments.clone())
                .map_err(|_| "Invalid editor insertion arguments")?;
            (
                EditorTarget {
                    snapshot_id: args.snapshot_id,
                    path: args.path,
                },
                EditAction::Insert {
                    position: args.position,
                    text: args.text,
                },
            )
        } else {
            let target: EditorTarget = serde_json::from_value(call.arguments.clone())
                .map_err(|_| "Invalid editor save arguments")?;
            (target, EditAction::Save)
        };
        if !validate_path(&target.path) {
            return Err("The active buffer is outside the supported file scope".into());
        }
        let is_save = matches!(action, EditAction::Save);
        let target_path = target.path.clone();
        let prepare = match sessions.enqueue_vim_command(
            session_id,
            EditorCommand::Prepare {
                root: root.into(),
                owner,
                target,
                action,
            },
        ) {
            Ok(pending) => pending,
            Err(failure) => return Ok(failed(failure)),
        };
        let prepared_id = prepare.id.clone();
        match prepare.wait(cancellation) {
            Ok((_, EditorReply::Prepared)) => {}
            Ok((_, reply)) => return Ok(editor_failure(reply)),
            Err(failure) => return Ok(failed(failure)),
        }
        self.revalidate_target(context, &call.target, sessions, dispatch.database)?;
        let pending = dispatch.write(|| {
            check()?;
            if cancellation.is_cancelled() {
                return Ok(Err(BridgeFailure::Cancelled));
            }
            Ok(sessions.enqueue_vim_command(session_id, EditorCommand::Commit { prepared_id }))
        })?;
        Ok(
            match pending.and_then(|pending| pending.wait(cancellation)) {
                Ok((kind, EditorReply::Inserted { snapshot })) if !is_save => response(
                    kind,
                    snapshot,
                    "inserted",
                    "Text was inserted in the editor buffer. The buffer remains open.",
                    Some(&target_path),
                ),
                Ok((kind, EditorReply::Saved { snapshot })) if is_save => response(
                    kind,
                    snapshot,
                    "saved",
                    "The editor saved the buffer and verified the file bytes by reading them back.",
                    Some(&target_path),
                ),
                Ok((_, reply)) => editor_failure(reply),
                Err(failure) => failed(failure),
            },
        )
    }
}
