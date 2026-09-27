# File edits and complete shell scripts

## Diagnostic delegation

Model-facing spawn tools accept optional `requiredTools`. Before creating a child,
the runtime checks these tools against the delegated role/parent intersection and
the selected target's available tools. Missing tools fail without creating a child.
Existing callers omitting this field remain compatible. Explorer, diagnostician,
verifier and reviewer roles do not receive terminal execution; system collection
should run in the parent or an authorized operator child before diagnostic analysis.
Full access changes approval policy, not role tool availability or structured file
root/symlink restrictions. The model context reports the host OS only for local
targets; remote OS remains unknown until observed on that target. Agents must report
missing collection separately from host health and return missing capabilities to
their parent instead of repeatedly attempting blocked file paths. Parent takeover
is model guidance, not automatic execution or an expansion of authorization.

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

Durable JSONL events allow up to 512 KiB so JSON escaping of bounded write
arguments and exact-diff approval prompts fits. Provider replay still moves to
artifact storage at the existing 256 KiB inline threshold. Total session-log
and aggregate storage limits are unchanged.

`run_terminal_command` accepts complete multiline scripts and heredocs within
its existing 8192-byte command bound. LF, CR and tab are allowed; other control
characters remain invalid. Scripts containing LF, CR or tab always route to
`exec_command`, including bound-terminal sessions. `terminal_execute` still
rejects all control characters: script lines are never pasted into a live PTY.

Direct execution uses the frozen host, not mutable visible shell state. Local
execution uses the frozen cwd when configured and the existing `/bin/sh -lc`
(PowerShell on Windows). Remote execution uses the existing credential-backed
SSH process path and the account's default directory; scripts needing a specific
directory must use an explicit `cd` or absolute paths.
Shell syntax must match the target executor. No fallback to live-terminal input
occurs if Direct execution is unavailable. Native process handles, timeout,
cancellation, output capture, secret redaction and exit status apply as before.

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
system resources and local ShellSpan application storage are denied. Literal
system-deletion/formatting commands are rejected where recognized; complex
scripts are not proven safe by this check; operator nevertheless auto-authorizes
them as requested by the user.

The destructive-command guard uses tree-sitter syntax plus shlex word decoding,
including static single/double quotes, concatenation and escapes. It follows
resolvable `cd` changes through sequences, `&&`, `||` and branches, keeps subshell
and pipeline cwd changes local, and normalizes `.`/`..` before checking delete
targets. Unrelated dynamic arguments do not suppress checks on known targets.
The scan has explicit depth and cwd-state limits. It does not execute expansions,
resolve arbitrary variable values or provide a general shell sandbox.

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
remote targets, changed digests and protected system files are rejected. The
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
