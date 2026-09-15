# Terminal Execution Phase 0 Baseline Evidence

Captured: 2026-09-15 (Asia/Shanghai); branch: `main`; repository revision before
Phase 0 edits: `d6116bb3140ca831b1f5fd8232e9208bb3ca4d3e`.

Protocol: [Terminal Session Protocol v1](./terminal-protocol-rfc.md)

Matrix: [Terminal Execution Platform Test Matrix](./terminal-execution-test-matrix.md)

## Scope and evidence rules

This document characterizes the implementation before any terminal-roadmap
cutover. Phase 0 adds protocol/schema/test artifacts and repairs two test-only
fixture expectations; it does not enable a broker, shell integration,
wrapper-free visible command, remote Agent PTY, or interactive terminal tool.

Only commands actually run on the named host are marked passed. Linux and
Windows remain explicit missing evidence. The isolated SSH results come only
from the loopback Docker fixture in `tests/ssh-e2e`.

## Host and toolchain

| Item | Observed value |
| --- | --- |
| Host | macOS 26.6.2 build 25G83, Darwin 25.6.0, arm64 |
| Node | 24.15.0 |
| pnpm | 11.1.1 |
| rustc | 1.95.0 (`59807616e`, 2026-04-14) |
| cargo | 1.95.0 (`f2d3ce0bd`, 2026-03-21) |
| Docker client/server | 29.7.2 / 29.7.2 |

## Current implementation characterization

| Area | Baseline behavior and contract |
| --- | --- |
| Direct execution | `exec_command.channel = "direct"` starts `/bin/sh -lc` locally on this host or an SSH exec channel remotely. Foreground results contain stdout, stderr, exit code, and duration. Background results return an opaque process handle used by `write_stdin`, `wait_process`, and `kill_process`. Local capture is bounded to 768 KiB stdout plus 256 KiB stderr. |
| Direct ownership/recovery | A process handle is bound to request, task, and owner target. Local process groups and Windows job objects provide containment. Dispatch without a durable result is uncertain and never automatically replayed. |
| Local terminal transport | A real `portable-pty` session feeds an 8 KiB reader into a bounded 32-chunk queue. Startup output waits up to 5 seconds or 1,000,000 bytes for frontend readiness. Reads are event-driven and drained in ordered batches of at most 64 chunks. |
| Remote terminal transport | The existing user terminal requests an SSH PTY and interactive shell. Decoded output flushes at 64 KiB, waits up to 5 seconds or 1,000,000 bytes for frontend readiness, and uses an event-driven socket/command wake path. |
| Encoding/display | Both transports incrementally decode bytes as UTF-8 before emitting `ssh-data:<sessionId>` strings. Invalid bytes become U+FFFD. The backend calls Agent PTY observation before emission, so the current legacy path can remove wrapper records and replace display content. This is not the RFC target. |
| Frontend flow control | xterm pauses backend reads at 512 KiB pending characters and resumes at 128 KiB. Input, pause/resume, and resize use the unlogged terminal hot-path IPC adapter. |
| Model terminal context | A separate 256 KiB bounded frontend buffer strips ANSI, renders carriage-return/backspace effects, redacts secrets, and caches versioned snapshots. It receives the original emitted terminal event payload, while display filters may change xterm's payload. |
| Legacy visible command | `AgentExecutionSurface = "boundTerminal"` maps the model facade to `exec_command.channel = "pty"`. POSIX wraps with `/bin/sh -c`; PowerShell wraps with nested `powershell.exe`. Authenticated BEGIN/END records are hidden, and a synthetic redacted `[Agent] $ ...` line is displayed. |
| Legacy lease | One in-memory lease per terminal blocks user input during a wrapped command, verifies Agent/task/operation identity, waits for clean frontend readiness, and supports cancel, timeout, terminal close, shutdown, and user takeover. Leases do not survive restart. |
| Persisted compatibility | Agent event version is 5. `direct` and `boundTerminal` are stored in `session/created` and surface-change events. Sessions live under `sessions-v5`; reconnect does not rebind an old Agent target. |

## Protocol and frontend evidence

| Command | Exact result |
| --- | --- |
| `pnpm exec vitest run scripts/__tests__/terminal-protocol-contract.test.mjs` | **PASS** — 1 file, 3 tests passed. TSP/1 fixture, generation/output fences, trusted lifecycle, screen/lease/uncertainty examples, event-v5 values, `direct`/`pty`, and seven rollout flags validated. |
| Initial `pnpm test` | **FAIL (repaired test drift)** — 193 files passed, 1 failed, 1 skipped; 1,772 tests passed, 1 failed, 1 skipped. The sole failure queried stale English text `Enable full access`; the product catalog already says `Allow full access`. |
| Targeted stale-label rerun after test-only correction | **PASS** — 1 passed, 64 filtered/skipped in the file. No production UI or locale was changed. |
| Final `pnpm test` | **PASS** — 195 files passed, 1 skipped; 1,776 tests passed, 1 skipped. |
| `pnpm build` | **PASS** — TypeScript and Vite production build completed; 2,805 modules transformed. Existing dynamic-import and large-chunk warnings were emitted. |
| `pnpm exec vitest run scripts/__tests__/terminal-performance-contract.test.ts` | **PASS** — 1 file, 11 tests passed. Workload geometry, bounded/cached context, redaction, per-session subscription, ordered input IPC, backpressure, and resize contracts passed. |

## Rust and visible-terminal evidence

| Command | Exact result |
| --- | --- |
| `cargo test --manifest-path src-tauri/Cargo.toml agent_runtime::native::process::tests --lib -- --nocapture` | **PASS** — 5 passed. Local stdout/stderr/exit/handle, background stdin, timeout race, bounded remote polling, and cancel-before-dispatch behavior passed. |
| `cargo test --manifest-path src-tauri/Cargo.toml agent_runtime::native::terminal_lease::tests --lib -- --nocapture` | **PASS** — 6 passed. Single owner, input rejection, event identity, readiness, bounded timeout, and restart cleanup passed. |
| `cargo test --manifest-path src-tauri/Cargo.toml agent_runtime::native::pty::tests --lib -- --nocapture` | **PASS on host-applicable tests** — 18 passed, isolated SSH test ignored. Parser, wrapper, capture, shell probe, local POSIX PTY, lease cleanup, cancellation, timeout, and takeover passed. The ignored SSH cell was subsequently run and passed through the fixture gate. |
| `cargo test --manifest-path src-tauri/Cargo.toml agent_runtime::recovery::tests --lib -- --nocapture` | **PASS** — 2 passed. Durable result continuation and uncertain/no-resume behavior passed. |
| `cargo test --manifest-path src-tauri/Cargo.toml commands::tests --lib -- --nocapture` | **PASS** — 14 passed. Bounded queue, startup gate, ordering, pause/resume, event wake, independent sessions, macOS real PTY smoke, and zsh wrapper protocol passed. |
| `cargo test --manifest-path src-tauri/Cargo.toml session::tests --lib -- --nocapture` | **PASS** — 51 matched tests passed. SSH transport, event-v5 persistence/replay, terminal continuation, uncertainty, and recovery-adjacent session contracts passed. |
| `pnpm test:agent-visible-terminal` | **PASS** — rustfmt and all-target checks passed; lease 6/6; host PTY 18 passed and 1 isolated SSH test was explicitly ignored; redaction 1/1; restart no-replay 1/1; frontend terminal bundle 200/200. The command explicitly skipped its optional SSH fixture, which the next row covers. |
| `pnpm test:agent-visible-terminal:ssh` | **PASS** — rustfmt check and all-target check passed; lease 6/6; host PTY 18 passed with the fixture test initially ignored; redaction 1/1; restart no-replay 1/1; frontend terminal bundle 200/200; Docker fixture built and became healthy; exact ignored SSH PTY test 1/1; fixture containers/network removed. Host gate reported `darwin/arm64`. |
| Isolated reviewed SSH direct-execution group | **PASS after fixture repair** — 6/6 passed: uname, output boundaries, cancellation/timeout/late result, secret redaction, security acceptance, and jump-host success. The first run was 5/6 because the test command reconstructed a different token than its declared secret; the test-only byte geometry was corrected and the exact test plus full group passed. |
| `cargo test --manifest-path src-tauri/Cargo.toml` | **PASS** — library 728 passed and 28 ignored; main 0 tests; integration probe 5 passed; doc tests 0. Fixture-dependent ignored tests remain explicit rather than counted as passes. |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check` | **PASS** — no output, exit 0. |
| `pnpm check:rust:includes` | **FAIL (pre-existing unrelated formatting debt)** — the check reports rustfmt diffs in `image_tests.rs`, `runtime_archive_tests.rs`, `runtime_loop_guard_tests.rs`, and `session_inbox_steer_tests.rs`. Those files were unchanged by Phase 0 and were not reformatted. |
| `pnpm check:ai-styles` | **PASS** — AI panel style boundaries are clean. |
| `pnpm check:llm:catalog` | **PASS** — 55 exact models validated and 4 negative fixtures rejected. |

## Transport performance baseline

Command:

```bash
env SHELLSPAN_E2E_SSH_HOST=127.0.0.1 \
  SHELLSPAN_E2E_SSH_PORT=22222 \
  SHELLSPAN_E2E_SSH_USERNAME=shellspan \
  SHELLSPAN_E2E_SSH_PASSWORD=<fixture-password> \
  cargo run --release --manifest-path src-tauri/Cargo.toml \
  --example terminal_transport_baseline -- \
  --bytes 2097152 --repetitions 5 --sessions 4 --ssh
```

The Docker fixture was healthy for the run and removed afterward.

| Throughput scenario | Median ms | p95 ms | Median MiB/s | Repetitions |
| --- | ---: | ---: | ---: | ---: |
| `local_pty_single` | 15.398 | 19.438 | 129.89 | 5 |
| `local_pty_multi` (4 sessions) | 38.179 | 42.473 | 209.54 aggregate | 5 |
| `ssh_pty_single` | 83.091 | 84.905 | 24.07 | 5 |
| `ssh_pty_multi` (4 sessions) | 109.175 | 121.179 | 73.28 aggregate | 5 |

| Worker latency scenario | Median ms | p95 ms | Max ms | Samples |
| --- | ---: | ---: | ---: | ---: |
| legacy 16 ms poll, first byte | 19.958 | 20.030 | 20.663 | 41 |
| event driven, first byte | 0.001 | 0.006 | 0.010 | 41 |
| legacy 16 ms poll, low-frequency burst | 11.301 | 19.367 | 20.015 | 41 |
| event driven, low-frequency burst | 0.022 | 0.085 | 0.373 | 41 |

All scenarios received at least the expected byte count; the harness exits
nonzero on a short read.

### Phase 2 comparison rule

Run the release harness on the same host class, byte count, session count, and
repetition count with background load controlled. The broker candidate is a
material regression if any of these occurs:

- any byte-count, ordering, or display-equality failure;
- median throughput is more than 20% below its matching baseline;
- p95 elapsed time increases by more than the greater of 25% or 5 ms locally,
  or the greater of 25% or 10 ms for SSH; or
- event-driven first-byte or low-frequency-burst p95 exceeds 2 ms.

A threshold miss requires investigation and either optimization or an explicit
reviewed baseline amendment; it is not averaged away with unrelated platforms.

## Missing platform evidence

| Evidence | Status | Required follow-up |
| --- | --- | --- |
| Native Linux PTY, bash/zsh, direct process, transport, and performance | **MISSING — not run on this macOS host.** | Run the matrix on a supported Linux host before the phase that requires cross-platform acceptance. |
| Native Windows ConPTY, Windows PowerShell 5.1, PowerShell 7, direct process/job object, and performance | **MISSING — not run on this macOS host.** | Run the matrix on a supported Windows host; pure parser tests on macOS do not count. |
| macOS bash-specific legacy visible-command end to end | **MISSING — current host gate exercises POSIX `/bin/sh` plus zsh transport protocol, not a dedicated bash lane.** | Add/run the bash lane with Phase 3 integration acceptance. |

The missing native lanes are baseline gaps, not passes. Phase 0's deliverable is
the explicit matrix and available-host evidence; later cross-platform gates
remain blocked until their native sessions supply results.

## Baseline risks carried forward

- The current PTY path changes the display stream before xterm sees it; this is
  the main Phase 2 invariant to eliminate.
- Current transport IPC is decoded text rather than raw bytes, so arbitrary
  non-UTF-8 byte equality is not available today.
- The current wrapper does not preserve interactive-shell state because it
  executes a nested shell/PowerShell. It must retain a degraded compatibility
  label until removed.
- `pnpm check:rust:includes` is not clean at the baseline revision. The reported
  files are outside Phase 0 changes and must be handled separately without
  folding unrelated formatting into a roadmap phase.
- Linux, Windows, and macOS bash evidence is missing as listed above.
