# Terminal Agent enhancement M4 background recovery and Operator

M4 adds durable background-task metadata, restart reconciliation, redacted
desktop notifications, bounded Operator grants, a native credential/elevation
broker, and native egress/sensitive-path policy to the opt-in Agent Contract v3
runtime. It does not replace Agent v2, enable v3 by default, or implement M5
Fleet and multi-Agent orchestration.

Rust remains authoritative for task identity and lifecycle, plan progress,
phase, timestamps, frozen targets, effects, failures, recovery advice,
notifications, approval, capability provenance, Operator scope, broker state,
dispatch policy, execution, and result correlation. The WebView renders Rust
snapshots and invokes explicit native actions; it does not infer recovery or
replay a call.

## Delivered boundaries

### Background task state and notifications

Closing the Agent panel does not cancel a v3 task. The native runtime retains
the task and exposes it through the background task center. Each snapshot
contains the frozen request, Rust state and phase, plan progress, correlated
results, recovery-call journal, native process state, last failure/effect,
recovery advice, and notification metadata.

The task center can rebind a restarted task to a currently active terminal,
continue after native reconciliation, cancel without replay, inspect lost
processes, and configure or revoke an Operator grant. A restarted task cannot
request a new capability until Rust has verified a replacement session with
the same local/remote identity and frozen roots. Rebinding also updates the
native context, extension, and MCP task copies so they cannot keep a stale
session target.

Completion, failure, human-action, and Operator-expiry notifications use fixed
redacted copy. They contain no goal, command, path, arguments, output, result
data, credential reference, or secret. Delivery is at-least-once: an item is
marked delivered only after the OS notification API accepts it.

### Durable persistence and restart semantics

M4 stores a versioned envelope in the application-data directory:

- `agent-m4/tasks-v1.json` for tasks, notifications, and the bounded audit
  snapshot;
- `agent-m4/audit-v1.jsonl` for append-only audit events, rotated to one
  previous file after 1 MiB.

The task store is limited to 2 MiB, 128 tasks, 512 calls/results per task, 256
notifications, and 1,024 in-envelope audit entries. Writes use a staged file,
file flush, atomic replacement, and directory flush. Unix files are restricted
to mode `0600`; Windows uses write-through `ReplaceFileW`/`MoveFileExW`.

Before persistence, Rust redacts goals, criteria, plan text, failures,
summaries, and effect summaries; removes result data and artifacts; bounds
collections; and forces every call journal entry to
`automaticReplayAllowed: false`. The store never serializes capabilities,
capability signing material, Operator grants, broker grants, credential values,
or live process handles that can be reattached.

Version 0 task envelopes migrate to version 1 with empty notification/audit
collections. Unsupported, oversized, malformed, or schema-invalid stores are
renamed to `tasks-v1.corrupt-<timestamp>` and start from an empty recovered
state with a visible warning. Accepted stores are sanitized, reclassified, and
rewritten in the current format before a task can resume.

Restart classifies tasks as:

| Disposition | Meaning | Allowed action |
| --- | --- | --- |
| `safeToResume` | no uncertain write/external call or lost process | verify and rebind a live matching session before new authorization |
| `needsReconciliation` | an in-flight state-changing, destructive, external, or MCP call is uncertain | inspect the target, then continue or cancel; never replay the call |
| `lost` | a process-local handle cannot be reattached | inspect the host, acknowledge loss, then continue or cancel |
| `cancelled` | native cancellation is durable | create a new authorization flow to do more work |
| `completed` | completion has native plan evidence | retain for audit only |

Waiting approval is not restored as an approval, waiting on an external system
requires reconciliation, and every non-terminal native process becomes lost.
No previous command, file write, transfer, MCP call, capability, Operator
grant, broker grant, or approval is revived.

Continuation revalidates the v3 rollout at the command boundary, the frozen
local/remote target, connected session identity, remote profile identity,
known-host key, canonical local/remote root, sensitive-write setting, egress
configuration, and Operator configuration. Missing or unknown state fails
closed and remains visible as recovery work.

## Operator

Operator is a separate default-off rollout. A grant exists only in Rust
memory, belongs to one Operator task, and is bounded by exact target ids, tool
names, effects, path prefixes, network destinations, elevation permission, and
TTL. The maximum TTL is 30 minutes; the task-center action requests five
minutes. Configuration shows the exact scope in a native dialog. Expiry,
use, revocation, and scope are audited without arguments or secret values.

M4 Operator auto-approval is intentionally conservative. Even when a grant
lists the tool/effect, Rust falls back to ordinary per-call native confirmation
for unknown writes, sensitive paths, destructive effects, and external side
effects. Hooks, Skills, Runbooks, MCP policy, schema validation, frozen target
validation, effect classification, call digest, capability limits,
checkpoints, egress, and sensitive-path controls remain mandatory.

Every Operator-derived capability records its native grant id. Rust verifies
the grant is still present, unrevoked, unexpired, exact-scope, and still
auto-approvable both during capability issuance and immediately before
dispatch. Revoking a grant also revokes all issued capabilities derived from
it. Operator grants and capability provenance do not survive restart.

Elevation needs all of the following:

- an Operator task and an active exact-scope grant with `allowElevation`;
- an exact-call, single-use native elevation-broker grant;
- a non-PTY execution channel;
- on Unix, non-interactive `sudo -n`; captured Windows elevation is unavailable
  and fails closed.

No password prompt or elevation token is captured or returned.

## Native credential and elevation broker

Broker records are process-local Rust state. Each grant is bound to task id,
request id, call id, frozen target id, tool name, kind, purpose, an optional
opaque native credential reference, and a TTL no longer than five minutes.
Grants are single-use, explicitly revocable, audited on authorization,
consumption, and revocation, and discarded on restart.

Public grant snapshots expose only whether a credential reference exists; they
never serialize the service/id pair or value. Credential lookup and injection
remain inside Rust. MCP grants are created after native MCP confirmation and
consumed only for the matching server call. Remote tool authorization creates
an exact single-use remote-profile grant derived from the exact native call
authorization; dispatch consumes it before the remote execution driver can
resolve the profile. Elevation uses a separate purpose and accepts no
credential reference.

The broker does not provision credentials. Existing OS credential-store
entries and remote/MCP profile references remain prerequisites. M2 remote
preview and checkpoint inspection still use the existing Rust-only credential
manager boundary; their values do not cross IPC, but unifying those inspection
reads under consumable M4 grants is not claimed here.

## Egress and sensitive paths

Rust derives a `CallPolicyScopeV3` from the effective arguments after Hooks.
It records literal network destinations, paths, sensitive/critical path
counts, unknown writes, and unknown network egress. The scope participates in
effect classification, native approval text, audit events, durable recovery
calls, the task-center policy summary, Operator matching, and dispatch.

Policy is evaluated when authorization is prepared and independently again at
dispatch, after target/effect revalidation and before journaling or execution.
Changing the environment or revoking an Operator grant between approval and
dispatch therefore cannot reuse stale approval.

Critical writes and checkpoint restores require an explicit sensitive-write
opt-in. External side effects may reach the exact frozen SSH/SFTP target;
other literal destinations require an exact protocol/host/port allowlist.
Unknown network egress from an external-effect `exec_command` is denied.
Unknown configuration values fail closed.

This is a native call-policy boundary, not an operating-system firewall.
Literal structured destinations are enforced exactly; unclassifiable external
shell egress is denied rather than guessed. Arbitrary third-party MCP processes
can have behavior beyond their declared schema, so MCP remains separately
enabled, native-confirmed, bounded, and treated as untrusted.

## Configuration

Agent v2 remains authoritative unless the exact v3 runtime stage is selected.
MCP and Operator require separate opt-ins:

~~~sh
export SHELLSPAN_AGENT_V3_ROLLOUT=runtime
export SHELLSPAN_AGENT_MCP_EXPERIMENTAL=enabled   # optional, independent
export SHELLSPAN_AGENT_OPERATOR=enabled           # optional, independent
pnpm tauri:dev
~~~

Sensitive critical-path writes remain disabled unless explicitly enabled:

~~~sh
export SHELLSPAN_AGENT_SENSITIVE_WRITES=enabled
~~~

Egress defaults to an empty allowlist. To permit non-target destinations, use
exact entries with no path, query, fragment, username, or password:

~~~sh
export SHELLSPAN_AGENT_EGRESS_POLICY=allowListed
export SHELLSPAN_AGENT_EGRESS_ALLOWLIST='https://api.example.com:443,ssh://ops.example.com:22'
~~~

`SHELLSPAN_AGENT_EGRESS_POLICY=deny` keeps the empty allowlist. Unknown values,
or `allowListed` without a valid list, fail closed. Environment settings are
read by Rust; none is an approval or a capability by itself.

## Migration, rollback, and data handling

M4 does not migrate v2 history into executable v3 tasks. Existing v2 history
remains readable under the v2 compatibility path. M4 v0 metadata is the only
automatic persistence migration described above.

To roll back, disable the optional layers and restart ShellSpan:

~~~sh
export SHELLSPAN_AGENT_OPERATOR=disabled
export SHELLSPAN_AGENT_MCP_EXPERIMENTAL=disabled
export SHELLSPAN_AGENT_V3_ROLLOUT=disabled
pnpm tauri:dev
~~~

This immediately returns command routing to v2. Process-local capabilities and
grants disappear on restart. The redacted v3 metadata remains on disk for
diagnosis/audit and is not executed by v2. If operators choose to remove that
metadata, ShellSpan must be stopped first and the application-data `agent-m4`
directory should be archived before deletion.

## Verification evidence

The completion review ran on macOS with the locked Rust 1.95 toolchain. The
Windows commands in the checkpoint were translated to their host-toolchain
semantic equivalents; Windows-specific atomic replacement remains covered by
conditional implementation rather than execution on this host.

~~~text
CI=true pnpm test:agent:m4
  PASS: 3 files, 10 tests

CI=true pnpm test:agent:contract-v3
  PASS: 1 file, 5 tests

CI=true pnpm exec tsc --noEmit
  PASS

CI=true pnpm build
  PASS: production bundle built; existing >500 kB chunk advisory remains

cargo +1.95.0 test --manifest-path src-tauri/Cargo.toml --locked agent_runtime_v3::m4::tests
  PASS: 8 tests

cargo +1.95.0 test --manifest-path src-tauri/Cargo.toml --locked agent_runtime_v3
  PASS: 45 tests; 1 isolated SSH/SFTP Docker test ignored by its existing annotation

cargo +1.95.0 clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings
  PASS

cargo +1.95.0 fmt --manifest-path src-tauri/Cargo.toml --all -- --check
  PASS

git diff --check
  PASS
~~~

The macOS full-runtime run canonicalizes its absolute tempfile root because
macOS exposes `/var` through `/private/var`; production symlink traversal
policy was not relaxed. The ignored SSH/SFTP Docker fixture is existing M2
remote evidence and was not started for this M4 host run.

## Known limits and M5 hand-off

- Restart recovery reconciles metadata and requires a new native session; it
  does not reattach process-local command, PTY, SFTP, or MCP process handles.
- No uncertain write or external call has an automatic retry path. A user may
  continue only after native revalidation and must create a new call id and
  authorization for any later operation.
- Operator is deliberately narrower than a blanket maximum-access mode. It
  does not auto-approve unknown, sensitive, destructive, or external effects.
- Egress enforcement is based on Rust argument/effect classification and is
  not a system firewall or sandbox for arbitrary child-process traffic.
- MCP remains stdio-only and experimental; arbitrary third-party
  interoperability, HTTP/OAuth, and OS-level network containment are not
  claimed.
- The production build reports existing large-chunk advisories. They are not
  an M4 correctness failure.
- The isolated Docker SSH/SFTP test is not part of this macOS M4 run.
- Fleet, host groups, canary rollout, multi-target result matrices,
  sub-Agents, parallel orchestration, and M5 scheduling are not implemented in
  this milestone.

M5 may consume the Rust recovery snapshots and exact-scope policy records, but
it must not weaken the M0–M4 target, capability, replay, broker, egress,
sensitive-path, or verification boundaries.
