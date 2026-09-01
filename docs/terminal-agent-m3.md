# Terminal Agent enhancement M3 context and extensions

M3 adds bounded context and extension surfaces to the opt-in Agent Contract v3
runtime. It does not replace Agent v2, enable v3 by default, add durable task
recovery, Operator mode, a credential broker UI, Fleet, or multiple Agents.
Rust remains authoritative for task identity, schema validation, effects,
approval, exact-call capabilities, execution, result correlation, and plan
evidence.

## Delivered context model

Every registered v3 task owns four explicit context layers:

| Layer | Native source | Scope |
| --- | --- | --- |
| workspace | bounded project instruction files and generated maps | frozen local workspace root and task |
| host | Rust-frozen local/remote target identity | target and task |
| session | Rust session identity | session, target, and task |
| task | user goal, success criteria, Rust plan, and correlated tool evidence | task |

Each fragment records its source kind and label, scope, numeric priority,
override references, trust, sensitivity, byte/token estimate, omission reason,
whether it is untrusted, and whether it is eligible to act as a project
instruction. AGENTS.md and .shellspan/instructions.md are the only M3 project
files that become instruction-eligible. Ordinary files, terminal output, tool
result text, MCP data, symbol names, directory entries, and retrieved
artifacts are data only and cannot promote themselves to instructions.

Workspace discovery is rooted at the canonical cwd frozen into a local Agent
target. Filesystem roots, symlinked roots, symlinked instruction/extension
paths, path escape, non-regular files, invalid UTF-8, individual instruction
files above 64 KiB, and combined instruction content above 192 KiB fail closed
or appear with an explicit omission reason. M3 does not fetch project
instructions over remote SFTP; remote file content remains untrusted data.

agent_v3_refresh_context also produces bounded directory and symbol maps.
Artifacts live under the private application-data agent-m3-artifacts
directory. IPC returns ids, media type, digest, size, and creation time, never
the native storage path. agent_v3_retrieve_context accepts only an artifact
owned by the task, caps returned UTF-8 at 16 KiB, supports a bounded line
query, redacts secret patterns again, and marks the result untrusted.

## Structured compaction and viewer

agent_v3_compact_context accepts only manual, budgetPressure, or
beforeExtension. Its versioned JSON artifact preserves:

- task/request ids, goal, and success criteria;
- plan version, step state, dependencies, success criteria, rollback text, and
  evidence references;
- correlated tool result ids, statuses, summaries, effects, artifact
  references, and truncation state;
- permission mode and the Rust exact-call capability boundary;
- failures, pending work, and checkpoint metadata.

Raw long output and credential values are not copied into the compaction.
The Context & fee viewer shows the four layers, provenance, priority,
overrides, trust, sensitivity, clipping reason, artifacts, extensions, MCP
health, source bytes, and a conservative input-token estimate. It reports
monetary cost as unavailable when price, cache tier, and billed usage are
unknown.

## Skills

Skills are discovered progressively from
.shellspan/skills/<id>/SKILL.md. Only catalog metadata is resident after
refresh. The body is returned only by agent_v3_load_skill.

~~~markdown
---
version: 1
name: Inspect safely
description: Read one bounded file
requiredTools: [read_file]
targets: [local]
permissions: [sensitiveRead]
---
Use the declared read_file tool and preserve evidence.
~~~

The declaration must name registered and implemented tools, supported target
kinds, and at least one matching effect. Missing/unavailable tools, target
mismatch, malformed frontmatter, symlinks, oversized bodies, and permission
mismatch fail closed. The response states grantsPermissions: false; Skill
prose never creates a capability.

## Hooks

M3 defines sessionStart, sessionEnd, userPromptSubmitted, beforeTool,
afterTool, toolFailed, permissionRequested, beforeCompact, taskCompleted, and
taskFailed. Hooks are loaded from .shellspan/hooks.json:

~~~json
{
  "version": 1,
  "hooks": [
    {
      "id": "limit-read",
      "event": "beforeTool",
      "mode": "sync",
      "action": "modify",
      "tool": "read_file",
      "argumentOverrides": { "maxBytes": 4096 }
    },
    {
      "id": "tool-metric",
      "event": "afterTool",
      "mode": "async",
      "action": "observe",
      "metricName": "agent.tool.completed"
    }
  ]
}
~~~

Synchronous hooks are limited to beforeTool allow, deny, or argument
modification. Allow is advisory and grants nothing. Modified arguments still
pass Rust schema validation, target revalidation, effect classification,
native preview/approval, exact-call digest, and capability checks. Hooks
cannot modify the tool name or target. Asynchronous hooks are observe-only
bounded audit/metric events; they receive no arguments or credential values
and cannot modify a result.

## Runbook v1

Versioned YAML files and Markdown with YAML frontmatter are discovered under
.shellspan/runbooks. A Runbook declares parameters, prechecks, steps, success
criteria, and rollback/compensation:

~~~yaml
version: 1
id: inspect-config
name: Inspect config
description: Inspect and verify a configuration file
parameters:
  - name: path
    required: true
prechecks:
  - id: precheck
    description: Check ${path}
    requiredTools: [read_file]
    expectedEffect: sensitiveRead
    successCriteria: [The target is readable]
    rollbackOrCompensation: No mutation was performed
steps:
  - id: verify
    description: Verify ${path}
    dependencies: [precheck]
    requiredTools: [read_file]
    expectedEffect: sensitiveRead
    successCriteria: [Evidence is recorded]
    rollbackOrCompensation: No mutation was performed
successCriteria: [Both reads succeed]
rollback: [No mutation was performed]
~~~

Instantiation performs strict substitution and converts the Runbook to the
existing Rust-authoritative PlanStepV3 model. The existing validator still
checks target ownership, registered tools, target compatibility, effects,
dependency cycles, optimistic plan version, and verification evidence.
Instantiation does not execute a step or issue a capability. Literal secret
markers in a Runbook are rejected.

## Experimental MCP stdio

MCP has a second explicit rollout switch and remains off when absent:

~~~powershell
$env:SHELLSPAN_AGENT_V3_ROLLOUT = 'runtime'
$env:SHELLSPAN_AGENT_MCP_EXPERIMENTAL = 'enabled'
pnpm tauri:dev
~~~

Workspace configuration is .shellspan/mcp.json:

~~~json
{
  "version": 1,
  "servers": [
    {
      "id": "inventory",
      "transport": "stdio",
      "command": "inventory-mcp",
      "args": ["--stdio"],
      "enabled": true,
      "credentialRefs": [
        { "env": "INVENTORY_TOKEN", "credentialId": "inventory-token" }
      ],
      "toolPolicies": {
        "read_status": "readOnly",
        "update_status": "externalWrite"
      }
    }
  ]
}
~~~

Only stdio is accepted. Configuration, command/argument count, cwd, schema,
tool count, request, response, time, and result size are bounded. Refresh
starts the executable without a shell, performs MCP initialize and tools/list,
records health/failure count, and can retry after failure. Disable clears
discovered tools; reload reparses the rooted file. Tool descriptions and
schemas are untrusted. Catalogs contain names/descriptions only; input schema
crosses IPC only after agent_v3_get_mcp_tool_schema.

Every tool requires an explicit disabled, readOnly, or externalWrite policy;
unknown tools default to disabled. Discovery and every call require native
confirmation because even a nominally read-only tool starts an untrusted
workspace executable. Calls bind request, user session, call id, server/tool,
exact arguments, target, effect, TTL, and a single-use HMAC capability. The
frozen target is revalidated before execution. Results are bounded, redacted,
stored as separate MCP evidence, and marked untrusted. Failed calls are
recorded honestly.

credentialRefs contain identifiers only. Rust resolves values from the OS
credential service com.shellspan.mcp and injects them into the child
environment. Values do not enter the model, WebView, logs, configuration
snapshots, ordinary results, or viewer. M3 exposes no WebView secret-write
command; provisioning needs an existing native/administrative credential
path. The M4 credential broker UI is not implemented.

Streamable HTTP is not enabled. The repository has no controlled HTTP MCP
fixture or OAuth callback harness, so reliable HTTP/OAuth support is not
claimed.

## Rollout and rollback

Agent v2 remains the default. All M3 commands require the existing explicit v3
runtime stage. Rollback is unchanged:

~~~powershell
$env:SHELLSPAN_AGENT_MCP_EXPERIMENTAL = 'disabled'
$env:SHELLSPAN_AGENT_V3_ROLLOUT = 'disabled'
pnpm tauri:dev
~~~

Unknown values fail closed. M3 does not add Operator, durable checkpoint
reconciliation, background restart recovery, Fleet, or sub-Agent execution.

## Test evidence

M3-specific gates:

~~~powershell
pnpm test:agent:m3
cargo +1.95.0-x86_64-pc-windows-msvc test --manifest-path src-tauri/Cargo.toml context::tests
cargo +1.95.0-x86_64-pc-windows-msvc test --manifest-path src-tauri/Cargo.toml extensions::tests
cargo +1.95.0-x86_64-pc-windows-msvc test --manifest-path src-tauri/Cargo.toml mcp::tests
~~~

They cover strict Schema/unknown fields, four-layer provenance, instruction
eligibility, size/root behavior, structured compaction, redacted retrieval,
progressive Skill loading, target mismatch, Hook modification/denial,
Runbook-to-plan conversion, MCP credential reference isolation, lazy schema,
and failed-to-healthy refresh state. TypeScript IPC tests verify that the
WebView receives opaque capability ids/effective arguments, not claims or
credential references. The viewer test checks provenance and usage without a
secret value.

Rust tests use local temporary directories and an in-memory MCP
failure/reconnect transition. There is no controlled external MCP server or
OAuth environment, so the stdio wire driver is implemented and compiled but
arbitrary third-party interoperability is not claimed as end-to-end evidence.
The isolated SSH/SFTP M2 gate remains the remote file evidence; it is not MCP
evidence.

## Known limits and M4 hand-off

- Context, extension, MCP catalog, and capability state remain process-local.
  Artifacts are reusable within the running task, but restart reconciliation
  is M4.
- Project instruction and extension discovery is local-only.
- Token usage is an estimate; monetary cost is unavailable without provider
  billing metadata.
- MCP starts a bounded process per discovery/call; pooling and Streamable HTTP
  are not implemented.
- There is no native UI for provisioning MCP credential references.
- Runbooks instantiate plans but do not schedule or execute them.
- taskCompleted/taskFailed are defined for the future orchestrator; the
  current M1–M3 task state has only active/cancelled terminal states.

M4 can reuse AgentContextSnapshotV3, ContextArtifactV3,
ExtensionSnapshotV3, HookAuditEventV3, strict Runbook-to-plan conversion,
McpServerSnapshotV3, lazy schema lookup, and the dynamic MCP exact-call
capability digest. Durable serialization must store only metadata and native
credential references, mark in-flight writes needsReconciliation, and never
replay a consumed or unknown MCP write.
