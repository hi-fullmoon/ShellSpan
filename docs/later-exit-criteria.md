# LATER workstream history

Original review date: 2026-08-23

Retirement date: 2026-08-28

The standalone Runbook v1, multi-host executor, AI-to-Runbook handoff, and Deployment Runbook v2 previously passed their historical acceptance reviews. They were later removed because they had no demonstrated product value sufficient to justify the combined product and maintenance cost.

The current acceptance boundary is:

- Runbook and Deployment navigation, editors, templates, state machines, IPC, native executors, schemas, and fixtures are absent;
- the Diagnostic Agent, including its planning and terminal-control paths, is absent;
- existing operation-history rows retain their historical labels;
- the shared reviewed SSH kernel remains internal and does not expose a generic execution IPC.

See `docs/runbook-retirement.md` and `docs/agent-retirement.md` for the removal inventories and regression boundaries.
