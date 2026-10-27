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

Terminal close is idempotent: after associated Agents have settled and terminal
ownership has been released, an absent transport or an exited command worker
counts as closed. The UI removes the tab without an error notification. Registry,
Agent settlement and ownership failures still propagate and retain the tab.

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

Rendering metadata is separate from lifecycle authority. The live backend
`SessionSummary.ptyInfo` reports the actual transport kind and, for local Windows
ConPTY, the OS build read through sysinfo. The frontend uses this metadata for
xterm `windowsPty` resize compatibility and replaces it on reconnect. It MUST NOT
infer ConPTY from the frontend host or an SSH destination, assume a modern build,
or persist the metadata in workspace records. This does not modify the raw output
stream, PSReadLine syntax colors, or prediction settings.

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

Secrets and authorization checks MUST NOT rely on cooperative shell lifecycle
metadata. Known `sensitiveRead`, `destructive`, and `externalSideEffect` effects
MUST retain their native approval classification and deny rules without changing
the selected execution surface. Callers MUST request
`lifecycleTrust = directRequired` when contextual adversarial or untrusted code
requires process-isolated lifecycle evidence. Such requests MUST be rejected
before input in `boundTerminal`, with an actionable requirement for the user to
explicitly switch to `direct`; the adapter MUST NOT switch automatically.
Direct isolates lifecycle/control from interactive-shell hooks, but it is not
by itself a general OS sandbox. Approval is always decided before dispatch and
never depends on visible-terminal completion metadata.

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

`commandStart.commandLine` MUST exactly match the actual submitted editor line
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
broker sends the frozen source or its deterministic native submission envelope
through the common input path. Ordinary commands remain wrapper-free. Bash
complete scripts use the native eval line below; it is evaluated at top level
in the existing shell. No `/bin/sh -c`, child shell, temporary script, or
synthetic `[Agent]` echo is added. Normal input echo remains raw output.

### Complete native scripts (unification stage two)

`commandLine` in the tool result is the approved original source (at most 8192
UTF-8 bytes). Optional `submittedCommandLine` records the actual Bash editor
line, including native quoting. Command-start lifecycle MUST match
that exact line, not the original source. Without an envelope, lifecycle
MUST match the source as before. The broker independently recomputes and checks
the envelope before input; it never weakens exact-line matching.

Bash 4.1+ Readline inserts a visible native command of the following fixed form. `Q`
is the complete source encoded as one argument by the mature `shlex` quoter;
physical newlines remain physical newlines, and decoding that argument yields
the approved source byte for byte:

```bash
(exit "$?"); builtin eval -- Q
```

The native validator uses the pinned current Bash executable in no-exec mode,
carrying parsing options. The private receiver validates the original source
and the actual eval line before acknowledging its Readline buffer. `eval`
then runs at top level in the same shell. A status-only native subshell restores
the preceding status and foreground interrupt settlement; it contains no user
source. Source execution introduces no function scope or child shell.
This is one interruptible evaluation unit: accepting a
raw multiline Readline buffer instead can continue later physical lines after
SIGINT. Readline displays the actual native eval line and quoted script;
private validation/status helper code is absent. The real raw stream is the
only display/capture source.

ZLE accepts the original complete buffer. It validates syntax with a pinned
executable matching the integrated Zsh, carrying parsing options and disabling
startup/interactive execution; PATH changes cannot substitute another parser.
PSReadLine inserts literal characters with native handlers and uses PowerShell's
`Parser.ParseInput` AST before acceptance. Prefix call `&` is allowed there;
background `PipelineAst.Background` is refused. Bash grammar is not used to
classify PowerShell. Both Windows lanes require native verification separately.

Rust rejects unsupported controls, oversized source/envelopes/editor input and
unsupported capabilities before writing. Both POSIX native no-exec parsers can
accept EOF within heredocs; each heredoc therefore additionally needs an
explicit nonmissing `heredoc_end` node in the mature grammar. Other Zsh syntax
is not rejected merely because the Bash grammar has errors. Background syntax
inspection remains conservative and is not a sandbox.

Zsh scripts containing grammar comment nodes require the current shell's
`INTERACTIVE_COMMENTS` option. If it is off, they fail before any input rather
than changing user options: noninteractive `-n` comment semantics do not prove
the completeness of an interactive ZLE buffer. Hashes inside quoted literals
or heredoc bodies are not comment nodes.

Internal isolated-control records add `I\0{0|1}\0` (native editor capability
between prompt-start/end), `C\0{0|1}\0` (Zsh native comment option),
`J\0source\0reason\0` (source not executed; reason is
`TERMINAL_INPUT_UNSUPPORTED` or `TERMINAL_BACKGROUND_UNSUPPORTED`), and `U\0`
(custom Bash INT handling makes an interrupt settlement uncertain). They use
the same registered integration/generation identity checks as lifecycle.
`nativeScriptInput` is the corresponding optional public capability. Each
control field is bounded to 32768 UTF-8 bytes and the control buffer to 131072;
the generated envelope and encoded editor input (65536 bytes, or 131072 for
the bounded Bash source-plus-display frame) are
checked before any lease/input. Nothing is truncated or resubmitted.

Current native input additionally requires `H\0{0|1}\0` advertising the owned
checkpoint binding. `I=1` alone from an older bootstrap is insufficient.
Input uses bounded Unicode-safe editor chunks. `A\0buffer\0` must acknowledge
the exact complete expected buffer before the next chunk. Readline/ZLE quote
ordinary characters as well as LF/CR/Tab; each payload is at most 512 encoded
bytes, followed by the native Ctrl-X Ctrl-A checkpoint widget. The Windows
candidate uses at most 8192 decoded UTF-8 bytes per Base64 payload: Ctrl-X
Ctrl-B first acknowledges the unchanged buffer, then an editor-owned receiver
reads through the non-submitting Ctrl-X Ctrl-F data fence within two seconds.
Public PSReadLine Replace preserves CR/LF/Tab, and GetBufferState supplies the
exact complete-buffer A acknowledgement. Native syntax coloring and prediction
remain enabled. The 65536-byte total includes encoded data, all readiness and
checkpoint keys, and the final accept key. Windows acceptance remains separately
versioned in windows-desktop-terminal-acceptance.md.
Long single-line sources above 512 UTF-8 bytes require this native path too;
an unavailable editor rejects before input rather than overflowing a PTY queue.
No fixed delay is used as evidence that a chunk was consumed. The existing
150ms pre-submit cancellation boundary follows the final acknowledgement.

Before any native source is typed, a read-only A probe must confirm an empty
editor. Existing user draft text causes rejection without writing or clearing
it. Bash unsubmitted cancellation uses an owned Readline discard widget; Zsh
uses a ZLE widget that clears BUFFER/CURSOR and redraws the existing prompt.
Neither interrupts an in-flight editor callback or submits another line. They emit
`L\0positiveSequence\0emptyBuffer\0`; the backend binds that monotonically
increasing sequence to the original integration/generation/operation and a
successfully enqueued discard key. Prepared, duplicated, delayed or foreign L
cannot confirm a newer clear. The clear scope is removed as soon as an accept
key is admitted, so it cannot inject a shortcut into a running program. A clear
timeout retains quarantine and prevents replacement leases. Clearing an edit
never sends Enter; a missing/mismatched checkpoint's sticky quarantine is not
removed by L. User Enter also closes the backend prompt gate at admission,
before the asynchronous S event, so management cannot enter a just-started user
program during that transport window.

Cancellation/takeover restores an unsubmitted editor once under the input gate.
The input worker must not repeat that interrupt/clear while unwinding: a second
interrupt can abort the replacement prompt's lifecycle hooks.

A records are private and cannot authorize commands or clear recovery. They
are bound to the active operation and current integration/generation. A
mismatched or missing checkpoint quarantines input until a new generation;
ordinary prompts, an unsolicited empty A or a same-generation integration
replacement cannot clear it. Cancellation/takeover wakes a checkpoint waiter
under the shared submission lock, sends no subsequent chunks or accept key,
and retains the existing scoped-interrupt/prompt recovery contract. Missing
confirmation never causes a chunk or source to be replayed.

Parser rejection returns failed with `inputRejection`, retains the source and
actual envelope in the result, and reports no source statement executed. A
trusted prompt is still required to clear input recovery. Cancellation and
takeover before submit interrupt the whole edit buffer; no accept key follows.
Known custom Bash INT traps disable complex submission. Ordinary commands keep
the user's trap; interrupted settlement is uncertain when that handler can
continue execution. Deliberately changing traps/options inside source remains
cooperative shell behavior, not process isolation. `LINENO`/`BASH_SOURCE` and
history expose native eval/envelope context; they are not promised to equal
separate interactive submissions. `return`, `exit`, `set` and alias expansion
follow each native shell's script semantics. ZLE parses one complete buffer,
so an alias newly defined there becomes available to subsequent buffers.

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
reconnect creates a new execution trust boundary while preserving the Agent
conversation. `agent_runtime_reconnect_terminal` verifies the live local/SSH
identity and current execution state before recording
`session/terminal_reconnected` in the same Agent Session. Broker-verified
transport ancestry permits automatic rebinding. When ancestry is absent (for
example after an application restart), an explicit restore action may bind a
fresh connection with the same login only if the original transport is missing
or disconnected. A still-connected or connecting original transport cannot be
adopted this way. The terminal registry remains locked through the journal
commit so a concurrent close or status change cannot invalidate that check.
The current transport must be open, have no Agent lease, active command or
pending native-input recovery, and for visible execution must have a trusted
ready prompt. Only settled root
Sessions with empty inboxes, settled children and reconciled native effects may
rebind. The target's explicit project root and all conversation events remain;
the target/transport IDs change and permission resets to `requestApproval`.
Old approvals, leases and process handles never authorize the new target.
Pinned file/Skills directory identity remains unchanged; its transport target
advances with the reconnect event, and Skills catalogs are observed afresh.
The asynchronous reconnect command writes its journal off the UI thread and
waits for an overlapping terminal close before retrying the binding.
Rebinding neither resumes a turn nor submits input: the next explicit human
message must inspect current execution state and must not replay earlier commands.
Uncertain operations remain blocked for reconciliation.
The UI preserves the original conversation and unsent draft while verifying;
verification errors remain retryable in place and do not require a new Session.
Same-login restoration must not fall back to creating a linked Session to
bypass pending input, child work, approvals or uncertain execution outcomes.

Focus follows the explicit replacement of its selected terminal transport
when the profile, host, port and username remain unchanged. This includes
reconnecting while viewing another tab or while Focus is hidden. Viewing or
closing a terminal never adopts an unrelated target. Following the UI target
does not transfer Agent authority: broker ancestry, settled execution,
reconciled effects and fresh permission checks above still govern rebinding.

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

Before acknowledging a connected, output-ready Agent lease, the frontend selects
and displays the lease's target terminal, commits its attachment, and verifies
that the target xterm textarea owns DOM focus. It rechecks controller and lease
identity after the UI commit. Failed focus leaves frontend readiness pending;
the existing five-second readiness timeout releases the lease without PTY input.
When a Terminal-workspace Agent runs while the user is viewing Focus, acquisition
and release preserve the viewed workspace, selection, target and keyboard focus.
In this case DOM focus is not a readiness requirement: commands write to the
leased PTY directly. Controller identity, connected transport, output readiness,
pending/unverified input and credential-prompt checks remain required.
Deferred section/tab focus must revalidate the selected session and controller
identity when it runs, and discard obsolete requests or requests after unmount.

Visible-terminal submissions reserve the terminal turn owner before durable inbox
admission. Competing Agent submissions fail with `TERMINAL_AGENT_CONFLICT` and
are not queued for automatic execution when ownership is released. Retrying an
already committed client submission still returns its original receipt. Failed
admission releases a newly acquired reservation. Terminal and Focus display the
same owner, link to its conversation, and retain the losing workspace's draft.
Release invites an explicit retry after inspecting the terminal's current state.
Takeover continues to require backend fencing before user input is restored.

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

Terminal closure may retire the execution registration before its waiter returns.
The waiter still returns the operation's captured output and `uncertain` outcome
with `noAutoReplay`, without requiring that registration to remain present.
Cleanup and capture finalization must not affect a replacement operation or use
output sequence numbers from a reconnected terminal generation.

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

## Native shell jobs

Zsh launches display a native asynchronous group containing a short opaque
`job-*` marker followed by the unchanged approved source. The one-use marker
returns before source execution; source runs at subshell top level. Completion
notifications therefore use native source text without the private validation,
trap or management implementation. Existing ZLE rendering and coloring remain
in effect; the frontend does not filter terminal output.

Zsh native script input and management require the private-widget capability
`V` (`0` or `1`), advertised with I/H at each prompt. Long/multiline source and
short foreground commands while current-generation controlled jobs may still
produce output use one bounded ZLE data receiver. Its 65-byte descriptor is
`e`, four hexadecimal digits for the encoded length, 28 random hexadecimal
digits, and a fresh 32-digit nonce. The ASCII `\\xHH` payload is decoded with
native `printf %b` into a variable, never eval/source/execute. After the bounded
read, native `zle -I` preserves asynchronous output before one BUFFER replacement;
M must match both the fresh descriptor and the entire approved buffer before
one native accept. Syntax coloring and prediction configuration remain intact.
Accept does not unconditionally invalidate the displayed buffer again. The
receiver snapshots running/suspended controlled groups from native jobstates
and jobtexts before this edit; only an edit with another such job retains the
protective accept-time invalidation. Its flag is consumed once and cleared on
prompt/discard. A first background launch and multiline foreground input with
no other jobs therefore display their source once. With another live job,
native invalidation can leave a source redraw fragment while preserving
interleaved output; it does not execute the source again. Native notifications
remain unchanged.
Ordinary short input without potentially active controlled jobs retains its
existing path. Old Zsh integrations without V advertise neither native script
input nor usable native job control; data is refused before typing.

Poll/stop require an empty native
editor checkpoint, then transfer a fixed 65-byte descriptor (action, opaque
handle suffix, fresh operation nonce) to a bounded native receiver. `M` returns
that descriptor and the observed editor buffer over the integration channel.
Only the matching current operation may dispatch the one-use commit widget;
the normal Enter path discards pending descriptors. Management keeps canonical
S/E/P/Q audit events without placing private commands into the editor/history.
Lease, generation, integration and frozen job bindings are revalidated before
each write under the existing submission/cancellation mutex. Missing or
mismatched confirmation retains uncertainty and never permits automatic replay.
The source receiver reads for at most two seconds; readiness and M share the
original bounded confirmation deadline. A late M cannot release recovery or
acknowledge another operation. Source-may-be-enqueued remains monotonic.

Before accepting a Zsh job, the native parser checks both the complete envelope
and the original source independently under the captured shell options. Only
the fixed broker-built prefix/suffix are removed; source grammar is parsed by
the native executable. This prevents invalid source from closing the outer
group. With errexit/errreturn and a nonzero prior status, launch explicitly
returns TERMINAL_BACKGROUND_UNSUPPORTED before source execution, without
changing those options or disabling management of existing jobs.
The Zsh evidence alone does not establish Bash or Windows display acceptance.
Windows PSReadLine coloring remains unchanged and requires native validation.

### Bash and PowerShell display extension (2026-10-26)

Bash jobs use a short marker/native asynchronous group containing
`builtin eval -- Q`, where shlex quotes the original source as one literal
argument. The receiver independently validates the original source and the
actual group before acknowledgement. The marker installs completion handling,
restores the parent's `expand_aliases` setting in the asynchronous child and
returns before eval runs at child top level. This preserves aliases defined
and used on successive source lines, as well as the preceding exit status;
source state changes remain confined to the child. Zsh keeps its native group.
With errexit and a nonzero preceding status, Bash refuses the launch before
source execution. Discard clears an armed marker; registration requires a real
native jobspec or completion receipt.

Bash long/multiline input uses a bounded private receiver, followed by native
Readline accept-line after a non-accepting frame checkpoint. The source
receiver reads each fixed-byte field in a synchronous command-substitution
child. That child stays in the foreground process group, opens its own
temporary /dev/tty descriptor and uses only builtins, creating no children.
The parent's background job exits therefore do not deliver SIGCHLD to the
reader while older Bash applies tcsetattr(TCSADRAIN). Child exit closes the
descriptor on success, timeout or interruption; no detached reader remains.
Each read consumes its original absolute timeout budget, without input
replay, deadline extension, parent trap replacement or changed parent job control.
The final accept does not perform bind-x cached line clearing, preserving
interleaved background output. Bash 4.1's descriptor allocation is required.
The receiver sets READLINE_POINT in bytes on Bash 4.x and in characters on
Bash 5.x+, without changing the caller's locale or native multibyte editing.
The Bash 4.x byte count comes from the validated frame lengths: subtract the
original-source field from the total encoded field and divide by four for
the ASCII `\\xHH` encoding. It does not assign LC_ALL, including when the
caller has made LC_ALL read-only.
Syntax refusal refreshes prompt readiness without rebinding the executing
bind-x command; Bash 4.x keeps that command string in place during its callback.
Binding refresh waits for the next real PROMPT_COMMAND cycle.
Its 65-byte descriptor is `b`, five hexadecimal encoded-length digits, four
hexadecimal original-source-length digits, four hexadecimal row digits, four
hexadecimal column digits, 15 random hexadecimal digits and a fresh 32-digit
nonce. Lengths count ASCII `\\xHH` bytes. The optional original
source precedes the displayed foreground or background eval line; both are decoded by native printf,
never evaluated by the receiver. Rust uses shlex to encode/decode the one eval
argument. Original source remains capped at 8192 UTF-8 bytes, actual line at
32768 bytes; only Bash's private wire budget becomes 131072 bytes to carry both
bounded fields. M must match the descriptor and entire actual editor line.
Before Readline's oversized-buffer viewport clear, the native receiver scrolls
the existing screen into terminal history. It emits cursor/newline controls,
never copies command text or output. This preserves earlier background lines
in narrow terminals without filtering, replaying or dropping raw output.

PowerShell jobs display `job-<opaque handle> Q`, where Q is the native
single-quoted original source (apostrophes are doubled). Before
acceptance, the native PowerShell parser validates source and complete line;
a temporary global marker passes the native StringConstantExpressionAst value
as data to the existing
console worker implementation. It probes inherited StrictMode and captures
caller functions/language before entering the module. Source is not invoked in
the marker. The prompt removes only the installed function with matching
identity. Its real worker/state/Job Object restrictions remain in force.

Bash and PowerShell poll/stop reuse the one-use private descriptor protocol.
PowerShell transports its descriptor through the existing bounded Base64
console receiver and fence, keeping PSReadLine coloring and prediction intact.
For Bash and PowerShell, receiver readiness is the separate `W\0` record,
expected only during that operation's private-control handshake. Their private
receiver chord is Ctrl-X/Ctrl-R, avoiding Ctrl-O being consumed by macOS
VDISCARD with Bash 4.x's older Readline tty settings. An ordinary
buffer-only A cannot confirm it. Matching M is still required before commit;
W alone grants no execution or management authority. Zsh keeps its existing
readiness path.
S/E/P/Q remain canonical audit records; management source is not typed into the
editor or history. Each platform's real-terminal evidence is recorded separately.

Windows PowerShell sessions prepend an application-private PSReadLine 2.4.5
module directory before normal startup/profile loading. The embedded upstream
files and license are installed atomically in a content-addressed application
cache and checked byte-for-byte before reuse. An application initializer keeps
the older no-prediction default before profiles set explicit preferences.
No system module or profile is edited. PowerShell 7's module selection is kept.
Native input refuses a mismatched option-provider/editor assembly or an older
Windows PowerShell editor, rather than silently using another execution surface.

Supported Bash 4.1+/Zsh `background=true` requests freeze the approved source,
target, Agent/task, terminal session/generation, integration identity and launch
operation. The broker independently builds and checks the frozen submission;
Bash literal quoting uses `shlex`, while Zsh additionally performs the native
source/envelope checks above. Source/envelope/editor limits remain 8192/32768/65536
bytes. The native asynchronous subshell inherits cwd, environment, aliases,
functions and options; its state changes do not modify the parent shell.
Monitor mode and native editor support are mandatory. PowerShell retains its
existing platform rollout and independent native/desktop acceptance boundaries;
this Zsh revision does not change or establish those gates. No implicit Direct
fallback is permitted.

Opaque `job-*` handles are not PIDs or job slots. A fixed native command prefix
binds the handle to its job; source/output mentioning another handle grants no
control. Native jobspec resolution selects the group atomically for TERM/CONT.
Bash observes machine-readable `jobs -p`; Zsh uses native `zsh/parameter`
jobstates/jobtexts dictionaries. Human jobs/ps tables are never parsed.
Suspended jobs remain live. Management acquires a fresh prompt/lease, preserves
exact accepted-line checks and atomically revalidates frozen bindings at every
input admission. It cannot inject into a foreground program or another lease.

The frozen submitted recipe and exact observed `acceptedCommandLine` are
separate. Launch submission completion does not prove native job start:
`launchConfirmed`, `nativeActive`, the nullable exit code, observation revision,
time and shared-output sequence range describe distinct facts. A missing start
acknowledgement retains the opaque handle and uncertainty. A new owned query
or stop can reconcile that same binding only after its own exact native S
record; creating a prepared management record cannot make delayed B/F records
fresh. A confirmed inactive job is retired even when its exit status is unknown.
Integration loss/close/reconnect sets permanent `controlLost`; it cannot be
reconciled in a replacement generation. Reconciliation never relaunches source.
Background command timeout bounds launch, readiness, typing and confirmation;
it is not the background job lifetime. Observation timeout does not stop a job.
Task cancellation/shutdown attempts only owned jobs through the same gates and
records unconfirmed cleanup instead of stealing a foreground program's input.

`wait_process`/`kill_process` dispatch by handle class; `proc-*` retains all
Direct semantics. `job-*` has no isolated stdin/stdout/stderr, and
`write_process_input` explicitly rejects it. Output stays in the original shared
terminal stream and may interleave. Results carry observation sequence ranges,
never fabricated isolated job logs. Wait timeout leaves the job running. Native
observations continue within one wait so natural completion is discoverable.
Before another editor transaction, the runtime reserves twice the largest
confirmed round-trip in that call, with a floor of twice the mandatory 150ms
pre-submit boundary. When the remaining deadline cannot cover that budget it
admits no more input and waits cancellably to the deadline. Returned observation
time/revision remain the actual last observation; elapsed time never invents exit
or refreshes state. Unexpected missing/mismatched A still quarantines the editor.
TERM is the supported stop signal; a suspended group receives CONT to handle it.
Stop requests and confirmed exit are distinct. Unknown exit status remains
uncertain, never synthesized as zero.

Direct `proc-*` keeps its existing consume-on-terminal contract: a terminal
result from `wait_process` or `kill_process` retires that handle. Use the returned
state/available output; do not query the retired handle again. A still-running
result retains the handle. A kill result with no exit code must not imply zero.

Only the interactive integration producer emits control frames. Native children
publish a completion scalar by atomic rename in the private integration
directory. The parent observes it, emits F(handle, exitCode), then
B(handle, state, nativeWaitCode-or-minus). Child directory/subshell hooks cannot
publish parent lifecycle/cwd events. Synchronous prompt-expansion Q is the sole
subshell exception. Thus completion cannot interleave long S records beyond
PIPE_BUF. User EXIT/TERM traps can replace the cooperative receipt; native wait
may recover status, otherwise uncertainty is retained. Private artifacts are
cleaned with the integration. Close, disconnect, integration loss and generation
replacement invalidate control authority; incomplete launches retain handles
and audit without replay. This is cooperative lifecycle, not strong isolation.

Windows PowerShell 5.1/7 use owned console workers assigned to Windows Job
Objects before source/state transfer. The trusted Rust process freezes the
module rollout before preparing the shell. It defaults on for supported Windows
hosts; `SHELLSPAN_NATIVE_POWERSHELL_JOBS=0` disables it for newly prepared shells,
`1` explicitly enables it, and invalid values fail closed. Changing a child
shell environment cannot enable the frozen flag. K=1 still requires native
editor checkpoints, FullLanguage and the compiled output-only PSHost.

Bounded, validated snapshots transfer supported variables, function/alias
definitions, location, version/culture/style and strict-mode context. Unsupported
state rejects before source execution. The private worker pipe verifies the
actual child PID; workers receive no original integration control pipe and
cannot prompt through Host/RawUI or consume the parent's stdin. Ordinary and
native stdout/stderr use the same ConPTY console; tool results never replay
them into the terminal. Source status is captured before formatting. Explicit
host exit, native nonzero and unknown status remain distinct; initialization
failure cannot claim execution and unknown exits are never filled with zero.

Stop and cleanup target the owned Job Object, including ordinary descendants;
control remains bound to the original opaque job/Agent/task/target/generation.
This is cooperative lifecycle, not general same-account isolation. The former
ThreadJob/Job2 design is historical and is not the current implementation.
Exact real-machine versions, source/binary bindings, matrix results and remaining
default/rollback gates are recorded in windows-desktop-terminal-acceptance.md.

## Direct execution boundary

Direct execution remains the reliable structured path for local processes and
SSH exec. Its stdout, stderr, exit code, background process handle, stdin, wait,
kill, timeout, cancellation, target binding, and recovery semantics do not
depend on TSP/1 feature flags. A terminal generation MUST NOT be added to direct
process handles, and disabling terminal migration flags MUST NOT change direct
execution behavior.

The selected execution surface is binding. `boundTerminal` MUST NOT silently
route any command to Direct, including commands with sensitive effects. In
visible-terminal unification stage two, complete scripts use the current
shell's advertised native editor capability. Unsupported editors and incomplete
heredocs MUST fail before terminal input; other syntax refusals MUST execute no
source statement and leave no executable residue. Native background requests
follow the shell-job contract above.
An explicit `lifecycleTrust = directRequired` MUST reject `boundTerminal`;
the user must explicitly switch the session to `direct`. Shell lifecycle is
cooperative and cannot supply process-isolated security guarantees.

In an explicitly selected Direct session, the model facade MAY request
`run_terminal_command.background = true` and receive its opaque `proc-*` handle. Model-facing
`write_process_input`, `wait_process`, and `kill_process` calls MUST bind that
handle to the same frozen Session, task, request, and owner target. Background
service workflows MUST terminate the handle explicitly after verification.

Shell execution is not a network sandbox and MUST NOT claim an enforced
destination scope. Known network-capable commands and general-purpose runtimes
are conservatively classified as `externalSideEffect` and
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
still use Direct execution. Selecting full access requires explicit confirmation.
The confirmed permission preference and execution surface are saved locally and
reused for new terminal sessions, including after application restart. Each terminal
captures both preferences when it is created. Changing either control updates that
terminal and the saved defaults; other existing terminals retain both settings,
including terminals that have not started an Agent Session yet. Existing Agent
Sessions retain their own permission settings. Target bindings remain
connection-scoped, and the remembered preference does not bypass operating-system
permissions or permit execution on disconnected targets.
Loopback HTTP verification uses the structured `probe_http` tool, which fixes
the destination to the frozen local or SSH target's `127.0.0.1`, follows no
redirects, exposes no arbitrary request headers, and enforces method, request
body, one total deadline, and response-size bounds. Remote probes use an
authenticated SSH direct-TCP channel connected to an internal preconnected
socket pair; no discoverable local forwarding listener carries target data.
The private SSH bridge uses nonblocking bidirectional I/O with bounded buffers,
preserves half-close, and observes cancellation and the same total deadline.
Finishing a framed or body-limited HTTP response stops and joins the private
transport without waiting for the service to close its connection. A probe
timeout leaves HTTP verification inconclusive; it MUST NOT be interpreted as
proof that a preceding service operation failed or replay that operation.
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
