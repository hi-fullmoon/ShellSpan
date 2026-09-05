# LLM Adapter Stage D Implementation Report

## Delivery

- Branch: `codex/llm-stage-d`
- Imported Stage A/B/C baseline: `56c7a15f53be107dc7644d6b2d7e1d108d804ab4`
- Stage D implementation: `7f2d415bb467e0a9c467ad189e67118e31bc049e`
- Source revision before the isolated import: `df1b45397be3e668738dbe0cb0bbcc1fcb620b0c`
- Scope: `docs/llm-adapter-architecture.md` section 7 and the Stage D acceptance row in section 11

## Delivered behavior

### Strict Event v5 replay envelope

Stage D completes the existing Event v5 `ReplayEnvelope`; it does not introduce Event v6. A prepared envelope is versioned globally and per adapter, and binds the response to the exact successful `request/start`, its referenced frozen `request/header` snapshot and digest, route revision, model, replay domain, request content hash, projection policy, immutable image references and image projection hash. It also records an assistant-content hash and an indexed, typed, per-block content hash.

The Session transition validator resolves the last `request/start` in the same Step, not merely the first request header. This makes a retry response valid only for the attempt that actually produced it while retaining the same frozen snapshot. Missing capture, unknown versions, adapter mismatch, source mismatch, content or block corruption, image drift, and provider tool-ID mismatch fail closed with stable replay error codes.

Whitespace-only text or reasoning blocks are removed together with their matching adapter metadata before hashing. The envelope hashes the same redacted content projection that the event store commits, while raw tool arguments remain available to existing policy and redaction-collision validation. This prevents either whitespace normalization or durable sanitization from changing the committed value after its replay hash is created.

Legacy converted history remains explicitly `legacyUnknown`. Archived provider items from that path can be preserved as historical evidence but are never executable replay authority.

### Adapter-owned native replay

`ReplayCodec` makes the active adapter the sole owner of native metadata validation and restoration. The generic Agent projection never passes through a historical `Reasoning.provider_item` or provider-native tool ID.

- Chat Completions stores only allowlisted response identity/model/system fingerprint fields, allowlisted reasoning-detail items, and the provider-native ID associated with a canonical tool call.
- Responses stores only allowlisted response identity/model fields, allowlisted native reasoning items, and provider-native tool/item IDs. A verified same-domain response may use `previous_response_id`; the request then sends only messages after the matching assistant boundary. No unverified ID can select this wire path.
- Ollama stores only its allowlisted response completion fields and provider-native tool IDs.

Metadata must satisfy adapter-specific object shapes, global byte bounds, credential-key rejection, and embedded-data rejection. There is one registry switch for adapter-to-codec lookup; the Agent loop and tool scheduler contain no protocol-specific replay branch.

### Same-domain restore and cross-domain projection

Every prepared request first removes all native reasoning state, provider call IDs, replay envelopes, and transient restored state from history. Only after adapter ID, adapter replay format, route ID, model ID, and persisted replay domain all match does the active codec restore its allowlisted native fields. The envelope is then removed from the prepared request so adapters receive only their native projection and canonical history.

Provider-native tool IDs are mapped from assistant calls to their matching tool results as one verified chain. Adapter call IDs are preserved when unique; a new response ID that collides with history is replaced by a request-scoped canonical ID before commit. Duplicate calls, orphan or duplicate results, and unfinished calls return `HISTORY_INCOMPATIBLE`; the runtime does not silently delete a result. Cross-domain history keeps canonical text, reasoning text, tool calls, and results, but sends no old signature, native item, response ID, or provider tool ID.

Route replay identity continues the Stage C policy: display-name and timeout edits retain the domain, while endpoint, adapter, authentication/credential, compatibility/model declarations, or preset protocol semantics rotate it. Tests cover the preset case explicitly.

### Persistence, restart, and public projection

The durable Event v5 log and backend-only `all_events` retain the validated replay envelope needed after restart. Derived internal surfaces retain it only as non-serializing state. Public event pages clone and scrub replay envelopes, reasoning provider items, and provider-native tool IDs while preserving canonical `callId` and all displayable content.

A restart test commits a response after two attempts, proves the envelope binds only the second request ID, verifies disk/raw state retains the private signature, verifies the UI page does not expose it, reopens the Session store, and proves the same-domain codec can restore the signature. Corrupted persisted content and an envelope rebound to the earlier attempt are rejected by the production Session validator.

## Validation

The final implementation tree passed these checks on Windows with `RUSTUP_TOOLCHAIN=1.95.0-x86_64-pc-windows-msvc` and `CARGO_TARGET_DIR=D:/Developer/ShellSpan/src-tauri/target` for Rust commands:

- `pnpm test:ai:stage-d`: passed. The inherited Stage C gate validated 54 exact catalog models and rejected 4 negative fixtures, validated the v5/route schemas, passed 8 frontend files with 109 tests, and passed 8 route, 6 migration, 1 prepared-call, 1 cold-subagent, and 1 local-HTTP credential-rotation Rust test. The Stage D gate validated 1 positive and 7 negative envelope-schema fixtures, passed 7 replay corruption/domain/tool/image tests, 1 controlled local-HTTP cross-domain wire test, and 1 UI/raw/restart test.
- `cargo +1.95.0-x86_64-pc-windows-msvc test --manifest-path src-tauri/Cargo.toml --lib --locked -- --test-threads=1`: 644 passed, 0 failed, 25 explicitly ignored tests.
- `pnpm test -- --maxWorkers=1`: 188 files passed and 1 skipped; 1,629 tests passed and 1 skipped.
- `pnpm exec tsc --noEmit`: passed.
- `cargo +1.95.0-x86_64-pc-windows-msvc check --manifest-path src-tauri/Cargo.toml --lib --locked`: passed.
- `cargo +1.95.0-x86_64-pc-windows-msvc fmt --manifest-path src-tauri/Cargo.toml -- --check`: passed.
- `pnpm build`: passed. Vite emitted only its existing large-chunk advisory and Node's experimental localStorage warning.
- `git diff --check`: passed. Generated Tauri schema files have no semantic diff.

The cross-domain wire test uses a controlled local HTTP server and asserts that old Responses response IDs, reasoning native items/signatures, and provider tool IDs are absent while the canonical tool chain remains usable. Live OpenAI, DeepSeek, Qwen, GLM, MiniMax, and Ollama tests were not run because no provider credentials or local model service were authorized; the 25 ignored tests remain explicit and are not counted as passed.

## Deferred work

Stage E still owns the Anthropic Messages adapter and its adapter-specific replay codec. Stage D adds no Anthropic branch and makes no live-provider compatibility claim beyond the existing ignored smoke tests.
