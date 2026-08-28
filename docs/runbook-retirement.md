# Runbook v1 retirement

The standalone Runbook v1 product surface and its multi-host executor were removed on 2026-08-28. They had no demonstrated product value and duplicated the clearer, purpose-built deployment workflow.

The removal includes the Workbench and command-palette entry points, JSON editor, single- and multi-host state machines, AI-to-Runbook handoff, frontend IPC wrappers, and native step execution commands. Historical operation-history labels remain readable so existing local audit rows do not lose their meaning.

Deployment Runbook v2 remains supported through the independent Deployment workbench and its semantic review, approval, rollout, recovery, and rollback APIs. The small shared `RunbookRisk` vocabulary, secret-literal guard, and deployment JSON file dialog are retained only for that workflow.

Regression coverage verifies that the old navigation and handoff are absent, Deployment Runbook v2 still validates and builds, and the native deployment implementation still compiles.
