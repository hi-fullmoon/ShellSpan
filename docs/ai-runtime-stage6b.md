# Stage 6B Skills implementation — 2026-09-04

The isolated worktree implements the Stage 6B design on the complete frozen 6A
source plus main commit `1ac0c1e4`. Validation and platform limits are recorded in
[the validation report](ai-runtime-stage6b-validation.md). No commit, merge, push,
or change to the main checkout is part of this delivery.

## Entry points and durable behavior

- The Session-addressed `agent_runtime_list_skills` IPC takes only `sessionId`.
  A new conversation first asks for an explicit absolute project directory and
  shows the local/remote terminal target. The directory goes into the ordinary
  create-Session request as `cwd` or `rootPath`. There is no process-cwd, home,
  SFTP-browser-path, or local fallback. Existing Session roots remain frozen.
- `AiProjectDirectoryInput` is a reusable project-directory input for later 6D.
  The Skills menu inserts `/name ` into the normal composer draft. It cannot
  invoke a skill directly. Original draft whitespace survives submit and Inbox.
  Pending creation and menu queries are isolated by target/navigation identity;
  an old creation failure cannot clear the new target's directory state.
- `skills.rs` defines protocol/renderer version 1, strict YAML parsing, two
  invocation policies, bounded inert metadata, snapshots, hashes, and a shared
  complete renderer. Flat `.agents/skills/*.md` and one-level bundles with
  `SKILL.md` are discovered. Relative paths sort before duplicate first-wins;
  policy filtering happens after choosing the winner. Ordinary unknown metadata
  is retained with diagnostics; invocation aliases and ambiguous booleans fail.
- Each new model Step observes the catalogue. Complete empty results replace it;
  malformed definitions are removed while valid siblings survive. Incomplete
  enumeration/read/limit/deadline results preserve last-good state. Root/profile
  drift or capability withdrawal retires it. A later incomplete observation
  cannot revive retired authority. Execution always checks current winners and
  flags again; stale listings never authorize a body load.
- `StepInputClaim` makes the claim's messages and scope reconstructible before
  Inbox removal, TurnStart, StepStart and UserMessage. Prefix repair writes only
  missing facts. `SkillStepPrepared` is one bounded fact for the whole step:
  direct-user ingress IDs, catalogue publication and every slash outcome. Form,
  runtime, plugin, inherited, queued-but-unclaimed and already injected content
  are excluded. Unknown/disabled names preserve the user text and record an
  explicit non-loaded outcome.
- A committed preparation or model ToolResult reuses the saved complete body on
  retry/restart, even if files change. No second content fact is needed for model
  projection. Actual compaction causes catalogue re-publication, including an
  empty retirement when an earlier catalogue has disappeared from the surface.
  Parent Skills facts/calls/results are removed from inherited model context;
  children discover under their own frozen capability scope.
- `skill({name})` has strict arguments and is an exclusive scheduler barrier.
  Before/after/failure hooks, cancellation, read-only scope, native write
  approval and child tool budget remain in force. Already reserved recovery
  calls are not charged again. Only a validated complete Skill result receives
  the dedicated bounded result path; ordinary native results retain 8 KiB
  inline handling.
- Both Conversation and Activity projections consume typed facts. Full
  instructions and provenance/hash details use existing Marker/Collapsible
  components and the existing single MessageScroller. No provenance is inferred
  by parsing model text. Labels and feedback have English and Chinese strings.

## Scope and I/O

`native/scoped_read.rs` supplies reusable bounded stream/handle reads. The native
local `read_file` path uses the same root/relative handle reader; existing local
and SFTP native bounded streams use the shared cancellation/bounds loop.

Unix roots and descendants are opened component-by-component with `openat`,
`O_NOFOLLOW`, directory flags and retained handles. Enumeration uses a directory
handle, not a pathname. The frozen root is identified by device/inode, independent
of ordinary directory mtime/size changes. File reads check identity/version and
bounds before/after reading. Replacement and symlink races cannot redirect the
handle traversal outside the root.

The Windows branch uses directory-capable `CreateFile` flags, reparse-point
rejection, volume/file-index identity, and retained ancestor handles without
`FILE_SHARE_DELETE`. This branch has **not been compiled or executed on a Windows
host in this stage**. Windows junction/reparse and native runtime validation
remain an explicit cross-platform item; Unix symlink evidence is not Windows
PASS.

SFTP v3 pathname opens cannot provide atomic no-follow traversal. Remote Skills
therefore use a fixed read-only Python 3 helper over the existing authenticated
SSH connection and existing profile/credential/known-host checks. All target
input is bounded JSON on stdin; the shell command contains only the embedded
fixed program. The helper exposes identity, the single Skills directory listing,
and flat/bundle Skill reads using dir-fd/no-follow operations. It never imports
from the remote cwd, writes, scans home, recursively loads resources, or executes
skill text. Python 3 and SSH exec must be available; absence fails unavailable.
The existing SFTP connection is still established and tested by the isolated
fixture. No remote failure falls back to local files.

Each observation/load has a 15-second deadline. Scoped DNS/TCP/SSH work uses the
same cancellation/deadline control; owned sockets are closed and blocking work
is joined. Scoped jump bridge workers are tracked, stopped and joined too.
Normal long-lived terminal connections retain their existing ownership. Root
and profile identity are rechecked before publishing results. Resource bases
are provenance only; later reads/writes still use normal native authorization.

## Final bounds and version integrity

| Quantity | Bound |
| --- | --- |
| Candidates / winning skills | 1,024 / 256 |
| File bytes / discovery total | 128 KiB / 8 MiB |
| Description | 500 Unicode scalars after whitespace normalization |
| Inert metadata per entry | 8 KiB |
| Diagnostics | 1,024 and 32 KiB overall |
| Serialized observation | 192 KiB |
| One rendered complete load | 96 KiB |
| Unique slash names per step | 16 |
| Complete new Skills input per step | 112 KiB |
| Serialized complete payload/preparation | 240 KiB, leaving event-envelope room |

The design's starting 128 KiB step bound was calibrated to 112 KiB because the
complete instruction and canonical rendered form are both retained in the durable
fact. UTF-8, XML escaping and JSON escaping count toward their respective bounds.
The existing 128 KiB message / 256 KiB event ceilings and log limits still apply.
Oversized batches fail completely; no head-of-file or first-N directory is
presented as complete.

Provenance contains protocol/renderer, provider identity, frozen target/root and
root identity, relative path/resource base, invocation kind, snapshot revision,
file/instruction hashes, user message IDs or model request/call IDs. The complete
payload also stores the canonical rendering and its SHA-256. Persistence and
replay validate the typed payload. The existing redactor runs as a preflight:
if it would change a complete body or rendering, loading is rejected rather
than storing a mismatched body/hash. No credential is added to provenance.

All new model input is budgeted after surface construction; compaction and the
post-compaction/over-window check run before a provider request. The runtime JSON
fixture is generated by the real HTTP integration test, not hand-authored skill
history. Old v4 fixtures remain in the cumulative suites.

## Handoff

Use `docs/ai-runtime-stage6b-handoff/inventory.json`, the complete tracked patches,
and **all** listed untracked product files. The current worktree is
`/Users/zhengbiwen/.codex/worktrees/5d5b/ShellSpan`, HEAD
`1ac0c1e4a070bd8024063af5c58e4b2add3b7395`. The stage patch is against that HEAD and
includes the uncommitted 6A and 6B work. The cumulative patch is against
`4f353d9bbfa2c6ccfe75a1023f4df46ab4fb8412`. Patches do not contain untracked files.
Generated handoff metadata is delivered separately and excluded from self-hashes.
