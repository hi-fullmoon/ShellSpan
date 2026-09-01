# Terminal Agent enhancement M5 Fleet and multi-Agent orchestration

M5 adds a Rust-authoritative Fleet controller to the opt-in Agent Contract v3
runtime. It freezes host-group selections, schedules canary and bounded batch
waves, exposes an honest per-target result matrix, isolates sub-Agent roles,
and requires independent native verification before a host can be marked
successful.

M5 does not replace Agent v2, enable v3 by default, or weaken any M0–M4
target, capability, checkpoint, broker, egress, sensitive-path, audit, or
restart boundary. Fleet has a separate default-off rollout switch.

## Architecture and authority

Fleet composes existing single-host v3 tasks rather than turning one task into
an ambiguous multi-host request. Every Fleet member therefore retains its own:

- frozen local or remote target and connected session identity;
- Rust-accepted plan and plan version;
- exact native capability, call digest, and single-use budget;
- Operator, broker, egress, sensitive-path, checkpoint, audit, and recovery
  enforcement;
- correlated native tool result.

Registration accepts task/target references plus non-secret display metadata,
labels, group, and environment. Rust re-reads each task, rejects inactive or
unbound tasks, revalidates the live target identity, and derives the allowed
tool/effect scope from its accepted plan. The selected members are sorted by
target id, assigned to waves, and hashed into a stable SHA-256 snapshot.

The ordinary `agent_v3_execute_tool` path remains the single-host path. Once a
non-terminal Fleet owns a task, direct dispatch is rejected; the call must use
`agent_v3_execute_fleet_tool`. The Fleet path then delegates to the same native
execution implementation used by M0–M4. It does not add a shell, file, SSH,
credential, or approval bypass.

Immediately before every Fleet dispatch Rust rechecks:

1. the Fleet, target, current wave, failure threshold, and call budgets;
2. the opaque sub-Agent id, role, exact target/tool/effect subset, and active
   status;
3. the current parent task plan version against the registration snapshot;
4. the natively classified effect and path-conflict scope;
5. the ordinary M0–M4 frozen request, live session/profile identity, capability
   proof, Operator source, broker grant, egress/sensitive-path policy,
   checkpoint journal, execution driver, and result correlation.

A changed parent plan invalidates dispatch. A capability obtained from the
ordinary authorization command is still insufficient to bypass the Fleet
boundary.

## Host groups, selector snapshot, and rollout waves

`RegisterFleetRequestV3` supports exact-match selectors for:

- label key/value pairs;
- host groups;
- environments.

The native bounds are 64 Fleet records, 256 selected targets per Fleet, 16
labels per member, 32 groups/environments per selector, 32 concurrent calls,
64 targets per batch, 4,096 calls per Fleet, and 30 seconds of deterministic
maximum jitter. Each target also has a separate call budget.

The scheduling policy contains `maxConcurrency`, `batchSize`, `canarySize`,
`maxFailures`, `jitterMs`, `maxCallsTotal`, and `maxCallsPerTarget`.

If any selected plan includes a state-changing, destructive, or external
effect, `canarySize` must be non-zero. Only the canary wave is dispatchable
until every canary target has independent verification evidence. A canary
failure always fail-stops expansion. Later waves advance only when every host
in the current wave has a terminal, explicit native state and the configured
failure threshold has not been exceeded.

Read-only Fleets use bounded batches without requiring a write canary, but
they still require independent verification before success. Jitter is derived
from the call id within the configured maximum, so the model or WebView cannot
select a privileged scheduling path.

## Result matrix and failure semantics

Rust returns an `AgentFleetSnapshotV3` containing every selected target. Each
row includes its task and target ids, display metadata, wave, frozen plan
version, allowed scope, calls used, last call, writer, verifier, evidence,
failure, and rollback checkpoint.

Target states are:

| State | Meaning |
| --- | --- |
| `pending` / `canary` | frozen but not dispatched; canary is the required first write wave |
| `running` | a natively bounded call is active |
| `awaitingVerification` | native execution completed but success is not yet proven |
| `succeeded` | an independent Verifier submitted a completed native read result |
| `failed` | execution or verification failed; the error remains on this row |
| `blocked` | never started because canary or failure threshold stopped expansion |
| `needsReconciliation` | a call was in flight at restart; inspect without replay |
| `rolledBack` | the exact target's restored native checkpoint was recorded |

Fleet-level `completedWithFailures` is distinct from `completed`. Failure
count and target rows remain present. The UI renders the Rust matrix using the
existing shadcn `Card`, `Table`, `Badge`, and `Alert` components. It never
derives a success state from counts, model text, or missing rows.

## Sub-Agent isolation and verification

M5 defines Explorer, Diagnostician, Operator, Verifier, and Reviewer roles.
Registration produces an opaque Rust id with exact target ids, tools, effects,
and a call budget. Every field must be a subset of every selected parent plan
scope. Explorer, Diagnostician, Verifier, and Reviewer are read-only roles;
Rust rejects any write effect assigned to or attempted by them.

Operator is not a replacement for M4 Operator permission. A Fleet Operator
call still needs the ordinary exact native authorization, and any M4 Operator
grant is independently checked at authorization and dispatch.

Execution completion only moves a host to `awaitingVerification`. To mark it
`succeeded`, an active Verifier must:

- be registered for that exact target and read tool/effect;
- execute through the Fleet boundary;
- reference its own completed native read call id;
- be different from the last writer;
- submit an explicit success/failure summary.

Model prose, an Operator result, a fabricated call id, a failed read, a write
effect, or a writer verifying itself cannot complete a target. Calls made
after a write is awaiting verification are limited to the Verifier role.

Same-target overlapping writes are serialized using the native path scope.
Empty or unknown path scopes conflict conservatively. Fleet, sub-Agent, and
per-target call budgets, plus the global concurrency bound, are checked before
the ordinary capability is consumed.

## Persistence and restart reconciliation

Fleet state is stored separately at `agent-m5/fleets-v1.json` under the
application-data directory. The version-1 envelope is bounded to 2 MiB and is
written through a staged file with flush and atomic persistence. It contains
the sanitized Fleet snapshot, opaque role metadata, active-call correlation,
and bounded native call evidence. It does not contain tool arguments, output,
artifacts, capability material, broker grants, credential references/values,
or exact conflict paths.

Goals, display metadata, verification summaries, and errors pass through the
shared native secret redactor before persistence. Exact paths are process-only
and skipped by serialization.

On restart:

- all sub-Agent registrations become inactive and must be registered again;
- any in-flight target becomes `needsReconciliation`;
- active calls and conflict locks are discarded;
- the target records that the uncertain effect will not be replayed;
- a human must move the target to independent verification or mark it failed.

Known `awaitingVerification` state remains evidence work, not an instruction
to repeat the write. M0–M4 capabilities, Operator grants, broker grants, and
process handles continue to follow their existing non-restoration rules.

## Rollback

File changes and transfers continue to create M2 native checkpoints before
mutation. Per-target rollback is a two-step native workflow:

1. restore the checkpoint through the existing native checkpoint command,
   including policy, drift, digest, identity, and root revalidation;
2. call `agent_v3_record_fleet_rollback` with the Fleet, target, and checkpoint
   id.

Rust accepts the matrix update only if that checkpoint belongs to the exact
member task and target and already has a native `restoredAtUnixMs`. The UI then
shows the row as restored. Commands without a file checkpoint retain the
parent plan's required compensation text; M5 does not claim an automatic
inverse for arbitrary shell or external side effects.

## Feature rollout and rollback

Agent v2 remains authoritative by default. Fleet requires both the v3 runtime
and its own explicit switch:

~~~sh
export SHELLSPAN_AGENT_V3_ROLLOUT=runtime
export SHELLSPAN_AGENT_FLEET=enabled
pnpm tauri:dev
~~~

`SHELLSPAN_AGENT_FLEET` accepts only `enabled` or `disabled`; absence means
disabled and unknown values fail closed. MCP and M4 Operator remain separately
controlled and are not enabled by Fleet.

To stop new Fleet registration and dispatch while retaining inspectable state:

~~~sh
export SHELLSPAN_AGENT_FLEET=disabled
pnpm tauri:dev
~~~

Listing, reconciliation, and verified rollback metadata remain available so
an operator can safely inspect or close existing work. To return command
routing fully to v2, also disable the v3 rollout as documented in M0 and M4.
The `agent-m5` directory should be archived while ShellSpan is stopped before
any manual deletion.

## Typed IPC and UI

M5 adds typed commands for Fleet policy, registration, role registration,
list/get, Fleet dispatch, verification, reconciliation, and verified rollback.
All mutating commands configure the same Rust runtime root and enforce the v3
rollout; registration, role creation, dispatch, and completion additionally
enforce the independent Fleet switch.

The result matrix is read-only. Creation and execution remain API-driven so
the model cannot manufacture a host status in React state. Existing M2/M4
surfaces retain checkpoint restore, task recovery, native approval, and
Operator controls for each member task.

## Verification evidence

The M5 completion review ran on macOS with Rust 1.95 on 2026-09-01.

| Command | Result |
| --- | --- |
| `CI=true pnpm test:agent:m5` | 2 files, 3 tests passed |
| `CI=true pnpm test:agent:contract-v3` | 1 file, 5 tests passed |
| `CI=true pnpm test:agent:m4` | 3 files, 10 tests passed |
| `CI=true pnpm test:agent:security` | 8 files, 311 tests passed |
| `CI=true pnpm exec tsc --noEmit` | passed |
| `CI=true pnpm build` | passed; only the existing chunk-size advisory was emitted |
| `cargo +1.95.0 test --manifest-path src-tauri/Cargo.toml --locked agent_runtime_v3::m5::tests --no-fail-fast` | 4 passed |
| `cargo +1.95.0 test --manifest-path src-tauri/Cargo.toml --locked fleet_runtime_blocks_direct_bypass_and_requires_independent_verifier_evidence --no-fail-fast` | 1 passed |
| `cargo +1.95.0 test --manifest-path src-tauri/Cargo.toml --locked agent_runtime_v3 --no-fail-fast` | 50 passed, 1 pre-existing Docker SSH/SFTP fixture ignored |
| `cargo +1.95.0 clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings` | passed |
| `cargo +1.95.0 fmt --manifest-path src-tauri/Cargo.toml --all -- --check` | passed |
| `git diff --check` | passed |

The Rust M5 tests cover stable selector/wave construction, mandatory write
canary, fail-stop with visible blocked hosts, role subset enforcement,
independent verification, sanitized restart reconciliation without replay,
and the integrated native runtime. The integration test proves a valid
single-call capability cannot use the ordinary dispatch API after its task is
Fleet-controlled and succeeds only through its registered role and independent
Verifier evidence.

## Known limits and final acceptance hand-off

- Fleet composes already registered single-host tasks. It does not import an
  external inventory or create SSH sessions on behalf of a selector.
- The current UI is a native result matrix; Fleet construction, role lifecycle,
  and dispatch are typed IPC surfaces rather than a general-purpose visual
  automation editor.
- M5 does not persist active sub-Agent authority, capabilities, credentials,
  exact paths, or process handles across restart.
- The existing isolated Docker SSH/SFTP test remains opt-in and was not run in
  this local verification pass.
- Packaging, cross-platform migration, full regression, and
  requirement-by-requirement closure belong to the separate final acceptance
  phase.

The next task must run the final acceptance pass in a separate Codex task
window and must not expand M5 scope while auditing it.
