# Deployment Runbook v2 contract

> Status: phase 1 of 5 — contract and validation only.
>
> This phase does **not** download or upload artifacts, create release directories, change symlinks, control services, run health checks, or perform rollback. It registers no Tauri command and adds no generic Shell path.

Deployment Runbook v2 is a semantic, reviewable description of deploying an already-built artifact to an SSH target. It is deliberately separate from the executable command-oriented Runbook v1 contract. The checked-in machine-readable schema is [`protocol/runbook/v2/deployment-runbook.schema.json`](../protocol/runbook/v2/deployment-runbook.schema.json), and a complete document is in [`docs/examples/deployment-runbook-v2.runbook.json`](examples/deployment-runbook-v2.runbook.json).

## Design goals

- Give a deployment and its application, environment, and version stable identities.
- Require content-addressed artifacts and bounded, normalized destinations.
- Model an immutable release directory and one atomic active-symlink swap.
- Describe service changes and post-activation health evidence without embedding Shell.
- Make rollback a complete semantic plan that reactivates the previously captured release, applies the required service actions, and reruns every health check.
- Carry risk, privilege, approval, frozen-target, and secret-reference metadata that a later executor must bind into its authorization decision.
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

`atomicSymlinkSwap` describes the intended activation invariant. A later executor must create and fully validate the new immutable release before atomically replacing the active symlink, and must capture the previous resolved target before the swap. Merely accepting this document does not claim any of those actions occurred.

### Services, verification, and rollback

- Service entries are a semantic systemd catalog. No service field is treated as a command, argument list, environment, working directory, or script.
- Every service action is locally classified as at least `stateChange`; declaring it `readOnly` is rejected. Over-reporting as `destructive` is allowed and raises the document's required approval risk.
- At least one bounded health check is required. HTTP checks accept no headers, credentials, query strings, or fragments; secret-bearing checks must be added later as a separately reviewed capability.
- Rollback action IDs must be distinct from forward action IDs. Rollback service actions must cover exactly the services changed by the forward plan.
- `rollback.verificationCheckIds` must reference every declared health check exactly once. A partial or unverifiable rollback is rejected.
- `reactivatePreviousRelease` is declarative. A future executor must fail closed if the pre-activation symlink target was not captured, is no longer an approved release, or cannot be reactivated atomically. Rollback requires a new, separate approval and is never automatic in this phase.

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

These values are policy requirements, not proof that approval has happened. A later phase must bind approval to the canonical document digest, deployment identity/version, artifact digests, frozen profile identity, derived risk, exact semantic plan, and expiry/replay controls.

Literal secrets are prohibited throughout metadata and URIs. The only secret-bearing shape is an opaque entry such as `keychain://deployment/artifact-download`, referenced by artifact `credentialRef`. Phase 1 only validates and preserves this reference; it does not create storage or resolve the secret. Plaintext values, URL userinfo, query tokens, private-key blocks, and dangling references fail closed.

## v1 compatibility and migration

| Input | Existing v1 parser/executor | v2 parser | Version-dispatch parser |
| --- | --- | --- | --- |
| Valid `schemaVersion: 1` | unchanged and accepted | rejected | returned as v1 |
| Valid deployment `schemaVersion: 2` | rejected before action selection/network access | accepted for validation only | returned as v2 |
| Unknown version/field | rejected | rejected | rejected |

There is no implicit v1-to-v2 migration. V1 commands cannot reliably reveal artifact identity, atomic activation, health evidence, or a complete semantic rollback. Migration is explicit re-authoring: preserve the v1 document for its existing behavior, create a separate v2 deployment document, fill every semantic field, and review the resulting canonical diff. The parsers never guess deployment semantics from Shell text.

The TypeScript version dispatcher is `parseRunbookContractText`; the existing `parseRunbookText`, `prepareRunbook`, multi-host scheduler, and UI remain v1-only. Rust compiles a crate-private v2 parser/serializer, while the production `execute_runbook_step` path continues to call the v1-only parser. Thus a valid v2 document cannot reach SSH through the existing Runbook command.

## Normalization and validation layers

Both implementations enforce the same 512 KiB document bound, trim human-readable strings, canonicalize accepted URIs, rebuild objects in schema order, and serialize as two-space UTF-8 JSON with one trailing newline. Serialization revalidates the typed object so an in-memory risk or reference mutation cannot bypass parsing.

The JSON Schema provides editor-facing structural diagnostics. TypeScript and Rust validators remain authoritative for semantic invariants that JSON Schema does not express cleanly: path ancestry, deployment-ID/release binding, cross-object references, complete rollback coverage, URI credential isolation, duplicate IDs/targets, and derived risk.

Shared fixtures in `tests/fixtures/deployment-runbook/v2/` cover the valid document, unknown top-level and nested fields, invalid artifacts and paths, missing verification, incomplete rollback, risk understatement, literal secrets, dangling secret references, and the v1 compatibility boundary.

## Deferred to later phases

- No artifact transfer, digest verification, unpacking, release retention, or cleanup.
- No remote path mutation or atomic symlink implementation.
- No service control or health-probe execution.
- No credential creation/resolution for `keychain://deployment/...` references.
- No approval issuance, persistence, digest binding, replay prevention, UI, or audit event.
- No deployment state machine, restart recovery, automatic rollback, multi-host scheduling, batch/canary policy, or traffic switching.
- No Docker Compose, Kubernetes, database migration, hooks, scripts, environment injection, or arbitrary Shell escape hatch.

Phase 2 must consume this canonical contract through new semantic reviewed actions; it must not map free-form strings into the existing command executor or reinterpret v1 commands as v2 deployments.
