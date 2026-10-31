# Visible command presentation

Integrated Bash, Zsh and PowerShell emit `OSC 133;A` before the prompt and
`OSC 133;C` alongside the command-start hook, terminated with BEL. These
markers share the PTY stream with command echo and output, so frontend rendering can delimit
the command without guessing prompts, parsing source, or relying on timing
between independent frontend events.

The frontend shades only the command range belonging to an active Agent
lease with `commandExecution: true`. `terminal_execute` sets this acquired-event
flag and publishes the approved, redacted source as optional `commandDisplay`.
When the shell accepts a generated submission, optional `commandSubmission`
contains that exact line under the same redaction policy. Both fields are
presentation metadata and confer no execution authority.
Private job-control requests send
`commandExecution: false`: they consume an ordered boundary slot but create no
background range. Interactive observation and input leases omit the field.
`commandDisplay` is optional and is not a decoration prerequisite.
The frontend anchors the beginning before acknowledging
frontend readiness and closes the range when xterm parses `OSC 133;C`.
The prompt marker reanchors the range if delayed PTY display follows lease
acquisition. In-progress shading appears only during the typing phase;
output is never shaded while waiting for an optional boundary.
Acquired command scopes queue in lease order and consume the ordered PTY
boundaries one at a time. A later acquisition never replaces an earlier
unconsumed scope; its range starts at the next prompt. Pending scopes are
bounded to 256 entries for old connections without display markers. The
`running` phase is published under the submission fence before lease release.
Requests released before that phase are discarded because no C is expected;
submitted requests retain their slot until the ordered display boundary.
Output retains its ANSI attributes. Markers follow normal-buffer scrollback
and reflow; alternate-screen applications hide these decorations. Lease
release hides an unfinished decoration; a fresh prompt also discards a released
scope when no command boundary arrived. Rebinding or disposing removes all
decorations.

Bash's intermediate native-input clears are held until its previous painted
prefix returns, with a 750 ms limit for each render hold. A timeout releases
only that hold and discards its snapshot; once native echo paints again, the
same command can protect subsequent clears. Repeated delays must not disable
redraw protection for the remaining command. Cancellation, takeover, resize,
buffer changes and ordered command boundaries still release held rendering.

These markers are untrusted, optional presentation hints. They do not change
the private control protocol, approvals, command capture, execution status,
input suppression or cancellation. Existing connections without the marker
continue displaying their original terminal stream.

Run `pnpm test:terminal-command-presentation` on macOS or Linux to capture real
integrated Bash/Zsh PTY executions and render them through xterm in WebKit.
The focused native case launches a real shell job, polls it three times and
executes a complete foreground script through the production terminal registry.
The browser checks wide/narrow layouts, app/terminal color schemes, delayed
display after lease release, internal control boundaries before and after a new
acquisition, consecutive polls, cancelled controls (including screen clear),
selection, reflow, alternate screens and cleanup.
Windows PowerShell runtime acceptance requires a Windows host.
`SHELLSPAN_NATIVE_SCRIPT_TRACE_PATH` can point the browser check at a complete
native script capture and its metadata. That path replays the actual acquired
lease events exported by the focused native case, without synthesizing
`commandDisplay`, command-execution flags or running-phase events.

The AI Shell card displays approved tool input separately from terminal output.
For structured terminal results, `combinedOutput` is the authoritative shared
capture, including an empty string. Direct results without that field use
`stdout` and `stderr`. Empty streams never fall back to displaying the result
envelope. Execution state is separate from tool-call completion and the launch
command's exit code. Other result fields, including original and submitted
command lines, remain available in the tool's execution details. This does not
rewrite the native terminal stream or change the accepted shell submission.

The terminal pane displays live shared output and interactive programs through
the original xterm. Agent input echoes use a source projection when acquired
lease metadata supplies both source and a distinct generated submission. Ordered
OSC command boundaries delimit the input. An input-time projection additionally
requires an editor erase/redraw, the same observed prompt, and a matching live
cursor, allowing trailing spaces, tabs and newlines between the final matched
character and that cursor. Previously verified input fragments keep their
projection when Readline leaves them in scrollback during a longer redraw;
their native prefix and prompt are still checked on every refresh. Reuse also
requires an extent within the verified fragment, unchanged native row contents
and unchanged erase revisions.
An erased or overwritten row must be verified again at the live cursor (or
the final input boundary); it cannot turn process output into an input echo.
For a split CR-before-erase redraw, a previously observed input may be checked
at the start of its current final row, only if its prefix consumes the entire
remaining input span and that row has no non-whitespace suffix.
Text resemblance alone never establishes an input echo. Completed
projections retain each verified fragment's logical-line anchors and character
offset, rather than rescanning unrelated output for matching prefixes.
Process output, its ANSI attributes and native job notices remain in place.
Original source is laid out by xterm itself, including Unicode and soft wraps.
Selection and search use the displayed cells. Missing metadata leaves the native
display available. Full-screen applications always use their original buffer.

Native editor animation uses grapheme-safe prefixes of the approved source for
intermediate frames. The final frame still installs and validates the exact
generated submission before accept-line. Each frame keeps its original receipt,
readiness, cancellation and submission fences; presentation adds no PTY writes.
The frontend reveals the verified command view over animation frames instead of
painting each transport batch at once. Reduced motion displays it immediately.
The ordered command boundary flushes pending presentation before process output;
cancellation, buffer changes and disposal discard pending animation.

The xterm 6 compatibility adapter changes line references only during synchronous
rendering and selection. During rendering it also places the cursor after the
displayed prefix, including wide and combining characters, and refreshes both
the previous and current cursor rows. All native line references and cursor
coordinates are restored in `finally`. Parsing, native state, PTY bytes,
execution capture, approvals and cancellation are unchanged.
Logical-line markers retain completed input projections across
reflow and expire with scrollback. Rebinding the same Terminal transfers only
completed records to its next adapter; active scopes and leases are cleared.
Final terminal disposal clears the adapter and all records.
No source projection writes terminal input or acknowledges a lease.
Readiness requires the selected, connected controller's actual terminal input
to receive focus, together with
the existing output subscription and frozen lease checks. The AI Shell card
retains command input, execution status and captured results separately.

`pnpm test:terminal-command-source` captures real Bash PTYs and checks original
source, native clipboard, foreground/background output, scrolling and reflow in
Chromium and WebKit, including each paintable input frame. Set
`SHELLSPAN_SOURCE_RENDERER=webgl` to run the same checks with WebGL.
The nearby unit tests replay checked-in native captures in fragmented reads
and also verify that a real process printing the exact internal submission
before or after the command is preserved as ordinary output, with or without
a trailing newline or an end-of-line erase. Native bytes and cursor state must match an
unmodified reference xterm throughout.
