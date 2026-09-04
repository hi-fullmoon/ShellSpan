# ShellSpan Agent Runtime

> Status: Event v4 is the only executable and readable Agent contract. The former frontend model
> loop, compatibility readers, dual-write paths, and lifecycle-as-conversation rendering are not
> part of the product.

> 2026-09-04 handoff: verified runtime hardening through Stage 5 is integrated into main.
> Structured questions remain unfinished on `codex/ai-runtime-stage6a-wip`; Skills, images,
> and file-reference completion are not implemented on main. Development stopped at the user's
> request. See [handoff and remaining acceptance](ai-runtime-handoff.md); supported source kinds
> and UI fixtures are not proof that a corresponding runtime producer exists.

## 1. Ownership

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
2. Runtime context, Agent instructions, skill/plugin context, forms, and session references enter
   the model surface only through committed `user/message` events with provenance.
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
admission budgets, not verified vendor maxima for every model alias. See the [Stage 4 contract
and semantic checkpoint details](ai-runtime-stage4.md) and [Stage 3B request recovery](ai-runtime-stage3b.md).

Request retries retain failed attempts as audit facts without replaying their partial output as
committed assistant/tool content. Provider policy is configurable and restored for child sessions;
connection, first-byte and idle deadlines do not impose a fixed total lifetime on an active stream.
The Stage 5 local scheduler uses a bounded rolling pool with ordered commits; a Provider's
parallel-tool request flag does not authorize local parallel execution. See [scheduler behavior](ai-runtime-stage5.md).

## 5. Persistence and incompatibility

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
pnpm build
pnpm benchmark:ai-panel
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --all-features --no-fail-fast
git diff --check
```

The AI Panel benchmark projects and revisions 5,000 nodes and exercises repeated streaming
revisions. The Phase 6 fixture test maps every acceptance scenario to direct Event, Conversation,
Activity, Stats, and visual evidence.

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
cp .env.example .env.local
# Edit only .env.local and uncomment the live provider entries you need.
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
