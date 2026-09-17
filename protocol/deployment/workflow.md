# Deployment Workflow Protocol

> Status: Phase 6 production contract  
> Wire format: UTF-8 JSON  
> Authority: Rust native validator and compiler  
> Compatibility: one current protocol only; legacy conversion, migration, and mixed graphs are out of scope

## 1. Security and execution boundary

Deployment Workflow is a closed deployment-domain DAG protocol. A workflow may only reference a node type and exact version registered by the native runtime. Workflow JSON never contains a shell, command template, executable, argv, interpreter, credential value, private key, token, or user-provided executor.

The frontend may use the native node catalog for editing hints, but Rust repeats every schema, graph, target, artifact, approval, verification, compensation, path, and size check. A valid workflow is still not executable: execution requires a later immutable run plan whose exact digest is approved by the native approval boundary.

This protocol does not accept legacy definitions, legacy Artifact handles, or graphs that combine legacy and current protocol objects. Existing execution entry points may coexist temporarily, but they do not participate in current protocol compilation.

## 2. Common JSON rules

- All objects reject unknown fields unless explicitly described as annotation/config maps.
- Identifiers are 1–64 bytes, start with an ASCII letter or digit, and contain only ASCII letters, digits, `.`, `-`, or `_`.
- User-visible names are 1–128 UTF-8 bytes.
- Semantic workflow JSON is at most 256 KiB; layout JSON is at most 128 KiB.
- A node config is at most 32 KiB and at most 16 JSON levels deep.
- Integer fields must be JSON integers within the native target type. NaN and infinity are never valid JSON values.
- A digest is lowercase `sha256:` followed by exactly 64 hexadecimal characters.
- Secret values are references resolved only at execution time. Literal fields named `password`, `secret`, `token`, `apiKey`, `privateKey`, or `credentialValue`, and fields named `command`, `shell`, `argv`, `executable`, `interpreter`, or `scriptBody`, are rejected recursively.
- Private-key PEM/OpenSSH material is rejected recursively even under an otherwise allowed field name.

### 2.1 Canonical JSON and digests

Canonical JSON is produced as follows:

1. Serialize the typed value to JSON.
2. Sort every object key lexicographically by Unicode scalar sequence, recursively.
3. Preserve array order.
4. Emit compact UTF-8 JSON with `serde_json` string and integer encoding and no insignificant whitespace.
5. Hash the bytes with SHA-256 and encode the result as lowercase `sha256:<hex>`.

Duplicate object keys are not part of the typed protocol. Producers must not emit them. Digests are calculated only after strict typed deserialization.

Object key order therefore cannot change a digest. Array order remains significant. Layout is a separate object and is never an input to `definitionDigest` or `planDigest`.

## 3. Workflow definition

```ts
interface DeploymentWorkflowDefinition {
  schemaVersion: 3;
  targets: DeploymentWorkflowTarget[];
  parameters: WorkflowParameterDefinition[];
  nodes: WorkflowNodeDefinition[];
  outputs: Record<string, PortBinding>;
  policy: {
    failFast: true;
    maxParallelLocalNodes: number;
    releasesToKeep: number;
    automaticRestore: boolean;
  };
}

interface DeploymentWorkflowTarget {
  id: string;
  connectionProfileId: string;
  remoteRoot: string;
}

interface PortBinding {
  fromNodeId: string;
  fromPort: string;
}

interface WorkflowNodeDefinition {
  id: string;
  type: string;
  typeVersion: number;
  displayName: string;
  inputs: Record<string, PortBinding>;
  config: Record<string, JsonValue>;
  timeoutSeconds: number;
  retry: NodeRetryPolicy;
  runWhen: 'allSucceeded' | 'anyFailed' | 'always';
  condition?: NodeCondition;
}
```

`inputs` is the only semantic source of edges. A canvas edge is an editor projection of an input binding and is not stored separately.

### 3.1 Targets and paths

- 1–8 targets are allowed in a definition.
- `connectionProfileId` is a reference, not a credential.
- `remoteRoot` is a normalized absolute POSIX path of at most 512 bytes.
- `/`, `//`, `.`, `..`, NUL, and control characters are rejected.
- A workflow may declare several targets, but all effectful nodes in one compiled graph must use exactly one target.

### 3.2 Parameters

At most 32 parameters are allowed:

```ts
interface WorkflowParameterDefinition {
  id: string;
  displayName: string;
  type: 'string' | 'boolean' | 'integer';
  required: boolean;
  defaultValue?: string | boolean | integer;
}
```

The default must match `type`. String scalar values are at most 1024 bytes. Secret parameters are not part of current protocol; secrets use runtime-owned references in allowlisted config fields.

### 3.3 Node and policy limits

| Limit | Value |
| --- | ---: |
| Nodes per workflow | 64 |
| Inputs per node | 16 |
| Registered outputs per node | 16 |
| Workflow outputs | 16 |
| Timeout | 1–86,400 seconds |
| Retry attempts | 1–3 |
| Retry backoff | 0–300 seconds |
| Parallel local nodes | 1–8 |
| Releases retained | 1–50 |
| Condition `in` values | 1–16 |

`failFast` is fixed to `true`. Effectful nodes and control nodes are not automatically retryable; their `maxAttempts` is 1. A retryable node still remains subject to the descriptor and executor’s later reconciliation rules.

### 3.4 Conditions

```ts
type NodeCondition =
  | { op: 'equals'; input: PortBinding; value: string | boolean | integer }
  | { op: 'in'; input: PortBinding; values: Array<string | boolean | integer> }
  | { op: 'exists'; input: PortBinding };
```

A condition binding forms a graph dependency. It may reference only a registered scalar output and its literal type must match the output type. There is no expression language.

- Ordinary nodes use `allSucceeded`.
- `always` and `anyFailed` are reserved for registered finalizers.
- Finalizers cannot define an additional scalar `condition`.
- Compensation and automatic restore are not user-authored branches.

## 4. Layout definition

```ts
interface DeploymentWorkflowLayout {
  schemaVersion: 1;
  nodes: Record<string, { x: number; y: number; collapsed?: boolean }>;
  groups: Array<{ id: string; title: string; nodeIds: string[] }>;
  viewport?: { x: number; y: number; zoom: number };
}
```

Coordinates must be finite. Viewport zoom is 0.1–4.0. Layout has its own revision stream. It is not accepted by the workflow compiler and cannot change either semantic digest.

## 5. Port types

The closed current protocol port set is:

```ts
type DeploymentPortType =
  | 'source.snapshot'
  | 'artifact.bundle'
  | 'target.snapshot'
  | 'release.candidate'
  | 'transfer.receipt'
  | 'release.receipt'
  | 'activation.receipt'
  | 'verification.evidence'
  | 'control.approval'
  | 'scalar.string'
  | 'scalar.boolean'
  | 'scalar.integer';
```

Connections require exact port type equality. `artifact.bundle` connections additionally require a non-empty intersection between the producer’s declared artifact types and the consumer’s accepted artifact types. Equal port types never override component role/media-type validation performed when a concrete Artifact is consumed.

Artifact type lineage is preserved through `transfer.receipt` and the preparation/loading receipts. The compiler propagates the exact producer contract through those opaque receipts: for example, a zip or Docker receipt cannot be consumed by `release.prepare-files`, and a static file-tree receipt cannot be consumed by `runtime.load-image`.

Files cross node boundaries only as `artifact.bundle`. Receipt/evidence/control values are opaque runtime-issued objects; users cannot edit them into paths or approvals.

## 6. Artifact Bundle

```ts
interface ArtifactDescriptor {
  name: string;
  role:
    | 'application'
    | 'deployment-config'
    | 'metadata'
    | 'sbom'
    | 'signature'
    | 'auxiliary';
  mediaType: string;
  digest: `sha256:${string}`;
  size: number;
  platform?: { os?: string; architecture?: string; variant?: string };
  annotations: Record<string, string>;
}

interface ArtifactBundleManifest {
  schemaVersion: 2;
  artifactType: string;
  source: {
    revision: string;
    dirty: boolean;
    snapshotDigest: `sha256:${string}`;
  };
  components: ArtifactDescriptor[];
  producer: {
    nodeType: string;
    nodeTypeVersion: number;
    configDigest: `sha256:${string}`;
  };
  annotations: Record<string, string>;
}

interface ArtifactHandle {
  artifactReference: `deployment-artifact:sha256:${string}`;
  manifestDigest: `sha256:${string}`;
  contentDigest: `sha256:${string}`;
}
```

The reference is opaque and contains no filesystem location. A manifest has 1–64 uniquely named components. Each component is at most 16 GiB and the sum is at most 32 GiB. Component names are normalized relative POSIX paths and reject absolute paths, backslashes, empty segments, `.`, `..`, and duplicate names.

`manifestDigest` hashes the canonical manifest. `contentDigest` hashes the canonical component descriptor set sorted by component name. Mutable record data such as creation time, leases, and references is outside both digests.

Known initial artifact types are:

| Artifact type | Required content |
| --- | --- |
| `application/vnd.shellspan.file-tree` | deterministic static file tree |
| `application/vnd.shellspan.oci-image` | verified OCI/Docker image archive |
| `application/vnd.shellspan.compose-release` | image plus Compose deployment config |
| `application/vnd.shellspan.binary` | one executable/application binary |
| `application/vnd.shellspan.zip` | bounded generic zip input |

Concrete component media types include `application/vnd.shellspan.file-tree.tar+zstd`, `application/vnd.shellspan.oci-image.tar`, and `application/vnd.shellspan.compose+yaml`. Unknown artifacts may later be stored and displayed, but no registered consumer may execute them without an explicit native compatibility contract.

The initial deterministic file-tree implementation applies these native limits before packaging and again before extraction:

| Limit | Value |
| --- | ---: |
| Entries | 50,000 |
| Path depth | 64 |
| Normalized path length | 512 bytes |
| Single regular file | 512 MiB |
| Total unpacked bytes | 4 GiB |
| Compressed archive bytes | 4 GiB |
| Zip compression ratio after 1 MiB | 200:1 |

File trees are emitted as zstd-compressed deterministic tar streams. Paths are sorted normalized UTF-8 POSIX paths; uid, gid, and mtime are zero; directory mode is `0755`; regular-file mode is `0644` or `0755` according to the source executable bit. Symlinks, hard links, devices, sockets, FIFOs, absolute paths, backslashes, empty/`.`/`..` segments, duplicates, and archive entries that exceed a bound are rejected. Zip artifacts collected by `artifact.collect@1` are fully streamed and validated for the same path/type/count/size limits before publication even though current protocol has no zip deployment consumer.

## 7. Node catalog

The native registry returns catalog schema 1. Each descriptor includes exact type/version, localization keys, category, typed ports, execution domain, effect class, capabilities, config schema version, risk, fixed actions, fixed compensation, and retryability.

For the editor, the same descriptor also returns a read-only `configSchema` and `defaultConfig`. `configSchema` has schema version 1 and an ordered `fields` list. Each field contains `name`, localization keys, `kind` (`string|integer|boolean|select|stringList|integerList`), required state, optional localized select options, and optional integer bounds. `defaultConfig` is a strict config object accepted by that descriptor's native validator before workflow-specific values such as the selected target are applied. These fields are presentation metadata only: the frontend may render immediate hints from them, but cannot add fields, options, node types, capabilities, effects, or authority. Native config deserialization and validation remain final.

Execution domains are `local`, `target`, and `nativeUi`.

Effect classes are:

```ts
type EffectClass =
  | 'pure'
  | 'localRead'
  | 'localBuild'
  | 'remoteRead'
  | 'control'
  | 'remoteWrite'
  | 'serviceControl'
  | 'trafficSwitch'
  | 'cleanup'
  | 'finalizer';
```

`control` and `finalizer` are registry-only orchestration classes. `remoteWrite`, `serviceControl`, `trafficSwitch`, and `cleanup` require exact approval ancestry, one target effect lane, and a fixed compensation declaration.

### 7.1 MVP registry

| Type | Required inputs | Outputs | Effect | Fixed compensation |
| --- | --- | --- | --- | --- |
| `source.snapshot@1` | — | `source` | localRead | — |
| `build.package-script@1` | `source` | file-tree `bundle` | localBuild | — |
| `build.docker-buildx@2` | `source` | image `bundle` | localBuild | — |
| `artifact.collect@1` | `source` | file-tree/binary/zip `bundle` | localRead | — |
| `artifact.bundle-compose@1` | image `imageBundle`, `source` | Compose release `bundle` | pure | — |
| `target.preflight@2` | `bundle` | `target` | remoteRead | — |
| `release.create-candidate@1` | `bundle`, `target` | `candidate` | pure | — |
| `control.approval@1` | `candidate`, `target` | `approval` | control | — |
| `transfer.sftp@2` | `bundle`, `approval` | `transfer` | remoteWrite | mark unactivated staging for cleanup |
| `release.prepare-compose@1` | Compose `transfer` | `release` | remoteWrite | retain/mark unactivated Compose staging |
| `release.prepare-files@1` | `transfer` | `release` | remoteWrite | retain/mark unactivated release |
| `runtime.load-image@1` | Compose/image `release` | `image` | remoteWrite | content-addressed no-op |
| `deploy.compose@2` | `image` | `activation` | serviceControl | restore frozen Compose release |
| `deploy.static-switch@1` | `release` | `activation` | trafficSwitch | restore frozen `current` link and reverify the frozen HTTP endpoint |
| `verify.http@2` | `activation` | `evidence` | remoteRead | — |
| `proxy.nginx-reload@2` | `evidence` | `activation` | serviceControl | reverify after release restore |
| `release.commit@1` | `evidence`, optional ordered `activation` | `activeRelease` | trafficSwitch | restore frozen release identity |
| `finalize.notify@1` | — | `notified` | finalizer | — |

Every descriptor has a native config validator. The initial closed config shapes are:

- `source.snapshot`: `{ sourceRef }`.
- `build.package-script`: `{ packageManager, workingDirectory, installMode, scriptName, outputDirectory, environmentRefs }`; manager is `pnpm|npm|yarn|bun`, install mode is `frozen|skip`, and paths are normalized relative POSIX paths.
- `build.docker-buildx`: `{ context, dockerfile, platform, imageRepository }`; platform is `linux/amd64|linux/arm64`.
- `artifact.collect`: `{ kind, paths }`; kind is `fileTree|binary|zip`, 1–32 normalized source-relative paths.
- `artifact.bundle-compose`: `{ composeFiles, projectName, services }`; 1–8 source-relative files.
- `target.preflight`: `{ targetId, requiredCapabilities }` using the closed target capability enum.
- `release.create-candidate`: `{ targetId, strategy }`, strategy `staticFiles|dockerCompose`.
- Approval, transfer, Compose/file preparation, image loading, Nginx reload, and release commit: `{ targetId }`.
- `deploy.compose`: `{ targetId, projectName, services, pullPolicy }`, pull policy `never|missing`.
- `deploy.static-switch`: `{ targetId, linkName: 'current' }`.
- `verify.http`: `{ targetId, scheme, port, path, expectedStatuses }`; scheme `http|https`, path is target-relative, and statuses contain 1–16 values in 100–599.
- `finalize.notify`: `{ channel: 'system', events }` using `succeeded|failed|canceled|stateUnknown`.

No config field is interpreted as command text.

`build.package-script@1` selects only the native manager executable and fixed argv. Frozen installs use manager-specific lockfile flags and disable install lifecycle scripts; the selected build script is invoked as `<manager> run <scriptName>` without a shell or user argument tail. The exact initial environment reference allowlist is `ci`, `node-env-production`, and `source-date-epoch-zero`; all other references fail native validation. Combined stdout/stderr is capped at 512 KiB, process trees are terminated on cancellation/timeout, and package metadata plus the selected lockfile digest are stored in the resulting Artifact manifest.

For static releases, `release.prepare-files@1` revalidates and extracts the file-tree archive into a runtime-owned local directory, uploads only the validated regular files/directories, verifies every remote size/digest/type and executable bit, and atomically publishes `releases/<releaseId>`. An existing release ID is reusable only when its marker and every member match. `deploy.static-switch@1` accepts only the relative link `current -> releases/<releaseId>` and uses an atomic Linux rename. `target.preflight@2` blocks static execution unless the Linux target exposes the required relative-symlink primitives. Compensation validates the frozen previous release marker, restores its relative link, and repeats the approved HTTP verification before it may report success.

## 8. Compiler validation

The pure native compiler performs, in order:

1. Raw JSON byte limit and strict schema/version validation.
2. Count, identifier, display name, path, timeout, retry, and policy validation.
3. Exact node type/version lookup and strict per-node config validation.
4. Required input, port existence, exact port type, Artifact contract, target consistency, and condition validation.
5. DAG construction from input and condition bindings and deterministic topological layering.
6. Rejection of cycles and non-finalizer nodes that do not contribute to any declared workflow output.
7. Requirement for at least one Artifact producer, exactly one approval, at least one deployment, and at least one verification.
8. Rejection when a target node's registered capabilities are not covered by an ancestor `target.preflight` for the same target.
9. Rejection when an effect is before/not downstream of approval, not reachable from an Artifact producer, targets a different target, or lacks fixed compensation.
10. Rejection when a deployment has no downstream verification.
11. Construction of node/config/input digests, structured risks, fixed actions, compensations, topology layers, and the serial target effect lane.

An approval node may not have an effectful ancestor. All effectful nodes must use the same target as the approval node. The compiler never infers authority from display names, canvas positions, or a user-provided action list.

## 9. Compiled plan draft and immutable run plan

Phase 0 emits a pure canonical plan draft:

```ts
interface CompiledRunPlanDraft {
  schemaVersion: 1;
  definitionDigest: `sha256:${string}`;
  planDigest: `sha256:${string}`;
  topologyLayers: string[][];
  targetEffectLanes: Record<string, string[]>;
  nodes: Array<{
    nodeId: string;
    displayName: string;
    nodeType: string;
    nodeTypeVersion: number;
    executionDomain: 'local' | 'target' | 'nativeUi';
    effectClass: EffectClass;
    targetId?: string;
    configDigest: `sha256:${string}`;
    inputDigest: `sha256:${string}`;
    timeoutSeconds: number;
    retry: NodeRetryPolicy;
    fixedActions: string[];
  }>;
  risks: {
    highestLevel: 'low' | 'medium' | 'high' | 'critical';
    entries: Array<{ nodeId; level; effectClass; summaryKey }>;
  };
  compensations: Array<{ nodeId; compensationKind; fixedActions }>;
  policy: WorkflowPolicy;
}
```

The draft `planDigest` is the digest of every field above except `planDigest` itself. A later prepare-run phase must add and freeze workflow identity/revision, source snapshot, concrete Artifact handles, target profile revision/identity, preflight capabilities, current/previous/target Releases, expanded executor versions, expiry, operation kind, and trigger identity. That fully frozen immutable plan receives the exact digest presented for approval. A phase-0 draft is not an approval token and cannot authorize execution.

The immutable wire envelope is:

```ts
interface ImmutableRunPlan {
  schemaVersion: 1;
  workflowId: string;
  workflowRevision: number;
  runId: string;
  operationKind: 'deploy' | 'rollback';
  triggerKind: 'manual' | 'agent' | 'quickAction' | 'recovery';
  definitionDigest: `sha256:${string}`;
  parameters: Record<string, string | boolean | integer>;
  source: {
    sourceRef: string;
    revision: string;
    dirty: boolean;
    snapshotDigest: `sha256:${string}`;
    metadataDigest: `sha256:${string}`;
  };
  target: {
    targetId: string;
    connectionProfileId: string;
    profileRevision: number;
    hostIdentityDigest: `sha256:${string}`;
    remoteRoot: string;
    capabilitiesDigest: `sha256:${string}`;
  };
  artifacts: ArtifactHandle[];
  currentRelease?: FrozenReleaseIdentity;
  previousRelease?: FrozenReleaseIdentity;
  targetRelease: FrozenReleaseIdentity;
  executorVersions: Record<string, string>;
  compiled: CompiledRunPlanDraft;
  preparedAt: number;
  expiresAt: number;
  planDigest: `sha256:${string}`;
}

interface FrozenReleaseIdentity {
  releaseId: string;
  artifactContentDigest: `sha256:${string}`;
  layoutDigest: `sha256:${string}`;
}
```

`executorVersions` freezes the native executor implementation selected for every node ID. Startup recovery and execution fail closed if the currently registered executor version differs.

The immutable `planDigest` is computed from the entire envelope except `planDigest`. `compiled.planDigest` remains the compiler-draft identity and is not interchangeable with the approval-bound immutable plan digest.

Changing a node, display name, parameter, config, binding, condition, target, or semantic policy changes `definitionDigest` and `planDigest`. Changing only layout cannot change either.

## 10. Attempt, receipt, evidence, and compensation records

A node attempt has schema version, `runId`, `nodeId`, monotonically increasing positive `attempt`, idempotency key, status, bounded timestamps, and an optional categorized failure. Supported attempt states are `pending`, `running`, `succeeded`, `failed`, `canceled`, `stateUnknown`, and `compensated`.

An effect receipt is immutable and includes:

```ts
interface EffectReceipt {
  schemaVersion: 1;
  receiptType: string;
  operationId: string;
  runId: string;
  nodeId: string;
  attempt: number;
  targetId: string;
  planDigest: `sha256:${string}`;
  payloadDigest: `sha256:${string}`;
}
```

Evidence uses the same run/node/target/plan binding plus `evidenceType`, `observedAt`, bounded `outcome`, and `payloadDigest`. Raw remote output is not a receipt or evidence identity.

Compensation is compiler-owned. Each effectful node contributes a fixed compensation kind/action list to the plan. Automatic restore may consume only the previous Release, target, Artifact, receipt chain, and actions frozen in the approved immutable plan. It is never implemented by reversing the DAG or by accepting user command text. If reconciliation cannot prove the state, the run becomes `stateUnknown`.

A compensation record binds `runId`, `nodeId`, the frozen compensation kind, an idempotency key, status (`pending|running|succeeded|failed|stateUnknown`), and an optional immutable effect receipt. A record cannot introduce actions that were absent from the approved plan.

## 11. Error wire format

Native validation returns one or more errors:

```ts
interface WorkflowValidationError {
  code: WorkflowValidationCode;
  message: string;
  path?: string;
  nodeId?: string;
}
```

Codes are stable uppercase snake case and include JSON/schema/limit, identifier/path/policy, node/version/config/retry, binding/port/artifact/condition, cycle/reachability, approval/deployment/verification, target, compensation, and Artifact integrity categories. `message` is diagnostic text and must not be used as a programmatic discriminator or a localization key.

## 12. Shared fixtures

- `fixtures/static-site-workflow.json`
- `fixtures/docker-compose-workflow.json`

Both fixtures are parsed and compiled by Rust tests and compared against strict TypeScript wire fixtures. They are protocol examples, not hidden templates or executable approvals.

## 13. Phase 5 runtime projections and manual rollback

The Phase 5 UI reads current protocol data only. It does not query, convert, or render legacy workflows, runs, artifacts, or releases. Native high-level queries expose bounded projections for:

- workflow-scoped run pages ordered by `(createdAt, runId)`;
- one run detail with its approval summary, bounded outputs, immutable receipts, node projections, attempt pages, and reverse event pages;
- Artifact Bundle inspection with manifest, component descriptors, opaque digests, run/node/release references, leases, and retention status;
- workflow-scoped current and previous Release projections.

These projections never expose a CAS blob path, local workspace path, credential value, command text, private key, token, or unbounded remote output. Event and attempt cursors are opaque ordering boundaries; fetching an older page cannot mutate a run projection.

Preparation emits bounded `deployment-node-progress` events for approval-before nodes. Each event binds `operationId`, `runId`, `nodeId`, attempt, monotonic sequence, phase, completed/total steps, unit, and a localization summary key. Remote text is never used as its title or summary key.

Manual rollback is a new coordinator operation, never a mutation of the source run:

1. The client supplies `operationKind: rollback` plus one selected retained `rollbackReleaseId` to `prepare_deployment_run`.
2. Native code resolves only a verifiable current protocol `release_previous` reference for the same workflow and revalidates its Artifact Bundle in CAS.
3. Source identity is recovered from the selected immutable manifest; current target identity and capabilities are observed again by read-only preflight.
4. The current workflow revision recompiles the deployment actions. The selected historical Release identity must still match the newly prepared candidate layout and content identity, otherwise preparation fails closed as drift.
5. The resulting immutable plan has a new `runId`, `operationKind: rollback`, selected target Release, current Release as its fixed compensation target, a fresh expiry, and a new `planDigest`.
6. Approval and execution use the ordinary `approve_deployment_run` and `start_deployment_run` coordinator commands. No rollback-specific effectful node IPC exists.
7. A successful commit rotates current/previous Release references. The original deployment run, attempts, receipts, evidence, and events remain immutable.

## 14. Phase 6 recovery and integrity contract

Every effectful node boundary is classified on startup using persisted node projection, attempt, receipt and read-only remote evidence:

| Persisted boundary | Required startup action | Allowed conclusion |
| --- | --- | --- |
| Not started (`pending`/`ready`) | Do not perform a side effect; retain or restore the exact approved plan | `approved` or canceled-before-effects |
| In progress (`running`/`cancelRequested`/`stateUnknown`/`compensating`) | Call the exact registered executor's read-only `reconcile` with the original idempotency key | succeeded, not started, definite failure, compensated, or `stateUnknown` |
| Completed (`succeeded`) | Verify an immutable receipt bound to run, node, attempt, target and exact plan digest | keep succeeded only when the receipt chain is complete |
| Compensated (`compensated`) | Verify original/compensation receipt binding and frozen compensation identity | compensated only when evidence is complete |
| Evidence incomplete or contradictory | Perform no write, retry, switch, service control or cleanup | `stateUnknown` |

Before approval, start and startup reconciliation, native code verifies the canonical plan digest, exact workflow revision/definition digest, target profile revision and host identity, every Artifact handle through CAS, target Release content identity, every node type/version and every executor version. Immediately before execution, `target.preflight@2` is repeated as a read-only observation and its complete target snapshot, including capability digest, must equal the approved snapshot. Any drift fails closed; execution never tries to repair the plan in place.

Receipt payload digests must be valid SHA-256 identities. A completed effect without an exact receipt is evidence-incomplete even if its node projection says `succeeded`.

## 15. Bounded events, outputs and audit

The native repository enforces these serialized canonical JSON limits at every write boundary:

| Record | Limit |
| --- | ---: |
| Run event payload | 16 KiB |
| Node output summary | 16 KiB |
| Run output value | 64 KiB |
| Effect receipt | 8 KiB |
| Approval summary | 64 KiB |
| Immutable plan | 512 KiB |
| Audit export | 2 MiB and 1,000 events |

All summary keys must be reviewed `deployment.*` localization keys. Remote stdout/stderr is never used as an event title, summary key, receipt identity or audit field. Persisted JSON rejects secret-valued field names and common literal secret markers. Audit export uses an allowlisted projection, exports output digests rather than raw output values, omits endpoints/local paths/approval details/remote text, scans the final document for secret literals, and writes through an atomic private staging file.

## 16. Authority, feature gate and final cutover

- Only the manual UI approval wire value `approvalSource: manualUi` is accepted. Agent, recovery and Quick Action values do not deserialize as approval authority.
- Agent and Quick Action integrations may create a draft or request preparation only; neither integration exposes `approve_deployment_run`.
- Workflow and node config store credential/config references only. Secret values are resolved at the execution boundary and never enter workflow JSON, plan, events, logs, Artifact metadata or audit.
- `SHELLSPAN_DEPLOYMENT_WORKFLOW` is read once at process start. Missing, false or invalid values disable admissions.
- With the gate closed, create, update, archive, prepare, approve and start fail closed. Read-only projection, cancel, reconcile and audit export remain available so disabling admissions cannot strand an active run.
- Production registers only current protocol commands. legacy conversion, history reads, execution and IPC are absent. Legacy SQLite tables remain untouched and unread; no automatic data deletion is authorized.
