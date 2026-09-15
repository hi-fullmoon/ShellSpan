# Terminal Execution Compatibility and Rollout Plan

Status: accepted Phase 0 plan; Phase 3 cooperative-shell amendment: 2026-09-15.

Protocol: [Terminal Session Protocol v1](./terminal-protocol-rfc.md)

## Compatibility table

| Existing boundary | Current meaning | Migration decision | Compatibility proof / removal gate |
| --- | --- | --- | --- |
| `AgentExecutionSurface` | Persisted values are `direct` and `boundTerminal` in Rust event v5 and TypeScript. `boundTerminal` currently selects the wrapped PTY path. | Preserve both serialized values. Phase 1 changes only the user-facing label and states. Do not add a third persisted surface for interactive operation; it is a runtime capability of the real-terminal surface. | Existing v5 session fixtures and restart tests must continue to load both values. `boundTerminal` cannot be relabeled as real terminal while it routes to the wrapper. |
| Model tool `run_terminal_command` | Stable model-facing facade normalized by the native adapter. | Keep the facade during migration. Routing is chosen and frozen before dispatch. The optional additive `lifecycleTrust = directRequired` requests Direct for adversarial or untrusted code; known sensitive, destructive, and external effects are forced to Direct independently of the selected surface. Do not expose rollout flags to the model. | Adapter/effect/policy tests prove old calls remain accepted, stateful shell commands remain eligible for the visible terminal, and strong-lifecycle requests cannot reach `terminal_execute`. |
| Native `exec_command.channel` | Contract v3 accepts `direct` and `pty`. `direct` uses process/SSH exec; `pty` invokes the legacy wrapper. | Preserve both enum values and their historical meaning. Add `terminal_execute` as a new native capability in Phase 3; do not silently reinterpret `pty` as wrapper-free execution. Deprecate `pty` only after the Phase 6 removal gate. | Protocol tests freeze both existing values. Old recorded tool calls/results remain decodable. |
| Agent Session event v5 | Append-only JSONL source of truth. `session/created.executionSurface` and `session/execution_surface_changed.data.surface` persist surface choice; `tool/call`, `tool/execution`, and `tool/result` persist execution boundaries. | Keep version 5. Phase 0 repairs the schema enum to match the already-shipped surface-change event. Raw frames, integration secrets, and screen contents do not enter event v5. Phase 3 adds the `uncertain` tool-result status and versioned `terminal_execute` result data without changing the envelope; explicit uncertainty remains a reconciliation boundary. | Event-v5 compatibility fixtures validate `direct` and `boundTerminal`; Rust replay tests retain every older result status and prove `uncertain` is never auto-replayed. A v5 version bump is required only for an incompatible event-envelope change. |
| Persisted Agent Sessions | Stored under `sessions-v5`; historical events are replayed strictly. | Never rewrite old logs in place. Continue deriving `boundTerminal` exactly as stored. New runtime readiness is ephemeral/derived and must not make an old record unloadable. | Rust restart tests plus frontend adapter fixtures cover restoration. Migration tests in Phase 1 must include pre-feature sessions. |
| Persisted terminal workspace | Terminal tabs restore identity and layout; a reconnect currently replaces the transport session id and records `replacesSessionId` ephemerally. | Preserve the stored workspace format through Phase 1. The broker later maps a replacement transport to a new terminal generation; it must not mutate an old Agent target or imply safe continuation. | Existing workspace persistence and reconnect tests remain green. Phase 2 adds generation tests before cutover. |
| Direct process handles | Opaque `proc-*` handles bind request, task, and owner target. `write_stdin`, `wait_process`, and `kill_process` target those handles. | No terminal flag changes this path. Do not attach terminal generations or leases to process handles. Preserve structured stdout/stderr, exit, timeout, cancellation, and recovery. | Native process tests and direct-execution fixture gate must pass at every phase. |
| Current terminal transport | Local `portable-pty` and interactive SSH PTY decode bytes to strings before Tauri emission. Frontend xterm applies high/low-watermark backpressure. | Phase 2 introduces byte-oriented broker frames without functional cutover. Existing transport remains fallback until byte equality, ordering, generation, and performance gates pass. | Broker shadow tests compare exact payload/order against the legacy display branch and the recorded baseline. |
| Legacy PTY wrapper | Injects a POSIX `/bin/sh -c` or nested PowerShell command, authenticated BEGIN/END records, synthetic `[Agent]` display, and backend output filtering. | Keep only as an explicitly named compatibility fallback. It is never called “real terminal.” It receives no new behavior. Remove wrapper, parser, synthetic echo, and obsolete tests only in Phase 6 after stable default evidence. | `terminal_legacy_wrapper_fallback_v1` remains independently controllable until removal. Rollback never replays an operation across paths. |

## Additive migration rules

1. Persisted `direct` and `boundTerminal` values are immutable compatibility
   vocabulary. UI copy is not protocol vocabulary.
2. A rollout decision is frozen before `tool/execution` is dispatched and is
   recorded as privacy-safe audit metadata. Changing a flag affects only later
   operations.
3. Falling back after an operation may have reached a transport is forbidden.
   The first operation becomes `uncertain`; a new operation requires normal
   approval/reconciliation.
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
| `terminal_surface_semantics_v1` | 1 | on after the Phase 1 gate | none | Enables compatibility-accurate labels and explicit ready/initializing/unavailable/degraded/direct-fallback states while preserving stored enums. The current repository has no general runtime feature service, so Phase 1 uses one non-persisted frontend source default. | Set the source default off to restore old copy only. Do not change persisted values or runtime routing. |
| `terminal_broker_v1` | 2 | off | none | Creates broker session records and shadow-fans raw bytes to broker consumers while legacy display remains authoritative. | Disable broker and all dependent flags for new generations. Close active broker generations; unresolved operations become uncertain. Keep the legacy transport for newly opened sessions. |
| `terminal_shell_integration_v1` | 3 | off | `terminal_broker_v1` | Installs supported local cooperative shell integration with a generation-bound control plane. POSIX readiness requires supported shell identity, all lifecycle capabilities, a private bounded endpoint, and ordered integration readiness; unsupported or failed initialization degrades explicitly. | Stop new integration bootstrap and mark affected new generations degraded. Invalidate active integration; any command lacking accepted completion becomes uncertain. |
| `terminal_execute_v1` | 3 | off | broker + ready cooperative shell integration | Routes eligible non-security-sensitive visible commands to wrapper-free `terminal_execute`. Effect policy and `lifecycleTrust = directRequired` force Direct where cooperative evidence is insufficient. | Stop routing new calls. Existing calls finish on their chosen path or become uncertain; never replay through the wrapper. New `boundTerminal` calls may use the explicitly degraded legacy fallback only when its flag is enabled. |
| `terminal_remote_agent_pty_v1` | 4 | off | broker + shell integration + terminal execute | Opens a dedicated Agent SSH PTY and bootstraps remote integration. | Stop opening new Agent PTYs and close idle flagged channels. Active incomplete operations become uncertain. Preserve ordinary user SSH terminals and Direct SSH exec. |
| `terminal_interactive_tools_v1` | 5 | off | broker + shell integration; remote flag for remote targets | Publishes terminal input/key/snapshot/wait tools and the headless screen model. | Remove tools from new model requests, revoke Agent leases, and reject later Agent input. Reconcile any operation without accepted completion; user ownership remains available. |
| `terminal_legacy_wrapper_fallback_v1` | 3-6 | on until Phase 6 removal | none; mutually exclusive per operation with `terminal_execute_v1` routing | Allows the current wrapped `exec_command.channel = "pty"` path only when real integration is not selected/ready and the UI labels it degraded compatibility execution. | Re-enable only for new operations if wrapper-free rollout regresses. Never reroute or replay an in-flight/uncertain command. Delete the flag with the wrapper only after the Phase 6 gate. |

## Flag evaluation and dependency rules

Phase 2 implements `terminal_broker_v1` as the backend-only process environment
decision `SHELLSPAN_TERMINAL_BROKER_V1`. Phase 3 adds the same trusted parsing
for `SHELLSPAN_TERMINAL_SHELL_INTEGRATION_V1`,
`SHELLSPAN_TERMINAL_EXECUTE_V1`, and
`SHELLSPAN_TERMINAL_LEGACY_WRAPPER_FALLBACK_V1`. Phase 4 adds
`SHELLSPAN_TERMINAL_REMOTE_AGENT_PTY_V1` through the same parser. An absent value is explicitly
off for broker, integration, execute, and remote Agent PTY;
an absent legacy-fallback value is on until
the Phase 6 removal gate. Accepted enabled values are `1`, `true`, and `on`,
and accepted disabled values are `0`, `false`, and `off`. Effective execute
routing requires both broker and integration. The decisions and all broker
records are ephemeral, are excluded from terminal workspace and Agent Session
persistence, and have no frontend mutation IPC. A rollback affects only later
routing; an active operation finishes on its frozen path or becomes uncertain
and is never replayed through the fallback. Disabling the broker closes active
broker generations with `brokerShutdown`; the legacy transport remains
available for new compatibility behavior only when its independent flag is
enabled.

Flag enablement cannot override integration identity, generation, capability,
prompt-readiness, framing, ordering, or exact-line gates. With broker,
integration, and execute enabled, a supported POSIX integration that passes
those gates routes eligible commands to `terminal_execute`; an unsupported or
degraded shell remains on the explicitly labeled legacy fallback (or is
unavailable when that fallback is disabled). Active same-UID endpoint discovery
and deliberate in-shell hook invocation remain documented cooperative-model
non-goals, never a security claim.
Closed broker metadata is bounded to the 256 most recently closed logical
sessions, with one transport identity retained per logical session so a valid
same-process reconnect can advance its generation. Successful reconnect drops
all superseded transport identities. Raw replay and capture bytes are cleared
when a generation closes.

The Phase 4 remote flag is effective only when broker, shell integration, and
terminal execute are all effective. A remote visible-command routing decision
is frozen before approval/dispatch. After approval, the runtime may create or
reconnect one independently authenticated, Agent-owned SSH PTY for the frozen
`(Agent Session, target)`; it never converts or silently borrows the user-owned
target SSH terminal. Bootstrap and command input both use that dedicated PTY.
Its ordinary frontend tab is ephemeral and excluded from terminal-workspace
persistence. Disabling the flag makes active incomplete commands uncertain and
closes registered Agent PTYs during runtime reconciliation; no command is
rerouted or replayed through Direct or legacy PTY.

- Except for the presentation-only `terminal_surface_semantics_v1` source
  default, flags are evaluated backend-side from trusted rollout configuration.
  No flag is stored in Agent session logs, editable by model tools, or inherited
  from terminal output. The semantics flag becomes backend-configured only if a
  general trusted rollout service is introduced later.
- A dependent flag evaluates false when any prerequisite is false.
- Backend routing state is authoritative; frontend flags control presentation
  only and cannot grant execution capability.
- Rollback order is the reverse dependency order: interactive tools, remote PTY,
  terminal execute, shell integration, then broker. The semantics flag can be
  rolled back independently because it does not alter persisted data.
- Emergency rollback keeps Direct enabled. The wrapper fallback may be enabled
  for subsequent operations, but only with the compatibility-accurate degraded
  label and existing approval policy.
- An active command is never migrated between old and new paths after dispatch.

## Legacy removal gate

The wrapper and `terminal_legacy_wrapper_fallback_v1` may be removed only when:

- local macOS, Linux, and Windows acceptance matrices pass on their native
  hosts;
- the isolated SSH matrix passes;
- wrapper-free execution is the stable default with privacy-safe readiness,
  lifecycle, uncertainty, timeout, takeover, truncation, backpressure, and
  latency evidence;
- Direct execution shows no regression;
- existing persisted v5 sessions still load; and
- rollback no longer depends on parsing or hiding wrapper output.
