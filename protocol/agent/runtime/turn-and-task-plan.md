# Agent turn and task-plan contract

Status: implemented runtime contract.

## Turn limits

Primary Agent turns have a 128-step default soft boundary in addition to cancellation, session token and active-time budgets, model-stream deadlines, request retry policy, and the no-progress detector. Reaching the boundary records `stepBudgetReached`, closes the open step and turn, and returns the Session to idle without a terminal failure. The conversation renders the reason explicitly and offers a continuation action; queued user input may also start a fresh turn against the same durable Session.

Subagents retain their explicit hard `maxStepsPerTurn` budget. Reaching a delegated budget records `stepLimitExceeded` and fails that bounded child settlement so the parent receives explicit partial-work evidence.

## Task-plan writes

`update_plan` is a whole-list replacement for the current turn's task plan:

- `steps` is required and replaces the preceding list.
- `planVersion` is optional for model callers. The runtime assigns the next monotonic version; if the caller supplies `planVersion`, it acts as a concurrency guard and must equal that next version.
- Models should keep an `inProgress` step while work remains and update completed, blocked, or failed steps as soon as their state changes.
- A successful tool result reports the assigned version and counts for every plan status.

The latest plan remains visible after `turn/end`. The UI derives an `inProgress` row as paused whenever its Session is idle, so unfinished work stays visible without displaying a stale spinner. The next `turn/start` clears the preceding projection until the new turn records its own plan. Durable `task/plan` events remain in Activity history for audit and replay.
