//! Direct tests of the production event selector. Typed event inputs are not
//! provider responses: no replay envelopes, substitute model or store bypass.
use super::*;
use crate::agent_runtime::{AgentAssistantContentBlock as Block, AgentStopReason};

fn event(seq: u64, turn: &str, payload: Payload) -> AgentSessionEvent {
    AgentSessionEvent::new(
        "session".into(),
        seq,
        1_000 + seq,
        Some(turn.into()),
        Some("step".into()),
        payload,
    )
}

fn reply(
    seq: u64,
    turn: &str,
    interrupted: bool,
    stop_reason: AgentStopReason,
) -> AgentSessionEvent {
    event(
        seq,
        turn,
        Payload::AssistantMessage {
            message_id: format!("reply-{seq}"),
            content: vec![
                Block::Reasoning {
                    text: "Excluded reasoning".into(),
                    provider_item: None,
                },
                Block::Text {
                    text: "Visible final reply".into(),
                },
            ],
            usage: Default::default(),
            stop_reason,
            interrupted,
            replay: None,
        },
    )
}

#[test]
fn petdex_selects_only_the_current_completed_final_assistant_text() {
    let mut events = vec![
        event(0, "first", Payload::TurnStart),
        reply(1, "first", false, AgentStopReason::Stop),
    ];
    assert!(completed_reply(&events, "first").is_none());
    events.push(event(
        2,
        "first",
        Payload::TurnEnd {
            reason: "completed".into(),
        },
    ));
    assert_eq!(
        completed_reply(&events, "first").unwrap(),
        "Visible final reply\n"
    );
    assert!(completed_reply(&events, "other").is_none());
    events.push(event(3, "second", Payload::TurnStart));
    assert!(completed_reply(&events, "first").is_none());
    assert!(completed_reply(&events, "second").is_none());
    events.push(event(
        4,
        "second",
        Payload::TurnEnd {
            reason: "completed".into(),
        },
    ));
    assert!(completed_reply(&events, "second").is_none());
}

#[test]
fn petdex_rejects_interrupted_truncated_cancelled_and_intermediate_replies() {
    for (interrupted, stop) in [
        (true, AgentStopReason::Stop),
        (false, AgentStopReason::Length),
        (false, AgentStopReason::ToolCalls),
        (false, AgentStopReason::Cancelled),
        (false, AgentStopReason::Error),
    ] {
        let events = vec![
            event(0, "turn", Payload::TurnStart),
            reply(1, "turn", interrupted, stop),
            event(
                2,
                "turn",
                Payload::TurnEnd {
                    reason: "completed".into(),
                },
            ),
        ];
        assert!(completed_reply(&events, "turn").is_none());
    }
    for reason in ["cancelled", "failed"] {
        let events = vec![
            event(0, "turn", Payload::TurnStart),
            reply(1, "turn", false, AgentStopReason::Stop),
            event(
                2,
                "turn",
                Payload::TurnEnd {
                    reason: reason.into(),
                },
            ),
        ];
        assert!(completed_reply(&events, "turn").is_none());
    }
    let events = vec![
        event(0, "turn", Payload::TurnStart),
        reply(1, "turn", false, AgentStopReason::Stop),
        event(2, "turn", Payload::StepStart),
        event(
            3,
            "turn",
            Payload::TurnEnd {
                reason: "completed".into(),
            },
        ),
    ];
    assert!(completed_reply(&events, "turn").is_none());
    let streaming = vec![
        event(0, "turn", Payload::TurnStart),
        event(
            1,
            "turn",
            Payload::AssistantChunk {
                request_id: "request".into(),
                text_delta: Some("never a final reply".into()),
                reasoning_delta: None,
                tool_call_delta: None,
                usage: None,
            },
        ),
        event(
            2,
            "turn",
            Payload::TurnEnd {
                reason: "completed".into(),
            },
        ),
    ];
    assert!(completed_reply(&streaming, "turn").is_none());
}

#[test]
fn petdex_current_tool_kind_prefers_native_name_and_maps_model_terminal_tools() {
    use crate::agent_runtime::{AgentToolExecutionStatus, AgentToolResultStatus, RecordedToolCall};
    use crate::petdex::message_content::ToolStage;

    let tool_call = |seq: u64, turn: &str, call_id: &str, name: &str, native_name: Option<&str>| {
        event(
            seq,
            turn,
            Payload::ToolCall {
                call: RecordedToolCall {
                    call_id: call_id.into(),
                    provider_call_id: None,
                    name: name.into(),
                    native_name: native_name.map(str::to_owned),
                    arguments: serde_json::json!({}),
                    title: None,
                    effect: None,
                    target: None,
                },
            },
        )
    };
    let tool_exec = |seq: u64, turn: &str, call_id: &str| {
        event(
            seq,
            turn,
            Payload::ToolExecution {
                call_id: call_id.into(),
                status: AgentToolExecutionStatus::Dispatched,
                idempotency: "yes".into(),
            },
        )
    };
    let tool_result = |seq: u64, turn: &str, call_id: &str, name: &str| {
        event(
            seq,
            turn,
            Payload::ToolResult {
                call_id: call_id.into(),
                name: name.into(),
                status: AgentToolResultStatus::Completed,
                summary: "ok".into(),
                data: None,
                duration_ms: None,
                evidence_refs: Vec::new(),
            },
        )
    };

    let events = vec![
        event(0, "prev", Payload::TurnStart),
        tool_call(1, "prev", "c0", "read_file", None),
        tool_exec(2, "prev", "c0"),
        event(
            3,
            "prev",
            Payload::TurnEnd {
                reason: "completed".into(),
            },
        ),
        event(4, "turn", Payload::TurnStart),
        tool_call(5, "turn", "c1", "run_terminal_command", None),
        tool_exec(6, "turn", "c1"),
    ];
    assert_eq!(
        current_tool_kind(&events, "turn"),
        ActivityKind::Tool(ToolStage::Command)
    );

    let mut events_with_native = events.clone();
    events_with_native.push(tool_result(7, "turn", "c1", "run_terminal_command"));
    events_with_native.push(tool_call(
        8,
        "turn",
        "c2",
        "write_process_input",
        Some("write_stdin"),
    ));
    events_with_native.push(tool_exec(9, "turn", "c2"));
    assert_eq!(
        current_tool_kind(&events_with_native, "turn"),
        ActivityKind::Tool(ToolStage::WriteTerminal)
    );

    events_with_native.push(tool_result(10, "turn", "c2", "write_process_input"));
    assert_eq!(
        current_tool_kind(&events_with_native, "turn"),
        ActivityKind::Ai
    );
}
