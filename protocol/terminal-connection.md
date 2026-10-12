# Terminal connection deadlines

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
