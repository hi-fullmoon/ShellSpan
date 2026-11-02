# Visible command presentation

The terminal displays unchanged PTY output. Original command input, cursor,
animation and redraw belong to the real shell editor. No application module
substitutes source text, buffers, cursor coordinates, selection, search or public
xterm methods. The formally maintained xterm dependency patch and explicit
same-stream display options remain as documented in
[native display integration](../../native-input-display.md).

## Read-only command ranges

Integrated shells emit OSC 133 A before the prompt and C at command start.
These optional, untrusted PTY markers delimit presentation only. They cannot
acknowledge frontend readiness, approve input, prove execution, or release a lease.

`terminal-command-decorations.ts` keeps bounded ordered lease scopes and public
xterm markers. It uses public buffer coordinates and DOM rectangles only to
shade command rows. It does not consume `commandDisplay` or
`commandSubmission`, keep another copy of source, hold rendering, or write text.
Only a command-execution lease shades input; private job controls consume their
ordered boundary without shading output. Missing/disposed markers may omit a
decoration. Alternate screens retain their own display. Release, disposal and
transport rebind remove active presentation resources without clearing history.

`terminal-registry.ts` renders every mode through the original Terminal.
Native generations additionally attach the verified NIP same-stream binding.
Legacy wire labels remain readable for old peers; they no longer install
projection, frontend typing or redraw protection. Raw generations install no
command decoration or native display handler. A new transport first stops old
callbacks, drains accepted bytes and restores display options before rebinding.
No mode is hot-switched within a connected generation; no terminal reset,
history replay or source reconstruction is used.

The controller retains focus/readiness and user-input suppression, but installs
no Agent-specific output filter. The separate directory-query filter and
ordinary terminal/TUI input remain outside this command-presentation change.

## Admission and existing sessions

New Agent source input requires a verified, negotiated native generation.
Legacy/raw or insufficient capabilities fail before a new lease or PTY write.
The application does not replace the user's shell or recover a failed native
operation through a legacy source-input fallback. The ZLE/PSReadLine production
editor profile list remains empty until separate acceptance. GNU Bash retains
its independent source-matching artifact catalogue and exact bound-shell SHA
admission; the empty editor list does not disable that existing path.

Existing legacy jobs retain only their already prepared, identity-bound private
descriptor channel for query/stop/cleanup. It cannot admit new source or a new
background launch. Existing interactive programs and ordinary user input retain
their original transport and authorization. Old clients and existing histories
are not upgraded in place. Unknown/possibly submitted commands retain recovery,
observation and no-replay fences.

The AI Shell card still shows approved input separately from terminal output.
Structured results use authoritative `combinedOutput`, including an empty
string; execution status is separate from the tool result and launch exit code.
This does not create a terminal source projection.

## Regression and static entry points

- `pnpm check:terminal:boundary`: TypeScript AST/type-based checks on command
  display modules, their application helpers and registry/controller integration;
  rejects private state, method/cursor/buffer replacements, metadata/DOM/canvas
  text projection and reopened ZLE/PSReadLine editor admission. It runs in Quality Gate.
- `terminal-command-stream.test.ts`: unchanged legacy capture fidelity and
  current genuine native capture source/copy/search/reflow/public-method checks.
- `pnpm test:terminal-command-source` and `pnpm test:terminal-command-redraw`:
  native display and original history-failure fixtures plus fresh NIP geometry
  captures in Chromium/WebKit and DOM/WebGL. Actual read timing is mandatory;
  missing captures fail. More than three visible states, over 500ms of progress,
  no disappearing painted source, exact source/copy/search and no extra input
  remain assertions. No legacy capture producer is called.
- `pnpm test:terminal-command-presentation`: real ordinary-shell boundary
  captures and read-only shading, followed by the same mandatory native suite.
- Real cancellation, FULL intent, duplicate/late commit, crash recovery, real
  output and stop semantics live in `terminal_native_protocol.rs`, native
  `local_tests.rs`/`zle_tests.rs` and P2/P3 App entry points.

Retired executable regression specifications remain as non-executable evidence
in `docs/design/p4-retired-regressions/`; original real PTY JSON and failure
artifacts are preserved. See the [P4 audit and pending acceptance](../../../docs/design/agent-terminal-input-p4-audit.md)
for the mapping and evidence boundaries. P4 currently has code/compile/static
evidence only; none of the dynamic entries above ran in this stage.
