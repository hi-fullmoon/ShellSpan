# Operation history

TermBridge keeps a local, task-oriented timeline for critical operations. The timeline is designed for personal incident review and issue reports; it is not a new execution path and it is never uploaded by default.

## Coverage

The existing IPC and state-machine boundaries emit history events for:

- remote and local terminal session open/close, connection preflight, host-key trust/removal, and SFTP connect/disconnect;
- remote create, rename, delete, copy, cross-host copy, upload, download, permission changes, and the corresponding local file operations;
- port-forward start, stop, stop-all, failure, and retry;
- explicitly authorized remote-health collection, cancellation, timeout, failure, and result identity mismatch;
- Runbook step approval, rejection, pause/resume, skip, cancellation, retry, command result, exit code, target identity, and prior evidence references;
- multi-host batch/concurrency configuration, per-host status, circuit-breaking failures, cancellation, retry, identity mismatch, timeout, stale evidence, and aggregate partial success.

Interactive terminal input is intentionally excluded. TermBridge cannot reliably distinguish a password typed at a shell prompt from a command, so recording raw `write_session` data would violate the secret boundary. Terminal output, SFTP file contents, transfer payloads, remote-health raw command output, and Runbook stdout/stderr are also not stored in operation history.

## Stored event contract

Database schema v5 adds an append-only `operation_history_events` table. Each event contains only bounded, structured fields:

- event, task, operation, parent/retry, and optional Runbook item IDs;
- timestamp, category, action, event kind, status, and risk;
- explicit local or remote target identities (profile ID, host, port, username, session ID, and optional identity fingerprint);
- counts, exit code, batch position, concurrency limit, and stable error category;
- evidence references containing an operation ID, evidence kind, observation time, and optional digest;
- Runbook command previews that already passed the Runbook literal-secret policy and keychain substitution, with a second backend check before persistence.

For Runbook execution, the approval event stores the exact redacted command preview that the user reviewed, together with its approved risk and frozen target. The backend result must return the same command, risk, operation ID, run/task ID, profile, host, port, and username before it can be recorded as success. A mismatch is recorded as `identityMismatch`, and the untrusted returned command is not substituted for the reviewed command. Multi-host executions pin these approval and result events to the parent multi-host task while retaining the per-host operation ID.

There is deliberately no arbitrary arguments, detail, stdout, stderr, terminal input, file-content, environment, credential, private-key, or secret-value column. Unknown actions and fields are rejected. Suspicious command previews are replaced in full with `[REDACTED COMMAND]` rather than partially retained.

Writes are idempotent by event ID. A history write failure never authorizes or blocks the controlled operation and never changes its approval, cancellation, host-identity, risk, batch, concurrency, or circuit-breaker behavior. It is logged and shown as a visible warning so the missing audit evidence is not silent.

## Failure and recovery semantics

Failure, cancellation, timeout, unauthorized execution, identity mismatch, rejection, pause, skip, partial success, and retry are first-class statuses or event kinds. A retry records the original operation ID; subsequent execution still uses the existing safe-retry rules. Multi-host outcomes remain per-host, and an aggregate partial success is never presented as overall success.

Operation history is observational only. The UI can list, filter, inspect, export, configure retention, and clear records. It cannot execute a command, approve a Runbook step, cancel work, reconnect a host, or alter a remote target.

## Retention, clearing, and export

The default retention period is 90 days. The Operation history panel can select 7, 30, 90, or 365 days, or keep records indefinitely. Saving a shorter period immediately prunes expired events. One-click clear requires confirmation and deletes only history events; it does not delete profiles, Runbooks, credentials, or remote data.

Markdown and JSON exports are generated directly from the structured local records. Both formats declare that the content is redacted and local-only. Export never reads application logs or raw command output, and no cloud API is involved. A cancelled file dialog creates no file. A failed final write reports an error and removes the temporary export artifact.

## Review checklist

- Confirm database migrations create schema v5 without adding secret-bearing columns.
- Confirm interactive terminal input and raw output never reach a history request.
- Confirm result identity is checked for remote-health and Runbook results before success is recorded.
- Confirm every Runbook approval event carries the reviewed command and exact target, and command/risk mismatches fail closed.
- Confirm partial transfer and multi-host results remain partial.
- Confirm write failures are visible but cannot become an execution bypass.
- Confirm retention and clear affect only operation history.
- Confirm Markdown and JSON exports contain evidence IDs and redacted command previews but no supplied credential or raw output fixture.
