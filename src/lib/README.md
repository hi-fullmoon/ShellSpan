# Library layout

`src/lib` is organized by application domain. New domain-specific modules belong
in the matching directory instead of the library root.

- `ai/`: AI session state, projections, provider contracts, and composer policy.
- `connections/`: connection import and credential prompt workflows.
- `host/`: host actions, host health, monitoring, and overview projections.
- `ipc/`: typed Tauri command and event adapters.
- `petdex/`: Petdex integration and feedback helpers.
- `sftp/`: remote file browsing, previews, workspace persistence, and transfers.
- `terminal/`: terminal state, output buffering, workspace persistence, and
  terminal-specific command validation.

The root is reserved for genuinely cross-domain utilities. Tests live in the
`__tests__` directory nearest to the code they exercise.

Prefer explicit domain imports such as
`@/lib/terminal/terminal-output-buffer`. Avoid adding a root-level compatibility
barrel: it hides ownership and recreates the coupling this layout is intended to
prevent.

`ipc/tauri.ts` remains a consolidated adapter while its command groups share
logging and cancellation behavior. New IPC commands should still be grouped by
domain inside that file so they can be extracted without changing call sites.
