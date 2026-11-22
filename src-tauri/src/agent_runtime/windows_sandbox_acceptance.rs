//! Fixed commands for the isolated Windows debug acceptance package.
use super::{ActiveDriverLease, AgentRuntime};
use crate::agent_runtime::{
    AgentActiveScope, AgentExecutionSurface, AgentInboxLane, AgentInboxMessage,
    AgentLifecyclePhase, AgentMessageSource, AgentToolDecision, AgentToolDecisionInput,
    ModelToolCall,
};
use base64::Engine;
use serde_json::{json, Value};
use std::{path::Path, sync::Arc};

impl AgentRuntime {
    fn require_windows_acceptance(&self, session_id: &str) -> Result<(), String> {
        let snapshot = self.sessions.snapshot(session_id)?;
        if !session_id.starts_with("windows-sandbox-acceptance-")
            || snapshot.ended
            || snapshot.header.model_selection.is_some()
            || snapshot.header.execution_surface != AgentExecutionSurface::Direct
            || snapshot
                .header
                .target
                .is_none_or(|target| !target.requires_windows_sandbox())
        {
            return Err("Isolated Windows sandbox acceptance Session required".into());
        }
        Ok(())
    }

    pub(crate) async fn windows_sandbox_acceptance_command(
        &self,
        evidence: &Path,
        session_id: &str,
        call_id: &str,
        kind: &str,
        argument: Option<&str>,
    ) -> Result<Value, String> {
        self.require_windows_acceptance(session_id)?;
        let id = uuid::Uuid::parse_str(call_id).map_err(|_| "Acceptance call requires UUID")?;
        let (source, timeout) = match kind {
            "sandbox-write" => (
                "[IO.File]::WriteAllText('approved.txt','approved')".into(),
                10_000,
            ),
            "sandbox-exit" => (
                "[Console]::Out.Write('stdout'); [Console]::Error.Write('stderr'); exit 125".into(),
                10_000,
            ),
            "sandbox-boundary" => {
                let outside = evidence
                    .join("outside.txt")
                    .display()
                    .to_string()
                    .replace('\'', "''");
                let port = argument
                    .and_then(|port| port.parse::<u16>().ok())
                    .filter(|port| *port > 1024)
                    .ok_or("Expected a high loopback port")?;
                (format!(
                    "[IO.File]::WriteAllText('inside.txt','inside'); [IO.File]::WriteAllText((Join-Path $env:TEMP 'scratch.txt'),'temp'); \
                     try {{ [IO.File]::ReadAllText('{outside}') | Out-Null; exit 41 }} catch {{}}; \
                     try {{ [IO.File]::WriteAllText('{outside}','modified'); exit 42 }} catch {{}}; \
                     $tcp = [Net.Sockets.TcpClient]::new(); try {{ $connect = $tcp.BeginConnect('127.0.0.1',{port},$null,$null); \
                     if ($connect.AsyncWaitHandle.WaitOne(750)) {{ $tcp.EndConnect($connect); exit 43 }} }} catch {{}} finally {{ $tcp.Dispose() }}; \
                     [Console]::Out.Write('boundaries'); exit 0"
                ), 10_000)
            }
            "sandbox-timeout" | "sandbox-cancel" | "sandbox-crash" => {
                let child: Vec<_> =
                    "[IO.File]::WriteAllText([IO.Path]::Combine($env:HOME,'child.txt'),[string]$PID); Start-Sleep -Seconds 60"
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect();
                let child = base64::engine::general_purpose::STANDARD.encode(child);
                (format!(
                    "$ErrorActionPreference = 'Stop'; $start = [Diagnostics.ProcessStartInfo]::new([IO.Path]::Combine($PSHOME,'powershell.exe'),'-NoProfile -NonInteractive -EncodedCommand {child}'); \
                     $start.UseShellExecute = $false; $start.WorkingDirectory = $env:HOME; \
                     $childProcess = [Diagnostics.Process]::Start($start); \
                     [IO.File]::WriteAllText('leader.txt',[string]$PID); $childProcess.WaitForExit()"
                ), if kind == "sandbox-timeout" { 7_000 } else { 55_000 })
            }
            _ => return Err("Unknown fixed Windows sandbox acceptance case".into()),
        };
        let handle = self
            .agents
            .attach_without_model(self.sessions.clone(), session_id.into())?;
        let entry = handle.entry();
        self.handles
            .lock()
            .map_err(|_| "Agent handle registry is unavailable")?
            .insert(session_id.into(), handle);
        if !entry.try_acquire_driver()? {
            return Err("Acceptance tool driver is busy".into());
        }
        let _driver = ActiveDriverLease(Arc::clone(&entry));
        let turn = format!("sandbox-turn-{id}");
        let step = format!("sandbox-step-{id}");
        self.sessions.enqueue(
            session_id,
            AgentInboxLane::NextTurn,
            AgentInboxMessage {
                message_id: format!("sandbox-input-{id}"),
                client_submission_id: None,
                content: format!("Run the isolated Windows sandbox acceptance case {kind}."),
                source: AgentMessageSource::user(),
                images: Vec::new(),
                terminal_context: None,
            },
        )?;
        self.sessions
            .begin_turn_step(session_id, turn.clone(), step.clone())?
            .ok_or("Acceptance input was not claimed")?;
        entry.set_scope(Some(AgentActiveScope {
            turn_id: turn.clone(),
            step_id: Some(step.clone()),
        }))?;
        entry.set_phase(AgentLifecyclePhase::Running)?;
        let settlement = self.tools.process_model_calls(
            &entry, &turn, &step, &format!("sandbox-request-{id}"),
            vec![ModelToolCall {
                call_id: call_id.into(), provider_call_id: None, name: "run_terminal_command".into(),
                arguments: json!({"command": source, "explanation": "Verify Windows AppContainer on owned fixtures", "timeoutMs": timeout}),
            }],
        ).await?;
        Ok(
            json!({"settlement": format!("{settlement:?}"), "session": self.sessions.snapshot(session_id)?}),
        )
    }

    pub(crate) async fn windows_sandbox_acceptance_decide(
        &self,
        input: AgentToolDecisionInput,
        approve: bool,
    ) -> Result<Value, String> {
        self.require_windows_acceptance(&input.session_id)?;
        let entry = self
            .agents
            .get(&input.session_id)?
            .ok_or("Acceptance Agent is unavailable")?;
        let session_id = input.session_id.clone();
        self.tools
            .decide(
                &entry,
                input,
                if approve {
                    AgentToolDecision::Approve
                } else {
                    AgentToolDecision::Reject
                },
            )
            .await?
            .acknowledge()?;
        Ok(json!({"session": self.sessions.snapshot(&session_id)?}))
    }
}
