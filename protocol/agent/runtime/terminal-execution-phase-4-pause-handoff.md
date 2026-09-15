# Terminal Execution Phase 4 Pause Handoff

Updated: 2026-09-15 (Asia/Shanghai)

## Current state

- Phase 0–3 remain complete under their recorded evidence and Windows waivers.
- Original Phase 4 session: `01a0a461-d04c-7d33-ba24-d2d314c773d8`.
- Lifecycle remediation continuation:
  `01a0a4cf-4ef0-71d2-8845-1ae963c3090a`.
- Migrated verification continuation:
  `01a0a4f2-3d68-78c3-b6f1-a39b18f6f03d`.
- Final lifecycle and gate continuation:
  `01a0a500-3512-7be2-9516-7bfc9813ed66`.
- The four independently reviewed lifecycle/resource findings are implemented
  and focused regression tests pass.
- Phase 4 is **PASS**. Its lifecycle remediation, real-SSH matrix, full product
  gates, and corrected `check:rust:includes` gate are green.
- Phase 5 is **READY** for a separate session and was not opened here.
- Native Windows PowerShell 5.1, PowerShell 7, and ConPTY are **MISSING**, not
  `PASS`, by explicit user deferral. They remain a hard Phase 6 prerequisite.

The roadmap and Phase 4 acceptance record reflect this final state. Earlier
`NOT READY` wording tied to the include-format gate is no longer authoritative.

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
- `pnpm check:rust:includes`: **PASS**, all 43 discovered `include!` fragments
  checked in their valid module-indentation contexts.
- Targeted include-gate Vitest regression: **PASS — 3 tests**; valid top-level
  and module-indented fragments pass, while a real formatting defect fails.
- Final `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` and
  `git diff --check`: **PASS**.

## Deferred platform verification

- Native Windows PowerShell 5.1, PowerShell 7, and ConPTY remain **MISSING** by
  explicit user deferral. This is a Phase 6 blocker, not a Phase 4 blocker.

## Next-machine continuation

Fetch `origin/main`, switch to `main`, and update with `git pull --ff-only`.
Open Phase 5 in a new session using the Phase 5 deliverables and gate in the
roadmap. Do not reuse a Phase 0–4 implementation session for Phase 5.

Before Phase 6, run and record the still-missing native Windows/ConPTY lane on
an appropriate Windows host.

## Integrity constraints

- Preserve all published Phase 0–4 commits. The local `.pnpm-store/` directory
  is untracked workspace cache and is not part of the handoff.
- Do not modify the four protected Agent Runtime test files or
  `src-tauri/vendor/portable-pty/`.
- Phase 5 must use a new session and must not silently broaden its scope into
  Phase 6 rollout or legacy removal.
- Keep Windows native evidence recorded as MISSING.
