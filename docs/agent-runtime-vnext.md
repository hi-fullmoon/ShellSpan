# ShellSpan Agent Runtime

> Status: implemented as the only executable Agent architecture. The former frontend-driven
> model loop, independent task control plane, compatibility bridge, and milestone-specific UI
> surfaces have been removed. Legacy AI-session Agent records can only be read during import.

## 1. Ownership

Rust owns every piece of Agent business state:

```text
Inbox → Turn → Step → Model Adapter → Native Tool Pipeline → Agent Session Event Log
                      └──────────────→ Child Agent / Fleet ──────────────┘
```

React subscribes to the committed event stream, backfills gaps, and derives Conversation and
Activity from the same ordered events. It never executes tools, submits tool results, repairs
business state, or persists a second Agent record.

The executable implementation is under `src-tauri/src/agent_runtime/`. The principal boundaries
are:

| Boundary | Responsibility |
| --- | --- |
| `runtime.rs` | Session creation, lifecycle ownership, follow-up, steer, cancel, recovery |
| `driver.rs` | Turn/Step loop, model requests, stopping checks, ordered tool dispatch |
| `session.rs` | Append-only event log, snapshots, paging, archive, read-only legacy import |
| `model.rs` | OpenAI Responses, OpenAI-compatible Chat Completions, Ollama, normalized errors |
| `tool_pipeline.rs` | Prepare → approve → execute → commit; Session tools and parallel read barriers |
| `surface.rs` / `compaction.rs` | Model-visible projection, budgets, structured compaction |
| `subagent.rs` | Real child Agents, settlement, and canary/wave Fleet coordination |
| `native/` | Call-scoped policy/capability checks plus filesystem, PTY/process, MCP, and evidence |

`native/` is deliberately not a second Agent runtime. It has no task store, plan owner, result
store, recovery loop, subagent registry, or Fleet lifecycle. Each call arrives with an immutable
Session/Turn/Step context and returns one bounded result. The primary Session pipeline owns
`update_plan` and commits it directly as a monotonic `task/plan` event; it never enters Native.

## 2. Identity and lifecycle

An Agent Session has stable `sessionId` and `taskId` values. A live Agent owns its provider,
cancellation token, phase, inbox, and exactly one loop task. The registry rejects duplicate
attachment and the runtime makes repeated start requests idempotent for an already-attached
session.

Lifecycle transitions are fail-closed:

```text
idle → running ↔ waiting → completed | failed | cancelled
```

- `followup` queues user input for the next turn.
- `steer` queues user input for the next safe step boundary.
- `inject` records trusted runtime input without impersonating a user.
- cancellation propagates model request → approval wait → tool/process → descendants, then commits
  one terminal event.
- an ended session cannot execute again; a new task receives a new Session identity.

## 3. Event log contract

The append-only log is the sole durable business-state source. Every event has a version,
`sessionId`, contiguous `seq`, timestamp, and optional Turn/Step identity. Important families are:

- lifecycle: `session/created`, `agent/status`, `session/ended`;
- control: `agent/inbox/spliced`, `user/message`, `turn/*`, `step/*`;
- model: `request/header`, `request/context`, `request/retry`, `assistant/chunk`,
  `assistant/message`;
- tools: `tool/call`, `tool/approval`, `tool/execution`, `tool/result`;
- memory: `context/artifact`, `compaction/summary`;
- orchestration: `subagent/*`, `task/state`.

Durability follows commit-before-publish. A failed append does not publish an event or advance the
in-memory state. Terminal events are idempotent. Snapshots are projections and never replace event
ordering authority.

The browser client subscribes first, reads the snapshot, pages committed events with `afterSeq`,
then merges buffered live frames. Gaps trigger bounded backfill or a full resync. A terminal state
is accepted only after the terminal event is present.

## 4. Model and tool pipeline

Every model request is rebuilt from the current Session surface plus strict tool schemas. Provider
adapters do not own history. Errors normalize into cancellation, retryable, context-too-large,
authentication, rate-limit, or terminal classes.

MiniMax cumulative stream fragments are merged without duplication. All provider tool calls are
retained in provider order. The pipeline executes calls in that order, while adjacent independent
read-only calls may share a bounded parallel group. Writes, sensitive reads, destructive calls,
external side effects, approvals, and same-target conflicts establish barriers.

Every tool follows one path:

```text
schema → frozen target → effect classification → policy/capability → approval
       → native execution → bounded result/artifact/evidence → committed event
```

The WebView cannot mint approval authority. Approval identifiers bind Session, Turn, Step, model
request, call, target, digest, expiry, and use count; dispatch revalidates them. Secret input,
target drift, stale digest, symlink escape, and uncertain recovery fail closed.

Workspace MCP calls use the same pipeline through `call_mcp_tool`. The runtime reads the bounded
`.shellspan/mcp.json` configuration first, presents a conservative external-side-effect approval,
and only after approval starts the configured stdio server, discovers the exact enabled tool,
loads its schema, brokers referenced credentials inside Rust, and commits the untrusted result.

The static Native manifest contains exactly nine OS-effect tools: command execution, process
input/wait/kill, file read/list/search/patch, and file transfer. UI, planning, task, child-Agent,
and Fleet operations are primary-runtime concerns and are absent from the Native contract.

## 5. Context, recovery, and orchestration

The model surface is a deterministic projection of committed events. Token estimation includes
system instructions, tool schemas, messages, and provider/model limits. Compaction creates a
versioned structured summary and advances a surface generation only after its artifact is durable.

Recovery checkpoints describe the last committed sequence and whether model, approval, execution,
tool result, compaction, or artifact work was open. Non-idempotent or uncertain execution requires
explicit reconciliation evidence; it is never silently replayed.

One-shot and continuable child Agents use the same runtime, model, pipeline, event vocabulary, and
recovery rules. Capability and target scopes may narrow but never widen. Fleet coordination uses
real per-target children, durable canary/wave state, failure thresholds, and independent verifier
evidence.

## 6. React projection

`src/lib/agent-session-client.ts` is the subscribe-first committed-stream client.
`src/lib/agent-session-projection.ts` contains pure Conversation and Activity projections.
`src/components/ai/agent-session-view.tsx` renders shadcn `Tabs` with:

- Conversation: user/assistant messages, markers, collapsible tool cards, and approval dialogs;
- Activity: Agent tree, Turn/Step timeline, request usage, plan, context/artifacts, recovery, and
  Fleet state.

The existing approval card content and its collapsible interaction are preserved. Settings and the
composer call only typed `agent_runtime_*` commands. Ask remains a separate read-only AI feature and
is never an Agent fallback.

## 7. Persistence and compatibility

New Agent data is written only to the Agent Runtime Session log and bounded artifact stores.
Former AI-session Agent records are exposed as opaque read-only import data; there is no append,
approval, execution, resume, or dual-write path for them. Runtime rollback is performed by
installing an earlier application version, not by switching engines in-process.

## 8. Verification

Required gates:

```bash
pnpm test:agent:runtime
pnpm test:scripts
pnpm test
pnpm build
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --all-features --no-fail-fast
```

Live OpenAI, Kimi, MiniMax, and Ollama basic-round checks are `#[ignore]` tests and require their
documented `SHELLSPAN_LIVE_*` environment variables. Isolated SSH/SFTP acceptance remains ignored
unless its Docker fixture is explicitly started.
