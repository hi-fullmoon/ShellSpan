# TermBridge local Runbook format

TermBridge Runbooks are UTF-8 JSON files ending in `.runbook.json`. JSON is intentionally used as the first local format because it is readable in code review, produces stable version-control diffs after normalization, and can be validated without executing code. The current **executable operational format** remains `schemaVersion: 1`; unknown fields fail closed.

`schemaVersion: 2` with `kind: "deployment"` is reserved for the validation-only [Deployment Runbook v2 contract](deployment-runbook-v2.md). It adds semantic artifact/release/service/health/rollback metadata but is not accepted by the v1 editor, scheduler, or execution parser. Phase 1 registers no deployment command and does not infer or execute Shell from v2 fields.

The Runbook workspace uses an offline Monaco JSON editor backed by the same v1 structural contract. It provides field and enum completion, hover documentation, folding, formatting, syntax errors, and live JSON Schema diagnostics. Typing `{{` inside a command also offers declared Runbook variables. Schema diagnostics improve editing feedback, but the explicit **Validate** action remains authoritative for semantic safety checks such as command risk, secret detection, duplicate identifiers, and undeclared placeholders.

## Security model

- A Runbook binds to one connection profile when a run starts. The review freezes the profile ID, host, port, username, source digest, resolved non-secret variables, and keychain references.
- Every precheck is read-only. Steps declare exactly one risk: `readOnly`, `stateChange`, or `destructive`. Static checks reject known mutating or destructive commands whose declared risk is lower than detected behavior. Read-only actions also use a local command allowlist and reject shell control operators.
- Approval is per step and per exact risk. The backend validates the source text, selected action, variable set, risk, target identity, timeout, and approval again. Every modifying step must describe a rollback. Destructive steps receive a second confirmation showing the complete reviewed command, impact, and rollback.
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
      "description": "Confirm the nginx service is running.",
      "command": "systemctl status {{SERVICE}}",
      "expected": { "exitCode": 0 },
      "timeoutSeconds": 15
    },
    {
      "id": "validate-nginx-config",
      "description": "Validate nginx configuration syntax and referenced files.",
      "command": "sudo nginx -t",
      "expected": { "exitCode": 0 },
      "timeoutSeconds": 15
    }
  ],
  "steps": [
    {
      "id": "reload-service",
      "description": "Reload the validated nginx configuration only if a reviewed change is still pending.",
      "command": "sudo systemctl reload {{SERVICE}}",
      "risk": "stateChange",
      "impact": "Reloads the selected unit without stopping it.",
      "rollback": "Restore the previous validated configuration and reload the same unit.",
      "expected": { "exitCode": 0 },
      "timeoutSeconds": 30,
      "safeToRetry": true
    },
    {
      "id": "verify-service-active",
      "description": "Confirm nginx remains active after the reload.",
      "command": "systemctl is-active {{SERVICE}}",
      "risk": "readOnly",
      "impact": "Collects the post-reload service state without changing it.",
      "expected": { "exitCode": 0, "stdoutContains": ["active"] },
      "timeoutSeconds": 15,
      "safeToRetry": true
    }
  ]
}
```

The service-status evidence includes recent unit events on systemd hosts. Review it before approving the reload: if it shows that the intended configuration was already reloaded and no newer reviewed change is pending, reject or skip the redundant action.

`expected.exitCode` is required. `expected.stdoutContains` may contain up to 20 literal evidence fragments; all must match. `rollback` is required for `stateChange` and `destructive` steps. A diagnostic evidence-only Runbook may use an empty `steps` array, but still requires at least one bounded precheck. A precheck failure, expected-result mismatch, cancellation, timeout, approval refusal, connection error, or step failure stops the run without advancing.

## Pause, skip, retry, and evidence

- Pause is available only between steps. A running command can be cancelled through its dedicated SSH channel.
- Prechecks cannot be skipped. A reviewed operational step can be skipped, and the skip remains explicit in the run state.
- Retry is available only from an action carrying `safeToRetry: true`; prechecks are intrinsically safe to retry. Retrying resets that action and everything after it.
- Successful precheck evidence carries the exact target and collection times. It expires after `evidenceMaxAgeSeconds`. A paused run cannot enter an operational step with stale evidence; the user must retry from a safe precheck.
- Result identity must match the frozen run ID, action ID, profile ID, host, port, and username. Mismatched or late evidence fails closed instead of updating the run.

## Implementation audit

The diagnostic Agent produces a structured draft only. It cannot insert or execute its commands in the visible PTY. Users explicitly hand the draft to this editor, where they can review, edit, save, bind a single profile or deliberately select a tag, and then approve each action. Runbooks use a separate one-step SSH channel with bounded output, timeout, cancellation, expected-result verification, and backend redaction. Connection authentication still reuses the existing profile, host-key, password prompt, private-key, jump-host, and OS-keychain implementations; no new credential store or unrestricted Agent shell was introduced.

Deployment Runbook v2 is intentionally outside this executable audit path in phase 1. Its TypeScript and crate-private Rust parsers provide strict validation and normalized serialization only. The existing `execute_runbook_step` command continues to parse `schemaVersion: 1` exclusively, so a v2 deployment document fails before action selection, credential resolution, or network access.
