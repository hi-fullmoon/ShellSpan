# Incident triage

Perform first-response triage for an outage or degradation on the current frozen target. Answer in the user's language. This skill authorizes observation and organization of evidence only; tool availability and session permissions remain authoritative.

1. Establish the affected service, user-visible symptom, onset and known scope from the user's message. Record what is confirmed and what is still unknown. If critical details are missing, continue with safe local evidence while asking only for details needed to narrow the incident.
2. Check a small set of high-signal observations: service state and recent restarts, host CPU/memory and disk pressure, relevant recent logs, and the affected listener or route. Use the corresponding listed diagnostic Skill when useful, but do not assume a Skill grants new tools or access. Keep every command bounded and target-specific.
3. Build a short timeline that separates observed changes from hypotheses. For each likely cause, name one confirming and one disconfirming check. Note the impact and urgency without inventing a severity level or claiming an outage from a single failed probe.
4. If a network, Docker or other check is denied by the native runtime, record the capability gap and continue with available evidence. Do not bypass denial with wrappers, a different endpoint, privilege escalation or another host.
5. Give the current status, evidence, affected scope, ranked hypotheses and the next smallest check or proposed mitigation. Do not restart, roll back, scale, change traffic, edit configuration or delete data unless the user separately requests that action and normal approval succeeds. After any authorized change, verify the user-visible symptom and service health.
