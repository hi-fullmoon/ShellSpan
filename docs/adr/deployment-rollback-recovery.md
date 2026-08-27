# ADR: durable deployment and separate rollback authority

Status: accepted for Deployment Runbook v2 phase 3.

## Decision

Deployment review/approval state is durable and authoritative in SQLite. The in-memory registries own cancellation flags only. Rollback uses a separate review, approval, execution, and cancellation API, derived solely from a durable deployment activation snapshot and its canonical Runbook.

The database extension is additive and versioned through `deployment_schema_version`; the primary schema stays at v5 for phase-2 rollback compatibility. Startup converts every unprovable in-flight operation to terminal `interrupted + recoveryRequired`, invalidates its execution token, and performs no remote replay.

## Security invariants

1. A rollback caller cannot provide a release path, command, Runbook, service action, or health check.
2. Approval consumption and operation creation are one SQLite transaction and one shot across restarts.
3. Every checkpoint requires the operation's random execution token and `terminal=0`; terminal or recovered operations reject late results.
4. Rollback revalidates the frozen profile, durable document/plan, unconsumed snapshot, current symlink, and both release directories before mutation.
5. Atomic reactivation uses only a fixed same-directory symlink-swap template. Service and health commands come only from the validated v2 contract.
6. Rollback failures preserve partial action/health/reactivation evidence and never recursively trigger rollback.
7. Connection credentials, resolved secrets, stdout, and stderr are not stored in deployment tables.
8. Cleanup eligibility protects current, rollback-target, pending-review, active-operation, and recovery-required references. Phase 3 does not execute cleanup or delete in the background.
9. Rollback snapshot reservation is transactional and exclusive. Pre-activation terminal failure releases it, activation consumes it, and only a terminal recovery-required owner may be replaced by a fresh reviewed execution.

## Recovery semantics

A restart is evidence loss, not permission to continue. An interrupted operation can be inspected through read-only list/detail APIs. A new forward review may safely retry the declarative deployment, or an interrupted operation with a durably captured activation snapshot can be the source of a new rollback review. Cross-target and cross-version substitutions fail plan revalidation.

## Deferred

Multi-host batches/canaries remain phase 4. A dedicated deployment UI remains phase 5. Cleanup execution, background GC, automatic rollback, arbitrary hooks, and generic Shell/SFTP remain outside phase 3.
