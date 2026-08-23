# TermBridge local Runbook format

TermBridge Runbooks are UTF-8 JSON files ending in `.runbook.json`. JSON is intentionally used as the first local format because it is readable in code review, produces stable version-control diffs after normalization, and can be validated without executing code. The current `schemaVersion` is `1`; unknown fields fail closed.

## Security model

- A Runbook binds to one connection profile when a run starts. The review freezes the profile ID, host, port, username, source digest, resolved non-secret variables, and keychain references.
- Every precheck is read-only. Steps declare exactly one risk: `readOnly`, `stateChange`, or `destructive`. Static checks reject known mutating or destructive commands whose declared risk is lower than detected behavior. Read-only actions also use a local command allowlist and reject shell control operators.
- Approval is per step and per exact risk. The backend validates the source text, selected action, variable set, risk, target identity, timeout, and approval again. Destructive steps receive a second confirmation showing the complete reviewed command and impact.
- Variable placeholders use `{{UPPERCASE_NAME}}`. Values are POSIX-shell quoted as one argument, preventing a variable from adding shell syntax. The review shows the resulting full command.
- Secret variables have no `default` or runtime text value. They use one of the supported references: `keychain://profile/password`, `keychain://profile/passphrase`, `keychain://profile/jump-password`, or `keychain://profile/jump-passphrase`. Only the Rust execution boundary resolves them. Reviews retain the reference, and returned stdout, stderr, and errors are scrubbed using every resolved Runbook and connection secret.
- Files containing unknown fields, common literal-secret assignments, private-key blocks, unsupported references, invalid placeholders, duplicate IDs, or understated risk are rejected before save or execution.

## Required shape

```json
{
  "schemaVersion": 1,
  "id": "nginx-reload",
  "name": "Reload nginx safely",
  "description": "Validate configuration before reloading.",
  "evidenceMaxAgeSeconds": 300,
  "variables": [
    {
      "name": "SERVICE",
      "description": "Service unit name.",
      "required": true,
      "default": "nginx"
    }
  ],
  "prechecks": [
    {
      "id": "service-status",
      "description": "Confirm the service exists.",
      "command": "systemctl status {{SERVICE}}",
      "expected": { "exitCode": 0 },
      "timeoutSeconds": 15
    }
  ],
  "steps": [
    {
      "id": "reload-service",
      "description": "Reload the service.",
      "command": "sudo systemctl reload {{SERVICE}}",
      "risk": "stateChange",
      "impact": "Reloads the selected unit without stopping it.",
      "expected": { "exitCode": 0 },
      "timeoutSeconds": 30,
      "safeToRetry": true
    }
  ]
}
```

`expected.exitCode` is required. `expected.stdoutContains` may contain up to 20 literal evidence fragments; all must match. A precheck failure, expected-result mismatch, cancellation, timeout, approval refusal, connection error, or step failure stops the run without advancing.

## Pause, skip, retry, and evidence

- Pause is available only between steps. A running command can be cancelled through its dedicated SSH channel.
- Prechecks cannot be skipped. A reviewed operational step can be skipped, and the skip remains explicit in the run state.
- Retry is available only from an action carrying `safeToRetry: true`; prechecks are intrinsically safe to retry. Retrying resets that action and everything after it.
- Successful precheck evidence carries the exact target and collection times. It expires after `evidenceMaxAgeSeconds`. A paused run cannot enter an operational step with stale evidence; the user must retry from a safe precheck.
- Result identity must match the frozen run ID, action ID, profile ID, host, port, and username. Mismatched or late evidence fails closed instead of updating the run.

## Implementation audit

The pre-existing diagnostic Agent inserts approved read-only commands into the visible PTY. That is appropriate for interactive diagnostics but not for Runbook secret variables because terminal echo and AI context capture could retain a resolved value. Local Runbooks therefore use a separate one-step SSH channel with bounded output, timeout, cancellation, expected-result verification, and backend redaction. Connection authentication still reuses the existing profile, host-key, password prompt, private-key, jump-host, and OS-keychain implementations; no new credential store or unrestricted Agent shell was introduced.
