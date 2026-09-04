# ShellSpan Agent Runtime

> Status: Event v4 is the only executable and readable Agent contract. The former frontend model
> loop, compatibility readers, dual-write paths, and lifecycle-as-conversation rendering are not
> part of the product.

> This document describes the current Runtime contract. For end-user workflows, see
> the [Terminal Agent guide](terminal-agent.md). macOS, local HTTP, isolated Linux,
> and configured live-provider results are separate evidence classes. Windows native
> compilation, junction/reparse races and execution still require validation.

## 1. Ownership

Root Session model and permission choices remain editable during conversation. The Runtime
commits `session/model_selected` (a credential-free provider descriptor) and
`session/permission_changed`; replay projects them into the Session header. A model Step
captures one provider/adapter pair and permission prompt for its requests and retries, while
the next Step reads the latest selection. Native tool preparation reads the latest permission;
already prepared calls and pending approvals retain their recorded authorization context.
The composer displays committed Session choices without changing global provider defaults.

Root Session turns have no default Step count limit, matching deepseek-harness: tool
continuations and approval resumes can run until completion, cancellation, a hook rejection,
or a runtime failure. Explicit Step budgets, including subagent budgets, remain enforced.

Image input uses typed refs in user input and Model Surface, durable renderer
drafts, native immutable blobs and verified transient HTTP image blocks. Images
survive compaction/restart separately from text summaries. Bounded, cancellable
path discovery runs through Runtime/IPC and the existing composer; it
shares the Skills project scope and does not attach file contents to Model Surface.

Rust owns Agent business state:

```text
Inbox → Turn → Step → Prompt assembler → Provider adapter → Native tool pipeline
                                             ↓                    ↓
                                   Agent Session Event v4 ←───────┘
```

React subscribes to one committed event window and derives two projections from it:

- **Conversation**: model-visible context and user-readable turn content.
- **Activity**: complete lifecycle, request, retry, tool, recovery, compaction, and orchestration
  diagnostics.

React does not execute tools, estimate provider usage, infer reasoning from answer text, repair
Runtime state, or persist a second Agent record.

The executable implementation lives under `src-tauri/src/agent_runtime/`:

| Boundary | Responsibility |
| --- | --- |
| `runtime.rs` | Session lifecycle, follow-up, steer, cancel, recovery |
| `driver.rs` | Turn/Step loop, request logging, streaming commits, ordered tool dispatch |
| `prompt.rs` | Deterministic system prompt and injected context assembly |
| `event.rs` | Strict Event v4 wire types |
| `session.rs` | Append-only v4 logs, snapshots, paging, archive |
| `model.rs` | Provider capabilities, request bodies, structured streaming and normalized errors |
| `surface.rs` / `compaction.rs` | Model-visible history and structured compaction |
| `tool_pipeline.rs` | Prepare → approve → execute → commit |
| `subagent.rs` | Child Agent and Fleet coordination |

`native/` is a call-scoped execution layer, not another Agent runtime. It owns no Session, Plan,
recovery loop, subagent registry, or Fleet lifecycle.

## 2. Event v4 contract

Every envelope contains `version: 4`, `sessionId`, contiguous `seq`, `timeUnixMs`, optional
`turnId`/`stepId`, and one typed payload. Rust rejects every version other than 4 during
deserialization; TypeScript rejects it before Conversation or Activity projection. There is no
v2/v3 branch, partial recovery, or compatibility parser.

Important event families are:

- lifecycle/control: `session/*`, `agent/*`, `turn/*`, `step/*`, `user/message`;
- model: `request/header`, `request/start`, `request/context`, `request/retry`, `request/failure`, `assistant/chunk`,
  `assistant/message`, `request/usage`;
- tools: `tool/call`, `tool/approval`, `tool/execution`, `tool/result`;
- memory: `context/artifact`, `compaction/*`;
- input preparation: `step/input_claim`, `skill/*`, `question/*`, `file_reference/scope_bound`;
- orchestration: `subagent/*`, `task/*`.

The v4 model contract is deliberately structured:

- `request/header` records provider, model, reasoning effort, request reason, series boundary,
  attempt, the exact system prompt, and the canonical tool schemas. Full snapshots are written
  for the first request, changed configuration, Agent resume, or a new series after surface
  replacement. `snapshotReason` distinguishes these boundaries.
- `request/start` records every model dispatch, including retries, and references the current
  snapshot by `headerRequestId`. Unchanged steps and later Turns inherit that snapshot. Series
  indices span steps and Turns; retry attempts remain scoped to one step. Both events commit in
  the same batch when a new snapshot is needed. Older v4 headers without `snapshotReason` still
  serve as request starts during replay. If pagination excludes a referenced header, Activity
  retains request timing and reports the prompt/tools as unknown until that history is loaded.
- injected messages carry a provenance object with `kind`, display `label`, `producerId`, and
  optional metadata. Supported kinds are `user`, `runtime`, `plugin`, `skill-catalog`,
  `agent-instructions`, `skill-invocation`, `session-reference`, and `form`.
- `assistant/chunk` independently carries `textDelta`, `reasoningDelta`, `toolCallDelta`, and
  provider usage updates.
- `assistant/message` stores provider-ordered `text`, `reasoning`, and `toolCall` blocks together
  with final usage, stop reason, and interruption state.
- unknown usage is an omitted field. A provider-reported zero remains `0`; the two meanings are
  never collapsed.

Durability is commit-before-publish. A failed append publishes nothing and does not advance the
in-memory projection. Snapshots are derived caches; ordered events remain authoritative.

### Model-visible ⇔ logged

Anything sent to a model must have durable evidence, and anything claimed as model-visible must
come from that evidence:

1. The prompt assembler produces one final system prompt and one canonical tool-schema list.
   `driver.rs` uses those values for both the `request/header` event and the provider request.
2. Runtime context, Agent instructions, plugin context, and session references enter
   through committed provenance-bearing messages. Skills use typed catalogue/preparation/result
   facts; question answers become the original call's durable ToolResult. User images remain
   typed immutable refs in durable input and are verified into transient wire blocks at dispatch.
   None of these inputs is reconstructed from UI labels or mutable external files during replay.
3. Assistant reasoning, text, tool calls, and tool results re-enter later requests from committed
   ordered blocks, not from UI state.
4. Compaction replaces model history only after its summary is durable.
5. Renderer-visible provenance, timing, stop reasons, and stats must be projected from events. Text
   inspection and component mount time are not evidence.

`request/context` token fields are deterministic Runtime budget estimates used for admission,
context-meter display, and compaction. They are logged diagnostics, not provider usage. Durable
Turn/Session token statistics use only `assistant/*` or `request/usage` provider facts; missing
facts stay unavailable.

## 3. Conversation, Activity, and Stats

`projectAgentChatNodes` and `projectAgentActivityNodes` consume the same validated, ordered event
window.

Conversation may contain:

```text
systemPrompt
userMessage
turnProcess
  ├─ contextInjection
  ├─ reasoning
  ├─ tool / approval
  ├─ retry
  └─ error
assistantMessage
turnTail
```

Session/Agent/Turn/Step/Request lifecycle is Activity-only. Conversation has no lifecycle marker
type or renderer. A completed Turn folds its process under “Thought”; the final answer and factual
`turnTail` remain visible. Running and incomplete windows remain expanded or partial. Disclosure
identity is scoped by Session, Turn, and answer generation so streaming does not reset user state.

Activity retains stable keyed entities and their ordered raw records. Repeated status events update
the same entity rather than adding duplicate rows. Pagination prepend keeps existing keys, and a
full replay converges to the same projection.

Stats are calculated from Runtime timestamps and provider usage carried by v4 events:

- Turn/Step/Request/tool counts;
- model duration, tool duration, TTFT, and tokens per second when the required timestamps exist;
- uncached input, cache read/write, output, reasoning, and total tokens when providers report them;
- cache hit rate only when its numerator and denominator are both known.

No field is synthesized from another unknown field. Incomplete history is marked incomplete and
does not receive a misleading completed tail.

The UI keeps one `MessageScroller` and the installed `Message`, `Bubble`, `Marker`, `Collapsible`,
and `Separator` primitives. Reasoning is rendered from structured blocks; literal `<think>` text in
a durable text block is not parsed by React.

## 4. Provider capability matrix

| Profile | Request/stream form | Reasoning | Streaming usage request | Usage normalization | History replay |
| --- | --- | --- | --- | --- | --- |
| OpenAI Responses | `/responses` SSE | Structured response reasoning items | No Chat `stream_options`; response usage events are parsed | input/cache-read/output/reasoning/total when reported | Opaque provider reasoning item plus ordered text/tool blocks |
| DeepSeek | OpenAI-compatible Chat SSE at the unversioned official root | V4 `thinking` + `reasoning_effort`; native `reasoning_content` | `stream_options.include_usage=true` | prompt/cache hit/cache miss/output/reasoning/total when reported | `reasoning_content`, text, tools in provider order |
| MiniMax | OpenAI-compatible cumulative Chat SSE | M3 `thinking.type=adaptive/disabled`; M2.x keeps mandatory thinking; `reasoning_split=true`; cumulative `reasoning_content` / `reasoning_details` deduplicated | `stream_options.include_usage=true` | available prompt/cache/output/reasoning/total fields | deduplicated reasoning/text/tools in provider order; oversized UTF-8 deltas are durably chunked |
| Qwen on Model Studio | OpenAI-compatible Chat SSE | Hybrid Qwen3 models use `enable_thinking=true/false`; thinking-only and instruct slugs have no toggle | `stream_options.include_usage=true` | available prompt/cache/output/reasoning/total fields | native `reasoning_content` retained in history; no general cross-turn preservation guarantee or unsupported `preserve_thinking` flag |
| GLM | OpenAI-compatible Chat SSE | GLM 4.5+ uses `thinking.type=enabled/disabled`; GLM 5.2 also accepts reasoning effort | `stream_options.include_usage=true` | available prompt/cache/output/reasoning/total fields | native `reasoning_content`, text, and tools in provider order |
| Generic OpenAI-compatible | Chat SSE | No native reasoning capability; Runtime `<think>` fallback only | Omitted to avoid incompatible parameters | any usage object supplied by the service; otherwise unknown | text/tools; no fabricated reasoning |
| Ollama | `/api/chat` JSON stream | `message.thinking` / equivalent, with Runtime `<think>` fallback | Not applicable | prompt/output counts when reported | ordered text/tool history |

Kimi uses the OpenAI-compatible path but disables `parallel_tool_calls` for its service contract.
Provider capability only controls request and parser behavior; the UI always consumes the same v4
events.

The executable source is the shared `src/lib/provider-contract.json` loaded by TypeScript and
Rust. An explicit profile takes precedence over host inference. Context values are operational
admission budgets, not verified vendor maxima for every model alias.

Request retries retain failed attempts as audit facts without replaying their partial output as
committed assistant/tool content. Provider policy is configurable and restored for child sessions;
connection, first-byte and idle deadlines do not impose a fixed total lifetime on an active stream.
Chat `finish_reason` closes a choice, not the transport: separate later usage frames are consumed
until `[DONE]` or clean EOF. Clean EOF after a finish reason remains valid without usage; usage
stays unknown. Abnormal EOF and idle timeout fail the uncommitted attempt; cancellation wins.
No complete tool or answer is committed twice through recovery. This boundary has gated real HTTP
tests and was verified against MiniMax-M2.7 live, not just single-buffer fixtures.
The local scheduler uses a bounded rolling pool with ordered commits; a Provider's
parallel-tool request flag does not authorize local parallel execution.

## 5. Persistence and incompatibility

Questions persist their identity, answer and exact resumed queue; unsent question-form drafts
are page-lifetime memory. Image drafts use IndexedDB, while normalized immutable PNG blobs live
in `agent-runtime/images-v1`; no automatic blob GC or full ICC color management is claimed.
Image input uses Chat Completions with the exact models in the shared vision contract:
Qwen `qwen3-vl-plus` / `qwen3-vl-flash`, and Kimi Code `k3` / `k3-256k`.
Qwen uses a conservative 128000-token application context cap; Kimi uses 262144 tokens,
the 256K context available to all K3-eligible memberships. K3's 1M context depends on membership.

Skills and @file share the explicitly selected, durable local/remote project identity.
Discovery is shallow and bounded. @file inserts ordinary text, never implicitly reads content
or grants tool permissions. Native/SSH scopes still authorize later reads. SSH discovery requires
the fixed Python 3 helper; unavailability never falls back to local files. User workflows
for Skills, images, and file references are covered in the [Terminal Agent guide](terminal-agent.md).

Active v4 logs are stored under the application data directory at
`agent-runtime/sessions-v4/`; archived logs use `agent-runtime/archives-v4/`. Older namespaces are
left untouched and never listed, read, migrated, imported, or dual-written. An old envelope copied
into a v4 namespace is rejected.

Old sessions are intentionally incompatible. To reclaim their disk space, first quit ShellSpan,
locate ShellSpan's application data directory using the operating system's normal application-data
UI, and move the pre-v4 Agent directories (notably `agent-runtime/sessions-v2/` and
`agent-runtime/archives-v2/`) to Trash after making any desired backup. Do not remove
`sessions-v4`, `archives-v4`, or `artifacts-v2`. This cleanup is optional; leaving old directories
in place has no effect on the v4 Session Browser.

## 6. Verification and release gates

Run the deterministic phase and full repository gates from the repository root:

```bash
pnpm test:ai:phase3
pnpm test:ai:phase4
pnpm test:ai:phase5
pnpm test:ai:phase6
pnpm test:agent:runtime
pnpm test:scripts
pnpm test
pnpm exec tsc --noEmit
pnpm build
pnpm benchmark:ai-panel
pnpm test:ai:stage3
pnpm test:ai:stage4
pnpm test:ai:stage3b
pnpm test:ai:stage5
pnpm test:ai:stage6a
pnpm test:ai:stage6b
pnpm test:ai:stage6c
pnpm test:ai:stage6d
pnpm check:rust:includes
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --all-features --no-fail-fast
git diff --check
```

The AI Panel benchmark retains 5,000 messages (7,500 nodes including Turn process rows),
computes every node revision, and exercises 20 repeated streaming
revisions. The Phase 6 fixture test maps every acceptance scenario to direct Event, Conversation,
Activity, Stats, and visual evidence.
The existing benchmark checks semantic invariants and reports timing; it has no numeric latency
failure threshold.
The entry first runs ordinary workload tests and then rejects missing/non-finite timing or fewer
than five measured samples. A successful experimental benchmark process alone is not PASS.
CI runs portable `stage6:frontend`/`stage6:rust` gates, pinned macOS pixel/browser bridges,
and the Linux-only disposable SSH runners separately. The 6B/6D aggregate commands above need
Docker's Linux engine. Saved macOS pixels are not Windows pixel evidence.

### Visual regression

Verify the complete deterministic pixel and semantic-DOM matrix:

```bash
pnpm test:ai:phase5:visual
```

Baselines live under `docs/ai-panel-phase5/evidence/`. A deliberate update is always one scene at
a time and requires a reviewable reason:

```bash
pnpm test:ai:phase5:visual -- --update <scene-id> --reason "<why the UI changed>"
```

`--update all` is rejected. After any update, rerun the full visual command twice. The harness fixes
time, IDs, locale, timezone, theme, reduced motion, caret/animation behavior, and waits for fonts;
it also rejects external provider requests, overflow, Composer overlap, pixel drift, and semantic
DOM drift.

### Live provider smoke

The live harness never prints credential values and runs only providers whose existing environment
configuration is present. Put local credentials in the gitignored repository-root `.env.local`
file; the package script loads that file automatically:

```bash
# Configure this project's .env.local; never overwrite an existing credential file.
pnpm test:agent:providers:live
```

- MiniMax: `SHELLSPAN_LIVE_MINIMAX_API_KEY`, optional `_BASE_URL` and `_MODEL`.
- DeepSeek: `SHELLSPAN_LIVE_DEEPSEEK_API_KEY`, optional `_BASE_URL` and `_MODEL`; the same key
  runs both thinking-enabled and thinking-disabled OpenAI-compatible smoke cases.
- Optional generic compatible extension: `SHELLSPAN_LIVE_COMPATIBLE_BASE_URL` and `_MODEL`;
  `_API_KEY` is optional.

MiniMax and thinking-enabled DeepSeek checks require non-empty answer text, structured reasoning,
and at least one provider usage fact. The DeepSeek thinking-disabled check requires a non-empty
answer, no reasoning block, and provider usage. The optional generic check proves a normal answer
completes without requiring reasoning or streaming usage. Missing optional configuration is
reported as `SKIP`; it is not counted as passed. Offline recording tests always verify exact system
prompt/tool schemas against the actual request body, generic no-reasoning completion, and
completion when stream usage options are unsupported.
