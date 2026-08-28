# P3 Agent terminal coordinator — phase 3 evidence

## Scope and admission status

This phase starts from `codex/agent-terminal-protocol-phase2` commit `f8f16915774b39c15c33c34e27a4ca7394a78d74`. It preserves both earlier hard boundaries: ordinary `write_session` cannot target `SessionKind::AgentPty`, and a model-facing `agent-terminal/v1` action cannot contain a run/session identity, lease authority, raw PTY bytes, a shell command, or free-form input.

P3 remains `planned`. `CURRENT_AGENT_TERMINAL_ADMISSION_V1` is checked in with P2 verification and the production feature disabled. The complete coordinator is exercised through deterministic fake integration only. No provider loop, arbitrary launcher, generic SSH/shell mutation adapter, or production modifying executor is connected.

## Sole effecting path and authority

`src-tauri/src/agent/terminal_coordinator.rs` owns every terminal interaction record. Its proposal seam strictly decodes `agent-terminal/v1`, evaluates local policy/risk, binds an exact one-time approval when required, revalidates the authoritative SessionManager lease, calls the phase-2 controller/sole renderer, and reaches only SessionManager's crate-private lease-fenced Agent input method.

The model still produces proposals only. It never receives the session ID, lease token, epoch/revision authority, or rendered bytes. There is no generic terminal execute/write IPC. The only raw string accepted by the new control plane is explicit user input for `agent_terminal_takeover_and_write`; SessionManager changes owner and enqueues that first user input under one lock.

Every effecting Agent input and the atomic user takeover input require a durable `writing` audit prewrite. A failed prewrite sends no bytes. Once `writing` is persisted, ambiguity becomes `unknownEffect` and the request cannot be automatically replayed.

## State machine, snapshot, journal, and idempotency

The backend sequence is authoritative. The closed state set is:

`proposed`, `validating`, `evaluatingRisk`, `awaitingApproval`, `approved`, `rejected`, `expired`, `revoked`, `writing`, `awaitingObservation`, `handoffRequired`, `completed`, `failed`, `cancelled`, and `unknownEffect`.

Terminal states are immutable. Action IDs reject changed replays; identical proposals are snapshot-idempotent. User control requests have a separate `clientActionId` cache. Approval use is single-shot. Snapshots contain bounded public control state, redacted observations, approval binding, actions, and journal events, but contain no approval token/challenge, lease token, credential, raw input/output, or full transcript.

## Exact approval and handoff

An approval binds the run, target digest, dedicated session, action digest, registered driver/program/scenario, current observation ID and digest, risk/policy digest, lease epoch/revision, issue time, expiry, and one-time state. The coordinator rereads SessionManager authority immediately before consumption. Expiry is enforced at the TTL boundary. Any binding change revokes the approval rather than falling through to a write.

Unknown/sensitive prompts are not approvable. Password, passphrase, MFA, OTP, token, credential, unknown-sensitive, alternate-screen, editor, installer, and unknown interaction paths revoke the actual phase-1 lease and enter `handoffRequired`. They never render an automatic response.

## Rust-side observation and privacy boundary

`src-tauri/src/agent/terminal_observation.rs` captures only while the Agent owns the lease. It strips ANSI CSI/OSC and control bytes, recognizes split alternate-screen markers, caps capture at 32 KiB, 200 lines, and 60 seconds, applies the generic secret redactor, classifies prompt/surface locally, and marks every model observation untrusted.

User takeover clears capture immediately. Output received while the user owns or no owner owns the PTY is discarded before transcript processing. Explicit return control rotates and clears the capture epoch while holding the coordinator lock, so user input echo cannot enter a later model observation. Raw user input is never copied into coordinator state, events, audit rows, or frontend operation logging.

## Audit, crash recovery, and verification

`src-tauri/src/agent/terminal_audit.rs` is a backend-only append writer over a fixed additive SQLite schema. Rows store only identities/digests, driver binding, risk/approval/lease facts, state, timestamp, and a bounded redacted preview. The schema has no raw input, raw output, credential, token/challenge, transcript, or arbitrary metadata column.

Startup recovery finds persisted actions whose latest state is `writing` or `awaitingObservation` and appends `unknownEffect`. It does not reconstruct a run, approval, lease owner, renderer request, or executable payload, so restart cannot replay input.

Every approved response/key creates a verification obligation. PTY output may complete the observation boundary but cannot mark the action verified. Only an exact run/target/obligation-bound, successful, independent read-only, structured verifier result can set `verified=true`. The production verifier remains blocked; tests provide the fake adapter.

## Narrow phase-4 control plane and lifecycle

The registered commands are limited to snapshot, resolve approval, takeover-and-write, return control, pause, and stop. There is no proposal/execute/launch/raw-Agent-write command. The TypeScript wrapper bypasses generic invocation logging so takeover data is not recorded.

Pause, stop, session close, disconnect, reconnect, restart, app exit, and crash paths fence the lease before allowing later coordinator state. Reconnect synchronizes a revoked lease but never reacquires Agent ownership. Late output after handoff is dropped. Panel remount can rebuild from the bounded snapshot without recreating authority.

## Shared fixtures and verification

- `tests/fixtures/agent-terminal-protocol/v1/terminal-coordinator.json` freezes the shared Rust/TypeScript state vocabulary, narrow command allowlist, sensitive classes, unsupported surfaces, and forbidden privacy fields/columns.
- Rust module tests cover happy path, exact approval binding/TTL/replay, audit prewrite failure, takeover privacy and capture rotation, user-output isolation, secret handoff, late output, disconnect/reconnect, pause/stop, writer ambiguity, startup recovery, and the independent-evidence requirement.
- TypeScript tests cover the shared fixture and prove the frontend exposes only the narrow commands and does not route takeover data through generic logging.

Validation on this branch:

- `cargo fmt --all`: passed.
- `cargo check --tests`: at phase-3 acceptance time, the modules and integrations reported no diagnostics while 30 unrelated deployment baseline errors blocked the command. That deployment subsystem was later retired and no longer blocks the current Rust gate.
- Targeted terminal TypeScript tests: 8 passed, 0 failed.
- Full TypeScript suite: 1292 passed, 0 failed.
- Roadmap audit: passed.
- TypeScript compile: passed.

## Known limitations and phase-4 boundary

- Production admission remains deliberately blocked, so there is no real model-to-terminal run and no claim that P0/P1/P2 modifying admission is satisfied.
- The only registered driver remains the deterministic phase-2 fixture. Its start action is an intent; this phase does not add a general process launcher or executable lookup.
- Normal prompt observation completion currently depends on an explicit backend driver/quiet boundary; only sensitive/unsupported output triggers immediate completion and handoff in the transport hook.
- No UI is implemented. Phase 4 may consume the narrow snapshot/control commands, but must not introduce a generic terminal write, expose approval secrets, persist takeover data, treat output as proof, or bypass the production admission gate.
