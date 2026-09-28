# Deployment preflight

Assess readiness of a specific release on the frozen target. Answer in the user's language. This is an observation workflow; loading it grants no permission to publish, migrate data, restart services, install dependencies or create backups. Use only supplied tools and existing authorization.

## Establish the release contract

Identify the application, intended version/artifact, target host, service unit, deployment method, affected storage and dependencies, expected health endpoint/status, maintenance window and recovery requirement from the request and existing project evidence. A branch name alone is not an immutable release identity. Ask only for missing details that affect the go/no-go decision; continue independent checks while awaiting them. Never invent thresholds, a rollback procedure, backup freshness requirements or an expected version.

Record the target ID and collection time. A check from the local workstation does not establish reachability from the remote host, and the reverse also holds. Keep secrets out of arguments and reports; use credential references where an existing authorized tool supports them.

## Collect evidence

1. Use `inspect_host` for system, CPU, memory, root disk and capabilities. Check the fields actually collected: load average is not CPU utilization; total memory is not available memory; root disk capacity says nothing about a separate application volume. If release thresholds require unsupported measurements, gather them with existing authorized read-only tools or mark them unverified. Do not use a universal free-space or memory threshold.
2. For systemd workloads, use `inspect_service` on the exact unit to establish the current load/active/sub-state, result and restart count. An absent unit may be expected for a first deployment; compare it with the intended deployment method. Containers and other service managers require their existing supported tools; `unsupported` is a collection limitation.
3. Inspect release/configuration metadata with bounded file tools only when the relevant root is available. Verify artifact identity/checksum, architecture compatibility and required configuration keys without printing secret values. Invoke a documented non-mutating syntax validator only if available and authorized. Do not execute arbitrary application startup or lifecycle scripts as validation.
4. Use `diagnose_endpoint` for explicit dependency destinations and ports when network access is authorized. Compare HTTP status with the documented contract; a TCP connection proves only transport reachability, and HEAD may be unsupported even when GET works. For approved target-loopback health checks use `probe_http` with GET/HEAD. A network request still follows the runtime's external-effect checks.
5. Use `query_logs` for a short explicit UTC baseline window of the exact systemd unit. Keep cursor filters unchanged, record truncation/access limitations, and stop after a justified bounded number of pages. Distinguish pre-existing errors from new release risks. Do not broaden collection to unrelated units.
6. Verify required backup and recovery evidence: identity, age against stated policy, scope, access and any recorded restore test. A backup file's existence does not prove recoverability. For migrations, identify documented backward compatibility and rollback constraints; never assume reverting code restores data.

## Decision and completion

Produce a compact checklist with requirement, observed evidence (tool call/reference and time), result (`pass`, `blocker`, `unverified`, or justified `not applicable`) and the next required action. Separate observed facts from hypotheses.

- Ready: every required condition is verified and no blocker remains.
- Blocked: evidence demonstrates a violated requirement; name its impact and smallest corrective action.
- Inconclusive: a required threshold, identity, permission, dependency or observation is missing. Do not label it ready or unhealthy.

End with the release identity, target, readiness decision and outstanding requirements. A passed preflight applies only to the observed state and is not authorization to deploy. Do not create a plan step claiming deployment completed.
