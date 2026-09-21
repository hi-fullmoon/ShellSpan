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
requires approval in scoped-autopilot mode; full-access operator mode retains
its existing permissions. Parsing is not a sandbox or proof of safe execution.
