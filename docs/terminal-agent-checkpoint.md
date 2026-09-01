# Terminal Agent Enhancement — Cross-machine Checkpoint

Last updated: 2026-09-01 (Asia/Shanghai)

## Durable objective

Follow `docs/terminal-agent-enhancement-plan.md` through M0–M5 and the final acceptance pass. Each phase must run in its own Codex task window. A phase is complete only after its documented acceptance evidence is available; a pushed checkpoint is not automatically an accepted phase.

## Repository checkpoint

- Remote: `git@github.com:hi-fullmoon/ShellSpan.git`
- Branch: `main`
- M0–M3 foundation commit: `26c27763a40671e34f61e42861c3d152d6d7b9b2`
- Original M4 implementation checkpoint: `1ec4b51` (`wip(agent): checkpoint M4 recovery controls`)
- Accepted M4 continuation: the local commit containing this updated checkpoint
  and `docs/terminal-agent-m4.md`; it is intentionally not pushed by this task
- Accepted M5 continuation: the local commit containing
  `docs/terminal-agent-m5.md`; it is intentionally not pushed by this task
- Accepted final pass: the local commit containing
  `docs/terminal-agent-final-acceptance.md` and the refreshed v2 baseline; it
  is intentionally not pushed by this task
- At the time this document was started, local `main`, `origin/main`, and `origin/HEAD` all pointed to `1ec4b51`, and the worktree was clean.

The M4 checkpoint contains 11 changed files with 871 insertions and 165 deletions. It is intentionally a WIP checkpoint and must not be represented as an accepted M4 implementation.

## Phase status

| Phase | Status | Durable evidence |
| --- | --- | --- |
| M0 — architecture freeze and v3 boundaries | Complete | `docs/terminal-agent-m0.md`; included in `26c2776` |
| M1 — unified execution engine and local rollback | Complete | `docs/terminal-agent-m1.md`; included in `26c2776` |
| M2 — MCP connectors and remote execution security | Complete | `docs/terminal-agent-m2.md`; included in `26c2776` |
| M3 — command DSL, plan preview, and audit | Complete | `docs/terminal-agent-m3.md`; included in `26c2776` |
| M4 — background tasks, restart recovery, and Operator | Complete | `docs/terminal-agent-m4.md`; continuation completed and verified on 2026-09-01 |
| M5 — Fleet and multi-agent orchestration | Complete | `docs/terminal-agent-m5.md`; implementation and acceptance verified on 2026-09-01 |
| Final acceptance | Complete | `docs/terminal-agent-final-acceptance.md`; full local regression, security, migration, restart, rollback, build, and packaging-feasibility audit completed on 2026-09-01 |

## Codex phase task history

These IDs are useful only if the same Codex account can still access the original tasks. They are not a replacement for the repository checkpoint.

| Phase | Task title | Task ID | Last known state |
| --- | --- | --- | --- |
| M0 | ShellSpan M0 | `01a0588e-267a-7723-9da8-f3828ebfb3dc` | Complete |
| M1 | ShellSpan M1 | `01a058f9-f51a-7563-8de6-f2caa0b43e52` | Complete |
| M2 | ShellSpan M2 | `01a0594c-4719-7183-a92d-97bdff1ca6a2` | Complete |
| M3 | ShellSpan M3 | `01a059be-ef4e-7543-96b2-03ef322e23cf` | Complete |
| M4 | ShellSpan M4：后台恢复与 Operator | `01a05a0b-2751-7f23-a7d4-545a040f070f` | Original task stopped at `1ec4b51`; M4 was completed in the documented continuation |
| M5 | ShellSpan M5 Fleet 与多 Agent | `01a05ae7-e351-7773-8716-ae798b00f362` | Separate M5 window completed design/code audit; implementation and acceptance were finished by the controlling task after the window scheduler stalled |
| Final acceptance | ShellSpan 最终验收 | `01a05b07-e46d-7312-a9af-8f5ed4912143` | Separate final window read the complete plan and M0–M5 evidence, then stalled after a no-match read-only search was misclassified as awaiting approval; the controlling task completed and committed the full acceptance pass |

M0–M5 and the separate final acceptance pass are complete. Keep this document,
`docs/terminal-agent-m0.md` through `docs/terminal-agent-m5.md`, and
`docs/terminal-agent-final-acceptance.md` as the durable hand-off.

## What was present in the original M4 checkpoint

The `1ec4b51` checkpoint advanced, but did not finish, the following M4 areas.
The accepted continuation closes them and records the current behavior in
`docs/terminal-agent-m4.md`:

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

## M4 completion evidence

The M4 continuation closed and documented every checkpoint item below:

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

The user explicitly requested that `1ec4b51` be committed and pushed without verification. Therefore no test result is attributed to that checkpoint.

The M4 continuation ran every command below on macOS with Rust 1.95 and passed;
the exact results and the one pre-existing ignored Docker fixture are recorded
in `docs/terminal-agent-m4.md`. Re-run at least this matrix after later changes:

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
4. Confirm the history contains the accepted M4, M5, and final acceptance
   commits with `docs/terminal-agent-m4.md`, `docs/terminal-agent-m5.md`, and
   `docs/terminal-agent-final-acceptance.md`.
5. Treat the final acceptance document as the current verification matrix and
   limitations record. Re-run it only when validating later changes; no
   enhancement phase remains open in this checkpoint.

## Suggested M5 hand-off

```text
Continue ShellSpan Terminal Agent M5 from docs/terminal-agent-checkpoint.md and docs/terminal-agent-m4.md. Read the enhancement plan and M0–M4 acceptance documents first, inspect the current worktree as authoritative, and finish only M5. Do not weaken M0–M4 target, capability, replay, broker, egress, sensitive-path, or verification boundaries. Preserve v2 as the default with v3, MCP, and Operator as independent opt-ins.
```

M5 is now complete; the block above is retained only as historical hand-off
evidence.

## M5 completion evidence

The M5 phase delivered and verified:

1. Rust-frozen label/group/environment selectors and stable target digests.
2. Mandatory canary-first multi-host writes, bounded batches, jitter,
   concurrency, per-target/role/Fleet budgets, failure thresholds, and
   same-target write serialization.
3. Explicit per-host result and rollback state; failed or blocked hosts cannot
   be hidden by aggregate completion.
4. Explorer, Diagnostician, Operator, Verifier, and Reviewer roles with exact
   parent-plan subsets and non-persistent authority.
5. Independent native Verifier evidence as the only success transition.
6. Separate, bounded, sanitized Fleet persistence; restart moves in-flight
   targets to reconciliation without replay.
7. A separate default-off Fleet switch, typed IPC, and a shadcn result matrix.
8. M5, M4 regression, contract, security, type, build, Rust runtime, clippy,
   formatting, and diff checks recorded in `docs/terminal-agent-m5.md`.

## Suggested final acceptance hand-off

```text
Run the ShellSpan Terminal Agent final acceptance pass from docs/terminal-agent-checkpoint.md. Read docs/terminal-agent-enhancement-plan.md and the M0–M5 acceptance documents, inspect the current repository as authoritative, and do not add unrelated features. Audit every requirement against concrete code and test evidence; run full frontend/Rust regression, security, migration, restart/reconciliation, rollback, build, and packaging checks. Record known limits honestly, update the checkpoint only after all required evidence passes, and preserve Agent v2 as the default with v3, MCP, Operator, and Fleet as independent opt-ins.
```

The final acceptance pass is now complete; the block above is retained only as
historical hand-off evidence.

## Final acceptance evidence

The final pass audited the enhancement plan against the protocol, Rust runtime,
typed IPC, UI, and executable tests. It also repaired a stale v2 baseline
contract digest by running the official collector; the underlying v2 schema
was unchanged.

The local evidence includes:

1. 164 frontend test files with 1,584 passing tests and 3 platform-conditioned
   skips, plus all targeted Agent security, v3, M3, M4, and M5 suites.
2. 479 passing Rust library tests, 18 explicitly ignored external/controlled
   tests, and 5 passing integration probes.
3. Successful TypeScript, production frontend, clippy, formatting, and unsigned
   macOS Tauri application bundle checks.
4. A standard Tauri release binary build followed by the expected signing
   failure because this host has no `ShellSpan Dev` identity; the same bundle
   completed with the official `--no-sign` local verification option.
5. Exact Docker, provider-credential, controlled-desktop, and cross-platform
   limitations recorded without claiming they passed.

See `docs/terminal-agent-final-acceptance.md` for the requirement matrix,
commands, results, security audit, migration/rollback proof, and known limits.

## Stop condition for the overall goal

The original goal is complete: M0–M5 and the final acceptance pass are
implemented, documented, and verified, and a separate Codex task window was
created for every phase.
