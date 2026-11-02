# Native GNU dependency targets

`python3 scripts/native-input-p2/build.py` builds Bash4.1/Readline6.0,
Bash4.4/Readline7.0 and Bash5.3/Readline8.3.6 on the accepted target platforms.
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

Building resources is not platform acceptance or production enablement. Every
target still requires its real Shell/PTY/SSH/display/lifecycle acceptance evidence.
