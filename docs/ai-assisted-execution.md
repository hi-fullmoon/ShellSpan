# AI-assisted execution

TermBridge's diagnostic Agent is a planner, not a shell. It can produce a structured execution draft, but it cannot insert commands into a terminal, save a Runbook, start a run, select a broader target, or call the SSH execution backend. The only transition from AI output to execution is the explicit **Review in Runbook** action.

## Plan contract

The AI provider receives a strict JSON schema. A plan contains:

- an objective and target scope;
- explicit assumptions and a diagnosis summary;
- evidence requirements with a source, source step, and maximum age;
- one to eight ordered commands with stable IDs;
- risk (`readOnly`, `stateChange`, or `destructive`), cited evidence IDs, impact scope, rollback, expected result, timeout, and retry safety for every command.

The frontend rejects unknown fields, duplicate or invalid IDs, missing evidence, read-only commands outside the bounded allowlist, read-only evidence scheduled after a modification, and any modifying step that does not cite output from an earlier read-only step. It then converts the draft to the versioned Runbook format and parses it again with the normal Runbook validator. This second pass rejects risk understatement, unsupported shell structure, literal secrets, invalid expected results, and missing rollback before the draft can be handed off.

## Evidence and freshness

Context evidence records whether it came from terminal output or a remote-health snapshot, the bound profile/session label, and the observation time. Its freshness is visible in the Agent UI. Context-only evidence can support planning but never authorizes a modification.

Each executable read-only AI step becomes a Runbook precheck. Its result records the operation ID, profile ID, host, port, username, start/completion times, exit code, expected-result match, stdout, and stderr. The AI draft uses the strictest declared `maxAgeSeconds` as the Runbook evidence window. A state-changing or destructive step cannot begin when any precheck is absent, failed, mismatched, or stale; resume and retry recheck the same gate.

## Review and execution boundary

The handoff opens an editable, unsaved Runbook draft and preselects the profile bound to the diagnostic context. It never starts execution. Selecting another profile or a tag is a visible user action and therefore an explicit scope change.

After handoff, all existing Runbook boundaries remain authoritative:

- source digest, selected action, exact approved risk, timeout, and resolved variables are validated again in Rust;
- the connection must match the frozen profile ID, host, port, and username;
- every step requires approval, while destructive steps add a confirmation showing host, command, impact, and rollback;
- multi-host runs retain frozen tag membership, batch and concurrency limits, per-host approval, cancellation IDs, identity isolation, and per-host circuit breakers;
- the AI has no direct access to credentials, unrestricted shell, cancellation registries, or execution functions.

## Outcomes and recovery

Invalid model output and insufficient evidence fail during planning. Approval refusal, credential cancellation, command cancellation, timeout, expected-result mismatch, identity mismatch, and execution failure stop the affected run without advancing. Multi-host execution reports success, partial success, failure, cancellation, timeout, stale evidence, and identity mismatch independently per host.

Recovery never silently continues. Only steps marked `safeToRetry` (and intrinsically safe prechecks) expose retry. Retrying a modification reruns all prechecks to collect fresh evidence. Multi-host retry is limited to explicitly selected failed hosts that still match their frozen identities and original tag; successful hosts remain untouched.
