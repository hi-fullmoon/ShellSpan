# Diagnostic Agent retirement

The Diagnostic Agent product surface was removed on 2026-08-28 because it did not provide enough practical value to justify its product and maintenance cost.

The removal includes the AI panel mode, static diagnostic-plan fallback, dynamic Agent workspace, remote-health handoff, host-overview status, frontend stores and protocols, Tauri lifecycle and terminal-control IPC, dedicated Agent PTY leases, audit migrations, schemas, fixtures, tests, roadmap gates, and implementation design documents.

AI chat, terminal-output explanation, paste-only command generation, remote health snapshots, and redacted diagnostic-bundle export remain available. Generated commands still pass a local read-only allowlist before the UI offers the paste shortcut; TermBridge never sends Enter automatically.

Existing installations may still contain inert Agent audit tables created by earlier versions. The application no longer reads, writes, migrates, or executes them, and the retirement deliberately avoids deleting historical local data during upgrade.
