# Terminal Execution Phase 6 Acceptance Evidence

Status: complete — PASS for the Windows delivery scope
Date: 2026-09-16
Continuation: Windows rollout continuation delegated from Phase 5 session `01a0a566-6a29-74a3-945e-cc310a46cecd`

## Scope and recommendation

This continuation completed only the Windows portion of Phase 6. Local Windows
ConPTY generations now default to the Broker, cooperative shell integration,
`terminal_execute`, and interactive terminal tools. The Windows local routing
graph cannot dispatch the legacy wrapper. macOS, Linux, user-owned SSH, and
dedicated Agent SSH rollout remain default-off and retain the compatibility
implementation.

**Final gate: PASS for the Windows delivery scope. Cross-platform wrapper
removal is NOT READY.** It remains blocked on independent native Phase 5
acceptance for macOS, Linux, and isolated SSH.

This file preserves the original Windows rollout boundary. Native macOS later
passed its independent Phase 5/6 gate; current macOS status is recorded in
[Terminal Execution Phase 6 macOS Acceptance Evidence](./terminal-execution-phase-6-macos-acceptance.md).
Linux and isolated SSH remain deferred.

## Worktree status at handoff

The exact cumulative `git status --short` is below. Phase 0–5 changes were
already dirty and were preserved; no file was reset, reverted, or committed.

```text
 M package.json
 M protocol/agent/runtime/built-in-tools.json
 M protocol/agent/runtime/terminal-execution-compatibility.md
 M protocol/agent/runtime/terminal-execution-phase-2-acceptance.md
 M protocol/agent/runtime/terminal-execution-phase-3-acceptance.md
 M protocol/agent/runtime/terminal-execution-phase-4-acceptance.md
 M protocol/agent/runtime/terminal-execution-roadmap.md
 M protocol/agent/runtime/terminal-execution-test-matrix.md
 M protocol/agent/runtime/terminal-protocol-rfc.md
 M protocol/agent/runtime/tool-contract.schema.json
 M protocol/agent/runtime/tool-manifest.schema.json
 M scripts/__tests__/agent-runtime-architecture.test.mjs
 M scripts/__tests__/terminal-protocol-contract.test.mjs
 M scripts/verify-terminal-broker-windows.mjs
 M src-tauri/Cargo.lock
 M src-tauri/Cargo.toml
 M src-tauri/examples/terminal_transport_baseline.rs
 M src-tauri/gen/schemas/desktop-schema.json
 M src-tauri/gen/schemas/windows-schema.json
 M src-tauri/src/agent_runtime/driver.rs
 M src-tauri/src/agent_runtime/model.rs
 M src-tauri/src/agent_runtime/model_tools.rs
 M src-tauri/src/agent_runtime/native/call_policy.rs
 M src-tauri/src/agent_runtime/native/mod.rs
 M src-tauri/src/agent_runtime/native/registry.rs
 M src-tauri/src/agent_runtime/native/runtime.rs
 M src-tauri/src/agent_runtime/native/terminal_lease.rs
 M src-tauri/src/agent_runtime/native_adapter.rs
 M src-tauri/src/agent_runtime/native_contract/policy.rs
 M src-tauri/src/agent_runtime/native_contract/types.rs
 M src-tauri/src/agent_runtime/prompt.rs
 M src-tauri/src/agent_runtime/runtime.rs
 M src-tauri/src/agent_runtime/tests/native/pty.rs
 M src-tauri/src/agent_runtime/tests/native/terminal_lease.rs
 M src-tauri/src/agent_runtime/tests/native_adapter/core.rs
 M src-tauri/src/agent_runtime/tool_pipeline.rs
 M src-tauri/src/lib.rs
 M src-tauri/src/terminal_broker.rs
 M src-tauri/src/tests/terminal_broker.rs
 M src-tauri/src/tests/terminal_integration.rs
 M src/lib/ipc/__tests__/tauri.test.ts
 M src/types/index.ts
?? docs/design/agent-terminal-execution-windows-rollout.md
?? protocol/agent/runtime/terminal-execution-phase-5-acceptance.md
?? protocol/agent/runtime/terminal-execution-phase-6-acceptance.md
?? src-tauri/src/agent_runtime/native/terminal_interactive.rs
?? src-tauri/src/terminal_screen.rs
```

Phase 6 added or edited these paths within that cumulative state:

- `package.json`
- `docs/design/agent-terminal-execution-windows-rollout.md`
- `protocol/agent/runtime/terminal-execution-compatibility.md`
- `protocol/agent/runtime/terminal-execution-phase-6-acceptance.md`
- `protocol/agent/runtime/terminal-execution-roadmap.md`
- `protocol/agent/runtime/terminal-execution-test-matrix.md`
- `protocol/agent/runtime/terminal-protocol-rfc.md`
- `scripts/__tests__/terminal-protocol-contract.test.mjs`
- `scripts/verify-terminal-broker-windows.mjs`
- `src-tauri/src/agent_runtime/native/runtime.rs`
- `src-tauri/src/agent_runtime/native_adapter.rs`
- `src-tauri/src/agent_runtime/tests/native/pty.rs`
- `src-tauri/src/agent_runtime/tests/native/terminal_lease.rs`
- `src-tauri/src/terminal_broker.rs`
- `src-tauri/src/tests/terminal_broker.rs`
- `src/lib/ipc/__tests__/tauri.test.ts`
- `src/types/index.ts`

## Requirement evidence

| Requirement | Result | Evidence |
| --- | --- | --- |
| Windows default enablement | **PASS** | Absent trusted values enable `terminal_broker_v1`, `terminal_shell_integration_v1`, `terminal_execute_v1`, `terminal_interactive_tools_v1`, and the independently accepted `terminal_remote_agent_pty_v1` path. `terminal_remote_interactive_tools_v1` remains absent-off. |
| Preserve shell state and terminal truth | **PASS** | PowerShell 5.1 and 7.6 real-ConPTY visible-command fixtures pass persistent cwd/environment/alias/function state, exact cooperative lifecycle, ANSI/Unicode, nonzero exit, capture, and screen-driven interaction without wrapper echo. |
| Windows local legacy removal | **PASS** | Local routing calls `visible_command_route`, which never admits fallback on Windows. Explicit local `exec_command.channel = pty` fails with `TERMINAL_LEGACY_WRAPPER_REMOVED_ON_WINDOWS`; no marker parser or synthetic `[Agent]` echo is reachable from the local Windows production route. |
| Deferred-platform compatibility | **PASS** | Remote routing uses the separate `remote_visible_command_route`; Linux local targets and remote rollback retain the wrapper/parser implementation and explicit compatibility tests. Remote Agent PTY visible commands are default-on for Windows and macOS desktop hosts, while remote interactive publication remains independently default-off. |
| Persisted and wire compatibility | **PASS** | Existing `direct` / `boundTerminal`, event-v5, and `exec_command.channel = direct` / `pty` values remain decodable without rewrite or reinterpretation. No operation is rerouted or replayed across paths. |
| Privacy-safe rollout counters | **PASS** | Existing read-only Broker snapshot exposes bounded numeric readiness/fallback/lifecycle/uncertainty/timeout/takeover/truncation/backpressure and latency sample/total/max counters. Values saturate at the JavaScript safe-integer limit, reset on restart, and contain no commands, paths, input, output, screen text, identifiers, credentials, nonces, timestamps, or raw samples. |
| Hot-path overhead | **PASS** | Broker latency is sampled on the first frame and every 64 frames thereafter. Two final release rounds remain above the 80% throughput floor and below the 2 ms event-latency p95 ceiling. |
| Direct execution regression | **PASS** | Native Direct foreground/background/stdin/timeout/remote dispatch tests pass independently of visible terminal routing. |
| Documentation | **PASS** | RFC, compatibility plan, platform matrix, roadmap, and the Windows rollout user/developer guide describe defaults, rollback, routing isolation, privacy, and deferred platforms. |

## Native Windows host evidence

- Host: Windows 11 x64.
- Rust: `rustc 1.95.0`, host `x86_64-pc-windows-msvc`.
- Windows PowerShell: `5.1.26100.9444`.
- PowerShell: `7.6.5`.
- Final command: `pnpm test:terminal-rollout:windows`.
- Final result: `Windows Phase 2/3/5/6 native ConPTY and rollout acceptance: PASS.`
- Full serial Rust result inside the gate: `778 passed; 0 failed; 37 ignored`.
- Exact real-ConPTY tests: PowerShell 5.1 and PowerShell 7 Broker,
  visible-command integration, and interactive-operation fixtures all passed
  when the runner invoked them with `--ignored --exact`.
- Direct process group: `5 passed; 0 failed`.
- Explicit legacy compatibility group: `19 passed; 0 failed; 1 ignored`; the
  ignored test requires the isolated SSH Docker fixture and is deferred by this
  Windows-only scope.

### Final release performance rounds

Each value is the median throughput from 2 MiB per session, five repetitions,
and four concurrent sessions. Latency is the event-driven first-byte p95.

| Round | Scenario | Control | Broker | Result |
| --- | --- | ---: | ---: | --- |
| 1 | Single PTY throughput | 15.23 MiB/s | 14.80 MiB/s | **PASS** |
| 1 | Four-PTY throughput | 46.81 MiB/s | 44.73 MiB/s | **PASS** |
| 1 | Event first-byte p95 | 0.002 ms | 0.009 ms | **PASS** |
| 2 | Single PTY throughput | 14.84 MiB/s | 14.76 MiB/s | **PASS** |
| 2 | Four-PTY throughput | 47.00 MiB/s | 47.51 MiB/s | **PASS** |
| 2 | Event first-byte p95 | 0.015 ms | 0.009 ms | **PASS** |

## Verification record

| Command | Result |
| --- | --- |
| `pnpm test:terminal-rollout:windows` with `RUSTUP_TOOLCHAIN=1.95.0-x86_64-pc-windows-msvc` | **PASS**; final consolidated host gate, exact ConPTY lanes, serial Rust, and two performance rounds. |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml terminal_broker::tests --lib -- --nocapture --test-threads=1` through the explicit MSVC toolchain | **PASS**; `23 passed; 0 failed; 2 ignored`. |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml agent_runtime::native::runtime::tests --lib -- --nocapture --test-threads=1` through the explicit MSVC toolchain | **PASS**; `3 passed; 0 failed`. |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml agent_runtime::native::terminal_lease::tests --lib -- --nocapture --test-threads=1` through the explicit MSVC toolchain | **PASS**; `8 passed; 0 failed`. |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml agent_runtime::native::pty::tests --lib -- --nocapture --test-threads=1` through the explicit MSVC toolchain | **PASS**; `19 passed; 0 failed; 1 ignored`. |
| `cargo check --locked --manifest-path src-tauri/Cargo.toml --all-targets` through the explicit MSVC toolchain | **PASS**; only pre-existing platform-conditional unused-import warnings. |
| `pnpm exec vitest run scripts/__tests__/terminal-protocol-contract.test.mjs src/lib/ipc/__tests__/tauri.test.ts` | **PASS** before the final evidence update; rerun by the full frontend gate below. |
| `pnpm test` | **PASS**; full frontend/protocol suite. |
| `pnpm build` | **PASS**; TypeScript and Vite production build. |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check` through the explicit MSVC toolchain | **PASS**. |
| `pnpm check:rust:includes` | **PASS**. |
| `pnpm check:ai-styles` | **PASS**. |
| `pnpm check:llm:catalog` | **PASS**. |
| `git diff --check` | **PASS**; Git reports expected LF-to-CRLF checkout warnings only. |

The worktree's default `cargo` resolution selected
`x86_64-pc-windows-gnu`, which cannot build the repository's vendored OpenSSL
with the Windows Perl/MSVC assumptions. That direct precheck is **NOT PASS —
host-toolchain mismatch**, not source acceptance. All authoritative native
commands above explicitly selected the installed
`1.95.0-x86_64-pc-windows-msvc` toolchain, and the consolidated gate verifies
the host triple before running.

## Regressions found and closed during the gate

1. Windows absent-on exposed legacy lease and PTY unit fixtures that implicitly
   assumed an absent-off Broker. Their setup now explicitly selects the disabled
   compatibility rollout; production defaults are unchanged.
2. Per-frame latency atomics caused the first multi-session performance round
   to fail (`31.54 MiB/s` Broker versus `51.85 MiB/s` control). Deterministic
   first-frame/every-64-frame sampling removed that hot-path contention. The
   final two independent rounds pass.

## Compatibility and follow-up

- Windows rollback disables dependent flags and closes affected generations.
  New local operations expose Direct; in-flight or uncertain operations are
  never replayed and never revived through the wrapper.
- The compatibility wrapper/parser remains source-compiled because remote and
  non-Windows targets still need it. Windows local runtime routing is the
  removal boundary in this phase.
- macOS, Linux, and isolated SSH Phase 5 gates are **MISSING — DEFERRED**. Their
  defaults stay off and their wrapper remains available until separate native
  acceptance and a later scoped removal decision.
- No commit, tag, push, release, or migration rewrite was created.
