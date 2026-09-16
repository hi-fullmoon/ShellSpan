# Terminal Execution Phase 5 macOS Acceptance Evidence

Status: complete — PASS for the macOS local delivery scope
Date: 2026-09-16 (Asia/Shanghai)

## Scope and recommendation

This supplement closes the deferred native macOS Phase 5 lane. Real local PTYs
for `/bin/bash` 3.2 and `/bin/zsh` 5.9 exercise the production Broker, screen
model, lease manager, Session input queue, and interactive registry.

**Final gate: PASS for native macOS bash and zsh.** Linux and isolated SSH
Phase 5 remain missing and default-off.

## Native evidence

Host: macOS 26.6.2 (25G83), arm64; Rust 1.95.0,
`aarch64-apple-darwin`.

Both exact ignored fixtures pass all of these behaviors:

- screen-driven REPL text input and exact echoed result;
- single-key confirmation without an Enter dependency;
- PTY and Broker resize from 80x24 to 100x30;
- alternate-screen entry, cursor movement, and return to the primary buffer;
- credential-like prompt detection, redaction, lease release, and proof that
  forbidden bytes never reached the PTY; and
- byte-for-byte raw observation of the accepted scenario markers.

Exact tests:

- `macos_bash_interactive_terminal_operation` — PASS;
- `macos_zsh_interactive_terminal_operation` — PASS.

The same consolidated gate also passed both bash/zsh Broker and visible-command
fixtures, Direct process regressions, compatibility tests, and the complete
serial Rust suite: 798 library tests passed, 34 ignored; 5 integration tests
passed.

Command: `pnpm test:terminal-rollout:macos`.
