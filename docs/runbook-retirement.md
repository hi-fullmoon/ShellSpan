# Runbook automation retirement

The standalone Runbook v1 product surface, multi-host executor, and Deployment Runbook v2 workflow were removed on 2026-08-28. Neither automation surface had demonstrated product value sufficient to justify its product and maintenance cost.

The removal includes the Workbench and command-palette entry points, JSON editors and templates, single-host and rollout state machines, AI-to-Runbook handoff, frontend IPC wrappers, native deployment/rollback commands, deployment-specific schemas, fixtures, and tests. Historical operation-history labels remain readable so existing local audit rows do not lose their meaning.

Existing installations may still contain inert deployment tables or keychain entries created by earlier versions. The application no longer reads, writes, migrates, or executes them; the retirement deliberately avoids silently deleting local audit data or secrets during upgrade.

The generic reviewed SSH execution kernel remains because fixed-purpose remote probes and the separately gated Agent roadmap use that infrastructure. It is not exposed as a deployment or generic execution IPC.
