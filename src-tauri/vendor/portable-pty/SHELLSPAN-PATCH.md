# ShellSpan portable-pty patch

This directory vendors the exact `portable-pty 0.9.0` crate distributed by
crates.io (registry checksum
`b4a596a2b3d2752d94f51fac2d4a96737b8705dddd311a32b9af47211f08671e`). Its MIT
license is preserved in `LICENSE.md`.

ShellSpan changes one Windows-only call: `CreatePseudoConsole` uses flags `0`
instead of the upstream hard-coded `PSEUDOCONSOLE_INHERIT_CURSOR |
PSEUDOCONSOLE_RESIZE_QUIRK | PSEUDOCONSOLE_WIN32_INPUT_MODE` combination.

ShellSpan passes xterm-compatible VT input bytes directly to the PTY master.
Win32 input mode instead requires a terminal-specific encoding of Win32 virtual
key, scan code, Unicode, key state, modifier, and repeat fields. Selecting the
standard ConPTY VT input mode keeps the Windows backend aligned with the input
contract used by the frontend and the Unix PTY backend.
