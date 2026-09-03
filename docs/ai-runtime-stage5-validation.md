# Stage 5 validation and handoff

Authoritative worktree: `C:/Users/zhengbiwen/.codex/worktrees/135f/ShellSpan`.
HEAD: `4f353d9bbfa2c6ccfe75a1023f4df46ab4fb8412`. No commits or merges.

## Commands and results

Rust commands use command-scoped `RUSTUP_TOOLCHAIN=1.95.0-x86_64-pc-windows-msvc` and `CARGO_TARGET_DIR=C:/Users/zhengbiwen/.codex/worktrees/fd30/ShellSpan/src-tauri/target`. This is the sole authorized write outside this worktree. It reuses the previous compiled dependencies, including OpenSSL, without modifying fd30 source or schemas.

| Command | Result | Temporary evidence |
| --- | --- | --- |
| Baseline status/manifest/HEAD/diff/SHA-256 comparison | All 47 files matched; 32 tracked + 15 untracked product files; initial tracked diff identical | `baseline.json` |
| `pnpm install --frozen-lockfile` | Passed; local dependencies installed, lockfile unchanged | `install.log` |
| `pnpm test:ai:stage5` | 17 scheduler tests, retained adjacent-read/write test, 2 recovery tests, 2 approval-barrier filters, approved-cancellation test and 9 restart filters passed | `stage5-final.log` |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib --locked scheduler_tests` × 3 | 17 passed on each consecutive final run | `scheduler-repeat-1.log` through `scheduler-repeat-3.log` |
| `pnpm test:ai:stage3` | 74 frontend + 21 AI + 179 Runtime passed; 9 explicit live ignores | `stage3-final.log` |
| `pnpm test:ai:stage4` | 54 frontend + 3 Provider + 23 model + 17 compaction passed; 9 explicit live ignores | `stage4-final.log` |
| `pnpm test:ai:stage3b` | 57 frontend + 55 runtime + 6 retry + 1 child restoration + 17 compaction passed | `stage3b-final.log` |
| `pnpm test -- --maxWorkers=2` | **1421 passed**, 165 files | `frontend.log` |
| `pnpm build` | Passed; existing bundle-size advisory | `build.log` |
| `pnpm test:scripts` | 29 passed, 6 files | `scripts.log` |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib --locked` | **522 passed, 20 ignored** | `rust-lib-final.log` |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings` | Passed | `clippy-final.log` |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check` | Passed; stage 5 script also checks included scheduler test formatting directly | `fmt-final.log` |
| `git -c core.safecrlf=false diff --check` | Passed | `diff-check.log` |
| Read-only source integrity | All 47 initial source content hashes and source HEAD/status retained; Harness remained clean | `read-only-verification.json` |

All evidence files above reside in `.phase5-evidence/`. Intermediate logs are diagnostic failures or partial runs, not acceptance evidence. The initial scheduler compilation caught a test-only unbound synchronization guard. Subsequent focused tests found an asynchronous child-start assertion and a simulated-restart test that incorrectly shared the old process's native registry. The tests now wait for child settlement and instantiate a fresh registry. Fault tests wait for the scheduler's explicit failure-observed notification before releasing the remaining worker, and check both zero later admissions and token cleanup. They do not infer failure ordering from simultaneous releases.

The retained stage 3B backoff-cancellation test failed under the expanded concurrent suite because 100 task yields could end before the first request. Its existing outcome assertions remain; a published retry notification now determines when cancellation occurs. No test expectations were weakened to allow dispatch after cancellation/failure.

No paid Provider live request was executed. Existing ignored tests remain ignored rather than reported as passes, and no credentials were taken from other projects.

## Behavioral evidence

- The rolling-pool test holds call zero while completing a later call and waits for the next call to start before releasing zero. It verifies the actual peak for default 4, limit 2 and serial 1, and ordered final results.
- The barrier matrix covers read/read → write, Session `update_plan`, and orchestration → read. It also strengthens the original `adjacent_parallel_reads_preserve_model_order_and_stop_at_write_barriers` test.
- Dynamic tests change native classification from an earlier committed after hook, covering exclusive and approval-required downgrades. A separate test changes a later barrier's before-hook policy; that hook runs once, sees the change and rejects the call.
- Budget tests cover one remaining admission, exact exhaustion, schema failure and mixed native/Session/orchestration calls. Child approval admission remains charged once through resolution; a following call is rejected without execution. Parent/child cancellation keeps scope restrictions and uses actual worker settlement.
- Cancellation is injected after assistant commit, inside before-hook admission, while two workers are blocked, and during ordered completion. Remaining calls have explicit rejected/not-started pairs and no native execution.
- Fault tests cover after-hook failure, early and late worker panic, dispatch-event failure, result-event failure, artifact-directory failure and complete store outage. Even with unavailable storage, started workers are joined and durable dispatch evidence remains uncertain. Restart and explicit resume do not replay those bodies.
- Pending approval cancellation waits for the executing decision owner. Recovered authorization can also be cancelled before dispatch without executing or leaking its token.

## Migration inventory

Migrate the **53 cumulative product/documentation files** listed with SHA-256 in `.phase5-evidence/stage5-files.json`: **34 tracked modifications and 19 untracked files**. The manifest records each final hash, its inherited stage 3B source hash where applicable, and whether this stage changed it. It includes every Provider/retry file and all earlier stage documents.

New product/documentation files introduced here:

- `src-tauri/src/agent_runtime/scheduler_tests.rs`
- `scripts/ai-runtime-stage5.mjs`
- `docs/ai-runtime-stage5.md`
- `docs/ai-runtime-stage5-validation.md`

Existing cumulative files changed in this stage are `tool_pipeline.rs`, `recovery.rs`, `driver.rs`, `runtime.rs`, `session.rs`, `subagent.rs`, `package.json`, the quality-gate workflow and the remediation checklist. No frontend product behavior was changed in stage 5. Generated schema bytes were restored after validation and are excluded from the migration inventory.

Do not migrate `.phase5-evidence/`, `node_modules/`, `dist/`, generated caches or Rust targets as product changes. Temporary evidence is listed separately in `.phase5-evidence/temporary-files.json`; it includes baseline/final manifests, logs and integrity reports.

The next phase should use **135f** as its authoritative cumulative source. Stage 6, final integration into the main workspace and the total Goal remain unfinished. The final acceptance checkboxes in the remediation plan remain open.
