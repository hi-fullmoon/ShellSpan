# Agent Runtime stage 4: provider contract and semantic compaction

The stage 1–3 baseline was copied from `fed7` at commit `4f353d9bbfa2c6ccfe75a1023f4df46ab4fb8412`. All 20 modified tracked files and the untracked `agent_runtime/retry.rs` were copied byte-for-byte. The migration manifest records SHA-256 per file; the two binary Git diffs were also compared before stage 4 edits. The source worktree and `D:/Developer/deepseek-harness` are read-only references.

## Contract and migration

`src/lib/provider-contract.json` is the version 1 authority consumed directly by TypeScript and Rust (`include_str!`). It declares protocol, tool/schema support, permitted reasoning options and wire encoding, reasoning parsing/replay, stream usage, cumulative streams, and operational context/output budgets. `provider-contract-fixtures.json` is an independent expected wire matrix consumed by both test suites. Rust also round-trips every JSON capability to detect dropped fields.

Resolution order is explicit `profile`, then a named frontend preset during migration, then protocol and an exact official hostname, finally `generic`. The frontend persists and sends the resolved profile. Explicit `generic` is authoritative even at an official URL. Changing a proxy URL cannot change an explicitly selected profile. Old anonymous compatible proxy configurations remain generic and can choose a profile in the setup dialog. No provider is selected by substring matches against arbitrary URLs.

An explicit profile must agree with the configured protocol. Unknown profiles and unsupported reasoning options are rejected before streaming. The frontend omits a stale reasoning option when a model change makes it unsupported; the stored preference is retained so switching back restores it. Unknown models have no thinking control. Profile selection, model selector controls, connection configuration, and backend adaptation consume the same contract.

The setup dialog provides Qwen and GLM presets and an explicit profile selector for custom endpoints. Endpoint preview follows the backend's DeepSeek and GLM root exceptions, retains complete proxy endpoint roots and query parameters, and strips fragments. URL validation still prohibits embedded credentials and non-loopback HTTP.

Context values are **operational estimation budgets**, inherited conservative defaults, not verified maximum context claims for every model alias. Output is capped at 4,096 tokens. The stage 2 legacy `context-N`/`ctx-N` model/id hints remain compatible. Model discovery does not invent capabilities from model-list responses. Unknown compatible services omit optional stream usage, thinking, strict, and parallel-tool fields.

## Provider behavior

| Profile | Implemented behavior and limits |
| --- | --- |
| OpenAI | Responses protocol; nested `reasoning.effort` only for the listed model families; strict function schema; opaque Responses reasoning items preserved; stream usage. |
| DeepSeek | Chat Completions; V4 `off/low/high/max`; enabled/disabled `thinking` paired with supported effort; all assistant `reasoning_content` retained, including assistant turns without tools. |
| MiniMax | Chat Completions; M3 `off/on` maps to disabled/adaptive; M2 has no invented toggle. `reasoning_split` separates reasoning; opaque `reasoning_details` are stored and replayed, including metadata. Existing cumulative text/tool-fragment handling remains. |
| Qwen | Native reasoning parsing is independent of a thinking toggle. `*-thinking` has no toggle and reasoning-only SSE remains meaningful output; `*-instruct` has no thinking toggle. Qwen3 switchable variants use `enable_thinking`. History reasoning is retained, but cross-turn preservation is not claimed: no unsupported `preserve_thinking` is sent. |
| GLM | Supported 4.5–5.2 families use `thinking`; 5.2 effort options follow the existing supported list. Preserved reasoning uses `thinking.clear_thinking=false` and original ordered assistant reasoning. |
| Kimi | Coding profile retains reasoning and usage; K3 exposes low/high/max. No parallel-tool-call flag is sent. A proxy can explicitly select this profile. |
| Ollama | Native `/api/chat`, `think` for the listed model families, `options.num_predict`, native usage and tool history. |
| Generic | Conservative Chat Completions; tools and text/think-tag fallback; unsupported optional fields omitted. |

Parallel-call capability means permission to send a provider wire declaration. This stage does not change the existing adjacent parallel groups and `join_all` in local tool execution. Chat-compatible providers conservatively omit the wire declaration. Stage 5 owns a bounded rolling pool, scheduling budgets and cancellation settlement. No attachments or skills UI were added.

Primary references checked during the audit:

- [DeepSeek thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/): thinking/effort and assistant reasoning replay.
- [GLM thinking mode](https://docs.z.ai/guides/capabilities/thinking-mode): preserved thinking and complete ordered replay.
- [Qwen deep thinking](https://help.aliyun.com/en/model-studio/deep-thinking): switchable versus thinking-only models; model-specific preservation support.
- [MiniMax OpenAI interface](https://platform.minimax.io/docs/api-reference/text-openai-api): split reasoning and complete details history.

Local Harness references were `packages/llm/llm-deepseek/src/serialize.ts`, its serialization/translation fixtures, `llm-pi-ai` compatibility fixtures, and `packages/compaction/compaction-basic`. Its attachment/plugin architecture is outside this stage.

## Semantic checkpoint algorithm

Runtime compaction uses the current provider's `ModelAdapter`; there is no second HTTP client or unmanaged request route. Existing request-header, first-byte, idle timeouts and normalized model errors apply. Stage 3B extends the original stage 4 behavior: the Provider's persisted `RetryPolicy` and cancellable delay apply to partial summary failures too. Each retry has a new request ID, retains error provenance, discards failed synthesis, and remains inside the same cumulative input budget and total deadline. See [stage 3B](ai-runtime-stage3b.md).

The semantic input is the last committed checkpoint plus subsequent source conversation, including complete user and assistant messages and tool call/result evidence. It does **not** use the stage 2 eight-message/head-truncated constraint list as its sole input. Complete source is regrouped at UTF-8 boundaries using the actual Provider input budget (up to roughly 46 KiB of new source per request, reserving room for prior synthesis). Validated synthesis is carried forward between fragments. Later user revocations can supersede earlier constraints. Older decisions and reasons survive through the prior committed checkpoint after restart.

Bounds: at most sixteen fragments, 64 KiB per assembled request, 512 KiB cumulative input across requests and retries, a 1 MiB source-collection ceiling, 16 KiB of emitted reasoning/text per call, and the provider output-token limit. A 45-second deadline covers the entire synthesis, including retries. This deadline can expire during ordinary long reasoning: it is an operational cost/latency cap, not a claim that the Provider failed. A >100 KiB regression exercises the semantic path; truly excessive input leaves the current Surface unchanged. The model must emit a JSON object with seven required arrays: latest constraints, completed work, unfinished work, decisions/reasons, files/commands, blockers, next steps. Unknown fields, missing/empty sections, oversized items, tool calls, incomplete completion, excessive usage, and oversized output are rejected. A valid schema does not prove factual truth; canonical scope, generation, source counts, goal, tool outcomes and evidence references remain source-owned, and model claims remain untrusted.

Semantic fields are merged into the structured checkpoint before budget admission. Semantic fields are never silently clipped by equal per-section quotas: the complete summary must fit the target. Empty/illegal/failed/timed-out/over-budget synthesis uses a safe unchanged-Surface fallback: store attempt provenance, record the failure, and do not commit a replacement checkpoint or advance generation. Cancellation also keeps the current Surface. The stage 2 deterministic renderer remains available for its regression fixtures, but production compaction uses the semantic path.

The content-addressed checkpoint artifact contains source fragments, validated summary, profile/model, exact internal model requests, responses or normalized errors for each attempt, and fallback reasons. A Session `ContextArtifact` event references that artifact and hash alongside the atomic summary/generation batch. Credentials are excluded and artifact redaction applies. Cancellation is checked before model work, after semantic work, after artifact creation and immediately before committing a checkpoint batch. An attempted cancelled request can retain an audit artifact without committing a checkpoint; the driver preserves Cancelled settlement rather than turning it into Failed. An artifact created just before cancellation can remain unreferenced for the existing cleanup path; no checkpoint generation is committed.

## Gates and remaining stages

`test:ai:stage4` runs the frontend contract/migration/UI tests and Rust provider/wire/compaction tests. CI invokes this in addition to the retained stage 3 gate (which includes stages 1 and 2). The complete Rust library, frontend test suite/build, formatting, diff checks and all-target Clippy are recorded separately in the validation report.

Live smoke only reads this project's `SHELLSPAN_LIVE_*` variables and optional `.env.local`. Missing configuration is reported as SKIP and counted separately from executed tests. Qwen/GLM/Kimi/OpenAI were added to the smoke list alongside the existing providers.

Stage 5 still owns replacement of the existing adjacent parallel groups with a bounded rolling pool, ownership/order coordination, scheduling budgets and cancellation settlement. Stage 6 still owns Harness attachment representations, skills integration and broader capability/plugin support. Model catalogs and additional vendor features require new verified contract entries and fixtures; this stage does not imply support for unlisted options.
