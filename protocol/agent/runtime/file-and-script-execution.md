# File edits and complete shell scripts

## Diagnostic delegation

Model-facing spawn tools accept optional `requiredTools`. Before creating a child,
the runtime checks these tools against the delegated role/parent intersection and
the selected target's available tools. Missing tools fail without creating a child.
Existing callers omitting this field remain compatible. Explorer, diagnostician,
verifier and reviewer roles do not receive terminal execution; system collection
should run in the parent or an authorized operator child before diagnostic analysis.
Spawn parameter descriptions list role tools from the same allowlists used by
native delegation, preserving the existing flat schema for provider compatibility.
File-only review should use structured reads; even read-only shell commands such
as `rg`, `wc` and `git log` require `run_terminal_command` and
a `general` or `operator` child. Parent/target checks remain authoritative for
all providers. A rejected combination creates no child and must be corrected
before reusing it across a batch; roles are never upgraded
automatically and required tools are never silently dropped.
Full access changes approval policy, not role tool availability or structured file
root/symlink restrictions. The model context reports the host OS only for local
targets; remote OS remains unknown until observed on that target. Agents must report
missing collection separately from host health and return missing capabilities to
their parent instead of repeatedly attempting blocked file paths. Parent takeover
is model guidance, not automatic execution or an expansion of authorization.

## Managed temporary execution files

The existing model-facing `read_file`, `list_directory`, `search_text`,
`write_file`, `edit_file` and `apply_patch` tools accept optional
`fileScope: "workspace" | "scratch"`. The default remains `workspace`.
`scratch` selects a native-owned file target, never an arbitrary extra root.
Without a frozen project root, these tools are restricted to an explicitly
required `fileScope: "scratch"`. Remote file tools still require a credential-backed
profile. Role, tool, approval and uncertain-execution gates remain authoritative.
The adapter removes this facade field before native argument validation and
retains it in recorded calls so approval reconstruction cannot switch roots.

Local files live under
`{dataRoot}/tmp/{shortId}`, where `shortId` is the first 16 hexadecimal characters
of the session/initial-target SHA-256 digest. The immutable `session/created`
target supplies this storage identity. A verified terminal reconnect updates
the live execution target and resets approval; it preserves this original
scratch identity, file paths and process pins. The current header must still
match the request, and only transport/target IDs may differ from the storage
owner: login, credentials and file/project roots cannot change this way.
The native file target still uses the current transport and its normal live
identity checks; a storage record never proves that a connection is available.
Ownership records and native target IDs keep
the complete digest. A conflicting reservation or an occupied directory without
a matching ownership record is rejected; files are never adopted or overwritten.
`dataRoot` keeps the existing development/production/custom-root separation.
Ownership records and the random installation identity stay in
`{dataRoot}/agent-runtime/scratch`, outside the writable file root. No legacy
workspace paths are read or migrated. Native storage protection admits only the
exact registered root for the owning session, with ordinary no-follow, digest
and dispatch validation.
Credential-backed remote files use
`{accountHome}/.shellspan-agent-scratch-{installationId}/{sessionTargetDigest}/files`.
SFTP resolves the account home and checks private directory ownership. Managed
directories may be allocated during preparation; script contents are written only
after the existing approval gate. Targets without SFTP credentials do not receive
this capability. Native shell execution is not a fallback for scratch provisioning.

File results add `fileScope: "scratch"`, `scratchRoot` and `temporary: true` at the
model facade, without changing the native v3 argument schemas. The model uses the
returned absolute path with `run_terminal_command`. Script location does not
change command cwd, visible-shell environment or the selected execution surface.
Local `write_file` and `read_file` results expose the portable absolute path
format. On Windows this removes the internal `\\?\` canonical-path prefix and
uses forward slashes, so the returned path can be passed directly to PowerShell
script authorization. Canonical paths remain in filesystem validation, I/O and
checkpoints; remote POSIX paths are returned unchanged.
Workspace-scope file tools reject access to either managed local tree with
`AGENT_SCRATCH_SCOPE_DENIED` before approval or dispatch. Storage-policy checks
resolve local paths and their nearest existing ancestors, so portable Windows
paths and canonical paths receive the same ownership protection. This does not
rewrite the proposed arguments or expand the owning session's registered root.
Intermediate outputs and interpreter caches should be directed into scratch when
supported. Relative imports may require explicit dependency configuration. Saved
project source and deliverables still use workspace tools. This is cooperative
file organization, not a process sandbox or a restriction on arbitrary shell writes.

Approval leases and executing markers are persisted before dispatch. Every
command in an eligible session participates, so collection does not need to parse
shell text to discover script references. Background handles pin the workspace;
authoritative process/job observations release them only after confirmed terminal
state. Direct results now include optional `terminationConfirmed`. Cancellation
also preserves references to Direct processes long enough to inspect their real
termination result. An exception after dispatch, unconfirmed remote termination,
or a process lost across restart leaves a persistent pin. Missing handles or a
closed/archived chat never prove termination and never trigger command replay.

New process pins use ownership-record version 2 and carry their actual
`executionTarget`. Maintenance validates that target against the immutable
storage scope, then uses its complete execution identity to confirm termination.
Version-1 records remain readable; old process pins without this field use their
original record target and remain pinned if authoritative state is unavailable.
An existing record advances to version 2 when a new process pin is stored; file
operations and foreground completion alone do not rewrite it as a new version.
Unknown versions or a process target outside the owning host/file scope fail
closed. Older runtimes that only understand version 1 must reject version 2;
they must not reinterpret, clear or replay its process pins.

Unused workspaces have a 24-hour retention period, extended to 7 days after a
failure, nonzero exit or cancellation. Cleanup runs on startup, hourly, and before
scratch mutations. Mutation admission checks actual bounded tree sizes against
64 MiB per session, 512 MiB total local storage and 256 MiB per remote account and
installation. These are admission limits, not filesystem quotas. Observation and
process control are not blocked by a full scratch workspace. Live approvals,
executing operations and uncertain uses cannot be evicted to satisfy capacity.

Collection and lease acquisition share one registry lock. Local collection uses
the system trash and never purges it. Remote collection uses SFTP unlink/rmdir
only inside the validated owned workspace; symlinks, special files, ownership
changes, bounded-inspection failures or disconnection defer collection. A later
maintenance pass retries eligible collection, never execution. Session events,
redacted output artifacts and file checkpoints keep their existing retention and
are not removed by scratch collection. Expired script files must be recreated,
not automatically rerun. There is no claim of protection against hostile same-user
path replacement or unregistered detached processes.

The local scratch regression executes real scripts through Direct and the
accepted native GNU Bash transport. Build its source-verified shell/module with
`python3 -B scripts/native-input-p2/build.py --versions 5.3`, then run
`cargo test --manifest-path src-tauri/Cargo.toml --lib scratch`.
The fixture requires the real native handshake; it does not grant capabilities
to a legacy shell or change editor admission policy. Remote SFTP coverage remains
an explicitly opted-in integration test.

## File and script limits

`write_file` accepts up to 128 KiB (131072 UTF-8 bytes). This is a native safety
ceiling, not a generation target; the current model output budget still applies.
`edit_file` retains its 32 KiB per-string ceiling. Existing files should normally
be changed through digest-bound `apply_patch` or `edit_file` calls. Large new
files can be built with an initial write followed by focused patches. The patch
format remains standard unified diff parsed by diffy, not Codex's custom syntax.

Write validation distinguishes `content_too_large` (actual and maximum UTF-8
bytes) from `invalid_control_character` (code point and byte offset). Both report
that no file changed and describe recovery. LF, CR and tab are valid file text.
The 240 KiB exact-diff bound remains enforced before committing, with an explicit
`diff_too_large` error and incremental-edit guidance. Creation preconditions,
digest checks, checkpoints, atomic replacement, cancellation and read-back
verification remain mandatory.

The model-facing `write_file.precondition` schema exposes both fields directly
and retains the exclusive creation/digest alternatives. `mustNotExist` explicitly
has JSON boolean type and constant `true`. Missing preconditions and string-valued
`mustNotExist` return specific correction guidance without echoing file content
or argument values. Native validation never coerces strings or supplies a missing
precondition; rejected calls still change no files.

Durable JSONL events allow up to 512 KiB so JSON escaping of bounded write
arguments and exact-diff approval prompts fits. Provider replay still moves to
artifact storage at the existing 256 KiB inline threshold. Total session-log
and aggregate storage limits are unchanged.

`run_terminal_command` accepts complete multiline scripts and heredocs within
its existing 8192-byte command bound. LF, CR and tab are allowed; other control
characters remain invalid. These scripts use `exec_command` only in explicitly
selected Direct sessions. Bound-terminal sessions use the same current-shell
native editor for complete scripts, LF, CR and Tab when advertised by the shell
integration; unsupported editors are rejected before input. They never silently
route to Direct. See [native input](native-input.md) for the input contract and
the [acceptance checklist](../../../docs/design/agent-terminal-input-acceptance-checklist.md)
for the pending shell matrix. CR is preserved literally, including in CRLF; no
newline normalization changes approved bytes or native shell semantics.

Direct execution uses the frozen host, not mutable visible shell state. Local
execution uses the frozen cwd when configured and the existing `/bin/sh -lc`
(PowerShell on Windows). Remote execution uses the existing credential-backed
SSH process path and the account's default directory; scripts needing a specific
directory must use an explicit `cd` or absolute paths.
Shell syntax must match the target executor. No fallback to live-terminal input
occurs if Direct execution is unavailable. Native process handles, timeout,
cancellation, output capture, secret redaction and exit status apply as before.

Local Direct stdin uses Tokio's asynchronous child-pipe interface. Partial writes retain
their exact byte offset, and a full pipe never prevents the process worker from
observing cancellation or its execution deadline. Each stdin request has a
five-second write deadline; an incomplete write reports the accepted byte count
and terminates the local process tree before settling as failed. This also
unblocks any Windows pipe write already accepted by Tokio's I/O pool. The write
is never silently retried. A task cancellation retains any process handle still
reported as running and returns an error instead of
discarding that handle.

Approval dispatch revalidates file preconditions and native policy. A failed
pre-dispatch check durably cancels the approval and its tool result, without a
dispatch marker or file change, then continues the remaining ordered queue.
If recording that outcome fails, the original pending decision remains
retryable. A dispatched call is never restored as an unexecuted approval.

In bound-terminal sessions, a child inherits the same execution surface and
permission mode. Turn admission accepts descendants verified against the
committed Session lineage and the identical frozen terminal target. The original
turn owner remains reserved while a descendant uses the terminal; unrelated
Agents and user input remain excluded. Each command lease still belongs to one
specific Agent, task and operation. Finishing a child turn only removes its
delegation. User takeover of a descendant's command revokes the entire active
turn's admission, including its parent and other delegated descendants, until
their turns end. No delegation silently switches to Direct execution.
The terminal UI's interruption request for a taken-over child is routed to its
verified owning root, stopping the entire delegation. Without a takeover marker,
human interruption continues to require a root Session.

For effect inspection, tree-sitter-bash recognizes literal linear command chains
joined by newline, `;`, `&&`, `||` or `|`. Each command is classified and the
strongest effect wins. Inspection never rewrites or separately executes commands.
Redirections, substitutions, assignments, quotes, globs, control flow, comments
and parser errors do not qualify for this narrow splitting. Complex multiline
programs are treated as whole shell invocations with an external-side-effect
classification, preserving destructive classification where identified. This
requires approval outside full-access operator mode. Operator retains its original
no-per-call-approval behavior for shell execution, terminal/process input and MCP
calls. Parsing is not a sandbox or proof of safe execution. Observing
or stopping an owned process does not require a second approval; ownership and
capability checks still apply.

## Execution safety, first release

### Automatic review in “Approve for me”

`scopedAutopilot` runs deterministic native review after target, tool, capability
scope and deny-rule validation. `read_file`, `list_directory` and `search_text`
within a frozen root may run automatically when no known sensitive or protected
path is involved. Remote structured reads also require a credential-backed
profile. Existing scoped readers retain their path, symlink and size checks;
recursive search omits known sensitive paths. No model explanation grants access.

`read_file` uses byte offsets and byte limits. UTF-8 pages end at a complete
character, so `readBytes` may be smaller than the requested `maxBytes`. When
`truncated` is true, continue with the returned `nextOffset`; do not add the
requested page size to the previous offset. An offset inside a UTF-8 character
is rejected with a valid restart offset. A page too small for the next character
is rejected with guidance to increase or omit `maxBytes`. Invalid UTF-8 files
remain errors; binary reads through `base64` retain exact byte ranges.

On macOS/Linux, a single literal local Direct `pwd`, `uname`, `ls`, `cat`, `head`
or `tail` can be auto-approved with the supported argument subset. `ls` permits
non-recursive `a/l/h/A/1/n` flags and at most one directory. `uname` permits
`-a/-s/-r/-m`; `pwd` takes no options. `cat` takes one ordinary file; `head` and
`tail` also allow `-n` with 1–1000 lines. Read files are regular, at most 1 MiB.
No elevation, background execution, pipelines, expansions, redirection,
wrappers, caller executables, unsupported flags or unknown command semantics
are auto-approved. Quotes currently require manual review; the model may use a
structured file tool for paths containing spaces. No automatic channel switch
occurs for a visible-terminal session.

An auto-approved command uses a root-owned system executable, a cleared
environment, descriptor-relative no-follow file/directory opens, pinned cwd and
file stdin. It never uses a login or interactive shell. The native-only plan is
bound to the existing single-use, expiring, digest-checked capability. Dispatch
revalidates the frozen root identity and the scoped handles. Failure returns
`AUTO_REVIEW_CHANGED` without an ordinary-shell fallback. Execution retains
output limits, process ownership, cancellation and a maximum 30-second timeout.
Successful dispatch results include `approvalReview: "boundedLocalRead"`; this
field is output-only and cannot be submitted as a tool argument.

Deletion (including trash), writes, privilege changes, sensitive paths, unknown
scope, remote shell, terminal/process input and MCP calls still require human
review in this mode. MCP read-only labels alone do not establish a resource
boundary. Windows currently auto-reviews structured reads only. This is a
bounded read executor, not a general-purpose process sandbox or a guarantee that
an innocuously named file contains no secrets. It trusts the system executables
and OS; ordinary structured reads retain their existing runtime boundaries.

`requestApproval` still asks before reads; `operator` / `fullAccess` keeps its
original automatic execution through the normal shell. Neither mode is silently
rerouted into this reviewer. Waiting for or stopping an owned process retains
the existing no-extra-approval behavior.

### Full access and recoverable deletion

The stored `operator` / `fullAccess` values retain their original full-access
approval semantics and UI name. Operator skips per-call approval, including for
sensitive file operations. Other modes keep their approval rules. Native deny
rules still apply in every mode. Structured writes to protected
system resources (except concrete resources deleted through `trash_file`) and
local ShellSpan application storage are denied. Deleting concrete application
resources such as `/usr/local/bin/mihomo` or `/etc/systemd/system/mihomo.service`
uses normal approval: request-approval and automatic modes require approval,
while Full access auto-authorizes. Recognized deletion of whole protected system
trees, kernel resources and formatting commands remains denied in every mode; complex
scripts are not proven safe by this check; operator nevertheless auto-authorizes
them as requested by the user.

The destructive-command guard uses tree-sitter syntax plus shlex word decoding,
including static single/double quotes, concatenation and escapes. It follows
resolvable `cd` changes through sequences, `&&`, `||` and branches, keeps subshell
and pipeline cwd changes local, and normalizes `.`/`..` before checking delete
targets. Unrelated dynamic arguments do not suppress checks on known targets.
The scan has explicit depth and cwd-state limits. It does not execute expansions,
resolve arbitrary variable values or provide a general shell sandbox.

Whole-tree protection includes `/usr/libexec`, `/usr/local/libexec`, `/lib`
and `/lib64`. The OS-owned `/System` namespace is protected recursively,
including `/System/Volumes`. The fixed macOS `/private/etc` and `/private/var`
aliases use the same delete policy as `/etc` and `/var`; concrete application
resources beneath those aliases still follow the session permission mode.

Local structured-file review and execution share the same no-follow root-chain
validation. A symlink ancestor is rejected before approval and rechecked during
execution; canonicalization must not erase a user-controlled alias into a
sensitive directory. Only macOS's verified OS aliases `/var`, `/tmp` and `/etc`
map to their fixed `/private` counterparts, with all descendants checked normally.
An unsafe root produces `AGENT_UNSAFE_FILE_ROOT` without reading file contents.

Transfer policy resolves local paths against `localRoot` and remote paths against
`rootPath` according to direction. Both endpoints contribute to sensitive-read
classification, but only the destination is subject to critical-write denial.
This applies to creation as well as overwrite, and to uploads as well as downloads.
Reading a protected source for a backup does not itself become a protected write.

`trash_file` is an additive native v3 tool, offered only with a frozen local file
root and appropriate role capability. Arguments are exactly `{path,
expectedSha256}`. Use `read_file` with `metadataOnly` first. The file must be a
regular file within that root, at most 64 MiB; directories, symlink traversal,
remote targets, changed digests, kernel resources and ShellSpan application
storage are rejected. Concrete system-directory files use normal approval. The
digest and path are rechecked before dispatch to the platform trash API. The
result is `{path, trashed: true, recovery: "systemTrash"}` only after success.
Operator may automatically trash a file; other modes approve
this destructive operation once. A call remains single-use and non-retryable.

Recovery is manual through the OS trash. On macOS the existing trash dependency
uses NSFileManager for this Agent tool, avoiding a separate Finder automation
permission prompt; Finder's “Put Back” is not guaranteed, so the UI does not
promise it. There is no permanent-delete fallback, automatic purge or in-app
undo. Cancellation stops before the OS call; an in-progress OS trash call cannot
be interrupted. Errors require inspecting both source and trash before retrying.

This release does not provide a production process sandbox, remote executor,
batch/directory trash plans or atomic protection against hostile concurrent
path replacement. Platform trash APIs are path-based; checks do not establish
an OS-enforced filesystem boundary. Arbitrary approved shell programs can still
delete data permanently, including outside the working directory. Existing
structured-edit checkpoints do not back up arbitrary shell side effects.
