# Stage 5: bounded tool scheduling

Implementation worktree: `C:/Users/zhengbiwen/.codex/worktrees/135f/ShellSpan`.
Baseline HEAD: `4f353d9bbfa2c6ccfe75a1023f4df46ab4fb8412`. No commits or merges.

## Baseline

The authoritative stage 3B source is `C:/Users/zhengbiwen/.codex/worktrees/c8a3/ShellSpan`. Its actual Git status and `.phase3b-evidence/stage3b-files.json` agreed on 32 tracked modifications and 15 untracked product/documentation files. All 47 files were copied byte-for-byte, including Provider/retry JSON, TypeScript, Rust, tests and earlier stage documents. Source and destination HEADs matched; all initial SHA-256 pairs and the complete tracked diff matched. `.phase5-evidence/baseline.json` records that inventory. No source evidence scripts, dependencies or caches were copied.

The source, main workspace and Harness are read-only. Only the explicitly authorized generated directory `fd30/ShellSpan/src-tauri/target` is reused, through command-scoped `CARGO_TARGET_DIR`. Rust commands use `1.95.0-x86_64-pc-windows-msvc`; no global/repository toolchain was changed. Generated schema files in this worktree are restored to source bytes after validation.

## Admission, execution and ordered results

`AgentToolPipeline::process_model_calls` uses a rolling pool of owned blocking-worker joins. A completion frees one slot immediately; an earlier blocked call does not prevent a later safe call from filling it. Completed results wait in a model-indexed map, and only its contiguous prefix runs lifecycle finalization and appends result/artifact/context events. This preserves the model's order without waiting for fixed batches.

The default is **4 in-flight native calls per Session scheduling invocation**, chosen to bound local blocking threads and SSH requests. The desktop Runtime's ordinary `configure` path reads `SHELLSPAN_MAX_PARALLEL_TOOL_CALLS`; accepted values are decimal integers **1–16**. An absent value selects 4; 1 is serial. Empty, signed, fractional, whitespace-padded, overflowing and out-of-range values fail configuration. The cap is captured when processing a set of model calls and is shared with child pipelines through the same configured runtime. It does not authorize tools, change Fleet limits or derive permission from a Provider's `parallel_tool_calls` wire flag.

Native descriptor parallel safety, read-only effect, idempotency, exclusivity, target and capability restrictions remain authoritative. Writes, approvals, orchestration and `update_plan` are barriers. No later body starts before a barrier completes. With earlier workers in flight, native preparation probes classification without lifecycle hooks, and immediately abandons its registry token. A barrier drains before its actual `before_tool` admission. It is prepared again against current policy, rather than retaining a lookahead authorization.

Each actual admission invokes `before_tool` once. A preceding `after_tool` may therefore revoke a later barrier before that barrier's hook runs. If the admission hook itself changes a provisionally parallel call to exclusive/approval-required while siblings are running, the scheduler drains and records a rejection asking for a fresh call; it does not reuse the earlier allow decision or repeat the hook. Native preparation performs validation/preview and registration; capability issuance and tool execution still occur only after durable dispatch.

Prepared-token leases clean up invalid preparation, probes, capability denial, cancellation, failed event writes and worker panic. Pending approvals retain their own lease. Approval/resume rechecks native preparation and delegated scope without another lifecycle admission or budget charge. Frozen call drift is rejected before dispatch.

## Child budgets

One durable `tool/call` reserves one admitted attempt. This covers running calls, settled-but-uncommitted calls, pending approvals, Session/orchestration calls and ordinary schema/policy preparation rejections. The single admission owner checks the durable count before each candidate; preparation is synchronous, so no second owner can spend an unrecorded reservation. Approval completion/recovery consumes the existing reservation, and remaining calls go through the same admission check.

Budget exhaustion drains previously started work, records the remaining calls as not started, and fails the child. An exact fit completes normally. A schema rejection spends its accepted attempt, while a hook infrastructure failure stops admission. Synthetic pairs have `native_name = None`, rejected result status and structured `schedulerAdmission: "notStarted"` data with a reason. These pairs do not count toward the budget. Native tool output cannot forge this exemption because admitted native/Session/orchestration calls carry a native name. Inspection and driver budget enforcement use the same counting helper.

## Cancellation, failures and recovery

Cancellation stops replenishment, joins every started worker, finalizes their actual outcomes in order and records explicit not-started pairs for remaining model calls. Rejected is the existing Session contract's pre-approval terminal result; its structured reason distinguishes cancellation, budget exhaustion and scheduler failure. No synthetic success or dispatch is emitted for skipped work.

Approval cancellation no longer emits a result while the worker is still running. Its decision owner joins and records the real outcome; parent/child cancellation waits for that owner before Session teardown. A recovered authorization may be cancelled before dispatch with a matching terminal approval/result, without inventing an execution.

Ordinary tool failures remain ordered tool results. Hook infrastructure errors, worker panics and artifact/event failures stop admission and drain all already-started work before reporting the first error. A worker failure is detected immediately even when an earlier model-order result is blocked. Already committed evidence is retained. A failed finalization leaves its dispatch without a fabricated result; later unstarted calls receive explicit pairs when storage permits.

The driver closes the step into a waiting reconciliation state and preserves the open turn. If storage cannot even write the recovery notice, memory admission remains blocked and the existing durable dispatch markers remain the recovery authority. Restart does not replay these bodies. Recovery prioritizes **all unresolved dispatches ahead of later completed/skipped siblings**. Authorized-before-dispatch recovery is blocked while any unresolved dispatch requires reconciliation, and restored remaining-call lists exclude calls with durable results. An approval that expired while the process was absent terminates its queued siblings explicitly.

Cancellation is cooperative: a worker that ignores cancellation keeps its owner waiting until it actually exits. The scheduler does not claim that dropping a future, timing out an observer or cancelling a token has stopped native work.

## Tests and reference

The read-only comparison was Harness `packages/core/agent-loop/src/tool-calls.ts`, its complete `tests/tool-calls.spec.ts`, `src/index.ts`, package README and root README. Harness defaults to 10; ShellSpan keeps the smaller desktop default above.

`scheduler_tests.rs` uses per-call condition variables, start channels, event/hook notifications and an explicit scheduler-failure observation signal. Timeouts only detect deadlocks; ordering assertions do not depend on sleeps. Tests exercise rolling replacement with the first result blocked, reverse completion, default/serial caps, all barrier families, live classification and hook changes, mixed child budgets and approvals, cancellation admission/worker/result boundaries, token cleanup, result/artifact/dispatch storage failures, total store outage, worker panic, ordered failure recovery and pre-dispatch cancellation after restart. The original adjacent-read/write test is retained and additionally invokes the deterministic barrier matrix.

The retained backoff-cancellation test previously polled only 100 yields; under the larger parallel suite it could cancel before the first request. It now waits for a published `request/retry` notification, with the same behavioral assertions.

`pnpm test:ai:stage5` is the dedicated script/CI gate. It checks the included test file's formatting and runs the scheduler, original barrier, approval cancellation and recovery/restart filters. Earlier stage gates remain present. See `ai-runtime-stage5-validation.md` for final commands, results and migration inventory.

Stage 6 interfaces and final integration/acceptance remain outside this stage. No paid live calls or credentials from another project were used.
