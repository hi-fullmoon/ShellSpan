import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import lifecycle from '../../../../../docs/design/deployment-center-product-phase-4-lifecycle-evidence.json';
import release from '../../../../../docs/design/deployment-center-product-phase-3-evidence.json';
import type { DeploymentRunNodeRecord, DeploymentWorkflowRecord } from '@/lib/deployment/types';
import { initI18n, t } from '@/locales';
import { useDeploymentWorkflowRunStore } from '@/stores/deploymentWorkflowRunStore';
import { RuntimeNodeInspector } from '../runtime-node-inspector';

beforeEach(async () => {
  await initI18n('zh-CN');
  useDeploymentWorkflowRunStore.getState().reset();
});
afterEach(() => {
  cleanup();
  useDeploymentWorkflowRunStore.getState().reset();
});

it('keeps attempt fields present while switching recorded nodes and clears loading on failure', () => {
  const nodes = lifecycle.rollbackNodes as unknown as DeploymentRunNodeRecord[];
  useDeploymentWorkflowRunStore.setState({ nodes, loadingAttempts: true, selectedNodeId: 'approval' });
  render(<RuntimeNodeInspector workflow={release.workflow as unknown as DeploymentWorkflowRecord} onOpenEvidence={() => undefined} />);
  for (const node of nodes.filter(item => item.lastAttempt > 0)) {
    act(() => useDeploymentWorkflowRunStore.setState({ selectedNodeId: node.nodeId }));
    expect(screen.getByTestId('deployment-selected-attempt')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText(t('deployment.runtime.attempt.executor'))).toBeVisible();
    expect(screen.getByLabelText(t('deployment.runtime.loading'))).toHaveClass('h-8');
    expect(screen.queryByRole('combobox')).toBeNull();
  }
  act(() => useDeploymentWorkflowRunStore.setState({ loadingAttempts: false }));
  expect(screen.queryByLabelText(t('deployment.runtime.loading'))).toBeNull();
  expect(screen.queryByTestId('deployment-selected-attempt')).toBeNull();
});

it('does not reserve attempt fields for recorded nodes that have never run', () => {
  useDeploymentWorkflowRunStore.setState({ nodes: lifecycle.rollbackNodes as unknown as DeploymentRunNodeRecord[], selectedNodeId: 'source', loadingAttempts: true });
  render(<RuntimeNodeInspector workflow={release.workflow as unknown as DeploymentWorkflowRecord} onOpenEvidence={() => undefined} />);
  expect(screen.queryByTestId('deployment-selected-attempt')).toBeNull();
});
