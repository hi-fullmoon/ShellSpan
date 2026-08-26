# Terminal performance baseline (phase 1)

Recorded on 2026-08-26 for commit `6e9f36c6abfbddceb352e3da15a99b975d4476f3` plus the pre-existing uncommitted worktree changes. This phase only establishes repeatable measurements; it does not change terminal production logic.

## Environment

- macOS/Darwin 25.6.0, arm64, Apple M4 Pro, 24 GiB RAM
- Node.js 24.15.0, pnpm 11.1.1, Vitest 4.1.10, xterm.js 6.0.0
- rustc/cargo 1.95.0; Rust transport measurements use the release profile
- Docker 29.7.2 with the repository's `tests/ssh-e2e` Alpine/OpenSSH fixture
- AC power, normal interactive desktop load; no CPU affinity or frequency pinning

Use medians for phase-to-phase comparison. The p99/RME columns are diagnostics for noisy runs, not pass/fail thresholds. Run each command at least twice after the first dependency/build warm-up and compare like-for-like environments.

## Reproduction commands

Frontend hot paths (single worker, warm-up before every case):

```sh
pnpm benchmark:terminal
```

To retain machine-readable output or compare two runs with Vitest:

```sh
pnpm exec vitest bench --run --config scripts/perf/vitest.config.ts --outputJson /tmp/termbridge-terminal-before.json
pnpm exec vitest bench --run --config scripts/perf/vitest.config.ts --outputJson /tmp/termbridge-terminal-after.json
pnpm exec vitest bench --run --config scripts/perf/vitest.config.ts --compare /tmp/termbridge-terminal-before.json
```

Local PTY transport (2 MiB/session, five measured repetitions, one warm-up, one and four sessions):

```sh
pnpm benchmark:terminal:transport
```

Isolated SSH PTY transport:

```sh
docker compose --project-name termbridge-perf --file tests/ssh-e2e/compose.yml up --build --detach --wait
env TERMBRIDGE_E2E_SSH_HOST=127.0.0.1 TERMBRIDGE_E2E_SSH_PORT=22222 TERMBRIDGE_E2E_SSH_USERNAME=termbridge TERMBRIDGE_E2E_SSH_PASSWORD=termbridge-e2e pnpm benchmark:terminal:transport --ssh
docker compose --project-name termbridge-perf --file tests/ssh-e2e/compose.yml down --volumes --remove-orphans
```

The transport entry accepts `--bytes N`, `--repetitions N`, `--sessions N`, and `--ssh`. Keep the defaults for comparisons with this report.

## Current frontend baseline

Each value is milliseconds per named operation from the final baseline run. Median is the primary comparison metric.

| Scenario | Median | p99 | RME | Samples |
| --- | ---: | ---: | ---: | ---: |
| 1,000 connected input events through the JS IPC wrapper | 0.774 ms | 1.283 ms | 1.04% | 1,227 |
| Append 256 KiB as 64 × 4 KiB chunks, AI panel closed | 0.131 ms | 0.715 ms | 3.77% | 6,420 |
| Same append plus one coalesced AI context extraction | 5.087 ms | 6.009 ms | 0.64% | 196 |
| Extract up to 2,000 lines from a saturated 256 KiB buffer | 4.763 ms | 12.988 ms | 3.26% | 204 |
| Four sessions, each append 256 KiB and extract context | 18.381 ms | 25.988 ms | 2.65% | 40 |
| xterm parser/buffer, one session, 512 KiB as 8 KiB writes | 5.342 ms | 9.420 ms | 2.66% | 137 |
| xterm parser/buffer, four sessions, 512 KiB each | 17.736 ms | 19.215 ms | 0.83% | 43 |

The input contract separately records deterministic amplification: 1,000 input events request 1,000 `write_session` IPC calls and 2,000 frontend debug-log writes (started/completed). The timed result mocks the native IPC and logging sinks, so it measures JavaScript wrapper/scheduling cost, not disk logging or WebView-to-Rust latency.

The AI-open workload models the implementation's animation-frame coalescing: many output notifications followed by one context extraction/render input. On this machine its median is about 4.96 ms higher than the AI-closed buffer-only path. This isolates the context preparation delta; it does not claim a full React paint measurement.

## Current PTY transport baseline

Each session emits 2 MiB. Multi-session throughput is aggregate across four concurrent sessions.

| Scenario | Median | p95 | Median throughput |
| --- | ---: | ---: | ---: |
| Local PTY, one session | 14.212 ms | 14.879 ms | 140.73 MiB/s |
| Local PTY, four sessions | 38.634 ms | 62.428 ms | 207.07 MiB/s aggregate |
| Isolated SSH PTY, one session | 108.921 ms | 114.431 ms | 18.36 MiB/s |
| Isolated SSH PTY, four sessions | 126.136 ms | 132.876 ms | 63.42 MiB/s aggregate |

Local PTY timing includes PTY creation, helper-process spawn, output generation, and master-side drain. SSH timing includes local TCP connection, SSH handshake, password authentication, PTY request, remote command, and drain against the Docker fixture. It intentionally excludes host-key policy and the Tauri event bridge so the transport can be measured independently.

## Coverage and limitations

- Exact production TypeScript functions are used for terminal output append, trimming, ANSI/render normalization, redaction, context truncation, and `invokeWriteSession` wrapping.
- xterm is exercised in jsdom without opening a renderer. The result covers parser and scrollback-buffer work, not DOM layout, paint, GPU work, or a real Tauri WebView.
- AI closed/open compares buffer-only work with one coalesced context extraction. Full `AiPanel` React commit and browser paint are outside this low-noise microbenchmark.
- Native IPC, Tauri event serialization, and frontend log-file I/O are represented by deterministic call counts rather than wall-clock timings; they require an instrumented packaged application for reliable end-to-end latency.
- The SSH fixture is loopback and deterministic. It is suitable for regression comparison, not representative WAN latency or throughput.
- Four sessions are the maintained multi-session baseline. Larger fan-out can be sampled with `--sessions`, but should be recorded as a separate series.

## Next-phase measurement guidance

Before changing a hot path, save a JSON run and the PTY table on the same machine. After the change, rerun the same commands and compare medians plus p99/RME. The first optimization candidates suggested by this baseline are input IPC/log amplification and AI-context preparation, but deciding or implementing those changes belongs to phase 2.
