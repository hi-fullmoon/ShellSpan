# Stage 4 validation and handoff

Implementation worktree: `C:/Users/zhengbiwen/.codex/worktrees/fd30/ShellSpan`.
Baseline HEAD: `4f353d9bbfa2c6ccfe75a1023f4df46ab4fb8412`.

## Results

| Gate | Result | Local evidence |
| --- | --- | --- |
| Baseline migration | 20 tracked files + untracked `retry.rs`; initial binary diffs identical; all 21 source SHA-256 hashes still match at completion | `.phase4-evidence/migration.json`, `read-only-verification.json` |
| Full Rust library, `1.95.0-x86_64-pc-windows-msvc`, locked | **490 passed, 20 ignored** | `rust-lib.log` |
| Retained stage 3 gate, includes stages 1–2 | **21 AI tests + 147 Runtime tests passed**, 9 explicit live ignores | `stage3-rust.log` |
| Stage 4 Rust gate | **3 contract + 23 model + 14 compaction tests passed**, 9 explicit live ignores | `stage4-rust.log` |
| Stage 4 frontend | **51 passed** across 4 files | `focused-front.log` |
| Full `pnpm test -- --maxWorkers=2` | **1,397 passed** across 163 files | `frontend.log` |
| Retained frontend Runtime gate | **74 passed** across 8 files | `runtime-front.log` |
| Script tests | **29 passed** across 6 files | `scripts-front.log` |
| `pnpm build` | **Passed**; existing bundle-size advisory only | `build.log` |
| `cargo clippy --all-targets --locked -- -D warnings`, MSVC 1.95.0 | **Passed** | `clippy.log` |
| `cargo fmt --all -- --check`, MSVC 1.95.0 | **Passed** | `fmt-check.log` |
| `git diff --check` | **Passed** | `diff-check.log` |
| Live provider smoke | **0 executed, 8 skipped**: this project has no `.env.local` or configured `SHELLSPAN_LIVE_*` inputs | `live.log` |

The full frontend gate was followed by focused contract/UI/Runtime/script checks and a fresh build after the final small contract/UI updates. The full Rust gate, retained stage 3, stage 4 and Clippy were rerun after the final cancellation/provenance changes. The Rust toolchain was explicitly selected through `+1.95.0-x86_64-pc-windows-msvc` or a command-scoped `RUSTUP_TOOLCHAIN`; the repository's GNU override was not changed.

The model tests exercise real local HTTP/SSE request bodies for every profile and all three protocols, reasoning-only Qwen output, tool calls, usage, opaque MiniMax details, DeepSeek non-tool-turn reasoning history, unsupported fields, and shared frontend fixtures. Compaction tests cover valid/invalid/empty/failing/partial/oversized responses, usage budget, cancellation, deadline, >100 KiB source, early constraints, tail revocation, repeated compaction after restart, true budget exhaustion, and cancellation after artifact creation before checkpoint commit.

No real API behavior is claimed from skipped live tests. The 45-second summary deadline is an explicit operational limit; normal long reasoning can reach it. Failed/incomplete/over-budget summaries retain the current Surface and record attempt evidence instead of committing lossy extraction. See [the implementation contract](ai-runtime-stage4.md) for limits and sources.

## Stage 4 product files

New product/documentation files:

- `src/lib/provider-contract.json`
- `src/lib/provider-contract.ts`
- `src/lib/__tests__/provider-contract-fixtures.json`
- `src/lib/__tests__/provider-contract.test.ts`
- `src-tauri/src/agent_runtime/provider.rs`
- `docs/ai-runtime-stage4.md`
- `docs/ai-runtime-stage4-validation.md`

Changed in stage 4:

- `.github/workflows/quality-gate.yml`, `package.json`, `scripts/agent-provider-live-smoke.mjs`
- `src-tauri/src/ai.rs`
- `src-tauri/src/agent_runtime/{budget,compaction,driver,mod,model,runtime,registry,subagent}.rs`
- `src/types/ai.ts`, `src/lib/ai-reasoning.ts`
- `src/stores/aiSettingsStore.ts`, `src/stores/__tests__/aiSettingsStore.test.ts`
- `src/components/ai/{provider-setup-dialog,ai-settings-section}.tsx`
- `src/components/ai/__tests__/provider-setup-dialog.test.tsx`
- `src/locales/{en-US,zh-CN}.ts`

`registry.rs` and `subagent.rs` only require the new optional config field in existing test constructors. The inherited untracked `src-tauri/src/agent_runtime/retry.rs` remains byte-identical to stage 3 and must be included in any later migration. Twelve baseline files remain byte-identical to the handoff; nine baseline files were extended in stage 4. The detailed manifest is `.phase4-evidence/stage4-files.json`.

`.phase4-evidence/` is temporary local evidence, including non-idempotent construction scripts; it is not application source. Do not blindly migrate it with the product changes. Build-generated schema content was checked against HEAD and its original line-ending representation restored; it has no product diff. `src-tauri/target` and installed frontend dependencies are retained for future local builds.

## Read-only sources and remaining stages

`fed7` was never written: all 21 handoff content hashes and its HEAD were rechecked. The Harness was only read; its initial and final Git status are clean. The initial empty PowerShell status pipeline produced no file, so the final verification explicitly documents that detail rather than treating a nonexistent snapshot as a hash record. The new remediation checklist in `D:/Developer/ShellSpan` was not copied or modified.

The existing adjacent parallel grouping remains unchanged. Stage 5 owns the bounded rolling pool, scheduling budgets and ownership/order/cancellation rules. Stage 6 still owns attachment/skill UI and remaining Harness capabilities. No commits, merges, production deployment or credential changes were performed.
