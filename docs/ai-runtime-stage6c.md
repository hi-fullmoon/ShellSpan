# Stage 6C — image attachments

Worktree: `/Users/zhengbiwen/.codex/worktrees/23d3/ShellSpan`. Base:
`31ce4343b9a834503c43db1b04b81fe0128e4ea0`. No commit/main mutation.

## Baseline reception

Verified frozen 6B HEAD `1ac0c1e4a070bd8024063af5c58e4b2add3b7395`,
inventory SHA-256 `c7e3eedeedfbdef44cea1b101976c70b8898372d5083ced055944f6047e33422`,
stage patch SHA-256 `189a79cb7780000e8042291913b8777daa082c58581c13b6df73d83212fbf6d3`.
Verified all 119 source hashes, copied all 35 untracked product files and historical
6A/6B metadata. Applied the patch with three-way merging. Session validation's
single conflict was resolved by retaining both request/start and Skills branches.

107 cumulative files remain byte-identical. The 12 merge exceptions are
`docs/agent-runtime-vnext.md`, Runtime `driver.rs`, `event.rs`, `mod.rs`,
`recovery.rs`, `registry.rs`, `runtime.rs`, `session.rs`,
`src/lib/agent-session-projection.ts`, `src/lib/ai/conversation-projection.ts`,
its test, and `src/types/agent-session.ts`. Every exception retains main's
request/start/system-prompt snapshot protocol in addition to the 6A/6B work.
Main's remaining six changed files are retained unchanged, including lock/workspace
configuration. The user-owned main input-group style was never touched.

Before attachment implementation: frozen pnpm install and TypeScript passed;
6B aggregate passed (32 Rust, 44 frontend, real controller bridge 1+1, isolated
SFTP 1, browser 8); 6A passed (40 frontend, 17 Rust, browser 8); system prompt
and conversation projection tests passed (26); request/start validation passed (1).
Evidence logs: `/tmp/shellspan-stage6c-baseline6a.log` and
`/tmp/shellspan-stage6c-baseline6b.log`.

## Implemented input contract

The production composer accepts local PNG, JPEG, WebP and single-frame GIF.
Rust checks canonical base64, declared MIME against magic bytes, actual decode,
container termination, UTF-8 filename bounds, animation and decoded dimensions.
The shared TS/Rust contract is `src/lib/vision-contract.json`: at most 4 images,
8 MiB/source, 16 MiB/source batch, 8192 pixels/side, 16,777,216 source pixels and
128 MiB decoder allocation. Imports run off the async executor, with two permits
per shared ImageStore (not a global semaphore shared by independent runtimes).

Normalization applies EXIF orientation, reduces RGB/gray 8/16-bit samples to
RGBA8, resizes to at most 1,048,576 pixels and 2048 pixels/side, and encodes PNG
within 5 MiB. Unprofiled samples are interpreted as sRGB. ICC, CMYK/YCCK JPEG,
nonstandard PNG gamma/chromaticity/cICP and animation are explicitly refused;
this is a limited-color admission policy, not a claim of general color management.
Descriptive metadata is removed. Filenames are redacted leaf names, never paths.

The app-managed `agent-runtime/images-v1/<sha256>` store publishes fsynced temp
files without clobbering an existing hash. Reads require a valid versioned ref,
regular no-follow file, matching size/hash/dimensions and full PNG decode.
Renderer preview requests must identify a ref actually committed in that Session.
No renderer path, arbitrary URL or globally guessed hash is accepted for reads.
There is no automatic image GC: failed batches may leave unreferenced immutable
blobs, and drafts/archived Sessions retain their files. User data removal is not
part of this stage; filesystem permissions are not an encryption claim.

## Draft, commit and recovery ownership

IndexedDB stores normalized draft bytes, text, owner, CAS revision and optional
frozen operation identity/create target in a single transaction. Selection creates
no Session. The existing explicit Skills directory flow remains responsible for
freezing a new Session's project root. Both image→directory→`/skill` and the
reverse sequence use the normal controller/adapter/Inbox path.

Send persists intent before create/send IPC, waits for the exact durable Inbox
operation to be backfilled, then clears the original draft. Failure retains the
draft and operation for idempotent retry. An index finds a cold-owner pending
draft after its Session is created and the app reloads. UI callbacks use both
owner and generation guards, including A→B→A navigation; stale import, removal,
text-save and cancellation replies cannot alter a newer owner's state.

Native normalization completes for the whole batch before publication; all refs
are admitted in one Inbox append. Original input fingerprint + Session + operation
ID distinguish an identical retry from a conflicting submission. An operation gate
linearizes cancellation against Inbox commit: cancel-before-commit creates no
message; commit-before-cancel returns the durable receipt and cannot be called
cancelled. In-flight operation cancellation tokens are process-local, bounded to
2048 identities; committed receipts recover from the append-only log after restart.
Cancelling selection discards late preview work; already-written orphan blobs are
not reclaimed. It does not promise forcibly interrupting a decoder mid-call.

Events/snapshots/model surfaces contain typed image refs, never data URLs or full
image bytes. At model dispatch, native verified files become transient `image_url`
data blocks in the real OpenAI-compatible HTTP body. Missing/corrupt files fail
before transport. Text follow-ups after restart reattach and retain the same pixels.
Compaction retains refs independently of its text summary; replay cannot replace
image input with an alt-text placeholder. Ordinary text, Questions, Skills, queue,
system-prompt snapshots and single MessageScroller remain on their existing paths.

## Provider capability and budget

Only exact `qwen3-vl-plus` and `qwen3-vl-flash`, `qwen` profile and
`openAiCompatible` protocol are admitted. Similar names, unknown models,
text-only models and other protocols are rejected, with a retained draft and
localized actionable feedback. A custom proxy must explicitly use the Qwen
profile; this does not assert every proxy deployment supports the contract.

The route allows four retained images and 20 MiB normalized bytes per request,
reserving 16,384 tokens/image separately from provider-reported usage. The
context budget is a deliberately conservative **128,000 application cap**, not
the advertised maximum of every region/model alias. Current provider listings
vary by deployment; do not reuse the earlier unverified 262,144 assumption.
Review deployment-specific limits before widening in Stage 7. The official
[vision wire/limits documentation](https://docs.modelstudio.console.alibabacloud.com/zh/model-studio/vision),
[model capabilities](https://docs.modelstudio.console.alibabacloud.com/en/model-studio/vision-model)
and [Qwen API listing](https://qwen.ai/apiplatform) were checked on 2026-09-04.
The selected models are a small supported legacy whitelist, not a recommendation
that newer Qwen models should be inferred compatible.

## UI and delivery

The project shadcn skill guided reuse of Button, Attachment and Alert. An accessible
button triggers a hidden real file input; no native English file-picker row remains
in Chinese layouts. Expected failures have localized instructions; returning to a
supported model clears the prior unsupported-model error without dropping images.
No shared Button/InputGroup overwrite, package workaround or extra chat scroller.

See [validation](ai-runtime-stage6c-validation.md) and the
[frozen cumulative inventory](ai-runtime-stage6c-handoff/inventory.json).
Apply one tracked patch to its recorded exact base, then copy every untracked
product in the inventory; a patch alone is incomplete. Preserve historical 6A/6B
metadata. No commit, merge, push, main mutation or Harness edit was performed.

Windows native verification and external live provider tests remain NOT RUN.
Same-project main `.env.local` exists; live is reserved for Stage 7, without
copying credentials or using another project's keys. Harness is read-only.
