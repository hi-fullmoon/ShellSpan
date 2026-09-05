# LLM Adapter Stage E Implementation Report

## Delivery

- Branch: `codex/llm-stage-e`
- Imported Stage A/B/C/D baseline: `6746c42e19e896ab6a5bbe38215e6dfcfae76493`
- Stage E implementation: `eebc5518b0991cd4136b68216dc7a807274a81a8`
- Source revision before the isolated import: `df1b45397be3e668738dbe0cb0bbcc1fcb620b0c`
- Scope: the Anthropic Messages row in `docs/llm-adapter-architecture.md` section 7 and the Stage E acceptance row in section 11
- Official-document retrieval date: 2026-09-05

## Official sources and protocol decisions

Only Anthropic's official Claude Platform documentation was used for provider behavior and built-in model facts.

- [Create a Message](https://platform.claude.com/docs/en/api/http/messages/create) defines the stable Messages request, `x-api-key`, `anthropic-version: 2023-06-01`, system/messages/tools fields, image blocks, response blocks, usage and stop reasons. ShellSpan sends `POST /v1/messages` and does not translate through an OpenAI-compatible shape.
- [Streaming Messages](https://platform.claude.com/docs/en/build-with-claude/streaming) defines the SSE lifecycle: `message_start`, ordered content-block start/delta/stop events, `message_delta`, and `message_stop`, plus `ping` and streamed `error`. The adapter recognizes only the stable event/block/delta types it can preserve safely and fails closed on malformed, duplicate, out-of-order, mismatched or unknown critical events.
- [Handle tool calls](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls) and [Parallel tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use) require one user message containing every matching `tool_result`, with all result blocks before later user text. The request encoder merges consecutive canonical tool results and user text in exactly that order and preserves the provider `tool_use.id` only as verified same-domain replay metadata.
- [Thinking](https://platform.claude.com/docs/en/about-claude/models/extended-thinking-models), [Adaptive thinking](https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking), and [Effort](https://platform.claude.com/docs/en/build-with-claude/effort) define `thinking: {"type":"adaptive"}`, `output_config.effort`, signed thinking blocks, redacted thinking, interleaving, and the five supported effort levels. ShellSpan never fabricates a signature: same-domain verified history reconstructs the exact signature/redacted placement, while cross-domain reasoning degrades to ordinary canonical assistant text.
- [Models overview](https://platform.claude.com/docs/en/models/overview), [Claude Fable 5.1](https://platform.claude.com/docs/en/models/fable-5-1/overview), [Claude Opus 5](https://platform.claude.com/docs/en/models/opus-5/whats-new-opus-5), and [Claude Sonnet 5](https://platform.claude.com/docs/en/models/sonnet-5/whats-new-sonnet-5) are the sources for the exact built-in IDs and published capacities below.
- [Errors](https://platform.claude.com/docs/en/api/errors) is the source for authentication, permission, rate-limit, API and overloaded classifications and the safe request identifier. Existing shared transport policy remains responsible for `Retry-After`, cancellation and the three independent timeout phases.
- [Beta headers](https://platform.claude.com/docs/en/api/beta-headers) documents opt-in beta behavior. Stage E enables no beta feature and emits no `anthropic-beta` header. Per-message effort, beta tools and beta content types are deliberately out of scope.

## Built-in Anthropic catalog

The following provider-published facts were retrieved on 2026-09-05 and are marked `providerPublished2026-09-05` by the Rust resolver. Model IDs remain exact and aliases are not guessed.

| Claude API model ID | Context window | Max output | Inputs / client tools | Thinking | Effort options |
| --- | ---: | ---: | --- | --- | --- |
| `claude-fable-5-1` | 1,000,000 | 128,000 | text, image, tool use | adaptive, always on | `low`, `medium`, `high`, `xhigh`, `max` |
| `claude-opus-5` | 1,000,000 | 128,000 | text, image, tool use | adaptive | `low`, `medium`, `high`, `xhigh`, `max` |
| `claude-sonnet-5` | 1,000,000 | 128,000 | text, image, tool use | adaptive | `low`, `medium`, `high`, `xhigh`, `max` |

The catalog's 20-image, 20 MiB and 4,096-reserved-token-per-image values are explicit ShellSpan admission limits, not claims about Anthropic's provider maxima or billing. Actual usage is taken from provider events: non-cached `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, and cumulative `output_tokens` remain distinct and total safely.

## Delivered behavior

### First-class protocol and configuration

`anthropicMessages` / `anthropic-messages` is registered as a fourth protocol throughout Rust, route documents, the exact catalog, Event v5 request snapshots, TypeScript DTOs and the existing provider settings surfaces. Event remains v5. The preset uses the origin `https://api.anthropic.com`; endpoint normalization accepts an origin, `/v1`, `/v1/messages`, or `/v1/models` without duplicating a version or operation path.

Anthropic routes require a non-empty versioned keychain credential. Requests send only `x-api-key` and `anthropic-version`; they never send bearer authorization. Model discovery separately uses `GET /v1/models` with the same stable headers and fails before the network when the credential is missing. Neither route documents, request snapshots, replay envelopes nor UI provider state contain the key.

The existing shadcn/Base UI settings shell was extended in place with an Anthropic preset, protocol label, endpoint preview, route adapter mapping and localized English/Chinese copy. No parallel design system or protocol-specific configuration store was introduced.

### Request conversion and tool history

The adapter serializes the system prompt separately, converts canonical text and immutable resolved images to native Messages blocks, emits tools as `name`/`description`/`input_schema`, and selects stable automatic tool choice. Assistant text, signed thinking, redacted thinking and multiple `tool_use` blocks retain order. Consecutive canonical tool results become a single user message and precede any following user text, including when several calls were returned in one assistant turn.

Image data URLs exist only at the final transport boundary. The replay capture stores no pixels or base64 source. Unsupported media, missing resolved data and empty image content fail before the request.

### Strict SSE, usage and failures

The SSE accumulator validates message and content-block sequencing, contiguous provider indexes, one open block at a time, matching SSE event names and JSON `type`, signed thinking completion, bounded safe provider IDs, bounded tool arguments, complete JSON objects, stop reasons and terminal `message_stop`. Hidden redacted-thinking blocks do not consume public output indexes, so streamed text/reasoning/tool deltas match the final canonical block indexes.

It supports text, thinking/signature, redacted thinking and multiple incremental tool inputs. Provider usage is merged across `message_start` and `message_delta` without treating the cache fields as interchangeable. `end_turn`, `stop_sequence`, `tool_use`, output/context limits and refusal map to existing normalized finish/error behavior.

HTTP 401/403, 429 and 5xx plus streamed authentication, permission, rate-limit, overloaded and generic API errors map to existing normalized classes. A validated `request-id`/`request_id` is retained for diagnosis; response bodies and transport errors continue through shared secret redaction. Header timeout, first-byte timeout, stream-idle timeout and cancellation use the existing transport primitives and stable error codes.

### Replay and isolation

The Anthropic `ReplayCodec` allowlists only response message/model identity, per-block thinking signatures, redacted-thinking placement and provider tool IDs. Metadata is type checked, byte bounded, credential-key rejected and embedded-data rejected before persistence. Same-domain restart restores the exact signature, redacted blocks and tool IDs before native request encoding.

Every prepared request first strips native metadata through the Stage D generic projection. A different endpoint/account/model/replay domain therefore sends only canonical content: no prior Anthropic signature, redacted-thinking payload, response identity or provider tool ID is present on the actual encoded wire. Canonical tool calls and results remain usable. Public Event v5 projections continue to omit all replay/native fields.

## Validation

The final implementation tree passed the following checks on Windows. Rust commands used `cargo +1.95.0-x86_64-pc-windows-msvc` (or `RUSTUP_TOOLCHAIN=1.95.0-x86_64-pc-windows-msvc` inside the aggregate script) and `CARGO_TARGET_DIR=D:/Developer/ShellSpan/src-tauri/target`.

- `pnpm test:ai:stage-e`: passed. This includes the inherited Stage C/D catalog, schema, frontend, route/migration/runtime and replay gates; the Stage E catalog/route schema fixture; 7 frontend files with 65 tests; 6 offline Anthropic adapter tests plus 1 explicit live ignored test; 1 discovery wire test; 7 replay tests; and 9 route tests.
- `cargo +1.95.0-x86_64-pc-windows-msvc test --manifest-path src-tauri/Cargo.toml --lib --locked --no-fail-fast`: 652 passed, 0 failed, 26 explicitly ignored external-environment tests.
- `pnpm test -- --maxWorkers=1`: 188 files passed and 1 skipped; 1,630 tests passed and 1 skipped.
- `pnpm exec tsc --noEmit`: passed.
- `pnpm build`: passed. Vite emitted only the existing large-chunk advisory and Node's experimental localStorage warning.
- `cargo +1.95.0-x86_64-pc-windows-msvc check --manifest-path src-tauri/Cargo.toml --lib --locked`: passed.
- `cargo +1.95.0-x86_64-pc-windows-msvc fmt --manifest-path src-tauri/Cargo.toml -- --check`: passed.
- `git diff --check`: passed before the implementation commit. Generated Tauri schema files had no semantic diff and were not committed.

Controlled local HTTP tests assert the complete request line, stable headers and absence of beta/bearer headers; exact system/image/thinking/tool/result bodies; the `/v1/models` discovery route; incremental reasoning/text/two-tool streams; redacted replay; cache usage; HTTP and SSE error classes; three timeout phases; cancellation; endpoint normalization; and absence of keys or image data in durable replay. Malformed, duplicate, out-of-order, unknown and truncated events are negative fixtures.

No `ANTHROPIC_API_KEY`, `SHELLSPAN_LIVE_ANTHROPIC_API_KEY`, `.env`, or `.env.local` was present in the validation environment. The ignored `live_anthropic_messages_basic_round` test is therefore not counted as passed and no real Anthropic service compatibility claim is made by this report.

## Risks and deferred work

- Live-provider evidence remains missing until an authorized `SHELLSPAN_LIVE_ANTHROPIC_API_KEY` is supplied locally. Offline wire and parser evidence is complete, but it is not a substitute for a real service response.
- Unknown future stable SSE/content variants fail closed until explicitly reviewed. This is intentional for durable replay safety but can require an adapter update when Anthropic adds a new block type.
- Server-executed tools, beta tool versions, beta content blocks, structured-output beta behavior and per-message effort are not enabled. Supporting any of them requires an explicit feature decision, beta header policy, replay schema and negative fixtures.
- Only the three exact current IDs above are built in. Discovery returns candidates but does not infer capabilities; any other model requires a declared definition or a later catalog update sourced from official documentation.
