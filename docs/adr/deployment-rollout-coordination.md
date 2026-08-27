# ADR: deterministic deployment rollout coordination

Status: accepted for Deployment Runbook v2 phase 4.

## Decision

Multi-host deployment uses a local, durable `canaryRolling` coordinator above the existing single-host deployment executor. The coordinator freezes an explicit ordered profile list and normalized batch plan. It owns batch approvals, bounded parallel dispatch, threshold aggregation, circuit state, cancellation fan-out, read-only queries, and restart sealing. It owns no Shell renderer, SFTP primitive, credential cache, traffic router, service discovery, or rollback executor.

## Safety invariants

1. Targets come only from explicit profile IDs; tags and discovery are not accepted inputs.
2. Profile/host/port/username/auth/jump identity and environment are frozen during review and revalidated before dispatch.
3. Canary and rolling membership/order, thresholds, maximum parallelism, and every target child plan are bound to the rollout plan digest.
4. Every unfinished target has its own phase 2 review, approval consumption, operation/result identity, connection value, cancellation token, and phase 3 operation history. Credentials are never shared or persisted.
5. Every batch has a separate manual approval bound to rollout/review/plan/batch plus exact unfinished-target approvals.
6. Canary failure, unreachable thresholds, identity/plan drift, approval expiry/mismatch, cancellation, and recovery ambiguity stop new dispatches.
7. Successful targets remain successful. A rollback suggestion is data only and always requires a new phase 3 rollback review/approval per source operation.
8. Restart converts running targets to `interrupted + recoveryRequired`, preserves untouched targets as `notStarted`, pauses the rollout, and performs no replay.
9. Recovery preserves document, policy, batch digests, target order, and frozen identities; already succeeded targets cannot receive a new deployment review.
10. Result projections bind rollout, rollout review, rollout plan, batch, and single-host result identity. Late or cross-batch results are discarded and open the circuit in the pure coordinator.

## Deferred

Traffic shifting, load-balancer integration, dynamic service discovery, unattended rollback, recursive rollback, deployment templates, and a dedicated deployment UI remain outside phase 4.
