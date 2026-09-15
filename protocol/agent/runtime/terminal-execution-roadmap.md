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
| 2. Terminal Session Broker | `01a0a304-aba8-77a0-bb6a-1679805d3c61` | complete (waived Windows native evidence) | [Phase 2 evidence](./terminal-execution-phase-2-acceptance.md) |
| 3. Local visible command | `01a0a3a5-747a-7af2-b6ec-392a60141fed` | **complete (waived Windows native evidence)** | [Phase 3 evidence](./terminal-execution-phase-3-acceptance.md) |
| 4. Remote real terminal | `01a0a461-d04c-7d33-ba24-d2d314c773d8`; continuations `01a0a4cf-4ef0-71d2-8845-1ae963c3090a`, `01a0a4f2-3d68-78c3-b6f1-a39b18f6f03d` | **remediation verified; NOT READY (pre-existing Rust include-format gate)** | [Phase 4 evidence](./terminal-execution-phase-4-acceptance.md) |
| 5. Interactive operation | not created | **blocked — not started** | Phase 4 still requires a green or explicitly waived `check:rust:includes` gate |
| 6. Rollout and legacy removal | not created | blocked by phase 5 | staged default enablement, migration evidence, wrapper removal, final verification |

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
- No functional cutover from the legacy wrapper in this phase.

Gate:

- Display receives the same PTY payload in order, capture cannot mutate display, reconnect changes generation, and transport/performance tests show no material regression.

Acceptance evidence: [Terminal Execution Phase 2 Acceptance Evidence](./terminal-execution-phase-2-acceptance.md).
The native macOS zsh/bash and isolated SSH lanes pass. Debian 12/aarch64
bash/zsh pass inside the Docker Desktop LinuxKit VM/container and are recorded
as VM/container evidence, not bare-metal. Native Windows/ConPTY remains
**MISSING**, not `PASS`. On 2026-09-15 the user approved a temporary Phase 2
gate waiver for that native Windows evidence, so Phase 2 is complete under the
waiver and Phase 3 is ready to open in a separate session. Static cross-target
compilation is supporting evidence only and cannot replace a native ConPTY run.
The native entry point is `pnpm test:terminal-broker:windows`; it has static
contract and vendored ConPTY cfg evidence for both x86_64 and ARM64 MSVC targets
only and has not run on Windows. The runner accepts native x64 and ARM64 Windows
and requires the corresponding Rust host tuple. This waiver expires before any
Phase 6 default enablement or removal of the legacy wrapper: the native Windows
lane must pass before either action.

## Phase 3: local visible command

Deliverables:

- Shell integration for bash, zsh, Windows PowerShell, and PowerShell 7; unsupported shells degrade explicitly.
- Generation-bound cooperative lifecycle events for prompt start/end, command start/end, exact command line, exit status, and current directory.
- A `terminal_execute` native tool and contract that submits real input to the current interactive shell without `/bin/sh -c`, nested PowerShell, hidden BEGIN/END wrappers, or synthetic command echo.
- Command-scoped output capture and uncertainty semantics.
- Feature-flagged compatibility fallback during migration.

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
execute flags and all identity/capability gates pass; defaults remain off and
legacy fallback remains available. Windows PowerShell 5.1 and PowerShell 7
implementation/static contracts follow the same cooperative model, but native
ConPTY execution and full `$?`/`$LASTEXITCODE` semantics are **MISSING**, never
`PASS`, under the user's explicit deferral. That Windows debt must be discharged
before Phase 6 default enablement or legacy-wrapper removal. Phase 3 is complete
under the recorded waiver; Phase 4 is ready for a separate future session and
was not started here.

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
related product checks pass. Phase 4 remains **NOT READY** only because the
pre-existing extracted-test `check:rust:includes` gate is not green or waived;
Phase 5 must not open. The remote flag
remains default-off and depends on broker + integration + execute. Native
Windows/ConPTY remains **MISSING**, not `PASS`, under the existing explicit
deferral and continues to block Phase 6 default enablement/legacy removal.

## Phase 5: interactive terminal operation

Deliverables:

- Terminal tools for text/key input, rendered screen snapshots, and bounded waits for lifecycle events, text/screen changes, idle output, and terminal closure.
- A backend headless terminal model with rows, columns, cursor state, active/alternate buffer, title, content, and monotonic screen version.
- Permission and audit classification for text, control keys, paste, interrupt, and terminal ownership.

Gate:

- Deterministic fixtures prove operation of a REPL, a confirmation menu, a credential-like prompt without secret leakage, and a curses/alternate-screen application.
- User takeover prevents all later Agent input for the released operation.

## Phase 6: rollout and legacy removal

Deliverables:

- Separate feature flags for the broker, shell integration, and interactive tools, with documented rollback behavior.
- Privacy-safe counters for integration readiness, degraded fallback, lifecycle matching, uncertainty, timeout, takeover, truncation, backpressure, and transport latency.
- Default enablement after local and SSH acceptance gates pass.
- Completion of the still-`MISSING` native Windows/ConPTY lane before any
  default enablement or removal of the legacy wrapper; the Phase 2 waiver does
  not apply at this boundary and static cross-compilation is not a substitute.
- Removal of the legacy wrapper, marker parser, synthetic `[Agent]` echo, and obsolete compatibility tests only after the new path has stable default evidence.
- Updated user and protocol documentation.

Final gate:

- Direct execution has no regression.
- Visible command execution is wrapper-free and shell-state preserving.
- Interactive operation is screen-driven and lease safe.
- Frontend build, frontend tests, Rust tests, formatting, protocol checks, locale checks, AI style checks, LLM catalog checks, and the visible-terminal host gate pass at the appropriate scope.

## Session handoff contract

Every phase session must finish with:

1. The exact worktree status and files changed.
2. A requirement-by-requirement completion table for that phase.
3. Commands run and their exact result, including skips and missing platform evidence.
4. Known risks, compatibility decisions, and follow-up work that belongs to later phases.
5. A clear `PASS` or `NOT READY` recommendation for opening the next phase session.

The orchestration session reviews this evidence and updates the phase tracker before creating the next dedicated session.
