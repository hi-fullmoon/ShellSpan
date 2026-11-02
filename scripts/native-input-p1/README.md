# P1 native input acceptance

Run `pnpm test:terminal-input:p1` on the frozen macOS arm64 host. It builds the
GNU Bash 5.3 / static Readline 8.3.6 producer using the P0 pinned archives and
reviewed C patches, then exercises the shared NIP protocol through a real PTY
and private Unix socket. No production session selects native mode here.

`build.py` writes `.native-input-p0/p1-protocol-build/manifest.json` containing
the exact producer sources and actual Shell/library/module hashes. Acceptance
rejects stale or modified artifacts. `display.patch` applies after the reviewed
P0 in-band patch and adds formal builtin aliases and the NIP display key only
for explicitly enabled native protocol mode. P0 default behavior is independent.

The entry saves per-step logs, exit codes, timings, the 504-case pure reducer
matrix and actual-wire schema validation under `.native-input-p0/p1-validation`.
Live cases write raw PTY and private control captures under `p1-evidence`,
including actual SIGKILL driver/restart evidence and four browser screenshots.
These contain controlled test commands only and stay outside Git/test discovery.
No timestamped build/capture directory is required. Missing inputs are built or
captured from source; no native lifecycle messages are fabricated.

Legacy Bash/Zsh compatibility checks keep their normal assertions and nonzero
exit status on failure. Baseline failures must be recorded and compared in an
isolated pre-P1 source snapshot, not bypassed by weakening checkpoints, extending
deadlines or marking ordinary output as a receipt. A failed entry is not a full
acceptance pass. See the P1 audit for the current gate and platform boundaries.

Native production transport/registry wiring remains P2. Display drain/dispose
does not reset incomplete xterm OSC/UTF-8 parser state. P1 native rebinding uses
the real next producer startup-off ESC; raw/unsupported-shell rebinding and old
generation tail fencing require P2 registry acceptance without reset/clear/replay.
