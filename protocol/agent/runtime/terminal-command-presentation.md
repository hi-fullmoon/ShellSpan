# Visible command presentation

Integrated Bash, Zsh and PowerShell emit `OSC 133;A` before the prompt and
`OSC 133;C` alongside the command-start hook, terminated with BEL. These
markers share the PTY stream with command echo and output, so frontend rendering can delimit
the command without guessing prompts, parsing source, or relying on timing
between independent frontend events.

The frontend shades only the command range belonging to an active Agent
lease with `commandExecution: true`. `terminal_execute` sets this acquired-event
flag without publishing command text; private job-control requests, interactive
observation and input leases omit it. `commandDisplay` is optional and is not a
decoration prerequisite.
The frontend anchors the beginning before acknowledging
frontend readiness and closes the range when xterm parses `OSC 133;C`.
The prompt marker reanchors the range if delayed PTY display follows lease
acquisition. In-progress shading appears only during the typing phase;
output is never shaded while waiting for an optional boundary.
Acquired command scopes queue in lease order and consume the ordered PTY
boundaries one at a time. A later acquisition never replaces an earlier
unconsumed scope; its range starts at the next prompt. Pending scopes are
bounded to 256 entries for old connections without display markers.
Output retains its ANSI attributes. Markers follow normal-buffer scrollback
and reflow; alternate-screen applications hide these decorations. Lease
release hides an unfinished decoration; the next prompt discards it if no
command boundary arrived. Rebinding or disposing the terminal removes all
decorations.

These markers are untrusted, optional presentation hints. They do not change
the private control protocol, approvals, command capture, execution status,
input suppression or cancellation. Existing connections without the marker
continue displaying their original terminal stream.

Run `pnpm test:terminal-command-presentation` on macOS or Linux to capture real
integrated Bash/Zsh PTY executions and render them through xterm in WebKit.
The browser checks wide/narrow layouts, app/terminal color schemes, delayed
display after lease release, selection, reflow, alternate screens and cleanup.
Windows PowerShell runtime acceptance requires a Windows host.
`SHELLSPAN_NATIVE_SCRIPT_TRACE_PATH` can point the browser check at a complete
native script capture and its metadata. That path replays the actual acquired
lease event exported by the native acceptance test, without synthesizing
`commandDisplay` or a command-execution flag.
