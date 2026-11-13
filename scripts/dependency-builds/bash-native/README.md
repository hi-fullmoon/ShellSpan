# Native GNU dependency targets

`python3 -B scripts/native-input-p2/build.py` builds the release profile,
Bash 5.3 / Readline 8.3.6, under `src-tauri/target/native-input/`. Set
`SHELLSPAN_NATIVE_BUILD_ROOT=.artifacts/tests` when preparing inputs for local
acceptance tests. To build the older
profiles for compatibility checks, pass `--versions 4.1,4.4` or
`--versions 4.1,4.4,5.3`. Use `--include-legacy` when listing or running the P2
application matrix or checking its cumulative evidence.
The dependency recipe verifies the pinned GNU archives and official Readline
patches, then applies the explicit post-profile startup and native display patches.

The Readline display extension adds `rl_native_prompt_columns()` to its public header
and implementation. This read-only extension returns Readline's own column count
for the prompt's last logical line, including invisible spans, multibyte widths
and supported mode strings. It is called on the Shell's Readline thread after
the prompt is ready. It does not edit text, move the cursor or accept a line.
The adapter resolves the public symbol before native initialization, including
on Bash4.1 which does not call the newer load hook. Its explicit read-only ABI
query is also checked by the producer and bootstrap. A target without the ABI is
refused, with no replacement Shell or fallback.

The adapter expands Tab from those native prompt columns and the actual editor
prefix, preserving source bytes. Clearing an unchanged owned draft restores its
renderer before acknowledging DraftCleared; event-hook teardown retains its safe
native service-key boundary. Foreign renderers and user drafts are not replaced.

These are explicit dependency builds, not transparent substitutes for the user's
bound executable. Each native profile verifies its actual Shell/module/relay
hashes and `readlineDisplayAbi: 1`. Source inputs invalidate cached builds when
the recipe or patches change. GNU archives, official and integration patches,
source notices and the rebuild instructions accompany the resource kit.

Readline 6.0 also receives the bracketed-paste implementation from the pinned
Bash 4.4 / Readline 7.0 archive (SHA-256
d86b3392c1202e8ff5a423b302e6284db7f8f435ea9f39b5b1b20fd3ac36dfcb).
The readline-paste-6.0.patch backports the insertion function, standard key binding,
public declaration, option and terminal enter/leave handling. It keeps the
standalone dependency's default off and preserves custom key bindings.
The explicit native Bash startup enables the standard option for its own
interactive session before opening NIP. Ordinary pasted Tab/newline bytes are
then inserted by Readline rather than interpreted as completion/accept keys.
No user startup or inputrc file is changed. The actual editor ABI remains 6.0;
this does not relabel the dependency as Readline 7.0. The affected Readline
source files and the backport patch are recorded in the build provenance.

The macOS Bash 4.1 target backports Bash 4.4's loadable-builtin unload callback
lookup and call. Its original `enable -d` removes the builtin without invoking
`ss_native_input_builtin_unload`, leaving the adapter's private socket and
Readline bindings active. The backport invokes the existing teardown before
deleting the builtin, preserving the adapter's required `RTLD_NODELETE` pin for
registered fork handlers. It adds no acceptance-only close command. The exact
patch, resulting `builtins/enable.def` and `general.h` hashes accompany the build.
Other target versions and non-macOS application of this patch are unchanged.

Darwin Bash 4.1 additionally receives the standard `ioctl` and signal headers
present in the newer GNU sources. The variadic `ioctl` declaration must be
visible even when Darwin's termios headers already define `TIOCGWINSZ`.
Actual compilation rejects implicit function declarations; old configure probes
keep their GNU C89 compatibility with warnings visible, not suppressed.

The macOS Bash 4.1 target also backports Bash 4.4's `putx` return value from the
same pinned archive. The native production service key uses `bind -x`; its tputs
output callback must return the result of `putc`, matching its declared `int`
contract. The actual `bashline.o` is compiled with `-Werror=return-type` before
the full build. This patch and the final `bashline.c` hash accompany provenance;
it does not alter a key binding, user history or permission to accept input.

Readline 6.0 and 7.0 backport the Readline 8.3.6 resize path's clearing of only
the screen rows occupied by the current editor line. This preserves historical
output while removing obsolete rows when the editor becomes narrower/shorter.
It does not clear the terminal screen or reconstruct display from a source copy.
The three verified macOS GNU main/module profiles select the existing Unicode 11
provider for their session so ordinary editing uses the measured native widths.
Unsupported raw shells and other platforms do not acquire this metadata from queries.

The macOS Readline 6.0/7.0/8.3.6 producers keep zero-width suffix bytes in the
same display row as a base character that fills the right margin. The patch
advances only the existing invisible-buffer break; it preserves source bytes,
hard newline separators and leading zero-width input. It uses Readline's own
multibyte/width results and does not normalize NFC/NFD or parse terminal output.
The patch and final display source hashes invalidate old resources for rebuilding.

The macOS GNU jobs path uses a private pipe to order the original parent and
child `setpgid` calls. The child continues after the parent closes its write
end following its original process-group assignment. The existing child call
and diagnostic remain unchanged; no syscall error is reclassified, retried or
suppressed. Failed fork attempts close both pipe ends; an unexpected child
read failure exits that child without executing the job. The patch/header and
final jobs source hashes invalidate old resources and accompany the actual
build. This changes no user monitor setting, signal disposition or startup file.

Building resources is not platform acceptance or production enablement. Every
target still requires its real Shell/PTY/SSH/display/lifecycle acceptance evidence.
