# Stage 6D — path-only @file completion

Worktree `/Users/zhengbiwen/.codex/worktrees/6461/ShellSpan`, HEAD/base
`31ce4343b9a834503c43db1b04b81fe0128e4ea0`. No commit, push, merge or main edit.
The Harness checkout is a read-only reference. Final Stage 7 and Windows native
validation remain separate work.

## Complete 6C reception

The source `/Users/zhengbiwen/.codex/worktrees/23d3/ShellSpan` has the same HEAD.
Before edits, verified its inventory SHA-256
`2066a1486074e3276ebcf22387ce5f0a6e1267d6261d990ddc0a87deae1ccccf` and stage patch
`b2494e61103bf98a4a8a70bff61db3a6615ea4181b4f5d3bf3e4e47fab65c099`.
Applied the tracked patch after `git apply --check`, copied all **52** untracked
product files, retained all 6A/6B/6C delivery metadata, and checked all **143**
cumulative source hashes. No migration conflicts or exceptions. The 6C migration
exceptions remain historical metadata, with main request/start and system-prompt
snapshot deduplication retained. Lock/workspace files and the user-owned main
input-group style were not edited.

Reception gates passed before 6D implementation: 6A frontend, full 6B including
real SSH and controller bridge, and full 6C including browser/HTTP/pixel/restart.

## Production path

`agent_runtime_list_file_references` accepts only Session ID, UUID request ID and
query. It delegates to `FileReferenceRuntime`, resolves the stored Session header,
checks its read-only target capability, and calls the native provider. The renderer
cannot supply a second filesystem root, command, URL or content-read operation.
`agent_runtime_cancel_file_references` addresses exactly one Session/query UUID.
The frontend chain is Tauri wrapper → Agent adapter → Session controller →
`AiComposerSeat` / `useFileCompletion`.

New conversations use the existing `AiProjectDirectoryInput`: explicit absolute
local `cwd` or remote `rootPath` is frozen through normal Session creation. The
same pending Session is shared by `/skill`, @file and eventual text/image submit.
Selecting an image still creates only a durable draft. All six permutations of
image/skill/file and a text-only path submission use the correct root. Recovered
Sessions use their stored target and show that target's host/label/root; terminal
prompts, process cwd, home and SFTP browsing are never consulted. An old rootless
Session gets actionable feedback to start a new conversation.

The first successful scope observation records `file_reference/scope_bound` with
target, normalized root and filesystem identity. It shares identity with 6B Skills
observations. The Session store validates competing observations and replay, so
root replacement is rejected after restart, and Skills cannot adopt a different
root after a file-reference observation. This is metadata, not model-visible file
content, attachment data or a tool invocation.

Selecting a candidate replaces only the active mention with ordinary prompt text.
Inbox and HTTP receiver tests compare the exact original spaces and quotes. The
model receives a stable conditional system-prompt instruction when `read_file` is
available: completion does not inspect content; use `read_file`/`list_directory`
explicitly when contents matter. Only that intentional policy section was added
to the prompt golden. Existing request/start and prompt snapshot dedup remain.

An idle recovered text-only Session now calls the idempotent start/attach entry
before follow-up, as recovered image-bearing Sessions already did. This fixes an
actual browser/Rust recovery case where input was enqueued without an owning driver.

## Bounded discovery and safety

Every query freshly lists **one** directory inside the frozen root. A slash splits
the directory from a case-insensitive basename prefix. This is deliberately a
live directory navigator, not a recursive fuzzy index. No candidate cache or
background rebuild exists: typing, directory navigation or reopening observes
fresh state. Tool changes need no separate invalidation event. `.gitignore` is
not read and there are no hidden build-directory exclusions.

| Budget | Policy |
| --- | --- |
| Traversal | One directory per query; no recursion, at most 32 query components |
| Path/query | At most 2048 UTF-8 bytes |
| Enumeration | At most 1024 entries; excess fails Limit, never an arbitrary OS-order partial result |
| Candidate path bytes | At most 64 KiB before display truncation |
| Display | At most 40; status explicitly says truncated; directories first, then UTF-8 lexical path order |
| Work | Four blocking providers per Runtime; no unbounded worker queue |
| Time | Four-second operation deadline; checks before/after traversal and each entry; remote scoped sockets are closed on cancellation/deadline and workers joined |
| Cancellation registry | At most 256 entries; early-cancel tombstones expire after 30 seconds; live entries never evicted; RAII cancels/removes dropped operations |
| Remote wire | Existing 16 KiB stdin / 256 KiB stdout fixed-helper limits |
| Frontend | 100 ms debounce; AbortSignal plus generation and current-draft guards |

Local enumeration reuses no-follow dirfd traversal on Unix and existing reparse
rejection/retained Windows handles. Root listing opens an independent directory
handle: a duplicated fd would share `readdir` position and silently return empty
results on later queries. Directory versions and root identity are checked before
and after enumeration. Local cancellation is cooperative between OS calls; it
cannot forcibly interrupt a kernel call on a stalled mounted filesystem.

The authenticated remote SSH provider reuses frozen profile, credentials and
known-host checks. Its fixed Python 3 helper gains only `listPaths`: relative
validated components are opened as directories with no-follow flags. Existing
content reads remain restricted to the Skills tree. Input is JSON on stdin, not
shell interpolation. Missing Python, disconnected/changed profiles, permission
failure and absent paths are explicit errors, with no fallback to `localRoot`.

Links/reparse entries and names with control characters, embedded quotes,
backslashes, colons or Unicode line separators are excluded and reported.
Absolute paths, empty interior components, dot/parent traversal and excessive
depth are rejected. Non-UTF8 names fail the query explicitly. macOS APFS does not
permit the invalid-byte fixture; this case runs against the actual Linux SSH
server. Choosing paths reads metadata only; an unreadable ordinary file remains
a valid path candidate. The remote fixture proves this with zero file permissions.

## Input and accessibility

The grammar recognizes @ only at input start or after whitespace and at the
current caret, never within email. It handles quoted spaces and an unfinished
quoted directory; selecting a directory leaves its trailing slash and quote open.
Selecting a file closes the quote. Full-token replacement preserves both surrounding
text and caret position, including when editing in the middle of a token. A text
selection is not treated as an active caret.

Up/down select, Enter/Tab insert, Escape dismisses, and mouse selection preserves
editor focus. Enter cannot submit while completion is loading, empty or in error.
Tab leaves the input in those states. With no root, Enter/Tab opens the directory
dialog; a visible hint explains the keyboard path. IME composition (including key
229 and the post-composition Enter guard) never selects or sends accidentally.
Listbox/option IDs and active-descendant reflect the focused choice.

The project shadcn skill guided reuse of Card, Button, InputGroup, Dialog, Alert,
EmptyState and Spinner. The root dialog is outside the InputGroup logical tree and
isolates portal clicks. Closing completion leaves no empty addon. It stays mounted
while the directory form has focus. Loading, empty, denied, absent, root drift,
budget, cancellation and unavailable states have English/Chinese explanations.
The existing single MessageScroller and both event projections remain unchanged.

## Delivery

See [validation](ai-runtime-stage6d-validation.md). Run
`node scripts/ai-runtime-stage6d-handoff.mjs` after any product/document edit. It
freezes tracked patches against HEAD and `4f353d9`, every untracked product,
all source SHA-256 values, and historical metadata, then reconstructs both exact
bases and verifies every hash. Delivery metadata excludes itself from product
patches. A tracked patch alone is incomplete; copy every listed untracked product.

No external paid/live request was made. Stage 7 may use only this project's main
`.env.local` configuration, without copying or exposing keys. No Windows native
compilation/junction execution, cross-device draft migration or final Stage 7
acceptance is claimed by this stage.
