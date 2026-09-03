# Stage 3B validation and handoff

Authoritative worktree: `C:/Users/zhengbiwen/.codex/worktrees/c8a3/ShellSpan`.
HEAD: `4f353d9bbfa2c6ccfe75a1023f4df46ab4fb8412` (no commits or merges).

## Commands and results

All Rust commands use command-scoped `RUSTUP_TOOLCHAIN=1.95.0-x86_64-pc-windows-msvc` (or the equivalent explicit `cargo +1.95.0-x86_64-pc-windows-msvc`) and `CARGO_TARGET_DIR=C:/Users/zhengbiwen/.codex/worktrees/fd30/ShellSpan/src-tauri/target`. The repository toolchain and source code in fd30 are unchanged.

| Command | Result | Evidence in `.phase3b-evidence/` |
| --- | --- | --- |
| Baseline copy, HEAD/diff/SHA-256 comparison | 32 tracked + 8 untracked product files, plus the main-workspace checklist; 41 matching hashes and identical initial tracked diff | `baseline.json` |
| `pnpm test:ai:stage3b` | 57 frontend tests; initial focused Rust run 37 runtime + 6 retry + 1 child restoration + 17 compaction passed | `stage3b.log` |
| `pnpm test:ai:stage3b:rust` after test cleanup | 38 runtime + 6 retry + 1 child restoration + 17 compaction passed | `stage3b-rust-final.log` |
| `pnpm test:ai:stage3` | 74 frontend + 21 AI + 162 Runtime passed; 9 explicit live ignores | `stage3.log` |
| `pnpm test:ai:stage4` | 54 frontend + 3 Provider + 23 model + 17 compaction passed; 9 explicit live ignores | `stage4.log` |
| `pnpm test -- --maxWorkers=2` | **1421 passed**, 165 files | `frontend.log` |
| `pnpm test:scripts` | 29 passed, 6 files | `scripts.log` |
| `pnpm build` | Passed, existing bundle-size advisory | `build.log` |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib --locked` | **505 passed, 20 ignored** | `rust-lib-final.log` |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings` | Passed | `clippy-final.log` |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check` | Passed after test cleanup | `fmt.log` |
| `git diff --check` | Passed | `diff-check.log` |
| Read-only source verification | All 41 original content hashes and source HEAD match; Harness status clean | `read-only-verification.json` |

The full library and retained stage 3 gate include the additional parent-cancellation/child-backoff test added after the first stage 3B runtime subset. Frontend product code was unchanged after the complete test/build runs. The Clippy first pass found two test-only lint issues; the unit-variant pattern and test-module location were corrected without suppressing lint rules. The shadcn CLI failed with the existing SDK/zod `./v3` package-export error; existing local Field/Input components and their official documentation were used instead, with no dependency changes.

No paid Provider live request was executed. Existing ignored tests were not reclassified as passes, and no credentials were sourced from other projects. Real network coverage here uses ephemeral loopback HTTP servers with captured provider request bodies.

## Behavioral evidence

- `real_http_partial_sse_then_503_then_success_retains_audit_and_clean_history` sends partial text, reasoning and tool-argument SSE, truncates the HTTP body, returns 503 on the next request, then succeeds. Every transmitted history is identical; failed chunks remain logged; one successful assistant message and zero incomplete tool executions result.
- Runtime tests cover retry-disabled Providers, the final available attempt, repeated partial failure/exhaustion, terminal authentication failure, empty response, same step/series identity, separate request IDs, cancellation before retry/during wait/at ready response, configuration snapshot stability, child inheritance, and parent cancellation during child backoff.
- The previous-step write test records one actual mock native execution, retries the later model request, compares its histories and then reloads the durable store. The event prefix and Surface are stable, and neither the write nor the completed model request is replayed. Existing uncertain-side-effect restart and context-compaction tests remain passing.
- Frontend tests verify failure removes temporary reply/reasoning immediately, the successful stream and committed answer contain no duplicate draft, audit retains failed chunks, and replay is identical. Provider UI/store tests verify disabling retry, invalid-value blocking, persistence, migration, independent Provider values and detached request snapshots.
- Summary tests verify partial failure→success with a new request ID, disabled retry fallback, request/error provenance, cumulative input charging across retries and the unchanged total deadline. Existing >100 KiB semantic compaction, cancellation, invalid/empty/over-budget responses and checkpoint recovery tests pass.

## Product files and next migration

Migrate all 32 cumulative modified tracked files and 15 untracked product/documentation files from this worktree (47 files total). The final `.phase3b-evidence/stage3b-files.json` lists every path with SHA-256 and distinguishes inherited content from this stage. Do not migrate `.phase3b-evidence/`, generated caches or dependency directories as product changes. Build-generated schema files were restored byte-for-byte from the unchanged source and have no product diff.

New files introduced in this stage:

- `src/lib/retry-policy.json`
- `src/lib/retry-policy.ts`
- `src/lib/__tests__/retry-policy.test.ts`
- `src/lib/ai/__tests__/retry-projection.test.ts`
- `docs/ai-runtime-stage3b.md`
- `docs/ai-runtime-stage3b-validation.md`
- `docs/ai-runtime-harness-remediation-plan.md` (copied from main, then updated only here)

The eight untracked product/documentation files inherited from stage 4 remain mandatory, including `src-tauri/src/agent_runtime/retry.rs` and `provider.rs`. This stage also extends driver/model/Provider parsing, child descriptors and validation, summary retry handling, the two frontend projections, Provider types/store/dialog/locales/tests, and package/CI gates. Rust Provider test constructors gained the optional policy field.

Stages 5, 6 and final workspace integration remain unfinished. The remediation checklist's final acceptance boxes and total Goal are not marked complete. Stage 3B does not add an unbounded retry mode, replace parallel scheduling, or implement attachment/skill interfaces. Runtime restart continues to require explicit recovery for uncertain open work; this change only retries eligible live attempts safely inside their existing Session.
