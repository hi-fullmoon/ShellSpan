# Terminal Execution Compatibility and Rollout Plan

Status: Phase 6 Windows and macOS local rollout accepted; remote bound-terminal reuse implemented through migration stage 6 on 2026-09-17, with final cross-platform/window validation pending.

Protocol: [Terminal Session Protocol v1](./terminal-protocol-rfc.md)

## Compatibility table

| Existing boundary | Current meaning | Migration decision | Compatibility proof / removal gate |
| --- | --- | --- | --- |
| `AgentExecutionSurface` | Persisted values are `direct` and `boundTerminal` in Rust event v5 and TypeScript. `boundTerminal` selects cooperative, wrapper-free terminal execution when it is available. | Preserve both serialized values. Do not add a third persisted surface for interactive operation; it is a runtime capability of the real-terminal surface. | Existing v5 session fixtures and restart tests continue to load both values. Runtime readiness remains ephemeral and platform-scoped. |
| Model tool `run_terminal_command` | Stable model-facing facade normalized by the native adapter. | Keep the facade during migration. Routing is chosen and frozen before dispatch. The optional additive `lifecycleTrust = directRequired` requests Direct for adversarial or untrusted code; known sensitive, destructive, and external effects are forced to Direct independently of the selected surface. Do not expose rollout flags to the model. | Adapter/effect/policy tests prove old calls remain accepted, stateful shell commands remain eligible for the visible terminal, and strong-lifecycle requests cannot reach `terminal_execute`. |
| Native `exec_command.channel` | Contract v3 accepts only `direct`, which uses process/SSH exec. Visible commands use the separate `terminal_execute` contract. | Remove the former `pty` channel instead of reinterpreting it. Historical event payloads remain readable as opaque recorded JSON, but a new `pty` tool call is invalid. | Protocol tests require `channel = direct`; native routing exposes only `TerminalExecute` or `Unavailable`. |
| Agent Session event v5 | Append-only JSONL source of truth. `session/created.executionSurface` and `session/execution_surface_changed.data.surface` persist surface choice; `tool/call`, `tool/execution`, and `tool/result` persist execution boundaries. | Keep version 5. Phase 0 repairs the schema enum to match the already-shipped surface-change event. Raw frames, integration secrets, and screen contents do not enter event v5. Phase 3 adds the `uncertain` tool-result status and versioned `terminal_execute` result data without changing the envelope; explicit uncertainty remains a reconciliation boundary. | Event-v5 compatibility fixtures validate `direct` and `boundTerminal`; Rust replay tests retain every older result status and prove `uncertain` is never auto-replayed. A v5 version bump is required only for an incompatible event-envelope change. |
| Persisted Agent Sessions | Stored under `sessions-v5`; historical events are replayed strictly. | Never rewrite old logs in place. Continue deriving `boundTerminal` exactly as stored. New runtime readiness is ephemeral/derived and must not make an old record unloadable. | Rust restart tests plus frontend adapter fixtures cover restoration. Migration tests in Phase 1 must include pre-feature sessions. |
| Persisted terminal workspace | Terminal tabs restore identity and layout; a reconnect currently replaces the transport session id and records `replacesSessionId` ephemerally. | Preserve the stored workspace format through Phase 1. The broker later maps a replacement transport to a new terminal generation; it must not mutate an old Agent target or imply safe continuation. | Existing workspace persistence and reconnect tests remain green. Phase 2 adds generation tests before cutover. |
| Direct process handles | Opaque `proc-*` handles bind request, task, and owner target. `write_stdin`, `wait_process`, and `kill_process` target those handles. | No terminal flag changes this path. Do not attach terminal generations or leases to process handles. Preserve structured stdout/stderr, exit, timeout, cancellation, and recovery. | Native process tests and direct-execution fixture gate must pass at every phase. |
| Current terminal transport | Local `portable-pty` and interactive SSH PTY feed byte-oriented broker frames while frontend xterm applies high/low-watermark backpressure. | Keep one authoritative display path. Visible-command capability is binary: cooperative execution is ready or unavailable. | Broker tests compare exact payload/order against the recorded baseline. |

## Additive migration rules

1. Persisted `direct` and `boundTerminal` values are immutable compatibility
   vocabulary. UI copy is not protocol vocabulary.
2. A rollout decision is frozen before `tool/execution` is dispatched and is
   recorded as privacy-safe audit metadata. Changing a flag affects only later
   operations.
3. Falling back after an operation may have reached a transport is forbidden.
   The first operation becomes `uncertain`; a new operation requires normal
   approval/reconciliation. Never reroute or replay an in-flight/uncertain command.
4. Direct execution is always independently available when supported. The UI
   must say when Direct is being offered instead of a real terminal.
5. Unsupported integration is an explicit state, never a transparent wrapper
   substitution under the real-terminal label.
6. Raw output and integration/screen data are ephemeral unless a separately
   reviewed bounded artifact contract is introduced.
7. A persisted `executionSurface = direct` records only the user's frozen
   selection. The `directFallback` presentation requires a separate,
   authoritative runtime fallback signal and is never inferred from that
   persisted value or ordinary terminal connection state.
8. Visible-terminal lifecycle metadata is cooperative operational evidence, not
   authorization evidence or a security sandbox. Approval completes before
   dispatch. Secrets, security-sensitive effects, adversarial code, and
   untrusted scripts requiring process-isolated lifecycle evidence use Direct.

## Named feature flags

Flag names are stable runtime identifiers. Their implementation belongs to the
phase listed below; Phase 0 only reserves their names and behavior.

| Flag | Phase | Default until gate | Prerequisites | Enabled behavior | Rollback rule |
| --- | --- | --- | --- | --- | --- |
| `terminal_broker_v1` | 2 | on for Windows and macOS local; off elsewhere | none | Creates broker session records and fans raw bytes to bounded consumers without rewriting display bytes. | Disable dependent flags before the broker for new local generations. Close active broker generations; unresolved operations become uncertain. Deferred platforms report visible commands unavailable. |
| `terminal_shell_integration_v1` | 3 | on for Windows and macOS local; off elsewhere | `terminal_broker_v1` | Installs supported local cooperative shell integration with a generation-bound control plane. Unsupported or failed initialization degrades explicitly. | Stop new integration bootstrap and mark affected generations degraded. Invalidate active integration; any command lacking accepted completion becomes uncertain. |
| `terminal_execute_v1` | 3 | on for Windows and macOS local; off elsewhere | broker + ready cooperative shell integration | Routes eligible non-security-sensitive visible commands to wrapper-free `terminal_execute`. Effect policy and `lifecycleTrust = directRequired` force Direct where cooperative evidence is insufficient. | Stop routing new calls. Existing calls finish on their chosen path or become uncertain; never replay. Rolled-out local platforms offer explicit Direct instead of reviving the wrapper. |
| `terminal_remote_bound_terminal_v1` | remote reuse stage 6 | on for Windows and macOS desktop hosts; off on Linux | broker + shell integration + terminal execute | Prepares integration while opening an ordinary user SSH PTY and routes remote `boundTerminal` visible commands to that frozen source transport and generation. | Stop new remote visible-command routing; make active incomplete commands uncertain; revoke Agent leases and turn guards; keep the user SSH transport open. Later new/reconnected sessions use an ordinary shell. Never restore a dedicated Agent PTY. |
| `terminal_interactive_tools_v1` | 5 | on for Windows and macOS local; off elsewhere | broker + shell integration; remote bound-terminal and remote-interactive flags for remote targets | Publishes terminal input/key/snapshot/wait tools and the headless screen model. | Remove tools from new model requests, revoke Agent leases, and reject later Agent input. Reconcile any operation without accepted completion; user ownership remains available. |
| `terminal_remote_interactive_tools_v1` | 5 | off | interactive tools + remote bound-terminal | Separately admits screen observation and interactive input for the frozen user SSH PTY after the SSH Phase 5 gate passes. It does not gate visible commands. | Remove remote interactive tools from new model requests and reject later remote interactive input without disabling remote visible commands. |

## Flag evaluation and dependency rules

Phase 2 implements `terminal_broker_v1` as the backend-only process environment
decision `SHELLSPAN_TERMINAL_BROKER_V1`. Phase 3 adds the same trusted parsing
for `SHELLSPAN_TERMINAL_SHELL_INTEGRATION_V1` and
`SHELLSPAN_TERMINAL_EXECUTE_V1`. The remote reuse migration uses
`SHELLSPAN_TERMINAL_REMOTE_BOUND_TERMINAL_V1`, and Phase 5 adds
`SHELLSPAN_TERMINAL_INTERACTIVE_TOOLS_V1` and
`SHELLSPAN_TERMINAL_REMOTE_INTERACTIVE_TOOLS_V1`, through the same parser. On
Windows and macOS, an absent value is on for broker, integration, execute,
remote bound-terminal routing, and local interactive tools; on Linux those absent values
remain off. Remote interactive tools are absent-off on every platform. Accepted enabled values are `1`, `true`, and `on`,
and accepted disabled values are `0`, `false`, and `off`. Effective execute
routing requires both broker and integration. The decisions and all broker
records are ephemeral, are excluded from terminal workspace and Agent Session
persistence, and have no frontend mutation IPC. The read-only Broker snapshot
serializes the remote decision as `remoteBoundTerminalRollout`. A rollback affects only later
routing; an active operation finishes on its frozen path or becomes uncertain
and is never replayed through another route. Disabling the broker closes active
broker generations with `brokerShutdown`.

Flag enablement cannot override integration identity, generation, capability,
prompt-readiness, framing, ordering, or exact-line gates. With broker,
integration, and execute enabled, a supported POSIX integration that passes
those gates routes eligible commands to `terminal_execute`; an unsupported or
degraded shell is unavailable. Active same-UID endpoint discovery
and deliberate in-shell hook invocation remain documented cooperative-model
non-goals, never a security claim.
Closed broker metadata is bounded to the 256 most recently closed logical
sessions, with one transport identity retained per logical session so a valid
same-process reconnect can advance its generation. Successful reconnect drops
all superseded transport identities. Raw replay and capture bytes are cleared
when a generation closes.

The remote bound-terminal flag is effective only when broker, shell integration,
and terminal execute are all effective. A remote visible-command decision is
frozen before approval/dispatch and directly resolves the Agent target
`sessionId` to the current user SSH transport, terminal session, and generation.
Preparation, post-approval validation, lease acquisition, and the final PTY
write all revalidate that identity. Shell integration is attempted during the
ordinary SSH connection startup; failure starts a normal usable shell and marks
visible commands unavailable. No alternate terminal is created and no implicit
Direct fallback is permitted.

Readiness requires `integrationState = ready`, `promptReady = true`, no active
command, the current generation, and user lease ownership before Agent
acquisition. The frontend turn guard protects the same source terminal from
`turn/start` through `turn/end`; per-command leases do not shorten that guard.
Takeover restores user ownership and fences every later Agent input for the
turn. Disabling the flag makes active incomplete commands uncertain, revokes
remote Agent leases and turn guards, and keeps the user's SSH transport open.
New connections and reconnects then use the ordinary shell startup path.

The Phase 5 interactive flag is effective only when broker and shell integration
are effective. Remote targets additionally require both the remote bound-terminal
flag and the independently default-off remote-interactive flag, and use only
the frozen source SSH terminal; interactive tools never attach to an unrelated
remote terminal. The flag controls
headless screen-model creation and model publication of `read_terminal`,
`write_terminal_input`, and `wait_terminal`. Disabling it removes those tools
from later model requests, revokes active Agent terminal leases, and rejects
later input for the released operation. Raw text and paste payloads remain
ephemeral: durable call records retain only input kind, key when applicable,
byte length, and `contentPersisted = false`.
Rendered title/content from read and wait results is injected only into the
current in-memory model turn. Durable tool results retain an allowlisted screen
metadata receipt with `transientObservation = true` and
`contentPersisted = false`; turn/session boundaries and runtime restart discard
the transient observation, so a resumed task must read the current screen again.

- Flags are evaluated backend-side from trusted rollout configuration. No flag
  is stored in Agent session logs, editable by model tools, or inherited from
  terminal output.
- A dependent flag evaluates false when any prerequisite is false.
- Backend routing state is authoritative; frontend flags control presentation
  only and cannot grant execution capability.
- Rollback order is the reverse dependency order: remote interactive tools,
  interactive tools, remote bound-terminal routing, terminal execute, shell integration, then
  broker.
- Emergency rollback keeps Direct enabled and marks visible commands unavailable.
- An active command is never migrated between old and new paths after dispatch.

## Compatibility execution removal

The legacy wrapper, marker parser, synthetic `[Agent]` echo, `pty` execution
channel, fallback feature flag, and fallback route have been removed. New
visible-command operations either use cooperative `terminal_execute` or fail
with `TERMINAL_VISIBLE_COMMAND_UNAVAILABLE`. Persisted `direct` and
`boundTerminal` surface values remain readable because they describe the user
selection, not the removed execution mechanism.

The dedicated Agent SSH terminal production path is also removed: there is no
candidate/promotion map, remote-session-created event, Agent-owned terminal tab,
or terminal workspace field to restore. Existing persisted
`executionSurface = boundTerminal` values now select the frozen user terminal;
they do not authorize rebinding an old Agent Session to a replacement transport.

## Phase 6 counters

`get_terminal_broker_snapshot` exposes read-only, process-lifetime unsigned
counters for integration readiness, accepted
lifecycle events, uncertainty, timeout, takeover, truncation, backpressure, and
Broker ingress latency samples/total/max in microseconds. Latency uses a
deterministic first-frame-and-every-64-frames sample so diagnostics do not
contend on every PTY read. Values saturate at the JavaScript safe-integer
boundary and reset on runtime restart. The counter
payload contains numbers only: command/input/output/screen text, paths,
integration identifiers, nonces, credentials, timestamps, and raw latency
samples are neither retained nor persisted.
