# Terminal Execution Phase 2 Acceptance Evidence

Updated: 2026-09-15 (Asia/Shanghai); Phase 2 complete with waived Windows native evidence.

Roadmap: [Terminal Execution Roadmap](./terminal-execution-roadmap.md)

Matrix: [Terminal Execution Platform Test Matrix](./terminal-execution-test-matrix.md)

## Scope

This record covers only the Terminal Session Broker gate. Legacy display and
the legacy wrapped PTY remain authoritative. No shell integration,
`terminal_execute`, remote Agent PTY, headless screen model, interactive tool,
or Phase 3 cutover is enabled.

## Evidence boundaries

- macOS evidence is native host evidence from Darwin arm64.
- Linux evidence below is Debian 12/aarch64 running as an unprivileged user in
  a container inside the Docker Desktop LinuxKit VM. It exercises the Linux
  kernel, native aarch64 Rust target, `portable-pty`, bash, and zsh, but it is
  **Linux VM/container evidence, not bare-metal Linux evidence**.
- Isolated SSH evidence uses the separate loopback-only `tests/ssh-e2e`
  fixture.
- Windows/ConPTY evidence is not available in this session and remains
  **MISSING**.

## User-approved temporary gate waiver

On 2026-09-15 the user explicitly approved deferring the native Windows
PowerShell/ConPTY run. This is a temporary Phase 2 gate waiver, not test
evidence: the Windows lane remains **MISSING** and must never be reported as
`PASS`. The existing x64/ARM64 runner, tests, and `MISSING` behavior remain in
place.

The waiver permits Phase 2 to close and makes Phase 3 ready to start only in a
separate dedicated session. It does not authorize Phase 3 work in this session.
It expires before any Phase 6 default enablement or removal of the legacy PTY
wrapper. Before either action, `pnpm test:terminal-broker:windows` must pass on
a native supported Windows host with real ConPTY, Windows PowerShell 5.1, and
PowerShell 7. Static x86_64/ARM64 cross-compilation and cfg checks cannot replace
that native run.

## macOS bash lane

Host shell identity:

```text
GNU bash, version 3.2.57(1)-release (arm64-apple-darwin25)
```

Command:

```bash
cargo test --manifest-path src-tauri/Cargo.toml \
  terminal_broker::tests::macos_bash_pty_broker_preserves_raw_bytes_input_order_and_resize \
  --lib -- --exact --nocapture
```

Result: **PASS — 1 passed, 0 failed**. The test directly starts
`/bin/bash --noprofile --norc` in a native `portable-pty`, sends input through
the broker admission path, resizes both PTY and broker geometry, and proves:

- non-UTF-8 byte `0xff` and ANSI bytes are observed before decoding;
- every broker display frame is byte-equal to the PTY read;
- frame sequence and byte offsets are exact and contiguous;
- bounded replay concatenates to the original raw stream; and
- display, capture, integration, and screen subscribers observe the same byte
  count without mutating display.

The existing macOS zsh PTY boundary test and visible-terminal host gate remain
green; this bash lane is independent of the user's default zsh.

## Linux/aarch64 Docker Desktop lane

Environment reported inside the final container:

```text
Docker engine boundary: linux/aarch64
Linux kernel: 7.0.12-linuxkit aarch64
Distribution: Debian GNU/Linux 12 (bookworm)
User: shellspan, uid 1000 (non-root)
rustc: 1.95.0 (59807616e 2026-04-14)
cargo: 1.95.0 (f2d3ce0bd 2026-03-21)
bash: 5.2.15 aarch64-unknown-linux-gnu
zsh: 5.9 aarch64-unknown-linux-gnu
```

Reproducible command:

```bash
pnpm test:terminal-broker:linux-container
```

The script builds `tests/terminal-broker-linux/Dockerfile`, verifies that the
Docker engine is Linux/aarch64, copies the repository into an ephemeral
writable container directory while excluding `.git`, `node_modules`, `dist`,
and `src-tauri/target`, and runs as an unprivileged user. No Linux build output
is written into the macOS worktree.

Final functional results:

| Evidence | Exact result |
| --- | --- |
| `cargo fmt --all -- --check` | **PASS** |
| `cargo check --locked --all-targets` | **PASS** |
| Broker suite | **PASS — 11 passed**, including explicit Linux bash and zsh native PTYs |
| Terminal lease | **PASS — 7 passed** |
| Direct process | **PASS — 5 passed** |
| Legacy native PTY | **PASS — 18 passed, 1 isolated-SSH test ignored** |
| Recovery | **PASS — 2 passed** |
| Commands/transport | **PASS — 14 passed** |
| Session/persistence/transport | **PASS — 53 passed** |
| Full Rust library | **PASS — 741 passed, 27 ignored** |
| Integration probe | **PASS — 5 passed** |
| Main/doc tests | **PASS — 0 failures** |

The Linux bash and zsh tests use real `portable-pty` sessions and the same
assertions as the macOS bash lane for raw byte equality, ANSI/non-UTF-8 data,
ordered input, sequence/offsets, replay, subscriber isolation, and resize.

### Linux container transport comparison

There is no accepted Phase 0 bare-metal Linux performance baseline, so these
measurements are an additional same-VM/container broker-off versus
broker-shadow comparison. They do not replace native-host baseline evidence.

Warm round 1:

| Scenario | Broker off median / p95 / MiB/s | Broker shadow median / p95 / MiB/s | Result |
| --- | --- | --- | --- |
| Single PTY | 51.106 / 59.699 ms / 39.13 | 49.964 / 53.249 ms / 40.03 | **PASS** |
| Four PTYs | 68.658 / 84.173 ms / 116.52 | 75.329 / 75.857 ms / 106.20 | **PASS** — throughput -8.9% |
| Event first-byte p95 | 0.056 ms | 0.049 ms | **PASS**, below 2 ms |
| Event burst p95 | 0.114 ms | 0.124 ms | **PASS**, below 2 ms |

Warm round 2:

| Scenario | Broker off median / p95 / MiB/s | Broker shadow median / p95 / MiB/s | Result |
| --- | --- | --- | --- |
| Single PTY | 49.488 / 53.320 ms / 40.41 | 47.058 / 50.320 ms / 42.50 | **PASS** |
| Four PTYs | 66.021 / 74.420 ms / 121.17 | 64.927 / 71.569 ms / 123.22 | **PASS** |
| Event first-byte p95 | 0.048 ms | 0.045 ms | **PASS**, below 2 ms |
| Event burst p95 | 0.115 ms | 0.117 ms | **PASS**, below 2 ms |

Every run received at least the requested 2,097,152 bytes per session. An
earlier non-root comparison produced a four-session broker p95 of 110.751 ms
against an 80.415 ms control, above the Phase 0-style relative threshold. The
two immediate warm repeats above passed; the miss is retained as Docker VM
scheduling variance evidence rather than averaged away.

### Environment corrections retained as evidence

1. The first image lacked `rustfmt` for the repository-pinned Rust 1.95
   toolchain and stopped before project compilation.
2. The first source mount was read-only; Tauri's build script required an
   ephemeral writable source copy and stopped before tests.
3. The first full suite ran as root and one permission fixture failed because
   root bypassed the expected denial. The final image runs as uid 1000; the
   same full suite then passed.

These attempts are not counted as passes.

## Windows native acceptance entry

The native Windows lane is implemented but was not run in this macOS session.
From an x64 or ARM64 Windows repository checkout with dependencies installed,
run:

```powershell
pnpm test:terminal-broker:windows
```

Required environment:

- native x64 or ARM64 Windows with ConPTY support;
- the matching Rust 1.95 MSVC host toolchain: `x86_64-pc-windows-msvc` for
  Node `process.arch === "x64"`, or `aarch64-pc-windows-msvc` for
  `process.arch === "arm64"`;
- MSVC C++ build tools and the Windows SDK for that architecture;
- Node 24 and pnpm 11 dependencies installed from the lockfile;
- Windows PowerShell 5.1 available as `powershell.exe`; and
- PowerShell 7 or newer available as `pwsh.exe`.

The script refuses non-Windows hosts and Windows architectures other than x64
or ARM64. It also requires the Rust host tuple to match the running Node
architecture. It probes both shell versions before acceptance, prints
`MISSING`, and exits nonzero if either shell is absent or has the wrong version.
Available evidence continues to run where safe, but a missing prerequisite can
never produce a passing lane.

On a complete host the one command runs:

- rustfmt and all-target checks;
- platform-independent Broker, lease, recovery, and session tests;
- explicit ignored native ConPTY Broker tests for Windows PowerShell 5.1 and
  PowerShell 7, each covering raw-byte equality, ordered sequence/offset,
  bounded replay, resize, common input admission, and subscriber isolation;
- Windows direct-process/job-object tests;
- the legacy PowerShell wrapper and real ConPTY tests;
- command transport tests, including the production PowerShell ConPTY smoke;
- the full Rust suite; and
- two broker-off/broker-shadow release benchmark rounds with automatic checks
  for byte-count success, the 20% median-throughput rule, local p95 rule, and
  2 ms event-driven p95 rule.

### Adversarial review hardening

The Windows entry was reviewed specifically for false-positive acceptance:

- each PowerShell ConPTY case now makes two independently admitted writes and
  asserts receipts with input sequences 1 and 2; the second write depends on
  variables established by the first, so reordered or dropped input cannot
  produce the expected output;
- the exact shell-output marker is assembled by PowerShell and never appears
  contiguously in either echoed input. The asserted payload contains the marker,
  literal ESC/ANSI bytes, a UTF-8 Chinese scalar, the observed `111x33` ConPTY
  geometry, eight payload bytes, and an end marker in one exact byte sequence.
  It remains below the resized width to avoid ConPTY physical-wrap rewriting;
  a 31-byte read buffer independently guarantees multiple raw frames;
- raw ConPTY observation intentionally includes prompt/input echo, but those
  bytes cannot satisfy the shell-output assertion. The test also requires more
  than one raw frame, contiguous sequence/offsets, a one-frame bounded replay
  with `has_more`, full replay equality, and equal subscriber byte counts;
- the runner parses the Rust host tuple and PowerShell versions strictly. An
  unavailable shell, malformed version, unsupported/mismatched architecture,
  or failed command remains nonzero;
- every filtered libtest command must report a non-empty harness. The two
  ignored ConPTY tests must report exactly one specifically named passing test,
  closing Cargo's successful zero-test filter behavior; and
- benchmark parsing requires one exact configuration/profile header, every
  expected row, finite and internally consistent metrics, exact repetition and
  sample counts, and no duplicate rows. Any non-finite benchmark metric is a
  hard failure. The PTY workload now frames its payload and verifies every
  requested payload byte exactly, rather than accepting prompt/control bytes as
  compensation for missing payload.

Regression coverage is in
`scripts/__tests__/terminal-broker-windows-runner.test.mjs`, the protocol
contract, and the `terminal_transport_baseline` example test.

macOS may syntax-check the runner and cross-check Windows cfg compilation, but
those results remain static evidence and cannot change the Windows lane from
`MISSING` to `PASS`.

Local static results from this macOS session:

| Command | Result |
| --- | --- |
| `node --check scripts/verify-terminal-broker-windows.mjs` | **PASS** |
| Focused Windows runner, protocol, and performance contracts | **PASS**, 3 files / 21 tests |
| `pnpm test` | **PASS**, 199 files / 1,815 tests; 1 file / 1 test skipped |
| `cargo test --manifest-path src-tauri/Cargo.toml --example terminal_transport_baseline` | **PASS**, 1 payload integrity test |
| `cargo test --manifest-path src-tauri/Cargo.toml terminal_broker::tests --lib` | **PASS**, 10 tests |
| One local release broker-off/on benchmark round using the framed exact payload | **PASS** — single 107.91/107.56 MiB/s, multi 192.69/186.27 MiB/s; broker event p95 0.007/0.038 ms |
| `pnpm test:terminal-broker:windows` | **MISSING as designed**, exit 2: current platform is `darwin/arm64` |
| `cargo check --manifest-path src-tauri/vendor/portable-pty/Cargo.toml --target x86_64-pc-windows-msvc --tests` | **PASS** — vendored ConPTY cfg compiles |
| `rustup target add aarch64-pc-windows-msvc` | **PASS** — ARM64 Windows standard library target installed |
| `cargo check --manifest-path src-tauri/vendor/portable-pty/Cargo.toml --target aarch64-pc-windows-msvc --tests` | **PASS** — vendored ConPTY cfg compiles for Windows ARM64 |
| Full ShellSpan `cargo check --target x86_64-pc-windows-msvc --tests` | **BLOCKED** — macOS lacks Windows SDK/MSVC C headers required by `ring`; stopped at missing `assert.h` |
| Full ShellSpan `cargo check --target aarch64-pc-windows-msvc --tests` | **BLOCKED** — same host limitation; `ring` stopped at missing `assert.h` before ShellSpan compiled |

The full-crate cross-check failures are not product test failures and are not
passes. ShellSpan and the vendored PTY code have no Windows
architecture-specific gate. Tauri 2.11.5 resolves for the ARM64 target, the
resolved Windows dependencies include `windows_aarch64_msvc` artifacts, and the
vendored ConPTY target check succeeds. Native Windows must still supply the
matching MSVC/Windows SDK environment and run the package command above.

## Current Phase 2 matrix disposition

| Lane | Status | Qualification |
| --- | --- | --- |
| macOS zsh | **PASS** | Native host visible-terminal and PTY evidence |
| macOS bash | **PASS** | Native host, explicit shell-specific broker PTY test |
| Linux bash | **PASS (VM/container)** | Debian 12/aarch64 Docker Desktop LinuxKit guest |
| Linux zsh | **PASS (VM/container)** | Debian 12/aarch64 Docker Desktop LinuxKit guest |
| Isolated SSH `/bin/sh` | **PASS** | Loopback Docker fixture; separate from the Linux local-PTY lane |
| Windows PowerShell 5.1 / PowerShell 7 ConPTY | **MISSING** | User-approved temporary Phase 2 gate waiver; still required before Phase 6 default enablement or wrapper removal |
| Bare-metal Linux | **MISSING** | Container evidence must not be relabeled as bare-metal; not an additional Phase 2 minimum-environment requirement |

## Formal Session handoff contract

### 1. Exact worktree status and files changed

The authoritative `git status --short` at handoff is:

```text
 M package.json
 M protocol/agent/runtime/event-v5.schema.json
 M scripts/verify-agent-visible-terminal.mjs
 M src-tauri/examples/terminal_transport_baseline.rs
 M src-tauri/src/agent_runtime/native/runtime.rs
 M src-tauri/src/agent_runtime/native/terminal_lease.rs
 M src-tauri/src/agent_runtime/runtime.rs
 M src-tauri/src/agent_runtime/session.rs
 M src-tauri/src/commands.rs
 M src-tauri/src/connection.rs
 M src-tauri/src/execution/fixture.rs
 M src-tauri/src/lib.rs
 M src-tauri/src/models.rs
 M src-tauri/src/session.rs
 M src/components/ai/__tests__/ai-workspace-controller.test.tsx
 M src/components/ai/agent-execution-surface-selector.tsx
 M src/components/ai/workspace/ai-workspace-controller.tsx
 M src/components/terminal/__tests__/terminal-pane.test.tsx
 M src/components/terminal/terminal-pane.tsx
 M src/hooks/__tests__/useReconnectSession.test.ts
 M src/hooks/useReconnectSession.ts
 M src/lib/ai/__tests__/session-adapters.test.ts
 M src/lib/ipc/__tests__/tauri.test.ts
 M src/lib/ipc/tauri.ts
 M src/locales/en-US.ts
 M src/locales/zh-CN.ts
 M src/stores/__tests__/terminalStore.test.ts
 M src/stores/terminalStore.ts
 M src/types/index.ts
?? protocol/agent/runtime/fixtures/
?? protocol/agent/runtime/terminal-execution-compatibility.md
?? protocol/agent/runtime/terminal-execution-phase-0-baseline.md
?? protocol/agent/runtime/terminal-execution-phase-2-acceptance.md
?? protocol/agent/runtime/terminal-execution-roadmap.md
?? protocol/agent/runtime/terminal-execution-test-matrix.md
?? protocol/agent/runtime/terminal-protocol-rfc.md
?? protocol/agent/runtime/terminal-protocol-v1.schema.json
?? scripts/__tests__/terminal-broker-windows-runner.test.mjs
?? scripts/__tests__/terminal-protocol-contract.test.mjs
?? scripts/verify-terminal-broker-linux-container.mjs
?? scripts/verify-terminal-broker-windows.mjs
?? src-tauri/src/terminal_broker.rs
?? src/components/ai/__tests__/agent-execution-surface-selector.test.tsx
?? src/lib/terminal/__tests__/terminal-surface-semantics.test.ts
?? src/lib/terminal/terminal-surface-semantics.ts
?? src/locales/__tests__/
?? tests/terminal-broker-linux/
```

This is the shared Phase 0-2 initiative worktree plus any pre-existing user
changes; no existing change was reverted, overwritten, staged, committed, or
reclassified. The four known include-format debt files
`image_tests.rs`, `runtime_archive_tests.rs`, `runtime_loop_guard_tests.rs`, and
`session_inbox_steer_tests.rs` were not modified.

### 2. Phase 2 requirement completion

| Requirement | Disposition | Evidence |
| --- | --- | --- |
| Backend-owned stable session identity and reconnect generation | **PASS** | Broker attachment/snapshot/reconnect tests; stale generation data is rejected and restored pre-broker workspaces attach fresh. |
| Raw byte observation before UTF-8 decoding or legacy filtering | **PASS** | PTY read bytes are observed directly and compared byte-for-byte; invalid UTF-8 and ANSI evidence is retained. |
| Exact ordered frames, sequence, and byte offsets | **PASS** | Contiguous sequence/offset assertions and raw concatenation equality. |
| Bounded replay plus duplicate/gap/stale rules | **PASS** | Frame/byte limits, `has_more`, duplicate handling, gap rejection, and generation reset tests. |
| Independent display, capture, integration, and screen subscribers | **PASS** | Subscriber isolation and independent byte-count/capture-bound tests; display remains immutable. |
| Startup and high/low-watermark backpressure retained | **PASS** | Startup readiness/timeout safety valves, bounded reader queue, pause/resume, and frontend IPC tests. |
| One lease-authorized path for user, Agent, and scoped system input | **PASS** | Lease identity, sequence, takeover, system-control scope, and compatibility-write tests. |
| Atomic local/SSH broker attachment | **PASS** | Failure tests prove child/channel, SessionManager entry, and broker state are cleaned before returning an error. |
| Bounded closed session and transport metadata | **PASS** | Closed logical sessions are capped at 256 and superseded transport identities are dropped. |
| Trusted non-persisted `terminal_broker_v1` rollout | **PASS** | Explicit default-off environment decision, no frontend mutation IPC, bounded ephemeral records, and rollback-close semantics. |
| Shadow/compatibility mode only | **PASS** | Legacy display and wrapped PTY stay authoritative; no shell integration, `terminal_execute`, remote Agent PTY, screen model, or interactive-tool cutover. |
| macOS zsh/bash, Linux distribution, and isolated SSH evidence | **PASS with stated boundaries** | Native macOS, Debian 12/aarch64 Docker Desktop VM/container, and loopback SSH fixture evidence above. Linux evidence is not relabeled bare-metal. |
| Native Windows/ConPTY evidence | **MISSING — WAIVED FOR PHASE 2 ONLY** | User-approved temporary gate waiver. Static cfg/cross checks are not a native pass; debt remains mandatory before the Phase 6 boundary. |

### 3. Commands and exact results

| Command / gate | Result |
| --- | --- |
| `pnpm test` | **PASS** — 199 files passed, 1 skipped; 1,815 tests passed, 1 skipped. |
| `pnpm build` | **PASS** — 2,806 modules transformed; existing dynamic-import and large-chunk warnings only. |
| Focused Windows runner, protocol, and performance contracts | **PASS** — 3 files / 21 tests. |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check` | **PASS**. |
| `cargo check --locked --manifest-path src-tauri/Cargo.toml --all-targets` | **PASS**. |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml --example terminal_transport_baseline` | **PASS** — 1 exact-payload integrity test. |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml terminal_broker::tests --lib` | **PASS** — 10 tests on macOS. |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml` | First parallel run: **742 passed, 1 failed, 28 ignored**; the unrelated 20 ms recovery-window test in an excluded debt file failed while other build/check processes ran concurrently. |
| Exact retry of `network_recovery_window_expires_without_sending_an_extra_request` | **PASS** — 1 passed. No source change. |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml -- --test-threads=1` | **PASS** — library 743 passed / 28 ignored; integration 5 passed; main/doc 0 failures. |
| `pnpm check:ai-styles` | **PASS** — AI panel style boundaries are clean. |
| `pnpm check:llm:catalog` | **PASS** — 55 exact models validated; 4 negative fixtures rejected. |
| `pnpm check:rust:includes` | **KNOWN OUT-OF-SCOPE FAILURE** — formatting debt only in the four user-protected include files listed above; none was modified. |
| `pnpm test:agent-visible-terminal` | **PASS** earlier in this Phase 2 session, including Broker, lease, PTY, recovery, and frontend terminal gates. |
| `pnpm test:agent-visible-terminal:ssh` | **PASS** earlier in this Phase 2 session against the disposable loopback SSH fixture. |
| `pnpm test:terminal-broker:linux-container` | **PASS (VM/container)** with the exact suite counts and two warm benchmark rounds recorded above. |
| macOS framed broker-off/on benchmark | **PASS** — single 107.91/107.56 MiB/s; multi 192.69/186.27 MiB/s; broker event p95 0.007/0.038 ms. |
| `pnpm test:terminal-broker:windows` on this macOS host | **MISSING as designed**, exit 2; no native Windows/ConPTY evidence. |
| vendored portable-pty checks for `x86_64-pc-windows-msvc` and `aarch64-pc-windows-msvc` | **PASS static evidence only**. |
| Full ShellSpan Windows cross-target checks | **BLOCKED before ShellSpan** by missing Windows SDK/MSVC C headers in `ring`; not a pass and not a product failure. |
| `git diff --check` | **PASS**. |

### 4. Risks, compatibility, and required follow-up

- Windows PowerShell 5.1/PowerShell 7 over real ConPTY is still unexecuted and
  remains `MISSING`. The waiver must not be inherited by the Phase 6 default or
  removal decision.
- Before Phase 6 default enablement or legacy-wrapper removal, run
  `pnpm test:terminal-broker:windows` successfully on native x64 or ARM64
  Windows. Static compilation cannot discharge this debt.
- Bare-metal Linux remains `MISSING`; Debian in Docker Desktop is accepted as
  the required Linux distribution lane with an explicit VM/container boundary,
  not promoted to bare-metal evidence.
- `terminal_broker_v1` remains backend-trusted, non-persisted, and default off.
  Legacy display and the legacy wrapper remain authoritative and independently
  rollback-safe.
- The first parallel full-Rust retry-window failure and the earlier Docker VM
  scheduling outlier remain recorded rather than averaged away. Current exact
  and serialized reruns pass.
- The four include formatting debts are outside Phase 2 and explicitly
  protected from modification in this handoff.

### 5. Recommendation

**PASS for Phase 2 with waived Windows native evidence. Phase 3 is READY to be
opened in a new dedicated session; Phase 3 was not started here.**

## Gate recommendation

**PASS for Phase 2 under the user-approved Windows evidence waiver. Phase 3 is
READY, but has not been started.** The Windows/ConPTY lane and bare-metal Linux
evidence remain explicitly `MISSING`, not `PASS`. The Windows debt is a hard
blocker before Phase 6 default enablement or legacy-wrapper removal.
