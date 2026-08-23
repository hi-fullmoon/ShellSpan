# LATER exit-criteria acceptance

Review date: 2026-08-23

Scope: the completed LATER Runbook, multi-host task, AI-assisted execution, and operation-history workstreams. This acceptance does not authorize or begin EXPLORE work.

## Result

All three LATER exit criteria are verified. The review found one audit-correlation gap: approval records identified the operation, risk, target, and evidence, while the exact reviewed command appeared only on the later execution result. The minimal fix pins the redacted command preview to the approval event, keeps multi-host execution approval/results under the parent task, and fails closed when the returned command or risk differs. No execution path, shell capability, credential store, or product surface was added.

## Evidence matrix

| Exit criterion | Failure and recovery semantics | Implementation evidence | Regression evidence |
| --- | --- | --- | --- |
| Runbook and multi-host interruption, partial failure, and retry are predictable | Cancellation and timeout stop only the addressed operation/host; a per-host circuit breaker prevents later steps; partial success remains an aggregate `partialSuccess` with independent host terminal states. Retry requires explicit failed-host selection, `safeToRetry`, unchanged frozen identity/tag membership, original batch/concurrency limits, and fresh read-only prechecks. | `src/lib/runbook.ts`, `src/lib/multi-host-runbook.ts`, `src/components/workbench/multi-host-runbook-execution.tsx`, `src-tauri/src/runbook.rs`, `docs/multi-host-runbook.md` | `src/lib/__tests__/runbook.test.ts`, `src/lib/__tests__/multi-host-runbook.test.ts`, `src/components/workbench/__tests__/multi-host-runbook-execution.test.tsx`, `src-tauri/src/runbook.rs`, `scripts/run-ssh-e2e.ps1` |
| Every remote modification is traceable to user approval, exact command, target host, and result | The approval event carries task/operation/item IDs, approved risk, reviewed redacted command, target identity, and prior evidence. Results must match operation, task, risk, command, profile, host, port, and username; mismatch becomes `identityMismatch` without retaining the untrusted returned command. Exit code and terminal status are stored on the result event. | `src/lib/operation-history.ts`, `src/lib/tauri.ts`, `src/components/workbench/runbook-panel.tsx`, `src/components/workbench/multi-host-runbook-execution.tsx`, `src-tauri/src/operation_history.rs`, `docs/operation-history.md` | `src/lib/__tests__/operation-history.test.ts`, `src-tauri/src/operation_history.rs`, `src/components/workbench/__tests__/operation-history-panel.test.tsx` |
| AI cannot bypass risk classification, approval, command limits, or secret redaction | AI produces a review-only structured plan of at most eight commands. The frontend rejects unknown fields, risk understatement, unsupported read-only commands, missing prior evidence/rollback, oversize commands, and literal secrets, then round-trips through the Runbook parser. Rust independently re-parses the reviewed text, enforces the 8 KiB command and 512 KiB document limits, exact approved risk, bounded timeout/output, keychain-only secret resolution, and value-based result redaction. AI has no direct execution or terminal-insertion API. | `src/lib/diagnostic-agent.ts`, `src/stores/agentStore.ts`, `src/lib/runbook.ts`, `src-tauri/src/ai.rs`, `src-tauri/src/runbook.rs`, `docs/ai-assisted-execution.md`, `docs/runbook-format.md` | `src/lib/__tests__/diagnostic-agent.test.ts`, `src/stores/__tests__/agentStore.test.ts`, `src/lib/__tests__/runbook.test.ts`, `src-tauri/src/ai.rs`, `src-tauri/src/runbook.rs`, `scripts/run-ssh-e2e.ps1` |

## Acceptance gates

The phase is accepted only when all of the following commands pass from a clean review state:

```text
pnpm review:frontend
cd src-tauri
cargo fmt --all -- --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-targets --all-features
cd ..
pnpm test:e2e:ssh
```

On Windows GNU, the Rust gates use the documented Strawberry OpenSSL environment and the process-only linker flag/resource injection workaround. Those gate adaptations remain ignored build artifacts and are not part of the acceptance commit.
