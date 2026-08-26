# Terminal performance baseline and phase results

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

The same command now also reports 41-sample reader-to-worker first-byte and
20 ms low-frequency-burst latency. It retains the former 16 ms polling loop as
a measurement-only reference and runs the event-driven queue used by local
sessions; neither latency case creates a Tauri window or measures WebView event
delivery.

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

## Phase 2 input IPC result

Recorded on 2026-08-26 at `a99b943` plus the same pre-existing uncommitted worktree changes. The before and after JSON runs used the frontend reproduction command above on the same machine. Only the terminal input/control IPC wrapper changed; neither run batches input events or measures native IPC latency.

| 1,000-event connected-input burst | Median | p99 | RME | Samples | Throughput |
| --- | ---: | ---: | ---: | ---: | ---: |
| Before direct terminal IPC path | 0.809000 ms | 1.194917 ms | 0.96% | 1,183 | 1,182.44 ops/s |
| After direct terminal IPC path | 0.069917 ms | 0.203417 ms | 1.02% | 13,287 | 13,286.74 ops/s |

The median improved by 11.57x, a 91.4% reduction. An additional after run produced a 0.0728 ms mean at 13,730.48 ops/s, consistent with the saved JSON run.

The input contract captures the deterministic amplification separately from timing:

| Work requested by 1,000 interactive input events | Before | After |
| --- | ---: | ---: |
| `write_session` IPC calls | 1,000 | 1,000 |
| Generated operation IDs | 1,000 | 0 |
| Generic IPC debug logs | 2,000 | 0 |
| Empty invocation-history start/finish wrapper calls | 2,000 | 0 |
| Operation-history events containing interactive input | 0 | 0 |

`write_session` now returns the native `invoke` promise directly, so rejection identity and caller-observed errors are preserved without another async wrapper. Input dispatch order remains the call order, with exactly one IPC per event. The same direct, untracked terminal-control boundary covers output backpressure pause/resume and debounced, deduplicated resize IPC; their controller call sites retain contextual failure handling and resume retry behavior. One-shot listener setup operations (`get_session_status` and `mark_session_ready`) remain on the logged lifecycle path.

## Phase 3 WebGL renderer result

Recorded on 2026-08-26 on the same worktree and machine. The existing `@xterm/addon-webgl` dependency is active again; no dependency or lockfile change was required.

The terminal controller now attempts one WebGL addon activation after its first successful `Terminal.open()`. Successful activation removes the DOM-only viewport-hiding class so the xterm scrollbar remains usable. Constructor or activation failure disposes any partially registered addon and leaves xterm's DOM renderer active with the viewport class restored. A WebGL context-loss notification disposes the context-loss subscription and addon; xterm then creates its DOM renderer again. The controller retains the same `Terminal`, parser, buffer, container, listeners, output backpressure state, and session binding throughout that fallback.

Renderer initialization belongs to the controller rather than an attachment or session generation. Consequently detach/reattach and rebind/reconnect do not load another addon or context-loss listener. Controller disposal tears down the subscription and addon before disposing xterm; double disposal remains a no-op. The existing resize path was not changed: `ResizeObserver` reflow remains debounced by 100 ms, the latest proposed size wins, and both unchanged grids and previously sent PTY dimensions are deduplicated.

### Correctness verification

- `pnpm exec vitest run src/components/terminal src/lib/__tests__/terminal-output-buffer.test.ts src/lib/__tests__/terminal-workspace.test.ts src/lib/__tests__/terminal-workspace-persistence.test.ts src/stores/__tests__/terminalStore.test.ts scripts/__tests__/terminal-performance-contract.test.ts`: 16 files and 245 tests passed.
- The focused registry suite has explicit cases for WebGL success, constructor and activation failure, context loss, detach/reattach, rebind, dispose, DOM/WebGL viewport class behavior, buffer identity, the 100 ms resize debounce, and unchanged-size deduplication.
- `pnpm build`: TypeScript and the Vite production build passed. The existing large-chunk advisory remains; the WebGL addon was already part of the terminal dependency chunk.
- A temporary local Vite probe imported the production terminal registry in the Codex in-app Chromium browser. It observed a successfully activated addon, a real WebGL2 context, two xterm canvases, and the viewport visible in WebGL mode. Forcing `WEBGL_lose_context` and waiting through xterm's three-second restoration window produced the production context-loss callback: the addon was disposed, the DOM viewport class returned, and terminal identity and buffer length were preserved. The probe was removed after verification.

### Phase 3 frontend benchmark

`pnpm benchmark:terminal` passed before and after the implementation. The console runner reports arithmetic mean rather than median, so the like-for-like phase 3 reference below uses the reported mean and diagnostics without relabeling them as medians.

| jsdom xterm parser/buffer workload | Before mean | After mean | Before p99 | After p99 | After RME | After samples |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| One session, 512 KiB as 8 KiB writes | 5.2040 ms | 5.4066 ms | 6.1109 ms | 6.0505 ms | 0.88% | 139 |
| Four sessions, 512 KiB each | 17.4589 ms | 17.9874 ms | 19.8222 ms | 18.8525 ms | 0.97% | 42 |

The final full run also reported 0.0771 ms mean for 1,000 connected input events, 0.1523 ms for the 256 KiB AI-closed buffer append, 5.0217 ms for append plus one AI context extraction, 4.8148 ms for the saturated-buffer extraction, and 18.3032 ms for four-session append plus extraction. A preceding after-run had an AI-open outlier (13.80% RME); the repeated final run returned to 5.0217 ms with 0.41% RME. No renderer conclusion is drawn from either run.

### Phase 3 validation limits

- The Vitest benchmark still creates xterm in jsdom without `open()`. It measures parser and scrollback-buffer work only; it cannot create a WebGL renderer or measure DOM layout, paint, compositing, GPU throughput, frame time, scrollbar interaction, or a Tauri WebView.
- The real-browser probe establishes activation and fallback correctness in local Chromium, not a GPU performance improvement. It did not run an SSH session or measure sustained output frame rate.
- A packaged Tauri application was not launched in this environment. Standalone Vite does not provide the Tauri IPC/event bridge, so expected bridge errors prevented a meaningful end-to-end session, reconnect, or PTY interaction test. Those behaviors remain covered by existing controller tests and were not changed in phase 3.
- xterm waits up to three seconds for automatic WebGL context restoration before emitting `onContextLoss`. During that upstream recovery window the canvas can be unavailable; after the notification TermBridge permanently uses DOM rendering for that controller rather than repeatedly allocating WebGL contexts.

## Phase 4 AI context and background-session result

Recorded on 2026-08-26 on the same machine and worktree after phases 1–3. Before changing production code, the existing AI-open, unchanged saturated-buffer, and four-session workloads were warmed once and saved twice as `/tmp/termbridge-phase4-before-{1,2}.json`. The final lazy-cache implementation was saved three times as `/tmp/termbridge-phase4-after-final-{1,2,3}.json`; the third run exists because the second incremental mean contained one 29 ms outlier. Medians were stable, so the tables use the low-RME run for diagnostics and ranges only where repeated medians are more honest.

### Hot-path design and invalidation model

The 256 KiB raw UTF-8 chunk buffer, trim behavior, and terminal/xterm write path are unchanged. Each output buffer now has a monotonically increasing version and at most one AI context checkpoint for the current `contextLines` setting. A checkpoint contains only already-redacted lines and the already-redacted final snapshot; decoded raw text is transient and is not retained as a second AI-readable cache.

- An unchanged `(session, version, contextLines)` read returns the same redacted snapshot in O(1), without byte concatenation, `TextDecoder`, ANSI stripping, terminal-text rendering, line slicing, or redaction.
- Below the byte cap, a checkpoint records the next raw chunk index. Output append remains limited to the existing UTF-8 encode/bounded-buffer work and a version increment. After the AI hook coalesces notifications, the next actual read normalizes and redacts all appended chunks once, then combines them with the bounded redacted line tail. Its work is O(new bytes + retained context assembly), not O(all raw bytes per output chunk).
- Incremental reuse is allowed only after a clean newline with no incomplete CSI/OSC escape and no pending cross-boundary credential/private-key prefix. Otherwise the next read conservatively runs the full safety pipeline. Buffer trim/overwrite, clear, controller dispose, session rebind, session-id reconstruction, and `contextLines` changes also invalidate or miss the checkpoint.
- Private-key redaction now treats an unterminated `BEGIN ... PRIVATE KEY` block as sensitive through the end of the available context. This prevents an incomplete key body from becoming either a cached or sent AI context while retaining the existing complete-block behavior.
- Output subscriptions are keyed by session. An open AI panel subscribes only to the active terminal, so background-session output does not invoke its refresh callback. AI-closed/unmounted state has no output subscription and does not read terminal context.
- Active output notifications are trailing-coalesced by animation frame with a 50 ms timer deadline. The last update is retained; opening, switching terminals, and manual send read the latest safe snapshot synchronously. Cleanup cancels both schedules, so closing the panel stops scans.

The fallback choices are deliberately one-way toward more work: uncertainty about ANSI state, redaction boundaries, or ring-buffer identity causes a full decode/normalize/redact. No cache hit or incremental branch bypasses `redactTerminalSecrets`.

### Comparable before/after benchmark

Values are median milliseconds per named operation. The first three rows retain the phase-1 workload geometry. The legacy four-session row intentionally cold-extracts every session and is retained as a regression stress case, not as a model of the production subscription path.

| Scenario | Before median | After median | Selected after p99 / RME / samples | Result |
| --- | ---: | ---: | ---: | --- |
| Append 256 KiB, AI closed | 0.131–0.133 ms | 0.130–0.131 ms | 0.482 ms / 3.80% / 6,565 | Buffer-only path unchanged |
| Append 256 KiB + one cold safe extraction | 5.106 ms | 4.560–4.604 ms | 5.091 ms / 0.46% / 218 | Full safety path remains; no cold-path improvement claimed |
| Re-read unchanged saturated 256 KiB context | 4.805–4.940 ms | 0.000041 ms | 0.000042 ms / 0.14% / 33,149,749 | Versioned redacted-cache hit; result is at timer resolution |
| Four sessions append + cold extract every session | 18.481–18.610 ms | 18.339–18.516 ms | 20.435 ms / 0.98% / 41 | Legacy worst-case stress is unchanged |

The unchanged-read ratio is numerically above 100,000x, but the after value is below a meaningful wall-clock resolution for a single JavaScript call. The supported conclusion is that it removed the O(256 KiB) pipeline and became an O(1) lookup; no precise six-figure speedup is claimed. The before saturated JSON runs had rare long pauses (8.18% and 12.14% RME), while their medians differed by only 2.8%; a separate warm run reported a 4.707 ms mean at 0.85% RME. The repeated after medians were identical.

### New incremental and production-shaped multi-session workloads

| Scenario | Median | p99 | RME | Samples |
| --- | ---: | ---: | ---: | ---: |
| Append 568 bytes + read incremental safe context | 0.0800 ms | 0.181 ms | 1.19% | 12,679 |
| Eight output chunks (4,544 bytes) + one coalesced read | 0.1673 ms | 0.900 ms | 1.83% | 5,420 |
| Four sessions append 256 KiB each, AI closed/unsubscribed | 0.5255 ms | 3.617 ms | 4.71% | 1,215 |
| Four sessions append 256 KiB each, one active AI subscription + extraction | 5.0114 ms | 5.955 ms | 0.89% | 149 |
| Four sessions append + cold extract every session (legacy stress) | 18.3393 ms | 20.435 ms | 0.98% | 41 |

The eight-chunk case is 2.1x the one-chunk median rather than eight times it because the appended raw chunks are handled once at the next reader checkpoint. In the production-shaped four-session case, all four raw buffers remain complete, ordered, and bounded, but only the active subscription prepares AI context. Its 5.01 ms median is 72.7% below the 18.34 ms extract-every-session stress case. The unsubscribed 0.53 ms case shows near-linear buffer append cost without hidden AI preparation; its higher p99/RME comes from occasional allocation/GC pauses, while repeated medians were 0.526 ms.

### Phase 4 correctness verification

- Focused Vitest: `src/components/ai`, `src/components/terminal`, terminal output/workspace libraries, and the terminal store passed 19 files and 296 tests after the final lazy-checkpoint refinement. The focused cache/AI and registry subsets also passed 63 and 33 tests respectively.
- `pnpm test:scripts`: 4 files and 35 tests passed.
- `pnpm build`: TypeScript and the Vite production build passed. The existing large-chunk advisory remains.
- Three final `pnpm benchmark:terminal`/JSON runs completed. Low-noise cache, incremental, coalesced, active-subscription, legacy stress, input, and xterm results remained in their repeated bands.
- Contracts cover unchanged snapshot identity, incremental redaction, UTF-8 retention, split CSI/OSC sequences, carriage-return rendering, cross-chunk credentials, incomplete private keys, clear, dispose/reconstruction, rebind, context-line changes, saturated overwrite, active/background session subscriptions, switching, manual-send freshness, the 50 ms trailing deadline, and AI-close cleanup.

### Phase 4 limits and remaining risk

- Once the raw buffer is saturated, any new output overwrites bytes and deliberately invalidates the incremental checkpoint. The next coalesced read still pays the approximately 4.5–5.1 ms full safety pipeline. Incremental ring eviction would require exact raw-byte-to-rendered/redacted ownership and is deferred rather than approximated.
- The snapshot cache adds one bounded redacted line tail plus one at-most-256-KiB final string for each session that is actually read for AI context. Background sessions that are never requested do not create these caches.
- A suspended WebView may clamp both animation frames and timers beyond their nominal 50 ms deadline. No data is lost: reopen/switch/manual-send uses a synchronous current snapshot.
- These are JavaScript microbenchmarks. They do not measure React paint, WebView scheduling, GPU work, native event serialization, or WAN/PTY throughput. No Rust PTY, server pause/resume, xterm parser/buffer, output ordering, reconnect, or backpressure behavior changed in phase 4.

## Current PTY transport baseline

Each session emits 2 MiB. Multi-session throughput is aggregate across four concurrent sessions.

| Scenario | Median | p95 | Median throughput |
| --- | ---: | ---: | ---: |
| Local PTY, one session | 14.212 ms | 14.879 ms | 140.73 MiB/s |
| Local PTY, four sessions | 38.634 ms | 62.428 ms | 207.07 MiB/s aggregate |
| Isolated SSH PTY, one session | 108.921 ms | 114.431 ms | 18.36 MiB/s |
| Isolated SSH PTY, four sessions | 126.136 ms | 132.876 ms | 63.42 MiB/s aggregate |

Local PTY timing includes PTY creation, helper-process spawn, output generation, and master-side drain. SSH timing includes local TCP connection, SSH handshake, password authentication, PTY request, remote command, and drain against the Docker fixture. It intentionally excludes host-key policy and the Tauri event bridge so the transport can be measured independently.

## Phase 5 local PTY wakeup result

Recorded on 2026-08-26 on the same machine and dirty worktree after phases 1–4. Before the production change, `cargo test` passed 281 tests with 6 environment-gated tests ignored. Three release transport runs saved the original 2 MiB reference. The original local worker was then reproduced directly in the latency benchmark: after draining `output_rx.try_recv()`, it blocked only on the independent command receiver with `recv_timeout(16 ms)`. Reader output arriving after that drain could not wake the worker, so it waited for the timeout. The reader also checked pause with an 8 ms sleep loop.

### Reader-to-worker latency

The final benchmark uses 41 samples per case. A first-byte sample creates a fresh idle worker, timestamps the reader-side enqueue, and measures until the worker receives it. The burst case sends one timestamped item every 20 ms. The legacy case retains the former standard-library output channel plus independent 16 ms command wait; the event case uses the production bounded crossbeam output channel and blocking receive/select. Values below are medians across three complete release runs; the range is the three run medians, and the p95 column is the median of the three run p95 values.

| Reader → worker scenario | Before/reference median | After median | After run-median range | Before/reference p95 | After p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| First byte after entering idle wait | 19.644 ms | 0.001 ms | 0.001–0.001 ms | 20.015 ms | 0.010 ms |
| 20 ms low-frequency bursts | 9.024 ms | 0.023 ms | 0.019–0.023 ms | 17.573 ms | 0.053 ms |

The event first-byte median is below useful wall-clock resolution, so no precise multi-thousand-fold speedup is claimed. The supported result is structural and visible in the tails: the independent fixed wait was removed, and the event case had 0.009–0.013 ms p95 for first byte. Burst p95 was 0.039–0.139 ms across runs, with one 0.470 ms maximum scheduling outlier; the legacy run-median ranges were 19.427–19.938 ms for first byte and 8.715–9.338 ms for bursts.

### 2 MiB transport regression check

Each table cell summarizes three complete runs, each with one warm-up and five measured repetitions. These cases intentionally drain the PTY directly and therefore validate the unchanged local transport rather than measuring the new worker/Tauri dispatch.

| Scenario | Before median | After median | Before run range | After run range | Before throughput | After throughput |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Local PTY, one session | 15.544 ms | 15.544 ms | 14.502–15.822 ms | 14.967–19.124 ms | 128.67 MiB/s | 128.67 MiB/s |
| Local PTY, four sessions | 38.770 ms | 39.936 ms | 38.718–42.279 ms | 39.660–40.126 ms | 206.35 MiB/s | 200.32 MiB/s aggregate |

The single-session median is unchanged. The four-session median is 3.0% higher but remains inside the original run range; because this benchmark does not execute the worker code and both sets contain scheduler outliers, no throughput improvement or regression is attributed to phase 5. Median-of-run p95 was 17.392 → 19.293 ms for one session and 39.661 → 41.142 ms for four sessions. One after run contained a 37.602 ms single-session p95 and another a 99.504 ms four-session p95, so tails remain environment-sensitive.

### Wakeup and backpressure design

- Local commands use their existing logically unbounded command queue, wrapped behind a sender enum so the SSH worker keeps its existing standard-library channel and socket self-pipe unchanged. Phase 5 does not change the SSH session loop.
- Reader output uses a new bounded 32 × 8 KiB crossbeam channel (256 KiB maximum queued payload). The local worker blocks in `select_biased!` on command, child-exit, output-state, and output events. There is no idle timeout and no default branch.
- A capacity-one output-state channel coalesces mark-ready, pause, and resume notifications. The atomic flags remain authoritative, so a full notification slot cannot lose the latest state.
- While paused, the worker removes output from its selectable set and emits nothing. The bounded queue fills, then the reader blocks in `send`, propagating backpressure to the PTY without an 8 ms sleep loop. Resume wakes the worker and drains the same FIFO in order.
- Commands have selection priority. An output turn combines at most 64 chunks before returning to selection, bounding how long sustained output can delay write/resize/close. Sessions retain independent workers and queues, so a high-throughput session cannot consume another session's queue or wakeup.
- A fixed child-wait thread per active local session converts process exit into an event; it is not created per output or command. On close/exit the worker releases the PTY, drains ordered tail output while waiting for reader/child completion, and uses the existing single 2 second shutdown bound for a grandchild that keeps the slave open. A naturally exiting shell with gated output waits for ready (or the existing five-second/1 MiB safety valve) before emitting the tail; close/controller-drop before ready does not leak gated output.

### Correctness verification and limits

- Deterministic local contracts cover output wakeup from a blocking idle select, absence of a default/poll branch, command/output competition, pause retention and resume order, ready-gate release, close/child-exit tail retention, FIFO batching with a 64-chunk fairness bound, the fixed output-queue capacity, coalesced state wakeups, and independent multi-session wakeups. Latency assertions are kept in the release benchmark rather than unit-test wall-clock thresholds.
- `cargo fmt --check` and `git diff --check` passed. Focused local command tests passed 12/12. The final full `cargo test --manifest-path src-tauri/Cargo.toml` passed 290 tests with 6 isolated Docker tests ignored.
- The benchmark stops its timestamp when the worker receives output. It proves removal of the reader-to-worker scheduling window, but excludes UTF-8 decoding, Tauri serialization/emission, WebView delivery, xterm parsing, and paint. A packaged-app trace is still required in the final phase.
- No Docker SSH benchmark was used to claim an improvement. The SSH worker, socket wait, keepalive, PTY channel, pause/resume behavior, and WAN path are outside this phase; only the shared manager sender wrapper changed, preserving the existing SSH channel type.
- The fixed child-wait thread raises the local-session thread count by one while that session is active. Thread count remains proportional to active sessions and does not grow with output volume; final-phase soak testing should verify teardown under repeated open/close and grandchild-held PTYs.

## Coverage and limitations

- Exact production TypeScript functions are used for terminal output append, trimming, ANSI/render normalization, redaction, context truncation, and `invokeWriteSession` wrapping.
- xterm is exercised in jsdom without opening a renderer. The result covers parser and scrollback-buffer work, not DOM layout, paint, GPU work, or a real Tauri WebView.
- AI closed/open compares buffer-only work with one coalesced context extraction. Full `AiPanel` React commit and browser paint are outside this low-noise microbenchmark.
- Native IPC, Tauri event serialization, and frontend log-file I/O are represented by deterministic call counts rather than wall-clock timings; they require an instrumented packaged application for reliable end-to-end latency.
- The SSH fixture is loopback and deterministic. It is suitable for regression comparison, not representative WAN latency or throughput.
- Four sessions are the maintained multi-session baseline. Larger fan-out can be sampled with `--sessions`, but should be recorded as a separate series.

## Later-phase measurement guidance

Before changing a hot path, save a JSON run and the PTY table on the same machine. After the change, rerun the same commands and compare medians plus p99/RME. Phase 2 addresses input IPC/log amplification, phase 3 restores the WebGL-first renderer with DOM fallback, phase 4 makes AI-context preparation versioned, lazy-incremental, redacted, and active-session scoped, and phase 5 removes the fixed local reader-to-worker wakeup window. The final phase still needs packaged-app end-to-end tracing, renderer frame time, Tauri/WebView event delivery, long-running fairness/backpressure soak, and teardown validation; phase 5 makes no WAN SSH performance claim.

## Phase 6 final acceptance

Recorded on 2026-08-26 at worktree `a99b9431fb073f8e2c7846c95c14e6dd96d322b1` plus the preserved uncommitted phase 2–5 and user changes. The machine remained the Apple M4 Pro/24 GiB arm64 system used above; the final audit observed macOS 26.6.2, Darwin 25.6.0, Node.js 24.15.0, pnpm 11.1.1, and rustc/cargo 1.95.0. Machine-readable selected results are stored in [terminal-performance-phase6-results.json](terminal-performance-phase6-results.json). The raw Vitest reports were also retained locally as `/tmp/termbridge-phase6-js-{1,2,3}.json`.

### Audit result

No confirmed production regression was found, so phase 6 made no production-code correction. The audit traced each changed entry point through its callers, shared state, error path, cleanup, and rebind/close behavior:

| Area | Audited contracts and conclusion |
| --- | --- |
| Direct terminal IPC | `write_session`, pause/resume, and resize keep exactly one native invocation, preserve the native rejection, and remain ordered at the caller boundary. Registry, reconnect, quick-action, and connection callers still handle or propagate failures contextually. Lifecycle calls that need reconciliation remain logged. |
| WebGL/DOM renderer | Addon and context-loss subscription are controller-scoped, attempted once after the first successful `open()`, preserved through detach/rebind, and disposed before xterm. Constructor/activation failure and context loss keep the same terminal, parser, buffer, listener generation, session binding, resize state, and backpressure state while returning to DOM. |
| AI safe context | Cache hits contain only redacted snapshots. Incremental reuse requires a newline-clean, ANSI-complete, sensitive-prefix-safe boundary. Context-line changes, clear, dispose/reconstruction, rebind, UTF-8 trim, and saturated overwrite invalidate or miss the checkpoint. Incomplete private keys redact through the available tail. Active-session subscriptions are removed on switch/close, and manual send synchronously reads the latest safe snapshot. |
| Local PTY wakeup | Command priority, bounded output queue, 64-chunk turn budget, atomic authoritative state plus coalesced wakeup, ready gate, pause retention/resume FIFO, close/controller-drop, child exit, ordered tail drain, and the two-second grandchild-held-PTY bound were all checked. Reader and child wait threads are fixed per active session and joined when their completion events are observed; remaining blocked waiters are detached only after the existing bounded shutdown path. |
| Cross-phase interaction | Direct pause/resume IPC still drives the local worker's authoritative state; rebind cancels stale resize/retry work and invalidates AI cache identity without reallocating WebGL; dispose removes renderer/listener/cache resources; no terminal input or raw decoded terminal text was added to generic history or a persistent cache. |

### Hard stop checklist

| Command | Final result |
| --- | --- |
| `pnpm test:scripts` | Passed: 4 files, 35 tests. |
| `pnpm test` | Passed: 141 files, 1,131 tests. |
| `pnpm build` | TypeScript and Vite production build passed; 3,775 modules transformed. The existing chunk-size advisory remains non-fatal. |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | Passed. |
| `cargo test --manifest-path src-tauri/Cargo.toml` | Passed: 290 tests; 6 isolated Docker tests ignored; no failures. Main and doc-test targets contained no additional tests. |
| `cargo check --manifest-path src-tauri/Cargo.toml --release --example terminal_transport_baseline` | Passed. |
| `git diff --check` | Passed before and after the final report update. |

### Before to final frontend result

Values are medians in milliseconds per named operation. Final ranges use phase 6 runs 1 and 3; both retained low per-case RME for the principal input, AI-open/cache/incremental/active-session, and xterm comparisons. Run 2 is preserved only as a diagnostic because one 59.468-second host scheduling pause made its AI cold-read and saturated-cache RME unusable. Allocation-heavy AI-closed/background-session cases still show roughly 3.4–5.1% RME and should be interpreted by their repeated median range rather than p99.

| Scenario | Comparable before | Phase 6 final median range | Supported conclusion |
| --- | ---: | ---: | --- |
| 1,000 connected input events | 0.8090 ms (phase 2 before) | 0.0687–0.0697 ms | About 11.6–11.8x less JS wrapper/bookkeeping time; native IPC latency is excluded. |
| Append 256 KiB, AI closed | 0.131–0.133 ms (phase 1/4) | 0.1229–0.1285 ms | Buffer-only path remains in the original band; no regression. |
| Append 256 KiB plus one cold safe extraction | 5.106 ms (phase 4 before) | 4.103–4.401 ms | Full decode/render/redact path remains bounded; no cold-path improvement claim is needed. |
| Re-read unchanged saturated 256 KiB context | 4.805–4.940 ms (phase 4 before) | 0.000041–0.000042 ms | O(256 KiB) safety work became an O(1) redacted snapshot lookup. The measured value is below useful timer resolution, so no precise speedup ratio is claimed. |
| Append 568 bytes plus incremental safe context | Not present before phase 4 | 0.0728–0.0775 ms | New bytes are normalized/redacted once at the next read. |
| Eight appends (4,544 bytes) plus one coalesced read | Not present before phase 4 | 0.1546–0.1576 ms | Coalescing retains the last update without eight full rescans. |
| Four sessions append, AI closed/unsubscribed | 0.5255 ms (phase 4 final reference) | 0.5054–0.5224 ms | Background buffers do not prepare hidden AI context. |
| Four sessions append, one active AI extraction | 5.0114 ms (phase 4 final reference) | 4.6601–4.8372 ms | Active-session subscription remains production-shaped and stable. |
| Four sessions append plus cold extraction for every session | 18.481–18.610 ms (phase 4 before) | 16.862–17.887 ms | Legacy worst-case stress has no regression; it is not the production subscription pattern. |
| xterm parser/buffer, one session, 512 KiB | 5.342 ms (phase 1) | 4.111–5.133 ms | Parser/scrollback work has no regression. This is still jsdom without a renderer. |
| xterm parser/buffer, four sessions, 512 KiB each | 17.736 ms (phase 1) | 17.529–17.732 ms | Multi-session parser/scrollback work remains stable. |

The phase 6 JSON contains p99, RME, and sample counts for both selected runs. WebGL conclusions are deliberately absent from this table: jsdom never calls `Terminal.open()` and proves no renderer, layout, paint, compositing, frame-rate, or GPU throughput behavior.

### Before to final release transport result

Each phase 6 value below is the median of three complete release-run medians. The range shows those three run medians. Each 2 MiB cell contains a warm-up and five measured repetitions; each latency cell contains 41 samples.

| Scenario | Before/reference median | Phase 6 median of run medians | Phase 6 run range | Conclusion |
| --- | ---: | ---: | ---: | --- |
| Local PTY, one 2 MiB session | 15.544 ms (phase 5 before) | 15.219 ms | 13.173–15.863 ms | Inside the prior scheduler/PTY range; no throughput regression or improvement attributed to the worker. |
| Local PTY, four 2 MiB sessions | 38.770 ms (phase 5 before) | 38.964 ms | 38.890–39.087 ms | Aggregate transport is stable at about 205.3 MiB/s. |
| Reader to worker, first byte after idle | 19.644 ms legacy reference | 0.001 ms event path | 0.001–0.001 ms | Fixed independent wait is structurally removed. Event value is below useful timer resolution; no precise multiplier is claimed. |
| Reader to worker, 20 ms low-frequency burst | 9.024 ms legacy reference | 0.025 ms event path | 0.024–0.026 ms | Event wakeup remains in the phase 5 band; median p95 was 0.051 ms. |

The latency timestamp stops when the worker receives the queued bytes. It excludes UTF-8 decoding, Tauri serialization/emission, WebView delivery, xterm parsing, renderer work, and paint.

### Additional final verification

- Local PTY soak: `pnpm benchmark:terminal:transport --bytes 65536 --repetitions 25 --sessions 8` passed. Including each suite's warm-up, it completed 234 PTY open/spawn/drain/wait lifecycles. This was a lifecycle soak, not a throughput comparison; the smaller payload is dominated by process startup.
- Worker contracts: the nine `commands::tests::local_` contracts plus the coalesced output-state contract were repeated for 50 iterations (500 contract executions) without failure. They cover blocking wakeup, command/output competition, pause/resume FIFO, ready release, tail retention, bounded batching/backpressure, independent sessions, and joined worker threads without fragile strict wall-clock assertions.
- Real browser renderer: a temporary Vite probe using the production registry in the Codex in-app Chromium browser observed WebGL2, two xterm canvases, the viewport visible, and an xterm buffer length of 24. Forcing `WEBGL_lose_context` triggered the production callback after xterm's restoration window; the controller switched to DOM while preserving terminal identity and buffer length. The temporary probe and browser tab were removed afterward. Standalone Vite predictably lacked the Tauri event/IPC bridge, so this is renderer correctness only, not a packaged-session test or a GPU frame-rate benchmark.
- Docker SSH fixture: Docker Desktop 29.7.2 was available. The isolated loopback benchmark passed at 83.354 ms for one 2 MiB session and 108.958 ms aggregate for four sessions, after which the container, network, and volumes were removed. This is a regression check only and is not evidence of WAN improvement.

### Final change scope

The terminal-performance work is limited to these files:

- `docs/terminal-performance-baseline.md`
- `docs/terminal-performance-phase6-results.json`
- `scripts/__tests__/terminal-performance-contract.test.ts`
- `scripts/perf/terminal-hot-path.bench.ts`
- `scripts/perf/terminal-workloads.ts`
- `src/lib/tauri.ts`
- `src/lib/terminal-output-buffer.ts`
- `src/lib/__tests__/terminal-output-buffer.test.ts`
- `src/components/ai/ai-panel.tsx`
- `src/components/ai/__tests__/ai-panel.test.ts`
- `src/components/terminal/registry/terminal-registry.ts`
- `src/components/terminal/__tests__/terminal-registry.test.ts`
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock`
- `src-tauri/examples/terminal_transport_baseline.rs`
- `src-tauri/src/commands.rs`
- `src-tauri/src/models.rs`

`src/lib/tauri.ts`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `src-tauri/src/commands.rs`, and `src-tauri/src/models.rs` are shared files that also contain the user's pre-existing SFTP, host-key, remote-file, and connection work. Phase 6 did not split, revert, format, or otherwise rewrite those unrelated hunks. The other modified SFTP/Rust/workbench/hooks/stores/types files and the untracked `src-tauri/src/directory_request_registry.rs` are user work outside the terminal-performance scope and remain untouched by phase 6.

### Residual risk and manual acceptance

- WebGL's real GPU frame rate is not proved by jsdom or by the activation/context-loss correctness probe. Sustained-output frame time, scrollbar interaction, context recovery, and DOM fallback should still be observed in a packaged Tauri WebView on target macOS/Windows hardware.
- A packaged trace is still required to measure native IPC, local worker decode/emission, Tauri event serialization, WebView scheduling, xterm parsing, and paint end to end. The local worker benchmark ends at worker receive.
- After saturated ring-buffer overwrite, the next AI read deliberately falls back to the full safe decode/render/redact pipeline. It does not attempt incremental eviction across uncertain raw/rendered/redacted ownership.
- A fixed child-wait thread remains proportional to active local sessions. The lifecycle soak and repeated contracts found no growth or stuck joins, but a many-hour packaged-app soak with real close/rebind churn remains a prudent manual acceptance item.
- The Docker fixture is loopback and the SSH worker/WAN path was not optimized by this goal. No WAN latency or throughput improvement is claimed.

All hard stopping conditions passed. Within the measured and explicitly bounded scope above, the terminal performance Goal is eligible to complete.
