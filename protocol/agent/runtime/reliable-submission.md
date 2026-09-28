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

An IPC reply timeout is **confirming**, not failed. The adapter backfills committed
events independently of the pending command and can acknowledge a lost reply.
Failure to read the receipt is not evidence that admission failed. A definitive
rejection holds subsequent admissions until the original operation is retried;
its content is retained separately from the current editor draft. Admission
acknowledgement does not imply model completion. Only native acknowledgement
promises text-message durability across process exit. Detached image bytes and
operation identity are also retained in IndexedDB until native acknowledgement.

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

Model-request retry and recovery remain owned by the driver. Frontend admission
does not retry a model generation or a tool call. Approval and question gates
remain in force; ordinary messages can queue while those gates are waiting.

Validation covers the pure composer and admission coordinator, real native store
write/replay, claim-prefix recovery, native image admission, real WebKit IndexedDB
detach/acknowledge transactions, and Chromium rendering at wide/narrow widths.
