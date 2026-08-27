# Deployment Runbook v2 contract

> Status: phase 2 of 5 — reviewed single-host semantic execution.
>
> This phase can execute one reviewed deployment on one frozen SSH target. It still does **not** execute rollback, schedule multiple hosts, expose generic Shell/SFTP, or migrate v1 documents.

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
- `reactivatePreviousRelease` remains declarative. Phase 2 records the previous release and whether activation changed, but does not reactivate it. Phase 3 must fail closed if the captured target is absent, is no longer an approved release, or cannot be reactivated atomically. Rollback requires a new, separate approval and is never automatic.

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

These values are policy requirements, not proof that approval has happened. `review_deployment_execution` reparses and normalizes the document in Rust, freezes the profile/host/port/username/auth/jump identity, and returns the canonical document digest, deployment identity/version, artifact digests, derived risk, bounded policy, and exact semantic action plan. The resulting plan digest and target digest are copied into an explicit approval. `execute_deployment` consumes that backend-held review once, rejects expiry/replay or any approval/document/target mismatch, reparses the submitted document again, and revalidates the current profile before network access.

Literal secrets are prohibited throughout metadata and URIs. Artifact `credentialRef` names an entry in `security.secretRefs`; that entry maps the document-local ID to an opaque value such as `keychain://deployment/artifact-download`. For HTTPS preparation the Rust boundary resolves the mapped deployment-keychain account and sends it only as a bearer credential; redirects, URL credentials, query tokens, fragments, response error bodies, and newline-bearing values fail closed. The temporary keychain string buffer is zeroized after building the request header, and secrets are never returned. Connection authentication continues to use the existing reviewed SSH credential boundary. The phase does not add credential creation UI or plaintext fallback.

## Phase 2 single-host execution

The frontend boundary is deliberately small: request a review, construct an approval from that review, execute it once, or cancel that operation. The backend state machine is:

```text
pending → preparingArtifacts → inspectingTarget → creatingRelease
        → stagingArtifacts → activatingRelease → applyingServices
        → verifying → succeeded
```

Every non-terminal state can safely stop as `failed`, `cancelled`, or `timedOut`; identity-sensitive states can also stop as `identityMismatch`, and the initial approval gate can stop as `unauthorized`. Terminal and late results cannot advance the TypeScript projection.

Each reviewed action binds an action ID, semantic kind, target, canonical parameters and parameter digest, risk, mutation flag, timeout, child operation identity, and the frozen target. The implementation has fixed command templates only for release inspection/creation, atomic activation, controlled `systemctl start|restart|reload`, HTTP status probes, and `systemctl is-active`. It uses `sudo -n` only when the document explicitly requires privilege escalation and never accepts a caller-provided command or arbitrary remote path.

Artifact preparation happens locally before remote mutation. `file://` and non-redirecting HTTPS sources are streamed into a private temporary directory with cancellation, timeout, byte limits, and SHA-256 verification. Tar, tar.gz, and zip extraction rejects absolute/traversing paths, links, special entries, excess files, and excess expanded bytes. SFTP then creates only reviewed release-relative parents, rejects existing symlinks or non-directory ancestors, uploads through an exclusive temporary name with bounded chunks, verifies size, and renames into place. The release directory must not already exist. The active link is replaced with a same-directory temporary symlink and atomic rename after a final safety inspection.

Health checks are declarative: HTTP checks compare an exact status code and service checks compare the expected systemd state. Attempts, intervals, per-action timeouts, total timeout, captured output, and total bytes read are bounded. A failed check stops the deployment and returns structured action, health, error, and rollback-snapshot data; phase 2 never performs an implicit rollback.

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

Shared fixtures in `tests/fixtures/deployment-runbook/v2/` cover the valid document, unknown top-level and nested fields, invalid artifacts and paths, missing verification, incomplete rollback, risk understatement, literal secrets, dangling secret references, the v1 compatibility boundary, and the bounded phase 2 execution contract.

## Phase 2 limits and later phases

- Reviews, replay guards, active cancellation flags, and execution state are process-memory only. Application restart/crash recovery and durable execution resumption are deferred.
- The existing operation-history projection records the deployment operation and terminal identity, but phase 2 adds no dedicated deployment editor or live progress UI.
- Cancellation is checked between artifact/archive/SFTP chunks and between semantic actions. A currently blocking connection/SFTP library call may observe cancellation only when that call or its connection timeout returns.
- No rollback execution, automatic rollback, release retention/cleanup, or garbage collection. Phase 2 preserves only the previous release and activation snapshot required by phase 3.
- No multi-host scheduling, batch/canary policy, traffic switching, or cross-host coordination.
- No Docker Compose, Kubernetes, database migration, hooks, scripts, environment injection, or arbitrary Shell escape hatch.

Phase 3 must consume the preserved rollback snapshot through a new, separately reviewed rollback plan. It must not reuse the forward approval or add automatic rollback as a shortcut.
