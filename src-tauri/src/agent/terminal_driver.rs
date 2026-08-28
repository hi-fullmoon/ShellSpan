//! Compile-time terminal driver registry and the sole semantic-input renderer.
//!
//! No generic driver or arbitrary program entry exists. The renderer is the
//! only module that turns model-facing enums into terminal input bytes.

use super::terminal_protocol::{
    TerminalActionV1, TerminalDriverIdV1, TerminalFixtureScenarioV1, TerminalHandoffReasonV1,
    TerminalKeyV1, TerminalProgramIdV1, TerminalResponseV1,
};
use std::fmt;

pub(crate) const TERMINAL_DRIVER_REGISTRY_VERSION_V1: &str = "agent-terminal-drivers-v1";

const CONFIRM_RESPONSES: &[TerminalResponseV1] = &[
    TerminalResponseV1::Accept,
    TerminalResponseV1::Decline,
    TerminalResponseV1::Cancel,
];
const CHOICE_RESPONSES: &[TerminalResponseV1] =
    &[TerminalResponseV1::Retry, TerminalResponseV1::Cancel];
const CONFIRM_KEYS: &[TerminalKeyV1] = &[
    TerminalKeyV1::Enter,
    TerminalKeyV1::Escape,
    TerminalKeyV1::CtrlC,
];
const CHOICE_KEYS: &[TerminalKeyV1] = &[
    TerminalKeyV1::Enter,
    TerminalKeyV1::Escape,
    TerminalKeyV1::Tab,
    TerminalKeyV1::CtrlC,
    TerminalKeyV1::ArrowUp,
    TerminalKeyV1::ArrowDown,
    TerminalKeyV1::ArrowLeft,
    TerminalKeyV1::ArrowRight,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TerminalDriverDefinitionV1 {
    pub(crate) driver: TerminalDriverIdV1,
    pub(crate) program: TerminalProgramIdV1,
    executable: &'static str,
}

const DRIVER_REGISTRY: [TerminalDriverDefinitionV1; 1] = [TerminalDriverDefinitionV1 {
    driver: TerminalDriverIdV1::FixtureShellPrompt,
    program: TerminalProgramIdV1::TermbridgeInteractiveFixture,
    executable: "termbridge-interactive-fixture",
}];

pub(crate) fn registered_terminal_drivers_v1() -> &'static [TerminalDriverDefinitionV1] {
    &DRIVER_REGISTRY
}

pub(crate) fn lookup_terminal_driver_v1(
    driver: TerminalDriverIdV1,
    program: TerminalProgramIdV1,
) -> Result<&'static TerminalDriverDefinitionV1, TerminalDriverErrorV1> {
    DRIVER_REGISTRY
        .iter()
        .find(|definition| definition.driver == driver && definition.program == program)
        .ok_or(TerminalDriverErrorV1::UnknownDriverProgram)
}

pub(crate) fn allowed_responses_v1(
    scenario: TerminalFixtureScenarioV1,
) -> &'static [TerminalResponseV1] {
    match scenario {
        TerminalFixtureScenarioV1::Confirm => CONFIRM_RESPONSES,
        TerminalFixtureScenarioV1::Choice => CHOICE_RESPONSES,
    }
}

pub(crate) fn allowed_keys_v1(scenario: TerminalFixtureScenarioV1) -> &'static [TerminalKeyV1] {
    match scenario {
        TerminalFixtureScenarioV1::Confirm => CONFIRM_KEYS,
        TerminalFixtureScenarioV1::Choice => CHOICE_KEYS,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RegisteredTerminalStartV1 {
    pub(crate) registry_version: &'static str,
    pub(crate) driver: TerminalDriverIdV1,
    pub(crate) program: TerminalProgramIdV1,
    pub(crate) executable: &'static str,
    pub(crate) args: Vec<&'static str>,
}

/// Opaque rendered input. Callers can pass it to the phase-1 lease seam but
/// cannot construct arbitrary contents through this type.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RenderedTerminalInputV1(String);

impl RenderedTerminalInputV1 {
    pub(super) fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RenderedTerminalActionV1 {
    Start(RegisteredTerminalStartV1),
    Input(RenderedTerminalInputV1),
    Handoff(TerminalHandoffReasonV1),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TerminalDriverErrorV1 {
    UnknownDriverProgram,
}

impl fmt::Display for TerminalDriverErrorV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownDriverProgram => {
                formatter.write_str("terminal driver/program is not in the compile-time registry")
            }
        }
    }
}

/// Sole renderer for all v1 semantic actions. Control bytes exist only in the
/// fixed key mapping below; they can never be supplied by the model protocol.
pub(crate) fn render_terminal_action_v1(
    action: &TerminalActionV1,
) -> Result<RenderedTerminalActionV1, TerminalDriverErrorV1> {
    match action {
        TerminalActionV1::Start(value) => {
            let definition = lookup_terminal_driver_v1(value.driver, value.program)?;
            let scenario = match value.arguments.scenario {
                TerminalFixtureScenarioV1::Confirm => "confirm",
                TerminalFixtureScenarioV1::Choice => "choice",
            };
            Ok(RenderedTerminalActionV1::Start(RegisteredTerminalStartV1 {
                registry_version: TERMINAL_DRIVER_REGISTRY_VERSION_V1,
                driver: definition.driver,
                program: definition.program,
                executable: definition.executable,
                args: vec!["--scenario", scenario],
            }))
        }
        TerminalActionV1::Respond(value) => {
            let bytes = match value.response {
                TerminalResponseV1::Accept => "yes\r",
                TerminalResponseV1::Decline => "no\r",
                TerminalResponseV1::Retry => "retry\r",
                TerminalResponseV1::Cancel => "cancel\r",
            };
            Ok(RenderedTerminalActionV1::Input(RenderedTerminalInputV1(
                bytes.to_string(),
            )))
        }
        TerminalActionV1::Key(value) => {
            let bytes = match value.key {
                TerminalKeyV1::Enter => "\r",
                TerminalKeyV1::Escape => "\u{1b}",
                TerminalKeyV1::Tab => "\t",
                TerminalKeyV1::CtrlC => "\u{3}",
                TerminalKeyV1::CtrlD => "\u{4}",
                TerminalKeyV1::ArrowUp => "\u{1b}[A",
                TerminalKeyV1::ArrowDown => "\u{1b}[B",
                TerminalKeyV1::ArrowLeft => "\u{1b}[D",
                TerminalKeyV1::ArrowRight => "\u{1b}[C",
            };
            Ok(RenderedTerminalActionV1::Input(RenderedTerminalInputV1(
                bytes.to_string(),
            )))
        }
        TerminalActionV1::Handoff(value) => Ok(RenderedTerminalActionV1::Handoff(value.reason)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::terminal_protocol::decode_terminal_action_v1;
    use std::collections::HashSet;

    fn decode(value: &str) -> TerminalActionV1 {
        decode_terminal_action_v1(value).unwrap()
    }

    #[test]
    fn registry_has_unique_driver_program_pairs_and_no_generic_entry() {
        let registry = registered_terminal_drivers_v1();
        assert_eq!(registry.len(), 1);
        let unique = registry
            .iter()
            .map(|entry| (entry.driver, entry.program))
            .collect::<HashSet<_>>();
        assert_eq!(unique.len(), registry.len());
        assert_eq!(
            TERMINAL_DRIVER_REGISTRY_VERSION_V1,
            "agent-terminal-drivers-v1"
        );
    }

    #[test]
    fn sole_renderer_has_a_frozen_response_and_key_corpus() {
        let response_cases = [
            ("accept", "yes\r"),
            ("decline", "no\r"),
            ("retry", "retry\r"),
            ("cancel", "cancel\r"),
        ];
        for (index, (response, expected)) in response_cases.into_iter().enumerate() {
            let action = decode(&format!(
                r#"{{"schemaVersion":1,"action":"terminal.respond","actionId":"response-{index}","observationId":"observation-1","response":"{response}"}}"#
            ));
            let RenderedTerminalActionV1::Input(input) =
                render_terminal_action_v1(&action).unwrap()
            else {
                panic!("response did not render as input")
            };
            assert_eq!(input.as_str(), expected);
            assert!(!input.as_str().contains('\n'));
            assert!(!input.as_str().contains('\0'));
        }

        let key_cases = [
            ("enter", "\r"),
            ("escape", "\u{1b}"),
            ("tab", "\t"),
            ("ctrlC", "\u{3}"),
            ("ctrlD", "\u{4}"),
            ("arrowUp", "\u{1b}[A"),
            ("arrowDown", "\u{1b}[B"),
            ("arrowLeft", "\u{1b}[D"),
            ("arrowRight", "\u{1b}[C"),
        ];
        for (index, (key, expected)) in key_cases.into_iter().enumerate() {
            let action = decode(&format!(
                r#"{{"schemaVersion":1,"action":"terminal.key","actionId":"key-{index}","observationId":"observation-1","key":"{key}"}}"#
            ));
            let RenderedTerminalActionV1::Input(input) =
                render_terminal_action_v1(&action).unwrap()
            else {
                panic!("key did not render as input")
            };
            assert_eq!(input.as_str(), expected);
        }
    }

    #[test]
    fn start_renders_a_direct_registered_program_not_a_shell_command() {
        let action = decode(
            r#"{"schemaVersion":1,"action":"terminal.start","actionId":"start-1","driver":"fixture.shellPrompt","program":"termbridge-interactive-fixture","arguments":{"scenario":"choice"}}"#,
        );
        let RenderedTerminalActionV1::Start(start) = render_terminal_action_v1(&action).unwrap()
        else {
            panic!("start did not render as a registered launch")
        };
        assert_eq!(start.executable, "termbridge-interactive-fixture");
        assert_eq!(start.args, vec!["--scenario", "choice"]);
        assert!(!start.args.iter().any(|value| *value == "-c"));
    }
}
