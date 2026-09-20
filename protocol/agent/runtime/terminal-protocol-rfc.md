# RFC: Terminal Session Protocol v1

Status: accepted Phase 0 contract; amended for the cooperative-shell threat model on 2026-09-15 and remote bound-terminal reuse on 2026-09-17; owner: ShellSpan Agent Runtime.

Roadmap: [Terminal Execution Roadmap](./terminal-execution-roadmap.md)

Conformance fixture schema: [terminal-protocol-v1.schema.json](./terminal-protocol-v1.schema.json)

## Summary

Terminal Session Protocol v1 (TSP/1) defines the boundary between a terminal
transport, the Terminal Session Broker, the display, shell integration, Agent
command execution, and the future headless screen model. It supports:

- direct execution, which remains outside the terminal protocol;
- visible commands submitted to a real interactive shell; and
- interactive terminal operation over the same real terminal.

The protocol makes raw output immutable, scopes all terminal state to a
generation, carries cooperative lifecycle evidence on an isolated control
plane, and treats an operation without an accepted completion as uncertain.
This RFC defines the target contract; feature flags separately control whether
each implementation is enabled.

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are
normative.

## Non-goals

- Replacing the structured direct-process and SSH-exec path.
- Persisting terminal scrollback or raw sensitive output in the Agent event log.
- Inferring command boundaries from prompt text, regular expressions, idle
  time, terminal title, or display contents.
- Attaching an arbitrary remote shell that is not the frozen `boundTerminal`
  target selected by the user.
- Selecting the concrete shell-integration injection technique. The technique
  must meet this RFC's trust properties before it can be enabled.
- Treating a visible terminal, its interactive shell, or shell integration as a
  security sandbox for code intentionally run by the user.
- Cryptographically isolating shell hooks from hostile code running inside the
  same interactive shell process or from an actively tampering same-UID
  process. Commands requiring that lifecycle assurance use Direct execution.

## Vocabulary and identity

| Term | Definition |
| --- | --- |
| Agent Session | The durable event-v5 task/conversation record. It is not a terminal session. |
| Terminal session | One logical terminal tab or pane managed by the broker, identified by `terminalSessionId`. |
| Generation | One continuous attachment to exactly one PTY/ConPTY or SSH PTY transport. |
| Operation | One Agent-visible command or interactive action, identified by `operationId`. |
| Command | One line submitted to the integrated interactive shell, identified by `commandId`. |
| Integration | The cooperative shell-lifecycle producer for one generation, identified by `integrationId`. |
| Lease | The exclusive authorization to submit input for a terminal session. |
| Raw output | Bytes observed from the PTY master or SSH channel before decoding, parsing, redaction, or display. |
| Screen | A derived terminal-emulator state obtained only by applying raw-output frames in order. |

`terminalSessionId`, `operationId`, `commandId`, `integrationId`, and `leaseId`
MUST be opaque, non-empty identifiers. They MUST NOT embed credentials, command
text, hostnames, or user-visible labels.

The terminal generation is distinct from Agent model-surface compaction's
existing `surfaceGeneration`. Implementations MUST use the full names
`terminalGeneration` and `surfaceGeneration` when both can appear in scope.

## Envelope and ordering

Every TSP/1 frame carries:

```text
protocolVersion: 1
terminalSessionId: opaque identifier
terminalGeneration: unsigned integer >= 1
type: frame discriminator
```

Frames from an older or unknown generation MUST NOT mutate current state. A
consumer MAY retain them as bounded diagnostic evidence, but MUST label them as
stale. Numeric counters in this RFC are unsigned 64-bit values on the backend
and MUST remain within JavaScript's safe-integer range at an IPC boundary. The
broker MUST rotate the terminal generation before an IPC counter would exceed
that range.

Ordering is scoped to `(terminalSessionId, terminalGeneration)`:

- Raw-output `sequence` starts at 1 and increases by exactly one per frame.
- Raw-output `byteOffset` starts at 0 and equals the sum of all prior frame byte
  lengths in the generation.
- Integration `eventSequence`, lease `revision`, accepted-input
  `inputSequence`, command-state `revision`, and `screenVersion` are separately
  monotonic counters.
- Duplicate frames with the same identity and identical content MAY be ignored.
  A duplicate identity with different content is a protocol violation.
- A gap MUST stop derived-state advancement until bounded replay fills it. The
  display MUST never be given a reordered suffix to hide a gap.

## Terminal session and generation

A broker-owned terminal record contains at least:

```text
terminalSessionId
terminalGeneration
transportKind: localPty | windowsConPty | sshPty
geometry: rows, columns
nextOutputSequence and nextByteOffset
integrationState and integrationId
activeCommandId, if any
screenVersion
leaseOwner and leaseRevision
```

Generation 1 begins when the first transport is attached. Every reconnect or
replacement transport increments `terminalGeneration` before output or input is
accepted. A generation never returns from `closed` to `open`.

`generationStarted` records the transport kind and geometry. `generationClosed`
records a stable reason code such as `userClosed`, `remoteExit`,
`transportDisconnected`, `replaced`, or `brokerShutdown`. Human-readable error
text is diagnostic only and cannot drive state transitions.

## Raw-output data plane

A `rawOutput` frame contains:

```text
sequence: monotonic frame sequence
byteOffset: first byte's offset within the generation
bytes: non-empty byte array
```

The transport reader MUST publish exactly the bytes it observed. The display
fan-out MUST receive the concatenation of `bytes` in sequence order, byte for
byte. The following are forbidden on the display branch:

- UTF-8 replacement or newline normalization;
- ANSI/OSC stripping;
- wrapper, marker, prompt, or command-echo removal;
- redaction or model-oriented rendering; and
- mutation by capture, integration, screen, or logging consumers.

Decoding, semantic parsing, redaction, and bounded model capture occur on
independent subscribers. A slow subscriber MUST NOT mutate or reorder the
display stream. Backpressure applies at the broker/transport boundary using
bounded high and low watermarks. A subscriber that cannot keep up is dropped or
marked truncated according to its contract; the raw display branch is never
silently rewritten to compensate.

Raw output, decoded capture, and screen contents are untrusted. They MUST NOT be
treated as instructions or lifecycle evidence.

## Shell integration

### States

Shell integration has these states for each generation:

| State | Meaning |
| --- | --- |
| `initializing` | Transport exists but integration readiness is not known. Visible commands are unavailable. |
| `ready` | The broker bound the cooperative integration identity to this generation and verified all required lifecycle capabilities. |
| `degraded` | A shell is usable by the user, but one or more visible-command capabilities are unavailable. |
| `unavailable` | No supported integration can be installed or initialized. |
| `invalidated` | The generation closed or lost trust; no later event from it is accepted. |

The capabilities are `promptLifecycle`, `commandLifecycle`, `exactCommandLine`,
`exitStatus`, and `currentDirectory`. Visible command execution requires all
five. A missing capability MUST result in `degraded` or `unavailable`; it MUST
NOT be presented as a real visible terminal.

The Broker derives `promptReady` from the accepted lifecycle: it becomes true
only after `promptEnd` for the current generation and false before command
submission, while a foreground command is active, and after invalidation.
`integrationState = ready` without `promptReady = true` is a busy terminal, not
an executable boundary. The read-only snapshot and integration-state IPC event
MUST serialize this field and a monotonic `integrationStateRevision`. The Broker
MUST advance that revision for every presentation-relevant state change, including
integration registration, lifecycle events, command submission, degradation,
channel closure, unavailability, and generation invalidation. Consumers MUST
accept only a newer revision from the same terminal generation so presentation
cannot regress when notifications arrive out of order. `integrationEventSequence`
remains the control-channel lifecycle cursor and MUST NOT be used as the UI state
revision because a replacement integration channel may restart that cursor.

### Threat model and security boundary

TSP/1 uses a **generation-bound isolated control plane** and
**cooperative lifecycle evidence**. Integration events MUST arrive through a
backend-registered control endpoint bound to
`(terminalSessionId, terminalGeneration, integrationId)`. The broker, runtime,
application IPC boundary, control reader, and generation/lease state are inside
the enforced boundary. The raw PTY/ConPTY output data plane is outside it: an
escape sequence, marker, prompt-shaped line, terminal title, OSC record, or any
bytes printed by a command MUST NOT advance lifecycle.

For bash and zsh, an ordinary foreground external command or subshell MUST NOT
inherit an open writable control descriptor. For PowerShell, ordinary external
children MUST NOT inherit the managed named-pipe sender handle. Control paths,
identifiers, or bootstrap details MUST NOT be exported in the child environment,
written to PTY output, ordinary logs, snapshots, workspace persistence, or Agent
event data. Frames remain bounded and are rejected on malformed encoding,
identity/generation mismatch, exact-line mismatch, or invalid event order.

The interactive shell and installed hooks are nevertheless cooperative
producers, not a hostile-code isolation boundary. Active same-UID code that
searches process state or private temporary paths and deliberately reopens an
integration endpoint, and code evaluated inside the interactive shell that
redefines hooks or calls integration internals, are **out-of-scope tampering**.
Shell integration cannot make a meaningful security guarantee against those
actors without moving command execution outside the interactive shell. The
product MUST describe this limitation and MUST NOT label the visible terminal a
security sandbox or use its lifecycle metadata as authorization evidence.

Secrets, authorization checks, security-sensitive side effects, explicitly
adversarial code, and untrusted scripts requiring process-isolated lifecycle
evidence MUST use Direct execution. ShellSpan classifies known
`sensitiveRead`, `destructive`, and `externalSideEffect` command effects to
Direct before dispatch; callers MUST request `lifecycleTrust = directRequired`
when the adversarial or untrusted nature is contextual rather than classifiable
from the command. Direct isolates lifecycle/control from interactive-shell
hooks, but it is not by itself a general OS sandbox. Approval is always decided
before dispatch and never depends on visible-terminal completion metadata.

### Amendment decision — 2026-09-15

The accepted Phase 0 wording required an “authenticated control channel” and
was initially interpreted during adversarial Phase 3 review as protection from
arbitrary same-UID code and code executing inside the integrated shell process.
That interpretation is not implementable by a real, state-preserving shell
integration and exceeds the cooperative metadata boundary used by comparable
terminal integrations. This explicit amendment replaces the overbroad
“authenticated against arbitrary command code” claim with the model above.

The amendment does not relax the enforced broker/app boundary: raw terminal
output still cannot complete a command, normal external children receive no
writable control descriptor, control details are not exported or persisted,
event/identity/generation/exact-line validation remains fail-closed, disconnect
still yields uncertainty, and uncertain work is never replayed automatically.
It only makes active same-UID discovery and deliberate in-shell hook tampering
an honest, documented non-goal and assigns strong lifecycle requirements to
Direct execution.

### Events

After control-plane registration, the broker accepts these ordered cooperative
integration events:

| Event | Required data | Meaning |
| --- | --- | --- |
| `promptStart` | `cwd` | The integrated shell began producing a prompt. |
| `promptEnd` | none | The prompt finished; detection does not inspect its text. |
| `commandStart` | `commandId`, exact `commandLine`, `cwd` | The shell accepted the broker-submitted command as its next command. |
| `commandEnd` | `commandId`, `exitCode`, `cwd` | The same shell completed the command and returned control. |
| `directoryChanged` | `cwd` | The shell's current directory changed outside a command-end event. |

Every event includes `eventSequence` and `observedThroughOutputSequence`, which
is the last raw-output frame known to precede or coincide with the event. The
fence associates capture and screen state without delaying or changing display
bytes.

`commandStart.commandLine` MUST exactly match the submitted logical command
after only the shell's documented line-ending removal. A mismatch invalidates
the operation. `commandEnd` from another command, integration, or generation is
ignored and recorded as a protocol violation.

## Visible-command lifecycle

The runtime exposes `terminal_execute` for visible commands. The removed
`exec_command.channel = "pty"` contract MUST NOT be accepted or silently
reinterpreted.

The broker command states and allowed transitions are:

| State | Allowed next states |
| --- | --- |
| `awaitingLease` | `submitted`, `cancelled`, `failed` |
| `submitted` | `running`, `cancelRequested`, `takenOver`, `uncertain`, `failed` |
| `running` | `completed`, `cancelRequested`, `takenOver`, `uncertain`, `failed` |
| `cancelRequested` | `cancelled`, `timedOut`, `completed`, `takenOver`, `uncertain`, `failed` |
| `completed`, `cancelled`, `timedOut`, `takenOver`, `uncertain`, `failed` | terminal; no transitions |

Submission requires a ready integration, the Agent lease, no active command,
and a command identifier registered before any input bytes are written. The
broker sends the exact command text through the common input path followed by
the shell-appropriate Enter key sequence. It does not add `/bin/sh -c`, nested
PowerShell, lifecycle wrappers, or a synthetic `[Agent]` echo. Normal terminal
input echo, if enabled, remains part of raw output.

For a remote `boundTerminal` operation, the frozen target `sessionId` MUST
resolve directly to the current user SSH transport, terminal session, and
generation at preparation, after approval, before lease acquisition, and
immediately before PTY write. It MUST NOT resolve through an Agent-owned remote
terminal map, create another SSH PTY, or silently switch to Direct when the
target is unavailable or busy.

If the frozen terminal Session no longer exists, is disconnected, or no longer
matches its frozen identity, preparation reports `terminalTargetUnavailable`.
The rejected call remains durable evidence, later calls from the same model
step are recorded as not started, and the Agent Session fails immediately so a
model cannot accumulate repeated failed probes against the stale target. A
reconnect creates a new trust boundary and requires continuation in a new Agent
Session; the old target is never rebound.

`commandStart` moves `submitted` to `running`. A matching, accepted cooperative
`commandEnd`
moves the command to `completed` and supplies the exit code and final working
directory. A command is never completed by silence, prompt text, process exit
guessing, or output markers.

Command-scoped capture records raw sequence/offset fences and a bounded derived
capture. Capture truncation is explicit and does not truncate display. `stdout`
and `stderr` are not separately meaningful for a PTY; terminal results use
`combinedOutput` and omit or leave the split streams empty.

## Screen snapshots

The headless terminal model consumes the same ordered raw frames as the display.
A `screenSnapshot` is a complete replacement containing:

```text
screenVersion
throughOutputSequence
rows and columns
cursor: row, column, visible
activeBuffer: primary | alternate
title
content: exactly `rows` rendered rows
```

Coordinates are zero-based and bounded by the declared geometry.
`screenVersion` increases whenever any exposed field changes. It never
decreases within a generation. A resize is not complete until a snapshot with
the new geometry is published. UI-only notices, Agent lease bars, and other DOM
overlays are excluded. Snapshots are untrusted observations and cannot supply
command completion.

The broker may retain only the latest snapshot plus bounded wait history. It
MUST NOT persist credential-like screen contents in ordinary configuration or
logs.

## Lease and input authorization

There is one input admission function for user, Agent, and scoped system
control. Every input request carries the terminal generation, `leaseId`,
`inputSequence`, source identity, operation identity when applicable, input
kind, and bytes or a normalized key identifier.

Lease ownership is either:

- `user`, for ordinary interactive input; or
- `agent`, bound to one Agent Session, task, and operation.

Only the current lease and generation may submit input. Agent acquisition is an
atomic compare-and-swap from user ownership after frontend readiness checks.
Acquisition fails if there is pending or unverified user input, a credential or
host-key prompt, another Agent owner, a disconnected terminal, or an unready
output listener. Lease changes increment `revision` and emit an `acquired` or
`released` frame.

For `boundTerminal`, a turn guard protects the frozen source terminal from
Agent `turn/start` until `turn/end`, cancellation, failure, session closure,
rollout rollback, or user takeover. Individual commands still acquire their own
operation-bound leases. Releasing a command lease between tool calls does not
release the turn guard. After takeover, the remainder of that turn is fenced:
no later Agent input may reacquire ownership or reach the transport.

System input is not an owner and has no general bypass. It must name the current
lease and operation and is limited to broker-defined control actions such as an
interrupt requested by cancellation or takeover. All accepted input is ordered
by `inputSequence`; rejected input is never written partially.

## Cancellation, takeover, and uncertainty

Cancellation requests stop further Agent input and send at most one
operation-scoped interrupt through the common input path. A matching accepted
`commandEnd` may still settle the command as `cancelled` (or `completed` if it
won the race). If accepted completion cannot be obtained before a bounded
deadline, the outcome is `uncertain`.

User takeover is an atomic lease transition to user ownership. Once it wins:

1. every later Agent input for the released operation is rejected;
2. the broker may send one scoped interrupt;
3. the UI regains input without waiting for model cancellation; and
4. the command is `takenOver` only when an accepted cooperative completion
   proves the boundary,
   otherwise it is `uncertain`.

An interrupted, timed-out, closed, or disconnected operation with no accepted
completion is uncertain. This is mandatory for state-changing, destructive, or
external-side-effecting operations and is the safe default for every visible
command. Uncertain operations MUST NOT be replayed automatically. Resumption
requires explicit reconciliation under the existing Agent recovery policy.

## Reconnect behavior

Reconnect performs this order atomically from the broker's point of view:

1. stop accepting input for the old generation;
2. invalidate its integration and release its lease;
3. settle any active command as uncertain unless a matching accepted completion
   was already committed;
4. close the old generation;
5. attach the new transport with `terminalGeneration + 1`;
6. reset output, integration, input, command, and screen counters; and
7. require integration initialization again before visible commands are
   admitted.

No raw frame, lifecycle event, snapshot, lease acknowledgement, or command
completion from the old generation can affect the new one. Reconnect never
replays a visible or interactive operation.

## Direct execution boundary

Direct execution remains the reliable structured path for local processes and
SSH exec. Its stdout, stderr, exit code, background process handle, stdin, wait,
kill, timeout, cancellation, target binding, and recovery semantics do not
depend on TSP/1 feature flags. A terminal generation MUST NOT be added to direct
process handles, and disabling terminal migration flags MUST NOT change direct
execution behavior.

The model facade MAY request `run_terminal_command.background = true`; the
adapter MUST force Direct and return its opaque `proc-*` handle. Model-facing
`write_process_input`, `wait_process`, and `kill_process` calls MUST bind that
handle to the same frozen Session, task, request, and owner target. Background
service workflows MUST terminate the handle explicitly after verification.

Shell execution is not a network sandbox and MUST NOT claim an enforced
destination scope. Known network-capable commands and general-purpose runtimes
are conservatively classified as `externalSideEffect`, forced to Direct, and
subject to the current permission mode. Permission controls confirmation; it
does not create network isolation or an exact destination scope.
`requestApproval` MUST require confirmation for every native tool call.
`scopedAutopilot` MAY automatically execute only ordinary `readOnly` effects;
`sensitiveRead`, `stateChange`, `destructive`, and `externalSideEffect` effects
MUST require confirmation. `operator` is full access: native calls, including
remote commands, visible terminal input, and configured MCP tools, MUST NOT
require per-call approval. Shell commands run without a workspace filesystem
or network sandbox, with the connected account's operating-system permissions.
The frozen connection identity, tool argument validation, capability binding,
cancellation, and audit remain enforced. Structured file and HTTP tools retain
their explicit path and destination contracts; shell commands may access paths
outside the workspace and arbitrary network destinations.
When a new remote `operator` Session starts from an interactive terminal backed
by a frozen credential profile, the client SHOULD resolve and freeze that
shell's current directory as `rootPath` so generated files use the bounded
native file tools instead of terminal heredocs. A profileless remote Session or
one whose directory probe is unavailable MUST remain unrooted and may execute
shell commands without approval in `operator` mode. Local full-access Sessions
also MUST NOT require a successful directory probe to start. Full access preserves
the selected execution surface; commands requiring trusted lifecycle evidence
still use Direct execution. Enabling full access requires explicit confirmation
for the current connection instance and does not grant authority over another
connection or bypass operating-system permissions.
Loopback HTTP verification uses the structured `probe_http` tool, which fixes
the destination to the frozen local or SSH target's `127.0.0.1`, follows no
redirects, exposes no arbitrary request headers, and enforces method, request
body, one total deadline, and response-size bounds. Remote probes use an
authenticated SSH direct-TCP channel connected to an internal preconnected
socket pair; no discoverable local forwarding listener carries target data.
They do not broaden shell network scope. Known external effects, including
inline general-purpose interpreter execution, MUST NOT use `terminal_execute`.

## Privacy, logging, and audit

- Raw output, screen content, command output, credentials, integration secrets,
  and nonces MUST NOT enter ordinary logs or rollout counters.
- User-visible command text follows existing redaction and approval rules.
- Exact ephemeral terminal input or wait-match text MAY be exposed to the
  current approval UI only through an identity-bound in-memory lookup. It MUST
  NOT be serialized into the Agent event log. The UI MUST fail closed while
  this preview is missing or unavailable and MUST render control characters
  unambiguously. A restart MUST cancel any such
  requested or authorized-but-undispatched call instead of reconstructing or
  replaying it from redacted metadata.
- Audit records may contain opaque identities, state transitions, stable reason
  codes, counts, byte sizes, truncation, and latency buckets.
- Integration readiness, degradation, lifecycle matching, uncertainty,
  timeout, takeover, truncation, backpressure, and transport latency counters
  MUST be privacy-safe and MUST NOT contain raw terminal text.

## Phase 6 native desktop rollout profile

On Windows and macOS hosts, absent trusted configuration enables `terminal_broker_v1`,
`terminal_shell_integration_v1`, `terminal_execute_v1`, and
`terminal_interactive_tools_v1` for local ConPTY/PTY generations, plus
`terminal_remote_bound_terminal_v1` for remote visible commands. Remote interactive
publication additionally requires the independently absent-off
`terminal_remote_interactive_tools_v1` flag. Linux keeps the new-path flags
absent-off.

The authoritative remote environment variable is
`SHELLSPAN_TERMINAL_REMOTE_BOUND_TERMINAL_V1`; the read-only Broker snapshot
serializes its decision as `remoteBoundTerminalRollout`. The decision is
process-lifetime state and MUST NOT be persisted or exposed through a mutation
IPC. Disabling it stops new remote visible-command routing, makes active
incomplete commands uncertain, revokes Agent leases and turn guards, and keeps
the user's SSH transport open. A later new connection or reconnect uses the
ordinary shell startup path. Rollback MUST NOT restore a dedicated Agent PTY.

`exec_command.channel` accepts only `direct`. Visible commands use
`terminal_execute`; the former `pty` wrapper contract, marker parser, and
fallback route are removed. If cooperative terminal execution is not ready,
the visible-command capability MUST be unavailable and MUST NOT reroute or
replay the operation through another execution mechanism.

The read-only Broker snapshot exposes process-lifetime counters for integration
ready transitions, accepted lifecycle events, uncertain settlements, timeouts,
takeovers, capture
truncations, backpressure entries, and Broker-ingress latency sample count,
total microseconds, and maximum microseconds. Latency MUST be sampled at the
first accepted frame of a generation and every 64 accepted frames thereafter,
so observation does not add per-frame atomic contention. Counter fields are unsigned,
saturating, reset on restart, and contain numbers only. They MUST NOT retain
raw samples, timestamps, identifiers, commands, paths, input, output, screen
content, credentials, or nonces, and MUST NOT enter Agent Session persistence.

## Failure handling

| Failure | Required behavior |
| --- | --- |
| Output gap or conflicting duplicate | Pause derived consumers, request bounded replay, and fail the generation if the gap cannot be repaired. |
| Display subscriber failure | Keep transport ownership explicit; close or surface degraded state rather than silently discarding an unbounded stream. |
| Capture or screen lag | Mark that subscriber truncated/stale; never change display bytes. |
| Integration identity, generation, framing, or ordering failure | Invalidate integration and block new visible commands. |
| Unsupported shell | Keep the terminal user-operable and expose `degraded` or `unavailable`; offer Direct explicitly. |
| Lease mismatch or stale generation | Reject without writing any bytes. |
| Disconnect during an operation | Mark uncertain unless an accepted completion was already committed; never replay. |

## Phase 3 local integration candidate profile

Local integration bootstrap files and control endpoints live in unique
`shellspan-terminal-integration-*` directories under `~/.shellspan/tmp/`
(`~/.shellspan-dev/tmp/` for development builds), rather than the system
temporary directory. The backend retains each directory for its shell generation
and removes it on normal teardown or startup rollback. Abnormal process exit
can leave a directory behind. If the application temporary directory cannot be
created, integration setup fails through the existing degraded-terminal path.
Remote integration continues to use its private directory under `/tmp`.

The local candidate binds every control reader to a backend-only
`integrationId`; the identifier is never sent through the PTY. Bash and zsh
write NUL-framed lifecycle records to a mode-`0600` FIFO inside a private
session-lifetime mode-`0700` temporary directory. Each hook opens a short-lived
FIFO writer only while emitting one event, so foreground commands inherit no
control file descriptor. The broker keeps the reader open, validates UTF-8,
field counts, size bounds, event order, generation, integration identity, exact
registered command line, and active command identity. Terminal output is not a
control input and is never parsed to advance lifecycle.

The FIFO is a cooperative control endpoint, not a credential or security
boundary against the same UID. Its path is necessarily held in interactive-shell
state, and mode `0700`/`0600` cannot distinguish that shell from another process
running as the same user. A regression demonstrates that a same-UID process
which has actively discovered the path can reopen it; this is the documented
out-of-scope tampering case above, not a production-readiness failure. The
in-scope gates instead prove that normal child processes inherit no endpoint and
that raw PTY bytes alone cannot reach the reader or advance lifecycle.

- zsh uses `preexec`, `precmd`, `chpwd`, and ZLE `line-init` hooks.
- bash uses a DEBUG pre-exec hook, `PROMPT_COMMAND`, a Readline accepted-line
  capture where available, and the shell history API fallback required by the
  native macOS bash 3.2 lane. Prompt readiness never examines `PS1` text.
- Windows PowerShell 5.1 and PowerShell 7 use a session-scoped module,
  `PSReadLine` accepted-line handler, prompt wrapper, and a byte-mode named
  pipe created by the PowerShell process. The pipe handle is not inherited by
  external commands. PowerShell 5.1 captures the first Enter through a
  temporary key handler, then restores the original binding and installs the
  accepted-line handler after history import; its older PSReadLine otherwise
  reports saved history as fresh commands. Missing PSReadLine degrades
  explicitly. The module object
  needed by the hooks remains reachable from the interactive PowerShell session;
  deliberate in-shell invocation is the same documented cooperative-producer
  limitation, never a security guarantee. `$?` identifies success of the last
  pipeline, while `$LASTEXITCODE` can remain stale after a later failing cmdlet;
  the candidate maps success to `0` and failure to a nonzero integer
  `$LASTEXITCODE` or `1` (never stale zero), but complete native-vs-cmdlet exit
  semantics remain unverified until the
  native Windows PowerShell 5.1 and PowerShell 7 ConPTY lanes run. Those lanes
  are **MISSING**, not `PASS`, and no stronger Windows claim is made.

The additive `terminal_execute` implementation registers the command before writing the exact logical line
and shell Enter sequence through the common lease-authorized input path. Its
version-1 result contains terminal/generation/operation/command identity,
exact command line, cooperative exit status and cwd, command-scoped combined
capture fences, explicit truncation, and `noAutoReplay: true`. An accepted cooperative end
after cancel, timeout, or takeover settles the corresponding terminal state;
loss of the integration or transport before that end settles `uncertain`. All
POSIX bash/zsh integrations may become ready only when their production flags,
generation identity, capabilities, and prompt lifecycle gates all pass.
Unsupported shells degrade explicitly. PowerShell code follows the same
cooperative contract, but native readiness evidence remains missing under the
recorded Windows waiver.

## Remote bound-terminal integration profile

The current remote profile supersedes the original Phase 4 dedicated-Agent-PTY
design. A remote `boundTerminal` target is the user's current SSH PTY identified
by the frozen Agent target `sessionId`. `terminal_execute` writes to that same
transport and generation, so user and Agent observe one cwd, environment,
alias/function set, history configuration, prompt, input stream, and output
stream. Repeated questions or commands MUST NOT create another terminal tab.

When the remote rollout is enabled, ordinary SSH connection startup attempts to
prepare the bash/zsh integration source, private mode-`0700` temporary root,
mode-`0600` control endpoint, and isolated control channel before starting the
user shell. Startup MUST preserve the supported shell's normal profile/rc/login
semantics, TERM, geometry, locale, interactive flags, prompt, and history, and
MUST NOT source user startup files twice. The integration bootstrap is not
typed into the PTY. Control bytes remain separate from the authoritative
`ssh-data:<transportSessionId>` raw-output stream.

Unsupported shells, unavailable SFTP, unreadable shell metadata, temporary-file
failure, or control-channel failure MUST clean up partial integration resources
and continue by starting an ordinary usable SSH shell. The generation reports
visible commands `unavailable`; it does not fail the SSH connection, open a
replacement terminal, or silently route the requested visible command to
Direct. Direct remains available only when explicitly selected or forced by the
existing sensitive/effect/lifecycle-trust policy.

The production paths that created, published, mapped, or decorated a dedicated
Agent SSH PTY, including its frontend creation event and persisted UI fields,
are removed. Reconnect replaces only the user's transport, advances the terminal
generation, and reinitializes integration when the rollout is enabled; a
connection created while it is disabled follows the ordinary shell path. Old
raw frames, control events, leases, input, and completion are rejected, active
incomplete commands settle `uncertain`, and every result remains
`noAutoReplay: true`.

## Review disposition

Phase 0 review checked this RFC against every cross-phase invariant in the
roadmap. The machine-readable fixtures cover generation rollover, ordered raw
bytes, integration readiness and lifecycle, command completion, screen state,
lease ownership, takeover, and uncertainty. The 2026-09-15 amendment above is
the explicit decision required after Phase 3 adversarial review showed that the
earlier arbitrary-same-UID interpretation was neither implementable for a real
interactive shell nor an accurate product promise. Under the amended
cooperative model, POSIX Phase 3 may pass when its production and adversarial
gates do; Windows remains a native-evidence debt rather than a claimed pass.
