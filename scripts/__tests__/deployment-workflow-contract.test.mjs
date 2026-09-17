import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');

describe('Deployment Workflow phase 6 production-hardening contracts', () => {
  it('uses an isolated loopback DinD fixture without the host Docker socket', async () => {
    const [compose, runner, packageJson] = await Promise.all([
      readFile(path.join(repositoryRoot, 'tests/deployment-e2e/compose.yml'), 'utf8'),
      readFile(path.join(repositoryRoot, 'scripts/verify-deployment-e2e.mjs'), 'utf8'),
      readFile(path.join(repositoryRoot, 'package.json'), 'utf8'),
    ]);
    expect(compose).toContain('127.0.0.1:22224:22');
    expect(compose).toContain('privileged: true');
    expect(compose).not.toContain('docker.sock');
    expect(runner).toContain("'isolated_deployment_'");
    expect(runner).toContain("'deployment::run_coordinator::tests'");
    expect(runner).toContain("'deployment::artifact_cas::tests'");
    expect(runner).not.toContain('rmSync');
    expect(runner).not.toContain('console.log(fixtureEnvironment)');
    expect(JSON.parse(packageJson).scripts['test:deployment:e2e'])
      .toBe('node scripts/verify-deployment-e2e.mjs');
  });

  it('keeps native admissions gated while recovery, audit, and cleanup policy stay explicit', async () => {
    const [commands, runtime, library, audit, runner] = await Promise.all([
      readFile(path.join(repositoryRoot, 'src-tauri/src/deployment/commands.rs'), 'utf8'),
      readFile(path.join(repositoryRoot, 'src-tauri/src/deployment/runtime.rs'), 'utf8'),
      readFile(path.join(repositoryRoot, 'src-tauri/src/lib.rs'), 'utf8'),
      readFile(path.join(repositoryRoot, 'src-tauri/src/deployment/audit.rs'), 'utf8'),
      readFile(path.join(repositoryRoot, 'src-tauri/src/deployment/docker_compose_executor.rs'), 'utf8'),
    ]);
    expect(runtime).toContain('SHELLSPAN_DEPLOYMENT_WORKFLOW');
    expect(runtime).toContain('cancel_recovery_audit_available: true');
    expect(commands.match(/DeploymentWorkflowAdmission::Mutating/g)?.length).toBeGreaterThanOrEqual(6);
    expect(commands).toContain('DeploymentWorkflowAdmission::Continuity');
    expect(library).toContain('deployment_workflow_capabilities');
    expect(library).toContain('export_deployment_run_audit');
    expect(library).not.toContain('deployment_run_remote');
    expect(audit).toContain('signatureStatus');
    expect(runner).not.toContain('rm -rf');
    expect(runner).not.toContain('docker system prune');
  });

  it('keeps UI deployment calls behind typed adapters and out of Agent approval authority', async () => {
    const [center, runtime, adapter, nativeAdapter, quickActions] = await Promise.all([
      readFile(path.join(repositoryRoot, 'src/components/workbench/deployment-workflow-center.tsx'), 'utf8'),
      readFile(path.join(repositoryRoot, 'src/components/workbench/deployment-workflow-runtime.tsx'), 'utf8'),
      readFile(path.join(repositoryRoot, 'src/lib/ipc/tauri.ts'), 'utf8'),
      readFile(path.join(repositoryRoot, 'src-tauri/src/agent_runtime/native_adapter.rs'), 'utf8'),
      readFile(path.join(repositoryRoot, 'src/lib/host/host-quick-actions.ts'), 'utf8'),
    ]);
    expect(center).not.toMatch(/\binvoke\s*\(/);
    expect(runtime).not.toMatch(/\binvoke\s*\(/);
    expect(adapter).toContain("'export_deployment_run_audit'");
    expect(adapter).toContain("'deployment_workflow_capabilities'");
    expect(adapter).not.toContain("'deployment_run_remote'");
    expect(nativeAdapter).not.toContain('approve_deployment_run');
    expect(quickActions).not.toContain('invokeApproveDeploymentRun');
  });
});
