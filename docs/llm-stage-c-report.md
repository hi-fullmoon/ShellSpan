# LLM Adapter Stage C Implementation Report

## Delivery

- Branch: `codex/llm-stage-c`
- Imported Stage A/B baseline: `4d915278f1d475c09dce1a8221b7eb84e763608b`
- Stage C implementation: `4c9ef70fed3ab6c21f54b7ef66d9f4e9c19bab61`
- Source revision before the isolated import: `df1b45397be3e668738dbe0cb0bbcc1fcb620b0c`
- Scope: `docs/llm-adapter-architecture.md` sections 4, 5, 9, 10, and 11

## Delivered behavior

### Routes, models, and selections

`RouteStore` is the authoritative backend store for secret-free `ProviderRoute` documents and exact `ModelSelection` values. It validates route IDs, adapter IDs, URLs, typed compatibility settings, model declarations, model overrides, reasoning choices, and default selections before publication. `models` and `modelOverrides` are mutually exclusive, overrides must name an existing catalog model, and model IDs retain their original case.

Route saves use SQLite compare-and-swap against the document revision. A candidate is fully validated, new credentials are written under versioned keychain references, the database commits the new document and one-time legacy backup, and the validated `Arc<RouteSnapshot>` is then swapped into memory. Stale writers receive `REVISION_CONFLICT`. Missing credentials fail with `MISSING_CREDENTIAL`; no other route, provider ID, or environment secret is consulted.

Legacy `ai.providers` entries migrate once into separate routes without merging connections. Invalid entries remain in migration diagnostics and the original document is backed up. Endpoint, adapter, compatibility, model, authentication, or credential changes rotate the route replay domain. Display-only and timeout edits do not claim a new identity.

### Prepared request lifecycle

Each Step resolves one `PreparedModel` before pre-step hooks and execution. The object freezes the validated route revision, adapter, endpoint, model capabilities, compatibility behavior, retry policy, timeouts, and resolved credential. Preparation checks the route revision again after credential lookup so a concurrent save cannot produce a mixed configuration.

`PreparedCall` performs history and image projection once and owns the logical request content. Ordinary transient retries reuse it and change only request/attempt identity. A context overflow followed by compaction discards the call and prepares a new snapshot because the content changed. Image preparation finishes before request header/start events are committed.

Every request header contains a deterministic, secret-free `RequestSnapshot` and SHA-256 digest. The snapshot records route and replay identity, adapter and model, catalog capabilities, effective limits, reasoning, retries, timeouts, purpose, projection algorithm, content hash, and immutable image references. `PreparedModel` and `PreparedCall` do not implement `Debug` or `Serialize`.

### Event v5 and offline conversion

The runtime now reads and writes only Event v5 under `sessions-v5` and `archives-v5`; Rust and TypeScript readers reject v2-v4. Event v5 includes the request snapshot fields and the reserved `ReplayEnvelopeV5` shapes required by Stage D. Subagent model state stores only route/model selection and route revision.

The explicit v4-to-v5 converter keeps the source and attachments, creates a one-time backup, uses an exclusive marker, and publishes a same-directory temporary file with no-clobber semantics. It runs the decoded result through the exact production `AgentSessionRecord::from_events` replay validator before publication, covering envelope, state transitions, payloads, redaction, inbox/surface derivation, and final invariants. Existing targets must pass the same validation before the command reports `alreadyConverted`. Failed conversion leaves the source intact and retains its marker for diagnosis; a stale marker beside an already valid published target is removed on the next idempotent run.

The converter preserves sequence numbers, request provider/model identity, image references, tool calls, results, and approval state. Missing historical request facts become `legacyUnknown`; unknown replay metadata is archived and cannot execute. Tests verify illegal state rejection, digest-corrupt destination rejection, exclusive marker behavior, idempotence, and byte-for-byte attachment preservation.

### Settings and session UI

New Tauri commands list and save routes, list effective route models, resolve an exact selection with revision checking, and list/run offline session migrations. Model discovery accepts only the explicit draft key or the selected route's exact versioned credential.

The settings UI manages connections with multiple models, default selection, add/edit/delete actions, key rotation or removal, and v4 migration status. The model selector groups models by route identity and uses backend capability DTOs for reasoning options. Stale model-list responses are ignored. Existing sessions retain their frozen selection; a blank session uses the backend route default, while a deleted or stale selection remains visible as invalid and never silently falls back.

`aiSettingsStore` now persists only its unrelated `contextLines` preference. Route state and credentials flow exclusively through `llmRoutesStore` and backend route commands, and failed route saves do not write a legacy preference copy.

## Validation

The final tree passed these checks on Windows with `RUSTUP_TOOLCHAIN=1.95.0-x86_64-pc-windows-msvc` and `CARGO_TARGET_DIR=D:/Developer/ShellSpan/src-tauri/target` for Rust commands:

- `pnpm test:ai:stage-c`: catalog 54 models accepted and 4 negative fixtures rejected; v5/route schemas passed; 8 frontend files and 109 tests passed; 7 route, 6 migration, 1 prepared-call, 1 cold-subagent, and 1 real-HTTP credential-resume Rust tests passed.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib --locked`: 634 passed, 0 failed, 25 explicitly ignored tests that require isolated SSH/browser fixtures or live provider services.
- `pnpm test -- --maxWorkers=1`: 188 files passed, 1 skipped; 1,629 tests passed, 1 skipped.
- `pnpm exec tsc --noEmit`: passed.
- `cargo check --manifest-path src-tauri/Cargo.toml --lib --locked`: passed.
- `pnpm build`: passed. Vite reported only its existing large-chunk advisory and Node's experimental localStorage warning.
- `git diff --check`: passed. Generated Tauri schema files have no semantic or line-ending diff.

The real-HTTP Stage C test uses a local controlled server and proves that restart plus credential rotation uses the new exact route key while retaining prior tool history. Live OpenAI, DeepSeek, Qwen, GLM, MiniMax, and Ollama smoke tests were not run because no provider credentials or local model service were authorized for this task; they remain separate from the offline fixture and local transport validation.

## Deferred work

Stage D still owns validation and population of protocol-native replay metadata. Stage C only reserves the v5 envelope and identity fields, so no cross-route native-signature replay behavior is claimed here.

Versioned credentials referenced by published or in-flight prepared routes are retained. Automated lifecycle garbage collection for superseded keychain versions is deferred until the runtime can prove that no prepared call or persisted route still references them.
