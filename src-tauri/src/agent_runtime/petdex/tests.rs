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
