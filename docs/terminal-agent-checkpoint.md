# Terminal Agent Enhancement — Cross-machine Checkpoint

Last updated: 2026-09-01 (Asia/Shanghai)

## Durable objective

Follow `docs/terminal-agent-enhancement-plan.md` through M0–M5 and the final acceptance pass. Each phase must run in its own Codex task window. A phase is complete only after its documented acceptance evidence is available; a pushed checkpoint is not automatically an accepted phase.

## Repository checkpoint

- Remote: `git@github.com:hi-fullmoon/ShellSpan.git`
- Branch: `main`
- M0–M3 foundation commit: `26c27763a40671e34f61e42861c3d152d6d7b9b2`
- Latest M4 implementation checkpoint: `1ec4b51` (`wip(agent): checkpoint M4 recovery controls`)
- At the time this document was started, local `main`, `origin/main`, and `origin/HEAD` all pointed to `1ec4b51`, and the worktree was clean.

The M4 checkpoint contains 11 changed files with 871 insertions and 165 deletions. It is intentionally a WIP checkpoint and must not be represented as an accepted M4 implementation.

## Phase status

| Phase | Status | Durable evidence |
| --- | --- | --- |
| M0 — architecture freeze and v3 boundaries | Complete | `docs/terminal-agent-m0.md`; included in `26c2776` |
| M1 — unified execution engine and local rollback | Complete | `docs/terminal-agent-m1.md`; included in `26c2776` |
| M2 — MCP connectors and remote execution security | Complete | `docs/terminal-agent-m2.md`; included in `26c2776` |
| M3 — command DSL, plan preview, and audit | Complete | `docs/terminal-agent-m3.md`; included in `26c2776` |
| M4 — background tasks, restart recovery, and Operator | In progress; stopped at a pushed checkpoint | Partial implementation in `1ec4b51`; M4 acceptance document and current-checkpoint verification are still missing |
| M5 — Fleet and multi-agent orchestration | Not started | No M5 task or acceptance document yet |
| Final acceptance | Not started | No full regression/security/migration/rollback audit yet |

## Codex phase task history

These IDs are useful only if the same Codex account can still access the original tasks. They are not a replacement for the repository checkpoint.

| Phase | Task title | Task ID | Last known state |
| --- | --- | --- | --- |
| M0 | ShellSpan M0 | `01a0588e-267a-7723-9da8-f3828ebfb3dc` | Complete |
| M1 | ShellSpan M1 | `01a058f9-f51a-7563-8de6-f2caa0b43e52` | Complete |
| M2 | ShellSpan M2 | `01a0594c-4719-7183-a92d-97bdff1ca6a2` | Complete |
| M3 | ShellSpan M3 | `01a059be-ef4e-7543-96b2-03ef322e23cf` | Complete |
| M4 | ShellSpan M4：后台恢复与 Operator | `01a05a0b-2751-7f23-a7d4-545a040f070f` | Stopped and archived after the `1ec4b51` checkpoint |

If the M4 task is available on the new computer, unarchive and resume it. If it is not available, create one new M4 continuation task window and point it at this document; do not start M5 in that window.

## What is present in the M4 checkpoint

The checkpoint advances, but does not finish, the following M4 areas:

- versioned task persistence and recovery/reconciliation state;
- Operator scope, expiry, revocation, audit, and fallback handling;
- native broker authorization boundaries;
- network destination and sensitive-path policy propagation;
- background task center and recovery UI behavior;
- M4-related Rust, TypeScript, and UI test coverage.

The implementation checkpoint changed:

- `src-tauri/src/agent_runtime_v3/commands.rs`
- `src-tauri/src/agent_runtime_v3/m4.rs`
- `src-tauri/src/agent_runtime_v3/mcp.rs`
- `src-tauri/src/agent_runtime_v3/runtime.rs`
- `src-tauri/src/commands.rs`
- `src/components/ai/agent-m4-task-center.tsx`
- `src/components/ai/agent-run-view.tsx`
- `src/types/agent-v3.ts`
- related M3/M4 UI tests and `docs/terminal-agent.md`

## M4 work still required

Before marking M4 complete, audit the current code against the plan and close every gap below:

1. Confirm Rust remains the authoritative source for background task state, progress, phase, timestamps, targets, effects, failures, notifications, and recovery advice.
2. Prove persistence is versioned, atomic, bounded, redacted, migratable, and corruption-tolerant. Restart must distinguish safe recovery, reconciliation required, lost, cancelled, and complete.
3. Prove unknown or external writes are never automatically replayed and that capabilities, Operator grants, and broker grants never survive restart.
4. Revalidate local/remote targets, host keys, roots, rollout, policy, and permissions before continuation. Unknown state must be surfaced honestly.
5. Prove notification payloads are redacted for completion, failure, manual action, and Operator expiry.
6. Prove Operator is default-off, scoped, time-bounded, revocable, audited, and unable to bypass M0–M3 controls. Out-of-scope calls must fall back to per-call native approval.
7. Prove native credential/elevation broker grants are request/target/purpose bound, short-lived, single-use, revocable, audited, and never expose secrets to the WebView/model/logs/results/snapshots/notifications.
8. Prove network egress and sensitive-path policy participates in effect, approval, audit, recovery, and Operator decisions.
9. Keep v2 as the default and keep v3, MCP, and Operator as separate opt-ins.
10. Create `docs/terminal-agent-m4.md` with design boundaries, configuration, migration/recovery semantics, tests, limitations, and rollback.

## Verification status and required commands

The user explicitly requested that `1ec4b51` be committed and pushed without verification. Therefore no test result should be attributed to that checkpoint.

Earlier tests passed against an older intermediate state, but those results are not sufficient evidence for `1ec4b51`. On resume, run at least:

```powershell
pnpm test:agent:m4
pnpm test:agent:contract-v3
pnpm exec tsc --noEmit
pnpm build
cargo +1.95.0-x86_64-pc-windows-msvc test --manifest-path src-tauri/Cargo.toml --locked agent_runtime_v3::m4::tests
cargo +1.95.0-x86_64-pc-windows-msvc test --manifest-path src-tauri/Cargo.toml --locked agent_runtime_v3
cargo +1.95.0-x86_64-pc-windows-msvc clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings
cargo +1.95.0-x86_64-pc-windows-msvc fmt --manifest-path src-tauri/Cargo.toml --all -- --check
git diff --check
```

If the installed Rust toolchain does not accept `--manifest-path` for `cargo fmt`, run the equivalent from `src-tauri`:

```powershell
Push-Location src-tauri
cargo +1.95.0-x86_64-pc-windows-msvc fmt --all -- --check
Pop-Location
```

Record exact commands and results in `docs/terminal-agent-m4.md`. Do not infer broad completion from only targeted tests.

## Resume on another computer

1. Clone or open the repository, then synchronize the durable branch:

   ```powershell
   git switch main
   git pull --ff-only origin main
   git log -3 --oneline --decorate
   git status -sb
   ```

2. Confirm the history contains `1ec4b51` or a later descendant containing it.
3. Read, in order:
   - `docs/terminal-agent-enhancement-plan.md`
   - `docs/terminal-agent-m0.md`
   - `docs/terminal-agent-m1.md`
   - `docs/terminal-agent-m2.md`
   - `docs/terminal-agent-m3.md`
   - this checkpoint document
4. Resume or create only the M4 continuation task window. Tell it to inspect the authoritative current worktree, finish the M4 list above, create `docs/terminal-agent-m4.md`, and stop before M5.
5. Independently review M4 and run the full M4 verification list. Only then mark M4 complete.
6. Create a separate M5 task window for Fleet and multi-agent orchestration.
7. After M5 acceptance, create one final acceptance task window for full regression, security, migration, rollback, packaging, and requirement-by-requirement completion evidence.

## Suggested M4 continuation prompt

```text
Continue ShellSpan Terminal Agent M4 from docs/terminal-agent-checkpoint.md. Read the enhancement plan and M0–M3 documents first, inspect the current worktree as authoritative, and finish only M4. Close every remaining M4 acceptance gap, create docs/terminal-agent-m4.md, and run the complete verification list recorded in the checkpoint. Do not enter M5, do not claim completion without evidence, and preserve v2 as the default with v3/MCP/Operator as independent opt-ins.
```

## Stop condition for the overall goal

The original goal is complete only when M0–M5 and the final acceptance pass are all implemented, documented, and verified, with each phase performed in its own Codex task window.
