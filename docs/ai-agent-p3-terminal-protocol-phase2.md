# P3 Agent terminal semantic protocol — phase 2 evidence

## Scope and status

This phase starts from `codex/agent-pty-lease-phase1` commit `7cde409c6800f26b119a4c7a7ca134c70d2b5c7b`. It preserves the phase-1 `SessionKind::AgentPty`, `TerminalLease`, and ordinary-input fence, then adds the strict protocol, compile-time driver boundary, renderer, prompt policy, and an internal lease-bound controller.

P3 remains `planned`. This phase does not connect a provider/model loop, production Agent manager, approval IPC, operation history, or UI. It registers no `agent_write_session`-style command and does not claim generic TUI/computer-use support.

## Frozen model-facing contract

`protocol/agent-terminal/v1/terminal-actions.schema.json` is a separate version namespace. Agent decision v1 and v2 remain unchanged and reject every terminal action. The four closed variants are:

- `terminal.start`: fixed compile-time driver and program plus structured scenario enum.
- `terminal.respond`: current backend observation ID plus a closed response enum.
- `terminal.key`: current backend observation ID plus the minimal closed key enum.
- `terminal.handoff`: current backend observation ID plus a closed transfer-reason enum.

The contract deliberately has no run ID, target identity, session ID, lease token, command, PTY data, text response, environment, cwd, shell, or argv escape hatch. Unknown, missing, and extra fields fail closed in Rust, TypeScript, and JSON Schema. Input is capped at 16 KiB before decode.

## Registry and sole renderer

`src-tauri/src/agent/terminal_driver.rs` contains the compile-time registry. The initial entry is the deterministic `fixture.shellPrompt` / `termbridge-interactive-fixture` pair with `confirm` and `choice` structured scenarios. There is no generic driver and no arbitrary executable lookup.

`render_terminal_action_v1` is the sole renderer. A start becomes a direct registered-program launch intent with fixed argv, never `shell -c`. Responses become one of four fixed single-line inputs. Key names become fixed internal control bytes only after local policy succeeds. The opaque rendered-input type has no public constructor. Handoff renders only a transfer intent and never a terminal write.

## Backend authority and prompt policy

`src-tauri/src/agent/terminal_policy.rs` owns the mutable interaction state. It binds actions and observations to the backend-provided run, target digest, Agent PTY binding, lease epoch/revision, active registry entry, monotonic prompt sequence, evidence ID, and current observation ID.

Responses and keys require a fresh observation (30-second maximum age), an unconsumed action and observation, an active Agent-owned lease, a supported line-prompt surface, a driver-matching prompt class, and a driver-specific response/key allowlist. A successful write advances the phase-1 lease revision exactly once. Ambiguous writer failure closes the controller and the same action is never automatically replayed.

Terminal output remains untrusted. The local detector can only elevate a driver claim to `password`, `passphrase`, `mfa`, `otp`, `token`, `credential`, or `unknownSensitive`; it cannot turn unknown/sensitive output into an automatable prompt. Control sequences and multiline prompt material also elevate to `unknownSensitive`. Sensitive and unknown prompts permit only handoff; full-screen, editor, and unknown surfaces reject response/key automation. A stale observation can still produce the safe handoff intent, but cannot produce input.

The controller implements `TerminalLeaseInputWriterV1` for crate-private `SessionManager`, which calls only phase 1 `write_agent_input`. Tests exercise both a deterministic fake lease writer and the real internal `SessionManager` seam. No Tauri command exposes this path.

## Shared fixtures and tests

- `tests/fixtures/agent-terminal-protocol/v1/terminal-actions.json`: valid action variants plus unknown version/action/driver/program/key, missing and extra fields, driver/argument mismatch, session/lease injection, arbitrary bytes, ESC, NUL, multiline paste, raw credential, and shell-interpretation attempts.
- `tests/fixtures/agent-terminal-protocol/v1/terminal-safety.json`: driver response/key corpus; password/passphrase/MFA/OTP/token/credential/unknown-sensitive detection; prompt control/multiline elevation; stale prompt; run/target/session/epoch/revision mismatch; replay; full-screen/editor denial; and handoff no-write behavior.
- Rust module tests also freeze registry uniqueness, renderer byte mappings, direct registered start argv, the real phase-1 seam, observation binding/size checks, and v1/v2 compatibility.
- TypeScript tests compile the schema in AJV strict mode, consume the same action and safety fixtures, and prove Agent v1/v2 reject the separate terminal actions.

Test results for this phase:

- Targeted TypeScript protocol tests: 19 passed, 0 failed.
- TypeScript production build: passed.
- Full TypeScript suite: 1288 passed, 1 pre-existing unrelated `useI18n` locale-switch test failed.
- Rust formatting: passed.
- Rust compilation/tests are blocked before test execution by the existing deployment baseline on the phase-1 starting commit: SHA-256 digest `LowerHex`, `rusqlite` `usize` conversion, non-exhaustive deployment error matches, and rollout statement lifetime errors. No deployment source was changed in this phase.

## Known limitations and next phase

- `terminal.start` returns a registered direct-launch intent; stage 2 does not create or launch a production process and the deterministic fixture executable is not shipped as a general CLI driver.
- A stage-3 launcher must resolve every registered executable to a backend-owned absolute or bundled path; it must not turn the current registry name into a mutable `PATH` lookup.
- Prompt extraction and production observation/evidence ingestion are not connected. The policy assumes a trusted local caller creates observations; it still treats prompt text itself as untrusted.
- Handoff is an intent only. Phase 3 must connect it to user takeover/revocation UI without adding a model-controlled lease operation.
- PTY output is never sufficient mutation evidence. Any later production driver must use independent structured/read-only postcondition evidence.
- Adding a driver, program, scenario, response, or key requires a compile-time registry/schema change plus Rust/TypeScript corpus updates; unknown additions fail closed.
