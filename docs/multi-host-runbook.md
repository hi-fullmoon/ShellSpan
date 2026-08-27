# Multi-host Runbook safety contract

> Scope: this scheduler currently accepts executable Runbook `schemaVersion: 1` only. Deployment Runbook v2 phase 1 is a validation-only contract and is not dispatched to single-host or multi-host execution. A later deployment scheduler must explicitly preserve all target-freezing, batching, per-host circuit, evidence, and approval invariants below.

TermBridge multi-host tasks are a local scheduler layered over the existing one-step Runbook SSH boundary. The scheduler does not introduce a shared shell, shared terminal, background agent, or new credential store. Every dispatched command still passes through `execute_runbook_step`, which validates the reviewed source digest, database profile binding, exact risk approval, bounded timeout, known host, keychain references, output limits, and redaction.

## Target selection and freezing

- A task starts from one non-empty connection tag. Matching is normalized for surrounding whitespace and case, while the displayed tag spelling is preserved.
- Starting read-only preflight freezes the ordered profile set and, for every profile, its stable ID, host, port, username, Runbook source digest, resolved non-secret variables, command previews, and batch number.
- A later profile deletion or host/port/username change trips only that host's circuit before another command can be sent. A failed host is retryable only if it still has the selected tag and its frozen connection identity matches again.
- Each host owns a cloned variable map and a separate `RunbookRun`. Secret values remain keychain references in the review and are resolved only by the Rust execution boundary for that profile.

## Concurrency, batches, and circuit breakers

- `concurrencyLimit` is an integer from 1 through 8. `batchSize` is an integer from 1 through 50 and cannot be smaller than the concurrency limit.
- The task has a global preflight phase followed by a modification phase. Read-only preflight advances through the frozen target set batch-by-batch; no modification approval is enabled until every target has either completed preflight or opened its own circuit. Modification then returns to the first unfinished batch, and its next batch cannot start while the active batch is running or waiting for per-host approval.
- A host has at most one active command and one unique operation ID. A task never reuses one host's operation ID, cancellation flag, command, output, exit code, evidence, or failure reason for another host.
- A failed expectation, SSH error, timeout, cancellation, stale preflight, frozen-target change, or result identity mismatch opens only that host's circuit. Other hosts may continue within the same fixed concurrency and batch boundaries.

## Preflight and approval

- Starting a tagged task authorizes only the reviewed read-only prechecks. Prechecks run before any Runbook step for that host.
- Every state-changing or destructive step waits for a separate approval on its exact host. Destructive steps show an additional confirmation containing that host, command, and impact.
- Approval and dispatch both recheck that all preflight evidence for the same host matched expectations and is younger than `evidenceMaxAgeSeconds`. Evidence that expires between approval and dispatch fails closed and requires a fresh preflight.
- Backend results are accepted only when operation ID, run ID, Runbook ID, source digest, item ID/kind/risk, command preview, profile ID, host, port, and username match the active frozen host. Mismatched output is discarded rather than attached to any host.

## Results, cancellation, and recovery

- Per-host cards retain only that host's command preview, stdout, stderr, exit code, expected-result evidence, failure reason, cancellation state, and attempt count.
- `partialSuccess` is a first-class terminal outcome. It is returned whenever at least one host succeeded and at least one did not; it is never displayed as an overall success.
- Cancelling one host sends only its active operation ID. Cancelling the task prevents new dispatches, immediately cancels queued/approval hosts, and signals every currently active per-host operation. A command that wins the cancellation race may retain its completed evidence, but no later step is scheduled.
- Recovery is available only after the task reaches a terminal outcome, only for explicitly selected failed hosts, and only when the failed item declared `safeToRetry`. The host must still match the frozen target and selected tag.
- A safe retry preserves already completed modification steps, clears untrusted/failed later evidence, reruns all read-only prechecks, increments that host's attempt, and stays in its original batch. It must receive fresh per-host approval again before modification continues.

## Verification evidence

- `src/lib/__tests__/multi-host-runbook.test.ts` covers tag selection and empty targets, configuration bounds, concurrency, batch barriers, per-host circuit breakers, cancellation, timeout, partial success, safe failed-host retry, stale evidence, result identity mismatch, cloned variables, and output/exit-code isolation.
- `src/components/workbench/__tests__/runbook-panel.test.tsx` covers the shadcn target-mode and tagged scheduling controls.
- `src/components/workbench/__tests__/multi-host-runbook-execution.test.tsx` verifies first-class partial-success rendering and host-card output isolation.
- The ignored Rust SSH E2E test `isolated_ssh_sftp_end_to_end_multi_host_runbook_output_isolation` opens independent concurrent SSH sessions and proves their marker output and exit status remain separate.
