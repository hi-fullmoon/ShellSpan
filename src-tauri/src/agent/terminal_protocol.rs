//! Strict model-facing protocol for P3 terminal interaction.
//!
//! This is deliberately separate from Agent decision v1/v2. A model can name
//! only semantic terminal actions; run/session identity, lease authority, and
//! rendered PTY bytes are backend-owned and are absent from this contract.

use serde::de::{self, Deserializer};
use serde::{Deserialize, Serialize, Serializer};
use std::fmt;

pub(crate) const TERMINAL_PROTOCOL_SCHEMA_VERSION_V1: u8 = 1;
pub(crate) const MAX_TERMINAL_ACTION_BYTES_V1: usize = 16 * 1024;
pub(crate) const TERMINAL_ACTION_SCHEMA_V1: &str =
    include_str!("../../../protocol/agent-terminal/v1/terminal-actions.schema.json");

const MAX_IDENTIFIER_CHARACTERS: usize = 64;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct TerminalSchemaVersionV1;

impl Serialize for TerminalSchemaVersionV1 {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_u8(TERMINAL_PROTOCOL_SCHEMA_VERSION_V1)
    }
}

impl<'de> Deserialize<'de> for TerminalSchemaVersionV1 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let version = u8::deserialize(deserializer)?;
        if version == TERMINAL_PROTOCOL_SCHEMA_VERSION_V1 {
            Ok(Self)
        } else {
            Err(de::Error::custom("terminal action schemaVersion must be 1"))
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Hash)]
pub(crate) enum TerminalDriverIdV1 {
    #[serde(rename = "fixture.shellPrompt")]
    FixtureShellPrompt,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Hash)]
pub(crate) enum TerminalProgramIdV1 {
    #[serde(rename = "termbridge-interactive-fixture")]
    TermbridgeInteractiveFixture,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TerminalFixtureScenarioV1 {
    Confirm,
    Choice,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TerminalResponseV1 {
    Accept,
    Decline,
    Retry,
    Cancel,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TerminalKeyV1 {
    Enter,
    Escape,
    Tab,
    CtrlC,
    CtrlD,
    ArrowUp,
    ArrowDown,
    ArrowLeft,
    ArrowRight,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TerminalHandoffReasonV1 {
    UserRequested,
    SensitivePrompt,
    UnsupportedInteraction,
    UnknownPrompt,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
enum TerminalStartActionNameV1 {
    #[serde(rename = "terminal.start")]
    TerminalStart,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
enum TerminalRespondActionNameV1 {
    #[serde(rename = "terminal.respond")]
    TerminalRespond,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
enum TerminalKeyActionNameV1 {
    #[serde(rename = "terminal.key")]
    TerminalKey,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
enum TerminalHandoffActionNameV1 {
    #[serde(rename = "terminal.handoff")]
    TerminalHandoff,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TerminalFixtureStartArgumentsV1 {
    pub(crate) scenario: TerminalFixtureScenarioV1,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TerminalStartActionV1 {
    pub(crate) schema_version: TerminalSchemaVersionV1,
    action: TerminalStartActionNameV1,
    pub(crate) action_id: String,
    pub(crate) driver: TerminalDriverIdV1,
    pub(crate) program: TerminalProgramIdV1,
    pub(crate) arguments: TerminalFixtureStartArgumentsV1,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TerminalRespondActionV1 {
    pub(crate) schema_version: TerminalSchemaVersionV1,
    action: TerminalRespondActionNameV1,
    pub(crate) action_id: String,
    pub(crate) observation_id: String,
    pub(crate) response: TerminalResponseV1,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TerminalKeyActionV1 {
    pub(crate) schema_version: TerminalSchemaVersionV1,
    action: TerminalKeyActionNameV1,
    pub(crate) action_id: String,
    pub(crate) observation_id: String,
    pub(crate) key: TerminalKeyV1,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TerminalHandoffActionV1 {
    pub(crate) schema_version: TerminalSchemaVersionV1,
    action: TerminalHandoffActionNameV1,
    pub(crate) action_id: String,
    pub(crate) observation_id: String,
    pub(crate) reason: TerminalHandoffReasonV1,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(untagged)]
pub(crate) enum TerminalActionV1 {
    Start(TerminalStartActionV1),
    Respond(TerminalRespondActionV1),
    Key(TerminalKeyActionV1),
    Handoff(TerminalHandoffActionV1),
}

impl TerminalActionV1 {
    pub(crate) fn action_id(&self) -> &str {
        match self {
            Self::Start(value) => &value.action_id,
            Self::Respond(value) => &value.action_id,
            Self::Key(value) => &value.action_id,
            Self::Handoff(value) => &value.action_id,
        }
    }

    pub(crate) fn observation_id(&self) -> Option<&str> {
        match self {
            Self::Start(_) => None,
            Self::Respond(value) => Some(&value.observation_id),
            Self::Key(value) => Some(&value.observation_id),
            Self::Handoff(value) => Some(&value.observation_id),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TerminalProtocolDecodeErrorKindV1 {
    TooLarge,
    InvalidJson,
    InvalidContract,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TerminalProtocolDecodeErrorV1 {
    pub(crate) kind: TerminalProtocolDecodeErrorKindV1,
    pub(crate) message: String,
}

impl fmt::Display for TerminalProtocolDecodeErrorV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

pub(crate) fn valid_terminal_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.chars().count() <= MAX_IDENTIFIER_CHARACTERS
        && value.is_ascii()
        && value.chars().enumerate().all(|(index, character)| {
            character.is_ascii_alphanumeric()
                || (index > 0 && matches!(character, '.' | '_' | ':' | '-'))
        })
}

pub(crate) fn decode_terminal_action_v1(
    raw: &str,
) -> Result<TerminalActionV1, TerminalProtocolDecodeErrorV1> {
    if raw.len() > MAX_TERMINAL_ACTION_BYTES_V1 {
        return Err(TerminalProtocolDecodeErrorV1 {
            kind: TerminalProtocolDecodeErrorKindV1::TooLarge,
            message: "terminal action exceeds 16 KiB".to_string(),
        });
    }
    let action = serde_json::from_str::<TerminalActionV1>(raw).map_err(|error| {
        TerminalProtocolDecodeErrorV1 {
            kind: if error.is_syntax() || error.is_eof() {
                TerminalProtocolDecodeErrorKindV1::InvalidJson
            } else {
                TerminalProtocolDecodeErrorKindV1::InvalidContract
            },
            message: "terminal action is not a valid strict v1 contract".to_string(),
        }
    })?;
    if !valid_terminal_identifier(action.action_id())
        || action
            .observation_id()
            .is_some_and(|value| !valid_terminal_identifier(value))
    {
        return Err(TerminalProtocolDecodeErrorV1 {
            kind: TerminalProtocolDecodeErrorKindV1::InvalidContract,
            message: "terminal action identifiers are invalid".to_string(),
        });
    }
    Ok(action)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::protocol::decode_agent_decision_v1;
    use crate::agent::protocol_v2::decode_agent_decision_v2;
    use serde::Deserialize;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Fixture {
        schema_version: u8,
        cases: Vec<FixtureCase>,
    }

    #[derive(Deserialize)]
    struct FixtureCase {
        name: String,
        valid: bool,
        value: serde_json::Value,
    }

    #[test]
    fn shared_terminal_action_fixture_is_strictly_decoded() {
        let fixture: Fixture = serde_json::from_str(include_str!(
            "../../../tests/fixtures/agent-terminal-protocol/v1/terminal-actions.json"
        ))
        .unwrap();
        assert_eq!(fixture.schema_version, 1);
        for fixture_case in fixture.cases {
            let raw = fixture_case.value.to_string();
            assert_eq!(
                decode_terminal_action_v1(&raw).is_ok(),
                fixture_case.valid,
                "{}",
                fixture_case.name
            );
        }
    }

    #[test]
    fn oversized_actions_and_legacy_agent_unions_fail_closed() {
        let oversized = format!(
            "{{\"schemaVersion\":1,\"action\":\"terminal.respond\",\"actionId\":\"{}\",\"observationId\":\"obs-1\",\"response\":\"accept\"}}",
            "a".repeat(MAX_TERMINAL_ACTION_BYTES_V1)
        );
        assert_eq!(
            decode_terminal_action_v1(&oversized).unwrap_err().kind,
            TerminalProtocolDecodeErrorKindV1::TooLarge
        );

        let terminal_action = r#"{"schemaVersion":1,"action":"terminal.key","actionId":"action-1","observationId":"obs-1","key":"enter"}"#;
        assert!(decode_agent_decision_v1(terminal_action).is_err());
        assert!(decode_agent_decision_v2(terminal_action).is_err());
    }

    #[test]
    fn schema_is_checked_in_under_a_separate_namespace() {
        let schema: serde_json::Value = serde_json::from_str(TERMINAL_ACTION_SCHEMA_V1).unwrap();
        assert_eq!(
            schema["$id"],
            "https://termbridge.app/protocol/agent-terminal/v1/terminal-actions.schema.json"
        );
        assert_eq!(schema["oneOf"].as_array().unwrap().len(), 4);
    }

    #[test]
    fn fixed_seed_unknown_field_enum_and_size_corpus_fails_closed() {
        let base = r#"{"schemaVersion":1,"action":"terminal.respond","actionId":"action-1","observationId":"observation-1","response":"accept"}"#;
        let mut seed = 0x0a11_ce55_u32;
        for index in 0..384 {
            seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345);
            let raw = match seed % 3 {
                0 => base.replacen(
                    "\"response\":\"accept\"",
                    &format!("\"response\":\"accept\",\"unknown{seed}\":true"),
                    1,
                ),
                1 => base.replacen(
                    "terminal.respond",
                    &format!("terminal.unknown{seed}"),
                    1,
                ),
                _ => format!(
                    "{{\"schemaVersion\":1,\"action\":\"terminal.respond\",\"actionId\":\"{}\",\"observationId\":\"observation-1\",\"response\":\"accept\"}}",
                    "a".repeat(MAX_TERMINAL_ACTION_BYTES_V1 + (seed as usize % 32))
                ),
            };
            assert!(
                decode_terminal_action_v1(&raw).is_err(),
                "seeded mutation {index} unexpectedly decoded"
            );
        }
    }
}
