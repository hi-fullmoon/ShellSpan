use serde_json::json;

use crate::agent_contract::{
    AgentPermissionMode, AgentRequest, AgentTargetKind, AgentTargetSnapshot, AgentToolCall,
    AgentToolResult, AgentToolResultStatus,
};

use super::types::{
    AgentPermissionModeV3, AgentRequestSourceV3, AgentRequestV3, AgentToolCallV3,
    AgentToolResultStatusV3, AgentToolResultV3, AgentToolTargetV3, AGENT_CONTRACT_V3_VERSION,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentV2CompatibilityError {
    EmptyUserSession,
    EmptyGoal,
    MissingSuccessCriteria,
    ResultRequestMismatch,
    ResultCallMismatch,
}

pub fn adapt_v2_target_to_v3(target: &AgentTargetSnapshot) -> AgentToolTargetV3 {
    let target_id = format!("v2:{}", target.session_id);
    match target.kind {
        AgentTargetKind::Local => AgentToolTargetV3::Local {
            target_id,
            session_id: target.session_id.clone(),
            cwd: None,
        },
        AgentTargetKind::Remote => AgentToolTargetV3::Remote {
            target_id,
            session_id: target.session_id.clone(),
            profile_id: target.profile_id.clone(),
            host: target.host.clone(),
            port: target.port,
            username: target.username.clone(),
            root_path: None,
            local_root: None,
        },
    }
}

pub fn adapt_v2_request_to_v3(
    request: &AgentRequest,
    user_session_id: impl Into<String>,
    goal: impl Into<String>,
    success_criteria: Vec<String>,
) -> Result<AgentRequestV3, AgentV2CompatibilityError> {
    let user_session_id = user_session_id.into();
    let goal = goal.into();
    if user_session_id.trim().is_empty() {
        return Err(AgentV2CompatibilityError::EmptyUserSession);
    }
    if goal.trim().is_empty() {
        return Err(AgentV2CompatibilityError::EmptyGoal);
    }
    if success_criteria.is_empty() {
        return Err(AgentV2CompatibilityError::MissingSuccessCriteria);
    }
    let permission_mode = match request.permission_mode {
        AgentPermissionMode::RequestApproval => AgentPermissionModeV3::RequestApproval,
        AgentPermissionMode::AutoApproveReadOnly => AgentPermissionModeV3::ScopedAutopilot,
        AgentPermissionMode::FullAccess => AgentPermissionModeV3::Operator,
    };
    Ok(AgentRequestV3 {
        contract_version: AGENT_CONTRACT_V3_VERSION,
        request_id: request.request_id.clone(),
        user_session_id,
        task_id: format!("v2:{}", request.request_id),
        goal,
        success_criteria,
        targets: vec![adapt_v2_target_to_v3(&request.target)],
        permission_mode,
        source_contract: AgentRequestSourceV3::V2Compatibility,
    })
}

/// Adapts the single v2 terminal tool into the v3 `exec_command` shape. The
/// capability id is required input and is never fabricated by the adapter.
pub fn adapt_v2_tool_call_to_v3(
    call: &AgentToolCall,
    capability_id: impl Into<String>,
) -> AgentToolCallV3 {
    AgentToolCallV3 {
        request_id: call.request_id.clone(),
        call_id: call.call_id.clone(),
        tool_name: "exec_command".into(),
        arguments: json!({
            "command": call.command,
            "explanation": call.explanation,
            "channel": "pty"
        }),
        target: adapt_v2_target_to_v3(&call.target),
        capability_id: capability_id.into(),
    }
}

/// Converts v2 results only when the request and call identity already match.
/// Historical v2 output is explicitly marked as combined and as having no
/// trustworthy truncation metadata.
pub fn adapt_v2_tool_result_to_v3(
    result: &AgentToolResult,
    call: &AgentToolCallV3,
) -> Result<AgentToolResultV3, AgentV2CompatibilityError> {
    if result.request_id != call.request_id {
        return Err(AgentV2CompatibilityError::ResultRequestMismatch);
    }
    if result.call_id != call.call_id {
        return Err(AgentV2CompatibilityError::ResultCallMismatch);
    }
    let status = match result.status {
        AgentToolResultStatus::Completed => AgentToolResultStatusV3::Completed,
        AgentToolResultStatus::Rejected => AgentToolResultStatusV3::Rejected,
        AgentToolResultStatus::Failed => AgentToolResultStatusV3::Failed,
        AgentToolResultStatus::TimedOut => AgentToolResultStatusV3::TimedOut,
        AgentToolResultStatus::Cancelled => AgentToolResultStatusV3::Cancelled,
    };
    let status_label = match result.status {
        AgentToolResultStatus::Completed => "completed",
        AgentToolResultStatus::Rejected => "rejected",
        AgentToolResultStatus::Failed => "failed",
        AgentToolResultStatus::TimedOut => "timed out",
        AgentToolResultStatus::Cancelled => "cancelled",
    };
    let data = (result.status != AgentToolResultStatus::Rejected).then(|| {
        let mut data = json!({
            "channel": "pty",
            "state": "exited",
            "stdout": "",
            "stderr": "",
            "combinedOutput": result.output,
            "truncated": false,
            "compatibility": {
                "sourceContract": "v2",
                "outputSeparation": "combined",
                "truncationKnowledge": "notReported"
            }
        });
        if let Some(exit_code) = result.exit_code {
            data.as_object_mut()
                .expect("compatibility result data is an object")
                .insert("exitCode".into(), json!(exit_code));
        }
        data
    });
    Ok(AgentToolResultV3 {
        request_id: result.request_id.clone(),
        call_id: result.call_id.clone(),
        tool_name: call.tool_name.clone(),
        target_id: call.target.target_id().to_string(),
        status,
        summary: format!("v2 compatibility result: {status_label}"),
        data,
        artifacts: Vec::new(),
        effects: Vec::new(),
        truncated: None,
    })
}
