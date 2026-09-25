import React from 'react';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import evidence from '../../../../docs/design/deployment-center-product-phase-3-evidence.json';
import { initI18n, t } from '@/locales';
import type { DeploymentRunDetail, DeploymentWorkflowRecord } from '@/lib/deployment/types';
import { useDeploymentWorkflowRunStore } from '@/stores/deploymentWorkflowRunStore';
import { DeploymentWorkflowRuntimeView } from '../deployment-workflow-runtime';

// Replay recorded acceptance evidence with the real store and components.
const workflow = evidence.workflow as unknown as DeploymentWorkflowRecord;
const detail = evidence.detail as unknown as DeploymentRunDetail;

beforeEach(async () => {
  await initI18n('zh-CN');
  useDeploymentWorkflowRunStore.getState().reset();
  useDeploymentWorkflowRunStore.setState({
    workflowId: workflow.id,
    runs: [detail.summary],
    selectedRunId: detail.summary.runId,
    detail,
  });
});

afterEach(() => {
  cleanup();
  useDeploymentWorkflowRunStore.getState().reset();
});

describe('deployment run loading boundaries', () => {
  it('keeps the workspace and history mounted while details load and after a failed load', () => {
    render(<DeploymentWorkflowRuntimeView workflow={workflow} kind="runs" />);
    const workspace = screen.getByTestId('deployment-runtime-workspace');
    const history = screen.getByTestId('deployment-run-list');

    act(() => useDeploymentWorkflowRunStore.setState({ detail: null, loading: true }));
    expect(screen.getByTestId('deployment-runtime-workspace')).toBe(workspace);
    expect(screen.getByTestId('deployment-run-list')).toBe(history);
    expect(within(workspace).getByText(t('deployment.runtime.loading'))).toBeVisible();
    expect(within(history).getByText(detail.summary.targetRelease.releaseId)).toBeVisible();

    act(() => useDeploymentWorkflowRunStore.setState({ loading: false, error: 'DEPLOYMENT_WORKFLOW_RUN_NOT_FOUND' }));
    expect(screen.getByTestId('deployment-run-list')).toBe(history);
    expect(within(history).getByRole('button', { name: new RegExp(detail.summary.targetRelease.releaseId) })).toBeEnabled();

    act(() => useDeploymentWorkflowRunStore.setState({ detail, error: null }));
    expect(screen.getByTestId('deployment-runtime-workspace')).toBe(workspace);
    expect(screen.queryByText(t('deployment.runtime.loading'))).not.toBeInTheDocument();
  });

  it('does not reload the already selected record or reset its detail', async () => {
    const before = useDeploymentWorkflowRunStore.getState();
    await before.selectRun(detail.summary.runId);
    expect(useDeploymentWorkflowRunStore.getState()).toBe(before);
  });
});
