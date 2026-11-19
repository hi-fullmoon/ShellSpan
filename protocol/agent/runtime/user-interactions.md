# User interactions

## Links in assistant responses

Use a complete HTTP or HTTPS URL for a web link destination. The label may be a
route such as `/todo/`. Render a route whose full URL is unknown as inline code.
The client initially offers to copy an absolute path formatted as standalone
inline code. It offers file actions after a metadata check confirms a file or
directory, using the connected terminal's SFTP route for remote paths and the
local filesystem for local paths.

## Command approval and sandbox scope

The approval card derives the sandbox message from the committed native call.
A recognized sandbox executor and policy binding on a matching Direct target
describe the restrictions for that approval. A command without such a binding
retains the ordinary account-permission warning. The invocation result carries
the evidence of whether a sandboxed process actually started.

The macOS local sandbox preview accepts foreground Direct commands. Local terminal
sessions reject visible execution when created or switched. The launcher remains
behind its startup gate until the process group is durable, the Agent admits
dispatch, and the process handle is registered. The handle stays active until
the process group terminates.

## User questions

`ask_user_question` collects non-sensitive decisions and information. Options are
optional; free text is supported. A selection is not missing text, an operation
completion, a credential, or a native tool approval. Passwords, private keys,
API keys, tokens and recovery codes must never be requested through this tool
or ordinary chat. `input_kind`, when supplied, accepts only `non_sensitive`.
Existing native credential-backed capabilities remain authoritative. When no
suitable secure operation is supplied, hand the sensitive operation to the user.

## Approved remote sudo

`run_terminal_command` accepts `sudoOperationId` for a frozen remote SSH
target with a credential-backed profile and explicitly configured operations.
The administrator of the saved connection manages named operations in the
connection editor. Each operation defines an absolute executable path and
fixed literal arguments. ShellSpan offers the current profile's operation IDs
to the model. The model supplies an ID, an explanation and optionally a timeout.
The approval card displays the target account and exact resolved command.
Every elevated call requires explicit human approval, including in full-access
mode. Ordinary Agent shell calls reject explicit privilege tool invocations.
Dependent steps must wait for a confirmed successful exit.

Policies start empty, are local to the saved connection, and are revoked when
the profile's connection identity changes. Every policy edit replaces its
revision. The runtime checks the revision before approval and before prompting
for the dedicated account's credential. It serializes the durable dispatch
journal and each nonblocking authorization-frame write with local policy
updates. A policy edit completed before the first admitted write prevents
dispatch. Once a write has been admitted, an unconfirmed outcome is uncertain.

The managed connection requires an independent restricted SSH service on the
same host, with a different port and dedicated account. The runtime checks its
administrator-supplied host key fingerprint before prompting. Passwords go to
SSH user authentication before any remote session channel opens. The runtime
then opens only the `shellspan-sudo-v1` subsystem. It does not invoke a general
SSH exec command or use the ordinary connection's credentials on this path.
If the saved connection uses a jump host, the runtime reuses that profile's
jump settings and known-host policy solely for the outer TCP tunnel. The
runner's host key is checked independently inside the tunnel. A jump failure
does not cause a direct connection or a password prompt.

The administrator-installed subsystem checks the requested operation against a
root-owned policy and validates ownership of the job and its declared inputs.
It revalidates their contents before dispatch and calls `sudo -n` for the exact
job and arguments using closed stdin. A regular Agent shell, file, or process
call cannot use the managed connection or the runner identity. The remote
administrator must keep ordinary accounts unprivileged and protect the
runner and job dependencies. See [runner deployment](../../../docs/remote-sudo-runner.md).

The result includes redacted stdout/stderr and a confirmed exit status. A
signal exit is a failure. Cancellation before dispatch prevents the command
from starting. A timeout, disconnect, or cancellation after dispatch without
a confirmed exit enters the existing uncertain-execution workflow, which
requires reconciliation before further writes. Approvals without a durable
dispatch journal are cancelled on restart. A host that refuses noninteractive
sudo for the exact restricted job returns that failure and keeps its policy.

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

For a bound terminal, requesting a standalone action or selecting an option
with `user_action` returns keyboard and paste input to the user on that
terminal. The original turn and its plan stay open. ShellSpan keeps the turn's
reservation, so another Agent or a delegate cannot acquire the same terminal
during the handoff. ShellSpan can release the same Agent's interactive lease
at a verified prompt once the shell has confirmed the submitted line and its
completion. Keystrokes and prompts without a matching command receipt leave the
handoff blocked, with the task available to choose another plan. Ordinary
questions and unselected options keep the existing input ownership.

After finishing, the user chooses Continue verification. ShellSpan reclaims
input as part of committing the action response, before the driver can
continue. Existing terminal readiness checks still apply to verification.
Opening the terminal view again restores the pending handoff and current
formatted screen from the same live transport generation. The renderer
subscribes before reading the display snapshot, applies live output after the
snapshot cursor, and waits for the terminal to parse the result before
accepting input. Completion, stop, and transport-close events invalidate a
handoff snapshot still in transit. The display snapshot is in memory and is
provided to the terminal renderer only.

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

Stopping closes native tool admission and signals native cancellation for the
parent and its descendants before joining their workers. A stopped turn settles
its outstanding approval even when only the journal is available. An approval
decision keeps the model driver waiting until the remaining tool batch settles
or reaches another interaction. A running one-shot child can receive approval
decisions through its own conversation.

After restart, approving checks the original identity, expiry, target and
current policy before dispatch. Rejecting records the decision before attempting
to restore the model. Unstarted calls following a rejection or expiry settled
from the journal are closed without execution so continuation can make a fresh
model request. Opening the conversation only reads its history. Approvals that
require a fresh request after restart stay subject to that rule.

Completion permits only the exact declared verification command, submitted alone
to `run_terminal_command` in the foreground. The command retains normal native
classification, approval, cancellation and redaction checks. If it returns a
process handle, only `wait_process` for that handle may observe its completion.
Dependent tools remain blocked until a committed native result confirms exit
code zero. A frontend rejection for pending input or an unverified submission
permits one fresh verification call if the native result confirms that execution
did not start. A second rejection or a failed verification requires fresh user
work while preserving the selected plan. Verification evidence is
scoped to the confirmed operation and cannot predate completion. Asking an
unrelated question cannot clear an outstanding verification requirement.
An explicit refusal on the approval card ends verification for that action.
Preparation rejections do not count as a user decision.
A text-only response ends the turn as incomplete while the user action or its
verification remains unresolved, even without a recorded task plan.

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
