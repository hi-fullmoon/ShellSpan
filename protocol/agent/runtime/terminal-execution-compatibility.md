# Terminal Execution Compatibility and Rollout Plan

Status: historical Phase 6 local rollout and remote migration records are retained. Stage-four host-scoped Windows native/frontend/model evidence was accepted independently on 2026-10-25; untested platform and architecture lanes remain open.

Protocol: [Terminal Session Protocol v1](./terminal-protocol-rfc.md)

Current routing amendment (2026-10-23): the selected `direct`/`boundTerminal`
surface is binding. The [visible-terminal unification plan](./visible-terminal-unification-plan.md)
supersedes earlier forced-Direct routing statements in historical acceptance
documents. Effects continue to control approval, not execution routing.

Stage-two amendment: complete native scripts preserve their approved source in
`commandLine`. Bash records its complete visible native evaluation envelope in
`submittedCommandLine`; lifecycle matches that actual accepted line exactly.
ZLE and PSReadLine accept the original buffer. See the plan for parser, heredoc,
cancellation, byte limits and version evidence. Windows native-shell evidence
is recorded in [the Windows acceptance report](./windows-native-terminal-acceptance.md);
stage-four desktop/model cases and the complete normal native and full frontend
gates are recorded independently in [the Windows desktop continuation](./windows-desktop-terminal-acceptance.md).
Both gates passed on the named Windows x64 host on 2026-10-25, with matching
production code across their frozen runs. The final frontend supplement also
includes the route-schema test and offline diagnostic example missing from
the earlier Windows inventory; those additions have explicit schema/build
checks and a complete-tree frontend pass, rather than retrospective coverage.
This does not change older
failed-run verdicts or establish other hosts, architectures or Linux desktop.

## Compatibility table

| Existing boundary | Current meaning | Migration decision | Compatibility proof / removal gate |
| --- | --- | --- | --- |
| `AgentExecutionSurface` | Persisted values are `direct` and `boundTerminal` in Rust event v5 and TypeScript. `boundTerminal` selects cooperative, wrapper-free terminal execution when it is available. | Preserve both serialized values. Do not add a third persisted surface for interactive operation; it is a runtime capability of the real-terminal surface. | Existing v5 session fixtures and restart tests continue to load both values. Runtime readiness remains ephemeral and platform-scoped. |
| Model tool `run_terminal_command` | Stable model-facing facade normalized by the native adapter. | The selected surface is binding. `boundTerminal` uses the current shell and its native editor. `background=true` requires advertised `nativeJobControl` and returns a generation/Agent/task-bound `job-*` handle. Unsupported capabilities and explicit `directRequired` fail before execution. Effects retain approval classification. Explicit `direct` preserves scripts and `proc-*` handles. | Real local/SSH Bash/Zsh jobs cover prompt reuse, shared output, native lifecycle and cleanup. Windows PowerShell uses owned console workers, validated state snapshots and the same ConPTY output; the supported-host implementation defaults on, with explicit `0` rollback for newly prepared shells. See the dated Windows report for actual versions, source bindings and remaining final gates. |
| Native shell job handles | Opaque `job-*` binds frozen target, integration identity, terminal generation, Agent/task and one launch operation. | `wait_process` observes without killing on wait timeout; `kill_process(terminate)` uses native job identity. No isolated job stdin or logs. Prompt/lease gates apply to management; incomplete launches and lost control remain uncertain without replay. | Native Bash jobspec and Zsh jobstates/jobtexts use no human table parsing. Windows binds a held worker Process handle to a fresh Job Object before source delivery and confirms termination only after the owned group is empty. Unsupported caller state is refused; unknown observations remain uncertain. Supported Windows shells default on, with explicit `0` rollback; desktop/model acceptance and the full standard gate remain separately recorded. |
| Native `exec_command.channel` | Contract v3 accepts only `direct`, which uses process/SSH exec. Visible commands use the separate `terminal_execute` contract. | Remove the former `pty` channel instead of reinterpreting it. Historical event payloads remain readable as opaque recorded JSON, but a new `pty` tool call is invalid. | Protocol tests require `channel = direct`; native routing exposes only `TerminalExecute` or `Unavailable`. |
| Agent Session event v5 | Append-only JSONL source of truth. `session/created.executionSurface` and `session/execution_surface_changed.data.surface` persist surface choice; `tool/call`, `tool/execution`, and `tool/result` persist execution boundaries. | Keep version 5. Phase 0 repairs the schema enum to match the already-shipped surface-change event. Raw frames, integration secrets, and screen contents do not enter event v5. Phase 3 adds the `uncertain` tool-result status and versioned `terminal_execute` result data without changing the envelope; explicit uncertainty remains a reconciliation boundary. Oversized private Assistant replay uses a content-addressed, zstd-compressed artifact claim check; the replay inline threshold remains 256 KiB. File/script execution expands the durable event bound to 512 KiB for escaped 128 KiB writes and exact-diff approval prompts; older runtimes may reject these larger records (see file-and-script-execution.md). Existing inline records remain readable, but runtimes predating claim checks are not supported for downgrade reads. | Event-v5 compatibility fixtures validate `direct` and `boundTerminal`; Rust replay tests retain every older result status and prove `uncertain` is never auto-replayed. Replay storage tests keep every JSONL event bounded, hide the private artifact reference from public projection, verify its digest, restore same-domain provider metadata after restart, and keep archived history viewable when a replay artifact is unavailable. |
| Persisted Agent Sessions | Stored under `sessions-v5`; historical events are replayed strictly. | Never rewrite old logs in place. Continue deriving `boundTerminal` exactly as stored. New runtime readiness is ephemeral/derived and must not make an old record unloadable. | Rust restart tests plus frontend adapter fixtures cover restoration. Migration tests in Phase 1 must include pre-feature sessions. |
| Persisted terminal workspace | Terminal tabs restore identity and layout; reconnect replaces the transport session id and records bounded ancestry ephemerally. | Preserve the stored workspace format. The broker maps replacements to new generations; Agent rebinding additionally requires the dedicated verified reconnect command described below and never implies safe command replay. | Workspace persistence, generation tests and native idle-timeout/Enter reconnect regressions remain green. |
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
   dispatch. Effects retain their approval requirements. Requests requiring
   process-isolated lifecycle evidence reject `boundTerminal` and require an
   explicit switch to Direct.

## Named feature flags

Flag names are stable runtime identifiers. Their implementation belongs to the
phase listed below; Phase 0 only reserves their names and behavior.

| Flag | Phase | Default until gate | Prerequisites | Enabled behavior | Rollback rule |
| --- | --- | --- | --- | --- | --- |
| `terminal_broker_v1` | 2 | on for Windows and macOS local; off elsewhere | none | Creates broker session records and fans raw bytes to bounded consumers without rewriting display bytes. | Disable dependent flags before the broker for new local generations. Close active broker generations; unresolved operations become uncertain. Deferred platforms report visible commands unavailable. |
| `terminal_shell_integration_v1` | 3 | on for Windows and macOS local; off elsewhere | `terminal_broker_v1` | Installs supported local cooperative shell integration with a generation-bound control plane. Unsupported or failed initialization degrades explicitly. | Stop new integration bootstrap and mark affected generations degraded. Invalidate active integration; any command lacking accepted completion becomes uncertain. |
| `terminal_execute_v1` | 3 | on for Windows and macOS local; off elsewhere | broker + ready cooperative shell integration | Routes supported visible commands regardless of effect. Ordinary commands remain wrapper-free; complete scripts use the advertised native mechanism. Explicit `directRequired` rejects bound-terminal execution. | Stop routing new calls. Existing calls finish on their chosen path or become uncertain; never replay. Rolled-out local platforms offer explicit Direct instead of reviving the wrapper. |
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
Submission also reserves backend input ownership before `turn/start`. Explicit
stop releases that reservation after the driver and pending tool executions
settle, including when no turn started and no `turn/end` event is emitted.
Stop admission is serialized with starts and text/image submissions. A per-session
stop fence rejects replacement starts and new submissions until cleanup finishes,
while duplicate submission receipts remain readable. The fence is released on
success or failure, without holding the admission mutex across asynchronous waits.
This does not clear the broker's independent pending-input recovery guard.
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
Interactive input may acquire an exclusive lease while a foreground pager or
REPL is waiting, without requiring a shell prompt, once the command observation
has retired. An active command observation still blocks acquisition. Generation,
rollout, takeover, credential-prompt and pending-input recovery checks remain in
force. `boundCommandReady` gates new shell commands, not observation or deliberate
input to a foreground program. For example, less accepts
`{"inputKind":"text","text":"q"}` without Enter. After the trusted shell prompt
returns, the same Agent/task's next command releases its interactive lease before
acquiring the command lease. The uncertain command result remains uncertain and
is never replayed or retrospectively reported as completed.
Vim/Neovim recovery requests a safe exit with Escape, text `:qa`, and Enter.
If the editor refuses because a buffer is modified, leave it open and preserve
the buffer. Saving requires task authorization; forced exit or discarding changes
requires explicit user authorization. Do not replace a refused exit with `:qa!`,
`:q!`, `ZQ`, or process termination. Tool guidance carries this policy.
When a user decision is needed, the root Agent must call `ask_user_question`
and wait for the submitted answer before dependent actions. The system prompt
and question-tool description both require the existing question card and
waiting flow; ordinary chat questions or simulated cards cannot substitute.
An unresolved editor decision leaves the editor open. A child without the
question tool reports the decision to its parent. Existing answers and task
authorization do not require another question, and answers do not bypass native
approval or recovery checks.
The optional native macOS gate `pnpm test:terminal-editors:macos` requires real
`vim` and `nvim` executables on PATH and fails if either is missing. It explicitly
runs four otherwise ignored PTY regressions (Bash/zsh × Vim/Neovim), each with
clean and modified-buffer exits, using a temporary copy of `src/lib/README.md`.
They verify that `:qa` refuses unsaved changes, the original file is unchanged,
the in-memory edit survives and is persisted by a separate explicit `:w`, and
the shell accepts a new command after exit. The tests use production terminal
registries and real editors; they do not make a model request.
When later model requests project those durable receipts back into tool-call
history, they use a non-executable `historicalInput` receipt with
`available = false` and `replayable = false`, preserving the call/result pair.
Historical receipts intentionally do not satisfy the live tool input schema;
they never substitute omission markers or empty strings for executable input.
Live calls containing receipts or legacy omission markers are rejected before
dispatch with `ephemeralInputUnavailable`, `executed = false`, and
`retryable = false`. The model may read current state and reconstruct real input.
A second such rejection in the same turn stops admission, closes that turn,
and moves the task to Waiting with `ephemeralInputRecoveryRequired`; it cannot complete successfully
from repeated rejected input. A new user turn gets a fresh recovery attempt.
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
they do not by themselves authorize rebinding an old Agent Session. The dedicated
reconnect command additionally verifies backend transport ancestry and live
identity, requires stopped work and released terminal ownership, and records the rebind
with reset approval policy in the original conversation. It never replays work.

Restoring a stopped conversation does not require an execution-result form.
Unknown outcomes remain attached to their original tool rows after interruption,
cancellation, reconnect and restart. Rebinding preserves that evidence, resets
approval policy and never submits terminal input or resumes the old tool queue.
Only a new user message starts another turn. Discussion and authorized
non-mutating tools remain available, including sensitive reads under their
normal approval rules. While an earlier outcome remains unknown, the runtime
rejects mutating or unknown effects before tool hooks/preparation completes and
again at the durable dispatch boundary, including delegated operations and full
access mode. Shell text is never assumed read-only by the recovery UI.
The original owner's definitive result can settle the matching step/call; a
reconnect, a new turn or successful unrelated inspection cannot settle it.
Legacy post-terminal reconciliation audit records remain readable, but there is
no result-confirmation dialog or new manual-confirmation input in this flow.

The frontend offers automatic rebind only when consecutive broker generations
confirm the replacement in the current process. Layout replacement IDs alone
preserve history selection but do not establish reconnect eligibility. Restored
workspace rows have no broker identity after a restart: their next connection
starts a new broker lineage. Explicit human verification can restore a settled
conversation after the backend checks the same host, port and login. Unknown
outcomes restrict execution effects rather than blocking conversation access.

## Visible command typing

The frontend lease-ready acknowledgement accepts optional `reducedMotion`.
Missing preferences default to reduced motion for older clients. The desktop
passes the current `prefers-reduced-motion` preference for each operation.
Without reduced motion, ordinary short commands advance in Unicode grapheme
clusters at 35 ms intervals, batching long commands into at most 48 writes (a 1.7 s
input budget). A 150 ms pause precedes the submit key. Output remains live.
Animated chunks use normal text input rather than repeated bracketed pastes,
avoiding paste-highlight redraws when the command wraps across terminal rows.
Reduced motion submits those short commands without animation or pause.

Lease events additionally accept `state: activity` and
`commandPhase: typing | running`. They carry no command text and only update
the matching active lease; they do not acquire ownership or require another
readiness acknowledgement. The existing status bar displays the phase.

Each input enqueue and the final submit share a per-operation gate with
cancellation and takeover. Cancelling before submit discards the shell edit
buffer with the existing scoped interrupt and settles as cancelled/taken over;
the submit key is never sent. Execution timeout starts after submission.
Every bracketed-paste envelope is closed within one enqueue. Complete scripts
use the advertised native Readline/ZLE/PSReadLine editor bindings: LF/CR/Tab
insert literal buffer characters, then one dedicated accept-line submits the
whole source or the visible Bash envelope containing that source. Bash validates
and evaluates source at top level as one interruptible unit. This path does not
rely on bracketed paste. Bash/Zsh receivers that advertise `Y=1` also support
animation: at most 48 grapheme-safe buffer prefixes, separated by 35 ms and an
exact native buffer acknowledgement. Each Bash/Zsh frame keeps the
submit/cancel/takeover gate from receiver readiness through the complete data
enqueue, resetting the previous frame receipt before the next receiver starts.
A stop request then waits for that frame's matching acknowledgement with the
existing bounded receipt timeout before attempting the independently confirmed
editor clear; editor control keys cannot enter the readiness/descriptor gap.
Intermediate `c` (Bash) / `f` (Zsh) frames only edit the buffer; the final
`b` / `e` frame retains complete-source validation and the single accept-line.
Immediately before that accept, the command result capture budget restarts so
repeated typing redisplays cannot
truncate execution output; terminal display and replay retain all original bytes.
A receiver only replaces an empty buffer or its own last confirmed edit,
preserving unrelated user drafts. Each frame keeps its existing bounded receive
deadline; reduced motion and older receivers
retain the complete-frame path. The capability resets at every prompt and
integration generation. A cancellation boundary remains before accept-line even
in reduced motion. Other control characters stay rejected. Unsupported editors
fail before input;
see `visible-terminal-unification-plan.md` for shell/version and grammar limits.

The broker tracks pending command input independently of the Agent lease.
Releasing or retiring a command cannot unlock a potentially dirty edit buffer.
Only an accepted command-start/prompt-end event or a new terminal generation
clears this guard. If integration fails during typing, input stops, cleanup
attempts a scoped interrupt, and subsequent user input is rejected with
`TERMINAL_INPUT_RECOVERY_REQUIRED` until the prompt is confirmed or the terminal
is reconnected. Raw terminal output does not clear the guard. Commands are
never replayed.

Bash/Zsh private script receivers keep terminal echo disabled across the entire
descriptor and encoded payload, using the `stty` executable resolved at shell
startup even if the user later changes `PATH`. Successful frame acknowledgements
are emitted after terminal modes have been restored. Stop/takeover waits up to
two seconds for an outstanding frame acknowledgement under the submit gate
before settling and retiring the unsubmitted command, preventing the discard
key from racing receiver cleanup. If the frame receipt is lost, the scoped
clear still requires its own matching empty-buffer acknowledgement; otherwise
the input recovery guard remains held. A truncated, invalid or timed-out
frame enters a silent drain instead of returning its delayed tail to the shell
editor. Ctrl-C does not release this isolation, because it cannot prove that
all bytes in flight have arrived; reconnect to establish a fresh generation. No delayed
source is submitted, decoded for execution, or replayed during this drain.

Before every model step, the runtime reads the bound terminal's current
generation, open/prompt state, script/job capabilities and input recovery state.
The current capability context and command tool description supersede earlier
snapshots. Unknown capabilities do not authorize scripts or background jobs.
`TERMINAL_INPUT_RECOVERY_REQUIRED` and `TERMINAL_DIRECT_REQUIRED` stop the tool
batch and automatic model continuation after committing the failed/rejected
result. Undispatched calls remain explicitly not started; queued user input is
paused. The task waits for explicit recovery/reconnect or a user-selected Direct
surface, retaining uncertainty and the no-replay rule.

### SSH recovery acceptance

The 2026-10-27 acceptance ran five faults over an external saved-profile SSH
connection and the same five faults on real isolated Bash and Zsh SSH servers:
partial descriptor timeout, absent payload, partial payload timeout, transport
closure during input, and transport closure after command start. All 15 cases
passed through the production SSH2 transport, shell integration, broker and
command registry. Delayed bytes after Ctrl-C remained invisible; retry probes
enqueued no new input; reconnect increased the terminal generation, submitted
no automatic input and executed only the explicitly requested fresh command.
The already-started command stayed uncertain and its first side effect occurred
once. Evidence uses actual remote file reads, generation/input counters and
redacted terminal transcripts, with no model-provider requests.

`pnpm test:terminal-visible:ssh` now includes the isolated recovery cases.
`saved_profile_ssh_input_timeout_disconnect_and_reconnect_do_not_replay` is an
explicitly ignored release-mode acceptance test: select an existing profile
with `SHELLSPAN_SSH_ACCEPTANCE_PROFILE_ID`. It reads profile metadata without
database writes, resolves the password through the production OS keychain and
uses the existing trusted host key. Secrets are never passed in command-line
arguments or evidence. `SHELLSPAN_SSH_RECOVERY_EVIDENCE_DIR` selects an absolute
evidence directory. Saved-profile tests never run as part of the default suite.
This lane supplies its own readiness acknowledgements; desktop UI interaction
and real-model automatic continuation require their separate acceptance lanes.

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
