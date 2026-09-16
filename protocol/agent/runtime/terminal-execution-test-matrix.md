# Terminal Execution Platform Test Matrix

Status: accepted Phase 0 matrix; Phase 3 cooperative-shell amendment: 2026-09-15.

Protocol: [Terminal Session Protocol v1](./terminal-protocol-rfc.md)

## Evidence policy

Each cell is evidence from the named native host or fixture. Conditional
compilation on another platform is not a pass. A skipped, ignored, unavailable,
or unrun cell is recorded as **MISSING**, never inferred from another platform.
Tests use deterministic commands and must not depend on a developer's prompt
text, shell theme, credentials, or home-directory contents.

Required host lanes are:

| Lane | Minimum environment | Shells / transport |
| --- | --- | --- |
| macOS | current supported arm64 or x86_64 macOS | zsh and bash over local PTY |
| Linux | current supported x86_64 or arm64 distribution | bash and zsh over local PTY |
| Windows | current supported x86_64 or arm64 Windows | Windows PowerShell 5.1 and PowerShell 7 over ConPTY |
| Isolated SSH | `tests/ssh-e2e` Docker image and loopback-published port | Alpine bash/zsh interactive SSH PTYs plus unsupported `/bin/sh`; no external host |

## Cross-platform behavior matrix

`P0` means the current baseline must be captured in Phase 0. Later labels name
the first phase that must supply acceptance evidence.

| Scenario | macOS | Linux | Windows | Isolated SSH | Gate |
| --- | --- | --- | --- | --- | --- |
| Direct foreground stdout/stderr/exit | native process | native process | native process | SSH exec | P0 and every phase |
| Direct background handle, stdin, wait, kill | native process | native process | native process | SSH exec handle | P0 and every phase |
| Direct timeout/cancel terminal-state race | native process group | native process group | job object/process tree | SSH channel | P0 and every phase |
| Real transport smoke and resize | `portable-pty` | `portable-pty` | ConPTY | `pty-req` | P0 baseline; P2 regression |
| Startup listener gate and bounded transport backpressure | native worker + xterm contract | native worker + xterm contract | native worker + xterm contract | SSH worker + xterm contract | P0 baseline; P2 regression |
| Raw byte equality, sequence, replay/dedup, subscriber isolation | zsh/bash | bash/zsh | both PowerShell lanes | `/bin/sh` | P2 |
| Reconnect increments generation and rejects stale frames/input | local replacement | local replacement | ConPTY replacement | disconnect/reconnect | P2/P4 |
| Integration ready/degraded/unavailable and generation-bound cooperative event ordering | zsh/bash/unsupported shell | bash/zsh/unsupported shell | Windows PowerShell/PowerShell 7/unsupported shell | bash/zsh and unsupported `/bin/sh` | P3/P4 |
| Prompt lifecycle independent of prompt text | custom empty/multiline ANSI prompts | custom empty/multiline ANSI prompts | custom functions/themes | custom `PS1` | P3/P4 |
| Wrapper-free state preservation: `cd`, environment, alias/function, shell option | zsh and bash | bash and zsh | each PowerShell | bash and zsh | P3/P4 |
| Exact visible command, ANSI, Unicode, no final newline, nonzero exit | zsh and bash | bash and zsh | each PowerShell | bash and zsh | P3/P4 |
| Large output remains display-complete while capture truncates explicitly | local PTY | local PTY | ConPTY | SSH PTY | P3/P4 |
| Forged lifecycle-like output cannot start/complete a command | local PTY | local PTY | ConPTY | SSH PTY | P3/P4 |
| Ordinary foreground child enumerates descriptors and cannot write a lifecycle endpoint | zsh/bash real PTY | bash/zsh real PTY | static handle non-inheritance plus native ConPTY | SSH PTY | P3/P4 |
| Same-UID endpoint reopen / in-shell hook invocation is documented as cooperative-model tampering, not a sandbox claim | documented adversarial proof | documented adversarial proof | static module-access audit plus native debt | documented boundary | P3/P4 |
| Sensitive/destructive/external or explicit untrusted/adversarial lifecycle request is forced to Direct | native route/effect/policy | native route/effect/policy | native route/effect/policy | native route/effect/policy | P3/P4 |
| Cancel, timeout, completion race, takeover, and input rejection after release | local PTY | local PTY | ConPTY | SSH PTY | P3/P4 |
| Disconnect with side effect is uncertain and never auto-replayed | local close | local close | ConPTY close | forced SSH disconnect | P3/P4 |
| Resize updates rows/columns and screen version | local PTY | local PTY | ConPTY | SSH PTY | P5 |
| REPL, confirmation menu, credential-like prompt, alternate-screen application | deterministic fixtures | deterministic fixtures | deterministic fixtures | deterministic fixtures | P5 |
| Credential-like input/output absent from logs, snapshots, counters, and persisted session | native checks | native checks | native checks | native checks | P5/P6 |
| Transport throughput/latency has no material regression from Phase 0 | baseline harness | baseline harness | baseline harness | baseline harness | P2 and P6 |

## Phase 0 command matrix

| Evidence | Command | Pass condition |
| --- | --- | --- |
| Protocol/compatibility fixtures | `pnpm exec vitest run scripts/__tests__/terminal-protocol-contract.test.mjs` | TSP/1 fixture validates; event-v5 surface fixtures validate; `direct`/`pty` remain accepted. |
| Frontend contracts | `pnpm test` | Relevant contract tests pass; unrelated failure is recorded separately and cannot be called a pass. |
| Direct native execution | `cargo test --manifest-path src-tauri/Cargo.toml agent_runtime::native::process::tests --lib -- --nocapture` | All host-applicable direct process tests pass. |
| Lease behavior | `cargo test --manifest-path src-tauri/Cargo.toml agent_runtime::native::terminal_lease::tests --lib -- --nocapture` | Ownership, frontend readiness, release identity, and restart tests pass. |
| Current native PTY behavior | `cargo test --manifest-path src-tauri/Cargo.toml agent_runtime::native::pty::tests --lib -- --nocapture` | All host-applicable tests pass; ignored SSH case remains missing until the fixture command passes. |
| Recovery behavior | `cargo test --manifest-path src-tauri/Cargo.toml agent_runtime::recovery::tests --lib -- --nocapture` plus the visible-terminal recovery filter | An execution without a durable result is uncertain and not resumable/replayed. |
| Current transport contracts | targeted `commands::tests`, `session::tests`, terminal registry, and performance contract tests | UTF-8 boundaries, startup gates, bounded queues, ordering, resize, and high/low-watermark behavior pass. |
| Visible-terminal host gate | `pnpm test:agent-visible-terminal` | Formatting/check, host-native PTY/lease tests, recovery filters, and frontend terminal integration tests pass. |
| Isolated SSH visible gate | `pnpm test:agent-visible-terminal:ssh` | Docker fixture builds, becomes healthy, ignored SSH PTY test passes exactly, and compose cleanup succeeds. |
| Local transport performance | `cargo run --release --manifest-path src-tauri/Cargo.toml --example terminal_transport_baseline -- --bytes 2097152 --repetitions 5 --sessions 4` | Expected byte counts are received; median/p95 throughput and event-vs-poll latency are recorded. |
| SSH transport performance | Run the same example with `--ssh` and the loopback fixture environment | Expected bytes are received for single and four-session SSH PTYs; measurements are recorded. |

## Deterministic fixture requirements for later phases

The isolated SSH fixture must remain loopback-only and disposable. Later phases
may extend it with scripts for persistent directory/environment state, resize,
forced disconnect, side-effect counters, REPL/menu/password-like prompts, and an
alternate-screen application. Fixture secrets are test-only constants and must
still be redacted from captured evidence. Host credentials or arbitrary user
terminals are never used for acceptance tests.

Every later-phase handoff updates this matrix with exact command output and
marks unexecuted native platforms **MISSING**. A platform-scoped gate may pass
only for its evidenced platform; it does not imply or enable another platform.

## Phase 2 acceptance status

Detailed evidence: [Terminal Execution Phase 2 Acceptance Evidence](./terminal-execution-phase-2-acceptance.md).

| Lane | Phase 2 result | Evidence boundary |
| --- | --- | --- |
| macOS zsh | **PASS** | Native Darwin arm64 host |
| macOS bash | **PASS** | Native `/bin/bash` PTY; explicit raw-byte Broker test |
| Linux bash and zsh | **PASS (VM/container)** | Debian 12/aarch64 inside Docker Desktop LinuxKit; not bare-metal |
| Isolated SSH `/bin/sh` | **PASS** | Loopback-only disposable SSH fixture |
| Windows PowerShell 5.1 and PowerShell 7 | **PASS** | Native Windows 11 x64 / ConPTY consolidated gate passed on 2026-09-16; exact Broker tests and two release performance rounds passed. |
| Bare-metal Linux | **MISSING** | Docker Desktop evidence is not promoted to bare-metal evidence; bare metal is not an additional Phase 2 minimum-environment requirement |

Native Windows command: `pnpm test:terminal-broker:windows`. The command must
exit nonzero with an explicit `MISSING` result when Windows PowerShell 5.1,
PowerShell 7, a supported x86_64 or arm64 Windows host, or the matching MSVC
Rust host toolchain is unavailable. The architecture mapping is
`x64` -> `x86_64-pc-windows-msvc` and
`arm64` -> `aarch64-pc-windows-msvc`.

The original Phase 2 waiver is closed. `pnpm test:terminal-interactive:windows`
runs this entry point plus the Phase 3 and Phase 5 Windows lanes and exits
nonzero if any required host, shell, functional, or performance check fails.

## Phase 3 acceptance status

Detailed evidence: [Terminal Execution Phase 3 Acceptance Evidence](./terminal-execution-phase-3-acceptance.md).

Overall gate: **PASS for Phase 3 under the 2026-09-15 cooperative-shell RFC
amendment**. The macOS, Linux, and Windows lanes pass their functional and
in-scope gates. The private
POSIX FIFO is a generation-bound isolated control plane, not authentication
against arbitrary same-UID code: raw PTY bytes cannot reach it, ordinary
foreground children inherit no writer, and deliberate same-UID reopen or
in-shell hook tampering is recorded as out-of-scope. Security-sensitive or
explicit adversarial/untrusted lifecycle requests are forced to Direct.

| Lane | Phase 3 result | Evidence boundary |
| --- | --- | --- |
| macOS zsh | **PASS** | Native Darwin arm64 production-config real PTY matrix; raw-output forgery, descriptor non-inheritance, path non-disclosure, state, capture, cancellation, takeover, and uncertainty gates pass. Same-UID active reopen remains the documented cooperative non-goal. |
| macOS bash | **PASS** | Native Darwin arm64 `/bin/bash` 3.2 production-config real PTY matrix with the same in-scope security and behavior gates. |
| Linux bash and zsh | **PASS (VM/container)** | Debian 12/aarch64 inside Docker Desktop LinuxKit with `C.UTF-8`; focused post-amendment production logic passes and is not promoted to bare-metal evidence. |
| Windows PowerShell 5.1 and PowerShell 7 | **PASS** | Native Windows 11 x64 / ConPTY independently passed exact lifecycle, persistent cwd/environment/alias/function state, ANSI/Unicode, native exit `7`, cmdlet failure `1`, and large-output capture on 2026-09-16. |
| Isolated SSH `/bin/sh` | **NOT APPLICABLE TO PHASE 3** | Remote real-terminal integration remains Phase 4 and was not started. |
| Bare-metal Linux | **MISSING** | VM/container evidence is not promoted to bare-metal; bare metal is not an additional Phase 3 minimum-environment requirement. |

Phase 3 native Windows entry: `pnpm test:terminal-visible:windows`. On a complete
Windows host it requires and runs both
`windows_powershell_5_1_visible_command_integration` and
`windows_powershell_7_visible_command_integration` over real ConPTY. On any
non-Windows host, missing PowerShell lane, unsupported architecture, or
mismatched Rust host it exits nonzero and reports `MISSING`. The native Windows
run passed on 2026-09-16 and closed the earlier waiver.

## Phase 4 acceptance status

Detailed evidence: [Terminal Execution Phase 4 Acceptance Evidence](./terminal-execution-phase-4-acceptance.md).

Overall gate: **PASS for the remote POSIX lane**. The isolated loopback Docker
fixture runs SSH `pty-req` plus interactive bash/zsh shells, uses a separate
cooperative control channel, and keeps a simultaneous user-owned SSH PTY
independent. Unsupported `/bin/sh` is explicitly `unavailable`. Direct SSH exec
passes independently. The separate native Windows prerequisite passed in the
2026-09-16 consolidated Windows gate; it is not part of the remote POSIX gate.

| Lane | Phase 4 result | Evidence boundary |
| --- | --- | --- |
| Isolated SSH bash | **PASS** | Alpine 3.22/aarch64 container in Docker Desktop LinuxKit; real SSH PTY, lifecycle/state/capture/resize/control/disconnect/reconnect matrix. |
| Isolated SSH zsh | **PASS** | Same isolated sshd; independently authenticated zsh login and state-preservation smoke. |
| Isolated SSH unsupported `/bin/sh` | **PASS (explicit unavailable)** | Separate fixture account proves no false-ready integration. |
| Direct SSH exec | **PASS** | Existing reviewed SSH execution fixture runs independently of remote terminal flags/channels. |
| User-owned SSH PTY isolation | **PASS** | A simultaneous real user-owned SSH shell retains its own state and is not selected by `terminal_execute`. |
| Native Windows PowerShell 5.1 / PowerShell 7 prerequisite | **PASS** | Consolidated native Windows Phase 2/3/5 gate passed on 2026-09-16. |

Phase 4 entry point: `pnpm test:terminal-visible:ssh`. It builds the disposable
fixture, waits for health, runs the exact ignored real-SSH tests plus Direct
regression, and always tears the compose project down.

## Phase 5 acceptance status

Detailed evidence: [Terminal Execution Phase 5 Acceptance Evidence](./terminal-execution-phase-5-acceptance.md).

Overall gate: **PASS for the Windows and macOS local delivery scopes**. The
Phase 5 implementation and deterministic core fixtures pass on native hosts,
including screen rendering,
resize/versioning, REPL/menu text, alternate-buffer state, credential-like
prompt redaction and input rejection, bounded waits, takeover fencing, and
non-persistence of text/paste payloads. Independent native PowerShell 5.1 and
PowerShell 7 ConPTY fixtures additionally exercise the production lease/input,
screen, and credential-safety path.

| Lane | Phase 5 result | Evidence boundary |
| --- | --- | --- |
| Deterministic Windows core | **PASS** | Native Windows Rust tests feed ordered terminal bytes through the production Broker and headless screen model; lease/input/takeover and durable audit boundaries use the production runtime. |
| Windows PowerShell 5.1 / PowerShell 7 over ConPTY | **PASS** | Both exact native fixtures pass REPL text, single-key confirmation, resize, alternate-screen entry/exit, credential-like prompt redaction/input rejection, raw observation, and restored user input. |
| macOS zsh and bash | **PASS** | Native macOS 26.6.2 arm64; both exact real-PTY fixtures pass REPL text, single-key confirmation, resize, alternate-screen entry/exit, credential-like prompt redaction/input rejection, and raw observation. |
| Linux bash and zsh | **MISSING — DEFERRED** | No current-code Phase 5 native PTY fixture has run on Linux; it is outside the first Windows delivery scope. |
| Isolated SSH bash and zsh | **MISSING — DEFERRED** | The Phase 4 SSH fixture has not been extended for Phase 5 interactive scenarios; remote interactive rollout remains off. |

The Windows and macOS Phase 6 continuations are complete. Linux and remote
targets retain default-off flags and the legacy wrapper until their independent
Phase 5 evidence is supplied.

## Phase 6 acceptance status

Detailed evidence: [Terminal Execution Phase 6 Acceptance Evidence](./terminal-execution-phase-6-acceptance.md).

Overall gate: **PASS for the Windows and macOS local rollout scopes**. The local
Broker, shell integration, visible command, and interactive tools are absent-on
after native acceptance. Neither local routing graph can select the wrapper;
degraded or disabled generations expose Direct without rerouting or replay.
Protocol vocabulary and persisted execution-surface values remain additive.

| Lane | Phase 6 result | Evidence boundary |
| --- | --- | --- |
| Windows PowerShell 5.1 / PowerShell 7 local ConPTY | **PASS — DEFAULT ON** | Native Windows 11 x64, `x86_64-pc-windows-msvc`; six exact real-ConPTY Broker/visible/interactive fixtures, Direct regression, full serial Rust, and two release performance rounds pass. |
| Persisted sessions and event-v5 vocabulary | **PASS — UNCHANGED** | `direct` / `boundTerminal` and `exec_command.channel = direct` / `pty` retain their stored/wire meanings; no migration rewrite or replay was added. |
| macOS zsh and bash | **PASS — DEFAULT ON** | Native macOS 26.6.2 arm64; exact Broker/visible/interactive fixtures, Direct regression, 798-test serial Rust suite, and two release performance rounds pass. Local wrapper routing is removed. |
| Linux bash and zsh | **MISSING — DEFERRED, DEFAULT OFF** | No Phase 5 native acceptance in this Windows continuation; wrapper/parser compatibility remains compiled and routable. |
| Isolated SSH bash and zsh | **MISSING — DEFERRED, DEFAULT OFF** | Phase 4 evidence remains valid, but remote interactive Phase 5 was not run; the remote flag stays off and wrapper fallback remains routable. |

Native Windows command: `pnpm test:terminal-rollout:windows`. It is an alias of
the consolidated host gate and reports `MISSING` rather than `PASS` if the
matching MSVC host, Windows PowerShell 5.1, or PowerShell 7 is unavailable.

Native macOS command: `pnpm test:terminal-rollout:macos`. It reports `MISSING`
rather than `PASS` unless the matching Darwin Rust host, `/bin/bash`, and
`/bin/zsh` are available.
