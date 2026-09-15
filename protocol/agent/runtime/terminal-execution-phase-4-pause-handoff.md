# Terminal Execution Phase 4 Pause Handoff

Updated: 2026-09-15 (Asia/Shanghai)

## Current state

- Phase 0–3 remain complete under their recorded evidence and Windows waivers.
- Original Phase 4 session: `01a0a461-d04c-7d33-ba24-d2d314c773d8`.
- Lifecycle remediation continuation:
  `01a0a4cf-4ef0-71d2-8845-1ae963c3090a`.
- Migrated verification continuation:
  `01a0a4f2-3d68-78c3-b6f1-a39b18f6f03d`.
- The four independently reviewed lifecycle/resource findings are implemented
  and focused regression tests pass.
- Phase 4 is still **PAUSED / NOT READY** only because the pre-existing
  `check:rust:includes` formatting gate fails in extracted Agent Runtime test
  modules that this continuation is forbidden to modify.
- Phase 5 was not opened and remains blocked.
- Native Windows PowerShell 5.1, PowerShell 7, and ConPTY are **MISSING**, not
  `PASS`, by explicit user deferral. They remain a hard Phase 6 prerequisite.

The roadmap and Phase 4 acceptance record now reflect this current state; their
earlier pre-review PASS wording is no longer authoritative.

## Implemented remediation

1. **Candidate ownership and cancellation cleanup**
   - `ensure_remote_agent_terminal` records whether the current call created a
     candidate.
   - Cancellation, snapshot failure, missing/degraded/unavailable/invalidated
     integration, readiness timeout, and publication failure abort only that
     candidate.
   - A healthy or failing pre-existing terminal is never closed by a waiter
     that does not own it.

2. **Post-prepare SSH integration cleanup**
   - `run_ssh_session` scopes every operation after
     `RemoteSshShellIntegration::prepare` through one cleanup helper.
   - Channel creation, PTY request, extended-data setup, shell start, Broker
     attach, runtime lookup, integration registration/state publication,
     connected-status publication, and session-loop errors all close remote
     integration resources.
   - The SSH runner includes a real ignored regression that prepares a remote
     root, injects a later failure, and verifies removal.

3. **Replacement ownership and predecessor shutdown**
   - Broker replacement channels begin as independent provisional candidates;
     the predecessor remains current and usable while readiness is established.
   - Publication failure restores exact Broker and SessionManager predecessor
     mappings.
   - Successful event publication updates the latest mapping and only then
     sends `SessionCommand::Close` to and removes the predecessor worker.

4. **Delayed readiness and atomic predecessor mapping**
   - Connection success follows Broker candidate attachment, integration
     registration or explicit failure-state publication, connected status, and
     connected notification.
   - Production Broker promotion additionally requires `Ready` and
     `prompt_ready`.
   - Expected-predecessor checks reject stale competing candidates; a
     two-thread race proves exactly one ready promotion wins and the failed
     candidate can be aborted.

## Verification completed

- `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check`: **PASS**.
- Focused Broker tests: **20 passed, 0 failed**.
- Focused SessionManager tests: **7 passed, 0 failed**.
- SSH success-order, status-failure suppression, and Broker-attachment failure
  tests: **1 passed each**.
- `pnpm test:terminal-visible:ssh`: **PASS**; 5 real Docker SSH fixture tests
  covered bash, zsh, unsupported shell, post-prepare cleanup, and Direct SSH.
- Real cleanup test: **PASS**; the injected post-prepare failure removed its
  prepared remote root.
- `cargo check --locked --manifest-path src-tauri/Cargo.toml --all-targets`:
  **PASS**.
- Full Rust: **779 library tests and 5 integration tests passed, 0 failed, 32
  ignored**.
- Full frontend: **200 files passed, 1 skipped; 1,823 tests passed, 1 skipped**.
- `pnpm review:frontend`: **PASS**, including the same full test suite and a
  production build of 2,806 modules.
- `node --check scripts/verify-terminal-remote-ssh.mjs`: **PASS**.
- `node scripts/check-ai-panel-styles.mjs`: **PASS**.
- `pnpm check:llm:catalog`: **PASS**, 55 exact models and 4 negative fixtures.
- `pnpm build`: **PASS**, 2,806 modules transformed.

## Blocking verification

- `node scripts/check-rust-includes.mjs` reports pre-existing formatting debt in
  extracted Agent Runtime test modules, beginning with
  `src-tauri/src/agent_runtime/tests/compaction.rs`. Do not bulk-format the
  protected files to hide this failure.

## Resume gate

Resolve or explicitly waive `pnpm check:rust:includes`, then rerun it together
with `git diff --check`.

Only a current-code green gate or an explicit new waiver can change Phase 4 to
PASS and unblock a separate Phase 5 session.

## Integrity constraints

- Preserve all existing Phase 0–4 changes in the dirty worktree.
- Do not modify the four protected Agent Runtime test files or
  `src-tauri/vendor/portable-pty/`.
- Do not create a commit, tag, or push.
- Keep Windows native evidence recorded as MISSING.
