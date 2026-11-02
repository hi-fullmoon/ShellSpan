# Native input P0 validation

The standalone native bridge remains a feasibility prototype, not a production
command-write route. User-approved generic xterm 6.0.0 fixes are now installed
through pnpm. The explicit display controller is available for P1/P2 integration
but is not attached in legacy/raw registry paths. Test writes stay in controlled
temporary/ignored directories and loopback fixtures; user startup/SSH config is
not changed.

## Formal package entry points

```bash
pnpm install --frozen-lockfile
pnpm test:terminal-native-display
pnpm test:terminal-native-input:p0:formal
pnpm check:xterm:rebuild
```

The controller uses a repository fixture exported from real native PTY bytes;
it does not require an old ignored timestamp directory. Full P0 verification
builds the pinned GNU 5.3/Readline 8.3.6 prototype and generates real corpora when
none are supplied. To replay, pass explicit `--captures`, `--copy-captures`,
`--compat-captures`, `--geometry-captures`, `--commit-capture` directories. Missing
or invalid inputs fail; there is no skip/fake-receipt fallback. Candidate JS is
always the verified installed pnpm runtime; only controls are source-built from
an original package extracted by pnpm.

Source/runtime patch rebuilding and integrity are documented in
`scripts/dependency-builds/xterm/README.md`; the caller/EOF/binding contract is in
`protocol/native-input-display.md`. Online identifiers and negotiation remain
P1 work. Formal generic cursor/copy/display-mechanism adoption is explicitly
authorized, including global default-history copy changes. No production native
command route has been enabled. The measured full scope is macOS arm64, GNU
Bash 5.3/Readline 8.3.6; other native display targets remain unaccepted.

The older commands/evidence below are historical feasibility controls. When
rebuilding a control after adoption, provide `SHELLSPAN_P0_ORIGINAL_PACKAGE`
pointing to a `pnpm patch --ignore-existing` extraction; never apply an old
experimental patch again to the formally installed package.

## Reproduce

Requires Python 3.11+, Rust/Cargo, a C compiler, GNU make, `tar`, `patch`, the
repository's Node/pnpm/Playwright dependencies and Docker for the SSH lane.
macOS's installed-header build additionally uses Homebrew Bash headers.

```bash
# Build the three pinned GNU Bash versions and run local PTY + browsers.
pnpm test:terminal-native-input:p0 --upstream

# Build and run all three Linux Bash versions through a loopback-only sshd.
pnpm test:terminal-native-input:p0:ssh

# Run both, preserving a nonzero status if any required lane fails.
pnpm test:terminal-native-input:p0 --upstream --ssh

# Inspect a particular completed real PTY capture in both browsers/renderers.
SHELLSPAN_P0_CAPTURE_ROOT=.native-input-p0/runs/<run>/darwin-5.3 \
  pnpm test:terminal-native-input:p0 --browser-only

# Optional independent public Unicode 11 addon comparison, installed in the
# ignored evidence directory; production dependencies/options are unchanged.
SHELLSPAN_P0_UNICODE=11 SHELLSPAN_P0_CAPTURE_ROOT=<capture-directory> \
  pnpm test:terminal-native-input:p0 --browser-only
```

The main entry runs every selected lane even if an earlier lane fails. SSH
publishes a fresh port on `127.0.0.1` only, generates private fixture keys under
a mode-0700 ignored directory, pins its host key, disables password login and
removes its own container in `finally`. Existing Docker containers are untouched.
Each Bash session has its own throwaway HOME, rc, inputrc, history and socket.
The SSH fixture shares that evidence directory through a repository bind mount.

GNU Bash 4.1/4.4 use their bundled Readline. The 5.3 build uses a private static
GNU Readline 8.3.6, built with all six official patches and pinned checksums in
`readline-sources.json`. Unpatched Readline 8.3 can keep invoking `rl_event_hook`
without consuming real input. See the [official patch report](https://ftp.gnu.org/gnu/readline/readline-8.3-patches/readline83-001).
The input provider is never repaired by calling `_rl_*` or Bash evaluator symbols.

Each suite copies its Bash executable and module before launching sessions.
`suite-inputs.json` records their hashes and observed source hashes;
`build-inputs.json` records build sources, dependencies and licenses. Builds use
the checked-in Cargo lockfile and verify GNU archive/patch hashes. Old compiler
compatibility flags and Debian's packaged GNU config helpers are recorded in the
build log and helper manifest. GNU runtime code is not manually rewritten.

## Native mechanism

`bridge.c` compiles against each target Bash's `builtins.h` and public Readline
headers. `enable -f` loads the module. Rust owns bounded `serde_json` stream
decoding, SHA-256 bindings and `unicode-segmentation` boundaries. `p0-plan` uses
the same mature `shlex` quoter as the native validator. UTF-8 fragments on the
Python receiver use the standard incremental codec and JSON decoder.

`rl_pre_input_hook` reports a real editor-ready boundary after the prompt and
checks the installed native bindings. A private service chord (Ctrl-X Ctrl-^)
starts a bounded nonblocking receive; complete source and plan travel over a
mode-0600 Unix socket, never as editor text. The owning editor thread applies
grapheme-safe prefixes on `rl_event_hook` callbacks, with a 1.5 second animation
budget and direct application for reduced motion. Ordinary user input has no
installed event hook. Hook teardown is dispatched by an inert native service
key; it never returns an uninitialized input character from Readline's hook loop.

A matching Commit request arms one native Ctrl-X a command. This is the single
executable input write. Its callback finishes Readline's source redisplay and
acceptance, replaces the returned line with the independently recomputed plan,
and returns to Bash. It evaluates no user source. Bash parses the fixed plan
at parent-shell top level:

```bash
p0_begin "$?"; builtin eval -- Q
```

`p0_begin` is a native builtin, not a shell function. It restores the temporary
SIGINT mask at that top-level boundary and returns the previous status. The
trusted prompt builtin records the actual final status without normalization.
An interrupt may leave a partial real side effect; tests never undo or replay it.
The experimental plan differs from the frozen production plan and is not a
production protocol change. Existing source syntax, permission and approval
validation remains a prerequisite for any later integration.

Cancel/takeover retires the owned operation, verifies the real buffer before
clearing it, rejects late requests/chords, and preserves existing user drafts.
Once submitted, no editor service chord is written into a foreground program.
Stopping uses a real PTY SIGINT and waits for a real prompt result. A closed
control endpoint cannot provide a completion receipt; the controller preserves
uncertainty and sends no second executable input. `FD_CLOEXEC` plus a native
`pthread_atfork` child closer prevents ordinary children/subshells inheriting
the control socket; both are exercised with real processes.

The module is pinned with public `RTLD_NODELETE` for the shell process lifetime:
`pthread_atfork` has no portable unregister operation. The verified Bash
`p0_builtin_unload` entry closes the socket and restores hooks/bindings; a real
test removes all builtins, forks another external child and exits normally.

The default candidate uses `rl_replace_line`. `acceptance.py --strategy insert`
independently probes `rl_insert_text` suffix application. Both candidates retain
all native bytes but fail the rendered background-output/resize preservation
gate. For a focused real capture, use `--case background` and then
`SHELLSPAN_P0_BACKGROUND_ONLY=1 SHELLSPAN_P0_CAPTURE_ROOT=<suite>` with the browser
entry. Browser evidence is saved inside that suite to avoid mixing candidates.

## Evidence and boundary

The native harness records unmodified `pty.bin`, resize/read/request timelines,
actual private receipts, runtime Bash identity, side-effect files, native
signal baselines and a final exit-code-based result. Browser checks replay these
bytes into an unmodified xterm using only public APIs. They compare actual user
edits and bridge edits at 32/40/100/180 columns, including a buffer larger than
the viewport, search, selection, focus and pre/post-commit screenshots. This is
real browser rendering of captured PTY bytes, not a live Tauri/Broker acceptance.
`pure-baseline.py` and `diagnose.py` are additional display/configuration probes.

Prototype identities use one generation and an in-memory lease. This is not the
P1 production protocol, durable submission journal, crash recovery or a strong
same-UID security boundary. Custom INT handlers, occupied private bindings,
custom input providers/event hooks, other shell families and unverified native
builds are outside the validated profile. They must not silently change surface
or start another shell in a future adapter. The laboratory does not advertise
support merely from a version string; the dated feasibility report defines the
actual accepted builds.

P0 is **NOT PASS**. Normal and oversized input matching alone is insufficient:
the complete browser gate also requires prior background output to remain
visible in scrollback. The failed assertion and screenshots are intentionally
retained. See the dated feasibility report before any later migration.

## Continuation: causal controls and explicitly authorized dependency lab

The original failures are not proof that all native mechanisms fail. Run the
no-module baseline and paired controls with the same frozen binary, locale,
prompt, source and actual resize schedule:

```bash
pnpm test:terminal-native-input:p0:background --modes=pure,loaded-user,replace,insert
pnpm test:terminal-native-input:p0:background --modes=pure --no-resize
pnpm test:terminal-native-input:p0:background --modes=pure --no-edit
```

`pure` creates no control socket and never loads a module. Its real Bash
`enable -p`, exact rc, history, prompt-status file and PTY are retained. Fixture
files/tty modes synchronize the experiment only; stdout is not execution
authority. `observed-end` stops display analysis before teardown. Timing and
whole graphemes come from the standard ICU `Intl.Segmenter`, not a custom parser.
Each causal run archives its source and build manifest.

`start-rebase`, `geometry-rebase` and `viewport-safe` remain rejected experiments.
They may retain BG labels but add blank lines, retained draft fragments or an
abbreviated preview. They do not satisfy the original in-place UX and are not
selected by any production route or default.

The `append-display` candidate uses Readline's public redisplay provider only
while the immutable programmatic draft is owned. It writes each newly added
byte of the actual Readline buffer once, without a screen/cursor/width model,
clears, bulk blank-line scrolling or whole-draft restoration. Normal input
restores the saved provider. Native `rl_done` accepts in the command callback;
user source still executes at parent Bash top level. Without a correct terminal
cursor reflow this candidate is also NOT PASS: BG labels can survive while
subsequent text overwrites earlier characters. The browser now compares the
entire actual copied stream with an unresized real-terminal reference, not just
the five labels. Legacy candidates retain full native-baseline comparisons.

The user explicitly authorized a separate generic terminal dependency repair
experiment. It is isolated under `.native-input-p0/xterm-reflow-lab/`; the
installed module, production lockfile and application remain unchanged.

```bash
node scripts/native-input-p0/build-xterm-lab.mjs --baseline
node scripts/native-input-p0/build-xterm-lab.mjs
# Full laboratory profile, still independent of production routing:
pnpm test:terminal-native-input:p0 --upstream --research-profile --ssh
SHELLSPAN_P0_XTERM_LAB=1 SHELLSPAN_P0_REFLOW_CURSOR=1 \
  pnpm test:terminal-native-input:p0:background --modes=append-display
SHELLSPAN_P0_XTERM_LAB=1 SHELLSPAN_P0_REFLOW_CURSOR=1 \
  pnpm test:terminal-native-input:p0:background --modes=append-display --repeats=270
SHELLSPAN_P0_XTERM_LAB=1 SHELLSPAN_P0_REFLOW_CURSOR=1 \
  pnpm test:terminal-native-input:p0:background --modes=append-display --ssh
```

The cursor patch changes only generic opt-in terminal resize behavior. It knows no
command/source/operation/lease or typing offset: it uses the terminal's existing
BufferLine reflow functions and line-change events to preserve active/saved
cursor cell offsets, including pending wrap and trimmed logical-line prefixes.
Default `reflowCursorLine=false` is unchanged.
Use `SHELLSPAN_P0_XTERM_LAB=baseline` for the identical source/bundler control
without the patch. This control fails the full copied-stream assertion while
the patched laboratory passes the focused native/SSH recordings. This is not
authorization to ship the dependency patch or claim other platforms accepted.

The cursor-only/async compatibility controls **FAIL**. They are not the complete
candidate described in the later copy-laboratory section. Tab-expanded cells survive, but stock
selection serialization trims their copied spaces. A tab arriving after resize
legitimately uses the new column and stops; separate cell invariants cover both
conditions. Keeping opt-in true during ordinary Readline redraw is an unsuitable
configuration. Representative ordinary default-false edits match stock; the
async ownership-window control has handoff/resize, late-open and lost-close failures. No failure
is hidden by a selection override or a reduced assertion.

```bash
# Builds isolated patched and same-bundler stock copies, captures actual PTY
# terminal programs, Bash edits and Vim, and runs public API browser checks.
# Requires a GNU Bash build from the existing build.py entry (or --shell PATH).
pnpm test:terminal-native-input:p0:compat
```

The earlier 18-case recording reported 60/72 passes for always-opt-in and 72/72
default-off state matches. That unclassified aggregate is historical evidence,
not a current product gate. Native hard-line source equality is retained only as
a stronger diagnostic, not an original requirement for ordinary Readline.
Ordinary edits check native state/copy compatibility and real execution.
The cases include non-end and saved cursors, pending wrap, Unicode,
tab/newline copy, row/column resize, small-scrollback trimming, repeated resize,
scroll-region queries, alternate screen, real native editing and installed Vim.
Fixed terminal-program stimuli are library assertions, not native integration
receipts or production acceptance. Capture hashes, public state, actual Bash
result and screenshots are retained under `.native-input-p0/`.
Nine additional real native-provider lifecycle captures test scoped public option
switches: commit, typing/confirmed cancel, takeover, known EOF, withheld close,
handoff resize, late Prepared during Vim and delayed Prepared before opening.
Serial handoffs work, but restoring false before actual acceptance leaves a
resize gap; a lost close leaves true enabled, and delayed open cannot recover
already lost text. Display receipts grant no execution authority. Production
boundary ordering and recovery remain unimplemented. Both gates keep exit 1.
The main `--research-profile` browser gate includes this compatibility gate and
retains its nonzero result even when the append-only focused checks pass.

An additional isolated direction uses the documented OSC 1337 `SetUserVar`
transport, with a **new lab-only variable-to-option binding**, rather than
inventing a standard terminal mode number or repurposing synchronized output.
The native append provider emits on/off in the actual PTY stream. A synchronous
public OSC hook changes only `term.options.reflowCursorLine`; neither stdout nor
any display acknowledgement authorizes execution or changes lifecycle state.

```bash
# macOS arm64 frozen GNU Bash 5.3 / Readline 8.3.6 build only:
pnpm test:terminal-native-input:p0:inband
```

This builds a separate C source/module copy and runs 15 real native scenarios,
including handoff resize, late/withheld display receipts, foreground Vim control
EOF, actual background output, normal exit, SIGHUP and SIGKILL/PTY EOF. It checks
public APIs with parsed chunks and with byte fragmentation/resize overtaking
queued parsing. A real stdout producer can change the lab display option but its
commit is still rejected without a native draft. Malformed values are ignored.
The isolated C fix cooperates with the public `rl_signal_event_hook` before
reentering Rust; it does not call private Bash signal functions. SIGKILL needs
actual terminal EOF cleanup because a dead process cannot send off bytes.
No production dependency, protocol number, capability or route is adopted.
The earlier failures and strict tab-copy assertions remain in their own gates.

The final scoped in-band profile passes 15/15 native cases and 60/60 public API
case lanes for each of parsed and queued/fragmented strategies. Actual packet
split/resize boundaries additionally pass 408/408 library-only assertions:

```bash
node scripts/native-input-p0/inband-parser-boundaries.mjs <actual-capture-root>
```

The native commit callback also needs a display guard: `rl_done` does not skip
the dispatcher's subsequent signal handling. A real dense-resize probe leaked
the hidden plan on its first pre-fix commit. The prototype now keeps an empty
native redisplay provider after accepting the visible source, until the fixed
parent-level `p0_begin` builtin proves Readline has returned. Only then is the
default provider restored. The display-off bytes still precede actual output.
There is no frontend acknowledgement, new signal mask, source projection or
hidden-plan filtering. Bash 4.1/4.4/5.3 each pass 64/64 real commit/resize probes;
the updated 5.3 module also passes 45/45 native regression cases.

```bash
python3 scripts/native-input-p0/commit-resize.py \
  --shell <frozen-bash> --bridge <frozen-inband-module> --output <new-evidence-dir>
# For a normal prototype module without the extra display transport:
# add --without-inband; the wrapper/once/source-point checks remain required.
```

These scoped passes alone do not fix tab-copy serialization or authorize a
production switch. The further generic copy repair below addresses that defect;
terminal lock entries and installed xterm source remain unchanged.

## Isolated generic copy serialization repair

`xterm-copy-serialization.patch` changes only library serialization from real
cells and soft-wrap attributes. It preserves meaningful blank cells inside a
logical line, excludes wide-wrap gaps using the existing reflow helper, and
retains old hard-line/empty-tail and column-selection behavior. Actual typed
spaces remain content. Logical ranges are cached per getter call to keep scans
linear. No command/source/lease data or separate display text is read.

This is a **global generic copy-rule change**, including matching historical
output under `reflowCursorLine=false`. It is not scoped to Agent ownership.
Passing representative ordinary edits does not prove every old copy result is
unchanged. Intended corrections of stock soft-wrap blank loss are distinguished
from unintended regressions, and require a product decision before formal
adoption. This experiment adds no business-layer getSelection/search/getLine override.

```bash
pnpm test:terminal-native-input:p0:copy
# Reuse an existing copy corpus without executing its commands again:
pnpm test:terminal-native-input:p0:copy --captures <copy-capture-root>
```

The final reviewed record passes **344/344 applicable case lanes**: 320 library,
12 paired owned in-band, and 12 ordinary default-native lanes. The cursor-only
control fails 56 applicable lanes, including the original owned Tab failures.
Direct comparison against unmodified installed xterm passes **12/12** for ASCII,
Unicode and real quoted-insert Tab native editing; actual execution and Tab
history/effect files are verified. The strong no-hard-newline source equality
diagnostic and its 12 mismatches remain recorded, outside product acceptance.

The corpus includes soft/hard wraps, meaningful and trailing blanks, erased
tails, wide placeholders, combining characters, partial selections, real forward
and reverse drags, column selections, word/line clicks, native SearchAddon
selection, Tab arrival columns, scrollback trim, saved cursors, alternate screen
and installed Vim. Three real owned Bash cases preserve exact source binding and
side effects while comparing full native copy at four resize widths and after
acceptance. No owned failure is removed from the applicable profile.

Alternate soft-wrapped lines can retain their old width after a resize. The
repair uses actual native `line.length`, preserving retained cells rather than
clipping to viewport columns. Both alternate soft-wrap/Tab cases stay in the
gate; the pre-fix failure and candidate bundles are archived. The final record
is `.native-input-p0/copy-runs/2026-10-31T08-48-37.817Z/`, including a `review/`
snapshot of the tested bundles, manifests, patches and verifier sources.

The unchanged 15-case in-band and 192-commit evidence is hash-checked and reused,
not rerun. This completes the reproduced copy defect in the measured scope;
formal cursor/copy/display-mechanism adoption was subsequently approved.
Capability negotiation and production recovery remain P1/P2 work. P1 and
concurrent SFTP edits are preserved. The production route is unchanged.
This entry requires the frozen prototype evidence and GNU builds described in
the report. Missing evidence is an error, not an automatic acceptance or skip.

GNU Bash and Readline identify their sources as GPL-3.0-or-later; their notices
and complete source/patch inputs remain in the ignored build tree. Rust package
license identifiers are captured from Cargo metadata. No adapter binary is
bundled, uploaded to a business host or released by this experiment. A later
distribution must use per-target artifacts, immutable content-addressed staging,
hash verification and corresponding dependency notices/source provenance.
