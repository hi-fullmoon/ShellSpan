# Terminal Execution Platform Test Matrix

2026-11-02 P4 code-only update: legacy projection/typing/redraw implementation
and source-input producers are retired. Wire labels/history remain readable;
new Agent source requires native negotiation, with ZLE/PSReadLine production
editor profiles still empty. GNU Bash retains its separate source-matching
catalogue and exact bound-shell/module SHA admission. Existing private job
management and ordinary/TUI input remain supported.
The current code has only compile/type/static evidence. Fresh NIP read-timing
captures, source/copy/search, continuous display, viewport, cancellation and
cross-platform acceptance are mandatory pending gates; old pass/fail records
below do not validate the current revision. See [current acceptance boundaries](../../../docs/design/agent-terminal-input.md).

Status: accepted Phase 0 matrix; Phase 3 cooperative-shell amendment: 2026-09-15; remote bound-terminal reuse gate added 2026-09-17.

Protocol: [Terminal Session Protocol v1](./terminal-protocol-rfc.md)

2026-10-23 stage-two native-script evidence is tracked separately in
[the current unification plan](./visible-terminal-unification-plan.md).
macOS and isolated SSH Bash/Zsh evidence does not extend earlier Windows passes
to the new script path. The native Windows continuation is tracked in
[the Windows acceptance report](./windows-native-terminal-acceptance.md), including
foreground cancellation, raw output, guarded state and complete descendant
cleanup. The known independent scoped HTTP/SSH gate gap remains open.

Stage-four desktop/model evidence and independent Windows native/frontend gates
are recorded separately in [the Windows desktop continuation](./windows-desktop-terminal-acceptance.md).
Supported Windows shells now default to native jobs; explicit `0` disables the
capability for newly prepared shells. On 2026-10-25 the complete normal native
gate and the full Windows frontend gate passed in separate frozen runs, with
identical code/tests/configuration; prior combined failures remain failures.
This does not close the Linux native-desktop or other-architecture lanes.
The final complete-tree frontend supplement contains 1318 frozen inputs and
292 discovered test files: 2611 passed / 6 existing skipped. It additionally
checks the actual route-schema tests and builds the offline trace example
that were absent from the earlier 1316-input Windows snapshot. Full-set
comparison checks added and deleted files as well as matching hashes.

## Evidence policy

Each cell is evidence from the named native host or fixture. Conditional
compilation on another platform is not a pass. A skipped, ignored, unavailable,
or unrun cell is recorded as **MISSING**, never inferred from another platform.
Tests use deterministic commands and must not depend on a developer's prompt
text, shell theme, credentials, or home-directory contents.

Required host lanes are:

| Lane | Minimum environment | Shells / transport |
| --- | --- | --- |
| macOS | current supported arm64 or x86_64 macOS | zsh and bash over local PTY |
| Linux | current supported x86_64 or arm64 distribution | bash and zsh over local PTY |
| Windows | current supported x86_64 or arm64 Windows | Windows PowerShell 5.1 and PowerShell 7 over ConPTY |
| Isolated SSH | `tests/ssh-e2e` Docker image and loopback-published port | Alpine bash/zsh interactive SSH PTYs plus unsupported `/bin/sh`; no external host |

## Cross-platform behavior matrix

`P0` means the current baseline must be captured in Phase 0. Later labels name
the first phase that must supply acceptance evidence.

| Scenario | macOS | Linux | Windows | Isolated SSH | Gate |
| --- | --- | --- | --- | --- | --- |
| Direct foreground stdout/stderr/exit | native process | native process | native process | SSH exec | P0 and every phase |
| Direct background handle, stdin, wait, kill | native process | native process | native process | SSH exec handle | P0 and every phase |
| Current-shell native background jobs, shared stream, prompt reuse, exit/stop and cleanup | real Bash 5.3 / Zsh 5.9 PTY | native desktop pending | 5.1/7 on the named x64 host: supported shells default on, explicit `0` rollback; separate complete native and frontend gates passed; exact versions/snapshots in report | isolated Bash 5.2 / Zsh 5.9 | visible-terminal unification stages 3–4; see dated plan and separate native/desktop Windows reports |
| Direct timeout/cancel terminal-state race | native process group | native process group | job object/process tree | SSH channel | P0 and every phase |
| Real transport smoke and resize | `portable-pty` | `portable-pty` | ConPTY | `pty-req` | P0 baseline; P2 regression |
| Startup listener gate and bounded transport backpressure | native worker + xterm contract | native worker + xterm contract | native worker + xterm contract | SSH worker + xterm contract | P0 baseline; P2 regression |
| Raw byte equality, sequence, replay/dedup, subscriber isolation | zsh/bash | bash/zsh | both PowerShell lanes | `/bin/sh` | P2 |
| Reconnect increments generation and rejects stale frames/input | local replacement | local replacement | ConPTY replacement | disconnect/reconnect | P2/P4 |
| Integration ready/degraded/unavailable and generation-bound cooperative event ordering | zsh/bash/unsupported shell | bash/zsh/unsupported shell | Windows PowerShell/PowerShell 7/unsupported shell | bash/zsh and unsupported `/bin/sh` | P3/P4 |
| Prompt lifecycle independent of prompt text | custom empty/multiline ANSI prompts | custom empty/multiline ANSI prompts | custom functions/themes | custom `PS1` | P3/P4 |
| Wrapper-free state preservation: `cd`, environment, alias/function, shell option | zsh and bash | bash and zsh | each PowerShell | bash and zsh | P3/P4 |
| Exact visible command, ANSI, Unicode, no final newline, nonzero exit | zsh and bash | bash and zsh | each PowerShell | bash and zsh | P3/P4 |
| Large output remains display-complete while capture truncates explicitly | local PTY | local PTY | ConPTY | SSH PTY | P3/P4 |
| Forged lifecycle-like output cannot start/complete a command | local PTY | local PTY | ConPTY | SSH PTY | P3/P4 |
| Ordinary foreground child enumerates descriptors and cannot write a lifecycle endpoint | zsh/bash real PTY | bash/zsh real PTY | static handle non-inheritance plus native ConPTY | SSH PTY | P3/P4 |
| Same-UID endpoint reopen / in-shell hook invocation is documented as cooperative-model tampering, not a sandbox claim | documented adversarial proof | documented adversarial proof | static module-access audit plus native debt | documented boundary | P3/P4 |
| Sensitive/destructive/external effects retain approval and the selected surface; explicit directRequired rejects boundTerminal before input | native route/effect/policy | native route/effect/policy | native route/effect/policy | native route/effect/policy | visible unification 1 |
| Cancel, timeout, completion race, takeover, and input rejection after release | local PTY | local PTY | ConPTY | SSH PTY | P3/P4 |
| Disconnect with side effect is uncertain and never auto-replayed | local close | local close | ConPTY close | forced SSH disconnect | P3/P4 |
| Remote `boundTerminal` resolves the frozen source session and creates no extra terminal | n/a | n/a | n/a | current user SSH PTY; stable tab count | Remote reuse |
| `promptReady = false` or a foreground program blocks every Agent byte | n/a | n/a | n/a | busy source SSH PTY | Remote reuse |
| Remote rollout disable makes active work uncertain, revokes lease/turn guard, and keeps transport open | n/a | n/a | n/a | source SSH PTY stays usable without reconnect | Remote reuse |
| Resize updates rows/columns and screen version | local PTY | local PTY | ConPTY | SSH PTY | P5 |
| REPL, confirmation menu, credential-like prompt, alternate-screen application | deterministic fixtures | deterministic fixtures | deterministic fixtures | deterministic fixtures | P5 |
| Credential-like input/output absent from logs, snapshots, counters, and persisted session | native checks | native checks | native checks | native checks | P5/P6 |
| Transport throughput/latency has no material regression from Phase 0 | baseline harness | baseline harness | baseline harness | baseline harness | P2 and P6 |

## Phase 0 command matrix

| Evidence | Command | Pass condition |
| --- | --- | --- |
| Protocol/compatibility fixtures | `pnpm exec vitest run scripts/__tests__/terminal-protocol-contract.test.mjs` | TSP/1 fixture validates; event-v5 surface fixtures validate; `direct`/`pty` remain accepted. |
| Frontend contracts | `pnpm test` | Relevant contract tests pass; unrelated failure is recorded separately and cannot be called a pass. |
| Direct native execution | `cargo test --manifest-path src-tauri/Cargo.toml agent_runtime::native::process::tests --lib -- --nocapture` | All host-applicable direct process tests pass. |
| Lease behavior | `cargo test --manifest-path src-tauri/Cargo.toml agent_runtime::native::terminal_lease::tests --lib -- --nocapture` | Ownership, frontend readiness, release identity, and restart tests pass. |
| Cooperative visible-command behavior | `cargo test --manifest-path src-tauri/Cargo.toml agent_runtime::native::terminal_execute::tests --lib -- --nocapture` | All host-applicable tests pass; unsupported targets report unavailable. |
| Recovery behavior | `cargo test --manifest-path src-tauri/Cargo.toml agent_runtime::recovery::tests --lib -- --nocapture` plus the visible-terminal recovery filter | An execution without a durable result is uncertain and not resumable/replayed. |
| Current transport contracts | targeted `commands::tests`, `session::tests`, terminal registry, and performance contract tests | UTF-8 boundaries, startup gates, bounded queues, ordering, resize, and high/low-watermark behavior pass. |
| Visible-terminal host gate | `pnpm test:agent-visible-terminal` | Formatting/check, host-native PTY/lease tests, recovery filters, and frontend terminal integration tests pass. |
| Isolated SSH visible gate | `pnpm test:terminal-visible:ssh` | Docker fixture proves current-user SSH PTY `terminal_execute`, shared shell state, busy fencing, fallback to an ordinary shell on integration failure, and no extra terminal; unsupported targets are unavailable. |
| Local transport performance | `cargo run --release --manifest-path src-tauri/Cargo.toml --example terminal_transport_baseline -- --bytes 2097152 --repetitions 5 --sessions 4` | Expected byte counts are received; median/p95 throughput and event-vs-poll latency are recorded. |
| SSH transport performance | Run the same example with `--ssh` and the loopback fixture environment | Expected bytes are received for single and four-session SSH PTYs; measurements are recorded. |

## Deterministic fixture requirements for later phases

The isolated SSH fixture must remain loopback-only and disposable. Later phases
may extend it with scripts for persistent directory/environment state, resize,
forced disconnect, side-effect counters, REPL/menu/password-like prompts, and an
alternate-screen application. Fixture secrets are test-only constants and must
still be redacted from captured evidence. Host credentials or arbitrary user
terminals are never used for acceptance tests.

Every later-phase handoff updates this matrix with exact command output and
marks unexecuted native platforms **MISSING**. A platform-scoped gate may pass
only for its evidenced platform; it does not imply or enable another platform.

## Phase 2 acceptance status

Detailed evidence: [Terminal Execution Phase 2 Acceptance Evidence](./terminal-execution-phase-2-acceptance.md).

| Lane | Phase 2 result | Evidence boundary |
| --- | --- | --- |
| macOS zsh | **PASS** | Native Darwin arm64 host |
| macOS bash | **PASS** | Native `/bin/bash` PTY; explicit raw-byte Broker test |
| Linux bash and zsh | **PASS (VM/container)** | Debian 12/aarch64 inside Docker Desktop LinuxKit; not bare-metal |
| Isolated SSH `/bin/sh` | **PASS** | Loopback-only disposable SSH fixture |
| Windows PowerShell 5.1 and PowerShell 7 | **PASS** | Native Windows 11 x64 / ConPTY consolidated gate passed on 2026-09-16; exact Broker tests and two release performance rounds passed. |
| Bare-metal Linux | **MISSING** | Docker Desktop evidence is not promoted to bare-metal evidence; bare metal is not an additional Phase 2 minimum-environment requirement |

Native Windows command: `pnpm test:terminal-broker:windows`. The command must
exit nonzero with an explicit `MISSING` result when Windows PowerShell 5.1,
PowerShell 7, a supported x86_64 or arm64 Windows host, or the matching MSVC
Rust host toolchain is unavailable. The architecture mapping is
`x64` -> `x86_64-pc-windows-msvc` and
`arm64` -> `aarch64-pc-windows-msvc`.

The original Phase 2 waiver is closed. `pnpm test:terminal-interactive:windows`
runs this entry point plus the Phase 3 and Phase 5 Windows lanes and exits
nonzero if any required host, shell, functional, or performance check fails.

## Phase 3 acceptance status

Detailed evidence: [Terminal Execution Phase 3 Acceptance Evidence](./terminal-execution-phase-3-acceptance.md).

Overall gate: **PASS for Phase 3 under the 2026-09-15 cooperative-shell RFC
amendment**. The macOS, Linux, and Windows lanes pass their functional and
in-scope gates. The private
POSIX FIFO is a generation-bound isolated control plane, not authentication
against arbitrary same-UID code: raw PTY bytes cannot reach it, ordinary
foreground children inherit no writer, and deliberate same-UID reopen or
in-shell hook tampering is recorded as out-of-scope. Security-sensitive or
explicit adversarial/untrusted lifecycle requests were forced to Direct in that
historical gate. Current routing is governed by
[visible-terminal unification](./visible-terminal-unification-plan.md): effects
retain approval, while explicit directRequired rejects boundTerminal without
an automatic surface change.

| Lane | Phase 3 result | Evidence boundary |
| --- | --- | --- |
| macOS zsh | **PASS** | Native Darwin arm64 production-config real PTY matrix; raw-output forgery, descriptor non-inheritance, path non-disclosure, state, capture, cancellation, takeover, and uncertainty gates pass. Same-UID active reopen remains the documented cooperative non-goal. |
| macOS bash | **PASS** | Native Darwin arm64 `/bin/bash` 3.2 production-config real PTY matrix with the same in-scope security and behavior gates. |
| Linux bash and zsh | **PASS (VM/container)** | Debian 12/aarch64 inside Docker Desktop LinuxKit with `C.UTF-8`; focused post-amendment production logic passes and is not promoted to bare-metal evidence. |
| Windows PowerShell 5.1 and PowerShell 7 | **PASS** | Native Windows 11 x64 / ConPTY independently passed exact lifecycle, persistent cwd/environment/alias/function state, ANSI/Unicode, native exit `7`, cmdlet failure `1`, and large-output capture on 2026-09-16. |
| Isolated SSH `/bin/sh` | **NOT APPLICABLE TO PHASE 3** | Remote real-terminal integration remains Phase 4 and was not started. |
| Bare-metal Linux | **MISSING** | VM/container evidence is not promoted to bare-metal; bare metal is not an additional Phase 3 minimum-environment requirement. |

Phase 3 native Windows entry: `pnpm test:terminal-visible:windows`. On a complete
Windows host it requires and runs both
`windows_powershell_5_1_visible_command_integration` and
`windows_powershell_7_visible_command_integration` over real ConPTY. On any
non-Windows host, missing PowerShell lane, unsupported architecture, or
mismatched Rust host it exits nonzero and reports `MISSING`. The native Windows
run passed on 2026-09-16 and closed the earlier waiver.

## Phase 4 acceptance status

Detailed evidence: [Terminal Execution Phase 4 Acceptance Evidence](./terminal-execution-phase-4-acceptance.md).

Overall gate: **PASS for the historical Phase 4 remote POSIX lane**. The isolated loopback Docker
fixture runs SSH `pty-req` plus interactive bash/zsh shells, uses a separate
cooperative control channel, and keeps a simultaneous user-owned SSH PTY
independent. Unsupported `/bin/sh` is explicitly `unavailable`. Direct SSH exec
passes independently. The separate native Windows prerequisite passed in the
2026-09-16 consolidated Windows gate; it is not part of the remote POSIX gate.

| Lane | Phase 4 result | Evidence boundary |
| --- | --- | --- |
| Isolated SSH bash | **PASS** | Alpine 3.22/aarch64 container in Docker Desktop LinuxKit; real SSH PTY, lifecycle/state/capture/resize/control/disconnect/reconnect matrix. |
| Isolated SSH zsh | **PASS** | Same isolated sshd; independently authenticated zsh login and state-preservation smoke. |
| Isolated SSH unsupported `/bin/sh` | **PASS (explicit unavailable)** | Separate fixture account proves no false-ready integration. |
| Direct SSH exec | **PASS** | Existing reviewed SSH execution fixture runs independently of remote terminal flags/channels. |
| User-owned SSH PTY isolation | **PASS (historical topology)** | A simultaneous real user-owned SSH shell retained its own state and was not selected by the original `terminal_execute` route. The current reuse gate below supersedes that topology and requires the frozen user SSH PTY to be selected. |
| Native Windows PowerShell 5.1 / PowerShell 7 prerequisite | **PASS** | Consolidated native Windows Phase 2/3/5 gate passed on 2026-09-16. |

Phase 4 entry point: `pnpm test:terminal-visible:ssh`. It builds the disposable
fixture, waits for health, runs the exact ignored real-SSH tests plus Direct
regression, and always tears the compose project down.

## Phase 5 acceptance status

Detailed evidence: [Terminal Execution Phase 5 Acceptance Evidence](./terminal-execution-phase-5-acceptance.md).

Overall gate: **PASS for the Windows and macOS local delivery scopes**. The
Phase 5 implementation and deterministic core fixtures pass on native hosts,
including screen rendering,
resize/versioning, REPL/menu text, alternate-buffer state, credential-like
prompt redaction and input rejection, bounded waits, takeover fencing, and
non-persistence of text/paste payloads. Independent native PowerShell 5.1 and
PowerShell 7 ConPTY fixtures additionally exercise the production lease/input,
screen, and credential-safety path.

| Lane | Phase 5 result | Evidence boundary |
| --- | --- | --- |
| Deterministic Windows core | **PASS** | Native Windows Rust tests feed ordered terminal bytes through the production Broker and headless screen model; lease/input/takeover and durable audit boundaries use the production runtime. |
| Windows PowerShell 5.1 / PowerShell 7 over ConPTY | **PASS** | Both exact native fixtures pass REPL text, single-key confirmation, resize, alternate-screen entry/exit, credential-like prompt redaction/input rejection, raw observation, and restored user input. |
| macOS zsh and bash | **PASS** | Native macOS 26.6.2 arm64; both exact real-PTY fixtures pass REPL text, single-key confirmation, resize, alternate-screen entry/exit, credential-like prompt redaction/input rejection, and raw observation. |
| Linux bash and zsh | **MISSING — DEFERRED** | No current-code Phase 5 native PTY fixture has run on Linux; it is outside the first Windows delivery scope. |
| Isolated SSH bash and zsh | **MISSING — DEFERRED** | The Phase 4 SSH fixture has not been extended for Phase 5 interactive scenarios; remote interactive rollout remains off. |

The Windows and macOS Phase 6 continuations are complete. Remote visible
commands now use the current-user SSH bound-terminal path on those desktop
hosts. Linux and remote interactive tools retain default-off flags. Rollback
makes remote visible commands unavailable; it does not restore a wrapper or a
dedicated Agent SSH terminal.

## 当前输入实现

当前架构及待验项统一见[原生终端输入](../../../docs/design/agent-terminal-input.md)。历史阶段报告不能作为当前源码通过的证明；不再安排旧实现兼容验收。

## Remote bound-terminal reuse current gate

This gate is authoritative for current remote `boundTerminal` behavior. The
historical Phase 4 acceptance remains evidence for what was tested then, but it
does not prove the revised transport topology.

| Requirement | Focused gate | Stage 7 status |
| --- | --- | --- |
| Frozen target `sessionId` resolves directly to the current user SSH PTY; no Agent terminal map/event/tab/store field remains | Native route/runtime tests, frontend event/store/tab regressions, and residual source search | **AUTOMATED PASS**; original native-window tab-count check blocked by unavailable computer-use app/window RPC |
| `integrationState = ready` and `promptReady = true` are both required; busy/active-command/generation drift writes no bytes; presentation events are ordered by `integrationStateRevision` rather than the resettable lifecycle cursor | Broker, command presentation, Native adapter/runtime, Terminal Store, and frontend selector/controller tests | **PASS**; real SSH busy fixture plus focused state-revision frontend and Rust regression gates passed 2026-09-17 |
| User and Agent share cwd, environment, aliases/functions, prompt/history startup semantics, and one output stream | `pnpm test:terminal-visible:ssh` bash/zsh real-SSH fixture | **PASS** on the 2026-09-17 isolated Bash/Zsh gate |
| Integration preparation failure still opens an ordinary usable SSH shell and does not create a replacement terminal | Session/commands tests plus no-SFTP/unsupported-shell/control-channel real-SSH fixture | **PASS** on the 2026-09-17 isolated fallback gate |
| Whole-turn guard, per-command lease, takeover fencing, disconnect uncertainty, and no automatic replay | Terminal lease/runtime/Broker focused tests | **AUTOMATED PASS**; native-window takeover presentation remains blocked by unavailable computer-use app/window RPC |
| No implicit Direct fallback; effects retain approval/native deny and explicit directRequired rejects boundTerminal before input | Native adapter/effect/policy focused tests and protocol contract | Current behavior supersedes historical effect-to-Direct routing; see visible-terminal unification stage one |
| `terminal_remote_bound_terminal`, `SHELLSPAN_TERMINAL_REMOTE_BOUND_TERMINAL`, and `remoteBoundTerminalRollout` are authoritative and non-persisted | Environment precedence test, Broker JSON serialization test, TypeScript IPC/type test, residual search | **PASS** in focused and full gates |
| Rollout disable makes incomplete work uncertain, revokes Agent lease/turn guard, preserves the SSH transport, and uses ordinary shell startup on later connection/reconnect | Broker rollback and Native runtime reconciliation regressions | **AUTOMATED PASS**; native-window reconnect presentation remains blocked by unavailable computer-use app/window RPC |

### Stage 7 execution record (2026-09-17, Windows 11 x64)

- The complete §11.4 command sequence passed after one minimal Windows-only
  durability correction in deployment artifact publication. The first full Rust
  run found four deployment artifact failures because `sync_all()` used a
  read-only Windows file handle (`os error 5`); reopening the already-created
  archive with write access fixed the blocker. The five affected focused tests,
  `cargo fmt --check`, and the complete Rust suite then passed.
- `pnpm test:terminal-visible:ssh` passed once without retry. Its isolated Docker
  services proved Bash/Zsh startup compatibility and shared-shell state, busy
  zero-write, takeover fencing, disconnect no-replay, integration cleanup,
  unsupported-shell/no-SFTP fallback, and independent Direct SSH exec.
- Full frontend result: 206 passed files / 1884 passed tests, with one file and
  one test skipped. Full Rust result: 832 passed / 41 ignored, plus five passed
  `petdex_contract_probe` integration tests. The production build and all four
  static/format checks passed.
- Additional UI-adjacent regression evidence passed: eight terminal/Agent files
  with 170 tests, plus 38 TerminalPane tests covering the non-overlaying lease
  bar, takeover button/Escape, input-block announcement, between-command guard,
  failure toast, and disconnect/reconnect presentation.
- The native Tauri app and SSH fixture were launched, but computer-use could not
  enumerate or bind a native window: `@oai/sky` reported `Trusted RPC service is
  not configured: sky`, and the active runtime exposed no native app/window API.
  Therefore native narrow/wide tab-count, takeover, and reconnect observation is
  **NOT RUN**. As a non-equivalent Web substitute, the repository's existing
  `aiComposerVisual` page rendered at 1200×760 and 1600×1000 and showed the bound
  terminal idle, running/stop, and unavailable states with the relevant header
  and composer controls present in the render tree. That page has no Tauri IPC,
  terminal tabs, live lease events, or reconnect transport.

Native Windows command: `pnpm test:terminal-rollout:windows`. It is an alias of
the consolidated host gate and reports `MISSING` rather than `PASS` if the
matching MSVC host, Windows PowerShell 5.1, or PowerShell 7 is unavailable.

Native macOS command: `pnpm test:terminal-rollout:macos`. It reports `MISSING`
rather than `PASS` unless the matching Darwin Rust host, `/bin/bash`, and
`/bin/zsh` are available.

## Native input refactor P0 (2026-10-31)

This is separate from the historical TSP Phase 0 above. Historical commands,
exit codes and build boundaries remain in Git history. Current boundaries are in
the [implementation guide](../../../docs/design/agent-terminal-input.md).

| Gate | Entry | Boundary |
| --- | --- | --- |
| Native local PTY and browsers | `pnpm test:terminal-native-input:p0 --upstream` | Pinned Bash 4.1/4.4/5.3, matching headers, real bytes; any rendering failure is fatal |
| Isolated native SSH | `pnpm test:terminal-native-input:p0:ssh` | Debian 12/aarch64 sshd, loopback port and private forwarding; no business host |
| Both | `pnpm test:terminal-native-input:p0 --upstream --ssh` | Retains an earlier nonzero result |
| Recorded PTY rendering | `SHELLSPAN_P0_CAPTURE_ROOT=<suite> pnpm test:terminal-native-input:p0 --browser-only` | Actual captures, public xterm; no live Tauri/Broker acceptance claim |

**Initial unpatched P0 control NOT PASS:** source/state/cancellation checks have evidence,
but background-output preservation during resize/redisplay fails in browsers.
No production switch or retirement of old input is permitted. P1 may only do
the native-independent state inventory allowed by the implementation plan.

Continuation evidence: `pnpm test:terminal-native-input:p0:background` captures
pure native Bash without loading any bridge, plus paired provider controls.
`--no-resize` / `--no-edit` isolate the combined failure; `--ssh` uses only the
disposable loopback fixture. The report records 45/45 native checks per tested
Bash build and 8/8 browser lanes for the isolated append-provider/generic-reflow
combination. Original and same-bundler unpatched controls remain failing.
The dependency experiment was explicitly authorized in isolation; it is not
adoption into the production package or authorization for P2/P4.

`pnpm test:terminal-native-input:p0:compat` adds 18 real-PTY library cases and
nine actual native-provider ownership-window scenarios, replayed through public
browser APIs. Always-opt-in passes 60/72 and fails 12/72; all 72 default-off
state comparisons match stock. Existing tab-expanded cells survive, but copied
spaces are trimmed by stock selection serialization. Tabs arriving after resize
use the actual column/stops and have separate invariants. Ordinary Readline
should retain false; global true duplicates its redraw. Scoped switching still
fails for a handoff resize gap, delayed open and withheld close. Stock/default
native hard-line redraw differs from no-newline source equality; that stronger
diagnostic is retained, but is not an original ordinary-editing requirement.
Default-false stock state/copy compatibility and actual execution are the
ordinary-native gates. The research
browser entry includes both gates and stays nonzero. Display acknowledgement
does not grant execution authority; production ordering/recovery is unimplemented.

`pnpm test:terminal-native-input:p0:inband` separately tests native-ordered
display signals via documented user-variable transport and a lab-only public
option binding. Its 15 native cases cover queued/fragmented parsing around
resize, cancel/takeover, real background output, TUI/control EOF, normal/SIGHUP
exit, SIGKILL/terminal EOF and stdout without commit authority. This does not
replace the failed global/async controls or the strict tab-copy assertion, and
does not enable a production protocol/capability.

The final in-band scoped profile records 15/15 native cases and 60/60 lanes for
each browser delivery strategy, plus 408/408 library-only packet split/resize
checks. A separate actual commit/resize probe first reproduced hidden-plan echo:
`rl_done` does not prevent post-dispatch SIGWINCH redisplay. The isolated native
prototype retains a non-output redisplay provider until the parent `p0_begin`
builtin, when Readline has returned. Bash 4.1/4.4/5.3 each pass 64/64 dense-resize
commits with no raw wrapper echo and exactly one side effect; the in-band 5.3
probe also checks source → off → actual output order. Native 5.3 regression is
45/45. The raw pre-fix and cursor-only tab-copy failures remain as controls;
production adoption is not granted by those scoped passes.

`pnpm test:terminal-native-input:p0:copy` adds a generic library serialization
repair. **344/344 applicable case lanes pass**, including every paired owned
Tab/copy case; the cursor-only baseline fails 56. Direct unmodified-stock
comparison passes **12/12** representative ordinary default-false lanes (ASCII,
Unicode and real native quoted-insert Tab). Source binding, actual side effects,
full visible owned copy and T05 checks remain mandatory. Strong ordinary
no-hard-newline source equality is diagnostic, not a new frozen goal.

The copy repair is global, not gated by reflowCursorLine. Default-configuration
history with qualifying soft-wrap blank cells intentionally copies differently
to correct the stock defect. Representative ordinary matches do not establish
universal old-copy equivalence. Formal acceptance of that generic rule change is
now explicitly authorized; no business-layer selection/search/buffer override
has been introduced. Unchanged in-band and 192-commit records
are reused after source/module hash checks. See the P0 report for scope/results.
Alternate soft-wrap/Tab resize additionally preserves the actual retained line
width and legacy copy behavior; the initial viewport-width regression remains
as evidence and both cases remain in the final gate.

### Formal package acceptance

User approval covers the global cursor/copy fixes and ordered display mechanism.
The pnpm-patched exact 6.0.0 source and rebuilt UMD/ESM package pass **344/344**
applicable copy/search lanes, **12/12** representative ordinary-native stock
comparisons, **60/60** for each in-band delivery strategy, **408/408** packet
boundaries, **52** explicit display-controller assertions and **8/8** geometry/
theme lanes. Old source/redraw/decorations browser regressions pass with the real
production ESM. Targeted frontend terminal/controller checks pass **166/166** and
the frontend build passes. Full frontend retains **3** unrelated AI assertions
also failing in the isolated unpatched-package baseline; it is not a global pass.

P0 is accepted only for frozen macOS arm64 + GNU Bash 5.3 / Readline 8.3.6, not
other native display platforms. The complete gate is
`pnpm test:terminal-native-input:p0:formal`: missing corpora are generated through
real builds/PTY captures, or explicit capture parameters can replay recorded
evidence. `pnpm test:terminal-native-display` uses the repository's real native
packet fixture and passes from clean source/dependencies without old temp paths.
P1 freezes online identifiers in [NIP](native-input.md); production native
input remains unwired until P2.

### P1 state, ownership and recovery

`pnpm test:terminal-input:p1` rebuilds the pinned native producer from source,
runs the complete pure state/event matrix (504 cases at P1; currently 546 including stop-unconfirmed), existing Broker/executor/
lease checks, real NIP PTY/socket tests, real SIGKILL/restart windows, captured
wire schema validation, and Chromium/WebKit × DOM/WebGL formal display checks.
It also verifies missing native capabilities and rejection of unverified editor
modes; removed tests and old experimental wire cases are no longer invoked.
The entry uses no timestamped build/capture
dependency and enables no production route. See the
[implementation guide](../../../docs/design/agent-terminal-input.md) for current
boundaries; exact historical results remain in Git history.

### P2 native Bash local and SSH migration

The production SessionManager, Agent execution, Broker/lease, durable intent
and frontend registry now carry NIP. Pending acceptance is tracked in the
[implementation guide](../../../docs/design/agent-terminal-input.md); implementation
does not by itself constitute a passed stage. The current candidate profiles
are pinned GNU Bash 4.1/Readline 6.0, 4.4/7.0 and 5.3/8.3.6, on macOS arm64
local PTYs and isolated Linux aarch64/glibc 2.36 SSH targets. Linux target-side
component evidence is distinct from native Linux desktop acceptance.

`pnpm test:terminal-input:p2 -- --fixture <owned-fixture.json>` runs the complete
entry. `--components-only` explicitly excludes complete application acceptance.
The actual-app matrix has 45 independent cases: five native history settings,
the existing default legacy-client baseline and complete job tooling for each
version/transport, plus one registry lifecycle case per version over SSH.
Every case has its own application data, HOME, PTY and credential reference.
Failed cases retain their original result; the matrix checks the remaining
independent combinations and exits nonzero if any case fails. It never retries
an operation or repairs model-generated tool parameters.
`--case <version/transport/scenario>` selects explicit missing or failed cases
in new contexts; a selected subset is never reported as a complete matrix.

New isolated P2 GUI runs build and retain static frontend assets, serve them
through Vite preview without HMR, and launch Tauri with `--no-watch` and an
isolated Cargo target. A single-use HTML entry rejects reloads with HTTP 409.
Source and asset hashes are checked around build/start/result/exit; the actual
signed image is checked before launch and after exit. Drift invalidates the
run. Offline build/HTTP/source-and-asset drift checks are separate from native
application acceptance. Earlier evidence keeps its recorded provenance and is
never backfilled with a new static-asset or image-end claim. The cumulative
summarizer reports ordinary and frozen coverage separately; `--require-frozen`
requires the complete frozen checkpoints and retained asset hashes.

Separate real application gates cover private SSH EOF/no-replay/reconnect,
alternate-screen/REPL/confirmation/credential rejection and physical interrupt,
delegation/child takeover, contention/confirmed takeover and running/idempotent
close. Read-only evidence records the actually accepted peer profile and binding,
full-input proof and durable intent; these observations confer no execution
authority. Public browser checks consume real target PTY streams with actual
mid-input geometry changes, exact source selection/search and unmodified APIs.
Source reconstruction and a signed release resource-directory smoke protect
distribution separately. Old clients remain on their existing path; unaccepted
native profiles remain unavailable. No Zsh/PowerShell native migration, extra
architecture or business-host acceptance is inferred from these lanes.

As of 2026-11-01, the frozen Bash production snapshot `815bf51a` has verified
42/42 required and 3/3 lifecycle cases, including full retained static assets
and actual signed-image exit checks. Its strict single-source report is
`.native-input-p2/evidence-summary/eff93fac-662f-459c-a539-080c0c53e773/summary.json`.
The complete auxiliary report `a5a5223e-ac4e-42e0-b82b-0f48789dd552` additionally
includes the production-identical, four-file test revision `4f37bd17` for the
fresh-task credential-input gate. It requires the same transport, terminal and
generation for role full-input/durable proofs. The original complete entry
`validation/4440e397-1a80-48d6-bdca-8f9c3acc4b27` remains FAIL; new isolated
supplements do not rewrite its result or replay its operations.

The later `4c61dfe8` revision changes the private legacy Zsh stty helper and is
not production-identical to `815bf51a`. Its two real Zsh stress regressions,
13 actual NIP tests (0 ignored) and two checkpoint regressions pass separately;
earlier Bash images are not described as a full matrix of this revision.
This compatibility fix does not constitute the P3 ZLE migration. Exact source
paths, original failures and scoped stage completion are recorded in the audit.
