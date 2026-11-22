use std::collections::HashSet;

use crate::agent_runtime::{
    images::VISION,
    skills::{
        unchanged_by_redaction, LoadedSkill, SkillInvocationKind, SKILL_PROTOCOL, SKILL_TOOL,
    },
    AgentCapabilityScope, AgentPlanStep, AgentSubagentBudget, AgentSubagentInheritance,
    MAX_AGENT_STREAM_DELTA_BYTES, MAX_TERMINAL_CONTEXT_BYTES,
};

use super::*;

const MAX_IDENTIFIER_BYTES: usize = 128;
const MAX_LABEL_BYTES: usize = 4 * 1024;
const MAX_COLLECTION_ITEMS: usize = 1_024;
const MAX_SESSION_TITLE_CHARS: usize = 120;
const MAX_SESSION_TITLE_BYTES: usize = 512;

pub(super) fn validate_session_lifecycle_payload(event: &AgentSessionEvent) -> Result<(), String> {
    use AgentSessionEventPayload as Payload;

    match &event.payload {
        Payload::SessionCreated {
            task_id,
            goal,
            parent_session_id,
            continued_from_session_id,
            target,
            success_criteria,
            capability_scope,
            subagent,
            ..
        } => {
            require_scope(event, false, false)?;
            validate_identifier(task_id, "taskId")?;
            validate_text(goal, "goal", false, MAX_AGENT_MESSAGE_BYTES)?;
            if let Some(parent) = parent_session_id {
                validate_identifier(parent, "parentSessionId")?;
            }
            if let Some(source_id) = continued_from_session_id {
                validate_identifier(source_id, "continuedFromSessionId")?;
                if source_id == &event.session_id
                    || parent_session_id.is_some()
                    || subagent.is_some()
                {
                    return Err("continuation requires a new root Session".into());
                }
            }
            if let Some(target) = target {
                validate_session_target(target)?;
            }
            validate_collection_allow_empty(success_criteria, "success criteria")?;
            for criterion in success_criteria {
                validate_text(
                    criterion,
                    "success criterion",
                    false,
                    MAX_AGENT_MESSAGE_BYTES,
                )?;
            }
            if let Some(scope) = capability_scope {
                validate_capability_scope(scope)?;
            }
            if let Some(subagent) = subagent {
                validate_subagent_session(subagent, parent_session_id.as_deref())?;
            }
        }
        Payload::AgentCreated {
            agent_id,
            parent_agent_id,
        } => {
            require_scope(event, false, false)?;
            validate_identifier(agent_id, "agentId")?;
            if let Some(parent) = parent_agent_id {
                validate_identifier(parent, "parentAgentId")?;
            }
        }
        Payload::SessionResumed {} => require_scope(event, false, false)?,
        Payload::SubagentRecoveryStarted {
            failed_turn_id,
            recovery_id,
            message,
        } => {
            require_scope(event, false, false)?;
            validate_identifier(failed_turn_id, "failedTurnId")?;
            validate_identifier(recovery_id, "recoveryId")?;
            validate_inbox_message(message)?;
        }
        Payload::AgentStatus { reason, .. } | Payload::SessionEnded { reason, .. } => {
            require_scope(event, false, false)?;
            if let Some(reason) = reason {
                validate_text(reason, "status reason", false, MAX_AGENT_MESSAGE_BYTES)?;
            }
        }
        Payload::SessionModelSelected { provider } => {
            require_scope(event, false, false)?;
            // Replay validates the recorded values, independently of today's model catalog.
            validate_text(&provider.route_id, "routeId", false, MAX_LABEL_BYTES)?;
            validate_text(&provider.model_id, "modelId", false, MAX_LABEL_BYTES)?;
            validate_optional_text(provider.reasoning_effort.as_deref(), "reasoning effort")?;
        }
        Payload::SessionPermissionChanged { .. }
        | Payload::SessionExecutionSurfaceChanged { .. } => {
            require_scope(event, false, false)?;
        }
        Payload::SessionProjectRootBound { root } => {
            require_scope(event, false, false)?;
            validate_text(root, "project root", false, 4096)?;
        }
        Payload::SessionTerminalReconnected {
            previous_session_id,
            target,
        } => {
            require_scope(event, false, false)?;
            validate_identifier(previous_session_id, "previousSessionId")?;
            validate_session_target(target)?;
        }
        Payload::SessionRenamed {
            title,
            previous_revision,
            client_operation_id,
        } => {
            require_scope(event, false, false)?;
            validate_mutation_event_identity(event, *previous_revision, client_operation_id)?;
            validate_session_title(title)?;
        }
        _ => return Err("unexpected event payload".into()),
    }
    Ok(())
}

pub(super) fn validate_inbox_payload(event: &AgentSessionEvent) -> Result<(), String> {
    use AgentSessionEventPayload as Payload;

    match &event.payload {
        Payload::InboxPaused { item_ids } => {
            require_scope(event, false, false)?;
            validate_collection(item_ids, "paused Inbox items")?;
            for item_id in item_ids {
                validate_identifier(item_id, "itemId")?;
            }
        }
        Payload::InboxItemResumed {
            item_id,
            previous_revision,
            client_operation_id,
        } => {
            require_scope(event, false, false)?;
            validate_mutation_event_identity(event, *previous_revision, client_operation_id)?;
            validate_identifier(item_id, "itemId")?;
        }
        Payload::InboxSpliced { messages, .. } => {
            require_scope(event, false, false)?;
            validate_collection(messages, "Inbox messages")?;
            for message in messages {
                validate_inbox_message(message)?;
            }
        }
        Payload::InboxItemUpdated {
            item_id,
            content,
            content_fingerprint,
            images,
            image_edit_fingerprint,
            previous_revision,
            client_operation_id,
            ..
        } => {
            require_scope(event, false, false)?;
            validate_mutation_event_identity(event, *previous_revision, client_operation_id)?;
            validate_identifier(item_id, "itemId")?;
            validate_text(content, "inbox content", true, MAX_AGENT_MESSAGE_BYTES)?;
            if let Some(fingerprint) = content_fingerprint {
                validate_content_fingerprint(fingerprint)?;
            }
            if let Some(images) = images {
                if images.len() > VISION.max_images {
                    return Err("IMAGE_COUNT_LIMIT".into());
                }
                for image in images {
                    image.validate()?;
                }
            }
            match (images, image_edit_fingerprint) {
                (Some(_), Some(fingerprint)) => validate_content_fingerprint(fingerprint)?,
                (None, None) => (),
                _ => return Err("incomplete Inbox image edit receipt".into()),
            }
        }
        Payload::InboxItemSteered {
            item_id,
            previous_revision,
            client_operation_id,
        }
        | Payload::InboxItemRemoved {
            item_id,
            previous_revision,
            client_operation_id,
            ..
        } => {
            require_scope(event, false, false)?;
            validate_mutation_event_identity(event, *previous_revision, client_operation_id)?;
            validate_identifier(item_id, "itemId")?;
        }
        Payload::InboxReordered {
            ordered_item_ids,
            previous_revision,
            client_operation_id,
            ..
        } => {
            require_scope(event, false, false)?;
            validate_mutation_event_identity(event, *previous_revision, client_operation_id)?;
            validate_collection_allow_empty(ordered_item_ids, "ordered inbox item ids")?;
            let mut unique = HashSet::with_capacity(ordered_item_ids.len());
            for item_id in ordered_item_ids {
                validate_identifier(item_id, "itemId")?;
                if !unique.insert(item_id) {
                    return Err("ordered inbox item ids contain duplicates".into());
                }
            }
        }
        Payload::StepInputClaim {
            turn_messages,
            step_messages,
            ..
        } => {
            require_scope(event, true, true)?;
            for message in turn_messages.iter().chain(step_messages) {
                validate_inbox_message(message)?;
            }
        }
        Payload::UserMessage { message } => {
            require_scope(event, true, true)?;
            validate_inbox_message(message)?;
        }
        _ => return Err("unexpected event payload".into()),
    }
    Ok(())
}

pub(super) fn validate_skill_and_file_ref_payload(event: &AgentSessionEvent) -> Result<(), String> {
    use AgentSessionEventPayload as Payload;

    match &event.payload {
        Payload::FileReferenceScopeBound { scope } => {
            require_scope(event, false, false)?;
            validate_text(&scope.root, "File reference root", false, 4096)?;
            validate_text(
                &scope.root_identity,
                "File reference root identity",
                false,
                256,
            )?;
            unchanged_by_redaction(scope)?;
        }
        Payload::SkillCatalogObserved { observation } => {
            require_scope(event, false, false)?;
            if observation.protocol_version != SKILL_PROTOCOL {
                return Err("unsupported Skill observation version".into());
            }
            if let Some(snapshot) = &observation.snapshot {
                snapshot.validate()?;
            }
        }
        Payload::SkillCatalogPublished { catalog } => {
            require_scope(event, true, true)?;
            validate_text(
                &catalog.content,
                "Skill catalog",
                false,
                MAX_AGENT_MESSAGE_BYTES,
            )?;
            unchanged_by_redaction(catalog)?;
        }
        Payload::SkillStepPrepared { prepared } => {
            require_scope(event, true, true)?;
            prepared.validate()?;
        }
        _ => return Err("unexpected event payload".into()),
    }
    Ok(())
}

pub(super) fn validate_turn_and_assistant_payload(event: &AgentSessionEvent) -> Result<(), String> {
    use AgentSessionEventPayload as Payload;

    match &event.payload {
        Payload::TurnStart => require_scope(event, true, false)?,
        Payload::TurnEnd { reason } => {
            require_scope(event, true, false)?;
            validate_text(reason, "Turn end reason", false, MAX_LABEL_BYTES)?;
        }
        Payload::StepStart => require_scope(event, true, true)?,
        Payload::StepEnd { reason } => {
            require_scope(event, true, true)?;
            validate_text(reason, "Step end reason", false, MAX_LABEL_BYTES)?;
        }
        Payload::StepPreparationAbandoned {
            reason,
            input_message_ids,
        } => {
            require_scope(event, true, true)?;
            validate_text(
                reason,
                "Preparation abandonment reason",
                false,
                MAX_LABEL_BYTES,
            )?;
            validate_collection_allow_empty(input_message_ids, "Preparation input IDs")?;
            for id in input_message_ids {
                validate_identifier(id, "Preparation input ID")?;
            }
        }
        Payload::AssistantChunk {
            request_id,
            text_delta,
            reasoning_delta,
            tool_call_delta,
            usage,
        } => {
            require_scope(event, true, true)?;
            validate_identifier(request_id, "requestId")?;
            validate_optional_stream_delta(text_delta.as_deref(), "assistant text delta")?;
            validate_optional_stream_delta(
                reasoning_delta.as_deref(),
                "assistant reasoning delta",
            )?;
            if let Some(delta) = tool_call_delta {
                validate_optional_text(delta.call_id.as_deref(), "tool call delta id")?;
                validate_optional_text(delta.name_delta.as_deref(), "tool call name delta")?;
                validate_optional_stream_delta(
                    delta.arguments_delta.as_deref(),
                    "tool call arguments delta",
                )?;
            }
            if text_delta.is_none()
                && reasoning_delta.is_none()
                && tool_call_delta.is_none()
                && usage.is_none()
            {
                return Err("assistant chunk must contain a delta or usage update".into());
            }
        }
        Payload::AssistantMessage {
            message_id,
            content,
            interrupted,
            replay,
            ..
        } => {
            require_scope(event, true, true)?;
            validate_identifier(message_id, "messageId")?;
            validate_collection_allow_empty(content, "assistant content blocks")?;
            if content.is_empty() && !interrupted {
                return Err("completed assistant message requires a content block".into());
            }
            for block in content {
                match block {
                    AgentAssistantContentBlock::Text { text } => {
                        validate_text(text, "assistant text block", false, MAX_AGENT_MESSAGE_BYTES)?
                    }
                    AgentAssistantContentBlock::Reasoning {
                        text,
                        provider_item,
                    } => {
                        validate_text(
                            text,
                            "assistant reasoning block",
                            false,
                            MAX_AGENT_MESSAGE_BYTES,
                        )?;
                        if replay.is_some() && provider_item.is_some() {
                            return Err(
                                "prepared replay stores native reasoning only in its envelope"
                                    .into(),
                            );
                        }
                    }
                    AgentAssistantContentBlock::ToolCall { call } => validate_tool_call(call)?,
                }
            }
        }
        _ => return Err("unexpected event payload".into()),
    }
    Ok(())
}

pub(super) fn validate_request_payload(event: &AgentSessionEvent) -> Result<(), String> {
    use AgentSessionEventPayload as Payload;

    match &event.payload {
        Payload::RequestHeader {
            request_id,
            snapshot,
            snapshot_digest,
            provider_id,
            model,
            reasoning_effort,
            series,
            system_prompt,
            tool_schemas,
            attempt,
            ..
        } => {
            require_scope(event, true, true)?;
            if snapshot.digest() != *snapshot_digest {
                return Err("request snapshot digest mismatch".into());
            }
            validate_identifier(request_id, "requestId")?;
            validate_text(provider_id, "providerId", false, MAX_LABEL_BYTES)?;
            validate_text(model, "model", false, MAX_LABEL_BYTES)?;
            validate_optional_text(reasoning_effort.as_deref(), "reasoning effort")?;
            validate_identifier(&series.series_id, "seriesId")?;
            validate_text(
                system_prompt,
                "system prompt",
                true,
                MAX_AGENT_MESSAGE_BYTES,
            )?;
            validate_collection_allow_empty(tool_schemas, "request tool schemas")?;
            for schema in tool_schemas {
                validate_text(&schema.name, "tool schema name", false, MAX_LABEL_BYTES)?;
                validate_text(
                    &schema.description,
                    "tool schema description",
                    true,
                    MAX_AGENT_MESSAGE_BYTES,
                )?;
            }
            if *attempt == 0 {
                return Err("request attempt must be positive".into());
            }
            if series.starts_series != (series.request_index == 0) {
                return Err("request series boundary does not match its index".into());
            }
        }
        Payload::RequestStart {
            request_id,
            header_request_id,
            provider_id,
            model,
            reasoning_effort,
            series,
            attempt,
            ..
        } => {
            require_scope(event, true, true)?;
            validate_identifier(request_id, "requestId")?;
            validate_identifier(header_request_id, "headerRequestId")?;
            validate_text(provider_id, "providerId", false, MAX_LABEL_BYTES)?;
            validate_text(model, "model", false, MAX_LABEL_BYTES)?;
            validate_optional_text(reasoning_effort.as_deref(), "reasoning effort")?;
            validate_identifier(&series.series_id, "seriesId")?;
            if *attempt == 0 {
                return Err("request attempt must be positive".into());
            }
            if series.starts_series != (series.request_index == 0) {
                return Err("request series boundary does not match its index".into());
            }
        }
        Payload::RequestContext {
            request_id,
            request_budget,
            input_tokens,
            ..
        } => {
            require_scope(event, true, true)?;
            validate_identifier(request_id, "requestId")?;
            if let Some(measurement) = request_budget
                .as_ref()
                .and_then(|budget| budget.input_measurement.as_ref())
            {
                let total = measurement
                    .heuristic_tokens
                    .checked_add(measurement.usage_adjustment_tokens);
                if measurement.identity.len() != 64
                    || !measurement
                        .identity
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit())
                    || total.is_none_or(|tokens| tokens > 9_007_199_254_740_991)
                    || *input_tokens != total
                    || (measurement.usage_adjustment_tokens > 0
                        && measurement.anchor_request_id.is_none())
                {
                    return Err("request input measurement is invalid".into());
                }
                if let Some(anchor) = &measurement.anchor_request_id {
                    validate_identifier(anchor, "anchorRequestId")?;
                }
            }
        }
        Payload::RequestRetry {
            request_id,
            previous_request_id,
            attempt,
            reason,
            error_kind,
            error_code,
            ..
        } => {
            require_scope(event, true, true)?;
            validate_identifier(request_id, "requestId")?;
            if let Some(previous) = previous_request_id {
                validate_identifier(previous, "previousRequestId")?;
            }
            if *attempt == 0 {
                return Err("request retry attempt must be positive".into());
            }
            validate_text(reason, "request retry reason", false, MAX_LABEL_BYTES)?;
            validate_optional_text(error_kind.as_deref(), "request retry error kind")?;
            validate_optional_text(error_code.as_deref(), "request retry error code")?;
        }
        Payload::RequestUsage { request_id, .. } => {
            require_scope(event, true, true)?;
            validate_identifier(request_id, "requestId")?;
        }
        Payload::RequestFailure {
            request_id,
            attempt,
            max_attempts,
            failure,
            ..
        } => {
            require_scope(event, true, true)?;
            validate_identifier(request_id, "requestId")?;
            if *attempt == 0 || *max_attempts == 0 || *attempt > *max_attempts {
                return Err("request failure attempts must be positive and bounded".into());
            }
            validate_text(
                &failure.message,
                "request failure message",
                false,
                MAX_AGENT_MESSAGE_BYTES,
            )?;
            validate_optional_text(failure.code.as_deref(), "request failure code")?;
        }
        _ => return Err("unexpected event payload".into()),
    }
    Ok(())
}

pub(super) fn validate_tool_payload(event: &AgentSessionEvent) -> Result<(), String> {
    use AgentSessionEventPayload as Payload;

    match &event.payload {
        Payload::ToolCall { call } => {
            require_scope(event, true, true)?;
            validate_tool_call(call)?;
        }
        Payload::ToolApproval {
            request_id,
            call_id,
            approval_id,
            reason,
            prompt,
            ..
        } => {
            require_scope(event, true, true)?;
            validate_identifier(request_id, "requestId")?;
            validate_identifier(call_id, "callId")?;
            if let Some(approval) = approval_id {
                validate_identifier(approval, "approvalId")?;
            }
            validate_optional_text(reason.as_deref(), "approval reason")?;
            validate_optional_text(prompt.as_deref(), "approval prompt")?;
        }
        Payload::ToolExecution {
            call_id,
            idempotency,
            ..
        } => {
            require_scope(event, true, true)?;
            validate_identifier(call_id, "callId")?;
            if !matches!(idempotency.as_str(), "yes" | "no" | "conditional") {
                return Err("tool execution idempotency is invalid".into());
            }
        }
        Payload::ToolResult {
            call_id,
            name,
            summary,
            evidence_refs,
            status,
            data,
            ..
        } => {
            require_scope(event, true, true)?;
            validate_identifier(call_id, "callId")?;
            validate_text(name, "tool name", false, MAX_LABEL_BYTES)?;
            validate_text(
                summary,
                "tool result summary",
                false,
                MAX_AGENT_MESSAGE_BYTES,
            )?;
            validate_collection_allow_empty(evidence_refs, "evidence refs")?;
            for evidence in evidence_refs {
                validate_identifier(evidence, "evidenceId")?;
            }
            if name == SKILL_TOOL && *status == AgentToolResultStatus::Completed {
                let loaded: LoadedSkill = serde_json::from_value(
                    data.clone().ok_or("complete Skill result has no body")?,
                )
                .map_err(|e| format!("invalid Skill result protocol: {e}"))?;
                loaded.validate()?;
                if loaded.provenance.call_id.as_deref() != Some(call_id)
                    || loaded.provenance.invocation != SkillInvocationKind::Model
                {
                    return Err("Skill result invocation identity mismatch".into());
                }
                unchanged_by_redaction(&loaded)?;
            }
        }
        _ => return Err("unexpected event payload".into()),
    }
    Ok(())
}

pub(super) fn validate_context_and_compaction_payload(
    event: &AgentSessionEvent,
) -> Result<(), String> {
    use AgentSessionEventPayload as Payload;

    match &event.payload {
        Payload::ContextArtifact {
            artifact_id,
            kind,
            title,
            media_type,
            sha256,
            ..
        } => {
            require_scope(event, true, true)?;
            validate_identifier(artifact_id, "artifactId")?;
            validate_text(kind, "artifact kind", false, MAX_LABEL_BYTES)?;
            validate_text(title, "artifact title", false, MAX_LABEL_BYTES)?;
            validate_optional_text(media_type.as_deref(), "artifact media type")?;
            if sha256.as_deref().is_some_and(|value| {
                value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit())
            }) {
                return Err("artifact sha256 is invalid".into());
            }
        }
        Payload::CompactionStart {
            reason,
            compaction_id,
        } => {
            require_scope(event, true, true)?;
            validate_text(reason, "compaction reason", false, MAX_LABEL_BYTES)?;
            if let Some(id) = compaction_id {
                validate_identifier(id, "compaction ID")?;
            }
        }
        Payload::CompactionSummary { summary, .. } => {
            require_scope(event, true, true)?;
            validate_text(
                summary,
                "compaction summary",
                false,
                MAX_AGENT_MESSAGE_BYTES,
            )?;
        }
        Payload::CompactionEnd {
            compaction_id,
            reason,
            ..
        } => {
            require_scope(event, true, true)?;
            if let Some(id) = compaction_id {
                validate_identifier(id, "compaction ID")?;
            }
            if let Some(reason) = reason {
                validate_text(reason, "compaction result reason", false, MAX_LABEL_BYTES)?;
            }
        }
        _ => return Err("unexpected event payload".into()),
    }
    Ok(())
}

pub(super) fn validate_subagent_payload(event: &AgentSessionEvent) -> Result<(), String> {
    use AgentSessionEventPayload as Payload;

    match &event.payload {
        Payload::SubagentDescriptor {
            descriptor_id,
            child_session_id,
            parent_session_id,
            parent_task_id,
            inheritance,
            capability_scope,
            target_scope,
            budget,
            ..
        } => {
            require_scope(event, false, false)?;
            validate_identifier(descriptor_id, "descriptorId")?;
            validate_identifier(child_session_id, "childSessionId")?;
            validate_identifier(parent_session_id, "parentSessionId")?;
            validate_identifier(parent_task_id, "parentTaskId")?;
            validate_subagent_inheritance(inheritance)?;
            validate_capability_scope(capability_scope)?;
            validate_collection(target_scope, "subagent target scope")?;
            for target in target_scope {
                validate_session_target(target)?;
            }
            validate_subagent_budget(budget)?;
        }
        Payload::SubagentMessage {
            descriptor_id,
            child_session_id,
            direction,
            route,
            summary,
        } => {
            require_scope(event, false, false)?;
            validate_identifier(descriptor_id, "descriptorId")?;
            validate_identifier(child_session_id, "childSessionId")?;
            if !matches!(direction.as_str(), "inbound" | "outbound") {
                return Err("subagent message direction is invalid".into());
            }
            if !matches!(
                route.as_str(),
                "steer" | "followup" | "inject" | "toolResult"
            ) {
                return Err("subagent message route is invalid".into());
            }
            validate_text(summary, "subagent message", false, MAX_AGENT_MESSAGE_BYTES)?;
        }
        Payload::SubagentSettled {
            descriptor_id,
            settlement_id,
            child_session_id,
            summary,
            evidence_refs,
            ..
        } => {
            require_scope(event, false, false)?;
            validate_identifier(descriptor_id, "descriptorId")?;
            validate_identifier(settlement_id, "settlementId")?;
            validate_identifier(child_session_id, "childSessionId")?;
            validate_text(summary, "subagent summary", false, MAX_AGENT_MESSAGE_BYTES)?;
            validate_collection_allow_empty(evidence_refs, "subagent evidence refs")?;
            for evidence in evidence_refs {
                validate_identifier(evidence, "evidenceId")?;
            }
        }
        Payload::SubagentDetached {
            descriptor_id,
            child_session_id,
            reason,
        } => {
            require_scope(event, false, false)?;
            validate_identifier(descriptor_id, "descriptorId")?;
            validate_identifier(child_session_id, "childSessionId")?;
            validate_text(reason, "subagent detach reason", false, MAX_LABEL_BYTES)?;
        }
        _ => return Err("unexpected event payload".into()),
    }
    Ok(())
}

pub(super) fn validate_task_payload(event: &AgentSessionEvent) -> Result<(), String> {
    use AgentSessionEventPayload as Payload;

    match &event.payload {
        Payload::TaskLinked { task_id, goal } => {
            validate_identifier(task_id, "taskId")?;
            if let Some(goal) = goal {
                validate_text(goal, "task goal", false, MAX_AGENT_MESSAGE_BYTES)?;
            }
        }
        Payload::TaskPlan { version, steps } => validate_task_plan(*version, steps)?,
        Payload::TaskState {
            status,
            phase,
            progress,
            recovery,
            fleet,
        } => {
            validate_text(status, "task status", false, MAX_LABEL_BYTES)?;
            validate_optional_text(phase.as_deref(), "task phase")?;
            if progress.is_some_and(|value| !value.is_finite() || !(0.0..=1.0).contains(&value)) {
                return Err("task progress must be finite and between zero and one".into());
            }
            if let Some(recovery) = recovery {
                validate_optional_text(recovery.summary.as_deref(), "recovery summary")?;
            }
            if fleet.as_ref().is_some_and(|value| {
                value.wave > value.total_waves || value.targets_completed > value.targets_total
            }) {
                return Err("task Fleet counters are invalid".into());
            }
            if let Some(fleet) = fleet {
                if let Some(budget) = &fleet.budget {
                    validate_subagent_budget(budget)?;
                }
                validate_optional_text(fleet.fleet_id.as_deref(), "Fleet id")?;
                validate_optional_text(fleet.status.as_deref(), "Fleet status")?;
                validate_collection_allow_empty(&fleet.targets, "Fleet targets")?;
                for target in &fleet.targets {
                    validate_identifier(&target.target_id, "Fleet targetId")?;
                    validate_identifier(&target.task_id, "Fleet taskId")?;
                    validate_text(
                        &target.goal,
                        "Fleet target goal",
                        false,
                        MAX_AGENT_MESSAGE_BYTES,
                    )?;
                    validate_text(&target.state, "Fleet target state", false, MAX_LABEL_BYTES)?;
                    validate_collection_allow_empty(
                        &target.child_session_ids,
                        "Fleet child Sessions",
                    )?;
                    validate_collection_allow_empty(&target.evidence_refs, "Fleet evidence")?;
                    validate_optional_text(target.recovery.as_deref(), "Fleet recovery")?;
                }
            }
        }
        Payload::TaskEvidence {
            evidence_id,
            kind,
            summary,
        } => {
            validate_identifier(evidence_id, "evidenceId")?;
            validate_text(kind, "evidence kind", false, MAX_LABEL_BYTES)?;
            validate_text(summary, "evidence summary", false, MAX_AGENT_MESSAGE_BYTES)?;
        }
        _ => return Err("unexpected event payload".into()),
    }
    Ok(())
}

fn require_scope(
    event: &AgentSessionEvent,
    require_turn: bool,
    require_step: bool,
) -> Result<(), String> {
    if require_turn != event.turn_id.is_some() || require_step != event.step_id.is_some() {
        return Err("Agent session event has an invalid Turn/Step scope".into());
    }
    Ok(())
}

fn validate_mutation_event_identity(
    event: &AgentSessionEvent,
    previous_revision: u64,
    client_operation_id: &str,
) -> Result<(), String> {
    if event.version != AGENT_SESSION_EVENT_VERSION {
        return Err(format!(
            "Agent Runtime mutation events require the v{AGENT_SESSION_EVENT_VERSION} event contract"
        ));
    }
    if previous_revision != event.seq {
        return Err("Agent Runtime mutation previous revision does not match its sequence".into());
    }
    validate_identifier(client_operation_id, "clientOperationId")
}

pub(super) fn validate_session_title(title: &str) -> Result<(), String> {
    validate_text(title, "Session title", false, MAX_SESSION_TITLE_BYTES)?;
    if title.trim() != title {
        return Err("Agent Session title must not contain leading or trailing whitespace".into());
    }
    if title.chars().count() > MAX_SESSION_TITLE_CHARS {
        return Err(format!(
            "Agent Session title exceeds {MAX_SESSION_TITLE_CHARS} Unicode characters"
        ));
    }
    if title.chars().any(char::is_control) {
        return Err("Agent Session title must be a single line without control characters".into());
    }
    Ok(())
}

fn validate_content_fingerprint(fingerprint: &str) -> Result<(), String> {
    if fingerprint.len() != 64 || !fingerprint.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("invalid Inbox content fingerprint".into());
    }
    Ok(())
}

pub(super) fn validate_inbox_message(message: &AgentInboxMessage) -> Result<(), String> {
    if let Some(fingerprint) = message.source.metadata.get(SUBMISSION_CONTENT_FINGERPRINT) {
        validate_content_fingerprint(
            fingerprint
                .as_str()
                .ok_or("invalid Inbox content fingerprint")?,
        )?;
    }
    if message.images.len() > VISION.max_images {
        return Err("IMAGE_COUNT_LIMIT".into());
    }
    for image in &message.images {
        image.validate()?;
    }
    if !message.images.is_empty() && message.source.kind != AgentMessageSourceKind::User {
        return Err("IMAGE_SOURCE_NOT_USER".into());
    }
    if let Some(context) = &message.terminal_context {
        if message.source.kind != AgentMessageSourceKind::User
            || context.version == 0
            || context.version > MAX_JS_SAFE_INTEGER
            || context.max_lines == 0
            || context.max_lines > 10_000
            || context.max_bytes == 0
            || context.max_bytes as usize > MAX_TERMINAL_CONTEXT_BYTES
            || context.content.len() > context.max_bytes as usize
        {
            return Err("TERMINAL_CONTEXT_SOURCE_INVALID".into());
        }
        validate_identifier(&context.session_id, "terminalContext.sessionId")?;
        validate_text(
            &context.content,
            "terminal context content",
            false,
            MAX_TERMINAL_CONTEXT_BYTES,
        )?;
    }
    validate_identifier(&message.message_id, "messageId")?;
    if let Some(client_submission_id) = message.client_submission_id.as_deref() {
        validate_identifier(client_submission_id, "clientSubmissionId")?;
    }
    validate_text(
        &message.content,
        "message content",
        !message.images.is_empty(),
        MAX_AGENT_MESSAGE_BYTES,
    )?;
    validate_text(
        &message.source.label,
        "message source label",
        false,
        MAX_LABEL_BYTES,
    )?;
    validate_text(
        &message.source.producer_id,
        "message source producer id",
        false,
        MAX_LABEL_BYTES,
    )?;
    Ok(())
}

fn validate_tool_call(call: &RecordedToolCall) -> Result<(), String> {
    validate_identifier(&call.call_id, "callId")?;
    if let Some(provider_call_id) = call.provider_call_id.as_deref() {
        validate_text(provider_call_id, "provider call id", false, MAX_LABEL_BYTES)?;
    }
    validate_text(&call.name, "tool name", false, MAX_LABEL_BYTES)?;
    validate_optional_text(call.native_name.as_deref(), "native tool name")?;
    validate_optional_text(call.title.as_deref(), "tool title")?;
    if let Some(target) = &call.target {
        validate_session_target(target)?;
    }
    Ok(())
}

pub(super) fn validate_session_target(target: &AgentSessionTarget) -> Result<(), String> {
    if !matches!(target.kind.as_str(), "local" | "remote") {
        return Err("tool target kind is invalid".into());
    }
    validate_identifier(&target.target_id, "targetId")?;
    validate_identifier(&target.session_id, "target sessionId")?;
    validate_optional_text(target.label.as_deref(), "target label")?;
    if let Some(profile_id) = target.profile_id.as_deref() {
        validate_identifier(profile_id, "profileId")?;
    }
    validate_optional_text(target.host.as_deref(), "target host")?;
    validate_optional_text(target.username.as_deref(), "target username")?;
    validate_optional_text(target.cwd.as_deref(), "target cwd")?;
    validate_optional_text(target.root_path.as_deref(), "target root path")?;
    validate_optional_text(target.local_root.as_deref(), "target local root")?;
    if target.remote_sandbox_required.is_some() && target.kind != "remote" {
        return Err("Agent sandbox requirement is only valid for a remote target".into());
    }
    if target.requires_local_sandbox()
        && (target.kind != "local" || target.cwd.is_none() || target.cwd != target.local_root)
    {
        return Err("Local sandbox target requires a managed local workspace".into());
    }
    if target.remote_sandbox_required == Some(true) && target.profile_id.is_none() {
        return Err("Agent sandbox requirement needs a saved SSH profile".into());
    }
    match target.kind.as_str() {
        "local" if target.host.is_some() || target.port.is_some() || target.username.is_some() => {
            Err("local tool target contains remote identity fields".into())
        }
        "remote"
            if target.host.as_deref().is_none_or(str::is_empty)
                || target.port.is_none()
                || target.username.as_deref().is_none_or(str::is_empty) =>
        {
            Err("remote tool target is missing its frozen identity".into())
        }
        _ => Ok(()),
    }
}

pub(super) fn validate_capability_scope(scope: &AgentCapabilityScope) -> Result<(), String> {
    validate_collection(&scope.tool_names, "capability tools")?;
    validate_collection(&scope.effects, "capability effects")?;
    validate_collection(&scope.target_ids, "capability targets")?;
    let mut tools = HashSet::new();
    let mut targets = HashSet::new();
    for tool in &scope.tool_names {
        validate_text(tool, "capability tool", false, MAX_LABEL_BYTES)?;
        if !tools.insert(tool) {
            return Err("capability scope contains duplicate tools".into());
        }
    }
    for target_id in &scope.target_ids {
        validate_identifier(target_id, "capability targetId")?;
        if !targets.insert(target_id) {
            return Err("capability scope contains duplicate targets".into());
        }
    }
    let mut effects = HashSet::new();
    if scope.effects.iter().any(|effect| !effects.insert(*effect)) {
        return Err("capability scope contains duplicate effects".into());
    }
    Ok(())
}

fn validate_subagent_inheritance(inheritance: &AgentSubagentInheritance) -> Result<(), String> {
    if let AgentSubagentInheritance::SafePrefix {
        parent_through_seq: Some(sequence),
    } = inheritance
    {
        if *sequence > MAX_JS_SAFE_INTEGER {
            return Err("subagent inheritance boundary exceeds the wire limit".into());
        }
    }
    Ok(())
}

pub(in crate::agent_runtime) fn validate_subagent_budget(
    budget: &AgentSubagentBudget,
) -> Result<(), String> {
    if budget
        .max_steps_per_turn
        .is_some_and(|limit| !(1..=64).contains(&limit))
        || budget.max_turns == 0
        || budget.max_turns > 256
        || budget
            .max_tool_calls
            .is_some_and(|limit| !(1..=4_096).contains(&limit))
        || budget
            .max_tokens
            .is_some_and(|limit| !(1_024..=16_000_000).contains(&limit))
        || budget.timeout_ms < 1_000
        || budget.timeout_ms > 24 * 60 * 60 * 1_000
    {
        return Err("subagent execution budget is outside native bounds".into());
    }
    Ok(())
}

pub(super) fn validate_subagent_session(
    subagent: &AgentSubagentSession,
    parent_session_id: Option<&str>,
) -> Result<(), String> {
    validate_identifier(&subagent.descriptor_id, "descriptorId")?;
    validate_identifier(&subagent.parent_task_id, "parentTaskId")?;
    if parent_session_id.is_none() {
        return Err("subagent Session requires parentSessionId".into());
    }
    if subagent.depth == 0 || subagent.depth > 16 {
        return Err("subagent depth is outside native bounds".into());
    }
    validate_subagent_inheritance(&subagent.inheritance)?;
    validate_capability_scope(&subagent.capability_scope)?;
    validate_collection(&subagent.target_scope, "subagent target scope")?;
    for target in &subagent.target_scope {
        validate_session_target(target)?;
        if !subagent
            .capability_scope
            .target_ids
            .contains(&target.target_id)
        {
            return Err("subagent target scope exceeds its capability targets".into());
        }
    }
    validate_subagent_budget(&subagent.budget)?;
    let Some(provider) = subagent.provider.as_ref() else {
        #[cfg(all(
            feature = "native-input-acceptance",
            debug_assertions,
            target_os = "macos",
            target_arch = "aarch64"
        ))]
        if std::env::var("SHELLSPAN_ACCEPTANCE_SUBMISSION_SCENARIO").as_deref() == Ok("delegation")
            && parent_session_id.is_some_and(|id| id.starts_with("phase3-submission-"))
        {
            let home = crate::commands::terminal_acceptance_directory()?.join("home");
            let ssh = crate::terminal_command::acceptance_trace::ssh_recovery_enabled();
            let port = std::env::var("SHELLSPAN_ACCEPTANCE_SSH_PORT")
                .ok()
                .and_then(|value| value.parse::<u16>().ok())
                .filter(|value| *value > 1024);
            let user = if std::env::var("SHELLSPAN_ACCEPTANCE_SSH_SHELL").as_deref() == Ok("bash") {
                "native53"
            } else {
                "nativeZle"
            };
            if subagent.target_scope.iter().all(|target| {
                if ssh {
                    target.kind == "remote"
                        && target.host.as_deref() == Some("127.0.0.1")
                        && port.is_some()
                        && target.port == port
                        && target.username.as_deref() == Some(user)
                } else {
                    target.kind == "local"
                        && target.cwd.as_deref() == home.to_str()
                        && target.local_root.as_deref() == home.to_str()
                }
            }) {
                return Ok(());
            }
        }
        return Err("subagent Session requires a frozen model".into());
    };
    validate_text(
        &provider.route_id,
        "subagent routeId",
        false,
        MAX_LABEL_BYTES,
    )?;
    validate_text(&provider.model_id, "subagent model", false, MAX_LABEL_BYTES)?;
    validate_optional_text(
        provider.reasoning_effort.as_deref(),
        "subagent reasoning effort",
    )
}

pub(in crate::agent_runtime) fn validate_identifier(
    value: &str,
    label: &str,
) -> Result<(), String> {
    if value.is_empty()
        || value.len() > MAX_IDENTIFIER_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(format!(
            "{label} must be 1-{MAX_IDENTIFIER_BYTES} ASCII letters, digits, '-' or '_'"
        ));
    }
    Ok(())
}

/// Validate the complete task-plan payload before it reaches durable event storage.
/// Model-facing session tools use the same validator so bad model arguments can
/// settle as an ordinary failed tool result instead of becoming a scheduler fault.
pub(in crate::agent_runtime) fn validate_task_plan(
    version: u64,
    steps: &[AgentPlanStep],
) -> Result<(), String> {
    if version == 0 {
        return Err("task plan version must be positive".into());
    }
    validate_collection_allow_empty(steps, "plan steps")?;
    let mut ids = HashSet::new();
    for step in steps {
        validate_identifier(&step.id, "plan step id")?;
        if !ids.insert(step.id.as_str()) {
            return Err("task plan contains duplicate step ids".into());
        }
        validate_text(&step.title, "plan step title", false, MAX_LABEL_BYTES)?;
        validate_optional_text(step.detail.as_deref(), "plan step detail")?;
        for evidence in &step.evidence_refs {
            validate_identifier(evidence, "evidenceId")?;
        }
    }
    Ok(())
}

pub(super) fn validate_text(
    value: &str,
    label: &str,
    allow_empty: bool,
    max_bytes: usize,
) -> Result<(), String> {
    if (!allow_empty && value.trim().is_empty()) || value.len() > max_bytes {
        return Err(format!("{label} is invalid or exceeds {max_bytes} bytes"));
    }
    Ok(())
}

fn validate_optional_text(value: Option<&str>, label: &str) -> Result<(), String> {
    if let Some(value) = value {
        validate_text(value, label, false, MAX_LABEL_BYTES)?;
    }
    Ok(())
}

pub(super) fn validate_optional_stream_delta(
    value: Option<&str>,
    label: &str,
) -> Result<(), String> {
    if let Some(value) = value {
        // Stream boundaries are provider-controlled. A valid JSON argument stream may
        // contain an empty, whitespace-only, or newline-only delta, so only enforce the
        // durable event byte bound here. Semantic validation happens after reassembly.
        if value.len() > MAX_AGENT_STREAM_DELTA_BYTES {
            return Err(format!(
                "{label} exceeds {MAX_AGENT_STREAM_DELTA_BYTES} bytes"
            ));
        }
    }
    Ok(())
}

fn validate_collection<T>(values: &[T], label: &str) -> Result<(), String> {
    if values.is_empty() || values.len() > MAX_COLLECTION_ITEMS {
        return Err(format!(
            "{label} must contain 1-{MAX_COLLECTION_ITEMS} items"
        ));
    }
    Ok(())
}

pub(super) fn validate_collection_allow_empty<T>(values: &[T], label: &str) -> Result<(), String> {
    if values.len() > MAX_COLLECTION_ITEMS {
        return Err(format!("{label} exceeds {MAX_COLLECTION_ITEMS} items"));
    }
    Ok(())
}

pub(super) fn validate_page_limit(limit: usize, maximum: usize, label: &str) -> Result<(), String> {
    if limit == 0 || limit > maximum {
        return Err(format!("Agent {label} page limit must be 1-{maximum}"));
    }
    Ok(())
}
