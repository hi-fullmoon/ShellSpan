mod host;
mod shell;

use super::orchestrator::{
    AgentToolDeniedV1, AgentToolDriverV1, AgentToolFutureV1, AgentToolInputV1,
    AgentToolOutputStatusV1, AgentToolOutputV1, AgentToolRequestV1, AgentToolValidationV1,
};
use super::policy::{AgentReadOnlyPolicyV1, AGENT_READ_ONLY_POLICY_VERSION_V1};
use super::protocol::{AgentPolicySnapshotV1, AgentToolNameV1};
use host::{prepare_host_inspect_v1, FixedHostInspectPlanV1};
use serde::Serialize;
use serde_json::{json, Value};
use shell::{prepare_posix_command_v1, ApprovedPosixCommandV1};
use std::future::Future;
use std::pin::Pin;
use tokio_util::sync::CancellationToken;

pub(crate) const AGENT_TOOL_REGISTRY_VERSION_V1: &str = "p1-tool-registry-v1";

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentToolRiskV1 {
    ReadOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AgentToolExecutorKindV1 {
    HostInspect,
    ShellExecReadOnly,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct AgentToolDefinitionV1 {
    pub(crate) name: AgentToolNameV1,
    pub(crate) schema_version: u8,
    pub(crate) description: &'static str,
    argument_schema: &'static str,
    pub(crate) risk: AgentToolRiskV1,
    pub(crate) policy_version: &'static str,
    executor: AgentToolExecutorKindV1,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentModelToolDefinitionV1 {
    pub(crate) name: &'static str,
    pub(crate) schema_version: u8,
    pub(crate) description: &'static str,
    pub(crate) argument_schema: Value,
    pub(crate) risk: AgentToolRiskV1,
    pub(crate) policy_version: &'static str,
}

const HOST_INSPECT_SCHEMA_V1: &str = r#"{
  "type":"object",
  "additionalProperties":false,
  "required":["include"],
  "properties":{"include":{"type":"array","minItems":1,"maxItems":6,"uniqueItems":true,"items":{"enum":["os","kernel","architecture","identity","uptime","capabilities"]}}}
}"#;
const SHELL_EXEC_READ_ONLY_SCHEMA_V1: &str = r#"{
  "type":"object",
  "additionalProperties":false,
  "required":["program","args"],
  "properties":{
    "program":{"enum":["uname","hostname","whoami","id","date","uptime","df","free","ps","ss","systemctl","journalctl","docker"]},
    "args":{"type":"array","maxItems":32,"items":{"type":"string","maxLength":512}},
    "timeoutSeconds":{"type":"integer","minimum":1,"maximum":60}
  }
}"#;

static TOOL_DEFINITIONS_V1: [AgentToolDefinitionV1; 2] = [
    AgentToolDefinitionV1 {
        name: AgentToolNameV1::HostInspect,
        schema_version: 1,
        description: "Select fixed host facts and diagnostic capabilities. This tool accepts no command, path, environment, or target.",
        argument_schema: HOST_INSPECT_SCHEMA_V1,
        risk: AgentToolRiskV1::ReadOnly,
        policy_version: AGENT_READ_ONLY_POLICY_VERSION_V1,
        executor: AgentToolExecutorKindV1::HostInspect,
    },
    AgentToolDefinitionV1 {
        name: AgentToolNameV1::ShellExecReadOnly,
        schema_version: 1,
        description: "Propose one allowlisted POSIX diagnostic program with program-specific bounded arguments. Docker is disabled unless a frozen tested capability explicitly enables it.",
        argument_schema: SHELL_EXEC_READ_ONLY_SCHEMA_V1,
        risk: AgentToolRiskV1::ReadOnly,
        policy_version: AGENT_READ_ONLY_POLICY_VERSION_V1,
        executor: AgentToolExecutorKindV1::ShellExecReadOnly,
    },
];

pub(crate) fn compile_time_tool_definitions_v1() -> &'static [AgentToolDefinitionV1] {
    &TOOL_DEFINITIONS_V1
}

pub(crate) fn model_tool_definitions_v1(
    policy: &AgentPolicySnapshotV1,
) -> Vec<AgentModelToolDefinitionV1> {
    if policy.policy_version != AGENT_READ_ONLY_POLICY_VERSION_V1
        || policy.tool_registry_version != AGENT_TOOL_REGISTRY_VERSION_V1
    {
        return Vec::new();
    }
    TOOL_DEFINITIONS_V1
        .iter()
        .filter(|definition| policy.allowed_tools.contains(&definition.name))
        .map(|definition| AgentModelToolDefinitionV1 {
            name: tool_name_v1(definition.name),
            schema_version: definition.schema_version,
            description: definition.description,
            argument_schema: serde_json::from_str(definition.argument_schema)
                .unwrap_or_else(|_| json!({"not": {}})),
            risk: definition.risk,
            policy_version: definition.policy_version,
        })
        .collect()
}

fn tool_name_v1(name: AgentToolNameV1) -> &'static str {
    match name {
        AgentToolNameV1::HostInspect => "host.inspect",
        AgentToolNameV1::ShellExecReadOnly => "shell.execReadOnly",
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ApprovedToolInvocationV1 {
    HostInspect(FixedHostInspectPlanV1),
    ShellExecReadOnly(ApprovedPosixCommandV1),
}

pub(crate) type AgentExecutorFutureV1<'a> =
    Pin<Box<dyn Future<Output = AgentToolOutputV1> + Send + 'a>>;

/// P1-C executor seam. Implementations receive only locally approved fixed
/// probes or a normalized POSIX command. P1-C supplies fakes only; no SSH,
/// session, PTY, process, or IPC implementation exists here.
pub(crate) trait AgentReadOnlyExecutorV1: Send + Sync {
    fn execute<'a>(
        &'a self,
        invocation: ApprovedToolInvocationV1,
        cancellation: CancellationToken,
    ) -> AgentExecutorFutureV1<'a>;
}

pub(crate) struct AgentToolRegistryV1<E>
where
    E: AgentReadOnlyExecutorV1,
{
    policy_snapshot: AgentPolicySnapshotV1,
    read_only_policy: AgentReadOnlyPolicyV1,
    executor: E,
}

impl<E> AgentToolRegistryV1<E>
where
    E: AgentReadOnlyExecutorV1,
{
    pub(crate) fn new(
        policy_snapshot: AgentPolicySnapshotV1,
        read_only_policy: AgentReadOnlyPolicyV1,
        executor: E,
    ) -> Self {
        Self {
            policy_snapshot,
            read_only_policy,
            executor,
        }
    }

    fn prepare_v1(
        &self,
        request: &AgentToolRequestV1,
    ) -> Result<ApprovedToolInvocationV1, AgentToolDeniedV1> {
        if self.policy_snapshot.policy_version != AGENT_READ_ONLY_POLICY_VERSION_V1
            || self.policy_snapshot.tool_registry_version != AGENT_TOOL_REGISTRY_VERSION_V1
        {
            return Err(AgentToolDeniedV1 {
                reason: "The frozen policy and compile-time tool registry versions disagree."
                    .to_string(),
            });
        }
        let requested_name = match &request.input {
            AgentToolInputV1::HostInspect(_) => AgentToolNameV1::HostInspect,
            AgentToolInputV1::ShellExecReadOnly(_) => AgentToolNameV1::ShellExecReadOnly,
        };
        if !self.policy_snapshot.allowed_tools.contains(&requested_name) {
            return Err(AgentToolDeniedV1 {
                reason: "The tool is not enabled by the frozen run policy.".to_string(),
            });
        }
        let definition = TOOL_DEFINITIONS_V1
            .iter()
            .find(|definition| definition.name == requested_name)
            .ok_or_else(|| AgentToolDeniedV1 {
                reason: "The tool is not present in the compile-time registry.".to_string(),
            })?;
        match (definition.executor, &request.input) {
            (AgentToolExecutorKindV1::HostInspect, AgentToolInputV1::HostInspect(arguments)) => {
                prepare_host_inspect_v1(arguments)
                    .map(ApprovedToolInvocationV1::HostInspect)
                    .map_err(|reason| AgentToolDeniedV1 { reason })
            }
            (
                AgentToolExecutorKindV1::ShellExecReadOnly,
                AgentToolInputV1::ShellExecReadOnly(arguments),
            ) => self
                .read_only_policy
                .validate_shell(arguments)
                .map(prepare_posix_command_v1)
                .map(ApprovedToolInvocationV1::ShellExecReadOnly)
                .map_err(|denial| AgentToolDeniedV1 {
                    reason: denial.message,
                }),
            _ => Err(AgentToolDeniedV1 {
                reason: "The registry definition and dispatch variant disagree.".to_string(),
            }),
        }
    }
}

impl<E> AgentToolDriverV1 for AgentToolRegistryV1<E>
where
    E: AgentReadOnlyExecutorV1,
{
    fn validate(&self, request: &AgentToolRequestV1) -> AgentToolValidationV1 {
        match self.prepare_v1(request) {
            Ok(_) => AgentToolValidationV1::Ready,
            Err(denial) => AgentToolValidationV1::Denied(denial),
        }
    }

    fn execute<'a>(
        &'a self,
        request: AgentToolRequestV1,
        cancellation: CancellationToken,
    ) -> AgentToolFutureV1<'a> {
        match self.prepare_v1(&request) {
            Ok(invocation) => self.executor.execute(invocation, cancellation),
            Err(denial) => Box::pin(async move {
                AgentToolOutputV1 {
                    status: AgentToolOutputStatusV1::Failed,
                    summary: denial.reason,
                    stdout_excerpt: String::new(),
                    stderr_excerpt: String::new(),
                    exit_code: None,
                    truncated: false,
                }
            }),
        }
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};

    #[derive(Clone)]
    pub(crate) struct FakeAgentReadOnlyExecutorV1 {
        invocations: Arc<Mutex<Vec<ApprovedToolInvocationV1>>>,
        outputs: Arc<Mutex<VecDeque<AgentToolOutputV1>>>,
    }

    impl FakeAgentReadOnlyExecutorV1 {
        pub(crate) fn new(outputs: Vec<AgentToolOutputV1>) -> Self {
            Self {
                invocations: Arc::new(Mutex::new(Vec::new())),
                outputs: Arc::new(Mutex::new(outputs.into())),
            }
        }

        pub(crate) fn invocations(&self) -> Arc<Mutex<Vec<ApprovedToolInvocationV1>>> {
            self.invocations.clone()
        }
    }

    impl AgentReadOnlyExecutorV1 for FakeAgentReadOnlyExecutorV1 {
        fn execute<'a>(
            &'a self,
            invocation: ApprovedToolInvocationV1,
            cancellation: CancellationToken,
        ) -> AgentExecutorFutureV1<'a> {
            self.invocations.lock().unwrap().push(invocation);
            let output =
                self.outputs
                    .lock()
                    .unwrap()
                    .pop_front()
                    .unwrap_or_else(|| AgentToolOutputV1 {
                        status: AgentToolOutputStatusV1::Failed,
                        summary: "The fake executor has no scripted output.".to_string(),
                        stdout_excerpt: String::new(),
                        stderr_excerpt: String::new(),
                        exit_code: None,
                        truncated: false,
                    });
            Box::pin(async move {
                if cancellation.is_cancelled() {
                    AgentToolOutputV1 {
                        status: AgentToolOutputStatusV1::Cancelled,
                        summary: "The fake executor was cancelled.".to_string(),
                        stdout_excerpt: String::new(),
                        stderr_excerpt: String::new(),
                        exit_code: None,
                        truncated: false,
                    }
                } else {
                    output
                }
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::FakeAgentReadOnlyExecutorV1;
    use super::*;
    use crate::agent::protocol::{AgentPolicyModeV1, AgentToolNameV1, ShellExecReadOnlyArgsV1};

    fn policy_snapshot() -> AgentPolicySnapshotV1 {
        AgentPolicySnapshotV1 {
            mode: AgentPolicyModeV1::ReadOnly,
            policy_version: AGENT_READ_ONLY_POLICY_VERSION_V1.to_string(),
            tool_registry_version: AGENT_TOOL_REGISTRY_VERSION_V1.to_string(),
            allowed_tools: vec![
                AgentToolNameV1::HostInspect,
                AgentToolNameV1::ShellExecReadOnly,
            ],
        }
    }

    fn shell_request(program: &str, args: &[&str]) -> AgentToolRequestV1 {
        AgentToolRequestV1 {
            tool_call_id: "run-1-tool-1".to_string(),
            input: AgentToolInputV1::ShellExecReadOnly(ShellExecReadOnlyArgsV1 {
                program: program.to_string(),
                args: args.iter().map(|arg| (*arg).to_string()).collect(),
                timeout_seconds: Some(15),
            }),
            rationale: "fixture".to_string(),
            purpose: "fixture".to_string(),
            success_criteria: "fixture".to_string(),
        }
    }

    #[test]
    fn model_definitions_and_dispatch_share_the_compile_time_registry() {
        let definitions = model_tool_definitions_v1(&policy_snapshot());
        assert_eq!(definitions.len(), compile_time_tool_definitions_v1().len());
        assert_eq!(definitions[0].name, "host.inspect");
        assert_eq!(definitions[1].name, "shell.execReadOnly");
        assert_eq!(
            definitions[1].argument_schema["properties"]["program"]["enum"]
                .as_array()
                .unwrap()
                .len(),
            13
        );
    }

    #[test]
    fn registry_and_policy_version_drift_fail_closed_before_dispatch() {
        let mut drifted = policy_snapshot();
        drifted.tool_registry_version = "future-registry".to_string();
        assert!(model_tool_definitions_v1(&drifted).is_empty());
        let executor = FakeAgentReadOnlyExecutorV1::new(Vec::new());
        let invocations = executor.invocations();
        let registry =
            AgentToolRegistryV1::new(drifted, AgentReadOnlyPolicyV1::default(), executor);
        assert!(matches!(
            registry.validate(&shell_request("uname", &["-a"])),
            AgentToolValidationV1::Denied(_)
        ));
        assert!(invocations.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn approved_shell_dispatch_reaches_the_fake_executor_with_the_unique_rendering() {
        let executor = FakeAgentReadOnlyExecutorV1::new(vec![AgentToolOutputV1 {
            status: AgentToolOutputStatusV1::Completed,
            summary: "ok".to_string(),
            stdout_excerpt: "Linux".to_string(),
            stderr_excerpt: String::new(),
            exit_code: Some(0),
            truncated: false,
        }]);
        let invocations = executor.invocations();
        let registry = AgentToolRegistryV1::new(
            policy_snapshot(),
            AgentReadOnlyPolicyV1::default(),
            executor,
        );
        let request = shell_request("uname", &["-a"]);
        assert_eq!(registry.validate(&request), AgentToolValidationV1::Ready);
        let output = registry.execute(request, CancellationToken::new()).await;
        assert_eq!(output.status, AgentToolOutputStatusV1::Completed);
        let calls = invocations.lock().unwrap();
        let ApprovedToolInvocationV1::ShellExecReadOnly(command) = &calls[0] else {
            panic!("shell invocation expected");
        };
        assert_eq!(command.rendered_command, "'uname' '-a'");
    }

    #[tokio::test]
    async fn security_injection_corpus_never_reaches_executor_or_produces_an_approved_command() {
        let executor = FakeAgentReadOnlyExecutorV1::new(Vec::new());
        let invocations = executor.invocations();
        let registry = AgentToolRegistryV1::new(
            policy_snapshot(),
            AgentReadOnlyPolicyV1::default(),
            executor,
        );
        let corpus: &[(&str, &[&str])] = &[
            ("sh", &["-c", "uname -a; rm -rf /tmp/x"]),
            ("systemctl", &["restart", "nginx.service"]),
            (
                "journalctl",
                &["--unit", "nginx.service", "--lines=20", "-f"],
            ),
            ("nohup", &["uptime", "&"]),
            ("cat", &["~/.ssh/id_rsa"]),
            ("cat", &["/proc/1/environ"]),
            ("curl", &["http://169.254.169.254/latest/meta-data/"]),
            ("ps", &["aux", "|", "grep", "secret"]),
            ("date", &["+%s", ">", "/tmp/output"]),
            ("uname", &["$(malicious-command)"]),
            ("uname", &["`malicious-command`"]),
            ("sudo", &["-n", "anything"]),
            ("docker", &["exec", "api", "sh"]),
            ("docker", &["logs", "--tail", "20", "--follow", "api"]),
            ("uname", &["-a\nrm -rf /tmp/x"]),
            ("uname", &["-a\u{0000}ignored"]),
            ("uname", &["-a", "&&", "id"]),
            ("uname", &["-a", "2>/tmp/x"]),
            ("uname", &["-a", "<(id)"]),
            ("uname", &["-a", "HOME=/tmp"]),
        ];
        for (program, args) in corpus {
            let request = shell_request(program, args);
            assert!(matches!(
                registry.validate(&request),
                AgentToolValidationV1::Denied(_)
            ));
            assert!(registry.prepare_v1(&request).is_err());
        }
        assert!(invocations.lock().unwrap().is_empty());
    }
}
