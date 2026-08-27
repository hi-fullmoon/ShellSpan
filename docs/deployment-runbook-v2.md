# Deployment Runbook v2 contract

> Status: phase 3 of 5 — durable single-host execution and separately reviewed rollback.
>
> This phase can execute one reviewed deployment or one separately reviewed rollback on one frozen SSH target, persist their audit state, and fail closed after restart. It still does **not** schedule multiple hosts, expose generic Shell/SFTP, provide deployment-specific UI, or migrate v1 documents.

Deployment Runbook v2 is a semantic, reviewable description of deploying an already-built artifact to an SSH target. It is deliberately separate from the executable command-oriented Runbook v1 contract. The checked-in machine-readable schema is [`protocol/runbook/v2/deployment-runbook.schema.json`](../protocol/runbook/v2/deployment-runbook.schema.json), and a complete document is in [`docs/examples/deployment-runbook-v2.runbook.json`](examples/deployment-runbook-v2.runbook.json).

## Design goals

- Give a deployment and its application, environment, and version stable identities.
- Require content-addressed artifacts and bounded, normalized destinations.
- Model an immutable release directory and one atomic active-symlink swap.
- Describe service changes and post-activation health evidence without embedding Shell.
- Make rollback a complete semantic plan that reactivates the previously captured release, applies the required service actions, and reruns every health check.
- Carry risk, privilege, approval, frozen-target, and secret-reference metadata that the phase 2 executor binds into its authorization decision.
- Fail closed on unknown versions, fields, enums, references, paths, secret literals, and understated risk in both TypeScript and Rust.

The minimal v2 capability set is intentionally narrow:

| Area | v2 values |
| --- | --- |
| Artifact sources | `https://` without credentials/query/fragment, or local `file://` |
| Artifact kinds | `file`, or `archive` with `tar`, `tarGz`, or `zip` unpack metadata |
| Activation | `atomicSymlinkSwap` only |
| Service manager | `systemd` only |
| Service actions | `start`, `restart`, `reload` |
| Health checks | bounded HTTP status or systemd `active` state |
| Rollback | `reactivatePreviousRelease` only |

Adding a new source, service manager, activation strategy, health-check kind, or rollback strategy requires an explicit schema/validator revision. It must not be inferred from free text.

## Required document shape

```json
{
  "schemaVersion": 2,
  "kind": "deployment",
  "id": "acme-api-production",
  "name": "Deploy Acme API to production",
  "description": "Install and verify one immutable release.",
  "deployment": {
    "id": "acme-api-2.4.0-20260828",
    "applicationId": "acme-api",
    "environment": "production",
    "version": "2.4.0"
  },
  "artifacts": [],
  "release": {},
  "services": [],
  "serviceActions": [],
  "verification": { "checks": [] },
  "rollback": {},
  "security": {}
}
```

The abbreviated arrays and objects above show placement only; the full example contains every required field.

### Identity and artifacts

- The top-level `id` identifies the reusable Runbook definition. `deployment.id` identifies one immutable release attempt and must be the final component of `release.releaseDirectory`.
- `applicationId`, `environment`, and `version` are separate so later policy can bind approvals to the exact application/environment/version tuple.
- Every artifact requires a lowercase SHA-256 digest. `sizeBytes` is an optional declared upper-bound check for a later downloader.
- `targetPath` and archive `destinationPath` are relative to the new release directory. They cannot be absolute, traverse with `..`, contain backslashes, or use unbounded/ambiguous path syntax.
- Archive artifacts require explicit unpack format and `stripComponents`. File artifacts cannot carry unpack metadata.

### Release and atomic activation

`rootDirectory`, `releasesDirectory`, `releaseDirectory`, and `activeSymlink` are normalized absolute POSIX paths. The validators require:

```text
rootDirectory
├── releasesDirectory
│   └── releaseDirectory (basename == deployment.id)
└── activeSymlink (outside releasesDirectory)
```

`atomicSymlinkSwap` describes the activation invariant. The phase 2 executor creates and validates the new release before atomically replacing the active symlink. Immediately before the swap it rechecks the link, captures the previous resolved release when it is safe and inside `releasesDirectory`, and records that value in the rollback snapshot. Accepting or reviewing a document does not claim any action occurred.

### Services, verification, and rollback

- Service entries are a semantic systemd catalog. No service field is treated as a command, argument list, environment, working directory, or script.
- Every service action is locally classified as at least `stateChange`; declaring it `readOnly` is rejected. Over-reporting as `destructive` is allowed and raises the document's required approval risk.
- At least one bounded health check is required. HTTP checks accept no headers, credentials, query strings, or fragments; secret-bearing checks must be added later as a separately reviewed capability.
- Rollback action IDs must be distinct from forward action IDs. Rollback service actions must cover exactly the services changed by the forward plan.
- `rollback.verificationCheckIds` must reference every declared health check exactly once. A partial or unverifiable rollback is rejected.
- `reactivatePreviousRelease` is executable only through phase 3's separate rollback boundary. The rollback review accepts a source operation ID, not paths or actions, and derives current/previous release identities, service actions, health checks, risk, target, and document/plan digests from a persisted activation snapshot. Missing, consumed, inconsistent, or unsafe snapshots fail closed. Rollback requires a new approval and is never automatic or recursive.

### Security and approval metadata

`security.declaredRisk` must be at least the locally detected risk. Deployment always has a `stateChange` floor because it stages files and changes activation state. Service and rollback action risks can raise that floor; the parser never lowers it based on author claims.

The approval object is fixed in v2:

```json
{
  "deployment": "explicit",
  "rollback": "separate",
  "destructive": "doubleConfirmation",
  "targetBinding": "frozenProfile"
}
```

These values are policy requirements, not proof that approval has happened. `review_deployment_execution` reparses and normalizes the document in Rust, freezes the profile/host/port/username/auth/jump identity, and returns the canonical document digest, deployment identity/version, artifact digests, derived risk, bounded policy, and exact semantic action plan. The resulting plan digest and target digest are copied into an explicit approval. `execute_deployment` consumes the persisted review once in the same SQLite transaction that creates the operation and approval-consumption record, rejects expiry/replay or any approval/document/target mismatch, reparses the submitted document again, and revalidates the current profile before network access.

Literal secrets are prohibited throughout metadata and URIs. Artifact `credentialRef` names an entry in `security.secretRefs`; that entry maps the document-local ID to an opaque value such as `keychain://deployment/artifact-download`. For HTTPS preparation the Rust boundary resolves the mapped deployment-keychain account and sends it only as a bearer credential; redirects, URL credentials, query tokens, fragments, response error bodies, and newline-bearing values fail closed. The temporary keychain string buffer is zeroized after building the request header, and secrets are never returned. Connection authentication continues to use the existing reviewed SSH credential boundary. The phase does not add credential creation UI or plaintext fallback.

## Phase 2/3 single-host deployment execution

The frontend boundary is deliberately small: request a review, construct an approval from that review, execute it once, or cancel that operation. The backend state machine is:

```text
pending → preparingArtifacts → inspectingTarget → creatingRelease
        → stagingArtifacts → activatingRelease → applyingServices
        → verifying → succeeded
```

Every non-terminal state can safely stop as `failed`, `cancelled`, or `timedOut`; identity-sensitive states can also stop as `identityMismatch`, and the initial approval gate can stop as `unauthorized`. Terminal and late results cannot advance the TypeScript projection.

Each reviewed action binds an action ID, semantic kind, target, canonical parameters and parameter digest, risk, mutation flag, timeout, child operation identity, and the frozen target. The implementation has fixed command templates only for release inspection/creation, atomic activation, controlled `systemctl start|restart|reload`, HTTP status probes, and `systemctl is-active`. It uses `sudo -n` only when the document explicitly requires privilege escalation and never accepts a caller-provided command or arbitrary remote path.

Artifact preparation happens locally before remote mutation. `file://` and non-redirecting HTTPS sources are streamed into a private temporary directory with cancellation, timeout, byte limits, and SHA-256 verification. Tar, tar.gz, and zip extraction rejects absolute/traversing paths, links, special entries, excess files, and excess expanded bytes. SFTP then creates only reviewed release-relative parents, rejects existing symlinks or non-directory ancestors, uploads through an exclusive temporary name with bounded chunks, verifies size, and renames into place. The release directory must not already exist. The active link is replaced with a same-directory temporary symlink and atomic rename after a final safety inspection.

Health checks are declarative: HTTP checks compare an exact status code and service checks compare the expected systemd state. Attempts, intervals, per-action timeouts, total timeout, captured output, and total bytes read are bounded. A failed check stops the deployment and returns structured action, health, error, and rollback-snapshot data; no failure path performs an implicit rollback. Phase 3 checkpoints reviewed actions and health evidence before advancing, and persists the activation change immediately after the atomic link swap.

## Phase 3 rollback boundary

Rollback exposes three commands that are intentionally distinct from deployment:

- `review_rollback_execution` accepts only a new operation ID, a persisted source deployment operation ID, the exact profile/connection used to revalidate the frozen target, and a bounded total timeout. It accepts no Runbook text, release path, command, service action, or health check.
- `execute_rollback` consumes that rollback review once. Its approval binds the source operation, document/plan/target digests, current and previous release paths, risk, authorization, and destructive confirmation.
- `cancel_rollback` can cancel only the matching active rollback operation. Forward deployment cancellation cannot cancel rollback and vice versa.

At execution time the backend reloads the source snapshot and canonical Runbook, proves the snapshot is still unconsumed, revalidates the profile identity, and recomputes the entire semantic plan. A fixed read-only script then requires `activeSymlink` to resolve to the reviewed new release and requires both release directories to be real directories rather than symlinks. The mutating script repeats those checks and performs a same-directory temporary-symlink plus `mv -Tf` activation. Only the Runbook's rollback `systemd start|restart|reload` actions run, followed by exactly the declared rollback verification checks.

If activation, a service action, or a health check fails, execution stops and preserves every durable partial action and reactivation result. It never launches another rollback. Snapshot use is exclusive: failure before activation releases the reservation for a new review, activation consumes the snapshot even if a later service or health check fails, and restart recovery permits only a newly reviewed takeover that first reinspects remote state.

## Persistence and crash recovery

Phase 3 stores canonical, secret-free review material and execution state in an additive `deployment_schema_version` namespace. The primary application schema remains v5: phase-2 binaries can open the database and ignore the new tables. Deployment schema v1 creates separate tables for reviews, operations, action results, health evidence, rollback snapshots, approval consumptions, release records, and review-to-release references; additive v2 adds exclusive rollback-snapshot reservations. Review consumption, snapshot reservation, operation creation, and approval consumption commit in one transaction.

Connection requests, passwords, passphrases, private-key data, resolved keychain values, stdout, and stderr are never persisted by this subsystem. The canonical Runbook may retain opaque `keychain://deployment/...` references, never resolved values. Persisted action rows omit output and store bounded semantic status/evidence only.

On startup, every non-terminal deployment or rollback operation is atomically sealed as `interrupted`, `terminal=true`, and `recoveryRequired=true`. It is not replayed. Its execution token is invalidated, so a late worker result cannot overwrite recovery or any terminal state. Read-only `list_deployment_operations` and `get_deployment_operation` return authoritative operation/review/action/health state. Recovery requires a fresh deployment review, or—when an activation snapshot was durably captured—a fresh rollback review.

## Release retention and cleanup semantics

`list_deployment_release_cleanup_candidates` is conservative. A release appears only when it was health-verified, is not current, is not an unconsumed rollback target, has no pending review or active operation reference, and its target has no active or recovery-required operation. `review_deployment_release_cleanup` revalidates the candidate and frozen profile and freezes one destructive `removeRelease` semantic action by candidate ID. Phase 3 deliberately reports `executableInPhase: false`: it does not delete the release, run background garbage collection, or expose a generic removal command.

## v1 compatibility and migration

| Input | Existing v1 parser/executor | v2 parser | Version-dispatch parser |
| --- | --- | --- | --- |
| Valid `schemaVersion: 1` | unchanged and accepted | rejected | returned as v1 |
| Valid deployment `schemaVersion: 2` | rejected before action selection/network access | accepted | returned as v2 |
| Unknown version/field | rejected | rejected | rejected |

There is no implicit v1-to-v2 migration. V1 commands cannot reliably reveal artifact identity, atomic activation, health evidence, or a complete semantic rollback. Migration is explicit re-authoring: preserve the v1 document for its existing behavior, create a separate v2 deployment document, fill every semantic field, and review the resulting canonical diff. The parsers never guess deployment semantics from Shell text.

The TypeScript version dispatcher is `parseRunbookContractText`; the existing `parseRunbookText`, `prepareRunbook`, multi-host scheduler, and editor UI remain v1-only. Rust keeps `execute_runbook_step` on the v1-only parser. V2 reaches SSH/SFTP only through the separate `review_deployment_execution` and `execute_deployment` semantic path, so it cannot be reinterpreted as a v1 command.

## Normalization and validation layers

Both implementations enforce the same 512 KiB document bound, trim human-readable strings, canonicalize accepted URIs, rebuild objects in schema order, and serialize as two-space UTF-8 JSON with one trailing newline. Serialization revalidates the typed object so an in-memory risk or reference mutation cannot bypass parsing.

The JSON Schema provides editor-facing structural diagnostics. TypeScript and Rust validators remain authoritative for semantic invariants that JSON Schema does not express cleanly: path ancestry, deployment-ID/release binding, cross-object references, complete rollback coverage, URI credential isolation, duplicate IDs/targets, and derived risk.

Shared fixtures in `tests/fixtures/deployment-runbook/v2/` cover the valid document, unknown top-level and nested fields, invalid artifacts and paths, missing verification, incomplete rollback, risk understatement, literal secrets, dangling secret references, the v1 compatibility boundary, bounded phase 2 execution, and phase 3 rollback/recovery/cleanup protections.

## Phase 4 multi-host canary and rolling coordination

Phase 4 adds a separate rollout contract; it does not make the v1 tag scheduler accept deployment documents. `review_deployment_rollout` accepts only an explicit ordered `profileIds` list and an exactly aligned target/connection list. Rust reloads every profile and freezes profile ID, host, port, username, authentication method, and jump-host identity through the phase 2 review boundary. Duplicate profiles, duplicate host/port/username tuples, reordered targets, unknown fields, empty batches, mixed target/Runbook environments, dynamic discovery, and tag-derived membership fail before rollout state is created.

The only strategy is `canaryRolling`. Canary size is one explicit count or percentage; the remaining immutable order is sliced by `batchSize`. `maxParallel` is bounded by the batch size, every batch requires a manual approval, and every approval binds rollout ID, rollout review, rollout plan digest, batch index/digest, plus the independent phase 2 approval for every unfinished target. Batch membership, order, health requirement, failure maximum, target identities, and child plans are included in the rollout digest. Execution never reorders or substitutes a target.

The coordinator never renders Shell or performs SFTP. Each host calls the crate-private phase 2 deployment executor with a distinct review, approval consumption, operation ID, connection object, cancellation flag, result identity, and phase 3 operation record. Connections and credentials are passed only to that call and are never written to rollout tables. Parallel work runs in waves no larger than `maxParallel`.

Canary failure, health or failure threshold breach, target/plan drift, expired or mismatched approval, recovery ambiguity, and late/cross-batch result identity open the rollout circuit and prevent another batch. Successful hosts are not rolled back. When policy requests it, the detail API derives a set of successful source operation IDs marked `requiresSeparateApproval: true`; callers must use the existing phase 3 rollback review separately for each target. The coordinator never invokes rollback itself.

The narrow non-UI IPC surface is `review_deployment_rollout`, `start_deployment_rollout`, `approve_next_deployment_rollout_batch`, `cancel_deployment_rollout`, `list_deployment_rollouts`, `get_deployment_rollout`, and `recover_deployment_rollout`. TypeScript helpers construct exact batch approvals and reject backend results unless rollout/review/plan/batch/target identities all match.

Deployment schema v3 adds rollout review, rollout, batch, target, and batch-approval-consumption tables. On restart, running child deployment operations are sealed by phase 3; running rollout targets become `interrupted + recoveryRequired`, untouched targets stay `notStarted`, and the rollout becomes `recoveryRequired` with an open circuit. Nothing resumes automatically. Recovery requires a fresh review with the same document, policy, deployment policy, target identity, order, environment, and batch digests. Succeeded targets carry their original operation and receive neither a new child review nor a new connection/execution slot.

## Phase 4 limits and later phases

- Active cancellation flags remain process-memory only; durable state records the interruption but cannot prove a blocking remote process stopped. No operation is resumed automatically.
- The existing operation-history projection records deployment and rollback invocation identity, and the deployment database stores detailed semantic checkpoints. Phase 3 adds no dedicated deployment editor or live progress UI.
- Cancellation is checked between artifact/archive/SFTP chunks and between semantic actions. A currently blocking connection/SFTP library call may observe cancellation only when that call or its connection timeout returns.
- No automatic rollback, recursive rollback, cleanup execution, or background garbage collection. Cleanup remains a reviewed, non-executable disposition.
- Multi-host coordination is limited to explicit local canary/rolling batches. There is no dynamic discovery, tag membership, traffic switching, load-balancer integration, or remote orchestrator.
- No Docker Compose, Kubernetes, database migration, hooks, scripts, environment injection, or arbitrary Shell escape hatch.

Phase 5 may add a dedicated deployment UI and templates around these APIs. It must not weaken target/approval binding, add unattended rollback, or reinterpret `recoveryRequired` as permission to replay.
