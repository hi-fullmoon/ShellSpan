# Terminal Execution Phase 4 Acceptance Evidence

Updated: 2026-09-15 (Asia/Shanghai)

Original Phase 4 session: `01a0a461-d04c-7d33-ba24-d2d314c773d8`

Remediation continuation: `01a0a4cf-4ef0-71d2-8845-1ae963c3090a`

Migrated verification continuation: `01a0a4f2-3d68-78c3-b6f1-a39b18f6f03d`

Final lifecycle and gate continuation: `01a0a500-3512-7be2-9516-7bfc9813ed66`

Roadmap: [Terminal Execution Roadmap](./terminal-execution-roadmap.md)

Protocol: [Terminal Session Protocol v1](./terminal-protocol-rfc.md)

Matrix: [Terminal Execution Platform Test Matrix](./terminal-execution-test-matrix.md)

## Scope and final gate

This record covers Phase 4 remote real-terminal execution only. It does not add
Phase 5 input/key/snapshot/wait tools or a headless screen model, and it does
not remove or reinterpret the legacy `exec_command.channel = "pty"` path.

An independent review reopened the earlier Phase 4 PASS because candidate,
replacement, and SSH integration cleanup were not lifecycle-safe. The four
findings are now implemented and verified by focused regression tests, a fresh
real-SSH fixture run, and a green full Rust suite.

**Final gate: PASS. Phase 5 is READY for a separate session and was not opened
here.** The final continuation corrected `check:rust:includes` so it validates
included Rust fragments in their possible module-indentation contexts without
skipping any discovered file. Its regression test accepts legitimate outer
module indentation and still rejects a real Rust formatting defect. The
remaining genuinely unformatted fragments were formatted mechanically, and the
gate now passes for all 43 discovered `include!` files.

Native Windows/ConPTY with Windows PowerShell 5.1 and PowerShell 7 remains
**MISSING**, not `PASS`, under the user's explicit deferral. No native Windows
command was run in this continuation. This evidence still blocks Phase 6
default enablement and legacy removal.

## Reopened-finding disposition

| Finding | Current result | Evidence |
| --- | --- | --- |
| Newly created candidate cleanup and cancellation ownership | **IMPLEMENTED; focused PASS** | `NativeToolAdapter::ensure_remote_agent_terminal` tracks an owned candidate and aborts only that candidate on cancellation, missing/degraded/unavailable/invalidated snapshots, snapshot errors, publication failure, and readiness timeout. Pre-existing terminals are returned as errors without being closed. SessionManager regression coverage proves candidate close preserves the predecessor. |
| `run_ssh_session` post-prepare cleanup | **PASS** | `with_remote_integration_cleanup` encloses channel creation, PTY request, extended-data mode, shell start, Broker attach, runtime lookup, integration registration/state publication, connected-status publication, and the session loop. The real-SSH regression injected a post-prepare failure and verified that the remote root was removed. |
| Replacement preserves predecessor on failure and closes it after success | **IMPLEMENTED; focused PASS** | Broker candidates use provisional records. Promotion temporarily adopts the logical id/generation and rolls back the exact candidate/predecessor records on publication failure. SessionManager changes `latest_agent_remote`, publishes, and only then sends predecessor `Close` and removes its registration. Focused tests cover failed publication, successful predecessor close, and Broker/SessionManager rollback alignment. |
| Delayed success and atomic predecessor/latest mapping | **PASS** | SSH connection success is sent only after Broker candidate attach, integration registration or explicit degraded/unavailable state publication, `Connected` status, and connected notification. Broker promotion requires `Ready` plus `prompt_ready`; a two-thread expected-predecessor race proves exactly one ready candidate wins and the stale candidate remains independently abortable. |

## Implementation notes

- A replacement SSH channel is first attached as a non-current Broker
  candidate. The existing Agent terminal remains routable while the candidate
  proves integration readiness.
- Production promotion requires a clean `Ready` integration state and prompt
  boundary. Unsupported or degraded candidates cannot replace a predecessor.
- Broker publication and SessionManager latest mapping are coupled through
  rollback-capable callbacks. Event publication failure restores both layers
  to the same predecessor.
- Successful publication closes the predecessor SessionManager worker only
  after the replacement event has been emitted. A failed candidate is aborted
  without touching the predecessor.
- Closing a candidate also removes its Agent ownership/latest bookkeeping and
  lease state. Disabling the remote rollout distinguishes staged candidates
  from published generations.
- Successful reconnect removes the reopened logical session id from bounded
  closed-session metadata so later eviction cannot delete the live generation.
- Remote integration cleanup still preserves cancellation, confirmation,
  audit, and redaction behavior. No credentials, nonce, remote integration
  path, or raw terminal output were added to logs or persisted configuration.

## Focused verification

| Exact command | Result |
| --- | --- |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check` | **PASS**. |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml terminal_broker::tests -- --test-threads=1` | **PASS — 20 passed, 0 failed**. Includes provisional candidate failure, rollback, a real two-thread first-winner predecessor race, reconnect metadata, and existing Broker contracts. |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml models::session_manager_tests -- --test-threads=1` | **PASS — 7 passed, 0 failed**. Includes candidate ownership cleanup, atomic promotion, publication rollback, Broker/SessionManager alignment, and predecessor shutdown. |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml ssh_success_signal_follows_status_and_connection_publication -- --test-threads=1` | **PASS — 1 passed**. |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml ssh_status_publication_failure_suppresses_success_signal -- --test-threads=1` | **PASS — 1 passed**. |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml ssh_broker_attachment_failure_closes_channel_and_is_visible -- --test-threads=1` | **PASS — 1 passed**. |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml remote_integration_scope_cleans_resources_after_post_prepare_failure -- --ignored --exact --test-threads=1` | **PASS — 1 passed** against the real Docker SSH fixture; the prepared remote root was removed after the injected failure. |
| `node --check scripts/verify-terminal-remote-ssh.mjs` | **PASS**. |

## Required-gate verification

| Exact command | Result |
| --- | --- |
| `cargo check --locked --manifest-path src-tauri/Cargo.toml --all-targets` | **PASS**. |
| `pnpm test:terminal-visible:ssh` | **PASS — 5 real fixture tests passed**: bash, zsh, unsupported shell, post-prepare cleanup, and Direct SSH execution. Docker resources were removed afterward. |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml -- --test-threads=1` | **PASS — 779 library tests and 5 integration tests passed; 0 failed; 32 ignored**. |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml --test petdex_contract_probe -- --test-threads=1` | **PASS — 5 passed, 0 failed** as part of the full Rust run. |
| `pnpm build` | **PASS — TypeScript/Vite, 2,806 modules transformed**, with the existing dynamic-import and chunk-size warnings. |
| `pnpm test` / `pnpm review:frontend` | **PASS — 200 files passed, 1 skipped; 1,823 tests passed, 1 skipped**. `review:frontend` also completed the production build. |
| `node scripts/check-ai-panel-styles.mjs` | **PASS — AI panel style boundaries are clean**. |
| `pnpm check:llm:catalog` | **PASS — 55 exact models validated; 4 negative fixtures rejected**. |
| `pnpm check:rust:includes` | **PASS — 43 discovered `include!` files checked**. The checker tests nesting depths without excluding files; a Vitest regression proves valid module indentation passes and a genuine formatting defect fails. |
| Native Windows PowerShell 5.1 / PowerShell 7 / ConPTY | **MISSING by explicit user deferral; not run and not PASS**. |

## Historical evidence

Before lifecycle review reopened Phase 4, the disposable Alpine sshd runner had
passed bash/zsh visible execution, unsupported-shell state, resize,
cancellation, takeover, disconnect uncertainty, reconnect/no-replay, a
simultaneous user-owned terminal, and Direct SSH regression. That result
validates the pre-remediation behavior only. Because candidate promotion and
cleanup changed, it was not reused to close the gate; the current-code fixture
was run again successfully.

## Acceptance result

There is no remaining Phase 4 acceptance work. `pnpm check:rust:includes`, its
targeted regression test, the Cargo formatting check, and `git diff --check`
all pass on the final continuation. Phase 5 may open in its own session on the
next machine.

Native Windows/ConPTY evidence remains explicitly deferred and **MISSING**. It
does not reopen Phase 4, but it remains a hard prerequisite for Phase 6 default
enablement or removal of the legacy wrapper.

## Protected-file and vendor disposition

This continuation did not modify:

- `src-tauri/src/agent_runtime/image_tests.rs`
- `src-tauri/src/agent_runtime/runtime_archive_tests.rs`
- `src-tauri/src/agent_runtime/runtime_loop_guard_tests.rs`
- `src-tauri/src/agent_runtime/session_inbox_steer_tests.rs`
- `src-tauri/vendor/portable-pty/`

The implementation continuation did not modify these protected paths.
