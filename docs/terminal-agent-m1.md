# Terminal Agent enhancement M1 native runtime

M1 adds an opt-in Agent Contract v3 execution runtime without replacing the
v2 path. Rust is authoritative for tool registration, authorization, target
identity, process lifecycle, result validation, and in-memory task state.
The rollout remains disabled by default.

## Delivered surface

The registry is constructed from
`protocol/agent/v3/built-in-tools.json`. It preserves all descriptor metadata
and exposes exactly the 12 M0 tool names. M1 implementation state is explicit:

| State | Tools |
| --- | --- |
| executable | `exec_command`, `wait_process`, `write_stdin`, `kill_process` |
| known but unavailable | `read_file`, `list_directory`, `search_text`, `apply_patch`, `transfer_file`, `host_snapshot`, `ask_user`, `update_plan` |

An unknown name is denied before a call is reserved. A known unavailable tool
produces a correlated rejected result. There is no generic shell fallback for
the eight future tools.

## Native trust boundary

The WebView requests authorization for a concrete call but cannot supply
trusted claims. Rust performs these steps:

1. Load the Rust-owned task and require its v3 source contract.
2. Resolve an executable registry descriptor and validate strict arguments.
3. Match the complete target against the frozen task target and revalidate the
   live terminal/profile identity.
4. Classify the effect in Rust. Unknown commands classify as state-changing;
   destructive and external command tokens classify upward.
5. Show a native confirmation dialog for request-approval mode and for every
   effect above read-only. The prompt includes the tool, target, task, native
   effect, TTL, and command or process operation preview.
6. Issue one HMAC-authenticated, process-private capability id bound to the
   request, user session, call id, SHA-256 digest of the exact call, tool,
   effect, and target.
7. At dispatch, verify TTL, revocation, use count, proof, exact call digest,
   live target identity, and the M0 Rust policy. Consume the capability once
   before execution.

Capability records and the signing key never cross Tauri IPC. Default TTL is
60 seconds, maximum TTL is 5 minutes, the M1 grant is single-use, revoked and
expired records cannot execute, and the native store is bounded. A changed
argument or target invalidates the exact-call digest.

`elevated: true` is denied in M1 because no native credential broker exists.
This avoids treating a WebView decision or terminal prompt as proof of an
elevated grant.

## Execution drivers

### Direct Exec

Local Direct Exec starts a non-interactive platform shell with independent
stdin, stdout, and stderr pipes. Unix children receive a dedicated process
group. Windows children are assigned to a Job Object with
`KILL_ON_JOB_CLOSE`, so cancellation, timeout, and application teardown target
the process tree rather than only the shell process.

Remote Direct Exec creates a separate verified SSH exec channel using the
frozen profile identity, existing known-host verification, and secrets loaded
inside Rust from the OS credential store. Passwords, private keys, and
passphrases are not returned over Agent v3 IPC. Remote stderr uses the SSH
extended-data stream.

Both drivers assign an opaque Rust process handle, enforce the manifest
concurrency limit, and retain a bounded head/tail capture. Each snapshot
reports lifecycle, exit code, separate stdout/stderr, bytes read, per-stream
truncation, termination confirmation, timestamps, and a redacted error.

Background Direct Exec returns while the handle is running. The three process
tools accept only the Rust-created process target associated with that handle:

- `write_stdin` writes a bounded payload and can close stdin.
- `wait_process` performs a bounded wait and returns a bounded output view.
- `kill_process` requests termination and distinguishes `terminated`,
  `terminationRequested`, and `unknown`.

For a remote SSH channel, closing the channel does not prove that the server
process died. M1 therefore reports unconfirmed remote termination honestly as
`unknown`; it does not fabricate a remote PID proof.

### PTY

PTY execution uses the already-open local or remote terminal session. Rust
injects a wrapper and observes terminal bytes before they reach the WebView.
The wrapper creates a random completion secret in the terminal runtime, emits
its SHA-256 commitment, runs the command in a child shell that does not inherit
the protocol variables, and finally emits the secret plus exit code. Rust
accepts completion only when it matches the committed secret, so command
output that imitates an end marker cannot complete the operation.

One native PTY operation may own a session at a time. Capture and protocol
buffers are bounded, and timeout/task cancellation sends the terminal
interrupt path. Since a PTY is one combined terminal byte stream, the result
reports `combinedOutput` and leaves `stdout` and `stderr` empty; it does not
claim separation that the channel cannot provide.

## Task and result authority

The Rust task store supports multiple active tasks but registration permits
exactly one local or remote host target per task. Fleet and multi-host
orchestration remain unavailable. Process targets can be appended only by the
native Direct Exec driver.

The store reserves each call id once, commits each result once, validates the
M1 result-data shape, and then applies M0 result correlation before adding the
result to history. Task snapshots carry a monotonic sequence and include the
request, state, results, processes, and timestamps. Task, result, process, and
capability collections all have explicit in-memory bounds.

The store belongs to Tauri application state rather than an Agent panel. A
closed or refreshed panel rehydrates from `agent_v3_get_task` or
`agent_v3_list_tasks`. Application exit/restart cancels active native tasks and
processes. Durable task recovery across an application restart is not an M1
claim; it is a later checkpoint/reconciliation concern.

## Tauri and TypeScript integration

The minimal M1 command surface is:

- `agent_v3_list_tools`
- `agent_v3_register_task`
- `agent_v3_authorize_call`
- `agent_v3_revoke_capability`
- `agent_v3_execute_tool`
- `agent_v3_get_task`
- `agent_v3_list_tasks`
- `agent_v3_cancel_task`

TypeScript contains matching invoke helpers and snapshot types. It receives an
opaque capability id and the informational native effect assessment, never an
`allowedTools`, `allowedEffects`, target-claims, or signing-key object.

## Rollout and rollback

`SHELLSPAN_AGENT_V3_ROLLOUT` remains independent of the v2 rollout flag:

| Value | Contract visible | Execution route |
| --- | --- | --- |
| absent or `disabled` | no | v2 |
| `contractOnly` | yes | v2 |
| `runtime` | yes | v3 M1 command surface |
| unknown | no (fail closed) | v2 |

The M1 commands all enforce the rollout policy in Rust. To enable a local M1
run, set the value before starting the application:

```powershell
$env:SHELLSPAN_AGENT_V3_ROLLOUT = 'runtime'
pnpm tauri:dev
```

Rollback is one value plus application restart:

```powershell
$env:SHELLSPAN_AGENT_V3_ROLLOUT = 'disabled'
pnpm tauri:dev
```

The existing v2 executor, v2 history, and M0 compatibility view remain intact.
A `v2Compatibility` request cannot be registered as a resumable v3 task.

## M2 hand-off interfaces

M2 can extend the manifest registry and dispatcher without moving authority to
the WebView. Its file/checkpoint implementation should consume these stable
boundaries:

- `ToolRegistryV3` for manifest metadata and explicit implementation state;
- native effect assessment before capability issuance and again at dispatch;
- `NativeCapabilityStoreV3` exact-call proofs;
- frozen local/remote target revalidation and native credential resolution;
- strict per-tool result validation followed by v3 result correlation;
- `AgentTaskStoreV3` sequencing and result ownership.

M2 still needs native file drivers for the eight unavailable tools it adopts,
path/symlink containment, diff approval, write verification, checkpoints,
artifact storage, and durable restart reconciliation. None of those are
silently implemented through `exec_command` in M1.
