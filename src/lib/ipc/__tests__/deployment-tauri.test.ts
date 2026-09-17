import { beforeEach, describe, expect, it, vi } from 'vitest';
import staticSiteJson from '../../../../protocol/deployment/fixtures/static-site-workflow.json';
import type { DeploymentWorkflowDefinition } from '@/lib/deployment/types';

const invokeMock = vi.hoisted(() => vi.fn());
const listenMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

import {
  invokeApproveDeploymentRun,
  invokeArchiveDeploymentWorkflow,
  invokeCancelDeploymentRun,
  invokeCreateDeploymentWorkflow,
  invokeCreateStaticSiteDeploymentWorkflow,
  invokeDeploymentWorkflowCapabilities,
  invokeGetDeploymentWorkflow,
  invokeGetDeploymentRunDetail,
  invokeExportDeploymentRunAudit,
  invokeInspectDeploymentArtifact,
  invokeListDeploymentNodeAttempts,
  invokeListDeploymentNodeTypes,
  invokeListDeploymentRunNodes,
  invokeListDeploymentRunEvents,
  invokeListDeploymentRuns,
  invokeListDeploymentReleases,
  invokeListDeploymentWorkflows,
  invokePrepareDeploymentRun,
  invokeReconcileDeploymentRun,
  invokeStartDeploymentRun,
  invokeUpdateDeploymentWorkflowLayout,
  invokeUpdateDeploymentWorkflow,
  invokeValidateDeploymentWorkflow,
  listenToDeploymentNodeProgress,
} from '@/lib/ipc/tauri';

const definition = staticSiteJson as unknown as DeploymentWorkflowDefinition;
const layout = {
  schemaVersion: 1 as const,
  nodes: { source: { x: 10, y: 20 } },
  groups: [],
};

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue({});
  listenMock.mockReset();
  listenMock.mockResolvedValue(vi.fn());
});

describe('deployment workflow IPC', () => {
  it('maps workflow, catalog, validation, and layout commands exactly', async () => {
    await invokeDeploymentWorkflowCapabilities();
    await invokeListDeploymentNodeTypes();
    await invokeValidateDeploymentWorkflow(definition);
    await invokeListDeploymentWorkflows('10:workflow-a', 25, true);
    await invokeGetDeploymentWorkflow('workflow-a');
    await invokeCreateDeploymentWorkflow({
      name: 'Static site', definition, layout, enabled: true,
    });
    await invokeCreateStaticSiteDeploymentWorkflow({
      name: 'Static production',
      connectionProfileId: 'profile-production',
      remoteRoot: '/srv/www/example',
      enabled: true,
    });
    await invokeUpdateDeploymentWorkflow('workflow-a', 3, {
      name: 'Static site', definition, enabled: false,
    });
    await invokeUpdateDeploymentWorkflowLayout('workflow-a', 5, { layout });
    await invokeArchiveDeploymentWorkflow('workflow-a', 4);

    expect(invokeMock.mock.calls).toEqual([
      ['deployment_workflow_capabilities', undefined],
      ['list_deployment_node_types', undefined],
      ['validate_deployment_workflow', { input: { definition } }],
      ['list_deployment_workflows', {
        cursor: '10:workflow-a', limit: 25, includeArchived: true,
      }],
      ['get_deployment_workflow', { id: 'workflow-a' }],
      ['create_deployment_workflow', {
        input: { name: 'Static site', definition, layout, enabled: true },
      }],
      ['create_static_site_deployment_workflow', {
        input: {
          name: 'Static production',
          connectionProfileId: 'profile-production',
          remoteRoot: '/srv/www/example',
          enabled: true,
        },
      }],
      ['update_deployment_workflow', {
        id: 'workflow-a',
        expectedRevision: 3,
        input: { name: 'Static site', definition, enabled: false },
      }],
      ['update_deployment_workflow_layout', {
        id: 'workflow-a', expectedLayoutRevision: 5, input: { layout },
      }],
      ['archive_deployment_workflow', {
        id: 'workflow-a', expectedRevision: 4,
      }],
    ]);
  });

  it('exposes only coordinator-level run operations and read-only projections', async () => {
    const planDigest = `sha256:${'a'.repeat(64)}` as const;
    await invokePrepareDeploymentRun({
      workflowId: 'workflow-a',
      workflowRevision: 4,
      operationKind: 'deploy',
      triggerKind: 'manual',
      parameters: {},
    });
    await invokeApproveDeploymentRun({ runId: 'run-a', planDigest });
    await invokeStartDeploymentRun({ runId: 'run-a', planDigest });
    await invokeCancelDeploymentRun({ runId: 'run-a' });
    await invokeReconcileDeploymentRun({ runId: 'run-a' });
    await invokeListDeploymentRuns('workflow-a', '10:run-a', 20);
    await invokeGetDeploymentRunDetail('run-a');
    await invokeListDeploymentRunEvents('run-a', 8, 20);
    await invokeListDeploymentReleases('workflow-a');
    await invokeListDeploymentRunNodes('run-a');
    await invokeListDeploymentNodeAttempts('run-a', 'transfer', 3, 20);
    await invokeInspectDeploymentArtifact(
      `deployment-artifact:sha256:${'b'.repeat(64)}`,
    );
    await invokeExportDeploymentRunAudit('run-a');
    const progress = vi.fn();
    await listenToDeploymentNodeProgress(progress);

    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual([
      'prepare_deployment_run',
      'approve_deployment_run',
      'start_deployment_run',
      'cancel_deployment_run',
      'reconcile_deployment_run',
      'list_deployment_runs',
      'get_deployment_run_detail',
      'list_deployment_run_events',
      'list_deployment_releases',
      'list_deployment_run_nodes',
      'list_deployment_node_attempts',
      'inspect_deployment_artifact',
      'export_deployment_run_audit',
    ]);
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'approve_deployment_run', {
      input: { runId: 'run-a', planDigest, approvalSource: 'manualUi' },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(11, 'list_deployment_node_attempts', {
      runId: 'run-a', nodeId: 'transfer', beforeAttempt: 3, limit: 20,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(6, 'list_deployment_runs', {
      workflowId: 'workflow-a', cursor: '10:run-a', limit: 20,
    });
    expect(listenMock).toHaveBeenCalledWith('deployment-node-progress', progress);
  });
});
