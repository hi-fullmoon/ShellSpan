# Terminal Execution Phase 4 Acceptance Evidence

Updated: 2026-09-15 (Asia/Shanghai)

Session: `01a0a461-d04c-7d33-ba24-d2d314c773d8`

Roadmap: [Terminal Execution Roadmap](./terminal-execution-roadmap.md)

Protocol: [Terminal Session Protocol v1](./terminal-protocol-rfc.md)

Matrix: [Terminal Execution Platform Test Matrix](./terminal-execution-test-matrix.md)

## Scope and final gate

This record covers Phase 4 remote real-terminal execution only. It implements
the default-off `terminal_remote_agent_pty_v1` lane on top of the Phase 2
Broker and Phase 3 cooperative shell integration/`terminal_execute`. It does
not add Phase 5 input/key/snapshot/wait tools or a headless screen model, and it
does not remove or reinterpret the legacy `exec_command.channel = "pty"` path.

**Final gate: PASS for all required non-Windows Phase 4 gates. Phase 5 is READY
for a separate session.** Native Windows/ConPTY with Windows PowerShell 5.1 and
PowerShell 7 remains **MISSING**, not `PASS`, under the explicit user deferral.
It remains a hard gate before Phase 6 default enablement or legacy removal.

## Requirement disposition

| Phase 4 requirement | Result | Evidence |
| --- | --- | --- |
| Default-off trusted remote flag and dependencies | **PASS** | `SHELLSPAN_TERMINAL_REMOTE_AGENT_PTY_V1` uses the existing trusted parser and is effective only with broker + integration + execute. Snapshot/contract tests freeze default-off and rollback metadata. |
| Dedicated Agent SSH PTY | **PASS** | The runtime independently authenticates from the frozen profile, requests `xterm-256color`, and starts the account's declared bash/zsh as the single interactive shell via an SSH exec request that `exec`-replaces the server setup shell. It records an Agent owner in both SessionManager and Broker. A normal transport cannot adopt an Agent predecessor. |
| Ordinary visible terminal tab/pane | **PASS** | Backend creation emits an ephemeral terminal-created event. The app-wide listener inserts a normal terminal session using the existing SSH raw display/controller path, with an accessible Agent badge. Workspace serialization removes the Agent session and its layout identity. |
| Never reuse a user-owned SSH terminal | **PASS** | Remote `terminal_execute` resolves only the latest matching `(Agent Session, target)` Agent-owned binding. The real fixture keeps a simultaneous user-owned SSH shell with independent state; Broker routing leaves it on legacy compatibility and never selects it as `terminal_execute`. |
| Remote bash/zsh bootstrap and explicit states | **PASS** | Bounded SFTP login-shell inspection supports bash/zsh. A mode-`0700` remote root contains a mode-`0600` source/FIFO; a distinct SSH channel drains control. Unsupported `/bin/sh` is `unavailable`, setup/control failures are `degraded`, and close is emitted as `invalidated`. |
| TSP/1 lifecycle/capture/lease/control | **PASS** | Exact-line and ordered cooperative events are decoded only from the isolated control channel. Raw PTY bytes remain display/capture data. Capture truncation does not truncate display; cancel/timeout/takeover use the common lease path. |
| Disconnect/reconnect | **PASS** | The real fixture makes an in-flight side effect `uncertain`, reconnects the same logical terminal as generation 2, rejects old-transport bytes, and observes the side effect exactly once. Results retain `noAutoReplay: true`. |
| Resize | **PASS** | The fixture issues real SSH `request_pty_size(132, 41)`, observes remote `stty size` as `41 132`, and verifies matching Broker geometry. Production continues through the existing SessionCommand resize transport. |
| Additive remote `run_terminal_command` routing | **PASS** | The adapter freezes `terminal_execute` only for eligible bound-terminal remote operations. Commands are registered before exact input. No `/bin/sh -c`, nested shell, BEGIN/END wrapper, or synthetic `[Agent]` echo was added to the operation path. |
| Direct policy boundary and direct invocation | **PASS** | Known sensitive/destructive/external effects and `lifecycleTrust = directRequired` normalize to Direct before Agent PTY provisioning. Native call policy independently rejects such `terminal_execute` calls. Existing Direct SSH exec passes in the isolated fixture. |
| Approval before PTY input | **PASS** | Remote provisioning occurs only after `issue_prepared_authorization`. The creation API requires an approval-witness type whose constructor is private to that post-authorization adapter path. Bootstrap and command writes therefore occur after the decision. |
| Real isolated SSH fixture | **PASS** | `pnpm test:terminal-visible:ssh` builds disposable Alpine 3.22 sshd containers on loopback, runs real bash/zsh/unsupported accounts plus Direct SSH exec, and tears the compose project down. No mock substitutes for the SSH PTY/control evidence. |
| Phase 5 exclusion | **PASS** | No general model-facing input/key/snapshot/wait tool and no headless screen implementation was added. Only Broker-internal input/control and existing resize/takeover paths are used. |

## Implementation and adversarial review

The Agent terminal is keyed ephemerally by `(Agent Session id, target id)` and
retains the source user transport id only as an ownership/frozen-target fence.
Creation after approval obtains fresh SSH transport authentication; it does not
borrow the source terminal's channel. A failed reconnect candidate is not
promoted over its predecessor. Generation adoption requires an exact Agent
owner match, so an ordinary user reconnect cannot acquire the Agent terminal's
logical identity.

Remote control uses the same NUL-field lifecycle vocabulary as local POSIX
integration but arrives on a separate SSH channel. The main PTY branch is sent
unchanged to Broker raw observation before UTF-8 display decoding. A real
command printed lifecycle-shaped NUL bytes claiming exit 77; only the
cooperative channel's actual exit 0 was accepted. Normal child environment and
descriptor output did not expose the remote control root. As required by the
amended threat model, deliberate same-UID discovery/reopen and deliberate
in-shell hook replacement remain out-of-scope tampering; the visible terminal
is not described as a sandbox.

Malformed control input immediately removes lifecycle trust and makes an
incomplete operation uncertain. Review found that simply stopping the control
reader at that point could eventually backpressure the FIFO and freeze the
otherwise user-operable shell. The final implementation therefore continues
to drain rejected control bytes without accepting events until generation
close, matching the local failure-drain behavior.

The random integration path is carried in the SSH exec request that starts the
single interactive shell; it is never written into PTY input and therefore
cannot be redisplayed by bash Readline or zsh ZLE. Bash uses `--rcfile`; zsh
uses a private `ZDOTDIR` with passthrough startup files, and both source the
user's normal profile before installing hooks. The random path, integration id, raw
output, and credentials are not logged or persisted. Setup output and
`/etc/passwd` inspection are bounded; remote resources are removed on normal
generation cleanup.

## Isolated SSH evidence

Host boundary: Darwin arm64 running Docker Desktop 29.7.2 with a Linux/aarch64
Alpine 3.22 fixture. Published endpoints are loopback-only. The fixture has
separate bash, zsh, and unsupported `/bin/sh` accounts with test-only
credentials.

`pnpm test:terminal-visible:ssh` final result:

- bash real SSH PTY: **PASS** — raw display, persistent `cd`/environment/alias/
  function/shell-option state, exact command/exit/cwd, ANSI/Unicode/no-final-
  newline output, 20 KB display with explicit 4 KB capture truncation,
  non-inherited control state, raw-output forgery, resize, cancellation,
  timeout, takeover/input rejection, simultaneous user-owned terminal,
  disconnect uncertainty, generation-2 reconnect, and no replay;
- zsh real SSH PTY: **PASS** — ready lifecycle and persistent environment/alias
  state over an independently authenticated zsh login;
- unsupported `/bin/sh`: **PASS (explicit `unavailable`)**;
- reviewed Direct SSH exec: **PASS**; and
- compose cleanup: **PASS**.

## Retained failed attempts

1. The first Docker build failed before tests because the Alpine mirror ended a
   TLS read early and left no usable package index. A clean retry downloaded the
   same pinned Alpine 3.22 packages and succeeded; the first attempt is not
   counted as evidence.
2. The first remote FIFO reader used a repeated short-lived `cat`. Bash emitted
   `ready` and `promptStart`, then blocked before `promptEnd` while the next FIFO
   reader reopened. The implementation now holds one read/write FIFO descriptor
   in the dedicated control process; the real bash and zsh lanes pass.
3. An early ANSI fixture command using a backslash-octal spelling was reported
   differently by the remote bash history fallback and correctly triggered an
   exact-line mismatch/degradation. The accepted deterministic ANSI case uses
   `tput`, is still exact and wrapper-free, and the mismatch attempt remains
   evidence that validation fails closed rather than fabricating completion.
4. A hardening attempt relied on SSH `pty-req` `ECHO=0/ECHONL=0` before sending
   the private bootstrap path. Bash honored it, but zsh startup/ZLE restored or
   independently rendered input; the privacy probe correctly failed twice.
   The final design carries the path only in the SSH exec request that starts
   and `exec`-replaces the single interactive shell, so no private bootstrap
   command is written into the PTY.
5. The first zsh startup-file run emitted `ready` and `promptStart` but no
   `promptEnd`; sending a blank activation line then produced a second
   `promptStart` and correctly failed ordering. The remote-only zsh profile now
   emits prompt end from an invisible prompt expansion, while local zsh keeps
   its existing ZLE `line-init` hook. Both native local and real remote zsh
   tests pass.
6. The first full `pnpm test` after documentation edits had one contract-only
   failure because a line break separated “absent” from “value is explicitly
   off”. The wording was repaired; no assertion was weakened.
7. A whole-application `aarch64-pc-windows-msvc` cross-check was attempted from
   macOS and stopped in upstream `ring` C compilation because the host has no
   Windows SDK/MSVC `assert.h`; the chained x86_64 check therefore did not run.
   This is **MISSING**, not a Windows pass or a product-source failure. The
   repository's Windows runner/architecture/protocol static tests still pass.

## Verification summary

| Exact command | Result |
| --- | --- |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml -- --test-threads=1` | **PASS — 772 passed, 31 ignored; integration probe 5 passed; main/doc tests 0 failures.** The three Phase 4 SSH tests are deliberately ignored in the ordinary host suite and run explicitly by the SSH runner. |
| `cargo check --locked --manifest-path src-tauri/Cargo.toml --all-targets` | **PASS**. |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check` | **PASS**. |
| `pnpm build` | **PASS — TypeScript and Vite build; 2,806 modules transformed**, with only existing dynamic-import/chunk-size warnings. |
| Initial `pnpm test` | **FAILED — 199 files passed, 1 skipped, 1 contract file failed; 1,822 tests passed, 1 skipped, 1 failed.** Retained attempt 6 above; not counted as final pass. |
| Final `pnpm test` | **PASS — 200 files passed, 1 skipped; 1,823 tests passed, 1 skipped.** |
| Targeted protocol/runner/frontend/locale command | **PASS — 7 files / 73 tests.** |
| Targeted architecture/protocol/remote-runner/Windows-runner command | **PASS — 4 files / 17 tests; both runner scripts pass `node --check`.** |
| `pnpm test:terminal-visible:ssh` | **PASS** with three real remote-shell tests plus Direct SSH regression and compose cleanup. |
| `pnpm check:ai-styles` | **PASS — AI panel style boundaries are clean.** |
| `pnpm check:llm:catalog` | **PASS — 55 exact models validated; 4 negative fixtures rejected.** |
| `pnpm test:terminal-visible:windows` | **MISSING — exit 2 on `darwin/arm64`; native Windows/ConPTY required.** |
| Whole-app `cargo check --lib --target aarch64-pc-windows-msvc` | **MISSING — upstream `ring` could not find the Windows SDK/MSVC `assert.h` on macOS; x86_64 chained check not run.** |
| `pnpm check:rust:includes` | **KNOWN PRE-EXISTING FAILURE** only in the four protected include-debt files; Phase 4 did not modify them. |
| `git diff --check` | **PASS**. |
| Protected-file and `src-tauri/vendor/portable-pty` scoped `git diff --exit-code` | **PASS — zero diff.** |

## Exact final worktree status

The following is the final `git status --short`. It contains the preserved
uncommitted Phase 0–3 work plus Phase 4; nothing was staged, committed, tagged,
pushed, reverted, or reclassified.

```text
 M package.json
 M protocol/agent/runtime/built-in-tools.json
 M protocol/agent/runtime/event-v5.schema.json
 M protocol/agent/runtime/tool-contract.schema.json
 M protocol/agent/runtime/tool-manifest.schema.json
 M scripts/__tests__/agent-runtime-architecture.test.mjs
 M scripts/verify-agent-visible-terminal.mjs
 M src-tauri/examples/terminal_transport_baseline.rs
 M src-tauri/src/agent_runtime/event.rs
 M src-tauri/src/agent_runtime/model_tools.rs
 M src-tauri/src/agent_runtime/native/call_policy.rs
 M src-tauri/src/agent_runtime/native/effect.rs
 M src-tauri/src/agent_runtime/native/mod.rs
 M src-tauri/src/agent_runtime/native/registry.rs
 M src-tauri/src/agent_runtime/native/runtime.rs
 M src-tauri/src/agent_runtime/native/terminal_lease.rs
 M src-tauri/src/agent_runtime/native_adapter.rs
 M src-tauri/src/agent_runtime/native_contract/policy.rs
 M src-tauri/src/agent_runtime/native_contract/types.rs
 M src-tauri/src/agent_runtime/recovery.rs
 M src-tauri/src/agent_runtime/runtime.rs
 M src-tauri/src/agent_runtime/session.rs
 M src-tauri/src/commands.rs
 M src-tauri/src/connection.rs
 M src-tauri/src/execution/fixture.rs
 M src-tauri/src/lib.rs
 M src-tauri/src/models.rs
 M src-tauri/src/session.rs
 M src/components/ai/__tests__/ai-workspace-controller.test.tsx
 M src/components/ai/agent-execution-surface-selector.tsx
 M src/components/ai/workspace/ai-workspace-controller.tsx
 M src/components/terminal/__tests__/terminal-controller-layer.test.tsx
 M src/components/terminal/__tests__/terminal-pane.test.tsx
 M src/components/terminal/__tests__/terminal-tab-bar.test.tsx
 M src/components/terminal/terminal-controller-layer.tsx
 M src/components/terminal/terminal-pane.tsx
 M src/components/terminal/terminal-tab-bar.tsx
 M src/hooks/__tests__/useMonitorEvents.test.ts
 M src/hooks/__tests__/useReconnectSession.test.ts
 M src/hooks/useMonitorEvents.ts
 M src/hooks/useReconnectSession.ts
 M src/lib/ai/__tests__/session-adapters.test.ts
 M src/lib/ai/conversation-projection.ts
 M src/lib/ipc/__tests__/tauri.test.ts
 M src/lib/ipc/tauri.ts
 M src/lib/terminal/__tests__/terminal-workspace.test.ts
 M src/lib/terminal/terminal-workspace.ts
 M src/locales/en-US.ts
 M src/locales/zh-CN.ts
 M src/stores/__tests__/terminalStore.test.ts
 M src/stores/terminalStore.ts
 M src/types/agent-session.ts
 M src/types/index.ts
 M tests/ssh-e2e/Dockerfile
 M tests/ssh-e2e/sshd_config
?? protocol/agent/runtime/fixtures/
?? protocol/agent/runtime/terminal-execution-compatibility.md
?? protocol/agent/runtime/terminal-execution-phase-0-baseline.md
?? protocol/agent/runtime/terminal-execution-phase-2-acceptance.md
?? protocol/agent/runtime/terminal-execution-phase-3-acceptance.md
?? protocol/agent/runtime/terminal-execution-phase-4-acceptance.md
?? protocol/agent/runtime/terminal-execution-roadmap.md
?? protocol/agent/runtime/terminal-execution-test-matrix.md
?? protocol/agent/runtime/terminal-protocol-rfc.md
?? protocol/agent/runtime/terminal-protocol-v1.schema.json
?? scripts/__tests__/terminal-broker-windows-runner.test.mjs
?? scripts/__tests__/terminal-protocol-contract.test.mjs
?? scripts/__tests__/terminal-remote-ssh-runner.test.mjs
?? scripts/verify-terminal-broker-linux-container.mjs
?? scripts/verify-terminal-broker-windows.mjs
?? scripts/verify-terminal-remote-ssh.mjs
?? src-tauri/src/agent_runtime/native/terminal_execute.rs
?? src-tauri/src/terminal_broker.rs
?? src-tauri/src/terminal_integration.rs
?? src/components/ai/__tests__/agent-execution-surface-selector.test.tsx
?? src/lib/terminal/__tests__/terminal-surface-semantics.test.ts
?? src/lib/terminal/terminal-surface-semantics.ts
?? src/locales/__tests__/
?? tests/terminal-broker-linux/
```

## Missing evidence and remaining risks

- Native Windows/ConPTY for Windows PowerShell 5.1 and PowerShell 7 is
  **MISSING**, never `PASS`. The static contracts remain, but native `$?` /
  `$LASTEXITCODE`, handle, connect, resize, and close behavior is not claimed.
  This does not block the Phase 4 remote POSIX lane under the user's explicit
  deferral; it still blocks Phase 6 default enablement and legacy removal.
- Bare-metal Linux is **MISSING**. The required isolated SSH result is a real
  sshd inside Docker Desktop LinuxKit and is not promoted to bare metal.
- The cooperative shell is not a same-UID or in-shell tamper sandbox. Direct is
  mandatory when lifecycle must withstand that adversary.
- Remote startup relies on SFTP access to `/etc/passwd`, a writable `/tmp`,
  `mkfifo`, `stty`, and the account's declared bash/zsh. Restricted accounts
  fail explicitly as degraded/unavailable and do not masquerade as ready.

## Protected-file and vendor disposition

Phase 4 does not modify these pre-existing include-debt files:

- `src-tauri/src/agent_runtime/image_tests.rs`
- `src-tauri/src/agent_runtime/runtime_archive_tests.rs`
- `src-tauri/src/agent_runtime/runtime_loop_guard_tests.rs`
- `src-tauri/src/agent_runtime/session_inbox_steer_tests.rs`

`src-tauri/vendor/portable-pty/` also has zero Phase 4 diff. No commit, tag, or
push was created.
