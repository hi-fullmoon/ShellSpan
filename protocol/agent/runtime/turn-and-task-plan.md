# Agent turn and task-plan contract

Status: implemented runtime contract.

## Turn limits

Primary Agent turns have a 128-step default soft boundary in addition to cancellation, session token and active-time budgets, model-stream deadlines, request retry policy, and the no-progress detector. Reaching the boundary records `stepBudgetReached`, closes the open step and turn, and returns the Session to idle without a terminal failure. The conversation renders the reason explicitly and offers a continuation action; queued user input may also start a fresh turn against the same durable Session.

Continuable subagents use their explicit `maxStepsPerTurn` as a recoverable turn boundary: reaching it records `stepBudgetReached`, preserves the Session and returns it to idle. The orchestration result explicitly marks `partial: true`, includes the stop reason and latest plan, and reports whether cumulative turn, tool, token and time budgets permit `send_child_input` against the same Session. The orchestration tool completing does not mean the child task completed. Continuation does not reset cumulative budgets, and exhausted children reject further input before being woken. The parent decides whether saved progress warrants continuation; it must not spawn replacements to bypass budgets.

Each child model request includes its current per-turn step count and asks for verification and a partial-work handoff near the limit. One-shot children retain their hard single-turn contract (`stepLimitExceeded`); their settlements also include partial-progress metadata. Use continuable children for implementation, debugging, and other multi-stage tasks.

## Model output limit

When a model response ends with `length` or the provider returns `OUTPUT_LIMIT`, the runtime records available partial text and reasoning as an interrupted assistant message and discards any unfinished tool calls without executing them. Completed responses also record usage; provider errors retain their request failure evidence. The runtime adds a continuation instruction and starts another step in the same turn. At most two automatic continuation steps are allowed per turn. A third output-limit stop preserves available partial content and fails the Session with `outputLimit`; the UI shows a concise error and does not offer a separate continuation button. Cancellation and the existing turn and task budgets still apply to each step.

## Task-plan writes

`update_plan` is a whole-list replacement for the current turn's task plan:

- `steps` is required and replaces the preceding list.
- `planVersion` is optional for model callers. The runtime assigns the next monotonic version; if the caller supplies `planVersion`, it acts as a concurrency guard and must equal that next version.
- Models should keep an `inProgress` step while work remains and update completed, blocked, or failed steps as soon as their state changes.
- A successful tool result reports the assigned version and counts for every plan status.

A final response triggers one completion check only when the current turn's latest plan still contains `pending` or `inProgress` work. If the remaining steps are `blocked` or `failed`, the runtime ends the turn as `incomplete` and releases the terminal turn guard without forcing another attempt. Such steps remain visible and are never reported as completed.

Ephemeral input placeholders in model history describe omitted content, not executable input. Model requests explicitly explain that historical input was omitted and new input is not replaced. Native tool preparation rejects these markers in terminal input, process input, terminal match text, and commands (including the native command name) before authorization or dispatch. The model must inspect current state and supply actual input or explain why it cannot proceed.

The latest plan remains visible after `turn/end`. The UI derives an `inProgress` row as paused whenever its Session is idle, so unfinished work stays visible without displaying a stale spinner. The next `turn/start` clears the preceding projection until the new turn records its own plan. Durable `task/plan` events remain in Activity history for audit and replay.
