# AI diagnostic planning

TermBridge's diagnostic Agent is a planner, not a shell. It produces a structured, informational troubleshooting plan and cannot insert or execute commands, select a broader target, access credentials, or call an SSH execution backend.

## Plan contract

The AI provider receives a strict JSON schema containing an objective, target scope, assumptions, evidence requirements, and one to eight ordered suggestions. Each suggestion carries a risk label, evidence references, impact, rollback, expected result, timeout, and retry guidance.

The frontend rejects unknown fields, duplicate or invalid IDs, missing evidence, unsafe read-only commands, read-only evidence scheduled after a modification, and modifying suggestions that do not cite an earlier evidence step. The resulting plan stays in the Agent panel for human review.

## Safety boundary

Context evidence records its source, bound profile/session label, and observation time. Stale context is visibly marked. Suggested commands are never copied to the terminal or executed automatically, and there is no Runbook handoff or generic execution IPC.

Users must independently verify the target, current evidence, impact, and rollback before acting on any suggestion. Deployment changes use the separate Deployment workflow and its semantic review and approval APIs.
