import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');

describe('Deployment Phase 8 production-hardening contracts', () => {
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
    expect(runner).not.toContain('rmSync');
    expect(runner).not.toContain('console.log(fixtureEnvironment)');
    expect(JSON.parse(packageJson).scripts['test:deployment:e2e'])
      .toBe('node scripts/verify-deployment-e2e.mjs');
  });

  it('keeps native admissions gated while recovery, audit, and cleanup policy stay explicit', async () => {
    const [commands, library, audit, runner] = await Promise.all([
      readFile(path.join(repositoryRoot, 'src-tauri/src/deployment/commands.rs'), 'utf8'),
      readFile(path.join(repositoryRoot, 'src-tauri/src/lib.rs'), 'utf8'),
      readFile(path.join(repositoryRoot, 'src-tauri/src/deployment/audit.rs'), 'utf8'),
      readFile(path.join(repositoryRoot, 'src-tauri/src/deployment/remote_runner.rs'), 'utf8'),
    ]);
    expect(commands).toContain('SHELLSPAN_DEPLOYMENT_CENTER_V1');
    expect(commands.match(/ensure_deployment_admissions_enabled\(\)\?/g)?.length).toBeGreaterThanOrEqual(10);
    expect(library).toContain('deployment_runtime_capabilities');
    expect(library).toContain('export_deployment_run_audit');
    expect(audit).toContain('automaticReleaseCleanup');
    expect(audit).toContain('signatureStatus');
    expect(runner).not.toContain('rm -rf');
    expect(runner).not.toContain('docker system prune');
  });

  it('keeps UI deployment calls behind typed adapters and out of Agent approval authority', async () => {
    const [center, history, adapter, nativeAdapter] = await Promise.all([
      readFile(path.join(repositoryRoot, 'src/components/workbench/deployment-center.tsx'), 'utf8'),
      readFile(path.join(repositoryRoot, 'src/components/workbench/deployment-run-history.tsx'), 'utf8'),
      readFile(path.join(repositoryRoot, 'src/lib/ipc/tauri.ts'), 'utf8'),
      readFile(path.join(repositoryRoot, 'src-tauri/src/agent_runtime/native_adapter.rs'), 'utf8'),
    ]);
    expect(center).not.toMatch(/\binvoke\s*\(/);
    expect(history).not.toMatch(/\binvoke\s*\(/);
    expect(adapter).toContain("'export_deployment_run_audit'");
    expect(adapter).toContain("'deployment_runtime_capabilities'");
    expect(nativeAdapter).not.toContain('approve_deployment_plan');
  });
});
