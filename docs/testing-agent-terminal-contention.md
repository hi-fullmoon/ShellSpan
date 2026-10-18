# Native Agent terminal contention and close

Run `node scripts/verify-ai-session-stream.mjs --terminal-contention` on a desktop
with a configured model route. This uses two real Agents and a local PTY to check
submission blocking, warning feedback, draft retention, release, manual retry,
simultaneous admission, confirmed takeover, and closing a running Agent terminal.
The close checks also verify unrelated-task preservation and a rendered error Toast.
Only test-created sessions and terminals are cleaned up.

The contention runner owns `127.0.0.1:1432` exclusively. Its compiled Tauri URL is
fixed; an HTTP redirect supplies the current test page and per-run result token.
This avoids changing the macOS binary identity solely because the port or token
changed. A busy port fails immediately instead of selecting another port.

`--no-model` runs real PTY and production close/error UI checks and cancels durable
Agent sessions without starting a model. It does not prove live model cancellation.

For repeated verification with an already-built binary, pass
`--native-binary /absolute/path/to/ShellSpan`. The binary must have been built by
the contention runner for the fixed entry above and must match the source under
review. This option skips Cargo and preserves that exact executable, so another
development process cannot replace it during authorization or verification.

macOS credential authorization is independent of the test result. A successful
metadata lookup or an unlocked login Keychain does not prove password access.
Ad-hoc code signatures change when a binary is rebuilt; an item restricted to old
code hashes can reject a new build without showing a password prompt. Authorize
only the intended verified application through the system credential controls.
Do not reset the vault, export credentials, or grant generic access to unsigned
applications to make a test pass. Source changes still require rebuilding and
may require renewed system authorization.
