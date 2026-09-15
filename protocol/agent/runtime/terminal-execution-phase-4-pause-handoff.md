# Terminal Execution Phase 4 Pause Handoff

Paused: 2026-09-15 (Asia/Shanghai)

## Current state

- Overall objective: deliver the roadmap's three explicit capabilities in sequential, phase-specific Codex sessions: reliable Direct execution, real visible command execution in a PTY, and interactive terminal operation.
- Phase 0 is complete in session `01a0a2d3-ea0c-77e1-b47d-ceda5d892fc3`.
- Phase 1 is complete in session `01a0a2ee-f8ad-72e1-8745-32ef2b48037d`.
- Phase 2 is complete in session `01a0a304-aba8-77a0-bb6a-1679805d3c61`, with native Windows evidence waived/deferred.
- Phase 3 is complete in session `01a0a3a5-747a-7af2-b6ec-392a60141fed`, with native Windows evidence waived/deferred.
- Phase 4 session `01a0a461-d04c-7d33-ba24-d2d314c773d8` initially passed its remote POSIX gate, but an independent lifecycle/resource review reopened it.
- Phase 4 is now **PAUSED / NOT READY**. Do not open Phase 5 until the remediation below is complete and verified.
- The roadmap tracker and Phase 4 acceptance file still contain the earlier pre-review `complete` / `PASS` wording. This handoff supersedes those gate statements until Phase 4 is repaired and re-accepted.

The resumed Phase 4 Codex process was interrupted and exited. No implementation or test process is intentionally left running.

## Reopened Phase 4 findings

1. `NativeToolAdapter::ensure_remote_agent_terminal` can leak a newly created Agent SSH candidate when readiness becomes degraded, unavailable, invalidated, disappears, snapshotting fails, or times out. Cancellation must close only a candidate created by the current call; it must not close a healthy pre-existing terminal owned by another waiter.
2. `run_ssh_session` creates `RemoteSshShellIntegration` resources before several fallible setup and publish operations. Early returns from SSH channel creation, PTY request, extended-data configuration, runtime lookup, or status/event publication need explicit cleanup of the remote temporary root, files, FIFO/control channel, and local registrations.
3. A successful generation replacement closes the Broker record but can leave the predecessor `SessionManager` SSH worker/channel alive. A failed candidate must preserve a usable predecessor; only a successfully attached, promoted, and published candidate may cause the predecessor to be closed and removed.
4. The SSH worker can report connection success before integration registration/setup and status publication have fully succeeded. Candidate readiness/promotion must occur only after all required setup succeeds, using an atomic latest-mapping/predecessor check.

## Partial, unverified edit at pause

The reopened session made only a partial change in `src-tauri/src/models.rs` before it was stopped. The current file contains:

- separate Agent remote candidate registration via `insert_agent_remote`;
- `promote_agent_remote` with an expected-predecessor check;
- `rollback_agent_remote_promotion`;
- Agent remote registration cleanup from `close` and `remove`; and
- unit-test drafts for candidate preservation, replacement promotion, predecessor close, and rollback.

This is not a complete fix. It has not yet been reconciled with `commands.rs`, `session.rs`, `native_adapter.rs`, Broker publication, or all early-return cleanup paths. It may not compile or satisfy the intended races. Treat it as work in progress, not accepted behavior.

No tests were run after this partial edit. The last `git diff --check` at pause passed, but that is only a whitespace check.

## Historical baseline before the review reopened Phase 4

These results describe the earlier Phase 4 implementation and must not be treated as validation of the current partial remediation:

- `pnpm test:terminal-visible:ssh`: passed for real Alpine sshd bash/zsh PTYs, explicit unsupported `/bin/sh`, Direct SSH regression, and compose cleanup.
- Full Rust suite: 772 passed, 31 ignored, plus 5 integration probes.
- Full frontend suite: 200 files passed, 1 skipped; 1,823 tests passed, 1 skipped.
- `pnpm build`: passed with 2,806 modules.
- Rust formatting/all-target checks, include checks, AI style, LLM catalog, and diff check passed.

Native Windows/ConPTY with Windows PowerShell 5.1 and PowerShell 7 remains **MISSING**, not `PASS`, by explicit user deferral. It does not prevent resuming the POSIX Phase 4 remediation, but it remains a hard prerequisite for Phase 6 default enablement or legacy-wrapper removal.

## Pause integrity checks

At pause time:

- `git diff --check` passed.
- The Git index had no staged changes.
- No commit, tag, or push was created.
- The four protected Agent Runtime test files had no diff:
  - `src-tauri/src/agent_runtime/image_tests.rs`
  - `src-tauri/src/agent_runtime/runtime_archive_tests.rs`
  - `src-tauri/src/agent_runtime/runtime_loop_guard_tests.rs`
  - `src-tauri/src/agent_runtime/session_inbox_steer_tests.rs`
- `src-tauri/vendor/portable-pty/` had no diff.
- `docker compose -f tests/ssh-e2e/compose.yml ps --all` showed no fixture containers.
- The worktree contains many modified and untracked Phase 0-4 files. They are intentionally uncommitted.

## Moving to another machine

The current implementation exists only in this dirty worktree. Git commits were not authorized or created, so checking out the repository on another machine will not reproduce it. Copy or synchronize the entire working directory, including untracked files, before continuing. A normal `git diff` patch alone is insufficient because this work includes untracked files.

Codex session state may also be machine-local. If session storage is synchronized, resume the same Phase 4 session:

```bash
cd /path/to/ShellSpan
git status --short
git diff --check
codex exec resume 01a0a461-d04c-7d33-ba24-d2d314c773d8 --json --dangerously-bypass-approvals-and-sandbox -
```

If that session ID is unavailable on the other machine, create a replacement **Phase 4 continuation** session rather than Phase 5. Give it this handoff, the roadmap, the Phase 4 acceptance record, and the root `AGENTS.md`; then record both the original and continuation session IDs in the final Phase 4 evidence.

## Recommended resume order

1. Read the root `AGENTS.md`, `terminal-execution-roadmap.md`, `terminal-execution-phase-4-acceptance.md`, and this handoff.
2. Inspect and reconcile the partial `src-tauri/src/models.rs` candidate/promotion API before extending it.
3. Add scope-bound cleanup for every newly created candidate and every fallible SSH integration setup path.
4. Delay connection success/readiness until integration registration, setup, status publication, Broker attach, and atomic promotion are complete.
5. Preserve the predecessor on every failed candidate path; close/remove it only after successful replacement publication.
6. Add focused regression tests for leaks, cancellation ownership, early-return cleanup, atomic predecessor races, failed-candidate preservation, and successful predecessor shutdown.
7. Run focused Rust tests, the real SSH fixture, then the full Rust/frontend/build and repository checks proportional to the final diff.
8. Update the Phase 4 acceptance evidence and roadmap back to `PASS` / `complete` only after the remediation gate passes. Phase 5 remains unopened until then.
