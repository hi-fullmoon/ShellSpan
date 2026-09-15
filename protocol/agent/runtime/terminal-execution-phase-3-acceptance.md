# Terminal Execution Phase 3 Acceptance Evidence

Updated: 2026-09-15 (Asia/Shanghai); final adversarial review: **Phase 3 PASS
under the explicit cooperative-shell RFC amendment and the user-approved
Windows native-evidence waiver**. Native Windows remains **MISSING**, never
`PASS`.

Session: `01a0a3a5-747a-7af2-b6ec-392a60141fed`

Roadmap: [Terminal Execution Roadmap](./terminal-execution-roadmap.md)

Protocol: [Terminal Session Protocol v1](./terminal-protocol-rfc.md)

Matrix: [Terminal Execution Platform Test Matrix](./terminal-execution-test-matrix.md)

## Scope and outcome

This record covers only Phase 3 local visible-command execution. It implements
local shell integration and the additive native `terminal_execute` tool. Final
review caused an explicit 2026-09-15 RFC amendment: visible-terminal metadata
uses a generation-bound isolated control plane and a cooperative shell producer;
it does not claim isolation from arbitrary same-UID code or malicious code
running inside the interactive shell. Under that honest boundary, POSIX may
become production-ready when all flags and readiness gates pass. This session
did not start the Phase 4 remote Agent SSH PTY, Phase 5 screen model or
interactive tools, or Phase 6 default enablement/removal.

The implemented production route is wrapper-free and writes the exact logical
command plus the shell Enter sequence into the current interactive shell
through the common lease-authorized terminal input path. The existing model-facing
`run_terminal_command`, persisted `direct`/`boundTerminal` values,
`exec_command.channel = direct|pty`, event-v5 envelope, direct-process path,
and legacy PTY wrapper remain compatible. Routing is frozen before dispatch.

## Shell integration and amended security disposition

### POSIX shells

Bash and zsh bootstrap from session-lifetime files in a private temporary
directory. Lifecycle events use NUL-delimited binary framing over a mode-`0600`
FIFO in that mode-`0700` directory. Each hook opens a short-lived FIFO writer
only for one event, so foreground commands and subshells inherit no control
descriptor. The integration identity is bound only in the backend reader
closure and never appears in PTY bytes, shell environment, logs, persisted
workspace, or Agent events.

These properties establish the in-scope isolated control plane; they do not
turn the FIFO path into a credential. A process running as the same user can
open the mode-`0600` FIFO if it actively discovers the path, and code running
inside the interactive shell can alter hooks. The backend-only `integrationId`
binds the reader closure but is not a per-record MAC. **Active same-UID code**
that deliberately discovers the path is outside the cooperative integration
threat model; so is deliberate in-shell tampering. The product makes no
security guarantee against either and never calls visible terminal a sandbox.
Raw PTY output and
ordinary external foreground descendants remain inside the enforced gate: raw
bytes cannot advance lifecycle and normal children inherit no writer.

- zsh uses `preexec`, `precmd`, `chpwd`, and ZLE `line-init` hooks.
- bash uses a DEBUG pre-exec hook, `PROMPT_COMMAND`, Readline accepted-line
  capture on bash 4+, and a shell-history API fallback for native macOS bash
  3.2. Prompt readiness does not inspect `PS1`, prompt bytes, or regexes.
- A missing/malformed hook record, wrong shell identity, event-order violation,
  or exact-line mismatch degrades the generation. If input may already have
  reached the shell, the operation becomes `uncertain`, never ordinary failed.

### PowerShell shells

Windows PowerShell 5.1 and PowerShell 7 share a generated session-scoped module
that wraps the existing prompt function and installs a `PSReadLine`
`AddToHistoryHandler`. It preserves an existing history handler and sends
binary control fields through a byte-mode `NamedPipeServerStream` created by
the PowerShell process. Foreground commands do not inherit that managed pipe
handle. Missing PSReadLine reports explicit degradation.

The module object used by prompt/history hooks remains in interactive
PowerShell state, so deliberate in-shell code can enter module scope and call
its sender. Under the same cooperative threat model this is documented
out-of-scope tampering, not a security guarantee. Direction `Out` and managed
handle non-inheritance cover the normal external-child boundary. Native
readiness is still not claimed because neither PowerShell lane has run on a
Windows/ConPTY host.

The prompt hook currently maps `$?` success to `0` and otherwise uses a
nonzero integer `$LASTEXITCODE` (falling back to `1`, so stale zero cannot turn
a failure into success). Static review cannot prove that value belongs to the
just-finished line: PowerShell may retain a stale native
exit code across a later failing cmdlet. No native lane currently proves the
full cmdlet/native-command distinction. The implementation therefore claims
only the candidate mapping above; complete PowerShell exit semantics remain
native debt before Windows can be marked ready.

The generated source, native ignored ConPTY tests, runner prerequisites, exact
test names, and static x64/ARM64 ConPTY dependency checks are present. No native
Windows machine was used, so both PowerShell lanes remain **MISSING**, not
`PASS`.

### Broker lifecycle and capture

The Broker parser accepts `ready`, prompt start/end, command start/end, and
directory change only from the registered control reader for the current
terminal generation and integration identity. It assigns monotonic event
sequence and raw-output fences. Raw terminal bytes remain append-only display
input and can never advance lifecycle; forged prompt text, OSC 133,
BEGIN/END-like bytes, or command-end-looking output stay untrusted capture
only. Same-UID endpoint reopen is retained as a documented out-of-scope threat
test and cannot be confused with raw-output forgery.

The distinct additive `terminal_execute` implementation registers an opaque
command before input, requires the Agent lease plus clean frontend readiness,
and returns version-1 data with:

- terminal session/generation, operation, and command identities;
- exact command line, cooperative exit code, and final cwd;
- PTY `combinedOutput` with command-scoped sequence fences;
- explicit capture truncation without display truncation; and
- `noAutoReplay: true`.

It never reinterprets `exec_command.channel = "pty"`; that value continues to
select the legacy wrapper. No `/bin/sh -c`, nested PowerShell, hidden BEGIN/END
wrapper, or synthetic `[Agent]` echo exists in the production
`terminal_execute` path. It is production-routable for supported POSIX
integrations only after all rollout, generation, identity, capability, prompt,
and ordering gates pass.

Visible lifecycle is never used as authorization or security evidence. The
native adapter and call policy force classified `sensitiveRead`, `destructive`,
and `externalSideEffect` commands to Direct. The additive
`lifecycleTrust = directRequired` argument does the same for contextual
adversarial/untrusted scripts that a command classifier cannot know. Direct
isolates process lifecycle from interactive-shell hooks; it is not a general OS
sandbox. Ordinary stateful commands such as `cd`, `export`, aliases, and
functions remain eligible for the visible shell.

Cancel, timeout, and takeover send at most one operation-scoped Ctrl-C through
the common input path. A matching accepted cooperative end settles the
corresponding state.
Missing completion, control loss, transport disconnect, or reconnect settles
`uncertain`. The additive event-v5 `uncertain` tool-result status remains a
manual reconciliation boundary; an eventual reconciliation result may settle
it exactly once.

## Requirement-by-requirement completion

| Phase 3 requirement | Disposition | Evidence |
| --- | --- | --- |
| Bash integration | **PASS** | Native macOS bash 3.2 and Debian bash 5.2 PTYs run the production state/capture/control matrix; normal children inherit no writer and raw PTY forge attempts do not affect state. |
| zsh integration | **PASS** | Native macOS zsh 5.9 and Debian zsh 5.9 PTYs run the same production and adversarial matrix. |
| Windows PowerShell 5.1 implementation | **IMPLEMENTED/STATIC PASS; NATIVE EVIDENCE MISSING** | Generated named-pipe/PSReadLine integration, static contracts, and ignored native ConPTY test are wired into the Windows runner; native exit/lifecycle evidence is not claimed. |
| PowerShell 7 implementation | **IMPLEMENTED/STATIC PASS; NATIVE EVIDENCE MISSING** | Same implementation boundary with an independent `pwsh.exe` native test; native status remains MISSING. |
| Unsupported shell degradation | **PASS** | Exact basename detection; unknown shells never bootstrap and publish `degraded/unsupportedShell`. |
| Cooperative prompt start/end | **PASS** | Ordered generation-bound control events are independent of prompt text/regex; malformed or stale events fail closed. |
| Cooperative command start/end, exact line, exit, cwd | **PASS on POSIX; WINDOWS NATIVE MISSING** | Broker and real PTY assertions bind exact line, event order, generation, exit, and cwd. Windows semantics remain unverified. |
| Output cannot forge lifecycle | **PASS** | Raw forged command-end, prompt, OSC, and marker-like bytes never change operation state. Same-UID reopen is separately documented as out-of-scope tampering. |
| Wrapper-free native `terminal_execute` | **PASS** | Separate manifest/schema/runtime tool; exact input contains no injected shell, wrapper, marker, or synthetic echo; production flags route ready POSIX integrations to it. |
| Current-shell state preservation | **PASS** | `cd`, exported environment, alias, function, and shell option persist across later tool calls in each native POSIX shell. |
| ANSI, Unicode, no final newline, nonzero exit | **PASS** | Raw display/capture assertions on macOS and Linux. |
| Large output and command-scoped truncation | **PASS** | 12,000-byte command remains display-complete while 4,096-byte capture reports truncation. |
| Cancellation and timeout | **PASS** | Real POSIX Ctrl-C tests plus registry races; accepted cooperative end classifies, missing end is uncertain. |
| User takeover | **PASS** | Typed takeover IPC is called before Agent turn interruption; lease returns to user, later Agent input is rejected, and accepted cooperative end classifies `takenOver`. |
| Reconnect/disconnect uncertainty and no replay | **PASS** | Generation replacement/control loss settle active operation uncertain and the transport-write counter remains exactly one. |
| Feature flags and legacy fallback | **PASS** | Backend-only dependency-aware decisions; new flags default off, legacy fallback defaults on, readiness still requires identity/capability/order gates, and rollback is new-operation-only. |
| Persisted enum/event compatibility | **PASS** | `direct`, `boundTerminal`, `direct|pty`, event v5, and old session fixtures remain; `terminal_execute` and `uncertain` are additive. |
| Typed Tauri IPC and UI state | **PASS** | Read-only Broker snapshot, typed integration-state event, generation checks, ready/degraded projection, and operation-scoped takeover IPC. |
| Bilingual i18n key parity | **PASS** | `agent.status.uncertain` added to both catalogs; full locale key-set tests pass. |
| Direct routing/security boundary | **PASS** | Sensitive/destructive/external effects and explicit `directRequired` lifecycle requests route to Direct; stateful visible-shell operations remain visible; approval precedes dispatch and never trusts terminal metadata. |
| Direct execution regression | **PASS** | Native direct process suite passes on macOS and Linux. |
| Remote Phase 4 work | **NOT STARTED** | Isolated SSH integration remains Phase 4 scope. |

Overall Phase 3 disposition: **PASS under the explicit cooperative-shell RFC
amendment and Windows native-evidence waiver**. Phase 4 is ready for a separate
session but was not started.

## Final adversarial review and corrections

- The Phase 3 session is frozen to the actual Codex session
  `01a0a3a5-747a-7af2-b6ec-392a60141fed` in both this document and the roadmap;
  the protocol contract test asserts both exact locations.
- A real PTY child now enumerates `/dev/fd`, attempts to write a forged
  NUL-framed lifecycle record to every inherited FIFO endpoint, and must exit
  zero without changing command state. This proves the candidate does not
  inherit a writable FIFO descriptor; it does not claim protection against a
  separately reopened same-UID FIFO.
- The native PTY regression checks that the private root/path, shell variable
  name, integration identifier, and bootstrap prefix do not appear in the child
  environment, PTY display bytes, or serialized Broker diagnostic snapshot.
  Broker tests separately prove raw lifecycle-looking output cannot settle a
  command. Agent event-v5 persists neither raw output nor integration transport
  details.
- POSIX resources are checked as mode `0700` root / mode `0600` FIFO, bounded
  to at most five entries, and removed on pre-reader rollback, normal stop, and
  reader-callback failure. The control handle owns and joins its reader thread;
  nonblocking close wakeup avoids creating a blocked writer during teardown,
  and a failed parser drains until bounded shutdown so shell hooks do not strand
  a blocked reader/writer pair.
- A regression intentionally confirms that a same-UID process which knows the
  FIFO path can open it. The 2026-09-15 RFC amendment classifies this active
  discovery as out-of-scope tampering in a cooperative shell, not as proof that
  visible terminal is a sandbox. Production accepts `ready` only after the
  rollout, generation, identity, capability, framing, order, and prompt gates;
  the prior test-only bypass and all-candidate production rejection were
  removed.
- PowerShell static contracts freeze server direction `Out`, byte mode,
  non-inheritable pipe options, connect-before-ready order, PSReadLine accepted
  line, prompt success/exit status, cwd, and absence of nested PowerShell,
  encoded commands, BEGIN/END markers, or synthetic Agent echo. Native Windows
  PowerShell 5.1 and PowerShell 7 ConPTY execution remains **MISSING**. The
  reachable in-session module is the corresponding cooperative-model
  limitation, not a sandbox claim. Static review also records stale
  `$LASTEXITCODE` ambiguity for a failing cmdlet; complete native-vs-cmdlet exit
  semantics are not claimed before native Windows evidence. The ignored native
  test now uses a real `cmd.exe /d /c exit 7` for native status and separately
  asserts that a failing cmdlet following stale zero reports `1`, not success.
- The model schema, adapter, effect classifier, and native call policy enforce
  Direct lifecycle for known sensitive/destructive/external commands and for
  explicit `lifecycleTrust = directRequired`. This prevents direct calls to
  `terminal_execute` from bypassing the rule while preserving stateful visible
  shell commands.

## Final correction validation (current source)

These are the proportionate post-correction commands. The earlier full and
performance evidence below is retained as historical evidence; it was not
rerun because the final production changes were limited to local integration
readiness/trust wording and Direct routing policy; the user explicitly excluded
another expensive Linux performance run.

| Exact command | Exact result |
| --- | --- |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml terminal_integration::tests --lib -- --nocapture --test-threads=1` | **PASS — 10 passed** on native macOS, including bash/zsh real PTYs, FD forgery attempt, path/environment/display/snapshot non-disclosure, permissions, and cleanup. |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml terminal_broker::tests --lib -- --nocapture --test-threads=1` | **PASS — 17 passed** on macOS, including default-off/legacy behavior and production-config routing to `terminal_execute` only after all flags, integration identity, capabilities, and prompt readiness pass. |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml agent_runtime::native::terminal_execute::tests --lib -- --nocapture --test-threads=1` | **PASS — 3 passed**. |
| Targeted `effect`, call policy, native registry, native adapter, recovery, and `commands` Rust filters | **PASS — 4 + 1 + 1 + 4 + 3 + 16 passed**, including automatic and explicit Direct routing plus native `terminal_execute` bypass rejection. |
| `pnpm exec vitest run` over terminal protocol, architecture, Windows runner, locale parity, semantics, typed IPC, adapter/store/reconnect, takeover/UI files | **PASS — 13 files / 236 tests**. |
| `pnpm exec vitest run scripts/__tests__/terminal-protocol-contract.test.mjs` after removal of the obsolete id literal | **PASS — 1 file / 5 tests**. |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check` | **PASS**. |
| `cargo check --locked --manifest-path src-tauri/Cargo.toml --all-targets` | **PASS**. |
| `pnpm build` | **PASS — TypeScript and Vite production build; 2,806 modules transformed**. Existing dynamic-import and chunk-size warnings only. |
| `node scripts/verify-terminal-broker-linux-container.mjs --phase3-only` final run | **PASS** on Debian 12/aarch64 Docker Desktop LinuxKit: Broker 18, integration 10, `terminal_execute` 3, direct process 5, recovery 3; fmt and all-target check passed. No performance round ran. This run includes the amended production readiness logic and cooperative-boundary tests. |
| `pnpm test:terminal-visible:windows` | **MISSING — exit 2** on `darwin/arm64`; no native Windows/ConPTY result was promoted to PASS. |
| `git diff --check` | **PASS**. |
| `git status --short` and `git diff --exit-code` scoped to the four protected Rust include-debt files | **PASS — empty / zero diff**. |
| `git diff --exit-code -- src-tauri/vendor/portable-pty` | **PASS — zero diff**. |
| Repository-wide fixed-string search for the obsolete Phase 3 session id, excluding VCS/build caches | **PASS — zero matches**. The contract separately freezes the actual session id in the tracker and this acceptance document. |

The first post-correction Linux focused attempt is retained as a failed attempt,
not a pass: all 18 Broker tests passed, then zsh remained `cancelRequested`
when the test sent Ctrl-C immediately after `preexec`, before the foreground
process group had settled (integration 9 passed / 1 failed). The real-PTY test
now waits 100 ms after observing `running` before measuring Ctrl-C behavior;
the final focused run above passed. Production still sends only one scoped
interrupt and, independently, converts missing accepted settlement to
`uncertain` after two seconds without replay.

An adversarial permissions assertion initially observed a pre-correction
integration root as `0755`; creation now explicitly sets `0700` and the test
passes on macOS and Linux. One unreferenced pre-correction temporary bootstrap
directory from 14:38 (no FIFO and no open handle) was inspected and removed;
post-correction lifecycle tests assert their own roots are deleted.

## Earlier native macOS evidence

Host boundary: Darwin arm64; `/bin/bash` 3.2.57 and `/bin/zsh` 5.9.

Earlier `pnpm test:agent-visible-terminal` result before the final adversarial
corrections:

| Suite | Exact result |
| --- | --- |
| rustfmt + all-target Rust check | **PASS** |
| Terminal Broker | **PASS — 16 passed** |
| Shell integration | **PASS — 7 passed**, including native macOS bash and zsh |
| `terminal_execute` | **PASS — 3 passed** |
| Terminal lease | **PASS — 7 passed** |
| Legacy PTY compatibility | **PASS — 18 passed, 1 isolated-SSH test ignored** |
| Legacy-result redaction | **PASS — 1 passed** |
| Recovery no-replay | **PASS — 1 passed** |
| Frontend/IPC/protocol gate | **PASS — 8 files / 230 tests** |
| SSH fixture | **SKIPPED by command**, because remote real terminal is Phase 4 |

The native bash/zsh acceptance sequence covers custom empty and multiline ANSI
prompts, non-inherited FIFO descriptors, `cd`, environment, alias, function,
shell option, ANSI, Unicode, no final newline, nonzero status, three real Ctrl-C
settlements, large output, exact command line, and cwd.

Full serialized Rust result:

```text
cargo test --locked --manifest-path src-tauri/Cargo.toml -- --test-threads=1
library: 761 passed, 0 failed, 28 ignored
integration probe: 5 passed, 0 failed
main/doc tests: 0 failures
```

Direct execution result:

```text
cargo test --locked --manifest-path src-tauri/Cargo.toml \
  agent_runtime::native::process::tests --lib -- --nocapture
5 passed, 0 failed
```

## Earlier Linux/aarch64 VM/container evidence

Boundary: Debian 12/aarch64 as uid 1000 inside Docker Desktop LinuxKit. This is
**VM/container evidence, not bare-metal Linux evidence**. The deterministic
shell fixture fixes `LANG` and `LC_ALL` to `C.UTF-8` for the Unicode matrix.

Reproducible commands:

```bash
pnpm test:terminal-visible:linux-container
pnpm test:terminal-visible:linux-container:focused
```

The earlier full run, before the later non-inherited-FIFO hardening, passed all
functional suites and both broker performance rounds. The final focused run
then re-ran the post-hardening source and passed:

| Suite | Exact focused result |
| --- | --- |
| rustfmt + all-target Rust check | **PASS** |
| Terminal Broker | **PASS — 17 passed**, including Linux bash/zsh transport tests |
| Shell integration | **PASS — 7 passed**, including Linux bash/zsh visible-command tests |
| `terminal_execute` | **PASS — 3 passed** |
| Direct process | **PASS — 5 passed** |
| Recovery | **PASS — 3 passed** |

The earlier full run also recorded:

```text
legacy PTY: 18 passed, 1 ignored
commands: 14 passed
session/transport: 53 passed
full Rust library: 759 passed, 0 failed, 27 ignored
integration probe: 5 passed, 0 failed
main/doc tests: 0 failures
```

Performance round 1:

| Scenario | Broker off | Broker shadow | Result |
| --- | --- | --- | --- |
| Single PTY | 63.826 ms p50 / 82.972 ms p95 / 31.34 MiB/s | 52.565 / 54.393 / 38.05 | **PASS** |
| Four PTYs | 71.578 / 86.013 / 111.77 | 64.735 / 77.201 / 123.58 | **PASS** |
| Event first-byte p95 | 0.052 ms | 0.069 ms | **PASS** |
| Event burst p95 | 0.415 ms | 0.181 ms | **PASS** |

Performance round 2:

| Scenario | Broker off | Broker shadow | Result |
| --- | --- | --- | --- |
| Single PTY | 49.444 ms p50 / 52.266 ms p95 / 40.45 MiB/s | 48.690 / 52.765 / 41.08 | **PASS** |
| Four PTYs | 62.954 / 63.432 / 127.08 | 62.687 / 67.628 / 127.62 | **PASS** |
| Event first-byte p95 | 0.052 ms | 0.034 ms | **PASS** |
| Event burst p95 | 0.348 ms | 0.221 ms | **PASS** |

### Retained Linux attempts

1. The first invocation stopped before container creation because Docker
   Desktop was not running: `Docker Desktop Linux engine is unavailable`.
2. After Docker started, the first functional run reached native tests. Bash
   passed, while zsh correctly failed exact-line validation because the
   container had no explicit UTF-8 locale and rendered Chinese input as
   `<ffffffff>`. The fixture was fixed to `C.UTF-8`; this attempt is not a pass.
3. A `zsh/system sysopen -o cloexec /dev/fd` hardening experiment passed on
   macOS but left Linux integration initializing. It was replaced, not waived,
   by the cross-platform non-inherited private FIFO design. The final focused
   run above passes that design on Linux bash and zsh.

The ephemeral container currently re-downloads Cargo registry sources on each
run even though `/cargo-target` is reused. This is a runner efficiency issue,
not a functional skip or pass substitution.

## Windows evidence boundary

Native command:

```powershell
pnpm test:terminal-visible:windows
```

Local result on macOS:

```text
MISSING: native Windows/ConPTY execution is required; current platform is darwin/arm64.
exit code 2
```

Static supporting evidence:

| Command | Result |
| --- | --- |
| `node --check scripts/verify-terminal-broker-windows.mjs` | **PASS** |
| Windows runner/protocol/architecture Vitest contracts | **PASS** |
| Generated PowerShell integration unit contract | **PASS** |
| `cargo check --locked --manifest-path src-tauri/vendor/portable-pty/Cargo.toml --target x86_64-pc-windows-msvc --tests` | **PASS — static vendored ConPTY cfg only** |
| Same check for `aarch64-pc-windows-msvc` | **PASS — static vendored ConPTY cfg only** |
| Native Windows PowerShell 5.1 ConPTY test | **MISSING** |
| Native PowerShell 7 ConPTY test | **MISSING** |

The Windows runner requires a matching x64 or ARM64 MSVC Rust host, probes both
PowerShell versions, runs each exact ignored native integration test, and exits
nonzero for every missing prerequisite. Static evidence does not discharge the
native lane. The user explicitly allowed this native validation to remain
deferred for Phase 3. It is a hard debt before Phase 6 default enablement or
legacy-wrapper removal.

## Earlier repository-wide verification

The following full-project results predate the final adversarial corrections.
The current-source targeted results are authoritative for those corrections and
are recorded above.

| Command | Exact result |
| --- | --- |
| `pnpm test` | **PASS — 199 files passed, 1 skipped; 1,818 tests passed, 1 skipped** |
| `pnpm build` | **PASS — 2,806 modules transformed**; existing dynamic-import and chunk-size warnings only |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check` | **PASS** |
| `cargo check --locked --manifest-path src-tauri/Cargo.toml --all-targets` | **PASS** |
| Full serialized Rust command above | **PASS — 761 passed / 28 ignored; 5 integration passed** |
| `pnpm check:ai-styles` | **PASS** |
| `pnpm check:llm:catalog` | **PASS — 55 models; 4 negative fixtures rejected** |
| `git diff --check` | **PASS** |
| `pnpm check:rust:includes` | **KNOWN OUT-OF-SCOPE FAILURE** only in the four pre-existing protected include files listed below |

The unchanged include-format debt remains in
`image_tests.rs`, `runtime_archive_tests.rs`, `runtime_loop_guard_tests.rs`, and
`session_inbox_steer_tests.rs`. Phase 3 did not edit those files.

## Exact worktree status and Phase 3 files

The final authoritative `git status --short` is recorded below. It includes the
shared uncommitted Phase 0–2 initiative plus Phase 3; no existing change was
reverted, staged, committed, tagged, pushed, or reclassified.

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
 M src/components/terminal/terminal-controller-layer.tsx
 M src/components/terminal/terminal-pane.tsx
 M src/hooks/__tests__/useReconnectSession.test.ts
 M src/hooks/useReconnectSession.ts
 M src/lib/ai/__tests__/session-adapters.test.ts
 M src/lib/ai/conversation-projection.ts
 M src/lib/ipc/__tests__/tauri.test.ts
 M src/lib/ipc/tauri.ts
 M src/locales/en-US.ts
 M src/locales/zh-CN.ts
 M src/stores/__tests__/terminalStore.test.ts
 M src/stores/terminalStore.ts
 M src/types/agent-session.ts
 M src/types/index.ts
?? protocol/agent/runtime/fixtures/
?? protocol/agent/runtime/terminal-execution-compatibility.md
?? protocol/agent/runtime/terminal-execution-phase-0-baseline.md
?? protocol/agent/runtime/terminal-execution-phase-2-acceptance.md
?? protocol/agent/runtime/terminal-execution-phase-3-acceptance.md
?? protocol/agent/runtime/terminal-execution-roadmap.md
?? protocol/agent/runtime/terminal-execution-test-matrix.md
?? protocol/agent/runtime/terminal-protocol-rfc.md
?? protocol/agent/runtime/terminal-protocol-v1.schema.json
?? scripts/__tests__/terminal-broker-windows-runner.test.mjs
?? scripts/__tests__/terminal-protocol-contract.test.mjs
?? scripts/verify-terminal-broker-linux-container.mjs
?? scripts/verify-terminal-broker-windows.mjs
?? src-tauri/src/agent_runtime/native/terminal_execute.rs
?? src-tauri/src/terminal_broker.rs
?? src-tauri/src/terminal_integration.rs
?? src/components/ai/__tests__/agent-execution-surface-selector.test.tsx
?? src/lib/terminal/__tests__/terminal-surface-semantics.test.ts
?? src/lib/terminal/terminal-surface-semantics.ts
?? src/locales/__tests__/
?? tests/terminal-broker-linux/
```

Phase 3 specifically adds or updates:

- `src-tauri/src/terminal_integration.rs` and
  `src-tauri/src/agent_runtime/native/terminal_execute.rs`;
- Broker lifecycle/capture/rollout state, Agent native routing, contracts,
  uncertainty/recovery, local shell startup, and Tauri integration events;
- frontend generation-safe integration projection and typed takeover flow;
- native-tool and JSON schemas, protocol/RFC/compatibility/matrix docs;
- macOS/Linux/Windows runners and regression tests; and
- bilingual uncertainty copy.

The project-maintained `src-tauri/vendor/portable-pty/` has no Phase 3 diff.

## Known risks and follow-up boundaries

- **Documented cooperative-model risk:** the POSIX FIFO does not authenticate
  arbitrary same-UID writers, and PowerShell integration internals are reachable
  to deliberate code executing inside that shell. Neither path is a security
  sandbox. Users and Agents must select Direct for adversarial/untrusted code or
  security-sensitive lifecycle assurance; the runtime additionally forces known
  sensitive/destructive/external effects to Direct.
- **PowerShell native exit-status debt:** `$LASTEXITCODE` can be stale after a
  cmdlet failure. Native Windows evidence must establish the actual
  native-vs-cmdlet behavior for Windows PowerShell 5.1 and PowerShell 7 before
  either lane is called ready; the current static candidate does not overclaim
  exact provenance.
- Native Windows/ConPTY execution remains **MISSING** for both PowerShell
  versions. It must prove connect/close/startup-failure/disconnect cleanup as
  well as lifecycle and exit semantics before Phase 6 default enablement or
  legacy removal.
- Bare-metal Linux remains **MISSING** and is not inferred from Docker Desktop.
  The accepted Phase 3 Linux lane is explicitly VM/container evidence.
- Native macOS bash 3.2 lacks modern Readline accepted-line state, so the
  integration uses the bash history builtin as its exact-line fallback. If a
  user disables history so completely that the exact line is unavailable, the
  operation becomes uncertain and the generation degrades; it never fabricates
  a match or completion.
- The new broker/integration/execute flags remain default off. The legacy
  wrapper remains default-on fallback for new operations only and is not
  removed in this phase.
- Remote shell bootstrap, SSH PTY reconnect behavior, screen snapshots, and
  general interactive input/key/wait tools remain later-phase work.

## Recommendation

**PASS for Phase 3 under the explicit 2026-09-15 cooperative-shell RFC
amendment and Windows native-evidence waiver.** Phase 4 is **READY for a
separate session and was not started**. Native Windows remains a hard
pre-Phase-6 debt and must continue to be reported as `MISSING`, never `PASS`.
