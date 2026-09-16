# Terminal Execution Phase 6 macOS Acceptance Evidence

Status: complete — PASS for the macOS local rollout scope
Date: 2026-09-16 (Asia/Shanghai)

## Scope and recommendation

Absent trusted configuration now enables the Broker, shell integration,
`terminal_execute`, and interactive tools for macOS local PTYs. The local
macOS routing graph cannot dispatch the legacy wrapper. Linux and SSH remain
default-off compatibility scopes.

**Final gate: PASS for the macOS local rollout scope. Cross-platform wrapper
removal is NOT READY** because native Linux and isolated SSH Phase 5 evidence
remain missing.

## Requirement evidence

| Requirement | Result | Evidence |
| --- | --- | --- |
| Default enablement | **PASS** | `terminal_broker_v1`, shell integration, execute, and interactive tools are absent-on for macOS and retain dependency gating. |
| Wrapper-free local route | **PASS** | Ready bash/zsh routes select `terminal_execute`; degradation or rollback selects `Unavailable`, never the wrapper. Direct `pty` dispatch returns `TERMINAL_LEGACY_WRAPPER_REMOVED_ON_MACOS`. |
| Phase 2/3 native behavior | **PASS** | Exact bash and zsh PTY Broker plus visible-command fixtures preserve raw bytes, resize, shell state, lifecycle, capture, cancellation, timeout, takeover, and uncertainty. |
| Phase 5 native behavior | **PASS** | Exact bash/zsh interactive fixtures cover REPL, single-key confirmation, resize, alternate screen, credential rejection, and raw observation. |
| Direct and compatibility regression | **PASS** | Local Direct process tests pass; remote and Linux wrapper code remains compiled and independently routed. |
| Full regression | **PASS** | Serial Rust: 798 library tests passed, 34 ignored; 5 integration tests passed. Formatting and all-target check pass. |
| Release performance | **PASS** | Two independent final rounds exceed the 80% median-throughput floor and keep Broker event p95 below 2 ms. |

## Final performance rounds

| Round | Scenario | Control | Broker | Result |
| --- | --- | ---: | ---: | --- |
| 1 | Single PTY throughput | 80.36 MiB/s | 83.73 MiB/s | **PASS** |
| 1 | Four-PTY throughput | 156.12 MiB/s | 156.38 MiB/s | **PASS** |
| 1 | Event first-byte p95 | 0.006 ms | 0.008 ms | **PASS** |
| 2 | Single PTY throughput | 81.09 MiB/s | 89.32 MiB/s | **PASS** |
| 2 | Four-PTY throughput | 157.12 MiB/s | 154.81 MiB/s | **PASS** |
| 2 | Event first-byte p95 | 0.011 ms | 0.012 ms | **PASS** |

An earlier attempt is **NOT A PASS**: one five-sample Broker single-PTY p95 was
32.109 ms versus a 23.335 ms control p95 and exceeded the Phase 0 allowance.
Median throughput remained 95.9% of control and event p95 was 0.005 ms. The
fail-closed runner stopped immediately; the complete independent rerun above
passed both required rounds without changing thresholds.

## Verification entry point

`pnpm test:terminal-rollout:macos` validates the Darwin host tuple and required
shells, runs targeted and exact native fixtures, the full serial Rust suite,
and two release benchmark rounds. Missing platform prerequisites exit with
status 2 rather than producing a partial pass.

Successful terminal line:
`macOS Phase 2/3/5/6 native PTY and rollout acceptance: PASS.`
