# User questions and manual operations

`ask_user_question` collects non-sensitive decisions and information. Options are
optional; free text is supported. A selection is not missing text, an operation
completion, a credential, or a native tool approval. Passwords, private keys,
API keys, tokens and recovery codes must never be requested through this tool
or ordinary chat. `input_kind`, when supplied, accepts only `non_sensitive`.
The Agent has no generic password-entry or sudo credential tool. Existing native
credential-backed capabilities remain authoritative. When no suitable secure
operation is supplied, hand the sensitive operation to the user instead of
collecting a secret or constructing a password-bearing command/script.

## Decisions

Use a stable `decision_key` and `decision_context` together for recurring
decisions. The context describes the target, account and relevant prerequisites.
Within the same turn, the runtime reuses a completed decision only when the
identities, contexts, option definitions and selection modes match.
The wording and call-local question IDs may change; reused answers are mapped to
the new IDs. No semantic text matching is performed. Changes to the
conditions require an updated context. Decisions are not automatically reused
across turns. Pending, cancelled and action-bearing answers are not reused.
Fresh human instructions or an explicit change-plan response invalidate earlier
decision reuse so a user can change their mind within the same turn.
Recovery fills an interrupted reusable request from its earlier committed answer.

## Manual operations

An option may declare `user_action: { instructions, verification_command }`.
Such a request contains exactly one single-select question. Selection is committed
as `question/answered`, but the tool remains unresolved and the question remains
pending until its manual operation is settled. This transition needs no additional
model request. The existing card displays the instructions, verification command,
and localized completion, change-plan and cancel controls. It has no text field.

`request_user_action` requests standalone manual work with `id`, optional `title`, `instructions`
and `verification_command`. It uses the same durable question barrier and
recovery path; its normalized question has `user_action` and no options.

An answer submission may include `action`, one of `completed`, `change_plan`
or `cancelled`. For a selected option, this second submission must preserve the
committed question answers exactly and emits `question/action_answered`. A
standalone operation submits an empty answer list and its explicit action through
`question/answered`. Both phases have independent operation IDs and fingerprints.
Retries acknowledge the committed phase without applying it again; conflicting,
stale and cancelled submissions cannot replace an earlier decision. An interrupted
task cancels an unfinished manual operation even if its selection was answered.

## Execution and verification

Pending interactions pause the driver and block tool admission, including the
remainder of the original assistant tool batch. Waiting never starts polling or a
sleep loop. Native dispatch rechecks the gate after approval/recovery as well.
After a structured decision, speculative calls remaining in that original batch
are rejected without execution; a fresh model step must use the actual choice.
This also applies when the user selects an alternative or types a custom plan.

Completion permits only the exact declared verification command, submitted alone
to `run_terminal_command` in the foreground. The command retains normal native
classification, approval, cancellation and redaction checks. If it returns a
process handle, only `wait_process` for that handle may observe its completion.
Dependent tools remain blocked until a committed native result confirms exit
code zero. A failed verification cannot be retried in a polling loop; request
fresh user work while preserving the selected plan. Verification evidence is
scoped to the confirmed operation and cannot predate completion. Asking an
unrelated question cannot clear an outstanding verification requirement.

Cancel or change-plan responses never execute the original dependent queue.
Changing the plan requires another explicit decision (with decision identity)
or a new manual operation. Cancellation blocks dependent work for that turn.
A later human turn establishes new task scope rather than inheriting authority
from a cancelled operation. Status, answers and fingerprints are derived from
committed events, including after process restart. Existing logs that lack the
new optional fields retain their original question behavior.

The schema restricts supported input kinds; model instructions prohibit requests
for secrets. Arbitrary natural-language questions and accidentally pasted secrets
cannot be exhaustively identified by an enum or keyword filter. The native
credential boundary and existing redaction must remain independent protections.
