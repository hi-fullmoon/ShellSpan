# Terminal Agent enhancement M0 contract baseline

This document freezes the ShellSpan v2 Agent behavior and records the M0-only
contract for a future v3 runtime. M0 does not add a model loop, tool executor,
capability signer, background process manager, file driver, or M1 registry.

## Frozen v2 behavior

The production execution route remains Agent Contract v2 and
`run_terminal_command`:

- Assistant text and Markdown never enter the execution path.
- A request owns one immutable local or remote terminal target.
- Only one structured terminal tool is registered with the model.
- The existing approval modes, eight-step limit, stop, timeout, output bound,
  redaction, result correlation, disconnect handling, and non-replay behavior
  remain unchanged.
- Existing v1 and v2 protocol artifacts remain checked in. No v2 history is
  rewritten as a resumable v3 task.

The executable regression baseline is described under [Evaluation baseline](#evaluation-baseline).

## v3 draft artifacts

The canonical M0 protocol is split by responsibility:

- `protocol/agent/v3/agent-contract.schema.json` defines requests and the
  logical claims produced by a native capability verifier.
- `protocol/agent/v3/tool-contract.schema.json` defines strict calls, targets,
  effects, artifacts, and per-tool result data.
- `protocol/agent/v3/tool-manifest.schema.json` defines registry metadata.
- `protocol/agent/v3/built-in-tools.json` freezes the first 12 descriptors.
- `protocol/agent/v3/agent-contract-fixtures.json` contains one call and result
  for every built-in tool and is decoded by both TypeScript and Rust tests.

All objects reject unknown fields. Every call contains `requestId`, `callId`, a
full frozen `target`, and an opaque `capabilityId`. Every result repeats
`requestId`, `callId`, `toolName`, and `targetId`. JSON Schema validates shape;
the Rust policy boundary validates cross-object identity and capability scope.

### Initial tool surface

| Tool | Target kinds | Admissible effect | Classification |
| --- | --- | --- | --- |
| `exec_command` | local, remote | read, sensitive read, state change, destructive, external | native |
| `write_stdin` | process | state change | fixed |
| `wait_process` | process | read | fixed |
| `kill_process` | process | state change | fixed |
| `read_file` | local, remote | sensitive read | fixed |
| `list_directory` | local, remote | read | fixed |
| `search_text` | local, remote | sensitive read | fixed |
| `apply_patch` | local, remote | state change or destructive | native |
| `transfer_file` | local, remote | sensitive read, state change, or external | native |
| `host_snapshot` | local, remote | sensitive read | fixed |
| `ask_user` | UI | none | fixed |
| `update_plan` | task | none | fixed |

`built-in-tools.json` additionally freezes idempotency, cancellation, retry,
timeout, output, concurrency, capability, and untrusted-result metadata. A
model-supplied effect is never authority: M1 must supply the native
`assessed_effect` used by policy evaluation.

## Native policy boundary

`src-tauri/src/agent_contract_v3` is an M0 contract module, not a runtime. Its
stable hand-off points for M1 are:

- `AgentCapabilityVerifierV3`: resolves an opaque capability id entirely in
  Rust and returns `VerifiedAgentCapabilityV3`. The verified type has no wire
  deserializer and its constructor is crate-private.
- `AgentPolicyEngineV3`: evaluates one request, call, native effect assessment,
  verified capability, and current time.
- `M0ContractPolicyEngineV3`: fail-closed reference implementation.
- `validate_tool_arguments_v3`: selects one of the 12 strict argument types and
  rejects unknown fields.
- `validate_result_correlation_v3`: binds a result to the same request, call,
  tool, and frozen target and rejects effects on unknown targets.

The reference evaluator denies execution when any of these checks fails:

1. Contract version, request identity, task identity, criteria, or unique
   targets are invalid.
2. The call belongs to another request.
3. The tool is not one of the 12 registered names.
4. The complete call target is absent from the request, the process owner is
   absent, or the target kind is unsupported by the tool.
5. Arguments contain unknown fields or fail semantic bounds.
6. Native effect classification is absent, targets another object, or is not
   valid for the tool.
7. A verified capability is absent, mismatched, not yet valid, expired,
   revoked, or lacks the call's tool, effect, or target.

Approval happens before this boundary and results in a short-lived native
capability. “Needs approval” is therefore not an execution decision; a missing
proof is a denial.

## v2 compatibility and migration

The compatibility layer is additive:

- `adapt_v2_request_to_v3` maps the v2 target and permission semantics into a
  v3 view and marks it `sourceContract: "v2Compatibility"`.
- `run_terminal_command` maps only to `exec_command` with `channel: "pty"`.
- `adapt_v2_tool_call_to_v3` requires an externally supplied `capabilityId`.
  It cannot create a capability or authorize execution.
- v2 combined output maps to a compatibility result that explicitly reports
  unavailable stdout/stderr separation and unknown truncation knowledge.
- The adapter rejects cross-request and cross-call result conversion.

M1 should migrate one guarded call path at a time. It must keep the v2 path and
history reader intact for at least one stable release and must not interpret a
read-only compatibility view as a resumable v3 task.

## Feature flag and rollback

v3 has an independent flag: `SHELLSPAN_AGENT_V3_ROLLOUT`.

| Value | Contract visible | Execution route |
| --- | --- | --- |
| absent or `disabled` | no | v2 |
| `contractOnly` | yes | v2 |
| unknown | no (fail closed) | v2 |

`agent_v3_rollout_policy` reports the resolved stage together with
`executionContractVersion: 2` and `rollbackContractVersion: 2`. M0 deliberately
has no value that selects a v3 executor.

Rollback is one switch plus application restart:

```powershell
$env:SHELLSPAN_AGENT_V3_ROLLOUT = 'disabled'
pnpm tauri:dev
```

For a packaged launch, remove or set that environment variable to `disabled`
in the launcher and restart ShellSpan. This affects only the v3 contract
preview; the existing `SHELLSPAN_AGENT_ROLLOUT` v2 release flag is independent.

## Evaluation baseline

`evals/agent-v2/task-set.json` freezes seven representative tasks:

- disk-space diagnosis;
- service diagnosis, correction, restart, and verification;
- bounded log root-cause analysis;
- local edit plus SFTP publication;
- Docker/process health diagnosis;
- multi-host canary upgrade;
- interruption and restart reconciliation.

Each task includes success criteria, safety assertions, required targets, its
v3 tool set, the expected v2 disposition, and explicit v2 gaps. The set covers
all 12 initial tools. v2 is expected to support two tasks, partially support
two, and not support three; “unsupported” is a baseline fact, not a failed v2
regression.

Capture the baseline with:

```powershell
pnpm baseline:agent:v2
```

The collector validates the task schema, runs the v2 TypeScript contract and
security suites serially, runs the v2 Rust contract tests, and writes
`evals/agent-v2/baseline.json` with revision, environment, v2 contract and task-set digests,
durations, exit states, and the frozen task dispositions. It does not store
test output or secrets. On Windows it uses the repository-pinned MSVC Rust
toolchain so Tauri is not subjected to MinGW `cdylib` export limits.
`--skip-rust` exists only for diagnostics and does
not constitute an accepted baseline.

Live remote task success rates require controlled hosts and provider
credentials, so M0 records those tasks as `requiresLiveEnvironment` instead of
claiming fabricated end-to-end results. Later milestones can add a harness
without changing task ids or their safety assertions.

## M1 hand-off constraints

M1 may consume these interfaces only after it supplies:

1. A Rust capability signer/verifier that constructs
   `VerifiedAgentCapabilityV3` without accepting claims from the WebView.
2. Native effect classifiers for every `nativeClassifier` descriptor.
3. A registry whose metadata matches `built-in-tools.json` and whose unknown
   tool behavior remains denial.
4. Frozen-target revalidation immediately before dispatch.
5. Strict result-data validation and `validate_result_correlation_v3` before a
   result is committed or sent to the model.
6. A new rollout value and tests that explicitly select the v3 runtime while
   retaining the `disabled` rollback route.

The enhancement plan's final “next step” list mentions a Direct Exec prototype,
but Direct Exec is an M1 runtime deliverable. M0 intentionally stops at the
schema and policy boundary to remain minimal, reversible, and testable.
