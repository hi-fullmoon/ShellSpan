# Stage 6A validation — 2026-09-04

Status: **Stage 6A accepted and frozen in the isolated worktree**. All nine required
risk groups and the cumulative gates below passed. Not merged into main; not an
acceptance of 6B–7 or the overall goal.

## Environment and boundaries

- macOS arm64; Node `v24.15.0`, pnpm `11.1.1`, Rust `1.95.0` native toolchain.
- Worktree: `/Users/zhengbiwen/.codex/worktrees/ad7b/ShellSpan`.
- HEAD: `25af899f9cde2c5da039e3f76c652b173334e6ea`; no local commit or push made.
- Frozen Stage 1–5 base: `3e40eefa49ea6a5c56ce5201dbec298687918d1f`.
- Pre-remediation cumulative diff base: `4f353d9bbfa2c6ccfe75a1023f4df46ab4fb8412`.
- No Windows toolchain copied, no dependency upgrades, no other project credentials.

## Nine required risk groups

All tests below run production Runtime methods, persistence, scheduler, and model
surface code. The HTTP test runs the real provider adapter against a local SSE
server with synthetic in-memory credentials. The JS IPC test checks the public
command and exact payload. These are deterministic integration tests, not a live
external provider or native desktop end-to-end restart smoke.

| Group | Evidence |
| --- | --- |
| 1. Actual answer entry restores Session/Turn/Step and next request | `question_single_answer_entry_reattaches_original_turn_and_next_request`; `question_real_http_resume_uses_current_credentials_and_original_tool_history` checks changed current credential, wire tool-call ID, schemas, one original user message and same Turn |
| 2. Minimal and read→question→write→question | `question_read_question_write_question_keeps_barriers_and_approval`; result order, writes blocked before approval, next request count, and operation ID reuse rejection |
| 3. Every complete JSONL prefix | `question_every_jsonl_prefix_repairs_answer_result_and_step_once`; `question_chain_every_prefix_preserves_unexecuted_queue_and_never_replays_dispatch`; `question_cancelled_jsonl_prefix_recovery_finishes_cancellation_without_model` |
| 4. Publish/answer/cancel/lease races and wait lifetime | `question_answer_cancel_and_driver_lease_races_have_one_commit_order` (three controlled orders); `question_answer_racing_wait_publication_cannot_be_overwritten_or_lost`; no native approval-expiry candidate; UI unmount does not invoke cancellation |
| 5. Identity and idempotency | All six identity fields mutated/rejected; exact replay succeeds; same operation on second question rejected; cancelled submissions rejected; single answer/result assertions |
| 6. Sensitive input and persistence failures | `question_sensitive_answer_retry_uses_raw_fingerprint_not_redacted_content`; `question_redaction_collisions_fail_without_pending_or_waiting`; answer/request storage-outage tests prove no published orphan or accepted answer |
| 7. Strict structure and selection semantics | `question_schema_and_answer_byte_limits_are_strict`; real form tests for required/free/custom answers, multi-select, multibyte overflow, no automatic recommendation selection |
| 8. Ownership and authorization | `question_live_ownership_not_lineage_and_subagent_entry_rejection`; `question_historical_child_can_resume_as_new_live_root`; pending native write approval in chain test |
| 9. UI/reconnect/projections/locales | Question form tests; workspace test for folded process and retained normal draft; lost-event adapter reconnect test; stable Conversation/Activity projection and exact IPC payload; 8 browser scenes |

## Gate commands and final outcomes

Final results are recorded below after the last code change. Logs are local
non-product evidence under `/tmp/shellspan-stage6a-bJGJPv`.

| Exact command | Final outcome |
| --- | --- |
| `pnpm install --frozen-lockfile` | PASS; lockfiles unchanged |
| `pnpm exec tsc --noEmit` | PASS |
| `pnpm test:ai:stage6a` | PASS: 38 frontend tests / 5 files; 16 Rust behavior tests; 8 Chromium scenes |
| `pnpm test:ai:stage3` | PASS: 75 frontend; Rust filters 21 + 197 pass / 9 ignored |
| `pnpm test:ai:stage4` | PASS: 54 frontend; Rust filters 3 + 23 + 17 pass / 9 ignored |
| `pnpm test:ai:stage3b` | PASS: 57 frontend; Rust filters 71 + 6 + 1 + 17 pass |
| `pnpm test:ai:stage5` | PASS: scheduler 17; remaining filters 1 + 2 + 2 + 1 + 9 pass / 1 ignored |
| `pnpm test` | PASS: 1431 tests / 167 files |
| `pnpm build` | PASS; existing >500 kB bundle-size advisory remains |
| `pnpm test:scripts` | PASS: 29 tests / 6 files |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib --locked --no-fail-fast` | PASS: 544 passed, 0 failed, 21 ignored |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check` | PASS |
| `rustfmt --edition 2021 --check src-tauri/src/agent_runtime/question_tests.rs` | PASS (explicit check for the included test module) |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings` | PASS |
| `git diff --check` | PASS |
| `pnpm test:agent:providers:live` | 0 executed / 8 SKIP; not live PASS |

The controlled lease test also passed five consecutive focused runs after the
lease fix. Final Stage 3B, Stage 6A, and whole-lib runs subsequently passed with
that same lease fix and the required-reconciliation guard.

Final browser evidence:
`/var/folders/0m/np6lcl6x32b52ssrwlkzp_ym0000gn/T/shellspan-question-visual-fjxyvq`.
Each of 320/400/560/720 px runs light/en-US and dark/zh-CN with reduced motion,
three questions and seven options. Assertions cover one MessageScroller, submit
visibility, no horizontal overflow, answer submission, read-only history and
normal draft preservation. Screenshots were inspected; no existing pixel
baselines were overwritten.

## Observed failures fixed during implementation

- Restored WIP lacked FieldSet/FieldLegend and required test adapter methods.
- A prior native approval cleared the active Step; a subsequent question answer
  skipped remaining original calls. Request/restore now retain the original scope.
- ToolCall-only prefixes had no resumable question; original queue reconstruction
  now repairs them and reuses exact unadmitted native Calls safely.
- Answer/cancellation prefixes needed deterministic result repair and cancellation
  completion. They are now tested by actual JSONL truncation.
- IPC success with a missing live event could leave a stale connected view. The
  adapter now reconnects before clearing the form.
- WIP global chat sorting reordered system prompt/user/process. Question insertion
  preserves existing hierarchy rather than resorting all nodes.
- The lease race test failed under cumulative load: idle could be observed between
  release and reacquisition. Driver lease transfer is now gated and retains the
  active lease when an answer is already committed.
- The existing ungated 20ms native overlap assertion was timing-dependent. Its
  exact-overlap assertion remains in the already-invoked controlled
  `verify_write_barrier` test; the ungated portion checks its upper bound, result
  count/order, and barriers. No scheduler requirement was removed.
- Strict tool catalog expectation now includes the new real question tool.
- Clippy's test-only complex type was replaced with a named alias.
- Question recovery now also preserves a required scheduler reconciliation;
  accepting an answer cannot bypass that boundary (`question_does_not_hide_required_scheduler_reconciliation`).

## Not claimed

- External live provider smoke: **0 executed / 8 SKIP**, because this project has
  no `.env.local` or required `SHELLSPAN_LIVE_*` configuration. No other project
  credentials were read or used. Synthetic local HTTP coverage is not live PASS.
- Dispatched native side effects without a durable result remain uncertain and
  require reconciliation; this is intentional fail-closed behavior, not replay.
- Stage 6B Skills, 6C images, 6D @file, main integration, final Phase 5 pixel
  baseline/benchmark and full Stage 7 audit are not completed by this stage.
- Unsent question drafts are page-lifetime memory, not restart-durable user data.

## Frozen handoff

The final inventory and complete tracked patches are generated after verification
with `node scripts/ai-runtime-stage6a-handoff.mjs` into
`docs/ai-runtime-stage6a-handoff/`:

- `inventory.json`: worktree/HEAD/bases; Stage 6A tracked file hashes; cumulative
  tracked hashes; every untracked product file; deduplicated full cumulative file
  list; patch hashes. Generated delivery metadata is excluded from self-hashing.
- `stage6a-tracked.patch`: complete tracked diff against HEAD `25af899f`.
- `cumulative-tracked.patch`: complete tracked diff against `4f353d9` (Stages 1–6A,
  including main's handoff documents).

Before applying a patch, verify the target base and a clean/non-conflicting
worktree. Untracked product files are **not inside those tracked patches**: copy
them from the frozen worktree by the inventory, then verify SHA-256 for the full
cumulative source list. The generator changes no ref, index, or main checkout.

They include all Stage 6A new product files and the cumulative Stage 1–6A tracked
changes relative to `4f353d9`; dependencies, dist, target, temporary logs,
screenshots and credentials are excluded. Do not copy only HEAD.
