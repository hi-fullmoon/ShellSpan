# Terminal connection deadlines

## Explicit close

`close_session` is asynchronous. While a close is pending, the Agent runtime rejects
new starts and submissions targeting that transport. It stops input admission and
cancels associated root Agents (including descendant Agents and pending tools),
then cleans terminal leases, closes the broker generation with `UserClosed`, and
requests transport shutdown. Failures propagate to the caller. The frontend removes
each tab only after success; failures retain that tab and show a localized Toast.
Bulk closing settles each terminal independently. Agent conversations remain in history.

Local shutdown requests termination of the shell. SSH shutdown closes the channel;
detached remote services may continue. Closing does not assert that uncertain remote
effects were rolled back and does not replay commands automatically.

## Bash prompt input

Integrated Bash sessions with Readline enabled keep `ICRNL` and `ECHOCTL` disabled
while waiting for input at a prompt. Disabling line editing restores the flags so
canonical input can still translate Enter. Readline displays typed input; a CR
arriving while Bash is running prompt hooks stays queued as CR instead of being
echoed by the cooked PTY as an extra newline. Only these two flags are saved and
restored before commands and on shell exit, including EOF; other terminal settings
made by prompt hooks remain in effect. EXIT and INT handlers are reconciled at
each prompt so runtime replacements and removals retain their semantics, including
the shell's positional arguments and the interrupted command's exit status. Ignored
SIGINT remains ignored by foreground programs. On Bash 4+, prompt cancellation
feedback respects Readline's echo-control setting and the configured interrupt
character; its marker appears on a separate line to preserve the cancelled input
after Readline has returned the cursor to column zero. Raw output is never stripped
of empty lines. The shared bootstrap applies this behavior to newly opened local
and SSH Bash sessions. Already running sessions need to be reopened or reconnected.

Private `stty` maintenance runs via `exec` in command-substitution children that
inherit the shell's process group, instead of creating short-lived foreground
jobs. This avoids the parent/child `setpgid` race observed with macOS Bash 3.2
without changing the user's `monitor` option or the process groups of user jobs.
Existing `PROMPT_COMMAND` callbacks retain their original execution semantics;
their own external foreground commands can still encounter the upstream race.
Those diagnostics are not filtered or hidden by ShellSpan.

## Connection deadlines

“Open terminal here” supplies an optional `initialDirectory` in the session
creation request. The backend rejects empty paths and control characters (which
could be interpreted by the terminal line editor), quotes the path
as one POSIX shell argument, and queues one setup line before publishing the
connected transport. That line is consumed by the interactive shell after its
startup scripts. The PTY initially disables ECHO to avoid premature duplicate
echo; the setup line restores ECHO before changing directory, including when the
directory does not exist. Ordinary fallback uses the standard SSH shell request,
so Zsh does not load `.zshenv` through an additional exec parent. Directory errors
remain visible in shell output. Sessions without an initial directory keep their
existing PTY modes and startup behavior.

An ordinary SSH terminal connection has one 30-second network deadline, starting
when its backend worker is dispatched. DNS lookup, all resolved addresses, jump
host setup, SSH handshake, authentication, broker attachment and shell startup
share that deadline. TCP attempts retain a maximum of 12 seconds per address;
SSH blocking operations retain their 15-second limit. Neither extends the shared
deadline. Frontend password entry and host-key confirmation happen outside the
worker attempt and do not consume its network budget.

Before readiness is published, timeout or removal from SessionManager shuts down
owned socket handles to interrupt blocking SSH operations. DNS waits and TCP
attempts observe the same cancellation/deadline. A late result cannot publish
readiness for a removed session. Successful readiness disarms the startup deadline
without closing the live transport. Existing connected-session keepalive,
disconnect detection and bounded reconnect policy remain independent.

Readiness validation and the registry's connected-status update share the lock
used by session removal. They complete before the success event, activity update
or result signal is published. Jump bridge accept/pump loops share the terminal
attempt's cancellation state; failed attempts join owned bridge workers before
publishing their failure result. Successful bridges remain alive after the
startup deadline and are joined when their terminal worker ends.

The create-session result waiter allows one additional second for deadline
cleanup. Expiry or a failed waiter closes the session and returns an error for
both broker-enabled and legacy paths; it never returns a successful summary for
a connection still in progress. Blocking OS DNS resolver work may finish later,
but its result is no longer used to open a connection.
