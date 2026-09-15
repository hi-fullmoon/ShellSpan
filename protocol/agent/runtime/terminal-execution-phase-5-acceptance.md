# Terminal Execution Phase 5 Acceptance Evidence

Updated: 2026-09-16 (Asia/Shanghai)

Session: `01a0a566-6a29-74a3-945e-cc310a46cecd`

Roadmap: [Terminal Execution Roadmap](./terminal-execution-roadmap.md)

Protocol: [Terminal Session Protocol v1](./terminal-protocol-rfc.md)

Matrix: [Terminal Execution Platform Test Matrix](./terminal-execution-test-matrix.md)

## Scope and final gate

This record covers Phase 5 interactive terminal operation. It adds a headless
terminal screen model plus gated native tools for observation, input, and
bounded waiting. It preserves the two existing persisted execution-surface
values, does not reinterpret `exec_command.channel = "pty"`, does not enable
the rollout flags by default, and does not remove the legacy wrapper.

The implementation, deterministic Windows-host core fixtures, and independent
native Windows PowerShell 5.1 and PowerShell 7.6 ConPTY fixtures are complete.
On 2026-09-16 the user explicitly narrowed the first delivery gate to Windows.
macOS, Linux, and Phase 5 SSH evidence remain missing and are deferred; they are
not inferred passes and cannot inherit Windows rollout state.

**Final gate: PASS for the Windows delivery scope. A Windows-only Phase 6
session is READY.**

## Requirement disposition

| Requirement | Result | Evidence |
| --- | --- | --- |
| Rendered screen observation | **IMPLEMENTED; CORE PASS** | `vt100` consumes only Broker-accepted ordered raw output and reports bounded rows, columns, cursor, primary/alternate buffer, OSC title, content, output sequence, and a monotonic screen version. |
| Text, key, paste, and interrupt input | **IMPLEMENTED; CORE PASS** | All input uses the existing lease-authorized Broker path. Supported keys have exact encodings; paste is bounded and uses bracketed-paste delimiters only when the rendered terminal enables that mode. |
| Bounded waits | **IMPLEMENTED; CORE PASS** | `wait_terminal` can wait for screen version, output sequence, lifecycle sequence, text, idle output, or terminal closure. Timeouts are capped at 60 seconds and runtime cancellation is polled in bounded slices. |
| Model/tool contracts | **IMPLEMENTED; PASS** | `read_terminal`, `write_terminal_input`, and `wait_terminal` are strict additions to the 13-tool manifest, JSON Schema, Rust contract registry, model catalog, adapter, and prompt filter. Direct surfaces and missing targets reject them. |
| Permissions and audit | **IMPLEMENTED; PASS** | Reads/waits are fixed `sensitiveRead`; input is fixed `stateChange`. Raw input/wait text is removed from durable Assistant and ToolCall records, and replay envelopes containing those arguments are dropped. Input receipts contain metadata only. |
| Credential-like prompt safety | **IMPLEMENTED; CORE PASS** | The latest nonempty visible rows and title are checked before input. A match releases the Agent lease, writes no bytes, redacts content/title before model exposure, and fences the operation. |
| User takeover | **IMPLEMENTED; CORE PASS** | Takeover sends at most one interrupt, releases ownership, records an operation tombstone, and rejects every later Agent input for that operation. |
| Local and remote rollout | **IMPLEMENTED; DEFAULT OFF** | `SHELLSPAN_TERMINAL_INTERACTIVE_TOOLS_V1` requires Broker plus shell integration; remote publication additionally requires the dedicated Agent SSH PTY flag. Disabling it revokes interactive leases. |
| Deterministic scenario fixtures | **CORE PASS** | Broker-fed tests cover REPL text, a confirmation menu, resize/versioning, credential-like prompts, alternate-screen state, idle wait, closure, bracketed paste, keys, and takeover. |
| Native Windows acceptance | **PASS** | Independent Windows PowerShell 5.1 and PowerShell 7.6 ConPTY fixtures run REPL, confirmation, resize, alternate-screen, and credential-rejection scenarios through the production Broker, lease manager, screen model, and interactive registry. |
| Deferred platform acceptance | **MISSING — DEFERRED** | macOS, Linux, and isolated SSH Phase 5 fixtures have not run. Their rollout remains default-off and their legacy fallback remains required. |

## Compatibility, security, and privacy decisions

- The headless model is created only for a newly attached generation when the
  effective interactive flag is on. It never rewrites display bytes.
- Terminal geometry is normalized to `1..=1000` rows/columns, and screen and
  wait contracts use matching bounds.
- Interactive ownership is turn-scoped and can span multiple reads/writes for
  one operation. Turn end, cancellation, terminal close, takeover, rollout
  disablement, and runtime shutdown release it deterministically.
- Remote tools resolve only the dedicated Agent-owned terminal identity. They
  do not borrow an arbitrary user-owned SSH terminal.
- Credential detection is a fail-closed guard, not a promise to recognize
  every possible secret prompt. Security-sensitive work remains subject to the
  existing Direct-execution policy.
- Redacted screen title/content is injected only into the current in-memory
  model turn. Durable Agent tool results contain allowlisted geometry/version/
  cursor metadata with `transientObservation = true` and
  `contentPersisted = false`; turn/session boundaries and restart discard the
  transient value. Raw terminal input and wait-search text is also excluded
  from durable Assistant, ToolCall, approval, replay, and result records.
- The rollout flag accepts the same trusted `1`/`true`/`on` and
  `0`/`false`/`off` values as prior backend flags. Absence is off.

## Verification evidence

| Exact command | Result |
| --- | --- |
| `cargo check --locked --manifest-path src-tauri/Cargo.toml --all-targets` | **PASS**; only pre-existing unused-import warnings remain. |
| `cargo test --manifest-path src-tauri/Cargo.toml terminal_screen` | **PASS — 2 passed**. |
| `cargo test --manifest-path src-tauri/Cargo.toml interactive_` | **PASS — 8 passed**; covers model publication, adapter normalization/audit, policy, Broker fixtures, credential handling, and takeover. |
| `cargo test --manifest-path src-tauri/Cargo.toml ephemeral_terminal` | **PASS — 1 passed**; durable result metadata excludes screen/title while the current in-memory model turn receives the observation. |
| `cargo test --manifest-path src-tauri/Cargo.toml agent_runtime::model::stage_c_tests::terminal_input_and_wait_text_are_not_retained_in_recorded_tool_calls -- --exact` | **PASS — 1 passed**; Assistant/ToolCall persistence contains only bounded metadata. |
| `cargo test --manifest-path src-tauri/Cargo.toml agent_runtime::native_adapter::tests` | **PASS — 6 passed**. |
| `cargo test --manifest-path src-tauri/Cargo.toml agent_runtime::native::registry::tests` | **PASS — 1 passed**. |
| `cargo test --manifest-path src-tauri/Cargo.toml agent_runtime::native_contract::policy::tests::interactive_terminal_arguments_are_bounded_and_shape_checked -- --exact` | **PASS — 1 passed**. |
| `pnpm exec vitest run scripts/__tests__/agent-runtime-architecture.test.mjs scripts/__tests__/terminal-protocol-contract.test.mjs` | **PASS — 2 files, 10 tests** after the final roadmap, matrix, compatibility, and evidence assertions were added. |
| `pnpm test` | **PASS — 200 files passed, 1 skipped; 1,832 tests passed, 1 skipped**. |
| `pnpm build` | **PASS**, with existing dynamic-import and chunk-size warnings. |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml -- --test-threads=1` | **PASS — 776 library tests passed, 37 ignored; 5 integration tests passed; 0 failed**. The two additional ignored tests are the native Phase 5 PowerShell lanes run explicitly by the Windows gate. |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check` | **PASS**. |
| `pnpm check:rust:includes` | **PASS — 43 discovered `include!` files** after mechanically formatting the two changed fragments. |
| `pnpm check:ai-styles` | **PASS — AI panel style boundaries are clean**. |
| `pnpm check:llm:catalog` | **PASS — 55 exact models validated; 4 negative fixtures rejected**. |
| `git diff --check` | **PASS**; Git emitted only the repository's Windows LF-to-CRLF checkout notices. |
| `cargo test --manifest-path src-tauri/Cargo.toml` (parallel, before increasing the bounded ConPTY fixture deadline) | **NOT A PASS — 773 passed, 1 failed, 35 ignored**; the existing real-ConPTY helper exceeded its 15-second deadline under full-suite contention and passed immediately when isolated. |
| `cargo test --manifest-path src-tauri/Cargo.toml` (parallel, after the ConPTY fixture adjustment) | **NOT A PASS — 773 passed, 1 failed, 35 ignored**; ConPTY passed, while the unrelated Anthropic three-phase timeout test observed a header timeout instead of idle timeout under contention. Its exact isolated rerun passed. The serial full gate above is authoritative for this host. |
| `pnpm test:terminal-interactive:windows` | **PASS** on native Windows 11 x64, Rust host `x86_64-pc-windows-msvc`, Windows PowerShell 5.1.26100.9444, and PowerShell 7.6.5. It runs the Phase 2 Broker, Phase 3 visible-command, and Phase 5 interactive exact ConPTY lanes, Direct/compatibility regressions, the serial full Rust suite, and two release performance rounds. |
| Native Phase 5 macOS/Linux/SSH fixture lanes | **MISSING — DEFERRED; not run and not PASS**. |

## Platform evidence

| Lane | Result | Follow-up |
| --- | --- | --- |
| Deterministic core on native Windows | **PASS** | Production Broker, screen model, runtime, lease manager, adapter, and persistence boundaries are exercised without a shell-specific prompt dependency. |
| Windows PowerShell 5.1 and PowerShell 7 / ConPTY | **PASS** | Both exact end-to-end Phase 5 fixtures passed. The same consolidated command also closed the earlier Phase 2/3 native Windows evidence debt. |
| Native macOS zsh and bash | **MISSING — DEFERRED** | Outside the first Windows delivery scope; keep its rollout off and wrapper available. |
| Linux bash and zsh | **MISSING — DEFERRED** | Outside the first Windows delivery scope; keep its rollout off and wrapper available. |
| Isolated SSH bash and zsh | **MISSING — DEFERRED** | Remote interactive rollout stays off until the disposable fixture covers the Phase 5 scenarios. |

## Exact worktree disposition

No commit, tag, release, or push was created. Final `git status --short` reports
37 modified tracked files and 3 untracked new files. The Phase 5 worktree
contains the following exact changed or added paths:

- Protocol and verification: `protocol/agent/runtime/built-in-tools.json`,
  `protocol/agent/runtime/tool-contract.schema.json`,
  `protocol/agent/runtime/tool-manifest.schema.json`,
  `protocol/agent/runtime/terminal-execution-compatibility.md`,
  `protocol/agent/runtime/terminal-execution-phase-2-acceptance.md`,
  `protocol/agent/runtime/terminal-execution-phase-3-acceptance.md`,
  `protocol/agent/runtime/terminal-execution-phase-4-acceptance.md`,
  `protocol/agent/runtime/terminal-execution-roadmap.md`,
  `protocol/agent/runtime/terminal-execution-test-matrix.md`, this evidence
  file, `scripts/__tests__/agent-runtime-architecture.test.mjs`, and
  `scripts/__tests__/terminal-protocol-contract.test.mjs`,
  `scripts/verify-terminal-broker-windows.mjs`, and `package.json`.
- Dependency and module registration: `src-tauri/Cargo.toml`,
  `src-tauri/Cargo.lock`, and `src-tauri/src/lib.rs`.
- Screen/Broker implementation: `src-tauri/src/terminal_screen.rs`,
  `src-tauri/src/terminal_broker.rs`, and
  `src-tauri/src/tests/terminal_broker.rs`. The Windows benchmark and native
  command fixtures are in `src-tauri/examples/terminal_transport_baseline.rs`
  and `src-tauri/src/tests/terminal_integration.rs`.
- Native runtime and contracts:
  `src-tauri/src/agent_runtime/native/terminal_interactive.rs`,
  `src-tauri/src/agent_runtime/native/terminal_lease.rs`,
  `src-tauri/src/agent_runtime/native/runtime.rs`,
  `src-tauri/src/agent_runtime/native/registry.rs`,
  `src-tauri/src/agent_runtime/native/call_policy.rs`,
  `src-tauri/src/agent_runtime/native/mod.rs`,
  `src-tauri/src/agent_runtime/native_contract/types.rs`,
  `src-tauri/src/agent_runtime/native_contract/policy.rs`, and the bounded
  fixture deadline in `src-tauri/src/agent_runtime/tests/native/pty.rs`.
- Model/adapter surface: `src-tauri/src/agent_runtime/model_tools.rs`,
  `src-tauri/src/agent_runtime/model.rs`,
  `src-tauri/src/agent_runtime/driver.rs`,
  `src-tauri/src/agent_runtime/runtime.rs`,
  `src-tauri/src/agent_runtime/prompt.rs`,
  `src-tauri/src/agent_runtime/tool_pipeline.rs`,
  `src-tauri/src/agent_runtime/native_adapter.rs`, and
  `src-tauri/src/agent_runtime/tests/native_adapter/core.rs`.
- Shared frontend type: `src/types/index.ts`.

## Follow-up gate

The next roadmap session may implement Phase 6 for Windows only. It must scope
default enablement, migration, rollback, and any legacy-wrapper removal to
Windows. macOS, Linux, and remote interactive paths remain blocked, default-off,
and dependent on the compatibility wrapper until their independent Phase 5
fixtures pass.
