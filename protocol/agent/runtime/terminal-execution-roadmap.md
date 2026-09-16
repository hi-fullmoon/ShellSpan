# Terminal Execution Roadmap

Status: active  
Owner: ShellSpan Agent Runtime  
Objective: replace the legacy wrapped visible-command path with three explicit capabilities: reliable direct execution, real visible command execution in a PTY, and interactive terminal operation.

## Delivery rules

- Each phase is implemented and verified in a separate Codex session.
- Phases run sequentially. A later phase must not start until the previous phase gate is satisfied in the shared worktree.
- Do not create commits, tags, or releases unless the user explicitly requests them.
- Preserve unrelated worktree changes and follow the repository `AGENTS.md` instructions.
- Keep compatibility at persisted protocol boundaries. Prefer additive migrations and explicit deprecation over silent reinterpretation.
- A phase is complete only when its listed behavior, tests, and verification commands are all evidenced in its handoff.

## Product model

The product exposes two user-facing execution surfaces:

1. **Direct execution**: reliable process or SSH exec with structured stdout, stderr, exit status, background handles, and cancellation.
2. **Real terminal**: a real local PTY/ConPTY or SSH PTY whose input and output are visible without display rewriting.

The real-terminal surface provides two Agent capabilities:

- **Visible command**: submit a command to an integrated interactive shell and obtain generation-bound cooperative lifecycle metadata.
- **Interactive operation**: observe the rendered screen and send terminal text or key input to REPLs, prompts, and full-screen applications.

These are three runtime capabilities but only two user-facing surface choices. Interactive operation is selected by the runtime when the task requires it.

## Cross-phase invariants

- PTY output is an append-only observed byte stream. Model capture and semantic parsing must not rewrite the stream delivered to the terminal emulator.
- User and Agent input share one lease-enforced authorization path.
- Prompt detection must not depend on prompt text or regular expressions.
- Command completion and exit status must come from the isolated shell-integration control plane, never raw PTY output.
- A terminal reconnect creates a new generation and invalidates old command ownership and integration state.
- An interrupted or disconnected operation with no accepted cooperative completion is `uncertain` and is never replayed automatically.
- Visible terminal integration is not a security sandbox. Secrets, authorization checks, security-sensitive effects, adversarial code, and untrusted scripts requiring process-isolated lifecycle evidence use Direct execution.
- Credentials, secrets, integration nonces, and raw sensitive output are not written to logs or ordinary persisted configuration.
- Unsupported or degraded integration is explicit to the UI and runtime. It must not masquerade as a real visible terminal.

## Phase tracker

| Phase | Session | State | Gate |
| --- | --- | --- | --- |
| 0. Protocol and baseline | `01a0a2d3-ea0c-77e1-b47d-ceda5d892fc3` | complete | RFC, compatibility plan, fixtures, and baseline evidence |
| 1. Product semantics | `01a0a2ee-f8ad-72e1-8745-32ef2b48037d` | complete | accurate UI naming, states, i18n, and migration-safe persisted values |
| 2. Terminal Session Broker | `01a0a304-aba8-77a0-bb6a-1679805d3c61`; Windows supplement `01a0a566-6a29-74a3-945e-cc310a46cecd` | **complete — PASS** | [Phase 2 evidence](./terminal-execution-phase-2-acceptance.md) and [Windows supplement](./terminal-execution-phase-5-acceptance.md) |
| 3. Local visible command | `01a0a3a5-747a-7af2-b6ec-392a60141fed`; Windows supplement `01a0a566-6a29-74a3-945e-cc310a46cecd` | **complete — PASS** | [Phase 3 evidence](./terminal-execution-phase-3-acceptance.md) and [Windows supplement](./terminal-execution-phase-5-acceptance.md) |
| 4. Remote real terminal | `01a0a461-d04c-7d33-ba24-d2d314c773d8`; continuations `01a0a4cf-4ef0-71d2-8845-1ae963c3090a`, `01a0a4f2-3d68-78c3-b6f1-a39b18f6f03d`, `01a0a500-3512-7be2-9516-7bfc9813ed66` | **complete — PASS** | [Phase 4 evidence](./terminal-execution-phase-4-acceptance.md) |
| 5. Interactive operation | `01a0a566-6a29-74a3-945e-cc310a46cecd`; macOS continuation (2026-09-16) | **complete — PASS (Windows + macOS local)** | [Windows evidence](./terminal-execution-phase-5-acceptance.md) and [macOS evidence](./terminal-execution-phase-5-macos-acceptance.md) |
| 6. Rollout and legacy removal | Windows and macOS rollout continuations (2026-09-16) | **complete — PASS (Windows + macOS local)** | [Windows evidence](./terminal-execution-phase-6-acceptance.md) and [macOS evidence](./terminal-execution-phase-6-macos-acceptance.md) |

## Phase 0: protocol and baseline

Deliverables:

- A reviewed terminal protocol RFC under `protocol/agent/runtime/` that defines session generation, raw-output frames, integration states and events, command lifecycle, screen snapshots, lease ownership, cancellation, takeover, uncertainty, and reconnect behavior.
- A compatibility table covering existing `AgentExecutionSurface`, `exec_command.channel`, event v5, persisted sessions, direct process handles, and the legacy PTY wrapper.
- A test matrix for local macOS/Linux/Windows and the isolated SSH fixture.
- Baseline evidence for direct execution, current terminal transport, visible-terminal tests, and terminal performance contracts.
- Named feature flags and a rollback rule for each migration stage.

Required verification:

- `pnpm test` for protocol/frontend contract coverage relevant to changed files.
- Targeted Rust tests for Agent native PTY, lease, direct execution, and recovery behavior.
- `pnpm test:agent-visible-terminal` when the host environment supports the full gate.
- Record any platform-specific or fixture-specific skip as explicit missing evidence, not as a pass.

## Phase 1: product semantics

Deliverables:

- Rename the current user-facing mode to a compatibility-accurate visible-command label while retaining migration-safe stored enum values.
- Define UI states for real-terminal ready, initializing, unavailable, degraded, and direct fallback.
- Keep stop-and-take-over, input locking, focus behavior, approval, and accessibility semantics.
- Update both locale catalogs and their key-set checks.

Gate:

- UI and persisted-state tests prove existing sessions remain loadable and the product never labels legacy wrapped execution as a real terminal.

## Phase 2: Terminal Session Broker

Deliverables:

- A backend-owned terminal session record containing session id, generation, transport kind, geometry, output sequence, integration state, active command, screen version, and lease owner.
- A byte-oriented raw-output pipeline that fans out to display transport, bounded capture, shell-integration parsing, and the future screen model.
- Ordered frame sequencing, bounded replay/deduplication behavior, and retained high/low-watermark backpressure.
- One lease-authorized input path for user, Agent, and system control input.
- This historical phase did not yet perform the later cooperative cutover.

Gate:

- Display receives the same PTY payload in order, capture cannot mutate display, reconnect changes generation, and transport/performance tests show no material regression.

Acceptance evidence: [Terminal Execution Phase 2 Acceptance Evidence](./terminal-execution-phase-2-acceptance.md).
The native macOS zsh/bash and isolated SSH lanes pass. Debian 12/aarch64
bash/zsh pass inside the Docker Desktop LinuxKit VM/container and are recorded
as VM/container evidence, not bare-metal. The original session temporarily
waived native Windows evidence. That debt was closed on 2026-09-16 by
`pnpm test:terminal-interactive:windows` on native
`x86_64-pc-windows-msvc` with Windows PowerShell 5.1 and PowerShell 7.6. The
runner passed raw Broker ordering/resize, Direct and compatibility regressions,
the full serial Rust suite, and two independent release performance rounds.
Phase 2 is therefore **PASS** at the current Windows delivery boundary.

## Phase 3: local visible command

Deliverables:

- Shell integration for bash, zsh, Windows PowerShell, and PowerShell 7; unsupported shells degrade explicitly.
- Generation-bound cooperative lifecycle events for prompt start/end, command start/end, exact command line, exit status, and current directory.
- A `terminal_execute` native tool and contract that submits real input to the current interactive shell without `/bin/sh -c`, nested PowerShell, hidden BEGIN/END wrappers, or synthetic command echo.
- Command-scoped output capture and uncertainty semantics.
- A temporary migration fallback, removed by the final Phase 6 product cutover.

Gate:

- `cd`, `export`, aliases, functions, shell options, ANSI output, Unicode, no-final-newline output, large output, cancellation, timeout, and takeover behave like manual input in the same shell.
- Forged raw PTY lifecycle-like output cannot complete an operation, and ordinary external children inherit no writable control endpoint.

Acceptance evidence: [Terminal Execution Phase 3 Acceptance Evidence](./terminal-execution-phase-3-acceptance.md).
Native macOS bash/zsh and Debian 12/aarch64 bash/zsh in the Docker Desktop
LinuxKit VM/container pass the production and adversarial visible-command
matrix. On 2026-09-15 the RFC was explicitly amended after review showed that
isolating an interactive shell hook from arbitrary same-UID or in-process shell
code is neither implementable for state-preserving integration nor an accurate
industry/product promise. The accepted boundary is a generation-bound isolated
control plane with cooperative lifecycle evidence: raw PTY bytes cannot advance
lifecycle, ordinary foreground children inherit no writer, validation remains
fail-closed, and active same-UID discovery or deliberate hook tampering is a
documented out-of-scope threat. Visible terminal is never a security sandbox;
known sensitive/destructive/external effects and explicit adversarial or
untrusted-script requests are forced to Direct execution.

POSIX production readiness is available only when the broker, integration, and
execute flags and all identity/capability gates pass. Native macOS bash/zsh
Phase 5/6 acceptance passed on 2026-09-16, so the macOS local path is now
default-on and wrapper-free; Linux reports visible commands unavailable.
Native Windows PowerShell 5.1 and PowerShell 7.6 ConPTY acceptance also passed
on 2026-09-16. Phase 6 therefore enables the local Windows path by default. It
proves persistent directory,
environment, alias and function state, exact cooperative command lifecycle,
ANSI/Unicode output, native exit code `7`, cmdlet failure code `1`, and bounded
large-output capture. The previous Phase 3 Windows waiver is closed.

## Phase 4: remote real terminal

Deliverables:

- A dedicated Agent SSH channel using `pty-req` and an interactive shell, surfaced as an ordinary terminal tab/pane.
- Remote shell-integration bootstrap with explicit supported and degraded states.
- Generation-safe disconnect and reconnect handling.
- No default takeover of an arbitrary user-owned remote shell in the first release.

Gate:

- The isolated SSH fixture proves visible execution, persistent shell state, resize, cancellation, takeover, disconnect uncertainty, and non-replay of uncertain side effects.

Acceptance evidence: [Terminal Execution Phase 4 Acceptance Evidence](./terminal-execution-phase-4-acceptance.md).
The earlier disposable loopback Alpine sshd fixture passed real bash/zsh Agent
SSH PTY execution and the original Phase 4 matrix, but an independent review
reopened the phase for candidate ownership, post-prepare cleanup, predecessor
shutdown, and success-publication races. Those findings now have focused
regression coverage. The current-code real-SSH, full Rust, frontend, build, and
related product checks pass. The final continuation corrected the extracted
test `include!` formatting gate without excluding discovered files; the gate
and its regression tests now pass. Phase 4 is **PASS**. The remote visible-command
flag is default-on for Windows and macOS desktop hosts and depends on broker +
integration + execute. Remote interactive tools remain independently
default-off. The previously
separate native Windows prerequisite was closed by the 2026-09-16 consolidated
Windows gate recorded in the Phase 5 evidence.

## Phase 5: interactive terminal operation

Deliverables:

- Terminal tools for text/key input, rendered screen snapshots, and bounded waits for lifecycle events, text/screen changes, idle output, and terminal closure.
- A backend headless terminal model with rows, columns, cursor state, active/alternate buffer, title, content, and monotonic screen version.
- Permission and audit classification for text, control keys, paste, interrupt, and terminal ownership.

Gate:

- Deterministic fixtures prove operation of a REPL, a confirmation menu, a credential-like prompt without secret leakage, and a curses/alternate-screen application.
- User takeover prevents all later Agent input for the released operation.

Acceptance evidence: [Windows Phase 5 Evidence](./terminal-execution-phase-5-acceptance.md) and [macOS Phase 5 Evidence](./terminal-execution-phase-5-macos-acceptance.md).
The backend screen model, gated native tools, lease-safe input, credential-like
prompt handling, bounded waits, and deterministic fixtures pass. Independent
real-ConPTY fixtures also pass for Windows PowerShell 5.1 and PowerShell 7.6,
covering REPL input, a single-key confirmation, resize, alternate-screen state,
and fail-closed credential input. A later native macOS continuation passed the
same production Broker/screen/lease path on bash 3.2 and zsh 5.9. Phase 5 is
therefore **PASS for Windows and macOS local targets**. Linux and Phase 5 SSH
remain explicitly deferred and unverified; their flags stay off and visible
commands are unavailable. The missing SSH Phase 5 gate no longer blocks
the already-passed Phase 4 remote visible-command rollout.

## Phase 6: rollout and legacy removal

Deliverables:

- Separate feature flags for the broker, shell integration, and interactive tools, with documented rollback behavior.
- Privacy-safe counters for integration readiness, lifecycle matching, uncertainty, timeout, takeover, truncation, backpressure, and transport latency.
- Platform-scoped default enablement after each native acceptance gate passes;
  enable the passed remote visible-command path independently, while keeping
  remote interactive tools and the Linux new path default-off until their
  independent Phase 5 gates pass.
- Platform rollback makes visible commands unavailable while Direct remains
  independently available; it never revives another execution mechanism.
- Remove the legacy wrapper, marker parser, synthetic `[Agent]` echo, `pty`
  channel, fallback flag, and obsolete compatibility tests.
- Updated user and protocol documentation.

Final gate:

- Direct execution has no regression.
- Visible command execution is wrapper-free and shell-state preserving.
- Interactive operation is screen-driven and lease safe.
- Frontend build, frontend tests, Rust tests, formatting, protocol checks, locale checks, AI style checks, LLM catalog checks, and the visible-terminal host gate pass at the appropriate scope.

Acceptance evidence: [Windows Phase 6 Evidence](./terminal-execution-phase-6-acceptance.md) and [macOS Phase 6 Evidence](./terminal-execution-phase-6-macos-acceptance.md).
On native Windows 11 x64, absent trusted configuration now enables the local
Broker, shell integration, `terminal_execute`, and interactive tools. Windows
local routing cannot dispatch a wrapper, including during rollback; it exposes
Direct explicitly instead. The `pty` vocabulary and wrapper/parser
implementation have been removed. Privacy-safe bounded counters and deterministic
latency sampling are exposed through the existing read-only Broker snapshot.
The consolidated Windows gate, frontend checks, repository checks, and two
release performance rounds pass. The independent macOS gate passes native
bash/zsh Broker, visible-command, interactive-operation, Direct, full serial
Rust, and two release performance rounds; macOS local routing is now
default-on and wrapper-free. Phase 6 is **PASS for the Windows and macOS local
delivery scopes**. Remote visible commands are also default-on for Windows and
macOS desktop hosts using the passed Phase 4 SSH path. Linux rollout, remote
interactive tools, and cross-platform legacy removal remain deferred.

## Session handoff contract

Every phase session must finish with:

1. The exact worktree status and files changed.
2. A requirement-by-requirement completion table for that phase.
3. Commands run and their exact result, including skips and missing platform evidence.
4. Known risks, compatibility decisions, and follow-up work that belongs to later phases.
5. A clear `PASS` or `NOT READY` recommendation for opening the next phase session.

The orchestration session reviews this evidence and updates the phase tracker before creating the next dedicated session.
