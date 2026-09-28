# Deployment verification

Verify a specific completed or attempted deployment on the frozen target. Answer in the user's language. This skill grants no permissions and does not itself authorize rollback, restart, traffic changes, data writes or another release.

## Define acceptance

Establish intended immutable version/artifact, deployment completion time, application/service, affected host, expected health response, required user-visible behavior and any documented observation window. Reuse the preflight baseline when available. Ask for a missing release identity or acceptance condition only when it changes the verdict. Do not infer a successful deployment from a build log, process exit code, HTTP 200 or an active service alone.

## Verify in order

1. **Identity:** read trusted deployment/application metadata through available tools. Compare actual version/hash with the intended release. State which evidence proves the running version; a changed file on disk does not prove that the running process loaded it. If the application exposes no version evidence, report that gap.
2. **Process state:** use `inspect_service` for an exact systemd unit. Check load, active/sub-state, result, main exit code and restart count. Interpret one-shot services using their type and expected lifecycle. When stability matters, take a second observation within the requested bounded window; a rising restart count is stronger evidence than a single count. Do not start an indefinite monitor.
3. **Resources:** use selected `inspect_host` fields and compare with a relevant baseline or explicit threshold. Root filesystem figures do not verify an application volume, and total memory does not prove memory headroom. Avoid causal claims based on a single sample.
4. **Reachability:** use authorized `diagnose_endpoint` checks for the public/dependency host, preserving its real name for SNI and certificate verification. Use target-loopback `probe_http` for the permitted local health interface. Record the vantage point; a remote host contacting its own public name does not establish end-user reachability. HEAD success is protocol evidence only. A 405/501 should lead to an authorized documented health GET, not a false outage conclusion.
5. **Application behavior:** compare expected status and required response fields on a documented non-mutating health/read path. Do not send credentials in URLs or run write transactions as a smoke test unless specifically authorized. If the supplied tools cannot verify the business requirement, mark it unverified.
6. **Errors:** query the exact unit's journal with `query_logs` using a fixed UTC interval around the deployment. Compare representative errors and restarts with the preflight baseline; use cursors with unchanged filters and bounded pages. An empty, truncated or permission-limited result does not prove absence of errors. Explain clock differences before correlating times.

## Verdict and handoff

Report actual versus intended identity, each required acceptance check, evidence references/times, result and unresolved limitations. Use `verified` only when all required criteria pass; use `failed` for an observed violated criterion and `inconclusive` for missing evidence. Distinguish these from collector failures.

For a regression, name the affected behavior, strongest evidence, likely cause with uncertainty and the smallest proposed mitigation. Check whether rollback is actually documented and compatible with any data migration; do not promise automatic reversibility. Execute a mitigation only when separately authorized through normal runtime approval, then repeat the affected acceptance checks.
