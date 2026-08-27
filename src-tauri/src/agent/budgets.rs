use super::protocol::AgentSchemaVersionV1;
use serde::de::{self, Deserializer};
use serde::{Deserialize, Serialize};
use std::fmt;

pub(crate) const DEFAULT_MAX_RUN_SECONDS: u32 = 10 * 60;
pub(crate) const HARD_MAX_RUN_SECONDS: u32 = 15 * 60;
pub(crate) const DEFAULT_MAX_MODEL_TURNS: u16 = 12;
pub(crate) const HARD_MAX_MODEL_TURNS: u16 = 20;
pub(crate) const DEFAULT_MAX_TOOL_CALLS: u16 = 10;
pub(crate) const HARD_MAX_TOOL_CALLS: u16 = 15;
pub(crate) const DEFAULT_TOOL_TIMEOUT_SECONDS: u16 = 15;
pub(crate) const HARD_MAX_TOOL_TIMEOUT_SECONDS: u16 = 60;
pub(crate) const DEFAULT_MAX_CONSECUTIVE_INVALID_DECISIONS: u8 = 2;
pub(crate) const HARD_MAX_CONSECUTIVE_INVALID_DECISIONS: u8 = 2;
pub(crate) const DEFAULT_MAX_CONSECUTIVE_TOOL_FAILURES: u8 = 2;
pub(crate) const HARD_MAX_CONSECUTIVE_TOOL_FAILURES: u8 = 3;
pub(crate) const DEFAULT_MAX_PENDING_PLAN_ITEMS: u8 = 6;
pub(crate) const HARD_MAX_PENDING_PLAN_ITEMS: u8 = 8;
pub(crate) const DEFAULT_MAX_STEERING_QUEUE_ITEMS: u8 = 8;
pub(crate) const HARD_MAX_STEERING_QUEUE_ITEMS: u8 = 16;
pub(crate) const DEFAULT_MAX_USER_MESSAGE_BYTES: u32 = 4 * 1024;
pub(crate) const HARD_MAX_USER_MESSAGE_BYTES: u32 = 8 * 1024;
pub(crate) const DEFAULT_STDOUT_CAPTURE_BYTES: u32 = 64 * 1024;
pub(crate) const HARD_MAX_STDOUT_CAPTURE_BYTES: u32 = 256 * 1024;
pub(crate) const DEFAULT_STDERR_CAPTURE_BYTES: u32 = 16 * 1024;
pub(crate) const HARD_MAX_STDERR_CAPTURE_BYTES: u32 = 64 * 1024;
pub(crate) const DEFAULT_TOTAL_READ_HARD_LIMIT_BYTES: u32 = 8 * 1024 * 1024;
pub(crate) const HARD_MAX_TOTAL_READ_HARD_LIMIT_BYTES: u32 = 16 * 1024 * 1024;

fn deserialize_optional_non_null<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)?
        .map(Some)
        .ok_or_else(|| de::Error::custom("optional Agent budget fields cannot be null"))
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentBudgetRequestV1 {
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) max_run_seconds: Option<u32>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) max_model_turns: Option<u16>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) max_tool_calls: Option<u16>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) tool_timeout_seconds: Option<u16>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) max_consecutive_invalid_decisions: Option<u8>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) max_consecutive_tool_failures: Option<u8>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) max_pending_plan_items: Option<u8>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) max_steering_queue_items: Option<u8>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) max_user_message_bytes: Option<u32>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) stdout_capture_bytes: Option<u32>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) stderr_capture_bytes: Option<u32>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) total_read_hard_limit_bytes: Option<u32>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentBudgetPolicyV1 {
    pub(crate) max_run_seconds: u32,
    pub(crate) max_model_turns: u16,
    pub(crate) max_tool_calls: u16,
    pub(crate) tool_timeout_seconds: u16,
    pub(crate) max_consecutive_invalid_decisions: u8,
    pub(crate) max_consecutive_tool_failures: u8,
    pub(crate) max_pending_plan_items: u8,
    pub(crate) max_steering_queue_items: u8,
    pub(crate) max_user_message_bytes: u32,
    pub(crate) stdout_capture_bytes: u32,
    pub(crate) stderr_capture_bytes: u32,
    pub(crate) total_read_hard_limit_bytes: u32,
}

impl Default for AgentBudgetPolicyV1 {
    fn default() -> Self {
        Self {
            max_run_seconds: DEFAULT_MAX_RUN_SECONDS,
            max_model_turns: DEFAULT_MAX_MODEL_TURNS,
            max_tool_calls: DEFAULT_MAX_TOOL_CALLS,
            tool_timeout_seconds: DEFAULT_TOOL_TIMEOUT_SECONDS,
            max_consecutive_invalid_decisions: DEFAULT_MAX_CONSECUTIVE_INVALID_DECISIONS,
            max_consecutive_tool_failures: DEFAULT_MAX_CONSECUTIVE_TOOL_FAILURES,
            max_pending_plan_items: DEFAULT_MAX_PENDING_PLAN_ITEMS,
            max_steering_queue_items: DEFAULT_MAX_STEERING_QUEUE_ITEMS,
            max_user_message_bytes: DEFAULT_MAX_USER_MESSAGE_BYTES,
            stdout_capture_bytes: DEFAULT_STDOUT_CAPTURE_BYTES,
            stderr_capture_bytes: DEFAULT_STDERR_CAPTURE_BYTES,
            total_read_hard_limit_bytes: DEFAULT_TOTAL_READ_HARD_LIMIT_BYTES,
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentBudgetFieldV1 {
    RunTime,
    ModelTurns,
    ToolCalls,
    ToolTimeout,
    ConsecutiveInvalidDecisions,
    ConsecutiveToolFailures,
    PendingPlanItems,
    SteeringQueueItems,
    UserMessageBytes,
    StdoutCaptureBytes,
    StderrCaptureBytes,
    TotalReadHardLimitBytes,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentBudgetPolicyError {
    pub(crate) field: AgentBudgetFieldV1,
    pub(crate) message: &'static str,
}

impl fmt::Display for AgentBudgetPolicyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.message)
    }
}

fn requested_non_zero<T: Copy + PartialOrd + From<u8>>(
    requested: Option<T>,
    default: T,
    hard_max: T,
    field: AgentBudgetFieldV1,
) -> Result<T, AgentBudgetPolicyError> {
    let value = requested.unwrap_or(default);
    if value < T::from(1) || value > hard_max {
        return Err(AgentBudgetPolicyError {
            field,
            message: "Agent budget request is outside the supported range",
        });
    }
    Ok(value)
}

fn requested_zero_allowed<T: Copy + PartialOrd>(
    requested: Option<T>,
    default: T,
    hard_max: T,
    field: AgentBudgetFieldV1,
) -> Result<T, AgentBudgetPolicyError> {
    let value = requested.unwrap_or(default);
    if value > hard_max {
        return Err(AgentBudgetPolicyError {
            field,
            message: "Agent budget request exceeds the supported hard limit",
        });
    }
    Ok(value)
}

pub(crate) fn resolve_agent_budget_policy_v1(
    request: Option<&AgentBudgetRequestV1>,
) -> Result<AgentBudgetPolicyV1, AgentBudgetPolicyError> {
    let request = request.cloned().unwrap_or_default();
    Ok(AgentBudgetPolicyV1 {
        max_run_seconds: requested_non_zero(
            request.max_run_seconds,
            DEFAULT_MAX_RUN_SECONDS,
            HARD_MAX_RUN_SECONDS,
            AgentBudgetFieldV1::RunTime,
        )?,
        max_model_turns: requested_non_zero(
            request.max_model_turns,
            DEFAULT_MAX_MODEL_TURNS,
            HARD_MAX_MODEL_TURNS,
            AgentBudgetFieldV1::ModelTurns,
        )?,
        max_tool_calls: requested_zero_allowed(
            request.max_tool_calls,
            DEFAULT_MAX_TOOL_CALLS,
            HARD_MAX_TOOL_CALLS,
            AgentBudgetFieldV1::ToolCalls,
        )?,
        tool_timeout_seconds: requested_non_zero(
            request.tool_timeout_seconds,
            DEFAULT_TOOL_TIMEOUT_SECONDS,
            HARD_MAX_TOOL_TIMEOUT_SECONDS,
            AgentBudgetFieldV1::ToolTimeout,
        )?,
        max_consecutive_invalid_decisions: requested_non_zero(
            request.max_consecutive_invalid_decisions,
            DEFAULT_MAX_CONSECUTIVE_INVALID_DECISIONS,
            HARD_MAX_CONSECUTIVE_INVALID_DECISIONS,
            AgentBudgetFieldV1::ConsecutiveInvalidDecisions,
        )?,
        max_consecutive_tool_failures: requested_non_zero(
            request.max_consecutive_tool_failures,
            DEFAULT_MAX_CONSECUTIVE_TOOL_FAILURES,
            HARD_MAX_CONSECUTIVE_TOOL_FAILURES,
            AgentBudgetFieldV1::ConsecutiveToolFailures,
        )?,
        max_pending_plan_items: requested_zero_allowed(
            request.max_pending_plan_items,
            DEFAULT_MAX_PENDING_PLAN_ITEMS,
            HARD_MAX_PENDING_PLAN_ITEMS,
            AgentBudgetFieldV1::PendingPlanItems,
        )?,
        max_steering_queue_items: requested_zero_allowed(
            request.max_steering_queue_items,
            DEFAULT_MAX_STEERING_QUEUE_ITEMS,
            HARD_MAX_STEERING_QUEUE_ITEMS,
            AgentBudgetFieldV1::SteeringQueueItems,
        )?,
        max_user_message_bytes: requested_non_zero(
            request.max_user_message_bytes,
            DEFAULT_MAX_USER_MESSAGE_BYTES,
            HARD_MAX_USER_MESSAGE_BYTES,
            AgentBudgetFieldV1::UserMessageBytes,
        )?,
        stdout_capture_bytes: requested_zero_allowed(
            request.stdout_capture_bytes,
            DEFAULT_STDOUT_CAPTURE_BYTES,
            HARD_MAX_STDOUT_CAPTURE_BYTES,
            AgentBudgetFieldV1::StdoutCaptureBytes,
        )?,
        stderr_capture_bytes: requested_zero_allowed(
            request.stderr_capture_bytes,
            DEFAULT_STDERR_CAPTURE_BYTES,
            HARD_MAX_STDERR_CAPTURE_BYTES,
            AgentBudgetFieldV1::StderrCaptureBytes,
        )?,
        total_read_hard_limit_bytes: requested_non_zero(
            request.total_read_hard_limit_bytes,
            DEFAULT_TOTAL_READ_HARD_LIMIT_BYTES,
            HARD_MAX_TOTAL_READ_HARD_LIMIT_BYTES,
            AgentBudgetFieldV1::TotalReadHardLimitBytes,
        )?,
    })
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentBudgetUsageV1 {
    pub(crate) elapsed_millis: u64,
    pub(crate) model_turns_used: u16,
    pub(crate) tool_calls_used: u16,
    pub(crate) consecutive_invalid_decisions: u8,
    pub(crate) consecutive_tool_failures: u8,
    pub(crate) steering_queue_items: u8,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentBudgetSnapshotV1 {
    pub(crate) schema_version: AgentSchemaVersionV1,
    pub(crate) policy: AgentBudgetPolicyV1,
    pub(crate) usage: AgentBudgetUsageV1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct AgentBudgetExceeded {
    pub(crate) field: AgentBudgetFieldV1,
}

impl fmt::Display for AgentBudgetExceeded {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Agent budget is exhausted")
    }
}

#[derive(Debug, Clone)]
pub(crate) struct AgentBudgetLedgerV1 {
    policy: AgentBudgetPolicyV1,
    usage: AgentBudgetUsageV1,
}

impl AgentBudgetLedgerV1 {
    pub(crate) fn new(policy: AgentBudgetPolicyV1) -> Self {
        Self {
            policy,
            usage: AgentBudgetUsageV1 {
                elapsed_millis: 0,
                model_turns_used: 0,
                tool_calls_used: 0,
                consecutive_invalid_decisions: 0,
                consecutive_tool_failures: 0,
                steering_queue_items: 0,
            },
        }
    }

    pub(crate) fn snapshot(&self) -> AgentBudgetSnapshotV1 {
        AgentBudgetSnapshotV1 {
            schema_version: AgentSchemaVersionV1,
            policy: self.policy,
            usage: self.usage,
        }
    }

    pub(crate) fn check_elapsed(&mut self, elapsed_millis: u64) -> Result<(), AgentBudgetExceeded> {
        self.usage.elapsed_millis = elapsed_millis;
        if elapsed_millis >= u64::from(self.policy.max_run_seconds) * 1_000 {
            Err(AgentBudgetExceeded {
                field: AgentBudgetFieldV1::RunTime,
            })
        } else {
            Ok(())
        }
    }

    pub(crate) fn consume_model_turn(&mut self) -> Result<(), AgentBudgetExceeded> {
        if self.usage.model_turns_used >= self.policy.max_model_turns {
            return Err(AgentBudgetExceeded {
                field: AgentBudgetFieldV1::ModelTurns,
            });
        }
        self.usage.model_turns_used += 1;
        Ok(())
    }

    pub(crate) fn consume_tool_call(&mut self) -> Result<(), AgentBudgetExceeded> {
        if self.usage.tool_calls_used >= self.policy.max_tool_calls {
            return Err(AgentBudgetExceeded {
                field: AgentBudgetFieldV1::ToolCalls,
            });
        }
        self.usage.tool_calls_used += 1;
        Ok(())
    }

    pub(crate) fn record_invalid_decision(&mut self) -> Result<(), AgentBudgetExceeded> {
        self.usage.consecutive_invalid_decisions =
            self.usage.consecutive_invalid_decisions.saturating_add(1);
        if self.usage.consecutive_invalid_decisions >= self.policy.max_consecutive_invalid_decisions
        {
            Err(AgentBudgetExceeded {
                field: AgentBudgetFieldV1::ConsecutiveInvalidDecisions,
            })
        } else {
            Ok(())
        }
    }

    pub(crate) fn record_valid_decision(&mut self) {
        self.usage.consecutive_invalid_decisions = 0;
    }

    pub(crate) fn record_tool_failure(&mut self) -> Result<(), AgentBudgetExceeded> {
        self.usage.consecutive_tool_failures =
            self.usage.consecutive_tool_failures.saturating_add(1);
        if self.usage.consecutive_tool_failures >= self.policy.max_consecutive_tool_failures {
            Err(AgentBudgetExceeded {
                field: AgentBudgetFieldV1::ConsecutiveToolFailures,
            })
        } else {
            Ok(())
        }
    }

    pub(crate) fn record_tool_success(&mut self) {
        self.usage.consecutive_tool_failures = 0;
    }

    pub(crate) fn set_steering_queue_items(
        &mut self,
        items: u8,
    ) -> Result<(), AgentBudgetExceeded> {
        if items > self.policy.max_steering_queue_items {
            return Err(AgentBudgetExceeded {
                field: AgentBudgetFieldV1::SteeringQueueItems,
            });
        }
        self.usage.steering_queue_items = items;
        Ok(())
    }

    pub(crate) fn check_user_message(&self, message: &str) -> Result<(), AgentBudgetExceeded> {
        if message.len() > self.policy.max_user_message_bytes as usize {
            Err(AgentBudgetExceeded {
                field: AgentBudgetFieldV1::UserMessageBytes,
            })
        } else {
            Ok(())
        }
    }

    pub(crate) fn check_plan_items(&self, count: usize) -> Result<(), AgentBudgetExceeded> {
        if count > self.policy.max_pending_plan_items as usize {
            Err(AgentBudgetExceeded {
                field: AgentBudgetFieldV1::PendingPlanItems,
            })
        } else {
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct BudgetFixtureV1 {
        schema_version: u8,
        cases: Vec<BudgetFixtureCaseV1>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct BudgetFixtureCaseV1 {
        name: String,
        valid: bool,
        request: serde_json::Value,
        #[serde(default)]
        expected: Option<AgentBudgetPolicyV1>,
    }

    #[test]
    fn shared_budget_fixtures_resolve_identically() {
        let fixture: BudgetFixtureV1 = serde_json::from_str(include_str!(
            "../../../tests/fixtures/agent-protocol/v1/budget-policy.json"
        ))
        .expect("shared budget fixture must decode");
        assert_eq!(fixture.schema_version, 1);

        for case in fixture.cases {
            let result = serde_json::from_value::<AgentBudgetRequestV1>(case.request)
                .map_err(|error| error.to_string())
                .and_then(|request| {
                    resolve_agent_budget_policy_v1(Some(&request))
                        .map_err(|error| error.to_string())
                });
            assert_eq!(result.is_ok(), case.valid, "budget fixture {}", case.name);
            if let Some(expected) = case.expected {
                assert_eq!(
                    result.expect("valid budget fixture"),
                    expected,
                    "{}",
                    case.name
                );
            }
        }
    }

    #[test]
    fn consumption_is_atomic_and_limits_are_fail_closed() {
        let policy = AgentBudgetPolicyV1 {
            max_model_turns: 1,
            max_tool_calls: 1,
            max_consecutive_invalid_decisions: 2,
            max_consecutive_tool_failures: 2,
            max_pending_plan_items: 1,
            max_steering_queue_items: 1,
            max_user_message_bytes: 4,
            max_run_seconds: 1,
            ..AgentBudgetPolicyV1::default()
        };
        let mut ledger = AgentBudgetLedgerV1::new(policy);

        ledger.consume_model_turn().expect("first model turn");
        assert_eq!(
            ledger
                .consume_model_turn()
                .expect_err("second turn is denied")
                .field,
            AgentBudgetFieldV1::ModelTurns
        );
        assert_eq!(ledger.snapshot().usage.model_turns_used, 1);

        ledger.consume_tool_call().expect("first tool proposal");
        assert_eq!(
            ledger
                .consume_tool_call()
                .expect_err("second tool is denied")
                .field,
            AgentBudgetFieldV1::ToolCalls
        );
        assert_eq!(ledger.snapshot().usage.tool_calls_used, 1);

        ledger
            .record_invalid_decision()
            .expect("one repair is allowed");
        assert_eq!(
            ledger
                .record_invalid_decision()
                .expect_err("second invalid decision closes the run")
                .field,
            AgentBudgetFieldV1::ConsecutiveInvalidDecisions
        );
        ledger.record_valid_decision();
        assert_eq!(ledger.snapshot().usage.consecutive_invalid_decisions, 0);

        ledger.record_tool_failure().expect("first tool failure");
        assert_eq!(
            ledger
                .record_tool_failure()
                .expect_err("failure limit closes the run")
                .field,
            AgentBudgetFieldV1::ConsecutiveToolFailures
        );
        ledger.record_tool_success();

        assert!(ledger.set_steering_queue_items(1).is_ok());
        assert!(ledger.set_steering_queue_items(2).is_err());
        assert!(ledger.check_user_message("four").is_ok());
        assert!(ledger.check_user_message("five!").is_err());
        assert!(ledger.check_plan_items(1).is_ok());
        assert!(ledger.check_plan_items(2).is_err());
        assert!(ledger.check_elapsed(999).is_ok());
        assert_eq!(
            ledger
                .check_elapsed(1_000)
                .expect_err("deadline is closed")
                .field,
            AgentBudgetFieldV1::RunTime
        );
    }

    #[test]
    fn unknown_budget_fields_and_over_limit_values_fail_closed() {
        assert!(
            serde_json::from_value::<AgentBudgetRequestV1>(serde_json::json!({
                "maxModelTurns": 12,
                "unlimited": true
            }))
            .is_err()
        );
        assert!(resolve_agent_budget_policy_v1(Some(&AgentBudgetRequestV1 {
            max_model_turns: Some(HARD_MAX_MODEL_TURNS + 1),
            ..AgentBudgetRequestV1::default()
        }))
        .is_err());
    }
}
