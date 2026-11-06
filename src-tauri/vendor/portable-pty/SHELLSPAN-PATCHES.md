# ShellSpan Windows changes

- Explicit private ConPTY uses the pinned redistributable's `Conpty*` exports
  and grapheme flag. Each console keeps that same API library until close;
  missing exports never fall back to a different implementation.
- `CommandBuilder::set_start_suspended(true)` opts Windows process creation
  into `CREATE_SUSPENDED`. The default remains immediate startup. The shared
  primary-thread handle is released once by `ChildKiller::resume_startup`,
  including through a cloned controller while another thread waits for exit.
- ShellSpan local sessions enqueue their initial resize before startup-ready,
  then resume the Shell. This prevents startup output from being produced at a
  different width from its first rendering. Closing before ready terminates the
  suspended process; no startup script has run. No permission or NIP capability
  is granted by this presentation handshake.
- Windows process termination now returns success when `TerminateProcess`
  succeeds and preserves real errors when it fails, rather than reversing its
  return value or discarding the error.

Real process regressions live beside the backend private-host loader in
`src-tauri/src/terminal_command/windows_conpty.rs`; registry and SessionManager
tests verify resize/ready ordering. Default Unix/SSH startup does not use the
suspended-process path.
