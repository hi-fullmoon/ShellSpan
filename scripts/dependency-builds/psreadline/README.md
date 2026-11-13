# PSReadLine 2.4.5-shellspan6

The native Windows providers use an application-private build of upstream
PSReadLine v2.4.5. The public module/API version remains 2.4.5; the verified
profile ID adds `shellspan6` and binds the actual assembly digest.

The reviewed patch registers a process-exit handler after native history
initialization. This fills the ordinary `exit` path that does not enter the
console-closing key loop. It calls the module's own history writer only for
SaveAtExit, retaining its sensitive-history filtering and mutex. An already
disposed mutex means the existing console-closing path has handled history.
SaveNothing and SaveIncrementally retain their original behavior.

The resize patch also corrects the cached input origin after a size change
when the previously rendered input is empty. It reads the actual console
prompt end instead of reducing an old physical column modulo successive
widths. It does not invoke the prompt, edit input or change native permissions.
The new private display provider also measures grapheme widths with the exact
Unicode 15 data and join rules from pinned `@xterm/addon-unicode-graphemes` 0.4.0.
Its MIT notice is included as `XTERM-LICENSE`. Public input offsets remain UTF-16.
Rendering defers a trailing high surrogate until the next input unit arrives.

The verified startup host installs a numeric display delegate once, on the
original editor thread. Only that installation enables grapheme layout; no
environment variable or file channel enables it. At prompt initialization the
delegate obtains bounded cell widths through a separate private pipe. Both
endpoints authenticate the actual peer PID. Rust binds each request to the
current terminal session and generation, and the frontend reads the actual
xterm cells after queued output has drained. This channel cannot send input or
change NIP, approvals, leases or execution facts. Closing the native context
also closes its display endpoint.

A NIP control failure leaves the still-live PTY's display service available for
the real failed-draft cleanup and ordinary PSReadLine editing. It neither
reopens command control nor settles recovery or returns editing ownership.
Context disposal and PTY shutdown still close the display endpoint, and a
session rebind cancels the old display binding.

An independent original-thread lifecycle observer runs only after the first
initialization of a new public ReadLine call has reset its buffer and cursor.
It must not run during exception recovery, which temporarily clears then
restores the previous line. The host re-reads GetBufferState and uses
the existing failed-draft confirmation only when control has already failed.
This avoids relying on an idle callback or a queued service key after Ctrl+C.
It retires only an observed-empty local handoff guard and emits no NIP receipt
or backend recovery/ownership fact. Display data cannot trigger this observer.

Display wire version 2 adds an explicit pending-wrap boolean. When a prompt
fills the final cell, xterm exposes column `columns` while Console reports the
last visible column. The observer reads every real cell and reports that exact
state; other coordinate mismatches remain rejected. The original editor thread
validates the full-width observation, materializes the pending soft wrap using
a display space and backspace, then reads the actual cursor origin, including
bottom-row scrolling. This changes no editor buffer, source or input authority.

Clearing stale cells uses bounded ECH in the private grapheme renderer. Writing
literal spaces there made erased cells appear in copied multiline input after
wide-character padding changed physical line counts. ECH preserves the text
instead of applying whitespace trimming to copied results.

Resizing uses the measured soft-wrapped prompt widths and actual console cursor
to recover the active input origin. Automatic PromptText inference strips SGR
only from derived metadata and retains a complete final grapheme. It neither
changes the returned prompt nor calls the prompt an extra time.

Real ConPTY plus installed xterm cursor-query regression evidence compares
both private builds on PowerShell 7 and Windows PowerShell 5.1: all twelve
empty-input origins are correct with this patch; six were wrong before it.
The new pipe candidate has 36 actual ConPTY active-input resize scenes across
both hosts and three prompt forms, with 144 exact rendered-prefix observations.
Eight real Rust/C# pipe cases cover replies, pending wrap, server PID rejection
and cancellation. The full-width candidate has another 36 actual ConPTY scenes
and 144 exact prefix observations, including ten-column first-line edits; the
original twelve failed observations are retained separately.
Native App, background-output and full acceptance remain separate, pending gates.

`build.json` pins the upstream source archive, patch, .NET SDK and output bytes.
The adjacent NuGet lock files pin transitive package content. Builds normalize
source paths and omit debug records so different owned build directories
produce identical assemblies.

```text
node scripts/rebuild-psreadline.mjs
node scripts/rebuild-psreadline.mjs --install
node scripts/rebuild-psreadline.mjs --verify-only
```

Builds use unique directories under `src-tauri/target/dependencies/psreadline/`.
`--install` copies only verified generated assemblies and their provenance into
the bundled module. It does not install or change the user's PowerShell/module,
alter execution policy or trust, enable production profiles, or package a release.

Upstream: https://github.com/PowerShell/PSReadLine/tree/v2.4.5
