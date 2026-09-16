# ShellSpan Deployment Center Phase 8 Acceptance

Status: PASS for the isolated single-host Linux/arm64 Docker Compose MVP on
2026-09-16. The external-platform rows below remain explicitly MISSING and are
not release evidence for those platforms.

## 1. Release scope

Phase 8 hardens the Phase 1–7 deployment center without widening its authority.
The supported release remains one SSH target, one fixed Docker Buildx artifact,
one bounded Compose project/file/service selection, optional typed localhost
HTTP health, optional fixed Nginx validation/reload, same-run automatic restore,
and read-only restart reconciliation.

Not implemented: arbitrary local or remote shell, caller-defined Docker or
Nginx arguments, automatic approval, rolling or multi-host deployment, and
remote release cleanup. `releasesToKeep` is displayed as a future-policy value;
automatic cleanup is off.

## 2. Reproducible isolated gate

Run:

```bash
pnpm test:deployment:e2e
```

The script builds `tests/deployment-e2e` and starts only the
`shellspan-deployment-e2e` Compose project. SSH is published only at
`127.0.0.1:22224`. The service is privileged solely to run its own Docker
daemon; it does not mount `/var/run/docker.sock` or any host project directory.
Its Docker data root is tmpfs. A `finally` block always runs Compose down with
volumes. Test passwords remain in the fixture environment and are never printed
as an environment object or copied into production logs.

Observed platform:

| Component | Evidence |
| --- | --- |
| Host client | Docker CLI 29.7.2, Darwin arm64 |
| Host daemon | Docker Desktop Linux daemon 29.7.2, arm64 |
| Host Buildx | v0.36.1-desktop.1 |
| Host Compose | v5.5.0 |
| Isolated remote | Alpine 3.22 privileged container, Linux arm64 |
| Isolated daemon | Alpine Docker Engine 28.3.3 |
| Isolated Compose | Docker Compose 2.36.2 |
| Remote storage | container tmpfs/overlay only; not bare-metal ext4/XFS evidence |

The passing gate contains two ignored Rust acceptance tests and runs them
serially:

- `isolated_deployment_sftp_transport_acceptance` proves Known Hosts first-use
  rejection, exact match, mismatch rejection, password authentication, bounded
  multi-chunk SFTP, an injected disconnect with verified-prefix resume, atomic
  exclusive rename, final absence of `.part`, lock conflict, and symlink escape
  rejection.
- `isolated_deployment_dind_remote_runner_acceptance` uploads a local arm64
  Buildx/Docker-save bundle, closes the launch SSH session, and observes the
  detached runner through fresh sessions. It proves exact config image ID after
  `docker load`, Compose config/up, localhost health, atomic activation, health
  failure with verified automatic restore, unprovable restore to
  `state_unknown`, explicit image mismatch rejection, Nginx test failure with
  zero reloads, successful reload followed by health re-verification, workflow
  lock conflict, pre-mutation cancel, and rejection of truncated event/status
  ledger files.

## 3. Security and durability matrix

| Requirement | Evidence | Status |
| --- | --- | --- |
| Workflow/command injection | Closed serde shapes, fixed enums, identifier/control validation, non-shell Buildx arguments, and `workflow_release_and_service_identifiers_reject_injection_and_controls` | PASS |
| Service/release ID injection | Native identifier validation plus strict runner `valid_id` | PASS |
| Path and symlink escape | Canonical local root, no-following compose/source checks, real SFTP symlink fixture, runner lstat checks | PASS for cooperative host; hostile root race remains external |
| TOCTOU | Immutable plan/source/profile/artifact revalidation before and after effects, content digests, transfer lock, post-rename hash, injected partial symlink swap | PASS for ShellSpan-owned concurrency |
| Partial/final conflict | Prefix hash resume, mismatched partial reset, identical final reuse, conflicting final fail-closed | PASS |
| Output limits | Bounded Git/SSH/runner/audit collectors and excess-output tests | PASS |
| Disk/inode exhaustion | Injected transfer failures prove no final publication | PASS (injected); physical filesystem evidence MISSING |
| Timeout/cancel | Unit timeout/cancellation plus real pre-mutation cancel and observation-stop semantics | PASS |
| Approval concurrency | Exact run revision/expiry binding and stale/duplicate rejection | PASS |
| Notification dedupe | Immutable receipt claim survives restart; second claim empty | PASS |
| Event replay/reorder/tamper | Contiguous sequence parser, already-imported byte equality, gap/replay/unknown action tests, real truncation/tamper rejection | PASS |
| Arbitrary shell / raw invoke | Fixed native command builders; UI deployment files contain no raw Tauri `invoke`; contract test scans registration and Agent adapter | PASS |
| Credential logging | Workflows/plans/events/export reject secret markers; export uses field allowlist; fixture does not log environment | PASS |
| Agent approval bypass | Agent/quick-action surfaces have no approval command; native exact-run approval remains required | PASS |

The remote host is treated as untrusted evidence, but a hostile root user can
always race or rewrite files after observation. The product responds by
requiring immutable digests, contiguous evidence, and `state_unknown`; it does
not claim to prevent a compromised host administrator from changing the host.

## 4. Audit export

Run details expose **Export audit JSON**. The native export is:

- exact-run and read-only;
- audit schema v1, at most 500 events and 2 MiB;
- complete only when sequences are contiguous from 1 through the run revision;
- redacted by construction with an evidence allowlist;
- written through a private sibling temporary file, `sync_all`, then atomic
  publish; and
- checksum-protected with SHA-256.

The JSON explicitly says `signatureStatus: notConfigured`. Organizational
signing, key custody, verification policy, and signed-retention lifecycle are
MISSING external controls and must not be inferred from the checksum.

## 5. Rollout, migration, and rollback

- Default: deployment admissions enabled.
- Disable admissions: restart ShellSpan with
  `SHELLSPAN_DEPLOYMENT_CENTER_V1=0`.
- Disabled mode still permits history, audit export, active cancellation,
  startup recovery, and read-only reconciliation.
- Invalid flag values fail closed.
- There is no Phase 8 database migration and no workflow/approval schema bump.
- Rollback procedure: disable admissions, reconcile every active/unknown run,
  export required audits, then install the prior application version. Do not
  delete release directories or database rows as part of rollback.

## 6. First workflow operator path

1. Create an SSH connection profile and explicitly trust its verified host key.
   Store password/private-key material through the credential manager, not in a
   workflow.
2. Open **Deployments**, choose **New workflow**, and enter the canonical Git
   project root, relative Build context/Dockerfile, exact Linux platform, image
   repository without tag, target profile, non-root remote root, Compose project
   and relative files, optional service allowlist, and optional `/path` health
   check. Nginx reload requires health.
3. Save, select **Build artifact**, then run read-only **Preflight**.
4. Create the frozen plan, inspect source/target/releases/actions/checks, request
   native approval, and approve only that exact digest.
5. Upload the verified artifact and start the fixed runner. Cancel means stop at
   a safe boundary and, after possible service mutation, attempt the frozen
   automatic restore.
6. Confirm durable history/notification evidence. After restart, resolve every
   recovery card through read-only reconciliation before starting another run.
7. Export the exact run audit JSON when operational evidence is required.

## 7. Acceptance commands

| Command | Result on 2026-09-16 |
| --- | --- |
| `pnpm test:deployment:e2e` | PASS: 2 real isolated tests |
| Deployment-focused Vitest and Rust tests | PASS |
| `pnpm test` | PASS |
| `pnpm build` | PASS; existing bundle-size and ineffective dynamic-import warnings only |
| `pnpm review:frontend` | PASS |
| `cargo test --manifest-path src-tauri/Cargo.toml` | Earlier full run PASS; final concurrent rerun exposed one pre-existing Agent timing flake, which passed exact single-thread replay |
| `cargo test --manifest-path src-tauri/Cargo.toml -- --test-threads=1` | PASS: 871 library tests, 36 explicit environment ignores, 5 integration probes |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | PASS |
| `pnpm check:rust:includes` | PASS |
| `pnpm check:ai-styles` | PASS |
| `pnpm check:llm:catalog` | PASS |
| `git diff --check` | PASS |

The final rows must be rerun after any later change; this file records this
specific repository state, not a permanent waiver.

## 8. External evidence still required

| Boundary | Status |
| --- | --- |
| Linux amd64 Engine/Compose | MISSING |
| Bare-metal ext4 and XFS atomic rename/link, real disk-full and inode exhaustion | MISSING |
| Supported network filesystems | MISSING |
| Windows/OpenSSH target and Windows filesystem behavior | MISSING |
| Direct/jump-host deployment using production key providers and rotation drills | MISSING |
| Docker daemon restart during runner observation | MISSING |
| Multi-hour soak with repeated app/host restart | MISSING |
| Organizational signing and audit key custody | MISSING |
| Production metrics/alerts, backup restore, incident ownership, and operator rehearsal | MISSING |

Docker Desktop/LinuxKit, tmpfs, and injected faults are intentionally not
presented as bare-metal ext4, XFS, network filesystem, Windows, or soak evidence.
