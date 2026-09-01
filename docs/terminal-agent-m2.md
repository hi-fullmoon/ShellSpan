# Terminal Agent enhancement M2 file, plan, and checkpoint runtime

M2 extends the opt-in Agent Contract v3 runtime from M1. It does not replace
Agent v2, add an Agent model loop, implement host snapshots, or enter the M3
context/MCP/Skills/Hooks/Runbook scope. Rust remains authoritative for target
identity, authorization, file effects, task plans, result validation, and
checkpoint recovery.

## Delivered tool surface

The manifest still exposes the original 12 registered names. Implementation
state is now:

| State | Tools |
| --- | --- |
| executable | `exec_command`, `wait_process`, `write_stdin`, `kill_process`, `read_file`, `list_directory`, `search_text`, `apply_patch`, `transfer_file`, `update_plan` |
| known but unavailable | `host_snapshot`, `ask_user` |

`ask_user` remains unavailable because M2 approval is already collected by a
native dialog and the plan state machine does not require a separate pending
question lifecycle. Returning a fabricated answer would move authority into
the WebView, so unknown, unimplemented, and unsupported calls continue to fail
closed. `host_snapshot` is an explicit later-stage tool and has no M2 stub.

No file tool invokes `exec_command`, a shell, `scp`, or a command-line SFTP
client. Local files use Rust filesystem APIs. Remote files use the existing
known-host-verified `ssh2` SFTP connection and credentials resolved inside
Rust.

## Native path and result boundary

Local file tools require a frozen local target `cwd`, which is their filesystem
root. Remote file tools require `rootPath`; native transfer additionally
requires `localRoot`. The two optional remote target fields preserve M0/M1
deserialization while M2 refuses a file call when its required root is absent.

Before access, Rust:

1. rejects control characters, parent traversal, wrong separator forms, and
   paths outside the frozen root;
2. canonicalizes the root and existing target or destination parent;
3. walks path components with `symlink_metadata`/SFTP `lstat` and rejects
   symlinks rather than following them;
4. repeats containment, type, digest, and destination checks immediately
   before replacement;
5. rejects a cursor when the directory/search snapshot digest has changed.

Reads are bounded to 1 MiB of returned content and 64 MiB of inspected file
content. Base64 slices are reduced so encoded output remains inside the
manifest output limit. Directory and search pages are sorted, cursor-bound,
and serialized-size bounded. Recursive search skips symlinks, caps files and
bytes, marks binary files, and returns explicit `sensitive` and `untrusted`
metadata for path/content results.

## Exact patch authorization and verification

`apply_patch` accepts one UTF-8 unified diff and one matching path/SHA-256
precondition per call. One file per capability keeps target and recovery
ownership unambiguous. At preview/authorization time Rust reads the bound file,
checks its digest, applies the diff in memory, and regenerates the canonical
exact diff shown by the native approval prompt and the TypeScript diff card.

At dispatch the capability is reverified and consumed, then the same digest and
diff computation is repeated. A non-dry-run write creates a checkpoint before
using a same-directory private temporary file plus atomic replacement. Remote
replacement stages an exclusive SFTP temporary file, verifies it, preserves
permissions, moves an existing target to a temporary backup, performs an
atomic/native rename, and restores the backup when finalization fails. Rust
then re-reads the target and requires exact content and SHA-256 equality before
committing a completed result.

## Native SFTP transfer

`transfer_file` supports local-to-remote upload and remote-to-local download.
It requires an expected source SHA-256 and applies a native size limit. An
existing destination requires `overwrite: true` and a matching
`destinationSha256`; absence, appearance, disappearance, and digest drift are
conflicts. Transfer loops observe the task cancellation flag. Both directions
stage writes, checkpoint the destination before replacement, and re-read the
destination to verify its final digest. Profile passwords, private keys, and
passphrases remain in the Rust credential resolver and never enter WebView IPC,
tool results, or checkpoint metadata.

The dedicated `test:e2e:ssh:agent-m2` gate starts the repository's isolated
OpenSSH/SFTP containers and verifies upload, remote read, conflict rejection,
digest-bound overwrite, download, remote patch, and remote checkpoint restore
through the M2 runtime before removing the containers and volumes. Unit tests
separately cover native path/cursor bounds and deterministic cancellation.
Success against arbitrary production servers is not inferred from that
controlled fixture; it still depends on the server's SFTP rename semantics,
host-key state, permissions, and operator-provided credentials.

## Checkpoints and restore

Local and remote overwrites save the original bytes, SHA-256, size, metadata,
target id, target kind, and exact path under the private application-data
checkpoint directory. A created destination records a missing original so
restore deletes the created file. The store is limited to 128 records,
128 MiB total, 64 MiB per recovery copy, and seven days; expired and oldest
records are removed under the store lock.

Task snapshots expose bounded checkpoint metadata, never backup contents. The
`agent_v3_restore_checkpoint` command reloads the recovery copy, verifies its
own digest, revalidates the frozen live target, shows the exact restore target
and before/after digests in a native confirmation dialog, rejects post-approval
drift, restores content and metadata, and verifies the restored digest before
marking the checkpoint restored. The M2 task surface provides the actual
restore button. Automated Rust coverage exercises write, verification,
checkpoint persistence, native restore, and final content verification.

## Rust-authoritative plan

Every plan step now contains:

- description and dependency ids;
- frozen target ids and required registered tools;
- expected effect;
- success criteria and rollback/compensation text;
- pending, in-progress, completed, or blocked status;
- native result evidence references.

`planVersion` is an optimistic concurrency precondition. Rust increments the
accepted version and rejects duplicate/cyclic/missing dependencies,
self-dependencies, targets outside the task, unavailable tools, incompatible
tool/target pairs, effects outside the required tool set, and in-progress or
completed steps whose dependencies are incomplete. A completed step needs a
completed result owned by the same task and at least one read/sensitive-read
verification effect or an internally verified patch/transfer result. A prior
plan update or another effect-free result cannot serve as completion evidence.

The native task target is appended by Rust at registration, so the WebView
cannot invent plan authority. Task snapshots include the current plan and
monotonic sequence.

## Tauri and TypeScript surface

M1 commands remain compatible. M2 adds:

- `agent_v3_preview_call` for a non-authoritative UI preview that is recomputed
  by Rust during native authorization;
- `agent_v3_restore_checkpoint` for approved, drift-checked recovery;
- task snapshot `plan` and `checkpoints` fields;
- reusable exact Diff approval, plan, and checkpoint/restore React surfaces.

All commands enforce the existing independent `SHELLSPAN_AGENT_V3_ROLLOUT`
`runtime` stage. The variable remains absent/disabled by default, unknown
values fail closed, and setting it to `disabled` plus restarting restores the
v2-only route in one step.

## M3 hand-off only

M3 may consume the M2 result, plan, checkpoint, and preview types as context
sources. M2 does not load instruction files, persist model context, discover
MCP tools, run Skills/Hooks/Runbooks, create a full background task center, or
claim restart reconciliation. Those interfaces remain deliberately outside
this milestone.
