# Stage 6A — durable structured user questions

This stage implements `ask_user_question` only. Skills (6B), image attachments
(6C), file completion (6D), and final integration (7) remain separate work.
The resumed worktree is `/Users/zhengbiwen/.codex/worktrees/ad7b/ShellSpan`.
No main checkout, branch, remote, or other worktree is mutated by this handoff.

## Baseline

- HEAD/base: `25af899f9cde2c5da039e3f76c652b173334e6ea` (detached worktree).
- Stage 1–5 base: `3e40eefa49ea6a5c56ce5201dbec298687918d1f`.
- Restored WIP: the complete 34-file diff from that base to
  `48fd8fda6abc37e05497bd74209c76fe1931bf43`, applied after `git apply --check`.
- Main's handoff documents were retained. No dependency versions or lockfiles
  were changed. Harness was read-only at
  `/Users/zhengbiwen/Developer/deepseek-harness`.

## Contract and execution

The model schema is strict: 1–3 questions, optional 2–7 options, unique question
IDs and option labels. Unknown fields, empty/whitespace-only text, unknown or
duplicate selections, missing answers, and oversized UTF-8 input are rejected.
Limits in bytes: ID 64, question 2048, header 128, label 256, description 1024,
custom answer 8192, complete argument/answer payload 32768. The schema advertises
string bounds; runtime byte validation is authoritative for non-ASCII input.

Single-select custom text replaces selected labels. Multi-select custom text
supplements selections. Recommended choices never select or submit themselves.
Unlike the reference Harness's optional skip UI, this stage deliberately requires
every question to have an answer, as specified by the stage acceptance contract.

The actual chain is:

1. Provider response commits its original assistant tool list.
2. The rolling scheduler drains prior tools before admitting the question.
3. `tool/call`, `question/requested`, and waiting status commit; the active scope
   retains the original Session/Turn/Step/request/call identity.
4. `agent_runtime_answer_question` calls `AgentRuntime::answer_question`. A
   missing live agent is attached using the persisted provider descriptor and
   **current project credential store**, never a persisted API key.
5. Exactly one `question/answered` commits. The driver supplies exactly one
   matching `tool/result`, completes remaining original calls, and advances once
   to the next model request in the original Turn. No extra user message is made.

Questions are separate from authorization. A following write still runs native
prepare/approval/dispatch validation. Child entry points reject human input based
on exact live registry ownership. Durable child lineage is not authority: a
historical child restarted as a root may ask, while a depth-zero agent currently
owned by a live parent cannot. Human-input schema availability is independent of
historical native tool scopes; execution still checks current live root identity.

## Recovery and concurrency

`append_batch` is **not** a crash-atomic JSONL transaction. Tests recreate each
complete line prefix, including prefixes inside a batch.

| Last durable boundary | Recovery |
| --- | --- |
| Question ToolCall only | Reuse the exact call; create the missing request, never duplicate Call |
| Question requested, no answer | Restore the original wait; no approval TTL |
| Answer, no result | Rebuild result from the committed, redacted answer; do not ask again |
| Result, remaining tool queue | Skip committed results; continue remaining calls in model order |
| Native Call before authorization | Re-prepare with current policy; reuse only the exact frozen call |
| Native authorization before dispatch | Preserve the existing explicit authorized-recovery boundary |
| Native dispatch without result | Require reconciliation; **never automatically re-execute** |
| Completed tool Step | Advance to the next Step once |
| Question cancellation prefix | Repair cancelled result and finish Session cancellation without a request |

Question publish, answer acceptance, cancellation, and driver lease release share
one question gate. If an answer commits before a waiting driver releases its
lease, that driver retains the lease and continues. Otherwise idle is published
under the same gate before a new answer can wake it. This removes both a lost
wakeup and a false-idle release/reacquire window. Tests use explicit Notify and
publication barriers, not arbitrary sleeps.

Original identity includes Session, Turn, Step, model request, tool call, and
question request. `clientOperationId` cannot be reused on another answer. The
SHA-256 fingerprint is computed from the original structured submission before
normalization/redaction; only that digest and the normalized, sanitized answer
are committed. Identical sensitive retries succeed; distinct original secrets
that both redact to `[REDACTED]` conflict. No second plaintext copy is stored.
Question text/labels requiring redaction are rejected before creating a pending
question. Storage failure publishes neither an orphan question nor an accepted
answer. Cancelled, stale, cross-Session, or conflicting submissions fail closed.

## UI and projections

The question card lives above the ordinary composer, outside folded Turn Process
content. The normal draft is preserved and normal submission is disabled while a
question owns the composer. The existing single `MessageScroller` remains the
only conversation scroller. A bounded card content region scrolls long forms;
the submit button stays in the viewport at 320–720 px.

The repository shadcn skill guided reuse of Card, FieldGroup/Field,
ToggleGroup, Textarea, Button, and Spinner; the existing Field primitive gained
semantic FieldSet/FieldLegend wrappers without replacing its local styles.
Only semantic colors are used. Chrome is bilingual. Accepted/cancelled questions
are read-only history and retire the matching ephemeral draft. Unsaved question
drafts survive Session navigation/remount within the page, but are deliberately
not persisted to browser storage or disk.

Conversation and Activity consume committed events. A question has stable
identity and remains outside the process collapse. Existing prompt/user/process
ordering was restored after the WIP's global sort caused a regression.
After answer IPC succeeds, the adapter reconnects/backfills and confirms the
committed operation before acknowledging the form; lost live events cannot
silently discard a retryable draft.

## Verification and next stage

See [validation report](ai-runtime-stage6a-validation.md) for the nine risk groups,
commands, outcomes, skipped live checks, and frozen handoff inventory. The next
task must carry **all** tracked differences and untracked product files, not only
HEAD. It must not infer that 6B–7 or the overall goal are complete from this stage.
