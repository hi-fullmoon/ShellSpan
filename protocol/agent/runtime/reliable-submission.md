# Reliable user submissions

User-message admission is independent of model execution. Text and detached image
messages enter one serial admission queue per conversation. Another editor draft
can be submitted while a previous admission awaits a receipt. Each send gesture
captures its content, attachments, provider selection, terminal context and mode.
Identical text with different operation IDs is distinct input.

`clientOperationId` / `clientSubmissionId` remains stable across retries. The
native Inbox event is the durable receipt. Repeating the same ID and payload
returns the committed snapshot, including after consumption or restart. Changed
payloads conflict. Creation uses a stable Session ID and compares the original
creation payload before acknowledging a repeated create request. Several inputs
submitted before creation completes share that same Session.

Question cancellation recovery is scoped to the current run. A committed
`session/resumed` or idle `agent/status` with reason `stoppedByUser` closes that
cancellation scope. Earlier cancelled questions remain historical evidence and
cannot cancel a newly attached Agent or reject its next user input. A cancelled
question without either boundary still finishes cancellation after restart.

When content is redacted, text admission retains a store-owned SHA-256 digest of
the original UTF-8 content in `source.metadata.submissionContentFingerprint`.
Inbox edits retain the corresponding optional `contentFingerprint` on
`agent/inbox/item_updated`. Receipt matching checks that digest before mutable
state, so identical original content can be retried after consumption, termination
or restart. Different original content conflicts even if it produces identical
redacted text. The original secret is never retained. Legacy receipts without a
digest continue to require exact equality with their persisted content.

Model-surface reconciliation replaces an uncertain or synthetic tool result by
its complete Turn/Step/call/name identity, including after later steps, turns or
assistant messages. Audit events remain append-only. A new assistant call only
invalidates the replacement slot for that exact identity.

The committed client reconciles periodically and on foreground return. Child
snapshot synchronization has its own cursor: committing a boundary event does
not acknowledge its snapshot read. Failed snapshot reads remain pending across
automatic or explicit retries even when no further event arrives.

An IPC reply timeout is **confirming**, not failed. The adapter backfills committed
events independently of the pending command and can acknowledge a lost reply.
Failure to read the receipt is not evidence that admission failed. A definitive
rejection holds subsequent admissions until the original operation is retried;
its content is retained separately from the current editor draft. Admission
acknowledgement does not imply model completion. Only native acknowledgement
promises text-message durability across process exit. Detached image bytes and
operation identity are also retained in IndexedDB until native acknowledgement.

Only the queue head is sending or confirming; later local inputs remain waiting
to send and do not start receipt timers. Preparation has its own 15-second limit;
expiry is an unsent, retryable failure and cannot start native admission when the
old preparation eventually resolves. Retry invalidates the stalled local creation
and directory probe. Later inputs can use the session established by the retry
without waiting for their original creation probe. Submission order is retained
by a stable ordinal across failures, retries and removal of earlier receipts,
including inputs with identical timestamps. Admission listens for live durable
receipts as well as IPC replies. Receipt reconciliation is bounded to 15 seconds,
including an unavailable reconnect. Expiry retains an explicitly unconfirmed
operation with a check-and-retry action using the same identity; it never claims
the message was not sent. Both definitive rejection and unconfirmed delivery
hold later admissions. A late durable receipt clears the matching recovery state
and releases the held queue without resending that head. All user enqueue
receipts remain available for reconciliation after consumption/removal.
Admission acknowledgement does not synthesize a running runtime. Processing is
shown only for a running runtime with a committed user input or admitted turn.

Admission queues, frozen inputs and composer submission state are owned by the
application and shared through the session adapter. Closing a panel releases its
view subscription, not its queue. Reopening restores original operation IDs and
receives late worker settlements without replacing the current editor draft.
An image recovery exclusion has an explicit owner and is released in the worker's
`finally` path, including failure. A recovered queue renders its failed image
operation rather than also restoring the same image over a newer editor draft.
Image preparation observes cancellation during binding, persistence and detach;
cancelled preparation never hands a message to native admission. If binding was
already saved, cancellation restores the editable draft without overwriting a
newer draft.

`nextTurn` inputs are consumed individually in FIFO order. `nextStep` inputs are
consumed in order at the next step boundary. New steering requests may include
`targetTurnId`; the store checks that identity under the same lock as admission.
If the target turn has ended, the input moves to `nextTurn`, with the original
target and requested lane retained in provenance metadata. The UI displays the
conversion. Legacy callers without a target retain their original behavior.

Text commands accept optional `paused` and `targetTurnId` input fields. Image
submission accepts the corresponding optional top-level Tauri arguments. A
paused admission writes a single enqueue event with the store-owned provenance
flag `admissionPaused: true`, and does not wake the driver. Replay applies that
flag when inserting the message; later explicit resume events still win. Legacy
enqueue records following a failed terminal Session are also interpreted as
paused, even when a crash lost their separate pause record. Thus every complete
log-record prefix remains recoverable. Stopping marks pending frontend admissions paused;
if stop races an already-started admission, the coordinator interrupts the late
admission before releasing the remaining queue.

A failed root Session retains all unclaimed inputs, paused, in its terminal log.
Only failed root Sessions may end with an entirely paused Inbox; other terminal
Session invariants remain unchanged. Explicitly resuming an item reopens the
Session, attaches its runtime and resumes that item. Process startup first repairs
committed claim intents, then durably pauses remaining root-session inputs. Merely
opening a conversation or replaying a receipt does not authorize consuming them.

Automatic model-request retry remains owned by the driver. Manual recovery uses
`agent_runtime_retry_model({ sessionId, turnId })`, only for the latest settled
turn whose final model failure is retryable. Configuration failures, pending
inputs, tool calls in that turn and uncertain effects block this operation.
The native boundary also enforces the recorded provider retry deadline.

The command joins the failed runtime and records a runtime-source recovery input
with the deterministic receipt `model-retry-{turnId}`. It starts a new turn using
the current session model selection and existing surface, including the original
text and image references. It does not duplicate the original user message or
rewrite the failed turn. Repeated commands acknowledge the same admission;
completed recovery receipts never authorize another generation. A subsequent
failed recovery turn has its own identity and can be retried separately.
If process startup pauses an unclaimed recovery input, the original failed
turn keeps its recovery action. An explicit click resumes only that durable
input and records `agent/inbox/item_resumed`; opening the conversation does
not resume it. The adapter dispatches this action even when an admission receipt
already exists, and confirms that the recovery is no longer paused.
Resuming an unclaimed recovery revalidates the latest failed turn and pending
work under the native store lock. An obsolete paused input cannot be resumed
after a newer turn begins. Consumed receipts remain idempotent acknowledgements.
The adapter waits for fresh recovery evidence independently of the IPC reply;
after 15 seconds it backfills events, with a further 3-second confirmation limit.
Stream errors in Chat Completions and Responses retain their typed provider
codes so temporary limits and terminal quota/policy errors have the same
recovery classification as HTTP errors.
Approval and question gates remain in force. Tool failure recovery requires
inspection and explicit follow-up rather than replaying tool calls.

Question answers retain their original operation ID and payload until a committed
`question/answered` receipt is visible. The client backfills the session after both
successful and failed answer IPC calls; a durable receipt acknowledges a lost
reply. A read-only status refresh never resubmits answers or bypasses recovery.
Cancelled, ended, obsolete and conflicting questions offer status refresh rather
than resubmission. Required recovery must be resolved before retrying. Explicit
answer-validation rejection permits editing only after successful state
reconciliation; unknown delivery and failed confirmation keep the answers frozen.
A successful read-only refresh that finds the same question pending preserves
its confirmed answer-validation rejection and the edit action.
The form retains a bounded, redacted diagnostic across panel remounts and provides
model settings for configuration or credential failures.

Validation covers the pure composer and admission coordinator, real native store
write/replay, claim-prefix recovery, native image admission, real WebKit IndexedDB
detach/acknowledge transactions, and Chromium rendering at wide/narrow widths.

Pre-step preparation diagnostics do not consume an Inbox item. If the prepared
input changes or admission stops before claiming it, `step/preparation_abandoned`
records the attempt's Turn/Step identity, original `inputMessageIds`, and the
reason (`inputChanged` or `stoppedByUser`). This event ends the preparation
attempt without starting or completing a conversation turn. It is idempotent
and leaves the Inbox and model Surface unchanged. Diagnostics and artifacts
remain in the durable audit log; abandoned attempts are excluded from chat.
`compaction-attempt` artifacts are shown in chat only after their turn is admitted.
