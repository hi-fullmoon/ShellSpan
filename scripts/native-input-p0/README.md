# Native input verification tools

These tools provide isolated native-input and terminal-display checks. They do
not establish current production admission. Current implementation boundaries
and pending platform acceptance are defined by
[the NIP contract](../../protocol/agent/runtime/native-input.md) and
[the acceptance checklist](../../docs/design/agent-terminal-input-acceptance-checklist.md).

Only compile, type and static checks are currently authorized. The commands
below are an execution index for a separately arranged acceptance window; do
not launch an App, browser, model, Shell/PTY or SSH fixture as part of cleanup.

## Installed terminal package

`node scripts/verify-terminal-p0-formal.mjs` checks the installed, digest-verified
xterm package. Pass `--copy-only` or `--inband-only` to select a narrower scope.
The generic cursor, copy, selection and viewport patch sources remain here
because the maintained dependency build records their digests.

- [Dependency build and integrity](../dependency-builds/xterm/README.md)
- [Display integration contract](../../protocol/native-input-display.md)
- [Formal package driver](../verify-terminal-p0-formal.mjs)

The driver captures the frozen native target when inputs are absent. Existing
captures can be supplied using `--captures`, `--copy-captures`,
`--compat-captures`, `--geometry-captures` and `--commit-capture`.
Missing or invalid inputs fail. Candidate JavaScript always comes from the
verified installed pnpm package; the unpatched and cursor-only controls are
built from an original package extracted with `pnpm patch --ignore-existing`.
Never reapply a laboratory patch to the installed package.

## Standalone GNU prototype

`node scripts/verify-terminal-native-input.mjs --upstream` builds and exercises the pinned
GNU Bash 4.1, 4.4 and 5.3 prototype. The SSH entry is
`python3 scripts/native-input-p0/ssh.py`; `--ssh` adds that lane to the local
driver. `--browser-only` replays a supplied capture, and `--native-only`
selects native capture without browser replay. These two local scope selectors
are mutually exclusive; combining them is rejected before any checks start.

These are feasibility controls, separate from production input. Earlier
replacement/insertion strategies retain their original failing display gates;
their results cannot enable a production profile. Superseded one-off
diagnostics and dependency experiment drivers are available in Git history.

`build.py`, `bridge.c`, `src/`, the reviewed patches and pinned source
manifests also supply the [NIP protocol producer](../native-input-p1/README.md).
They remain prerequisites of the current acceptance checklist. The prototype
library uses bounded serde_json decoding, SHA-256 bindings and mature Unicode
and shell-quoting dependencies. Ordinary PTY output never authorizes execution.

## Environment and evidence

The native tools require Python 3.11+, Rust/Cargo, a C compiler, GNU make,
`tar` and `patch`. Browser checks use the repository's Node/pnpm/Playwright
dependencies; the isolated SSH lane additionally requires Docker. Bash 5.3
uses the pinned Readline 8.3.6 sources; actual source versions and checksums
remain in the build manifests.

Builds, raw PTY/control captures, timelines, command results and summaries stay
under the ignored `artifacts/tests/native-input-p0/` directory. Freeze sources, dependencies,
artifacts and actual loaded binaries for each new batch. Historical captured
bytes and failures remain unchanged; old captures do not validate current code.

Use only disposable HOME/history/configuration directories and authorized
loopback fixtures. The SSH harness owns its temporary keys, pinned host key,
container and port; it must clean only those resources. Do not alter user startup
files, business hosts or unrelated processes. Missing environments, skipped
cases and uncertain submissions are not passes and must never trigger replay.
