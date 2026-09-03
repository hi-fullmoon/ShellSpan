# Stage 3B: same-Session request recovery and Provider retry settings

Authoritative implementation worktree: `C:/Users/zhengbiwen/.codex/worktrees/c8a3/ShellSpan`. Baseline HEAD: `4f353d9bbfa2c6ccfe75a1023f4df46ab4fb8412`.

## Baseline and scope

The stage 4 source was `C:/Users/zhengbiwen/.codex/worktrees/fd30/ShellSpan`. Its actual status contained 32 modified tracked files and eight untracked product/documentation files, all copied byte-for-byte. This includes `retry.rs`, `provider.rs`, the shared Provider JSON/TypeScript/fixtures/tests, and both stage 4 documents. The remediation checklist was copied separately from `D:/Developer/ShellSpan/docs/ai-runtime-harness-remediation-plan.md`. All 41 SHA-256 pairs matched, both worktrees had the same HEAD, and their initial tracked diffs were identical. `.phase3b-evidence/baseline.json` records the full inventory and hashes. The source `.phase4-evidence` was read for its manifest but was not migrated or executed.

Only this worktree contains product edits. The source worktree, main workspace and Harness are read-only. The explicitly authorized exception is the generated Rust cache at `fd30/ShellSpan/src-tauri/target`; commands select it with `CARGO_TARGET_DIR` and select `1.95.0-x86_64-pc-windows-msvc` without changing repository or global toolchains. No Git commit/merge, next task, subagent, paid live call, or stage 5/6 implementation is part of this delivery.

## Request state and durable output

Each step owns one bounded request series. Transport failures, timeouts, 429, retryable server errors and empty responses can retry even after text, reasoning or tool argument deltas. Each attempt has a new request ID, while turn, step, series and attempt budget remain stable. Request assembly reads the current committed Model Surface; failed drafts never enter it. Completed tool calls from earlier steps remain in history and are not executed again by retry recovery.

Every failed attempt appends `request/failure`, including attempt/max-attempt count, scheduled cumulative delay, normalized kind/status/code and whether output was observed. Existing `assistant/chunk` records remain untouched. `request/retry.previousRequestId` links the next attempt to that failure and records the capped wait and server hint. Successful completion alone appends the ordinary `assistant/message` and enters tool execution. Exhaustion and terminal errors close the step/turn/session as Failed without committing failed text or incomplete tools. Context-too-large recovery retains the stage 4 compaction path and shares the same attempt counter.

User cancellation remains distinct: cancellation takes precedence over an already-ready response/error or chunk, retains interrupted text/reasoning when appropriate, and never admits another attempt. Cancellation during backoff settles without a new request header. The wait uses the owning Session cancellation token; cancelling a parent also stops child backoff. Restart replays the append-only log and preserves the existing fail-closed recovery for an open request; it does not automatically repeat model requests or uncertain side effects.

The chat projection withdraws a failed attempt's temporary text/reasoning on `request/failure`, before the next stream starts. The activity projection retains the failed stream, closes its state and preserves chunk records and retry diagnostics. Streaming and completed answers therefore contain only the successful attempt, and JSON reload produces the same projection.

The local HTTP regression also found that reqwest reports premature Content-Length EOF as a Decode error. Raw-byte response decoding failures are now transport failures (`STREAM_DECODE`), eligible for bounded retry. Provider JSON/SSE parsing failures remain separate terminal protocol errors.

This follows the distinction in the read-only Harness `packages/core/agent-loop/src/agent.ts:345–430`: failed attempt chunks provide audit evidence, while successful assistant messages and tools are committed only after a successful request.

## Provider configuration

The existing Provider setup dialog exposes five fields with English and Chinese labels. Total attempts of one disables retry. Settings persist with each Provider and travel through `getProviderConfig` and the Rust `AiProviderConfig.retryPolicy` parser. An omitted legacy field preserves the previous defaults. Explicit malformed, incomplete, unknown-field, non-finite, fractional count/delay, overflowing or out-of-range policies fail validation before network admission; invalid persisted frontend settings remain visible and cannot silently enable a fallback policy.

| Field | Default | Accepted range |
| --- | --- | --- |
| `maxAttempts` | 3 | Integer 1–8, including the first request |
| `initialDelayMs` | 250 | Integer 0–300000, no larger than `maxDelayMs` |
| `maxDelayMs` | 4000 | Integer 0–300000 |
| `maxServerDelayMs` | 30000 | Integer 0–300000 |
| `jitterRatio` | 0.2 | Finite number 0–1 |

`src/lib/retry-policy.json` supplies the frontend defaults/limits; Rust parity tests verify every default and ceiling. Local delay grows exponentially with bounded jitter. Existing Retry-After seconds/date and millisecond hint parsing is retained, with the configured server cap. The saved Provider snapshot is owned by the running Agent; editing settings or calling start again cannot reset its budget. Changes apply to newly attached sessions. Child creation and persisted child restoration retain both explicit Provider profile and retry policy, including custom proxy profiles.

The model summarizer uses that Provider's policy too. Partial summary failures can retry with a new attempt request ID; failed output is not reused as synthesis. Provenance records the request, normalized error and whether partial output existed. Every retry is charged against the existing 512 KiB cumulative input limit, and backoff remains inside the 45-second total deadline. Existing per-call input/output, chunk/source and usage limits remain in force. Failure/cancellation/budget exhaustion retains the old Surface and does not commit a lossy checkpoint.

## Verification

See `ai-runtime-stage3b-validation.md` for exact commands, final counts and source integrity checks. Focused coverage includes real local HTTP partial text/reasoning/tool arguments → truncated transport → 503 → success; deterministic exhaustion/last-budget/disabled/terminal/empty-response cases; cancellation before retry, during backoff and at ready response; prior write execution plus replay; Provider persistence, malformed settings, snapshots and children; frontend streaming/completion replay; and summary retry/deadline/input-cost boundaries.

The local evidence directory is temporary and should not be migrated as product code. Its final cumulative file manifest includes all untracked product files. Stages 5, 6 and final integration remain open in the remediation checklist.
